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
  if (due > shown) {
    const entry = decoded.get(due);
    if (entry?.bitmap && writer !== null) {
      const frame = new VideoFrame(entry.bitmap, { timestamp: Math.round(due * intervalMs * 1000) });
      writer.write(frame).catch(() => undefined);
      pending.push({ n: due, k: frameOf(due), atAbs: nowAbs() });
      if (shown >= 0) skipped += due - shown - 1;
      drop(due);
      shown = due;
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
    lastFrame = message.lastFrame ?? Infinity;
    originAbs = message.originAbs;
    running = true;
    shown = -1;
    for (let n = 0; n <= DECODE_AHEAD; n += 1) decode(n);
    reportTimer = setInterval(report, REPORT_EVERY_MS);
    tick();
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
