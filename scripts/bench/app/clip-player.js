/**
 * A real clip as the bench camera: frames `ffmpeg` already extracted into the
 * cache (`real.mjs`), played at their own rate into the real `<ScanFlow>`.
 *
 * Only on the machine that has the media: the frames come from the bench
 * server's `/real/frames/`, which exists only when `SCAN_REAL_MEDIA` is set,
 * and nothing the player holds leaves the page except numbers.
 *
 * A clip has no truth of its own. Frames a person labelled carry their label
 * (`frames[k].quad`, `labelled: true`); every other frame has `quad: null` and
 * `labelled: false`, which means *unknown*, not *no page*.
 *
 * A still (`takePhoto`) is the frame on screen when it is exposed, as it was
 * extracted — same shape as the preview, so the app keeps it; there is no
 * higher-resolution sensor behind a recorded clip.
 */

import { StreamPlayer, thumbnailOf } from "./session-player.js";

/** How many frames are fetched at once while loading. */
const FETCH_CONCURRENCY = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Replay frame `k`'s URL, as `real.mjs` names it. */
export function replayFrameUrl(clip, k) {
  return `/real/frames/${clip.key}/replay/f${String(k).padStart(5, "0")}.jpg`;
}

/**
 * A script-shaped description of a clip, so the session page's scripted user
 * and the fake camera need not know the difference: the frame, the duration,
 * what the user does, and what the still pipeline answers.
 */
export function clipScript(clip, { tapAtMs = null, confirmAfterMs = 1100, permission = "prompt" } = {}) {
  const frame = { width: clip.replay.width, height: clip.replay.height };
  const duration = (clip.replay.frames * 1000) / clip.fps;
  return {
    id: `real:${clip.id}`,
    clip: clip.key,
    seed: 0,
    title: clip.rel,
    frame,
    duration,
    permission,
    actions: tapAtMs === null ? [] : [{ at: tapAtMs, tap: "shutter" }, { confirmAfterMs }],
    marks: tapAtMs === null ? {} : { tapAt: tapAtMs },
    still: {
      aspect: "preview",
      fovScale: 1,
      latencyMs: 350,
      exposeAtMs: 90,
      // The recorded frame is all there is: the "sensor" is the frame, landscape.
      sensor: { width: Math.max(frame.width, frame.height), height: Math.min(frame.width, frame.height) },
      quality: 0.92,
    },
  };
}

export class ClipPlayer extends StreamPlayer {
  /**
   * @param {object} clip an entry of `/real/items.json`'s `clips`
   * @param {object} script from {@link clipScript}
   * @param {Map<number, { quad: number[][] | null, noDocument: boolean }>} labels by replay frame index
   */
  constructor(clip, script, labels = new Map()) {
    super(script, 1000 / clip.fps);
    this.clip = clip;
    this.labels = labels;
  }

  /** Fetch every replay frame (a few MB); nothing is rendered. */
  async load(onProgress = () => {}) {
    const started = performance.now();
    const count = this.clip.replay.frames;
    let next = 0;
    const worker = async () => {
      while (next < count) {
        const k = next;
        next += 1;
        const response = await fetch(replayFrameUrl(this.clip, k));
        if (!response.ok) throw new Error(`replay frame ${k}: HTTP ${response.status}`);
        this.blobs[k] = await response.blob();
        if (k % 30 === 0) onProgress(k, count);
      }
    };
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
    for (let k = 0; k < count; k += 1) {
      const label = this.labels.get(k);
      this.frames.push({
        i: k,
        t: k * this.frameIntervalMs,
        labelled: label !== undefined,
        noDocument: label?.noDocument ?? false,
        quad: label === undefined || label.noDocument ? null : label.quad,
        corners: label === undefined || label.noDocument ? null : label.quad,
        whole: null,
        share: null,
      });
    }
    this.ctx.drawImage(await createImageBitmap(this.blobs[0]), 0, 0);
    return {
      frames: count,
      bytes: this.blobs.reduce((sum, blob) => sum + blob.size, 0),
      totalMs: performance.now() - started,
      labelled: this.labels.size,
    };
  }

  /** The frame on screen when the still is exposed, as extracted. */
  async takePhoto(request) {
    const attempt = this.takeAttempt();
    const still = this.script.still;
    const calledAt = this.now();
    await sleep(still.exposeAtMs);
    const exposedAt = this.now();
    const k = this.current();
    const blob = this.blobs[k];
    const index = this.stills.length;
    this.stillThumbs[index] = await thumbnailOf(blob);
    const remaining = still.latencyMs - (this.now() - calledAt);
    if (remaining > 0) await sleep(remaining);
    const frame = this.frames[k];
    this.stills.push({
      index,
      attempt,
      calledAt,
      exposedAt,
      doneAt: this.now(),
      request,
      k,
      width: this.script.frame.width,
      height: this.script.frame.height,
      bytes: blob.size,
      labelled: frame?.labelled ?? false,
      quad: frame?.quad ?? null,
      corners: frame?.corners ?? null,
    });
    return blob;
  }
}
