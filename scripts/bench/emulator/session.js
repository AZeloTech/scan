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
import { page, partialCamera } from "./kit.js";
import { SKIN_TONES } from "./effects.js";
import { clipPolygon, polygonArea } from "../metrics.mjs";

const sessions = new Map();

/**
 * @param {{ id: string, title: string, describe: string,
 *   build: (rng: import("./prng.js").Rng, options: { frame: { width: number, height: number }, seed: number }) => object }} session
 */
export function registerSession(session) {
  if (sessions.has(session.id)) throw new Error(`session "${session.id}" is already registered`);
  sessions.set(session.id, session);
}

export function sessionIds() {
  return [...sessions.keys()];
}

export function describeSessions() {
  return [...sessions.values()].map(({ id, title, describe }) => ({ id, title, describe }));
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
  const finger = fingerAt(script, t, cameraFromPose(camera, frame));
  if (finger !== null) params.effects = [finger];
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

/** A pose at `t` as a camera, for code that needs the matrices. */
export function cameraAt(script, t, frame = script.frame, focalPixels) {
  const pose = poseAt(script, t);
  return cameraFromPose(focalPixels === undefined ? pose : { ...pose, focalPixels }, frame);
}
