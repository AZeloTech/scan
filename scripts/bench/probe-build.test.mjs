import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

import { PROBE_OFF, PROBE_ON } from "../probe-switch.mjs";
import { ROOT } from "./paths.mjs";

/**
 * The probe (`src/lib/probe.ts`) is how the bench watches the scanner, and
 * nothing a host page should be able to reach. These tests bundle the probe
 * module the way each build does and hold them to it: the library's switch
 * leaves no forwarding code, no hook name and no hook source (not even in the
 * source map) behind, and a page cannot turn it back on at run time; the
 * bench's switch keeps it. `scripts/check-dist.mjs` checks the real `dist/`.
 */

const ENTRY = join(ROOT, "src/lib/probe.ts");

async function bundle(options) {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    outdir: join(ROOT, ".bench-out", "probe-build-test"),
    sourcemap: "external",
    logLevel: "silent",
    ...options,
  });
  const js = result.outputFiles.find((f) => f.path.endsWith(".js")).text;
  const map = JSON.parse(result.outputFiles.find((f) => f.path.endsWith(".map")).text);
  return { js, map };
}

/** Import bundled code as a module of its own (no file written). */
function load(js) {
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

test("the library's switch compiles the forwarding out, source map included", async () => {
  const { js, map } = await bundle(PROBE_OFF);
  assert.ok(!js.includes("__SCAN_PROBE__"), "the hook's name is gone from the code");
  assert.ok(!js.includes("__SCAN_PROBE_BUILD__"), "the switch was folded, not left to read at run time");
  assert.ok(!js.includes("probeListener"), "no dead branch names the dropped module");
  assert.ok(!map.sources.some((s) => s.includes("probe-hook")), "the hook module is not in the bundle at all");
  assert.ok(!(map.sourcesContent ?? []).some((s) => s.includes("__SCAN_PROBE__")), "nor in the source map");
});

test("a page cannot switch the compiled-out probe back on", async () => {
  const { js } = await bundle(PROBE_OFF);
  const module = await load(js);
  const seen = [];
  globalThis.__SCAN_PROBE__ = (event) => seen.push(event);
  globalThis.__SCAN_PROBE_BUILD__ = true;
  try {
    assert.equal(module.probing(), false);
    module.probe({ type: "hint", t: 1, key: "k", shown: true });
  } finally {
    delete globalThis.__SCAN_PROBE__;
    delete globalThis.__SCAN_PROBE_BUILD__;
  }
  assert.deepEqual(seen, []);
});

test("the bench's switch keeps the forwarding, and hands the listener a copy", async () => {
  const { js } = await bundle(PROBE_ON);
  assert.ok(js.includes("__SCAN_PROBE__"));
  const module = await load(js);
  const seen = [];
  const event = { type: "confirm-done", t: 1, corners: { topLeft: { x: 0.1, y: 0.1 } }, edited: false, wholePhoto: false };
  globalThis.__SCAN_PROBE__ = (heard) => seen.push(heard);
  try {
    assert.equal(module.probing(), true);
    module.probe(event);
  } finally {
    delete globalThis.__SCAN_PROBE__;
  }
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], event);
  assert.notEqual(seen[0].corners, event.corners);
});
