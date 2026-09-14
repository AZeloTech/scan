import assert from "node:assert/strict";
import test from "node:test";

import { dewarpAssets } from "./assets.ts";
import { dewarpAssetsCached, prefetchDewarpAssets } from "./prefetch.ts";
import { assetUrls } from "../runtime-config.ts";

/** What a host that ran `scan-copy-assets` would pass. */
const urls = assetUrls("/scan-assets/");
const { wasmUrl, glueUrl } = dewarpAssets(urls);

/**
 * The module latch is per-process, so these run in order and share one run —
 * which is the thing under test. `fetch` is the only browser API the prefetch
 * touches; `caches` is absent here, and {@link dewarpAssetsCached} guards for
 * exactly that.
 */
const asked: string[] = [];
let openBodies = 0;

globalThis.fetch = (async (input: RequestInfo | URL) => {
  asked.push(String(input));
  openBodies += 1;
  // Two chunks, so a consumer that stops at the first one is visible.
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        controller.close();
        openBodies -= 1;
      },
    }),
  );
}) as typeof fetch;

test("nothing is cached before anything is fetched", async () => {
  assert.equal(await dewarpAssetsCached(urls), false);
});

test("the two files are pulled once each, in order, and drained", async () => {
  await prefetchDewarpAssets(urls);
  assert.deepEqual(asked, [wasmUrl, glueUrl]);
  // Both bodies read to the end: nothing left half-open for the service worker
  // to lose its cache write on.
  assert.equal(openBodies, 0);
});

test("the run is single-flight for the whole session", async () => {
  const again = prefetchDewarpAssets(urls);
  assert.equal(again, prefetchDewarpAssets(urls));
  await again;
  assert.deepEqual(asked, [wasmUrl, glueUrl]);
});

test("a completed run answers the cached question on its own", async () => {
  // No `caches` in this process at all — the session latch is the other half of
  // the answer, and it is what the consent copy reads on a phone that just
  // prefetched over Wi-Fi.
  assert.equal(typeof (globalThis as { caches?: unknown }).caches, "undefined");
  assert.equal(await dewarpAssetsCached(urls), true);
});
