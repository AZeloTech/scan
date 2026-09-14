/**
 * Fetching the curved-page engine *before* anyone asks for it — on Wi-Fi only.
 *
 * The engine is one wasm module plus its `wasm-bindgen` glue
 * ({@link dewarpAssets}, ~130 KB gzipped together), and without this the user
 * pays for them at the worst possible moment: standing over a book with a photo
 * already taken, watching a progress bar. On Wi-Fi that wait is avoidable — the
 * bytes can be in the browser's HTTP cache long before the switch is touched.
 *
 * Everything about this is deliberately timid:
 *
 *  * **Wi-Fi only, decided by the caller** (`lib/network.ts`). This module
 *    fetches what it is told to fetch; the decision of whether the user is
 *    paying for it lives with the reading of the connection.
 *  * **Sequential, never parallel.** Two streams at once spike a phone's radio
 *    and its memory for no gain — the second file is not needed a second
 *    sooner, and the capture path is using the same device.
 *  * **Drained, not retained.** The bytes are read to the end (a cache only
 *    keeps a response the page actually consumes) and thrown away chunk by
 *    chunk. Nothing here holds the module alive.
 *  * **Silent.** Every failure is swallowed. A prefetch that did not happen is
 *    the state the app was in before this file existed: the user opts in and
 *    downloads it then. A prefetch that surfaced an error would be a bug report
 *    about a favour nobody asked for.
 *  * **Once per page-session, per asset base.** A module latch keyed by the
 *    wasm's own URL, so remounting the capture screen — or mounting it on every
 *    page of a ten-page scan — costs nothing, while a host that somehow served
 *    a second base still gets an honest answer for it.
 */

import { dewarpAssets } from "./assets.ts";
import type { AssetUrls } from "../runtime-config.ts";

/** The one run per asset base, alive for the whole page-session. */
const runs = new Map<string, Promise<void>>();

/** Bases whose two files both came back whole. Cleared by nothing. */
const completed = new Set<string>();

/**
 * Pull one asset through the browser's cache and forget it.
 *
 * `cache: "force-cache"` matches the engine's own fetch, so a hit here is a hit
 * there. Reading the body to the end is not optional: an abandoned body can
 * take the cache write down with it.
 */
async function warm(url: string): Promise<void> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`prefetch ${url}: ${response.status}`);
  const body = response.body;
  if (body === null) {
    // No streams (or an empty body): consume it the only way left.
    await response.arrayBuffer();
    return;
  }
  const reader = body.getReader();
  // Read to completion, dropping every chunk on the floor as it arrives.
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

/**
 * Warm the curved-page engine's files, at most once per page-session.
 *
 * Resolves when the attempt is over, whether or not it worked; never rejects.
 */
export function prefetchDewarpAssets(urls: AssetUrls): Promise<void> {
  const { wasmUrl, glueUrl } = dewarpAssets(urls);
  const existing = runs.get(wasmUrl);
  if (existing !== undefined) return existing;
  const run = (async () => {
    try {
      await warm(wasmUrl);
      await warm(glueUrl);
      completed.add(wasmUrl);
    } catch {
      // Best effort, by design. See the note at the top of this file.
    }
  })();
  runs.set(wasmUrl, run);
  return run;
}

/**
 * Whether turning the correction on would download anything.
 *
 * Two ways to be sure: this session already fetched everything, or a cache is
 * holding the engine's primary asset from some earlier visit. `caches` is
 * guarded because it does not exist without a secure context — and a browser
 * that cannot cache has, correctly, nothing stored.
 */
export async function dewarpAssetsCached(urls: AssetUrls): Promise<boolean> {
  const { wasmUrl } = dewarpAssets(urls);
  if (completed.has(wasmUrl)) return true;
  try {
    if (typeof caches === "undefined") return false;
    return (await caches.match(wasmUrl)) !== undefined;
  } catch {
    return false;
  }
}
