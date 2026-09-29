/**
 * The emulator's own check: is the ground truth where the renderer put the
 * page, and what does a scene cost to render?
 *
 * Every scene is re-rendered stripped to geometry (white pages on black, no
 * optics, no sensor — `calibrationParams`) and compared with its ground truth:
 * rendered area against the projected polygon's, rendered centroid against the
 * polygon's, and the sub-pixel position of the 50 % crossing across every page
 * edge. The first frames of each family are also saved, full size, for a human
 * to look at.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mean, percentile } from "../metrics.mjs";

/** Frames per family kept at full size for eyeballing. */
const FRAMES_KEPT = 3;

/** Beyond these the renderer and the ground truth disagree, and the run fails. */
export const EMULATOR_TOLERANCE = { areaErrorPct: 0.05, centroidOffsetPx: 0.1, edgeOffsetPx: 0.25 };

function render(results) {
  const out = [];
  out.push("# Detection bench — emulator self-check (SYNTHETIC)");
  out.push("");
  out.push(`- run: ${results.createdAt} · commit ${results.git.commit}${results.git.dirty ? " (dirty)" : ""}`);
  out.push(`- WebGL: ${results.environment.renderer}`);
  out.push(
    `- tolerance: area ${EMULATOR_TOLERANCE.areaErrorPct} %, centroid ${EMULATOR_TOLERANCE.centroidOffsetPx} px, ` +
      `edge crossing ${EMULATOR_TOLERANCE.edgeOffsetPx} px`,
  );
  out.push("");
  out.push("| family | scenes | area error max (%) | centroid offset max (px) | edge offset mean / max (px) | render ms p50 / p95 | verdict |");
  out.push("|---|---:|---:|---:|---:|---:|---|");
  for (const [family, s] of Object.entries(results.summary)) {
    out.push(
      `| ${family} | ${s.scenes} | ${s.areaErrorMaxPct.toFixed(5)} | ${s.centroidOffsetMaxPx.toFixed(4)} | ` +
        `${s.edgeOffsetMeanPx.toFixed(3)} / ${s.edgeOffsetMaxPx.toFixed(3)} | ${s.renderP50.toFixed(0)} / ${s.renderP95.toFixed(0)} | ${s.note ?? (s.ok ? "ok" : "**FAIL**")} |`,
    );
  }
  out.push("");
  out.push(`Frames: ${results.frames.map((f) => `[${f}](${f})`).join(" · ")}`);
  return out.join("\n");
}

export async function runEmulatorSuite({ page, options, outDir, log }) {
  const rows = [];
  const frames = [];
  mkdirSync(join(outDir, "frames"), { recursive: true });
  for (const family of options.families) {
    const seeds = options.seedPlan?.[family] ?? Array.from({ length: options.seeds }, (_, i) => i + 1);
    for (const [index, seed] of seeds.entries()) {
      const scene = await page.evaluate(([f, s, o]) => window.__bench.scene(f, s, o), [family, seed, { size: options.size }]);
      if (index < FRAMES_KEPT) {
        const url = await page.evaluate((id) => window.__bench.frameDataUrl(id, "image/jpeg"), scene.id);
        const file = `frames/${family}-${seed}.jpg`;
        writeFileSync(join(outDir, file), Buffer.from(url.split(",")[1], "base64"));
        frames.push(file);
      }
      await page.evaluate((id) => window.__bench.release(id), scene.id);
      const check = await page.evaluate(([f, s, o]) => window.__bench.selfCheck(f, s, o), [family, seed, { size: options.size }]);
      rows.push({ family, seed, renderMs: scene.renderMs, timings: scene.timings, check });
    }
    log(`emulator: ${family} checked (${seeds.length} scenes)`);
  }
  await page.evaluate(() => window.__bench.reset());
  const summary = {};
  for (const family of options.families) {
    const all = rows.filter((r) => r.family === family);
    const group = all.filter((r) => r.check.pages > 0);
    if (group.length === 0) {
      summary[family] = {
        scenes: all.length,
        areaErrorMaxPct: 0,
        centroidOffsetMaxPx: 0,
        edgeOffsetMeanPx: 0,
        edgeOffsetMaxPx: 0,
        renderP50: percentile(all.map((r) => r.renderMs), 50),
        renderP95: percentile(all.map((r) => r.renderMs), 95),
        ok: true,
        note: "no pages to measure",
      };
      continue;
    }
    const areaErrorMaxPct = Math.max(...group.map((r) => Math.abs(r.check.areaErrorPct)));
    const centroidOffsetMaxPx = Math.max(...group.map((r) => r.check.centroidOffsetPx));
    const edgeOffsetMaxPx = Math.max(...group.map((r) => r.check.edgeOffsetPx.maxAbs));
    summary[family] = {
      scenes: group.length,
      areaErrorMaxPct,
      centroidOffsetMaxPx,
      edgeOffsetMeanPx: mean(group.map((r) => r.check.edgeOffsetPx.mean)),
      edgeOffsetMaxPx,
      renderP50: percentile(group.map((r) => r.renderMs), 50),
      renderP95: percentile(group.map((r) => r.renderMs), 95),
      ok:
        areaErrorMaxPct <= EMULATOR_TOLERANCE.areaErrorPct &&
        centroidOffsetMaxPx <= EMULATOR_TOLERANCE.centroidOffsetPx &&
        edgeOffsetMaxPx <= EMULATOR_TOLERANCE.edgeOffsetPx,
    };
  }
  const failed = Object.entries(summary).filter(([, s]) => !s.ok).map(([f]) => f);
  return {
    synthetic: true,
    rows,
    scenes: [],
    sheets: [],
    frames,
    summary,
    failed,
    render: (results) => render({ ...results, frames }),
  };
}
