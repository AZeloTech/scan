/**
 * The real-video suite: each camera clip in `SCAN_REAL_MEDIA`, three ways.
 *
 * 1. **Every replay frame** (15 fps, `real.mjs`) through every variant — the
 *    GT-free numbers: how often each finds the page, how much its quad moves
 *    between consecutive frames (1/15 s apart, the page hardly moves), and how
 *    often ML and classical disagree. The ML answers double as the per-frame
 *    *reference* for step 3.
 * 2. **The sparse frames** (every 8th, ≈ 0.5 s, at 1080p-preview size) —
 *    the frames people label: detection rate, and wherever a label exists the
 *    synthetic suites' verdicts.
 * 3. **The clip replayed through the real `<ScanFlow>`** on the bench phone
 *    (the session page with a real clip as its camera, in real time): what the
 *    overlay did against the per-frame reference on the frame that was on
 *    screen — shown on the page, lagging off it, stale, or nothing — and
 *    against labels where frames have them; the live loop's passes and
 *    cadence; and one shutter tap, at the steadiest second of the clip (by the
 *    reference), scored at the confirm screen.
 *
 * The reference is a proxy: it says where the ML detector would have put the
 * quad on that very frame, not where the page is. Its job is to expose lag
 * and staleness; only labels say what is right.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frameId, labelFor } from "../labels.mjs";
import { LOCK_TOLERANCE, WRONG_CROP_MAX_CORNER_ERROR, quadDistance } from "../metrics.mjs";
import { REPLAY_FPS, REPLAY_LONG_EDGE, replayUrl, SPARSE_LONG_EDGE, SPARSE_STRIDE, sparseUrl } from "../real.mjs";
import {
  disagreement,
  detectionSummary,
  DISAGREE_THRESHOLD,
  frameToFrameMotion,
  JUMP_THRESHOLD,
  REFINE_AUDIT_MOVE,
  refineMoves,
  refineMoveSummary,
  scoreAgainstLabel,
  scoreReplay,
  steadiestFrame,
} from "../real-score.mjs";
import { detectorTable, summarizeGroup } from "../report.mjs";
import { toPoints } from "../session-score.mjs";
import { cpuThrottle } from "../browser.mjs";
import { COLORS } from "../app/sheets.js";
import { openSessionPage, sessionKnobs } from "./session.mjs";
import { detectAll, diag, ms, num, pct, REAL_BANNER, realHeader, runLabels, writeSheet } from "./real-shared.mjs";

/** Sparse-frame thumbnails for the sheets. */
const THUMB_LONG_EDGE = 320;

/** The tap: the steadiest window this long, no earlier than this, and this long before the end. */
const TAP_WINDOW_S = 1;
const TAP_EARLIEST_S = 3;
const TAP_TAIL_S = 3;

function compact(det) {
  return {
    ok: det.ok,
    accepted: det.accepted,
    quad: det.quad,
    source: det.source,
    confidence: det.confidence,
    coverage: det.coverage,
    ms: det.ms,
    // Refining variants: what went in, and each side's mode — per frame, so kept small.
    refine:
      det.refine == null
        ? null
        : { ms: det.refine.ms, changed: det.refine.changed, input: det.refine.input, modes: det.refine.sides.map((side) => side.mode) },
  };
}

/** How far a refining variant moved the detector's own answer on one frame. */
function moveOf(det, frame) {
  return det.refine?.input && det.accepted ? refineMoves(det.refine.input, det.quad, frame) : null;
}

/** Pass 1: every replay frame through every variant. */
async function replayPass(page, throttle, options, clip, log) {
  const perVariant = Object.fromEntries(options.variants.map((v) => [v, []]));
  const frame = { width: clip.replay.width, height: clip.replay.height };
  const started = Date.now();
  for (let k = 0; k < clip.replay.frames; k += 1) {
    const id = `${clip.key}#${k}`;
    await page.evaluate(([i, url]) => window.__bench.load(i, url, { thumbLongEdge: 0 }), [id, replayUrl(clip, k)]);
    const dets = await detectAll(page, throttle, options, id);
    for (const variant of options.variants) {
      const det = compact(dets[variant]);
      perVariant[variant].push({ k, id, det, move: moveOf(det, frame) });
    }
    await page.evaluate((i) => window.__bench.release(i), id);
  }
  log(`real-video: ${clip.rel}: ${clip.replay.frames} replay frames × ${options.variants.length} variants in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  return { frame, perVariant };
}

/** Pass 2: the sparse (labelled) frames. */
async function sparsePass(page, throttle, options, clip, labels) {
  const rows = [];
  for (let j = 0; j < clip.sparse.frames; j += 1) {
    const k = j * clip.sparse.stride;
    const id = frameId(clip.rel, k, clip.fps);
    const loaded = await page.evaluate(
      ([i, url, thumb]) => window.__bench.load(i, url, { thumbLongEdge: thumb }),
      [id, sparseUrl(clip, j), THUMB_LONG_EDGE],
    );
    const frame = { width: loaded.width, height: loaded.height };
    const label = labelFor(labels.doc, id);
    const dets = await detectAll(page, throttle, options, id);
    for (const variant of options.variants) {
      const det = dets[variant];
      rows.push({
        clip: clip.key,
        id,
        j,
        k,
        t: k / clip.fps,
        variant,
        frame,
        det: compact(det),
        label,
        score: scoreAgainstLabel(det.accepted ? det.quad : null, label, frame),
        move: moveOf(det, frame),
      });
    }
    await page.evaluate((i) => window.__bench.release(i), id);
  }
  return rows;
}

/** The overlay on screen when frame `k` was presented, from the played record. */
function overlayAt(record, k, fps) {
  const shown = record.presented.find((p) => p.k >= k);
  const at = shown?.at ?? record.startedAt + (k * 1000) / fps;
  let overlay = null;
  for (const e of record.events) if (e.type === "overlay" && e.t <= at + 50) overlay = e;
  return overlay !== null && overlay.quad !== null && overlay.opacity >= 0.5 ? toPoints(overlay.quad) : null;
}

/** Pass 3: the clip replayed through the real app on the bench phone. */
async function replayThroughApp(browser, origin, options, clip, { reference, referenceLive, labelsByK, frame }, outDir, log) {
  const fps = clip.fps;
  const tapK =
    steadiestFrame(reference, frame, {
      windowFrames: Math.round(TAP_WINDOW_S * fps),
      earliest: Math.round(TAP_EARLIEST_S * fps),
      tail: Math.round(TAP_TAIL_S * fps),
    }) ?? Math.round(clip.replay.frames * 0.6);
  const tapAtMs = Math.round((tapK * 1000) / fps);
  const { context, page, errors } = await openSessionPage(browser, origin, options.layout, options.viewport);
  try {
    const prepared = await page.evaluate(
      ([key, tap, labels, knobs]) => window.__session.prepareClip(key, { tapAtMs: tap, labels, knobs }),
      [clip.key, tapAtMs, [...labelsByK.entries()], sessionKnobs(options)],
    );
    const throttle = await cpuThrottle(page);
    await throttle.set(options.cpu);
    let record;
    try {
      record = await page.evaluate(() => window.__session.run());
    } finally {
      await throttle.set(1);
    }
    const score = scoreReplay({ frame, fps }, record, { labels: labelsByK, reference });
    // The same overlay against the live loop's own per-frame answer — the
    // model's quad refined on its sample, which is what the overlay draws:
    // where the refinement corrects the model, "off the per-frame ML" is the
    // overlay being right.
    if (referenceLive !== null) {
      score.vsLive = scoreReplay({ frame, fps }, record, { labels: new Map(), reference: referenceLive }).vsReference;
    }
    // A film strip: every ~1.5 s and each capture.
    const tiles = [];
    const step = Math.round(1.5 * fps);
    for (let k = Math.round(0.5 * fps); k < clip.replay.frames; k += step) {
      const overlay = overlayAt(record, k, fps);
      const ref = reference[k];
      const error = overlay !== null && ref !== null ? quadDistance(overlay, ref, frame) : null;
      const label = labelsByK.get(k);
      tiles.push({
        frame: k,
        caption: [
          `${clip.rel.split("/").pop()} t ${(k / fps).toFixed(1)} s`,
          overlay === null ? "overlay: none" : `overlay vs ML ${error === null ? "(ML: none)" : `${(error * 100).toFixed(1)}%`}`,
          label === undefined ? "unlabelled" : label.noDocument ? "label: no document" : "labelled",
        ],
        quads: [
          ...(label?.quad ? [{ quad: label.quad, color: COLORS.truth }] : []),
          { quad: ref, color: COLORS.rejected, dashed: true },
          { quad: overlay, color: error !== null && error <= LOCK_TOLERANCE ? COLORS.good : COLORS.wrong },
        ],
      });
    }
    score.captures.forEach((capture, index) => {
      const still = capture.stillUsed ? record.stills.findIndex((s) => s.k === capture.k) : -1;
      tiles.push({
        ...(still >= 0 ? { still } : { frame: capture.k ?? 0 }),
        caption: [
          `capture ${index + 1}: frame ${capture.k} (${capture.stillUsed ? "still" : "preview"})`,
          `confirm vs ML ${capture.vsReference === null ? "–" : `${(capture.vsReference * 100).toFixed(1)}%`}${capture.verdict ? ` · ${capture.verdict}` : ""}`,
          `from ${capture.cornersFrom ?? "none"}${capture.detector ? `/${capture.detector}` : ""}`,
        ],
        quads: [
          ...(labelsByK.get(capture.k)?.quad ? [{ quad: labelsByK.get(capture.k).quad, color: COLORS.truth }] : []),
          { quad: capture.referenceQuad, color: COLORS.rejected, dashed: true },
          {
            quad: capture.confirmCorners,
            color: capture.vsReference !== null && capture.vsReference <= WRONG_CROP_MAX_CORNER_ERROR ? COLORS.good : COLORS.wrong,
          },
        ],
      });
    });
    const file = `sheets/${clip.key}-replay.jpg`;
    const dataUrl = await page.evaluate((spec) => window.__session.sheet(spec), {
      title: `${clip.rel} · replayed through <ScanFlow> · REAL — local only, never commit`,
      columns: 6,
      legend: [
        { label: "label", color: COLORS.truth },
        { label: "per-frame ML (dashed)", color: COLORS.rejected },
        { label: "overlay / confirm near ML", color: COLORS.good },
        { label: "off it", color: COLORS.wrong },
      ],
      tiles,
    });
    writeFileSync(join(outDir, file), Buffer.from(dataUrl.split(",")[1], "base64"));
    const counts = {};
    for (const e of record.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
    log(
      `real-video: ${clip.rel} replayed — ${score.stream.fps?.toFixed(1) ?? "–"} fps, overlay on ML ${pct(score.vsReference?.onShare, 0)}, ` +
        `${score.captures.map((c) => `capture ${c.stillUsed ? "still" : "preview"} ${c.cornersFrom ?? "none"}`).join(", ") || "no capture"}`,
    );
    if (errors.length > 0) log(`real-video: ${clip.rel} page errors: ${errors.slice(0, 3).join(" | ")}`);
    return {
      tapK,
      tapAtMs,
      prepare: prepared.prepare,
      actions: record.actions.map((a) => a.what).join(" → "),
      eventCounts: counts,
      pageErrors: errors,
      score,
      sheet: file,
      record: { ...record, frames: undefined },
    };
  } finally {
    await context.close();
  }
}

function render(results, labels) {
  const { summary, rows, config } = results;
  const out = [];
  out.push("# Detection bench — real video (REAL)");
  out.push("");
  out.push(REAL_BANNER);
  out.push("");
  out.push(...realHeader(results, labels));
  out.push(
    `- frames: ffmpeg (rotation applied) → replay ${results.extraction.replayFps} fps at ${results.extraction.replayLongEdge} px long edge; ` +
      `sparse = every ${results.extraction.sparseStride}th replay frame at ${results.extraction.sparseLongEdge} px (the labelled set)`,
  );
  out.push(
    `- motion = largest matched corner move between consecutive replay frames (% of the diagonal; > ${(JUMP_THRESHOLD * 100).toFixed(0)} % is a jump); ` +
      `ML and classical disagree beyond ${(DISAGREE_THRESHOLD * 100).toFixed(0)} %`,
  );
  out.push(
    `- replay: the clip is the camera of the real \`<ScanFlow>\` on the bench phone (390×844 @3, touch), in real time; the overlay is compared, on the frame on screen, ` +
      `with the per-frame ML answer (a **proxy**: lag and staleness, not correctness) — on ≤ ${(LOCK_TOLERANCE * 100).toFixed(0)} %, off > ${(WRONG_CROP_MAX_CORNER_ERROR * 100).toFixed(0)} %; ` +
      "the shutter is tapped once, in the steadiest second of the clip by that reference",
  );
  out.push("");
  out.push("## Every replay frame (GT-free)");
  out.push("");
  out.push("| clip | variant | frames | detected | motion p50 / p95 (% diag) | jumps | coverage p50 | ms p50 / p95 |");
  out.push("|---|---|---:|---:|---:|---:|---:|---:|");
  for (const [clip, byVariant] of Object.entries(summary)) {
    for (const [variant, s] of Object.entries(byVariant)) {
      if (variant === "app") continue;
      out.push(
        `| ${clip} | ${variant} | ${s.frames} | ${pct(s.detectionRate)} | ${diag(s.motion.p50)} / ${diag(s.motion.p95)} | ${s.motion.jumps} (${pct(s.motion.jumpRate, 0)}) | ${num(s.coverageP50)} | ${ms(s.msP50)} / ${ms(s.msP95)} |`,
      );
    }
  }
  out.push("");
  const refining = Object.values(summary).some((byVariant) => Object.values(byVariant).some((s) => s.moves !== undefined));
  if (refining) {
    out.push("## Edge refinement moves (GT-free)");
    out.push("");
    out.push(
      `Largest corner move per frame, % of the diagonal, against the same detector's unrefined answer; > ${(REFINE_AUDIT_MOVE * 100).toFixed(0)} % is flagged for a visual audit.`,
    );
    out.push("");
    out.push("| clip | variant | frames refined | moved | move p50 / p95 / max | flagged frames | off image | refine ms p50 / p95 |");
    out.push("|---|---|---:|---:|---:|---|---:|---:|");
    for (const [clip, byVariant] of Object.entries(summary)) {
      for (const [variant, s] of Object.entries(byVariant)) {
        const m = s.moves;
        if (m === undefined) continue;
        const flagged = m.flagged.length === 0 ? "0" : `**${m.flagged.length}** (${m.flagged.slice(0, 12).map((id) => id.split("#").pop()).join(", ")}${m.flagged.length > 12 ? ", …" : ""})`;
        out.push(`| ${clip} | ${variant} | ${m.refined} | ${m.moved} | ${diag(m.moveP50)} / ${diag(m.moveP95)} / ${diag(m.moveMax)} | ${flagged} | ${m.offImage} | ${ms(m.refineMsP50)} / ${ms(m.refineMsP95)} |`);
      }
    }
    out.push("");
  }
  if (config.variants.includes("ml") && config.variants.includes("classical")) {
    out.push("| clip | ML vs classical: both found | disagree | only ML | only classical | distance p50 / p95 (% diag) |");
    out.push("|---|---:|---:|---:|---:|---:|");
    for (const [clip, byVariant] of Object.entries(summary)) {
      const d = byVariant.ml.mlVsClassical;
      out.push(`| ${clip} | ${d.comparable} | ${d.disagree} (${pct(d.rate, 0)}) | ${d.onlyA} | ${d.onlyB} | ${diag(d.distanceP50)} / ${diag(d.distanceP95)} |`);
    }
    out.push("");
  }
  out.push("## Sparse frames");
  out.push("");
  out.push("| clip | variant | frames | detected | labelled |");
  out.push("|---|---|---:|---:|---:|");
  for (const [clip, byVariant] of Object.entries(summary)) {
    for (const [variant, s] of Object.entries(byVariant)) {
      if (variant === "app") continue;
      out.push(`| ${clip} | ${variant} | ${s.sparse.images} | ${pct(s.sparse.detectionRate)} | ${s.labelled} |`);
    }
  }
  out.push("");
  const labelled = Object.entries(summary).filter(([, byVariant]) => Object.values(byVariant).some((s) => s.verdicts));
  if (labelled.length === 0) {
    out.push("No sparse frame has a label yet — `npm run bench:label` to add some. Only the GT-free numbers apply.");
    out.push("");
  } else {
    for (const [clip, byVariant] of labelled) {
      out.push(`### ${clip}, labelled frames`);
      out.push("");
      out.push(detectorTable(Object.fromEntries(Object.entries(byVariant).filter(([, s]) => s.verdicts).map(([v, s]) => [v, s.verdicts]))));
      out.push("");
    }
  }
  const replays = rows.filter((r) => r.kind === "replay");
  if (replays.length > 0) {
    out.push("## Replayed through the app");
    out.push("");
    out.push(
      "| clip | stream fps (skipped) | first pass / overlay ms | overlay shown | vs per-frame ML: on / near / off / on nothing / none | err p50 / p95 (% diag) | lock ms | longest off ms | overlay vs ML motion p50 (% diag) | capture |",
    );
    out.push("|---|---:|---:|---:|---|---:|---:|---:|---:|---|");
    for (const r of replays) {
      const s = r.score;
      const v = s.vsReference;
      const captures = s.captures
        .map((c) => `${c.stillUsed ? "still" : "preview"} ${c.k === null ? "**unidentified frame**" : `f${c.k}`} · ${c.cornersFrom ?? "none"}${c.detector ? `/${c.detector}` : ""} · vs ML ${diag(c.vsReference)}${c.verdict ? ` · **${c.verdict}**` : ""} · ${ms(c.tapToConfirmMs)} ms`)
        .join("<br>");
      out.push(
        `| ${r.clip} | ${s.stream.fps === null ? "–" : s.stream.fps.toFixed(1)} (${s.stream.skipped}) | ${ms(s.firstAcceptedMs)} / ${ms(s.firstShownMs)} | ${pct(s.shownShare, 0)} | ` +
          `${v === null ? "–" : `${pct(v.onShare, 0)} / ${pct(v.nearShare, 0)} / ${pct(v.offShare, 0)} / ${pct(v.onNothingShare, 0)} / ${pct(v.noneShare, 0)}`} | ` +
          `${v === null ? "–" : `${diag(v.errorP50)} / ${diag(v.errorP95)}`} | ${v === null ? "–" : v.lockObservable === false ? "unobservable" : v.timeToLockMs === null ? "**never**" : ms(v.timeToLockMs)} | ${ms(v?.longestOffMs)} | ` +
          `${diag(s.overlayMotion.p50)} vs ${diag(s.referenceMotion.p50)} | ${captures || "**no capture**"} |`,
      );
    }
    out.push("");
    for (const r of replays) {
      const s = r.score;
      out.push(`### ${r.clip} · replay`);
      out.push("");
      if (s.vsLive) {
        const v = s.vsLive;
        out.push(
          `- vs the live loop's own per-frame answer (\`ml+live\`: the model's quad refined on its sample): on ${pct(v.onShare, 0)} / near ${pct(v.nearShare, 0)} / ` +
            `off ${pct(v.offShare, 0)} / on nothing ${pct(v.onNothingShare, 0)} / none ${pct(v.noneShare, 0)}; err p50 ${diag(v.errorP50)} / p95 ${diag(v.errorP95)} % diag`,
        );
      }
      out.push(`- loaded ${r.prepare.frames} frames (${(r.prepare.bytes / 1e6).toFixed(1)} MB) · flow: ${r.actions} · tap at frame ${r.tapK} (${(r.tapAtMs / 1000).toFixed(2)} s)`);
      out.push(
        `- passes: ${Object.entries(s.passes).map(([source, p]) => `${source} ${p.passes} (accepted ${p.accepted}, ${ms(p.msP50)} ms p50, every ${ms(p.intervalP50)} ms)`).join("; ") || "none"}`,
      );
      if (s.vsLabels !== null) {
        const l = s.vsLabels;
        out.push(
          `- vs labels (${l.samples} overlay samples on labelled frames): on ${pct(l.onShare, 0)} / near ${pct(l.nearShare, 0)} / off ${pct(l.offShare, 0)} / on nothing ${pct(l.onNothingShare, 0)} / none ${pct(l.noneShare, 0)}; err p50 ${diag(l.errorP50)} / p95 ${diag(l.errorP95)} % diag`,
        );
      }
      out.push(`- hints: ${s.hints.map((h) => `${(h.t / 1000).toFixed(1)} s ${h.change}`).join(" · ") || "–"}`);
      if (r.pageErrors.length > 0) out.push(`- **page errors**: ${r.pageErrors.slice(0, 3).join(" | ")}`);
      out.push("");
      out.push(`Film strip (real pixels, cache only): [${r.sheet}](${r.sheet})`);
      out.push("");
    }
  }
  if (results.sheets.length > 0) {
    out.push(`Sparse-frame sheets (real pixels, cache only): ${results.sheets.filter((s) => s.variant).map((s) => `[${s.clip} ${s.variant}](${s.file})`).join(" · ")}`);
    out.push("");
  }
  return out.join("\n");
}

export async function runRealVideoSuite({ page, throttle, options, outDir, log }) {
  const prepared = options.real;
  const labels = runLabels();
  const browser = page.context().browser();
  const origin = new URL(page.url()).origin;
  mkdirSync(join(outDir, "sheets"), { recursive: true });
  log(`real-video: ${prepared.clips.length} clip(s) · labels ${labels.counts.total} in ${labels.path} (${labels.reason})`);
  const rows = [];
  const sheets = [];
  const summary = {};
  const scenes = [];
  for (const clip of prepared.clips) {
    const replay = await replayPass(page, throttle, options, clip, log);
    const sparseRows = await sparsePass(page, throttle, options, clip, labels);
    const referenceVariant = options.variants.includes("ml") ? "ml" : options.variants[0];
    const reference = replay.perVariant[referenceVariant].map((r) => (r.det.accepted ? r.det.quad : null));
    const referenceLive = replay.perVariant["ml+live"]?.map((r) => (r.det.accepted ? r.det.quad : null)) ?? null;
    const labelsByK = new Map();
    for (let j = 0; j < clip.sparse.frames; j += 1) {
      const k = j * clip.sparse.stride;
      const label = labelFor(labels.doc, frameId(clip.rel, k, clip.fps));
      if (label !== null) labelsByK.set(k, label);
    }
    scenes.push({ clip: clip.key, rel: clip.rel, replay: clip.replay, sparse: clip.sparse, fps: clip.fps, labelled: labelsByK.size, referenceVariant });

    summary[clip.key] = {};
    for (const variant of options.variants) {
      const perFrame = replay.perVariant[variant];
      const own = sparseRows.filter((r) => r.variant === variant);
      const labelledRows = own.filter((r) => r.score !== null);
      const verdicts = labelledRows.length > 0 ? summarizeGroup(labelledRows) : null;
      const motion = frameToFrameMotion(perFrame.map((r) => (r.det.accepted ? r.det.quad : null)), replay.frame);
      summary[clip.key][variant] = {
        frames: perFrame.length,
        ...detectionSummary(perFrame),
        motion,
        jitterP50: motion.p50,
        sparse: detectionSummary(own),
        labelled: labelledRows.length,
        wrongRate: verdicts?.wrongRate ?? null,
        missRate: verdicts?.missRate ?? null,
        cornerErrorP50: verdicts?.cornerErrorP50 ?? null,
        verdicts,
        ...(perFrame.some((r) => r.move !== null) ? { moves: refineMoveSummary(perFrame), sparseMoves: refineMoveSummary(own) } : {}),
      };
      for (const r of perFrame) rows.push({ kind: "frame", clip: clip.key, k: r.k, variant, det: r.det, move: r.move });
    }
    if (options.variants.includes("ml") && options.variants.includes("classical")) {
      summary[clip.key].ml.mlVsClassical = disagreement(
        replay.perVariant.ml.map((r) => (r.det.accepted ? r.det.quad : null)),
        replay.perVariant.classical.map((r) => (r.det.accepted ? r.det.quad : null)),
        replay.frame,
      );
    }
    rows.push(...sparseRows.map((r) => ({ kind: "sparse", ...r })));

    for (const variant of options.variants) {
      const tiles = sparseRows
        .filter((r) => r.variant === variant)
        .map((r) => {
          const color = r.score === null ? "unlabelled" : !r.det.accepted ? "rejected" : r.score.wrongCrop || r.score.falsePositive ? "wrong" : "good";
          return {
            id: r.id,
            caption: [
              `${clip.key} t ${r.t.toFixed(2)} s`,
              `${variant}: ${r.det.accepted ? `cov ${num(r.det.coverage)}` : r.det.ok ? "gated out" : "nothing"}${r.score === null ? "" : r.score.hasTruth ? (r.score.detected ? (r.score.wrongCrop ? " WRONG" : " ok") : " MISS") : r.score.falsePositive ? " FP" : ""}`,
            ],
            quads: [
              ...(r.label?.quad ? [{ quad: r.label.quad, color: "truth" }] : []),
              { quad: r.det.quad, color: r.det.accepted ? color : "rejected", dashed: !r.det.accepted },
            ],
          };
        });
      const file = await writeSheet(page, outDir, `sheets/${clip.key}-${variant}.jpg`, {
        title: `${clip.rel} · sparse frames · ${variant} · REAL — local only, never commit`,
        columns: 8,
        tiles,
        legend: [
          { label: "label", color: "truth" },
          { label: "unlabelled answer", color: "unlabelled" },
          { label: "right crop", color: "good" },
          { label: "wrong crop", color: "wrong" },
          { label: "gated out (dashed)", color: "rejected" },
        ],
      });
      sheets.push({ clip: clip.key, variant, file });
    }
    // The refinement's flagged frames (moves > REFINE_AUDIT_MOVE): reloaded
    // with a thumbnail and drawn before (dashed amber) / after (blue), for a
    // person to look at, locally.
    const flagged = options.variants
      .flatMap((variant) => replay.perVariant[variant].filter((r) => r.move?.flagged).map((r) => ({ ...r, variant })))
      .slice(0, 48);
    if (flagged.length > 0) {
      for (const r of flagged) {
        await page.evaluate(
          ([i, url, thumb]) => window.__bench.load(i, url, { thumbLongEdge: thumb }),
          [`${r.id}@audit`, replayUrl(clip, r.k), THUMB_LONG_EDGE],
        );
        await page.evaluate((i) => window.__bench.release(i), `${r.id}@audit`);
      }
      const file = await writeSheet(page, outDir, `sheets/${clip.key}-refine-audit.jpg`, {
        title: `${clip.rel} · refinement moves > ${(REFINE_AUDIT_MOVE * 100).toFixed(0)} % · REAL — local only, never commit`,
        columns: 6,
        tiles: flagged.map((r) => ({
          id: `${r.id}@audit`,
          caption: [`frame ${r.k} · ${r.variant}`, `max move ${diag(r.move.max)} %`, (r.det.refine?.modes ?? []).map((m) => m[0]).join("")],
          quads: [
            { quad: r.det.refine.input, color: "rejected", dashed: true },
            { quad: r.det.quad, color: "unlabelled" },
          ],
        })),
        legend: [
          { label: "before refinement (dashed)", color: "rejected" },
          { label: "after refinement", color: "unlabelled" },
        ],
      });
      sheets.push({ clip: clip.key, variant: "refine-audit", file });
    }
    await page.evaluate(() => window.__bench.reset());

    if (!options.skipReplay) {
      const played = await replayThroughApp(browser, origin, options, clip, { reference, referenceLive, labelsByK, frame: replay.frame }, outDir, log);
      rows.push({ kind: "replay", clip: clip.key, ...played });
      sheets.push({ clip: clip.key, replay: true, file: played.sheet });
      const v = played.score.vsReference;
      summary[clip.key].app = {
        offShare: v?.offShare ?? null,
        onShare: v?.onShare ?? null,
        noneShare: v?.noneShare ?? null,
        onShareVsLive: played.score.vsLive?.onShare ?? null,
        offShareVsLive: played.score.vsLive?.offShare ?? null,
        timeToLockMs: v?.timeToLockMs ?? null,
        longestOffMs: v?.longestOffMs ?? null,
        capturesVsReference: played.score.captures.map((c) => c.vsReference),
        // Captures whose frame could not be named by id: missing data.
        unidentifiedCaptures: played.score.unidentifiedCaptures,
      };
    }
  }
  const extraction = { replayFps: REPLAY_FPS, replayLongEdge: REPLAY_LONG_EDGE, sparseStride: SPARSE_STRIDE, sparseLongEdge: SPARSE_LONG_EDGE };
  return {
    synthetic: false,
    rows,
    scenes,
    sheets,
    summary,
    extraction,
    labels: { path: labels.path, reason: labels.reason, counts: labels.counts },
    render: (results) => render({ ...results, extraction }, labels),
  };
}
