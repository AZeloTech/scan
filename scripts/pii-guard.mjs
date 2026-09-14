#!/usr/bin/env node
// PII guard. This repository is public and the products built on it handle health
// documents. No personal data ever enters it: no photograph-derived raster, no real
// name, CPF, phone or e-mail. The guard runs in CI over the whole tree and in the
// native pre-commit hook over the staged files.
//
// Exit 0 = clean. Exit 1 = refuse. There is no override flag, by design.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname, basename, relative, join } from "node:path";

const ROOT = process.cwd();
const STAGED = process.argv.includes("--staged");

/** Binary media may exist ONLY under fixtures/ (synthetic, with a provenance row)
 *  and under assets/ (model weights, WASM, fonts — machine artefacts, never pages). */
const MEDIA = new Set([
  ".png", ".jpg", ".jpeg", ".heic", ".heif", ".webp", ".gif", ".bmp", ".tif", ".tiff",
  ".avif", ".pdf", ".mp4", ".mov", ".webm", ".avi", ".dcm", ".svg",
]);
const MEDIA_ALLOWED_PREFIXES = ["fixtures/", "assets/"];

/** Paths that must never exist here at all: anything shaped like a dump of
 *  photographed pages. Named rather than guessed, so the guard says why. */
const FORBIDDEN_PATHS = [
  /(^|\/)data\//,
  /(^|\/)parity\/fixtures\//,
  /(^|\/)detect-bench\/(samples|captures|photos|videos)\//,
  /(^|\/)pii_free(\/|$)/,
];

/** The only human identities allowed to appear anywhere in this repository. */
const PERSONA_ALLOW = [
  "joao azelo", "joão azelo", "maria azelo", "azelo",
  "000.000.000-00", "00000000000",
];

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".css", ".html",
  ".yml", ".yaml", ".rs", ".toml", ".sh", ".txt", ".env",
]);

const PATTERNS = [
  { name: "CPF", re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g },
  { name: "CNPJ", re: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g },
  { name: "BR phone", re: /\b(?:\+55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g },
  // The TLD must be alphabetic, or every `package@1.2.3` specifier is an e-mail.
  { name: "e-mail", re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g },
  { name: "CNS (cartao SUS)", re: /\b\d{3}\s?\d{4}\s?\d{4}\s?\d{4}\b/g },
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "AWS key id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "bearer-ish secret", re: /\b(?:secret|password|passwd|token)\s*[:=]\s*["'][^"'\s]{12,}["']/gi },
];

function listFiles() {
  const args = STAGED
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["ls-files"];
  const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function provenanceNames() {
  try {
    const md = readFileSync(join(ROOT, "fixtures", "PROVENANCE.md"), "utf8");
    const names = new Set();
    for (const m of md.matchAll(/^\s*[-|]\s*`([^`]+)`/gm)) names.add(m[1].trim());
    return names;
  } catch {
    return new Set();
  }
}

function allowedIdentity(hit, lower) {
  if (PERSONA_ALLOW.some((p) => lower.includes(p))) return true;
  const at = hit.indexOf("@");
  if (at !== -1) {
    const host = hit.slice(at + 1).toLowerCase();
    // example.com / example.org / localhost are fine in docs and tests
    if (/^(example\.(com|org|net)|localhost|test)$/.test(host)) return true;
  }
  return false;
}

const violations = [];
const files = listFiles();
const provenance = provenanceNames();

for (const file of files) {
  const ext = extname(file).toLowerCase();

  for (const re of FORBIDDEN_PATHS) {
    if (re.test(file)) {
      violations.push(`${file}: this path is forbidden — it is where photographed pages collect`);
    }
  }

  if (MEDIA.has(ext)) {
    const underAllowed = MEDIA_ALLOWED_PREFIXES.some((p) => file.startsWith(p));
    if (!underAllowed) {
      violations.push(
        `${file}: binary media outside fixtures/ and assets/ — no photograph-derived raster may exist here (§0.1)`
      );
    } else if (file.startsWith("fixtures/") && !provenance.has(basename(file))) {
      violations.push(
        `${file}: fixture has no row in fixtures/PROVENANCE.md — every fixture must name the script and seed that generated it (§0.3)`
      );
    }
    continue;
  }

  if (!TEXT_EXT.has(ext)) continue;

  let size = 0;
  try {
    size = statSync(join(ROOT, file)).size;
  } catch {
    continue; // staged deletion or a path that no longer exists
  }
  if (size > 2_000_000) continue; // generated bundles, lockfiles

  let body;
  try {
    body = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  if (body.includes("pii-guard: allow-file")) continue;

  const lines = body.split("\n");
  lines.forEach((line, i) => {
    if (line.includes("pii-guard: allow-line")) return;
    const lower = line.toLowerCase();
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const hit = m[0];
        if (allowedIdentity(hit, lower)) continue;
        // version strings and hashes trip the phone pattern; require a separator shape
        if (name === "BR phone" && !/[()\-\s]/.test(hit)) continue;
        if (name === "CNS (cartao SUS)" && !/\s/.test(hit)) continue;
        violations.push(`${file}:${i + 1}: possible ${name} — ${hit}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("\nPII guard REFUSED this tree:\n");
  for (const v of violations) console.error("  " + v);
  console.error(
    "\nNothing personal enters this repository. Replace the content with a synthetic\n" +
      "fixture or a persona from the allowlist. There is no override flag.\n"
  );
  process.exit(1);
}

console.log(`PII guard clean — ${files.length} tracked files checked.`);
