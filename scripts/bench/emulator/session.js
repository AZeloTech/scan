/**
 * Scan sessions: a document being scanned, as a function of time.
 *
 * A session is a **script** — plain JSON, a pure function of `(id, seed)` like
 * every scene — over one scene from a family: where the camera is at every
 * moment (keyframed poses plus handheld tremor), what moves on the desk (a page
 * pulled away and another put down), what comes into view (a thumb), how the
 * light changes, what the fake camera's still pipeline does, and what the
 * scripted user does (tap the shutter at a time, confirm the corners a beat
 * after the confirm screen opens). {@link sessionAt} turns a script and a time
 * into ordinary scene params, so a session frame and its ground truth come out
 * of exactly the code a still scene does.
 *
 * Time is **camera time** in milliseconds: 0 is the moment the app opened the
 * camera. The page (`app/page-session.js`) plays it in real time.
 *
 * Tremor is 1/f noise — a sum of sinusoids between 0.5 and 3 Hz with
 * amplitude falling as 1/√f — scaled to an RMS image displacement given as a
 * fraction of the frame height (0.3–1.5 % in the field), applied as a shift
 * of the aim point plus a little roll.
 *
 * Pure maths, no DOM: the Node runner rebuilds the same script to score a run.
 */

import { rngFor } from "./prng.js";
import { buildScene, groundTruth } from "./scene.js";
import { aimAt, cameraFromPose, inFrame, project, projectRect } from "./camera.js";
import { darkGranite, fabric, framingCamera, lightWood, page, paleTable, partialCamera, rectCentre } from "./kit.js";
import { frameSize } from "./scene.js";
import { SKIN_TONES } from "./effects.js";
import { clipPolygon, polygonArea } from "../metrics.mjs";

const sessions = new Map();

/**
 * @param {{ id: string, title: string, describe: string, inDefault?: boolean, group?: string,
 *   build: (rng: import("./prng.js").Rng, options: { frame: { width: number, height: number }, seed: number }) => object }} session
 *
 * `inDefault: false` keeps a session out of a plain `--suite session` run (it
 * runs when named with `--session`): the long `sustained-hold` measures the
 * app over a minute and more, not the detector over a few seconds.
 *
 * `group` names a set `--session <group>` runs whole: `regression` is the
 * adversarial sessions (whip pans, rushed swaps, flicker, steep tilts, a hand
 * passing, a page sliding, paper lookalikes) the live loop is re-checked on
 * before it changes; `all` is every registered session.
 */
export function registerSession(session) {
  if (sessions.has(session.id)) throw new Error(`session "${session.id}" is already registered`);
  sessions.set(session.id, session);
}

export function sessionIds() {
  return [...sessions.keys()];
}

export function describeSessions() {
  return [...sessions.values()].map(({ id, title, describe, inDefault = true, group = null }) => ({ id, title, describe, inDefault, group }));
}

/* ── looped sessions ────────────────────────────────────────────────────── */

/** The camera's frame interval, ms: sessions play at 30 fps. */
export const SESSION_FRAME_MS = 1000 / 30;

/**
 * Which rendered frame camera frame `n` shows. A session longer than is worth
 * rendering ahead (`sustained-hold`: 75 s) renders `script.loop.frames` frames
 * once and plays them forward and back — a held phone has no direction a
 * replayed second gives away, and its tremor stays continuous at the turns.
 * Without `loop`, frame `n` is rendered frame `n`.
 */
export function loopedFrame(script, n) {
  const count = script.loop?.frames;
  if (!count || count < 2) return n;
  const span = count - 1;
  const m = n % (2 * span);
  return m <= span ? m : 2 * span - m;
}

/**
 * The scene time camera time `t` shows — itself, or for a looped session the
 * same forward-and-back fold {@link loopedFrame} makes of frames, so a still
 * exposed at `t` is a photo of the frame on screen.
 */
export function loopedTime(script, t) {
  const count = script.loop?.frames;
  if (!count || count < 2) return t;
  const span = (count - 1) * SESSION_FRAME_MS;
  const m = t % (2 * span);
  return m <= span ? m : 2 * span - m;
}

/** How many frames a session renders ahead: the whole script, or its loop. */
export function renderedFrameCount(script, tailFrames) {
  return script.loop?.frames ?? Math.ceil(script.duration / SESSION_FRAME_MS) + tailFrames;
}

/* ── the fake camera's still pipeline ───────────────────────────────────── */

/**
 * What `ImageCapture.takePhoto()` does in a session.
 *
 * - `aspect: "preview"` honours the size the app asks for (the app asks at the
 *   preview's shape); `"sensor"` ignores it and returns the whole 4:3 sensor —
 *   the same long-edge field of view as a 16:9 preview crop, a *wider* short
 *   edge: the D-343 RC1 still.
 * - `fovScale` > 1 widens the still further in both directions (a preview
 *   cropped by stabilization, a photo that is not).
 * - `latencyMs` is the shutter-to-photo time a phone's still pipeline takes;
 *   `exposeAtMs` is when, after the call, the photo is actually exposed.
 */
export const DEFAULT_STILL = {
  aspect: "preview",
  fovScale: 1,
  latencyMs: 350,
  exposeAtMs: 90,
  sensor: { width: 4000, height: 3000 },
  quality: 0.92,
};

/**
 * The still for a request, portrait-aware: `{ width, height, focalPixels }`
 * for a preview frame `frame` whose focal length is `previewFocal` pixels.
 * `request` is what the app passed to `takePhoto` (sensor orientation) or
 * nothing.
 */
export function stillGeometry(still, frame, previewFocal, request = null) {
  const portrait = frame.height > frame.width;
  const previewLong = Math.max(frame.width, frame.height);
  const sensorLong = Math.max(still.sensor.width, still.sensor.height);
  const sensorShort = Math.min(still.sensor.width, still.sensor.height);
  let long;
  let short;
  if (still.aspect === "sensor" || request === null) {
    // The whole sensor at the requested long edge (or its own).
    long = request === null ? sensorLong : Math.max(request.imageWidth, request.imageHeight);
    short = Math.round((long * sensorShort) / sensorLong);
  } else {
    long = Math.max(request.imageWidth, request.imageHeight);
    short = Math.min(request.imageWidth, request.imageHeight);
  }
  // Same lens: the long edges span the same angle as the preview's (a 16:9
  // preview is a crop of the 4:3 sensor's short edge), then `fovScale` wider.
  const focalPixels = (previewFocal * long) / previewLong / still.fovScale;
  return {
    width: portrait ? short : long,
    height: portrait ? long : short,
    focalPixels,
  };
}

/* ── keyframes ──────────────────────────────────────────────────────────── */

const DEG = Math.PI / 180;

function smootherstep(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Where a key list is at `t`, as the two keys around it and the eased fraction between them. */
function bracket(keys, t) {
  if (t <= keys[0].t) return [keys[0], keys[0], 0];
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (t < keys[i + 1].t) {
      const span = keys[i + 1].t - keys[i].t;
      return [keys[i], keys[i + 1], span > 0 ? smootherstep((t - keys[i].t) / span) : 1];
    }
  }
  const last = keys[keys.length - 1];
  return [last, last, 0];
}

const lerp = (a, b, f) => a + (b - a) * f;

/**
 * A pose between two keyframed poses. The lean (tilt towards an azimuth) is
 * interpolated as a vector — so a camera straightening up does not spin — and
 * the distance geometrically, the way an approach feels.
 */
function lerpPose(a, b, f) {
  const va = [a.tilt * Math.cos(a.azimuth * DEG), a.tilt * Math.sin(a.azimuth * DEG)];
  const vb = [b.tilt * Math.cos(b.azimuth * DEG), b.tilt * Math.sin(b.azimuth * DEG)];
  const v = [lerp(va[0], vb[0], f), lerp(va[1], vb[1], f)];
  return {
    ...a,
    tilt: Math.hypot(v[0], v[1]),
    azimuth: (Math.atan2(v[1], v[0]) / DEG + 360) % 360,
    roll: lerp(a.roll, b.roll, f),
    target: [lerp(a.target[0], b.target[0], f), lerp(a.target[1], b.target[1], f)],
    distance: Math.exp(lerp(Math.log(a.distance), Math.log(b.distance), f)),
  };
}

/* ── tremor ─────────────────────────────────────────────────────────────── */

/** Components of the tremor per axis: log-spaced over the hand's band. */
const TREMOR_BAND = [0.5, 3];
const TREMOR_COMPONENTS = 9;

/** A seeded 1/f tremor: per axis, frequencies, phases and 1/√f weights normalized to unit RMS. */
export function tremorModel(seed) {
  const rng = rngFor("tremor", seed);
  const axes = [0, 1, 2].map(() => {
    const parts = [];
    for (let k = 0; k < TREMOR_COMPONENTS; k += 1) {
      const f =
        TREMOR_BAND[0] * (TREMOR_BAND[1] / TREMOR_BAND[0]) ** ((k + rng.range(0, 1)) / TREMOR_COMPONENTS);
      parts.push({ f, phase: rng.range(0, Math.PI * 2), w: 1 / Math.sqrt(f) });
    }
    // Unit RMS: a sum of sinusoids has RMS √(Σ w²/2).
    const rms = Math.sqrt(parts.reduce((s, p) => s + (p.w * p.w) / 2, 0));
    return parts.map((p) => ({ ...p, w: p.w / rms }));
  });
  return { seed, axes };
}

/** The unit-RMS tremor signal on each axis (x, y, roll) at `t` ms. */
export function tremorAt(model, t) {
  const seconds = t / 1000;
  return model.axes.map((parts) =>
    parts.reduce((sum, p) => sum + p.w * Math.sin(2 * Math.PI * p.f * seconds + p.phase), 0),
  );
}

/* ── a script at one instant ────────────────────────────────────────────── */

/** The keyframed amplitude of the tremor at `t` (fraction of the frame height, RMS). */
function amplitudeAt(keys, t) {
  const [a, b, f] = bracket(keys, t);
  return lerp(a.amplitude, b.amplitude, f);
}

/** The camera pose at `t`: keyframes, the scripted user following "Aproxime" ({@link followHint}), then the hand's tremor on top. */
export function poseAt(script, t) {
  const pose = followedPose(script, t, keyedPose(script, t));
  const amplitude = amplitudeAt(script.tremor.keys, t);
  if (amplitude <= 0) return pose;
  const [nx, ny, nr] = tremorAt(script.tremor.model, t);
  const focal = cameraFromPose(pose, script.frame).f;
  // An image shift of `amplitude` × frame height, as a shift of the aim on the desk.
  const mm = (amplitude * script.frame.height * pose.distance) / focal;
  return {
    ...pose,
    target: [pose.target[0] + nx * mm, pose.target[1] + ny * mm],
    roll: pose.roll + nr * amplitude * 40,
  };
}

/** The keyframed pose at `t`, before the user's own corrections and the tremor. */
function keyedPose(script, t) {
  const [a, b, f] = bracket(script.camera, t);
  return lerpPose(a.pose, b.pose, f);
}

/* ── the scripted user frames the page, and follows "Aproxime" ──────────── */

/**
 * The app's "too far" line, which the scripted user follows (`--follow`):
 * `fill` is the app's rule now (`FILL_ENTER` / `FILL_EXIT`, `src/lib/guidance.ts`
 * — the page's reach along the view's limiting axis); `area` the rule before
 * it (`AREA_ENTER` / `AREA_EXIT`: its share of the view's area). Mirrored
 * here because the emulator is plain JS; `session.test.mjs` holds the `fill`
 * numbers to the source.
 */
export const FOLLOW_RULES = {
  fill: { kind: "fill", enter: 0.7, exit: 0.75 },
  area: { kind: "area", enter: 0.14, exit: 0.17 },
};

/** The rule a run follows unless `--follow` says otherwise: the app's own. */
export const DEFAULT_FOLLOW = FOLLOW_RULES.fill;

/**
 * How much of the view a person fills with the page when nothing asks for
 * more (`fill`): the owner's field run on a Galaxy S25 Ultra under the old
 * area rule put two pages across 54 % and 45 % of the still's 9:16 crop —
 * 66 % and 55 % of the narrower visible region.
 */
export const NATURAL_FILL = [0.55, 0.72];

/**
 * `--follow fill|area|off|fill:ENTER:EXIT|area:ENTER:EXIT` as a rule, or null
 * (`off`: the scripted user holds where the script says, whatever the hint).
 */
export function parseFollow(text) {
  if (text === undefined || text === null || text === "") return DEFAULT_FOLLOW;
  if (text === "off") return null;
  // `…@E`: an imperfect person, who aims the page off the middle by up to E of the view (each axis).
  const [ruleText, aimText] = text.split("@");
  const aimError = aimText === undefined ? 0 : Number(aimText);
  if (!(aimError >= 0 && aimError < 0.3)) throw new Error(`--follow ${text}: expected an aim error 0 ≤ E < 0.3 after @`);
  const withAim = (rule) => (aimError > 0 ? { ...rule, aimError } : rule);
  const [kind, enter, exit] = ruleText.split(":");
  const base = FOLLOW_RULES[kind];
  if (base === undefined) throw new Error(`--follow ${text}: expected fill, area or off (optionally kind:enter:exit, and @aim-error)`);
  if (enter === undefined) return withAim(base);
  const rule = { kind, enter: Number(enter), exit: Number(exit ?? enter) };
  if (!(rule.enter > 0 && rule.exit >= rule.enter && rule.exit < 1)) throw new Error(`--follow ${text}: expected 0 < enter <= exit < 1`);
  return withAim(rule);
}

/** A rule's measure of a page (`points`: its corners in fractions of the visible region): its fill (bounding box, clipped) or its clipped area. */
export function framingMeasure(kind, points) {
  if (kind === "area") {
    const inside = clipPolygon(points, [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    return inside.length >= 3 ? polygonArea(inside) : 0;
  }
  const clip = (v) => Math.min(1, Math.max(0, v));
  const xs = points.map(([x]) => clip(x));
  const ys = points.map(([, y]) => clip(y));
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/** Where a layer's corners fall from `pose`, in fractions of `region` (frame fractions). */
function inRegion(pose, frame, layer, region) {
  const camera = cameraFromPose(pose, frame);
  return projectRect(camera, layer).map((p) => [(p.u / frame.width - region.x) / region.width, (p.v / frame.height - region.y) / region.height]);
}

/** "Until the end" in a follow segment, as plain JSON (Infinity is not). */
const FOREVER = 1e9;

/** The natural framing settles over this long before a hold starts (the camera is still arriving). */
const NATURAL_RAMP_MS = 600;

/**
 * The scripted user keeps the page's corners at least this far (share of the
 * view) from its edge, over and above the tremor's swings: between
 * "Afaste um pouco"'s enter and exit lines (`BORDER_ENTER` / `BORDER_EXIT`).
 */
const FOLLOW_EDGE = 0.02;

/** How far into an approach the user is at `t`: 0 before it, 1 while there, eased in between. */
function followProgress(segment, t) {
  if (t <= segment.reactAt || t >= segment.releaseTo) return 0;
  if (t < segment.arriveAt) return smootherstep((t - segment.reactAt) / (segment.arriveAt - segment.reactAt));
  if (t <= segment.releaseFrom) return 1;
  return 1 - smootherstep((t - segment.releaseFrom) / (segment.releaseTo - segment.releaseFrom));
}

/** The natural framing's distance scale at `t` (log-interpolated between its keys; 1 before the first). */
function naturalScaleAt(keys, t) {
  if (keys.length === 0 || t <= keys[0].t) return 1;
  const [a, b, f] = bracket(keys, t);
  return Math.exp(lerp(Math.log(a.scale), Math.log(b.scale), f));
}

/** The middle of a layer's outline from `pose`, in pixels (what a person centres on screen). */
function outlineMiddle(pose, frame, layer) {
  const pts = projectRect(cameraFromPose(pose, frame), layer);
  const us = pts.map((p) => p.u);
  const vs = pts.map((p) => p.v);
  return [(Math.min(...us) + Math.max(...us)) / 2, (Math.min(...vs) + Math.max(...vs)) / 2];
}

/**
 * A pose `progress` of the way to the user's corrected one: `scale`^progress
 * the distance, and the page's outline moved that far towards the middle of
 * `region` — what the person frames in (people centre what they see, not the
 * page's own middle).
 */
function correctedPose(pose, frame, layer, region, scale, progress) {
  if (progress <= 0) return pose;
  const centre = rectCentre(layer);
  const start = outlineMiddle(pose, frame, layer);
  const goal = [(region.x + region.width / 2) * frame.width, (region.y + region.height / 2) * frame.height];
  const want = [lerp(start[0], goal[0], progress), lerp(start[1], goal[1], progress)];
  const scaled = { ...pose, distance: pose.distance * scale ** progress };
  const at = project(cameraFromPose(pose, frame), centre);
  let pixel = [at.u + want[0] - start[0], at.v + want[1] - start[1]];
  let out = aimAt(scaled, frame, centre, pixel);
  for (let i = 0; i < 3; i += 1) {
    const middle = outlineMiddle(out, frame, layer);
    if (Math.hypot(want[0] - middle[0], want[1] - middle[1]) < 0.5) break;
    pixel = [pixel[0] + want[0] - middle[0], pixel[1] + want[1] - middle[1]];
    out = aimAt(scaled, frame, centre, pixel);
  }
  return out;
}

/** The keyed pose at `t` at the user's own framing (`script.follow.natural`). */
function naturalPose(script, t, pose) {
  const keys = script.follow?.natural ?? [];
  const scale = naturalScaleAt(keys, t);
  return scale === 1 ? pose : { ...pose, distance: pose.distance * scale };
}

/** The keyed pose with the user's framing and corrections at `t` applied (`script.follow`). */
function followedPose(script, t, keyed) {
  const follow = script.follow;
  if (follow === undefined || follow === null) return keyed;
  const pose = naturalPose(script, t, keyed);
  for (const segment of follow.segments) {
    const progress = followProgress(segment, t);
    if (progress <= 0) continue;
    const layer = layerAt(script.scene.layers[segment.layer], segment.layer, script, t);
    return correctedPose(pose, script.frame, layer, segment.aim ?? follow.aim ?? follow.region, segment.scale, progress);
  }
  return pose;
}

/**
 * The scripted user frames a page as people do, and follows the app's
 * "Aproxime" as people do.
 *
 * **Their own framing.** In every framed hold (`marks.ready` windows, else
 * `holdFrom…holdTo` and `lockFrom2…holdTo2`; a session with neither but
 * `marks.stable` — a page returned to again and again, `whip-off-auto` —
 * holds from each of those) the page is held at the size people hold it
 * at when nothing asks for more ({@link NATURAL_FILL}, seeded per hold —
 * the script's own distance scaled to it, settling over the
 * {@link NATURAL_RAMP_MS} before the hold, easing between holds, kept after
 * the last; never so close that a corner crowds the edge).
 *
 * **Following the hint.** A hold whose page the app would call too far
 * (`rule`, measured in the app's visible `region` at the hold's start —
 * under its exit line: a page that came in from afar arrives with the hint
 * already up, and it stays up until the exit line) gets an approach: the hint comes up (the lock, then its 300 ms), the person
 * reacts (0.7–1.2 s after the hold starts, all told) and comes in over
 * 0.7–1.2 s, re-centring the page, until it is a little past the line the
 * hint clears at (exit × 1.02–1.08: the hint lags the move, so people
 * overshoot) — or, with a shaking hand, as close as its swings leave the
 * corners clear of the edge — and holds there; between two holds they ease
 * back (the next page is elsewhere). A practised user (the `stable` holds)
 * is there from the moment the page arrives.
 *
 * The marks move with the user: a ready window and a `stable` moment inside
 * an approach start where it ends; `marks.follow` records each approach for
 * the scorer. Under a rule no natural framing breaks (`area`, before) there
 * is no approach — the hint never asks.
 */
export function followHint(script, rule, region) {
  if (rule === null || rule === undefined) return script;
  const marks = script.marks ?? {};
  const view = region ?? script.frame.view ?? { x: 0, y: 0, width: 1, height: 1 };
  // Where the person centres the page: the part of the screen they frame in
  // (below the hint, above the controls), else the app's region.
  const aim = script.frame.view ?? view;
  const frame = script.frame;
  const windows =
    (marks.ready ?? []).length > 0
      ? marks.ready.map((w) => ({ from: w.from, to: w.to }))
      : [
          ...(marks.holdFrom !== undefined && marks.holdTo !== undefined ? [{ from: marks.holdFrom, to: marks.holdTo }] : []),
          ...(marks.lockFrom2 !== undefined && marks.holdTo2 !== undefined ? [{ from: marks.lockFrom2, to: marks.holdTo2 }] : []),
        ];
  const practised = windows.length === 0 && (marks.stable ?? []).length > 0 && marks.pageless !== true;
  const spans = practised ? practisedSpans(script, marks.stable) : windows.sort((a, b) => a.from - b.from);
  if (spans.length === 0) return script;
  const roomAt = (t) => {
    // A shaking hand keeps its distance: the corners stay clear of the
    // cut-off line by the tremor's swings (2 × its RMS) on each axis.
    const peak = 2 * amplitudeAt(script.tremor.keys, t);
    return [FOLLOW_EDGE + (peak * frame.height) / (view.width * frame.width), FOLLOW_EDGE + peak / view.height];
  };
  const roomy = (points, room) => points.every(([x, y]) => x >= room[0] && x <= 1 - room[0] && y >= room[1] && y <= 1 - room[1]);
  // Bisect a distance scale on [0.25, 4] for the boundary of `closerOk`
  // (true for every scale at or above the answer).
  const boundary = (closerOk) => {
    let lo = Math.log(0.25);
    let hi = Math.log(4);
    if (closerOk(Math.exp(lo))) return Math.exp(lo);
    if (!closerOk(Math.exp(hi))) return Math.exp(hi);
    for (let i = 0; i < 40; i += 1) {
      const mid = (lo + hi) / 2;
      if (closerOk(Math.exp(mid))) hi = mid;
      else lo = mid;
    }
    return Math.exp(hi);
  };
  // 1. The user's own framing of each hold.
  const natural = [];
  const pages = spans.map((span, index) => {
    const pageIndex = pageLayerIndex(script, primaryAt(script, span.from));
    if (pageIndex === null) return null;
    const layer = layerAt(script.scene.layers[pageIndex], pageIndex, script, span.from);
    const keyed = keyedPose(script, span.from);
    const scripted = framingMeasure("fill", inRegion(keyed, frame, layer, view));
    const rng = rngFor("frame", script.id, script.seed, index);
    const want = rng.range(NATURAL_FILL[0], NATURAL_FILL[1]);
    const room = roomAt(span.from);
    const fillAt = (scale) => framingMeasure("fill", inRegion({ ...keyed, distance: keyed.distance * scale }, frame, layer, view));
    // The farthest scale that still fills `want`, kept back to where the corners have room.
    const toWant = boundary((scale) => fillAt(scale) <= want);
    const toRoom = boundary((scale) => roomy(inRegion({ ...keyed, distance: keyed.distance * scale }, frame, layer, view), room));
    const scale = Math.max(toWant, toRoom);
    natural.push({ t: Math.max(0, span.from - NATURAL_RAMP_MS), scale }, { t: span.to, scale });
    return { pageIndex, layer, scripted, want, scale };
  });
  natural.sort((a, b) => a.t - b.t);
  const withNatural = { ...script, follow: { rule, region: view, aim, natural, segments: [] } };
  // 2. Following the hint, from that framing.
  const segments = [];
  const record = [];
  spans.forEach((span, index) => {
    const page = pages[index];
    if (page === null) return;
    const { pageIndex, layer } = page;
    const pose = naturalPose(withNatural, span.from, keyedPose(script, span.from));
    const before = framingMeasure(rule.kind, inRegion(pose, frame, layer, view));
    const rng = rngFor("follow", script.id, script.seed, index);
    const overshoot = rule.kind === "fill" ? rng.range(1.02, 1.08) : rng.range(1.1, 1.3);
    const reactAt = practised ? span.from - 250 : span.from + rng.range(700, 1200);
    const arriveAt = practised ? span.from : reactAt + rng.range(700, 1200);
    const base = { from: span.from, to: span.to, page: pageIndex, scripted: page.scripted, natural: framingMeasure("fill", inRegion(pose, frame, layer, view)), before };
    if (before >= rule.exit || (!practised && arriveAt >= span.to)) {
      record.push({ ...base, approached: false });
      return;
    }
    const target = rule.kind === "fill" ? Math.min(0.92, rule.exit * overshoot) : rule.exit * overshoot;
    // An imperfect person (`rule.aimError`) re-centres on a point off the middle, per hold.
    const err = rule.aimError ?? 0;
    const holdAim =
      err > 0
        ? { ...aim, x: aim.x + rng.range(-err, err) * aim.width, y: aim.y + rng.range(-err, err) * aim.height }
        : aim;
    const pointsAt = (scale) => inRegion(correctedPose(pose, frame, layer, holdAim, scale, 1), frame, layer, view);
    const measureAt = (scale) => framingMeasure(rule.kind, pointsAt(scale));
    const room = roomAt(arriveAt);
    const scale = Math.min(1, Math.max(boundary((k) => measureAt(k) <= target), boundary((k) => roomy(pointsAt(k), room))));
    if (measureAt(scale) <= before + 0.01) {
      record.push({ ...base, approached: false });
      return;
    }
    const next = spans[index + 1];
    const releaseFrom = practised ? span.leaveAt : next === undefined ? FOREVER : span.to;
    const releaseTo = practised ? span.leaveAt + 200 : next === undefined ? FOREVER : Math.max(span.to + 1, next.from - 1);
    segments.push({ layer: pageIndex, reactAt, arriveAt, releaseFrom, releaseTo, scale, ...(holdAim === aim ? {} : { aim: holdAim }) });
    record.push({ ...base, approached: true, reactAt, arriveAt, target, after: measureAt(scale), practised });
  });
  const moved = (t) => {
    const r = record.find((f) => f.approached && !f.practised && t >= f.from && t < f.arriveAt);
    return r === undefined ? t : r.arriveAt;
  };
  return {
    ...script,
    follow: { rule, region: view, aim, natural, segments },
    marks: {
      ...marks,
      follow: record,
      ...(marks.ready === undefined ? {} : { ready: marks.ready.map((w) => ({ ...w, from: moved(w.from) })) }),
      ...(marks.stable === undefined ? {} : { stable: marks.stable.map(moved) }),
    },
  };
}

/** The layer index of the scene's `page`-th page (its document layers in order), or null. */
function pageLayerIndex(script, page) {
  let seen = -1;
  for (let i = 0; i < script.scene.layers.length; i += 1) {
    if (script.scene.layers[i].document === undefined) continue;
    seen += 1;
    if (seen === page) return i;
  }
  return null;
}

/** A practised user's spans: from each `stable` moment to when the camera next leaves that pose. */
function practisedSpans(script, stable) {
  return stable.map((from) => {
    const keys = script.camera;
    const at = keys.findIndex((k) => k.t >= from);
    let leaveAt = keys[keys.length - 1].t;
    if (at >= 0) {
      for (let i = at; i < keys.length - 1; i += 1) {
        if (keys[i + 1].pose !== keys[at].pose) {
          leaveAt = keys[i].t;
          break;
        }
      }
    }
    return { from, to: leaveAt, leaveAt };
  });
}

/** A layer's centre and rotation at `t`, when the script moves it. */
function layerAt(layer, index, script, t) {
  const motion = script.layerMotion.find((m) => m.layer === index);
  if (motion === undefined) return layer;
  const [a, b, f] = bracket(motion.keys, t);
  return {
    ...layer,
    center: [lerp(a.center[0], b.center[0], f), lerp(a.center[1], b.center[1], f)],
    rotation: lerp(a.rotation, b.rotation, f),
  };
}

function lightingAt(script, t) {
  const base = script.scene.lighting;
  if (script.light.length === 0) return base;
  const [a, b, f] = bracket(script.light, t);
  return {
    ...base,
    exposure: base.exposure * lerp(a.exposure, b.exposure, f),
    gradient: { ...base.gradient, amount: base.gradient.amount + lerp(a.gradient, b.gradient, f) },
  };
}

/** The thumb, if it is in the frame at `t`: a finger effect in this frame's pixels. */
function fingerAt(script, t, camera) {
  const finger = script.finger;
  if (finger === null || t < finger.enterAt || t > finger.leaveAt) return null;
  const inFor = Math.min(t - finger.enterAt, finger.leaveAt - t);
  // Sliding in from outside: everything travels along the thumb's own axis.
  const away = 1 - smootherstep(inFor / finger.slideMs);
  const out = [finger.knuckleWorld[0] - finger.tipWorld[0], finger.knuckleWorld[1] - finger.tipWorld[1]];
  const at = (p, lift) => [p[0] + out[0] * away * 1.5, p[1] + out[1] * away * 1.5, -(finger.heightMm + lift)];
  const tip = project(camera, at(finger.tipWorld, 0));
  const knuckle = project(camera, at(finger.knuckleWorld, 10));
  const hand = project(camera, at(finger.handWorld, 30));
  if (tip.depth <= 0 || knuckle.depth <= 0 || hand.depth <= 0) return null;
  const width = (finger.widthMm * camera.f) / tip.depth;
  return {
    type: "finger",
    base: [knuckle.u, knuckle.v],
    tip: [tip.u, tip.v],
    width,
    hand: { to: [hand.u, hand.v], width: (finger.widthMm * 2.9 * camera.f) / hand.depth },
    skin: finger.skin,
    blur: Math.max(1.5, width / 30),
    shadow: { dx: width * 0.2, dy: width * 0.35, blur: width * 0.35, alpha: 0.35 },
  };
}

/**
 * The scene params at camera time `t` — ordinary params: the renderer and
 * {@link groundTruth} take them as they take a still scene's. `frame`
 * overrides the frame (a still), with `focalPixels` for its lens.
 */
export function sessionAt(script, t, { frame = script.frame, focalPixels } = {}) {
  const pose = poseAt(script, t);
  const camera = focalPixels === undefined ? pose : { ...pose, focalPixels };
  const layers = script.scene.layers.map((layer, index) => layerAt(layer, index, script, t));
  const params = {
    ...script.scene,
    frame,
    camera,
    shake: [],
    layers,
    lighting: lightingAt(script, t),
    effects: [],
    primaryPage: primaryAt(script, t),
    post: {
      ...script.scene.post,
      // Sensor noise is new every frame.
      noise: { ...script.scene.post.noise, seed: (script.scene.post.noise.seed + Math.floor(t / 33)) >>> 0 },
      jpeg: null,
    },
  };
  const view = cameraFromPose(camera, frame);
  // `finger` is the thumb most sessions script; `fingers` more of them (a hand
  // reaching in, then again from another side).
  params.effects = [script.finger, ...(script.fingers ?? [])]
    .map((finger) => fingerAt({ finger }, t, view))
    .filter((effect) => effect !== null);
  const glares = glareAt(script, t);
  if (glares.length > 0) params.blobs = [...(script.scene.blobs ?? []), ...glares];
  return params;
}

/**
 * A lamp's hot spot on the page at `t` (`script.glare`: `{ from, to, fadeMs,
 * blob }` windows, the blob in screen pixels as `kit.glare` makes them),
 * faded in and out over `fadeMs` — the phone tilting into and out of the
 * reflection.
 */
function glareAt(script, t) {
  return (script.glare ?? [])
    .filter((g) => t >= g.from && t <= g.to)
    .map((g) => {
      const fade = g.fadeMs > 0 ? smootherstep(Math.min(t - g.from, g.to - t) / g.fadeMs) : 1;
      return { ...g.blob, strength: g.blob.strength * fade };
    })
    .filter((blob) => blob.strength > 0.01);
}

/** Which page (index among the scene's pages) the scan is about at `t`. */
export function primaryAt(script, t) {
  let current = script.primary[0].page;
  for (const step of script.primary) if (t >= step.t) current = step.page;
  return current;
}

/**
 * The truth at `t`: the primary page's corners (normalized) — or `null` when
 * no part of it is in the frame — plus how much of it is inside the frame and
 * whether all four corners are.
 */
export function sessionTruth(script, t, options = {}) {
  const params = sessionAt(script, t, options);
  const gt = groundTruth(params);
  if (gt.primary === null) return { quad: null, inFrameShare: 0, whole: false, pages: 0 };
  const pageTruth = gt.pages[gt.primary];
  const { width, height } = params.frame;
  const inside = clipPolygon(pageTruth.polygon, [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ]);
  const area = polygonArea(pageTruth.polygon);
  const inFrameShare = area > 0 && inside.length >= 3 ? polygonArea(inside) / area : 0;
  return {
    quad: inFrameShare > 0.02 ? pageTruth.corners : null,
    corners: pageTruth.corners,
    inFrameShare,
    whole: pageTruth.inFrame.every(Boolean),
    visible: pageTruth.visible,
    coverage: pageTruth.coverage,
    pages: gt.pages.length,
  };
}

/* ── building a script ──────────────────────────────────────────────────── */

/** Build a session's script. Deterministic in (id, seed, size, family). */
export function buildSession(id, seed, options = {}) {
  const session = sessions.get(id);
  if (session === undefined) {
    throw new Error(`unknown session "${id}" (known: ${sessionIds().join(", ")})`);
  }
  const rng = rngFor("session", id, seed);
  // `view`: the part of the frame the layout under test shows (frame
  // fractions) — the scripted user frames the page in it, as a person aims
  // by the screen (`--frame-by screen`). Without it, the whole frame.
  // A measured view carries the app's whole visible region alongside
  // (`region`, untrimmed): what the app judges "Aproxime" in.
  const { region: viewRegion = null, ...viewRect } = options.view ?? {};
  const size = options.view ? { ...frameSize(options.size ?? "portrait"), view: viewRect } : (options.size ?? "portrait");
  // `family` overrides the scene family a session would pick (the playground's choice).
  // `follow` / `region`: the rule the user answers to and where the app
  // judges it — a session built around the "too far" line (`hover-far`)
  // swings across the line under test.
  const follow = options.follow === undefined ? DEFAULT_FOLLOW : options.follow;
  const region = options.region ?? viewRegion;
  const built = session.build(rng, { seed, size, family: options.family ?? null, follow, region });
  const script = {
    id,
    seed,
    title: session.title,
    layerMotion: [],
    light: [],
    finger: null,
    primary: [{ t: 0, page: 0 }],
    still: { ...DEFAULT_STILL },
    permission: "prompt",
    ...built,
  };
  script.frame = script.scene.frame;
  script.tremor = { model: tremorModel(rng.fork("tremor").seed32()), keys: built.tremor };
  script.still = { ...DEFAULT_STILL, ...(built.still ?? {}) };
  // The user follows "Aproxime" (`options.follow`: a rule, null to hold where
  // the script says; absent, the app's own), judged in the app's visible
  // region (`options.region`; absent, the part of the frame the user frames in).
  return followHint(script, follow, region);
}

/** A pose the user starts from: farther, leaning more, aimed off to one side. */
function farPose(rng, rest, { distance = [1.7, 2.3], lean = [8, 18], off = [60, 140] } = {}) {
  const bearing = rng.range(0, Math.PI * 2);
  const reach = rng.range(off[0], off[1]);
  return {
    ...rest,
    distance: rest.distance * rng.range(distance[0], distance[1]),
    tilt: Math.min(40, rest.tilt + rng.range(lean[0], lean[1])),
    roll: rest.roll + rng.range(-10, 10),
    target: [rest.target[0] + Math.cos(bearing) * reach, rest.target[1] + Math.sin(bearing) * reach],
  };
}

/**
 * The same pose, backed off until the page clears the frame edge by
 * `margin` × the frame's short side — room for the session's tremor, so a
 * page that is meant to be whole stays whole.
 */
function withMargin(pose, frame, layer, margin) {
  const px = margin * Math.min(frame.width, frame.height);
  // Framed by the screen, backing off keeps the page where the person had it
  // on screen (backing off along the axis would slide it to the frame's centre).
  const centre = frame.view ? rectCentre(layer) : null;
  const at = centre === null ? null : project(cameraFromPose(pose, frame), centre);
  let out = pose;
  for (let step = 0; step < 80; step += 1) {
    const camera = cameraFromPose(out, frame);
    if (projectRect(camera, layer).every((p) => inFrame(camera, p, px))) return out;
    out = { ...out, distance: out.distance * 1.02 };
    if (at !== null) out = aimAt(out, frame, centre, [at.u, at.v]);
  }
  return out;
}

/** The page layer of a scene (the last document layer) and its index. */
function pageOf(scene) {
  for (let i = scene.layers.length - 1; i >= 0; i -= 1) {
    if (scene.layers[i].document !== undefined) return { layer: scene.layers[i], index: i };
  }
  return null;
}

/**
 * A thumb resting on the page: its tip just inside a corner or an edge, the
 * base knuckle 65 mm out and the hand beyond, all in desk mm.
 */
function thumbOn(rng, pageLayer) {
  const half = [pageLayer.size[0] / 2, pageLayer.size[1] / 2];
  const a = ((pageLayer.rotation ?? 0) * Math.PI) / 180;
  const toWorld = ([x, y]) => [
    pageLayer.center[0] + Math.cos(a) * x - Math.sin(a) * y,
    pageLayer.center[1] + Math.sin(a) * x + Math.cos(a) * y,
  ];
  const onEdge = rng.chance(0.5);
  const corner = [rng.pick([-1, 1]), rng.pick([-1, 1])];
  const local = onEdge
    ? [corner[0] * half[0] * rng.range(0.2, 0.7), corner[1] * half[1]]
    : [corner[0] * half[0], corner[1] * half[1]];
  const outward = onEdge ? [0, corner[1]] : [corner[0] * 0.7, corner[1] * 0.7];
  const turn = rng.range(-0.4, 0.4);
  const out = [
    Math.cos(turn) * outward[0] - Math.sin(turn) * outward[1],
    Math.sin(turn) * outward[0] + Math.cos(turn) * outward[1],
  ];
  const along = (d) => [local[0] + out[0] * d, local[1] + out[1] * d];
  return {
    tipWorld: toWorld(along(-4)),
    knuckleWorld: toWorld(along(62)),
    handWorld: toWorld(along(200)),
    widthMm: rng.range(16, 20),
    heightMm: pageLayer.height + 6,
    skin: rng.pick(SKIN_TONES),
  };
}

/** The confirm step every capture ends with: the user looks for a moment, then accepts. */
const CONFIRM_AFTER_MS = 1100;

registerSession({
  id: "approach-hold",
  title: "approach, settle, hold, shoot",
  describe:
    "the camera opens aimed off to one side from twice the distance, comes in over 2 s, settles and holds with a light tremor; the shutter is tapped 3.5 s into the hold (F1 scenes on odd seeds, F2 on even)",
  build(rng, { seed, size, family }) {
    const scene = buildScene(family ?? (seed % 2 === 1 ? "F1" : "F2"), seed, { size });
    const rest = withMargin(scene.camera, scene.frame, pageOf(scene).layer, 0.04);
    scene.camera = rest;
    const far = farPose(rng.fork("far"), rest);
    return {
      scene,
      duration: 9500,
      camera: [
        { t: 0, pose: far },
        { t: 600, pose: far },
        { t: 2700, pose: rest },
      ],
      tremor: [
        { t: 0, amplitude: 0.012 },
        { t: 2700, amplitude: 0.005 },
        { t: 3200, amplitude: 0.004 },
      ],
      actions: [{ at: 6500, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: { lockFrom: 2700, holdFrom: 2700, holdTo: 6450, tapAt: 6500 },
    };
  },
});

registerSession({
  id: "tremor-hold",
  title: "shaky hold, a thumb, the light changes",
  describe:
    "framed from the start with a strong handheld tremor (1.2 % RMS); a thumb comes in to hold the page at 2 s; the light drops by 40 % at 4.5 s; shutter at 6.5 s",
  build(rng, { seed, size, family }) {
    const scene = buildScene(family ?? (seed % 2 === 1 ? "F1" : "F3"), seed, { size });
    const found = pageOf(scene);
    // A 1.2 % tremor swings the page by several per cent: leave it the room.
    scene.camera = withMargin(scene.camera, scene.frame, found.layer, 0.09);
    const finger = { ...thumbOn(rng.fork("thumb"), found.layer), enterAt: 2000, leaveAt: 1e9, slideMs: 450 };
    return {
      scene,
      duration: 9000,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [
        { t: 0, amplitude: 0.012 },
        { t: 5000, amplitude: 0.012 },
        { t: 5600, amplitude: 0.008 },
      ],
      finger,
      light: [
        { t: 0, exposure: 1, gradient: 0 },
        { t: 4500, exposure: 1, gradient: 0 },
        { t: 4900, exposure: 0.6, gradient: 0.15 },
      ],
      actions: [{ at: 6500, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: { lockFrom: 0, holdFrom: 800, holdTo: 6450, tapAt: 6500, fingerAt: 2000, lightAt: 4500 },
    };
  },
});

registerSession({
  id: "page-swap",
  title: "one page out, another in",
  describe:
    "hold on a page, then it is slid out of the frame and a different document is slid in and put down elsewhere (re-aiming over it if the held camera cannot see it whole); the shutter is tapped on the new page",
  build(rng, { seed, size, family }) {
    const scene = buildScene(family ?? (seed % 2 === 1 ? "F1" : "F2"), seed, { size });
    const found = pageOf(scene);
    const first = found.layer;
    scene.camera = withMargin(scene.camera, scene.frame, first, 0.04);
    const layout = rng.fork("swap");
    const type = layout.pick(["form", "letter", "lab-report", "receipt"]);
    const second = page(rng.fork("second"), {
      type,
      rotation: first.rotation + layout.pick([-1, 1]) * layout.range(6, 15),
      height: first.height - 0.1,
    });
    // Put down clearly elsewhere — shifted by an eighth to a third of the page —
    // but wholly in view of the camera that is still held over the first.
    const held = cameraFromPose(scene.camera, scene.frame);
    const margin = 0.03 * Math.min(scene.frame.width, scene.frame.height);
    const fits = (camera, center) => projectRect(camera, { ...second, center }).every((p) => inFrame(camera, p, margin));
    let rest = null;
    for (let attempt = 0; attempt < 60 && rest === null; attempt += 1) {
      const shift = layout.range(0.12, 0.33) * Math.min(...first.size);
      const bearing = layout.range(0, Math.PI * 2);
      const candidate = [first.center[0] + Math.cos(bearing) * shift, first.center[1] + Math.sin(bearing) * shift];
      if (fits(held, candidate)) rest = candidate;
    }
    // Nowhere to put it that the held camera sees whole: put it down anyway and
    // re-aim — over the new page, backing off until it fits.
    let reaim = null;
    if (rest === null) {
      const shift = 0.2 * Math.min(...first.size);
      const bearing = layout.range(0, Math.PI * 2);
      rest = [first.center[0] + Math.cos(bearing) * shift, first.center[1] + Math.sin(bearing) * shift];
      reaim = { ...scene.camera, target: [...rest] };
      for (let step = 0; step < 100 && !fits(cameraFromPose(reaim, scene.frame), rest); step += 1) {
        reaim = { ...reaim, distance: reaim.distance * 1.03 };
      }
    }
    const outA = layout.range(0, Math.PI * 2);
    const outB = outA + Math.PI * layout.range(0.6, 1.4);
    const away = 520;
    second.center = [rest[0] + Math.cos(outB) * away, rest[1] + Math.sin(outB) * away];
    scene.layers.push(second);
    const secondIndex = scene.layers.length - 1;
    const far = farPose(rng.fork("far"), scene.camera, { distance: [1.3, 1.6], off: [30, 70] });
    const settled = reaim === null ? 6500 : 7400;
    return {
      scene,
      duration: 13000,
      camera: [
        { t: 0, pose: far },
        { t: 1600, pose: scene.camera },
        ...(reaim === null ? [] : [{ t: 6500, pose: scene.camera }, { t: 7400, pose: reaim }]),
      ],
      tremor: [{ t: 0, amplitude: 0.006 }],
      layerMotion: [
        {
          layer: found.index,
          keys: [
            { t: 0, center: first.center, rotation: first.rotation },
            { t: 5000, center: first.center, rotation: first.rotation },
            {
              t: 5700,
              center: [first.center[0] + Math.cos(outA) * away, first.center[1] + Math.sin(outA) * away],
              rotation: first.rotation + 8,
            },
          ],
        },
        {
          layer: secondIndex,
          keys: [
            { t: 0, center: second.center, rotation: second.rotation - 10 },
            { t: 5700, center: second.center, rotation: second.rotation - 10 },
            { t: 6500, center: rest, rotation: second.rotation },
          ],
        },
      ],
      primary: [
        { t: 0, page: 0 },
        { t: 5700, page: 1 },
      ],
      actions: [{ at: 10500, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        lockFrom: 1600,
        holdFrom: 1600,
        holdTo: 4950,
        swapAt: 5000,
        swapDoneAt: 6500,
        lockFrom2: settled,
        holdTo2: 10450,
        tapAt: 10500,
        ...(reaim === null ? {} : { reaimAt: 6500 }),
      },
    };
  },
});

registerSession({
  id: "empty-desk-sweep",
  title: "sweeping an empty desk",
  describe:
    "no document anywhere: the camera wanders over an F6 desk (a laptop, a notebook, a place mat, a keyboard, a phone) for 10 s; the shutter is tapped at 8.5 s anyway",
  build(rng, { seed, size }) {
    const scene = buildScene("F6", seed, { size });
    const sweep = rng.fork("sweep");
    const start = scene.camera;
    const keys = [{ t: 0, pose: start }];
    for (let k = 1; k <= 4; k += 1) {
      keys.push({
        t: k * 2300,
        pose: {
          ...start,
          target: [start.target[0] + sweep.range(-160, 160), start.target[1] + sweep.range(-160, 160)],
          distance: start.distance * sweep.range(0.75, 1.25),
          tilt: sweep.range(0, 25),
          azimuth: sweep.range(0, 360),
          roll: start.roll + sweep.range(-12, 12),
        },
      });
    }
    return {
      scene,
      duration: 10000,
      camera: keys,
      tremor: [{ t: 0, amplitude: 0.008 }],
      primary: [{ t: 0, page: 0 }],
      actions: [{ at: 8500, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: { negativeFrom: 0, negativeTo: 8450, tapAt: 8500 },
    };
  },
});

registerSession({
  id: "partial-frame",
  title: "too close, then backing off",
  describe:
    "the page is cut off by the frame (1-2 corners outside) for 5 s and the shutter is tapped there; after confirming, the user backs off until the whole page is in view, holds, and shoots again",
  build(rng, { seed, size, family }) {
    const scene = buildScene(family ?? (seed % 2 === 1 ? "F1" : "F2"), seed, { size });
    const found = pageOf(scene);
    scene.camera = withMargin(scene.camera, scene.frame, found.layer, 0.04);
    const cut = rng.fork("cut");
    const close = partialCamera(cut, scene.frame, found.layer, {
      coverage: cut.range(0.45, 0.7),
      cut: cut.chance(0.5) ? 1 : 2,
    });
    return {
      scene,
      duration: 13500,
      camera: [
        { t: 0, pose: close },
        { t: 5600, pose: close },
        { t: 7200, pose: scene.camera },
      ],
      tremor: [
        { t: 0, amplitude: 0.005 },
        { t: 5600, amplitude: 0.01 },
        { t: 7200, amplitude: 0.004 },
      ],
      actions: [
        { at: 3500, tap: "shutter" },
        { confirmAfterMs: CONFIRM_AFTER_MS },
        { at: 11000, tap: "shutter" },
        { confirmAfterMs: CONFIRM_AFTER_MS },
      ],
      marks: { partialFrom: 500, partialTo: 3450, lockFrom: 7200, holdFrom: 7200, holdTo: 10950, tapAt: 3500, tapAt2: 11000 },
    };
  },
});

registerSession({
  id: "wider-still",
  title: "the still is wider than the preview (D-343 RC1)",
  describe:
    "approach-hold, but the fake ImageCapture ignores the requested size and returns the whole 4:3 sensor — a wider field of view than the 16:9 preview the user framed",
  build(rng, { seed, size, family }) {
    const base = sessions.get("approach-hold").build(rng, { seed, size, family });
    return { ...base, still: { aspect: "sensor", fovScale: 1 } };
  },
});

registerSession({
  id: "wider-still-eis",
  title: "the still is wider, same shape (stabilization crop)",
  describe:
    "approach-hold, but the still comes back at the preview's shape with a 25 % wider field of view — the preview was cropped by stabilization, the photo was not — so it passes the app's shape check",
  build(rng, { seed, size, family }) {
    const base = sessions.get("approach-hold").build(rng, { seed, size, family });
    return { ...base, still: { aspect: "preview", fovScale: 1.25 } };
  },
});

registerSession({
  id: "sustained-hold",
  title: "a long hold: 75 s, three pages, then the flow remounted",
  inDefault: false,
  describe:
    "framed from the start with a light tremor and held for 75 s (10 s of frames played forward and back); the shutter at 20, 40 and 60 s, each confirmed — then the page unmounts and remounts the flow three times, to count what outlives it (F1 scenes on odd seeds, F2 on even)",
  build(rng, { seed, size, family }) {
    const scene = buildScene(family ?? (seed % 2 === 1 ? "F1" : "F2"), seed, { size });
    scene.camera = withMargin(scene.camera, scene.frame, pageOf(scene).layer, 0.05);
    return {
      scene,
      duration: 75000,
      loop: { frames: 300 },
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.005 }],
      actions: [
        { at: 20000, tap: "shutter" },
        { confirmAfterMs: CONFIRM_AFTER_MS },
        { at: 40000, tap: "shutter" },
        { confirmAfterMs: CONFIRM_AFTER_MS },
        { at: 60000, tap: "shutter" },
        { confirmAfterMs: CONFIRM_AFTER_MS },
      ],
      marks: { lockFrom: 0, holdFrom: 1000, holdTo: 19950, tapAt: 20000, sustainedFrom: 0, sustainedTo: 75000 },
      remounts: 3,
    };
  },
});

/**
 * Not a scan: a still, page-less desk the bench opens the flow on to measure
 * what the layout under test shows of the frame (`--frame-by screen`) before
 * it builds the sessions that frame a page in it.
 */
registerSession({
  id: "view-probe",
  title: "measure the visible region",
  inDefault: false,
  describe: "an empty desk, held still for a moment: the runner reads the layout's visible region and the controls over it",
  build(rng, { seed, size }) {
    const scene = buildScene("F6", seed, { size });
    return {
      scene,
      duration: 6000,
      loop: { frames: 2 },
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0 }],
      actions: [],
      marks: {},
    };
  },
});

/* ── adversarial sessions (named with --session; not in a plain run) ────── */

/*
 * Built to make the live loop look bad: motion faster than its cadence, pages
 * that change under it, light that jumps, steep angles, hands, a page that
 * moves while the camera does not, and white things on a desk that are not
 * paper. Besides the usual marks each carries `marks.windows` — named
 * `[from, to]` spans of camera time an outside scorer judges the overlay on —
 * `marks.events` (named moments the overlay should let go of the old page at)
 * and `marks.locks` (named moments a new lock is owed from).
 */

/** Where a layer can lie (its centre, `shift` × its short side from `from` at some bearing) wholly in a camera's view. */
function placeInView(rng, frame, pose, layer, from, { shift = [0.12, 0.33], margin = 0.03 } = {}) {
  const camera = cameraFromPose(pose, frame);
  const px = margin * Math.min(frame.width, frame.height);
  const fits = (center) => projectRect(camera, { ...layer, center }).every((p) => inFrame(camera, p, px));
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const reach = rng.range(shift[0], shift[1]) * Math.min(...layer.size);
    const bearing = rng.range(0, Math.PI * 2);
    const center = [from[0] + Math.cos(bearing) * reach, from[1] + Math.sin(bearing) * reach];
    if (fits(center)) return center;
  }
  return null;
}

/**
 * A hand reaching over a page from outside it: fingertip `reach` × the page's
 * short side in from one edge, knuckle and palm out beyond that edge.
 */
function handOver(rng, pageLayer, { reach = [0.15, 0.35] } = {}) {
  const half = [pageLayer.size[0] / 2, pageLayer.size[1] / 2];
  const a = ((pageLayer.rotation ?? 0) * Math.PI) / 180;
  const toWorld = ([x, y]) => [
    pageLayer.center[0] + Math.cos(a) * x - Math.sin(a) * y,
    pageLayer.center[1] + Math.sin(a) * x + Math.cos(a) * y,
  ];
  const side = rng.pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
  const along = rng.range(-0.5, 0.5);
  const edge = side[0] !== 0 ? [side[0] * half[0], along * half[1]] : [along * half[0], side[1] * half[1]];
  const turn = rng.range(-0.35, 0.35);
  const out = [Math.cos(turn) * side[0] - Math.sin(turn) * side[1], Math.sin(turn) * side[0] + Math.cos(turn) * side[1]];
  const depth = rng.range(reach[0], reach[1]) * Math.min(...pageLayer.size);
  const at = (d) => [edge[0] + out[0] * d, edge[1] + out[1] * d];
  return {
    tipWorld: toWorld(at(-depth)),
    knuckleWorld: toWorld(at(-depth + 62)),
    handWorld: toWorld(at(-depth + 200)),
    widthMm: rng.range(17, 21),
    heightMm: pageLayer.height + 25,
    skin: rng.pick(SKIN_TONES),
  };
}

/** A page scene framed with room to spare, for the sessions that move things inside a held frame. */
function roomyScene(seed, size, family, margin) {
  const scene = buildScene(family ?? (seed % 2 === 1 ? "F1" : "F2"), seed, { size });
  const found = pageOf(scene);
  scene.camera = withMargin(scene.camera, scene.frame, found.layer, margin);
  return { scene, found };
}

registerSession({
  id: "fast-pan",
  title: "whip pans off the page and back",
  inDefault: false,
  group: "regression",
  describe:
    "framed and held; at 1.6 s the camera whips off the page in 250 ms (the page leaves the frame), stays off 1 s, whips back in 300 ms; at 5 s a fast half-pan puts half the page out for 0.7 s and comes back; shutter at 7.5 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = roomyScene(seed, size, family, 0.06);
    const rest = scene.camera;
    const pan = rng.fork("pan");
    const bearing = pan.range(0, Math.PI * 2);
    const away = Math.max(...found.layer.size) * pan.range(1.8, 2.3);
    const off = { ...rest, target: [rest.target[0] + Math.cos(bearing) * away, rest.target[1] + Math.sin(bearing) * away] };
    const half = Math.min(...found.layer.size) * pan.range(0.45, 0.6);
    const bearing2 = bearing + Math.PI * pan.range(0.5, 1.5);
    const halfOff = { ...rest, target: [rest.target[0] + Math.cos(bearing2) * half, rest.target[1] + Math.sin(bearing2) * half] };
    return {
      scene,
      duration: 8600,
      camera: [
        { t: 0, pose: rest },
        { t: 1600, pose: rest },
        { t: 1850, pose: off },
        { t: 2850, pose: off },
        { t: 3150, pose: rest },
        { t: 5000, pose: rest },
        { t: 5200, pose: halfOff },
        { t: 5900, pose: halfOff },
        { t: 6100, pose: rest },
      ],
      tremor: [{ t: 0, amplitude: 0.005 }],
      actions: [{ at: 7500, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        lockFrom: 0,
        holdFrom: 800,
        holdTo: 1550,
        panAt: 1600,
        backAt: 3150,
        halfAt: 5000,
        tapAt: 7500,
        windows: [
          { name: "hold", from: 800, to: 1550 },
          { name: "off page", from: 1900, to: 2800 },
          { name: "after whip back", from: 3150, to: 4950 },
          { name: "half off", from: 5250, to: 5850 },
          { name: "after half pan", from: 6100, to: 7450 },
        ],
        events: [
          { name: "whip off", at: 1600, to: 2800 },
          { name: "half pan", at: 5000, to: 5850 },
        ],
        locks: [
          { name: "after whip back", from: 3150 },
          { name: "after half pan", from: 6100 },
        ],
        negatives: [{ name: "off page", from: 1900, to: 2800 }],
      },
    };
  },
});

registerSession({
  id: "swap-rush",
  title: "three pages in four seconds",
  inDefault: false,
  group: "regression",
  describe:
    "held over a page; at 1.8 s it is slid away and a second document slid in (600 ms); at 3.6 s that one is slid away and the first put back down somewhere else, turned (600 ms); shutter at 6.2 s on the third placement",
  build(rng, { seed, size, family }) {
    const { scene, found } = roomyScene(seed, size, family, 0.14);
    const first = found.layer;
    const layout = rng.fork("rush");
    const second = page(rng.fork("second"), {
      type: layout.pick(["form", "letter", "lab-report"]),
      rotation: first.rotation + layout.pick([-1, 1]) * layout.range(6, 15),
      height: first.height - 0.1,
    });
    const restB = placeInView(layout, scene.frame, scene.camera, second, first.center) ?? [...first.center];
    const turnA = layout.pick([-1, 1]) * layout.range(8, 20);
    const restA = placeInView(layout, scene.frame, scene.camera, { ...first, rotation: first.rotation + turnA }, first.center) ?? [...first.center];
    const away = 520;
    const outA = layout.range(0, Math.PI * 2);
    const inB = outA + Math.PI * layout.range(0.6, 1.4);
    const outB = inB + Math.PI * layout.range(0.6, 1.4);
    const inA = outB + Math.PI * layout.range(0.6, 1.4);
    const far = (c, b) => [c[0] + Math.cos(b) * away, c[1] + Math.sin(b) * away];
    scene.layers.push({ ...second, center: far(restB, inB) });
    const secondIndex = scene.layers.length - 1;
    return {
      scene,
      duration: 7300,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.005 }],
      layerMotion: [
        {
          layer: found.index,
          keys: [
            { t: 0, center: first.center, rotation: first.rotation },
            { t: 1800, center: first.center, rotation: first.rotation },
            { t: 2200, center: far(first.center, outA), rotation: first.rotation + 8 },
            { t: 3600, center: far(restA, inA), rotation: first.rotation + turnA - 8 },
            { t: 4200, center: restA, rotation: first.rotation + turnA },
          ],
        },
        {
          layer: secondIndex,
          keys: [
            { t: 0, center: far(restB, inB), rotation: second.rotation - 10 },
            { t: 1800, center: far(restB, inB), rotation: second.rotation - 10 },
            { t: 2400, center: restB, rotation: second.rotation },
            { t: 3600, center: restB, rotation: second.rotation },
            { t: 4000, center: far(restB, outB), rotation: second.rotation + 8 },
          ],
        },
      ],
      primary: [
        { t: 0, page: 0 },
        { t: 2000, page: 1 },
        { t: 3800, page: 0 },
      ],
      actions: [{ at: 6200, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        lockFrom: 0,
        holdFrom: 800,
        holdTo: 1750,
        swapAt: 1800,
        lockFrom2: 2400,
        holdTo2: 3550,
        swap2At: 3600,
        lock3At: 4200,
        tapAt: 6200,
        windows: [
          { name: "page 1", from: 800, to: 1750 },
          { name: "page 2", from: 2400, to: 3550 },
          { name: "page 1 again, moved", from: 4200, to: 6150 },
        ],
        events: [
          { name: "swap 1", at: 1800, to: 3550 },
          { name: "swap 2", at: 3600, to: 6150 },
        ],
        locks: [
          { name: "page 2", from: 2400 },
          { name: "page 1 moved", from: 4200 },
        ],
      },
    };
  },
});

registerSession({
  id: "light-flicker",
  title: "the light jumps and flickers",
  inDefault: false,
  group: "regression",
  describe:
    "framed and held with a light tremor; the exposure steps to 0.45× at 1.5 s, to 1.6× (paper clipping) at 2.3 s, to 0.5× at 2.9 s, back at 3.4 s; from 4 s to 6 s it flickers between 0.6× and 1.35× every 120–220 ms (auto-exposure hunting, a failing tube) with the light's gradient swinging; shutter at 6.8 s",
  build(rng, { seed, size, family }) {
    const scene = buildScene(family ?? (seed % 2 === 1 ? "F1" : "F3"), seed, { size });
    scene.camera = withMargin(scene.camera, scene.frame, pageOf(scene).layer, 0.05);
    const flick = rng.fork("flicker");
    // [at, exposure, gradient]: each level holds until the next, which it
    // jumps to within a frame.
    const plan = [
      [1500, 0.45, 0.1],
      [2300, 1.6, -0.05],
      [2900, 0.5, 0.2],
      [3400, 1, 0],
    ];
    let high = true;
    for (let t = 4000; t < 6000; t += flick.range(120, 220)) {
      plan.push([t, high ? flick.range(1.2, 1.35) : flick.range(0.6, 0.7), flick.range(-0.1, 0.25)]);
      high = !high;
    }
    plan.push([6000, 1, 0]);
    const light = [{ t: 0, exposure: 1, gradient: 0 }];
    for (const [at, exposure, gradient] of plan) {
      const held = light[light.length - 1];
      light.push({ t: at, exposure: held.exposure, gradient: held.gradient }, { t: at + 33, exposure, gradient });
    }
    return {
      scene,
      duration: 7800,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.004 }],
      light,
      actions: [{ at: 6800, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        lockFrom: 0,
        holdFrom: 800,
        holdTo: 6750,
        jumpsAt: 1500,
        flickerAt: 4000,
        tapAt: 6800,
        windows: [
          { name: "steady", from: 800, to: 1450 },
          { name: "exposure jumps", from: 1500, to: 3950 },
          { name: "flicker", from: 4000, to: 6000 },
          { name: "after", from: 6000, to: 6750 },
        ],
        events: [],
        locks: [{ name: "after the flicker", from: 6000 }],
      },
    };
  },
});

registerSession({
  id: "steep-tilt",
  title: "tilted to a steep angle and back",
  inDefault: false,
  group: "regression",
  describe:
    "framed flat and held; at 1.5 s the phone tilts to 45–55° over 1 s (the page a strong trapezoid, backed off only as far as keeps it in frame), holds there and taps the shutter at the slant at 4.5 s; tilts back from 6.5 s, holds, shoots again at 10.5 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = roomyScene(seed, size, family, 0.05);
    const rest = scene.camera;
    const lean = rng.fork("lean");
    const steep = withMargin(
      { ...rest, tilt: lean.range(45, 55), azimuth: lean.range(0, 360), roll: rest.roll + lean.range(-8, 8) },
      scene.frame,
      found.layer,
      0.02,
    );
    return {
      scene,
      duration: 11600,
      camera: [
        { t: 0, pose: rest },
        { t: 1500, pose: rest },
        { t: 2500, pose: steep },
        { t: 6500, pose: steep },
        { t: 7500, pose: rest },
      ],
      tremor: [{ t: 0, amplitude: 0.005 }],
      actions: [
        { at: 4500, tap: "shutter" },
        { confirmAfterMs: CONFIRM_AFTER_MS },
        { at: 10500, tap: "shutter" },
        { confirmAfterMs: CONFIRM_AFTER_MS },
      ],
      marks: {
        lockFrom: 0,
        holdFrom: 800,
        holdTo: 1450,
        tiltAt: 1500,
        steepAt: 2500,
        tapAt: 4500,
        backAt: 6500,
        tapAt2: 10500,
        windows: [
          { name: "flat", from: 800, to: 1450 },
          { name: "tilting", from: 1500, to: 2500 },
          { name: "steep", from: 2500, to: 4450 },
          { name: "tilting back", from: 6500, to: 7500 },
          { name: "flat again", from: 7500, to: 10450 },
        ],
        events: [],
        locks: [
          { name: "steep", from: 2500 },
          { name: "flat again", from: 7500 },
        ],
      },
    };
  },
});

registerSession({
  id: "hand-pass",
  title: "a hand reaches in, leaves, reaches in again",
  inDefault: false,
  group: "regression",
  describe:
    "framed and held; a hand reaches over the page from one side at 1.5 s (fingertip well inside the page) and leaves at 3 s; another reaches in from a different side at 4.5 s, rests a second and leaves at 5.8 s; shutter at 7.2 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = roomyScene(seed, size, family, 0.08);
    const one = handOver(rng.fork("hand-1"), found.layer);
    let two = handOver(rng.fork("hand-2"), found.layer);
    for (let k = 3; k < 12 && Math.hypot(two.tipWorld[0] - one.tipWorld[0], two.tipWorld[1] - one.tipWorld[1]) < 60; k += 1) {
      two = handOver(rng.fork(`hand-${k}`), found.layer);
    }
    return {
      scene,
      duration: 8300,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.005 }],
      fingers: [
        { ...one, enterAt: 1500, leaveAt: 3000, slideMs: 350 },
        { ...two, enterAt: 4500, leaveAt: 5800, slideMs: 350 },
      ],
      actions: [{ at: 7200, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        lockFrom: 0,
        holdFrom: 800,
        holdTo: 7150,
        handAt: 1500,
        hand2At: 4500,
        tapAt: 7200,
        windows: [
          { name: "before", from: 800, to: 1450 },
          { name: "hand 1", from: 1500, to: 3000 },
          { name: "between", from: 3000, to: 4450 },
          { name: "hand 2", from: 4500, to: 5800 },
          { name: "after", from: 5800, to: 7150 },
        ],
        events: [],
        locks: [
          { name: "after hand 1", from: 3000 },
          { name: "after hand 2", from: 5800 },
        ],
      },
    };
  },
});

registerSession({
  id: "slide-across",
  title: "a page slid across the desk under a still camera",
  inDefault: false,
  group: "regression",
  describe:
    "the camera is held still over the desk; the page starts half out of the frame, is slid (turning 12°) to the middle over 2.5 s from 1 s, rests 2 s, is slid again quickly (0.8 s) to another spot in view, rests; shutter at 8.5 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = roomyScene(seed, size, family, 0.15);
    const layer = found.layer;
    const slide = rng.fork("slide");
    const bearing = slide.range(0, Math.PI * 2);
    const turn = slide.pick([-1, 1]) * 12;
    // Out along the bearing until two corners have left the frame, then a
    // little further: the page starts about half out.
    const held = cameraFromPose(scene.camera, scene.frame);
    const outside = (center) =>
      projectRect(held, { ...layer, center, rotation: layer.rotation - turn }).filter((p) => !inFrame(held, p)).length;
    let reach = 0;
    const along = (d) => [layer.center[0] + Math.cos(bearing) * d, layer.center[1] + Math.sin(bearing) * d];
    while (reach < 2000 && outside(along(reach)) < 2) reach += 5;
    const start = along(reach + Math.min(...layer.size) * 0.2);
    const mid = layer.center;
    const second = { ...layer, rotation: layer.rotation + turn - 6 };
    const end = placeInView(slide, scene.frame, scene.camera, second, mid, { shift: [0.2, 0.4] }) ??
      placeInView(slide, scene.frame, scene.camera, second, mid, { shift: [0.06, 0.15] }) ?? [...mid];
    return {
      scene,
      duration: 9600,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.004 }],
      layerMotion: [
        {
          layer: found.index,
          keys: [
            { t: 0, center: start, rotation: layer.rotation - turn },
            { t: 1000, center: start, rotation: layer.rotation - turn },
            { t: 3500, center: mid, rotation: layer.rotation },
            { t: 5500, center: mid, rotation: layer.rotation },
            { t: 6300, center: end, rotation: second.rotation },
          ],
        },
      ],
      actions: [{ at: 8500, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        partialFrom: 100,
        partialTo: 950,
        lockFrom: 3500,
        holdFrom: 3500,
        holdTo: 5450,
        slideAt: 1000,
        slide2At: 5500,
        tapAt: 8500,
        windows: [
          { name: "half out", from: 100, to: 950 },
          { name: "sliding", from: 1000, to: 3500 },
          { name: "rest 1", from: 3500, to: 5450 },
          { name: "quick slide", from: 5500, to: 6300 },
          { name: "rest 2", from: 6300, to: 8450 },
        ],
        events: [{ name: "quick slide", at: 5500, to: 8450 }],
        locks: [
          { name: "rest 1", from: 3500 },
          { name: "rest 2", from: 6300 },
        ],
      },
    };
  },
});

/** A prop layer (as `kit.js` makes them): a material over a rounded rectangle with a height and a shadow. */
function prop(name, material, { center, rotation, size, radius, height, shadowStrength, softness = 0.3 }) {
  return { name, material, center, size, rotation, radius, height, shadowHeight: height, shadowStrength, softness };
}

/** White and cream things that are page-sized rectangles and not paper. */
function lookalikes(rng) {
  const white = () => rng.pick(["#ecebe6", "#f1f0ec", "#e6e5e0", "#efece4"]);
  return [
    prop("laptop", {
      material: "laptop",
      body: rng.pick(["#e3e2de", "#ecebe7", "#dcdbd6"]),
      brushing: rng.range(0.02, 0.05),
      keys: "#e8e8e6",
      open: false,
      seed: rng.seed32(),
    }, { center: [0, 0], rotation: 0, size: rng.pick([[304, 212], [325, 225]]), radius: rng.range(6, 10), height: 16, shadowStrength: rng.range(0.35, 0.5) }),
    prop("placemat", {
      material: "placemat",
      straw: rng.pick(["#e8e4da", "#efece4", "#e2ddd0"]),
      strand: rng.range(2.5, 4),
      binding: white(),
      bindingWidth: rng.range(0, 8),
      contrast: rng.range(0.15, 0.35),
      seed: rng.seed32(),
    }, { center: [0, 0], rotation: 0, size: [rng.range(400, 450), rng.range(290, 330)], radius: rng.range(3, 12), height: 2, shadowStrength: rng.range(0.2, 0.3) }),
    prop("box", {
      material: "laminate",
      color: white(),
      mottle: rng.range(0.02, 0.05),
      speckle: rng.range(0, 0.05),
      streak: 0,
      streakAngle: 0,
      sheen: rng.range(0, 0.04),
      seed: rng.seed32(),
    }, { center: [0, 0], rotation: 0, size: [rng.range(210, 240), rng.range(290, 330)], radius: rng.range(1, 3), height: rng.range(40, 90), shadowStrength: rng.range(0.4, 0.6) }),
    prop("book", {
      material: "notebook",
      cover: rng.pick(["#ece6d8", "#f0ede4", "#e4dccb"]),
      label: rng.chance(0.6),
      binding: rng.pick(["#d8d0c0", "#c9c2b3", "#ece6d8"]),
      spiral: false,
      open: false,
      seed: rng.seed32(),
    }, { center: [0, 0], rotation: 0, size: rng.pick([[155, 230], [170, 240], [140, 210]]), radius: rng.range(1, 3), height: rng.range(15, 35), shadowStrength: rng.range(0.35, 0.5) }),
  ];
}

registerSession({
  id: "paper-lookalikes",
  title: "white things that are not paper",
  inDefault: false,
  group: "regression",
  describe:
    "no document: a closed white laptop, a white place mat, a white box and a cream book on a wood, granite, grey or fabric desk; the camera frames each in turn for 1.8 s (0.6 s between); the shutter is tapped at 10 s over the last",
  build(rng, { seed, size }) {
    const base = buildScene("F6", seed, { size });
    const deskRng = rng.fork("desk");
    const kind = deskRng.pick(["wood", "granite", "grey", "fabric"]);
    const background =
      kind === "wood" ? lightWood(deskRng) : kind === "granite" ? darkGranite(deskRng) : kind === "grey" ? paleTable(deskRng, { grey: true }) : fabric(deskRng);
    const props = lookalikes(rng.fork("props"));
    const shuffle = rng.fork("order");
    const order = [0, 1, 2, 3];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = shuffle.int(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const spots = [[-260, -220], [260, -220], [-260, 230], [260, 230]];
    const placed = props.map((p, i) => ({ ...p, center: spots[i], rotation: rng.range(-25, 25) }));
    const scene = { ...base, setting: "paper-lookalikes", desk: kind, background, layers: placed };
    const cameraRng = rng.fork("camera");
    const keys = [];
    order.forEach((index, i) => {
      const pose = framingCamera(cameraRng, scene.frame, placed[index], { coverage: cameraRng.range(0.3, 0.55), tilt: [0, 20] });
      const arrive = i === 0 ? 0 : i * 2400;
      keys.push({ t: arrive, pose }, { t: arrive + 1800, pose });
    });
    scene.camera = keys[0].pose;
    return {
      scene,
      duration: 10600,
      camera: keys,
      tremor: [{ t: 0, amplitude: 0.006 }],
      primary: [{ t: 0, page: 0 }],
      actions: [{ at: 10000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        negativeFrom: 0,
        negativeTo: 9950,
        tapAt: 10000,
        windows: [],
        events: [],
        locks: [],
        negatives: order.map((index, i) => ({ name: placed[index].name, from: i * 2400 + 300, to: i * 2400 + 1800 })),
      },
    };
  },
});

registerSession({
  id: "sustained-90",
  title: "90 s of use: holds, pans away and back, a tilt, four pages",
  inDefault: false,
  describe:
    "90 s on one page, 15 s of frames played forward and back: a hold, a pan off the page and back, a tilt to 35° and back, a hold; the shutter at 20, 40, 60 and 80 s, each confirmed; then three remounts and a final unmount to count what outlived the flow (F1 on odd seeds, F2 on even)",
  build(rng, { seed, size, family }) {
    const { scene, found } = roomyScene(seed, size, family, 0.06);
    const rest = scene.camera;
    const move = rng.fork("move");
    const bearing = move.range(0, Math.PI * 2);
    const away = Math.max(...found.layer.size) * 1.4;
    const off = { ...rest, target: [rest.target[0] + Math.cos(bearing) * away, rest.target[1] + Math.sin(bearing) * away] };
    const tilted = withMargin({ ...rest, tilt: 35, azimuth: move.range(0, 360) }, scene.frame, found.layer, 0.02);
    return {
      scene,
      duration: 90000,
      loop: { frames: 450 },
      camera: [
        { t: 0, pose: rest },
        { t: 4000, pose: rest },
        { t: 4600, pose: off },
        { t: 6000, pose: off },
        { t: 6600, pose: rest },
        { t: 9000, pose: rest },
        { t: 10000, pose: tilted },
        { t: 11500, pose: tilted },
        { t: 12500, pose: rest },
      ],
      tremor: [{ t: 0, amplitude: 0.005 }],
      actions: [20000, 40000, 60000, 80000].flatMap((at) => [{ at, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }]),
      marks: { lockFrom: 0, holdFrom: 1000, holdTo: 3950, tapAt: 20000, sustainedFrom: 0, sustainedTo: 90000, windows: [], events: [], locks: [] },
      remounts: 3,
    };
  },
});

/* ── guidance sessions (Phase 4: hints, the ready cue, auto-capture) ───── */

/*
 * Each puts the viewfinder in one condition the hint engine names, long
 * enough to judge it, then resolves it and holds still — where the ready cue
 * and, with `autoCapture` (the scripted user turns the toggle on as the
 * camera goes live), an automatic capture are owed. Besides the usual marks:
 *
 * - `marks.hints` — `[{ name, from, to, expect, conditionFrom }]`: over
 *   `[from, to]` the hint shown should be one of `expect` (`null` = none);
 *   `conditionFrom` is when the condition began (time to the first correct
 *   hint is counted from it). Windows open a little after the condition
 *   starts: the app has to see it and a hint has to hold 300 ms to appear.
 * - `marks.ready` — `[{ from, to }]`: the page whole, big enough, lit, still:
 *   where the ready cue is owed (its recall).
 * - `marks.stable` — moments the scene became still with a page framed: an
 *   automatic capture's latency is counted from the last one before it.
 * - `marks.tremor` — `[{ from, to }]`: a trembling hand; no automatic capture
 *   may fire inside.
 * - `marks.pageless` — the whole session has no page: every automatic
 *   capture is a false fire.
 */

/** The hint keys a session expects (the app's probe names them the same). */
const SEARCHING = ["searching", "not-found"];

/** A page scene held still over the page from the start, whole with room to spare. */
function framedScene(seed, size, family, margin = 0.08) {
  return roomyScene(seed, size, family, margin);
}

registerSession({
  id: "too-far",
  title: "the page small in the frame, then closer",
  inDefault: false,
  group: "guidance",
  describe:
    "held still far from the page (it covers 7–10 % of the frame) for 4.5 s; comes in over 1.5 s, holds; auto-capture on; shutter at 9 s (F1 on odd seeds, F2 on even)",
  build(rng, { seed, size, family }) {
    const { scene, found } = framedScene(seed, size, family, 0.06);
    const rest = scene.camera;
    const far = framingCamera(rng.fork("far"), scene.frame, found.layer, { coverage: rng.range(0.07, 0.1), tilt: [0, 12] });
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [
        { t: 0, pose: far },
        { t: 4500, pose: far },
        { t: 6000, pose: rest },
      ],
      tremor: [{ t: 0, amplitude: 0.003 }],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        tapAt: 9000,
        hints: [{ name: "too far", from: 900, to: 4450, expect: ["move-closer"], conditionFrom: 0 }],
        ready: [{ from: 6000, to: 8950 }],
        stable: [6000],
        tremor: [],
      },
    };
  },
});

registerSession({
  id: "cut-off",
  title: "part of the page outside the frame, then backing off",
  inDefault: false,
  group: "guidance",
  describe:
    "held still too close, one or two corners outside the frame, for 4.5 s; backs off over 1.5 s until the page is whole, holds; auto-capture on; shutter at 9 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = framedScene(seed, size, family, 0.06);
    const cut = rng.fork("cut");
    const close = partialCamera(cut, scene.frame, found.layer, { coverage: cut.range(0.5, 0.7), cut: cut.chance(0.5) ? 1 : 2 });
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [
        { t: 0, pose: close },
        { t: 4500, pose: close },
        { t: 6000, pose: scene.camera },
      ],
      tremor: [{ t: 0, amplitude: 0.003 }],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        tapAt: 9000,
        partialFrom: 500,
        partialTo: 4450,
        hints: [{ name: "cut off", from: 900, to: 4450, expect: ["move-back"], conditionFrom: 0 }],
        ready: [{ from: 6000, to: 8950 }],
        stable: [6000],
        tremor: [],
      },
    };
  },
});

registerSession({
  id: "low-light",
  title: "the light goes down on a framed page",
  inDefault: false,
  group: "guidance",
  describe:
    "framed and held still in a dim room (exposure ×0.06–0.1) for 6 s — auto-capture on, and none is owed while the hint is up; the light comes back over 0.5 s and the page is held; shutter at 9.5 s",
  build(rng, { seed, size, family }) {
    const { scene } = framedScene(seed, size, family, 0.06);
    const dim = rng.fork("dim").range(0.06, 0.1);
    return {
      scene,
      duration: 10500,
      autoCapture: true,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.003 }],
      light: [
        { t: 0, exposure: dim, gradient: 0.05 },
        { t: 6000, exposure: dim, gradient: 0.05 },
        { t: 6500, exposure: 1, gradient: 0 },
      ],
      actions: [{ at: 9500, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        tapAt: 9500,
        lightAt: 6000,
        hints: [{ name: "low light", from: 900, to: 5950, expect: ["low-light"], conditionFrom: 0 }],
        ready: [{ from: 6800, to: 9450 }],
        stable: [6500],
        tremor: [],
      },
    };
  },
});

registerSession({
  id: "glare",
  title: "a lamp's reflection on the page, then tilted away",
  inDefault: false,
  group: "guidance",
  describe:
    "framed and held still with a lamp's hot spot washing out part of the page (auto-capture on: none is owed while the hint is up) until 5.5 s, when the phone is tilted out of it (it fades over 0.3 s); holds; shutter at 9 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = framedScene(seed, size, family, 0.06);
    const lamp = rng.fork("lamp");
    const camera = cameraFromPose(scene.camera, scene.frame);
    const c = project(camera, [found.layer.center[0], found.layer.center[1], -(found.layer.height ?? 0)]);
    const reach = Math.min(scene.frame.width, scene.frame.height);
    const blob = {
      kind: "glare",
      center: [c.u + lamp.range(-0.12, 0.12) * reach, c.v + lamp.range(-0.12, 0.12) * reach],
      radius: [reach * lamp.range(0.14, 0.2), reach * lamp.range(0.1, 0.16)],
      angle: lamp.range(0, 180),
      strength: lamp.range(1.1, 1.4),
      softness: lamp.range(0.3, 0.5),
    };
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.003 }],
      glare: [{ from: -300, to: 5500, fadeMs: 300, blob }],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        tapAt: 9000,
        glareTo: 5500,
        hints: [{ name: "glare", from: 900, to: 5450, expect: ["glare"], conditionFrom: 0 }],
        ready: [{ from: 5800, to: 8950 }],
        stable: [5800],
        tremor: [],
      },
    };
  },
});

registerSession({
  id: "shaky-hold",
  title: "a shaking hand, then a steady one",
  inDefault: false,
  group: "guidance",
  describe:
    "framed; a strong handheld tremor (1.5 % RMS) for 4.5 s, then the hand steadies (0.3 %) and holds; auto-capture on (none may fire while it shakes); shutter at 9 s",
  build(rng, { seed, size, family }) {
    const { scene } = framedScene(seed, size, family, 0.1);
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [
        { t: 0, amplitude: 0.015 },
        { t: 4500, amplitude: 0.015 },
        { t: 5000, amplitude: 0.003 },
      ],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        tapAt: 9000,
        lockFrom: 0,
        hints: [{ name: "shaking", from: 900, to: 4450, expect: ["hold-still"], conditionFrom: 0 }],
        ready: [{ from: 5300, to: 8950 }],
        stable: [5000],
        tremor: [{ from: 0, to: 4700 }],
      },
    };
  },
});

registerSession({
  id: "tremor-hold-auto",
  title: "tremor-hold with auto-capture on",
  inDefault: false,
  group: "guidance",
  describe: "tremor-hold (a 1.2 % tremor, a thumb, the light dropping) with auto-capture on: no automatic capture may fire",
  build(rng, { seed, size, family }) {
    const base = sessions.get("tremor-hold").build(rng, { seed, size, family });
    return { ...base, autoCapture: true, marks: { ...base.marks, hints: [], ready: [], stable: [], tremor: [{ from: 0, to: base.duration }] } };
  },
});

registerSession({
  id: "page-swap-auto",
  title: "page-swap with auto-capture on",
  inDefault: false,
  group: "guidance",
  describe: "page-swap with auto-capture on: one automatic capture of each page, and the shutter on the new one",
  build(rng, { seed, size, family }) {
    const base = sessions.get("page-swap").build(rng, { seed, size, family });
    // The swap's own measures (stale overlay, the hold after it) are page-swap's:
    // here the first page's automatic capture puts its confirm screen over the swap.
    const { swapAt, swapDoneAt, lockFrom2, holdTo2, holdFrom, lockFrom, holdTo, ...marks } = base.marks;
    return {
      ...base,
      autoCapture: true,
      marks: {
        ...marks,
        hints: [],
        ready: [
          { from: lockFrom, to: holdTo },
          { from: lockFrom2, to: holdTo2 },
        ],
        stable: [lockFrom, lockFrom2],
        tremor: [],
        pages: 2,
      },
    };
  },
});

registerSession({
  id: "present-auto",
  title: "a page brought into view and held, auto-capture on",
  inDefault: false,
  group: "guidance",
  describe:
    "the camera starts over the desk beside the page; at 1.5 s it swings onto the page in 0.6 s and the person holds it — framing it as people do and following the hints — for 10.4 s; auto-capture on, no shutter: when it fires and where the time went (5b)",
  build(rng, { seed, size, family }) {
    const { scene, found } = roomyScene(seed, size, family, 0.06);
    const rest = scene.camera;
    const pan = rng.fork("pan");
    const bearing = pan.range(0, Math.PI * 2);
    const away = Math.max(...found.layer.size) * pan.range(1.8, 2.3);
    const off = { ...rest, target: [rest.target[0] + Math.cos(bearing) * away, rest.target[1] + Math.sin(bearing) * away] };
    const presentAt = 2100;
    return {
      scene,
      duration: 12600,
      autoCapture: true,
      camera: [
        { t: 0, pose: off },
        { t: 1500, pose: off },
        { t: presentAt, pose: rest },
      ],
      tremor: [{ t: 0, amplitude: 0.004 }],
      actions: [],
      marks: {
        hints: [],
        ready: [{ from: presentAt, to: 12500 }],
        stable: [presentAt],
        tremor: [],
        pages: 1,
      },
    };
  },
});

/** A page-less session with auto-capture on: the hint owed is "searching", and every automatic capture is a false fire. */
function pagelessAuto(id, base, title, describe) {
  registerSession({
    id,
    title,
    inDefault: false,
    group: "guidance",
    describe,
    build(rng, options) {
      const built = sessions.get(base).build(rng, options);
      return {
        ...built,
        autoCapture: true,
        marks: {
          ...built.marks,
          hints: [{ name: "no page", from: 600, to: built.marks.negativeTo, expect: SEARCHING, conditionFrom: 0 }],
          ready: [],
          stable: [],
          tremor: [],
          pageless: true,
        },
      };
    },
  });
}

pagelessAuto("empty-desk-auto", "empty-desk-sweep", "empty-desk-sweep with auto-capture on", "empty-desk-sweep with auto-capture on: no automatic capture may fire");
pagelessAuto("lookalikes-auto", "paper-lookalikes", "paper-lookalikes with auto-capture on", "paper-lookalikes (a white laptop, place mat, box and book, each framed 1.8 s) with auto-capture on: no automatic capture may fire");

registerSession({
  id: "desk-hold",
  title: "held still over a desk with no page",
  inDefault: false,
  describe: "an F6 scene (a laptop, a notebook, a place mat, a keyboard or clutter, no document) held still with a light tremor for 9 s; shutter at 9 s",
  build(rng, { seed, size }) {
    const scene = buildScene("F6", seed, { size });
    return {
      scene,
      duration: 10000,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.003 }],
      primary: [{ t: 0, page: 0 }],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: { negativeFrom: 0, negativeTo: 8950, tapAt: 9000 },
    };
  },
});

pagelessAuto("desk-hold-auto", "desk-hold", "desk-hold with auto-capture on", "an F6 desk with no page held still for 9 s with auto-capture on: no automatic capture may fire");

/** A pose at `t` as a camera, for code that needs the matrices. */
export function cameraAt(script, t, frame = script.frame, focalPixels) {
  const pose = poseAt(script, t);
  return cameraFromPose(focalPixels === undefined ? pose : { ...pose, focalPixels }, frame);
}

/* ── breaker sessions (Phase 4 adversarial: auto-capture and hint churn) ── */

/*
 * The `breaker` group — **not in a plain run**; `--session breaker` runs it.
 * Every session has auto-capture on. Besides the guidance marks
 * (`scoreGuidance`), each may carry `marks.noFire` —
 * `[{ name, from, to }]`: windows where an automatic capture would take a
 * bad image (a page cut off, a hot spot on it, the page still moving) — read
 * by the analysis that goes with the group (the guidance table counts only
 * `marks.tremor`, used here for motion).
 */

/**
 * The viewfinder's crop of the 720×1280 portrait stream on the bench's
 * 390×844 phone (object-cover: 7.5 % hidden top and bottom), as the app
 * measures it (`camera-live`'s `visible`).
 */
const VIEW_CROP = { x: 0, y: 0.075, width: 1, height: 0.85 };

/** A layer as the viewfinder shows it from `pose` (in `crop`, frame fractions): its nearest corner's margin, its share of the view, and its fill. */
function inView(pose, frame, layer, crop = frame.view ?? VIEW_CROP) {
  const camera = cameraFromPose(pose, frame);
  const pts = projectRect(camera, layer).map((p) => [
    (p.u / frame.width - crop.x) / crop.width,
    (p.v / frame.height - crop.y) / crop.height,
  ]);
  const margin = Math.min(...pts.map(([x, y]) => Math.min(x, 1 - x, y, 1 - y)));
  const inside = clipPolygon(pts, [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ]);
  const area = inside.length >= 3 ? polygonArea(inside) : 0;
  const whole = polygonArea(pts);
  return {
    margin,
    area,
    fill: framingMeasure("fill", pts),
    inShare: whole > 0 ? area / whole : 0,
    center: pts.reduce((s, [x, y]) => [s[0] + x / 4, s[1] + y / 4], [0, 0]),
  };
}

/** Bisect `f` in [0, 1] so that `measure(f)` (monotonic) meets `target`. */
function solveFor(measure, target, increasing) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    const v = measure(mid);
    if ((v < target) === increasing) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Keyframes that hold `hold` until `from`, then swing `x`, `y`, `x`, … one every `halfMs` until `to`. */
function swing(hold, x, y, from, to, halfMs, key = "pose") {
  const keys = [{ t: 0, [key]: hold }, { t: from, [key]: hold }];
  let at = from;
  let flip = true;
  while (at + halfMs <= to) {
    at += halfMs;
    keys.push({ t: at, [key]: flip ? x : y });
    flip = !flip;
  }
  return keys;
}

const NO_GUIDANCE = { hints: [], ready: [], stable: [], tremor: [], noFire: [] };

registerSession({
  id: "still-lookalikes-auto",
  title: "white things that are not paper, each held still 3.6 s",
  inDefault: false,
  group: "breaker",
  describe:
    "no document: a closed white laptop, a white place mat, a white box, a cream book and a white cutting board, then a white plastic folder, each framed and held still (0.25 % tremor) 3.6 s on one desk; auto-capture on: every automatic capture is a false fire",
  build(rng, { seed, size }) {
    const base = buildScene("F6", seed, { size });
    const deskRng = rng.fork("desk");
    const kind = deskRng.pick(["wood", "granite", "grey", "fabric"]);
    const background =
      kind === "wood" ? lightWood(deskRng) : kind === "granite" ? darkGranite(deskRng) : kind === "grey" ? paleTable(deskRng, { grey: true }) : fabric(deskRng);
    const extra = rng.fork("extra");
    const props = [
      ...lookalikes(rng.fork("props")),
      prop("board", { material: "laminate", color: extra.pick(["#f2f2ee", "#ececea", "#f4f3ef"]), mottle: 0.02, speckle: 0.01, streak: 0.02, streakAngle: extra.range(0, 180), sheen: 0.03, seed: extra.seed32() }, {
        center: [0, 0], rotation: 0, size: [extra.range(280, 320), extra.range(200, 230)], radius: extra.range(4, 10), height: 3, shadowStrength: 0.3,
      }),
      prop("folder", { material: "plastic", body: extra.pick(["#e9e9e6", "#f0efeb"]), sheen: extra.range(0.2, 0.6), spine: "#dcdcd8", spineWidth: 0, sheenAngle: extra.range(0, 180), peel: 0.08, crease: 10, seed: extra.seed32() }, {
        center: [0, 0], rotation: 0, size: [235, 320], radius: 3, height: 1.5, shadowStrength: 0.3,
      }),
    ];
    const spots = props.map((_, i) => [(i - 2.5) * 560, (i % 2) * 120]);
    const placed = props.map((p, i) => ({ ...p, center: spots[i], rotation: rng.range(-20, 20) }));
    const scene = { ...base, setting: "still-lookalikes", desk: kind, background, layers: placed };
    const cameraRng = rng.fork("camera");
    const keys = [];
    const hold = 3600;
    const move = 800;
    placed.forEach((layer, i) => {
      const pose = framingCamera(cameraRng, scene.frame, layer, { coverage: cameraRng.range(0.25, 0.5), tilt: [0, 15], marginFraction: 0.1 });
      const arrive = i * (hold + move);
      keys.push({ t: arrive, pose }, { t: arrive + hold, pose });
    });
    scene.camera = keys[0].pose;
    const duration = placed.length * (hold + move);
    return {
      scene,
      duration,
      autoCapture: true,
      camera: keys,
      tremor: [{ t: 0, amplitude: 0.0025 }],
      primary: [{ t: 0, page: 0 }],
      actions: [{ at: duration - 700, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        ...NO_GUIDANCE,
        negativeFrom: 0,
        negativeTo: duration - 750,
        tapAt: duration - 700,
        hints: [{ name: "no page", from: 600, to: duration - 750, expect: SEARCHING, conditionFrom: 0 }],
        pageless: true,
        objects: placed.map((p, i) => ({ name: p.name, from: i * (hold + move), to: i * (hold + move) + hold })),
      },
    };
  },
});

registerSession({
  id: "screen-page-auto",
  title: "a page shown on a phone and on a tablet",
  inDefault: false,
  group: "breaker",
  describe:
    "a phone and then a tablet lying screen up, each showing a document page (fit to the screen's width, black around it), each framed and held still 4.5 s; auto-capture on; counted page-less (a screen is not the paper): every automatic capture is a false fire",
  build(rng, { seed, size }) {
    const base = buildScene("F6", seed, { size });
    const deskRng = rng.fork("desk");
    const kind = deskRng.pick(["wood", "granite", "grey", "fabric"]);
    const background =
      kind === "wood" ? lightWood(deskRng) : kind === "granite" ? darkGranite(deskRng) : kind === "grey" ? paleTable(deskRng, { grey: true }) : fabric(deskRng);
    const dev = rng.fork("devices");
    const device = (name, center, bodySize) =>
      prop(name, { material: "phone", body: dev.pick(["#101114", "#2b2d31"]), screenUp: true, reflection: dev.range(0.1, 0.4), reflectionAngle: dev.range(0, 180), seed: dev.seed32() }, {
        center, rotation: 0, size: bodySize, radius: name === "phone" ? 9 : 12, height: name === "phone" ? 8.5 : 7, shadowStrength: 0.5,
      });
    const shown = (center, width, deviceHeight) => {
      const p = page(dev.fork(`page-${center[0]}`), { type: dev.pick(["lab-report", "letter", "form"]), center, curl: 0 });
      const height = width * (p.size[1] / p.size[0]);
      return {
        ...p,
        size: [width, height],
        material: { ...p.material, tint: dev.pick(["#f7f9ff", "#fbfbff", "#f4f6fb"]), fibre: 0, edge: 0 },
        height: deviceHeight + 0.2,
        shadowHeight: 0,
        shadowStrength: 0,
        wobble: 0,
      };
    };
    const rot = rng.range(-20, 20);
    const phoneAt = [-400, 0];
    const tabletAt = [400, 0];
    const layers = [
      device("phone", phoneAt, [72, 150]),
      { ...shown(phoneAt, 66, 8.5), rotation: 0 },
      device("tablet", tabletAt, [178, 250]),
      { ...shown(tabletAt, 162, 7), rotation: 0 },
    ].map((l) => ({ ...l, rotation: rot }));
    const scene = { ...base, setting: "screen-page", desk: kind, background, layers };
    const cameraRng = rng.fork("camera");
    const p1 = framingCamera(cameraRng, scene.frame, layers[0], { coverage: cameraRng.range(0.2, 0.35), tilt: [0, 12], marginFraction: 0.1 });
    const p2 = framingCamera(cameraRng, scene.frame, layers[2], { coverage: cameraRng.range(0.3, 0.5), tilt: [0, 12], marginFraction: 0.1 });
    scene.camera = p1;
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [
        { t: 0, pose: p1 },
        { t: 4500, pose: p1 },
        { t: 5300, pose: p2 },
      ],
      tremor: [{ t: 0, amplitude: 0.0025 }],
      primary: [
        { t: 0, page: 0 },
        { t: 4900, page: 1 },
      ],
      actions: [{ at: 9300, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        ...NO_GUIDANCE,
        tapAt: 9300,
        hints: [
          { name: "phone screen", from: 600, to: 4450, expect: SEARCHING, conditionFrom: 0 },
          { name: "tablet screen", from: 5900, to: 9250, expect: SEARCHING, conditionFrom: 5300 },
        ],
        pageless: true,
      },
    };
  },
});

registerSession({
  id: "half-out-auto",
  title: "a printed page half out of the frame, held still",
  inDefault: false,
  group: "breaker",
  describe:
    "held still with about half of the page outside the view (two corners gone) for 6.5 s — \"Afaste um pouco\" owed and no automatic capture; backs off over 1 s, holds; shutter at 10 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = framedScene(seed, size, family, 0.06);
    const rest = scene.camera;
    const cut = rng.fork("cut");
    const bearing = cut.range(0, Math.PI * 2);
    const share = cut.range(0.4, 0.65);
    const reach = Math.max(...found.layer.size) * 1.2;
    const shifted = (f) => ({ ...rest, target: [rest.target[0] + Math.cos(bearing) * reach * f, rest.target[1] + Math.sin(bearing) * reach * f] });
    const f = solveFor((x) => inView(shifted(x), scene.frame, found.layer).inShare, share, false);
    const out = shifted(f);
    return {
      scene,
      duration: 11000,
      autoCapture: true,
      camera: [
        { t: 0, pose: out },
        { t: 6500, pose: out },
        { t: 7500, pose: rest },
      ],
      tremor: [{ t: 0, amplitude: 0.003 }],
      actions: [{ at: 10000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        ...NO_GUIDANCE,
        tapAt: 10000,
        inShare: share,
        hints: [{ name: "half out", from: 900, to: 6450, expect: ["move-back"], conditionFrom: 0 }],
        ready: [{ from: 7800, to: 9950 }],
        stable: [7500],
        noFire: [{ name: "half out", from: 0, to: 7200 }],
      },
    };
  },
});

registerSession({
  id: "overlap-auto",
  title: "two pages overlapping, the top one is the scan",
  inDefault: false,
  group: "breaker",
  describe:
    "a second page laid over the first, offset 15–50 % of its size, both in view, held still 9 s; the top page is the one being scanned — an automatic capture of the bottom page or of both together is wrong; shutter at 9 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = framedScene(seed, size, family, 0.06);
    const under = found.layer;
    const lay = rng.fork("overlap");
    const bearing = lay.range(0, Math.PI * 2);
    const offset = lay.range(0.15, 0.5) * Math.min(...under.size);
    const top = page(lay.fork("page"), {
      type: lay.pick(["lab-report", "lab-report", "form", "letter", "note"]),
      center: [under.center[0] + Math.cos(bearing) * offset, under.center[1] + Math.sin(bearing) * offset],
      rotation: (under.rotation ?? 0) + lay.range(-15, 15),
      height: under.height,
      curl: 0,
    });
    const docsBefore = scene.layers.filter((l) => l.document !== undefined).length;
    scene.layers = [...scene.layers, top];
    // Framed on both pages together (their outline's bounding box), then backed off until each is whole.
    const corners = [under, top].flatMap((l) => {
      const a = ((l.rotation ?? 0) * Math.PI) / 180;
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
        const x = (sx * l.size[0]) / 2;
        const y = (sy * l.size[1]) / 2;
        return [l.center[0] + Math.cos(a) * x - Math.sin(a) * y, l.center[1] + Math.sin(a) * x + Math.cos(a) * y];
      });
    });
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const both = { center: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], size: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], rotation: 0 };
    let pose = framingCamera(lay.fork("camera"), scene.frame, both, { coverage: 0.6, tilt: [0, 12], aimSpread: 5, marginFraction: 0.04 });
    pose = withMargin(pose, scene.frame, under, 0.04);
    pose = withMargin(pose, scene.frame, top, 0.04);
    scene.camera = pose;
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [{ t: 0, pose }],
      tremor: [{ t: 0, amplitude: 0.003 }],
      primary: [{ t: 0, page: docsBefore }],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: { ...NO_GUIDANCE, tapAt: 9000, stable: [0], ready: [{ from: 1500, to: 8950 }], offset: offset / Math.min(...under.size) },
    };
  },
});

registerSession({
  id: "slow-drift-auto",
  title: "the page never quite stops: a slow, steady pan",
  inDefault: false,
  group: "breaker",
  describe:
    "framed; from 0.6 s the camera pans steadily across the page for 6 s at 0.8–3.2 % of the diagonal a second (by seed), then stops and holds; any automatic capture during the pan is a fire during motion; shutter at 9.5 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = framedScene(seed, size, family, 0.2);
    const rest = scene.camera;
    const speeds = [0.008, 0.012, 0.018, 0.025, 0.032];
    const want = speeds[(seed - 1 + speeds.length * 10) % speeds.length];
    const drift = rng.fork("drift");
    const bearing = drift.range(0, Math.PI * 2);
    const at = (mm) => ({ ...rest, target: [rest.target[0] + Math.cos(bearing) * mm, rest.target[1] + Math.sin(bearing) * mm] });
    const diag = Math.hypot(1, (scene.frame.height * VIEW_CROP.height) / scene.frame.width);
    const moveMs = 6000;
    // Travel (mm) for the wanted speed: measured on the view, not assumed.
    const c0 = inView(rest, scene.frame, found.layer).center;
    const c1 = inView(at(10), scene.frame, found.layer).center;
    const perMm = Math.hypot(c1[0] - c0[0], (c1[1] - c0[1]) * ((scene.frame.height * VIEW_CROP.height) / scene.frame.width)) / 10 / diag;
    let travel = (want * moveMs) / 1000 / perMm;
    while (travel > 1 && (inView(at(-travel / 2), scene.frame, found.layer).margin < 0.03 || inView(at(travel / 2), scene.frame, found.layer).margin < 0.03)) travel *= 0.95;
    const speed = (travel * perMm * 1000) / moveMs;
    const keys = [{ t: 0, pose: at(-travel / 2) }, { t: 600, pose: at(-travel / 2) }];
    const frames = Math.round(moveMs / SESSION_FRAME_MS);
    for (let i = 1; i <= frames; i += 1) keys.push({ t: 600 + i * SESSION_FRAME_MS, pose: at(-travel / 2 + (travel * i) / frames) });
    scene.camera = keys[0].pose;
    return {
      scene,
      duration: 10500,
      autoCapture: true,
      camera: keys,
      tremor: [{ t: 0, amplitude: 0.002 }],
      actions: [{ at: 9500, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        ...NO_GUIDANCE,
        tapAt: 9500,
        driftSpeed: speed,
        stable: [0, 6600],
        ready: [{ from: 7000, to: 9450 }],
        tremor: [{ from: 700, to: 6600 }],
        noFire: [{ name: "drifting", from: 700, to: 6600 }],
      },
    };
  },
});

registerSession({
  id: "hand-rest-auto",
  title: "a hand resting on the page, held still",
  inDefault: false,
  group: "breaker",
  describe:
    "framed and held still 9 s with a hand resting on the page the whole time (fingertip 20–45 % of the short side in from an edge) and a thumb holding a corner; auto-capture on; shutter at 9 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = roomyScene(seed, size, family, 0.08);
    const hand = handOver(rng.fork("hand"), found.layer, { reach: [0.2, 0.45] });
    const thumb = thumbOn(rng.fork("thumb"), found.layer);
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.003 }],
      finger: { ...thumb, enterAt: -2000, leaveAt: 60000, slideMs: 300 },
      fingers: [{ ...hand, enterAt: -2000, leaveAt: 60000, slideMs: 300 }],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: { ...NO_GUIDANCE, tapAt: 9000, stable: [0], ready: [{ from: 1500, to: 8950 }] },
    };
  },
});

registerSession({
  id: "dim-page-auto",
  title: "a page in a dim room, just above the low-light line",
  inDefault: false,
  group: "breaker",
  describe:
    "framed and held still 9 s in a dim room (exposure ×0.12–0.26 by seed: around the low-light hint's threshold); auto-capture on; the hint may be \"Pouca luz\" or none, nothing else; shutter at 9 s",
  build(rng, { seed, size, family }) {
    const { scene } = framedScene(seed, size, family, 0.06);
    const levels = [0.12, 0.15, 0.18, 0.22, 0.26];
    const dim = levels[(seed - 1 + levels.length * 10) % levels.length];
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.003 }],
      light: [{ t: 0, exposure: dim, gradient: 0.05 }],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        ...NO_GUIDANCE,
        tapAt: 9000,
        exposure: dim,
        hints: [{ name: "dim page", from: 900, to: 8950, expect: ["low-light", null], conditionFrom: 0 }],
        stable: [0],
      },
    };
  },
});

registerSession({
  id: "dim-desk-auto",
  title: "a desk with no page in a dim room, held still",
  inDefault: false,
  group: "breaker",
  describe:
    "an F6 desk (a laptop, notebook, place mat, keyboard or clutter, no document) held still 9 s in a dim room (exposure ×0.15–0.3); auto-capture on: every automatic capture is a false fire",
  build(rng, { seed, size }) {
    const scene = buildScene("F6", seed + 100, { size });
    const dim = rng.fork("dim").range(0.15, 0.3);
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.003 }],
      light: [{ t: 0, exposure: dim, gradient: 0.05 }],
      primary: [{ t: 0, page: 0 }],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        ...NO_GUIDANCE,
        negativeFrom: 0,
        negativeTo: 8950,
        tapAt: 9000,
        exposure: dim,
        hints: [{ name: "no page (dim)", from: 600, to: 8950, expect: [...SEARCHING, "low-light"], conditionFrom: 0 }],
        pageless: true,
      },
    };
  },
});

registerSession({
  id: "glare-sweep-auto",
  title: "a lamp's reflection sweeping across a still page",
  inDefault: false,
  group: "breaker",
  describe:
    "framed and held still with a lamp's hot spot on the page from the start (a third of the way in from one side); it slides across and off the page by 7.5 s; then no glare; auto-capture on — any automatic capture while the spot is on the page took it; shutter at 10 s",
  build(rng, { seed, size, family }) {
    const { scene, found } = framedScene(seed, size, family, 0.06);
    const lamp = rng.fork("lamp");
    const camera = cameraFromPose(scene.camera, scene.frame);
    const quad = projectRect(camera, found.layer).map((p) => [p.u, p.v]);
    const c = quad.reduce((s, [u, v]) => [s[0] + u / 4, s[1] + v / 4], [0, 0]);
    const reach = Math.min(scene.frame.width, scene.frame.height);
    const bearing = lamp.range(0, Math.PI * 2);
    const span = Math.max(...quad.map(([u, v]) => Math.hypot(u - c[0], v - c[1]))) * 1.25;
    // It starts on the page (a third of the way in from one side), so the ready cue and the countdown meet it.
    const from = [c[0] - Math.cos(bearing) * span * 0.35, c[1] - Math.sin(bearing) * span * 0.35];
    const to = [c[0] + Math.cos(bearing) * span, c[1] + Math.sin(bearing) * span];
    const shape = {
      kind: "glare",
      radius: [reach * lamp.range(0.1, 0.16), reach * lamp.range(0.08, 0.13)],
      angle: lamp.range(0, 180),
      strength: lamp.range(1.1, 1.5),
      softness: lamp.range(0.3, 0.5),
    };
    const startMs = -300;
    const endMs = 7500;
    const steps = Math.round((endMs - startMs) / SESSION_FRAME_MS);
    const glare = [];
    const inside = (p) => {
      let sign = 0;
      for (let i = 0; i < 4; i += 1) {
        const a = quad[i];
        const b = quad[(i + 1) % 4];
        const s = Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
        if (sign === 0) sign = s;
        else if (s !== 0 && s !== sign) return false;
      }
      return true;
    };
    let onFrom = null;
    let onTo = null;
    for (let i = 0; i < steps; i += 1) {
      const f = i / (steps - 1);
      const center = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f];
      const t = startMs + i * SESSION_FRAME_MS;
      glare.push({ from: t, to: t + SESSION_FRAME_MS - 0.001, fadeMs: 0, blob: { ...shape, center } });
      if (inside(center)) {
        onFrom ??= t;
        onTo = t + SESSION_FRAME_MS;
      }
    }
    onFrom = Math.max(0, onFrom ?? 0);
    onTo ??= endMs;
    return {
      scene,
      duration: 11000,
      autoCapture: true,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.003 }],
      glare,
      actions: [{ at: 10000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        ...NO_GUIDANCE,
        tapAt: 10000,
        hints: [{ name: "glare on page", from: onFrom + 500, to: onTo, expect: ["glare"], conditionFrom: onFrom }],
        ready: [{ from: 8000, to: 9950 }],
        stable: [0, endMs],
        noFire: [{ name: "spot on page", from: onFrom, to: onTo }],
      },
    };
  },
});

registerSession({
  id: "hover-far",
  title: "the page's size hovering at the too-far line",
  inDefault: false,
  group: "breaker",
  describe:
    "held 4 s with the page inside the too-far hint's hysteresis band (its fill — or, under the old rule, its area — halfway between the enter and exit lines), then the distance swings to 2.5 points past either line every second until 12 s; the hint may be \"Aproxime\" or none, and should change seldom; auto-capture on",
  build(rng, { seed, size, family, follow, region }) {
    const { scene, found } = framedScene(seed, size, family, 0.06);
    const rule = follow ?? DEFAULT_FOLLOW;
    const base = framingCamera(rng.fork("aim"), scene.frame, found.layer, { coverage: 0.14, tilt: [0, 10], aimSpread: 5, marginFraction: 0.1 });
    const at = (f) => ({ ...base, distance: base.distance * Math.exp(lerp(Math.log(0.4), Math.log(2.2), f)) });
    const crop = region ?? scene.frame.view ?? VIEW_CROP;
    const pose = (share) => at(solveFor((f) => inView(at(f), scene.frame, found.layer, crop)[rule.kind], share, false));
    const mid = pose((rule.enter + rule.exit) / 2);
    return {
      scene,
      duration: 13000,
      autoCapture: true,
      camera: swing(mid, pose(rule.enter - 0.025), pose(rule.exit + 0.025), 4000, 12000, 1000),
      tremor: [{ t: 0, amplitude: 0.004 }],
      actions: [],
      marks: { ...NO_GUIDANCE, hints: [{ name: "hover far", from: 900, to: 12000, expect: ["move-closer", null], conditionFrom: 0 }] },
    };
  },
});

registerSession({
  id: "hover-edge",
  title: "a corner hovering at the cut-off line",
  inDefault: false,
  group: "breaker",
  describe:
    "held 4 s with the nearest corner 2.2 % inside the view's edge (inside the cut-off hint's hysteresis band), then swings between 0.4 % and 4 % inside every 0.9 s until 12 s; the page is whole throughout; the hint may be \"Afaste um pouco\" or none; auto-capture on",
  build(rng, { seed, size, family }) {
    const { scene, found } = framedScene(seed, size, family, 0.06);
    const whole = scene.camera;
    const close = partialCamera(rng.fork("cut"), scene.frame, found.layer, { coverage: 0.4, cut: 1 });
    const pose = (m) => lerpPose(whole, close, solveFor((f) => inView(lerpPose(whole, close, f), scene.frame, found.layer).margin, m, false));
    const mid = pose(0.022);
    const keys = swing(mid, pose(0.004), pose(0.04), 4000, 12000, 900);
    return {
      scene,
      duration: 13000,
      autoCapture: true,
      camera: keys,
      tremor: [{ t: 0, amplitude: 0.004 }],
      actions: [],
      marks: { ...NO_GUIDANCE, hints: [{ name: "hover edge", from: 900, to: 12000, expect: ["move-back", null], conditionFrom: 0 }] },
    };
  },
});

registerSession({
  id: "hover-light",
  title: "the light hovering at the low-light line",
  inDefault: false,
  group: "breaker",
  describe:
    "framed and held still; the exposure swings between ×0.12 and ×0.3 every 1.2 s until 6 s, then flickers between ×0.13 and ×0.28 every 150–300 ms until 12 s — across the low-light hint's threshold; the hint may be \"Pouca luz\" or none, and should change seldom; auto-capture on",
  build(rng, { seed, size, family }) {
    const { scene } = framedScene(seed, size, family, 0.06);
    const flick = rng.fork("flicker");
    const lo = { exposure: 0.12, gradient: 0.05 };
    const light = swing(lo, { exposure: 0.3, gradient: 0.05 }, lo, 0, 6000, 1200, "value").map((k) => ({ t: k.t, ...k.value }));
    let t = 6000;
    let hi = false;
    while (t < 12000) {
      t += flick.range(150, 300);
      light.push({ t, exposure: hi ? 0.28 : 0.13, gradient: 0.05 });
      hi = !hi;
    }
    return {
      scene,
      duration: 13000,
      autoCapture: true,
      camera: [{ t: 0, pose: scene.camera }],
      tremor: [{ t: 0, amplitude: 0.003 }],
      light,
      actions: [],
      marks: { ...NO_GUIDANCE, hints: [{ name: "hover light", from: 900, to: 12000, expect: ["low-light", null], conditionFrom: 0 }] },
    };
  },
});

registerSession({
  id: "whip-off-auto",
  title: "pulled off the page just as the countdown runs",
  inDefault: false,
  group: "breaker",
  describe:
    "six times: framed on the page and held 0.9–1.9 s (so the ready cue and the auto-capture countdown are under way), then whipped off to bare desk in 200 ms and kept off 1.5 s; auto-capture on — a capture fired while off the page (or on the way) is a false fire / a fire in motion; shutter at the end on the page",
  build(rng, { seed, size, family }) {
    const { scene, found } = roomyScene(seed, size, family, 0.08);
    const rest = scene.camera;
    const whip = rng.fork("whip");
    const keys = [{ t: 0, pose: rest }];
    const tremor = [];
    const noFire = [];
    let t = 0;
    const holds = [900, 1100, 1300, 1500, 1700, 1900];
    holds.forEach((hold, i) => {
      const bearing = whip.range(0, Math.PI * 2);
      const away = Math.max(...found.layer.size) * whip.range(1.4, 1.8);
      const off = { ...rest, target: [rest.target[0] + Math.cos(bearing) * away, rest.target[1] + Math.sin(bearing) * away] };
      if (i > 0) {
        keys.push({ t: t + 250, pose: rest });
        t += 250;
      }
      keys.push({ t: t + hold, pose: rest });
      t += hold;
      noFire.push({ name: `whip ${i + 1}`, from: t, to: t + 1700 });
      keys.push({ t: t + 200, pose: off }, { t: t + 1700, pose: off });
      t += 1700;
    });
    keys.push({ t: t + 250, pose: rest });
    t += 250;
    const tapAt = t + 1500;
    return {
      scene,
      duration: tapAt + 1000,
      autoCapture: true,
      camera: keys,
      tremor: [{ t: 0, amplitude: 0.003 }],
      actions: [{ at: tapAt, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: { ...NO_GUIDANCE, tapAt, stable: keys.filter((k, i) => i > 0 && k.pose === rest && keys[i - 1].pose !== rest).map((k) => k.t), tremor: noFire.map(({ from, to }) => ({ from, to })), noFire },
    };
  },
});

/* ── 5d+ phase B: a covered corner, the phone moving ─────────────────────── */

/**
 * The first F8 seed at or after `from` that samples `setting` (F8 cycles its
 * settings by seed).
 */
function f8Seed(setting, from) {
  for (let s = Math.max(1, from); s < from + 600; s += 1) if (buildScene("F8", s).setting === setting) return s;
  throw new Error(`no F8 seed samples ${setting}`);
}

registerSession({
  id: "covered-corner-auto",
  title: "a leaflet over the page's corner, the phone moving",
  inDefault: false,
  group: "breaker",
  describe:
    "the owner's field case (F8 owner-case: a white leaflet over the top-left corner of a stacked imaging report on a leather mat, phone tilted 30–45°): the camera comes in from further off over 1.5 s, holds with a hand's tremor, drifts 4 % aside and back at 4.5 s; auto-capture on — the covered corner can only be estimated, so no automatic capture is owed at all and none may fire; the shutter at 8 s still works (confirm screen marks the corner)",
  build(rng, { seed, size }) {
    const scene = buildScene("F8", f8Seed("owner-case", 1 + 6 * (seed - 1)), { size });
    const found = pageOf(scene);
    const rest = withMargin(scene.camera, scene.frame, found.layer, 0.05);
    scene.camera = rest;
    const far = farPose(rng.fork("far"), rest, { distance: [1.25, 1.45], off: [20, 50] });
    const drift = rng.fork("drift");
    const bearing = drift.range(0, Math.PI * 2);
    const by = 0.04 * Math.max(...found.layer.size);
    const aside = { ...rest, target: [rest.target[0] + Math.cos(bearing) * by, rest.target[1] + Math.sin(bearing) * by] };
    return {
      scene,
      duration: 9600,
      autoCapture: true,
      camera: [
        { t: 0, pose: far },
        { t: 300, pose: far },
        { t: 1800, pose: rest },
        { t: 4500, pose: rest },
        { t: 5200, pose: aside },
        { t: 5900, pose: rest },
      ],
      tremor: [
        { t: 0, amplitude: 0.008 },
        { t: 1800, amplitude: 0.004 },
      ],
      actions: [{ at: 8000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        ...NO_GUIDANCE,
        tapAt: 8000,
        stable: [1800, 5900],
        // Covered the whole time: an automatic capture anywhere is one the owner's rule forbids.
        noFire: [{ name: "covered corner", from: 0, to: 9600 }],
        covered: true,
      },
    };
  },
});

/* ── 5d-paper: the paper gate in dim, uneven light ──────────────────────── */

/**
 * A warm, dim, one-lamp room (the field case of 2026-10-02 evening, from its
 * description): exposure ×0.15–0.4 (the session's `light`), the sensor's gain
 * 2–5 (its noise with it), 2700–3200 K with a good part of the cast left by
 * the white balance, the lamp to one side (a strong gradient across the
 * page), and — two seeds in three — the shadow of the hand or the phone over
 * one side's margin. Mutates `scene`; returns the exposure.
 */
function dimLamp(rng, scene, layer, pose) {
  const dim = rng.range(0.15, 0.4);
  const gain = rng.range(2, 5);
  scene.lighting = {
    ...scene.lighting,
    temperature: rng.range(2700, 3200),
    whiteBalanceResidual: rng.range(0.3, 0.55),
    gradient: { angle: rng.range(0, 360), amount: rng.range(0.5, 0.9), scale: 400, at: layer === null ? [...pose.target] : [...layer.center] },
  };
  scene.post = { ...scene.post, noise: { ...scene.post.noise, shot: scene.post.noise.shot * Math.sqrt(gain), read: scene.post.noise.read * gain } };
  if (layer !== null && rng.chance(0.67)) {
    const camera = cameraFromPose(pose, scene.frame);
    const px = projectRect(camera, layer);
    const k = rng.int(0, 3);
    const a = px[k];
    const b = px[(k + 1) % 4];
    const cx = px.reduce((s, p) => s + p.u, 0) / 4;
    const cy = px.reduce((s, p) => s + p.v, 0) / 4;
    const mid = [(a.u + b.u) / 2, (a.v + b.v) / 2];
    const length = Math.hypot(b.u - a.u, b.v - a.v);
    let n = [-(b.v - a.v) / length, (b.u - a.u) / length];
    if ((mid[0] - cx) * n[0] + (mid[1] - cy) * n[1] < 0) n = [-n[0], -n[1]];
    const reach = Math.min(scene.frame.width, scene.frame.height);
    const across = reach * rng.range(0.1, 0.18);
    const along = rng.range(-0.25, 0.25) * length;
    const dir = [(b.u - a.u) / length, (b.v - a.v) / length];
    scene.blobs = [
      ...(scene.blobs ?? []),
      {
        kind: "shadow",
        center: [mid[0] + dir[0] * along + n[0] * across * 0.5, mid[1] + dir[1] * along + n[1] * across * 0.5],
        radius: [length * rng.range(0.25, 0.45), across],
        angle: (Math.atan2(dir[1], dir[0]) * 180) / Math.PI,
        strength: rng.range(0.3, 0.55),
        softness: rng.range(0.6, 0.9),
      },
    ];
  }
  return dim;
}

/**
 * A page presented in the dim lamp light and held: the camera comes in over
 * 1.5 s, holds with a hand's tremor, drifts 4 % aside at 4.5 s and back by
 * 5.9 s, holds; the shutter at 9 s. Auto-capture stays off: the measure is
 * the found-sheet lock itself (`marks.paperLock`, scored by
 * `scorePaperLock`), and a fire would end the presentation.
 */
function dimPresentation(rng, scene, layer, dim) {
  const rest = scene.camera;
  const far = farPose(rng.fork("far"), rest, { distance: [1.25, 1.45], off: [20, 50] });
  const drift = rng.fork("drift");
  const bearing = drift.range(0, Math.PI * 2);
  const by = 0.04 * Math.max(...layer.size);
  const aside = { ...rest, target: [rest.target[0] + Math.cos(bearing) * by, rest.target[1] + Math.sin(bearing) * by] };
  return {
    scene,
    duration: 10000,
    camera: [
      { t: 0, pose: far },
      { t: 300, pose: far },
      { t: 1800, pose: rest },
      { t: 4500, pose: rest },
      { t: 5200, pose: aside },
      { t: 5900, pose: rest },
    ],
    tremor: [
      { t: 0, amplitude: 0.008 },
      { t: 1800, amplitude: 0.004 },
    ],
    light: [{ t: 0, exposure: dim, gradient: 0 }],
    actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
    marks: {
      ...NO_GUIDANCE,
      tapAt: 9000,
      exposure: dim,
      stable: [1800, 5900],
      // Presented from the end of the approach to the tap; steady (dropouts
      // count here) outside the drift.
      paperLock: { from: 1800, to: 8950, steady: [{ from: 1800, to: 4500 }, { from: 5900, to: 8950 }] },
    },
  };
}

/** The first F8 `sheet-over` seed at or after `from` whose page is an imaging report. */
function f8ReportSeed(from) {
  for (let s = Math.max(1, from); s < from + 600; s += 1) {
    const scene = buildScene("F8", s);
    if (scene.setting === "sheet-over" && pageOf(scene).layer.document?.type === "imaging-report") return s;
  }
  throw new Error("no F8 sheet-over imaging report");
}

/** An F8 scene for a dim session: its page framed with room for the drift, the occluder kept or taken away. */
function dimF8(seed, size, { setting, occluder }) {
  const scene = buildScene("F8", setting === "owner-case" ? f8Seed("owner-case", 1 + 6 * (seed - 1)) : f8ReportSeed(1 + 6 * (seed - 1)), { size });
  if (!occluder) scene.layers = scene.layers.filter((layer) => layer.occluder === undefined);
  const found = pageOf(scene);
  scene.camera = withMargin(scene.camera, scene.frame, found.layer, 0.05);
  return { scene, found };
}

for (const [id, title, describe, make] of [
  [
    "dim-owner-case",
    "the field case in a dim warm room",
    "F8 owner-case (a stacked imaging report on a leather mat, a white leaflet over its top-left corner, tilted 30–45°) under one warm lamp: exposure ×0.15–0.4, sensor gain 2–5, 2700–3200 K, the lamp to one side, a hand's shadow over one margin on two seeds in three; comes in, holds, drifts 4 % and back; auto off; shutter at 9 s",
    (seed, size) => dimF8(seed, size, { setting: "owner-case", occluder: true }),
  ],
  [
    "dim-owner-bare",
    "the field case's report, no leaflet, in a dim warm room",
    "dim-owner-case with the leaflet taken away: the same imaging report, mat, tilt and lamp, every corner in view",
    (seed, size) => dimF8(seed, size, { setting: "owner-case", occluder: false }),
  ],
  [
    "dim-sheet-over",
    "a sheet over an imaging report's corner in a dim warm room",
    "F8 sheet-over seeds whose page is an imaging report (any corner covered 5–35 %, any desk, tilt 0–45°) under the dim warm lamp; comes in, holds, drifts and back; auto off; shutter at 9 s",
    (seed, size) => dimF8(seed, size, { setting: "sheet-over", occluder: true }),
  ],
  [
    "dim-text-page",
    "a plain text page in a dim warm room",
    "an F1/F2 text page under the dim warm lamp; comes in, holds, drifts and back; auto off; shutter at 9 s",
    (seed, size, family) => framedScene(seed, size, family, 0.06),
  ],
]) {
  registerSession({
    id,
    title,
    inDefault: false,
    group: "paper",
    describe,
    build(rng, { seed, size, family }) {
      const { scene, found } = make(seed, size, family);
      // The lamp by seed alone: dim-owner-case and dim-owner-bare light the same report alike.
      const dim = dimLamp(rngFor("dim-lamp", seed), scene, found.layer, scene.camera);
      return dimPresentation(rng, scene, found.layer, dim);
    },
  });
}

registerSession({
  id: "dim-lamp-desk-auto",
  title: "a desk with no page under the dim warm lamp",
  inDefault: false,
  group: "paper",
  describe:
    "an F6 desk (a laptop lid, a keyboard, a place mat, a notebook or clutter; no document) under the dim warm lamp of the dim-* sessions, held 4 s, drifted and held again; auto-capture on: every automatic capture is a false fire, every lock a false lock",
  build(rng, { seed, size }) {
    const scene = buildScene("F6", seed + 200, { size });
    const dim = dimLamp(rng.fork("lamp"), scene, null, scene.camera);
    const rest = scene.camera;
    const drift = rng.fork("drift");
    const bearing = drift.range(0, Math.PI * 2);
    const aside = { ...rest, target: [rest.target[0] + Math.cos(bearing) * 20, rest.target[1] + Math.sin(bearing) * 20] };
    return {
      scene,
      duration: 10000,
      autoCapture: true,
      camera: [
        { t: 0, pose: rest },
        { t: 4500, pose: rest },
        { t: 5200, pose: aside },
      ],
      tremor: [{ t: 0, amplitude: 0.004 }],
      light: [{ t: 0, exposure: dim, gradient: 0 }],
      primary: [{ t: 0, page: 0 }],
      actions: [{ at: 9000, tap: "shutter" }, { confirmAfterMs: CONFIRM_AFTER_MS }],
      marks: {
        ...NO_GUIDANCE,
        negativeFrom: 0,
        negativeTo: 8950,
        tapAt: 9000,
        exposure: dim,
        hints: [{ name: "no page (dim lamp)", from: 600, to: 8950, expect: [...SEARCHING, "low-light"], conditionFrom: 0 }],
        pageless: true,
      },
    };
  },
});
