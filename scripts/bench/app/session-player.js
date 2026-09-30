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
import { loopedFrame, loopedTime, renderedFrameCount, SESSION_FRAME_MS, sessionAt, sessionTruth } from "../emulator/session.js";
import { previewFocal, SessionRenderer, stillGeometry } from "../emulator/stream.js";

export const FRAME_INTERVAL_MS = SESSION_FRAME_MS;

/**
 * The browser's own `createImageBitmap`, taken before the session page wraps
 * the global to count the app's bitmaps (`perf-watch.js`): the player's
 * decodes and thumbnails are the bench's, not the app's.
 */
const nativeCreateImageBitmap =
  typeof globalThis.createImageBitmap === "function" ? globalThis.createImageBitmap.bind(globalThis) : null;

function createBitmap(...args) {
  return nativeCreateImageBitmap(...args);
}

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

/**
 * A still rendered ahead is used for a `takePhoto()` exposed within this of
 * its scripted time (`prepareStills`): the tap is late by the page's own
 * scheduling, more so on a throttled main thread.
 */
const PREPARED_STILL_SLACK_MS = 400;

/** The app's work between the scripted tap and `takePhoto()` (capabilities, the probe), roughly. */
const STILL_CALL_DELAY_MS = 15;

/** JPEG quality of the pre-rendered preview frames. */
const FRAME_QUALITY = 0.9;

/**
 * Part of every frame-cache key (`suites/session.mjs`): bump it when the way
 * frames are rendered or encoded here changes, so no run replays frames an
 * older player made. (The emulator's own source is hashed into the key.)
 */
export const FRAME_CACHE_VERSION = `1:q${FRAME_QUALITY}:tail${TAIL_FRAMES}`;

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
  const image = source instanceof Blob ? await createBitmap(source) : source;
  const scale = Math.min(1, THUMB_LONG_EDGE / Math.max(image.width, image.height));
  return createBitmap(image, {
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
  constructor(script, frameIntervalMs = FRAME_INTERVAL_MS, { streamScale = 1 } = {}) {
    this.script = script;
    this.frameIntervalMs = frameIntervalMs;
    // `streamScale`: the camera delivers every frame scaled up by this (a
    // 720×1280 session played as a 2160×3840 stream, the size a 4K phone
    // camera negotiates) — the scene and its truth are the same, in frame
    // fractions; only the pixels the app has to grab and resize grow.
    this.streamScale = streamScale;
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.round(script.frame.width * streamScale);
    this.canvas.height = Math.round(script.frame.height * streamScale);
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
    /** Times the app opened the camera again after stopping it (a remounted flow). */
    this.reopened = 0;
    /** The worker pumping frames (`camera-worker.js`), when the browser allows one. */
    this.pump = null;
    /** Frames carry their camera time as their timestamp (the worker pump). */
    this.exactTimestamps = false;
    this.flushed = null;
    /** Called with each frame index the app's `<video>` presents (the playground's truth overlay). */
    this.onPresent = null;
    /** The app's `<video>`, once it is live ({@link StreamPlayer#watchVideo}). */
    this.video = null;
  }

  /**
   * The rendered frame camera frame `n` shows: frame `n` itself, or for a
   * looped script the forward-and-back fold of it (`loopedFrame`). A real
   * clip is never looped.
   */
  frameOf(n) {
    return this.script.loop === undefined ? n : loopedFrame(this.script, n);
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
    // Keyed by camera frame (`n`): a looped session shows a rendered frame `k` many times.
    const pushAt = new Map(this.pushes.map((push) => [push.n ?? push.k, push.at]));
    const offsets = this.presented
      .filter((p) => Number.isFinite(p.mediaTime) && pushAt.has(p.n ?? p.k))
      .map((p) => pushAt.get(p.n ?? p.k) - origin - p.mediaTime * 1000)
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
      if (best === null || distance < best.distance) best = { k: push.k, n: push.n ?? push.k, distance };
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
    if (this.exactTimestamps) {
      // The worker stamped every frame with its camera time: no offset to learn.
      const n = timestampUs === null ? null : this.frameAtMediaTime(timestampUs / 1e6);
      this.grabs.push({
        id,
        at,
        k: n === null ? null : this.frameOf(n),
        n,
        timestampUs,
        offsetMs: 0,
        matchMs: 0,
        presentedK: this.presented.length === 0 ? null : this.presented[this.presented.length - 1].k,
        pushedK: this.pushes.length === 0 ? null : this.current(),
      });
      return;
    }
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

  /** Decode camera frame `n` (its rendered frame's JPEG) ahead of the clock. */
  decode(n) {
    const k = this.frameOf(n);
    if (k >= this.blobs.length || this.decoded.has(n)) return;
    const entry = { bitmap: null };
    entry.promise = createBitmap(this.blobs[k]).then((bitmap) => (entry.bitmap = bitmap));
    this.decoded.set(n, entry);
  }

  /**
   * The last camera frame the script plays: its last rendered frame, or —
   * looped — none: the loop plays on for as long as the page runs, so a flow
   * remounted after the script still opens onto a moving camera.
   */
  lastFrame() {
    return this.script.loop === undefined ? this.blobs.length - 1 : Infinity;
  }

  /**
   * The app asked for the camera: start the clock and the stream.
   *
   * Where the browser can (`MediaStreamTrackGenerator`: Chromium), frames are
   * pumped by a worker (`camera-worker.js`) on its own clock — a phone's
   * camera does not slow down with the page's main thread, and CDP throttles
   * only that thread — each stamped with its camera time, so a frame the page
   * holds is named exactly. Elsewhere (WebKit) the page's own rAF pumps them
   * into a `canvas.captureStream()`, as it always did.
   *
   * Asked again after the app stopped the track (the flow was unmounted and
   * mounted again), the camera answers a new track on the same clock — a
   * phone's camera reopened, the scene still in front of it.
   */
  open() {
    if (this.stream !== null) {
      if (this.track?.readyState !== "ended") return this.stream;
      this.reopened += 1;
      if (this.pump !== null) {
        const generator = new MediaStreamTrackGenerator({ kind: "video" });
        this.pump.postMessage({ type: "reopen", writable: generator.writable }, [generator.writable]);
        this.track = generator;
        this.stream = new MediaStream([generator]);
        return this.stream;
      }
      this.stream = this.pageStream();
      this.track = this.stream.getVideoTracks()[0];
      this.track.requestFrame?.();
      return this.stream;
    }
    this.startedAt = performance.now();
    this.running = true;
    if (typeof MediaStreamTrackGenerator === "function" && typeof Worker === "function") {
      this.openPumped();
      return this.stream;
    }
    this.stream = this.pageStream();
    this.track = this.stream.getVideoTracks()[0];
    this.track.requestFrame?.();
    this.pushes.push({ k: this.frameOf(0), n: 0, at: performance.now() });
    let shown = 0;
    const last = this.lastFrame();
    for (let n = 1; n <= DECODE_AHEAD; n += 1) this.decode(n);
    const tick = () => {
      if (!this.running) return;
      const due = Math.min(last, Math.floor(this.now() / this.frameIntervalMs));
      if (due > shown) {
        const entry = this.decoded.get(due);
        if (entry?.bitmap) {
          this.ctx.drawImage(entry.bitmap, 0, 0, this.canvas.width, this.canvas.height);
          if (this.track.readyState === "live") this.track.requestFrame?.();
          this.pushes.push({ k: this.frameOf(due), n: due, at: performance.now() });
          this.skipped += due - shown - 1;
          for (let n = shown; n <= due; n += 1) {
            this.decoded.get(n)?.bitmap?.close();
            this.decoded.delete(n);
          }
          shown = due;
        } else {
          this.decode(due);
        }
        for (let n = due + 1; n <= Math.min(last, due + DECODE_AHEAD); n += 1) this.decode(n);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return this.stream;
  }

  /**
   * The page-pumped camera's stream. At the camera's own rate rather than
   * `captureStream(0)` + `requestFrame()`: WebKit's canvas capture never
   * delivers a frame to a `<video>` in that mode (tested: 0 × 0 for ever),
   * and at a rate it captures each change of the canvas as it happens.
   */
  pageStream() {
    return this.canvas.captureStream(Math.round(1000 / this.frameIntervalMs));
  }

  /** The worker-pumped camera (see {@link open}). */
  openPumped() {
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    this.track = generator;
    this.stream = new MediaStream([generator]);
    this.exactTimestamps = true;
    this.pump = new Worker("/app/camera-worker.js", { type: "module", name: "bench-camera" });
    this.pump.onmessage = (event) => {
      const message = event.data;
      if (message.type === "pushes") {
        for (const push of message.list) {
          this.pushes.push({ k: push.k, n: push.n, at: push.atAbs - performance.timeOrigin });
        }
        this.skipped = message.skipped;
      } else if (message.type === "flushed") {
        this.skipped = message.skipped;
        this.flushed?.();
      }
    };
    this.pump.postMessage(
      {
        type: "start",
        writable: generator.writable,
        blobs: this.blobs,
        intervalMs: this.frameIntervalMs,
        loopFrames: this.script.loop?.frames ?? null,
        size: this.streamScale === 1 ? null : { width: this.canvas.width, height: this.canvas.height },
        lastFrame: this.lastFrame(),
        originAbs: performance.timeOrigin + this.startedAt,
      },
      [generator.writable],
    );
  }

  /** The camera frame (`n`) a media timestamp names — exact when the worker stamped it. */
  frameAtMediaTime(seconds) {
    return Math.round((seconds * 1000) / this.frameIntervalMs);
  }

  /** Watch the app's `<video>`: which frame it presented, and when. */
  watchVideo(video) {
    this.video = video;
    if (typeof video.requestVideoFrameCallback !== "function") return;
    const onFrame = (now, metadata) => {
      let k;
      let n;
      if (this.exactTimestamps && Number.isFinite(metadata.mediaTime)) {
        // The frame's own stamp is its camera time.
        n = this.frameAtMediaTime(metadata.mediaTime);
        k = this.frameOf(n);
      } else {
        // The newest frame pushed before it was presented is the one on screen.
        let push = this.pushes.length - 1;
        while (push > 0 && this.pushes[push].at > now) push -= 1;
        k = this.pushes[push]?.k ?? 0;
        n = this.pushes[push]?.n ?? k;
      }
      this.presented.push({ at: now, k, n, presentedFrames: metadata.presentedFrames, mediaTime: metadata.mediaTime });
      if (this.onPresent !== null) this.onPresent(k);
      if (this.running && this.video === video) video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  /** Stop the camera; with a worker pump, its last pushes are collected first. */
  async stop() {
    this.running = false;
    if (this.pump !== null) {
      const flushed = new Promise((resolve) => {
        this.flushed = resolve;
        setTimeout(resolve, 1000);
      });
      this.pump.postMessage({ type: "stop" });
      await flushed;
      this.pump.terminate();
      this.pump = null;
    }
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
      reopened: this.reopened,
      camera: this.exactTimestamps ? "worker" : "page",
    };
  }
}

/** A synthetic session: every frame rendered ahead from the script, stills rendered on demand. */
export class SessionPlayer extends StreamPlayer {
  /**
   * @param {object} script a `buildSession` script
   * @param {{ stills?: boolean }} options `stills: false` — a camera with no
   *   still pipeline (Safari has no `ImageCapture`): nothing is ever rendered
   *   here, so a page with no WebGL can play frames another browser rendered.
   */
  constructor(script, { stills = true, streamScale = 1 } = {}) {
    super(script, FRAME_INTERVAL_MS, { streamScale });
    this.stillsEnabled = stills;
    this.renderer = stills ? new SessionRenderer() : null;
  }

  /**
   * The session's frames: from the frame cache when `cache` names an entry
   * that is there (`GET /frame-cache/<key>/…`, written by an earlier run of
   * the same script, emulator and browser build), else rendered — plate,
   * baked pages, then every frame — and, with `cache`, written there for the
   * next run. A cached frame is the very JPEG a render made, so a run from
   * the cache sees the pixels a rendering run does.
   */
  async prerender(onProgress = () => {}, { cache = null } = {}) {
    const started = performance.now();
    const info = this.renderer === null ? { renderer: null } : this.renderer.prepare(this.script);
    if (cache !== null) {
      const loaded = await this.loadCached(cache, onProgress);
      if (loaded !== null) {
        return { ...info, ...loaded, cached: true, totalMs: performance.now() - started };
      }
    }
    if (this.renderer === null) throw new Error("no cached frames for this session, and this camera renders none");
    const count = renderedFrameCount(this.script, TAIL_FRAMES);
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
    const renderMsPerFrame = (performance.now() - renderStarted) / count;
    // Where each page's print is — measured now, off the clock, so a still's
    // content truth costs its real-time pipeline nothing (it is cached).
    for (const spec of documents.values()) documentContent(spec);
    await this.openOnFirstFrame();
    if (cache !== null) await this.storeCached(cache, { frames: count, renderMsPerFrame });
    return {
      ...info,
      frames: count,
      renderMsPerFrame,
      bytes: this.blobs.reduce((sum, blob) => sum + blob.size, 0),
      cached: false,
      totalMs: performance.now() - started,
    };
  }

  /** The stream opens on frame 0 (a bitmap drawn and let go). */
  async openOnFirstFrame() {
    const first = await createBitmap(this.blobs[0]);
    this.ctx.drawImage(first, 0, 0, this.canvas.width, this.canvas.height);
    first.close();
  }

  /** Frames and truth from the frame cache, or `null` when the entry is not (all) there. */
  async loadCached(key, onProgress) {
    const base = `/frame-cache/${encodeURIComponent(key)}`;
    const response = await fetch(`${base}/manifest.json`);
    if (!response.ok) return null;
    const manifest = await response.json();
    if (!Array.isArray(manifest.frames) || manifest.frames.length !== manifest.count) return null;
    const blobs = [];
    for (let k = 0; k < manifest.count; k += 1) {
      const frame = await fetch(`${base}/${k}.jpg`);
      if (!frame.ok) return null;
      blobs.push(await frame.blob());
      if (k % 60 === 0) onProgress(k, manifest.count);
    }
    this.blobs = blobs;
    this.frames = manifest.frames;
    // The content boxes a still's truth reads, measured off the clock as a render would.
    for (const layer of this.script.scene.layers) if (layer.document !== undefined) documentContent(layer.document);
    await this.openOnFirstFrame();
    return {
      frames: manifest.count,
      renderMsPerFrame: manifest.renderMsPerFrame ?? null,
      bytes: blobs.reduce((sum, blob) => sum + blob.size, 0),
    };
  }

  /** Write this session's frames to the frame cache, the manifest last (it marks the entry complete). */
  async storeCached(key, { frames, renderMsPerFrame }) {
    const base = `/frame-cache/${encodeURIComponent(key)}`;
    for (let k = 0; k < frames; k += 1) {
      const put = await fetch(`${base}/${k}.jpg`, { method: "PUT", body: this.blobs[k] });
      if (!put.ok) return false;
    }
    const manifest = { count: frames, frames: this.frames, renderMsPerFrame, session: this.script.id, seed: this.script.seed };
    const put = await fetch(`${base}/manifest.json`, { method: "PUT", body: JSON.stringify(manifest) });
    return put.ok;
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
    // `still.disrupt`: the preview misbehaves while the photo is taken
    // (frozen, resized, re-exposed), as Android's camera does for a still.
    if (still.disrupt && this.pump !== null) {
      const d = still.disrupt;
      this.pump.postMessage({
        type: "disrupt",
        untilAbs: performance.timeOrigin + performance.now() + (d.ms ?? still.latencyMs),
        size: d.size ?? null,
        gain: d.gain ?? 1,
        freeze: d.freeze === true,
      });
    }
    await sleep(still.exposeAtMs);
    // A looped session's still is a photo of the frame on screen: scene time, not camera time.
    const wanted = loopedTime(this.script, this.now());
    // A still rendered ahead for this tap (`prepareStills`) when there is one:
    // rendering it now would block the page's main thread for as long as the
    // software GPU takes — seconds under `--cpu 4` — which a phone's still
    // pipeline never does.
    const ahead = this.takePrepared(request, calledAt + still.exposeAtMs);
    const rendered = ahead ?? (await this.renderStill(wanted, request));
    const index = this.stills.length;
    this.stillThumbs[index] = rendered.thumb;
    const remaining = still.latencyMs - (this.now() - calledAt);
    if (remaining > 0) await sleep(remaining);
    this.stills.push({
      index,
      attempt,
      calledAt,
      exposedAt: rendered.exposedAt,
      doneAt: this.now(),
      request,
      width: rendered.width,
      height: rendered.height,
      focalPixels: rendered.focalPixels,
      aspect: still.aspect,
      fovScale: still.fovScale,
      renderMs: rendered.renderMs,
      renderedAhead: ahead !== null,
      bytes: rendered.blob.size,
      ...compactTruth(rendered.truth),
      content: rendered.content,
    });
    return rendered.blob;
  }

  /** One still of the scene at scene time `exposedAt`, at the size `request` gets from this sensor. */
  async renderStill(exposedAt, request) {
    const still = this.script.still;
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
    const thumb = await thumbnailOf(canvas);
    canvas.width = 0;
    canvas.height = 0;
    return { exposedAt, request, blob, renderMs, truth, content, thumb, width: frame.width, height: frame.height, focalPixels: geometry.focalPixels };
  }

  /**
   * Render, before the clock starts, the still each scripted tap will ask
   * for: exposed at the tap's scripted camera time plus the pipeline's
   * exposure delay, at the size the app requests (the sensor's full size —
   * computed with the app's own `pickPhotoSize`). A tap
   * that lands close to its time gets it; one that does not (or a person
   * tapping in the playground) is rendered on demand.
   */
  async prepareStills(requestFor) {
    this.preparedStills = [];
    if (this.renderer === null) return 0;
    const started = performance.now();
    for (const step of this.script.actions ?? []) {
      if (step.tap === undefined) continue;
      const at = step.at + this.script.still.exposeAtMs + STILL_CALL_DELAY_MS;
      const request = requestFor(this.script);
      const rendered = await this.renderStill(loopedTime(this.script, at), request);
      this.preparedStills.push({ ...rendered, cameraAt: at, used: false });
    }
    return performance.now() - started;
  }

  /** The still rendered ahead for an exposure at camera time `cameraAt` with this request, if one is near enough. */
  takePrepared(request, cameraAt) {
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const match = (this.preparedStills ?? []).find(
      (p) => !p.used && same(p.request, request) && Math.abs(p.cameraAt - cameraAt) <= PREPARED_STILL_SLACK_MS,
    );
    if (match === undefined) return null;
    match.used = true;
    return match;
  }

  /**
   * The primary page's content boxes on preview frame `k` (normalized to the
   * frame; `null` with no page) — computed on demand for the frames a capture
   * took, rather than kept for every frame of the session.
   */
  frameContent(k) {
    // `k` is a rendered frame: scene time, looped or not.
    const params = sessionAt(this.script, k * FRAME_INTERVAL_MS);
    return withContent(groundTruth(params), params).content;
  }
}
