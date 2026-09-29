/**
 * The playground (`npm run bench:play`): the real `<ScanFlow>` on the bench
 * camera, with a control panel and a HUD — for a person to watch the scanner
 * work, poke at it, and see the numbers the suites compute as they happen.
 *
 * The phone is an `<iframe>` of the session page (`page-session.js`) sized
 * like one (390×844), so the library's full-screen layers stay inside it; the
 * session page installs the fake camera and the probe listener there, and
 * hands every probe event out here, stamped with the frame on screen and its
 * truth. Choose:
 *
 *  - a synthetic **session** (any registered one), its seed, the scene family
 *    it uses, the stream size, and what the fake still does (4:3 sensor or
 *    the preview's shape, and a wider field of view) — or a **real clip**
 *    (only when the server has `SCAN_REAL_MEDIA`), with its labels as truth;
 *  - a **scripted** user (the suites' — allow, shoot, confirm) or a **manual**
 *    one (you tap the shutter);
 *  - the CPU throttle (`npm run bench:play` exposes it; a plain browser tab
 *    cannot throttle itself) and the truth drawn over the viewfinder.
 *
 * The HUD: the last detect pass (source, confidence, pass time, the loop's
 * cadence), the overlay's error against the truth on the frame on screen,
 * time to lock, the hints, event counts — and each capture with its corners at
 * the confirm screen against the truth of the image that became the page.
 *
 * `?autoplay=<session>&seed=&stream=&user=&cpu=` starts at once
 * (`&source=clip&clip=<key>` for a real clip);
 * `window.__play` is what the headless smoke check reads.
 */

import { describeFamilies, describeSessions } from "../emulator/index.js";
import { frameId, labelFor } from "../labels.mjs";
import { LOCK_HOLD_MS, LOCK_TOLERANCE, quadDistance } from "../metrics.mjs";
import { CAPTURE_FAILURES, PAGELESS_CAPTURE, toPoints } from "../session-score.mjs";

const PHONE = { width: 390, height: 844 };
const STREAMS = ["540x960", "720x1280", "1080x1920"];
/** Families whose scenes have a page — a page session needs one. */
const PAGE_FAMILIES = ["F1", "F2", "F3", "F4", "F5"];

const css = `
:root { color-scheme: dark; }
html, body { margin: 0; height: 100%; background: #15171a; color: #e8e8e8; font: 13px/1.4 system-ui, sans-serif; }
#root { height: 100%; }
.pg { display: grid; grid-template-columns: 420px 1fr; height: 100%; }
.pg .panel { overflow: auto; padding: 12px; border-right: 1px solid #2c3036; display: flex; flex-direction: column; gap: 10px; }
.pg h1 { font-size: 15px; margin: 0; }
.pg fieldset { border: 1px solid #2c3036; border-radius: 6px; padding: 8px 10px; display: grid; grid-template-columns: auto 1fr; gap: 6px 8px; align-items: center; }
.pg legend { color: #9aa3ad; padding: 0 4px; }
.pg button, .pg select, .pg input { background: #2a2f36; color: #e8e8e8; border: 1px solid #3a414b; border-radius: 4px; padding: 4px 8px; font: inherit; }
.pg button:disabled, .pg select:disabled, .pg input:disabled { opacity: 0.45; }
.pg .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pg .status { color: #9aa3ad; min-height: 1.4em; }
.pg .status.bad { color: #ff8a80; }
.pg .hud { font: 12px/1.5 ui-monospace, monospace; background: #0f1113; border: 1px solid #2c3036; border-radius: 6px; padding: 8px; white-space: pre-wrap; }
.pg table { border-collapse: collapse; font: 12px ui-monospace, monospace; width: 100%; }
.pg td, .pg th { border-bottom: 1px solid #2c3036; padding: 2px 4px; text-align: left; }
.pg .good { color: #7ee2a8; }
.pg .wrong { color: #ff8a80; }
.pg .phone { display: flex; align-items: center; justify-content: center; min-width: 0; overflow: hidden; }
.pg .phone .frame { width: ${PHONE.width}px; height: ${PHONE.height}px; transform-origin: center; border-radius: 18px; overflow: hidden; box-shadow: 0 0 0 8px #000, 0 0 0 9px #333; flex: none; }
.pg iframe { width: ${PHONE.width}px; height: ${PHONE.height}px; border: 0; background: #000; display: block; }
`;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

const option = (value, text = value) => el("option", { value, textContent: text });

const ui = {};
const hud = {
  counts: {},
  lastDetect: null,
  detectTimes: [],
  overlay: null,
  overlayError: null,
  lockAt: null,
  lockStart: null,
  hints: new Set(),
  cameraMs: 0,
  frame: null,
  k: 0,
};
let session = null;
let running = false;
let ticker = null;
let captures = [];
let result = null;
let real = { media: false, clips: [], items: [] };

/** What the headless smoke check reads. */
window.__play = { hud, get captures() { return captures; }, get result() { return result; }, done: false, error: null };

function setStatus(text, bad = false) {
  ui.status.className = `status${bad ? " bad" : ""}`;
  ui.status.textContent = text;
}

function buildUi() {
  document.head.append(el("style", { textContent: css }));
  const params = new URLSearchParams(location.search);
  ui.source = el("select", {}, option("session", "synthetic session"), option("clip", "real clip"));
  ui.session = el("select", {}, ...describeSessions().map((s) => option(s.id, `${s.id} — ${s.title}`)));
  ui.seed = el("input", { type: "number", min: 1, value: params.get("seed") ?? "1", style: "width: 5em" });
  ui.family = el(
    "select",
    {},
    option("", "the session's own"),
    ...describeFamilies().filter((f) => PAGE_FAMILIES.includes(f.id)).map((f) => option(f.id, `${f.id} — ${f.title}`)),
  );
  ui.stream = el("select", {}, ...STREAMS.map((s) => option(s)));
  ui.stream.value = params.get("stream") ?? "720x1280";
  ui.aspect = el("select", {}, option("", "the session's own"), option("preview", "the preview's shape"), option("sensor", "the whole 4:3 sensor"));
  ui.fov = el("input", { type: "number", min: 0.8, max: 2, step: 0.05, value: "", placeholder: "session's", style: "width: 6em" });
  ui.clip = el("select", { disabled: true }, option("", "(SCAN_REAL_MEDIA not set)"));
  ui.user = el("select", {}, option("scripted", "scripted (allow, shoot, confirm)"), option("manual", "manual (you tap)"));
  ui.user.value = params.get("user") ?? "scripted";
  ui.cpu = el("select", {}, ...[1, 2, 4, 6].map((r) => option(String(r), `${r}×`)));
  ui.cpu.disabled = typeof window.__playCpu !== "function";
  if (params.get("cpu") !== null) ui.cpu.value = params.get("cpu");
  ui.truth = el("input", { type: "checkbox", checked: true });
  ui.start = el("button", { textContent: "Load & play", onclick: () => start() });
  ui.stop = el("button", { textContent: "Stop", onclick: () => stop() });
  ui.status = el("div", { className: "status" });
  ui.hud = el("div", { className: "hud", textContent: "—" });
  ui.captures = el("div");
  ui.result = el("div");
  ui.iframe = el("iframe", { title: "the phone" });
  ui.phoneFrame = el("div", { className: "frame" }, ui.iframe);
  const autoplay = params.get("autoplay");
  if (autoplay !== null) ui.session.value = autoplay;
  ui.session.addEventListener("change", syncControls);
  ui.source.addEventListener("change", syncControls);

  const field = (label, control) => [el("label", { textContent: label }), control];
  document.getElementById("root").append(
    el(
      "div",
      { className: "pg" },
      el(
        "div",
        { className: "panel" },
        el("h1", { textContent: "scan bench · playground" }),
        el("fieldset", {}, el("legend", { textContent: "camera" }), ...field("source", ui.source), ...field("session", ui.session), ...field("seed", ui.seed), ...field("scene family", ui.family), ...field("stream", ui.stream), ...field("real clip", ui.clip)),
        el("fieldset", {}, el("legend", { textContent: "fake still (ImageCapture)" }), ...field("shape", ui.aspect), ...field("field of view ×", ui.fov)),
        el("fieldset", {}, el("legend", { textContent: "run" }), ...field("user", ui.user), ...field("CPU throttle", ui.cpu), ...field("truth on viewfinder", ui.truth)),
        el("div", { className: "row" }, ui.start, ui.stop),
        ui.status,
        el("div", { className: "hud-wrap" }, ui.hud),
        el("div", {}, el("b", { textContent: "Captures" }), ui.captures),
        ui.result,
      ),
      el("div", { className: "phone" }, ui.phoneFrame),
    ),
  );
  const fit = () => {
    const room = ui.phoneFrame.parentElement.getBoundingClientRect();
    const scale = Math.min(1, (room.height - 24) / PHONE.height, (room.width - 24) / PHONE.width);
    ui.phoneFrame.style.transform = `scale(${Math.max(0.3, scale)})`;
  };
  new ResizeObserver(fit).observe(document.body);
  ui.truth.addEventListener("change", () => session?.showTruth(ui.truth.checked));
  syncControls();
}

function syncControls() {
  const clip = ui.source.value === "clip";
  for (const control of [ui.session, ui.seed, ui.stream, ui.aspect, ui.fov]) control.disabled = clip;
  ui.family.disabled = clip || ui.session.value === "empty-desk-sweep";
  ui.clip.disabled = !clip || !real.media;
}

async function loadReal() {
  try {
    const response = await fetch("/real/items.json");
    if (!response.ok) return;
    real = await response.json();
    ui.clip.replaceChildren(...real.clips.map((c) => option(c.key, `${c.rel} (${c.duration.toFixed(1)} s)`)));
    const params = new URLSearchParams(location.search);
    if (params.get("source") === "clip") ui.source.value = "clip";
    if (params.get("clip") !== null) ui.clip.value = params.get("clip");
    syncControls();
  } catch {
    // No real media on this server: synthetic only.
  }
}

/* ── the HUD ───────────────────────────────────────────────────────────── */

function resetHud() {
  Object.assign(hud, {
    counts: {},
    lastDetect: null,
    detectTimes: [],
    overlay: null,
    overlayError: null,
    lockAt: null,
    lockStart: null,
    hints: new Set(),
    cameraMs: 0,
    k: 0,
  });
  captures = [];
  result = null;
  ui.captures.replaceChildren();
  ui.result.replaceChildren();
}

function onEvent(event) {
  hud.counts[event.type] = (hud.counts[event.type] ?? 0) + 1;
  hud.cameraMs = event.st;
  hud.k = event.k;
  if (event.type === "detect" && !event.warmUp) {
    hud.lastDetect = event;
    hud.detectTimes.push(event.t);
    if (hud.detectTimes.length > 12) hud.detectTimes.shift();
  } else if (event.type === "overlay") {
    hud.overlay = event;
    const shown = event.quad !== null && event.opacity >= 0.5 ? toPoints(event.quad) : null;
    hud.overlayError = shown !== null && event.truth !== null && hud.frame !== null ? quadDistance(shown, event.truth, hud.frame) : null;
    if (hud.overlayError !== null && hud.overlayError <= LOCK_TOLERANCE) {
      hud.lockStart ??= event.st;
      if (hud.lockAt === null && event.st - hud.lockStart >= LOCK_HOLD_MS) hud.lockAt = hud.lockStart;
    } else {
      hud.lockStart = null;
    }
  } else if (event.type === "hint") {
    if (event.shown) hud.hints.add(event.key);
    else hud.hints.delete(event.key);
  } else if (event.type === "confirm-open" || event.type === "confirm-done") {
    // Scored once the confirm screen has its corners.
    setTimeout(renderCaptures, 0);
  }
}

const f = (v, digits = 2) => (v === null || v === undefined ? "–" : Number(v).toFixed(digits));

function renderHud() {
  const d = hud.lastDetect;
  const gaps = hud.detectTimes.slice(1).map((t, i) => t - hud.detectTimes[i]);
  const cadence = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : null;
  const o = hud.overlay;
  const lines = [
    `camera ${(hud.cameraMs / 1000).toFixed(1)} s · frame ${hud.k}`,
    d === null
      ? "detect: –"
      : `detect: ${d.source}${d.ok ? "" : " (nothing)"}${d.accepted ? " ACCEPTED" : ""} · conf ${f(d.confidence)} · cov ${f(d.coverage)} · pass ${f(d.passMs, 0)} ms`,
    `cadence: loop says every ${d === null ? "–" : f(d.intervalMs, 0)} ms · measured ${cadence === null ? "–" : f(cadence, 0)} ms`,
    o === null
      ? "overlay: –"
      : `overlay: ${o.quad !== null && o.opacity >= 0.5 ? "shown" : "hidden"} (opacity ${f(o.opacity)})${o.searching ? " searching" : ""}` +
        ` · error vs truth ${hud.overlayError === null ? (o.labelled === false ? "(frame unlabelled)" : o.truth === null ? "(no page / none shown)" : "–") : `${(hud.overlayError * 100).toFixed(2)} % diag`}`,
    `time to lock (≤ ${(LOCK_TOLERANCE * 100).toFixed(0)} % for ${LOCK_HOLD_MS} ms, from camera open): ${hud.lockAt === null ? "not yet" : `${(hud.lockAt / 1000).toFixed(2)} s`}`,
    `hints: ${[...hud.hints].join(", ") || "–"}`,
    `events: ${Object.entries(hud.counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "–"}`,
  ];
  ui.hud.textContent = lines.join("\n");
}

function renderCaptures() {
  if (session === null) return;
  try {
    captures = session.captures();
  } catch (error) {
    setStatus(`scoring captures failed: ${error?.message ?? error}`, true);
    return;
  }
  const rows = captures.map((c, i) => {
    const error = c.atConfirm?.max ?? c.labelError ?? null;
    const verdict = c.verdict ?? (c.labelled === false ? "unlabelled" : "–");
    return el(
      "tr",
      {},
      el("td", { textContent: String(i + 1) }),
      el("td", { textContent: c.trigger }),
      el("td", { textContent: c.stillUsed ? "still" : "preview" }),
      el("td", { textContent: `${c.cornersFrom ?? "none"}${c.detector ? `/${c.detector}` : ""}` }),
      el("td", { textContent: c.tapToConfirmMs === null ? "–" : `${Math.round(c.tapToConfirmMs)}` }),
      el("td", { textContent: error === null ? "–" : `${(error * 100).toFixed(2)}` }),
      el("td", { className: verdict === "good" ? "good" : CAPTURE_FAILURES.has(verdict) || verdict === PAGELESS_CAPTURE ? "wrong" : "", textContent: verdict }),
    );
  });
  ui.captures.replaceChildren(
    el(
      "table",
      {},
      el("tr", {}, ...["#", "trigger", "image", "corners from", "tap→confirm ms", "err @confirm % diag", "verdict"].map((h) => el("th", { textContent: h }))),
      ...rows,
    ),
  );
}

function renderResult(score) {
  if (score === null) return;
  const pct = (v) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(0)} %`);
  const lines = [
    `time to lock ${score.timeToLockMs === undefined ? "–" : score.timeToLockMs === null ? "never" : `${Math.round(score.timeToLockMs)} ms`}`,
    score.hold ? `hold: on page ${pct(score.hold.lockedShare)} · wrong ${pct(score.hold.wrongShare)} · none ${pct(score.hold.noneShare)}` : null,
    score.jitter ? `jitter rms ${(score.jitter.rms * 100).toFixed(2)} vs truth ${(score.truthMotion.rms * 100).toFixed(2)} % diag` : null,
    score.staleAfterSwapMs !== undefined ? `stale after swap ${score.staleAfterSwapMs === null ? "stuck" : `${Math.round(score.staleAfterSwapMs)} ms`}` : null,
    score.falseLocksPerMinute !== undefined ? `false locks ${score.falseLocksPerMinute.toFixed(1)} /min` : null,
    `stream ${score.stream.fps?.toFixed(1) ?? "–"} fps (${score.stream.skipped} skipped)`,
  ].filter((l) => l !== null);
  ui.result.replaceChildren(el("b", { textContent: "Session score (as the suite computes it)" }), el("div", { className: "hud", textContent: lines.join("\n") }));
}

/* ── running ───────────────────────────────────────────────────────────── */

async function freshPhone() {
  // `&layout=` on the playground reaches the phone: the capture layout (the library's default, `rail`, without it).
  const layout = new URLSearchParams(location.search).get("layout");
  ui.iframe.src = `/page-session.html?play=${Date.now()}${layout === null ? "" : `&layout=${encodeURIComponent(layout)}`}`;
  await new Promise((resolve) => ui.iframe.addEventListener("load", resolve, { once: true }));
  const win = ui.iframe.contentWindow;
  const deadline = performance.now() + 30000;
  while (win.__sessionReady !== true) {
    if (performance.now() > deadline) throw new Error("the session page did not come up");
    await new Promise((r) => setTimeout(r, 50));
  }
  return win.__session;
}

async function clipLabels(clip) {
  try {
    const response = await fetch("/labels");
    if (!response.ok) return [];
    const doc = await response.json();
    const out = [];
    for (let j = 0; j < clip.sparse.frames; j += 1) {
      const k = j * clip.sparse.stride;
      const label = labelFor(doc, frameId(clip.rel, k, clip.fps));
      if (label !== null) out.push([k, label]);
    }
    return out;
  } catch {
    return [];
  }
}

async function setCpu(rate) {
  if (typeof window.__playCpu === "function") await window.__playCpu(rate);
}

async function start() {
  if (running) await stop();
  running = true;
  window.__play.done = false;
  window.__play.error = null;
  resetHud();
  ui.start.disabled = true;
  try {
    setStatus("loading the phone…");
    session = await freshPhone();
    session.listen(onEvent);
    const scripted = ui.user.value === "scripted";
    const progress = (k, count) => setStatus(`rendering frames ${k} / ${count}…`);
    let prepared;
    if (ui.source.value === "clip") {
      const clip = real.clips.find((c) => c.key === ui.clip.value);
      if (clip === undefined) throw new Error("no real clip chosen");
      const labels = await clipLabels(clip);
      setStatus(`loading ${clip.rel} (${labels.length} labelled frames)…`);
      prepared = await session.prepareClip(clip.key, {
        tapAtMs: scripted ? Math.round(clip.duration * 600) : null,
        labels,
        onProgress: (k, count) => setStatus(`loading frames ${k} / ${count}…`),
      });
    } else {
      const still = {};
      if (ui.aspect.value !== "") still.aspect = ui.aspect.value;
      if (ui.fov.value !== "") still.fovScale = Number(ui.fov.value);
      prepared = await session.prepare(ui.session.value, Number(ui.seed.value) || 1, {
        size: ui.stream.value,
        family: ui.family.disabled || ui.family.value === "" ? undefined : ui.family.value,
        still: Object.keys(still).length > 0 ? still : undefined,
        onProgress: progress,
      });
    }
    hud.frame = prepared.script.frame;
    session.showTruth(ui.truth.checked);
    await setCpu(Number(ui.cpu.value));
    setStatus(`${scripted ? "playing" : "live — tap the shutter in the phone"} · ${prepared.script.title ?? prepared.script.id}`);
    clearInterval(ticker);
    ticker = setInterval(renderHud, 150);
    try {
      if (scripted) {
        await session.run();
        renderCaptures();
        result = session.score();
        renderResult(result);
        setStatus("done");
        window.__play.done = true;
      } else {
        await session.run({ scripted: false });
        window.__play.done = true;
        // Manual: the HUD keeps ticking until Stop.
        return;
      }
    } finally {
      if (scripted) {
        clearInterval(ticker);
        renderHud();
        await setCpu(1);
      }
    }
  } catch (error) {
    window.__play.error = String(error?.message ?? error);
    setStatus(window.__play.error, true);
    await setCpu(1);
  } finally {
    ui.start.disabled = false;
    running = ui.user.value === "manual" && window.__play.error === null;
  }
}

async function stop() {
  running = false;
  clearInterval(ticker);
  ui.iframe.src = "about:blank";
  session = null;
  await setCpu(1);
  setStatus("stopped");
}

buildUi();
await loadReal();
const autoplay = new URLSearchParams(location.search).get("autoplay");
if (autoplay !== null) start();
