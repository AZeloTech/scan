#!/usr/bin/env node
// Dist guard. Runs after `npm run build`.
//
// What must be true of what we are about to publish:
//   1. No asset was inlined as a data: URI. Vite library mode does this by
//      default and it is the failure the adversary caught: a data: WASM cannot
//      be streamed-compiled and forces `connect-src data:` on every host.
//   2. No OCR bytes ship. OCR was deleted, not carried (§7).
//   3. The entry module has no side effects at import: hosts must be able to
//      mock it, and a server-side render must not crash on `document`.
//   4. Every runtime asset exists.
//   5. Every CSS selector is scoped to `.scan-root`.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const DIST = join(process.cwd(), "dist");
const problems = [];

if (!existsSync(DIST)) {
  console.error("dist/ does not exist — run `npm run build` first.");
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(DIST);
const rel = (f) => f.slice(process.cwd().length + 1);

// 1. data: URIs
const DATA_URI = /data:(?:application\/wasm|application\/octet-stream|image\/[a-z+]+|font\/[a-z0-9]+);base64,[A-Za-z0-9+/]{512,}/;
for (const file of files) {
  if (![".js", ".mjs", ".css"].includes(extname(file))) continue;
  const body = readFileSync(file, "utf8");
  const hit = body.match(DATA_URI);
  if (hit) {
    problems.push(
      `${rel(file)}: an asset was inlined as a data: URI (${hit[0].slice(0, 48)}…). ` +
        `Assets must ship as real files under assets/ and be located through assetBaseUrl.`
    );
  }
}

// 2. OCR bytes
const OCR = /tesseract|traineddata|tessdata/i;
for (const file of files) {
  if (OCR.test(file)) {
    problems.push(`${rel(file)}: OCR artefact in dist — this library has no OCR.`);
    continue;
  }
  if (![".js", ".mjs"].includes(extname(file))) continue;
  const body = readFileSync(file, "utf8");
  if (OCR.test(body)) {
    problems.push(`${rel(file)}: references an OCR engine — this library has no OCR.`);
  }
}

// 3. No side effects at import in the entry module.
const entry = join(DIST, "index.js");
if (!existsSync(entry)) {
  problems.push("dist/index.js is missing.");
} else {
  const body = readFileSync(entry, "utf8");
  // Strip everything inside function bodies is overkill; instead look for the
  // known-dangerous globals appearing at statement depth 0 of the module.
  const topLevel = body
    .split("\n")
    .filter((line) => /^[A-Za-z_$({[]/.test(line)) // crude: unindented statements
    .join("\n");
  for (const bad of [
    ["navigator.mediaDevices", "camera access"],
    ["new Worker(", "worker construction"],
    ["document.createElement", "DOM access"],
    ["ort.env", "ONNX Runtime configuration"],
    ["window.", "window access"],
  ]) {
    if (topLevel.includes(bad[0])) {
      problems.push(
        `dist/index.js: ${bad[1]} appears at module top level (${bad[0]}). ` +
          `The entry must be importable in Node and mockable in tests.`
      );
    }
  }
}

// 4. Every asset the library can ask for must exist in assets/.
const ASSETS = join(process.cwd(), "assets");
const required = [
  "dewarp",
  "scanic-ml/doccornernet_lean.ort",
  "scanic-ml/ort-wasm-simd-threaded.mjs",
  "scanic-ml/ort-wasm-simd-threaded.wasm",
  "workers/render.worker.js",
  "workers/dewarp-classical.worker.js",
  "scanic/scanic-entry.js",
];
for (const entryPath of required) {
  if (!existsSync(join(ASSETS, entryPath))) {
    problems.push(`assets/${entryPath} is missing — run \`npm run build:assets\`.`);
  }
}

// 5. Every selector in the stylesheet is scoped to `.scan-root`.
//
// Importing `@azelotech/scan/styles.css` must not be able to style a single
// element of the host's page. Tailwind scopes the utilities through
// `important`, but it also emits rules of its own outside that mechanism — the
// `*, ::before, ::after` variable defaults, `::backdrop`, `.container` — so the
// output is checked, not the configuration. Keyframe steps are not selectors.
const STYLES = join(DIST, "styles.css");
if (!existsSync(STYLES)) {
  problems.push("dist/styles.css is missing.");
} else {
  const { default: postcss } = await import("postcss");
  const root = postcss.parse(readFileSync(STYLES, "utf8"));
  const escaped = new Set();
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
    for (const part of rule.selectors) {
      if (!/^\.scan-root(?![\w-])/.test(part.trim())) escaped.add(part.trim());
    }
  });
  root.walkAtRules((at) => {
    if (/^(font-face|import|page|property)$/i.test(at.name)) {
      escaped.add(`@${at.name}`);
    }
  });
  for (const selector of escaped) {
    problems.push(
      `dist/styles.css: "${selector.slice(0, 80)}" is not scoped to .scan-root — ` +
        `the stylesheet would reach elements of the host's page.`
    );
  }
}

if (problems.length > 0) {
  console.error("\nDist guard REFUSED this build:\n");
  for (const p of problems) console.error("  " + p);
  console.error("");
  process.exit(1);
}

const bytes = files.reduce((sum, f) => sum + statSync(f).size, 0);
console.log(`Dist guard clean — ${files.length} files, ${(bytes / 1024).toFixed(0)} KiB in dist/.`);
