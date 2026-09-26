/**
 * The real-stills suite: every still photo in `SCAN_REAL_MEDIA`, decoded the
 * way the app decodes a photo (`__bench.load`: EXIF applied, 3000 px cap), and
 * every detector variant run on it.
 *
 * With no labels it reports what can be known without a truth — how often
 * each variant finds a page, how large a share of the photo it claims, and
 * how often ML and classical disagree (and, when they do, whether classical
 * claimed more of the photo: the desk-lock signature). Where a hand label
 * exists (`npm run bench:label`) the same verdicts as the synthetic suites are
 * added, from the labelled images only.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { labelFor } from "../labels.mjs";
import { stillUrl } from "../real.mjs";
import {
  disagreement,
  detectionSummary,
  DISAGREE_THRESHOLD,
  REFINE_AUDIT_MOVE,
  refineMoves,
  refineMoveSummary,
  scoreAgainstLabel,
} from "../real-score.mjs";
import { detectorTable, summarizeGroup } from "../report.mjs";
import { detectAll, diag, ms, num, pct, REAL_BANNER, realHeader, runLabels, writeSheet } from "./real-shared.mjs";

/** Long edge of a still's thumbnail on the sheets. */
const THUMB_LONG_EDGE = 360;

/** Tiles per sheet. */
const SHEET_TILES = 30;

/** ML and classical disagree and classical's quad covers this much more of the photo: it took the desk. */
const WIDER_BY = 0.05;

function tileCaption(still, row) {
  const d = row.det;
  const head = `${still.group}/${still.rel.split("/").pop()}`;
  const verdict =
    row.score === null
      ? d.accepted
        ? `found (unlabelled)`
        : d.ok
          ? "gated out"
          : "nothing"
      : !row.score.hasTruth
        ? row.score.falsePositive
          ? "FALSE POSITIVE"
          : "no page: ok"
        : !row.score.detected
          ? "MISS"
          : row.score.wrongCrop
            ? `WRONG iou ${num(row.score.iou, 2)}`
            : `ok iou ${num(row.score.iou, 3)}`;
  return [head, `${row.variant}: ${verdict}`, `conf ${num(d.confidence)} cov ${num(d.coverage)} ${d.source ?? ""}`];
}

/** Per group (and ALL) × variant: GT-free numbers, plus the labelled ones where labels exist. */
export function summarizeRealStills(rows, variants) {
  const groups = [...new Set(rows.map((r) => r.group))];
  const out = {};
  for (const group of [...groups, "ALL"]) {
    const inGroup = rows.filter((r) => group === "ALL" || r.group === group);
    const byImage = new Map();
    for (const r of inGroup) byImage.set(r.id, { ...(byImage.get(r.id) ?? {}), [r.variant]: r });
    const images = [...byImage.values()];
    const mlVsClassical =
      variants.includes("ml") && variants.includes("classical")
        ? disagreement(
            images.map((i) => (i.ml.det.accepted ? i.ml.det.quad : null)),
            images.map((i) => (i.classical.det.accepted ? i.classical.det.quad : null)),
            images.map((i) => i.ml.frame),
          )
        : null;
    const classicalWider = mlVsClassical === null
      ? null
      : images.filter((i) => {
          const a = i.ml.det;
          const b = i.classical.det;
          if (!a.accepted || !b.accepted) return false;
          const apart = i.ml.pairDistance;
          return apart > DISAGREE_THRESHOLD && b.coverage > a.coverage + WIDER_BY;
        }).length;
    out[group] = {};
    for (const variant of variants) {
      const own = inGroup.filter((r) => r.variant === variant);
      const labelled = own.filter((r) => r.score !== null);
      const verdicts = labelled.length > 0 ? summarizeGroup(labelled) : null;
      out[group][variant] = {
        ...detectionSummary(own),
        ...(own.some((r) => r.move !== null) ? { moves: refineMoveSummary(own) } : {}),
        labelled: labelled.length,
        wrongRate: verdicts?.wrongRate ?? null,
        missRate: verdicts?.missRate ?? null,
        falsePositiveRate: verdicts?.falsePositiveRate ?? null,
        cornerErrorP50: verdicts?.cornerErrorP50 ?? null,
        verdicts,
        mlVsClassical,
        classicalWider,
      };
    }
  }
  return out;
}

function render(results, labels) {
  const { summary, rows, config } = results;
  const out = [];
  out.push("# Detection bench — real stills (REAL)");
  out.push("");
  out.push(REAL_BANNER);
  out.push("");
  out.push(...realHeader(results, labels));
  out.push(`- decode: \`createImageBitmap(…, { imageOrientation: "from-image" })\` → \`bitmapToCanvas\` (the app's still path, 3000 px cap)`);
  out.push(
    `- ML vs classical **disagree** when a matched corner is > ${(DISAGREE_THRESHOLD * 100).toFixed(0)} % of the diagonal apart; ` +
      `**classical wider** = they disagree and classical's quad covers ≥ ${(WIDER_BY * 100).toFixed(0)} points more of the photo`,
  );
  out.push("");
  out.push("## GT-free: detection");
  out.push("");
  out.push("| group | variant | images | answered | detected | quad coverage p50 | ms p50 / p95 |");
  out.push("|---|---|---:|---:|---:|---:|---:|");
  for (const [group, byVariant] of Object.entries(summary)) {
    for (const [variant, s] of Object.entries(byVariant)) {
      out.push(`| ${group} | ${variant} | ${s.images} | ${pct(s.answeredRate)} | ${pct(s.detectionRate)} | ${num(s.coverageP50)} | ${ms(s.msP50)} / ${ms(s.msP95)} |`);
    }
  }
  out.push("");
  if (config.variants.includes("ml") && config.variants.includes("classical")) {
    out.push("## GT-free: ML vs classical");
    out.push("");
    out.push("| group | both found | disagree | classical wider | only ML | only classical | distance p50 / p95 (% diag) |");
    out.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const [group, byVariant] of Object.entries(summary)) {
      const d = byVariant.ml.mlVsClassical;
      out.push(
        `| ${group} | ${d.comparable} | ${d.disagree} (${pct(d.rate, 0)}) | ${byVariant.ml.classicalWider} | ${d.onlyA} | ${d.onlyB} | ${diag(d.distanceP50)} / ${diag(d.distanceP95)} |`,
      );
    }
    out.push("");
  }
  const refining = config.variants.filter((v) => summary.ALL[v]?.moves !== undefined);
  if (refining.length > 0) {
    out.push("## GT-free: how far the edge refinement moved the corners");
    out.push("");
    out.push(
      `Largest corner move per image, % of the diagonal, against the same detector's unrefined answer. ` +
        `A move > ${(REFINE_AUDIT_MOVE * 100).toFixed(0)} % is **flagged** for a visual audit ([audit sheet](sheets/refine-audit.jpg), cache only): ` +
        "nothing here says whether a move was the fix or the damage.",
    );
    out.push("");
    out.push("| group | variant | refined | moved | move p50 / p95 / max | flagged | off image | refine ms p50 / p95 |");
    out.push("|---|---|---:|---:|---:|---|---:|---:|");
    for (const [group, byVariant] of Object.entries(summary)) {
      for (const variant of refining) {
        const m = byVariant[variant]?.moves;
        if (m === undefined) continue;
        out.push(
          `| ${group} | ${variant} | ${m.refined} | ${m.moved} | ${diag(m.moveP50)} / ${diag(m.moveP95)} / ${diag(m.moveMax)} | ` +
            `${m.flagged.length === 0 ? "0" : `**${m.flagged.length}**`} | ${m.offImage} | ${ms(m.refineMsP50)} / ${ms(m.refineMsP95)} |`,
        );
      }
    }
    out.push("");
    const flaggedRows = rows.filter((r) => r.move?.flagged);
    if (flaggedRows.length > 0) {
      out.push("Flagged:");
      out.push("");
      for (const r of flaggedRows) {
        const sides = (r.det.refine?.sides ?? []).map((side) => `${side.mode}${side.accepted ? ` ${(side.shiftFrac * 100).toFixed(1)}` : ""}`).join(" · ");
        out.push(`- \`${r.id}\` (${r.variant}): corners TL/TR/BR/BL moved ${r.move.corners.map((c) => diag(c)).join(" / ")} % · sides ${sides}`);
      }
      out.push("");
    }
  }
  const anyLabels = Object.values(summary.ALL).some((s) => s.labelled > 0);
  out.push("## Labelled");
  out.push("");
  if (!anyLabels) {
    out.push("No still has a label yet — `npm run bench:label` to add some. Only the GT-free numbers above apply.");
    out.push("");
  } else {
    for (const [group, byVariant] of Object.entries(summary)) {
      const labelled = Object.fromEntries(
        Object.entries(byVariant).filter(([, s]) => s.verdicts !== null).map(([v, s]) => [v, s.verdicts]),
      );
      if (Object.keys(labelled).length === 0) continue;
      out.push(`### ${group} (${Object.values(byVariant)[0].labelled} labelled)`);
      out.push("");
      out.push(detectorTable(labelled));
      out.push("");
    }
  }
  out.push("## Per image");
  out.push("");
  const variants = config.variants;
  out.push(`| image | ${variants.join(" | ")} | ML↔classical (% diag) | label |`);
  out.push(`|---|${variants.map(() => "---").join("|")}|---:|---|`);
  const byImage = new Map();
  for (const r of rows) byImage.set(r.id, { ...(byImage.get(r.id) ?? {}), [r.variant]: r });
  for (const [id, image] of byImage) {
    const cells = variants.map((v) => {
      const r = image[v];
      const found = r.det.accepted ? `✓ cov ${num(r.det.coverage)}` : r.det.ok ? "gated" : "✗";
      const verdict = r.score === null ? "" : !r.score.hasTruth ? (r.score.falsePositive ? " **FP**" : "") : !r.score.detected ? " **miss**" : r.score.wrongCrop ? ` **wrong** ${diag(r.score.maxCertainCornerError)}` : ` good ${diag(r.score.maxCertainCornerError)}`;
      return found + verdict;
    });
    const first = Object.values(image)[0];
    const label = first.label === null ? "–" : first.label.noDocument ? "no document" : `✓${first.label.uncertain.some(Boolean) ? " (uncertain)" : ""}`;
    out.push(`| ${id} | ${cells.join(" | ")} | ${diag(image.ml?.pairDistance ?? null)} | ${label} |`);
  }
  out.push("");
  if (results.sheets.length > 0) {
    out.push(`Contact sheets (real pixels, cache only): ${results.sheets.map((s) => `[${s.group} ${s.variant}${s.part > 1 ? ` ${s.part}` : ""}](${s.file})`).join(" · ")}`);
    out.push("");
  }
  return out.join("\n");
}

export async function runRealStillsSuite({ page, throttle, options, outDir, log }) {
  const prepared = options.real;
  const labels = runLabels();
  log(`real-stills: ${prepared.stills.length} stills · labels ${labels.counts.total} in ${labels.path} (${labels.reason})`);
  const rows = [];
  const scenes = [];
  const started = Date.now();
  for (const [index, still] of prepared.stills.entries()) {
    const loaded = await page.evaluate(
      ([id, url, thumb]) => window.__bench.load(id, url, { thumbLongEdge: thumb }),
      [still.id, stillUrl(still.rel), THUMB_LONG_EDGE],
    );
    const frame = { width: loaded.width, height: loaded.height };
    const label = labelFor(labels.doc, still.id);
    scenes.push({ id: still.id, group: still.group, frame, bytes: loaded.bytes, decodeMs: loaded.decodeMs, labelled: label !== null });
    const dets = await detectAll(page, throttle, options, still.id);
    const accepted = (v) => (dets[v]?.accepted ? dets[v].quad : null);
    const pair = accepted("ml") !== null && accepted("classical") !== null
      ? disagreement([accepted("ml")], [accepted("classical")], frame).distanceP50
      : null;
    for (const variant of options.variants) {
      const det = dets[variant];
      rows.push({
        id: still.id,
        group: still.group,
        family: still.group,
        seed: index + 1,
        variant,
        frame,
        det,
        label,
        pairDistance: pair,
        score: scoreAgainstLabel(det.accepted ? det.quad : null, label, frame),
        // Refining variants: how far the refinement moved the detector's own answer.
        move: det.refine?.input && det.accepted ? refineMoves(det.refine.input, det.quad, frame) : null,
      });
    }
    await page.evaluate((id) => window.__bench.release(id), still.id);
  }
  log(`real-stills: ${prepared.stills.length} stills × ${options.variants.length} variants in ${((Date.now() - started) / 1000).toFixed(0)} s`);

  const sheets = [];
  mkdirSync(join(outDir, "sheets"), { recursive: true });
  for (const group of [...new Set(prepared.stills.map((s) => s.group))]) {
    const stills = prepared.stills.filter((s) => s.group === group);
    for (const variant of options.variants) {
      for (let start = 0, part = 1; start < stills.length; start += SHEET_TILES, part += 1) {
        const tiles = stills.slice(start, start + SHEET_TILES).map((still) => {
          const row = rows.find((r) => r.id === still.id && r.variant === variant);
          const color = row.score === null ? "unlabelled" : !row.det.accepted ? "rejected" : row.score.wrongCrop || row.score.falsePositive ? "wrong" : "good";
          return {
            id: still.id,
            caption: tileCaption(still, row),
            quads: [
              ...(row.label?.quad ? [{ quad: row.label.quad, color: "truth" }] : []),
              { quad: row.det.quad, color: row.det.accepted ? color : "rejected", dashed: !row.det.accepted },
            ],
          };
        });
        const file = await writeSheet(page, outDir, `sheets/${group}-${variant}${part > 1 ? `-${part}` : ""}.jpg`, {
          title: `${group} · ${variant} · REAL — local only, never commit`,
          columns: 6,
          tiles,
          legend: [
            { label: "label", color: "truth" },
            { label: "unlabelled answer", color: "unlabelled" },
            { label: "right crop", color: "good" },
            { label: "wrong crop", color: "wrong" },
            { label: "gated out (dashed)", color: "rejected" },
          ],
        });
        sheets.push({ group, variant, part, file });
      }
    }
  }
  // The audit sheet: every flagged refinement, its input dashed amber, its
  // output blue — for a person to look at, locally.
  const flagged = rows.filter((r) => r.move?.flagged);
  if (flagged.length > 0) {
    for (let start = 0, part = 1; start < flagged.length; start += SHEET_TILES, part += 1) {
      const file = await writeSheet(page, outDir, `sheets/refine-audit${part > 1 ? `-${part}` : ""}.jpg`, {
        title: `refinement moves > ${(REFINE_AUDIT_MOVE * 100).toFixed(0)} % · REAL — local only, never commit`,
        columns: 4,
        tiles: flagged.slice(start, start + SHEET_TILES).map((r) => ({
          id: r.id,
          caption: [
            `${r.group}/${r.id.split("/").pop()}`,
            `${r.variant}: max move ${diag(r.move.max)} %`,
            (r.det.refine?.sides ?? []).map((side) => side.mode[0]).join(""),
          ],
          quads: [
            { quad: r.det.refine.input, color: "rejected", dashed: true },
            { quad: r.det.quad, color: "unlabelled" },
            ...(r.label?.quad ? [{ quad: r.label.quad, color: "truth" }] : []),
          ],
        })),
        legend: [
          { label: "before refinement (dashed)", color: "rejected" },
          { label: "after refinement", color: "unlabelled" },
          { label: "label", color: "truth" },
        ],
      });
      sheets.push({ group: "audit", variant: "refine", part, file });
    }
  }
  await page.evaluate(() => window.__bench.reset());
  const summary = summarizeRealStills(rows, options.variants);
  return {
    synthetic: false,
    rows,
    scenes,
    sheets,
    summary,
    labels: { path: labels.path, reason: labels.reason, counts: labels.counts },
    render: (results) => render(results, labels),
  };
}
