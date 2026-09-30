/**
 * The page the user would see after an Endireitar tap, for an engine root
 * with or without the text-deskew step (`src/lib/deskew.ts`).
 *
 * An engine root whose deskew module exports `planStraighten` (the app's own
 * restructured step) is driven exactly the way `dewarp-stage.ts` drives it:
 *
 *   copy      = the canonical scaled to 896 px, rendered once
 *   B₀        = warp of the confirmed quad Q from the copy (the A/B baseline)
 *   step      = deskew.planStraighten(B₀, Q, renderSmall = warp from the same copy)
 *               (θ, judged against B₀; the curl gate says whether the engine runs)
 *   run       = step.plan && !step.runEngine ? not run ("curl-absent")
 *             : engine on Q (baseline B₀), exactly as without the step
 *   final     = accepted ? surface (on Q, never rotated)
 *             : flat warp of Q′ when rotated (+ wedge fill), else of Q
 *
 * `SCAN_STRAIGHTEN_CURL_GATE=always|never` (diagnostic only, never the app's
 * behaviour) forces the engine to run, or not, on every rotated page — the
 * two runs a threshold for the gate is chosen from.
 *
 * An older deskew module (the F5 prototype's `planDeskew`) is driven the way
 * that prototype's glue drove it: Q′ replaces Q, the engine always runs.
 *
 * `mode` null: the plain pipeline — `final = accepted ? surface : flat`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bilinearDownscale, mapQuad, outputDims, warpQuad } from "./imaging.mjs";
import { BASELINE_SOURCE_LONG_EDGE } from "./engine-host.mjs";

export const DESKEW_MODES = ["auto", "off", "paper", "crop"];

/** Where an engine root keeps its deskew module, if it has one. */
export const deskewModule = (root) => path.join(root, "src/lib/deskew.ts");

/**
 * `--deskew`: `off`, `paper`, `crop`, or `auto` — `paper` (the approved wedge
 * policy) when the engine root has a deskew module, else `off`. Answers the
 * mode in force, or null for off.
 */
export function resolveDeskewMode(requested, root) {
  if (!DESKEW_MODES.includes(requested)) throw new Error(`--deskew ${requested}: expected ${DESKEW_MODES.join(", ")}`);
  const has = existsSync(deskewModule(root));
  if (requested === "auto") return has ? "paper" : null;
  if (requested === "off") return null;
  if (!has) throw new Error(`--deskew ${requested}: ${deskewModule(root)} does not exist`);
  return requested;
}

export async function loadDeskew(root) {
  return import(pathToFileURL(deskewModule(root)).href);
}

/** The engine's own A/B baseline (scaleSurface 896 + scanic warp), which the estimate reads. */
export function smallBaseline(canonical, quad) {
  const small = bilinearDownscale(canonical, BASELINE_SOURCE_LONG_EDGE);
  const kx = small.width / canonical.width, ky = small.height / canonical.height;
  const smallQuad = mapQuad(quad, (p) => ({ x: p.x * kx, y: p.y * ky }));
  const bd = outputDims(smallQuad);
  return warpQuad(small, smallQuad, bd.width, bd.height);
}

const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

/**
 * One tap: `{ r, final, quadUsed, deskew }` — the engine's stage result, the
 * page the user sees, the quad the engine ran on, and the deskew record
 * (null without the step).
 */
export const CURL_GATES = ["auto", "always", "never"];

/** The engine stage a page gets when the deskew made it level and found no curl: not run. */
function notRun(host, reason) {
  return {
    accepted: false,
    reason,
    code: host.codeOf?.(reason) ?? "#050",
    bucket: host.bucketOf?.(reason) ?? "better-flat",
    surface: null,
    ms: 0,
    engineMs: 0,
    gateMs: 0,
    engineRun: false,
    diagnostics: {},
  };
}

export async function runFinal(host, dk, mode, canonical, quad, id, curlGate = process.env.SCAN_STRAIGHTEN_CURL_GATE ?? "auto") {
  if (!dk || !mode) {
    const r = await host.runStage(canonical, quad, id);
    return { r, final: r.surface ?? host.flatPage(canonical, quad), quadUsed: quad, deskew: null };
  }
  if (typeof dk.planStraighten === "function") return runStraighten(host, dk, mode, canonical, quad, id, curlGate);
  const baseline0 = smallBaseline(canonical, quad);
  const flatDims = outputDims(quad);
  const t0 = performance.now();
  const decision = dk.planDeskew({
    flat: baseline0, quad, outputWidth: flatDims.width, outputHeight: flatDims.height,
    canonicalWidth: canonical.width, canonicalHeight: canonical.height, mode, now: () => performance.now(),
  });
  const estimateMs = performance.now() - t0;
  const e = decision.estimate;
  let plan = decision.plan;
  let rebaselineMs = 0;
  if (plan) {
    const t1 = performance.now();
    // host.runStage renders this same small page again as the engine's A/B
    // baseline; the app renders it once and uses it for both.
    const rebased = smallBaseline(canonical, plan.quad);
    if (typeof dk.decideWedgePaint === "function") plan = dk.decideWedgePaint(plan, baseline0, rebased);
    rebaselineMs = performance.now() - t1;
  }
  const quadUsed = plan ? plan.quad : quad;
  const r = await host.runStage(canonical, quadUsed, id);
  const final = r.surface ?? host.flatPage(canonical, quadUsed);
  let fillMs = 0, wedgePx = 0;
  if (plan && plan.mode === "paper") {
    const t2 = performance.now();
    wedgePx = dk.fillDeskewWedges(final, plan);
    fillMs = performance.now() - t2;
  }
  if (r.surface) r.surface = final; // accepted: what is shown is the filled surface
  return {
    r, final, quadUsed,
    deskew: {
      // `act`: the page the user sees carries the rotation.
      mode, act: !!plan, reason: e.reason, deg: r3(e.deg), coarseDeg: e.coarseDeg, peakRatio: r3(e.peakRatio), lineCount: e.lineCount,
      components: e.components, graphicInkShare: r3(e.graphicInkShare), scale: plan ? r3(plan.scale) : null,
      estimateMs: r3(estimateMs), rebaselineMs: r3(rebaselineMs), fillMs: r3(fillMs), wedgePx,
      ...(plan?.paint ? { paint: plan.paint.map((b) => (b ? 1 : 0)).join("") } : {}),
      ...(e.halves ? { halves: e.halves.map(r3) } : {}),
    },
  };
}

/** The app's restructured step (`planStraighten`), driven as `dewarp-stage.ts` drives it. */
async function runStraighten(host, dk, mode, canonical, quad, id, curlGate) {
  if (!CURL_GATES.includes(curlGate)) throw new Error(`SCAN_STRAIGHTEN_CURL_GATE=${curlGate}: expected ${CURL_GATES.join(", ")}`);
  const t0 = performance.now();
  const small = host.smallCopy(canonical);
  const baseline0 = host.baselineOn(small, canonical, quad);
  const copyMs = performance.now() - t0;
  const step = await dk.planStraighten({
    flat: baseline0,
    quad,
    canonicalWidth: canonical.width,
    canonicalHeight: canonical.height,
    mode,
    renderSmall: async (q) => host.baselineOn(small, canonical, q),
    now: () => performance.now(),
  });
  const plan = step.plan;
  let runEngine = step.runEngine;
  if (plan && curlGate === "always") runEngine = true;
  if (plan && curlGate === "never") runEngine = false;
  const r = runEngine
    ? await host.runStage(canonical, quad, id, { small, baseline: baseline0 })
    : notRun(host, "curl-absent");
  if (runEngine) r.engineRun = true;
  // An engine surface is on Q and carries no rotation; the rotation is the flat path's.
  const rotated = plan !== null && !r.surface;
  const quadUsed = rotated ? plan.quad : quad;
  const final = r.surface ?? host.flatPage(canonical, quadUsed);
  let fillMs = 0, wedgePx = 0, fillStep = null;
  if (rotated && plan.mode === "paper") {
    const unfilled = new Uint8ClampedArray(final.data);
    const t2 = performance.now();
    wedgePx = dk.fillDeskewWedges(final, plan);
    fillMs = performance.now() - t2;
    if (wedgePx > 0) fillStep = boundaryStep(final, unfilled);
  }
  if (r.surface) r.surface = final; // accepted: what is shown is the filled surface
  const e = step.estimate;
  const j = step.judgement;
  const curl = plan?.curl;
  return {
    r, final, quadUsed,
    deskew: {
      // `act`: the page the user sees carries the rotation.
      mode, act: rotated, planned: !!plan,
      reason: e.act && !plan ? (j && !j.ok ? `judge-${j.rejection}` : "render-failed") : plan && !rotated ? "engine-accepted" : e.reason,
      deg: r3(e.deg), coarseDeg: e.coarseDeg, peakRatio: r3(e.peakRatio), lineCount: e.lineCount,
      components: e.components, graphicInkShare: r3(e.graphicInkShare), scale: plan ? r3(plan.scale) : null,
      // The whole step (copy + B₀ + estimate + B′ + judge) is what the device waits for.
      estimateMs: r3(copyMs + step.ms), rebaselineMs: 0, fillMs: r3(fillMs), wedgePx,
      ...(fillStep ? { fillStep } : {}),
      runEngine, curlGate,
      ...(plan?.paint ? { paint: plan.paint.map((b) => (b ? 1 : 0)).join("") } : {}),
      ...(e.halves ? { halves: e.halves.map(r3) } : {}),
      ...(e.orphanDeg !== undefined ? { orphanDeg: r3(e.orphanDeg) } : {}),
      ...(e.rulesDeg !== undefined ? { rulesDeg: r3(e.rulesDeg) } : {}),
      ...(j ? { judge: { ok: j.ok, rejection: j.rejection, clipped: r3(j.clippedShare), residual: r3(j.residualDeg), flatLines: j.flat.lineCount, flatBow: r3(j.flat.medianCurvature * 1000) / 1000, lines: j.rotated.lineCount, bow: r3(j.rotated.medianCurvature * 1000) / 1000 } } : {}),
      ...(curl ? { curl: { evidence: curl.evidence, spread: r3(curl.spread), midOffset: r3(curl.midOffset), bow: r3(curl.bow * 1000) / 1000, bowLines: curl.bowLines, why: curl.why } } : {}),
      // Print already level: the flat page's own curl evidence (the card's "nothing").
      ...(step.level ? { level: { evidence: step.level.evidence, bow: r3(step.level.bow * 1000) / 1000, midOffset: r3(step.level.midOffset), why: step.level.why } } : {}),
    },
  };
}

/**
 * The seam as a viewer meets it: fill against the real paper right across the
 * fill's edge. For painted pixels (sampled every 3 px) within 3 px of real
 * pixels toward the page centre: fill luminance minus the 60th-percentile
 * luminance of the real pixels 2–14 px further in. Answers
 * `{ n, p10, p50, p90 }` in grey levels (signed: + = fill brighter), or null.
 * The block seam metric (`measure.mjs :: paintCheck`) compares against paper
 * up to two blocks away, which on a steeply lit sheet is not the paper beside
 * the fill; this is.
 */
export function boundaryStep(img, unfilled) {
  const { width: W, height: H, data } = img;
  const lum = (d, o) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  const same = (o) => data[o] === unfilled[o] && data[o + 1] === unfilled[o + 1] && data[o + 2] === unfilled[o + 2];
  const cx = W / 2, cy = H / 2, steps = [];
  for (let y = 2; y < H - 2; y += 3) for (let x = 2; x < W - 2; x += 3) {
    const o = (y * W + x) * 4;
    if (same(o)) continue;
    const dx = cx - x, dy = cy - y, n = Math.hypot(dx, dy) || 1, ux = dx / n, uy = dy / n;
    let edge = -1;
    for (let t = 1; t <= 3; t++) {
      const xx = Math.round(x + ux * t), yy = Math.round(y + uy * t);
      if (same((yy * W + xx) * 4)) { edge = t; break; }
    }
    if (edge < 0) continue;
    const inside = [];
    for (let t = edge + 2; t < edge + 14; t++) {
      const xx = Math.round(x + ux * t), yy = Math.round(y + uy * t);
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      inside.push(lum(unfilled, (yy * W + xx) * 4));
    }
    if (inside.length === 0) continue;
    inside.sort((a, b) => a - b);
    steps.push(lum(data, o) - inside[Math.floor(0.6 * (inside.length - 1))]);
  }
  if (steps.length === 0) return null;
  steps.sort((a, b) => a - b);
  const q = (f) => r3(steps[Math.floor(f * (steps.length - 1))]);
  return { n: steps.length, p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}
