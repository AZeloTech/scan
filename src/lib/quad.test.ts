import assert from "node:assert/strict";
import test from "node:test";

import {
  cornerBracketPath,
  cornerList,
  denormalizeQuad,
  frameDiagonal,
  FULL_FRAME_QUAD,
  lerpQuad,
  maxCornerShift,
  normalizedCoverage,
  QuadDetectionSmoother,
  type BracketCap,
  type NormalizedQuad,
} from "./quad.ts";

interface TestPoint {
  x: number;
  y: number;
}

/** The `M x,y L x,y` pairs of a bracket path, as points. */
function bracketSegments(path: string): [TestPoint, TestPoint][] {
  if (path === "") return [];
  return path.split(" ").map((segment) => {
    const [from, to] = segment.slice(1).split("L");
    const parse = (pair: string): TestPoint => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    };
    return [parse(from), parse(to)];
  });
}

function bracketLengths(path: string): number[] {
  return bracketSegments(path).map(([from, to]) =>
    Math.hypot(to.x - from.x, to.y - from.y),
  );
}

/** Segment lengths as the user sees them, once the viewBox is stretched. */
function drawnLengths(path: string, width: number, height: number): number[] {
  return bracketSegments(path).map(([from, to]) =>
    Math.hypot((to.x - from.x) * width, (to.y - from.y) * height),
  );
}

/** A cap in viewBox units: an unstretched box is a square one. */
function viewBoxCap(length: number): BracketCap {
  return { length, width: 1, height: 1 };
}

const ASPECT = 9 / 16;
const BASE: NormalizedQuad = {
  topLeft: { x: 0.15, y: 0.08 },
  topRight: { x: 0.85, y: 0.08 },
  bottomRight: { x: 0.85, y: 0.92 },
  bottomLeft: { x: 0.15, y: 0.92 },
};

function shifted(x: number): NormalizedQuad {
  return {
    topLeft: { x: BASE.topLeft.x + x, y: BASE.topLeft.y },
    topRight: { x: BASE.topRight.x + x, y: BASE.topRight.y },
    bottomRight: { x: BASE.bottomRight.x + x, y: BASE.bottomRight.y },
    bottomLeft: { x: BASE.bottomLeft.x + x, y: BASE.bottomLeft.y },
  };
}

test("a still document does not visibly chase alternating edge candidates", () => {
  const detections = Array.from({ length: 17 }, (_, index) =>
    shifted(index % 2 === 0 ? -0.006 : 0.006),
  );
  const smoother = new QuadDetectionSmoother();
  let target = smoother.update(detections[0], 0);
  let current = target;
  let detectorTravel = 0;
  let displayedTravel = 0;

  for (let frame = 1; frame <= 120; frame += 1) {
    if (frame % 8 === 0) {
      const raw = detections[frame / 8];
      detectorTravel += maxCornerShift(
        detections[frame / 8 - 1],
        raw,
        ASPECT,
      );
      target = smoother.update(raw, frame * (125 / 8));
    }
    const next = lerpQuad(current, target, 0.35);
    if (frame > 15) {
      displayedTravel += maxCornerShift(current, next, ASPECT);
    }
    current = next;
  }

  assert.ok(
    displayedTravel / detectorTravel <= 0.35,
    "the rendered outline should remove most stationary detector flicker",
  );
});

test("a real page move settles after the next confirming detection", () => {
  const smoother = new QuadDetectionSmoother();
  const before = shifted(0);
  const after = shifted(0.08);

  smoother.update(before, 0);
  const first = smoother.update(after, 125);
  const confirmed = smoother.update(after, 250);

  assert.ok(maxCornerShift(first, after, ASPECT) > 0);
  assert.ok(maxCornerShift(confirmed, after, ASPECT) < 1e-9);
});

test("a slow detector does not add a half-second of smoothing lag", () => {
  const smoother = new QuadDetectionSmoother();
  const after = shifted(0.08);

  smoother.update(BASE, 0);
  const result = smoother.update(after, 500);

  assert.ok(
    maxCornerShift(result, after, ASPECT) / frameDiagonal(ASPECT) < 1e-9,
  );
});

test("corner brackets are capped, and never longer than the edge allows", () => {
  // A quad wide enough that 12 % of an edge exceeds the cap on one axis and
  // not on the other: the cap has to bind per segment, not per quad.
  const path = cornerBracketPath(BASE, 0.12, viewBoxCap(0.05));
  const lengths = bracketLengths(path);

  assert.equal(lengths.length, 8, "four corners, two segments each");
  for (const length of lengths) {
    assert.ok(length <= 0.05 + 1e-9, `segment ${length} exceeded the cap`);
  }
  // Top edge is 0.70 wide → 12 % is 0.084, capped to 0.05. Side edges are 0.84
  // tall → 12 % is 0.1008, also capped. Both ends bind, so all eight are equal.
  for (const length of lengths) {
    assert.ok(Math.abs(length - 0.05) < 1e-9);
  }
});

test("a small quad gets proportional brackets rather than the cap", () => {
  const small: NormalizedQuad = {
    topLeft: { x: 0.4, y: 0.4 },
    topRight: { x: 0.6, y: 0.4 },
    bottomRight: { x: 0.6, y: 0.6 },
    bottomLeft: { x: 0.4, y: 0.6 },
  };
  const lengths = bracketLengths(cornerBracketPath(small, 0.12, viewBoxCap(0.05)));

  assert.equal(lengths.length, 8);
  for (const length of lengths) {
    // 12 % of a 0.2 edge, well under the 0.05 cap.
    assert.ok(Math.abs(length - 0.024) < 1e-9);
  }
});

test("bracket segments lie on the quad's own edges", () => {
  // A leaning quad — the whole point of brackets over static corner marks.
  const leaning: NormalizedQuad = {
    topLeft: { x: 0.2, y: 0.15 },
    topRight: { x: 0.9, y: 0.3 },
    bottomRight: { x: 0.82, y: 0.9 },
    bottomLeft: { x: 0.1, y: 0.75 },
  };
  const segments = bracketSegments(cornerBracketPath(leaning, 0.12, viewBoxCap(0.05)));
  const corners = cornerList(leaning);

  for (const [from, to] of segments) {
    const corner = corners.find(
      (point) => Math.hypot(point.x - from.x, point.y - from.y) < 1e-4,
    );
    assert.ok(corner !== undefined, "every segment starts on a corner");
    // The far end must sit on the edge between that corner and a neighbour:
    // corner→end and corner→neighbour point the same way.
    const onAnEdge = corners.some((neighbour) => {
      const edgeX = neighbour.x - from.x;
      const edgeY = neighbour.y - from.y;
      const armX = to.x - from.x;
      const armY = to.y - from.y;
      const edgeLength = Math.hypot(edgeX, edgeY);
      const armLength = Math.hypot(armX, armY);
      if (edgeLength === 0 || armLength === 0) return false;
      const cross = (edgeX * armY - edgeY * armX) / (edgeLength * armLength);
      const dot = (edgeX * armX + edgeY * armY) / (edgeLength * armLength);
      // The path is written to five decimals, so collinearity is checked to a
      // tolerance that rounding cannot break rather than to the bit.
      return Math.abs(cross) < 1e-3 && dot > 0 && armLength <= edgeLength;
    });
    assert.ok(onAnEdge, "every segment runs along one of the quad's edges");
  }
});

test("a degenerate quad draws nothing rather than a smear of dots", () => {
  const collapsed: NormalizedQuad = {
    topLeft: { x: 0.5, y: 0.5 },
    topRight: { x: 0.5, y: 0.5 },
    bottomRight: { x: 0.5, y: 0.5 },
    bottomLeft: { x: 0.5, y: 0.5 },
  };

  assert.equal(cornerBracketPath(collapsed, 0.12, viewBoxCap(0.05)), "");
  // A cap of zero is the same question from the other side.
  assert.equal(cornerBracketPath(BASE, 0.12, viewBoxCap(0)), "");
});

test("the cap holds in drawn pixels on a landscape frame", () => {
  // 640×360 is the frame the old normalization got wrong: a cap read against
  // the short side let a horizontal mark reach 28 × 640/360 ≈ 50 px.
  const path = cornerBracketPath(BASE, 0.12, {
    length: 28,
    width: 640,
    height: 360,
  });
  const drawn = drawnLengths(path, 640, 360);

  assert.equal(drawn.length, 8);
  for (const length of drawn) {
    // The path is written to five decimals, so the ceiling is checked to the
    // hundredth of a pixel that rounding can move it by, not to the bit.
    assert.ok(length <= 28.01, `segment drew ${length} px`);
    // Both axes bind on this quad, so every mark is the ceiling.
    assert.ok(Math.abs(length - 28) < 0.01);
  }
});

test("the cap holds in drawn pixels on a portrait frame", () => {
  const path = cornerBracketPath(BASE, 0.12, {
    length: 28,
    width: 360,
    height: 640,
  });
  const drawn = drawnLengths(path, 360, 640);

  assert.equal(drawn.length, 8);
  for (const length of drawn) {
    assert.ok(length <= 28.01, `segment drew ${length} px`);
    assert.ok(Math.abs(length - 28) < 0.01);
  }
});

test("a small quad on a stretched frame is still proportional, not capped", () => {
  const small: NormalizedQuad = {
    topLeft: { x: 0.45, y: 0.45 },
    topRight: { x: 0.55, y: 0.45 },
    bottomRight: { x: 0.55, y: 0.55 },
    bottomLeft: { x: 0.45, y: 0.55 },
  };
  const drawn = drawnLengths(
    cornerBracketPath(small, 0.12, { length: 28, width: 640, height: 360 }),
    640,
    360,
  );

  // 12 % of a 0.1 edge: 0.012 × 640 = 7.68 px across, 0.012 × 360 = 4.32 px down
  // — four of each, and neither anywhere near the 28 px ceiling.
  assert.deepEqual(
    drawn.map((length) => Number(length.toFixed(2))).sort((a, b) => a - b),
    [4.32, 4.32, 4.32, 4.32, 7.68, 7.68, 7.68, 7.68],
  );
});

test("an over-eager fraction still stops at half an edge", () => {
  // Past half, one corner's bracket would meet the next one's and the four
  // marks would read as a full outline.
  const lengths = bracketLengths(cornerBracketPath(BASE, 0.9, viewBoxCap(1)));

  for (const length of lengths) {
    assert.ok(length <= 0.84 / 2 + 1e-9);
  }
});

test("the whole-frame quad covers the whole frame", () => {
  assert.equal(normalizedCoverage(FULL_FRAME_QUAD), 1);
});

test("the whole-frame quad is y-down and wound clockwise from the top-left", () => {
  // The trap this guards: read as y-up, (0,0) is the BOTTOM-left and the same
  // four numbers describe a page flipped over — which the warp would apply
  // silently, since an upside-down quad is a perfectly valid one.
  assert.deepEqual(cornerList(FULL_FRAME_QUAD), [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]);
});

test("the whole-frame quad lands on the image's own corners in pixels", () => {
  // What "no crop" has to mean by the time scanic sees it: the four corners of
  // the canonical, in its own grid, on any aspect.
  assert.deepEqual(denormalizeQuad(FULL_FRAME_QUAD, 3000, 2250), {
    topLeft: { x: 0, y: 0 },
    topRight: { x: 3000, y: 0 },
    bottomRight: { x: 3000, y: 2250 },
    bottomLeft: { x: 0, y: 2250 },
  });
});
