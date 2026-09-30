#!/usr/bin/env node
/**
 * One shard of a straighten run, in its own Node process: loads the engine
 * root's Endireitar engine (and its deskew step, when the run has one), runs
 * each scene of the shard the way the app would, measures the flat page and
 * the page the user would see, and writes the records to a partial file the
 * suite merges. The wasm solve is single-threaded and a page takes seconds,
 * so `--jobs` of these run side by side.
 *
 *   node scripts/bench/straighten/worker.mjs <job.json>
 *
 * `job.json` (written by `suite.mjs`): `{ engineRoot, deskew, kind, specs,
 * mediaDir, sheetsDir, previous, out }`. Before/after sheets are written only
 * for flagged scenes and only into `sheetsDir` — the run's own directory,
 * which for real media is in the cache outside the repository.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadDeskew, runFinal } from "./deskew-step.mjs";
import { loadEngineHost } from "./engine-host.mjs";
import { clippingCheck, measurePage, paintCheck, textureBlocks } from "./measure.mjs";
import { encodePng, sideBySide } from "./png.mjs";
import { buildRealScene } from "./real-scenes.mjs";
import { buildScene } from "./scenes.mjs";
import { flaggedScenes, verdict } from "./score.mjs";

const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);

function slimDiagnostics(d, semanticWhy) {
  const st = d.classicalStatus;
  return {
    ...(st ? { status: { converged: st.converged, kept_text_lines: st.kept_text_lines, quad_corner_residual: st.quad_corner_residual } } : {}),
    ...(d.map ? { map: d.map } : {}),
    ...(d.verdict ? { verdict: d.verdict } : {}),
    ...(semanticWhy ? { semanticWhy } : {}),
  };
}

/** The axes a scene is grouped and tabled by. */
export function axesOf(kind, spec) {
  return kind === "synthetic"
    ? { family: spec.family, layout: spec.layout, quadMode: spec.quadMode, tilt: spec.tiltDeg, phi: spec.phiDeg, curl: spec.curl }
    : { still: spec.still, variant: spec.variant, tilt: spec.tiltDeg };
}

async function scene(job, host, dk, spec) {
  let canonical, quad, truth, paper = null;
  const axes = axesOf(job.kind, spec);
  if (job.kind === "synthetic") {
    const sc = buildScene(spec, job.sceneOptions);
    ({ canonical, quad, truth } = sc);
    paper = sc.paper;
  } else {
    const sc = await buildRealScene(spec, path.join(job.mediaDir, spec.still));
    ({ canonical, quad, truth } = sc);
  }
  const fr = await runFinal(host, dk, job.deskew, canonical, quad, spec.id);
  const r = fr.r;
  // The ORIGINAL flat page of the confirmed outline: what every final page is judged against.
  const flatImg = host.flatPage(canonical, quad);
  const flat = measurePage(flatImg);
  const acted = r.accepted || fr.deskew?.act === true;
  const final = acted ? measurePage(fr.final) : null;
  const deskewMs = fr.deskew ? fr.deskew.estimateMs + fr.deskew.rebaselineMs + fr.deskew.fillMs : 0;
  const record = {
    id: spec.id,
    suite: job.kind,
    axes,
    truth,
    outcome: { accepted: r.accepted, reason: r.reason, code: r.code, bucket: r.bucket },
    deskew: fr.deskew,
    timing: { stageMs: Math.round(r.ms), engineMs: Math.round(r.engineMs), gateMs: Math.round(r.gateMs), deskewMs: Math.round(deskewMs) },
    flat,
    final,
    clip: acted ? roundClip(clippingCheck(flat, final)) : null,
    paint: acted ? paintCheck(textureBlocks(flatImg), textureBlocks(fr.final)) : null,
    ...(paper ? { paper: { tiltDeg: measurePage(paper).tiltDeg } } : {}),
    diag: slimDiagnostics(r.diagnostics ?? {}, r.semanticWhy),
  };
  record.verdict = verdict(record);
  return { record, flatImg, finalImg: fr.final };
}

function roundClip(c) {
  return { ...c, inkRatio: r4(c.inkRatio) };
}

async function main() {
  const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const host = await loadEngineHost(job.engineRoot);
  const dk = job.deskew ? await loadDeskew(job.engineRoot) : null;
  const previous = job.previous ?? null;
  const records = [];
  const sheets = [];
  for (const spec of job.specs) {
    try {
      const { record, flatImg, finalImg } = await scene(job, host, dk, spec);
      records.push(record);
      if (job.sheetsDir) {
        const prev = previous?.[spec.id];
        const flags = flaggedScenes([record], prev ? [{ id: spec.id, verdict: prev }] : null).get(spec.id);
        if (flags !== undefined) {
          const file = `${spec.id.replace(/[^A-Za-z0-9._-]+/g, "_")}.png`;
          mkdirSync(job.sheetsDir, { recursive: true });
          writeFileSync(path.join(job.sheetsDir, file), encodePng(sideBySide([flatImg, finalImg])));
          sheets.push({ id: spec.id, file: `sheets/${file}`, flags });
        }
      }
      const o = record.outcome;
      process.stderr.write(`${spec.id} ${record.verdict.cls} ${o.accepted ? "accepted" : `${o.code} ${o.reason}`}${record.deskew?.act ? ` deskew ${record.deskew.deg}°` : ""} ${record.timing.stageMs} ms\n`);
    } catch (error) {
      records.push({ id: spec.id, suite: job.kind, axes: axesOf(job.kind, spec), error: String(error?.stack ?? error) });
      process.stderr.write(`${spec.id} ERROR ${error?.message ?? error}\n`);
    }
    // Written after every scene: a shard that dies still leaves what it measured.
    writeFileSync(job.out, JSON.stringify({ meta: host.meta, records, sheets }));
  }
  writeFileSync(job.out, JSON.stringify({ meta: host.meta, records, sheets }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch((error) => {
  process.stderr.write(`straighten worker: ${error?.stack ?? error}\n`);
  process.exit(1);
});
