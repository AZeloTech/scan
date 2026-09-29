import assert from "node:assert/strict";
import test from "node:test";

import { scoreDetection } from "./metrics.mjs";
import {
  ABSOLUTE_LIMITS,
  absoluteViolations,
  compareSummaries,
  flipsAgainst,
  refineSummary,
  REGRESSION_TOLERANCE,
  RESULTS_SCHEMA,
  summarizeDetector,
  summarizeGroup,
} from "./report.mjs";

/**
 * `--compare` is a gate: it has to fail a run that got worse, pass one that
 * did not, and refuse to compare numbers that mean different things.
 */

const FRAME = { width: 1000, height: 1000 };
const PAGE = [
  [0.2, 0.2],
  [0.8, 0.2],
  [0.8, 0.8],
  [0.2, 0.8],
];
const DESK = [
  [0.02, 0.02],
  [0.98, 0.02],
  [0.98, 0.98],
  [0.02, 0.98],
];

/** A line of text 20 px inside the page's left edge — the emulator's content truth, in miniature. */
const CONTENT = [{ kind: "text", polygon: [[0.22, 0.3], [0.5, 0.3], [0.5, 0.33], [0.22, 0.33]] }];

function row(variant, seed, quad, truth = PAGE, { content = CONTENT, family = "F1", setting = null } = {}) {
  return {
    family,
    setting,
    seed,
    variant,
    det: { ok: quad !== null, accepted: quad !== null, quad, source: "ml", ms: 10 + seed },
    score: scoreDetection(quad, truth, FRAME, { content: truth === null ? null : content }),
  };
}

function results(rows, extra = {}) {
  return { schema: RESULTS_SCHEMA, suite: "detector", synthetic: true, summary: summarizeDetector(rows), ...extra };
}

test("the summary counts good, wrong, miss and false positives per family and variant", () => {
  const rows = [
    row("ml", 1, PAGE),
    row("ml", 2, DESK),
    row("ml", 3, null),
    row("ml", 4, PAGE, null),
    row("ml", 5, null, null),
  ];
  const s = summarizeDetector(rows).F1.ml;
  assert.equal(s.positives, 3);
  assert.equal(s.negatives, 2);
  assert.equal(s.good, 1);
  assert.equal(s.wrong, 1);
  assert.equal(s.miss, 1);
  assert.equal(s.falsePositives, 1);
  assert.equal(s.falsePositiveRate, 0.5);
  assert.deepEqual(summarizeDetector(rows).ALL.ml, s);
});

test("compare passes an unchanged run and fails a worse one", () => {
  const before = results([row("ml", 1, PAGE), row("ml", 2, PAGE)]);
  assert.deepEqual(compareSummaries(before, before).regressions, []);
  const worse = results([row("ml", 1, PAGE), row("ml", 2, DESK)]);
  const { regressions } = compareSummaries(before, worse);
  assert.ok(regressions.some((line) => line.startsWith("F1/ml: wrongRate")), regressions.join("\n"));
  // Getting better is never a regression.
  assert.deepEqual(compareSummaries(worse, before).regressions, []);
  assert.ok(REGRESSION_TOLERANCE.wrongRate < 0.5);
});

test("compare refuses to mix synthetic with real, or one suite with another", () => {
  const synthetic = results([row("ml", 1, PAGE)]);
  assert.throws(() => compareSummaries(synthetic, { ...synthetic, synthetic: false }), /synthetic run with a real one/);
  assert.throws(() => compareSummaries(synthetic, { ...synthetic, suite: "session" }), /detector run with a session run/);
});

test("a headline that loses its number is a regression, not a dash", () => {
  const session = (all) => ({ schema: RESULTS_SCHEMA, suite: "session", synthetic: true, summary: { "approach-hold": { all } } });
  const before = session({ captureWrongRate: 0, cornersAtConfirmMax: 0.012, falseLocksPerMinute: null });
  const after = session({ captureWrongRate: null, cornersAtConfirmMax: null, falseLocksPerMinute: null });
  const { regressions } = compareSummaries(before, after);
  assert.equal(regressions.length, 2, regressions.join("\n"));
  assert.ok(regressions.every((line) => line.includes("no longer measured")));
  // A session that stopped being run at all, with the same config, is one too.
  const gone = { schema: RESULTS_SCHEMA, suite: "session", synthetic: true, summary: {} };
  assert.deepEqual(compareSummaries(before, gone).regressions, ["approach-hold: measured before, missing now"]);
});

test("compare refuses runs over different samples and narrows to what both measured", () => {
  const config = { families: ["F1"], seeds: 10, frame: FRAME, cpu: 1, variants: ["ml"] };
  const f1 = results([row("ml", 1, PAGE)], { config });
  assert.throws(() => compareSummaries(f1, { ...f1, config: { ...config, seeds: 40 } }), /different samples: seeds 10 → 40/);
  assert.throws(() => compareSummaries(f1, { ...f1, config: { ...config, cpu: 4 } }), /cpu 1 → 4/);
  // Another family in the current run: F1 is compared, the pooled ALL row is not.
  const f2row = { ...row("ml", 1, DESK), family: "F2" };
  const wider = results([row("ml", 1, PAGE), f2row], { config: { ...config, families: ["F1", "F2"] } });
  const compared = compareSummaries(f1, wider);
  assert.deepEqual(compared.regressions, []);
  assert.ok(!compared.table.includes("| ALL |"), compared.table);
  assert.ok(compared.table.includes("| F1 | ml |"), compared.table);
  assert.equal(compared.notes.length, 1);
});

test("a baseline of another results schema is refused, not compared", () => {
  const current = results([row("ml", 1, PAGE)]);
  const { schema: _schema, ...old } = current;
  assert.throws(() => compareSummaries(old, current), /schema 1 baseline with a schema 2 run/);
  assert.throws(() => compareSummaries({ ...current, schema: 3 }, current), /schema 3 baseline/);
});

test("content clipping and severe crops are summarized — n/a where the truth has no content", () => {
  const bitten = [[0.225, 0.2], [0.8, 0.2], [0.8, 0.8], [0.225, 0.8]];
  const s = summarizeGroup([row("ml", 1, PAGE), row("ml", 2, bitten), row("ml", 3, DESK), row("ml", 4, null)]);
  assert.equal(s.wrongRate, 0.25);
  assert.equal(s.contentJudged, 3);
  assert.equal(s.contentClipped, 1, "the desk quad kept everything; the bitten one did not");
  assert.equal(s.contentClippedRate, 1 / 3);
  assert.equal(s.severe, 2);
  assert.equal(s.severeRate, 0.5);
  assert.equal(s.contentUnknown, 0);
  // A hand label knows where the paper is, not the print.
  const labelled = summarizeGroup([row("ml", 1, PAGE, PAGE, { content: null }), row("ml", 2, bitten, PAGE, { content: null })]);
  assert.equal(labelled.contentClippedRate, null);
  assert.equal(labelled.severeRate, null);
  assert.equal(labelled.contentUnknown, 2);
});

test("each setting is gated on its own, so a negative scene cannot hide in its family", () => {
  const negatives = (laptop) => [
    ...[1, 2, 3, 4].map((seed) => row("ml", seed, null, null, { family: "F6", setting: "empty-desk" })),
    ...[5, 6, 7, 8].map((seed) => row("ml", seed, seed <= 4 + laptop ? PAGE : null, null, { family: "F6", setting: "laptop" })),
  ];
  const before = results(negatives(0));
  assert.ok("F6/laptop" in before.summary && "F6/empty-desk" in before.summary);
  const after = results(negatives(1));
  const { regressions } = compareSummaries(before, after);
  assert.ok(regressions.some((line) => line.startsWith("F6/laptop/ml: falsePositiveRate")), regressions.join("\n"));
});

test("absolute limits hold whatever the baseline said, and unmeasured is not within them", () => {
  const session = (all) => ({ schema: RESULTS_SCHEMA, suite: "session", synthetic: true, summary: { "approach-hold": { all } } });
  const clean = { captureWrongRate: 0, missingCaptures: 0, confirmNeverOpened: 0, confirmOffImage: 0, unscoredCaptures: 0, missingData: 0 };
  assert.deepEqual(compareSummaries(session(clean), session(clean)).regressions, []);
  // A baseline that already lost a capture does not make losing one acceptable.
  const lost = session({ ...clean, missingCaptures: 1 });
  assert.deepEqual(compareSummaries(lost, lost).regressions, ["approach-hold/all: missingCaptures 1 > absolute limit 0"]);
  const unmeasured = session({ ...clean, missingData: null });
  assert.deepEqual(absoluteViolations(unmeasured), ["approach-hold/all: missingData has no value (absolute limit 0)"]);
  // Synthetic detector rows must carry their content truth.
  const blind = results([row("ml", 1, PAGE, PAGE, { content: null })]);
  assert.ok(absoluteViolations(blind).some((line) => line.includes("contentUnknown")));
  assert.equal(ABSOLUTE_LIMITS.detector.contentUnknown, 0);
});

test("flips pair a refining variant with its unrefined twin, scene by scene", () => {
  const row = (sceneId, variant, quad, truth = PAGE) => ({
    sceneId,
    family: "F1",
    seed: Number(sceneId.slice(1)),
    variant,
    det: { accepted: quad !== null, quad, source: "ml", refine: variant === "refined" ? { ms: 10, changed: true, sides: [{ mode: "local" }, { mode: "wide" }, { mode: "kept" }, { mode: "local" }] } : null },
    score: scoreDetection(quad, truth, FRAME),
  });
  const rows = [
    row("s1", "production", PAGE),
    row("s1", "refined", DESK), // right → wrong
    row("s2", "production", DESK),
    row("s2", "refined", PAGE), // wrong → right
    row("s3", "production", PAGE),
    row("s3", "refined", PAGE),
    row("s4", "production", null),
    row("s4", "refined", PAGE), // a miss that became right
  ];
  const flips = flipsAgainst(rows, "refined");
  assert.deepEqual(flips.goodToWrong.map((r) => r.sceneId), ["s1"]);
  assert.deepEqual(flips.wrongToGood.map((r) => r.sceneId).sort(), ["s2", "s4"]);
  const summary = refineSummary(rows.filter((r) => r.variant === "refined"));
  assert.equal(summary.refineRuns, 4);
  assert.equal(summary.refineChanged, 4);
  assert.deepEqual(summary.refineSides, { local: 8, wide: 4, kept: 4 });
  assert.equal(summary.refineOffImage, 0);
  const off = PAGE.map(([x, y], i) => (i === 0 ? [-0.01, y] : [x, y]));
  assert.equal(refineSummary([row("s5", "refined", off)]).refineOffImage, 1);
  assert.deepEqual(refineSummary(rows.filter((r) => r.variant === "production")), {});
});
