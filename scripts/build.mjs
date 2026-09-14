#!/usr/bin/env node
// Library build. esbuild, not Vite library mode: Vite inlines referenced assets
// as base64 data: URIs, which cannot be streaming-compiled as WebAssembly and
// would force `connect-src data:` on every host.

import { build } from "esbuild";
import { readFile, writeFile, rm, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

await rm(DIST, { recursive: true, force: true });

const result = await build({
  entryPoints: [join(ROOT, "src/index.ts"), join(ROOT, "src/self-test.ts")],
  outdir: DIST,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: ["es2022", "chrome91", "firefox90", "safari16"],
  jsx: "automatic",
  sourcemap: true,
  minify: false, // a library ships readable code; the host minifies
  legalComments: "linked",
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "react-dom/client",
    "gsap",
    "gsap/*",
    // Loaded at run time from the host's asset directory, never bundled: see
    // src/lib/scanic-entry.ts. Listing it here means a stray static import
    // fails the build rather than quietly dragging the ONNX Runtime back in.
    "scanic",
  ],
  logLevel: "info",
  metafile: true,
});

// Two things must be true of the emitted library.
//
// One: every relative dynamic import names a file we actually emitted, so no
// chunk 404s in a consumer's production build.
//
// Two: no byte of scanic is in here. It is loaded at run time from the host's
// asset directory precisely because the ONNX Runtime inside it locates its own
// WebAssembly with `new URL(..., import.meta.url)`, which webpack resolves at
// build time and cannot satisfy from a consumer's hashed output. A static
// import creeping back would only fail in somebody else's Next build.
const emitted = new Set(await readdir(DIST));
const problems = [];
for (const file of await readdir(DIST)) {
  if (!file.endsWith(".js")) continue;
  const body = await readFile(join(DIST, file), "utf8");
  for (const match of body.matchAll(/import\(\s*["']\.\/([^"']+)["']\s*\)/g)) {
    if (!emitted.has(match[1])) {
      problems.push(`${file}: dynamic import of "./${match[1]}" which was not emitted`);
    }
  }
  // Deliberately narrow: our own runtime-config legitimately names the model
  // file when it builds a URL. These two strings appear only inside scanic's
  // own code — the ORT loader it ships, and the lazy sibling it imports.
  if (/ort-wasm-simd-threaded|scanic-mlDetector/.test(body)) {
    problems.push(
      `${file}: scanic or the ONNX Runtime was bundled into the library. It must be ` +
        `loaded at run time from assetBaseUrl instead — see src/lib/scanic-entry.ts.`
    );
  }
}
if (problems.length > 0) {
  console.error("\nBuild REFUSED:\n");
  for (const p of problems) console.error("  " + p);
  console.error("");
  process.exit(1);
}

/**
 * The two Web Workers, each bundled into one self-contained file under
 * `assets/workers/`.
 *
 * Separate from the main build and deliberately not code-split: a worker that
 * imports shared chunks needs those chunks resolvable from the worker's own URL,
 * which is a second set of paths to get right in somebody else's bundler. One
 * file each, no imports, loaded by URL like every other asset.
 */
/**
 * scanic, its ML detector and the ONNX Runtime wrapper, bundled into
 * `assets/scanic/` as plain files that no consumer's bundler ever sees.
 *
 * Splitting is ON here, deliberately: scanic reaches its ML path through two
 * relative dynamic imports, and this is the one place where those siblings
 * should stay siblings — they land next to the entry, exactly where their own
 * specifiers expect them, served from the host's asset directory.
 *
 * The comment-stripping plugin does not run on this pass. Nothing downstream
 * re-bundles these files, so webpack's annotations are simply inert here, and
 * the ORT runtime's `new URL(..., import.meta.url)` resolves against its own
 * real location for the first time.
 */
await build({
  entryPoints: [join(ROOT, "src/lib/scanic-entry.ts")],
  outdir: join(ROOT, "assets/scanic"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: ["es2022", "chrome91", "firefox90", "safari16"],
  sourcemap: false,
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});

const WORKERS = [
  ["src/lib/render.worker.ts", "render.worker.js"],
  ["src/lib/dewarp/dewarp-classical.worker.ts", "dewarp-classical.worker.js"],
];
for (const [entry, name] of WORKERS) {
  // One `outfile` per worker rather than one `outdir` for both: esbuild mirrors
  // the entry points' shared directory structure into the output, which would
  // bury the dewarp worker one level deeper than the URL that loads it.
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile: join(ROOT, "assets/workers", name),
    bundle: true,
    splitting: false,
    format: "esm",
    platform: "browser",
    target: ["es2022", "chrome91", "firefox90", "safari16"],
    sourcemap: false,
    minify: true,
    legalComments: "none",
    logLevel: "warning",
  });
}

const workers = await readdir(join(ROOT, "assets/workers"));
for (const expected of ["render.worker.js", "dewarp-classical.worker.js"]) {
  if (!workers.includes(expected)) {
    console.error(`\nassets/workers/${expected} was not emitted.\n`);
    process.exit(1);
  }
}

await writeFile(join(DIST, "meta.json"), JSON.stringify(result.metafile), "utf8");
console.log(`built ${emitted.size} files into dist/`);
