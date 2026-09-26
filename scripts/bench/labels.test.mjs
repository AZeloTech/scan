import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  emptyLabels,
  frameId,
  labelCounts,
  labelFor,
  LABELS_VERSION,
  mergeLabels,
  orderCorners,
  validateLabels,
} from "./labels.mjs";
import { clipKey, discoverRealMedia, scaledSize, SCREEN_RECORDING } from "./real.mjs";

/**
 * The labels file is the one thing a person spends hours on: the check must
 * refuse a malformed document before it overwrites a good one, and the corner
 * order and ids must be stable enough to find a label again.
 */

const SQUARE = [
  [0.2, 0.2],
  [0.8, 0.2],
  [0.8, 0.8],
  [0.2, 0.8],
];

test("a well-formed labels document passes; malformed ones name their problem", () => {
  const good = {
    version: LABELS_VERSION,
    items: {
      "a.jpg": { corners: SQUARE, uncertain: [false, true, false, false], labeller: "x", t: "2026-01-01T00:00:00Z" },
      "b.jpg": { noDocument: true, labeller: "x", t: "2026-01-01T00:00:00Z" },
      // A corner a little outside the image: a page the frame cut off.
      "c.jpg": { corners: [[-0.1, 0.2], [0.8, 0.2], [0.8, 1.2], [0.2, 0.8]] },
    },
  };
  assert.equal(validateLabels(good), null);
  assert.equal(validateLabels(emptyLabels()), null);
  assert.match(validateLabels({ version: 2, items: {} }), /version/);
  assert.match(validateLabels({ version: 1, items: [] }), /items/);
  assert.match(validateLabels({ version: 1, items: { x: { corners: SQUARE.slice(0, 3) } } }), /four/);
  assert.match(validateLabels({ version: 1, items: { x: { corners: [[0, 0], [1, 0], [1, 1], [0, 9]] } } }), /normalized/);
  assert.match(validateLabels({ version: 1, items: { x: { corners: SQUARE, uncertain: [true] } } }), /uncertain/);
  assert.match(validateLabels({ version: 1, items: { x: { noDocument: "yes" } } }), /noDocument/);
});

test("corners placed in any order come back TL, TR, BR, BL, their flags with them", () => {
  const shuffled = [SQUARE[2], SQUARE[0], SQUARE[3], SQUARE[1]];
  const { corners, carry } = orderCorners(shuffled, ["br", "tl", "bl", "tr"]);
  assert.deepEqual(corners, SQUARE);
  assert.deepEqual(carry, ["tl", "tr", "br", "bl"]);
  // A page turned 20°: still starts at the corner nearest the image's top-left.
  const a = (20 * Math.PI) / 180;
  const turned = SQUARE.map(([x, y]) => [
    0.5 + (x - 0.5) * Math.cos(a) - (y - 0.5) * Math.sin(a),
    0.5 + (x - 0.5) * Math.sin(a) + (y - 0.5) * Math.cos(a),
  ]);
  assert.deepEqual(orderCorners([turned[3], turned[1], turned[0], turned[2]]).corners, turned);
});

test("ids and label lookups", () => {
  assert.equal(frameId("clips/one.mp4", 8, 15), "clips/one.mp4@533ms");
  assert.equal(frameId("clips\\one.mp4", 0, 15), "clips/one.mp4@0ms");
  const doc = {
    version: 1,
    items: {
      a: { corners: SQUARE, uncertain: [true, false, false, false] },
      b: { noDocument: true, corners: SQUARE },
      c: { corners: SQUARE },
    },
  };
  assert.deepEqual(labelFor(doc, "a"), { noDocument: false, quad: SQUARE, uncertain: [true, false, false, false] });
  assert.equal(labelFor(doc, "b").noDocument, true);
  assert.equal(labelFor(doc, "b").quad, null);
  assert.deepEqual(labelFor(doc, "c").uncertain, [false, false, false, false]);
  assert.equal(labelFor(doc, "missing"), null);
  assert.deepEqual(labelCounts(doc), { total: 3, noDocument: 1, withUncertain: 1 });
});

test("discovery takes stills and camera clips, and never a screen recording", () => {
  const dir = mkdtempSync(join(tmpdir(), "scan-bench-media-"));
  try {
    for (const sub of ["pii_free", "capture-issue", "elsewhere"]) mkdirSync(join(dir, sub));
    for (const file of [
      "one.jpg",
      "two.JPEG",
      "notes.txt",
      "pii_free/three.jpg",
      "pii_free/clip-a.mp4",
      "capture-issue/four.jpg",
      "capture-issue/clip-b.mp4",
      "capture-issue/Screen_Recording_x_Chrome.mp4",
      "capture-issue/screen-recording.mp4",
      "elsewhere/five.jpg",
      "root-clip.mp4",
    ]) {
      writeFileSync(join(dir, file), "");
    }
    const found = discoverRealMedia(dir);
    assert.deepEqual(found.stills.map((s) => s.id), ["one.jpg", "two.JPEG", "pii_free/three.jpg", "capture-issue/four.jpg"]);
    assert.deepEqual(found.stills.map((s) => s.group), ["root", "root", "pii_free", "capture-issue"]);
    assert.deepEqual(found.videos.map((v) => v.id), ["pii_free/clip-a.mp4", "capture-issue/clip-b.mp4"]);
    assert.deepEqual(found.skipped.map((s) => s.rel).sort(), [
      "capture-issue/Screen_Recording_x_Chrome.mp4",
      "capture-issue/screen-recording.mp4",
    ]);
    assert.ok(SCREEN_RECORDING.test("Screen Recording 2.mp4"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extraction sizes keep the upright aspect, even, never upscaled", () => {
  assert.deepEqual(scaledSize({ width: 2160, height: 3840 }, 1080), { width: 608, height: 1080 });
  assert.deepEqual(scaledSize({ width: 3840, height: 2160 }, 1920), { width: 1920, height: 1080 });
  assert.deepEqual(scaledSize({ width: 640, height: 480 }, 1920), { width: 640, height: 480 });
  assert.equal(clipKey("capture-issue/a b.mp4"), "capture-issue__a__b");
});

test("a save is merged item by item: an older tab never erases a newer label", () => {
  const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const label = (minute, x = 0.2) => ({ corners: SQUARE.map(([, y], i) => [i === 0 ? x : SQUARE[i][0], y]), labeller: "x", t: at(minute) });
  // On disk: tab 2 saved b.jpg at :05 and re-labelled a.jpg at :06.
  const disk = { version: LABELS_VERSION, items: { "a.jpg": label(6, 0.25), "b.jpg": label(5) } };
  // Tab 1 loaded a.jpg (:01) at start-up and now saves c.jpg.
  const tab1 = { version: LABELS_VERSION, items: { "a.jpg": label(1), "c.jpg": label(7) } };
  const { merged, keptNewer } = mergeLabels(disk, tab1);
  assert.deepEqual(Object.keys(merged.items).sort(), ["a.jpg", "b.jpg", "c.jpg"]);
  assert.equal(merged.items["a.jpg"].t, at(6), "the newer label on disk survives");
  assert.deepEqual(keptNewer, ["a.jpg"]);
  assert.equal(validateLabels(merged), null);
  // A newer edit from the tab wins.
  assert.equal(mergeLabels(disk, { version: LABELS_VERSION, items: { "a.jpg": label(9, 0.3) } }).merged.items["a.jpg"].t, at(9));
  // Into an empty file, the save is the file.
  assert.deepEqual(mergeLabels(emptyLabels(), tab1).merged.items, tab1.items);
});
