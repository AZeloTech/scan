#!/usr/bin/env node
/**
 * `npm run bench:webkit` — the real `<ScanFlow>` on the bench camera in
 * **WebKit** (Playwright's build), end to end: permission primer, a live
 * viewfinder that finds the page and guides the aim (a hint, the ready cue),
 * auto-capture switched on and firing, a tap, the confirm screens.
 *
 * WebKit is where the detection worker's features are least certain (Safari
 * before 16.4 has no 2-D `OffscreenCanvas` in a worker) and where the
 * main-thread lane is most likely to carry a session, so the smoke plays one
 * session on each lane: the one the app picks by itself (and the reason it
 * gives), and the main-thread lane forced (`--lane main` through the probe).
 * The session's frames are rendered once by Chromium into the frame cache
 * (WebKit plays them, it renders nothing), and the fake camera has no still
 * pipeline — Safari has no `ImageCapture` — so every capture is a preview
 * frame, as it is on an iPhone.
 *
 * Exits 0 when every run passed: the camera went live, the lane was reported,
 * the model came up and answered passes, the overlay found the page, the hint
 * the script's condition owes was shown, the ready cue came on over the page,
 * the auto-capture toggle was found and switched on and an automatic capture
 * fired, every tap made a capture, every confirm screen opened, and the page
 * threw nothing. The default session is `too-far` (the page small in the
 * frame — "Aproxime" — then framed and held, with auto-capture on).
 * Writes `.bench-out/webkit-smoke-<stamp>/results.json`. Linux WebKit is not
 * iOS Safari: this proves the paths run, not how a phone feels.
 *
 *   npm run bench:webkit [-- --session tremor-hold --seed 1 --out dir]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildBenchApp, ensureRuntimeAssets } from "./build-app.mjs";
import { launchChromium } from "./browser.mjs";
import { OUT_DIR } from "./paths.mjs";
import { startServer } from "./server.mjs";
import { frameCacheKey, openSessionPage, PHONE } from "./suites/session.mjs";
import { scoreSession } from "./session-score.mjs";

const STREAM = "720x1280";

/** An iPhone, as far as a page can tell. */
const IPHONE = {
  viewport: PHONE.viewport,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
};

function parse() {
  const { values } = parseArgs({
    options: {
      session: { type: "string", default: "too-far" },
      seed: { type: "string", default: "1" },
      out: { type: "string" },
    },
    strict: true,
  });
  return { session: values.session, seed: Number(values.seed), out: values.out ?? null };
}

/** What a run must show to pass, as `[name, ok, detail]`. */
function checks(record, score, errors, ready) {
  const events = record.events;
  const lane = events.find((e) => e.type === "lane");
  const ml = events.filter((e) => e.type === "detect" && e.source === "ml");
  const shown = events.filter((e) => e.type === "overlay" && e.quad !== null && e.opacity >= 0.5);
  const captures = score.captures;
  const g = score.guidance;
  const hintKeys = [...new Set(events.filter((e) => e.type === "hint" && e.shown).map((e) => e.key))];
  const autoOn = record.actions.some((a) => a.what === "auto-on");
  const scripted = (record.actions ?? []).length > 0 && g.windows.length > 0;
  const fires = captures.filter((c) => c.trigger === "auto");
  return [
    ["camera live", record.actions.some((a) => a.what === "camera-live"), record.actions.map((a) => a.what).join(" → ")],
    ["lane reported", lane !== undefined, lane === undefined ? "no lane event" : `${lane.lane} (${lane.reason})`],
    ["model answered", ml.length > 0, `${ml.length} ML passes, ${events.filter((e) => e.type === "detect").length} in all`],
    ["overlay on the page", (score.hold?.lockedShare ?? 0) > 0 || shown.length > 0, `hold on page ${score.hold?.lockedShare?.toFixed(2) ?? "–"}, ${shown.length} overlay samples shown`],
    [
      "hint shown",
      scripted ? g.windows.every((w) => (w.share ?? 0) > 0) : hintKeys.length > 0,
      `${g.windows.map((w) => `${w.name}: ${w.expect.join("|")} ${w.share === null ? "–" : `${Math.round(w.share * 100)} %`}`).join(", ") || "–"}; keys shown: ${hintKeys.join(", ") || "none"}`,
    ],
    ["ready cue", g.ready.onMs > 0 && (g.ready.precision ?? 0) > 0, `on ${Math.round(g.ready.onMs)} ms, precision ${g.ready.precision === null ? "–" : g.ready.precision.toFixed(2)}`],
    ...(ready.autoCapture
      ? [["auto-capture", autoOn && fires.length > 0 && fires.every((f) => f.confirmOpened), `toggle ${autoOn ? "on" : "not found"}, ${fires.length} automatic capture(s): ${fires.map((f) => f.verdict).join(", ") || "none"}`]]
      : []),
    ["every tap captured", score.missingCaptures === 0 && captures.length > 0, `${captures.length} capture(s), ${score.missingCaptures} missing`],
    ["confirm opened", captures.length > 0 && captures.every((c) => c.confirmOpened), captures.map((c) => `${c.verdict} (${c.cornersFrom ?? "none"}/${c.detector ?? "–"})`).join(", ")],
    ["no page errors", errors.length === 0, errors.slice(0, 3).join(" | ")],
  ];
}

async function main() {
  const options = parse();
  ensureRuntimeAssets({ styles: true });
  await buildBenchApp();
  const server = await startServer();
  const results = { createdAt: new Date().toISOString(), session: options.session, seed: options.seed, runs: [] };
  let failed = false;
  try {
    // 1. Chromium renders the session's frames into the frame cache.
    const { browser: chromium } = await launchChromium();
    const key = frameCacheKey(options.session, options.seed, STREAM, chromium.version());
    const renderer = await openSessionPage(chromium, server.url);
    const prepared = await renderer.page.evaluate(
      ([name, seed, size, cache]) => window.__session.prepare(name, seed, { size, cache }),
      [options.session, options.seed, STREAM, key],
    );
    console.log(`frames: ${prepared.prepare.frames} (${prepared.prepare.cached ? "cached" : "rendered"})`);
    await renderer.context.close();
    await chromium.close();

    // 2. WebKit plays them, once on the lane it picks and once on the main thread.
    const { webkit } = await import("@playwright/test");
    const browser = await webkit.launch();
    results.webkit = browser.version();
    for (const knobs of [{}, { lane: "main" }]) {
      const context = await browser.newContext(IPHONE);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${server.url}/page-session.html`);
      await page.waitForFunction(() => window.__sessionReady === true, null, { timeout: 60_000 });
      const ready = await page.evaluate(
        ([name, seed, size, cache, settings]) =>
          window.__session.prepare(name, seed, { size, cache, stills: false, knobs: settings }).then((p) => ({ script: p.script, cached: p.prepare.cached })),
        [options.session, options.seed, STREAM, key, knobs],
      );
      const features = await page.evaluate(() => ({
        worker: typeof Worker === "function",
        createImageBitmap: typeof createImageBitmap === "function",
        offscreenCanvas: typeof OffscreenCanvas === "function",
        videoFrame: typeof VideoFrame === "function",
        imageCapture: typeof window.ImageCapture === "function",
        requestVideoFrameCallback: typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function",
      }));
      const record = await page.evaluate(() => window.__session.run());
      const score = scoreSession(ready.script, record);
      const verdicts = checks(record, score, errors, { autoCapture: ready.script.autoCapture === true });
      const ok = verdicts.every(([, pass]) => pass);
      failed ||= !ok;
      const lane = record.events.find((e) => e.type === "lane");
      results.runs.push({
        forced: knobs.lane ?? null,
        lane: lane === undefined ? null : { lane: lane.lane, reason: lane.reason },
        features,
        ok,
        checks: verdicts.map(([name, pass, detail]) => ({ name, pass, detail })),
        passes: score.passes,
        hold: score.hold,
        timeToLockMs: score.timeToLockMs,
        captures: score.captures.map((c) => ({ trigger: c.trigger, verdict: c.verdict, cornersFrom: c.cornersFrom, detector: c.detector, tapToConfirmMs: c.tapToConfirmMs, stillUsed: c.stillUsed })),
        guidance: score.guidance,
        startup: score.startup,
        errors,
      });
      console.log(`\nWebKit ${browser.version()} · lane ${lane ? `${lane.lane} (${lane.reason})` : "not reported"}${knobs.lane ? " [forced]" : ""} · ${ok ? "PASS" : "FAIL"}`);
      for (const [name, pass, detail] of verdicts) console.log(`  ${pass ? "✓" : "✗"} ${name} — ${detail}`);
      await context.close();
    }
    await browser.close();
  } finally {
    await server.close();
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = options.out === null ? join(OUT_DIR, `webkit-smoke-${stamp}`) : resolve(options.out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 1));
  console.log(`\nwebkit smoke → ${join(dir, "results.json")}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`\nwebkit smoke: ${error?.stack ?? error}`);
  process.exit(2);
});
