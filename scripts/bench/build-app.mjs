/**
 * The bench page's bundle, and the runtime files it needs.
 *
 * The page imports the library's **source** (`src/lib/flatten.ts` and friends)
 * rather than a packed build, so a bench run always measures the working tree.
 * esbuild resolves the `@/` alias through `tsconfig.json`, exactly as
 * `scripts/build.mjs` does, and leaves `scanic` external: the library loads it
 * at run time from `assets/scanic/`, and so does the bench.
 */

import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROBE_ON } from "../probe-switch.mjs";
import { APP_BUILD_DIR, APP_SOURCE_DIR, ASSETS_DIR, DIST_DIR, LABEL_SOURCE_DIR, ROOT } from "./paths.mjs";

/** What the detectors load at run time, from `assetBaseUrl`. */
const RUNTIME_ASSETS = [
  "scanic/scanic-entry.js",
  "scanic-ml/doccornernet_lean.ort",
  "scanic-ml/ort-wasm-simd-threaded.mjs",
  "scanic-ml/ort-wasm-simd-threaded.wasm",
];

function missingAssets() {
  return RUNTIME_ASSETS.filter((file) => !existsSync(join(ASSETS_DIR, file)));
}

function runStep(script, log) {
  log(`bench: building runtime assets — node ${script}`);
  const result = spawnSync(process.execPath, [join(ROOT, script)], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${script} failed (exit ${result.status})`);
}

/**
 * Whether `dist/styles.css` is missing or older than anything it is compiled
 * from: `src/styles.css`, the Tailwind and PostCSS configs, and every source
 * file Tailwind scans for class names (`content` in `tailwind.config.ts`).
 * A stale sheet would lay the flow out without a class the source now uses.
 */
function stylesStale() {
  const built = join(DIST_DIR, "styles.css");
  if (!existsSync(built)) return true;
  const builtAt = statSync(built).mtimeMs;
  const inputs = [join(ROOT, "tailwind.config.ts"), join(ROOT, "postcss.config.js")];
  const src = join(ROOT, "src");
  for (const entry of readdirSync(src, { recursive: true })) {
    if (/\.(tsx?|css)$/.test(entry)) inputs.push(join(src, entry));
  }
  return inputs.some((file) => existsSync(file) && statSync(file).mtimeMs > builtAt);
}

/**
 * Make sure `assets/` holds the detector runtime, running the repository's own
 * build steps when it does not: `build-assets.mjs` for the model and ONNX
 * Runtime, `build.mjs` for the scanic entry (which also rebuilds `dist/`).
 * With `styles`, also that `dist/styles.css` exists and is current — every
 * page that mounts `<ScanFlow>` needs it for its layout.
 */
export function ensureRuntimeAssets({ log = console.log, styles = false } = {}) {
  let missing = missingAssets();
  if (missing.some((file) => file.startsWith("scanic-ml/"))) {
    runStep("scripts/build-assets.mjs", log);
    missing = missingAssets();
  }
  if (missing.some((file) => file.startsWith("scanic/"))) {
    runStep("scripts/build.mjs", log);
    missing = missingAssets();
  }
  if (missing.length > 0) {
    throw new Error(
      `the detector runtime is still missing after building: ${missing.join(", ")}. ` +
        "Run `npm run build` and look at its output.",
    );
  }
  if (styles && stylesStale()) {
    log("bench: building dist/styles.css — npm run build:styles");
    const result = spawnSync("npm", ["run", "build:styles"], { cwd: ROOT, stdio: "inherit" });
    if (result.status !== 0) throw new Error("npm run build:styles failed");
  }
}

/**
 * Bundle every page — `scripts/bench/app/` and the labelling page in
 * `scripts/bench/label/` — into `.bench-out/app/`, flat: page `x` is `/app/x.js`.
 */
export async function buildBenchApp({ outdir = APP_BUILD_DIR } = {}) {
  const entryPoints = {};
  for (const dir of [APP_SOURCE_DIR, LABEL_SOURCE_DIR]) {
    for (const name of readdirSync(dir)) {
      if (!/\.(jsx?|mjs)$/.test(name) || /\.test\./.test(name) || !isEntry(name)) continue;
      const page = name.replace(/\.(jsx?|mjs)$/, "");
      if (page in entryPoints) throw new Error(`two bench pages are called "${page}"`);
      entryPoints[page] = join(dir, name);
    }
  }
  await build({
    entryPoints,
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: ["es2022", "chrome110"],
    jsx: "automatic",
    sourcemap: true,
    minify: false,
    external: ["scanic"],
    // The probe forwards events only in a build that says so: this one. The
    // library build compiles the seam out (scripts/probe-switch.mjs).
    define: { "process.env.NODE_ENV": '"development"', ...PROBE_ON.define },
    // The package's `sideEffects: ["*.css"]` is true of the library and false of
    // the emulator, whose families, materials and documents register
    // themselves on import. Honour the imports as written.
    ignoreAnnotations: true,
    logLevel: "warning",
  });
  return { outdir, entries: Object.keys(entryPoints) };
}

/**
 * Entry points are the pages: a module the server can put in a `<script>`.
 * Helpers the pages import are not entries.
 */
const PAGE_ENTRIES = new Set(["bench.js"]);

function isEntry(name) {
  return PAGE_ENTRIES.has(name) || /^page-.*\.(jsx?|mjs)$/.test(name);
}
