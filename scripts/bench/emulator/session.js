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
import { cameraFromPose, inFrame, project, projectRect } from "./camera.js";
import { darkGranite, fabric, framingCamera, lightWood, page, paleTable, partialCamera } from "./kit.js";
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

/** The camera pose at `t`: keyframes, then the hand's tremor on top. */
export function poseAt(script, t) {
  const [a, b, f] = bracket(script.camera, t);
  const pose = lerpPose(a.pose, b.pose, f);
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
  return params;
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
  // `family` overrides the scene family a session would pick (the playground's choice).
  const built = session.build(rng, { seed, size: options.size ?? "portrait", family: options.family ?? null });
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
  return script;
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
  let out = pose;
  for (let step = 0; step < 80; step += 1) {
    const camera = cameraFromPose(out, frame);
    if (projectRect(camera, layer).every((p) => inFrame(camera, p, px))) return out;
    out = { ...out, distance: out.distance * 1.02 };
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

/** A pose at `t` as a camera, for code that needs the matrices. */
export function cameraAt(script, t, frame = script.frame, focalPixels) {
  const pose = poseAt(script, t);
  return cameraFromPose(focalPixels === undefined ? pose : { ...pose, focalPixels }, frame);
}
