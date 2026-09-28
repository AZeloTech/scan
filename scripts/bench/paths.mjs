/**
 * Where the bench reads from and writes to — and the one rule behind it.
 *
 * **Synthetic output lives in the repo's git-ignored `.bench-out/`. Anything
 * derived from real media lives outside the repository, in the user's cache
 * (`${XDG_CACHE_HOME:-~/.cache}/scan-bench/`), and nowhere else.** Real media
 * is found only through `SCAN_REAL_MEDIA`; the bench never goes looking for it.
 */

import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const BENCH_DIR = join(ROOT, "scripts", "bench");
export const APP_SOURCE_DIR = join(BENCH_DIR, "app");
export const LABEL_SOURCE_DIR = join(BENCH_DIR, "label");
export const ASSETS_DIR = join(ROOT, "assets");
export const DIST_DIR = join(ROOT, "dist");

/** Synthetic results: git-ignored, inside the repo. */
export const OUT_DIR = join(ROOT, ".bench-out");

/** The bench page's bundle. Code, not media — but generated, so it lives with the output. */
export const APP_BUILD_DIR = join(OUT_DIR, "app");

/**
 * Runtime assets the bench builds from the working tree to stand in for the
 * library's own (`/assets/workers/detect.worker.js`, with the probe on).
 */
export const APP_ASSETS_DIR = join(OUT_DIR, "app-assets");

/**
 * Pre-rendered session frames (synthetic JPEGs), keyed by script, stream size,
 * emulator source and browser build — rendered once, replayed by every later
 * run of the same session. Synthetic only: a real clip is never cached here.
 */
export const FRAME_CACHE_DIR = join(OUT_DIR, "frame-cache");

/** The cache for anything derived from real media. Never inside the repository. */
export function cacheDir() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(base, "scan-bench");
  if (isInside(dir, ROOT)) {
    throw new Error(
      `the real-media cache would be ${dir}, inside this repository. ` +
        "Point XDG_CACHE_HOME somewhere outside it.",
    );
  }
  return dir;
}

/** Pre-extracted real frames, served read-only at /real/frames/ when SCAN_REAL_MEDIA is set. */
export function realFramesDir() {
  return join(cacheDir(), "frames");
}

/** Real-media runs: reports, results and contact sheets that may embed real pixels. */
export function realRunsDir() {
  return join(cacheDir(), "runs");
}

/** `SCAN_REAL_MEDIA`, or null. */
export function realMediaDir() {
  const dir = process.env.SCAN_REAL_MEDIA;
  return dir === undefined || dir === "" ? null : resolve(dir);
}

/** Whether `child` is `parent` or lies beneath it. */
export function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
