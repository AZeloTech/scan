/**
 * Scenes: what a family samples, what the ground truth is, and how a scene
 * becomes pixels.
 *
 * A scene is a plain JSON object — the **params** — sampled by a family from a
 * seeded stream ({@link buildScene}). Everything downstream is a function of
 * it: the ground truth ({@link groundTruth}, pure maths, runs in Node too) and
 * the pixels ({@link SceneMaker}, WebGL in the page). The params are what
 * `results.json` records, so any row of a report can be re-rendered exactly.
 *
 * Two registries make the emulator grow without the runner noticing:
 *
 *  - **families** ({@link registerFamily}): a sampler from `(rng, options)` to
 *    params. F1 lives in `family-f1.js`; F2–F7 register the same way.
 *  - **effects** ({@link registerEffect}): post-render steps applied, in the
 *    order the params list them, after the renderer and before the JPEG
 *    round-trip — a finger over a corner, a screen-space occluder. An effect
 *    may also say which image points it hides, which feeds the ground truth's
 *    per-corner `visible` flags.
 */

import { rngFor } from "./prng.js";
import {
  applyHomography,
  cameraFromPose,
  curlLift,
  layerOutline,
  planeHomography,
  polygonArea,
  project,
  rectCorners,
} from "./camera.js";
import { packMaterial } from "./materials.js";
import { documentContent, renderDocument } from "./documents.js";
import { SceneRenderer } from "./renderer.js";

/* ── registries ─────────────────────────────────────────────────────────── */

const families = new Map();
const effects = new Map();

/**
 * @param {{ id: string, title: string, describe: string,
 *   sample: (rng: import("./prng.js").Rng, options: { frame: { width: number, height: number }, seed: number }) => object }} family
 *   `sample` returns params without `family`, `seed` or `frame` — those are
 *   filled in here. Most families draw everything from `rng`; `seed` is there
 *   for one that assigns its settings by seed (F7 cycles through them, so a
 *   run of N seeds covers every setting evenly).
 */
export function registerFamily(family) {
  if (families.has(family.id)) throw new Error(`family "${family.id}" is already registered`);
  families.set(family.id, family);
}

export function familyIds() {
  return [...families.keys()];
}

export function describeFamilies() {
  return [...families.values()].map(({ id, title, describe }) => ({ id, title, describe }));
}

/**
 * @param {string} name
 * @param {{ apply: (ctx: CanvasRenderingContext2D, params: object, scene: object) => void,
 *   hides?: (params: object, scene: object) => ((u: number, v: number) => boolean) }} effect
 *   `apply` draws on the rendered frame (pixels); `hides` answers whether an
 *   image point (pixels) is covered. `hides` must be pure maths: the ground
 *   truth is computed from it in Node as well as in the page.
 */
export function registerEffect(name, effect) {
  if (effects.has(name)) throw new Error(`effect "${name}" is already registered`);
  effects.set(name, effect);
}

/** What the params' effects hide, as one predicate over image pixels, or null. */
function effectHider(params) {
  const hiders = [];
  for (const step of params.effects ?? []) {
    const effect = effects.get(step.type);
    if (effect === undefined) throw new Error(`unknown effect "${step.type}"`);
    if (effect.hides !== undefined) hiders.push(effect.hides(step, params));
  }
  return hiders.length === 0 ? null : (u, v) => hiders.some((h) => h(u, v));
}

/* ── frames ─────────────────────────────────────────────────────────────── */

/** Android Chrome's portrait stream, and its landscape twin. */
export const FRAME_SIZES = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};

/** `"portrait"`, `"landscape"` or `"WxH"`. */
export function frameSize(size = "portrait") {
  if (typeof size === "object" && size !== null) return size;
  if (size in FRAME_SIZES) return FRAME_SIZES[size];
  const match = /^(\d+)x(\d+)$/.exec(String(size));
  if (match === null) throw new Error(`frame size "${size}" is not portrait, landscape or WxH`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Sample one scene's params. Deterministic in (family, seed, options). */
export function buildScene(familyId, seed, options = {}) {
  const family = families.get(familyId);
  if (family === undefined) {
    throw new Error(`unknown family "${familyId}" (known: ${familyIds().join(", ")})`);
  }
  const frame = frameSize(options.size);
  const params = family.sample(rngFor(familyId, seed), { frame, seed });
  return { family: familyId, seed, frame, effects: [], blobs: [], ...params };
}

/* ── ground truth ───────────────────────────────────────────────────────── */

/**
 * The cameras one frame is exposed through: the pose itself, or — with motion
 * blur — one per sample along the shake. Shake deltas are centred on the pose,
 * so the pose itself is the middle of the exposure.
 */
export function cameras(params) {
  const base = params.camera;
  const shake = params.shake ?? [];
  if (shake.length === 0) return [cameraFromPose(base, params.frame)];
  return shake.map((delta) =>
    cameraFromPose(
      {
        ...base,
        target: [base.target[0] + (delta.target?.[0] ?? 0), base.target[1] + (delta.target?.[1] ?? 0)],
        tilt: base.tilt + (delta.tilt ?? 0),
        roll: base.roll + (delta.roll ?? 0),
        distance: base.distance + (delta.distance ?? 0),
      },
      params.frame,
    ),
  );
}

/** The camera the ground truth is measured with: the middle of the exposure. */
export function referenceCamera(params) {
  return cameraFromPose(params.camera, params.frame);
}

/** Whether a desk point lies inside a layer's outline (in the plane, ignoring parallax). */
function insideLayer(layer, x, y) {
  const angle = ((layer.rotation ?? 0) * Math.PI) / 180;
  const dx = x - layer.center[0];
  const dy = y - layer.center[1];
  const lx = Math.cos(angle) * dx + Math.sin(angle) * dy;
  const ly = -Math.sin(angle) * dx + Math.cos(angle) * dy;
  return Math.abs(lx) <= layer.size[0] / 2 && Math.abs(ly) <= layer.size[1] / 2;
}

/**
 * Every page in the scene, projected: corners (pixels and normalized, TL, TR,
 * BR, BL of the page's own content), whether each corner is inside the frame,
 * whether it is visible (in frame, and not under a layer above it or an
 * effect), the page's outline (`polygon`, pixels — the four corners for a flat
 * page, the projected boundary polyline for a curled one) and its coverage of
 * the frame.
 *
 * `quad` is the **primary** page's normalized corners — the page a scan of this
 * scene is about — or `null` for a scene with no document.
 *
 * `hidden`, when given, is an extra occlusion test over and above the
 * params' own effects.
 */
export function groundTruth(params, hidden = null) {
  const camera = referenceCamera(params);
  const { width, height } = params.frame;
  const fromEffects = effectHider(params);
  const covered = (u, v) =>
    (fromEffects !== null && fromEffects(u, v)) || (hidden !== null && hidden(u, v));
  const pages = [];
  params.layers.forEach((layer, index) => {
    if (layer.document === undefined) return;
    const world = rectCorners(layer);
    const px = world.map((point) => {
      const p = project(camera, point);
      return [p.u, p.v];
    });
    const inFrame = px.map(([u, v]) => u >= 0 && v >= 0 && u <= width && v <= height);
    const above = params.layers.slice(index + 1);
    const visible = world.map(([x, y], corner) => {
      if (!inFrame[corner]) return false;
      if (above.some((other) => insideLayer(other, x, y))) return false;
      return !covered(px[corner][0], px[corner][1]);
    });
    const polygon = layer.curl
      ? layerOutline(layer, OUTLINE_POINTS_PER_EDGE).map((point) => {
          const p = project(camera, point);
          return [p.u, p.v];
        })
      : px;
    pages.push({
      layer: index,
      type: layer.document.type,
      px,
      corners: px.map(([u, v]) => [u / width, v / height]),
      inFrame,
      visible,
      polygon,
      coverage: polygonArea(polygon) / (width * height),
    });
  });
  const primary = pages.length === 0 ? null : Math.max(0, Math.min(pages.length - 1, params.primaryPage ?? 0));
  return {
    frame: { width, height },
    pages,
    primary,
    quad: primary === null ? null : pages[primary].corners,
  };
}

/** Points per edge of a curled page's outline: its sagitta between them is far below a pixel. */
const OUTLINE_POINTS_PER_EDGE = 24;

/* ── content: where the print is, for judging what a crop cut off ───────── */

/** On a curled page a content box's edges are followed in steps this long (mm). */
const CONTENT_STEP_MM = 8;

/**
 * A page's content boxes projected into the frame: `boxes` are fractions of
 * the page (`documentContent`), each becomes `{ kind, polygon }` with the
 * polygon normalized to the frame — its four corners on a flat page, its
 * outline in {@link CONTENT_STEP_MM} steps where the page curls. Pure maths,
 * like the rest of the truth; a box is lifted exactly as the renderer lifts
 * the paper under it.
 */
export function projectContent(params, layer, boxes, camera = referenceCamera(params)) {
  const { width, height } = params.frame;
  const [w, h] = layer.size;
  const half = [w / 2, h / 2];
  const angle = ((layer.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const base = layer.height ?? 0;
  const point = (u, v) => {
    const x = (u - 0.5) * w;
    const y = (v - 0.5) * h;
    const p = project(camera, [
      layer.center[0] + c * x - s * y,
      layer.center[1] + s * x + c * y,
      -(base + curlLift(layer.curl, [x, y], half)),
    ]);
    return [p.u / width, p.v / height];
  };
  return boxes.map(({ kind, box: [u0, v0, u1, v1] }) => {
    const corners = [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ];
    const outline = [];
    for (let edge = 0; edge < 4; edge += 1) {
      const [au, av] = corners[edge];
      const [bu, bv] = corners[(edge + 1) % 4];
      const steps = layer.curl ? Math.max(1, Math.ceil(Math.hypot((bu - au) * w, (bv - av) * h) / CONTENT_STEP_MM)) : 1;
      for (let k = 0; k < steps; k += 1) outline.push(point(au + ((bu - au) * k) / steps, av + ((bv - av) * k) / steps));
    }
    return { kind, polygon: outline };
  });
}

/**
 * Adds each page's projected content to a ground truth (`pages[i].content`)
 * and the primary page's as `content` (null without a page). `contentOf(spec)`
 * answers a document's content boxes — `documentContent`, which draws, so
 * this runs where the pixels are made.
 */
export function withContent(gt, params, contentOf = documentContent) {
  const camera = referenceCamera(params);
  for (const page of gt.pages) {
    const layer = params.layers[page.layer];
    page.content = projectContent(params, layer, contentOf(layer.document), camera);
  }
  gt.content = gt.primary === null ? null : gt.pages[gt.primary].content;
  return gt;
}

/* ── lighting ───────────────────────────────────────────────────────────── */

/** Tanner Helland's black-body fit, as linear RGB with unit luminance. */
function kelvinToLinear(kelvin) {
  const t = kelvin / 100;
  const clamp = (v) => Math.min(255, Math.max(0, v));
  const r = t <= 66 ? 255 : clamp(329.698727446 * (t - 60) ** -0.1332047592);
  const g = t <= 66 ? clamp(99.4708025861 * Math.log(t) - 161.1195681661) : clamp(288.1221695283 * (t - 60) ** -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  const linear = [r, g, b].map((v) => (v / 255) ** 2.2);
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return linear.map((v) => v / luminance);
}

/**
 * The light's colour after the phone's white balance has taken most of it
 * out: `residual` 0 is a perfect correction, 1 none at all.
 */
function whiteBalanceTint(kelvin, residual, exposure) {
  const light = kelvinToLinear(kelvin);
  const neutral = kelvinToLinear(6500);
  return light.map((v, i) => exposure * (1 + residual * (v / neutral[i] - 1)));
}

/* ── pixels ─────────────────────────────────────────────────────────────── */

/** Resolution of a page's ink texture: enough for the closest the camera gets. */
function inkResolution(params, layer) {
  const camera = referenceCamera(params);
  const px = rectCorners(layer).map(([x, y]) => applyHomography(planeHomography(camera, layer.height ?? 0), x, y));
  const longestEdge = Math.max(
    ...px.map((p, i) => Math.hypot(p[0] - px[(i + 1) % 4][0], p[1] - px[(i + 1) % 4][1])),
  );
  const pxPerMm = longestEdge / Math.max(...layer.size);
  return Math.min(12, Math.max(3, pxPerMm * 1.6));
}

/** The renderer's vocabulary for one scene. */
export function buildFrame(params) {
  const { lighting, post } = params;
  const gradientAngle = ((lighting.gradient.angle ?? 0) * Math.PI) / 180;
  const shadowAngle = ((lighting.shadow.angle ?? 0) * Math.PI) / 180;
  let inkSlot = 0;
  return {
    width: params.frame.width,
    height: params.frame.height,
    cameras: cameras(params),
    background: packMaterial(params.background),
    layers: params.layers.map((layer) => ({
      ...layer,
      ...packMaterial(layer.material),
      ink: layer.document === undefined ? -1 : inkSlot++,
    })),
    lighting: {
      gradientDir: [Math.cos(gradientAngle), Math.sin(gradientAngle)],
      gradientAmount: lighting.gradient.amount,
      gradientScale: lighting.gradient.scale ?? 400,
      gradientAt: lighting.gradient.at ?? [0, 0],
      shadowDir: [
        Math.cos(shadowAngle) * lighting.shadow.length,
        Math.sin(shadowAngle) * lighting.shadow.length,
      ],
      tint: whiteBalanceTint(lighting.temperature, lighting.whiteBalanceResidual, lighting.exposure),
    },
    blobs: params.blobs ?? [],
    samples: params.samples ?? 1,
    curlShading: params.curlShading ?? 1,
    post: {
      blurSigma: post.blurSigma,
      vignette: post.vignette,
      noiseShot: post.noise.shot,
      noiseRead: post.noise.read,
      noiseLumaShare: post.noise.lumaShare,
      noiseSeed: post.noise.seed,
    },
  };
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("encode failed")) : resolve(blob)), type, quality);
  });
}

/** Renders scenes in the page. One per page: it owns a WebGL context. */
export class SceneMaker {
  constructor() {
    this.renderer = new SceneRenderer();
    this.inkCache = new Map();
  }

  describe() {
    return this.renderer.describe();
  }

  ink(spec, pxPerMm) {
    const key = `${spec.type}:${spec.seed}:${pxPerMm.toFixed(2)}`;
    let canvas = this.inkCache.get(key);
    if (canvas === undefined) {
      canvas = renderDocument(spec, pxPerMm);
      this.inkCache.set(key, canvas);
      while (this.inkCache.size > 4) this.inkCache.delete(this.inkCache.keys().next().value);
    }
    return canvas;
  }

  /**
   * Params → `{ canvas, gt }`. The canvas is a fresh 2-D canvas the caller owns:
   * the frame as a camera would deliver it, after optics, sensor, effects and
   * the JPEG round-trip.
   */
  async render(params) {
    const timings = {};
    let mark = performance.now();
    const lap = (name) => {
      const now = performance.now();
      timings[name] = now - mark;
      mark = now;
    };
    const frame = buildFrame(params);
    let slot = 0;
    for (const layer of params.layers) {
      if (layer.document === undefined) continue;
      if (slot > 1) throw new Error("the renderer holds at most two printed pages per scene");
      this.renderer.setInk(slot, this.ink(layer.document, inkResolution(params, layer)));
      slot += 1;
    }
    lap("ink");
    // The GPU runs asynchronously: "submit" is only the draw calls, and the
    // wait for the pixels lands in whichever step reads them first.
    const gl = this.renderer.render(frame);
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(gl, 0, 0);
    lap("submit");

    applyEffects(ctx, params);

    if (params.post.jpeg !== null && params.post.jpeg !== undefined) {
      const blob = await toBlob(canvas, "image/jpeg", params.post.jpeg);
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    }
    lap("finish");
    return { canvas, gt: withContent(groundTruth(params), params), timings };
  }
}

/** Draw the params' effects (a finger, …) onto a rendered frame, in order. */
export function applyEffects(ctx, params) {
  for (const step of params.effects ?? []) {
    const effect = effects.get(step.type);
    if (effect === undefined) throw new Error(`unknown effect "${step.type}"`);
    effect.apply(ctx, step, params);
  }
}

/**
 * The same scene stripped to geometry: every page flat white on black, no ink,
 * no props, no light, no optics, no sensor. What is left is the renderer's
 * own coverage of each page, which must sit exactly on the ground truth — the
 * check behind "GT is sub-pixel".
 *
 * Motion blur is stripped too: the truth of a smeared frame is the pose in the
 * middle of the exposure, and that is the pose checked. (Eight poses make a
 * staircase of eight edges; where its 50 % crossing falls says more about the
 * staircase than about the geometry.)
 */
export function calibrationParams(params) {
  return {
    ...params,
    shake: [],
    curlShading: 0,
    background: { material: "solid", color: "#000000", mottle: 0, seed: 0 },
    layers: params.layers
      .filter((layer) => layer.document !== undefined)
      .map((layer) => ({
        ...layer,
        document: undefined,
        calibrationOf: layer.document,
        material: { material: "solid", color: "#ffffff", mottle: 0, seed: 0 },
        // The truth is a rectangle's corners: the renderer's own rounding of a
        // card's corners is shape, not position, and would read as area error.
        radius: 0,
        wobble: 0,
        softness: 0,
        shadowStrength: 0,
      })),
    lighting: {
      ...params.lighting,
      temperature: 6500,
      whiteBalanceResidual: 0,
      exposure: 1,
      gradient: { ...params.lighting.gradient, amount: 0 },
    },
    blobs: [],
    effects: [],
    post: { ...params.post, blurSigma: 0, vignette: 0, noise: { ...params.post.noise, shot: 0, read: 0 }, jpeg: null },
  };
}
