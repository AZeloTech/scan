/**
 * The bench page: `window.__bench`, the API the Node runner drives.
 *
 * Everything that touches pixels happens here, in the browser — rendering a
 * scene, running a detector on it, drawing a contact sheet — and only numbers,
 * quads and finished sheet images travel back to Node. Scenes are kept by id
 * until released; a small thumbnail of each outlives its frame so the sheets
 * can be drawn at the end of a run.
 *
 * Served by `scripts/bench/server.mjs` on 127.0.0.1 only.
 */

import {
  buildScene,
  calibrationParams,
  describeFamilies,
  groundTruth,
  SceneMaker,
} from "../emulator/index.js";
import * as emulator from "../emulator/index.js";
import { detect, evidenceOn, initDetectors, refineOnSample, VARIANTS } from "./detectors.js";
import { COLORS, drawSheet, thumbnail } from "./sheets.js";
import { clipPolygon, polygonArea, signedArea } from "../metrics.mjs";
import { bitmapToCanvas } from "../../../src/lib/image.ts";

const frames = new Map();
const thumbs = new Map();
let maker = null;

async function init({ assetBase = "/assets/" } = {}) {
  maker = new SceneMaker();
  const detectors = await initDetectors(assetBase);
  return {
    ...detectors,
    renderer: maker.describe(),
    userAgent: navigator.userAgent,
    variants: Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, v.describe])),
    families: describeFamilies(),
  };
}

/** Render one scene; answers its params and ground truth, keeps the frame by id. */
async function scene(family, seed, options = {}) {
  if (maker === null) throw new Error("__bench.init() first");
  const params = buildScene(family, seed, options);
  const started = performance.now();
  const { canvas, gt, timings } = await maker.render(params);
  const renderMs = performance.now() - started;
  const id = `${family}-${seed}-${params.frame.width}x${params.frame.height}`;
  frames.set(id, canvas);
  thumbs.get(id)?.close();
  thumbs.set(id, await thumbnail(canvas, options.thumbLongEdge ?? 480));
  return { id, params, gt, renderMs, timings };
}

/**
 * Where the renderer actually put each page, against where the ground truth
 * says it is: the scene re-rendered as white pages on black
 * (`calibrationParams`), then the rendered coverage's area and centroid, and
 * the sub-pixel position of the 50 % crossing across every edge.
 */
async function selfCheck(family, seed, options = {}) {
  if (maker === null) throw new Error("__bench.init() first");
  const params = buildScene(family, seed, options);
  const truth = groundTruth(params);
  // A scene with no page has nothing to measure.
  if (truth.pages.length === 0) return { pages: 0 };
  const { canvas } = await maker.render(calibrationParams(params));
  const { width, height } = canvas;
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const cover = new Float32Array(width * height);
  let area = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < cover.length; i += 1) {
    const c = (pixels[i * 4 + 1] / 255) ** 2.2;
    cover[i] = c;
    area += c;
    mx += c * ((i % width) + 0.5);
    my += c * (Math.floor(i / width) + 0.5);
  }
  mx /= area;
  my /= area;
  const sample = (u, v) => {
    const x = Math.min(width - 1.001, Math.max(0, u - 0.5));
    const y = Math.min(height - 1.001, Math.max(0, v - 0.5));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (xx, yy) => cover[yy * width + xx];
    return (
      at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) +
      at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy
    );
  };
  // What the renderer should have covered: each page clipped to the frame,
  // pages that overlap counted once (inclusion–exclusion over pairs).
  const framePoly = [[0, 0], [width, 0], [width, height], [0, height]];
  const shapes = truth.pages.map((page) => clipPolygon(page.polygon, framePoly));
  const areaAndCentroid = (poly) => {
    if (poly.length < 3) return { area: 0, cx: 0, cy: 0 };
    let doubled = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < poly.length; i += 1) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const cross = ax * by - bx * ay;
      doubled += cross;
      cx += (ax + bx) * cross;
      cy += (ay + by) * cross;
    }
    // Two pages that only touch (a booklet's facing pages at the spine) overlap in a line.
    if (Math.abs(doubled) < 1e-9) return { area: 0, cx: 0, cy: 0 };
    return { area: Math.abs(doubled / 2), cx: cx / (3 * doubled), cy: cy / (3 * doubled) };
  };
  let gtArea = 0;
  let gx = 0;
  let gy = 0;
  shapes.forEach((shape, i) => {
    const own = areaAndCentroid(shape);
    gtArea += own.area;
    gx += own.cx * own.area;
    gy += own.cy * own.area;
    for (let j = i + 1; j < shapes.length; j += 1) {
      const overlap = areaAndCentroid(clipPolygon(shape, shapes[j]));
      gtArea -= overlap.area;
      gx -= overlap.cx * overlap.area;
      gy -= overlap.cy * overlap.area;
    }
  });
  const inside = (poly, [x, y]) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const nearOther = (index, point) =>
    truth.pages.some((other, k) => {
      if (k === index) return false;
      const poly = other.polygon;
      if (inside(poly, point)) return true;
      return poly.some(([ax, ay], i) => {
        const [bx, by] = poly[(i + 1) % poly.length];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(point[0] - ax - t * dx, point[1] - ay - t * dy) < 6;
      });
    });
  const offsets = [];
  truth.pages.forEach((page, pageIndex) => {
    // The outline: four corners for a flat page, the projected curved
    // boundary for a curled one.
    const pts = page.polygon;
    const n = pts.length;
    const winding = Math.sign(signedArea(pts));
    const along = n === 4 ? [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85] : [0.5];
    for (let i = 0; i < n; i += 1) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % n];
      const length = Math.hypot(bx - ax, by - ay);
      // Outward normal, from the outline's own winding.
      const normal = [(winding * (by - ay)) / length, (-winding * (bx - ax)) / length];
      // Near a corner of a curled outline the neighbouring edge is within
      // reach of the probe; those samples would measure the corner.
      if (n !== 4 && (i % (n / 4) === 0 || i % (n / 4) === n / 4 - 1)) continue;
      for (const t of along) {
        const p = [ax + (bx - ax) * t, ay + (by - ay) * t];
        if (p[0] < 5 || p[1] < 5 || p[0] > width - 5 || p[1] > height - 5) continue;
        if (nearOther(pageIndex, p)) continue;
        let previous = sample(p[0] - 4 * normal[0], p[1] - 4 * normal[1]);
        for (let s = -4 + 0.02; s <= 4; s += 0.02) {
          const current = sample(p[0] + s * normal[0], p[1] + s * normal[1]);
          if (previous >= 0.5 && current < 0.5) {
            offsets.push(s - 0.02 * ((0.5 - current) / (previous - current)));
            break;
          }
          previous = current;
        }
      }
    }
  });
  gx /= gtArea;
  gy /= gtArea;
  return {
    pages: truth.pages.length,
    areaPx: area,
    truthAreaPx: gtArea,
    areaErrorPct: ((area - gtArea) / gtArea) * 100,
    centroidOffsetPx: Math.hypot(mx - gx, my - gy),
    edgeOffsetPx: {
      samples: offsets.length,
      mean: offsets.reduce((s, v) => s + v, 0) / offsets.length,
      maxAbs: Math.max(...offsets.map(Math.abs)),
    },
  };
}

/** The paper evidence of each quad on scene `id`'s live sample (`evidenceOn`). */
function evidence(id, quads) {
  const frame = frames.get(id);
  if (frame === undefined) throw new Error(`no scene "${id}" (released, or never rendered)`);
  return evidenceOn(frame, quads);
}

/** The live-sample refinement of a quad on scene `id` (`refineOnSample`). */
function refineLive(id, quad, mode) {
  const frame = frames.get(id);
  if (frame === undefined) throw new Error(`no scene "${id}" (released, or never rendered)`);
  return refineOnSample(frame, quad, mode);
}

async function detectScene(variant, id) {
  const frame = frames.get(id);
  if (frame === undefined) throw new Error(`no scene "${id}" (released, or never rendered)`);
  return detect(variant, frame);
}

/**
 * A real image, decoded **the way the app decodes a photo**: the bytes as
 * served, `createImageBitmap(…, { imageOrientation: "from-image" })` (EXIF
 * applied once), then `bitmapToCanvas` from `src/lib/image.ts` — the still
 * path's own draw, at the image's full resolution (only a browser canvas
 * limit could shrink it). Extracted video frames carry no EXIF, so the same
 * call leaves them as they are. Kept by id like a scene;
 * `thumbLongEdge: 0` keeps no thumbnail (a clip's hundreds of frames).
 */
async function load(id, url, { thumbLongEdge = 480 } = {}) {
  const started = performance.now();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  let canvas;
  try {
    canvas = bitmapToCanvas(bitmap).canvas;
  } finally {
    bitmap.close();
  }
  release(id);
  frames.set(id, canvas);
  if (thumbLongEdge > 0) {
    thumbs.get(id)?.close();
    thumbs.set(id, await thumbnail(canvas, thumbLongEdge));
  }
  return { id, width: canvas.width, height: canvas.height, bytes: blob.size, decodeMs: performance.now() - started };
}

/** Drop a scene's full frame (the thumbnail stays for the sheets). */
function release(id) {
  const frame = frames.get(id);
  if (frame !== undefined) {
    frame.width = 0;
    frame.height = 0;
    frames.delete(id);
  }
}

/** One contact sheet; tiles name scenes (or loaded images) by id. */
function sheet({ title, columns, tiles, legend }) {
  return drawSheet({
    title,
    columns,
    legend: (
      legend ?? [
        { label: "truth", color: "truth" },
        { label: "right crop", color: "good" },
        { label: "wrong crop", color: "wrong" },
        { label: "gated out (dashed)", color: "rejected" },
      ]
    ).map((entry) => ({ ...entry, color: COLORS[entry.color] ?? entry.color })),
    tiles: tiles.map((tile) => {
      const thumb = thumbs.get(tile.id);
      if (thumb === undefined) throw new Error(`no thumbnail for "${tile.id}"`);
      return {
        thumb,
        caption: tile.caption,
        quads: tile.quads.map((q) => ({ ...q, color: COLORS[q.color] ?? q.color })),
      };
    }),
  });
}

/** A full-resolution PNG of one live frame — for eyeballing the renderer. */
function frameDataUrl(id, type = "image/png") {
  const frame = frames.get(id);
  if (frame === undefined) throw new Error(`no scene "${id}"`);
  return frame.toDataURL(type);
}

function reset() {
  for (const id of [...frames.keys()]) release(id);
  for (const bitmap of thumbs.values()) bitmap.close();
  thumbs.clear();
}

// `emulator` is the scene emulator itself, for a console or a one-off script.
window.__bench = { init, scene, load, detect: detectScene, evidence, refineLive, release, sheet, frameDataUrl, reset, selfCheck, emulator };
window.__benchReady = true;
