/**
 * The straighten suite's scoring: one verdict per scene over one
 * denominator, unmeasurable pages never counted as fixed, and `--compare`'s
 * per-scene gate. Pure records in; no engine.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { checkComparable, compareSummaries, RESULTS_SCHEMA } from "./report.mjs";
import { cardHistogram, cardOf, flaggedScenes, sceneRegressions, summarize, summarizeRun, verdict } from "./straighten/score.mjs";

const page = (tiltDeg, { bowFrac = 0.001, borderDarkFrac = 0 } = {}) => ({
  tiltDeg, tiltConfidence: 2, bowFrac, bowFracMax: bowFrac, curvBands: 6, ink: 20_000, inkFrac: 0.1, inkAbs: 0.05,
  band: [0, 0, 0, 0], bbox: [0.1, 0.1, 0.9, 0.9], borderDarkFrac,
});
const declined = { accepted: false, reason: "guard-boundary", code: "#017", bucket: "page" };
const acceptedOutcome = { accepted: true, reason: null, code: null, bucket: null };
const deskewed = (deg) => ({ mode: "paper", act: true, reason: "act", deg });
const clean = { clipped: false, inkRatio: 1 };

/** A tilted page (4°) that the engine declined and nothing else touched. */
const rec = (over = {}) => ({
  id: over.id ?? "tilt/x/correct/t4/p0/none",
  suite: "synthetic",
  axes: { family: "tilt", quadMode: "correct" },
  truth: { shouldAct: true, tiltDeg: 4, curl: "none", flatAndStraight: false },
  outcome: declined,
  deskew: null,
  timing: { stageMs: 1000, engineMs: 900, gateMs: 1000, deskewMs: 0 },
  flat: page(4),
  final: null,
  clip: null,
  paint: null,
  ...over,
});

test("verdict: a page nobody touched is a no-op, graded on the flat page", () => {
  const v = verdict(rec());
  assert.equal(v.cls, "noop");
  assert.equal(v.acted, false);
  assert.equal(v.residualTilt, 4);
});

test("verdict: a deskewed decline acted — complete when the tilt is gone and nothing was lost", () => {
  const v = verdict(rec({ deskew: deskewed(4), final: page(0.05), clip: clean }));
  assert.equal(v.cls, "complete");
  assert.equal(v.deskewed, true);
});

test("verdict: a finished page more tilted than the flat page is harm", () => {
  const v = verdict(rec({ truth: { shouldAct: false, tiltDeg: 0, curl: "none", flatAndStraight: true }, flat: page(0), deskew: deskewed(1.2), final: page(-1.2), clip: clean }));
  assert.equal(v.cls, "harm");
  assert.match(v.harmWhy[0], /tilt/);
});

test("verdict: a NaN tilt on the finished page is unverified, never a fix", () => {
  const v = verdict(rec({ deskew: deskewed(4), final: page(NaN), clip: clean }));
  assert.equal(v.cls, "unverified");
  assert.match(v.unverifiedWhy[0], /tilt unmeasured/);
});

test("verdict: NaN survives a JSON round trip as unmeasured (null is not 0°)", () => {
  const r = JSON.parse(JSON.stringify(rec({ deskew: deskewed(4), final: page(NaN), clip: clean })));
  assert.equal(r.final.tiltDeg, null);
  assert.equal(verdict(r).cls, "unverified");
});

test("verdict: an accepted surface with an unmeasurable bow is unverified; a deskew-only page needs no bow check", () => {
  const accepted = verdict(rec({ outcome: acceptedOutcome, final: page(0.1, { bowFrac: NaN }), clip: clean }));
  assert.equal(accepted.cls, "unverified");
  // A rotation cannot bend lines: a bow change on a deskew-only page is estimator noise, not harm.
  const rotated = verdict(rec({ deskew: deskewed(4), final: page(0.1, { bowFrac: 0.01 }), clip: clean }));
  assert.equal(rotated.cls, "complete");
});

test("verdict: an engine surface that bends the lines more is harm", () => {
  const v = verdict(rec({ outcome: acceptedOutcome, final: page(0.1, { bowFrac: 0.006 }), clip: clean }));
  assert.equal(v.cls, "harm");
  assert.match(v.harmWhy[0], /bow/);
});

test("verdict: lost print is harm; an unmeasurable clip check is unverified", () => {
  assert.equal(verdict(rec({ deskew: deskewed(4), final: page(0), clip: { clipped: true, inkRatio: 0.8, why: "ink 80% of flat" } })).cls, "harm");
  assert.equal(verdict(rec({ deskew: deskewed(4), final: page(0), clip: { clipped: null, inkRatio: NaN, why: "too little print" } })).cls, "unverified");
});

test("verdict: background brought into a straight page is harm; into a tilted one, the price of straightening", () => {
  const straight = rec({ truth: { shouldAct: true, tiltDeg: 0, curl: "small", flatAndStraight: false }, flat: page(0, { bowFrac: 0.004 }), outcome: acceptedOutcome, final: page(0, { bowFrac: 0.001, borderDarkFrac: 0.2 }), clip: clean });
  assert.equal(verdict(straight).cls, "harm");
  const tilted = rec({ outcome: acceptedOutcome, final: page(0.1, { borderDarkFrac: 0.2 }), clip: clean });
  assert.equal(verdict(tilted).cls, "complete");
  assert.equal(verdict(tilted).darkWedge, true);
});

test("verdict: a curl page straightened but still bowed is partial", () => {
  const curl = rec({ truth: { shouldAct: true, tiltDeg: 3, curl: "large", flatAndStraight: false }, flat: page(3, { bowFrac: 0.01 }) });
  assert.equal(verdict({ ...curl, deskew: deskewed(3), final: page(0, { bowFrac: 0.01 }), clip: clean }).cls, "partial");
  assert.equal(verdict({ ...curl, outcome: acceptedOutcome, final: page(0, { bowFrac: 0.004 }), clip: clean }).cls, "complete");
});

test("summary: the five classes partition the should-act pages, with counts beside rates", () => {
  const rows = [
    rec({ id: "a" }),
    rec({ id: "b", deskew: deskewed(4), final: page(0), clip: clean }),
    rec({ id: "c", deskew: deskewed(4), final: page(2), clip: clean }),
    rec({ id: "d", deskew: deskewed(4), final: page(NaN), clip: clean }),
    rec({ id: "e", deskew: deskewed(4), final: page(5), clip: clean }),
    rec({ id: "f", truth: { shouldAct: false, tiltDeg: 0, curl: "none", flatAndStraight: true }, flat: page(0) }),
    { id: "g", suite: "synthetic", axes: { family: "tilt" }, error: "boom" },
  ].map((r) => (r.error ? r : { ...r, verdict: verdict(r) }));
  const s = summarize(rows);
  assert.equal(s.shouldAct, 5);
  assert.equal(s.noop + s.partial + s.complete + s.harm + s.unverified, s.shouldAct);
  assert.deepEqual([s.noop, s.partial, s.complete, s.harm, s.unverified], [1, 1, 1, 1, 1]);
  assert.equal(s.completeRate, 0.2);
  assert.equal(s.unfixedRate, 0.8);
  assert.equal(s.errors, 1);
  assert.equal(s.flatHarms, 0);
  assert.equal(s.trueNoopRate, 1);
  assert.equal(s.residTiltUnmeasured, 1);
  const byGroup = summarizeRun(rows);
  assert.ok(byGroup.ALL.final && byGroup.tilt.final && byGroup["tilt/correct"].final);
});

const results = (rows, config = {}) => ({
  schema: RESULTS_SCHEMA,
  suite: "straighten",
  synthetic: true,
  config: { profile: "full", only: null, sceneHash: "abc", scene: { noise: true, blurSigma: 0.8 }, jobs: 8, timeoutCapMs: 30_000, ...config },
  summary: summarizeRun(rows),
  rows,
});
const scored = (r) => ({ ...r, verdict: verdict(r) });

test("compare: a lost fix and a new harm fail the run by scene, whatever the totals", () => {
  const before = [
    scored(rec({ id: "fixed", deskew: deskewed(4), final: page(0), clip: clean })),
    scored(rec({ id: "untouched" })),
  ];
  const after = [
    scored(rec({ id: "fixed" })),
    scored(rec({ id: "untouched", deskew: deskewed(4), final: page(6), clip: clean })),
  ];
  const { lostFixes, newHarms, missing } = sceneRegressions(before, after);
  assert.deepEqual(lostFixes.map((s) => s.id), ["fixed"]);
  assert.deepEqual(newHarms.map((s) => s.id), ["untouched"]);
  assert.deepEqual(missing, []);
  const { regressions } = compareSummaries(results(before), results(after));
  assert.ok(regressions.some((line) => line.startsWith("scene fixed: lost fix")), regressions.join("\n"));
  assert.ok(regressions.some((line) => line.startsWith("scene untouched: new harm")), regressions.join("\n"));
  assert.ok(regressions.some((line) => line.includes("harmCount")), regressions.join("\n"));
});

test("compare: the same run against itself passes", () => {
  const rows = [scored(rec({ id: "fixed", deskew: deskewed(4), final: page(0), clip: clean }))];
  assert.deepEqual(compareSummaries(results(rows), results(rows)).regressions, []);
});

test("compare: runs over another scene set, job count or timeout are refused", () => {
  const rows = [scored(rec())];
  assert.throws(() => checkComparable(results(rows), results(rows, { sceneHash: "other" })), /sceneHash/);
  assert.throws(() => checkComparable(results(rows), results(rows, { jobs: 4 })), /jobs/);
  assert.throws(() => checkComparable(results(rows), results(rows, { profile: "quick" })), /profile/);
});

test("sheets: harms, unverified pages, lost fixes and new acts are flagged", () => {
  const before = [scored(rec({ id: "a" })), scored(rec({ id: "b", deskew: deskewed(4), final: page(0), clip: clean }))];
  const after = [
    scored(rec({ id: "a", deskew: deskewed(4), final: page(0), clip: clean })),
    scored(rec({ id: "b" })),
    scored(rec({ id: "c", deskew: deskewed(4), final: page(NaN), clip: clean })),
  ];
  const flags = flaggedScenes(after, before);
  assert.deepEqual(flags.get("a"), ["new act"]);
  assert.deepEqual(flags.get("b"), ["lost fix"]);
  assert.deepEqual(flags.get("c"), ["unverified"]);
});

test("cardOf: the card the page view would show, rebuilt from the record as the store builds it", () => {
  const level = (evidence) => ({ mode: "paper", act: false, planned: false, reason: "negligible", deg: 0, level: { evidence, why: evidence ? ["bow"] : [] } });
  const regression = { accepted: false, reason: "semantic-regression", code: "#001", bucket: "declined" };
  const timeout = { accepted: false, reason: "timeout", code: "#042", bucket: "transient" };
  const curlAbsent = { accepted: false, reason: "curl-absent", code: "#050", bucket: "nothing" };
  assert.equal(cardOf(rec({ outcome: acceptedOutcome })), "curl");
  assert.equal(cardOf(rec({ outcome: acceptedOutcome, deskew: level(false) })), "none", "no curl claimed over a page measured flat");
  assert.equal(cardOf(rec({ outcome: acceptedOutcome, deskew: level(true) })), "curl");
  assert.equal(cardOf(rec({ outcome: acceptedOutcome, deskew: { ...deskewed(3), act: false, planned: true } })), "both");
  assert.equal(cardOf(rec({ outcome: curlAbsent, deskew: deskewed(3) })), "tilt");
  assert.equal(cardOf(rec({ deskew: deskewed(3) })), "tilt-only");
  assert.equal(cardOf(rec({ outcome: regression, deskew: level(false) })), "nothing");
  assert.equal(cardOf(rec({ outcome: regression, deskew: level(true) })), "declined", "a curl on the level page is not 'flat'");
  assert.equal(cardOf(rec({ outcome: regression })), "declined");
  assert.equal(cardOf(rec({ outcome: timeout, deskew: level(false) })), "transient", "a retry is still the thing to say");
  assert.equal(cardOf(rec()), "page");
  // Results written before the split still read.
  assert.equal(cardOf(rec({ outcome: { ...regression, bucket: "better-flat" } })), "declined");
  assert.equal(cardOf({ id: "x", error: "boom" }), null);
});

test("cardHistogram: a 'nothing' card on a should-act page is counted where it can be seen", () => {
  const regression = { accepted: false, reason: "semantic-regression", code: "#001", bucket: "declined" };
  const flatDeskew = { mode: "paper", act: false, planned: false, reason: "negligible", deg: 0, level: { evidence: false, why: [] } };
  const rows = [
    rec({ id: "a", outcome: regression, deskew: flatDeskew }),
    rec({ id: "b", outcome: regression, deskew: flatDeskew, truth: { shouldAct: false, tiltDeg: 0, curl: "none", flatAndStraight: true }, flat: page(0) }),
  ].map((r) => ({ ...r, verdict: verdict(r) }));
  const [nothing] = cardHistogram(rows);
  assert.equal(nothing.key, "nothing");
  assert.equal(nothing.n, 2);
  assert.equal(nothing.noop, 1, "the should-act page it was said over");
  assert.equal(nothing.nothingToDo, 1);
});
