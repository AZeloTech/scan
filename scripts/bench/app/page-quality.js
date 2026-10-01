/**
 * The resolution page: does the PDF keep every pixel the camera gave the page?
 *
 * `window.__quality` for `scripts/bench/quality.mjs`:
 *
 *   flow({ sensor, stream, still, maxBytes }) — mount the real `<ScanFlow>` on a fake
 *     camera, take one page with the shutter, confirm it, open step 2, tap
 *     "Gerar PDF", and hand back the PDF (base64) and every diagnostics event.
 *   edits({ sensor, stream })        — the real render pipeline, through the
 *     real store: one capture, then girar + cantos + acabamento, each render's
 *     size and the final's decoded size — no generational shrink allowed.
 *
 * The fake camera photographs one synthetic scene — a drawn page (ruled lines,
 * a title bar, a stamp) on a dark desk, no photograph of anything — in the
 * geometry a phone has: `sensor` is the upright photo the still pipeline
 * returns at its largest size, and the `stream` is the centre crop of that
 * sensor at the stream's aspect, scaled to the stream's size (a 16:9 preview of
 * a 4:3 sensor). `still`:
 *
 *   "ok"      — `takePhoto` honours the size asked for (the range maxima →
 *               the whole sensor), ~300 ms;
 *   "closest" — answers a fixed other-shaped size whatever is asked (the
 *               Galaxy S25 Ultra's 3648×1704 for any request);
 *   "hang"    — never answers (the budget has to run out);
 *   "none"    — no `ImageCapture` at all (Safari).
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ScanFlow } from "../../../src/index.ts";
import { copyFor } from "../../../src/lib/i18n.ts";
import { createScanStore } from "../../../src/lib/scan-store.ts";
import { encodeCanvas } from "../../../src/lib/image.ts";
import { assetUrls } from "../../../src/lib/runtime-config.ts";

const copy = copyFor("pt");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitFor(find, timeoutMs = 20000, everyMs = 50) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const found = find();
    if (found) return found;
    await sleep(everyMs);
  }
  return null;
}

function button(match) {
  return (
    [...document.querySelectorAll("button")].find(
      (b) => !b.disabled && match((b.textContent ?? "").trim(), b.getAttribute("aria-label") ?? ""),
    ) ?? null
  );
}

/* ── the scene ──────────────────────────────────────────────────────────── */

/** The page, as fractions of the preview's field of view (upright). */
const PAGE = { x: 0.14, y: 0.16, width: 0.72 };

/** The preview's field of view inside the upright sensor: its centre crop at the stream's aspect. */
function previewFov(sensor, stream) {
  const aspect = stream.width / stream.height;
  if (sensor.width / sensor.height > aspect) {
    const width = sensor.height * aspect;
    return { x: (sensor.width - width) / 2, y: 0, width, height: sensor.height };
  }
  const height = sensor.width / aspect;
  return { x: 0, y: (sensor.height - height) / 2, width: sensor.width, height };
}

/** The page rectangle in upright sensor pixels. */
function pageInSensor(sensor, stream) {
  const fov = previewFov(sensor, stream);
  const width = PAGE.width * fov.width;
  const height = width * Math.SQRT2;
  return { x: fov.x + PAGE.x * fov.width, y: fov.y + PAGE.y * fov.height, width, height };
}

/**
 * Draw the scene into `ctx`, where the context's pixel (0,0)…(w,h) shows the
 * sensor rectangle `view` (upright sensor pixels).
 */
function drawScene(ctx, w, h, sensor, stream, view) {
  const sx = w / view.width;
  const sy = h / view.height;
  ctx.save();
  ctx.setTransform(sx, 0, 0, sy, -view.x * sx, -view.y * sy);
  ctx.fillStyle = "#2a2622";
  ctx.fillRect(view.x, view.y, view.width, view.height);
  const page = pageInSensor(sensor, stream);
  ctx.fillStyle = "#f3f0e6";
  ctx.fillRect(page.x, page.y, page.width, page.height);
  ctx.fillStyle = "#1f2430";
  const m = page.width * 0.08;
  ctx.fillRect(page.x + m, page.y + m, page.width * 0.5, page.width * 0.045);
  const line = page.height * 0.022;
  for (let i = 0, y = page.y + m * 2.2; y < page.y + page.height - m; i += 1, y += line) {
    const full = i % 6 !== 5;
    ctx.fillRect(page.x + m, y, (page.width - 2 * m) * (full ? 1 : 0.5), Math.max(1, line * 0.22));
  }
  ctx.strokeStyle = "rgba(40,60,190,0.85)";
  ctx.lineWidth = page.width * 0.01;
  ctx.beginPath();
  ctx.arc(page.x + page.width * 0.72, page.y + page.height * 0.82, page.width * 0.1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/* ── the fake camera ────────────────────────────────────────────────────── */

let cameraCanvas = null;
let pump = 0;
/** Every size the app asked the fake stream for (`applyConstraints`). */
let streamSizes = [];

function installCamera({ sensor, stream, still, restore = "ok" }) {
  const fov = previewFov(sensor, stream);
  const media = navigator.mediaDevices;
  const getUserMedia = async () => {
    cameraCanvas = document.createElement("canvas");
    cameraCanvas.width = stream.width;
    cameraCanvas.height = stream.height;
    const ctx = cameraCanvas.getContext("2d");
    drawScene(ctx, stream.width, stream.height, sensor, stream, fov);
    const captured = cameraCanvas.captureStream(0);
    const track = captured.getVideoTracks()[0];
    // The phone camera's modes: constraints in landscape terms, the stream
    // portrait. A cap (1920×1080) redraws the same field of view smaller; the
    // native size (3840×2160) brings the stream back — unless `restore` is
    // "stuck", a camera that takes the constraints and never delivers the size.
    const sizes = [];
    Object.defineProperty(track, "applyConstraints", {
      configurable: true,
      value: async (constraints = {}) => {
        const w = constraints.width?.ideal;
        const h = constraints.height?.ideal;
        if (typeof w !== "number" || typeof h !== "number") return;
        const long = Math.round((Math.max(w, h) / 3840) * stream.height);
        const short = Math.round((Math.min(w, h) / 2160) * stream.width);
        sizes.push({ width: short, height: long, at: Math.round(performance.now()) });
        if (restore === "stuck" && long > 1920) return;
        await sleep(150);
        cameraCanvas.width = short;
        cameraCanvas.height = long;
        drawScene(cameraCanvas.getContext("2d"), short, long, sensor, stream, fov);
        track.requestFrame?.();
      },
    });
    Object.defineProperty(track, "getSettings", {
      configurable: true,
      value: () => ({ width: cameraCanvas.width, height: cameraCanvas.height, deviceId: "fake" }),
    });
    streamSizes = sizes;
    // A static scene, re-presented at ~15 fps so the video keeps frames coming.
    window.clearInterval(pump);
    pump = window.setInterval(() => {
      if (track.readyState === "live") track.requestFrame?.();
    }, 66);
    track.requestFrame?.();
    return captured;
  };
  Object.defineProperty(media, "getUserMedia", { value: getUserMedia, configurable: true, writable: true });
  Object.defineProperty(media, "enumerateDevices", {
    value: async () => [{ deviceId: "fake", kind: "videoinput", label: "fake", groupId: "fake", toJSON() { return this; } }],
    configurable: true,
    writable: true,
  });
  const query = navigator.permissions.query.bind(navigator.permissions);
  Object.defineProperty(navigator.permissions, "query", {
    value: async (descriptor) =>
      descriptor?.name === "camera" ? { name: "camera", state: "granted", onchange: null, addEventListener() {}, removeEventListener() {} } : query(descriptor),
    configurable: true,
    writable: true,
  });

  const landscape = { width: Math.max(sensor.width, sensor.height), height: Math.min(sensor.width, sensor.height) };
  const calls = [];
  class FakeImageCapture {
    constructor(track) {
      this.track = track;
    }
    async getPhotoCapabilities() {
      // Sensor orientation, as a phone driver reports it.
      return {
        imageWidth: { min: 640, max: landscape.width, step: 1 },
        imageHeight: { min: 480, max: landscape.height, step: 1 },
      };
    }
    async takePhoto(settings) {
      calls.push(settings ?? null);
      if (still === "hang") return new Promise(() => {});
      if (still === "fail-second" && calls.length === 2) {
        await sleep(200);
        throw new DOMException("the camera could not take the photo", "UnknownError");
      }
      await sleep(300);
      // What the driver answers, upright.
      let size;
      if (still === "closest") size = { width: 1704, height: 3648 };
      else {
        const w = settings?.imageWidth ?? landscape.width;
        const h = settings?.imageHeight ?? landscape.height;
        size = { width: Math.min(w, h), height: Math.max(w, h) };
      }
      // A photo covers what its shape allows of the sensor: the whole sensor
      // when it is the sensor's shape, its own centre crop otherwise.
      const view = previewFov(sensor, size);
      const canvas = new OffscreenCanvas(size.width, size.height);
      drawScene(canvas.getContext("2d"), size.width, size.height, sensor, stream, view);
      return canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
    }
  }
  if (still === "none") {
    try {
      delete window.ImageCapture;
    } catch {
      // Not configurable.
    }
    window.ImageCapture = undefined;
  } else {
    window.ImageCapture = FakeImageCapture;
  }

  // A finger, not a mouse: the phone flow.
  const matchMedia = window.matchMedia.bind(window);
  const answer = (q, matches) => ({ matches, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  window.matchMedia = (q) => {
    if (/\(\s*pointer\s*:\s*fine\s*\)/.test(q)) return answer(q, false);
    if (/\(\s*pointer\s*:\s*coarse\s*\)/.test(q)) return answer(q, true);
    if (/\(\s*hover\s*:\s*none\s*\)/.test(q)) return answer(q, true);
    return matchMedia(q);
  };
  return { calls };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/* ── the flow ───────────────────────────────────────────────────────────── */

async function flow({ sensor, stream, still = "ok", pages = 1, restore = "ok", maxBytes = null }) {
  const camera = installCamera({ sensor, stream, still, restore });
  const events = [];
  let completed = null;
  const host = document.getElementById("root");
  const root = createRoot(host);
  root.render(
    createElement(ScanFlow, {
      assetBaseUrl: "/assets/",
      lang: "pt-BR",
      onDiagnostics: (event) => events.push(event),
      ...(maxBytes === null ? {} : { maxBytes }),
      onComplete: (result) => {
        completed = result;
      },
      onCancel: () => {},
    }),
  );
  const steps = [];
  const step = (what) => steps.push({ what, at: Math.round(performance.now()) });
  const allow = await waitFor(() => button((text) => text.includes(copy.primer.ctaAllow)) ?? (button((_, aria) => aria.startsWith(copy.capture.take(1).replace(/\d+$/, ""))) ? "live" : null));
  if (allow !== null && allow !== "live") {
    allow.click();
    step("allow");
  }
  const shutterPrefix = copy.capture.take(1).replace(/\d+$/, "");
  for (let n = 1; n <= pages; n += 1) {
    // Let the preview settle (and any cap change land) and the detector see the page.
    await waitFor(() => button((_, aria) => aria.startsWith(shutterPrefix)));
    await sleep(2500);
    const shutters = [...document.querySelectorAll("button")].filter((b) => !b.disabled && (b.getAttribute("aria-label") ?? "").startsWith(shutterPrefix));
    if (shutters.length === 0) throw new Error(`no shutter for page ${n}`);
    shutters[shutters.length - 1].click();
    step(`shutter ${n}`);
    const confirm = await waitFor(() => button((text) => text.includes(copy.confirm.confirmCta)), 30000);
    if (confirm === null) throw new Error(`the confirm screen never opened for page ${n}`);
    await sleep(600);
    confirm.click();
    step(`confirm ${n}`);
    await waitFor(() => !button((text) => text.includes(copy.confirm.confirmCta)), 10000);
  }
  const review = await waitFor(
    () =>
      button((text, aria) => aria.startsWith(copy.captureLayout.reviewAria(1).slice(0, 8)) || text.includes(copy.captureLayout.review) || aria.startsWith("Seguir")),
    20000,
  );
  if (review === null) throw new Error("no way to step 2");
  await sleep(400);
  review.click();
  step("review");
  const generate = await waitFor(() => button((text) => text.includes(copy.gerar.generate)), 60000);
  if (generate === null) throw new Error("no Gerar PDF");
  // Wait for every page to finish rendering before generating.
  await waitFor(() => new Set(events.filter((e) => e.type === "render").map((e) => e.page)).size >= pages, 60000);
  await sleep(300);
  (button((text) => text.includes(copy.gerar.generate)) ?? generate).click();
  step("generate");
  await waitFor(() => completed !== null, 120000);
  if (completed === null) throw new Error("the PDF never completed");
  const pdf = await blobToBase64(completed.file);
  root.unmount();
  window.clearInterval(pump);
  return { events, pdf, bytes: completed.file.size, steps, stillCalls: camera.calls, streamSizes };
}

/* ── the edits, through the real store and render pipeline ─────────────── */

async function decodedSize(blob) {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

async function edits({ sensor, stream }) {
  // The canonical exactly as the still path makes it: the preview's field of
  // view cut out of the sensor-native photo, every pixel kept, encoded once.
  const fov = previewFov(sensor, stream);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(fov.width);
  canvas.height = Math.round(fov.height);
  drawScene(canvas.getContext("2d"), canvas.width, canvas.height, sensor, stream, fov);
  const canonical = await encodeCanvas(canvas, "canonical");
  const W = canvas.width;
  const H = canvas.height;
  canvas.width = 0;
  const page = pageInSensor(sensor, stream);
  const quad = (inset) => {
    const x0 = (page.x - fov.x + inset) / W;
    const y0 = (page.y - fov.y + inset) / H;
    const x1 = (page.x - fov.x + page.width - inset) / W;
    const y1 = (page.y - fov.y + page.height - inset) / H;
    return { topLeft: { x: x0, y: y0 }, topRight: { x: x1, y: y0 }, bottomRight: { x: x1, y: y1 }, bottomLeft: { x: x0, y: y1 } };
  };
  const heard = [];
  const store = createScanStore({ assets: assetUrls("/assets/"), onQuality: (event) => heard.push(event) });
  const settled = async (revision) => {
    const ok = await waitFor(() => {
      const p = store.getSnapshot().session?.pages[0];
      return p !== undefined && p.status === "ready" && p.revision >= revision && p.rendered?.revision === p.revision ? p : null;
    }, 120000);
    if (ok === null) throw new Error(`render never settled: ${JSON.stringify(store.getSnapshot().session?.pages[0]?.status)}`);
    return ok;
  };
  const record = async (label) => {
    const p = store.getSnapshot().session.pages[0];
    const done = await settled(p.revision);
    return { label, width: done.width, height: done.height, decoded: await decodedSize(done.final), bytes: done.final.size, finish: done.rendered.finish, rotation: done.rendered.rotation, canonicalSame: done.canonical === canonical };
  };
  try {
    store.start();
    store.addCapture({ canonical, corners: quad(0), gate: null, path: "shutter" });
    const out = [await record("captured")];
    const id = store.getSnapshot().session.pages[0].id;
    store.rotatePage(id, "cw");
    out.push(await record("girar"));
    store.replaceCapture(id, { canonical, corners: quad(2), gate: null, path: "adjust" });
    out.push(await record("cantos"));
    store.setPageFinish(id, "bw");
    out.push(await record("acabamento"));
    store.rotatePage(id, "ccw");
    out.push(await record("girar de volta"));
    return { canonical: { width: W, height: H, bytes: canonical.size }, page: { width: page.width, height: page.height }, steps: out, heard };
  } finally {
    store.dispose();
  }
}

window.__quality = { flow, edits };
window.__qualityReady = true;
