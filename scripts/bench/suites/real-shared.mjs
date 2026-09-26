/**
 * What the two real-media suites share: the labels, running every variant on
 * a loaded image, writing a sheet, and the report's warning line.
 *
 * Every file these suites write lands in the run directory `run.mjs` chose —
 * under the cache, outside the repository (`paths.mjs`, `outputDir`). The
 * sheets hold real pixels; the reports and results hold file names and
 * numbers. None of it is committed or sent anywhere.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { labelCounts } from "../labels.mjs";
import { readLabels } from "../real.mjs";
import { resolveLabelsPath } from "../server.mjs";

export const REAL_BANNER =
  "> **REAL media, local only.** Decoded from `SCAN_REAL_MEDIA` on this machine; this report, its " +
  "`results.json` and its sheets live in the cache outside the repository and are never committed or uploaded. " +
  "Real numbers are **never** comparable with synthetic ones.";

/** The labels in force for this run: where they are, why there, and the document. */
export function runLabels() {
  const where = resolveLabelsPath();
  const doc = readLabels(where.path);
  return { ...where, doc, counts: labelCounts(doc) };
}

/** Every variant on one loaded image, the CPU throttle on only while a detector runs. */
export async function detectAll(page, throttle, { variants, cpu }, id) {
  const out = {};
  for (const variant of variants) {
    await throttle.set(cpu);
    try {
      out[variant] = await page.evaluate(([v, i]) => window.__bench.detect(v, i), [variant, id]);
    } finally {
      await throttle.set(1);
    }
  }
  return out;
}

/** Draw a sheet in the bench page and write it into the run directory. */
export async function writeSheet(page, outDir, file, spec) {
  const dataUrl = await page.evaluate((s) => window.__bench.sheet(s), spec);
  writeFileSync(join(outDir, file), Buffer.from(dataUrl.split(",")[1], "base64"));
  return file;
}

export const pct = (v, digits = 1) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(digits)} %`);
export const diag = (v) => (v === null || v === undefined ? "–" : (v * 100).toFixed(2));
export const ms = (v) => (v === null || v === undefined ? "–" : `${Math.round(v)}`);
export const num = (v, digits = 2) => (v === null || v === undefined ? "–" : v.toFixed(digits));

/** The run's header lines, shared by both real reports. */
export function realHeader(results, labels) {
  const env = results.environment;
  const cfg = results.config;
  return [
    `- run: ${results.createdAt} · commit ${results.git.commit}${results.git.dirty ? " (dirty)" : ""} · CPU throttle ${cfg.cpu}× (detectors only)`,
    `- browser: ${env.executable} · ML runtime ready: ${env.mlReady ? "yes" : "**NO — every ML number below is a fallback**"}`,
    `- labels: ${labels.counts.total} labelled item(s) in \`${labels.path}\` (${labels.reason})` +
      (labels.counts.total > 0 ? ` — ${labels.counts.noDocument} "no document", ${labels.counts.withUncertain} with an uncertain corner` : ""),
    `- variants: ${cfg.variants.map((v) => `\`${v}\``).join(", ")}`,
  ];
}
