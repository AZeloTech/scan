/**
 * F7 — refine-adversarial: scenes built to pull a refined side off the page.
 *
 * The capture-time edge refinement (`src/lib/refine.ts`) snaps each side of
 * the detector's quad to the outermost straight edge nearby that has paper
 * just inside it and — for the model's quads — searches out to 18 % of the
 * diagonal when paper-coloured surface lies beyond. Every setting here offers
 * it a straight, parallel, believable edge where the page's edge is not, or
 * takes the page's own edge away. Most attack one side of the page, the
 * **target** (`target`, 0–3 = top, right, bottom, left of the page itself;
 * `gapFrac`, where there is one, is how far off it the distractor lies, as a
 * fraction of the frame diagonal).
 *
 * A regression family, not a random sample: the setting is assigned by seed,
 * cycling through {@link F7_SETTINGS} (seed 1 the first, seed 33 the first
 * again), so any run of 32·k seeds covers every setting k times.
 *
 * Beside the page, mostly 0.5–4 % of the diagonal outside the target side —
 * inside the refinement's local band — and, where the page's edge can look
 * like paper meeting paper, further out too, where only its wide search
 * reaches:
 *  - `mat-edge` — a leather desk mat's edge, the page on the mat or beside it;
 *  - `folder` — a folder a little larger than the page under it: four
 *    parallel edges, each 0.5–5 % out;
 *  - `table-edge` — the page near the edge of a white, grey or wooden table
 *    (some white ones the page's own white), a dark floor beyond (half the
 *    time 4–12 % out);
 *  - `white-board` — a white board, plastic folder or blank sheet under the
 *    page, larger all round: paper-coloured surface past every edge (the
 *    target side half the time 4–12 % out);
 *  - `parallel-object` — a pen, a ruler, a keyboard, a notebook or a phone
 *    lying along the side;
 *  - `shadow-out` — a hard cast-shadow edge on the desk, parallel to the side
 *    (sometimes 4–12 % out);
 *  - `neighbour` — a second document (a receipt, a note, a card) beside the
 *    side, a gap of 0.3–6 % between them, turned up to 15°;
 *  - `stacked` — a sheet of the same stock under the page, offset 0.3–10 %
 *    (a fanned pile), the top sheet's contact shadow faint;
 *  - `striped-cloth` — a tablecloth striped white and grey, the stripes
 *    parallel to the side (half the time 4–20° off it): every white
 *    stripe's far edge has paper just inside it;
 *  - `tiles` — a white tiled counter: grout lines 100–200 mm apart, the grid
 *    square to the page or not;
 *  - `compound` — a white table (often the page's own white) whose edge, or
 *    a hard shadow's, lies 3–12 % outside the side, while a thumb or a lamp's
 *    glare weakens the page's own edge there.
 *
 * On the page:
 *  - `shadow-in` — a hard cast-shadow edge across the page 1–6 % inside the
 *    side, the margin beyond it (and the desk) in shade;
 *  - `margin-rule` — a header bar, table rules and a footer rule a few
 *    millimetres inside the edges (document `edge-ruled`);
 *  - `bleed-band` — a dark band printed to the edge (document `bleed-band`),
 *    mostly on a dark desk;
 *  - `crease` — a flattened fold parallel to the side, 3–18 mm in, on a grey
 *    or white table as often as not;
 *  - `glare-edge` — a lamp's hot spot saturating the side;
 *  - `blind-shadow` — sunlight through a blind: hard bands of shade across
 *    page and table, parallel to the side.
 *
 * The edge itself:
 *  - `white-on-white` — a white page on a table of its own colour: a thin
 *    contact shadow is all the edge there is;
 *  - `finger-edge` — a thumb (sometimes one on each side) over the side;
 *  - `curl` — a strongly curled edge (lift 11–30 mm) or a rolled sheet;
 *  - `dog-ear` — a corner folded over onto the page, or torn off;
 *  - `receipt-tear` — a till receipt whose end was torn off the roll,
 *    serrated or ragged.
 *
 * Field cases the refinement was reviewed against (appended; seeds 23+):
 *  - `dark-stock` — navy or black card stock printed in white (often with a
 *    white panel), a kraft envelope with a white label, a dark ID card — on a
 *    white, grey or wooden table; beyond it nothing, a dark object, the
 *    table's own edge, or both on two sides;
 *  - `black-table` — a white page on a black table or a black leather mat
 *    whose edge lies 3–12 % out, often with a white sheet, receipt or card
 *    beyond the page lying across that edge;
 *  - `form-border` — a form inside a printed border 3–8 mm from the edges,
 *    its code in the margin outside it (document `bordered-form`);
 *  - `stack-offset` — one or two sheets of the same stock under the page,
 *    offset 1–5 mm along both axes, either way;
 *  - `screen` — a document shown on a tablet or a phone: a bezel of black,
 *    white or silver, the viewer's bars above and below the page;
 *  - `booklet` — the right-hand page of an open, thick booklet: the facing
 *    page past the spine, a gutter shadow, the page block's edges and the
 *    cover around the outer sides, the page often lifted at the spine;
 *  - `curled-receipt` — a till receipt rolled along its length or across,
 *    or curling up at one end: its sides are not straight;
 *  - `jpeg-strong`, `sharpen-halo`, `clipped-highlights` — a plain page shot
 *    through a phone's processing: JPEG at quality 0.2–0.45, an unsharp mask
 *    (halos either side of every edge), a gain clipping paper and white
 *    tables to 255.
 *
 * The truth is the page's rectangle as everywhere else: a torn-off corner is
 * where its two edges meet (and is not `visible`), a curled page's corners
 * are its lifted corners; on a screen, the page as the viewer shows it.
 */

import { cameraFromPose, project } from "./camera.js";
import { documentStock } from "./documents.js";
import { fingerOver } from "./effects.js";
import {
  anyDesk,
  darkGranite,
  fabric,
  folder,
  framingCamera,
  glare,
  indoorLighting,
  leatherDeskMat,
  lightWood,
  makeProp,
  page,
  paleTable,
  paperDocument,
  phoneSensor,
  pixelsPerMm,
} from "./kit.js";
import { registerFamily } from "./scene.js";

/** The settings, in the order seeds cycle through them. */
export const F7_SETTINGS = [
  "mat-edge",
  "folder",
  "table-edge",
  "white-board",
  "parallel-object",
  "shadow-out",
  "neighbour",
  "stacked",
  "striped-cloth",
  "tiles",
  "compound",
  "shadow-in",
  "margin-rule",
  "bleed-band",
  "crease",
  "glare-edge",
  "blind-shadow",
  "white-on-white",
  "finger-edge",
  "curl",
  "dog-ear",
  "receipt-tear",
  // The field cases of the refinement's external review (adv-p2), appended
  // so seeds 1–22 keep their settings.
  "dark-stock",
  "black-table",
  "form-border",
  "stack-offset",
  "screen",
  "booklet",
  "curled-receipt",
  "jpeg-strong",
  "sharpen-halo",
  "clipped-highlights",
];

const DEG = Math.PI / 180;

/* ── geometry in the page's own frame ───────────────────────────────────── */

/**
 * Side `k` of a layer in its own frame (TL→TR, TR→BR, BR→BL, BL→TL): outward
 * normal, direction along it, half-extents across and along it.
 */
function sideOf(layer, k) {
  const hw = layer.size[0] / 2;
  const hh = layer.size[1] / 2;
  return [
    { n: [0, -1], t: [1, 0], across: hh, along: hw },
    { n: [1, 0], t: [0, 1], across: hw, along: hh },
    { n: [0, 1], t: [-1, 0], across: hh, along: hw },
    { n: [-1, 0], t: [0, -1], across: hw, along: hh },
  ][k];
}

/** A point in a layer's own frame → world mm on the desk. */
function toWorld(layer, [x, y]) {
  const a = (layer.rotation ?? 0) * DEG;
  return [layer.center[0] + Math.cos(a) * x - Math.sin(a) * y, layer.center[1] + Math.sin(a) * x + Math.cos(a) * y];
}

/** A point in a layer's own frame, at the layer's height → image pixels. */
function toPixel(camera, layer, point) {
  const [x, y] = toWorld(layer, point);
  const p = project(camera, [x, y, -(layer.height ?? 0)]);
  return [p.u, p.v];
}

/** Millimetres of desk that `fraction` of the frame diagonal spans at the middle of side `k`. */
function mmFor(pose, frame, layer, k, fraction) {
  const s = sideOf(layer, k);
  const middle = toWorld(layer, [s.n[0] * s.across, s.n[1] * s.across]);
  return (fraction * Math.hypot(frame.width, frame.height)) / pixelsPerMm(pose, frame, middle);
}

/**
 * The centre (world mm) that puts a rectangle's edge facing side `k` of
 * `pageLayer` `gap` mm outside that side — reaching back `under` the page, or
 * lying beside it — slid `slide` mm along the side. `halfAcross` is the
 * rectangle's half-extent along the side's normal.
 */
function placeOff(pageLayer, k, gap, halfAcross, slide, under) {
  const s = sideOf(pageLayer, k);
  const offset = under ? s.across + gap - halfAcross : s.across + gap + halfAcross;
  return toWorld(pageLayer, [s.n[0] * offset + s.t[0] * slide, s.n[1] * offset + s.t[1] * slide]);
}

/**
 * A long thing laid along side `k` with its long axis along the side: the
 * rotation to add to the page's, and its half-extents across and along.
 */
function alongSide(k, size) {
  const longX = size[0] >= size[1];
  return {
    turn: (k % 2 === 0) === longX ? 0 : 90,
    halfAcross: Math.min(size[0], size[1]) / 2,
    halfAlong: Math.max(size[0], size[1]) / 2,
  };
}

/** A few tenths of a degree off parallel — never enough to close a `gap` over half a side of `along`. */
function offParallel(rng, gap, along) {
  return rng.range(-1, 1) * Math.min(1.2, Math.atan((0.4 * gap) / along) / DEG);
}

/** The page's corners in the image, its centroid, and side `k`'s middle and outward normal there. */
function sideInImage(pose, frame, layer, k) {
  const camera = cameraFromPose(pose, frame);
  const hw = layer.size[0] / 2;
  const hh = layer.size[1] / 2;
  const px = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map((p) => toPixel(camera, layer, p));
  const centre = px.reduce((sum, p) => [sum[0] + p[0] / 4, sum[1] + p[1] / 4], [0, 0]);
  const [a, b] = [px[k], px[(k + 1) % 4]];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dir = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let normal = [-dir[1], dir[0]];
  if ((middle[0] - centre[0]) * normal[0] + (middle[1] - centre[1]) * normal[1] < 0) normal = [-normal[0], -normal[1]];
  return { camera, px, centre, a, b, dir, middle, normal, length };
}

/**
 * A hard-edged cast shadow over everything past a straight line in the image
 * (pixels): through `at`, shade on the side `normal` points to. An ellipse so
 * large that its rim is straight to a pixel or two across the frame;
 * `softPx` is the half-width of the penumbra.
 */
function shadowEdge(frame, at, normal, { strength, softPx }) {
  const reach = Math.hypot(frame.width, frame.height);
  const across = reach * 2;
  const along = reach * 25;
  return {
    kind: "shadow",
    center: [at[0] + normal[0] * across, at[1] + normal[1] * across],
    radius: [across, along],
    angle: Math.atan2(normal[1], normal[0]) / DEG,
    strength,
    softness: softPx / across,
  };
}

function rotate([x, y], degrees) {
  const a = degrees * DEG;
  return [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y];
}

/* ── shared pieces ──────────────────────────────────────────────────────── */

function paperPage(rng, layout, options = {}) {
  return page(rng.fork("page"), {
    type: options.type ?? paperDocument(layout),
    rotation: layout.range(-12, 12),
    height: options.height ?? 0,
    curl: 0,
    crease: 0,
  });
}

/** A handheld framing of the page, with room around it for what lies beside it. */
function frameIt(rng, frame, target, { coverage = [0.22, 0.5], marginFraction = 0.09 } = {}) {
  const cameraRng = rng.fork("camera");
  return framingCamera(cameraRng, frame, target, {
    coverage: cameraRng.range(coverage[0], coverage[1]),
    tilt: [0, 18],
    marginFraction,
  });
}

function scene(rng, parts) {
  return {
    lighting: indoorLighting(rng.fork("light")),
    post: phoneSensor(rng.fork("sensor")),
    ...parts,
  };
}

/** The white or grey table the low-contrast attacks want, as often as not. */
function paleOrAny(rng, share = 0.6) {
  if (rng.chance(share)) {
    const grey = rng.chance(0.35);
    return { desk: grey ? "grey" : "white", background: paleTable(rng, { grey }) };
  }
  const desk = anyDesk(rng);
  return { desk: desk.kind, background: desk.surface };
}

/** A prop made of plain plastic: a pen, a ruler. */
function plasticStick(rng, { body, size, height, sheen }) {
  return {
    name: "stick",
    material: {
      material: "plastic",
      body,
      sheen,
      spine: body,
      spineWidth: 0,
      sheenAngle: rng.range(0, 180),
      peel: rng.range(0.02, 0.08),
      // The folder material's crease, put far outside the stick.
      crease: -10000,
      seed: rng.seed32(),
    },
    center: [0, 0],
    size,
    rotation: 0,
    radius: Math.min(size[0], size[1]) * 0.4,
    height,
    shadowHeight: height,
    shadowStrength: rng.range(0.35, 0.55),
    softness: 0.3,
  };
}

/** A table top the page lies on (1.6 × 1 m of `surface`, its shadow on the floor below). */
function tableUnder(rng, surface) {
  return {
    name: "table",
    material: surface,
    center: [0, 0],
    size: [1600, 1000],
    rotation: 0,
    radius: 3,
    height: 0.5,
    shadowHeight: rng.range(4, 12),
    shadowStrength: rng.range(0.3, 0.5),
    softness: 0.6,
  };
}

/** Puts the table's edge `gap` mm outside side `k` of the page on it, all but parallel to it. */
function placeTable(rng, table, paper, k, gap) {
  const s = sideOf(paper, k);
  table.rotation = paper.rotation + offParallel(rng, gap, s.along);
  table.center = placeOff(paper, k, gap, table.size[k % 2 === 1 ? 0 : 1] / 2, rng.range(-200, 200), true);
}

/** A white table of the page's own white: the page's edge is a faint contact shadow and nothing else. */
function sameWhite(rng, paper) {
  paper.shadowStrength = rng.range(0.1, 0.25);
  paper.shadowHeight = rng.range(0.4, 1.2);
  return {
    material: "laminate",
    color: paper.material.tint,
    mottle: rng.range(0.02, 0.05),
    speckle: rng.range(0, 0.05),
    streak: rng.range(0, 0.04),
    streakAngle: rng.range(0, 180),
    sheen: rng.range(0, 0.03),
    seed: rng.seed32(),
  };
}

/** A hard cast-shadow edge `gapFrac` of the diagonal outside side `k`, parallel to it, the shade beyond. */
function shadowBeyond(fx, frame, camera, paper, k, gapFrac) {
  const side = sideInImage(camera, frame, paper, k);
  const normal = rotate(side.normal, fx.range(-0.4, 0.4));
  const gapPx = gapFrac * Math.hypot(frame.width, frame.height);
  const at = [side.middle[0] + side.normal[0] * gapPx, side.middle[1] + side.normal[1] * gapPx];
  const scale = Math.min(frame.width, frame.height) / 1080;
  return shadowEdge(frame, at, normal, { strength: fx.range(0.25, 0.55), softPx: fx.range(1.5, 6) * scale });
}

/* ── the settings ───────────────────────────────────────────────────────── */

const RECIPES = {
  "mat-edge"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const under = layout.chance(0.6);
    const deskRng = rng.fork("background");
    const white = deskRng.chance(0.4);
    const background = white ? paleTable(deskRng, { grey: deskRng.chance(0.3) }) : lightWood(deskRng);
    const mat = leatherDeskMat(rng.fork("mat"), { center: [0, 0], rotation: 0 });
    const paper = paperPage(rng, layout, { height: under ? mat.height : 0 });
    const camera = frameIt(rng, frame, paper);
    const gapFrac = layout.range(0.005, 0.04);
    const gap = mmFor(camera, frame, paper, k, gapFrac);
    const s = sideOf(paper, k);
    const acrossAxis = k % 2 === 1 ? 0 : 1;
    if (under) mat.size[acrossAxis] = Math.max(mat.size[acrossAxis], 2 * s.across + gap + layout.range(40, 150));
    const halfAcross = mat.size[acrossAxis] / 2;
    const halfAlong = mat.size[1 - acrossAxis] / 2;
    mat.rotation = paper.rotation + offParallel(layout, gap, s.along);
    mat.center = placeOff(paper, k, gap, halfAcross, layout.range(-1, 1) * Math.max(0, halfAlong - s.along - 20), under);
    return scene(rng, {
      target: k,
      gapFrac,
      desk: white ? "white" : "wood",
      matUnder: under,
      camera,
      background,
      layers: [mat, paper],
    });
  },

  folder(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const desk = anyDesk(rng.fork("background"));
    const under = folder(rng.fork("folder"), { center: [0, 0], rotation: 0 });
    const paper = paperPage(rng, layout, { height: under.height });
    const camera = frameIt(rng, frame, paper);
    const gapFrac = layout.range(0.005, 0.04);
    // Top, right, bottom, left: the target side at gapFrac, the others anywhere in 0.5–5 %.
    const margins = [0, 1, 2, 3].map((j) => mmFor(camera, frame, paper, j, j === k ? gapFrac : layout.range(0.005, 0.05)));
    const [hw, hh] = [paper.size[0] / 2, paper.size[1] / 2];
    under.size = [2 * hw + margins[1] + margins[3], 2 * hh + margins[0] + margins[2]];
    under.center = toWorld(paper, [(margins[1] - margins[3]) / 2, (margins[2] - margins[0]) / 2]);
    under.rotation = paper.rotation + offParallel(layout, Math.min(...margins), Math.max(hw, hh));
    return scene(rng, { target: k, gapFrac, desk: desk.kind, camera, background: desk.surface, layers: [under, paper] });
  },

  "table-edge"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const floorRng = rng.fork("background");
    const background = floorRng.chance(0.5) ? darkGranite(floorRng) : fabric(floorRng);
    const top = rng.fork("table");
    const kind = top.weighted([
      ["same-white", 3],
      ["white", 2],
      ["grey", 1],
      ["wood", 2],
    ]);
    const paper = paperPage(rng, layout, { height: 0.5 });
    const surface =
      kind === "same-white" ? sameWhite(top, paper) : kind === "wood" ? lightWood(top) : paleTable(top, { grey: kind === "grey" });
    const table = tableUnder(top, surface);
    const camera = frameIt(rng, frame, paper);
    const gapFrac = layout.chance(0.5) ? layout.range(0.005, 0.04) : layout.range(0.04, 0.12);
    placeTable(layout, table, paper, k, mmFor(camera, frame, paper, k, gapFrac));
    return scene(rng, { target: k, gapFrac, desk: kind, camera, background, layers: [table, paper] });
  },

  "white-board"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const deskRng = rng.fork("background");
    const deskKind = deskRng.pick(["granite", "wood", "fabric"]);
    const background = deskKind === "granite" ? darkGranite(deskRng) : deskKind === "wood" ? lightWood(deskRng) : fabric(deskRng);
    const b = rng.fork("board");
    const kind = b.pick(["laminate", "sheet", "plastic"]);
    const material =
      kind === "laminate"
        ? paleTable(b)
        : kind === "sheet"
          ? { material: "paper", tint: b.pick(documentStock("lab-report").tints), fibre: b.range(0.03, 0.06), edge: b.range(0.05, 0.1), seed: b.seed32() }
          : {
              material: "plastic",
              body: b.pick(["#ecebe6", "#f2f1ec", "#e4e6e8"]),
              sheen: b.range(0.1, 0.4),
              spine: "#e0e0dc",
              spineWidth: 0,
              sheenAngle: b.range(0, 180),
              peel: 0.05,
              crease: -10000,
              seed: b.seed32(),
            };
    const height = kind === "laminate" ? 3 : kind === "sheet" ? 0.1 : 1;
    const board = {
      name: "board",
      material,
      center: [0, 0],
      size: [0, 0],
      rotation: 0,
      radius: kind === "sheet" ? 0.3 : b.range(2, 6),
      height,
      shadowHeight: height + b.range(0.3, 1),
      shadowStrength: b.range(0.25, 0.45),
      softness: 0.2,
    };
    const paper = paperPage(rng, layout, { height });
    const camera = frameIt(rng, frame, paper);
    const gapFrac = layout.chance(0.5) ? layout.range(0.005, 0.04) : layout.range(0.04, 0.12);
    const margins = [0, 1, 2, 3].map((j) => mmFor(camera, frame, paper, j, j === k ? gapFrac : layout.range(0.005, 0.05)));
    const [hw, hh] = [paper.size[0] / 2, paper.size[1] / 2];
    board.size = [2 * hw + margins[1] + margins[3], 2 * hh + margins[0] + margins[2]];
    board.center = toWorld(paper, [(margins[1] - margins[3]) / 2, (margins[2] - margins[0]) / 2]);
    board.rotation = paper.rotation + offParallel(layout, Math.min(...margins), Math.max(hw, hh));
    return scene(rng, { target: k, gapFrac, desk: deskKind, board: kind, camera, background, layers: [board, paper] });
  },

  "parallel-object"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const desk = anyDesk(rng.fork("background"));
    const paper = paperPage(rng, layout);
    const camera = frameIt(rng, frame, paper);
    const gapFrac = layout.range(0.005, 0.04);
    const gap = mmFor(camera, frame, paper, k, gapFrac);
    const o = rng.fork("object");
    const kind = o.pick(["pen", "ruler", "keyboard", "notebook", "phone"]);
    const thing =
      kind === "pen"
        ? plasticStick(o, { body: o.pick(["#1d3f8f", "#151515", "#e8e8e8", "#b0b3b8", "#8c1d1d"]), size: [o.range(130, 150), o.range(8, 11)], height: 9, sheen: o.range(0.5, 1) })
        : kind === "ruler"
          ? plasticStick(o, { body: o.pick(["#e9e9e4", "#d9dde0", "#b9bcc0"]), size: [300, o.range(25, 32)], height: 2, sheen: o.range(0.2, 0.6) })
          : makeProp(kind, o, { center: [0, 0], rotation: 0 });
    const s = sideOf(paper, k);
    const fit = alongSide(k, thing.size);
    thing.rotation = paper.rotation + fit.turn + offParallel(o, gap, fit.halfAlong);
    const room = Math.abs(s.along - fit.halfAlong) * 0.8;
    thing.center = placeOff(paper, k, gap, fit.halfAcross, layout.range(-1, 1) * room, false);
    // Above the page in the stack: a tall object's shadow may fall across its edge.
    return scene(rng, { target: k, gapFrac, desk: desk.kind, object: kind, camera, background: desk.surface, layers: [paper, thing] });
  },

  "shadow-out"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const { desk, background } = paleOrAny(rng.fork("background"));
    const paper = paperPage(rng, layout);
    const camera = frameIt(rng, frame, paper);
    const gapFrac = layout.chance(0.6) ? layout.range(0.005, 0.04) : layout.range(0.04, 0.12);
    const blobs = [shadowBeyond(rng.fork("fx"), frame, camera, paper, k, gapFrac)];
    return scene(rng, { target: k, gapFrac, desk, camera, background, layers: [paper], blobs });
  },

  neighbour(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const desk = anyDesk(rng.fork("background"));
    const paper = paperPage(rng, layout);
    const camera = frameIt(rng, frame, paper);
    const gapFrac = layout.range(0.003, 0.06);
    const gap = mmFor(camera, frame, paper, k, gapFrac);
    const other = page(rng.fork("second"), {
      type: layout.pick(["receipt", "note", "id-card", "receipt", "note"]),
      rotation: 0,
      curl: 0,
    });
    const s = sideOf(paper, k);
    const fit = alongSide(k, other.size);
    // Parallel half the time; otherwise turned (up to 15°) about its corner nearest the page, clear of it.
    const turned = layout.chance(0.5) ? 0 : layout.range(-15, 15);
    other.rotation = paper.rotation + fit.turn + (turned === 0 ? offParallel(layout, gap, fit.halfAlong) : turned);
    const room = Math.max(0, s.along - fit.halfAlong) * 0.8;
    const lift = Math.abs(Math.sin(turned * DEG)) * fit.halfAlong;
    other.center = placeOff(paper, k, gap + lift, fit.halfAcross / Math.max(0.5, Math.cos(turned * DEG)), layout.range(-1, 1) * room, false);
    return scene(rng, {
      target: k,
      gapFrac,
      desk: desk.kind,
      neighbour: other.document.type,
      camera,
      background: desk.surface,
      layers: [paper, other],
      primaryPage: 0,
    });
  },

  stacked(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const desk = anyDesk(rng.fork("background"));
    const paper = paperPage(rng, layout);
    const look = rng.fork("stack");
    // The top sheet barely lifts off the one below: its contact shadow is faint.
    paper.shadowStrength = look.range(0.06, 0.2);
    paper.shadowHeight = look.range(0.3, 0.9);
    paper.softness = look.range(0.15, 0.3);
    const below = {
      name: "sheet-below",
      material: {
        material: "paper",
        tint: look.chance(0.7) ? paper.material.tint : look.pick(documentStock("lab-report").tints),
        fibre: paper.material.fibre,
        edge: look.range(0.05, 0.12),
        seed: look.seed32(),
      },
      center: [0, 0],
      size: [...paper.size],
      rotation: 0,
      radius: 0.3,
      height: 0.1,
      shadowHeight: look.range(0.6, 2),
      shadowStrength: look.range(0.2, 0.4),
      softness: look.range(0.12, 0.25),
      wobble: look.range(0.15, 0.4),
    };
    paper.height += below.height;
    const camera = frameIt(rng, frame, paper);
    const gapFrac = layout.chance(0.5) ? layout.range(0.003, 0.035) : layout.range(0.035, 0.1);
    const j = (k + (layout.chance(0.5) ? 1 : 3)) % 4;
    const out = mmFor(camera, frame, paper, k, gapFrac);
    const sideways = mmFor(camera, frame, paper, j, layout.range(-0.02, 0.02));
    const [nk, nj] = [sideOf(paper, k).n, sideOf(paper, j).n];
    below.center = toWorld(paper, [nk[0] * out + nj[0] * sideways, nk[1] * out + nj[1] * sideways]);
    below.rotation = paper.rotation + offParallel(layout, out, sideOf(paper, k).along);
    return scene(rng, { target: k, gapFrac, desk: desk.kind, camera, background: desk.surface, layers: [below, paper] });
  },

  "striped-cloth"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const paper = paperPage(rng, layout);
    const cloth = rng.fork("background");
    // The pale stripes are the paper's own white; the others ~14 % darker.
    const white = cloth.pick(documentStock("lab-report").tints);
    const background = {
      material: "fabric",
      warp: white,
      weft: cloth.pick([white, "#e9e6dd", "#eeeeea"]),
      pitch: cloth.range(0.5, 1),
      contrast: cloth.range(0.1, 0.35),
      wrinkle: cloth.range(0.02, 0.08),
      // Parallel to the side half the time; otherwise up to 20° off it.
      angle: paper.rotation + (k % 2 === 0 ? 0 : 90) + (cloth.chance(0.5) ? cloth.range(-3, 3) : cloth.pick([-1, 1]) * cloth.range(4, 20)),
      stripe: cloth.range(5, 20),
      seed: cloth.seed32(),
    };
    const camera = frameIt(rng, frame, paper);
    return scene(rng, { target: k, desk: "striped", camera, background, layers: [paper] });
  },

  "blind-shadow"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const { desk, background } = paleOrAny(rng.fork("background"), 0.8);
    const paper = paperPage(rng, layout);
    const camera = frameIt(rng, frame, paper);
    const side = sideInImage(camera, frame, paper, k);
    const fx = rng.fork("fx");
    const diagonal = Math.hypot(frame.width, frame.height);
    const period = fx.range(0.03, 0.07) * diagonal;
    const half = (fx.range(0.35, 0.6) * period) / 2;
    const normal = rotate(side.normal, fx.range(-3, 3));
    const phase = fx.range(-0.5, 0.5) * period;
    const strength = fx.range(0.15, 0.4);
    const softPx = fx.range(2, 8) * (Math.min(frame.width, frame.height) / 1080);
    // Four slats' shade, straddling the side: bands, not half-planes — an
    // ellipse as long as twenty-five frames is straight across this one.
    const blobs = [0, 1, 2, 3].map((i) => {
      const offset = phase + (i - 1.5) * period;
      return {
        kind: "shadow",
        center: [side.middle[0] + normal[0] * offset, side.middle[1] + normal[1] * offset],
        radius: [half, diagonal * 25],
        angle: Math.atan2(normal[1], normal[0]) / DEG,
        strength,
        softness: softPx / half,
      };
    });
    return scene(rng, { target: k, desk, camera, background, layers: [paper], blobs });
  },

  tiles(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const t = rng.fork("background");
    const background = paleTable(t, { grey: t.chance(0.25) });
    const paper = paperPage(rng, layout);
    const camera = frameIt(rng, frame, paper);
    // A tiled counter: grout lines every 100–200 mm, the grid square to the
    // page (within 5°) or anywhere. Four lines each way around the page.
    const tile = t.range(100, 200);
    const turn = paper.rotation + (t.chance(0.6) ? t.range(-5, 5) : t.range(0, 90));
    const grout = t.range(2, 4);
    const colour = t.pick(["#9a9892", "#b7b4ac", "#8a8f94", "#c4c1ba"]);
    const phase = [t.range(0, tile), t.range(0, tile)];
    const layers = [];
    for (const across of [0, 1]) {
      for (let i = -2; i <= 1; i += 1) {
        const offset = phase[across] + i * tile;
        const local = across === 0 ? [offset, 0] : [0, offset];
        const a = turn * DEG;
        layers.push({
          name: "grout",
          material: { material: "solid", color: colour, mottle: 0.1, seed: t.seed32() },
          center: [paper.center[0] + Math.cos(a) * local[0] - Math.sin(a) * local[1], paper.center[1] + Math.sin(a) * local[0] + Math.cos(a) * local[1]],
          size: across === 0 ? [grout, 3000] : [3000, grout],
          rotation: turn,
          radius: 0,
          height: 0,
          shadowHeight: 0,
          shadowStrength: 0,
          softness: 0.3,
        });
      }
    }
    paper.height += 0.05;
    return scene(rng, { target: k, desk: "tiles", tileMm: tile, camera, background, layers: [...layers, paper] });
  },

  compound(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const top = rng.fork("table");
    const paper = paperPage(rng, layout, { height: 0.5 });
    const same = top.chance(0.6);
    const surface = same ? sameWhite(top, paper) : paleTable(top);
    const camera = frameIt(rng, frame, paper);
    const gapFrac = layout.range(0.03, 0.12);
    const fx = rng.fork("fx");
    // What lies beyond the side: the table's own edge, or a hard shadow's.
    const beyond = fx.pick(["table-edge", "shadow-edge"]);
    // And what weakens the page's own edge there: a thumb, a lamp's glare, nothing.
    const weakener = fx.pick(["finger", "glare", "none"]);
    const layers = [paper];
    const blobs = [];
    const effects = [];
    let background = surface;
    if (beyond === "table-edge") {
      const floor = rng.fork("floor");
      background = floor.chance(0.5) ? darkGranite(floor) : fabric(floor);
      const table = tableUnder(top, surface);
      placeTable(layout, table, paper, k, mmFor(camera, frame, paper, k, gapFrac));
      layers.unshift(table);
    } else {
      blobs.push(shadowBeyond(fx, frame, camera, paper, k, gapFrac));
    }
    const side = sideInImage(camera, frame, paper, k);
    const t = fx.range(0.3, 0.7);
    const on = [side.a[0] + (side.b[0] - side.a[0]) * t, side.a[1] + (side.b[1] - side.a[1]) * t];
    if (weakener === "finger") {
      const s = sideOf(paper, k);
      const world = toWorld(paper, [s.n[0] * s.across, s.n[1] * s.across]);
      effects.push(fingerOver(fx, frame, on, pixelsPerMm(camera, frame, world), side.centre));
    } else if (weakener === "glare") {
      const hot = glare(fx, frame, on);
      hot.center = on;
      hot.strength = fx.range(0.8, 1.4);
      blobs.push(hot);
    }
    return scene(rng, {
      target: k,
      gapFrac,
      desk: same ? "same-white" : "white",
      beyond,
      weakener,
      camera,
      background,
      layers,
      blobs,
      effects,
    });
  },

  "shadow-in"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const { desk, background } = paleOrAny(rng.fork("background"));
    const paper = paperPage(rng, layout);
    const camera = frameIt(rng, frame, paper);
    const side = sideInImage(camera, frame, paper, k);
    const fx = rng.fork("fx");
    const diagonal = Math.hypot(frame.width, frame.height);
    // How deep the page runs from this side, in pixels: the shadow stops well short of the far side.
    const depthPx = Math.min(
      ...side.px.map((p) => (side.middle[0] - p[0]) * side.normal[0] + (side.middle[1] - p[1]) * side.normal[1]).filter((d) => d > 1),
    );
    const inFrac = Math.min(layout.range(0.01, 0.06), (0.35 * depthPx) / diagonal);
    const normal = rotate(side.normal, fx.range(-0.4, 0.4));
    const at = [side.middle[0] - side.normal[0] * inFrac * diagonal, side.middle[1] - side.normal[1] * inFrac * diagonal];
    const scale = Math.min(frame.width, frame.height) / 1080;
    const blobs = [shadowEdge(frame, at, normal, { strength: fx.range(0.2, 0.45), softPx: fx.range(1.5, 6) * scale })];
    return scene(rng, { target: k, gapFrac: -inFrac, desk, camera, background, layers: [paper], blobs });
  },

  "margin-rule"(rng, frame) {
    const layout = rng.fork("layout");
    const desk = anyDesk(rng.fork("background"));
    const paper = paperPage(rng, layout, { type: "edge-ruled" });
    const camera = frameIt(rng, frame, paper, { marginFraction: 0.04 });
    return scene(rng, { target: -1, desk: desk.kind, camera, background: desk.surface, layers: [paper] });
  },

  "bleed-band"(rng, frame) {
    const layout = rng.fork("layout");
    const deskRng = rng.fork("background");
    const dark = deskRng.chance(0.5);
    const desk = dark ? { kind: "granite", surface: darkGranite(deskRng) } : anyDesk(deskRng);
    const paper = paperPage(rng, layout, { type: "bleed-band" });
    const camera = frameIt(rng, frame, paper, { marginFraction: 0.04 });
    return scene(rng, { target: -1, desk: desk.kind, camera, background: desk.surface, layers: [paper] });
  },

  crease(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const deskRng = rng.fork("background");
    const pick = deskRng.weighted([
      ["grey", 2],
      ["white", 1],
      ["any", 2],
    ]);
    const desk = pick === "any" ? anyDesk(deskRng) : { kind: pick, surface: paleTable(deskRng, { grey: pick === "grey" }) };
    const paper = paperPage(rng, layout);
    const fold = rng.fork("fold");
    const s = sideOf(paper, k);
    const inset = fold.range(3, 18);
    // Mostly the strip between fold and edge is the half turned from the light.
    const darkStrip = fold.chance(0.7);
    const n = darkStrip ? s.n : [-s.n[0], -s.n[1]];
    paper.material.crease = {
      offset: darkStrip ? s.across - inset : -(s.across - inset),
      angle: Math.atan2(n[1], n[0]) / DEG + fold.range(-1, 1),
      depth: fold.range(0.3, 0.6),
    };
    const camera = frameIt(rng, frame, paper, { marginFraction: 0.04 });
    return scene(rng, { target: k, foldMm: inset, darkStrip, desk: desk.kind, camera, background: desk.surface, layers: [paper] });
  },

  "glare-edge"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const { desk, background } = paleOrAny(rng.fork("background"), 0.5);
    const paper = paperPage(rng, layout);
    const camera = frameIt(rng, frame, paper, { marginFraction: 0.04 });
    const side = sideInImage(camera, frame, paper, k);
    const fx = rng.fork("fx");
    const t = fx.range(0.25, 0.75);
    const on = [side.a[0] + (side.b[0] - side.a[0]) * t, side.a[1] + (side.b[1] - side.a[1]) * t];
    const hot = glare(fx, frame, on);
    const reach = Math.min(frame.width, frame.height);
    hot.center = [on[0] + fx.range(-0.02, 0.02) * reach, on[1] + fx.range(-0.02, 0.02) * reach];
    hot.strength = fx.range(1.0, 1.8);
    return scene(rng, { target: k, desk, camera, background, layers: [paper], blobs: [hot] });
  },

  "white-on-white"(rng, frame) {
    const layout = rng.fork("layout");
    const paper = paperPage(rng, layout);
    const look = rng.fork("look");
    paper.shadowStrength = look.range(0.12, 0.3);
    paper.shadowHeight = look.range(0.4, 1.2);
    paper.softness = look.range(0.15, 0.3);
    paper.material.edge = look.range(0.04, 0.1);
    const background = {
      material: "laminate",
      color: paper.material.tint,
      mottle: look.range(0.02, 0.05),
      speckle: look.range(0, 0.05),
      streak: look.range(0, 0.04),
      streakAngle: look.range(0, 180),
      sheen: look.range(0, 0.03),
      seed: look.seed32(),
    };
    const camera = frameIt(rng, frame, paper, { marginFraction: 0.04 });
    const parts = scene(rng, { target: -1, desk: "same-white", camera, background, layers: [paper] });
    parts.lighting.gradient.amount *= 0.5;
    return parts;
  },

  "finger-edge"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const desk = anyDesk(rng.fork("background"));
    const paper = paperPage(rng, layout);
    const camera = frameIt(rng, frame, paper, { marginFraction: 0.04 });
    const fx = rng.fork("fx");
    const effects = [];
    const sides = fx.chance(0.35) ? [k, (k + 2) % 4] : [k];
    for (const j of sides) {
      const side = sideInImage(camera, frame, paper, j);
      const t = fx.range(0.3, 0.7);
      const target = [side.a[0] + (side.b[0] - side.a[0]) * t, side.a[1] + (side.b[1] - side.a[1]) * t];
      const s = sideOf(paper, j);
      const world = toWorld(paper, [s.n[0] * s.across, s.n[1] * s.across]);
      effects.push(fingerOver(fx, frame, target, pixelsPerMm(camera, frame, world), side.centre));
    }
    return scene(rng, { target: k, desk: desk.kind, camera, background: desk.surface, layers: [paper], effects });
  },

  curl(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const desk = anyDesk(rng.fork("background"));
    const paper = paperPage(rng, layout);
    const shape = rng.fork("curl");
    if (shape.chance(0.65)) {
      const axis = k % 2 === 0 ? "y" : "x";
      const extent = axis === "x" ? paper.size[0] : paper.size[1];
      const reach = Math.min(extent * 0.5, shape.range(60, 120));
      // The renderer walks rays onto the curl; a lift of a quarter of its reach is as steep as it takes.
      paper.curl = { mode: `edge-${axis}`, lift: reach * shape.range(0.18, 0.25), reach, side: k === 0 || k === 3 ? -1 : 1 };
    } else {
      const axis = shape.pick(["x", "y"]);
      const half = (axis === "x" ? paper.size[0] : paper.size[1]) / 2;
      paper.curl = { mode: `roll-${axis}`, lift: half * shape.range(0.12, 0.25), reach: 1, side: 1 };
    }
    paper.shadowHeight += paper.curl.lift * 0.3;
    const camera = frameIt(rng, frame, paper, { marginFraction: 0.04 });
    return scene(rng, { target: k, curlMode: paper.curl.mode, desk: desk.kind, camera, background: desk.surface, layers: [paper] });
  },

  "dog-ear"(rng, frame) {
    const layout = rng.fork("layout");
    const c = layout.int(0, 3);
    const desk = anyDesk(rng.fork("background"));
    const paper = paperPage(rng, layout);
    // Room around the page: the torn-off corner shows desk cloned from beyond it.
    const camera = frameIt(rng, frame, paper, { marginFraction: 0.12 });
    const cam = cameraFromPose(camera, frame);
    const ear = rng.fork("ear");
    const torn = ear.chance(0.4);
    const [hw, hh] = [paper.size[0] / 2, paper.size[1] / 2];
    const [sx, sy] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ][c];
    const ra = ear.range(12, 32);
    const rb = ra * ear.range(0.8, 1.25);
    const C = [sx * hw, sy * hh];
    const A = [C[0] - sx * ra, C[1]];
    const B = [C[0], C[1] - sy * rb];
    const margin = 4;
    const cut = [];
    if (torn) {
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const across = [-(B[1] - A[1]) / len, (B[0] - A[0]) / len];
      const pieces = ear.int(6, 10);
      for (let i = pieces - 1; i >= 1; i -= 1) {
        const t = i / pieces;
        const wiggle = ear.range(-1.8, 1.8);
        cut.push([A[0] + (B[0] - A[0]) * t + across[0] * wiggle, A[1] + (B[1] - A[1]) * t + across[1] * wiggle]);
      }
    }
    const polygon = [A, [A[0], A[1] + sy * margin], [C[0] + sx * margin, C[1] + sy * margin], [B[0] + sx * margin, B[1]], B, ...cut];
    const reach = Math.SQRT2 * (Math.max(ra, rb) / 2 + 8) + margin;
    const from = toPixel(cam, paper, C);
    const to = toPixel(cam, paper, [C[0] + (sx * reach) / Math.SQRT2, C[1] + (sy * reach) / Math.SQRT2]);
    const effects = [
      { type: "patch", polygon: polygon.map((p) => toPixel(cam, paper, p)), shift: [to[0] - from[0], to[1] - from[1]] },
    ];
    if (!torn) {
      // The flap: the corner reflected across the fold A–B, lying on the page.
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const u = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
      const v = [C[0] - A[0], C[1] - A[1]];
      const along = v[0] * u[0] + v[1] * u[1];
      const F = [A[0] + 2 * along * u[0] - v[0], A[1] + 2 * along * u[1] - v[1]];
      const S = [F[0] + (F[0] - C[0]) * 0.35, F[1] + (F[1] - C[1]) * 0.35];
      const scale = Math.min(frame.width, frame.height) / 1080;
      const drop = ear.range(0, Math.PI * 2);
      effects.push({
        type: "flap",
        polygon: [A, B, F].map((p) => toPixel(cam, paper, p)),
        sample: toPixel(cam, paper, S),
        shade: [ear.range(0.78, 0.88), ear.range(0.9, 0.98)],
        shadow: {
          dx: Math.cos(drop) * ear.range(2, 6) * scale,
          dy: Math.sin(drop) * ear.range(2, 6) * scale,
          blur: ear.range(3, 6) * scale,
          alpha: ear.range(0.2, 0.35),
        },
        seed: ear.seed32(),
      });
    }
    return scene(rng, { target: c, corner: c, torn, desk: desk.kind, camera, background: desk.surface, layers: [paper], effects });
  },

  "receipt-tear"(rng, frame) {
    const layout = rng.fork("layout");
    const desk = anyDesk(rng.fork("background"));
    const paper = page(rng.fork("page"), { type: "receipt", rotation: layout.range(-15, 15), curl: 0 });
    const camera = frameIt(rng, frame, paper, { coverage: [0.15, 0.4], marginFraction: 0.1 });
    const cam = cameraFromPose(camera, frame);
    const tear = rng.fork("tear");
    const ends = tear.chance(0.4) ? [0, 2] : [tear.pick([0, 2])];
    const margin = 3;
    const effects = [];
    for (const k of ends) {
      const s = sideOf(paper, k);
      const serrated = tear.chance(0.5);
      const pitch = tear.range(2.5, 4);
      const amp = tear.range(0.8, 2);
      const phase = tear.range(0, pitch);
      const step = serrated ? pitch / 2 : tear.range(1.5, 3);
      let d = tear.range(0.5, 2);
      let deepest = 0;
      const inner = [];
      for (let x = s.along + margin; x >= -(s.along + margin); x -= step) {
        if (serrated) {
          const f = (((x - phase) / pitch) % 1 + 1) % 1;
          d = amp * Math.abs(f - 0.5) * 2 + 0.2;
        } else {
          d = Math.max(0.2, Math.min(4.5, d + tear.normal(0, 0.9)));
        }
        deepest = Math.max(deepest, d);
        inner.push([s.n[0] * (s.across - d) + s.t[0] * x, s.n[1] * (s.across - d) + s.t[1] * x]);
      }
      const outer = (x) => [s.n[0] * (s.across + margin) + s.t[0] * x, s.n[1] * (s.across + margin) + s.t[1] * x];
      const polygon = [outer(-(s.along + margin)), outer(s.along + margin), ...inner];
      const reach = deepest + margin + 6;
      const edge = [s.n[0] * s.across, s.n[1] * s.across];
      const from = toPixel(cam, paper, edge);
      const to = toPixel(cam, paper, [edge[0] + s.n[0] * reach, edge[1] + s.n[1] * reach]);
      effects.push({ type: "patch", polygon: polygon.map((p) => toPixel(cam, paper, p)), shift: [to[0] - from[0], to[1] - from[1]], serrated });
    }
    return scene(rng, { target: ends[0], ends, desk: desk.kind, camera, background: desk.surface, layers: [paper], effects });
  },

  /* ── field cases (adv-p2) ── */

  "dark-stock"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const deskRng = rng.fork("background");
    const pale = deskRng.chance(0.7);
    const surface = pale ? paleTable(deskRng, { grey: deskRng.chance(0.25) }) : lightWood(deskRng);
    const type = layout.weighted([
      ["dark-stock", 3],
      ["kraft-envelope", 2],
      ["dark-card", 2],
    ]);
    const paper = paperPage(rng, layout, { type, height: 0.5 });
    const camera = frameIt(rng, frame, paper);
    // Beyond the page: nothing; a dark object off side k; the table's own
    // edge off side k; or both — the object off k, the edge off a side next
    // to it, so two sides have something straight past them.
    const beyond = layout.pick(["none", "object", "table-edge", "both"]);
    const layers = [paper];
    let background = surface;
    let gapFrac = null;
    let edgeSide = null;
    if (beyond === "object" || beyond === "both") {
      gapFrac = layout.range(0.02, 0.12);
      layers.push(darkThingBeside(rng.fork("object"), layout, camera, frame, paper, k, gapFrac));
    }
    if (beyond === "table-edge" || beyond === "both") {
      edgeSide = beyond === "both" ? (k + (layout.chance(0.5) ? 1 : 3)) % 4 : k;
      const edgeFrac = layout.range(0.03, 0.12);
      if (beyond === "table-edge") gapFrac = edgeFrac;
      const floor = rng.fork("floor");
      background = floor.chance(0.5) ? darkGranite(floor) : fabric(floor);
      const table = tableUnder(rng.fork("table"), surface);
      placeTable(layout, table, paper, edgeSide, mmFor(camera, frame, paper, edgeSide, edgeFrac));
      layers.unshift(table);
    }
    return scene(rng, { target: k, gapFrac, stock: type, beyond, edgeSide, desk: pale ? "pale" : "wood", camera, background, layers });
  },

  "black-table"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const surf = rng.fork("background");
    const surface = surf.pick(["laminate", "mat"]);
    const paper = paperPage(rng, layout, { height: surface === "mat" ? 2.5 : 0.5 });
    const camera = frameIt(rng, frame, paper);
    // Where the black ends: its edge edgeFrac of the diagonal past side k.
    const edgeFrac = layout.range(0.03, 0.12);
    const edgeGap = mmFor(camera, frame, paper, k, edgeFrac);
    let background;
    let black;
    if (surface === "laminate") {
      background = surf.weighted([
        ["pale", 2],
        ["wood", 1],
        ["fabric", 1],
      ]);
      background = background === "pale" ? paleTable(surf) : background === "wood" ? lightWood(surf) : fabric(surf);
      black = tableUnder(surf, {
        material: "laminate",
        color: surf.pick(["#101012", "#151517", "#1a1a1c", "#121417"]),
        mottle: surf.range(0.05, 0.12),
        speckle: surf.range(0, 0.05),
        streak: surf.range(0, 0.06),
        streakAngle: surf.range(0, 180),
        sheen: surf.range(0.05, 0.2),
        seed: surf.seed32(),
      });
      placeTable(layout, black, paper, k, edgeGap);
    } else {
      background = surf.chance(0.5) ? paleTable(surf) : lightWood(surf);
      black = leatherDeskMat(rng.fork("mat"), { center: [0, 0], rotation: 0 });
      black.material.hide = surf.pick(["#161617", "#1b1a1a", "#121315", "#1a1c20"]);
      const s = sideOf(paper, k);
      const acrossAxis = k % 2 === 1 ? 0 : 1;
      black.size[acrossAxis] = Math.max(black.size[acrossAxis], 2 * s.across + edgeGap + layout.range(40, 150));
      black.size[1 - acrossAxis] = Math.max(black.size[1 - acrossAxis], 2 * s.along + 80);
      const halfAlong = black.size[1 - acrossAxis] / 2;
      black.rotation = paper.rotation + offParallel(layout, edgeGap, s.along);
      black.center = placeOff(paper, k, edgeGap, black.size[acrossAxis] / 2, layout.range(-1, 1) * Math.max(0, halfAlong - s.along - 20), true);
    }
    const layers = [black, paper];
    // A white thing past the page, lying across the black's edge (or short
    // of it): its far edge has paper inside and — past the edge — not black
    // outside.
    let nearFrac = null;
    let white = "none";
    if (layout.chance(0.65)) {
      nearFrac = layout.range(0.012, Math.max(0.015, edgeFrac - 0.01));
      const nearGap = mmFor(camera, frame, paper, k, nearFrac);
      white = layout.pick(["letter", "receipt", "note", "id-card"]);
      const other = page(rng.fork("second"), { type: white, rotation: 0, curl: 0, height: black.height });
      const s = sideOf(paper, k);
      const fit = alongSide(k, other.size);
      other.rotation = paper.rotation + fit.turn + offParallel(layout, nearGap, fit.halfAlong);
      other.center = placeOff(paper, k, nearGap, fit.halfAcross, layout.range(-1, 1) * Math.abs(s.along - fit.halfAlong) * 0.8, false);
      layers.push(other);
    }
    return scene(rng, {
      target: k,
      gapFrac: nearFrac ?? edgeFrac,
      edgeFrac,
      surface,
      white,
      camera,
      background,
      layers,
      primaryPage: 0,
    });
  },

  "form-border"(rng, frame) {
    const layout = rng.fork("layout");
    const { desk, background } = paleOrAny(rng.fork("background"), 0.4);
    const paper = paperPage(rng, layout, { type: "bordered-form" });
    const camera = frameIt(rng, frame, paper, { marginFraction: 0.04 });
    return scene(rng, { target: -1, desk, camera, background, layers: [paper] });
  },

  "stack-offset"(rng, frame) {
    const layout = rng.fork("layout");
    const k = layout.int(0, 3);
    const desk = anyDesk(rng.fork("background"));
    const paper = paperPage(rng, layout);
    const look = rng.fork("stack");
    paper.shadowStrength = look.range(0.05, 0.18);
    paper.shadowHeight = look.range(0.2, 0.7);
    paper.softness = look.range(0.12, 0.3);
    // Past side k by 1–5 mm, and along side j's normal by 1–5 mm either way:
    // past side j, or past the side across from it.
    const j = (k + (layout.chance(0.5) ? 1 : 3)) % 4;
    const out = layout.range(1, 5);
    const sideways = layout.range(1, 5) * (layout.chance(0.5) ? 1 : -1);
    const sheets = layout.chance(0.3) ? 2 : 1;
    const [nk, nj] = [sideOf(paper, k).n, sideOf(paper, j).n];
    const below = [];
    for (let i = 0; i < sheets; i += 1) {
      const step = i === 0 ? 1 : look.range(1.6, 2.2);
      below.push({
        name: "sheet-below",
        material: {
          material: "paper",
          tint: look.chance(0.75) ? paper.material.tint : look.pick(documentStock("lab-report").tints),
          fibre: paper.material.fibre,
          edge: look.range(0.05, 0.12),
          seed: look.seed32(),
        },
        center: toWorld(paper, [nk[0] * out * step + nj[0] * sideways * step, nk[1] * out * step + nj[1] * sideways * step]),
        size: [...paper.size],
        rotation: paper.rotation + look.range(-0.3, 0.3),
        radius: 0.3,
        height: 0.1 * (sheets - i),
        shadowHeight: look.range(0.3, 1.2),
        shadowStrength: look.range(0.12, 0.3),
        softness: look.range(0.12, 0.25),
        wobble: look.range(0.15, 0.4),
      });
    }
    paper.height += 0.1 * sheets;
    const camera = frameIt(rng, frame, paper);
    return scene(rng, {
      target: k,
      side: j,
      offsetMm: [out, sideways],
      sheets,
      desk: desk.kind,
      camera,
      background: desk.surface,
      layers: [...below.reverse(), paper],
    });
  },

  screen(rng, frame) {
    const layout = rng.fork("layout");
    const desk = anyDesk(rng.fork("background"));
    const dev = rng.fork("device");
    const tablet = dev.chance(0.6);
    const screenW = tablet ? dev.range(135, 175) : dev.range(62, 72);
    const screenH = screenW * (tablet ? dev.range(1.33, 1.6) : dev.range(2.0, 2.2));
    const bezel = tablet ? dev.range(5, 20) : dev.range(2, 5);
    const body = dev.pick(["#111113", "#1b1c1e", "#0c0c0d", "#e9e9e6", "#c9cacc"]);
    const rotation = layout.range(-15, 15);
    const thickness = tablet ? 7 : 8.5;
    const device = {
      name: tablet ? "tablet" : "phone",
      material: {
        material: "plastic",
        body,
        sheen: dev.range(0.1, 0.4),
        spine: body,
        spineWidth: 0,
        sheenAngle: dev.range(0, 180),
        peel: 0.02,
        crease: -10000,
        seed: dev.seed32(),
      },
      center: [0, 0],
      size: [screenW + 2 * bezel, screenH + 2 * bezel],
      rotation,
      radius: tablet ? dev.range(6, 12) : dev.range(7, 10),
      height: thickness,
      shadowHeight: thickness,
      shadowStrength: dev.range(0.3, 0.5),
      softness: 0.4,
    };
    // The viewer: its bars (dark or light) fill the screen; the page fits
    // the screen's width (or its height), scrolled a little off centre.
    const chrome = dev.pick(["#2b2c2f", "#1f1f22", "#f2f2f2", "#dcdcdc"]);
    const glass = {
      name: "screen",
      material: { material: "solid", color: chrome, mottle: 0.01, seed: dev.seed32() },
      center: [0, 0],
      size: [screenW, screenH],
      rotation,
      radius: tablet ? 1 : 4,
      height: thickness + 0.01,
      shadowHeight: 0,
      shadowStrength: 0,
      softness: 0.08,
    };
    const shown = page(rng.fork("page"), { type: paperDocument(layout), rotation, height: thickness + 0.02, curl: 0, crease: 0 });
    const aspect = shown.size[1] / shown.size[0];
    let pageW = screenW * dev.range(0.94, 1);
    let pageH = pageW * aspect;
    if (pageH > screenH * 0.97) {
      pageH = screenH * 0.97;
      pageW = pageH / aspect;
    }
    const scroll = dev.range(-0.5, 0.5) * (screenH - pageH);
    shown.size = [pageW, pageH];
    shown.center = toWorld(glass, [0, scroll]);
    shown.material = { ...shown.material, tint: dev.pick(["#f4f6fa", "#f7f7f7", "#f2f4f7"]), fibre: 0, edge: 0 };
    shown.radius = 0;
    shown.wobble = 0;
    shown.softness = 0.08;
    shown.shadowHeight = 0;
    shown.shadowStrength = 0;
    const camera = frameIt(rng, frame, shown, { marginFraction: 0.06 });
    const blobs = [];
    const fx = rng.fork("fx");
    if (fx.chance(0.4)) {
      // A reflection on the glass: the room's window or lamp.
      const side = sideInImage(camera, frame, shown, fx.int(0, 3));
      const t = fx.range(0.2, 0.8);
      blobs.push(glare(fx, frame, [side.a[0] + (side.b[0] - side.a[0]) * t, side.a[1] + (side.b[1] - side.a[1]) * t]));
    }
    return scene(rng, {
      target: -1,
      device: tablet ? "tablet" : "phone",
      bezelMm: bezel,
      body,
      chrome,
      desk: desk.kind,
      camera,
      background: desk.surface,
      layers: [device, glass, shown],
      blobs,
    });
  },

  booklet(rng, frame) {
    const layout = rng.fork("layout");
    const desk = anyDesk(rng.fork("background"));
    const b = rng.fork("booklet");
    const [pw, ph] = b.pick([
      [148, 210],
      [125, 176],
      [105, 148],
    ]);
    const type = layout.pick(["lab-report", "letter", "note", "form"]);
    const rotation = layout.range(-12, 12);
    const book = { center: [0, 0], rotation };
    const leaves = b.int(3, 5);
    const tint = b.pick(documentStock("lab-report").tints);
    const coverMargin = b.range(2, 4);
    const cover = {
      name: "cover",
      material: { material: "paper", tint: b.pick(["#1f3a68", "#245b3c", "#6b1f2a", "#2b2b2b", "#d8b87c", "#0f4c5c"]), fibre: 0.05, edge: 0.1, seed: b.seed32() },
      center: [0, 0],
      size: [2 * pw + 2 * coverMargin, ph + 2 * coverMargin],
      rotation,
      radius: 2,
      height: 0.3,
      shadowHeight: 1.5,
      shadowStrength: b.range(0.25, 0.4),
      softness: 0.3,
    };
    // The page block: each leaf below the top pages a little larger, its cut
    // edge showing past the one above — a band of fine parallel edges.
    const block = [];
    for (let i = 0; i < leaves; i += 1) {
      const grow = (leaves - i) * b.range(0.3, 0.8);
      block.push({
        name: "leaf",
        material: { material: "paper", tint, fibre: 0.04, edge: b.range(0.15, 0.3), seed: b.seed32() },
        center: [0, 0],
        size: [2 * pw + 2 * grow, ph + 2 * grow],
        rotation,
        radius: 0.3,
        height: 0.3 + 0.1 * (i + 1),
        shadowHeight: 0.2,
        shadowStrength: b.range(0.15, 0.3),
        softness: 0.15,
        wobble: b.range(0.1, 0.3),
      });
    }
    const top = 0.3 + 0.1 * (leaves + 1);
    const lifted = b.chance(0.5);
    const lift = b.range(3, 8);
    const reach = b.range(20, 45);
    const facing = (side, name) => {
      const leaf = page(rng.fork(name), { type, center: toWorld(book, [(side * pw) / 2, 0]), rotation, height: top, curl: 0, crease: 0 });
      leaf.size = [pw, ph];
      leaf.material.tint = tint;
      leaf.shadowStrength = b.range(0.08, 0.2);
      leaf.shadowHeight = 0.3;
      // The spine side of each page rises off the gutter.
      if (lifted) leaf.curl = { mode: "edge-x", lift, reach, side: -side };
      return leaf;
    };
    const left = facing(-1, "left");
    const right = facing(1, "right");
    const camera = frameIt(rng, frame, right, { coverage: [0.2, 0.45], marginFraction: 0.06 });
    // The gutter's shade: a soft band along the spine, over both pages.
    const cam = cameraFromPose(camera, frame);
    const [s0, s1] = [toPixel(cam, { ...book, height: top }, [0, -ph / 2]), toPixel(cam, { ...book, height: top }, [0, ph / 2])];
    const along = [s1[0] - s0[0], s1[1] - s0[1]];
    const normal = Math.atan2(along[0], -along[1]) / DEG;
    const gutterMm = b.range(8, 20);
    const half = (gutterMm / 2) * pixelsPerMm(camera, frame, book.center);
    // As long as the spine and a little more: it fades out past the book's ends.
    const length = 0.62 * Math.hypot(along[0], along[1]);
    const blobs = [
      {
        kind: "shadow",
        center: [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2],
        radius: [half, length],
        angle: normal,
        strength: b.range(0.25, 0.5),
        softness: b.range(0.6, 0.95),
      },
    ];
    return scene(rng, {
      target: 3,
      leaves,
      lifted,
      gutterMm,
      desk: desk.kind,
      camera,
      background: desk.surface,
      layers: [cover, ...block, left, right],
      blobs,
      primaryPage: 1,
    });
  },

  "curled-receipt"(rng, frame) {
    const layout = rng.fork("layout");
    const desk = anyDesk(rng.fork("background"));
    const paper = page(rng.fork("page"), { type: "receipt", rotation: layout.range(-15, 15), curl: 0 });
    const shape = rng.fork("curl");
    const mode = shape.weighted([
      ["roll-y", 5],
      ["edge-y", 3],
      ["roll-x", 2],
    ]);
    const [w, h] = paper.size;
    if (mode === "roll-y") {
      paper.curl = { mode, lift: (h / 2) * shape.range(0.12, 0.25), reach: 1, side: 1 };
    } else if (mode === "roll-x") {
      paper.curl = { mode, lift: (w / 2) * shape.range(0.15, 0.25), reach: 1, side: 1 };
    } else {
      const reach = Math.min(h * 0.5, shape.range(40, 80));
      paper.curl = { mode, lift: reach * shape.range(0.18, 0.25), reach, side: shape.pick([-1, 1]) };
    }
    paper.shadowHeight += paper.curl.lift * 0.3;
    const camera = frameIt(rng, frame, paper, { coverage: [0.12, 0.35], marginFraction: 0.08 });
    return scene(rng, { target: -1, curlMode: mode, liftMm: paper.curl.lift, desk: desk.kind, camera, background: desk.surface, layers: [paper] });
  },

  "jpeg-strong"(rng, frame) {
    const parts = plainPage(rng, frame, 0.5);
    parts.post.jpeg = rng.fork("jpeg").range(0.2, 0.45);
    return parts;
  },

  "sharpen-halo"(rng, frame) {
    const parts = plainPage(rng, frame, 0.5);
    const fx = rng.fork("fx");
    parts.effects = [{ type: "sharpen", radius: fx.range(1, 3), amount: fx.range(0.8, 2) }];
    parts.post.jpeg = fx.range(0.6, 0.85);
    return parts;
  },

  "clipped-highlights"(rng, frame) {
    const parts = plainPage(rng, frame, 0.7);
    const fx = rng.fork("fx");
    parts.effects = [{ type: "exposure", gain: fx.range(1.12, 1.5) }];
    if (fx.chance(0.4)) {
      const page0 = parts.layers[0];
      const side = sideInImage(parts.camera, frame, page0, fx.int(0, 3));
      const t = fx.range(0.25, 0.75);
      const hot = glare(fx, frame, [side.a[0] + (side.b[0] - side.a[0]) * t, side.a[1] + (side.b[1] - side.a[1]) * t]);
      parts.blobs = [hot];
    }
    return parts;
  },
};

/** A plain paper page on a pale (share `paleShare`) or any desk, for the settings that only change the camera's processing. */
function plainPage(rng, frame, paleShare) {
  const layout = rng.fork("layout");
  const { desk, background } = paleOrAny(rng.fork("background"), paleShare);
  const paper = paperPage(rng, layout);
  const camera = frameIt(rng, frame, paper);
  return scene(rng, { target: -1, desk, camera, background, layers: [paper] });
}

/**
 * A dark object — a phone, a keyboard, a notebook, a pen — laid along side
 * `k` of `paper`, `gapFrac` of the diagonal outside it: on a pale table, its
 * near edge is a straight line with "paper" (the table) inside it.
 */
function darkThingBeside(o, layout, camera, frame, paper, k, gapFrac) {
  const gap = mmFor(camera, frame, paper, k, gapFrac);
  const kind = o.pick(["phone", "keyboard", "notebook", "pen"]);
  const thing =
    kind === "pen"
      ? plasticStick(o, { body: o.pick(["#151515", "#1d3f8f", "#2a2a2e"]), size: [o.range(130, 150), o.range(8, 11)], height: 9, sheen: o.range(0.5, 1) })
      : makeProp(kind, o, { center: [0, 0], rotation: 0 });
  if (kind === "phone") thing.material.body = o.pick(["#101114", "#2b2d31", "#1c1c1e"]);
  const s = sideOf(paper, k);
  const fit = alongSide(k, thing.size);
  thing.rotation = paper.rotation + fit.turn + offParallel(o, gap, fit.halfAlong);
  thing.center = placeOff(paper, k, gap, fit.halfAcross, layout.range(-1, 1) * Math.abs(s.along - fit.halfAlong) * 0.8, false);
  return thing;
}

registerFamily({
  id: "F7",
  title: "refine-adversarial",
  describe:
    "a straight edge parallel to the page just outside it (mat, folder, table, board, pen, cast shadow, a second sheet), " +
    "one just inside it (shadow, rule, full-bleed band, fold, glare), or the page's own edge made weak or broken " +
    "(white on white, a thumb, a curl, a dog-ear, a torn receipt); and the field cases of its review — dark stock, " +
    "a black table, a bordered form, offset sheets, a screen, a booklet, a curled receipt, a phone's JPEG, " +
    "sharpening and clipping",
  sample(rng, { frame, seed = 1 }) {
    const count = F7_SETTINGS.length;
    const setting = F7_SETTINGS[(((seed - 1) % count) + count) % count];
    return { setting, ...RECIPES[setting](rng, frame) };
  },
});
