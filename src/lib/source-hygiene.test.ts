import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * **This product makes no off-origin request.** That is the promise the whole
 * library is sold on — a patient's health document is opened, straightened and
 * turned into a PDF without a byte of it, or a byte about it, leaving the
 * device — and it is a property of the *whole source tree*, not of any one
 * function. A unit test cannot see it; a grep can.
 *
 * A library is held to a stricter rule than an application would be: there
 * are no routes, no service worker, no server config, no vendored OCR runtime
 * and no visit counter here, so there is no privileged page to carve an
 * exception out for. **Nothing in `src/` may reach off-origin, and nothing may
 * reach for OCR or analytics at all.**
 *
 * Four rules, and each failure message states the rule rather than the match:
 *
 *  1. no URL literal pointing at another origin;
 *  2. no `fetch` / `XMLHttpRequest` / `sendBeacon` outside the modules that
 *     derive their URL from the host's `assetBaseUrl`;
 *  3. no mention of tesseract, analytics or umami anywhere;
 *  4. every JPEG encode still goes through `lib/encode.ts`.
 *
 * Needles are assembled from pieces (`"um" + "ami"`) so this file does not
 * match itself.
 */

const SOURCE_ROOT = path.join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

function relative(file: string): string {
  return path.relative(SOURCE_ROOT, file);
}

/**
 * The lines of a file that are neither a comment nor inside a block comment.
 *
 * Doc comments are where this library *explains* the rule, and an explanation
 * quotes what it forbids — `https://cdn.example/model.ort` in a paragraph about
 * why the CDN default is overridden is documentation, not a request. Stripping
 * comments is what lets those paragraphs stay honest and specific instead of
 * being written around the test.
 *
 * Crude on purpose: it does not understand a `//` inside a string literal. The
 * cost of that is a line skipped in a file that also has a real off-origin URL
 * on the *same* line, which is a shape no code in this tree has; the benefit is
 * that it has no parser to be wrong in more interesting ways.
 */
function codeLines(source: string): { line: string; number: number }[] {
  const out: { line: string; number: number }[] = [];
  let inBlock = false;
  source.split("\n").forEach((raw, index) => {
    let line = raw;
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close === -1) return;
      line = line.slice(close + 2);
      inBlock = false;
    }
    for (;;) {
      const open = line.indexOf("/*");
      if (open === -1) break;
      const close = line.indexOf("*/", open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlock = true;
        break;
      }
      line = line.slice(0, open) + line.slice(close + 2);
    }
    const comment = line.indexOf("//");
    if (comment !== -1) line = line.slice(0, comment);
    if (line.trim() !== "") out.push({ line, number: index + 1 });
  });
  return out;
}

// ── rule 1: no off-origin URL literal ────────────────────────────────────────

/**
 * `https://github.com/...` in a licence header or a `@see` is documentation and
 * lives in a comment, which `codeLines` has already removed. What is left is
 * the two places a scheme legitimately appears in *code*: the `package.json`
 * metadata mirrored into `pdf.ts`'s producer string (there is none — it is a
 * package name), and a URL built for an error message about a bad
 * `assetBaseUrl`. Neither needs a host, so the allowlist is empty and stays
 * empty: a library that never fetches off-origin has no reason to write another
 * origin down.
 */
test("no source file contains an off-origin URL literal", () => {
  const scheme = /(["'`])(https?:\/\/[^"'`\s]+)/g;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    for (const { line, number } of codeLines(readFileSync(file, "utf8"))) {
      for (const match of line.matchAll(scheme)) {
        assert.fail(
          `${relative(file)}:${number} contains the URL ${match[2]}.\n` +
            "RULE: this library makes no off-origin request, ever. Every " +
            "runtime file it needs is served by the host from `assetBaseUrl`. " +
            "If this URL is an example or a citation, put it in " +
            "a comment; if it is a request, it cannot ship.",
        );
      }
    }
  }
});

// ── rule 2: no network API outside the asset path ────────────────────────────

/**
 * The modules that may call `fetch`.
 *
 * Every one of them fetches a URL built by `lib/runtime-config.ts` out of the
 * host's `assetBaseUrl` — the corner-detection model, the ONNX Runtime pair,
 * the dewarp WebAssembly, the pdf.js runtime — which is same-origin by
 * construction and checked at mount by `explainBadAssetBaseUrl`. A `fetch` in
 * any other module is a request nobody has reasoned about.
 */
const MAY_FETCH = new Set(
  [
    ["lib", "runtime-config.ts"],
    ["lib", "ml-detection.ts"],
    ["lib", "assets.ts"],
    ["lib", "dewarp", "engine.ts"],
    ["lib", "dewarp", "index.ts"],
    ["lib", "dewarp", "loader.ts"],
    ["lib", "dewarp", "prefetch.ts"],
    ["lib", "pdf-import.ts"],
  ].map((parts) => path.join(SOURCE_ROOT, ...parts)),
);

test("only the asset loaders touch the network, and never a beacon", () => {
  const always = [`XMLHttp` + `Request`, `send` + `Beacon`];
  const unlessAllowed = [`fetch` + `(`, `new ` + `EventSource`, `new ` + `WebSocket`];

  for (const file of sourceFiles(SOURCE_ROOT)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const lines = codeLines(readFileSync(file, "utf8"));
    for (const { line, number } of lines) {
      for (const needle of always) {
        assert.ok(
          !line.includes(needle),
          `${relative(file)}:${number} uses ${needle}.\n` +
            "RULE: nothing in this library sends anything anywhere. There is " +
            "no telemetry channel and no beacon; `onEvent` hands numbers and " +
            "enums to the host, and the host decides.",
        );
      }
      if (MAY_FETCH.has(file)) continue;
      for (const needle of unlessAllowed) {
        assert.ok(
          !line.includes(needle),
          `${relative(file)}:${number} opens a connection (${needle}).\n` +
            "RULE: the only requests this library makes are for its own runtime " +
            "files, at URLs derived from the host's assetBaseUrl, from the " +
            "modules listed in MAY_FETCH in this test. If this is a new asset " +
            "loader, add it there and say which asset it loads; if it is " +
            "anything else, it cannot ship.",
        );
      }
    }
  }
});

// ── rule 3: the deleted features stay deleted ────────────────────────────────

/**
 * Banned outright, comments included, because the tarball guard greps the built
 * output and a comment can survive minification: the OCR engine's name, its
 * language data, and the visit counter's.
 */
const BANNED_ANYWHERE = [`tess` + `eract`, `train` + `eddata`, `um` + `ami`];

/**
 * Banned in code only. Prose is allowed to name these, because explaining that
 * a module was deleted and why is exactly what a doc comment in this tree is
 * for — and an explanation that cannot name its subject is not one.
 */
const BANNED_IN_CODE = [`analy` + `tics`, `debug-` + `metrics`, `gtag` + `(`];

const DELETED_RULE =
  "RULE: OCR, the ?debug=1 metrics log and every visit counter are absent " +
  "from this library rather than disabled. The tarball guard " +
  "greps the built output for the OCR engine's name, and a counter is one " +
  "import away from breaking the no-network promise. A future " +
  "@azelotech/scan-ocr would consume the finished PDF, not the pages.";

test("nothing reaches for OCR, analytics or a visit counter", () => {
  for (const file of sourceFiles(SOURCE_ROOT)) {
    if (file === path.join(SOURCE_ROOT, "lib", "source-hygiene.test.ts")) continue;
    const source = readFileSync(file, "utf8");
    const lowered = source.toLowerCase();
    for (const needle of BANNED_ANYWHERE) {
      assert.ok(
        !lowered.includes(needle),
        `${relative(file)} mentions "${needle}" — anywhere, comments included.\n` +
          DELETED_RULE,
      );
    }
    for (const { line, number } of codeLines(source)) {
      const loweredLine = line.toLowerCase();
      for (const needle of BANNED_IN_CODE) {
        assert.ok(
          !loweredLine.includes(needle),
          `${relative(file)}:${number} reaches for "${needle}".\n` + DELETED_RULE,
        );
      }
    }
  }
});

// ── rule 4: one encoder ──────────────────────────────────────────────────────

test("every JPEG encode goes through lib/encode.ts", () => {
  // Two needles, one blessed file. The render tail runs on two threads —
  // `toBlob` is the main thread's encoder and `convertToBlob` the worker's —
  // and the fidelity promise ("one lossy generation from the canonical to the
  // PDF") survives that only because both live in the same module, behind the
  // same quality table. A second call site anywhere is a second generation the
  // page never agreed to.
  const needles = [`toBlob` + `(`, `convertToBlob` + `(`];
  const allowed = path.join(SOURCE_ROOT, "lib", "encode.ts");

  for (const file of sourceFiles(SOURCE_ROOT)) {
    if (file === allowed) continue;
    const source = readFileSync(file, "utf8");
    for (const needle of needles) {
      assert.ok(
        !source.includes(needle),
        `${relative(file)} encodes its own image (${needle}).\n` +
          "RULE: lib/encode.ts is the only module allowed to write a JPEG, so " +
          "that every generation is counted and every page reaches the PDF " +
          "through exactly one quality table.",
      );
    }
  }
});

test("the build-time re-encode of a turned page is gone", () => {
  const needle = `rotate` + `Jpeg`;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    assert.ok(
      !readFileSync(file, "utf8").includes(needle),
      `${relative(file)} still reaches for ${needle}.\n` +
        "RULE: rotation is baked into the page's own single render " +
        "(lib/page-processing.ts), so turning a page costs no extra encode.",
    );
  }
});

// ── rule 5: the host's page is not ours ──────────────────────────────────────

/**
 * A component embedded in somebody else's page owns neither the back button
 * nor the origin's storage. Pushing a history entry breaks the host's
 * navigation in ways only the host can see (an entry that outlives the overlay
 * that pushed it, a back gesture that no longer means what it meant), so the
 * history API is banned outright. Storage is allowed in exactly one module —
 * `lib/tips.ts`, the UI-tip flags the README lists — so the list of keys this
 * library writes cannot grow without a test saying so.
 */
test("nothing touches the host's history, and only the tip flags touch storage", () => {
  const history = [
    `history` + `.push` + `State`,
    `history` + `.replace` + `State`,
    `history` + `.back`,
    `history` + `.go`,
    `"pop` + `state"`,
  ];
  const storage = [`local` + `Storage`, `session` + `Storage`, `indexed` + `DB`];
  const mayStore = path.join(SOURCE_ROOT, "lib", "tips.ts");

  for (const file of sourceFiles(SOURCE_ROOT)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    for (const { line, number } of codeLines(readFileSync(file, "utf8"))) {
      for (const needle of history) {
        assert.ok(
          !line.includes(needle),
          `${relative(file)}:${number} touches the page's history (${needle}).\n` +
            "RULE: the host owns the URL and the back button. The library's " +
            "overlays close through their own controls and Escape.",
        );
      }
      if (file === mayStore) continue;
      for (const needle of storage) {
        assert.ok(
          !line.includes(needle),
          `${relative(file)}:${number} touches browser storage (${needle}).\n` +
            "RULE: pages live in memory only. The one persisted thing is a " +
            "UI-tip flag, written by lib/tips.ts under a `scan.` key the " +
            "README lists.",
        );
      }
    }
  }
});
