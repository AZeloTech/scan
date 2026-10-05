import assert from "node:assert/strict";
import test from "node:test";

import { loadScanic } from "./scanic-runtime.ts";
import type { AssetUrls } from "./runtime-config.ts";

function urlsWith(scanic: string): AssetUrls {
  return { scanic } as unknown as AssetUrls;
}

test("a failed load is forgotten: the next attempt fetches again", async () => {
  const broken = urlsWith("data:text/javascript,throw new Error('transient')");
  await assert.rejects(loadScanic(broken));
  await assert.rejects(loadScanic(broken), "the second attempt must be a new import, not the remembered failure");
  const working = urlsWith("data:text/javascript,export const ok = 1;");
  const loaded = (await loadScanic(working)) as unknown as { ok: number };
  assert.equal(loaded.ok, 1);
  // A success is memoised.
  assert.equal(await loadScanic(broken), loaded);
});
