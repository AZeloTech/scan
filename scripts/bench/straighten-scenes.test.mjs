/**
 * The straighten suite's scene sets, its PNG sheets and its deskew-mode
 * switch. Engine-free.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { resolveDeskewMode } from "./straighten/deskew-step.mjs";
import { newImage } from "./straighten/imaging.mjs";
import { encodePng, sideBySide } from "./straighten/png.mjs";
import { realMatrix } from "./straighten/real-scenes.mjs";
import { buildScene, sceneProfile } from "./straighten/scenes.mjs";

test("profiles: the full matrix is 279 scenes, the quick one 83 of them, ids unique", () => {
  const full = sceneProfile("full");
  const quick = sceneProfile("quick");
  assert.equal(full.length, 279);
  assert.equal(quick.length, 83);
  assert.equal(new Set(full.map((s) => s.id)).size, full.length);
  const ids = new Set(full.map((s) => s.id));
  assert.ok(quick.every((s) => ids.has(s.id)));
  // Every family, layout and outline mode is in the quick screen.
  for (const key of ["family", "layout", "quadMode"]) {
    assert.deepEqual(new Set(quick.map((s) => s[key])), new Set(full.map((s) => s[key])), key);
  }
  assert.equal(full.filter((s) => Math.abs(s.tiltDeg) >= 0.5 || s.curl !== "none").length, 255);
  assert.throws(() => sceneProfile("huge"), /unknown straighten profile/);
});

test("scenes: the same spec renders the same pixels, and the truth follows the spec", () => {
  const spec = sceneProfile("quick").find((s) => s.id === "curl/paragraphs/correct/t3/p0/large");
  const a = buildScene(spec);
  const b = buildScene(spec);
  assert.deepEqual(a.quad, b.quad);
  assert.ok(Buffer.from(a.canonical.data.buffer).equals(Buffer.from(b.canonical.data.buffer)));
  assert.equal(a.truth.shouldAct, true);
  assert.equal(a.truth.tiltDeg, 3);
  assert.ok(a.truth.edgeBowFrac > 0.01);
});

test("real scenes: per labelled still a base and each variant at each tilt", () => {
  const stills = [{ id: "pii_free/a.jpg", corners: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] }, { id: "b.jpeg", corners: [[0, 0], [1, 0], [1, 1], [0, 1]] }];
  const full = realMatrix(stills, "full");
  assert.equal(full.length, 2 * 16);
  assert.equal(realMatrix(stills, "quick").length, 2 * 7);
  assert.ok(full.some((s) => s.id === "real/a/base/t0" && s.variant === "base"));
  assert.ok(full.some((s) => s.id === "real/b/rot-origquad/t8"));
  assert.equal(new Set(full.map((s) => s.id)).size, full.length);
});

test("png: a valid RGB PNG of the image's size, pixels intact", () => {
  const img = newImage(3, 2);
  for (let i = 0; i < 6; i++) img.data.set([i * 40, 255 - i * 40, 7, 255], i * 4);
  const png = encodePng(img);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 3);
  assert.equal(png.readUInt32BE(20), 2);
  const idatLength = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  assert.equal(raw.length, (3 * 3 + 1) * 2);
  assert.deepEqual([...raw.subarray(1, 4)], [0, 255, 7]);
  assert.deepEqual([...raw.subarray(11 + 6, 11 + 9)], [200, 55, 7]);
});

test("png: a sheet puts the panels side by side at one height", () => {
  const sheet = sideBySide([newImage(100, 200), newImage(50, 50)], { height: 100, gutter: 10 });
  assert.equal(sheet.height, 120);
  assert.equal(sheet.width, 10 + 50 + 10 + 100 + 10);
});

test("deskew mode: auto follows the engine root; asking for one it lacks is an error", () => {
  const root = mkdtempSync(join(tmpdir(), "straighten-root-"));
  try {
    assert.equal(resolveDeskewMode("auto", root), null);
    assert.equal(resolveDeskewMode("off", root), null);
    assert.throws(() => resolveDeskewMode("paper", root), /does not exist/);
    assert.throws(() => resolveDeskewMode("sideways", root), /expected/);
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "deskew.ts"), "export {};\n");
    assert.equal(resolveDeskewMode("auto", root), "paper");
    assert.equal(resolveDeskewMode("crop", root), "crop");
    assert.equal(resolveDeskewMode("off", root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
