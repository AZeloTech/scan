/**
 * The page the user would see after an Endireitar tap, for an engine root
 * with or without the text-deskew step (`src/lib/deskew.ts`, the F5
 * prototype's module), driven the way that prototype's glue drives it:
 *
 *   baseline₀ = scanic warp of the confirmed quad at 896 px
 *   plan      = deskew.planDeskew(baseline₀, quad, dims)   (θ, Q′, paper colours)
 *   run       = engine with Q′                             (host.runStage(canonical, Q′))
 *   final     = accepted ? surface : flat warp of Q′       (+ wedge fill in "paper" mode)
 *
 * A homography is fixed by four point pairs, so "warp Q′" is exactly "warp
 * the quad, then rotate about the centre": the step wraps the unchanged host
 * by handing it Q′. When the app grows its own restructured deskew glue this
 * module follows it; until then it reproduces the prototype's.
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
export async function runFinal(host, dk, mode, canonical, quad, id) {
  if (!dk || !mode) {
    const r = await host.runStage(canonical, quad, id);
    return { r, final: r.surface ?? host.flatPage(canonical, quad), quadUsed: quad, deskew: null };
  }
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
      mode, act: !!plan, reason: e.reason, deg: r3(e.deg), coarseDeg: e.coarseDeg, peakRatio: r3(e.peakRatio), lineCount: e.lineCount,
      components: e.components, graphicInkShare: r3(e.graphicInkShare), scale: plan ? r3(plan.scale) : null,
      estimateMs: r3(estimateMs), rebaselineMs: r3(rebaselineMs), fillMs: r3(fillMs), wedgePx,
      ...(plan?.paint ? { paint: plan.paint.map((b) => (b ? 1 : 0)).join("") } : {}),
      ...(e.halves ? { halves: e.halves.map(r3) } : {}),
    },
  };
}
