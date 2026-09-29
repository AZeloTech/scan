import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScene,
  buildSession,
  familyIds,
  groundTruth,
  loopedFrame,
  loopedTime,
  renderedFrameCount,
  SESSION_FRAME_MS,
  poseAt,
  sessionAt,
  sessionIds,
  sessionTruth,
  stillGeometry,
  tremorAt,
  tremorModel,
} from "./emulator/index.js";
import { cameraFromPose, curlLift, layerOutline, project, rectCorners } from "./emulator/camera.js";
import { previewFocal } from "./emulator/stream.js";
import { StreamPlayer } from "./app/session-player.js";

/**
 * Sessions are scored against truth computed from their scripts, so the
 * scripts must be stable and must do what their names say: the page in view
 * during a hold, a new page after a swap, nothing on an empty desk, a page cut
 * off when it is meant to be. The tremor must be the hand the field footage
 * shows, and a still must see the scene through the same lens as the preview.
 */

const close = (actual, expected, tolerance, what = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} ${actual} ≉ ${expected}`);

test("every session script is deterministic and plain JSON", () => {
  for (const id of sessionIds()) {
    const a = buildSession(id, 1);
    assert.deepEqual(a, buildSession(id, 1), id);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a, id);
    assert.ok(a.duration > 5000, id);
    // A session with auto-capture on may leave every capture to it.
    assert.ok(a.autoCapture === true || a.actions.some((step) => step.tap !== undefined), `${id}: never taps the shutter`);
  }
  assert.notDeepEqual(buildSession("approach-hold", 1), buildSession("approach-hold", 2));
});

test("the tremor is unit-RMS 1/f noise in the hand's 0.5–3 Hz band", () => {
  const model = tremorModel(42);
  const samples = [];
  for (let t = 0; t < 120_000; t += 10) samples.push(tremorAt(model, t));
  for (let axis = 0; axis < 3; axis += 1) {
    const values = samples.map((s) => s[axis]);
    const rms = Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
    close(rms, 1, 0.12, `axis ${axis} rms`);
    let crossings = 0;
    for (let i = 1; i < values.length; i += 1) if (Math.sign(values[i]) !== Math.sign(values[i - 1])) crossings += 1;
    const hz = crossings / 2 / 120;
    assert.ok(hz > 0.5 && hz < 3, `axis ${axis}: ${hz} Hz`);
  }
});

test("a hold's tremor moves the page by the scripted fraction of the frame", () => {
  const script = buildSession("tremor-hold", 1);
  const camera0 = cameraFromPose(script.camera[0].pose, script.frame);
  const centre = [script.camera[0].pose.target[0], script.camera[0].pose.target[1], 0];
  const rest = project(camera0, centre);
  const shifts = [];
  for (let t = 0; t < 4500; t += 20) {
    const p = project(cameraFromPose(poseAt(script, t), script.frame), centre);
    shifts.push(Math.hypot(p.u - rest.u, p.v - rest.v) / script.frame.height);
  }
  const rms = Math.sqrt(shifts.reduce((s, v) => s + v * v, 0) / shifts.length);
  // Two axes of 1.2 % each; a 4.5 s window of 1/f noise is short, so loosely.
  assert.ok(rms > 0.008 && rms < 0.03, `image RMS ${rms}`);
});

test("sessions show what they say they show", () => {
  const approach = buildSession("approach-hold", 1);
  const held = sessionTruth(approach, approach.marks.holdFrom + 100);
  assert.ok(held.whole && held.quad !== null, "approach-hold: the page is whole during the hold");

  for (let seed = 1; seed <= 8; seed += 1) {
    const swap = buildSession("page-swap", seed);
    const before = sessionTruth(swap, swap.marks.swapAt - 100);
    const after = sessionTruth(swap, swap.marks.lockFrom2 + 200);
    assert.ok(before.whole && after.whole, `page-swap #${seed}: a page not whole`);
    const moved = Math.max(...before.quad.map((p, i) => Math.hypot(p[0] - after.quad[i][0], p[1] - after.quad[i][1])));
    assert.ok(moved > 0.05, `page-swap #${seed}: the new page lies elsewhere (${moved})`);
  }

  const empty = buildSession("empty-desk-sweep", 1);
  for (let t = 0; t < empty.duration; t += 500) assert.equal(sessionTruth(empty, t).quad, null);

  for (let seed = 1; seed <= 4; seed += 1) {
    const partial = buildSession("partial-frame", seed);
    const cut = sessionTruth(partial, partial.marks.partialFrom + 100);
    assert.ok(cut.quad !== null && !cut.whole, `partial-frame #${seed}: the page is cut off at first`);
    assert.ok(sessionTruth(partial, partial.marks.lockFrom + 100).whole, `partial-frame #${seed}: whole after backing off`);
  }

  for (let seed = 1; seed <= 6; seed += 1) {
    const shaky = buildSession("tremor-hold", seed);
    for (let t = 0; t < shaky.marks.holdTo; t += 50) {
      assert.ok(sessionTruth(shaky, t).whole, `tremor-hold #${seed}: the tremor pushed the page out at ${t} ms`);
    }
    // The thumb is in the frame, on the page.
    const params = sessionAt(shaky, shaky.marks.fingerAt + 800);
    const [finger] = params.effects;
    assert.ok(finger.tip[0] > 0 && finger.tip[1] > 0 && finger.tip[0] < shaky.frame.width && finger.tip[1] < shaky.frame.height, `tremor-hold #${seed}: thumb off frame`);
  }
});

test("a still sees through the preview's lens: its shape, and a wider one on request", () => {
  const script = buildSession("wider-still", 1);
  const focal = previewFocal(script);
  // What the app asks for at a 9:16 preview of a 4000×3000 sensor.
  const request = { imageWidth: 3000, imageHeight: 1688 };
  const honoured = stillGeometry({ ...script.still, aspect: "preview" }, script.frame, focal, request);
  assert.deepEqual([honoured.width, honoured.height], [1688, 3000]);
  close(honoured.width / honoured.height, script.frame.width / script.frame.height, 0.002);
  const sensor = stillGeometry(script.still, script.frame, focal, request);
  assert.deepEqual([sensor.width, sensor.height], [2250, 3000]);
  // Same vertical field of view: the preview's top edge is the still's top edge.
  const pose = poseAt(script, 5000);
  const preview = cameraFromPose(pose, script.frame);
  const still = cameraFromPose({ ...pose, focalPixels: sensor.focalPixels }, { width: sensor.width, height: sensor.height });
  const halfAngle = (script.frame.height / 2) / preview.f;
  close((sensor.height / 2) / still.f, halfAngle, 1e-9);
  // …and a wider horizontal one.
  assert.ok((sensor.width / 2) / still.f > (script.frame.width / 2) / preview.f * 1.3);
  const eis = stillGeometry({ ...script.still, aspect: "preview", fovScale: 1.25 }, script.frame, focal, request);
  close((eis.height / 2) / eis.focalPixels, halfAngle * 1.25, 1e-9);
});

test("a curled page's truth: lifted corners, a curved outline through them", () => {
  const layer = {
    center: [10, -5],
    size: [210, 297],
    rotation: 12,
    height: 1,
    curl: { mode: "edge-x", lift: 8, reach: 40, side: 1 },
  };
  const half = [105, 148.5];
  close(curlLift(layer.curl, [105, 0], half), 8, 1e-12);
  close(curlLift(layer.curl, [105 - 40, 0], half), 0, 1e-12);
  close(curlLift(layer.curl, [-105, 0], half), 0, 1e-12);
  const corners = rectCorners(layer);
  close(corners[1][2], -9, 1e-9, "TR is lifted");
  close(corners[0][2], -1, 1e-9, "TL is not");
  const outline = layerOutline(layer, 8);
  assert.equal(outline.length, 32);
  for (let c = 0; c < 4; c += 1) {
    for (let axis = 0; axis < 3; axis += 1) close(outline[c * 8][axis], corners[c][axis], 1e-9);
  }
  const roll = { ...layer, curl: { mode: "roll-y", lift: 6, reach: 1, side: 1 } };
  close(curlLift(roll.curl, [0, 148.5], half), 6, 1e-12);
  close(curlLift(roll.curl, [0, -148.5], half), 6, 1e-12);
  close(curlLift(roll.curl, [0, 0], half), 0, 1e-12);
});

test("every family is deterministic, and its truth matches what it claims", () => {
  const seen = {};
  for (const family of familyIds()) {
    for (let seed = 1; seed <= 30; seed += 1) {
      const params = buildScene(family, seed);
      assert.deepEqual(params, buildScene(family, seed));
      const gt = groundTruth(params);
      (seen[`${family}:${params.setting}`] ??= []).push(gt);
      if (family === "F6") {
        assert.equal(gt.quad, null, `F6 #${seed} has a page`);
        continue;
      }
      assert.ok(gt.quad !== null, `${family} #${seed} has no page`);
      const primary = gt.pages[gt.primary];
      if (params.setting === "partial") {
        assert.ok(!primary.inFrame.every(Boolean), `F5 #${seed}: partial, yet every corner is in frame`);
      } else {
        assert.ok(primary.inFrame.every(Boolean), `${family} #${seed} ${params.setting}: a corner left the frame`);
      }
      if (params.setting === "tiny") assert.ok(primary.coverage < 0.12, `F3 #${seed}: tiny at ${primary.coverage}`);
      if (params.setting === "two-docs") assert.equal(gt.pages.length, 2);
      if (params.setting === "object-on-page") {
        assert.ok(primary.visible.some((v) => !v), `F5 #${seed}: the object hides no corner`);
      }
    }
  }
  // Every family samples more than one setting in 30 seeds.
  for (const family of familyIds()) {
    const settings = Object.keys(seen).filter((key) => key.startsWith(`${family}:`));
    assert.ok(settings.length >= 2, `${family}: ${settings.join(", ")}`);
  }
});

test("a finger over a corner hides that corner in the truth", () => {
  let checked = 0;
  for (let seed = 1; seed <= 60 && checked < 3; seed += 1) {
    const params = buildScene("F5", seed);
    if (params.setting !== "finger") continue;
    const gt = groundTruth(params);
    const [finger] = params.effects;
    const page = gt.pages[gt.primary];
    const hidden = page.px.filter(([u, v]) => {
      const d = Math.hypot(u - finger.tip[0], v - finger.tip[1]);
      return d < finger.width * 0.3;
    });
    if (hidden.length > 0) {
      assert.ok(page.visible.some((v) => !v), `F5 #${seed}: the finger's corner is still visible`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "no F5 finger-over-corner scene in 60 seeds");
});

test("a grab names the frame it drew by that frame's own timestamp, not by the last presentation", () => {
  // Frames pushed every 33.3 ms (frame 4 skipped); the canvas capture's clock
  // starts at frame 1 (46 ms after frame 0's push), each frame captured a
  // little after its push. The <video> last *presented* frame 20 but already
  // holds 21 when the app draws it; 25 has been pushed.
  const interval = 1000 / 30;
  const pushAt = (k) => 1000 + k * interval + (k % 2) * 1.2;
  const stamp = (k) => (pushAt(k) - pushAt(0) - 46 + 0.4) * 1000;
  const player = Object.create(StreamPlayer.prototype);
  Object.assign(player, {
    frameIntervalMs: interval,
    pushes: [0, 1, 2, 3, ...Array.from({ length: 21 }, (_, i) => 5 + i)].map((k) => ({ k, at: pushAt(k) })),
    presented: [],
    grabs: [],
  });
  const held = (us) => {
    player.heldTimestamp = () => us;
  };
  // Too few presented frames to know the capture clock's origin: nothing is named.
  held(stamp(21));
  player.noteGrab(1, 1700);
  assert.equal(player.grabs[0].k, null);
  player.presented = [1, 2, 3, ...Array.from({ length: 16 }, (_, i) => 5 + i)].map((k) => ({ at: pushAt(k) + 20, k, mediaTime: stamp(k) / 1e6 }));
  assert.ok(Math.abs(player.timestampOffset() - (46 - 0.4)) < 1e-6);
  player.noteGrab(2, 1700);
  assert.deepEqual([player.grabs[1].k, player.grabs[1].presentedK, player.grabs[1].pushedK], [21, 20, 25]);
  // A timestamp between frames names nothing; so does an unreadable one.
  held(stamp(21) + (interval / 2) * 1000);
  player.noteGrab(3, 1710);
  held(null);
  player.noteGrab(4, 1720);
  assert.deepEqual(player.grabs.slice(2).map((g) => g.k), [null, null]);
  // Presented frames that disagree about the offset name nothing either.
  player.presented = player.presented.map((p, i) => ({ ...p, mediaTime: p.mediaTime + (i % 2) * 0.02 }));
  assert.equal(player.timestampOffset(), null);
});

test("a looped session plays its rendered frames forward and back, stills included", () => {
  const script = buildSession("sustained-hold", 1);
  assert.equal(renderedFrameCount(script, 60), 300);
  assert.equal(renderedFrameCount(buildSession("tremor-hold", 1), 60), Math.ceil(9000 / SESSION_FRAME_MS) + 60);
  // 0 … 299 forward, 298 … 1 back, 0 again: never a jump.
  assert.deepEqual([0, 1, 299, 300, 301, 597, 598, 599].map((n) => loopedFrame(script, n)), [0, 1, 299, 298, 297, 1, 0, 1]);
  for (let n = 1; n < 2000; n += 1) assert.ok(Math.abs(loopedFrame(script, n) - loopedFrame(script, n - 1)) <= 1);
  // A still exposed at camera time t is a photo of the frame on screen then.
  for (const t of [0, 5000, 9966.7, 12000, 30000, 71234]) {
    const n = Math.round(t / SESSION_FRAME_MS);
    assert.ok(Math.abs(loopedTime(script, t) / SESSION_FRAME_MS - loopedFrame(script, n)) <= 1, `t ${t}`);
  }
  // Not looped: camera time is scene time.
  const plain = buildSession("approach-hold", 1);
  assert.equal(loopedFrame(plain, 1234), 1234);
  assert.equal(loopedTime(plain, 4321), 4321);
});

