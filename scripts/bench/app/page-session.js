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
  player = new SessionPlayer(script, { stills });
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
  log("camera-live", { videoW: video.videoWidth, videoH: video.videoHeight });
  player.watchVideo(video);
  return true;
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

  for (const step of script.actions) {
    if (step.tap !== undefined) {
      const wait = step.at - player.now();
      if (wait > 0) await sleep(wait);
      const button = await waitFor(() => captureButton(step.tap));
      if (button === null) {
        log("tap-missing", { trigger: step.tap, due: step.at });
        continue;
      }
      button.click();
      log("tap", { trigger: step.tap, due: step.at });
    } else if (step.confirmAfterMs !== undefined) {
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
  await sleep(TAIL_MS);
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

window.__session = {
  prepare,
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
