/**
 * The session suite: the real `<ScanFlow>` on an emulated phone, watching an
 * emulated document being scanned.
 *
 * Each run gets a fresh browser context shaped like a phone — 390×844 CSS px
 * at DPR 3, touch, an Android user agent — so the library mounts its phone
 * flow, and a fresh page (the library keeps per-session state in module
 * scope, like the still-capture failure count). The page pre-renders the
 * session's frames, the flow is mounted, and the scripted user goes through
 * the permission primer, aims, taps the shutter and confirms. The probe's
 * events are scored against the ground truth of the frame that was on screen
 * when each happened (`session-score.mjs`).
 *
 * With `--cpu N` the throttle is on for the whole played session — the app
 * runs in real time, all of it on the main thread — and off while frames are
 * pre-rendered.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpuThrottle } from "../browser.mjs";
import {
  CONTENT_CLIP_MIN_FRACTION,
  LOCK_TOLERANCE,
  MAX_SAMPLE_GAP_MS,
  WRONG_CROP_MAX_CORNER_ERROR,
  offImage,
  percentile,
  quadDistance,
} from "../metrics.mjs";
import { CAPTURE_FAILURES, PAGELESS_CAPTURE, scoreSession, toPoints, UNSCORED_CAPTURE } from "../session-score.mjs";
import { COLORS } from "../app/sheets.js";

/** What the bench's phone looks like to the page. */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
};

/** The stream the fake camera delivers, unless `--stream` says otherwise. */
export const DEFAULT_STREAM = "720x1280";

const pct = (v, digits = 1) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(digits)} %`);
const diag = (v) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(2)}`);
const ms = (v) => (v === null || v === undefined ? "–" : `${Math.round(v)}`);

/** The stale-overlay cell: ms, or what kept it from being measured. */
function staleCell(s) {
  if (s.staleAfterSwap === undefined) return "–";
  if (s.staleAfterSwap === "stuck") return "**stuck**";
  if (s.staleAfterSwap === "unobserved") return "**unobserved**";
  return ms(s.staleAfterSwapMs);
}

function sessionRow(run) {
  const s = run.score;
  const shown = s.hold ?? s.negative ?? null;
  const passes = Object.entries(s.passes)
    .map(
      ([source, p]) =>
        `${source} ${p.passes}${p.accepted > 0 ? ` (acc ${p.accepted}: on page ${p.acceptedOnPage}, wrong ${p.wrong}${p.falsePositive ? `, FP ${p.falsePositive}/${p.noPagePasses}` : ""})` : ""}` +
        (p.unknownPasses > 0 ? ` · ${p.unknownPasses} unscored` : ""),
    )
    .join("; ");
  const captures = s.captures
    .map(
      (c) =>
        `${c.verdict}${c.atConfirm ? ` ${diag(c.atConfirm.max)}` : ""}${c.contentClipped ? " **content clipped**" : ""}` +
        (c.refine?.changed && c.refine.seeded ? ` (unrefined: ${c.unrefinedVerdict} ${diag(c.unrefinedAtConfirm?.max)})` : "") +
        (c.finalVerdict !== c.verdict ? ` → final ${c.finalVerdict}` : "") +
        ` [${c.stillUsed ? "still" : "preview"} · ${c.cornersFrom ?? "none"}${c.detector ? `/${c.detector}` : ""}]`,
    )
    .join("<br>");
  return (
    `| ${run.session} | ${run.seed} | ${run.scene} | ${s.stream.fps === null ? "–" : s.stream.fps.toFixed(1)} (${s.stream.skipped}) | ` +
    `${s.timeToLockMs === undefined ? "–" : s.timeToLockMs === null ? "**never**" : ms(s.timeToLockMs)} | ` +
    `${shown === null ? "–" : `${pct(shown.lockedShare, 0)} / ${pct(shown.wrongShare, 0)} / ${pct(shown.noneShare, 0)}`} | ` +
    `${s.jitter ? `${diag(s.jitter.rms)} / ${diag(s.truthMotion?.rms)}` : "–"} | ` +
    `${staleCell(s)} | ` +
    `${s.falseLocksPerMinute === undefined ? "–" : `${s.falseLocksPerMinute.toFixed(1)} (shown ${pct(s.falseLockExposure?.share, 0)})`} | ${passes || "–"} | ` +
    `${[captures, s.missingCaptures > 0 ? `**${s.missingCaptures} of ${s.expectedCaptures} tap(s) made no capture**` : ""].filter(Boolean).join("<br>") || "**no capture**"} | ` +
    `${s.captures.map((c) => ms(c.tapToConfirmMs)).join(", ") || "–"} |`
  );
}

function render(results) {
  const out = [];
  const env = results.environment;
  const cfg = results.config;
  out.push("# Detection bench — session suite (SYNTHETIC)");
  out.push("");
  out.push(
    "> The real `<ScanFlow>` on an emulated phone and an emulated camera, scanning synthetic scenes. " +
      "Synthetic numbers are **never** comparable with real-media results and are reported separately by design.",
  );
  out.push("");
  out.push(`- run: ${results.createdAt} · commit ${results.git.commit}${results.git.dirty ? " (dirty)" : ""}`);
  out.push(`- browser: ${env.executable} · WebGL: ${env.renderer}`);
  out.push(
    `- phone: ${PHONE.viewport.width}×${PHONE.viewport.height} CSS px @ DPR ${PHONE.deviceScaleFactor}, touch, Android UA · CPU throttle ${cfg.cpu}× (whole session)`,
  );
  out.push(
    `- camera: ${cfg.stream} portrait preview at 30 fps — frames **pre-rendered** (SwiftShader draws one in ~0.1 s) and pushed into ` +
      "`canvas.captureStream()` on the camera clock; late frames are skipped, never slowed. Stills are rendered on demand at the size the app asks " +
      "for (4000×3000 sensor), exposed 90 ms after `takePhoto()`, delivered ≥ 350 ms after it.",
  );
  out.push(
    `- scoring: lock = displayed quad within ${(LOCK_TOLERANCE * 100).toFixed(0)} % of the diagonal of the truth for ≥ 300 ms, observed throughout ` +
      `(samples ≤ ${MAX_SAMPLE_GAP_MS} ms apart); wrong = a shown corner > ${(WRONG_CROP_MAX_CORNER_ERROR * 100).toFixed(0)} % off (only corners the frame shows are judged); ` +
      'the overlay is "shown" at opacity ≥ 0.5. Overlay shares are **time-weighted** (a sample holds until the next; a longer gap is unobserved). ' +
      "Every event is scored against the frame the `<video>` was presenting when it happened; a capture names its image by id (the grab's frame, the still's attempt). " +
      "Corner errors are % of the frame diagonal.",
  );
  out.push(
    "- captures: **proposal** = the corners the confirm screen opened with; **final** = what the user left with (the scripted user never edits, " +
      "so a missing proposal becomes the editor's default crop); **content clipped** = the crop cut into a line of text, an identifier or a mark " +
      `(> ${(CONTENT_CLIP_MIN_FRACTION * 100).toFixed(0)} % of a box); **severe** = a failed capture or clipped content; **page-less** = an image with no page became a capture.`,
  );
  out.push("");
  if (results.summary) {
    out.push("## Summary");
    out.push("");
    out.push(
      "Capture verdicts over the scripted taps. **unrefined** = the same captures scored with the corners the edge refinement " +
        "was given (what the confirm screen opened with before refinement existed) — paired, same run.",
    );
    out.push("");
    out.push(
      "| session | runs | never locked | capture wrong: unrefined → refined | shown / final wrong | content clipped | severe | page-less | " +
        "corners at confirm p50: unrefined → refined / max (% diag) | seeds off image | refine ms p50 / p95 | missing data |",
    );
    out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
    for (const [session, { all: a }] of Object.entries(results.summary)) {
      out.push(
        `| ${session} | ${a.runs} | ${a.neverLocked} | ${pct(a.captureWrongRateUnrefined, 0)} → **${pct(a.captureWrongRate, 0)}** | ` +
          `${pct(a.captureWrongRateShown, 0)} / ${pct(a.captureWrongRateFinal, 0)} | ${a.contentClippedCaptures} | **${pct(a.severeCaptureRate, 0)}** | ${a.pagelessCaptures} | ` +
          `${diag(a.cornersAtConfirmP50Unrefined)} → ${diag(a.cornersAtConfirmP50)} / ${diag(a.cornersAtConfirmMax)} | ${a.confirmOffImage} | ${ms(a.refineMsP50)} / ${ms(a.refineMsP95)} | ` +
          `${a.missingData === 0 ? "–" : `**${a.missingData}**`} |`,
      );
    }
    out.push("");
  }
  out.push("## Sessions");
  out.push("");
  out.push(
    "| session | seed | scene | stream fps (skipped) | time to lock ms | hold: on page / wrong / none | jitter rms shown / truth (% diag) | stale after swap ms | false locks /min | detect passes | captures: verdict err@confirm [image · corners from] | tap→confirm ms |",
  );
  out.push("|---|---:|---|---:|---:|---|---:|---:|---:|---|---|---:|");
  for (const run of results.rows) out.push(sessionRow(run));
  out.push("");
  for (const run of results.rows) {
    const s = run.score;
    out.push(`## ${run.session} · seed ${run.seed}`);
    out.push("");
    out.push(`${run.describe}.`);
    out.push("");
    out.push(`- scene: ${run.scene} · prepared in ${(run.prepare.totalMs / 1000).toFixed(1)} s (${run.prepare.frames} frames, ${run.prepare.renderMsPerFrame.toFixed(0)} ms each) · flow: ${run.actions}`);
    if (s.partial) {
      out.push(
        `- page cut off by the frame: overlay shown ${pct(1 - s.partial.noneShare, 0)} of the time, ` +
          `its corners p50 ${diag(s.partial.errorP50)} / p95 ${diag(s.partial.errorP95)} % diag from the true (out-of-frame) corners`,
      );
    }
    if (s.negative) {
      out.push(
        `- no page in view: a quad was shown ${pct(s.falseLockExposure?.share, 0)} of the observed time (${ms(s.falseLockExposure?.shownMs)} ms); ` +
          `${s.falseLocksPerMinute.toFixed(1)} false locks/min (≥ 300 ms)`,
      );
    }
    if (s.missingData?.length > 0) out.push(`- **missing data**: ${s.missingData.join("; ")}`);
    if (s.holdAfterSwap) {
      const stale =
        s.staleAfterSwap === "stuck"
          ? "**never left the old page**"
          : s.staleAfterSwap === "unobserved"
            ? "**not observed**"
            : `${ms(s.staleAfterSwapMs)} ms`;
      out.push(
        `- after the swap: stale overlay ${stale}, ` +
          `lock on the new page ${s.timeToLockAfterSwapMs === null ? "**never**" : `${ms(s.timeToLockAfterSwapMs)} ms`}, ` +
          `hold on page / wrong / none ${pct(s.holdAfterSwap.lockedShare, 0)} / ${pct(s.holdAfterSwap.wrongShare, 0)} / ${pct(s.holdAfterSwap.noneShare, 0)}`,
      );
    }
    if (s.hold) {
      out.push(`- hold: shown corners p50 ${diag(s.hold.errorP50)} / p95 ${diag(s.hold.errorP95)} % diag from the page`);
    }
    out.push(`- hints: ${s.hints.map((h) => `${(h.t / 1000).toFixed(1)} s ${h.change}`).join(" · ") || "–"}`);
    out.push("");
    if (s.captures.length > 0) {
      out.push(
        "| tap (s) | still | image | corners from | detector | buffer age ms | ML wait ms | corners at confirm: max / mean (% diag) | proposal | shown | final | content | capture ms | tap→confirm ms |",
      );
      out.push("|---:|---|---|---|---|---:|---:|---:|---|---|---|---|---:|---:|");
      for (const c of s.captures) {
        const content =
          c.contentClipped === null ? "n/a" : c.contentClipped ? `**clipped**${c.identifierClipped ? " (identifier)" : ""}` : c.marginClipped ? "margin only" : "kept";
        out.push(
          `| ${(c.tapAt / 1000).toFixed(2)} | ${c.stillAttempted ? (c.stillOk ? `${c.stillSize.join("×")} in ${ms(c.stillMs)} ms` : `failed (${ms(c.stillMs)} ms)`) : "–"} | ` +
            `${c.imageSource} (${c.frame.join("×")}) | ${c.cornersFrom ?? "none"} | ${c.detector ?? "–"} | ${ms(c.bufferAgeMs)} | ${ms(c.mlWaitMs)} | ` +
            `${c.atConfirm ? `${diag(c.atConfirm.max)} / ${diag(c.atConfirm.mean)}` : "–"} | ${c.verdict}${c.hasTruth && c.truthWhole === false ? " (page cut off)" : ""}${c.orderWrong ? " (corner order)" : ""} | ` +
            `${c.shownVerdict} | ${c.finalVerdict}${c.finalContentClipped ? " (content clipped)" : ""} | ${content} | ${ms(c.captureMs)} | ${ms(c.tapToConfirmMs)} |`,
        );
      }
      out.push("");
    }
    if (run.sheet) out.push(`Film strip: [${run.sheet}](${run.sheet})`, "");
  }
  return out.join("\n");
}

/** The overlay shown when frame `k` was on screen, and the last accepted pass. */
function overlayFor(record, k) {
  const shown = record.presented.find((p) => p.k >= k);
  const at = shown?.at ?? record.startedAt + (k * 1000) / 30;
  let overlay = null;
  let detect = null;
  for (const e of record.events) {
    if (e.type === "overlay" && e.t <= at + 50) overlay = e;
    if (e.type === "detect" && e.accepted && e.frameAt <= at) detect = e;
  }
  return {
    overlay: overlay !== null && overlay.quad !== null && overlay.opacity >= 0.5 ? toPoints(overlay.quad) : null,
    detect: detect === null ? null : { quad: toPoints(detect.quad), source: detect.source },
  };
}

function filmStrip(script, record, score) {
  const frame = script.frame;
  const times = new Set();
  for (const value of Object.values(script.marks)) if (Number.isFinite(value)) times.add(value + 200);
  for (let t = 500; t < script.duration; t += 1500) times.add(t);
  const frames = [...new Set([...times].map((t) => Math.min(record.frames.length - 1, Math.round((t * 30) / 1000))))];
  const tiles = frames
    .sort((a, b) => a - b)
    .map((k) => {
      const truth = record.frames[k];
      const { overlay, detect } = overlayFor(record, k);
      const error = overlay !== null && truth.quad !== null ? quadDistance(overlay, truth.quad, frame) : null;
      return {
        frame: k,
        caption: [
          `${script.id} t ${(truth.t / 1000).toFixed(1)} s`,
          overlay === null ? "overlay: none" : `overlay err ${error === null ? "(no page)" : `${(error * 100).toFixed(1)}%`}`,
          detect === null ? "no accepted pass yet" : `last pass: ${detect.source}`,
        ],
        quads: [
          { quad: truth.quad ?? null, color: COLORS.truth },
          { quad: detect?.quad ?? null, color: COLORS.rejected, dashed: true },
          { quad: overlay, color: error !== null && error <= LOCK_TOLERANCE ? COLORS.good : COLORS.wrong },
        ],
      };
    });
  score.captures.forEach((capture, index) => {
    const tile = capture.stillIndex !== null ? { still: capture.stillIndex } : capture.k !== null ? { frame: capture.k } : null;
    if (tile === null) return;
    tiles.push({
      ...tile,
      caption: [
        `capture ${index + 1}: ${capture.imageSource}`,
        `confirm: ${capture.verdict}${Number.isFinite(capture.atConfirm?.max) ? ` ${(capture.atConfirm.max * 100).toFixed(1)}%` : ""}`,
        `from ${capture.cornersFrom ?? "none"}${capture.detector ? `/${capture.detector}` : ""}`,
      ],
      quads: [
        { quad: capture.truthCorners, color: COLORS.truth },
        { quad: capture.confirmCorners, color: capture.verdict === "good" ? COLORS.good : COLORS.wrong },
      ],
    });
  });
  return tiles;
}

export async function runSessionSuite({ page, throttle: _unused, options, outDir, log, environment }) {
  const browser = page.context().browser();
  const origin = new URL(page.url()).origin;
  const rows = [];
  const sheets = [];
  const sheetDir = join(outDir, "sheets");
  mkdirSync(sheetDir, { recursive: true });
  const listing = await openSessionPage(browser, origin);
  const known = await listing.page.evaluate(() => window.__session.sessions());
  await listing.context.close();
  const ids = options.sessions ?? known.map((s) => s.id);
  for (const id of ids) {
    if (!known.some((s) => s.id === id)) throw new Error(`unknown session "${id}" (known: ${known.map((s) => s.id).join(", ")})`);
  }
  for (const id of ids) {
    for (let seed = 1; seed <= options.sessionSeeds; seed += 1) {
      const started = Date.now();
      const { context, page: phone, errors } = await openSessionPage(browser, origin);
      try {
        const prepared = await phone.evaluate(
          ([name, s, size]) => window.__session.prepare(name, s, { size }),
          [id, seed, options.stream],
        );
        const throttle = await cpuThrottle(phone);
        await throttle.set(options.cpu);
        let record;
        try {
          record = await phone.evaluate(() => window.__session.run());
        } finally {
          await throttle.set(1);
        }
        const script = prepared.script;
        const score = scoreSession(script, record);
        const tiles = filmStrip(script, record, score);
        const file = `sheets/${id}-${seed}.jpg`;
        const dataUrl = await phone.evaluate((spec) => window.__session.sheet(spec), {
          title: `${id} · seed ${seed} · SYNTHETIC`,
          columns: 6,
          legend: [
            { label: "truth", color: COLORS.truth },
            { label: "overlay on page", color: COLORS.good },
            { label: "overlay off / wrong corners", color: COLORS.wrong },
            { label: "last accepted pass (dashed)", color: COLORS.rejected },
          ],
          tiles,
        });
        writeFileSync(join(outDir, file), Buffer.from(dataUrl.split(",")[1], "base64"));
        sheets.push({ session: id, seed, file });
        const describe = known.find((s) => s.id === id).describe;
        const counts = {};
        for (const e of record.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
        rows.push({
          session: id,
          seed,
          describe,
          scene: `${script.scene.family} #${script.scene.seed}${script.scene.setting ? ` ${script.scene.setting}` : ""}`,
          prepare: prepared.prepare,
          actions: record.actions.map((a) => a.what).join(" → "),
          eventCounts: counts,
          pageErrors: errors,
          score,
          sheet: file,
          // Raw material for anyone re-scoring: every event and every frame's truth.
          record: { ...record, frames: record.frames.map((f) => ({ t: f.t, quad: f.quad, whole: f.whole, share: f.share })) },
          script: { ...script, scene: undefined, sceneFamily: script.scene.family },
        });
        log(
          `session: ${id} #${seed} — ${((Date.now() - started) / 1000).toFixed(0)} s ` +
            `(prepared ${(prepared.prepare.totalMs / 1000).toFixed(0)} s, ${score.stream.fps?.toFixed(1) ?? "–"} fps, ` +
            `${score.captures.map((c) => c.verdict).join(", ") || "no capture"})`,
        );
        if (errors.length > 0) log(`session: ${id} #${seed} page errors: ${errors.slice(0, 3).join(" | ")}`);
      } finally {
        await context.close();
      }
    }
  }
  const summary = summarize(rows);
  return {
    synthetic: true,
    rows,
    scenes: [],
    sheets,
    summary,
    render: (results) => render({ ...results, config: { ...results.config, stream: options.stream } }),
  };
}

/** A fresh phone-shaped context on the session page, ready to prepare. */
export async function openSessionPage(browser, origin) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}/page-session.html`);
  await page.waitForFunction(() => window.__sessionReady === true, null, { timeout: 60_000 });
  return { context, page, errors };
}

/**
 * `{ [session]: headline numbers }`, averaged over seeds — what `--compare` reads.
 *
 * The capture rates are over the taps the script made, not the captures that
 * happened: a tap that produced nothing, or a capture whose confirm screen
 * never opened, is a failed capture — never a smaller denominator. The
 * proposal, the crop the editor showed and the final crop each get their own
 * rate; a page-less capture is its own count, not a wrong crop and not "ok";
 * `missingData` counts what could not be measured at all.
 */
export function summarize(rows) {
  const out = {};
  for (const row of rows) {
    const entry = (out[row.session] ??= {
      runs: 0,
      locks: [],
      wrongCaptures: 0,
      wrongUnrefined: 0,
      wrongShown: 0,
      wrongFinal: 0,
      severe: 0,
      contentClipped: 0,
      contentJudged: 0,
      contentUnknown: 0,
      pageless: 0,
      unscored: 0,
      neverOpened: 0,
      missing: 0,
      captures: 0,
      confirmErrors: [],
      unrefinedErrors: [],
      refineMs: [],
      offImage: 0,
      stale: [],
      stuck: 0,
      falseLocks: [],
      exposure: [],
      missingData: 0,
    });
    entry.runs += 1;
    if (row.score.timeToLockMs !== undefined) entry.locks.push(row.score.timeToLockMs);
    const missing = row.score.missingCaptures ?? 0;
    entry.missing += missing;
    entry.captures += row.score.captures.length + missing;
    entry.wrongCaptures += missing;
    entry.wrongUnrefined += missing;
    entry.wrongShown += missing;
    entry.wrongFinal += missing;
    entry.severe += missing;
    entry.missingData += row.score.missingData?.length ?? 0;
    for (const c of row.score.captures) {
      const failed = (verdict) => CAPTURE_FAILURES.has(verdict);
      if (failed(c.verdict)) entry.wrongCaptures += 1;
      if (failed(c.unrefinedVerdict ?? c.verdict)) entry.wrongUnrefined += 1;
      if (failed(c.shownVerdict ?? c.verdict)) entry.wrongShown += 1;
      if (failed(c.finalVerdict ?? c.verdict)) entry.wrongFinal += 1;
      if (failed(c.verdict) || c.contentClipped === true) entry.severe += 1;
      if (c.contentClipped !== null && c.contentClipped !== undefined) entry.contentJudged += 1;
      if (c.contentClipped === true) entry.contentClipped += 1;
      if (c.contentUnknown === true) entry.contentUnknown += 1;
      if (c.verdict === PAGELESS_CAPTURE || c.pagelessCapture) entry.pageless += 1;
      if (c.verdict === UNSCORED_CAPTURE) entry.unscored += 1;
      if (c.verdict === "confirm never opened") entry.neverOpened += 1;
      if (Number.isFinite(c.atConfirm?.max)) entry.confirmErrors.push(c.atConfirm.max);
      if (Number.isFinite(c.unrefinedAtConfirm?.max)) entry.unrefinedErrors.push(c.unrefinedAtConfirm.max);
      if (Number.isFinite(c.refine?.ms)) entry.refineMs.push(c.refine.ms);
      if (offImage(c.confirmCorners)) entry.offImage += 1;
    }
    if (row.score.staleAfterSwap === "stuck") entry.stuck += 1;
    if (Number.isFinite(row.score.staleAfterSwapMs)) entry.stale.push(row.score.staleAfterSwapMs);
    if (row.score.falseLocksPerMinute !== undefined) entry.falseLocks.push(row.score.falseLocksPerMinute);
    if (Number.isFinite(row.score.falseLockExposure?.share)) entry.exposure.push(row.score.falseLockExposure.share);
  }
  const avg = (list) => (list.length > 0 ? list.reduce((s, v) => s + v, 0) / list.length : null);
  return Object.fromEntries(
    Object.entries(out).map(([session, e]) => [
      session,
      {
        all: {
          runs: e.runs,
          neverLocked: e.locks.filter((v) => v === null).length,
          timeToLockMs: e.locks.filter((v) => v !== null).reduce((s, v, _, a) => s + v / a.length, 0) || null,
          // (a) the proposal the confirm screen opened with
          captureWrongRate: e.captures > 0 ? e.wrongCaptures / e.captures : null,
          // (b) the crop the editor showed, (c) the crop the user left with
          captureWrongRateShown: e.captures > 0 ? e.wrongShown / e.captures : null,
          captureWrongRateFinal: e.captures > 0 ? e.wrongFinal / e.captures : null,
          // A failed capture, or a crop that cut into text, an identifier or a
          // mark — unknown (null) when a captured page's content is.
          severeCaptureRate: e.captures > 0 && e.contentUnknown === 0 ? e.severe / e.captures : null,
          contentClippedCaptures: e.contentClipped,
          contentJudgedCaptures: e.contentJudged,
          contentUnknownCaptures: e.contentUnknown,
          // An image with no page became a capture: its own class.
          pagelessCaptures: e.pageless,
          pagelessCaptureRate: e.captures > 0 ? e.pageless / e.captures : null,
          missingCaptures: e.missing,
          confirmNeverOpened: e.neverOpened,
          unscoredCaptures: e.unscored,
          cornersAtConfirmMax: e.confirmErrors.length > 0 ? Math.max(...e.confirmErrors) : null,
          cornersAtConfirmP50: e.confirmErrors.length > 0 ? percentile(e.confirmErrors, 50) : null,
          // The same captures as the refinement's input saw them (paired, same run).
          captureWrongRateUnrefined: e.captures > 0 ? e.wrongUnrefined / e.captures : null,
          cornersAtConfirmP50Unrefined: e.unrefinedErrors.length > 0 ? percentile(e.unrefinedErrors, 50) : null,
          refineMsP50: e.refineMs.length > 0 ? percentile(e.refineMs, 50) : null,
          refineMsP95: e.refineMs.length > 0 ? percentile(e.refineMs, 95) : null,
          // Confirm screens seeded with a corner off the captured image (the contract says none).
          confirmOffImage: e.offImage,
          // Over the runs whose overlay left the old page; the ones that never did are `staleStuck`.
          staleAfterSwapMs: e.stale.length > 0 ? Math.max(...e.stale) : null,
          staleStuck: e.stuck,
          falseLocksPerMinute: avg(e.falseLocks),
          // Share of the page-less time a quad was on screen, time-weighted.
          falseLockExposure: avg(e.exposure),
          // Windows, swaps and captures that could not be measured.
          missingData: e.missingData,
        },
      },
    ]),
  );
}
