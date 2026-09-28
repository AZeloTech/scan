import assert from "node:assert/strict";
import test from "node:test";

import {
  classicalQuadSane,
  minInteriorAngle,
  PAPER,
  paperEvidence,
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
