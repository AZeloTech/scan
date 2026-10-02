/**
 * F8 — occluded corners and overlapping sheets (5d+): something lies over the
 * page, and a corner the warp needs is under it.
 *
 * Built from a described field case (never from its photo): a thick stack of
 * white A4 on a brown leather desk mat with a stitched border, on wood; the
 * page mostly near-black image panels with white margins; another white
 * sheet — a folded leaflet, slightly curled — lying over the page's top-left
 * corner, white on white, its edge over the page only a faint shadow line;
 * the phone at 30–45° of tilt, warm light, the hand's shadow low on one side.
 *
 * A regression family like F7: the setting is assigned **by seed**, cycling
 * through {@link F8_SETTINGS}, so `--setting sheet-over --seeds 20` (or any
 * run of 6·k seeds) covers each evenly.
 *
 *  - `owner-case` — the field case as described: the corner nearest the
 *    image's top-left covered 8–15 % along the page's top edge and 15–25 %
 *    along its left; a stack 2–6 px thick showing on the image's right and
 *    bottom; imaging report; brown mat on wood; tilt 30–45°; 2700–3600 K;
 *    the hand's shadow low on the left;
 *  - `sheet-over` — the same idea, widened: any corner, 5–35 % along each
 *    edge meeting there, the sheet's own corner on the page turned up to 25°
 *    off it, flat or curled, contact shadow from none to soft; stack or a
 *    single sheet, desk mat on wood or any desk, imaging report or any
 *    paper document, tilt 0–45°;
 *  - `clipboard` — the page on a hardboard or plastic clipboard (a larger
 *    board under it all round), a metal or black clip over its top edge —
 *    mid-edge, or slid over one of its top corners;
 *  - `binder-clip` — a black binder clip over a corner (turned ~45°) or
 *    gripping an edge near one, its silver wire handles lying out past the
 *    page;
 *  - `staple` — a stapled packet: one to three sheets under the page fanned
 *    0.5–3 mm, a staple across a corner 4–10 mm in (the corner itself seen);
 *  - `two-sheets` — two full printed sheets overlapping: the scanned one
 *    under the other (a corner covered 15–60 % along each edge), or on top
 *    of it with the other peeking out.
 *
 * Every layer that lies over the page on purpose carries `occluder` (its
 * kind), so the ground truth lists it with its outline (`gt.occluders`);
 * the page's truth is its whole rectangle, hidden corner included, and
 * `gt.pages[i].occluded` names the corners in frame that are covered.
 * `occlusion` in the params says what was asked for: the corner, the
 * coverage fraction along each edge meeting there (the page's top/bottom
 * edge first, then its left/right), the sheet's turn.
 */

import { cameraFromPose, project } from "./camera.js";
import { documentStock } from "./documents.js";
import {
  anyDesk,
  framingCamera,
  indoorLighting,
  leatherDeskMat,
  lightWood,
  page,
  paperDocument,
  phoneSensor,
  pixelsPerMm,
} from "./kit.js";
import { registerFamily } from "./scene.js";

const DEG = Math.PI / 180;

/** The settings, in the order seeds cycle through them. */
export const F8_SETTINGS = ["owner-case", "sheet-over", "clipboard", "binder-clip", "staple", "two-sheets"];

/** Corner `c`'s signs in the page's own frame: TL, TR, BR, BL. */
const SIGNS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** A point in a layer's own frame → world mm on the desk. */
function toWorld(layer, [x, y]) {
  const a = (layer.rotation ?? 0) * DEG;
  return [layer.center[0] + Math.cos(a) * x - Math.sin(a) * y, layer.center[1] + Math.sin(a) * x + Math.cos(a) * y];
}

/** A world point → a layer's own frame. */
function toLocal(layer, [x, y]) {
  const a = (layer.rotation ?? 0) * DEG;
  const dx = x - layer.center[0];
  const dy = y - layer.center[1];
  return [Math.cos(a) * dx + Math.sin(a) * dy, -Math.sin(a) * dx + Math.cos(a) * dy];
}

/** The page's corners in the image (pixels), at its height. */
function pageCornersPx(pose, frame, layer) {
  const camera = cameraFromPose(pose, frame);
  const [hw, hh] = [layer.size[0] / 2, layer.size[1] / 2];
  return SIGNS.map(([sx, sy]) => {
    const [x, y] = toWorld(layer, [sx * hw, sy * hh]);
    const p = project(camera, [x, y, -(layer.height ?? 0)]);
    return [p.u, p.v];
  });
}

/** The page corner the image shows nearest its top-left. */
function cornerNearestImageTopLeft(pose, frame, layer) {
  const px = pageCornersPx(pose, frame, layer);
  let best = 0;
  for (let i = 1; i < 4; i += 1) if (px[i][0] + px[i][1] < px[best][0] + px[best][1]) best = i;
  return best;
}

function scene(rng, parts) {
  return {
    lighting: indoorLighting(rng.fork("light")),
    post: phoneSensor(rng.fork("sensor")),
    ...parts,
  };
}

/** The brown leather desk mat of the field case, its stitched border light enough to see. */
function brownMat(rng) {
  const mat = leatherDeskMat(rng, { center: [0, 0], rotation: 0 });
  mat.material.hide = rng.pick(["#3a2a21", "#4a3326", "#5a3b26", "#6b4429", "#55361f"]);
  mat.material.thread = rng.pick(["#c9b79c", "#a8957a", "#8a7d6b", "#d8cbb4"]);
  return mat;
}

/**
 * Lays `paper` on `mat`: the mat turned up to 10° off the page, its stitched
 * edge 15–120 mm past one side of the page (sometimes further, off the shot).
 */
function onMat(rng, mat, paper) {
  mat.rotation = paper.rotation + rng.range(-10, 10);
  const k = rng.int(0, 3);
  const [sx, sy] = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ][k];
  const reach = rng.chance(0.75) ? rng.range(15, 120) : rng.range(150, 260);
  const halfAcross = (sx !== 0 ? mat.size[0] : mat.size[1]) / 2;
  const pageHalf = (sx !== 0 ? paper.size[0] : paper.size[1]) / 2;
  const offset = pageHalf + reach - halfAcross;
  mat.center = toWorld(paper, [sx * offset + rng.range(-40, 40) * Math.abs(sy), sy * offset + rng.range(-40, 40) * Math.abs(sx)]);
  paper.height += mat.height;
  return k;
}

/**
 * The page as the top of a stack: a layer the page's size under it, a little
 * greyer (the stack's side face), offset towards corner `towards` by enough
 * millimetres to show 2–6 px of thickness in the image — a second edge
 * parallel to the page's, just outside it, on two sides. The page is lifted
 * by the stack's height and its own contact shadow made faint (it lies on
 * paper, not on the desk).
 */
function stackUnder(rng, paper, pose, frame, towards) {
  const [sx, sy] = SIGNS[towards];
  const ppm = pixelsPerMm(pose, frame, paper.center);
  const px = rng.range(2, 6);
  const mm = px / ppm;
  const thickness = rng.range(3, 12);
  const shade = rng.range(0.78, 0.92);
  const tint = paper.material.tint;
  const grey = `#${[1, 3, 5].map((i) => Math.round(parseInt(tint.slice(i, i + 2), 16) * shade).toString(16).padStart(2, "0")).join("")}`;
  const base = paper.height;
  const side = {
    name: "stack",
    material: { material: "paper", tint: grey, fibre: rng.range(0.08, 0.16), edge: rng.range(0.1, 0.25), seed: rng.seed32() },
    center: toWorld(paper, [sx * mm, sy * mm]),
    size: [...paper.size],
    rotation: paper.rotation + rng.range(-0.2, 0.2),
    radius: 0.3,
    height: base + thickness - 0.1,
    shadowHeight: thickness * rng.range(0.6, 1),
    shadowStrength: rng.range(0.25, 0.45),
    softness: rng.range(0.15, 0.3),
    wobble: rng.range(0.1, 0.3),
  };
  paper.height = base + thickness;
  paper.shadowStrength = rng.range(0.03, 0.1);
  paper.shadowHeight = rng.range(0.1, 0.4);
  return { layer: side, thicknessPx: px, thicknessMm: thickness, towards };
}

/**
 * Where a sheet lying over corner `c` of `paper` must have its own corner
 * `K` (page-local mm) so that its two sides through `K`, turned `phi`° off
 * the page's, cross the page's edges `along[0]` of the way along the
 * horizontal edge meeting at `c` and `along[1]` along the vertical one. `phi`
 * is clamped so `K` stays on the page (3 mm in at least).
 */
function sheetCorner(paper, c, along, phi) {
  const [W, H] = paper.size;
  const A = along[0] * W;
  const B = along[1] * H;
  // In the corner's own frame (a along the horizontal edge inwards, b along
  // the vertical one inwards): Ka + Kb·t = A and Kb − Ka·t = B.
  const limit = 0.8 * Math.min(A / B, B / A);
  const t = Math.max(-limit, Math.min(limit, Math.tan(phi * DEG)));
  const Ka = (A - B * t) / (1 + t * t);
  const Kb = (B + A * t) / (1 + t * t);
  return { Ka, Kb, t, phi: Math.atan(t) / DEG };
}

/**
 * A sheet (`size` mm) lying over corner `c` of `paper` with its own corner
 * at `Ka`, `Kb` in from the page's corner, its sides turned `atan(t)` off the
 * page's, reaching out past the page's corner: its centre and rotation.
 * `long` puts its long side along the page's horizontal edge.
 */
function placeSheet(paper, c, { Ka, Kb, t }, size, extra = [0, 0]) {
  const [hw, hh] = [paper.size[0] / 2, paper.size[1] / 2];
  const [sx, sy] = SIGNS[c];
  const C = [sx * hw, sy * hh];
  const ua = [-sx, 0];
  const ub = [0, -sy];
  const n = Math.hypot(1, t);
  const d1 = [1 / n, t / n];
  const d2 = [-t / n, 1 / n];
  // Long enough to reach past the page's edges on both sides of the corner.
  const L1 = Math.max(size[0], Ka * n + 20 + extra[0]);
  const L2 = Math.max(size[1], Kb * n + 20 + extra[1]);
  const centreAB = [Ka - (L1 / 2) * d1[0] - (L2 / 2) * d2[0], Kb - (L1 / 2) * d1[1] - (L2 / 2) * d2[1]];
  const local = [C[0] + centreAB[0] * ua[0] + centreAB[1] * ub[0], C[1] + centreAB[0] * ua[1] + centreAB[1] * ub[1]];
  const axis = [d1[0] * ua[0] + d1[1] * ub[0], d1[0] * ua[1] + d1[1] * ub[1]];
  return {
    center: toWorld(paper, local),
    rotation: paper.rotation + Math.atan2(axis[1], axis[0]) / DEG,
    size: [L1, L2],
    tip: toWorld(paper, [C[0] + Ka * ua[0] + Kb * ub[0], C[1] + Ka * ua[1] + Kb * ub[1]]),
  };
}

/**
 * A white sheet — a folded leaflet, or a plain sheet — lying over corner
 * `c` of `paper`, covering `along` of the two edges meeting there: flat or
 * curled, its contact shadow from none to soft. White on white more often
 * than not.
 */
function sheetOver(rng, paper, c, along, { phi, curlChance = 0.45, shadow = [0, 0.35] } = {}) {
  const geom = sheetCorner(paper, c, along, phi);
  const leaflet = rng.chance(0.6);
  const dims = leaflet ? [rng.range(100, 150), rng.range(148, 220)] : [210, 297];
  const turned = rng.chance(0.5) ? dims : [dims[1], dims[0]];
  const placed = placeSheet(paper, c, geom, turned, [rng.range(0, 60), rng.range(0, 60)]);
  const tint = rng.chance(0.7) ? paper.material.tint : rng.pick(documentStock("lab-report").tints);
  const shadowStrength = rng.chance(0.25) ? 0 : rng.range(shadow[0], shadow[1]);
  const layer = {
    name: "sheet-over",
    occluder: "sheet",
    material: {
      material: "paper",
      tint,
      fibre: rng.range(0.03, 0.07),
      edge: rng.range(0.03, 0.12),
      ...(leaflet && rng.chance(0.7)
        ? { crease: { offset: rng.range(-0.15, 0.15) * placed.size[0], angle: rng.pick([0, 90]) + rng.range(-2, 2), depth: rng.range(0.1, 0.35) } }
        : {}),
      seed: rng.seed32(),
    },
    center: placed.center,
    size: placed.size,
    rotation: placed.rotation,
    radius: 0.3,
    height: paper.height + rng.range(0.1, 0.5),
    shadowHeight: rng.range(0.3, 4),
    shadowStrength,
    softness: rng.range(0.15, 0.6),
    wobble: rng.range(0.1, 0.35),
  };
  let curl = null;
  if (rng.chance(curlChance)) {
    const axis = rng.pick(["x", "y"]);
    const extent = axis === "x" ? layer.size[0] : layer.size[1];
    const reach = Math.max(30, extent * rng.range(0.2, 0.45));
    curl = { mode: `edge-${axis}`, lift: Math.min(rng.range(3, 12), reach * 0.25), reach, side: rng.pick([-1, 1]) };
    layer.curl = curl;
  }
  return {
    layer,
    info: { corner: c, along, phi: geom.phi, tip: placed.tip, leaflet, curled: curl !== null, shadowStrength },
  };
}

/** A clip's plastic or metal body: a box of `size` mm at `height`. */
function clipBody(rng, name, { body, size, height, sheen }) {
  return {
    name,
    occluder: name,
    material: {
      material: "plastic",
      body,
      sheen,
      spine: body,
      spineWidth: 0,
      sheenAngle: rng.range(0, 180),
      peel: rng.range(0.02, 0.06),
      crease: -10000,
      seed: rng.seed32(),
    },
    center: [0, 0],
    size,
    rotation: 0,
    radius: Math.min(size[0], size[1]) * 0.1,
    height,
    shadowHeight: height,
    shadowStrength: rng.range(0.35, 0.55),
    softness: 0.3,
  };
}

/** The desk: a brown mat on wood (`matShare` of the time), else any desk. */
function deskFor(rng, matShare) {
  if (rng.chance(matShare)) return { desk: "mat-on-wood", background: lightWood(rng), mat: brownMat(rng.fork("mat")) };
  const d = anyDesk(rng);
  return { desk: d.kind, background: d.surface, mat: null };
}

/* ── the settings ───────────────────────────────────────────────────────── */

const RECIPES = {
  "owner-case"(rng, frame) {
    const layout = rng.fork("layout");
    const wood = rng.fork("background");
    const background = lightWood(wood);
    const mat = brownMat(rng.fork("mat"));
    const paper = page(rng.fork("page"), { type: "imaging-report", rotation: layout.range(-8, 8), curl: 0, crease: 0 });
    onMat(layout, mat, paper);
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, paper, {
      coverage: cameraRng.range(0.35, 0.6),
      tilt: [30, 45],
      marginFraction: 0.05,
    });
    // The corner the image shows top-left, as in the field case.
    const c = cornerNearestImageTopLeft(camera, frame, paper);
    const stack = stackUnder(rng.fork("stack"), paper, camera, frame, (c + 2) % 4);
    const over = rng.fork("over");
    // "Top" and "left" as the image shows them: the page's horizontal edge
    // is the image's top edge when the page is upright in it.
    const px = pageCornersPx(camera, frame, paper);
    const horizontalIsTop = Math.abs(px[c][1] - px[(c + (c % 2 === 0 ? 1 : 3)) % 4][1]) < Math.abs(px[c][0] - px[(c + (c % 2 === 0 ? 1 : 3)) % 4][0]);
    const top = over.range(0.08, 0.15);
    const left = over.range(0.15, 0.25);
    const along = horizontalIsTop ? [top, left] : [left, top];
    const sheet = sheetOver(over, paper, c, along, { phi: over.range(-12, 12), curlChance: 0.7, shadow: [0.05, 0.2] });
    const scale = Math.min(frame.width, frame.height);
    const fx = rng.fork("fx");
    const hand = {
      kind: "shadow",
      center: [fx.range(-0.1, 0.15) * frame.width, fx.range(0.75, 1.0) * frame.height],
      radius: [scale * fx.range(0.35, 0.6), scale * fx.range(0.2, 0.3)],
      angle: fx.range(-35, 5),
      strength: fx.range(0.25, 0.5),
      softness: fx.range(0.6, 0.9),
    };
    const light = rng.fork("light");
    return {
      lighting: indoorLighting(light, { temperature: [2700, 3600] }),
      post: phoneSensor(rng.fork("sensor")),
      desk: "mat-on-wood",
      camera,
      background,
      layers: [mat, stack.layer, paper, sheet.layer],
      blobs: [hand],
      occlusion: { kind: "sheet", ...sheet.info, stackPx: stack.thicknessPx },
    };
  },

  "sheet-over"(rng, frame) {
    const layout = rng.fork("layout");
    const { desk, background, mat } = deskFor(rng.fork("background"), 0.6);
    const type = layout.chance(0.6) ? "imaging-report" : paperDocument(layout);
    const paper = page(rng.fork("page"), { type, rotation: layout.range(-15, 15), curl: 0, crease: 0 });
    if (mat !== null) onMat(layout, mat, paper);
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, paper, {
      coverage: cameraRng.range(0.3, 0.65),
      tilt: [0, 45],
      marginFraction: 0.05,
    });
    const over = rng.fork("over");
    const c = over.int(0, 3);
    const stack = over.chance(0.5) ? stackUnder(rng.fork("stack"), paper, camera, frame, over.int(0, 3)) : null;
    const along = [over.range(0.05, 0.35), over.range(0.05, 0.35)];
    const sheet = sheetOver(over, paper, c, along, { phi: over.range(-25, 25) });
    return scene(rng, {
      desk,
      camera,
      background,
      layers: [...(mat === null ? [] : [mat]), ...(stack === null ? [] : [stack.layer]), paper, sheet.layer],
      occlusion: { kind: "sheet", ...sheet.info, stackPx: stack?.thicknessPx ?? 0 },
    });
  },

  clipboard(rng, frame) {
    const layout = rng.fork("layout");
    const d = anyDesk(rng.fork("background"));
    const paper = page(rng.fork("page"), { type: paperDocument(layout), rotation: layout.range(-12, 12), curl: 0, crease: 0 });
    const kit = rng.fork("clipboard");
    const hard = kit.chance(0.6);
    const margin = [kit.range(6, 14), kit.range(4, 12), kit.range(6, 14), kit.range(30, 45)]; // left, bottom, right, top (under the clip)
    const board = {
      name: "clipboard",
      material: hard
        ? { material: "paper", tint: kit.pick(["#7a5a3a", "#8b6a45", "#6a4c30"]), fibre: kit.range(0.08, 0.15), edge: 0.2, seed: kit.seed32() }
        : {
            material: "plastic",
            body: kit.pick(["#2a5caa", "#1c1c1e", "#5b5f66", "#a3262a", "#d9d9d6"]),
            sheen: kit.range(0.2, 0.6),
            spine: "#202020",
            spineWidth: 0,
            sheenAngle: kit.range(0, 180),
            peel: 0.05,
            crease: -10000,
            seed: kit.seed32(),
          },
      center: toWorld(paper, [(margin[2] - margin[0]) / 2, (margin[1] - margin[3]) / 2]),
      size: [paper.size[0] + margin[0] + margin[2], paper.size[1] + margin[1] + margin[3]],
      rotation: paper.rotation + kit.range(-1.5, 1.5),
      radius: kit.range(3, 10),
      height: 3,
      shadowHeight: 3,
      shadowStrength: kit.range(0.3, 0.5),
      softness: 0.3,
    };
    paper.height += board.height;
    const metal = kit.chance(0.6);
    const clip = clipBody(kit, "clipboard-clip", {
      body: metal ? kit.pick(["#b8bcc2", "#a9adb3", "#c9ccd1"]) : kit.pick(["#151515", "#1d1d1f"]),
      size: [kit.range(85, 115), kit.range(28, 42)],
      height: paper.height + kit.range(6, 12),
      sheen: metal ? kit.range(0.6, 1.2) : kit.range(0.2, 0.5),
    });
    // Over the top edge: mid-edge, or slid out over one of the top corners.
    const overCorner = kit.chance(0.5);
    const grip = kit.range(12, 28);
    const [hw, hh] = [paper.size[0] / 2, paper.size[1] / 2];
    const slide = overCorner ? kit.pick([-1, 1]) * (hw - clip.size[0] / 2 + kit.range(8, clip.size[0] * 0.35)) : kit.range(-30, 30);
    clip.center = toWorld(paper, [slide, -hh + grip - clip.size[1] / 2]);
    clip.rotation = paper.rotation + kit.range(-3, 3);
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, board, { coverage: cameraRng.range(0.3, 0.6), tilt: [0, 40], marginFraction: 0.04 });
    return scene(rng, {
      desk: d.kind,
      camera,
      background: d.surface,
      layers: [board, paper, clip],
      occlusion: { kind: "clipboard-clip", overCorner, corner: overCorner ? (slide < 0 ? 0 : 1) : -1, grip },
    });
  },

  "binder-clip"(rng, frame) {
    const layout = rng.fork("layout");
    const { desk, background, mat } = deskFor(rng.fork("background"), 0.4);
    const paper = page(rng.fork("page"), { type: paperDocument(layout), rotation: layout.range(-15, 15), curl: 0, crease: 0 });
    if (mat !== null) onMat(layout, mat, paper);
    const kit = rng.fork("clip");
    const c = kit.int(0, 3);
    const [sx, sy] = SIGNS[c];
    const [hw, hh] = [paper.size[0] / 2, paper.size[1] / 2];
    const width = kit.pick([19, 25, 32, 41]);
    const depth = width * kit.range(0.45, 0.6);
    const onCorner = kit.chance(0.6);
    const clip = clipBody(kit, "binder-clip", {
      body: kit.pick(["#111111", "#151515", "#1b1b1d", "#2a2a2a"]),
      size: [width, depth],
      height: paper.height + kit.range(8, 14),
      sheen: kit.range(0.4, 0.9),
    });
    // Its jaw along the clip's long side: the side away from the page lies
    // `out` mm past the page's edge (or corner), the rest grips the paper.
    const out = kit.range(1, 4);
    let outward;
    if (onCorner) {
      outward = [sx / Math.SQRT2, sy / Math.SQRT2];
      // Turned so its long side runs across the corner's diagonal.
      const across = Math.atan2(outward[1], outward[0]) / DEG + 90;
      clip.rotation = paper.rotation + across + kit.range(-12, 12);
      // The corner sits inside the jaw, `depth`·(0.3–0.6) in from the clip's outer side.
      const inset = depth * kit.range(0.3, 0.6);
      const centre = [sx * hw + outward[0] * (inset - depth / 2), sy * hh + outward[1] * (inset - depth / 2)];
      clip.center = toWorld(paper, centre);
    } else {
      // On the horizontal or vertical edge meeting at c, 5–25 mm from the corner.
      const horizontal = kit.chance(0.5);
      const from = kit.range(5, 25) + width / 2;
      outward = horizontal ? [0, sy] : [sx, 0];
      const centre = horizontal
        ? [sx * (hw - from), sy * (hh + out - depth / 2)]
        : [sx * (hw + out - depth / 2), sy * (hh - from)];
      clip.rotation = paper.rotation + (horizontal ? 0 : 90) + kit.range(-6, 6);
      clip.center = toWorld(paper, centre);
    }
    // The handles: two silver wires folded out past the page.
    const handles = [-1, 1].map((side) => {
      const wire = clipBody(kit, "binder-handle", {
        body: kit.pick(["#c4c7cc", "#b0b4ba"]),
        size: [width * 0.9, 1.6],
        height: clip.height - 2,
        sheen: 1.2,
      });
      const a = clip.rotation * DEG;
      const n = [outward[0], outward[1]];
      const nWorld = [Math.cos(paper.rotation * DEG) * n[0] - Math.sin(paper.rotation * DEG) * n[1], Math.sin(paper.rotation * DEG) * n[0] + Math.cos(paper.rotation * DEG) * n[1]];
      const along = [Math.cos(a), Math.sin(a)];
      const reach = depth / 2 + kit.range(10, 22);
      wire.center = [clip.center[0] + nWorld[0] * reach + along[0] * side * width * 0.05, clip.center[1] + nWorld[1] * reach + along[1] * side * width * 0.05];
      wire.rotation = clip.rotation + side * kit.range(4, 12);
      wire.radius = 0.6;
      return wire;
    });
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, paper, { coverage: cameraRng.range(0.3, 0.6), tilt: [0, 40], marginFraction: 0.07 });
    return scene(rng, {
      desk,
      camera,
      background,
      layers: [...(mat === null ? [] : [mat]), paper, clip, ...handles],
      occlusion: { kind: "binder-clip", corner: c, onCorner, width },
    });
  },

  staple(rng, frame) {
    const layout = rng.fork("layout");
    const d = anyDesk(rng.fork("background"));
    const paper = page(rng.fork("page"), { type: paperDocument(layout), rotation: layout.range(-15, 15), curl: 0, crease: 0 });
    const kit = rng.fork("packet");
    const c = kit.int(0, 3);
    const [sx, sy] = SIGNS[c];
    const [hw, hh] = [paper.size[0] / 2, paper.size[1] / 2];
    const sheets = kit.int(1, 3);
    const below = [];
    for (let i = 0; i < sheets; i += 1) {
      // Fanned about the staple: turned a little about the stapled corner.
      const turn = kit.range(-1.5, 1.5);
      const C = toWorld(paper, [sx * hw, sy * hh]);
      const shiftLocal = [kit.range(-3, 3), kit.range(-3, 3)];
      const a = (paper.rotation + turn) * DEG;
      const centreFromCorner = [-sx * hw, -sy * hh];
      below.push({
        name: "sheet-below",
        material: { material: "paper", tint: paper.material.tint, fibre: paper.material.fibre, edge: kit.range(0.05, 0.12), seed: kit.seed32() },
        center: [
          C[0] + Math.cos(a) * centreFromCorner[0] - Math.sin(a) * centreFromCorner[1] + shiftLocal[0] * 0.2,
          C[1] + Math.sin(a) * centreFromCorner[0] + Math.cos(a) * centreFromCorner[1] + shiftLocal[1] * 0.2,
        ],
        size: [...paper.size],
        rotation: paper.rotation + turn,
        radius: 0.3,
        height: 0.1 * (sheets - i),
        shadowHeight: kit.range(0.3, 1.2),
        shadowStrength: kit.range(0.12, 0.3),
        softness: kit.range(0.12, 0.25),
        wobble: kit.range(0.15, 0.4),
      });
    }
    paper.height += 0.1 * sheets;
    const inset = kit.range(4, 10);
    const staple = clipBody(kit, "staple", { body: kit.pick(["#c8cbd0", "#b5b9bf", "#9ea2a8"]), size: [12.5, 0.7], height: paper.height + 0.3, sheen: 1.4 });
    staple.radius = 0.3;
    staple.shadowStrength = kit.range(0.2, 0.35);
    staple.shadowHeight = 0.3;
    staple.center = toWorld(paper, [sx * (hw - inset), sy * (hh - inset)]);
    staple.rotation = paper.rotation + (sx * sy > 0 ? -45 : 45) + kit.range(-15, 15);
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, paper, { coverage: cameraRng.range(0.3, 0.6), tilt: [0, 40], marginFraction: 0.05 });
    return scene(rng, {
      desk: d.kind,
      camera,
      background: d.surface,
      layers: [...below.reverse(), paper, staple],
      occlusion: { kind: "staple", corner: c, sheets, inset },
    });
  },

  "two-sheets"(rng, frame) {
    const layout = rng.fork("layout");
    const { desk, background, mat } = deskFor(rng.fork("background"), 0.4);
    const paper = page(rng.fork("page"), { type: paperDocument(layout), rotation: layout.range(-15, 15), curl: 0, crease: 0 });
    if (mat !== null) onMat(layout, mat, paper);
    const pair = rng.fork("pair");
    const scannedUnder = pair.chance(0.65);
    const c = pair.int(0, 3);
    const along = [pair.range(0.15, 0.6), pair.range(0.15, 0.6)];
    const geom = sheetCorner(paper, c, along, pair.range(-25, 25));
    const other = page(rng.fork("other"), {
      type: pair.pick(["lab-report", "letter", "form", "imaging-report"]),
      curl: 0,
      crease: 0,
    });
    const placed = placeSheet(paper, c, geom, other.size);
    other.center = placed.center;
    other.rotation = placed.rotation;
    other.size = [...other.size];
    let layers;
    let primaryPage;
    if (scannedUnder) {
      other.height = paper.height + other.height;
      other.occluder = "page";
      layers = [...(mat === null ? [] : [mat]), paper, other];
      primaryPage = 0;
    } else {
      // The scanned page on top: the other only peeks out from under it.
      paper.height += other.height;
      other.height = paper.height - 0.1;
      layers = [...(mat === null ? [] : [mat]), other, paper];
      primaryPage = 1;
    }
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, paper, { coverage: cameraRng.range(0.3, 0.55), tilt: [0, 40], marginFraction: 0.06 });
    return scene(rng, {
      desk,
      camera,
      background,
      layers,
      primaryPage,
      occlusion: { kind: "page", scannedUnder, corner: scannedUnder ? c : -1, along, phi: geom.phi },
    });
  },
};

registerFamily({
  id: "F8",
  title: "occluded corners, overlapping sheets",
  describe:
    "a white sheet over a corner of a stacked imaging report on a desk mat (the field case, and widened), " +
    "a clipboard clip, a binder clip, a staple, two overlapping printed sheets",
  sample(rng, { frame, seed = 1 }) {
    const count = F8_SETTINGS.length;
    const setting = F8_SETTINGS[(((seed - 1) % count) + count) % count];
    return { setting, ...RECIPES[setting](rng, frame) };
  },
});
