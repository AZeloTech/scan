/**
 * The session renderer: a session's frames, fast enough to stream.
 *
 * A still scene is shaded procedurally everywhere, which costs about a second
 * a frame on the software GPU the bench runs on. A session needs thirty a
 * second. The desk does not move, though — only the camera does — so the desk
 * and every prop under the first page are rendered **once**, straight down,
 * into a texture (a *plate*, `SceneRenderer#renderPlate`) covering everything
 * the session's camera will ever see; each frame then draws the desk as one
 * texture read and only the pages (and anything lying on them) analytically.
 * The pages keep their exact outline, parallax and ground truth; the desk
 * loses the parallax of its few millimetres of props, which nothing measures.
 *
 * Stills from the fake `ImageCapture` go through the same path at the still's
 * size and focal length, so a photo and the preview it was taken from are the
 * same scene, and the photo is ready in the fraction of a second a phone's
 * still pipeline takes.
 */

import { SceneRenderer } from "./renderer.js";
import { buildFrame, referenceCamera } from "./scene.js";
import { renderDocument } from "./documents.js";
import { cameraFromPose } from "./camera.js";
import { cameraAt, poseAt, sessionAt, stillGeometry } from "./session.js";

/** The largest plate side: 4096² RGBA with mipmaps is ~90 MB, and several seconds to shade. */
const PLATE_MAX_PX = 4096;

/** Finest plate: a quarter millimetre a texel is more than the closest preview resolves. */
const PLATE_MIN_MM_PER_PX = 0.25;

/** How far a ray near the horizon is followed across the desk. */
const RAY_REACH_MM = 1500;

/** Where on the desk the frame's corners and edge midpoints land, widened by `widen`. */
function footprint(camera, widen) {
  const { width, height, cx, cy } = camera;
  const points = [];
  for (const [u, v] of [
    [0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5],
  ]) {
    const px = cx + (u * width - cx) * widen;
    const py = cy + (v * height - cy) * widen;
    // R · K⁻¹ · (px, py, 1)
    const d = [(px - cx) / camera.f, (py - cy) / camera.f, 1];
    const R = camera.R;
    const dir = [
      R[0] * d[0] + R[1] * d[1] + R[2] * d[2],
      R[3] * d[0] + R[4] * d[1] + R[5] * d[2],
      R[6] * d[0] + R[7] * d[1] + R[8] * d[2],
    ];
    const norm = Math.hypot(...dir);
    let s = dir[2] > 1e-3 ? -camera.C[2] / dir[2] : Infinity;
    s = Math.min(s, RAY_REACH_MM / norm);
    points.push([camera.C[0] + s * dir[0], camera.C[1] + s * dir[1]]);
  }
  return points;
}

export class SessionRenderer {
  constructor() {
    this.renderer = new SceneRenderer();
    this.plate = null;
    this.script = null;
    this.firstLive = 0;
  }

  describe() {
    return this.renderer.describe();
  }

  /**
   * Split the scene into plate and live layers, render the plate and upload
   * the pages' ink. Returns what it cost and what it covers.
   */
  prepare(script) {
    const started = performance.now();
    this.script = script;
    const layers = script.scene.layers;
    const firstPage = layers.findIndex((layer) => layer.document !== undefined);
    this.firstLive = firstPage === -1 ? layers.length : firstPage;

    // Everything the camera — and a still wider than it — will ever see.
    const widen = script.still.fovScale * (script.still.aspect === "sensor" ? 1.34 : 1) + 0.05;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let closest = Infinity;
    for (let t = 0; t <= script.duration + 3000; t += 100) {
      const camera = cameraAt(script, t);
      closest = Math.min(closest, poseAt(script, t).distance);
      for (const [x, y] of footprint(camera, widen)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    const margin = 40;
    const rect = [minX - margin, minY - margin, maxX + margin, maxY + margin];
    const reference = cameraFromPose(script.scene.camera, script.frame);
    const mmPerPx = Math.max(
      PLATE_MIN_MM_PER_PX,
      closest / reference.f,
      (rect[2] - rect[0]) / PLATE_MAX_PX,
      (rect[3] - rect[1]) / PLATE_MAX_PX,
    );
    const plateParams = {
      ...script.scene,
      shake: [],
      layers: layers.slice(0, this.firstLive),
      blobs: [],
      effects: [],
      lighting: {
        ...script.scene.lighting,
        temperature: 6500,
        whiteBalanceResidual: 0,
        exposure: 1,
        gradient: { ...script.scene.lighting.gradient, amount: 0 },
      },
    };
    this.renderer.releasePlate(this.plate);
    this.plate = this.renderer.renderPlate(buildFrame(plateParams), rect, mmPerPx);
    const plateMs = performance.now() - started;

    // Each page baked: its paper and its ink, shaded once in its own frame at
    // the resolution of the closest view (and the still's), so a frame reads
    // one texture per page instead of shading paper fibres per pixel.
    const stillScale = 3000 / Math.max(script.frame.width, script.frame.height);
    const pxPerMm = Math.min(12, Math.max(3, (reference.f / closest) * 1.6 * Math.max(1, stillScale * 0.8)));
    for (const baked of this.baked ?? []) this.renderer.releasePlate(baked);
    this.baked = [];
    for (const layer of layers.slice(this.firstLive)) {
      if (layer.document === undefined) continue;
      if (this.baked.length > 1) throw new Error("the renderer holds at most two printed pages per session");
      this.baked.push(this.bakePage(script, layer, pxPerMm));
    }
    this.baked.forEach((baked, slot) => this.renderer.setInkTexture(slot, baked));
    this.gl = this.renderer.gl;
    this.gl.finish();
    return {
      plate: { width: this.plate.width, height: this.plate.height, mmPerPx, rect },
      inkPxPerMm: pxPerMm,
      liveLayers: layers.length - this.firstLive,
      plateMs,
      totalMs: performance.now() - started,
    };
  }

  /**
   * A page's paper × ink, straight down, exactly its own rectangle — the
   * texture the page is drawn with from then on. Rendered a texel larger all
   * round so its border texels are all paper; no shadow, no soft edge, no
   * wobble (the live layer draws those), no curl (the live layer bends it).
   */
  bakePage(script, layer, pxPerMm) {
    this.renderer.setInk(0, renderDocument(layer.document, pxPerMm));
    const mm = 1 / pxPerMm;
    const [w, h] = layer.size;
    const flat = {
      ...layer,
      center: [0, 0],
      rotation: 0,
      height: 0,
      size: [w + 4 * mm, h + 4 * mm],
      radius: 0,
      wobble: 0,
      softness: 0,
      shadowStrength: 0,
      curl: undefined,
    };
    const params = {
      ...script.scene,
      shake: [],
      background: { material: "solid", color: "#000000", mottle: 0, seed: 0 },
      layers: [flat],
      blobs: [],
      effects: [],
      lighting: {
        ...script.scene.lighting,
        temperature: 6500,
        whiteBalanceResidual: 0,
        exposure: 1,
        gradient: { ...script.scene.lighting.gradient, amount: 0 },
      },
    };
    return this.renderer.renderPlate(buildFrame(params), [-w / 2, -h / 2, w / 2, h / 2], mm);
  }

  /**
   * Draw the session at camera time `t` (optionally as a still: `frame` and
   * `focalPixels`). Returns the WebGL canvas — valid until the next call — and
   * the params it was drawn from (their effects still to be applied in 2-D).
   */
  render(t, options = {}) {
    const params = sessionAt(this.script, t, options);
    const live = {
      ...params,
      background: { material: "plate", seed: 0 },
      // Pages are drawn flat white under their baked texture (the ink slot).
      layers: params.layers
        .slice(this.firstLive)
        .map((layer) => (layer.document === undefined ? layer : { ...layer, material: { material: "flat", color: "#ffffff", seed: 0 } })),
      samples: 1,
    };
    const frame = buildFrame(live);
    frame.plate = this.plate;
    return { canvas: this.renderer.render(frame), params };
  }

  release() {
    this.renderer.releasePlate(this.plate);
    for (const baked of this.baked ?? []) this.renderer.releasePlate(baked);
    this.plate = null;
    this.baked = [];
  }
}

/** The preview's focal length in pixels (constant for a session: its frame and lens). */
export function previewFocal(script) {
  return referenceCamera({ ...script.scene, frame: script.frame }).f;
}

export { stillGeometry };

