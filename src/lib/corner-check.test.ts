import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_SEEN,
  cornerCheckOf,
  hasInferred,
  hasUnknown,
  isUncertain,
  provenanceByNearest,
  provenanceDiagnostic,
  type CornerCheck,
} from "./corner-check.ts";
import type { NormalizedQuad } from "./quad.ts";
import type { CornerReport } from "./refine.ts";

const QUAD: NormalizedQuad = {
  topLeft: { x: 0.2, y: 0.1 },
  topRight: { x: 0.8, y: 0.12 },
  bottomRight: { x: 0.82, y: 0.9 },
  bottomLeft: { x: 0.18, y: 0.88 },
};

const report = (provenance: CornerReport["provenance"]): CornerReport => ({ provenance, confidence: provenance === "seen" ? 1 : 0.7, runs: [0.9, 0.8] });

test("a refinement's corner reports become a check keyed like its quad (TL, TR, BR, BL)", () => {
  const check = cornerCheckOf({
    corners: [report("inferred"), report("seen"), report("seen"), report("unknown")],
    occlusion: { suspected: true, separate: false },
  });
  assert.deepEqual(check.corners, { topLeft: "inferred", topRight: "seen", bottomRight: "seen", bottomLeft: "unknown" });
  assert.equal(check.separate, false);
});

test("uncertain: any corner not seen, or another sheet over the page — what holds auto-capture", () => {
  assert.equal(isUncertain(ALL_SEEN), false);
  assert.equal(isUncertain(null), false);
  assert.equal(isUncertain(undefined), false);
  const inferred: CornerCheck = { corners: { ...ALL_SEEN.corners, topLeft: "inferred" }, separate: false };
  const unknown: CornerCheck = { corners: { ...ALL_SEEN.corners, bottomRight: "unknown" }, separate: false };
  const separate: CornerCheck = { corners: ALL_SEEN.corners, separate: true };
  assert.equal(isUncertain(inferred), true);
  assert.equal(isUncertain(unknown), true);
  assert.equal(isUncertain(separate), true);
  assert.equal(hasInferred(inferred), true);
  assert.equal(hasUnknown(inferred), false);
  assert.equal(hasUnknown(unknown), true);
  assert.equal(hasInferred(separate), false);
});

test("the diagnostics carry one enum per corner, in an object (the stream drops arrays) — metadata only", () => {
  const check: CornerCheck = { corners: { topLeft: "inferred", topRight: "seen", bottomRight: "unknown", bottomLeft: "seen" }, separate: false };
  assert.deepEqual(provenanceDiagnostic(check), { tl: "inferred", tr: "seen", br: "unknown", bl: "seen" });
  assert.equal(provenanceDiagnostic(null), null);
  for (const value of Object.values(provenanceDiagnostic(check)!)) assert.ok(["seen", "inferred", "unknown"].includes(value));
});

test("a corner editor's handles take the provenance of the nearest seed corner, whatever order it hands them back in", () => {
  const check: CornerCheck = { corners: { topLeft: "inferred", topRight: "seen", bottomRight: "seen", bottomLeft: "seen" }, separate: false };
  // The editor named its handles from another starting corner, and nudged them a little.
  const handles = {
    topLeft: { x: 0.79, y: 0.13 },
    topRight: { x: 0.81, y: 0.89 },
    bottomRight: { x: 0.19, y: 0.87 },
    bottomLeft: { x: 0.21, y: 0.11 },
  };
  assert.deepEqual(provenanceByNearest(check, QUAD, handles), {
    topLeft: "seen",
    topRight: "seen",
    bottomRight: "seen",
    bottomLeft: "inferred",
  });
});
