#!/usr/bin/env node
/**
 * Real media, for the bench — found, extracted and listed, never copied into
 * the repository and never sent anywhere.
 *
 * Real media is located **only** through `SCAN_REAL_MEDIA` (a directory
 * outside this repository). From it the bench takes:
 *
 *  - **stills**: `*.jpg` / `*.jpeg` in the directory itself, in `pii_free/`
 *    and in `capture-issue/`. They are served to the bench page byte for byte
 *    (`/real/stills/…`, an allowlist of exactly these files) and decoded there
 *    the way the app decodes a photo;
 *  - **videos**: `*.mp4` in `pii_free/` and `capture-issue/` — except a screen
 *    recording, which films the app's own screen (its overlay, its chips), not
 *    a camera's view of a page, and is never detector input.
 *
 * Each video is decoded once, by the system `ffmpeg` (which applies the clip's
 * rotation), into the cache (`${XDG_CACHE_HOME:-~/.cache}/scan-bench/frames/`):
 *
 *  - `replay/` — {@link REPLAY_FPS} fps, {@link REPLAY_LONG_EDGE} px long edge:
 *    what the session player streams into the real `<ScanFlow>`, and what the
 *    per-frame detector pass reads;
 *  - `sparse/` — every {@link SPARSE_STRIDE}th replay frame (≈ 0.5 s apart) at
 *    {@link SPARSE_LONG_EDGE} px (a 1080p preview frame): the frames people
 *    label and the detector-level evaluation scores.
 *
 * A clip is re-extracted only when its source (size, mtime) or these settings
 * change. `node scripts/bench/real.mjs` extracts and prints what it found.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyLabels, frameId, stillId, validateLabels } from "./labels.mjs";
import { isInside, realFramesDir, realMediaDir, ROOT } from "./paths.mjs";

/** Frames per second of the replay stream. */
export const REPLAY_FPS = 15;

/** Long edge of a replay frame, px. */
export const REPLAY_LONG_EDGE = 1080;

/** Every this many replay frames, one sparse (labelled) frame: 8 / 15 fps ≈ 0.53 s. */
export const SPARSE_STRIDE = 8;

/** Long edge of a sparse frame, px — a 1080p preview frame. */
export const SPARSE_LONG_EDGE = 1920;

/** JPEG quality of extracted frames (ffmpeg's `-q:v`, 2 best … 31 worst). */
const FRAME_QSCALE = 3;

/** Bump when the extraction changes in a way the settings above do not show. */
const EXTRACTION_VERSION = 1;

const STILL_DIRS = ["", "pii_free", "capture-issue"];
const VIDEO_DIRS = ["pii_free", "capture-issue"];

/** A screen recording shows the app, not the page: never detector input. */
export const SCREEN_RECORDING = /screen[\s_-]*record/i;

/** The directory named by `SCAN_REAL_MEDIA`, checked; throws with the reason when unusable. */
export function requireRealMedia() {
  const dir = realMediaDir();
  if (dir === null) {
    throw new Error("the real-media suites need SCAN_REAL_MEDIA=<directory of real photos and clips>");
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`SCAN_REAL_MEDIA=${dir} is not a directory`);
  if (isInside(dir, ROOT) || isInside(ROOT, dir)) {
    throw new Error(`SCAN_REAL_MEDIA=${dir} overlaps this repository; real media never lives here`);
  }
  return dir;
}

function listFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * What `SCAN_REAL_MEDIA` holds that the bench may use: `{ stills, videos,
 * skipped }`, each entry `{ id, rel, file, group }`; `skipped` names what was
 * deliberately left out and why.
 */
export function discoverRealMedia(mediaDir) {
  const stills = [];
  const videos = [];
  const skipped = [];
  for (const sub of STILL_DIRS) {
    for (const name of listFiles(join(mediaDir, sub))) {
      if (!/\.jpe?g$/i.test(name)) continue;
      const rel = sub === "" ? name : `${sub}/${name}`;
      stills.push({ id: stillId(rel), rel, file: join(mediaDir, rel), group: sub === "" ? "root" : sub });
    }
  }
  for (const sub of VIDEO_DIRS) {
    for (const name of listFiles(join(mediaDir, sub))) {
      if (!/\.mp4$/i.test(name)) continue;
      const rel = `${sub}/${name}`;
      if (SCREEN_RECORDING.test(name)) {
        skipped.push({ rel, reason: "a screen recording (the app's screen, not a camera view)" });
        continue;
      }
      videos.push({ id: stillId(rel), rel, file: join(mediaDir, rel), group: sub });
    }
  }
  return { stills, videos, skipped };
}

/** A clip's directory name in the cache: its path, flattened. */
export function clipKey(rel) {
  return rel.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "__");
}

function ffprobe(file) {
  const out = execFileSync(
    "ffprobe",
    [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name,avg_frame_rate:stream_side_data=rotation:format=duration",
      "-of", "json", file,
    ],
    { encoding: "utf8" },
  );
  const info = JSON.parse(out);
  const stream = info.streams?.[0] ?? {};
  const rotation = Number(stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0);
  const [num, den] = String(stream.avg_frame_rate ?? "0/1").split("/").map(Number);
  const quarter = ((Math.round(rotation / 90) % 4) + 4) % 4;
  const upright = quarter % 2 === 1 ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
  return {
    codec: stream.codec_name ?? null,
    width: stream.width,
    height: stream.height,
    rotation,
    upright,
    sourceFps: den > 0 ? num / den : null,
    duration: Number(info.format?.duration ?? 0),
  };
}

/** `WxH` for a long edge, keeping the upright aspect, even dimensions. */
export function scaledSize({ width, height }, longEdge) {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  const even = (v) => Math.max(2, 2 * Math.round((v * scale) / 2));
  return { width: even(width), height: even(height) };
}

function framesOf(dir, prefix) {
  return listFiles(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".jpg")).length;
}

/**
 * Decode one clip into the cache, unless an extraction with the same source
 * and settings is already there. Answers the clip's manifest entry.
 */
function extractClip(video, framesRoot, log) {
  const source = statSync(video.file);
  const settings = {
    version: EXTRACTION_VERSION,
    replayFps: REPLAY_FPS,
    replayLongEdge: REPLAY_LONG_EDGE,
    sparseStride: SPARSE_STRIDE,
    sparseLongEdge: SPARSE_LONG_EDGE,
    qscale: FRAME_QSCALE,
    sourceSize: source.size,
    sourceMtimeMs: Math.round(source.mtimeMs),
  };
  const key = clipKey(video.rel);
  const dir = join(framesRoot, key);
  const infoFile = join(dir, "clip.json");
  if (existsSync(infoFile)) {
    try {
      const previous = JSON.parse(readFileSync(infoFile, "utf8"));
      if (JSON.stringify(previous.settings) === JSON.stringify(settings)) return previous;
    } catch {
      // Unreadable: extract again.
    }
  }
  const probe = ffprobe(video.file);
  const replay = scaledSize(probe.upright, REPLAY_LONG_EDGE);
  const sparse = scaledSize(probe.upright, SPARSE_LONG_EDGE);
  const staging = `${dir}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "replay"), { recursive: true });
  mkdirSync(join(staging, "sparse"), { recursive: true });
  log(`real: extracting ${video.rel} (${probe.width}×${probe.height} ${probe.codec}, rotation ${probe.rotation}°, ${probe.duration.toFixed(1)} s) → ${REPLAY_FPS} fps`);
  const started = Date.now();
  // One decode, two outputs. ffmpeg applies the display rotation before the
  // filter graph, so `fps` and `scale` see the upright picture; `select` then
  // keeps every SPARSE_STRIDE-th frame of the already-resampled stream, so
  // sparse frame j is replay frame j × SPARSE_STRIDE, at a higher resolution.
  const graph =
    `[0:v]fps=${REPLAY_FPS},split=2[a][b];` +
    `[a]scale=${replay.width}:${replay.height}:flags=lanczos[r];` +
    `[b]select='not(mod(n\\,${SPARSE_STRIDE}))',scale=${sparse.width}:${sparse.height}:flags=lanczos[s]`;
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", video.file,
      "-filter_complex", graph,
      "-map", "[r]", "-fps_mode", "passthrough", "-q:v", String(FRAME_QSCALE), "-start_number", "0",
      join(staging, "replay", "f%05d.jpg"),
      "-map", "[s]", "-fps_mode", "passthrough", "-q:v", String(FRAME_QSCALE), "-start_number", "0",
      join(staging, "sparse", "s%05d.jpg"),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`ffmpeg failed on ${video.rel}: ${(result.stderr || result.error?.message || "").slice(0, 400)}`);
  }
  const replayFrames = framesOf(join(staging, "replay"), "f");
  const sparseFrames = framesOf(join(staging, "sparse"), "s");
  const info = {
    id: video.id,
    rel: video.rel,
    key,
    group: video.group,
    settings,
    probe,
    fps: REPLAY_FPS,
    replay: { width: replay.width, height: replay.height, frames: replayFrames },
    sparse: { width: sparse.width, height: sparse.height, frames: sparseFrames, stride: SPARSE_STRIDE },
    extractedAt: new Date().toISOString(),
    extractMs: Date.now() - started,
  };
  writeFileSync(join(staging, "clip.json"), JSON.stringify(info, null, 1));
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  log(`real: ${video.rel}: ${replayFrames} replay + ${sparseFrames} sparse frames in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return info;
}

/**
 * Discover, extract whatever is stale, and write the frames manifest. Answers
 * `{ media, stills, clips, skipped }`.
 *
 * With `clips: false` nothing is decoded — the stills need no ffmpeg — and
 * `clips` is whatever an earlier extraction left in the cache. A clip that
 * cannot be decoded (no ffmpeg, a broken file) is skipped with its reason
 * rather than taking every other clip and the stills down with it.
 */
export function prepareRealMedia({ log = console.log, clips: extract = true } = {}) {
  const media = requireRealMedia();
  const found = discoverRealMedia(media);
  for (const skip of found.skipped) log(`real: skipping ${skip.rel} — ${skip.reason}`);
  if (!extract) return { media, stills: found.stills, clips: extractedClips(), skipped: found.skipped };
  const framesRoot = realFramesDir();
  if (isInside(framesRoot, ROOT)) throw new Error(`the frames cache ${framesRoot} is inside this repository`);
  mkdirSync(framesRoot, { recursive: true });
  const clips = [];
  const skipped = [...found.skipped];
  for (const video of found.videos) {
    try {
      clips.push(extractClip(video, framesRoot, log));
    } catch (error) {
      const reason = `could not be decoded: ${String(error?.message ?? error).split("\n")[0]}`;
      log(`real: skipping ${video.rel} — ${reason}`);
      skipped.push({ rel: video.rel, reason });
    }
  }
  const manifest = { media, createdAt: new Date().toISOString(), clips: clips.map((c) => c.key) };
  writeFileSync(join(framesRoot, "manifest.json"), JSON.stringify(manifest, null, 1));
  return { media, stills: found.stills, clips, skipped };
}

/** The clips already extracted for this `SCAN_REAL_MEDIA` (no ffmpeg), by the manifest. */
export function extractedClips() {
  const framesRoot = realFramesDir();
  try {
    const manifest = JSON.parse(readFileSync(join(framesRoot, "manifest.json"), "utf8"));
    if (manifest.media !== realMediaDir()) return [];
    return manifest.clips
      .map((key) => {
        try {
          return JSON.parse(readFileSync(join(framesRoot, key, "clip.json"), "utf8"));
        } catch {
          return null;
        }
      })
      .filter((clip) => clip !== null);
  } catch {
    return [];
  }
}

/** URL of a still, by its path inside `SCAN_REAL_MEDIA`: every segment encoded (a name may hold `%`, `#` or `?`). */
export const stillUrl = (rel) => `/real/stills/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** URL of replay frame `k` / sparse frame `j` of a clip, as the bench server serves it. */
export const replayUrl = (clip, k) => `/real/frames/${clip.key}/replay/f${String(k).padStart(5, "0")}.jpg`;
export const sparseUrl = (clip, j) => `/real/frames/${clip.key}/sparse/s${String(j).padStart(5, "0")}.jpg`;

/**
 * Every real image the bench can show or label, in one list — what
 * `/real/items.json` answers: stills first, then each clip's sparse frames.
 * Each `{ id, kind, group, url, clip?, k?, t? }`; `k` is the replay frame index.
 */
export function realItems() {
  const media = realMediaDir();
  if (media === null) return { media: false, items: [], clips: [] };
  const { stills } = discoverRealMedia(media);
  const clips = extractedClips();
  const items = stills.map((s) => ({ id: s.id, kind: "still", group: s.group, url: stillUrl(s.rel) }));
  for (const clip of clips) {
    for (let j = 0; j < clip.sparse.frames; j += 1) {
      const k = j * clip.sparse.stride;
      items.push({
        id: frameId(clip.rel, k, clip.fps),
        kind: "frame",
        group: clip.group,
        clip: clip.key,
        k,
        t: k / clip.fps,
        url: sparseUrl(clip, j),
      });
    }
  }
  return {
    media: true,
    items,
    clips: clips.map((c) => ({
      key: c.key,
      id: c.id,
      rel: c.rel,
      group: c.group,
      fps: c.fps,
      replay: c.replay,
      sparse: c.sparse,
      duration: c.replay.frames / c.fps,
      rotation: c.probe.rotation,
    })),
  };
}

/** The stills the server may hand out, by their path inside `SCAN_REAL_MEDIA`. */
export function stillAllowlist() {
  const media = realMediaDir();
  if (media === null) return new Map();
  return new Map(discoverRealMedia(media).stills.map((s) => [s.rel, s.file]));
}

/** The labels document at `path` (an empty one when absent); throws when it is malformed. */
export function readLabels(path) {
  if (!existsSync(path)) return emptyLabels();
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const problem = validateLabels(doc);
  if (problem !== null) throw new Error(`labels ${path}: ${problem}`);
  return doc;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const prepared = prepareRealMedia();
    console.log(`\nreal media: ${prepared.media}`);
    console.log(`  stills: ${prepared.stills.length} (${[...new Set(prepared.stills.map((s) => s.group))].map((g) => `${g} ${prepared.stills.filter((s) => s.group === g).length}`).join(", ")})`);
    for (const clip of prepared.clips) {
      console.log(
        `  clip ${clip.rel}: ${clip.replay.frames} frames @ ${clip.fps} fps ${clip.replay.width}×${clip.replay.height}, ` +
          `${clip.sparse.frames} sparse @ ${clip.sparse.width}×${clip.sparse.height}`,
      );
    }
    for (const skip of prepared.skipped) console.log(`  skipped ${skip.rel}: ${skip.reason}`);
    console.log(`  frames cache: ${realFramesDir()}`);
  } catch (error) {
    console.error(`real: ${error?.message ?? error}`);
    process.exit(2);
  }
}
