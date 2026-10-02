import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedQuad } from "./quad.ts";
import { refineQuad, type CornerProvenance, type RefineImage, type RefineResult } from "./refine.ts";

/**
 * Covered corners (5d+ phase B): the edge refinement fits each side on the
 * visible run of its edge, places a covered corner where two such lines meet,
 * and says how it got each corner — seen, inferred or unknown. Pictures drawn
 * here, in the test, like `refine.test.ts`'s: a page on a desk, with a sheet,
 * a clip or a trap (white-on-white, glare, a rounded card, a torn or
 * dog-eared corner, a curled edge, a stack) at a corner. Pixel noise is
 * seeded, so every picture is the same on every run.
 */

type Rgb = [number, number, number];
type Pt = [number, number];

const W = 600;
const H = 800;
const DIAG = Math.hypot(W, H);

/** A page slightly rotated and foreshortened, as a phone sees one: TL, TR, BR, BL. */
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

  /** Brighten towards white around (cx, cy), radius r: a lamp's hot spot. */
  glare(cx: number, cy: number, r: number, strength: number): void {
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const t = Math.max(0, 1 - Math.hypot(x - cx, y - cy) / r) * strength;
        if (t <= 0) continue;
        const o = (y * W + x) * 3;
        for (let k = 0; k < 3; k += 1) this.data[o + k] += (252 - this.data[o + k]) * Math.min(1, t);
      }
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

const KEYS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;

/** One corner's distance from the page's, fraction of the diagonal. */
function cornerError(quad: NormalizedQuad, k: number, truth: Pt[] = PAGE): number {
  const p = quad[KEYS[k]];
  return Math.hypot(p.x * W - truth[k][0], p.y * H - truth[k][1]) / DIAG;
}

function worstCorner(quad: NormalizedQuad, truth: Pt[] = PAGE): number {
  return Math.max(...[0, 1, 2, 3].map((k) => cornerError(quad, k, truth)));
}

function provenance(result: RefineResult): CornerProvenance[] {
  return result.corners.map((c) => c.provenance);
}

function describe(result: RefineResult): string {
  return `${provenance(result).join(",")} · ${result.sides.map((s) => `${s.mode}/${s.reason}`).join(" ")} · ${result.reason}`;
}

const LEATHER: Rgb = [70, 48, 36];
const PAPER: Rgb = [240, 238, 232];
/** A leaflet a shade off the page's white. */
const LEAFLET: Rgb = [246, 245, 241];

/** A white page with text on a dark leather mat. */
function page(background: Rgb = LEATHER): Canvas {
  const canvas = new Canvas(background);
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  return canvas;
}

/** Where the line a→b meets the line c→d. */
function meet(a: Pt, b: Pt, c: Pt, d: Pt): Pt {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / (r[0] * s[1] - r[1] * s[0]);
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}

/**
 * A sheet over the page's top-left corner, its own corner on the page at
 * (u, v) and its edges square to the page's: it covers `u` of the top edge
 * and `v` of the left, and reaches well past both onto the desk.
 */
function sheetOverTopLeft(canvas: Canvas, u: number, v: number, colour: Rgb = LEAFLET): Pt[] {
  const tip = onPage(u, v);
  const sheet: Pt[] = [
    [tip[0] - 260, tip[1] - 220],
    [tip[0], tip[1] - 220],
    tip,
    [tip[0] - 260, tip[1]],
  ];
  canvas.polygon(sheet, colour, 1.2);
  return sheet;
}

/** The model's typical answer under a sheet over the top-left corner: its corner where the sheet's edge crosses the left edge. */
function crossingPrior(v: number): Pt[] {
  const crossing = onPage(0, v);
  return [crossing, PAGE[1], PAGE[2], PAGE[3]];
}

// ── line fitting on the visible runs ─────────────────────────────────────────

test("a sheet over a corner: the corner is inferred where the visible runs of its two edges meet", () => {
  const canvas = page();
  sheetOverTopLeft(canvas, 0.12, 0.2);
  const result = refineQuad(canvas.image(), toQuad(crossingPrior(0.2)));
  assert.ok(cornerError(result.quad, 0) < 0.005, `top-left off by ${(cornerError(result.quad, 0) * 100).toFixed(2)} % (${describe(result)})`);
  assert.ok(worstCorner(result.quad) < 0.005, describe(result));
  assert.deepEqual(provenance(result), ["inferred", "seen", "seen", "seen"], describe(result));
  assert.equal(result.occlusion.suspected, true);
  assert.equal(result.occlusion.separate, false);
  assert.ok(result.corners[0].confidence > 0.5, `confidence ${result.corners[0].confidence}`);
});

test("a sheet over a corner, the model's corner out on the sheet: the quad does not grow onto it", () => {
  const canvas = page();
  sheetOverTopLeft(canvas, 0.1, 0.18);
  // The model's corner out on the sheet, past the page's (5 % of the diagonal).
  const prior: Pt[] = [[PAGE[0][0] - 30, PAGE[0][1] - 40], PAGE[1], PAGE[2], PAGE[3]];
  const result = refineQuad(canvas.image(), toQuad(prior));
  assert.ok(cornerError(result.quad, 0) < 0.005, `top-left off by ${(cornerError(result.quad, 0) * 100).toFixed(2)} % (${describe(result)})`);
  assert.equal(provenance(result)[0], "inferred", describe(result));
});

test("a sheet in the faint shade of the page's white, its edge over the page only a shadow line: still inferred", () => {
  const canvas = page();
  const tip = onPage(0.1, 0.22);
  // The sheet's soft shadow on the page, then the sheet in the page's own white.
  canvas.polygon([[tip[0] - 260, tip[1] - 220], [tip[0] + 3, tip[1] - 220], [tip[0] + 3, tip[1] + 3], [tip[0] - 260, tip[1] + 3]], [205, 203, 198], 3);
  sheetOverTopLeft(canvas, 0.1, 0.22, PAPER);
  const result = refineQuad(canvas.image(), toQuad(crossingPrior(0.22)));
  assert.ok(cornerError(result.quad, 0) < 0.006, `top-left off by ${(cornerError(result.quad, 0) * 100).toFixed(2)} % (${describe(result)})`);
  assert.equal(provenance(result)[0], "inferred", describe(result));
});

test("a covered corner whose edges would be extended further than they are seen is unknown, not inferred", () => {
  const canvas = page();
  // The sheet covers 40 % of each edge: the corner would be extended two
  // thirds as far as either edge is seen.
  sheetOverTopLeft(canvas, 0.4, 0.4);
  const prior: Pt[] = [onPage(0.4, 0), PAGE[1], PAGE[2], PAGE[3]];
  const result = refineQuad(canvas.image(), toQuad(prior));
  assert.equal(provenance(result)[0], "unknown", describe(result));
  assert.equal(result.corners[0].confidence, 0);
  // Placed where the edges meet all the same — never on the sheet.
  assert.ok(cornerError(result.quad, 0) < 0.004, `top-left off by ${(cornerError(result.quad, 0) * 100).toFixed(2)} %`);
  assert.equal(result.occlusion.suspected, true);
});

test("a black binder clip over a corner: inferred, at the edges' meeting point", () => {
  const canvas = page();
  const [x, y] = PAGE[1];
  // The clip's body turned 45° over the top-right corner, most of it past the page.
  canvas.polygon([[x - 6, y - 26], [x + 26, y + 6], [x + 6, y + 26], [x - 26, y - 6]], [22, 22, 24], 1.2);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.ok(cornerError(result.quad, 1) < 0.004, `top-right off by ${(cornerError(result.quad, 1) * 100).toFixed(2)} % (${describe(result)})`);
  assert.equal(provenance(result)[1], "inferred", describe(result));
});

test("a clip mid-edge hides no corner: every corner is seen", () => {
  const canvas = page();
  const [a, b] = [onPage(0.4, 0), onPage(0.6, 0)];
  canvas.polygon([[a[0], a[1] - 18], [b[0], b[1] - 18], [b[0], b[1] + 24], [a[0], a[1] + 24]], [150, 152, 156], 1);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.deepEqual(provenance(result), ["seen", "seen", "seen", "seen"], describe(result));
  assert.ok(worstCorner(result.quad) < 0.004, describe(result));
});

// ── real corners that must not be called covered ────────────────────────────

test("trap: a white page on a white table is seen, not inferred", () => {
  const canvas = new Canvas([226, 224, 220]);
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.deepEqual(provenance(result), ["seen", "seen", "seen", "seen"], describe(result));
  assert.equal(result.occlusion.separate, false);
});

test("trap: a lamp's glare washing out a corner and the desk round it is seen, not covered", () => {
  const canvas = page();
  canvas.glare(PAGE[0][0] - 10, PAGE[0][1] - 10, 90, 1.1);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.equal(provenance(result)[0], "seen", describe(result));
});

test("trap: an ID card's rounded corners are seen (the corner is where the edges meet, nothing lies over it)", () => {
  const card: Pt[] = [
    [180, 300],
    [420, 290],
    [428, 446],
    [186, 454],
  ];
  const canvas = new Canvas(LEATHER);
  // A rounded card: the quad less a quarter-disc's worth at each corner.
  const r = 14;
  const at = (k: number, t: number): Pt => {
    const p = card[k];
    const a = card[(k + 3) % 4];
    const b = card[(k + 1) % 4];
    const ua = [(a[0] - p[0]) / Math.hypot(a[0] - p[0], a[1] - p[1]), (a[1] - p[1]) / Math.hypot(a[0] - p[0], a[1] - p[1])];
    const ub = [(b[0] - p[0]) / Math.hypot(b[0] - p[0], b[1] - p[1]), (b[1] - p[1]) / Math.hypot(b[0] - p[0], b[1] - p[1])];
    const c = [p[0] + (ua[0] + ub[0]) * r, p[1] + (ua[1] + ub[1]) * r];
    return [c[0] - ua[0] * r * Math.cos(t) - ub[0] * r * Math.sin(t), c[1] - ua[1] * r * Math.cos(t) - ub[1] * r * Math.sin(t)];
  };
  const outline: Pt[] = [];
  for (let k = 0; k < 4; k += 1) for (let i = 0; i <= 6; i += 1) outline.push(at(k, (i / 6) * (Math.PI / 2)));
  canvas.polygon(outline, [236, 238, 242], 1.2);
  const result = refineQuad(canvas.image(), toQuad(card.map(([x, y]) => [x + (x < 300 ? 3 : -3), y + (y < 370 ? 3 : -3)] as Pt)));
  assert.deepEqual(provenance(result), ["seen", "seen", "seen", "seen"], describe(result));
});

test("trap: a torn-off corner (the desk where the corner was) is seen", () => {
  const canvas = page();
  canvas.polygon([PAGE[2], [PAGE[2][0] - 2, PAGE[2][1] - 40], [PAGE[2][0] - 34, PAGE[2][1] + 1]], LEATHER, 1);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.equal(provenance(result)[2], "seen", describe(result));
  assert.equal(result.occlusion.suspected, false, describe(result));
});

test("trap: a dog-ear (the corner folded back onto the page) is never unknown, and the crop is the page's", () => {
  const canvas = page();
  const [x, y] = PAGE[3];
  const a: Pt = [x + 1, y - 46];
  const b: Pt = [x + 44, y - 1];
  // The desk where the corner was, the flap's back lying on the page.
  canvas.polygon([PAGE[3], a, b], LEATHER, 1);
  canvas.polygon([a, [x + 40, y - 42], b], [214, 212, 205], 1);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.notEqual(provenance(result)[3], "unknown", describe(result));
  assert.ok(cornerError(result.quad, 3) < 0.006, `bottom-left off by ${(cornerError(result.quad, 3) * 100).toFixed(2)} % (${describe(result)})`);
});

test("trap: a curled edge is not extended into an inferred corner", () => {
  const canvas = new Canvas(LEATHER);
  // The right edge bows out by up to 9 px towards its bottom: a curl.
  const bow = (t: number) => 9 * t * t;
  for (let t = 0; t < 1; t += 0.005) {
    const left = onPage(0, t);
    const right = onPage(1, t);
    const left2 = onPage(0, t + 0.005);
    const right2 = onPage(1, t + 0.005);
    canvas.polygon([left, [right[0] + bow(t), right[1]], [right2[0] + bow(t + 0.005), right2[1]], left2], PAPER, 1.2);
  }
  text(canvas, 0.1, 0.12, 0.85, 0.85);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.ok(!provenance(result).includes("inferred"), describe(result));
});

test("trap: the top sheet of a stack (its side face a few px past two edges) is seen, and not two sheets", () => {
  const canvas = new Canvas(LEATHER);
  // The stack's side face: a slightly darker paper 4 px past the right and bottom edges.
  canvas.polygon(
    [PAGE[0], [PAGE[1][0] + 4, PAGE[1][1]], [PAGE[2][0] + 4, PAGE[2][1] + 4], [PAGE[3][0], PAGE[3][1] + 4]],
    [208, 205, 198],
    1.2,
  );
  canvas.polygon(PAGE, PAPER, 1.2);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.deepEqual(provenance(result), ["seen", "seen", "seen", "seen"], describe(result));
  assert.equal(result.occlusion.separate, false);
});

// ── two sheets ────────────────────────────────────────────────────────────────

test("two full sheets, one lying half under the other: the top sheet is answered, and the two are said to overlap", () => {
  const canvas = new Canvas(LEATHER);
  // The other sheet, offset down and right, under this one…
  canvas.polygon(PAGE.map(([x, y]) => [x + 120, y + 180] as Pt), PAPER, 1.2);
  // …the top sheet's thin contact shadow on it, and the top sheet.
  canvas.polygon(PAGE.map(([x, y]) => [x + 2, y + 2] as Pt), [196, 194, 188], 2);
  canvas.polygon(PAGE, PAPER, 1.2);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.ok(worstCorner(result.quad) < 0.006, describe(result));
  assert.equal(result.occlusion.separate || result.occlusion.suspected, true, describe(result));
});

// ── the occluder guard ───────────────────────────────────────────────────────

test("guard: a side found on a sheet's outline, the page's own edge seen inside it, is refitted on the page's run — never the sheet's", () => {
  const canvas = page();
  // A sheet square to the page over its top-left, 18 px past the top edge and
  // over 60 % of it: its top edge runs parallel past the page's, and is a
  // straight paper edge with the desk outside — what a page's edge looks like.
  const tl = onPage(0, 0);
  const sheet: Pt[] = [
    [tl[0] - 120, tl[1] - 18],
    [onPage(0.6, 0)[0], onPage(0.6, 0)[1] - 18],
    onPage(0.6, 0.3),
    [tl[0] - 120, onPage(0, 0.3)[1]],
  ];
  canvas.polygon(sheet, LEAFLET, 1.2);
  const prior: Pt[] = [[tl[0] - 20, tl[1] - 9], [PAGE[1][0], PAGE[1][1] - 3], PAGE[2], PAGE[3]];
  const result = refineQuad(canvas.image(), toQuad(prior));
  assert.equal(result.sides[0].reason, "occluder-edge", describe(result));
  assert.ok(cornerError(result.quad, 0) < 0.004, `top-left off by ${(cornerError(result.quad, 0) * 100).toFixed(2)} % (${describe(result)})`);
  // Placed where the page's edges meet, but extended far past what is seen of
  // the top edge: not trusted.
  assert.equal(provenance(result)[0], "unknown", describe(result));
});

// ── the model's quad the union of the page and what lies over it ─────────────

/** A smaller page low right in the picture, and room up-left for a big sheet over its corner. */
const SMALL: Pt[] = [
  [262, 330],
  [520, 316],
  [536, 700],
  [248, 710],
];

test("the model's quad spans the page and a big sheet over its corner: the quad comes back to the page's visible runs", () => {
  const canvas = new Canvas(LEATHER);
  canvas.polygon(SMALL, PAPER, 1.5);
  text(canvas, 0.1, 0.15, 0.9, 0.85, SMALL);
  // The sheet's own corner on the page, the sheet reaching far up and left.
  const tip = onPage(0.12, 0.14, SMALL);
  canvas.polygon([[18, 58], [tip[0], 58], tip, [18, tip[1]]], LEAFLET, 1.2);
  // The model's corner out on the sheet's far corner: the union of the two,
  // over half again the page — the page's top edge is seen along under half
  // of the prior's top side.
  const prior: Pt[] = [[24, 64], SMALL[1], SMALL[2], SMALL[3]];
  const result = refineQuad(canvas.image(), toQuad(prior));
  assert.ok(cornerError(result.quad, 0, SMALL) < 0.006, `top-left off by ${(cornerError(result.quad, 0, SMALL) * 100).toFixed(2)} % (${describe(result)})`);
  assert.ok(worstCorner(result.quad, SMALL) < 0.006, describe(result));
  assert.notEqual(provenance(result)[0], "seen", describe(result));
  assert.equal(result.occlusion.suspected, true);
});

// ── two sheets: the page on another, the desk between two ───────────────────

test("two sheets: the page's corner lying on another sheet is seen, and the two sheets are said to overlap", () => {
  const canvas = new Canvas(LEATHER);
  // The other sheet under the page's bottom-right corner, reaching well past it.
  const corner = PAGE[2];
  canvas.polygon([[corner[0] - 150, corner[1] - 170], [corner[0] + 90, corner[1] - 182], [corner[0] + 100, corner[1] + 90], [corner[0] - 140, corner[1] + 96]], [236, 236, 230], 1.2);
  // The page's soft contact shadow on it, then the page.
  canvas.polygon(PAGE.map(([x, y]) => [x + 2, y + 3] as Pt), [190, 188, 182], 3);
  canvas.polygon(PAGE, PAPER, 1.2);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.ok(worstCorner(result.quad) < 0.005, describe(result));
  assert.deepEqual(provenance(result), ["seen", "seen", "seen", "seen"], describe(result));
  assert.equal(result.occlusion.separate, true, describe(result));
});

test("two sheets taken for one (the desk between them inside the answer): the two are said to overlap", () => {
  const canvas = new Canvas(LEATHER);
  // Two sheets, the second down and to the right, overlapping at one corner;
  // the model's quad their hull.
  const a: Pt[] = [
    [80, 90],
    [330, 82],
    [338, 420],
    [86, 428],
  ];
  const b: Pt[] = a.map(([x, y]) => [x + 110, y + 300] as Pt);
  canvas.polygon(a, PAPER, 1.2);
  text(canvas, 0.1, 0.12, 0.9, 0.85, a);
  canvas.polygon(b.map(([x, y]) => [x + 2, y + 3] as Pt), [190, 188, 182], 3);
  canvas.polygon(b, PAPER, 1.2);
  text(canvas, 0.1, 0.12, 0.9, 0.85, b);
  const hull: Pt[] = [a[0], [b[1][0], a[1][1]], b[2], [a[3][0], b[3][1]]];
  const result = refineQuad(canvas.image(), toQuad(hull));
  assert.equal(result.occlusion.separate, true, describe(result));
});

test("trap: a page on a desk mat, the mat's edge and the wood past it near a corner, is one page", () => {
  const canvas = new Canvas([188, 140, 96]);
  // The mat ends 30 px past the page's right edge.
  canvas.polygon([[0, 0], [PAGE[1][0] + 30, 0], [PAGE[2][0] + 30, H], [0, H]], LEATHER, 1.5);
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  const result = refineQuad(canvas.image(), toQuad(shrink(PAGE, 0.006)));
  assert.deepEqual(provenance(result), ["seen", "seen", "seen", "seen"], describe(result));
  assert.equal(result.occlusion.separate, false, describe(result));
});

// ── a clipboard ──────────────────────────────────────────────────────────────

test("a page on a clipboard, the board's margin wide at the top and bottom and too thin to read at the sides: the crop is the page's", () => {
  const canvas = new Canvas([214, 210, 204]);
  const [tl, tr, br, bl] = PAGE;
  // The board: 3 px past the page's sides, 60 px past its top, 30 px past its bottom.
  canvas.polygon([[tl[0] - 3, tl[1] - 60], [tr[0] + 3, tr[1] - 60], [br[0] + 3, br[1] + 30], [bl[0] - 3, bl[1] + 30]], [120, 82, 52], 1.2);
  canvas.polygon(PAGE, PAPER, 1.5);
  text(canvas, 0.1, 0.12, 0.9, 0.85);
  // The clip over the top edge's middle, out over the board.
  const [a, b] = [onPage(0.35, 0), onPage(0.65, 0)];
  canvas.polygon([[a[0], a[1] - 40], [b[0], b[1] - 40], [b[0], b[1] + 22], [a[0], a[1] + 22]], [40, 40, 44], 1.2);
  // The model's quad: the board's outline.
  const prior: Pt[] = [[tl[0] - 3, tl[1] - 60], [tr[0] + 3, tr[1] - 60], [br[0] + 3, br[1] + 30], [bl[0] - 3, bl[1] + 30]];
  const result = refineQuad(canvas.image(), toQuad(prior));
  assert.ok(worstCorner(result.quad) < 0.006, describe(result));
});
