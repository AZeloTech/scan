/**
 * The page the user would see after an Endireitar tap (`runFinal`), with a
 * stand-in engine host and a stand-in deskew module: which quad the engine
 * runs on, which image is the final page, and when the wedge fill paints it.
 * The real engine is not needed to pin the derivation the verdicts judge.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runFinal } from "./straighten/deskew-step.mjs";
import { newImage } from "./straighten/imaging.mjs";

const QUAD = { topLeft: { x: 10, y: 10 }, topRight: { x: 110, y: 10 }, bottomRight: { x: 110, y: 150 }, bottomLeft: { x: 10, y: 150 } };
const ROTATED = { topLeft: { x: 12, y: 8 }, topRight: { x: 112, y: 12 }, bottomRight: { x: 108, y: 152 }, bottomLeft: { x: 8, y: 148 } };

function canvas() {
  const img = newImage(120, 160);
  img.data.fill(200);
  return img;
}

/** An engine that accepts or declines, and remembers the quads it was handed. */
function stubHost(accepted) {
  const calls = [];
  const flats = [];
  return {
    calls,
    flats,
    async runStage(_canonical, quad, id) {
      calls.push({ quad, id });
      return { accepted, surface: accepted ? Object.assign(newImage(100, 140), { tag: "surface" }) : null, reason: accepted ? "accepted" : "guard-boundary", code: accepted ? null : "#017", ms: 1, engineMs: 1, gateMs: 1 };
    },
    flatPage(_canonical, quad) {
      flats.push(quad);
      return Object.assign(newImage(100, 140), { tag: "flat", quad });
    },
  };
}

/** A deskew module that plans (or abstains) and counts its wedge fills. */
function stubDeskew(plan) {
  const fills = [];
  return {
    fills,
    planDeskew: () => ({ estimate: { reason: plan ? "ok" : "too-little-text", deg: plan ? 3 : NaN, coarseDeg: 3, peakRatio: 2, lineCount: 20, components: 300, graphicInkShare: 0 }, plan }),
    fillDeskewWedges(image) {
      fills.push(image);
      image.painted = true;
      return 42;
    },
  };
}

test("final page: without a deskew step it is the surface when accepted, the flat page of the quad when declined", async () => {
  const ok = stubHost(true);
  const a = await runFinal(ok, null, null, canvas(), QUAD, "s");
  assert.equal(a.final.tag, "surface");
  assert.equal(a.quadUsed, QUAD);
  assert.equal(a.deskew, null);
  const no = stubHost(false);
  const b = await runFinal(no, null, null, canvas(), QUAD, "s");
  assert.equal(b.final.tag, "flat");
  assert.equal(b.final.quad, QUAD);
});

test("final page: an abstaining deskew runs the engine on the confirmed quad and paints nothing", async () => {
  const host = stubHost(false);
  const dk = stubDeskew(null);
  const out = await runFinal(host, dk, "paper", canvas(), QUAD, "s");
  assert.equal(host.calls[0].quad, QUAD);
  assert.equal(out.final.quad, QUAD);
  assert.equal(out.deskew.act, false);
  assert.equal(dk.fills.length, 0);
});

test("final page: a deskewed decline is the flat page of the rotated quad, wedges painted in paper mode", async () => {
  const host = stubHost(false);
  const dk = stubDeskew({ quad: ROTATED, mode: "paper", scale: 1 });
  const out = await runFinal(host, dk, "paper", canvas(), QUAD, "s");
  assert.equal(host.calls[0].quad, ROTATED, "the engine runs on Q′");
  assert.equal(out.final.tag, "flat");
  assert.equal(out.final.quad, ROTATED);
  assert.equal(out.final.painted, true);
  assert.equal(out.deskew.act, true);
  assert.equal(out.deskew.wedgePx, 42);
});

test("final page: a deskewed accept is the engine's surface, painted, and the stage result shows the painted one", async () => {
  const host = stubHost(true);
  const dk = stubDeskew({ quad: ROTATED, mode: "paper", scale: 1 });
  const out = await runFinal(host, dk, "paper", canvas(), QUAD, "s");
  assert.equal(out.final.tag, "surface");
  assert.equal(out.final.painted, true);
  assert.equal(out.r.surface, out.final);
});

test("final page: crop mode rotates without painting", async () => {
  const host = stubHost(false);
  const dk = stubDeskew({ quad: ROTATED, mode: "crop", scale: 1.05 });
  const out = await runFinal(host, dk, "crop", canvas(), QUAD, "s");
  assert.equal(out.final.quad, ROTATED);
  assert.equal(dk.fills.length, 0);
  assert.equal(out.deskew.wedgePx, 0);
});

/* ── The app's restructured step (`planStraighten`) ─────────────────────── */

/** The host the step needs on top: the small copy and its baselines. */
function stubStraightenHost(accepted) {
  const host = stubHost(accepted);
  host.baselines = [];
  host.smallCopy = () => Object.assign(newImage(60, 80), { tag: "copy" });
  host.baselineOn = (_small, _canonical, quad) => {
    host.baselines.push(quad);
    return Object.assign(newImage(50, 70), { tag: "small", quad });
  };
  host.codeOf = (reason) => (reason === "curl-absent" ? "#050" : "#0??");
  host.bucketOf = () => "better-flat";
  return host;
}

/** A restructured deskew module: plans (rotation or not), says whether the engine runs, counts fills. */
function stubStraighten({ plan, runEngine, rejection = null }) {
  const fills = [];
  return {
    fills,
    async planStraighten(input) {
      if (plan) await input.renderSmall(plan.quad);
      return {
        estimate: { act: plan !== null || rejection !== null, reason: plan || rejection ? "act" : "negligible", deg: 3, coarseDeg: 3, peakRatio: 2, lineCount: 20, components: 300, graphicInkShare: 0, halves: [3, 3] },
        plan,
        judgement: rejection ? { ok: false, rejection, clippedShare: 0, residualDeg: 2, flat: { lineCount: 3, medianCurvature: 0 }, rotated: { lineCount: 3, medianCurvature: 0 } } : null,
        runEngine,
        ms: 5,
      };
    },
    fillDeskewWedges(image) {
      fills.push(image);
      image.painted = true;
      return 42;
    },
  };
}

const PLAN = { quad: ROTATED, mode: "paper", scale: 1, paint: [true, true, true, true], curl: { evidence: false, spread: 0, midOffset: 0, bow: 0, bowLines: 20, why: [] } };

test("final page (restructured): a level page with no curl is the rotated flat page — the engine is not asked", async () => {
  const host = stubStraightenHost(true);
  const dk = stubStraighten({ plan: PLAN, runEngine: false });
  const out = await runFinal(host, dk, "paper", canvas(), QUAD, "s", "auto");
  assert.equal(host.calls.length, 0, "no engine run");
  assert.equal(out.r.reason, "curl-absent");
  assert.equal(out.r.code, "#050");
  assert.equal(out.final.tag, "flat");
  assert.equal(out.final.quad, ROTATED);
  assert.equal(out.final.painted, true);
  assert.equal(out.deskew.act, true);
  assert.equal(host.baselines[0], QUAD, "B₀ is the confirmed outline's small page");
});

test("final page (restructured): with curl evidence the engine runs on the CONFIRMED quad; its surface carries no rotation", async () => {
  const host = stubStraightenHost(true);
  const dk = stubStraighten({ plan: { ...PLAN, curl: { ...PLAN.curl, evidence: true } }, runEngine: true });
  const out = await runFinal(host, dk, "paper", canvas(), QUAD, "s", "auto");
  assert.equal(host.calls[0].quad, QUAD);
  assert.equal(out.final.tag, "surface");
  assert.equal(out.final.painted, undefined, "nothing to paint on an unrotated surface");
  assert.equal(out.deskew.act, false, "the page shown is not rotated");
  assert.equal(out.deskew.planned, true);
});

test("final page (restructured): the engine declining leaves the rotation standing", async () => {
  const host = stubStraightenHost(false);
  const dk = stubStraighten({ plan: { ...PLAN, curl: { ...PLAN.curl, evidence: true } }, runEngine: true });
  const out = await runFinal(host, dk, "paper", canvas(), QUAD, "s", "auto");
  assert.equal(host.calls[0].quad, QUAD);
  assert.equal(out.final.quad, ROTATED);
  assert.equal(out.final.painted, true);
  assert.equal(out.deskew.act, true);
});

test("final page (restructured): a rotation the judge refused is no rotation, and says why", async () => {
  const host = stubStraightenHost(false);
  const dk = stubStraighten({ plan: null, runEngine: true, rejection: "not-level" });
  const out = await runFinal(host, dk, "paper", canvas(), QUAD, "s", "auto");
  assert.equal(host.calls[0].quad, QUAD);
  assert.equal(out.final.quad, QUAD);
  assert.equal(out.deskew.act, false);
  assert.equal(out.deskew.reason, "judge-not-level");
});

test("final page (restructured): the diagnostic curl gate forces the engine on, or off", async () => {
  const on = stubStraightenHost(false);
  await runFinal(on, stubStraighten({ plan: PLAN, runEngine: false }), "paper", canvas(), QUAD, "s", "always");
  assert.equal(on.calls.length, 1);
  const off = stubStraightenHost(true);
  const out = await runFinal(off, stubStraighten({ plan: { ...PLAN, curl: { ...PLAN.curl, evidence: true } }, runEngine: true }), "paper", canvas(), QUAD, "s", "never");
  assert.equal(off.calls.length, 0);
  assert.equal(out.final.quad, ROTATED);
  await assert.rejects(runFinal(off, stubStraighten({ plan: PLAN, runEngine: false }), "paper", canvas(), QUAD, "s", "sometimes"));
});
