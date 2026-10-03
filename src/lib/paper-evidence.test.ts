import assert from "node:assert/strict";
import test from "node:test";

import {
  classicalQuadSane,
  evidenceDiagnostic,
  evidenceVerdict,
  GLARE_LUMA,
  imagesFailure,
  textFailure,
  minInteriorAngle,
  PAPER,
  paperEvidence,
  paperLike,
  paperSurface,
  sideRatio,
  sidesOnFrameBorder,
} from "./paper-evidence.ts";
import type { CornerPoints } from "scanic";

const W = 360;
const H = 640;

/** A deterministic PRNG, so a "textured" desk is the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Paint = (x: number, y: number) => number;

function image(paint: Paint): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = Math.max(0, Math.min(255, paint(x, y)));
      const i = (y * W + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

const page = { x0: 80, y0: 140, x1: 280, y1: 420 };
const inPage = (x: number, y: number): boolean => x >= page.x0 && x < page.x1 && y >= page.y0 && y < page.y1;
const quad: CornerPoints = {
  topLeft: { x: page.x0, y: page.y0 },
  topRight: { x: page.x1, y: page.y0 },
  bottomRight: { x: page.x1, y: page.y1 },
  bottomLeft: { x: page.x0, y: page.y1 },
};

/** Lines of "words": dark dashes on a text grid, about a tenth of the page inked. */
function printed(x: number, y: number): boolean {
  const line = Math.floor((y - page.y0 - 12) / 12);
  const inLine = (y - page.y0 - 12) % 12 < 2;
  const word = Math.floor((x - page.x0 - 14) / 6) + line * 3;
  return line >= 0 && line < 21 && inLine && x > page.x0 + 14 && x < page.x1 - 14 && word % 5 !== 0;
}

test("a printed white page on a dark desk is paper", () => {
  const noise = rng(1);
  const data = image((x, y) => (inPage(x, y) ? (printed(x, y) ? 60 : 225) + noise() * 6 : 55 + noise() * 20));
  const e = paperEvidence(data, W, H, quad);
  assert.ok(e !== null && e.ok, JSON.stringify(e));
  assert.equal(e.sidesSupported, 4);
});

test("dark stock printed in white is paper too", () => {
  const noise = rng(2);
  const data = image((x, y) => (inPage(x, y) ? (printed(x, y) ? 220 : 40) + noise() * 6 : 200 + noise() * 10));
  const e = paperEvidence(data, W, H, quad);
  assert.ok(e !== null && e.ok, JSON.stringify(e));
});

test("a sparse page in faint print is paper, on a clean page only", () => {
  const noise = rng(8);
  // One line in six, one word-group in two: about 2 % of the interior inked.
  const sparse = (x: number, y: number): boolean =>
    printed(x, y) && Math.floor((y - page.y0 - 12) / 12) % 6 === 0 && Math.floor((x - page.x0) / 18) % 2 === 0;
  const data = image((x, y) => (inPage(x, y) ? (sparse(x, y) ? 60 : 225) + noise() * 6 : 55 + noise() * 20));
  const e = paperEvidence(data, W, H, quad);
  assert.ok(e !== null && e.ok, JSON.stringify(e));
  assert.ok(e.ink < PAPER.minInk && e.ink >= PAPER.faintInk, `ink ${e.ink}`);
  // Without the allowance it would not be…
  const strict = paperEvidence(data, W, H, quad, { ...PAPER, faintInk: PAPER.minInk });
  assert.ok(strict !== null && !strict.ok);
  // …and the allowance needs the clean page: the same print on a mottled
  // surface (a fifth of it off its background, not far enough to be ink) is not.
  const mottled = image((x, y) => {
    if (!inPage(x, y)) return 55 + noise() * 20;
    if (sparse(x, y)) return 60;
    return (Math.floor(x / 9) + Math.floor(y / 9)) % 5 === 0 ? 209 : 225 + noise() * 6;
  });
  const m = paperEvidence(mottled, W, H, quad);
  assert.ok(m !== null && !m.ok && m.background < PAPER.faintBackground, JSON.stringify(m));
});

test("a blank lid (a laptop, a notebook cover) is not: no print", () => {
  const noise = rng(3);
  const data = image((x, y) => (inPage(x, y) ? 170 + noise() * 6 : 55 + noise() * 20));
  const e = paperEvidence(data, W, H, quad);
  assert.ok(e !== null && !e.ok);
  assert.ok(e.ink < 0.01);
  assert.equal(e.sidesSupported, 4);
});

test("a keyboard is not: a third of it is the deck between the keys", () => {
  const noise = rng(7);
  // Caps 13 px on a 16 px pitch (the emulator's keyboard: caps 80 % of the
  // pitch) over a dark deck — no background covering most of the surface.
  const data = image((x, y) => {
    if (!inPage(x, y)) return 200 + noise() * 10;
    const cap = (x - page.x0) % 16 < 13 && (y - page.y0) % 16 < 13;
    return (cap ? 90 : 25) + noise() * 6;
  });
  const e = paperEvidence(data, W, H, quad);
  assert.ok(e !== null && !e.ok, JSON.stringify(e));
});

test("a sheet under three-quarters background must be mostly print off it (the black keyboard)", () => {
  // The numbers a black keyboard on a wooden desk read at (session runs):
  // strong sides, a 0.70 "background" of keycaps, little ink.
  const keyboard = {
    sidesSupported: 3,
    sidesKnown: 3,
    sideSupport: [1, 1, 1, null],
    background: 0.7,
    ink: 0.031,
    counterInk: 0.012,
    inkSpread: 0.39,
    solidInk: 0,
    backgroundSpread: 0.03,
  };
  assert.equal(paperLike(keyboard), false);
  assert.equal(paperLike(keyboard, { ...PAPER, minInkOfRest: 0 }), true);
  // A dense real page at the same background share holds far more ink.
  assert.equal(paperLike({ ...keyboard, ink: 0.106, counterInk: 0.03 }), true);
  // Above the marginal line the rule does not apply (a sparse, faint page).
  assert.equal(paperSurface({ ...keyboard, background: 0.95, ink: 0.013, counterInk: 0 }), true);
});

test("little ink spread evenly over the whole sheet is a texture, not print (the woven place mat)", () => {
  // A white woven place mat as the breaker's still-lookalikes session read it.
  const mat = {
    sidesSupported: 4,
    sidesKnown: 4,
    sideSupport: [0.9, 0.95, 0.9, 0.92],
    background: 0.9,
    ink: 0.028,
    counterInk: 0,
    inkSpread: 0.86,
    solidInk: 0,
    backgroundSpread: 0.02,
  };
  assert.equal(paperLike(mat), false);
  assert.equal(paperLike(mat, { ...PAPER, textureInk: 0 }), true);
  // A faint page with as little ink holds it in lines: half its blocks or so.
  assert.equal(paperLike({ ...mat, inkSpread: 0.56 }), true);
  // A page with real print spread all over is print.
  assert.equal(paperLike({ ...mat, ink: 0.08, inkSpread: 0.92 }), true);
});

test("the glare share is the interior clipped white, and no part of the verdict", () => {
  const noise = rng(9);
  const hot = (x: number, y: number): boolean => Math.hypot(x - 180, y - 280) < 60;
  const data = image((x, y) => (inPage(x, y) ? (hot(x, y) ? 255 : printed(x, y) ? 60 : 225 + noise() * 6) : 55 + noise() * 20));
  const e = paperEvidence(data, W, H, quad);
  assert.ok(e !== null);
  // A 60 px disc in a 200 × 280 page, a little under the inset interior's 0.24.
  assert.ok(e.glare > 0.15 && e.glare < 0.3, `glare ${e.glare}`);
  const clean = paperEvidence(image((x, y) => (inPage(x, y) ? (printed(x, y) ? 60 : 225) : 55)), W, H, quad);
  assert.ok(clean !== null && clean.glare === 0 && GLARE_LUMA > 225);
  // A page exposed to the top of the range is bright, not glared.
  const bright = paperEvidence(image((x, y) => (inPage(x, y) ? (printed(x, y) ? 60 : 255) : 55)), W, H, quad);
  assert.ok(bright !== null && bright.glare === 0, `glare ${bright?.glare}`);
});

test("an edgeless side with the page's paper running on to the frame's edge is open", () => {
  const noise = rng(10);
  // The page runs off the right of the frame; the quad was drawn short of it, at x = 280.
  const data = image((x, y) => (x >= page.x0 && y >= page.y0 && y < page.y1 ? (printed(x, y) ? 60 : 225) + noise() * 6 : 55 + noise() * 20));
  const e = paperEvidence(data, W, H, quad);
  assert.ok(e !== null && e.sideSupport[1] !== null && e.sideSupport[1] < 0.3, JSON.stringify(e?.sideSupport));
  assert.equal(e.open, 1);
  // The same quad on a page that ends there has no open side.
  const whole = paperEvidence(image((x, y) => (inPage(x, y) ? (printed(x, y) ? 60 : 225) + noise() * 6 : 55 + noise() * 20)), W, H, quad);
  assert.ok(whole !== null && whole.open === 0);
});

test("a quad drawn across a textured desk is not: no edges, all texture", () => {
  const noise = rng(4);
  const data = image(() => 60 + noise() * 140);
  const e = paperEvidence(data, W, H, quad);
  assert.ok(e !== null && !e.ok, JSON.stringify(e));
  assert.ok(e.sidesSupported <= 1);
});

test("a lighting gradient across a page is background, not ink", () => {
  const noise = rng(5);
  const data = image((x, y) => {
    const light = 1 - (0.35 * (x - page.x0)) / (page.x1 - page.x0);
    return inPage(x, y) ? (printed(x, y) ? 60 : 230 * light) + noise() * 5 : 40 + noise() * 15;
  });
  const e = paperEvidence(data, W, H, quad);
  assert.ok(e !== null && e.ok, JSON.stringify(e));
});

test("a side the frame cuts off is not held against the page", () => {
  const noise = rng(6);
  const cut: CornerPoints = {
    topLeft: { x: page.x0, y: -60 },
    topRight: { x: page.x1, y: -60 },
    bottomRight: { x: page.x1, y: page.y1 },
    bottomLeft: { x: page.x0, y: page.y1 },
  };
  const data = image((x, y) => (x >= page.x0 && x < page.x1 && y < page.y1 ? (printed(x, y + 200) ? 60 : 225) + noise() * 6 : 55 + noise() * 20));
  const e = paperEvidence(data, W, H, cut);
  assert.ok(e !== null);
  assert.ok(e.sidesKnown <= 3);
});

test("the classical detector's usual failures are not shown", () => {
  const frame: CornerPoints = {
    topLeft: { x: 1, y: 1 },
    topRight: { x: W - 2, y: 1 },
    bottomRight: { x: W - 2, y: H - 2 },
    bottomLeft: { x: 1, y: H - 2 },
  };
  assert.equal(sidesOnFrameBorder(frame, W, H), 4);
  assert.equal(classicalQuadSane(frame, W, H, null), false);
  const sliver: CornerPoints = {
    topLeft: { x: 100, y: 100 },
    topRight: { x: 300, y: 100 },
    bottomRight: { x: 300, y: 120 },
    bottomLeft: { x: 100, y: 120 },
  };
  assert.ok(sideRatio(sliver) < 0.15);
  assert.equal(classicalQuadSane(sliver, W, H, null), false);
  // A corner pulled deep inside: an angle no page seen by a phone has.
  const skewed: CornerPoints = {
    topLeft: { x: 100, y: 100 },
    topRight: { x: 300, y: 100 },
    bottomRight: { x: 320, y: 300 },
    bottomLeft: { x: 250, y: 140 },
  };
  assert.ok(minInteriorAngle(skewed) < 35);
  assert.equal(classicalQuadSane(skewed, W, H, null), false);
  assert.equal(classicalQuadSane(quad, W, H, null), true);
});

test("the diagnostics name the rule and the clause a reading fails, and agree with the verdict", () => {
  const noise = rng(1);
  const ok = paperEvidence(image((x, y) => (inPage(x, y) ? (printed(x, y) ? 60 : 225) + noise() * 6 : 55 + noise() * 20)), W, H, quad);
  assert.ok(ok !== null && ok.ok);
  const d = evidenceDiagnostic(ok);
  assert.equal(d.verdict, "ok");
  assert.equal(d.failPrint, null);
  assert.equal(d.sidesKnown, 4);
  assert.ok(d.sideT !== null && d.sideT >= 0.55);
  assert.ok(d.paperLevel !== null && Math.abs(d.paperLevel - 228) <= 4, `paper level ${d.paperLevel}`);
  // Rounded: two decimals for shares, whole levels.
  for (const value of [d.background, d.ink, d.inkSpread, d.marginUniform ?? 0]) assert.equal(Math.round(value * 100) / 100, value);
  // A blank lid: four edges, no print — the surface fails, on ink.
  const lid = paperEvidence(image((x, y) => (inPage(x, y) ? 170 + noise() * 6 : 55 + noise() * 20)), W, H, quad);
  assert.ok(lid !== null && !lid.ok);
  assert.equal(evidenceVerdict(lid), "surface");
  assert.equal(textFailure(lid), "ink-low");
  assert.notEqual(imagesFailure(lid), null);
  // A quad across a textured desk: no edges, whatever the surface.
  const desk = paperEvidence(image(() => 120 + noise() * 60), W, H, quad);
  assert.ok(desk !== null && !desk.ok);
  assert.equal(evidenceVerdict(desk), "sides");
  // The clause functions are the verdict: paper exactly when the sides hold and one rule passes.
  for (const e of [ok, lid, desk]) {
    assert.equal(e.ok, evidenceVerdict(e) === "ok");
    if (evidenceVerdict(e) !== "sides") assert.equal(e.ok, textFailure(e) === null || imagesFailure(e) === null);
  }
});
