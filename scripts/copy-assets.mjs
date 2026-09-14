#!/usr/bin/env node
// `npx scan-copy-assets <public-dir> [--subdir scan-assets]`
//
// Copies this package's runtime assets into a directory the host serves
// same-origin, and prints the assetBaseUrl to pass to <ScanFlow>.
//
// Why a copy step instead of `new URL(..., import.meta.url)`: the ML detector,
// the ONNX Runtime pair and the pdf.js runtime are located through a *string
// base* at runtime, not through bundler-rewritten URLs, and a library cannot
// rewrite its consumer's emitted asset names. Hosts run this once in their build
// (a RUN line in a Dockerfile, or a prebuild script) and the assets land under a
// stable, unhashed path.

import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(PKG_ROOT, "assets");

function usage(message) {
  if (message) console.error("\n" + message + "\n");
  console.error(
    "Usage: scan-copy-assets <public-dir> [--subdir <name>]\n\n" +
      "  <public-dir>   directory your server exposes at the web root (e.g. public, dist, static)\n" +
      "  --subdir       folder name created inside it (default: scan-assets)\n\n" +
      "Example:\n" +
      "  npx scan-copy-assets public\n" +
      "  → copies to public/scan-assets, pass assetBaseUrl=\"/scan-assets\"\n"
  );
  process.exit(message ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) usage();

const publicDir = argv.find((a) => !a.startsWith("--"));
const subdirFlag = argv.indexOf("--subdir");
const subdir = subdirFlag === -1 ? "scan-assets" : argv[subdirFlag + 1];

if (!publicDir) usage("No target directory given.");
if (!subdir || subdir.startsWith("--")) usage("--subdir needs a name.");

if (!existsSync(SOURCE)) {
  console.error(
    `\n${SOURCE} does not exist.\n` +
      "If you are working inside a checkout of the scan repository, run `npm run build:assets` first.\n" +
      "If you see this from an installed package, the tarball is broken — please open an issue.\n"
  );
  process.exit(1);
}

const target = resolve(process.cwd(), publicDir, subdir);
await mkdir(target, { recursive: true });
await cp(SOURCE, target, { recursive: true });

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

const { bytes, count } = await measure(target);

console.log(
  `\n@azelotech/scan — copied ${count} files (${(bytes / 1024 / 1024).toFixed(1)} MB) to ${target}\n\n` +
    `  <ScanFlow assetBaseUrl="/${subdir}" … />\n\n` +
    "Serve that folder without hashing or renaming its files, with long-lived\n" +
    "immutable caching. Your CSP needs:\n" +
    "  script-src 'self' 'wasm-unsafe-eval'   (add 'unsafe-eval' to support Safari < 16)\n" +
    "  worker-src 'self' blob:\n" +
    "  img-src 'self' blob: data:\n"
);
