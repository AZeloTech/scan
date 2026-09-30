/**
 * The text deskew, on pages whose skew is known by construction.
 *
 * Pages are drawn in level text frames and then rotated by θ with a
 * supersampled inverse map, so the estimator is graded against the θ that
 * made them — never against another estimator. The abstentions are the other
 * half of the contract: a flat page, a sparse form, a picture, a page lying on
 * its side, a level heading over a skewed body, handwriting across level
 * rules — each must come back untouched.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CURL_BOW_FRACTION,
  DESKEW_MAX_DEG,
  DESKEW_POLICY_VERSION,
  applyHomography,
  curlEvidence,
  decideWedgePaint,
  deskewQuad,
  estimateSkew,
  fillDeskewWedges,
  homographyFrom,
  inscribedScale,
  judgeDeskew,
  outsideEdge,
  paintWedgeWindow,
  planStraighten,
  wedgeFillFrom,
  wedgePaintBoxes,
  wedgeSampleBoxes,
  type DeskewImage,
  type DeskewPlan,
  type DeskewQuad,
  type PixelWindow,
  type SkewEstimate,
} from "./deskew.ts";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Layout =
  | "paragraphs"
  | "twocol"
  | "sparse"
  | "graphic"
  | "blank"
  | "header"
  | "body-below"
  | "onecol-left"
  | "handwriting"
  | "rules"
  | "vertical";

const W = 560;
const H = 740;

/** Ink bitmap in a level text frame (w×h): hollow-ish glyphs grouped into words. */
function layoutBitmap(layout: Layout, seed: number, w = W, h = H): Uint8Array {
  const bm = new Uint8Array(w * h);
  const rnd = rng(seed);
  const dot = (x: number, y: number): void => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px >= 0 && py >= 0 && px < w && py < h) bm[py * w + px] = 1;
  };
  const glyph = (x: number, y: number, gw: number, gh: number, vertical = false): void => {
    for (let dy = 0; dy < gh; dy += 1) {
      for (let dx = 0; dx < gw; dx += 1) {
        if (dx > 0 && dx < gw - 1 && dy > 1 && dy < gh - 2) continue;
        if (vertical) dot(x + dy, y + dx);
        else dot(x + dx, y + dy);
      }
    }
  };
  /** A line of words from x0 to x1 at y, rising `slope` degrees per unit x (+ = descends right). */
  const run = (x0: number, x1: number, y: number, maxWords = Infinity, slope = 0, big = 1): void => {
    let x = x0;
    let words = 0;
    const k = Math.tan((slope * Math.PI) / 180);
    while (x < x1 && words < maxWords) {
      const letters = 2 + Math.floor(rnd() * 6);
      for (let g = 0; g < letters && x < x1; g += 1) {
        const gw = (4 + Math.floor(rnd() * 2)) * big;
        glyph(x, y + (x - x0) * k + (rnd() < 0.3 ? -2 : 0), gw, (7 + (rnd() < 0.3 ? 2 : 0)) * big);
        x += gw + 1;
      }
      x += 5 * big;
      words += 1;
    }
  };
  const rect = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = Math.round(y0); y < Math.round(y1); y += 1) {
      for (let x = Math.round(x0); x < Math.round(x1); x += 1) dot(x, y);
    }
  };
  switch (layout) {
    case "paragraphs":
      for (let y = 0.08 * h; y < 0.92 * h - 12; y += 15) {
        if (rnd() < 0.08) continue;
        run(0.1 * w, rnd() < 0.2 ? w * (0.3 + 0.4 * rnd()) : 0.9 * w, y);
      }
      break;
    case "twocol":
      for (const [l, r] of [
        [0.08, 0.46],
        [0.54, 0.92],
      ]) {
        for (let y = 0.1 * h; y < 0.9 * h; y += 14) run(l * w, r * w, y);
      }
      break;
    case "sparse":
      // A form with almost nothing on it: a title, three labels, rules.
      run(0.1 * w, 0.4 * w, 0.08 * h);
      for (let i = 0; i < 3; i += 1) {
        run(0.1 * w, 0.3 * w, 0.2 * h + i * 60, 1);
        rect(0.35 * w, 0.2 * h + i * 60 + 9, 0.9 * w, 0.2 * h + i * 60 + 11);
      }
      break;
    case "graphic":
      rect(0.1 * w, 0.1 * h, 0.9 * w, 0.7 * h);
      run(0.1 * w, 0.6 * w, 0.75 * h);
      run(0.1 * w, 0.5 * w, 0.8 * h);
      break;
    case "blank":
      break;
    case "header":
      // A heading block: three lines of large print in the top fifth.
      for (let i = 0; i < 3; i += 1) run(0.12 * w, 0.88 * w, 0.05 * h + i * 30, Infinity, 0, 2);
      break;
    case "body-below":
      for (let y = 0.3 * h; y < 0.92 * h - 12; y += 15) run(0.1 * w, 0.9 * w, y);
      break;
    case "onecol-left":
      for (let y = 0.08 * h; y < 0.92 * h - 12; y += 15) run(0.06 * w, 0.44 * w, y);
      break;
    case "handwriting":
      // Lines that each wander their own way: alternating ±2.5°.
      for (let i = 0, y = 0.1 * h; y < 0.86 * h; i += 1, y += 24) {
        run(0.1 * w, 0.9 * w, y, Infinity, i % 2 === 0 ? 2.5 : -2.5);
      }
      break;
    case "rules":
      for (let y = 0.1 * h + 12; y < 0.9 * h; y += 24) rect(0.06 * w, y, 0.94 * w, y + 2);
      break;
    case "vertical":
      // Print a quarter turn away: columns of glyphs running down the page.
      for (let x = 0.1 * w; x < 0.9 * w - 12; x += 15) {
        let y = 0.08 * h;
        while (y < 0.92 * h) {
          const letters = 2 + Math.floor(rnd() * 6);
          for (let g = 0; g < letters && y < 0.92 * h; g += 1) {
            const gw = 4 + Math.floor(rnd() * 2);
            glyph(x, y, gw, 7, true);
            y += gw + 1;
          }
          y += 5;
        }
      }
      break;
  }
  return bm;
}

interface Layer {
  layout: Layout;
  deg: number;
  bow?: number;
  seed?: number;
}

interface PageOptions {
  width?: number;
  height?: number;
  /** Paper RGB at the brightest. */
  paper?: [number, number, number];
  /** Multiplicative shade from left (1) to right (this). */
  shadeTo?: number;
  seed?: number;
}

/**
 * Layers of print, each rotated by its own θ (+ = lines descend right) about
 * the centre and bent by its own `bow` (sagitta, px), 3×3 supersampled.
 */
function compose(layers: Layer[], options: PageOptions = {}): DeskewImage {
  const w = options.width ?? W;
  const h = options.height ?? H;
  const paper = options.paper ?? [235, 232, 225];
  const shadeTo = options.shadeTo ?? 1;
  const maps = layers.map((layer) => ({
    bm: layoutBitmap(layer.layout, layer.seed ?? options.seed ?? 7, w, h),
    c: Math.cos((layer.deg * Math.PI) / 180),
    s: Math.sin((layer.deg * Math.PI) / 180),
    bow: layer.bow ?? 0,
  }));
  const data = new Uint8ClampedArray(w * h * 4);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const noise = rng((options.seed ?? 7) + 1);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let cover = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const dx = x + (sx - 1) / 3 - cx;
          const dy = y + (sy - 1) / 3 - cy;
          let hit = false;
          for (const m of maps) {
            const uf = cx + m.c * dx + m.s * dy;
            const tt = (uf - cx) / cx;
            const u = Math.round(uf);
            const v = Math.round(cy - m.s * dx + m.c * dy - m.bow * (1 - tt * tt));
            if (u >= 0 && v >= 0 && u < w && v < h && m.bm[v * w + u] === 1) {
              hit = true;
              break;
            }
          }
          if (hit) cover += 1;
        }
      }
      const shade = 1 + (shadeTo - 1) * (x / (w - 1));
      const ink = cover / 9;
      const o = (y * w + x) * 4;
      const jitter = (noise() - 0.5) * 8;
      for (let c = 0; c < 3; c += 1) {
        data[o + c] = (paper[c] * (1 - 0.85 * ink)) * shade + jitter;
      }
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function page(layout: Layout, deg: number, seed = 7, bow = 0): DeskewImage {
  return compose([{ layout, deg, bow, seed }], { seed });
}

/* ── The estimate ─────────────────────────────────────────────────────── */

for (const deg of [0.3, -0.3, 1, -1, 3, -3, 8, -8, 15, -15]) {
  test(`estimates a ${deg}° print skew within ±0.1°`, () => {
    const estimate = estimateSkew(page("paragraphs", deg));
    assert.ok(
      Math.abs(estimate.deg - deg) <= 0.1,
      `estimated ${estimate.deg.toFixed(3)}° for ${deg}° (${estimate.reason})`,
    );
    if (Math.abs(deg) >= 0.5) assert.equal(estimate.act, true, estimate.reason);
  });
}

test("two columns are estimated as well", () => {
  const estimate = estimateSkew(page("twocol", 4, 3));
  assert.ok(Math.abs(estimate.deg - 4) <= 0.1, `${estimate.deg}`);
  assert.equal(estimate.act, true);
});

test("a level page abstains as negligible", () => {
  const estimate = estimateSkew(page("paragraphs", 0));
  assert.equal(estimate.act, false);
  assert.equal(estimate.reason, "negligible");
  assert.ok(Math.abs(estimate.deg) < 0.1, `${estimate.deg}`);
});

test("a sparse form abstains", () => {
  for (const deg of [0, 3]) {
    const estimate = estimateSkew(page("sparse", deg));
    assert.equal(estimate.act, false, `${deg}°: ${estimate.reason}`);
  }
});

test("a page that is mostly picture abstains", () => {
  const estimate = estimateSkew(page("graphic", 3));
  assert.equal(estimate.act, false);
  assert.ok(["graphic", "sparse", "few-lines"].includes(estimate.reason), estimate.reason);
});

test("a blank page abstains", () => {
  assert.equal(estimateSkew(page("blank", 0)).act, false);
});

test("beyond the act range it abstains", () => {
  const estimate = estimateSkew(page("paragraphs", 22));
  assert.equal(estimate.act, false);
  assert.ok(Math.abs(22) > DESKEW_MAX_DEG);
});

test("a curled page whose halves tilt apart abstains as curved", () => {
  const estimate = estimateSkew(page("paragraphs", 0, 7, 12));
  assert.equal(estimate.act, false, `${estimate.reason} ${estimate.deg}`);
  assert.equal(estimate.reason, "curved");
  const [left, right] = estimate.halves ?? [NaN, NaN];
  assert.ok(Math.abs(left - right) > 3, `${left} / ${right}`);
});

test("a gentle curl still deskews to the mean tilt", () => {
  const estimate = estimateSkew(page("paragraphs", 3, 7, 4));
  assert.equal(estimate.act, true, estimate.reason);
  assert.ok(Math.abs(estimate.deg - 3) < 0.25, `${estimate.deg}`);
});

test("one column to one side: both ink halves are measured, so a curl cannot slip past the veto", () => {
  // The page-centre split left the empty right half NaN, and a NaN spread
  // passed the veto — a curled single column was rotated by a garbage angle.
  const level = estimateSkew(page("onecol-left", 3));
  const [l, r] = level.halves ?? [NaN, NaN];
  assert.ok(Number.isFinite(l) && Number.isFinite(r), `halves ${l} / ${r}`);
  assert.equal(level.act, true, level.reason);
  assert.ok(Math.abs(level.deg - 3) <= 0.15, `${level.deg}`);
  // A column this curled splits its own two halves by ~4°: the veto sees it.
  // (Split at the page centre, its right half was empty — NaN — and the
  // column was rotated by the average of its bend.)
  const curled = estimateSkew(page("onecol-left", 0, 7, 25));
  const [cl, cr] = curled.halves ?? [NaN, NaN];
  assert.ok(Number.isFinite(cl) && Number.isFinite(cr), `halves ${cl} / ${cr}`);
  assert.equal(curled.act, false, `${curled.reason} ${curled.deg}`);
  assert.equal(curled.reason, "curved");
});

test("a level heading over a skewed body abstains as mixed", () => {
  for (const deg of [7, -5]) {
    const estimate = estimateSkew(
      compose([
        { layout: "header", deg: 0, seed: 11 },
        { layout: "body-below", deg, seed: 12 },
      ]),
    );
    assert.equal(estimate.act, false, `${deg}°: acted ${estimate.deg}`);
    assert.equal(estimate.reason, "mixed", `${deg}°`);
    assert.ok(Math.abs(estimate.orphanDeg ?? NaN) < 1, `orphans at ${estimate.orphanDeg}`);
  }
});

test("a heading skewed with its body is one block, and acts", () => {
  const estimate = estimateSkew(
    compose([
      { layout: "header", deg: 4, seed: 11 },
      { layout: "body-below", deg: 4, seed: 12 },
    ]),
  );
  assert.equal(estimate.act, true, estimate.reason);
  assert.ok(Math.abs(estimate.deg - 4) <= 0.15, `${estimate.deg}`);
});

test("handwriting whose lines wander both ways is not given one rotation", () => {
  const estimate = estimateSkew(page("handwriting", 0, 5));
  assert.ok(!estimate.act || Math.abs(estimate.deg) < 0.5, `${estimate.reason} ${estimate.deg}`);
});

test("handwriting across level rules abstains: the rules are the page's horizontal", () => {
  const estimate = estimateSkew(
    compose([
      { layout: "rules", deg: 0 },
      { layout: "paragraphs", deg: 2.5, seed: 9 },
    ]),
  );
  assert.equal(estimate.act, false, `acted ${estimate.deg}`);
  assert.equal(estimate.reason, "rules-disagree");
  assert.ok(Math.abs(estimate.rulesDeg ?? NaN) < 0.2, `rules at ${estimate.rulesDeg}`);
});

test("a ruled form fed crooked, rules and print together, acts", () => {
  const estimate = estimateSkew(
    compose([
      { layout: "rules", deg: 3 },
      { layout: "paragraphs", deg: 3, seed: 9 },
    ]),
  );
  assert.equal(estimate.act, true, estimate.reason);
  assert.ok(Math.abs(estimate.deg - 3) <= 0.15, `${estimate.deg}`);
});

test("a page lying on its side (print a quarter turn away) abstains", () => {
  for (const deg of [0, 3]) {
    const estimate = estimateSkew(page("vertical", deg));
    assert.equal(estimate.act, false, `${deg}°: acted ${estimate.deg}`);
  }
});

test("a landscape page is estimated like a portrait one", () => {
  const estimate = estimateSkew(compose([{ layout: "paragraphs", deg: -4 }], { width: 740, height: 520 }));
  assert.equal(estimate.act, true, estimate.reason);
  assert.ok(Math.abs(estimate.deg + 4) <= 0.12, `${estimate.deg}`);
});

test("coloured, shadowed paper is estimated like white paper", () => {
  const estimate = estimateSkew(
    compose([{ layout: "paragraphs", deg: 3 }], { paper: [236, 214, 160], shadeTo: 0.6 }),
  );
  assert.equal(estimate.act, true, estimate.reason);
  assert.ok(Math.abs(estimate.deg - 3) <= 0.12, `${estimate.deg}`);
});

/* ── Geometry ─────────────────────────────────────────────────────────── */

const perspectiveQuad: DeskewQuad = {
  topLeft: { x: 410, y: 300 },
  topRight: { x: 1590, y: 340 },
  bottomRight: { x: 1650, y: 1880 },
  bottomLeft: { x: 350, y: 1830 },
};

test("the deskewed outline is homography-then-rotation, in one map", () => {
  const w = 1200;
  const h = 1550;
  const deg = 5;
  const { quad, scale } = deskewQuad({
    quad: perspectiveQuad,
    outputWidth: w,
    outputHeight: h,
    canonicalWidth: 2000,
    canonicalHeight: 2200,
    deg,
    mode: "paper",
  });
  assert.equal(scale, 1);
  const rect = [
    { x: 0, y: 0 },
    { x: w - 1, y: 0 },
    { x: w - 1, y: h - 1 },
    { x: 0, y: h - 1 },
  ];
  const list = (q: DeskewQuad) => [q.topLeft, q.topRight, q.bottomRight, q.bottomLeft];
  const canonicalToFlat = homographyFrom(list(perspectiveQuad), rect);
  const outToCanonical = homographyFrom(rect, list(quad));
  const t = (deg * Math.PI) / 180;
  for (const p of [
    { x: 100, y: 200 },
    { x: 900, y: 1300 },
    { x: 600, y: 775 },
  ]) {
    const f = applyHomography(canonicalToFlat, applyHomography(outToCanonical, p));
    const dx = p.x - (w - 1) / 2;
    const dy = p.y - (h - 1) / 2;
    const ex = (w - 1) / 2 + Math.cos(t) * dx - Math.sin(t) * dy;
    const ey = (h - 1) / 2 + Math.sin(t) * dx + Math.cos(t) * dy;
    assert.ok(Math.hypot(f.x - ex, f.y - ey) < 1e-6, `${JSON.stringify(f)} vs ${ex},${ey}`);
  }
});

function planFor(
  geometry: ReturnType<typeof deskewQuad>,
  deg: number,
  overrides: Partial<DeskewPlan> = {},
): DeskewPlan {
  return {
    policyVersion: DESKEW_POLICY_VERSION,
    deg,
    quad: geometry.quad,
    scale: geometry.scale,
    mode: "paper",
    pageInOutput: geometry.pageInOutput,
    cornerColors: [
      [225, 225, 225],
      [225, 225, 225],
      [225, 225, 225],
      [225, 225, 225],
    ],
    paint: [true, true, true, true],
    bleedFraction: 0,
    photoInOutput: geometry.photoInOutput,
    curl: curlEvidence({ deg, halves: [deg, deg] } as SkewEstimate, null),
    ...overrides,
  };
}

test("crop mode uses the inscribed rectangle and leaves no wedge", () => {
  const w = 1000;
  const h = 1400;
  const geometry = deskewQuad({
    quad: perspectiveQuad,
    outputWidth: w,
    outputHeight: h,
    canonicalWidth: 2000,
    canonicalHeight: 2200,
    deg: -6,
    mode: "crop",
  });
  assert.ok(Math.abs(geometry.scale - inscribedScale(w, h, -6)) < 1e-12);
  const image = { width: 50, height: 70, data: new Uint8ClampedArray(50 * 70 * 4).fill(0) };
  // Painted as if it were paper mode: nothing lies outside the page.
  const painted = fillDeskewWedges(image, planFor(geometry, -6, { bleedFraction: 0.0001 }));
  // Only the one-pixel bleed along the frame's edge, never a wedge.
  assert.ok(painted <= 0.01 * 50 * 70, `${painted} wedge pixels at the inscribed scale`);
});

test("paper mode keeps the page's scale and marks what lies beyond the photo", () => {
  // outline == the whole photo: the rotated rectangle cannot fit at scale 1
  const full: DeskewQuad = {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 999, y: 0 },
    bottomRight: { x: 999, y: 1399 },
    bottomLeft: { x: 0, y: 1399 },
  };
  const geometry = deskewQuad({
    quad: full,
    outputWidth: 1000,
    outputHeight: 1400,
    canonicalWidth: 1000,
    canonicalHeight: 1400,
    deg: 4,
    mode: "paper",
  });
  const { scale, photoInOutput, pageInOutput } = geometry;
  assert.equal(scale, 1);
  assert.ok(photoInOutput !== null);
  // the outline *is* the photo, so the two polygons coincide
  for (let i = 0; i < 4; i += 1) {
    assert.ok(Math.hypot(photoInOutput[i].x - pageInOutput[i].x, photoInOutput[i].y - pageInOutput[i].y) < 1e-3);
  }
  // …and the corners beyond it are painted even where the wedge is kept
  const image = { width: 100, height: 140, data: new Uint8ClampedArray(100 * 140 * 4) };
  for (let i = 0; i < image.data.length; i += 4) image.data.set([200, 200, 200, 255], i);
  image.data.set([0, 0, 0, 255], 0);
  const painted = fillDeskewWedges(image, planFor(geometry, 4, { paint: [false, false, false, false] }));
  assert.ok(painted > 0);
  assert.equal(image.data[0], 200, "the clamped corner took the paper beside it");
});

/* ── The wedge fill ───────────────────────────────────────────────────── */

/** A rotated page as the warp leaves it: shaded paper inside, table (or `outside`) in the wedges. */
function wedged(plan: DeskewPlan, w: number, h: number, outside: number, shade = 0): DeskewImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const poly = plan.pageInOutput;
  const noise = rng(3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      let sign = 0;
      let out = false;
      for (let i = 0; i < 4; i += 1) {
        const a = poly[i];
        const b = poly[(i + 1) % 4];
        const cross = (b.x - a.x) * (v - a.y) - (b.y - a.y) * (u - a.x);
        const sg = cross > 0 ? 1 : -1;
        if (sign === 0) sign = sg;
        else if (sg !== sign) out = true;
      }
      // Shaded paper: darker to the right and down, like a lamp to the top-left.
      const paper = 230 - shade * (0.6 * u + 0.4 * v) + (noise() - 0.5) * 6;
      const value = out ? outside : paper;
      data.set([value, value * 0.97, value * 0.9, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

function geometry300(deg: number) {
  return deskewQuad({
    quad: { topLeft: { x: 100, y: 100 }, topRight: { x: 399, y: 100 }, bottomRight: { x: 399, y: 499 }, bottomLeft: { x: 100, y: 499 } },
    outputWidth: 300,
    outputHeight: 400,
    canonicalWidth: 600,
    canonicalHeight: 700,
    deg,
    mode: "paper",
  });
}

test("the fill carries the paper beside it across the seam, shading and all", () => {
  const plan = planFor(geometry300(6), 6, { bleedFraction: 0.004 });
  const image = wedged(plan, 300, 400, 60, 50);
  const before = new Uint8ClampedArray(image.data);
  const painted = fillDeskewWedges(image, plan);
  assert.ok(painted > 0);
  // Every painted pixel against the real paper just inside the page next to
  // it: the same shade within grain, not one flat corner colour.
  const lum = (d: Uint8ClampedArray, o: number) => d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
  let worst = 0;
  let checked = 0;
  for (let y = 4; y < 396; y += 7) {
    for (let x = 4; x < 296; x += 3) {
      const o = (y * 300 + x) * 4;
      if (image.data[o] === before[o] && image.data[o + 2] === before[o + 2]) continue;
      // The paper 12 px toward the centre, in the original.
      const cx = x + Math.sign(150 - x) * 12;
      const cy = y + Math.sign(200 - y) * 12;
      const ref = (cy * 300 + cx) * 4;
      if (before[ref] < 100) continue;
      worst = Math.max(worst, Math.abs(lum(image.data, o) - lum(before, ref)));
      checked += 1;
    }
  }
  assert.ok(checked > 20, `${checked}`);
  assert.ok(worst < 6, `worst step ${worst.toFixed(1)} grey levels`);
});

test("painting box by box (the canvas path) gives the very pixels of the whole-image fill", () => {
  const plans = [6, -3.5, 11].map((deg) => planFor(geometry300(deg), deg, { bleedFraction: 0.004, paint: [true, false, true, true] }));
  // Q′ past the photo, one wedge kept as table and one as page.
  for (const deg of [5, -9]) {
    plans.push(
      planFor(geometryFull(deg), deg, {
        bleedFraction: 0.004,
        paint: [true, false, false, true],
        tableBeyondPhoto: [false, true, false, false],
      }),
    );
  }
  for (const plan of plans) {
    const deg = plan.deg;
    const whole = wedged(plan, 300, 400, 60, 40);
    const boxed = { width: 300, height: 400, data: new Uint8ClampedArray(whole.data) };
    fillDeskewWedges(whole, plan);
    // What `dewarp-stage.ts :: paintDeskewWedges` does with getImageData /
    // putImageData: read the sample boxes, then paint each paint box on its own.
    const read = (box: { x: number; y: number; width: number; height: number }): PixelWindow => {
      const data = new Uint8ClampedArray(box.width * box.height * 4);
      for (let y = 0; y < box.height; y += 1) {
        const from = ((box.y + y) * 300 + box.x) * 4;
        data.set(boxed.data.subarray(from, from + box.width * 4), y * box.width * 4);
      }
      return { x: box.x, y: box.y, image: { width: box.width, height: box.height, data } };
    };
    const windows = wedgeSampleBoxes(plan, 300, 400).flatMap((b) => (b === null ? [] : [read(b)]));
    const fill = wedgeFillFrom(windows, plan, 300, 400);
    for (const box of wedgePaintBoxes(plan, 300, 400)) {
      const win = read(box);
      paintWedgeWindow(win, plan, fill, 300, 400);
      for (let y = 0; y < box.height; y += 1) {
        boxed.data.set(win.image.data.subarray(y * box.width * 4, (y + 1) * box.width * 4), ((box.y + y) * 300 + box.x) * 4);
      }
    }
    assert.deepEqual(boxed.data, whole.data, `${deg}°`);
  }
});

test("the paint boxes hold every pixel the fill paints", () => {
  const plans = [
    planFor(geometry300(8), 8, { bleedFraction: 0.004 }),
    planFor(geometryFull(-9), -9, { bleedFraction: 0.004, paint: [true, false, false, true], tableBeyondPhoto: [false, true, false, false] }),
  ];
  for (const plan of plans) {
    const image = wedged(plan, 300, 400, 60);
    const reference = { width: 300, height: 400, data: new Uint8ClampedArray(image.data) };
    // Every pixel, no boxes: the predicate alone.
    const fill = wedgeFillFrom([{ x: 0, y: 0, image: reference }], plan, 300, 400);
    const everywhere = paintWedgeWindow({ x: 0, y: 0, image: reference }, plan, fill, 300, 400);
    assert.equal(fillDeskewWedges(image, plan), everywhere);
    assert.deepEqual(image.data, reference.data);
  }
});

test("wedges of new table (outline was the sheet) are painted", () => {
  const plan = planFor(geometry300(6), 6);
  const decided = decideWedgePaint(plan, wedged(planFor(geometry300(0), 0), 300, 400, 225), wedged(plan, 300, 400, 60));
  assert.deepEqual(decided.paint, [true, true, true, true]);
  assert.deepEqual(decided.tableBeyondPhoto, [false, false, false, false]);
});

test("wedges where the page continues (outline inside the sheet) are kept", () => {
  const plan = planFor(geometry300(6), 6);
  const flat = wedged(planFor(geometry300(0), 0), 300, 400, 225);
  const decided = decideWedgePaint(plan, flat, wedged(plan, 300, 400, 225));
  assert.deepEqual(decided.paint, [false, false, false, false]);
  // The page, not the table: past the photo it is still painted paper.
  assert.deepEqual(decided.tableBeyondPhoto, [false, false, false, false]);
  // Shaded page with print in the corner: darker than bright paper, still the page.
  assert.deepEqual(decideWedgePaint(plan, flat, wedged(plan, 300, 400, 200)).paint, [false, false, false, false]);
});

test("wedges of a table already in the frame (loose outline) are kept", () => {
  const plan = planFor(geometry300(6), 6);
  const loose = wedged(planFor(geometry300(0), 0), 300, 400, 225);
  // 12 px of table along every edge of the flat page.
  for (let y = 0; y < 400; y += 1) {
    for (let x = 0; x < 300; x += 1) {
      if (x < 12 || y < 12 || x >= 288 || y >= 388) loose.data.set([60, 60, 60, 255], (y * 300 + x) * 4);
    }
  }
  const decided = decideWedgePaint(plan, loose, wedged(plan, 300, 400, 60));
  assert.deepEqual(decided.paint, [false, false, false, false]);
  // Kept as table: past the photo, scanic's clamp (that same table) stays.
  assert.deepEqual(decided.tableBeyondPhoto, [true, true, true, true]);
});

/** A 300 × 400 photo that is all outline: Q′ reaches past it at any rotation. */
function geometryFull(deg: number) {
  return deskewQuad({
    quad: { topLeft: { x: 0, y: 0 }, topRight: { x: 299, y: 0 }, bottomRight: { x: 299, y: 399 }, bottomLeft: { x: 0, y: 399 } },
    outputWidth: 300,
    outputHeight: 400,
    canonicalWidth: 300,
    canonicalHeight: 400,
    deg,
    mode: "paper",
  });
}

test("past the photo, a wedge kept as table is left alone and every other one is painted", () => {
  for (const deg of [5, -9]) {
    const geometry = geometryFull(deg);
    assert.ok(geometry.photoInOutput !== null);
    // Top painted, right kept as table, bottom kept as page, left painted.
    const plan = planFor(geometry, deg, {
      bleedFraction: 0.004,
      paint: [true, false, false, true],
      tableBeyondPhoto: [false, true, false, false],
    });
    const image = wedged(plan, 300, 400, 60, 30);
    const before = new Uint8ClampedArray(image.data);
    fillDeskewWedges(image, plan);
    const photo = plan.photoInOutput ?? [];
    const seen = [0, 0, 0, 0];
    for (let y = 0; y < 400; y += 1) {
      for (let x = 0; x < 300; x += 1) {
        const u = x / 299;
        const v = y / 399;
        // Well past the photo's edge, not on it.
        if (outsideEdge(photo, u, v) < 0) continue;
        const inset = photo.map((p) => ({ x: 0.5 + (p.x - 0.5) * 1.02, y: 0.5 + (p.y - 0.5) * 1.02 }));
        if (outsideEdge(inset, u, v) < 0) continue;
        const edge = outsideEdge(plan.pageInOutput, u, v);
        if (edge < 0) continue;
        seen[edge] += 1;
        const o = (y * 300 + x) * 4;
        const kept = before[o] === image.data[o] && before[o + 1] === image.data[o + 1] && before[o + 2] === image.data[o + 2];
        assert.equal(kept, edge === 1, `${deg}°: edge ${edge} at ${x},${y} ${kept ? "kept" : "painted"}`);
      }
    }
    assert.ok(seen.filter((n) => n > 20).length >= 2, `${deg}°: past-the-photo pixels by edge ${seen}`);
  }
});

/* ── The judge ────────────────────────────────────────────────────────── */

/** B′ for a flat page B₀: the same page, rotated by −deg about its centre (bilinear), table in the wedges. */
function rotateImage(image: DeskewImage, deg: number): DeskewImage {
  const { width: w, height: h } = image;
  const out = new Uint8ClampedArray(w * h * 4);
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const fx = cx + c * (x - cx) - s * (y - cy);
      const fy = cy + s * (x - cx) + c * (y - cy);
      const o = (y * w + x) * 4;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) {
        out.set([60, 60, 60, 255], o);
        continue;
      }
      const ax = fx - x0;
      const ay = fy - y0;
      for (let k = 0; k < 3; k += 1) {
        const p = (yy: number, xx: number) => image.data[(yy * w + xx) * 4 + k];
        out[o + k] =
          (p(y0, x0) * (1 - ax) + p(y0, x0 + 1) * ax) * (1 - ay) + (p(y0 + 1, x0) * (1 - ax) + p(y0 + 1, x0 + 1) * ax) * ay;
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

test("the judge keeps a rotation that levels the print", () => {
  const flat = page("paragraphs", 4);
  const verdict = judgeDeskew({ flat, rotated: rotateImage(flat, 4), deg: 4, sample: null });
  assert.equal(verdict.ok, true, `${verdict.rejection} lean ${verdict.residualDeg}`);
  assert.ok(Math.abs(verdict.residualDeg) < 0.3, `${verdict.residualDeg}`);
});

test("the judge refuses a rotation that leaves the print leaning (checked against the page, not the estimate)", () => {
  const flat = page("paragraphs", 4);
  // The wrong way: 4° more lean, not less.
  const verdict = judgeDeskew({ flat, rotated: rotateImage(flat, -4), deg: -4, sample: null });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rejection, "not-level");
});

test("the judge refuses a rotation that pushes print out of the frame", () => {
  // Print to the very corners, then turned 8°: the corners leave the frame.
  const bleed = compose([{ layout: "paragraphs", deg: 8 }], { width: 560, height: 740 });
  const sample = { xs: new Float64Array(1000), ys: new Float64Array(1000), width: 560, height: 740 };
  // Glyph pixels spread over the whole flat page, corners included.
  for (let i = 0; i < 1000; i += 1) {
    sample.xs[i] = ((i % 40) / 39 - 0.5) * 559;
    sample.ys[i] = (Math.floor(i / 40) / 24 - 0.5) * 739;
  }
  const verdict = judgeDeskew({ flat: bleed, rotated: rotateImage(bleed, 8), deg: 8, sample });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rejection, "clips");
  assert.ok(verdict.clippedShare > 0.002);
});

test("curl evidence: level halves and straight lines say no curl; a bow or split halves say curl", () => {
  const flat = { lineCount: 20, medianCurvature: 0.0008 };
  assert.equal(curlEvidence({ deg: 3, halves: [3.02, 2.98] } as SkewEstimate, flat).evidence, false);
  // A form's blocks split the halves with no curl: the spread alone says nothing…
  assert.equal(curlEvidence({ deg: 3, halves: [3.4, 2.6] } as SkewEstimate, flat).evidence, false);
  // …the halves' mean leaving the whole page does.
  assert.deepEqual(curlEvidence({ deg: 3, halves: [3.7, 2.9] } as SkewEstimate, flat).why, ["halves-offset"]);
  assert.deepEqual(
    curlEvidence({ deg: 3, halves: [3, 3] } as SkewEstimate, { lineCount: 20, medianCurvature: CURL_BOW_FRACTION * 1.5 }).why,
    ["bow"],
  );
  // Unmeasured halves are not evidence of a flat page.
  assert.equal(curlEvidence({ deg: 3, halves: [NaN, 3] } as SkewEstimate, flat).evidence, true);
});

/* ── The step, end to end ─────────────────────────────────────────────── */

/** A stand-in for the stage's small render: the homography warp of `quad` from `source` (bilinear, clamped). */
function warp(source: DeskewImage, quad: DeskewQuad, w: number, h: number): DeskewImage {
  const rect = [
    { x: 0, y: 0 },
    { x: w - 1, y: 0 },
    { x: w - 1, y: h - 1 },
    { x: 0, y: h - 1 },
  ];
  const map = homographyFrom(rect, [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft]);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = applyHomography(map, { x, y });
      const fx = Math.max(0, Math.min(source.width - 1, p.x));
      const fy = Math.max(0, Math.min(source.height - 1, p.y));
      const x0 = Math.min(source.width - 2, Math.floor(fx));
      const y0 = Math.min(source.height - 2, Math.floor(fy));
      const ax = fx - x0;
      const ay = fy - y0;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k += 1) {
        const q = (yy: number, xx: number) => source.data[(yy * source.width + xx) * 4 + k];
        data[o + k] = (q(y0, x0) * (1 - ax) + q(y0, x0 + 1) * ax) * (1 - ay) + (q(y0 + 1, x0) * (1 - ax) + q(y0 + 1, x0 + 1) * ax) * ay;
      }
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** A photo: the page, on a dark table, with the outline Q around the sheet. */
function photo(layers: Layer[]): { canonical: DeskewImage; quad: DeskewQuad } {
  const sheet = compose(layers);
  const pad = 60;
  const width = W + 2 * pad;
  const height = H + 2 * pad;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([55, 50, 45, 255], i);
  for (let y = 0; y < H; y += 1) {
    data.set(sheet.data.subarray(y * W * 4, (y + 1) * W * 4), ((y + pad) * width + pad) * 4);
  }
  return {
    canonical: { width, height, data },
    quad: {
      topLeft: { x: pad, y: pad },
      topRight: { x: pad + W - 1, y: pad },
      bottomRight: { x: pad + W - 1, y: pad + H - 1 },
      bottomLeft: { x: pad, y: pad + H - 1 },
    },
  };
}

async function straighten(layers: Layer[]) {
  const { canonical, quad } = photo(layers);
  return planStraighten({
    flat: warp(canonical, quad, W, H),
    quad,
    canonicalWidth: canonical.width,
    canonicalHeight: canonical.height,
    renderSmall: async (q) => warp(canonical, q, W, H),
  });
}

test("a tilted flat page is straightened with no engine run: the level page is the whole answer", async () => {
  const result = await straighten([{ layout: "paragraphs", deg: 4 }]);
  assert.ok(result.plan !== null, `${result.estimate.reason} ${result.judgement?.rejection}`);
  assert.equal(result.judgement?.ok, true);
  assert.ok(Math.abs(result.plan.deg - 4) < 0.15, `${result.plan.deg}`);
  assert.equal(result.plan.policyVersion, DESKEW_POLICY_VERSION);
  assert.equal(result.plan.curl.evidence, false, result.plan.curl.why.join(","));
  assert.equal(result.runEngine, false);
  // The wedges hold new table (the outline was the sheet): painted.
  assert.deepEqual(result.plan.paint, [true, true, true, true]);
});

test("a tilted page that is also curled keeps the rotation and still asks the engine", async () => {
  const result = await straighten([{ layout: "paragraphs", deg: 3, bow: 5 }]);
  assert.ok(result.plan !== null, `${result.estimate.reason} ${result.judgement?.rejection}`);
  assert.equal(result.plan.curl.evidence, true);
  assert.equal(result.runEngine, true);
});

test("an abstaining estimate leaves the page to the engine, on the confirmed outline", async () => {
  const result = await straighten([{ layout: "paragraphs", deg: 0 }]);
  assert.equal(result.plan, null);
  assert.equal(result.runEngine, true);
});

test("a level, flat page is said to be level and flat — and the engine is still asked", async () => {
  const result = await straighten([{ layout: "paragraphs", deg: 0 }]);
  assert.equal(result.estimate.reason, "negligible");
  assert.ok(result.level !== null, "the level page's own curl was measured");
  assert.equal(result.level.evidence, false, result.level.why.join(","));
  // Only the page view reads it: the engine runs exactly as before.
  assert.equal(result.runEngine, true);
});

test("a level page that is curled is not said to be flat", async () => {
  // Bowed lines whose halves still agree on the level: the estimate calls it
  // level, and the bow is what says it is not flat.
  const result = await straighten([{ layout: "paragraphs", deg: 0, bow: 5 }]);
  assert.equal(result.estimate.reason, "negligible");
  assert.ok(result.level !== null);
  assert.equal(result.level.evidence, true);
  assert.ok(result.level.why.includes("bow"), result.level.why.join(","));
});

test("a page with a rotation, or one the estimate abstained on, carries no level verdict", async () => {
  const tilted = await straighten([{ layout: "paragraphs", deg: 4 }]);
  assert.equal(tilted.level, null);
  const blank = await straighten([]);
  assert.notEqual(blank.estimate.reason, "negligible");
  assert.equal(blank.level, null);
});

test("a render that fails is no rotation, not an error", async () => {
  const { canonical, quad } = photo([{ layout: "paragraphs", deg: 4 }]);
  const result = await planStraighten({
    flat: warp(canonical, quad, W, H),
    quad,
    canonicalWidth: canonical.width,
    canonicalHeight: canonical.height,
    renderSmall: async () => null,
  });
  assert.equal(result.plan, null);
  assert.equal(result.runEngine, true);
});
