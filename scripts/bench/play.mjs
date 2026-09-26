#!/usr/bin/env node
/**
 * `npm run bench:play` — the playground: the real `<ScanFlow>` on the bench
 * camera, with a control panel and a probe HUD (`app/page-play.js`).
 *
 *   npm run bench:play                     headed Chromium on the playground
 *   npm run bench:play -- --no-browser     only serve it; open the printed URL in any local browser
 *   npm run bench:play -- --smoke          headless: play one scripted session, check the HUD
 *                          [--session approach-hold] [--seed 1] [--stream 540x960]
 *                          [--clip <key>]  (a real clip instead; needs SCAN_REAL_MEDIA) [--cpu 4]
 *
 * Builds the pages from the working tree and serves them on 127.0.0.1 only.
 * With `SCAN_REAL_MEDIA` set, the clips' frames are extracted into the cache
 * first and the playground offers them too. In the headed browser the CPU
 * throttle control works (it is CDP, driven from here); a plain browser tab
 * cannot throttle itself, so there it is greyed out.
 */

import { parseArgs } from "node:util";
import { buildBenchApp, ensureRuntimeAssets } from "./build-app.mjs";
import { cpuThrottle, launchChromium } from "./browser.mjs";
import { realMediaDir } from "./paths.mjs";
import { prepareRealMedia } from "./real.mjs";
import { startServer } from "./server.mjs";

/** How long the smoke check gives one scripted session, rendering included. */
const SMOKE_TIMEOUT_MS = 240_000;

function parse() {
  const { values } = parseArgs({
    options: {
      "no-browser": { type: "boolean", default: false },
      smoke: { type: "boolean", default: false },
      session: { type: "string", default: "approach-hold" },
      seed: { type: "string", default: "1" },
      stream: { type: "string", default: "540x960" },
      clip: { type: "string" },
      cpu: { type: "string", default: "1" },
    },
    strict: true,
  });
  return values;
}

async function smoke(url, options) {
  const { browser } = await launchChromium({ headed: false });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const throttle = await cpuThrottle(page);
    const cpuCalls = [];
    await page.exposeFunction("__playCpu", async (rate) => {
      cpuCalls.push(rate);
      await throttle.set(rate);
    });
    const query = new URLSearchParams({
      autoplay: options.session,
      seed: options.seed,
      stream: options.stream,
      user: "scripted",
      cpu: options.cpu,
      ...(options.clip ? { source: "clip", clip: options.clip } : {}),
    });
    await page.goto(`${url}/page-play.html?${query}`);
    await page.waitForFunction(() => window.__play?.done === true || window.__play?.error !== null, null, { timeout: SMOKE_TIMEOUT_MS });
    const state = await page.evaluate(() => ({
      error: window.__play.error,
      counts: window.__play.hud.counts,
      mlPassMs: (() => {
        const doc = document.querySelector("iframe")?.contentWindow;
        const ms = (doc?.__session?.snapshot().events ?? []).filter((e) => e.type === "detect" && !e.warmUp && e.source === "ml").map((e) => e.passMs).sort((a, b) => a - b);
        return ms.length === 0 ? null : ms[Math.floor(ms.length / 2)];
      })(),
      lastDetect: window.__play.hud.lastDetect && {
        source: window.__play.hud.lastDetect.source,
        passMs: window.__play.hud.lastDetect.passMs,
        intervalMs: window.__play.hud.lastDetect.intervalMs,
        confidence: window.__play.hud.lastDetect.confidence,
      },
      lockAt: window.__play.hud.lockAt,
      overlayError: window.__play.hud.overlayError,
      hudText: document.querySelector(".hud")?.textContent ?? "",
      captures: window.__play.captures.map((c) => ({
        stillUsed: c.stillUsed,
        cornersFrom: c.cornersFrom,
        verdict: c.verdict,
        atConfirm: c.atConfirm?.max ?? null,
        tapToConfirmMs: c.tapToConfirmMs,
      })),
      timeToLockMs: window.__play.result?.timeToLockMs ?? null,
      truthDrawnOnFrames: Number(document.querySelector("iframe")?.contentDocument?.querySelector("svg[data-drawn]")?.dataset.drawn ?? 0),
    }));
    console.log(JSON.stringify({ ...state, cpuCalls, pageErrors: errors.slice(0, 5) }, null, 1));
    const ok =
      state.error === null &&
      (state.counts.detect ?? 0) >= 3 &&
      (state.counts.overlay ?? 0) >= 10 &&
      state.captures.length >= 1 &&
      errors.length === 0;
    console.log(ok ? "\nplayground smoke: OK" : "\nplayground smoke: FAILED");
    return ok;
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parse();
  if (realMediaDir() !== null) prepareRealMedia();
  ensureRuntimeAssets({ styles: true });
  await buildBenchApp();
  const server = await startServer({ log: (line) => console.log(line) });
  const url = `${server.url}/page-play.html`;
  if (options.smoke) {
    const ok = await smoke(server.url, options);
    await server.close();
    process.exit(ok ? 0 : 1);
  }
  console.log(`\nplayground: ${url}\n(loopback only${realMediaDir() === null ? "; set SCAN_REAL_MEDIA for real clips" : ""})`);
  if (options["no-browser"]) {
    console.log("open it in any browser on this machine; Ctrl-C to stop");
    return;
  }
  let launched;
  try {
    launched = await launchChromium({ headed: true });
  } catch (error) {
    console.log(`could not open a browser window (${String(error?.message ?? error).split("\n")[0]}); open the URL yourself. Ctrl-C to stop`);
    return;
  }
  const context = await launched.browser.newContext({ viewport: null });
  const page = await context.newPage();
  const throttle = await cpuThrottle(page);
  await page.exposeFunction("__playCpu", (rate) => throttle.set(rate));
  await page.goto(url);
  launched.browser.on("disconnected", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`bench:play: ${error?.message ?? error}`);
  process.exit(2);
});
