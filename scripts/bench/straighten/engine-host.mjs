/**
 * Drives the REAL Endireitar engine the way the app does
 * (`src/lib/dewarp-stage.ts` :: `runDewarpStage`), minus the DOM:
 *
 *   canonical ─┬─ scale to 896 long edge ─ scanic-style homography warp ─→ baseline
 *              └─ quad → paddedCropBox(cropPadForMode) / outputDimsFromQuad /
 *                 renderKeyFor ─→ engine.runDewarp({ job, canonical, baseline })
 *
 * The engine is loaded from an engine root (this checkout by default, or any
 * other checkout or git worktree — `--engine-root`): its `src/lib/dewarp/*.ts`
 * through an `@/` alias hook rooted there, and the wasm named by *its*
 * `wasm-manifest.json` from *its* `assets/dewarp/`. The worker is replaced by
 * an in-thread stand-in that makes exactly the calls
 * `dewarp-classical.worker.ts` makes, so the engine code under test is byte
 * for byte the checkout's. Node only (TypeScript through Node's type
 * stripping); one engine root per process.
 */

import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bilinearDownscale, mapQuad, outputDims, warpQuad } from "./imaging.mjs";

/** dewarp-stage.ts :: BASELINE_SOURCE_LONG_EDGE */
export const BASELINE_SOURCE_LONG_EDGE = 896;

/**
 * The engine's hard timeout is the app's own (`HARD_TIMEOUT_MS`), capped at
 * 30 s: a page that takes longer on this machine at the run's fixed `--jobs`
 * counts as the timeout the app would show, the same way in every run.
 */
export const HARD_TIMEOUT_CAP_MS = 30_000;

/** scan-store.ts :: DEWARP_OUTCOMES (fallback copy; parsed from ENGINE_ROOT when possible). */
const OUTCOME_BUCKETS_FALLBACK = {
  "semantic-regression": "better-flat", "semantic-insufficient-evidence": "unverified",
  "ineligible-quad": "page", "grid-contract": "page", "guard-nonfinite": "page", "guard-bounds": "page",
  "guard-jacobian": "page", "guard-scale": "page", "guard-displacement": "page", "guard-boundary": "page",
  "classical-non-convergent": "page", "classical-insufficient-features": "page",
  "classical-degenerate-bounds": "page", "classical-aspect-outlier": "page",
  "model-unavailable": "download", unsupported: "transient", "worker-failed": "transient",
  timeout: "transient", "render-failed": "transient",
};

function parseOutcomeBuckets(root) {
  try {
    const src = readFileSync(path.join(root, "src/lib/scan-store.ts"), "utf8");
    const m = src.match(/const DEWARP_OUTCOMES[^{]*\{([\s\S]*?)\n\};/);
    if (!m) return OUTCOME_BUCKETS_FALLBACK;
    const out = {};
    for (const l of m[1].matchAll(/^\s*"?([a-z-]+)"?\s*:\s*"([a-z-]+)"/gm)) out[l[1]] = l[2];
    return Object.keys(out).length > 5 ? out : OUTCOME_BUCKETS_FALLBACK;
  } catch { return OUTCOME_BUCKETS_FALLBACK; }
}

let aliasRegistered = null;

/** The engine at `root`, ready to run pages: `{ meta, runStage, flatPage }`. */
export async function loadEngineHost(root) {
  root = path.resolve(root);
  if (aliasRegistered !== null && aliasRegistered !== root) throw new Error("one engine root per process");
  if (aliasRegistered === null) {
    const src = pathToFileURL(path.join(root, "src", "/")).href;
    registerHooks({
      resolve(specifier, context, next) {
        if (!specifier.startsWith("@/")) return next(specifier, context);
        return next(new URL(`${specifier.slice(2)}.ts`, src).href, context);
      },
    });
    aliasRegistered = root;
  }
  const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
  const idx = await mod("src/lib/dewarp/index.ts");
  const types = await mod("src/lib/dewarp/types.ts");
  const gridMod = await mod("src/lib/dewarp/grid.ts");
  const semantic = await mod("src/lib/dewarp/semantic.ts");
  const sampler = await mod("src/lib/dewarp/sampler.ts");
  const manifest = JSON.parse(readFileSync(path.join(root, "src/lib/dewarp/wasm-manifest.json"), "utf8"));
  const gluePath = path.join(root, "assets/dewarp", `${manifest.version}.js`);
  const wasmPath = path.join(root, "assets/dewarp", `${manifest.version}.wasm`);
  if (!existsSync(gluePath) || !existsSync(wasmPath)) throw new Error(`wasm assets missing under ${root}/assets/dewarp for ${manifest.version}`);
  const glue = await import(pathToFileURL(gluePath).href);
  const { memory } = await glue.default({ module_or_path: readFileSync(wasmPath) });
  const GW = gridMod.CLASSICAL_GRID_WIDTH, GH = gridMod.CLASSICAL_GRID_HEIGHT;

  // dewarpSupported() probes typeof Worker; the stand-in below is what runs.
  if (typeof globalThis.Worker !== "function") globalThis.Worker = function Worker() {};

  let engineMs = 0;
  let lastGridMsg = null;
  function spawnWorker() {
    let reply = null;
    return {
      post(req) {
        if (req.kind !== "infer") return;
        const t0 = performance.now();
        const input = req.input, len = input.width * input.height * 4;
        let msg;
        let handle = 0;
        try {
          const ptr = glue.dewarp_alloc_input(len);
          new Uint8Array(memory.buffer, ptr, len).set(input.data);
          handle = glue.dewarp(ptr, input.width, input.height, req.optsJson ?? idx.CLASSICAL_OPTS_JSON);
          const inferMs = performance.now() - t0;
          const statusJson = glue.dewarp_status_json(handle);
          const data = Float32Array.from(new Float32Array(memory.buffer, glue.dewarp_grid_ptr(handle), glue.dewarp_grid_len(handle)));
          msg = { kind: "grid", generation: req.generation, renderKey: req.renderKey, dims: [1, 2, GH, GW], type: "float32", data, initMs: 0, inferMs, statusJson };
        } catch (e) {
          msg = { kind: "failed", generation: req.generation, renderKey: req.renderKey, stage: "inferring", message: String(e) };
        } finally {
          if (handle !== 0) glue.dewarp_free_result(handle);
        }
        engineMs += performance.now() - t0;
        lastGridMsg = msg.kind === "grid" ? msg : null;
        setTimeout(() => reply?.(msg), 0);
      },
      terminate() {},
      onReply(h) { reply = h; },
      onCrash() {},
    };
  }
  const mode = "classical";
  const hardTimeoutMs = Math.min(Number(idx.HARD_TIMEOUT_MS) || HARD_TIMEOUT_CAP_MS, HARD_TIMEOUT_CAP_MS);
  const engine = idx.createEngine({ assets: {}, mode, hardTimeoutMs, spawnWorker, yieldToHost: async () => {} });
  const buckets = parseOutcomeBuckets(root);
  let generation = 0;

  const flatPage = (canonical, quad) => {
    const d = idx.outputDimsFromQuad(quad);
    return warpQuad(canonical, quad, d.width, d.height);
  };

  /** scaleSurface(source, 896): the small copy every A/B baseline is warped from. */
  const smallCopy = (canonical) => bilinearDownscale(canonical, BASELINE_SOURCE_LONG_EDGE);

  /** scanic warpToCanvas(small, corners): the small flat page of `quad`, from the copy. */
  function baselineOn(small, canonical, quad) {
    // Per axis, as the app's normalized corners are. An engine that exports
    // its pixel-centre rule (`quadOnScaledCopy`, F4) has the app put the
    // baseline's corners on the copy by it; older checkouts' app scales them
    // linearly (`denormalizeQuad` of the normalized corners).
    const kx = small.width / canonical.width, ky = small.height / canonical.height;
    const smallQuad = typeof idx.quadOnScaledCopy === "function"
      ? idx.quadOnScaledCopy(quad, idx.copyScale(canonical, small))
      : mapQuad(quad, (p) => ({ x: p.x * kx, y: p.y * ky }));
    const bd = outputDims(smallQuad);
    return warpQuad(small, smallQuad, bd.width, bd.height);
  }

  /**
   * One engine run on `quad`. `given` hands over the copy and the A/B
   * baseline the caller already rendered (the deskew step renders them once
   * and reuses them, as the app does); absent, they are rendered here.
   */
  async function runStage(canonical, quad, sourceId, given = null) {
    const t0 = performance.now();
    engineMs = 0;
    const small = given?.small ?? smallCopy(canonical);
    const baseline = given?.baseline ?? baselineOn(small, canonical, quad);

    const output = idx.outputDimsFromQuad(quad);
    const crop = idx.paddedCropBox(quad, canonical.width, canonical.height, idx.cropPadForMode(mode));
    generation += 1;
    const job = {
      generation,
      renderKey: idx.renderKeyFor({ sourceId, quad, padVersion: idx.CROP_PAD_VERSION, modelVersion: idx.activeModelVersion(mode) }),
      quad,
      canonicalWidth: canonical.width,
      canonicalHeight: canonical.height,
      crop,
      outputWidth: output.width,
      outputHeight: output.height,
    };
    // baselineSource: dewarp-stage.ts hands the engine the small copy the
    // baseline was warped from (F4). Engines that predate it ignore the field.
    const run = await engine.runDewarp({ job, canonical, baseline, baselineSource: small });
    // The engine's own A/B candidate, rendered the way that checkout renders it.
    const candidatePreview = (grid, pv) =>
      typeof semantic.renderSemanticCandidate === "function"
        ? semantic.renderSemanticCandidate({ canonical, baseline, baselineSource: small, grid, crop, outputWidth: output.width, outputHeight: output.height })
        : sampler.renderThroughGrid({ source: canonical, grid, crop, width: pv.width, height: pv.height });
    const ms = performance.now() - t0;
    const accepted = run.outcome.geometryMode !== "homography" && run.surface !== undefined;
    const reason = accepted ? null : (run.outcome.fallbackReason ?? "render-failed");
    const d = run.diagnostics ?? {};
    // For #001/#002: which clause of that checkout's semantic verdict fired,
    // recomputed from the same grid and baseline with its own measureSurface
    // and constants. The clause order mirrors semantic.ts when this was
    // written; a prototype that rewrites the verdict reads with care.
    let semanticWhy;
    if (reason?.startsWith("semantic-") && lastGridMsg) {
      try {
        const grid = gridMod.parseGridTensor(lastGridMsg, { width: GW, height: GH });
        const pv = sampler.fitLongEdge(output.width, output.height, semantic.SEMANTIC_LONG_EDGE);
        const cand = candidatePreview(grid, pv);
        const b = semantic.measureSurface(baseline), c = semantic.measureSurface(cand);
        const S = semantic, clauses = [];
        if (c.occupancy.blankBorderFraction - b.occupancy.blankBorderFraction > S.OCCUPANCY_BLANK_REGRESSION_DELTA) clauses.push("blank-border");
        if (b.occupancy.inkFraction - c.occupancy.inkFraction > S.OCCUPANCY_INK_LOSS_DELTA) clauses.push("ink-loss");
        if (c.occupancy.borderRepeatScore - b.occupancy.borderRepeatScore > S.BORDER_REPEAT_REGRESSION_DELTA) clauses.push("border-repeat");
        const evidence = Math.min(b.straightness.lineCount, c.straightness.lineCount);
        if (evidence < S.MIN_LINE_EVIDENCE) clauses.push(`no-line-evidence(${b.straightness.lineCount}/${c.straightness.lineCount})`);
        else {
          // F2 (tilt-aware A/B): the verdict compares bow + lean, and separately
          // refuses a candidate whose bow alone regressed. Mirrored when exported.
          const dep = typeof S.textDeparture === "function" ? S.textDeparture : (st) => st.medianCurvature;
          const base = dep(b.straightness), found = dep(c.straightness);
          const md = d.map?.stats?.meanDisplacementFraction ?? 0;
          const bent = typeof S.textDeparture === "function" && c.straightness.medianCurvature > Math.max(b.straightness.medianCurvature * S.CURVATURE_REGRESSION_RATIO, S.CURVATURE_NOISE_FLOOR);
          if (bent) clauses.push("bow-worse");
          else if (found > Math.max(base * S.CURVATURE_REGRESSION_RATIO, S.CURVATURE_NOISE_FLOOR)) clauses.push("curvature-worse");
          else {
            const ratio = md > S.LARGE_DEFORMATION_MEAN_FRACTION ? S.CURVATURE_IMPROVEMENT_RATIO : S.CURVATURE_NOT_WORSE_RATIO;
            if (found > Math.max(base * ratio, S.CURVATURE_NOISE_FLOOR)) clauses.push(md > S.LARGE_DEFORMATION_MEAN_FRACTION ? "curvature-not-improved(large-deformation)" : "curvature-not-within-1.15x");
          }
        }
        const pick = (m) => ({ blank: m.occupancy.blankBorderFraction, ink: m.occupancy.inkFraction, borderRepeat: m.occupancy.borderRepeatScore, lines: m.straightness.lineCount, medCurv: m.straightness.medianCurvature, ...(m.straightness.medianLean !== undefined ? { medLean: m.straightness.medianLean } : {}) });
        semanticWhy = { clauses, base: pick(b), cand: pick(c) };
      } catch (e) { semanticWhy = { clauses: [`attribution-failed: ${e}`], base: null, cand: null }; }
    }
    return {
      accepted,
      reason,
      code: reason === null ? null : types.dewarpReasonCode(reason),
      bucket: reason === null ? null : (buckets[reason] ?? "transient"),
      surface: accepted ? run.surface : null,
      ms,
      engineMs,
      gateMs: run.deviceGate?.totalMs ?? ms,
      job: { crop, outputWidth: output.width, outputHeight: output.height },
      ...(semanticWhy ? { semanticWhy } : {}),
      diagnostics: {
        classicalStatus: d.classicalStatus,
        map: d.map?.stats ? { ok: d.map.ok, failure: d.map.failure, ...d.map.stats } : undefined,
        verdict: d.verdict,
        eligibility: d.eligibility,
      },
    };
  }

  return {
    root,
    meta: { wasmVersion: manifest.version, appHardTimeoutMs: idx.HARD_TIMEOUT_MS, appDeviceBudgetMs: idx.DEVICE_GATE_BUDGET_MS, hardTimeoutMs },
    runStage,
    flatPage,
    smallCopy,
    baselineOn,
    codeOf: (reason) => types.dewarpReasonCode(reason),
    bucketOf: (reason) => buckets[reason] ?? "transient",
  };
}
