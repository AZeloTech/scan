// The build-time switch for the development bench's probe (src/lib/probe.ts),
// as esbuild options — one place, so the library build, the bench bundle and
// the test that holds them to it cannot drift apart.
//
// OFF (the library, its workers and its runtime assets): the constant is the
// literal `false`, so every forwarding branch is dead and the module that knows
// where a listener lives (src/lib/probe-hook.ts) is tree-shaken out; the dead
// branches are labelled BENCH_PROBE and dropped, so not even their text is left.
// scripts/check-dist.mjs refuses a published build where any of it survived.
//
// ON (the bench's own bundle, scripts/bench/build-app.mjs): the constant is
// `true` and the probe forwards copies of its events to a page's listener.

const SWITCH = "globalThis.__SCAN_PROBE_BUILD__";

export const PROBE_OFF = Object.freeze({
  define: { [SWITCH]: "false" },
  dropLabels: ["BENCH_PROBE"],
});

export const PROBE_ON = Object.freeze({
  define: { [SWITCH]: "true" },
});
