/**
 * The straighten suite's Markdown report. Pure: `results.json` in, text out.
 * Synthetic and real runs render with the same tables, each under its own
 * banner; they are never mixed or compared.
 */

import { CLIP, PAINT } from "./measure.mjs";
import { cardHistogram, cardOf, outcomeHistogram, perTilt, quantile, TOL, DEVICE_BUDGET_MS } from "./score.mjs";

const pct = (v, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${(v * 100).toFixed(digits)} %`);
const deg = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v.toFixed(2)}°`);
const ms = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${Math.round(v)}`);
const cr = (n, d) => `${n} (${pct(d > 0 ? n / d : null, 0)})`;

function headlineTable(summary) {
  const lines = [
    "| group | scenes | should-act | **complete** | partial | no-op | **harm** | unverified | nothing-to-do: acted / harmed | tilt-only complete | curl complete | resid. tilt p50 / p90 | dark wedges · painted · seams | timeouts · > 12 s | errors |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [group, { final: s }] of Object.entries(summary)) {
    lines.push(
      `| ${group} | ${s.scenes} | ${s.shouldAct} | **${cr(s.complete, s.shouldAct)}** | ${cr(s.partial, s.shouldAct)} | ${cr(s.noop, s.shouldAct)} | ` +
        `**${cr(s.harm, s.shouldAct)}** | ${cr(s.unverified, s.shouldAct)} | ${s.nothingToDoActed} / ${s.flatHarms} of ${s.nothingToDo} | ` +
        `${s.tiltCases ? `${s.tiltComplete}/${s.tiltCases}` : "–"} | ${s.curlCases ? `${s.curlComplete}/${s.curlCases}` : "–"} | ` +
        `${deg(s.residTiltP50)} / ${deg(s.residTiltP90)}${s.residTiltUnmeasured ? ` (${s.residTiltUnmeasured} unmeasured)` : ""} | ` +
        `${s.darkWedges} · ${s.paintedPages} · ${s.seamCount} | ${s.timeouts} · ${s.overBudget} | ${s.errors} |`,
    );
  }
  return lines.join("\n");
}

function tiltTable(rows, quadMode) {
  const table = perTilt(rows, quadMode);
  if (table.length === 0) return null;
  const lines = [
    "| \\|θ\\| | n | deskewed | engine accepted | complete | harm | unverified | untouched | resid. p50 / p90 | deskew \\|err\\| p90 | deskew abstained |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const t of table) {
    const abstain = Object.entries(t.abstain).map(([k, v]) => `${k} ×${v}`).join(", ") || "–";
    lines.push(
      `| ${t.tilt} | ${t.n} | ${t.deskewed} | ${t.accepted} | ${t.complete} | ${t.harm} | ${t.unverified} | ${t.noop} | ${deg(t.residP50)} / ${deg(t.residP90)} | ${deg(t.estErrP90)} | ${abstain} |`,
    );
  }
  return lines.join("\n");
}

function sceneList(rows, pick, describe, limit = 60) {
  const sel = rows.filter(pick);
  if (sel.length === 0) return ["none"];
  const out = sel.slice(0, limit).map(describe);
  if (sel.length > limit) out.push(`- … and ${sel.length - limit} more (every row is in results.json)`);
  return out;
}

const outcomeOf = (r) => (r.outcome.accepted ? "engine accepted" : `${r.outcome.code} ${r.outcome.reason}`) + (r.deskew?.act ? `, deskewed ${r.deskew.deg}°` : "");

/** Tilt and bow estimator self-check, on scenes whose truth is known. */
function estimatorLines(rows) {
  const syn = rows.filter((r) => !r.error && r.suite === "synthetic");
  if (syn.length === 0) return [];
  const paperErr = syn.filter((r) => r.paper).map((r) => Math.abs(r.paper.tiltDeg - r.truth.tiltDeg));
  const exact = syn.filter((r) => r.truth.curl === "none" && r.axes.quadMode !== "jitter");
  const flatErr = exact.map((r) => Math.abs(r.flat.tiltDeg - r.truth.tiltDeg));
  const noCurlBow = syn.filter((r) => r.truth.curl === "none" && r.axes.quadMode === "correct").map((r) => r.flat.bowFrac);
  const nan = (xs) => xs.filter((v) => !Number.isFinite(v)).length;
  return [
    "## Estimator self-check",
    "",
    `- tilt on the paper itself: |err| p90 ${deg(quantile(paperErr, 0.9))} over ${paperErr.length} (${nan(paperErr)} unmeasured)`,
    `- tilt on the flat page of an exact outline (no curl): |err| p90 ${deg(quantile(flatErr, 0.9))}, max ${deg(Math.max(...flatErr.filter(Number.isFinite)))} over ${flatErr.length}`,
    `- bow on flat pages with no curl (the noise floor): p50 ${pct(quantile(noCurlBow, 0.5), 3)}, p90 ${pct(quantile(noCurlBow, 0.9), 3)}, max ${pct(Math.max(...noCurlBow.filter(Number.isFinite)), 3)} (${nan(noCurlBow)} unmeasured) — the bow-harm floor is ${pct(TOL.bowWorseAbs, 2)}`,
    "",
  ];
}

/** The Markdown report of a straighten run. */
export function renderStraightenReport(results, { banner = null } = {}) {
  const { config, summary, rows, sheets } = results;
  const kind = results.synthetic ? "SYNTHETIC" : "REAL";
  const e = config.engine;
  const out = [`# Endireitar bench — ${results.suite} suite (${kind})`, ""];
  if (banner) out.push(banner, "");
  else {
    out.push(
      "> Synthetic scenes rendered from specs with known truth. These numbers are **never** comparable with real-media results.",
      "",
    );
  }
  out.push(
    `- run: ${results.createdAt} · bench commit ${results.git.commit}${results.git.dirty ? " (dirty)" : ""}`,
    `- engine: \`${e.root}\` · ${e.head ?? "not a git checkout"}${e.dirty ? ` + uncommitted changes (patch sha256 ${e.patchHash})` : " (clean)"} · wasm ${results.environment.wasmVersion ?? "?"}`,
    `- deskew step: ${config.deskew ?? "off"} · hard timeout ${config.timeoutCapMs / 1000} s (the app's, capped) · device budget ${DEVICE_BUDGET_MS / 1000} s · ${config.jobs} parallel jobs`,
    `- profile: ${config.profile} (${config.scenes} scenes${config.only ? `, --only ${config.only}` : ""}) · scene set ${config.sceneHash}${config.scene ? ` · photo noise ${config.scene.noise ? "on" : "off"}, blur σ ${config.scene.blurSigma}` : ""}`,
    `- verdicts, the page the user sees against the ORIGINAL flat page of the outline: **harm** = tilt worse by > ${TOL.tiltWorseDeg}°, ` +
      `bow worse by > max(${pct(TOL.bowWorseAbs, 2)}, ${pct(TOL.bowWorseRel, 0)}) (engine surfaces only), print lost (absolute ink < ${pct(CLIP.inkRatio, 0)} of the flat page's, ` +
      `or pushed into a border it kept clear of; print scaled down whole with its bounding box is shrunk, not lost), background brought into a page no rotation uncovered (a straight page, an engine surface, print shrunk into a frame), or the page's aspect off the flat page's by > ${pct(TOL.aspectDrift, 0)}; **complete** = no harm, |tilt| ≤ ${TOL.tiltFixedDeg}° and bow ≤ ${pct(TOL.bowFixedRel, 0)} of the flat page's; ` +
      `**unverified** = acted, no harm found, but a check could not be measured; **partial** = the rest of what acted. Rates are over the should-act pages. ` +
      `**Painted** = fill without the photo's grain (< ${pct(PAINT.roughRatio, 0)} of it); **seam** = ≥ ${PAINT.seamMinBlocks} painted blocks that step > ${PAINT.seamDelta} grey levels against the paper beside them.`,
    ...(rows.some((r) => !r.error && r.truth.curl === "unknown")
      ? [
          "",
          "> **Curl is not graded here.** These stills carry no curl truth: a page counts as complete on its tilt alone (and on no harm), " +
            "and a still's own base and `rot-quad` variants are \"nothing to do\" only in the tilt this suite added, not in whatever skew or curl the photo itself has.",
        ]
      : []),
    "",
    "## Headline",
    "",
    headlineTable(summary),
    "",
    "## Engine outcomes",
    "",
    "| outcome | pages | should-act | nothing to do |",
    "|---|---:|---:|---:|",
    ...outcomeHistogram(rows).map((o) => `| ${o.key} | ${o.n} | ${o.shouldAct} | ${o.nothingToDo} |`),
    "",
    "## What the card says",
    "",
    "The sentence the page view shows after the tap (`straightenOutcome`), against what the page needed. \"nothing\" (already level and flat) on a should-act page is a false claim; \"none\" is no card (the engine changed a page measured level and flat, so no curl is claimed).",
    "",
    "| card | pages | complete | partial | no-op | harm | unverified | nothing to do |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...cardHistogram(rows).map((c) => `| ${c.key} | ${c.n} | ${c.complete} | ${c.partial} | ${c.noop} | ${c.harm} | ${c.unverified} | ${c.nothingToDo} |`),
    "",
  );
  const falseNothing = rows.filter((r) => !r.error && r.truth.shouldAct && cardOf(r) === "nothing");
  if (falseNothing.length > 0) {
    out.push("Should-act pages told \"nothing to straighten\":", "", ...falseNothing.map((r) => `- \`${r.id}\` (${outcomeOf(r)})`), "");
  }
  if (results.synthetic) {
    for (const [title, mode] of [["correct outline — tilted print inside a right outline", "correct"], ["every outline", null]]) {
      const table = tiltTable(rows, mode);
      if (table) out.push(`## Per tilt, synthetic tilt family: ${title}`, "", table, "");
    }
  }
  out.push("## Harms", "");
  out.push(...sceneList(rows, (r) => !r.error && r.verdict.harm, (r) => `- \`${r.id}\` (${outcomeOf(r)}): ${r.verdict.harmWhy.join("; ")}`));
  out.push("", "## Unverified", "");
  out.push(...sceneList(rows, (r) => !r.error && r.verdict.unverified, (r) => `- \`${r.id}\` (${outcomeOf(r)}): ${r.verdict.unverifiedWhy.join("; ")}`));
  out.push("", "## Partial fixes", "");
  out.push(
    ...sceneList(rows, (r) => !r.error && r.verdict.cls === "partial", (r) =>
      `- \`${r.id}\` (${outcomeOf(r)}): tilt ${deg(r.flat.tiltDeg)} → ${deg(r.final?.tiltDeg)}` +
        (r.truth.curl !== "none" && r.truth.curl !== "unknown" ? `, bow ${pct(r.flat.bowFrac, 2)} → ${pct(r.final?.bowFrac, 2)}` : ""),
    ),
  );
  out.push("", "## Seams", "");
  out.push(...sceneList(rows, (r) => !r.error && r.verdict.seam, (r) => `- \`${r.id}\` (${outcomeOf(r)}): ${r.paint.seamBlocks} seam blocks, worst step ${r.paint.maxSeamDelta} grey levels, painted ${pct(r.paint.paintedFrac, 2)} of the page`));
  const errors = rows.filter((r) => r.error);
  if (errors.length > 0) {
    out.push("", "## Errors", "", ...errors.map((r) => `- \`${r.id}\`: ${r.error.split("\n")[0]}`));
  }
  out.push("");
  out.push(...estimatorLines(rows));
  out.push(`## Runtime (${config.jobs} parallel jobs — load-dependent)`, "");
  const all = summary.ALL?.final;
  if (all) {
    out.push(
      `- engine stage ms p50 / p90: ${ms(all.stageMsP50)} / ${ms(all.stageMsP90)} · deskew step ms p50 / p90: ${ms(all.deskewMsP50)} / ${ms(all.deskewMsP90)}`,
      `- over the ${DEVICE_BUDGET_MS / 1000} s device budget (engine + deskew): ${all.overBudget} · engine timeouts: ${all.timeouts}`,
      "",
    );
  }
  if ((sheets ?? []).length > 0) {
    out.push("## Before / after sheets (flat page | page the user sees)", "");
    for (const s of sheets) out.push(`- [${s.id}](${s.file}) — ${s.flags.join(", ")}`);
    out.push("");
  }
  return out.join("\n");
}
