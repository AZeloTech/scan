/**
 * Plays a session script as a camera, in real time.
 *
 * **Rendered ahead, played in real time.** The bench's WebGL runs on a
 * software rasterizer (deterministic, and there on every machine), which draws
 * a session frame in ~0.1 s at 720×1280 — too slow to render thirty a second
 * while the app under test runs beside it. So {@link SessionPlayer#prerender}
 * renders every frame of the script first, at 30 fps of camera time, each with
 * its own ground truth, and keeps them as JPEGs; once the app opens the camera
 * the clock starts and the player pushes frame k into the capture stream when
 * camera time reaches k / 30 s, decoding a few frames ahead. What the app sees
 * is a 30 fps camera moving in real time; a frame the page could not decode in
 * time is skipped, never slowed down, and the log says so.
 *
 * Stills (`takePhoto`) are rendered on demand from the pose at the moment they
 * are exposed — the renderer is idle during playback.
 *
 * It also keeps which frame the app's `<video>` was actually presenting
 * (`requestVideoFrameCallback`), so an event stamped with a time can be scored
 * against the frame that was on screen then.
 *
 * The streaming itself is {@link StreamPlayer}, which a real clip's player
 * (`clip-player.js`) shares: only where frames and stills come from differs.
 */

import { documentContent } from "../emulator/documents.js";
import { applyEffects, groundTruth, withContent } from "../emulator/scene.js";
import { sessionAt, sessionTruth } from "../emulator/session.js";
import { previewFocal, SessionRenderer, stillGeometry } from "../emulator/stream.js";

export const FRAME_INTERVAL_MS = 1000 / 30;

/** Frames rendered past the script's end, for a flow still finishing its last step. */
const TAIL_FRAMES = 60;

/** Frames decoded ahead of the clock. */
const DECODE_AHEAD = 6;

/**
 * Naming a frame by its media timestamp ({@link StreamPlayer#timestampOffset}):
 * at least this many presented frames, this share of them within this many
 * ms of their median offset.
 */
const OFFSET_MIN_FRAMES = 10;
const OFFSET_AGREE_SHARE = 0.8;
const OFFSET_AGREE_MS = 3;

/** Thumbnail long edge for the report's film strips. */
const THUMB_LONG_EDGE = 360;

/** JPEG quality of the pre-rendered preview frames. */
const FRAME_QUALITY = 0.9;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("encode failed")) : resolve(blob)), type, quality);
  });
}

function compactTruth(truth) {
  return {
    quad: truth.quad,
    corners: truth.corners ?? null,
    whole: truth.whole,
    share: truth.inFrameShare,
    visible: truth.visible ?? null,
  };
}

/** A small copy of a canvas, bitmap or image blob, for the report's film strips. */
export async function thumbnailOf(source) {
  const image = source instanceof Blob ? await createImageBitmap(source) : source;
  const scale = Math.min(1, THUMB_LONG_EDGE / Math.max(image.width, image.height));
  return createImageBitmap(image, {
    resizeWidth: Math.max(1, Math.round(image.width * scale)),
    resizeHeight: Math.max(1, Math.round(image.height * scale)),
    resizeQuality: "high",
  });
}

/**
 * A camera made of JPEG frames: `blobs[k]` goes on screen at camera time
 * `k × frameIntervalMs`, in real time, from the moment the app opens the
 * camera. The synthetic session and a real clip differ only in where the
 * frames come from and what a still is.
 */
export class StreamPlayer {
  /** @param {{ frame: { width: number, height: number } }} script */
  constructor(script, frameIntervalMs = FRAME_INTERVAL_MS) {
    this.script = script;
    this.frameIntervalMs = frameIntervalMs;
    this.canvas = document.createElement("canvas");
    this.canvas.width = script.frame.width;
    this.canvas.height = script.frame.height;
    this.ctx = this.canvas.getContext("2d");
    this.stream = null;
    this.track = null;
    this.startedAt = null;
    this.frames = [];
    this.blobs = [];
    this.decoded = new Map();
    this.pushes = [];
    this.skipped = 0;
    this.stills = [];
    this.presented = [];
    /** Each preview grab the app announced (`grab` probe events), with the frame then on screen. */
    this.grabs = [];
    /** The still attempt the app announced (`still-call`) for the next `takePhoto()` to answer. */
    this.pendingAttempt = null;
    this.stillThumbs = [];
    this.running = false;
    this.errors = [];
    /** Called with each frame index the app's `<video>` presents (the playground's truth overlay). */
    this.onPresent = null;
    /** The app's `<video>`, once it is live ({@link StreamPlayer#watchVideo}). */
    this.video = null;
  }

  /** The frame index the camera last pushed. */
  current() {
    return this.pushes.length === 0 ? 0 : this.pushes[this.pushes.length - 1].k;
  }

  /** The frame the app's `<video>` last presented. */
  presentedFrame() {
    return this.presented.length === 0 ? this.current() : this.presented[this.presented.length - 1].k;
  }

  /**
   * How the stream's media timestamps line up with the push log: the offset
   * (ms) from a frame's timestamp to its push's time since the first push.
   * The canvas capture stamps each frame with its capture time since the
   * first frame it captured — which need not be the first push (in the
   * bench's sessions it is the second, ~40 ms later) — so the offset is learnt
   * from the frames the `<video>` presented, whose timestamps its callbacks
   * report: it is one number for every frame, to a millisecond or two. `null`
   * until enough presented frames agree on it.
   */
  timestampOffset() {
    if (this.pushes.length === 0) return null;
    const origin = this.pushes[0].at;
    const pushAt = new Map(this.pushes.map((push) => [push.k, push.at]));
    const offsets = this.presented
      .filter((p) => Number.isFinite(p.mediaTime) && pushAt.has(p.k))
      .map((p) => pushAt.get(p.k) - origin - p.mediaTime * 1000)
      .sort((a, b) => a - b);
    if (offsets.length < OFFSET_MIN_FRAMES) return null;
    const median = offsets[Math.floor(offsets.length / 2)];
    const agree = offsets.filter((o) => Math.abs(o - median) <= OFFSET_AGREE_MS).length;
    return agree >= OFFSET_AGREE_SHARE * offsets.length ? median : null;
  }

  /**
   * The push whose frame carries media timestamp `us` (µs), given the
   * {@link timestampOffset}: each frame's stamp sits within a millisecond or
   * two of its push, against a frame interval between pushes. `null` when no
   * push is within a third of a frame: then nothing is named.
   */
  pushAtTimestamp(us, offsetMs) {
    if (this.pushes.length === 0 || offsetMs === null) return null;
    const at = us / 1000 + offsetMs;
    const origin = this.pushes[0].at;
    let best = null;
    for (const push of this.pushes) {
      const distance = Math.abs(push.at - origin - at);
      if (best === null || distance < best.distance) best = { k: push.k, distance };
    }
    return best.distance <= this.frameIntervalMs / 3 ? best : null;
  }

  /**
   * The media timestamp (µs) of the frame the app's `<video>` holds right now
   * — the one a `drawImage` of it takes — or `null` where it cannot be read.
   */
  heldTimestamp() {
    const video = this.video?.isConnected ? this.video : document.querySelector("video");
    if (video === null || video === undefined || typeof VideoFrame !== "function") return null;
    try {
      const frame = new VideoFrame(video);
      const us = frame.timestamp;
      frame.close();
      return Number.isFinite(us) ? us : null;
    } catch {
      return null;
    }
  }

  /**
   * The app just drew a preview frame to make a page of (`grab` probe event,
   * delivered synchronously from inside the draw's task): name the frame it
   * drew **by the frame's own timestamp** — the `<video>`'s current frame,
   * read in the same task ({@link heldTimestamp}) — never by when it was
   * presented: `drawImage` takes the newest frame the element holds, which
   * the last presentation callback has often not reported yet. `k` is `null`
   * when the frame cannot be named. The last presented and newest pushed
   * frames are kept for the record.
   */
  noteGrab(id, at) {
    const timestampUs = this.heldTimestamp();
    const offsetMs = this.timestampOffset();
    const match = timestampUs === null ? null : this.pushAtTimestamp(timestampUs, offsetMs);
    this.grabs.push({
      id,
      at,
      k: match?.k ?? null,
      timestampUs,
      offsetMs,
      matchMs: match?.distance ?? null,
      presentedK: this.presented.length === 0 ? null : this.presented[this.presented.length - 1].k,
      pushedK: this.pushes.length === 0 ? null : this.current(),
    });
  }

  /** The app is about to call `takePhoto()` for its attempt `attempt` (`still-call`). */
  noteStillCall(attempt) {
    this.pendingAttempt = attempt;
  }

  /** The attempt the current `takePhoto()` call answers — read once, at the call. */
  takeAttempt() {
    const attempt = this.pendingAttempt;
    this.pendingAttempt = null;
    return attempt;
  }

  /** Camera time: ms since the app opened the camera (0 before it has). */
  now() {
    return this.startedAt === null ? 0 : performance.now() - this.startedAt;
  }

  owns(track) {
    return track !== null && track === this.track;
  }

  decode(k) {
    if (k >= this.blobs.length || this.decoded.has(k)) return;
    const entry = { bitmap: null };
    entry.promise = createImageBitmap(this.blobs[k]).then((bitmap) => (entry.bitmap = bitmap));
    this.decoded.set(k, entry);
  }

  /** The app asked for the camera: start the clock and the stream. */
  open() {
    if (this.stream !== null) return this.stream;
    this.stream = this.canvas.captureStream(0);
    this.track = this.stream.getVideoTracks()[0];
    this.startedAt = performance.now();
    this.running = true;
    this.track.requestFrame();
    this.pushes.push({ k: 0, at: performance.now() });
    let shown = 0;
    const last = this.blobs.length - 1;
    for (let k = 1; k <= DECODE_AHEAD; k += 1) this.decode(k);
    const tick = () => {
      if (!this.running) return;
      const due = Math.min(last, Math.floor(this.now() / this.frameIntervalMs));
      if (due > shown) {
        const entry = this.decoded.get(due);
        if (entry?.bitmap) {
          this.ctx.drawImage(entry.bitmap, 0, 0);
          this.track.requestFrame();
          this.pushes.push({ k: due, at: performance.now() });
          this.skipped += due - shown - 1;
          for (let k = shown; k <= due; k += 1) {
            this.decoded.get(k)?.bitmap?.close();
            this.decoded.delete(k);
          }
          shown = due;
        } else {
          this.decode(due);
        }
        for (let k = due + 1; k <= due + DECODE_AHEAD; k += 1) this.decode(k);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return this.stream;
  }

  /** Watch the app's `<video>`: which frame it presented, and when. */
  watchVideo(video) {
    this.video = video;
    if (typeof video.requestVideoFrameCallback !== "function") return;
    const onFrame = (now, metadata) => {
      // The newest frame pushed before it was presented is the one on screen.
      let push = this.pushes.length - 1;
      while (push > 0 && this.pushes[push].at > now) push -= 1;
      const k = this.pushes[push]?.k ?? 0;
      this.presented.push({ at: now, k, presentedFrames: metadata.presentedFrames, mediaTime: metadata.mediaTime });
      if (this.onPresent !== null) this.onPresent(k);
      if (this.running) video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  stop() {
    this.running = false;
    this.track?.stop();
  }

  /** Everything logged, as plain data for the runner. */
  record() {
    return {
      startedAt: this.startedAt,
      frames: this.frames,
      pushes: this.pushes,
      skipped: this.skipped,
      stills: this.stills,
      presented: this.presented,
      grabs: this.grabs,
      errors: this.errors,
    };
  }
}

/** A synthetic session: every frame rendered ahead from the script, stills rendered on demand. */
export class SessionPlayer extends StreamPlayer {
  /** @param {object} script a `buildSession` script */
  constructor(script) {
    super(script, FRAME_INTERVAL_MS);
    this.renderer = new SessionRenderer();
  }

  /** Plate, baked pages, then every frame of the script. */
  async prerender(onProgress = () => {}) {
    const started = performance.now();
    const info = this.renderer.prepare(this.script);
    const count = Math.ceil(this.script.duration / FRAME_INTERVAL_MS) + TAIL_FRAMES;
    const work = document.createElement("canvas");
    work.width = this.script.frame.width;
    work.height = this.script.frame.height;
    const ctx = work.getContext("2d");
    const pending = [];
    const documents = new Map();
    const renderStarted = performance.now();
    for (let k = 0; k < count; k += 1) {
      const t = k * FRAME_INTERVAL_MS;
      const { canvas: gl, params } = this.renderer.render(t);
      for (const layer of params.layers) {
        if (layer.document !== undefined) documents.set(`${layer.document.type}:${layer.document.seed}`, layer.document);
      }
      ctx.drawImage(gl, 0, 0);
      applyEffects(ctx, params);
      this.frames.push({ i: k, t, ...compactTruth(sessionTruth(this.script, t)) });
      pending.push(toBlob(work, "image/jpeg", FRAME_QUALITY).then((blob) => (this.blobs[k] = blob)));
      if (pending.length >= 12) await Promise.all(pending.splice(0));
      if (k % 30 === 0) onProgress(k, count);
    }
    await Promise.all(pending);
    // Where each page's print is — measured now, off the clock, so a still's
    // content truth costs its real-time pipeline nothing (it is cached).
    for (const spec of documents.values()) documentContent(spec);
    // The stream opens on frame 0.
    this.ctx.drawImage(await createImageBitmap(this.blobs[0]), 0, 0);
    return {
      ...info,
      frames: count,
      renderMsPerFrame: (performance.now() - renderStarted) / count,
      bytes: this.blobs.reduce((sum, blob) => sum + blob.size, 0),
      totalMs: performance.now() - started,
    };
  }

  /**
   * The fake still pipeline: exposed `exposeAtMs` after the call, at the size
   * and field of view the script's still says, ready no sooner than
   * `latencyMs` after the call.
   */
  async takePhoto(request) {
    const attempt = this.takeAttempt();
    const still = this.script.still;
    const calledAt = this.now();
    await sleep(still.exposeAtMs);
    const exposedAt = this.now();
    const geometry = stillGeometry(still, this.script.frame, previewFocal(this.script), request);
    const frame = { width: geometry.width, height: geometry.height };
    const started = performance.now();
    const { canvas: gl, params } = this.renderer.render(exposedAt, { frame, focalPixels: geometry.focalPixels });
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(gl, 0, 0);
    applyEffects(ctx, params);
    const blob = await toBlob(canvas, "image/jpeg", still.quality);
    const renderMs = performance.now() - started;
    const truth = sessionTruth(this.script, exposedAt, { frame, focalPixels: geometry.focalPixels });
    const content = withContent(groundTruth(params), params).content;
    const index = this.stills.length;
    this.stillThumbs[index] = await thumbnailOf(canvas);
    const remaining = still.latencyMs - (this.now() - calledAt);
    if (remaining > 0) await sleep(remaining);
    this.stills.push({
      index,
      attempt,
      calledAt,
      exposedAt,
      doneAt: this.now(),
      request,
      width: frame.width,
      height: frame.height,
      focalPixels: geometry.focalPixels,
      aspect: still.aspect,
      fovScale: still.fovScale,
      renderMs,
      bytes: blob.size,
      ...compactTruth(truth),
      content,
    });
    return blob;
  }

  /**
   * The primary page's content boxes on preview frame `k` (normalized to the
   * frame; `null` with no page) — computed on demand for the frames a capture
   * took, rather than kept for every frame of the session.
   */
  frameContent(k) {
    const params = sessionAt(this.script, k * FRAME_INTERVAL_MS);
    return withContent(groundTruth(params), params).content;
  }
}
