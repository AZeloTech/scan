import assert from "node:assert/strict";
import test from "node:test";

import {
  clearArea,
  frameBoxFor,
  MAX_CROP_PER_SIDE,
  resolveFit,
  sameRegion,
  videoBoxFor,
  visibleRegionOf,
  type Box,
} from "./visible-region.ts";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

const STAGE = { width: 412, height: 891 };
const PORTRAIT_9_16 = { width: 720, height: 1280 };
const PORTRAIT_3_4 = { width: 960, height: 1280 };
/** The rail's bottom band: 14 px safe area + 11.75 rem. */
const BOTTOM = { edge: "bottom" as const, box: { left: 0, top: 891 - 202, width: 412, height: 202 } };

test("clear area: the stage ∩ the viewport, minus the bands on each edge", () => {
  assert.deepEqual(clearArea(STAGE, null, []), { left: 0, top: 0, width: 412, height: 891 });
  assert.deepEqual(clearArea(STAGE, null, [BOTTOM]), { left: 0, top: 0, width: 412, height: 689 });
  const top = { edge: "top" as const, box: { left: 0, top: 0, width: 412, height: 47 } };
  assert.deepEqual(clearArea(STAGE, null, [top, BOTTOM]), { left: 0, top: 47, width: 412, height: 642 });
  // A band with no size (a safe area of 0) is no band.
  assert.deepEqual(clearArea(STAGE, null, [{ edge: "top", box: { left: 0, top: 0, width: 412, height: 0 } }]).top, 0);
  // Zoomed in: the visual viewport shows part of the stage.
  const viewport: Box = { left: 50, top: 100, width: 200, height: 400 };
  assert.deepEqual(clearArea(STAGE, viewport, [BOTTOM]), { left: 50, top: 100, width: 200, height: 400 });
  // Side bands.
  const left = { edge: "left" as const, box: { left: 0, top: 0, width: 30, height: 891 } };
  const right = { edge: "right" as const, box: { left: 392, top: 0, width: 20, height: 891 } };
  assert.deepEqual(clearArea(STAGE, null, [left, right]), { left: 30, top: 0, width: 362, height: 891 });
});

test("cover: fills the stage, crops the sides of a 9:16 frame on a 19.5:9 phone", () => {
  const clear = clearArea(STAGE, null, []);
  const frame = frameBoxFor("cover", PORTRAIT_9_16, STAGE, clear);
  near(frame.height, 891);
  near(frame.width, 720 * (891 / 1280));
  near(frame.left, (412 - frame.width) / 2);
  const region = visibleRegionOf(frame, clear)!;
  near(region.y, 0);
  near(region.height, 1);
  near(region.x, (frame.width - 412) / 2 / frame.width);
  near(region.x + region.width, 1 - region.x);
  // Cover ignores the bands for placement, but the region does not show what they hide.
  const banded = clearArea(STAGE, null, [BOTTOM]);
  const hidden = visibleRegionOf(frameBoxFor("cover", PORTRAIT_9_16, STAGE, banded), banded)!;
  near(hidden.height, 689 / 891);
  assert.equal(videoBoxFor("cover", frame, STAGE), null);
});

test("contain: the whole frame in the clear area, centred in it", () => {
  const clear = clearArea(STAGE, null, [BOTTOM]);
  const frame = frameBoxFor("contain", PORTRAIT_9_16, STAGE, clear);
  // 9:16 is wider than 412×689: the width limits.
  near(frame.width, 412 * (1280 / 720) > 689 ? 689 * (720 / 1280) : 412);
  near(frame.top + frame.height / 2, 689 / 2);
  const region = visibleRegionOf(frame, clear)!;
  assert.ok(sameRegion(region, { x: 0, y: 0, width: 1, height: 1 }));
});

test("maxcrop: covers the clear area, never more than 12 % off a side", () => {
  const clear = clearArea(STAGE, null, [BOTTOM]);
  // 9:16 on 412×689: cover crops 3 % top and bottom — under the ceiling.
  const tall = frameBoxFor("maxcrop", PORTRAIT_9_16, STAGE, clear);
  near(tall.width, 412);
  const tallRegion = visibleRegionOf(tall, clear)!;
  near(tallRegion.x, 0);
  near(tallRegion.width, 1);
  near(tallRegion.y, (tall.height - 689) / 2 / tall.height);
  assert.ok(tallRegion.y < MAX_CROP_PER_SIDE);
  // 3:4 on 412×689: cover would crop 10 % a side — allowed.
  const wide = visibleRegionOf(frameBoxFor("maxcrop", PORTRAIT_3_4, STAGE, clear), clear)!;
  near(wide.y, 0);
  near(wide.height, 1);
  near(wide.x, (1 - 412 / (960 * (689 / 1280))) / 2);
  assert.ok(wide.x <= MAX_CROP_PER_SIDE);
  // A 16:9 landscape frame would lose most of its width: capped at 12 % a side, letterboxed.
  const landscape = { width: 1280, height: 720 };
  const capped = frameBoxFor("maxcrop", landscape, STAGE, clear);
  const cappedRegion = visibleRegionOf(capped, clear)!;
  near(cappedRegion.x, MAX_CROP_PER_SIDE);
  near(cappedRegion.width, 1 - 2 * MAX_CROP_PER_SIDE);
  near(cappedRegion.height, 1);
  assert.ok(capped.height < 689);
  // A short phone: 360×640 with the same band — the 9:16 frame is capped vertically.
  const small = { width: 360, height: 640 };
  const smallClear = clearArea(small, null, [{ edge: "bottom", box: { left: 0, top: 640 - 202, width: 360, height: 202 } }]);
  const smallRegion = visibleRegionOf(frameBoxFor("maxcrop", PORTRAIT_9_16, small, smallClear), smallClear)!;
  near(smallRegion.y, MAX_CROP_PER_SIDE);
  near(smallRegion.x, 0);
});

test("the video box puts the frame where the frame box says, when the stage clips it", () => {
  const clear = clearArea(STAGE, null, [BOTTOM]);
  const frame = frameBoxFor("maxcrop", PORTRAIT_9_16, STAGE, clear);
  // Centred in 0..689, the frame starts above the stage: only its top is clipped.
  assert.ok(frame.top < 0 && frame.top + frame.height < 891);
  const video = videoBoxFor("maxcrop", frame, STAGE)!;
  near(video.box.top, 0);
  near(video.box.height, frame.top + frame.height);
  near(video.box.width, frame.width);
  // object-fit: cover in that box, at that position, draws the frame box.
  const scale = Math.max(video.box.width / 720, video.box.height / 1280);
  near(720 * scale, frame.width);
  const contentTop = video.box.top + (video.box.height - 1280 * scale) * video.position.y;
  near(contentTop, frame.top);
  near(video.position.x, 0.5);
});

test("fit values are read defensively", () => {
  assert.equal(resolveFit("contain", "cover"), "contain");
  assert.equal(resolveFit("maxcrop", "cover"), "maxcrop");
  assert.equal(resolveFit("stretch", "maxcrop"), "maxcrop");
  assert.equal(resolveFit(undefined, "cover"), "cover");
  assert.equal(visibleRegionOf({ left: 0, top: 0, width: 0, height: 0 }, clearArea(STAGE, null, [])), null);
});
