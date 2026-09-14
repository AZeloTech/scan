#!/usr/bin/env node
// Fills assets/ from node_modules, so the tarball carries every runtime file the
// library can ask for and a host never reaches a CDN.
//
// What does NOT happen here: scanic's two lazy JavaScript chunks are not copied.
// esbuild follows their relative dynamic imports and emits them as our own
// chunks (verified empirically — see scripts/build.mjs). Only data files, which
// are located at runtime through a string base, need to live under assets/.
//
// assets/dewarp/ is not filled here either: it holds our own Rust crate's
// WebAssembly output, committed as a build artefact and rebuilt by
// dewarp-rs/build-wasm.sh when the crate changes.

import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets");

function packageDir(name) {
  // Resolve through package.json so we do not depend on a package's main entry.
  return dirname(require.resolve(`${name}/package.json`));
}

/** scanic-ml: the DocCornerNet model and the trimmed ONNX Runtime pair.
 *  The .mjs loader finds its .wasm sibling by name, so these three must stay
 *  together in one directory with their names unchanged. */
const ML = [
  "doccornernet_lean.ort",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];

/** pdf.js: the worker plus four runtime directories. pdf.js chooses which file
 *  it needs at runtime from the document's own fonts and character maps, so
 *  these are copied whole rather than sampled. Loaded only when a host enables
 *  `intake.pdf`. */
const PDFJS_DIRS = ["cmaps", "standard_fonts", "iccs", "wasm"];
const PDFJS_WORKER = "build/pdf.worker.min.mjs";

async function copyTree(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (src) => !src.endsWith(".map"),
  });
}

async function measure(dir) {
  let bytes = 0;
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await measure(full);
      bytes += inner.bytes;
      count += inner.count;
    } else {
      bytes += (await stat(full)).size;
      count += 1;
    }
  }
  return { bytes, count };
}

// --- scanic-ml ---------------------------------------------------------------
const mlSource = join(packageDir("scanic-ml"), "dist");
const mlTarget = join(ASSETS, "scanic-ml");
await rm(mlTarget, { recursive: true, force: true });
await mkdir(mlTarget, { recursive: true });
for (const file of ML) {
  const from = join(mlSource, file);
  if (!existsSync(from)) {
    console.error(
      `\nscanic-ml no longer ships ${file}.\n` +
        `The ML corner detector cannot be served same-origin without it, and there is no\n` +
        `CDN fallback by design. Check the scanic-ml release notes before upgrading.\n`
    );
    process.exit(1);
  }
  await cp(from, join(mlTarget, file));
}

// --- pdf.js ------------------------------------------------------------------
const pdfSource = packageDir("pdfjs-dist");
const pdfTarget = join(ASSETS, "pdfjs");
await rm(pdfTarget, { recursive: true, force: true });
await mkdir(pdfTarget, { recursive: true });
const worker = join(pdfSource, PDFJS_WORKER);
if (!existsSync(worker)) {
  console.error(`\npdfjs-dist no longer ships ${PDFJS_WORKER}. PDF import cannot work.\n`);
  process.exit(1);
}
await cp(worker, join(pdfTarget, "pdf.worker.min.mjs"));
for (const dir of PDFJS_DIRS) {
  const from = join(pdfSource, dir);
  if (!existsSync(from)) {
    console.error(`\npdfjs-dist no longer ships ${dir}/. PDF import would fail at runtime.\n`);
    process.exit(1);
  }
  await copyTree(from, join(pdfTarget, dir));
}

// --- dewarp (committed, only checked) ----------------------------------------
const dewarp = join(ASSETS, "dewarp");
if (!existsSync(dewarp)) {
  console.error(
    `\nassets/dewarp/ is missing. It holds the dewarp-rs WebAssembly build output and is\n` +
      `committed to this repository. Rebuild it with dewarp-rs/build-wasm.sh.\n`
  );
  process.exit(1);
}

const { bytes, count } = await measure(ASSETS);
console.log(
  `assets/ built — ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB ` +
    `(scanic-ml, pdfjs, dewarp).`
);
