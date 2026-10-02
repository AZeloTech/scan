import assert from "node:assert/strict";
import test from "node:test";

import {
  applyHomography,
  cameraFromPose,
  distanceForCoverage,
  focalPx,
  mat3Inv,
  mat3Mul,
  mat3Vec,
  planeHomography,
  project,
  projectedCoverage,
  rayMatrix,
  rectCorners,
} from "./emulator/camera.js";
import { rngFor } from "./emulator/prng.js";

/**
 * The emulator's ground truth is computed, not measured, so the maths it is
 * computed with is the thing to test: the pinhole, the plane homography the
 * GT is read from, and the ray matrix the shader renders with must all agree,
 * and the seeded streams must be stable.
 */

const FRAME = { width: 1080, height: 1920 };
const close = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≉ ${expected}`);

test("a camera looking straight down images the desk as a scaled copy", () => {
  const camera = cameraFromPose({ distance: 400, target: [10, 20] }, FRAME);
  const f = focalPx(FRAME.width, FRAME.height);
  const centre = project(camera, [10, 20, 0]);
  close(centre.u, 540, 1e-9);
  close(centre.v, 960, 1e-9);
  close(centre.depth, 400, 1e-9);
  // 100 mm to the right of the target lands f·100/400 px to the right.
  close(project(camera, [110, 20, 0]).u, 540 + (f * 100) / 400, 1e-9);
  // +Y on the desk is down the image.
  assert.ok(project(camera, [10, 120, 0]).v > 960);
});

test("26 mm equivalent gives a phone's ~79° diagonal field of view", () => {
  const f = focalPx(FRAME.width, FRAME.height);
  const diagonalFov = (2 * Math.atan(Math.hypot(1080, 1920) / 2 / f) * 180) / Math.PI;
  close(diagonalFov, 79.5, 0.5);
});

test("the plane homography and the ray matrix agree with the pinhole", () => {
  const camera = cameraFromPose(
    { distance: 350, tilt: 18, azimuth: 40, roll: -7, target: [15, -25] },
    FRAME,
  );
  for (const height of [0, 2.5]) {
    const H = planeHomography(camera, height);
    const M = rayMatrix(camera);
    for (const [x, y] of [
      [-105, -148.5],
      [105, -148.5],
      [60, 90],
      [0, 0],
    ]) {
      const expected = project(camera, [x, y, -height]);
      const [u, v] = applyHomography(H, x, y);
      close(u, expected.u, 1e-6);
      close(v, expected.v, 1e-6);
      // Cast the ray back through that pixel and intersect the same plane.
      const dir = mat3Vec(M, [u, v, 1]);
      const s = (-height - camera.C[2]) / dir[2];
      close(camera.C[0] + s * dir[0], x, 1e-6);
      close(camera.C[1] + s * dir[1], y, 1e-6);
    }
    const inverse = mat3Mul(H, mat3Inv(H));
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value, index) => close(inverse[index], value, 1e-9));
  }
});

test("tilting leans the optical axis towards the azimuth", () => {
  const camera = cameraFromPose({ distance: 300, tilt: 30, azimuth: 0 }, FRAME);
  // The axis heads towards +X, so the camera sits on the −X side of the target.
  assert.ok(camera.C[0] < 0);
  close(camera.C[2], -300 * Math.cos(Math.PI / 6), 1e-9);
  // The target still images at the principal point.
  const target = project(camera, [0, 0, 0]);
  close(target.u, 540, 1e-6);
  close(target.v, 960, 1e-6);
});

test("the distance solver hits the requested coverage", () => {
  const page = { center: [0, 0], size: [210, 297], rotation: 8 };
  for (const coverage of [0.25, 0.45, 0.6]) {
    const pose = { tilt: 15, azimuth: 120, roll: 3, target: [5, 5] };
    const distance = distanceForCoverage(pose, FRAME, page, coverage);
    const covered = projectedCoverage(cameraFromPose({ ...pose, distance }, FRAME), page);
    close(covered, coverage, 1e-6);
  }
});

test("rect corners run TL, TR, BR, BL in the page's own frame", () => {
  const corners = rectCorners({ center: [0, 0], size: [200, 100], rotation: 90, height: 2 });
  // Rotated 90°: the page's top edge now runs down the desk's +Y.
  const [tl, tr] = corners;
  close(tl[0], 50, 1e-9);
  close(tl[1], -100, 1e-9);
  close(tr[0], 50, 1e-9);
  close(tr[1], 100, 1e-9);
  close(tl[2], -2, 1e-12);
});

test("seeded streams are stable, and forks do not disturb each other", () => {
  const a = rngFor("F1", 7);
  const b = rngFor("F1", 7);
  assert.deepEqual([a.next(), a.next(), a.next()], [b.next(), b.next(), b.next()]);
  assert.notEqual(rngFor("F1", 7).next(), rngFor("F1", 8).next());
  // A fork draws the same values however much its parent was used before.
  const fresh = rngFor("F1", 7).fork("camera").next();
  const used = rngFor("F1", 7);
  used.next();
  used.next();
  assert.equal(used.fork("camera").next(), fresh);
  assert.notEqual(rngFor("F1", 7).fork("document").next(), fresh);
  const r = rngFor("range");
  for (let i = 0; i < 1000; i += 1) {
    const x = r.int(3, 5);
    assert.ok(x >= 3 && x <= 5 && Number.isInteger(x));
  }
});

test("F1 scenes are deterministic, framed and in the D-343 coverage band", async () => {
  const { buildScene, groundTruth } = await import("./emulator/index.js");
  assert.deepEqual(buildScene("F1", 3), buildScene("F1", 3));
  assert.notDeepEqual(buildScene("F1", 3), buildScene("F1", 4));
  const settings = new Set();
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const size of ["portrait", "landscape"]) {
      const params = buildScene("F1", seed, { size });
      settings.add(params.setting);
      const gt = groundTruth(params);
      assert.equal(gt.pages.length, 1);
      const [pageTruth] = gt.pages;
      assert.ok(pageTruth.inFrame.every(Boolean), `F1/${seed}/${size}: a corner left the frame`);
      assert.ok(pageTruth.visible.every(Boolean));
      assert.ok(
        pageTruth.coverage > 0.24 && pageTruth.coverage < 0.61,
        `F1/${seed}/${size}: coverage ${pageTruth.coverage}`,
      );
      assert.deepEqual(gt.quad, pageTruth.corners);
      // The page, not the mat: its corners are the last layer's.
      assert.equal(params.layers[pageTruth.layer].name, "page");
    }
  }
  assert.deepEqual([...settings].sort(), ["granite", "wood-mat"]);
});

test("F7 cycles its settings by seed, and its distractors sit where they claim", async () => {
  const { buildScene, groundTruth } = await import("./emulator/index.js");
  const { F7_SETTINGS } = await import("./emulator/family-f7.js");
  assert.equal(new Set(F7_SETTINGS).size, F7_SETTINGS.length);
  const toLocal = (page, [x, y]) => {
    const a = (page.rotation * Math.PI) / 180;
    const dx = x - page.center[0];
    const dy = y - page.center[1];
    return [Math.cos(a) * dx + Math.sin(a) * dy, -Math.sin(a) * dx + Math.cos(a) * dy];
  };
  const normals = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  for (let seed = 1; seed <= F7_SETTINGS.length * 3; seed += 1) {
    const params = buildScene("F7", seed);
    assert.equal(params.setting, F7_SETTINGS[(seed - 1) % F7_SETTINGS.length], `F7 #${seed}`);
    assert.deepEqual(buildScene("F7", seed), params, `F7 #${seed}: a scene is a pure function of its seed`);
    const gt = groundTruth(params);
    const primary = gt.pages[gt.primary];
    const page = params.layers[primary.layer];
    assert.equal(page.name, "page");
    if (params.setting === "neighbour" || params.setting === "parallel-object") {
      // Beside the target side, clear of the page: every corner of the other
      // thing lies past the side's line.
      const other = params.layers.find((layer) => layer !== page);
      const n = normals[params.target];
      const across = params.target % 2 === 0 ? page.size[1] / 2 : page.size[0] / 2;
      const a = (other.rotation * Math.PI) / 180;
      const [hw, hh] = [other.size[0] / 2, other.size[1] / 2];
      for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
        const world = [other.center[0] + Math.cos(a) * x - Math.sin(a) * y, other.center[1] + Math.sin(a) * x + Math.cos(a) * y];
        const [lx, ly] = toLocal(page, world);
        assert.ok(lx * n[0] + ly * n[1] > across, `F7 #${seed} ${params.setting}: the ${other.name} reaches over the page`);
      }
      if (params.setting === "neighbour") assert.equal(gt.pages.length, 2);
    }
    if (params.setting === "dog-ear") {
      // The corner is gone (torn) or folded over: either way not visible.
      assert.equal(primary.visible[params.corner], false, `F7 #${seed}: the dog-eared corner is visible`);
      assert.ok(primary.inFrame.every(Boolean));
    }
    if (params.setting === "receipt-tear") {
      const torn = params.ends.flatMap((k) => [k, (k + 1) % 4]);
      for (const corner of torn) assert.equal(primary.visible[corner], false, `F7 #${seed}: torn corner ${corner} visible`);
    }
    const beside = (other) => {
      const n = normals[params.target];
      const across = params.target % 2 === 0 ? page.size[1] / 2 : page.size[0] / 2;
      const a = (other.rotation * Math.PI) / 180;
      const [hw, hh] = [other.size[0] / 2, other.size[1] / 2];
      return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].every(([x, y]) => {
        const world = [other.center[0] + Math.cos(a) * x - Math.sin(a) * y, other.center[1] + Math.sin(a) * x + Math.cos(a) * y];
        const [lx, ly] = toLocal(page, world);
        return lx * n[0] + ly * n[1] > across;
      });
    };
    if (params.setting === "dark-stock" && (params.beyond === "object" || params.beyond === "both")) {
      assert.ok(beside(params.layers[params.layers.length - 1]), `F7 #${seed}: the object reaches over the page`);
    }
    if (params.setting === "black-table" && params.white !== "none") {
      assert.equal(gt.pages.length, 2);
      assert.ok(beside(params.layers[params.layers.length - 1]), `F7 #${seed}: the white ${params.white} reaches over the page`);
      assert.ok(params.gapFrac < params.edgeFrac, `F7 #${seed}: the white thing starts past the black's edge`);
    }
    if (params.setting === "stack-offset") {
      // The first sheet below: 1–5 mm past side k, 1–5 mm either way along side j's normal.
      const below = params.layers[params.layers.length - 2];
      const [lx, ly] = toLocal(page, below.center);
      const out = lx * normals[params.target][0] + ly * normals[params.target][1];
      const sideways = lx * normals[params.side][0] + ly * normals[params.side][1];
      assert.ok(out >= 1 - 1e-9 && out <= 5 + 1e-9, `F7 #${seed}: offset ${out} mm past the target side`);
      assert.ok(Math.abs(sideways) >= 1 - 1e-9 && Math.abs(sideways) <= 5 + 1e-9, `F7 #${seed}: offset ${sideways} mm sideways`);
    }
    if (params.setting === "screen") {
      // The page is on the screen: inside the glass, which is inside the device.
      const glass = params.layers.find((layer) => layer.name === "screen");
      const a = (page.rotation * Math.PI) / 180;
      const [hw, hh] = [page.size[0] / 2, page.size[1] / 2];
      for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
        const world = [page.center[0] + Math.cos(a) * x - Math.sin(a) * y, page.center[1] + Math.sin(a) * x + Math.cos(a) * y];
        const [lx, ly] = toLocal(glass, world);
        assert.ok(Math.abs(lx) <= glass.size[0] / 2 + 1e-6 && Math.abs(ly) <= glass.size[1] / 2 + 1e-6, `F7 #${seed}: the page runs off the screen`);
      }
    }
    if (params.setting === "booklet") {
      // The right-hand page is the one scanned; the facing page meets it at the spine.
      assert.equal(gt.pages.length, 2);
      assert.equal(gt.primary, 1);
      const left = params.layers[gt.pages[0].layer];
      const [lx] = toLocal(page, left.center);
      assert.ok(Math.abs(lx + page.size[0]) < 1e-6, `F7 #${seed}: the facing page is ${lx} mm off`);
    }
  }
});

test("content boxes project with the page: a page's corners are its content's (0,0) and (1,1)", async () => {
  const { buildScene, groundTruth, withContent } = await import("./emulator/index.js");
  for (const [family, seed] of [
    ["F1", 3],
    ["F4", 2],
  ]) {
    const params = buildScene(family, seed);
    const whole = [{ kind: "text", box: [0, 0, 1, 1] }];
    const gt = withContent(groundTruth(params), params, () => whole);
    const page = gt.pages[gt.primary];
    assert.equal(gt.content, page.content);
    // A box over the whole page is the page's own outline (flat: its four corners).
    const [box] = gt.content;
    assert.equal(box.kind, "text");
    const layer = params.layers[page.layer];
    if (layer.curl) {
      assert.ok(box.polygon.length > 4, "a curled page's box follows the curl");
    } else {
      assert.equal(box.polygon.length, 4);
      box.polygon.forEach(([x, y], i) => {
        close(x, page.corners[i][0], 1e-9);
        close(y, page.corners[i][1], 1e-9);
      });
    }
  }
});

test("a content box sits where the page's fractions say, and a scene without a page has none", async () => {
  const { buildScene, groundTruth, withContent } = await import("./emulator/index.js");
  const params = buildScene("F1", 5);
  const layerIndex = groundTruth(params).pages[0].layer;
  const flat = { ...params, layers: params.layers.map((l, i) => (i === layerIndex ? { ...l, curl: undefined, rotation: 0 } : l)) };
  const gt = withContent(groundTruth(flat), flat, () => [{ kind: "identifier", box: [0.5, 0.5, 0.5, 0.5] }]);
  // The page's centre fraction lands on the projection of the page's centre.
  const [x, y] = gt.content[0].polygon[0];
  const camera = cameraFromPose(flat.camera, flat.frame);
  const layer = flat.layers[layerIndex];
  const centre = project(camera, [layer.center[0], layer.center[1], -(layer.height ?? 0)]);
  close(x * flat.frame.width, centre.u, 1e-6);
  close(y * flat.frame.height, centre.v, 1e-6);
  const empty = buildScene("F6", 1);
  assert.equal(withContent(groundTruth(empty), empty, () => []).content, null);
});

test("F8 cycles its settings by seed, and its occluders cover what they claim", async () => {
  const { buildScene, groundTruth } = await import("./emulator/index.js");
  const { F8_SETTINGS } = await import("./emulator/family-f8.js");
  assert.equal(new Set(F8_SETTINGS).size, F8_SETTINGS.length);
  const toLocal = (layer, [x, y]) => {
    const a = (layer.rotation * Math.PI) / 180;
    const dx = x - layer.center[0];
    const dy = y - layer.center[1];
    return [Math.cos(a) * dx + Math.sin(a) * dy, -Math.sin(a) * dx + Math.cos(a) * dy];
  };
  const toWorld = (layer, [x, y]) => {
    const a = (layer.rotation * Math.PI) / 180;
    return [layer.center[0] + Math.cos(a) * x - Math.sin(a) * y, layer.center[1] + Math.sin(a) * x + Math.cos(a) * y];
  };
  const inside = (layer, point) => {
    const [lx, ly] = toLocal(layer, point);
    return Math.abs(lx) <= layer.size[0] / 2 && Math.abs(ly) <= layer.size[1] / 2;
  };
  const signs = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let seed = 1; seed <= F8_SETTINGS.length * 4; seed += 1) {
    const params = buildScene("F8", seed);
    assert.equal(params.setting, F8_SETTINGS[(seed - 1) % F8_SETTINGS.length], `F8 #${seed}`);
    assert.deepEqual(buildScene("F8", seed), params, `F8 #${seed}: a scene is a pure function of its seed`);
    const gt = groundTruth(params);
    const primary = gt.pages[gt.primary];
    assert.ok(primary.inFrame.every(Boolean), `F8 #${seed}: the whole page is in frame`);
    assert.deepEqual(primary.occluded, [0, 1, 2, 3].filter((c) => !primary.visible[c]), `F8 #${seed}: covered = in frame, not seen`);
    const page = params.layers[primary.layer];
    const occluderLayers = params.layers.filter((l) => l.occluder);
    assert.deepEqual(gt.occluders.map((o) => o.kind), occluderLayers.map((l) => l.occluder));
    for (const o of gt.occluders) assert.ok(o.polygon.length >= 4, `F8 #${seed}: an occluder has an outline`);
    const { occlusion } = params;
    if (params.setting === "owner-case" || params.setting === "sheet-over") {
      assert.deepEqual(primary.occluded, [occlusion.corner], `F8 #${seed}: the covered corner is the one asked for`);
      const sheet = occluderLayers[0];
      assert.ok(sheet.height > page.height, `F8 #${seed}: the sheet lies over the page`);
      // Along each edge meeting at the corner the sheet ends where `along` says.
      const [sx, sy] = signs[occlusion.corner];
      const [hw, hh] = [page.size[0] / 2, page.size[1] / 2];
      const edges = [
        (f) => [sx * hw - sx * f * page.size[0], sy * hh],
        (f) => [sx * hw, sy * hh - sy * f * page.size[1]],
      ];
      edges.forEach((at, i) => {
        const f = occlusion.along[i];
        assert.ok(f >= 0.05 && f <= 0.35, `F8 #${seed}: coverage ${f}`);
        assert.ok(inside(sheet, toWorld(page, at(f - 0.01))), `F8 #${seed}: edge ${i} covered short of ${f}`);
        assert.ok(!inside(sheet, toWorld(page, at(f + 0.01))), `F8 #${seed}: edge ${i} uncovered past ${f}`);
      });
      if (params.setting === "owner-case") {
        assert.ok(params.camera.tilt >= 30 && params.camera.tilt <= 45, `F8 #${seed}: tilt`);
        assert.ok(occlusion.stackPx >= 2 && occlusion.stackPx <= 6, `F8 #${seed}: the stack shows 2–6 px`);
        // The covered corner is the one the image shows top-left.
        const sums = primary.px.map(([u, v]) => u + v);
        assert.equal(occlusion.corner, sums.indexOf(Math.min(...sums)), `F8 #${seed}: top-left in the image`);
      }
    }
    if (params.setting === "two-sheets") {
      // The truth is the sheet on top (the owner's decision): whole, nothing over it.
      assert.equal(gt.pages.length, 2);
      assert.equal(gt.primary, 1);
      const [under, over] = gt.pages.map((p) => params.layers[p.layer]);
      assert.ok(over.height > under.height, `F8 #${seed}: the answer is the sheet on top`);
      assert.deepEqual(primary.occluded, [], `F8 #${seed}: nothing covers the sheet on top`);
      assert.deepEqual(gt.occluders, []);
    }
    if (params.setting === "staple") assert.deepEqual(primary.occluded, [], `F8 #${seed}: a staple leaves the corner seen`);
  }
});
