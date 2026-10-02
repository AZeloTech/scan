import assert from "node:assert/strict";
import test from "node:test";

import { hiddenReach, renderOcclusionSection, scoreOcclusion, scoreProvenance, summarizeOcclusion, summarizeProvenance } from "./suites/detector-occlusion.mjs";

/**
 * A 1000 × 1000 frame, the page the square 0.2–0.8, a sheet over its
 * top-left corner: the sheet's own corner on the page at (0.3, 0.35), the
 * rest of it out past the page's corner.
 */
const FRAME = { width: 1000, height: 1000 };
const PAGE = [
  [0.2, 0.2],
  [0.8, 0.2],
  [0.8, 0.8],
  [0.2, 0.8],
];
const SHEET = [
  [0.05, 0.05],
  [0.3, 0.05],
  [0.3, 0.35],
  [0.05, 0.35],
];
const GT = {
  frame: FRAME,
  quad: PAGE,
  primary: 0,
  pages: [{ corners: PAGE, inFrame: [true, true, true, true], visible: [false, true, true, true], occluded: [0] }],
  occluders: [{ layer: 2, kind: "sheet", polygon: SHEET }],
};
const DIAG = Math.hypot(1000, 1000);

test("the true quad: the covered corner is right and nothing of the sheet is in it", () => {
  const s = scoreOcclusion(PAGE, GT);
  assert.equal(s.mode, "true-corner");
  assert.equal(s.occludedCornerError, 0);
  assert.equal(s.occluderIncluded, false);
  assert.deepEqual(s.occludedCorners, [0]);
});

test("a corner on the sheet's own corner is the occluder's tip", () => {
  const s = scoreOcclusion([[0.3, 0.35], ...PAGE.slice(1)], GT);
  assert.equal(s.mode, "occluder-tip");
  assert.ok(Math.abs(s.occludedCornerError - Math.hypot(100, 150) / DIAG) < 1e-9);
  assert.equal(s.occluderIncluded, false);
});

test("a corner where the sheet's edge crosses the page's is the edge crossing", () => {
  // The sheet's right side crosses the page's top edge at (0.3, 0.2).
  const s = scoreOcclusion([[0.3, 0.2], ...PAGE.slice(1)], GT);
  assert.equal(s.mode, "edge-crossing");
});

test("the union of page and sheet includes the occluder", () => {
  const s = scoreOcclusion([[0.05, 0.05], ...PAGE.slice(1)], GT);
  assert.equal(s.mode, "on-occluder");
  assert.equal(s.occluderIncluded, true);
  assert.ok(s.occluderIncludedFraction > 0.05);
});

test("a gated answer is lost; a scene with nothing over its page is not scored", () => {
  assert.equal(scoreOcclusion(null, GT).mode, "lost");
  const bare = { ...GT, occluders: [], pages: [{ ...GT.pages[0], visible: [true, true, true, true], occluded: [] }] };
  assert.equal(scoreOcclusion(PAGE, bare), null);
  assert.equal(scoreOcclusion(null, { ...GT, quad: null, primary: null }), null);
});

test("the summary and its report section group by family and setting", () => {
  const row = (variant, quad) => ({
    family: "F8",
    setting: "sheet-over",
    variant,
    det: { source: "ml", accepted: quad !== null },
    score: { detected: quad !== null, wrongCrop: quad !== null && quad[0][0] !== 0.2, severe: false, contentClipped: false },
    occlusion: scoreOcclusion(quad, GT),
  });
  const rows = [row("refined", PAGE), row("refined", [[0.3, 0.35], ...PAGE.slice(1)]), row("production", null)];
  const summary = summarizeOcclusion(rows);
  assert.deepEqual(Object.keys(summary), ["F8", "F8/sheet-over"]);
  const refined = summary["F8/sheet-over"].refined;
  assert.equal(refined.scenes, 2);
  assert.equal(refined.modes["true-corner"], 1);
  assert.equal(refined.modes["occluder-tip"], 1);
  assert.equal(summary.F8.production.modes.lost, 1);
  assert.match(renderOcclusionSection(rows), /### F8\/sheet-over/);
  assert.equal(renderOcclusionSection([]), "");
});

test("provenance: a covered corner is judged by how far its edges are hidden, a tip-only cover is neither hit nor miss", () => {
  // The sheet hides 0.1 of the top edge and 0.15 of the left: 150 px of a 1414 px diagonal.
  assert.equal(Math.round(hiddenReach(GT, 0)), 150);
  const flagged = scoreProvenance(PAGE, GT, ["inferred", "seen", "seen", "seen"]);
  const missed = scoreProvenance(PAGE, GT, ["seen", "seen", "seen", "seen"]);
  assert.deepEqual(
    [summarizeProvenance([{ provenance: flagged }]).recall, summarizeProvenance([{ provenance: missed }]).recall],
    [1, 0],
  );
  // A clip's jaw over the very tip: 10 px of each edge (under 2 % of the diagonal).
  const tip = { ...GT, occluders: [{ layer: 2, kind: "binder-clip", polygon: [[0.19, 0.19], [0.21, 0.19], [0.21, 0.21], [0.19, 0.21]] }] };
  const s = summarizeProvenance([{ provenance: scoreProvenance(PAGE, tip, ["seen", "seen", "seen", "seen"]) }]);
  assert.equal(s.covered, 0);
  assert.equal(s.shallow, 1);
  assert.equal(s.recall, null);
  // A cover with no outline (an effect's) is judged as covered.
  const effect = { ...GT, occluders: [] };
  assert.equal(hiddenReach(effect, 0), null);
  assert.equal(summarizeProvenance([{ provenance: scoreProvenance(PAGE, effect, ["seen", "seen", "seen", "seen"]) }]).covered, 1);
  assert.ok(DIAG > 0);
});
