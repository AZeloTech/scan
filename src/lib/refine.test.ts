import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedQuad } from "./quad.ts";
import { refineQuad, type RefineImage } from "./refine.ts";

/**
 * Pictures drawn here, in the test: a page (an anti-aliased convex quad with a
 * soft edge) on a background, with whatever the case needs on or around it —
 * lines of text, a header band, a desk mat, a shadow, a finger. Pixel noise is
 * seeded, so every picture is the same on every run.
 */

type Rgb = [number, number, number];
type Pt = [number, number];

const W = 600;
const H = 800;
const DIAG = Math.hypot(W, H);

/** A page slightly rotated and foreshortened, as a phone sees one. */
const PAGE: Pt[] = [
  [150, 130],
  [470, 112],
  [492, 690],
  [128, 700],
];

class Canvas {
  readonly data = new Float32Array(W * H * 3);

  constructor(background: Rgb) {
    for (let i = 0; i < W * H; i += 1) this.data.set(background, i * 3);
  }

  /** Fill a convex polygon (clockwise, y down) with an edge `soft` px wide. */
  polygon(points: Pt[], color: Rgb | ((x: number, y: number) => Rgb), soft = 1.2): void {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - soft - 1));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(...xs) + soft + 1));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - soft - 1));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys) + soft + 1));
    const edges = points.map((a, i) => {
      const b = points[(i + 1) % points.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      // Outward normal of a clockwise (y-down) polygon.
      return { a, nx: (b[1] - a[1]) / len, ny: -(b[0] - a[0]) / len };
    });
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        let d = -Infinity;
        for (const e of edges) d = Math.max(d, (px - e.a[0]) * e.nx + (py - e.a[1]) * e.ny);
        const cover = Math.min(1, Math.max(0, 0.5 - d / soft));
        if (cover <= 0) continue;
        const c = typeof color === "function" ? color(px, py) : color;
        const o = (y * W + x) * 3;
        for (let k = 0; k < 3; k += 1) this.data[o + k] += (c[k] - this.data[o + k]) * cover;
      }
    }
  }

  /** Darken everything inside a convex polygon by `factor` (a shadow). */
  shade(points: Pt[], factor: number, soft = 20): void {
    const copy = new Canvas([0, 0, 0]);
    copy.polygon(points, [1, 1, 1], soft);
    for (let i = 0; i < W * H; i += 1) {
      const m = 1 - (1 - factor) * copy.data[i * 3];
      for (let k = 0; k < 3; k += 1) this.data[i * 3 + k] *= m;
    }
  }

  image(noise = 2.5, seed = 7): RefineImage {
    let state = seed >>> 0;
    const rand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i += 1) {
      for (let k = 0; k < 3; k += 1) data[i * 4 + k] = this.data[i * 3 + k] + (rand() + rand() - 1) * noise;
      data[i * 4 + 3] = 255;
    }
    return { data, width: W, height: H };
  }
}

/** A point on the page, from page fractions (u across, v down). */
function onPage(u: number, v: number, page = PAGE): Pt {
  const [a, b, c, d] = page;
  return [
    a[0] * (1 - u) * (1 - v) + b[0] * u * (1 - v) + c[0] * u * v + d[0] * (1 - u) * v,
    a[1] * (1 - u) * (1 - v) + b[1] * u * (1 - v) + c[1] * u * v + d[1] * (1 - u) * v,
  ];
}

/** The page-fraction rectangle [u0,u1]×[v0,v1] as an image polygon. */
function pageRect(u0: number, v0: number, u1: number, v1: number, page = PAGE): Pt[] {
  return [onPage(u0, v0, page), onPage(u1, v0, page), onPage(u1, v1, page), onPage(u0, v1, page)];
}

/** Lines of "text": thin dark bars over a block of the page. */
function text(canvas: Canvas, u0: number, v0: number, u1: number, v1: number, page = PAGE): void {
  for (let v = v0; v < v1; v += 0.028) {
    for (let u = u0; u < u1; u += 0.09) {
      canvas.polygon(pageRect(u, v, Math.min(u1, u + 0.07), v + 0.011, page), [40, 40, 45], 0.8);
    }
  }
}

function toQuad(points: Pt[]): NormalizedQuad {
  const [tl, tr, br, bl] = points;
  return {
    topLeft: { x: tl[0] / W, y: tl[1] / H },
    topRight: { x: tr[0] / W, y: tr[1] / H },
    bottomRight: { x: br[0] / W, y: br[1] / H },
    bottomLeft: { x: bl[0] / W, y: bl[1] / H },
  };
}

/** Every corner pulled toward the page centre by `frac` of the diagonal. */
function shrink(points: Pt[], frac: number): Pt[] {
  const cx = points.reduce((s, p) => s + p[0], 0) / 4;
  const cy = points.reduce((s, p) => s + p[1], 0) / 4;
  return points.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy);
    return [x + ((cx - x) / d) * frac * DIAG, y + ((cy - y) / d) * frac * DIAG];
  });
}

/** Largest corner distance between a quad and the page, fraction of the diagonal. */
function worstCorner(quad: NormalizedQuad, truth: Pt[] = PAGE): number {
  const got = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  return Math.max(...got.map((p, i) => Math.hypot(p.x * W - truth[i][0], p.y * H - truth[i][1]) / DIAG));
}

const GRANITE: Rgb = [48, 44, 46];
const PAPER: Rgb = [238, 236, 230];

/** A white page with a body of text on a dark desk. */
function plainPage(background: Rgb = GRANITE, paper: Rgb = PAPER): Canvas {
  const canvas = new Canvas(background);
  canvas.polygon(PAGE, paper, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  return canvas;
}

test("a quad sitting inside the page is moved out onto its edge", () => {
  const image = plainPage().image();
  const prior = toQuad(shrink(PAGE, 0.012));
  assert.ok(worstCorner(prior) > 0.01);
  const result = refineQuad(image, prior);
  assert.equal(result.changed, true);
  assert.ok(worstCorner(result.quad) < 0.002, `worst corner ${worstCorner(result.quad)}`);
  assert.ok(result.sides.every((side) => side.accepted && side.mode === "local"));
  assert.ok(result.sides.every((side) => side.shiftFrac > 0), "every side moved outward");
});

test("a quad a little outside the page on a plain desk is pulled in", () => {
  const image = plainPage().image();
  const result = refineQuad(image, toQuad(shrink(PAGE, -0.012)));
  assert.ok(worstCorner(result.quad) < 0.002, `worst corner ${worstCorner(result.quad)}`);
});

test("a low-contrast page on a light table is still found", () => {
  const image = plainPage([226, 226, 222], [241, 238, 229]).image();
  const result = refineQuad(image, toQuad(shrink(PAGE, 0.01)));
  assert.ok(worstCorner(result.quad) < 0.003, `worst corner ${worstCorner(result.quad)}`);
});

test("works on a grey (one byte a pixel) image", () => {
  const rgba = plainPage().image();
  const grey = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i += 1) grey[i] = rgba.data[i * 4 + 1];
  const result = refineQuad({ data: grey, width: W, height: H }, toQuad(shrink(PAGE, 0.012)));
  assert.ok(worstCorner(result.quad) < 0.002, `worst corner ${worstCorner(result.quad)}`);
});

test("a corner pulled onto the text block is taken back out to the page's corner", () => {
  const image = plainPage([232, 230, 226], [243, 238, 226]).image();
  // The model's failure on a white table: the bottom-left corner on the text.
  const prior = PAGE.map((p) => [...p] as Pt);
  prior[3] = onPage(0.1, 0.86);
  assert.ok(worstCorner(toQuad(prior)) > 0.07);
  const result = refineQuad(image, toQuad(prior));
  assert.ok(worstCorner(result.quad) < 0.01, `worst corner ${worstCorner(result.quad)}`);
  assert.ok(result.sides.some((side) => side.mode === "wide"));
});

test("the classical detector's quads are only ever snapped locally", () => {
  const image = plainPage([232, 230, 226], [243, 238, 226]).image();
  const prior = PAGE.map((p) => [...p] as Pt);
  prior[3] = onPage(0.1, 0.86);
  const result = refineQuad(image, toQuad(prior), { mode: "local" });
  assert.ok(result.sides.every((side) => side.mode !== "wide"));
  assert.ok(worstCorner(result.quad) > 0.07, "no wide move without mode full");
});

test("a header band does not pass for the page's top edge", () => {
  const canvas = plainPage();
  // A dark band across the top of the page, a white margin above it.
  canvas.polygon(pageRect(0, 0.035, 1, 0.09), [30, 70, 50], 1);
  const image = canvas.image();
  // The prior's top side on the band's lower edge.
  const prior = PAGE.map((p) => [...p] as Pt);
  prior[0] = onPage(0, 0.09);
  prior[1] = onPage(1, 0.09);
  const result = refineQuad(image, toQuad(prior));
  assert.ok(worstCorner(result.quad) < 0.003, `worst corner ${worstCorner(result.quad)}`);
});

test("a desk mat's edge beyond the page does not pass for the page's edge", () => {
  const canvas = new Canvas([176, 128, 84]);
  // A dark leather mat under the page, its edge 2 % of the diagonal outside it.
  canvas.polygon(shrink(PAGE, -0.02), [52, 38, 32], 1);
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const image = canvas.image();
  const result = refineQuad(image, toQuad(shrink(PAGE, 0.006)));
  assert.ok(worstCorner(result.quad) < 0.002, `worst corner ${worstCorner(result.quad)}`);
});

test("a second sheet under the page does not pass for the page's edge", () => {
  const canvas = new Canvas(GRANITE);
  // The sheet below, a little larger and offset: its edge 3-6 % outside the page's.
  canvas.polygon(shrink(PAGE, -0.045).map(([x, y]) => [x + 12, y + 8] as Pt), [236, 235, 231], 1.5);
  // The same paper stock: all that marks the page's edge is its thin shadow.
  canvas.polygon(shrink(PAGE, -0.003), [205, 204, 200], 3);
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const image = canvas.image();
  const result = refineQuad(image, toQuad(shrink(PAGE, 0.006)));
  assert.ok(worstCorner(result.quad) < 0.003, `worst corner ${worstCorner(result.quad)}`);
  assert.ok(result.sides.every((side) => side.mode !== "wide"));
});

test("on a white table the table's own edge does not pass for the page's", () => {
  const canvas = new Canvas([70, 60, 55]);
  // The table ends 8 % of the diagonal outside the page on every side.
  canvas.polygon(shrink(PAGE, -0.08), [246, 246, 244], 2);
  canvas.polygon(PAGE, [240, 237, 228], 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const image = canvas.image();
  const result = refineQuad(image, toQuad(shrink(PAGE, 0.006)));
  assert.ok(worstCorner(result.quad) < 0.003, `worst corner ${worstCorner(result.quad)}`);
});

test("never moves inward across a full-bleed band of ink", () => {
  const canvas = plainPage();
  // Dark ink up to the page's top edge, no white margin: from outside, the
  // band's lower edge is the first paper edge there is.
  canvas.polygon(pageRect(0, 0, 1, 0.07), [60, 20, 30], 1);
  const image = canvas.image();
  const result = refineQuad(image, toQuad(PAGE));
  const top = result.sides[0];
  assert.ok(!(top.accepted && top.shiftFrac < -0.005), `top side moved ${top.shiftFrac}`);
  assert.ok(worstCorner(result.quad) < 0.005, `worst corner ${worstCorner(result.quad)}`);
});

test("a shadow across the page's edge does not pull the side", () => {
  const canvas = plainPage([120, 110, 100]);
  canvas.shade([[0, 380], [600, 330], [600, 520], [0, 560]], 0.6, 30);
  const image = canvas.image();
  const result = refineQuad(image, toQuad(shrink(PAGE, 0.008)));
  assert.ok(worstCorner(result.quad) < 0.003, `worst corner ${worstCorner(result.quad)}`);
});

test("a finger over the edge leaves the side on the paper", () => {
  const canvas = plainPage();
  // A thumb across the right edge, a third of the way down.
  const [x, y] = onPage(1, 0.33);
  canvas.polygon([[x - 30, y - 22], [x + 60, y - 30], [x + 70, y + 20], [x - 26, y + 26]], [200, 150, 120], 3);
  const image = canvas.image();
  const result = refineQuad(image, toQuad(shrink(PAGE, 0.008)));
  assert.ok(worstCorner(result.quad) < 0.003, `worst corner ${worstCorner(result.quad)}`);
});

test("answers the input, with a reason, instead of throwing", () => {
  const image = plainPage().image();
  const prior = toQuad(PAGE);
  const nan: NormalizedQuad = { ...prior, topLeft: { x: Number.NaN, y: 0.2 } };
  const twisted: NormalizedQuad = { ...prior, topLeft: prior.topRight, topRight: prior.topLeft };
  const cases: [RefineImage, NormalizedQuad][] = [
    [image, nan],
    [image, twisted],
    [{ data: new Uint8ClampedArray(10), width: W, height: H }, prior],
    [{ data: new Uint8ClampedArray(0), width: 0, height: 0 }, prior],
    [image, null as unknown as NormalizedQuad],
  ];
  for (const [img, quad] of cases) {
    const result = refineQuad(img, quad);
    assert.equal(result.changed, false);
    assert.equal(result.quad, quad);
    assert.notEqual(result.reason, "refined");
  }
});

test("a blank frame changes nothing", () => {
  const image = new Canvas([128, 128, 128]).image();
  const prior = toQuad(PAGE);
  const result = refineQuad(image, prior);
  assert.equal(result.changed, false);
  assert.deepEqual(result.quad, prior);
  assert.ok(result.sides.every((side) => !side.accepted && side.mode === "kept"));
});

test("out of time answers the input", () => {
  const image = plainPage().image();
  const prior = toQuad(shrink(PAGE, 0.012));
  let clock = 0;
  const result = refineQuad(image, prior, { budgetMs: 5, now: () => (clock += 10) });
  assert.equal(result.changed, false);
  assert.equal(result.quad, prior);
  assert.equal(result.reason, "budget");
});

test("is deterministic", () => {
  const image = plainPage([232, 230, 226], [243, 238, 226]).image();
  const prior = PAGE.map((p) => [...p] as Pt);
  prior[3] = onPage(0.1, 0.86);
  const a = refineQuad(image, toQuad(prior));
  const b = refineQuad(image, toQuad(prior));
  assert.deepEqual(a.quad, b.quad);
  assert.deepEqual(a.sides, b.sides);
});

/** A speckled stone desk: grain a few px across, seeded. */
function granite(seed: number, mid = 195, spread = 70): (x: number, y: number) => Rgb {
  return (x, y) => {
    let h = (Math.floor(x / 3) * 374761393 + Math.floor(y / 3) * 668265263 + seed * 982451653) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    const v = mid + (((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5) * spread;
    return [v, v, v * 0.97];
  };
}

test("on a speckled desk a line a degree off the edge does not win", () => {
  // Such a twin crosses the edge, borrows its points near the crossing and
  // fills the rest with speckle; its middle, a few px out, used to win
  // "outermost". Worst in local mode, where speckle fills every profile.
  for (const seed of [1, 2, 3]) {
    const canvas = new Canvas([0, 0, 0]);
    canvas.polygon([[0, 0], [W, 0], [W, H], [0, H]], granite(seed), 0.5);
    canvas.polygon(PAGE, [242, 240, 234], 1.5);
    text(canvas, 0.1, 0.12, 0.9, 0.85);
    const image = canvas.image(2.5, seed);
    for (const mode of ["local", "full"] as const) {
      const result = refineQuad(image, toQuad(shrink(PAGE, 0.006)), { mode });
      assert.ok(worstCorner(result.quad) < 0.002, `seed ${seed} ${mode}: worst corner ${worstCorner(result.quad)}`);
    }
  }
});

test("a prior turned across a printed rule does not cut off the header above it", () => {
  // The prior's top side turned 4.4° against the page: on the rule under the
  // header at its middle, above the header at its left end. The rule's line
  // is "no move" at the middle and 12 px in at the left: judged by its middle
  // alone, the header went out of the crop.
  const page: Pt[] = [
    [150, 50],
    [450, 50],
    [450, 410],
    [150, 410],
  ];
  const canvas = new Canvas(GRANITE);
  canvas.polygon(page, PAPER, 1.2);
  for (let x = 165; x < 435; x += 20) {
    canvas.polygon([[x, 55], [x + 15, 55], [x + 15, 59], [x, 59]], [40, 40, 45], 0.8);
  }
  canvas.polygon([[155, 62], [445, 62], [445, 64], [155, 64]], [30, 30, 35], 0.8);
  text(canvas, 0.1, 0.12, 0.9, 0.85, page);
  const image = canvas.image();
  const prior: Pt[] = [
    [152, 52],
    [448, 75],
    [448, 408],
    [152, 408],
  ];
  for (const mode of ["full", "local"] as const) {
    const result = refineQuad(image, toQuad(prior), { mode });
    const y = result.quad.topLeft.y * H;
    assert.ok(y <= 55, `${mode}: top-left corner at y ${y.toFixed(1)}, below the header's top (55)`);
  }
});

test("a short side is not turned past its angle limit in local mode", () => {
  // A small square turned 12° and a prior square to the frame: the edges are
  // there to snap to, but 12° is three times the local limit.
  const [cx, cy] = [300, 400];
  const square = (size: number, deg: number): Pt[] => {
    const r = (deg * Math.PI) / 180;
    const h = size / 2;
    return ([[-h, -h], [h, -h], [h, h], [-h, h]] as Pt[]).map(([x, y]) => [
      cx + x * Math.cos(r) - y * Math.sin(r),
      cy + x * Math.sin(r) + y * Math.cos(r),
    ]);
  };
  const canvas = new Canvas([60, 56, 52]);
  canvas.polygon(square(60, 12), PAPER, 1.2);
  const result = refineQuad(canvas.image(1.5), toQuad(square(58, 0)), { mode: "local" });
  const { topLeft: a, topRight: b } = result.quad;
  const turn = (Math.atan2((b.y - a.y) * H, (b.x - a.x) * W) * 180) / Math.PI;
  assert.ok(Math.abs(turn) < 9, `top side turned ${turn.toFixed(1)}°`);
});

test("a budget spent after the first pass answers the input", () => {
  const image = plainPage().image();
  const prior = toQuad(shrink(PAGE, 0.012));
  // The clock stands still through the start and the four sides of the local
  // pass, then jumps: the corners are never assembled.
  let reads = 0;
  const now = () => (reads++ < 5 ? 0 : 1000);
  const result = refineQuad(image, prior, { mode: "local", budgetMs: 50, now });
  assert.equal(result.changed, false);
  assert.equal(result.quad, prior);
  assert.equal(result.reason, "budget");
});

test("corners stay on the image when the page runs off it", () => {
  // The page's bottom-left corner is off the frame; the detector answers with
  // a corner on the frame's edge. Snapping the left and bottom sides onto the
  // page's edges would put their crossing — the refined corner — off the
  // image: that side falls back instead.
  const page: Pt[] = [
    [60, 120],
    [480, 110],
    [500, 700],
    [-15, 690],
  ];
  const canvas = new Canvas(GRANITE);
  canvas.polygon(page, PAPER, 1.5);
  text(canvas, 0.15, 0.12, 0.9, 0.85, page);
  const image = canvas.image();
  const prior = toQuad([
    [63, 125],
    [476, 115],
    [495, 694],
    [2, 684],
  ]);
  for (const mode of ["full", "local"] as const) {
    const result = refineQuad(image, prior, { mode });
    for (const p of [result.quad.topLeft, result.quad.topRight, result.quad.bottomRight, result.quad.bottomLeft]) {
      assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `${mode}: corner ${p.x.toFixed(4)},${p.y.toFixed(4)} off the image`);
    }
    assert.ok(result.changed, `${mode}: the sides that can move still do`);
  }
});

test("on a striped cloth the next white stripe is not the page", () => {
  // Paper-white and grey stripes, 10 px each, along the page's top and bottom
  // edges: past each a grey stripe, then white "paper" with an edge of its
  // own, then grey again — the pattern, not more page.
  const page: Pt[] = [
    [150, 139],
    [470, 139],
    [470, 689],
    [150, 689],
  ];
  const canvas = new Canvas([0, 0, 0]);
  const stripe = (_x: number, y: number): Rgb => (Math.floor(y / 10) % 2 === 0 ? [236, 234, 228] : [168, 166, 162]);
  canvas.polygon([[0, 0], [W, 0], [W, H], [0, H]], stripe, 0.5);
  canvas.polygon(page, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85, page);
  const image = canvas.image();
  const prior = shrink(page, 0.004);
  const result = refineQuad(image, toQuad(prior));
  for (const k of [0, 2]) {
    const side = result.sides[k];
    assert.notEqual(side.mode, "wide", `side ${k} searched past the page's edge`);
    assert.ok(side.shiftFrac < 0.008, `side ${k} moved out ${side.shiftFrac}`);
  }
  const top = result.quad.topLeft.y * H;
  assert.ok(Math.abs(top - 139) < 2, `top edge at ${top.toFixed(1)}`);
});

test("a fold's shaded margin is not cut off at the fold", () => {
  // A fold across the top, 5 % of the page down; past it the paper is turned
  // from the light and darker. The model's top side sits in that strip. From
  // the prior outward, the strip looks just like what the fold's edge would
  // cut away — but it ends at an edge of its own, the page's.
  const canvas = new Canvas([150, 148, 146]);
  canvas.polygon(PAGE, PAPER, 1.5);
  canvas.polygon(pageRect(0, 0, 1, 0.05), [196, 194, 189], 1);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const image = canvas.image();
  const prior = PAGE.map((p) => [...p] as Pt);
  prior[0] = onPage(0, 0.02);
  prior[1] = onPage(1, 0.02);
  const result = refineQuad(image, toQuad(prior));
  const top = result.sides[0];
  assert.ok(!(top.accepted && top.shiftFrac < -0.002), `top side moved ${top.shiftFrac} (${top.reason})`);
});

// ── red-team claims (adv-p2) ─────────────────────────────────────────────────
//
// Each case below is one claim of the external review of this module, drawn
// as the smallest picture that shows it, with the claim's number. Every one
// that reproduced failed against the module as reviewed and holds its fix
// now; a claim refuted by construction holds the evidence. A "control" is
// the same picture without what the claim is about: the fix must not cost
// the ordinary case.

/** A quad's top-left-to-top-right… points in image pixels. */
function pixels(quad: NormalizedQuad): Pt[] {
  return [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft].map((p) => [p.x * W, p.y * H]);
}

/** Largest distance of any refined corner from the prior's, in px. */
function moved(result: { quad: NormalizedQuad }, prior: NormalizedQuad): number {
  const a = pixels(result.quad);
  const b = pixels(prior);
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
}

/** A convex clockwise polygon with every side moved `d` px inward along its normal. */
function inset(points: Pt[], d: number): Pt[] {
  const lines = points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n: Pt = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
    return { p: [a[0] + n[0] * d, a[1] + n[1] * d] as Pt, t: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] as Pt };
  });
  return lines.map((l, i) => {
    const m = lines[(i + points.length - 1) % points.length];
    const det = m.t[0] * l.t[1] - m.t[1] * l.t[0];
    const u = ((l.p[0] - m.p[0]) * l.t[1] - (l.p[1] - m.p[1]) * l.t[0]) / det;
    return [m.p[0] + m.t[0] * u, m.p[1] + m.t[1] * u];
  });
}

function sidesOf(result: ReturnType<typeof refineQuad>): string {
  return result.sides.map((s) => `${s.mode}/${s.reason}/${(s.shiftFrac * 100).toFixed(2)}`).join(" ");
}

test("claim 2.2: a side on the frame's edge is not moved inward without evidence", () => {
  // The page runs off the left of the frame; the detector's left side lies
  // on the frame's edge. 18 px in, a results table's column rule runs down
  // the page, with the column's labels between it and the frame's edge.
  // Outside the prior there is no image to compare the cut strip with.
  const page: Pt[] = [
    [-60, 120],
    [470, 110],
    [492, 700],
    [-70, 690],
  ];
  const canvas = new Canvas(GRANITE);
  canvas.polygon(page, PAPER, 1.5);
  canvas.polygon([[17, 150], [19, 150], [19, 660], [17, 660]], [30, 30, 35], 0.8);
  for (let y = 160; y < 650; y += 22) canvas.polygon([[3, y], [13, y], [13, y + 7], [3, y + 7]], [40, 40, 45], 0.8);
  text(canvas, 0.2, 0.12, 0.9, 0.85, page);
  const image = canvas.image();
  const prior = toQuad([
    [0, 119],
    [468, 112],
    [490, 698],
    [0, 689],
  ]);
  for (const mode of ["full", "local"] as const) {
    const result = refineQuad(image, prior, { mode });
    const left = Math.min(result.quad.topLeft.x, result.quad.bottomLeft.x) * W;
    assert.ok(left <= 2, `${mode}: left side moved in to x ${left.toFixed(1)}, cutting the label column (${sidesOf(result)})`);
  }
});

test("claim 2.1: on a black mat the wide search does not cross to a white sheet beyond", () => {
  // A white page on a black leather mat. Beside it, 2 % of the diagonal
  // away, a second sheet lies across the mat's edge onto a wooden table:
  // its far edge has paper inside and wood — not the mat — outside.
  const canvas = new Canvas([176, 128, 84]);
  canvas.polygon([[0, 0], [540, 0], [540, H], [0, H]], [26, 25, 27], 1);
  canvas.polygon([[512, 95], [585, 95], [585, 715], [512, 715]], [236, 235, 230], 1.5);
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const image = canvas.image();
  const prior = toQuad(shrink(PAGE, 0.006));
  const result = refineQuad(image, prior);
  assert.ok(worstCorner(result.quad) < 0.005, `worst corner ${worstCorner(result.quad).toFixed(4)} (${sidesOf(result)})`);
});

test("claim 2.1 control: the same sheet on the mat, its far edge on the mat too, is not taken", () => {
  const canvas = new Canvas([176, 128, 84]);
  canvas.polygon([[0, 0], [590, 0], [590, H], [0, H]], [26, 25, 27], 1);
  canvas.polygon([[512, 95], [575, 95], [575, 715], [512, 715]], [236, 235, 230], 1.5);
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.ok(worstCorner(result.quad) < 0.005, `worst corner ${worstCorner(result.quad).toFixed(4)} (${sidesOf(result)})`);
});

const NAVY: Rgb = [28, 42, 88];

/** A navy card-stock page with white print: a white panel over `panel` of its height, text on it. */
function navyPage(background: Rgb, panel: number): Canvas {
  const canvas = new Canvas(background);
  canvas.polygon(PAGE, NAVY, 1.5);
  if (panel > 0) canvas.polygon(pageRect(0.08, 0.3, 0.92, 0.3 + panel), [236, 236, 232], 1);
  // White headings and lines of text straight on the navy.
  for (let v = 0.1; v < 0.26; v += 0.035) canvas.polygon(pageRect(0.1, v, 0.7, v + 0.012), [228, 228, 226], 0.8);
  text(canvas, 0.12, 0.33, 0.88, 0.3 + panel - 0.03);
  return canvas;
}

test("claim 1.1: a navy page with a white panel on a light table is not grown to the table's edge", () => {
  // Read as a white page's bright end (its 90th percentile), the panel
  // makes white the page's "paper": the navy edge has no paper inside it,
  // and the light table beyond it does. The table ends 5 % of the diagonal
  // above the page; a phone lies 4 % to its right — each a straight edge
  // with "paper" (table) inside. The navy along the page's border is its
  // stock.
  const canvas = navyPage([228, 226, 220], 0.35);
  canvas.polygon([[0, 0], [W, 0], [W, 62], [0, 62]], [58, 50, 46], 2);
  canvas.polygon([[528, 150], [566, 150], [566, 650], [528, 650]], [34, 34, 38], 2);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.ok(worstCorner(result.quad) < 0.01, `worst corner ${worstCorner(result.quad).toFixed(4)} (${sidesOf(result)})`);
});

test("claim 1.1 control: the same page, nothing beyond it, is left alone or snapped", () => {
  const canvas = navyPage([228, 226, 220], 0.35);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.ok(worstCorner(result.quad) < 0.01, `worst corner ${worstCorner(result.quad).toFixed(4)} (${sidesOf(result)})`);
});

test("claim 2.4: a navy page's own white border rule does not pass for its edge", () => {
  // Thin white print only (the navy stays the "paper"), and a 2 px white
  // rule 10 px inside every edge (past the strip the inner paper is read
  // in): from outside in, table → navy (darker
  // inside) → white rule (brighter inside). By polarity alone that is a
  // contact shadow's outer edge and the page's; the navy between them is
  // the page's paper, not a shadow.
  const canvas = navyPage([228, 226, 220], 0);
  canvas.polygon(inset(PAGE, 10), [230, 230, 228], 0.8);
  canvas.polygon(inset(PAGE, 12), NAVY, 0.8);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.ok(worstCorner(result.quad) < 0.003, `worst corner ${worstCorner(result.quad).toFixed(4)} (${sidesOf(result)})`);
});

/** The page square to the frame, for the cases that draw lines against its sides. */
const SQUARE: Pt[] = [
  [150, 139],
  [470, 139],
  [470, 689],
  [150, 689],
];

/**
 * A white page on a white table whose left edge is washed out by a lamp's
 * glare over its lower quarter, and a printed rule running down the page
 * 1 px inside the edge at the top and 21 px inside at the bottom (a form
 * printed 2.5° askew). Only at the top is the rule within the 3–8 px strip
 * the edge's inner paper is read in.
 */
function skewedRule(withRule: boolean): RefineImage {
  const canvas = new Canvas([226, 225, 221]);
  canvas.polygon(SQUARE, [241, 238, 229], 1.5);
  canvas.polygon([[120, 545], [175, 545], [175, 700], [120, 700]], [250, 249, 246], 10);
  if (withRule) canvas.polygon([[151, 150], [152.6, 150], [172.6, 680], [171, 680]], [35, 35, 40], 0.8);
  text(canvas, 0.14, 0.12, 0.9, 0.85, SQUARE);
  return canvas.image();
}

test("claim 2.3: a printed rule a few degrees off the edge does not remove the edge as its twin", () => {
  // The glare leaves the edge on ~75 % of the profiles, the rule on all of
  // them. They are 11 px apart at the middle and meet at the top: judged by
  // the separation at their closer end they would be "twins", and the
  // weaker — the page's edge — would go. Along most of the side each has
  // points of its own.
  const image = skewedRule(true);
  for (const offset of [-0.004, 0, 0.004]) {
    const result = refineQuad(image, toQuad(shrink(SQUARE, offset)));
    const left = Math.max(result.quad.topLeft.x, result.quad.bottomLeft.x) * W;
    assert.ok(left < 152, `prior ${offset}: left side in to x ${left.toFixed(1)} (edge 150): a wedge cut (${sidesOf(result)})`);
  }
});

test("claim 2.3 control: without the rule the same glared edge is found", () => {
  const image = skewedRule(false);
  for (const offset of [-0.004, 0, 0.004]) {
    const result = refineQuad(image, toQuad(shrink(SQUARE, offset)));
    const left = Math.max(result.quad.topLeft.x, result.quad.bottomLeft.x) * W;
    assert.ok(Math.abs(left - 150) < 1.5, `prior ${offset}: left side at x ${left.toFixed(1)} (${sidesOf(result)})`);
  }
});

/** A form with a 1.5 px border `borderPx` inside the page's edges, its code printed in the margin below it. */
function borderedForm(borderPx: number): { image: RefineImage; code: Pt[] } {
  const canvas = new Canvas(GRANITE);
  canvas.polygon(PAGE, PAPER, 1.5);
  canvas.polygon(inset(PAGE, borderPx), [30, 30, 35], 0.8);
  canvas.polygon(inset(PAGE, borderPx + 1.5), PAPER, 0.8);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const code = pageRect(0.05, 0.988, 0.3, 0.996);
  canvas.polygon(code, [40, 40, 45], 0.6);
  return { image: canvas.image(), code };
}

test("claim 1.2: a prior inside a printed border is taken out to the page's edge", () => {
  // The border 12 px inside the edges (6 mm on this page), the form's code
  // in the margin below it. The model sits inside the page, as it does as a
  // rule — here inside the border too. The border is a confident line with
  // paper-coloured surface outside it — what one sheet on another looks
  // like — but it is print, with the page's paper either side of it.
  const { image, code } = borderedForm(12);
  const result = refineQuad(image, toQuad(shrink(PAGE, 0.02)));
  // The refined bottom side, under the code's lower corners.
  const [, , br, bl] = pixels(result.quad);
  const cut = code.slice(2).filter(([x, y]) => y > bl[1] + ((br[1] - bl[1]) * (x - bl[0])) / (br[0] - bl[0]));
  assert.equal(cut.length, 0, `the form code is cut off (${sidesOf(result)})`);
  assert.ok(worstCorner(result.quad) < 0.003, `worst corner ${worstCorner(result.quad).toFixed(4)} (${sidesOf(result)})`);
});

test("finding N1: a rule 3-8 px inside the edge hides the edge", () => {
  // The same form, its border 5 px inside the edges (2.5 mm here; 1.5-4 mm
  // at 1200 px on an A4 filling half the frame). The page's edge has ink,
  // not paper, in the strip just inside it on every profile — paper, then
  // the border, then paper again, at one distance from it all along.
  const { image } = borderedForm(5);
  for (const offset of [-0.006, 0.006]) {
    const result = refineQuad(image, toQuad(shrink(PAGE, offset)));
    assert.ok(worstCorner(result.quad) < 0.003, `prior ${offset}: worst corner ${worstCorner(result.quad).toFixed(4)} (${sidesOf(result)})`);
  }
});

test("claim 1.2 control: the same prior, no border, is taken out to the page's edge", () => {
  const canvas = new Canvas(GRANITE);
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  canvas.polygon(pageRect(0.05, 0.988, 0.3, 0.996), [40, 40, 45], 0.6);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.02)));
  assert.ok(worstCorner(result.quad) < 0.003, `worst corner ${worstCorner(result.quad).toFixed(4)} (${sidesOf(result)})`);
});

test("claim 2.5: dense rules inside a faint edge do not crowd the edge out of the candidates", () => {
  // A white page on a white table (a step of ~8) whose margin is ruled
  // densely: 2 px rules 5 px apart, from 9 px inside the edge (the strip
  // just inside the edge stays paper) to the end of the band — twelve steps
  // per profile, each far stronger than the edge's, against the six
  // strongest a local profile keeps (the wide pass keeps sixteen).
  const page: Pt[] = [
    [150, 139],
    [470, 139],
    [470, 689],
    [150, 689],
  ];
  const canvas = new Canvas([230, 229, 225]);
  canvas.polygon(page, [242, 240, 233], 1.5);
  for (let y = 148; y < 176; y += 5) canvas.polygon([[156, y], [464, y], [464, y + 2], [156, y + 2]], [60, 60, 66], 0.6);
  text(canvas, 0.1, 0.12, 0.9, 0.85, page);
  const image = canvas.image();
  for (const offset of [-0.005, 0.002, 0.006]) {
    const full = refineQuad(image, toQuad(shrink(page, offset)));
    assert.ok(Math.abs(full.quad.topLeft.y * H - 139) < 1.5, `full, prior ${offset}: ${sidesOf(full)}`);
    const result = refineQuad(image, toQuad(shrink(page, offset)), { mode: "local" });
    const top = result.quad.topLeft.y * H;
    assert.ok(Math.abs(top - 139) < 1.5, `local, prior ${offset}: top side at y ${top.toFixed(1)} (edge 139) (${sidesOf(result)})`);
  }
});

test("claim 2.6: the refined quad keeps the prior's winding, whatever the prior", () => {
  // Refuted by construction: every refined line must have paper just inside
  // it (inside = towards the prior's centroid), so two sides cannot cross
  // over each other. Fuzzed: priors of every size and shape, at every
  // offset from the page, both windings, on four desks.
  let state = 12345;
  const rand = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 4294967296;
  };
  const images = [plainPage(), plainPage([232, 230, 226], [243, 238, 226]), navyPage([228, 226, 220], 0.35), plainPage([20, 20, 22])].map((c) => c.image());
  let changed = 0;
  for (let n = 0; n < 160; n += 1) {
    const image = images[n % images.length];
    const scale = 0.1 + rand() * 1.1;
    const cx = 310 + (rand() - 0.5) * 200;
    const cy = 400 + (rand() - 0.5) * 300;
    const points = PAGE.map(([x, y]) => [cx + (x - 310) * scale + (rand() - 0.5) * 40, cy + (y - 405) * scale + (rand() - 0.5) * 40] as Pt);
    const prior = n % 5 === 4 ? [points[0], points[3], points[2], points[1]] : points;
    const quad = toQuad(prior);
    const result = refineQuad(image, quad);
    if (!result.changed) continue;
    changed += 1;
    const sign = (q: Pt[]) => Math.sign(q.reduce((s, a, i) => s + a[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * a[1], 0));
    assert.equal(sign(pixels(result.quad)), sign(prior), `prior #${n} flipped (${sidesOf(result)})`);
  }
  assert.ok(changed > 40, `only ${changed} priors refined`);
});

test("claim 2.7: \"changed\" means a corner moved", () => {
  const image = plainPage().image();
  const prior = toQuad(PAGE);
  const result = refineQuad(image, prior);
  assert.ok(!result.changed || moved(result, prior) >= 0.5, `changed, largest corner move ${moved(result, prior).toFixed(2)} px (${sidesOf(result)})`);
});


// ── after the claims ─────────────────────────────────────────────────────────

test("the wide search does not cross a grey mat to a sheet beyond it", () => {
  // A white page on a grey desk mat, a band of ink along its right edge (so
  // that edge is never a paper edge), and past 7 % of the diagonal of mat a
  // second sheet lying across the mat's edge onto a wooden table: its far
  // edge has paper inside and wood — not the mat — outside, and a grey mat
  // is the colour of shaded paper. The page must be seen to go on right past
  // the side, not somewhere across the desk.
  const canvas = new Canvas([176, 128, 84]);
  canvas.polygon([[0, 0], [540, 0], [540, H], [0, H]], [150, 146, 140], 1);
  canvas.polygon([[555, 60], [585, 60], [585, 760], [555, 760]], PAPER, 1.5);
  canvas.polygon(PAGE, PAPER, 1.5);
  canvas.polygon(pageRect(0.955, 0, 1, 1), [30, 30, 36], 0.8);
  text(canvas, 0.1, 0.12, 0.85, 0.85);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.004)));
  const right = Math.max(result.quad.topRight.x, result.quad.bottomRight.x) * W;
  assert.ok(right < 500, `right side out to x ${right.toFixed(1)} (${sidesOf(result)})`);
});

test("a side bowed in at its middle is not cut along its chord", () => {
  // Both long sides of the page bow in by 10 px at their middles (a curled
  // receipt, a page lifting off the desk), the detector's corners on the
  // page's. A line through the middle of the bow is straight, well
  // supported, with desk outside it there — and 13 px inside the page's
  // corners. The side stays.
  const [, tr, br, bl] = SQUARE;
  const bow = (t: number) => 10 * (1 - (2 * t - 1) ** 2);
  const canvas = new Canvas(GRANITE);
  for (let t = 0; t < 1; t += 0.005) {
    const y0 = tr[1] + (br[1] - tr[1]) * t;
    const y1 = tr[1] + (br[1] - tr[1]) * (t + 0.005);
    canvas.polygon([[bl[0] + bow(t), y0], [tr[0] - bow(t), y0], [tr[0] - bow(t + 0.005), y1], [bl[0] + bow(t + 0.005), y1]], PAPER, 1.2);
  }
  text(canvas, 0.14, 0.12, 0.86, 0.85, SQUARE);
  const result = refineQuad(canvas.image(), toQuad(SQUARE));
  const left = Math.max(result.quad.topLeft.x, result.quad.bottomLeft.x) * W;
  const right = Math.min(result.quad.topRight.x, result.quad.bottomRight.x) * W;
  assert.ok(left <= 151 && right >= 469, `left side at x ${left.toFixed(1)}, right at ${right.toFixed(1)} (${sidesOf(result)})`);
});

test("a faint contact shadow's outer flank does not pass for the page's edge", () => {
  // A white page on a light grey table and, all round it, a contact shadow
  // 2 px wide and 15 % dark: from the page out, paper, the shadow, the
  // table. The shadow's outer flank is a step of its own, darker inside, a
  // few px past the paper's edge — the refined sides stay on the paper's.
  const canvas = new Canvas([196, 194, 190]);
  const outside = (x: number, y: number) =>
    Math.max(
      ...PAGE.map((a, i) => {
        const b = PAGE[(i + 1) % 4];
        return ((x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
      }),
    );
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const d = outside(x + 0.5, y + 0.5);
      if (d < -2 || d > 6) continue;
      for (let k = 0; k < 3; k += 1) canvas.data[(y * W + x) * 3 + k] *= 1 - 0.15 * Math.exp(-Math.max(0, d) / 2);
    }
  }
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const image = canvas.image();
  for (const offset of [-0.004, -0.002, 0.004]) {
    const result = refineQuad(image, toQuad(shrink(PAGE, offset)));
    const px = worstCorner(result.quad) * DIAG;
    assert.ok(px < 1.5, `prior ${offset}: worst corner ${px.toFixed(2)} px off (${sidesOf(result)})`);
  }
});
