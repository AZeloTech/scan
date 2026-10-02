/**
 * The detector suite: every family × seed rendered once, every variant run on
 * the same frame, each answer scored against the scene's ground truth.
 *
 * Detector level only — no viewfinder, no tracking, no capture UI; that is the
 * session suite's job. The CPU throttle (when asked for) is on only while a
 * detector runs, so rendering never distorts the latency column.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scoreDetection } from "../metrics.mjs";
import { renderDetectorReport, summarizeDetector } from "../report.mjs";
import { renderOcclusionSection, scoreOcclusion, scoreProvenance } from "./detector-occlusion.mjs";

/** Tiles per contact sheet. */
const SHEET_TILES = 30;

function fmt(v, digits = 3) {
  return v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(digits);
}

function caption(scene, row) {
  const s = row.score;
  const head = `${scene.family} #${scene.seed}${scene.setting ? ` ${scene.setting}` : ""}`;
  const verdict = !s.hasTruth
    ? s.falsePositive
      ? "FALSE POSITIVE"
      : "no page: ok"
    : !s.detected
      ? `MISS${row.det.ok ? " (gated)" : ""}`
      : s.wrongCrop
        ? `WRONG ${s.orderWrong ? "order " : ""}iou ${fmt(s.iou, 2)}`
        : s.contentClipped
          ? `CLIPPED iou ${fmt(s.iou, 3)}`
          : `ok iou ${fmt(s.iou, 3)}`;
  return [
    head,
    `${row.variant}: ${verdict}`,
    `err ${s.detected && s.maxCornerError !== null ? `${fmt(s.maxCornerError * 100, 2)}%` : "–"} conf ${fmt(row.det.confidence, 2)} ${row.det.source ?? ""}`,
    `cov page ${fmt(row.pageCoverage, 2)} quad ${fmt(row.det.coverage, 2)}`,
  ];
}

/** A ground truth with each page's content boxes replaced by their count. */
function withoutContent(gt) {
  const count = (content) => (Array.isArray(content) ? content.length : null);
  return {
    ...gt,
    content: undefined,
    contentBoxes: count(gt.content),
    pages: gt.pages.map((page) => ({ ...page, content: undefined, contentBoxes: count(page.content) })),
  };
}

export async function runDetectorSuite({ page, throttle, options, outDir, log, environment }) {
  const rows = [];
  const scenes = [];
  const started = Date.now();
  const seedsOf = (family) => options.seedPlan?.[family] ?? Array.from({ length: options.seeds }, (_, i) => i + 1);
  const total = options.families.reduce((sum, family) => sum + seedsOf(family).length, 0);
  for (const family of options.families) {
    for (const seed of seedsOf(family)) {
      const scene = await page.evaluate(
        ([f, s, o]) => window.__bench.scene(f, s, o),
        [family, seed, { size: options.size }],
      );
      const gt = scene.gt;
      const primary = gt.primary === null ? null : gt.pages[gt.primary];
      scenes.push({
        id: scene.id,
        family,
        seed,
        setting: scene.params.setting ?? null,
        renderMs: scene.renderMs,
        // The content boxes are re-derived from the params on a re-render;
        // results.json keeps only how many there were.
        gt: withoutContent(gt),
        params: scene.params,
      });
      for (const variant of options.variants) {
        await throttle.set(options.cpu);
        let det;
        try {
          det = await page.evaluate(([v, id]) => window.__bench.detect(v, id), [variant, scene.id]);
        } finally {
          await throttle.set(1);
        }
        if (det.mlDisabled && environment.mlReady) {
          log(`warning: the ML runtime latched off during ${family} #${seed} ${variant}; later ML rows are fallbacks`);
          environment.mlLatchedOff = true;
        }
        const verdictQuad = det.accepted ? det.quad : null;
        rows.push({
          family,
          seed,
          sceneId: scene.id,
          setting: scene.params.setting ?? null,
          variant,
          pageCoverage: primary?.coverage ?? null,
          det,
          score: scoreDetection(verdictQuad, gt.quad, gt.frame, { content: gt.content ?? null }),
          rawScore: det.quad === null ? null : scoreDetection(det.quad, gt.quad, gt.frame, { content: gt.content ?? null }),
          // Only where something lies over the page (F8): the covered corner, the occluder.
          ...(() => {
            const occlusion = scoreOcclusion(verdictQuad, gt);
            return occlusion === null ? {} : { occlusion };
          })(),
          // Corner provenance (5d+ phase B), wherever the variant refined its answer.
          ...(() => {
            const refined = det.refine ?? det.liveRefine ?? null;
            const provenance = scoreProvenance(verdictQuad, gt, refined?.corners ?? null, refined?.separate ?? false, refined?.basis ?? null);
            return provenance === null ? {} : { provenance };
          })(),
        });
      }
      await page.evaluate((id) => window.__bench.release(id), scene.id);
      const done = scenes.length;
      if (done % 5 === 0 || done === total) {
        log(`detector: ${done}/${total} scenes (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      }
    }
  }

  // Contact sheets: one per family × variant, in parts of SHEET_TILES.
  const sheets = [];
  const sheetDir = join(outDir, "sheets");
  mkdirSync(sheetDir, { recursive: true });
  for (const family of options.families) {
    const familyScenes = scenes.filter((s) => s.family === family);
    for (const variant of options.variants) {
      for (let start = 0, part = 1; start < familyScenes.length; start += SHEET_TILES, part += 1) {
        const tiles = familyScenes.slice(start, start + SHEET_TILES).map((scene) => {
          const row = rows.find((r) => r.sceneId === scene.id && r.variant === variant);
          const color = !row.det.accepted ? "rejected" : row.score.wrongCrop || row.score.contentClipped ? "wrong" : "good";
          return {
            id: scene.id,
            caption: caption(scene, row),
            quads: [
              { quad: scene.gt.quad, color: "truth" },
              // A refining variant: its input, thin and dashed, under its answer.
              ...(row.det.refine?.changed ? [{ quad: row.det.refine.input, color: "#8fb8ff", dashed: true }] : []),
              { quad: row.det.quad, color, dashed: !row.det.accepted },
            ],
          };
        });
        const dataUrl = await page.evaluate((spec) => window.__bench.sheet(spec), {
          title: `${family} · ${variant} · scenes ${start + 1}–${start + tiles.length} · SYNTHETIC`,
          columns: 6,
          tiles,
        });
        const file = `sheets/${family}-${variant}${part > 1 ? `-${part}` : ""}.jpg`;
        writeFileSync(join(outDir, file), Buffer.from(dataUrl.split(",")[1], "base64"));
        sheets.push({ family, variant, part, file });
      }
    }
  }
  await page.evaluate(() => window.__bench.reset());

  const summary = summarizeDetector(rows);
  return {
    synthetic: true,
    rows,
    scenes,
    sheets,
    summary,
    render: (results) => renderDetectorReport(results) + renderOcclusionSection(results.rows),
  };
}
