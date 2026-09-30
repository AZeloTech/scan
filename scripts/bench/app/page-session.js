/**
 * The session page: the real `<ScanFlow>`, on the bench camera, driven by a
 * scripted user — `window.__session` for the Node runner and the playground.
 *
 *   prepare(id, seed, { size, family?, still? }) — build a synthetic session, render all its frames
 *   prepareClip(key, { tapAtMs, labels })          — load a real clip's replay frames instead
 *   run({ scripted = true })                       — mount the flow and play to the end
 *                                                    (unscripted: mount, allow, return; a person drives)
 *   sheet(spec)                                    — draw a film strip of frames and stills
 *   listen(fn), showTruth(on), captures(), snapshot() — for the playground's HUD
 *
 * The component is the library's source, mounted as a host would mount it:
 * `assetBaseUrl` at the served `/assets/`, Portuguese, the default intake. The
 * page installs the fake camera ({@link installFakeCamera}) and the probe
 * listener (`src/lib/probe.ts`) before it mounts, so every event from the
 * first render on is recorded with the camera time it happened at.
 *
 * The scripted user does what a person would: on the permission primer it
 * taps "allow"; at the script's times it taps the shutter (or the frame); when
 * the confirm screen opens it looks for a moment and confirms. It never edits
 * a corner — the corners the screen opened with are the ones scored.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ScanFlow } from "../../../src/index.ts";
import { copyFor } from "../../../src/lib/i18n.ts";
import { buildSession, describeSessions } from "../emulator/index.js";
import { installFakeCamera } from "./fake-camera.js";
import { SessionPlayer, thumbnailOf } from "./session-player.js";
import { ClipPlayer, clipScript } from "./clip-player.js";
import { drawSheet } from "./sheets.js";
import { installPerfWatch } from "./perf-watch.js";
import { pickPhotoSize, readPhotoSizeRange } from "../../../src/lib/still-capture.ts";
import { MAX_LONG_EDGE } from "../../../src/lib/image.ts";
import { scoreCaptures, scoreSession } from "../session-score.mjs";
import { scoreReplayCaptures } from "../real-score.mjs";

const copy = copyFor("pt");

/** How long the scripted user waits for a control before giving up on a step. */
const STEP_TIMEOUT_MS = 8000;

/** How long the scripted user looks at a confirm screen it did not open itself (auto-capture) — as `emulator/session.js` scripts its own. */
const CONFIRM_AFTER_MS = 1100;

/** After the script's last moment, how long the flow is left to finish. */
const TAIL_MS = 1200;

/** A remount (`script.remounts`): unmounted this long, then held live this long. */
const REMOUNT_GAP_MS = 600;
const REMOUNT_HOLD_MS = 4000;

/**
 * Bench-only settings the app reads through the probe (`probeSetting`,
 * `src/lib/probe-hook.ts`), set from `prepare`'s `knobs` — e.g. which
 * detection lane to force, or how much slower a worker's passes should run
 * than this machine runs them (CDP throttles only the page's own thread).
 */
let knobs = {};

let player = null;
let script = null;
/** Set for a real clip: its per-frame labels (replay frame index → label). */
let clipLabels = null;
const events = [];
const actions = [];
const hostEvents = [];
const listeners = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Poll for something in the page, or null after `timeoutMs`. */
async function waitFor(find, timeoutMs = STEP_TIMEOUT_MS, everyMs = 25) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const found = find();
    if (found) return found;
    await sleep(everyMs);
  }
  return null;
}

function buttons() {
  return [...document.querySelectorAll("button")];
}

function enabledButton(match) {
  return buttons().find((button) => !button.disabled && match(button)) ?? null;
}

const SHUTTER_PREFIX = copy.capture.take(1).replace(/\d+$/, "");

/** The capture controls: the frame overlay first in the DOM, the shutter after it. */
function captureButton(trigger) {
  const all = buttons().filter((b) => (b.getAttribute("aria-label") ?? "").startsWith(SHUTTER_PREFIX));
  const enabled = all.filter((b) => !b.disabled);
  if (enabled.length === 0) return null;
  return trigger === "frame" ? enabled[0] : enabled[enabled.length - 1];
}

function log(what, extra = {}) {
  actions.push({ what, at: performance.now(), t: player?.now() ?? 0, ...extra });
}

function lastEvent(type, after) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === type && events[i].at >= after) return events[i];
  }
  return null;
}

/**
 * The probe listener: every event is kept, stamped with page and camera time,
 * and handed to the playground's listeners with the frame on screen and its
 * truth (null for a real frame nobody labelled). The event is already the
 * listener's own copy (the probe clones it).
 *
 * Two events are answered on the spot, because they arrive synchronously from
 * inside the app's own task: a `grab` (a preview frame was just drawn to make
 * a page) is named by the timestamp of the frame the `<video>` holds — the
 * one the draw took (`StreamPlayer#noteGrab`) — and a
 * `still-call` tells the fake camera which attempt its next `takePhoto()`
 * answers. That is how a capture names its image — by id, never by time.
 */
function installProbe() {
  const listener = (event) => {
    const entry = { ...event, at: performance.now(), st: player.now() };
    if (event.type === "grab") player.noteGrab(event.id, entry.at);
    if (event.type === "still-call") player.noteStillCall(event.attempt);
    if (event.type === "hint") queueMicrotask(() => sampleBox("hint"));
    events.push(entry);
    if (listeners.size === 0) return;
    const k = player.presentedFrame();
    const frame = player.frames[k];
    const enriched = { ...entry, k, truth: frame?.quad ?? null, labelled: frame?.labelled ?? true };
    for (const listener of listeners) {
      try {
        listener(enriched);
      } catch {
        // A HUD that throws must not break the run.
      }
    }
  };
  listener.knobs = { ...knobs };
  globalThis.__SCAN_PROBE__ = listener;
}

/**
 * What the app will ask `takePhoto()` for on this session's camera: its own
 * `pickPhotoSize` over the fake sensor's capabilities (`fake-camera.js`), at
 * the preview's shape and the page grid's long edge — so a still rendered
 * ahead is the size the call asks for.
 */
function requestFor(session) {
  const { width, height } = session.still.sensor;
  return pickPhotoSize(
    readPhotoSizeRange({ imageWidth: { min: 640, max: width, step: 1 } }, "imageWidth"),
    readPhotoSizeRange({ imageHeight: { min: 480, max: height, step: 1 } }, "imageHeight"),
    MAX_LONG_EDGE,
    session.frame.width / session.frame.height,
  );
}

/**
 * `cache` names the frame-cache entry for this script (the runner derives it
 * from the session, seed, stream size, emulator source and browser build);
 * `stills: false` is a camera without a still pipeline (and renders nothing:
 * the frames must come from the cache); `knobs` are the bench-only settings
 * the app reads through the probe.
 */
async function prepare(id, seed, options = {}) {
  script = buildSession(id, seed, options);
  if (options.still) script.still = { ...script.still, ...options.still };
  knobs = options.knobs ?? {};
  const stills = options.stills ?? true;
  player = new SessionPlayer(script, { stills, streamScale: options.streamScale ?? 1 });
  const info = await player.prerender(options.onProgress, { cache: options.cache ?? null });
  info.stillsMs = await player.prepareStills(requestFor);
  installFakeCamera({ player, permission: options.permission ?? script.permission, stills });
  installProbe();
  return {
    script,
    renderer: player.renderer?.describe() ?? null,
    prepare: info,
  };
}

/**
 * A real clip instead of a synthetic session: its replay frames from the
 * cache, played at their own rate, one shutter tap at `tapAtMs` (camera time)
 * or none. `labels` is `[[k, label], …]` for the labelled replay frames.
 */
async function prepareClip(key, { tapAtMs = null, labels = [], permission, onProgress, knobs: settings = {} } = {}) {
  knobs = settings;
  const response = await fetch("/real/items.json");
  if (!response.ok) throw new Error(`/real/items.json: HTTP ${response.status} (is SCAN_REAL_MEDIA set?)`);
  const clip = (await response.json()).clips.find((c) => c.key === key);
  if (clip === undefined) throw new Error(`no extracted clip "${key}"`);
  clipLabels = new Map(labels);
  script = clipScript(clip, { tapAtMs, permission });
  player = new ClipPlayer(clip, script, clipLabels);
  const info = await player.load(onProgress);
  installFakeCamera({ player, permission: script.permission });
  installProbe();
  return { script, clip, prepare: info };
}

/** Wait for the app's `<video>` to show the camera, and watch it. False when it never did. */
async function cameraLive() {
  const video = await waitFor(() => {
    const v = document.querySelector("video");
    return v !== null && v.srcObject !== null && v.videoWidth > 0 ? v : null;
  }, 20000);
  if (video === null) {
    log("camera-missing");
    return false;
  }
  log("camera-live", { videoW: video.videoWidth, videoH: video.videoHeight, visible: visibleCrop(video) });
  player.watchVideo(video);
  watchStage(video);
  return true;
}

/**
 * The part of the camera frame the viewfinder shows — the `<video>`'s
 * object-cover crop of its stage — as fractions of the frame: what "the page
 * is cut off" means to the person holding the phone.
 */
function visibleCrop(video) {
  const stage = video.parentElement;
  if (stage === null || video.videoWidth === 0) return null;
  const rect = stage.getBoundingClientRect();
  const scale = Math.max(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return {
    x: (width - rect.width) / 2 / width,
    y: (height - rect.height) / 2 / height,
    width: rect.width / width,
    height: rect.height / height,
  };
}

/**
 * The viewfinder's box, sampled while it is live (every 100 ms, and on every
 * hint change): a hint appearing or going away must never move or resize the
 * frame the user is aiming through (`boxes`, scored as layout shifts).
 */
const boxes = [];
/**
 * The part of the camera frame the person can actually see, sampled with the
 * box (`regions`) and measured here, independently of the app's own answer:
 * the `<video>`'s content box under its computed `object-fit` /
 * `object-position`, clipped by its own box, every clipping ancestor and the
 * viewport, then trimmed by the opaque edge bands the layout declares
 * (`[data-scan-occluder="top|bottom|left|right"]`) — as fractions of the
 * frame, plus its size in CSS px. A build that declares no occluders is
 * measured as the crop alone. `blocks`: the opaque controls over the
 * picture, found independently of anything the app declares
 * ({@link opaqueControls}) — the scorer counts a corner under one as hidden.
 */
const regions = [];
let boxTimer = null;
let stageVideo = null;
function sampleBox(why) {
  const stage = stageVideo?.parentElement;
  if (!stage || !stage.isConnected) return;
  const r = stage.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  const at = performance.now();
  boxes.push({ at, why, x: r.left, y: r.top, width: r.width, height: r.height });
  const region = visibleRegion(stageVideo);
  if (region !== null) regions.push({ at, ...region });
}

function visibleRegion(video) {
  if (video === null || !video.isConnected || video.videoWidth === 0 || video.videoHeight === 0) return null;
  const box = video.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const style = getComputedStyle(video);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  let w = box.width;
  let h = box.height;
  if (style.objectFit !== "fill") {
    const pick = style.objectFit === "contain" || style.objectFit === "scale-down" ? Math.min : Math.max;
    const scale = style.objectFit === "none" ? 1 : pick(box.width / vw, box.height / vh);
    w = vw * scale;
    h = vh * scale;
  }
  const [px, py] = style.objectPosition.split(" ").map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : 0.5));
  const left = box.left + (box.width - w) * (px ?? 0.5);
  const top = box.top + (box.height - h) * (py ?? 0.5);
  const clip = { l: box.left, t: box.top, r: box.right, b: box.bottom };
  const cut = (rect) => {
    clip.l = Math.max(clip.l, rect.left);
    clip.t = Math.max(clip.t, rect.top);
    clip.r = Math.min(clip.r, rect.right);
    clip.b = Math.min(clip.b, rect.bottom);
  };
  for (let el = video.parentElement; el !== null && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible") cut(el.getBoundingClientRect());
  }
  const vv = window.visualViewport;
  cut({ left: vv?.offsetLeft ?? 0, top: vv?.offsetTop ?? 0, right: (vv?.offsetLeft ?? 0) + (vv?.width ?? innerWidth), bottom: (vv?.offsetTop ?? 0) + (vv?.height ?? innerHeight) });
  for (const el of document.querySelectorAll("[data-scan-occluder]")) {
    const o = el.getBoundingClientRect();
    if (o.width === 0 || o.height === 0) continue;
    const edge = el.getAttribute("data-scan-occluder");
    if (edge === "top") clip.t = Math.max(clip.t, o.bottom);
    else if (edge === "bottom") clip.b = Math.min(clip.b, o.top);
    else if (edge === "left") clip.l = Math.max(clip.l, o.right);
    else if (edge === "right") clip.r = Math.min(clip.r, o.left);
  }
  const cssW = Math.max(0, clip.r - clip.l);
  const cssH = Math.max(0, clip.b - clip.t);
  const blocks = opaqueControls(video, { l: left, t: top, w, h }, clip);
  return {
    blocks,
    x: (clip.l - left) / w,
    y: (clip.t - top) / h,
    width: cssW / w,
    height: cssH / h,
    cssW,
    cssH,
    viewW: vv?.width ?? innerWidth,
    viewH: vv?.height ?? innerHeight,
    fit: style.objectFit,
  };
}
/**
 * What sits OVER the picture and hides it, found on the page itself rather
 * than from what the app declares (`data-scan-occluder`): every rendered
 * element outside the video's own ancestry whose painted background is at
 * least half opaque (its colour's alpha times the opacity of it and every
 * ancestor) — the glass buttons, the hint pill, a diagnostics HUD — as
 * rectangles in frame fractions, only where they overlap the visible part.
 * A layer covering most of the stage (the white capture flash, the file
 * surface) is not a control and is left out.
 */
function opaqueControls(video, frame, clip) {
  const ancestry = new Set();
  for (let el = video; el !== null; el = el.parentElement) ancestry.add(el);
  const stage = video.parentElement?.getBoundingClientRect() ?? null;
  const out = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (ancestry.has(el) || el instanceof SVGElement) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right <= clip.l || r.left >= clip.r || r.bottom <= clip.t || r.top >= clip.b) continue;
    if (stage !== null && r.width * r.height >= 0.9 * stage.width * stage.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== "visible" || cs.display === "none") continue;
    const alpha = colourAlpha(cs.backgroundColor);
    if (alpha <= 0) continue;
    let opacity = alpha;
    for (let a = el; a !== null && opacity >= 0.5; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
    if (opacity < 0.5) continue;
    out.push({ x: (r.left - frame.l) / frame.w, y: (r.top - frame.t) / frame.h, width: r.width / frame.w, height: r.height / frame.h });
  }
  return out;
}

function colourAlpha(colour) {
  const m = /rgba?\(([^)]+)\)/.exec(colour);
  if (m === null) return colour === "transparent" ? 0 : 1;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const a = parts[3];
  return a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
}

function watchStage(video) {
  stageVideo = video;
  if (boxTimer !== null) clearInterval(boxTimer);
  sampleBox("live");
  boxTimer = setInterval(() => sampleBox("tick"), 100);
}

/** Confirm screens open now (opened, not yet confirmed). */
function confirmsOpen() {
  let open = 0;
  for (const e of events) {
    if (e.type === "confirm-open") open += 1;
    else if (e.type === "confirm-done") open = Math.max(0, open - 1);
  }
  return open;
}

/** Captures made whose confirm screen has not opened yet (an automatic one still taking its photo). */
function capturesInFlight() {
  const count = (type) => events.filter((e) => e.type === type).length;
  return Math.max(0, count("capture") - count("confirm-open"));
}

/**
 * With auto-capture on, confirm screens open without a tap: the scripted
 * user confirms every one of them the way it confirms its own — a look,
 * then "confirm" — and the script's taps wait until none is open.
 */
let confirming = false;
async function confirmWatcher() {
  let handled = 0;
  while (confirming) {
    const opens = events.filter((e) => e.type === "confirm-open");
    if (opens.length <= handled) {
      await sleep(40);
      continue;
    }
    const opened = opens[handled];
    handled += 1;
    await sleep(Math.max(0, opened.at + CONFIRM_AFTER_MS - performance.now()));
    const confirm = await waitFor(() => enabledButton((b) => b.textContent.includes(copy.confirm.confirmCta)));
    if (confirm === null) {
      log("confirm-button-missing");
      continue;
    }
    confirm.click();
    log("confirm", { auto: true });
    const done = await waitFor(() => lastEvent("confirm-done", opened.at), 5000);
    await waitFor(() => captureButton("shutter"), 8000);
    log("confirm-closed", { done: done !== null });
  }
}

/**
 * The auto-capture control, as a switch — or null where there is none. Two
 * shapes: a pressed-state toggle named "Captura automática" (`standard`,
 * `onehand`, `collapse`), and `rail`'s MANUAL · AUTOMÁTICO radio pair (the
 * default layout).
 */
function autoToggle() {
  const label = copy.capture.autoCapture;
  const toggle =
    typeof label === "string" ? buttons().find((b) => b.getAttribute("aria-label") === label && !b.disabled) : undefined;
  if (toggle !== undefined) {
    const on = () => toggle.getAttribute("aria-pressed") === "true";
    return {
      on,
      set: (want) => {
        if (on() !== want) toggle.click();
      },
    };
  }
  const modeLabel = copy.captureLayout?.modeLabel;
  const group = [...document.querySelectorAll('[role="radiogroup"]')].find((g) => g.getAttribute("aria-label") === modeLabel);
  const radios = group === undefined ? [] : [...group.querySelectorAll('[role="radio"]')];
  if (radios.length !== 2) return null;
  const [manual, auto] = radios;
  const on = () => auto.getAttribute("aria-checked") === "true";
  return {
    on,
    set: (want) => {
      if (on() !== want) (want ? auto : manual).click();
    },
  };
}

/** The scripted user, from the primer to the last confirm (unscripted: only the primer). */
async function act({ scripted = true } = {}) {
  const allow = await waitFor(
    () => enabledButton((b) => b.textContent.includes(copy.primer.ctaAllow)) ?? (captureButton("shutter") ? "live" : null),
    20000,
  );
  if (allow === null) {
    log("primer-missing");
  } else if (allow !== "live") {
    log("primer-shown");
    await sleep(400);
    allow.click();
    log("primer-allow");
  } else {
    log("primer-skipped");
  }
  if (!(await cameraLive())) return;
  if (!scripted) return;
  const auto = script.autoCapture === true;
  if (auto) {
    const toggle = await waitFor(autoToggle, 3000);
    if (toggle === null) log("auto-toggle-missing");
    else {
      toggle.set(true);
      log("auto-on");
    }
    confirming = true;
    void confirmWatcher();
  }

  for (const step of script.actions) {
    if (step.tap !== undefined) {
      const wait = step.at - player.now();
      if (wait > 0) await sleep(wait);
      // Never under an open confirm screen: a person cannot reach the shutter there.
      if (auto) await waitFor(() => confirmsOpen() === 0 && capturesInFlight() === 0 && captureButton(step.tap), 15000);
      const button = await waitFor(() => captureButton(step.tap));
      if (button === null) {
        log("tap-missing", { trigger: step.tap, due: step.at });
        continue;
      }
      button.click();
      log("tap", { trigger: step.tap, due: step.at });
    } else if (step.confirmAfterMs !== undefined) {
      // With auto-capture on, the watcher confirms every screen.
      if (auto) continue;
      const since = actions[actions.length - 1]?.at ?? 0;
      const opened = await waitFor(() => lastEvent("confirm-open", since), 15000);
      if (opened === null) {
        log("confirm-missing");
        continue;
      }
      await sleep(step.confirmAfterMs);
      const confirm = await waitFor(() => enabledButton((b) => b.textContent.includes(copy.confirm.confirmCta)));
      if (confirm === null) {
        log("confirm-button-missing");
        continue;
      }
      confirm.click();
      log("confirm");
      const done = await waitFor(() => lastEvent("confirm-done", opened.at), 5000);
      // The screen flies the page into its slot and closes; the viewfinder is live again when the shutter is.
      await waitFor(() => captureButton("shutter"), 8000);
      log("confirm-closed", { done: done !== null });
    }
  }
}

function flow() {
  return createElement(ScanFlow, {
    assetBaseUrl: "/assets/",
    lang: "pt-BR",
    // The auto-capture toggle: a script that switches it on asks for it
    // (`true` also puts it on `standard`); otherwise the prop is left out, as
    // a host that says nothing would — the default `rail` shows the toggle
    // (off), `standard` does not.
    experimentalAutoCapture: script?.autoCapture === true ? true : undefined,
    // The capture layout, when the page is asked for one (`?layout=standard|
    // classic|filmstrip|onehand|collapse`, from `npm run bench -- --layout` or
    // the playground); the library's default (`rail`) otherwise.
    captureLayout: new URLSearchParams(location.search).get("layout") ?? undefined,
    // `?diag=1`: the diagnostics HUD (`experimentalDiagnostics`), for screenshots.
    experimentalDiagnostics: new URLSearchParams(location.search).get("diag") === "1" || undefined,
    onComplete: () => hostEvents.push({ name: "complete", at: performance.now() }),
    onCancel: (reason) => hostEvents.push({ name: "cancel", reason, at: performance.now() }),
    onEvent: (event) => hostEvents.push({ ...event, at: performance.now() }),
  });
}

/**
 * Mount the flow and play the script to its end. What the app cost the page
 * over the live part (`perf`: long tasks, heap, workers, bitmaps) comes back
 * with the record. A script with `remounts` then unmounts the flow and mounts
 * it again that many times — each held live for a few seconds, when the
 * runtime is warm — and finally unmounts it for good: `perfEnd` counts what
 * outlived it, after a garbage collection.
 */
async function run({ scripted = true } = {}) {
  if (player === null) throw new Error("__session.prepare() first");
  const perf = scripted ? installPerfWatch() : null;
  const host = document.getElementById("root");
  let root = createRoot(host);
  const mountedAt = performance.now();
  root.render(flow());
  log("mounted");
  await act({ scripted });
  if (!scripted) return { mountedAt };
  // Play the script out, then give the flow a moment.
  const rest = script.duration - player.now();
  if (rest > 0) await sleep(rest);
  // With auto-capture on, the user switches it off as the script ends (the
  // frames stop there), and a capture near the end still owes its confirm
  // screen and its confirmation.
  if (script.autoCapture === true) {
    const toggle = autoToggle();
    if (toggle !== null && toggle.on()) {
      toggle.set(false);
      log("auto-off");
    }
    // Settled: no photo being taken (the shutter enabled), none waiting for
    // its confirm screen, none open — twice in a row, a beat apart.
    const settled = () => captureButton("shutter") !== null && capturesInFlight() === 0 && confirmsOpen() === 0;
    await waitFor(() => settled(), 10000);
    await sleep(300);
    await waitFor(() => settled(), 10000);
  }
  await sleep(TAIL_MS);
  confirming = false;
  if (boxTimer !== null) clearInterval(boxTimer);
  boxTimer = null;
  const liveFrom = actions.find((a) => a.what === "camera-live")?.at ?? mountedAt;
  const liveTo = performance.now();
  const perfLive = await perf.report({ from: liveFrom, to: liveTo });
  const remounts = [];
  let perfEnd = null;
  if (script.remounts > 0) {
    for (let i = 0; i < script.remounts; i += 1) {
      root.unmount();
      log("unmounted");
      const unmountedAt = performance.now();
      await sleep(REMOUNT_GAP_MS);
      root = createRoot(host);
      const at = performance.now();
      root.render(flow());
      log("remounted");
      const live = await cameraLive();
      remounts.push({ unmountedAt, mountedAt: at, cameraLiveAt: live ? performance.now() : null });
      await sleep(REMOUNT_HOLD_MS);
      remounts[remounts.length - 1].heldTo = performance.now();
    }
    root.unmount();
    log("unmounted");
    await sleep(1000);
    perfEnd = await perf.report({ settle: true, from: liveTo, to: performance.now() });
  }
  await player.stop();
  perf.stop();
  return {
    mountedAt,
    events,
    actions,
    hostEvents,
    ...player.record(),
    frameContent: grabbedContent(),
    perf: perfLive,
    perfEnd,
    remounts,
    visible: actions.find((a) => a.what === "camera-live")?.visible ?? null,
    boxes,
    regions,
    torch: globalThis.__benchTorch ?? [],
  };
}

/**
 * The content boxes of every preview frame a capture took (`{ [k]: content }`)
 * — what a crop of it is judged by. Synthetic sessions only: a real clip has
 * no content truth.
 */
function grabbedContent() {
  if (typeof player.frameContent !== "function") return null;
  const out = {};
  for (const grab of player.grabs) {
    if (grab.k !== null && !(grab.k in out)) out[grab.k] = player.frameContent(grab.k);
  }
  return out;
}

/**
 * A film strip: tiles are pre-rendered frames (`{ frame: k }`) or stills
 * (`{ still: i }`), with the quads the runner computed drawn over them.
 */
async function sheet({ title, columns, tiles, legend }) {
  const drawn = [];
  for (const tile of tiles) {
    const thumb =
      tile.frame !== undefined
        ? await thumbnailOf(player.blobs[tile.frame])
        : player.stillThumbs[tile.still];
    if (thumb !== undefined) drawn.push({ thumb, caption: tile.caption, quads: tile.quads });
  }
  return drawSheet({ title, columns, legend, tiles: drawn });
}

/** Everything recorded so far, as `run()` would answer it at the end. */
function snapshot() {
  return { events, actions, hostEvents, ...player.record(), frameContent: grabbedContent() };
}

/** Each capture so far, scored against the truth of the image that became the page. */
function captures() {
  if (player === null) return [];
  const record = snapshot();
  if (clipLabels !== null) {
    return scoreReplayCaptures(record, {
      labelAt: (k) => clipLabels.get(k) ?? null,
      referenceAt: () => undefined,
    });
  }
  return scoreCaptures({ ...script, framesTruth: record.frames }, record);
}

/** The whole-session score (synthetic sessions), as the suite computes it. */
function score() {
  return clipLabels === null && player !== null ? scoreSession(script, snapshot()) : null;
}

function listen(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The truth drawn over the viewfinder: the page's corners on the frame the
 * `<video>` is presenting, mapped through its object-fit. Hidden while
 * anything covers the video (the confirm screen), and on real frames nobody
 * labelled.
 */
let truthLayer = null;

function showTruth(on) {
  if (!on) {
    truthLayer?.remove();
    truthLayer = null;
    if (player !== null) player.onPresent = null;
    return;
  }
  if (truthLayer !== null || player === null) return;
  const svgNs = "http://www.w3.org/2000/svg";
  truthLayer = document.createElementNS(svgNs, "svg");
  truthLayer.setAttribute(
    "style",
    "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;overflow:visible",
  );
  const polygon = document.createElementNS(svgNs, "polygon");
  polygon.setAttribute("style", "fill:none;stroke:#00e05a;stroke-width:2;stroke-dasharray:6 4");
  truthLayer.appendChild(polygon);
  document.body.appendChild(truthLayer);
  player.onPresent = (k) => {
    const video = document.querySelector("video");
    const quad = player.frames[k]?.quad ?? null;
    if (video === null || quad === null || video.videoWidth === 0) {
      polygon.setAttribute("points", "");
      return;
    }
    const box = video.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const stage = video.parentElement?.parentElement ?? video;
    if (box.width === 0 || hit === null || !(hit === video || stage.contains(hit))) {
      polygon.setAttribute("points", "");
      return;
    }
    const fit = getComputedStyle(video).objectFit;
    const scaleOf = fit === "contain" ? Math.min : Math.max;
    const scale = scaleOf(box.width / video.videoWidth, box.height / video.videoHeight);
    const w = video.videoWidth * scale;
    const h = video.videoHeight * scale;
    const x0 = box.left + (box.width - w) / 2;
    const y0 = box.top + (box.height - h) / 2;
    polygon.setAttribute("points", quad.map(([x, y]) => `${(x0 + x * w).toFixed(1)},${(y0 + y * h).toFixed(1)}`).join(" "));
    // How many frames it has been drawn on — what the playground's smoke check reads.
    truthLayer.dataset.drawn = String(Number(truthLayer.dataset.drawn ?? 0) + 1);
  };
}

// A host gives the flow its height (`.app-h`); this page is the host.
const style = document.createElement("style");
style.textContent = "html, body { margin: 0; background: #111; } .app-h { height: 100svh; }";
document.head.appendChild(style);

/**
 * What the layout shows of the frame, for the scripted user to frame pages
 * in (`--frame-by screen`): the newest measured visible region (frame
 * fractions) and every opaque control seen over it since the camera went
 * live — or null before the first sample.
 */
function view() {
  const last = regions[regions.length - 1];
  if (last === undefined) return null;
  const blocks = regions.flatMap((r) => r.blocks ?? []);
  return { x: last.x, y: last.y, width: last.width, height: last.height, blocks, samples: regions.length };
}

window.__session = {
  prepare,
  view,
  prepareClip,
  run,
  sheet,
  sessions: describeSessions,
  listen,
  showTruth,
  captures,
  score,
  snapshot,
  frameInterval: () => player?.frameIntervalMs ?? null,
};
window.__sessionReady = true;
