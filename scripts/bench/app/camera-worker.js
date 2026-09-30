/**
 * The bench camera's frame pump, off the page's main thread.
 *
 * A phone's camera delivers frames whatever the page's main thread is doing;
 * a pump on that thread does not — under CDP CPU throttling (`--cpu 4`) it
 * starved, the "camera" dropped to 6–18 fps and a capture's frame could no
 * longer be named. So the session player hands this worker the session's
 * JPEG frames and the writable end of a `MediaStreamTrackGenerator` (Chromium),
 * and the worker decodes frame *n* and writes it as a `VideoFrame` at camera
 * time *n* × interval, on its own clock — which CDP does not throttle, like a
 * real camera pipeline. Each frame is stamped with its camera time
 * (`timestamp` = *n* × interval, µs), so the page names any frame it holds —
 * `new VideoFrame(video).timestamp`, `requestVideoFrameCallback`'s
 * `mediaTime` — exactly, by arithmetic.
 *
 * Late frames are skipped, never slowed; the pushes (camera frame *n*, the
 * rendered frame *k* it shows, absolute time) are reported back in batches.
 *
 * Messages in: `start` { writable, blobs, intervalMs, loopFrames, lastFrame,
 * originAbs }, `reopen` { writable } (the app stopped the track and asked for
 * the camera again), `flush`, `stop`. Out: `pushes` { list, skipped },
 * `flushed`, `error`.
 */

/** Frames decoded ahead of the clock. */
const DECODE_AHEAD = 6;
/** How often the push log goes back to the page. */
const REPORT_EVERY_MS = 100;

let writer = null;
let blobs = [];
let intervalMs = 1000 / 30;
let loopFrames = null;
let lastFrame = Infinity;
let originAbs = 0;
/** The stream's size when it is delivered scaled up (`streamScale`), else null (the frames' own). */
let size = null;
let running = false;
let shown = -1;
let skipped = 0;
let timer = null;
const decoded = new Map();
let pending = [];
let reportTimer = null;

const nowAbs = () => performance.timeOrigin + performance.now();

/** The rendered frame camera frame `n` shows (the session's forward-and-back loop, `loopedFrame`). */
function frameOf(n) {
  if (loopFrames === null || loopFrames < 2) return n;
  const span = loopFrames - 1;
  const m = n % (2 * span);
  return m <= span ? m : 2 * span - m;
}

function decode(n) {
  if (n > lastFrame || decoded.has(n)) return;
  const k = frameOf(n);
  if (k >= blobs.length) return;
  const entry = { bitmap: null };
  entry.promise = createImageBitmap(blobs[k]).then(
    (bitmap) => {
      if (entry.dropped) bitmap.close();
      else entry.bitmap = bitmap;
    },
    () => undefined,
  );
  decoded.set(n, entry);
}

/**
 * A camera busy with a photo (`disrupt`, from the still pipeline): until
 * `untilAbs` it freezes (pushes nothing), or delivers at another size and a
 * jumped exposure — what an Android `takePhoto()` does to the preview.
 */
let disrupt = null;

/** The frame at the stream's size: itself, or drawn onto a reused canvas (scaled up, or disrupted). */
let stage = null;
function scaled(bitmap) {
  const busy = disrupt !== null && nowAbs() < disrupt.untilAbs ? disrupt : null;
  const want = busy?.size ?? size;
  if (want === null && busy === null) return bitmap;
  const width = want?.width ?? bitmap.width;
  const height = want?.height ?? bitmap.height;
  if (stage === null || stage.width !== width || stage.height !== height) stage = new OffscreenCanvas(width, height);
  const ctx = stage.getContext("2d");
  ctx.imageSmoothingQuality = "low";
  ctx.filter = busy !== null && busy.gain !== 1 ? `brightness(${busy.gain})` : "none";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return stage;
}

function drop(upTo) {
  for (const [n, entry] of decoded) {
    if (n > upTo) continue;
    entry.dropped = true;
    entry.bitmap?.close();
    decoded.delete(n);
  }
}

function report() {
  if (pending.length === 0) return;
  postMessage({ type: "pushes", list: pending, skipped });
  pending = [];
}

function tick() {
  timer = null;
  if (!running) return;
  const due = Math.min(lastFrame, Math.floor((nowAbs() - originAbs) / intervalMs));
  const frozen = disrupt !== null && disrupt.freeze && nowAbs() < disrupt.untilAbs;
  if (due > shown && !frozen) {
    // The due frame, or — a scaled-up stream decoding slower than the clock
    // (`size`) — the newest one decoded since the last push: a late frame,
    // stamped with its own camera time, never a stall.
    let n = due;
    if (size !== null && !decoded.get(due)?.bitmap) {
      for (let m = due - 1; m > shown; m -= 1) {
        if (decoded.get(m)?.bitmap) {
          n = m;
          break;
        }
      }
    }
    const entry = decoded.get(n);
    if (entry?.bitmap && writer !== null) {
      const frame = new VideoFrame(scaled(entry.bitmap), { timestamp: Math.round(n * intervalMs * 1000) });
      writer.write(frame).catch(() => undefined);
      pending.push({ n, k: frameOf(n), atAbs: nowAbs() });
      if (shown >= 0) skipped += n - shown - 1;
      drop(n);
      shown = n;
    } else {
      decode(due);
    }
  }
  for (let n = Math.max(due, shown) + 1; n <= Math.min(lastFrame, Math.max(due, shown) + DECODE_AHEAD); n += 1) decode(n);
  const next = originAbs + (Math.max(due, shown) + 1) * intervalMs - nowAbs();
  timer = setTimeout(tick, Math.max(1, Math.min(intervalMs, next)));
}

onmessage = (event) => {
  const message = event.data;
  if (message.type === "start") {
    writer = message.writable.getWriter();
    blobs = message.blobs;
    intervalMs = message.intervalMs;
    loopFrames = message.loopFrames ?? null;
    size = message.size ?? null;
    lastFrame = message.lastFrame ?? Infinity;
    originAbs = message.originAbs;
    running = true;
    shown = -1;
    for (let n = 0; n <= DECODE_AHEAD; n += 1) decode(n);
    reportTimer = setInterval(report, REPORT_EVERY_MS);
    tick();
  } else if (message.type === "disrupt") {
    disrupt = { untilAbs: message.untilAbs, size: message.size ?? null, gain: message.gain ?? 1, freeze: message.freeze === true };
  } else if (message.type === "reopen") {
    writer?.releaseLock?.();
    writer = message.writable.getWriter();
  } else if (message.type === "flush") {
    report();
    postMessage({ type: "flushed", skipped });
  } else if (message.type === "stop") {
    running = false;
    if (timer !== null) clearTimeout(timer);
    if (reportTimer !== null) clearInterval(reportTimer);
    report();
    drop(Infinity);
    writer?.close().catch(() => undefined);
    postMessage({ type: "flushed", skipped });
  }
};
