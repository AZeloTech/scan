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

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpuThrottle } from "../browser.mjs";
import { BENCH_DIR } from "../paths.mjs";
import { FRAME_CACHE_VERSION } from "../app/session-player.js";
import { buildSession, loopedFrame } from "../emulator/index.js";
import {
  CONTENT_CLIP_MIN_FRACTION,
  LOCK_TOLERANCE,
  MAX_SAMPLE_GAP_MS,
  WRONG_CROP_MAX_CORNER_ERROR,
  offImage,
  percentile,
  quadDistance,
} from "../metrics.mjs";
import { CAPTURE_FAILURES, hintSeries, PAGELESS_CAPTURE, scoreSession, toPoints, UNSCORED_CAPTURE } from "../session-score.mjs";
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

/**
 * The frame-cache key of a session's pre-rendered frames: the script itself
 * (as `buildSession` builds it, JSON), the stream size, and everything that
 * turns a script into pixels — the emulator's source except the session
 * registry's own scripts (`session.js` up to its first `registerSession`: the
 * code that plays a script, not the code that writes one — a script change
 * is already in the script), the player's render settings and the browser
 * build. Any change to any of them is another key, so a stale frame is never
 * replayed — and editing one session's script re-renders that session only.
 */
export function frameCacheKey(id, seed, stream, browserVersion) {
  const hash = createHash("sha256");
  const dir = join(BENCH_DIR, "emulator");
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".js")).sort()) {
    const source = readFileSync(join(dir, name), "utf8");
    hash.update(name).update(name === "session.js" ? source.slice(0, source.indexOf("registerSession({")) : source);
  }
  hash.update(JSON.stringify(buildSession(id, seed, { size: stream })));
  hash.update(FRAME_CACHE_VERSION).update(browserVersion);
  return `${id}-${seed}-${stream}-${hash.digest("hex").slice(0, 16)}`;
}

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
    `- phone: ${cfg.viewport ?? `${PHONE.viewport.width}x${PHONE.viewport.height}`} CSS px @ DPR ${PHONE.deviceScaleFactor}, touch, Android UA · CPU throttle ${cfg.cpu}× (whole session)`,
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
  if (results.summary) {
    const n = (v, d = 0) => (v === null || v === undefined ? "–" : Number(v).toFixed(d));
    out.push("## Live loop");
    out.push("");
    out.push(
      "The overlay over the hold windows, **pooled over runs and time-weighted** (on page = within 2 % of the diagonal; " +
        "wrong = a corner > 3 % off; none = nothing shown). Time to lock over runs — a run that never locked counts as never in the p50. " +
        "Stale = how long the overlay stayed on a swapped-out page (p95 over runs that left it). Exposure = share of an empty desk's time a quad was shown.",
    );
    out.push("");
    out.push(
      "| session | hold on page / wrong / none | after swap on page / wrong | time to lock p50 / mean (never) ms | stale p95 ms | exposure | tap→confirm p50 ms | capture fall-through / downgraded |",
    );
    out.push("|---|---|---|---:|---:|---:|---:|---:|");
    for (const [session, { all: a }] of Object.entries(results.summary)) {
      out.push(
        `| ${session} | ${pct(a.holdOnPageShare, 0)} / ${pct(a.holdWrongShare, 0)} / ${pct(a.holdNoneShare, 0)} | ` +
          `${pct(a.holdAfterSwapOnPageShare, 0)} / ${pct(a.holdAfterSwapWrongShare, 0)} | ${ms(a.timeToLockP50)} / ${ms(a.timeToLockMean)} (${a.neverLocked}) | ` +
          `${ms(a.staleAfterSwapP95)} | ${pct(a.falseLockExposure, 0)} | ${ms(a.tapToConfirmP50)} | ${a.captureFallThrough} / ${a.captureDowngraded ?? "n/a"} |`,
      );
    }
    out.push("");
    const policies = Object.entries(results.summary).filter(([, { all: a }]) => (a.fallThroughPolicy?.fellThrough ?? 0) > 0);
    if (policies.length > 0) {
      out.push(
        "Captures whose corners came from the **classical fall-through** (the model answered no page on the capture), judged as they were and as the " +
          "no-fall-through policy would have opened them (the buffered live quad where one could travel, else none) — paired, same image:",
      );
      out.push("");
      out.push("| session | fall-through captures | failed: with / without | severe: with / without |");
      out.push("|---|---:|---:|---:|");
      for (const [session, { all: a }] of policies) {
        const p = a.fallThroughPolicy;
        out.push(`| ${session} | ${p.fellThrough} | ${p.wrongWith} / ${p.wrongWithout} | ${p.severeWith} / ${p.severeWithout} |`);
      }
      out.push("");
    }
    const guided = Object.entries(results.summary).filter(([, { all: a }]) => a.guidance);
    if (guided.length > 0) {
      out.push("## Guidance");
      out.push("");
      out.push(
        "The single hint over the viewfinder, the ready cue on the brackets and auto-capture. **Hint windows**: time-weighted share of each scripted " +
          "condition's window with the expected hint shown / another hint shown (wrong) / none, and the time from the condition's start to the first " +
          "correct hint (p50; never = not within the window). **Churn**: hint changes per second of live viewfinder, and changes within 1.5 s of the " +
          "previous one. **Hold hints**: share of the default sessions' framed holds with a hint up. **Ready**: precision = share of cue-on time with " +
          "the overlay on the page (≤ 2 % diag); recall = share of the scripted ready windows with the cue on; on no page = cue-on ms over a frame with " +
          "no page. **Auto**: automatic captures, false fires (a page-less session, or no page in the image), fires inside a tremor window, pages that " +
          "got one, repeat fires on a page, fires where none is owed (a `noFire` window of the breaker sessions — the page cut off, a hot spot on it, still moving — or a window where a hint other than \"searching\" is owed), latency from the scene becoming stable (p50); failed / severe of automatic vs manual captures. **Layout**: " +
          "viewfinder box samples that moved or resized.",
      );
      out.push("");
      out.push("| session | hint windows: correct / wrong / none (first correct p50 ms) | churn /s (fast) | hold hints | ready precision / recall / on no page ms | auto: fires / false / tremor / pages fired of / repeat / not owed / latency p50 ms | auto failed/severe of n · manual failed/severe of n | layout shifts |");
      out.push("|---|---|---:|---:|---:|---:|---:|---:|");
      for (const [session, { all: a }] of guided) {
        const g = a.guidance;
        const windows = Object.entries(g.windows)
          .map(([name, w]) => `${name}: ${pct(w.share, 0)} / ${pct(w.wrongShare, 0)} / ${pct(w.noneShare, 0)} (${w.firstCorrectP50 === null ? "never" : ms(w.firstCorrectP50)}${w.neverCorrect ? `, ${w.neverCorrect} never` : ""})`)
          .join("<br>");
        out.push(
          `| ${session} | ${windows || "–"} | ${g.changesPerSecond === null ? "–" : g.changesPerSecond.toFixed(2)} (${g.fastChanges}) | ${pct(g.holdHintShare, 0)} | ` +
            `${pct(g.readyPrecision, 0)} / ${pct(g.readyRecall, 0)} / ${ms(g.readyNoPageMs)} | ` +
            `${g.fires} / ${g.falseFires} / ${g.firesDuringTremor} / ${g.pagesFired} of ${g.pages} / ${g.repeatFires} / ${(g.firesInNoFire ?? 0) + (g.firesInHintWindow ?? 0)} / ${ms(g.fireLatencyP50)} | ` +
            `${g.autoCaptures.failed}/${g.autoCaptures.severe} of ${g.autoCaptures.captures} · ${g.manualCaptures.failed}/${g.manualCaptures.severe} of ${g.manualCaptures.captures} | ${g.layoutShifts} of ${g.layoutSamples} |`,
        );
      }
      out.push("");
    }
    const seen = results.rows.filter((row) => row.score.visibility);
    if (seen.length > 0) {
      out.push("## Visible region");
      out.push("");
      out.push(
        "The page against the part of the frame the person can see (`page-session.js` measures it on its own: the video's content box under " +
          "its object-fit, clipped by the stage and the viewport, minus the layout's declared opaque bands; a build that declares none is the crop alone). " +
          "**Holds**: framed holds (the ready windows where a script has them, else the default holds) where the ready cue came on — from an onset of that hold's own page, all four corners visible and uncovered at it — / all; " +
          "**page visible**: share of hold time with all four corners inside the region; **Afaste false**: \"Afaste um pouco\" shown while the whole " +
          "page was clearly visible (every corner ≥ 3 % of the region in — the app's own exit threshold), over the time it was; **Afaste right**: shown while it was not, over that time. **Ready**: cue-on instants every 50 ms (onsets) with a " +
          "corner outside the region, under an opaque control found on the page (not declared by the app), or no page at all / all; then page-less · covered. **Auto**: automatic captures whose page has a corner outside the image / flagged of those / all fires. " +
          "**Area**: the visible region as a share of the viewport (median).",
      );
      out.push("");
      out.push("| session | holds ready / all | page visible | Afaste false | Afaste right | ready violations (onsets) | auto: corner outside / flagged / fires | area |");
      out.push("|---|---:|---:|---:|---:|---:|---:|---:|");
      const bySession = new Map();
      for (const row of seen) {
        const acc = bySession.get(row.session) ?? {
          holds: 0, reached: 0, visibleMs: 0, hiddenMs: 0, clearMs: 0, falseMs: 0, rightMs: 0,
          samples: 0, violations: 0, pageless: 0, blocked: 0, onsets: 0, onsetViolations: 0, fires: 0, outside: 0, flagged: 0, areas: [],
        };
        const v = row.score.visibility;
        for (const h of v.holds) {
          acc.holds += 1;
          if (h.reached) acc.reached += 1;
          acc.visibleMs += h.visibleMs;
          acc.hiddenMs += h.hiddenMs;
          acc.clearMs += h.clearMs ?? h.visibleMs;
          acc.falseMs += h.moveBackFalseMs;
          acc.rightMs += h.moveBackRightMs;
        }
        acc.samples += v.ready.samples;
        acc.violations += v.ready.violations;
        acc.pageless += v.ready.pageless ?? 0;
        acc.blocked += v.ready.blocked ?? 0;
        acc.onsets += v.ready.onsets;
        acc.onsetViolations += v.ready.onsetViolations;
        acc.fires += v.auto.fires;
        acc.outside += v.auto.cornerOutside;
        acc.flagged += v.auto.cornerOutsideFlagged;
        if (v.area !== null) acc.areas.push(v.area);
        bySession.set(row.session, acc);
      }
      const share = (a, b) => (b > 0 ? a / b : null);
      for (const [session, a] of bySession) {
        const areas = a.areas.sort((x, y) => x - y);
        out.push(
          `| ${session} | ${a.holds === 0 ? "–" : `${a.reached} / ${a.holds}`} | ${pct(share(a.visibleMs, a.visibleMs + a.hiddenMs), 0)} | ` +
            `${pct(share(a.falseMs, a.clearMs), 0)} | ${pct(share(a.rightMs, a.hiddenMs), 0)} | ${a.violations} / ${a.samples} (${a.onsetViolations} / ${a.onsets}); ${a.pageless} · ${a.blocked} | ` +
            `${a.outside} / ${a.flagged} / ${a.fires} | ${areas.length === 0 ? "–" : pct(areas[Math.floor(areas.length / 2)], 0)} |`,
        );
      }
      out.push("");
    }
    out.push("## What it cost");
    out.push("");
    out.push(
      "Over the live part of each run (camera live → end of script), averaged over runs: main-thread long tasks (> 50 ms) per minute and their share of the time; " +
        "the ML loop's cadence (interval between regular passes p50 / p95, captures excluded), its pass time and the main thread's own share of a pass " +
        "(where the probe reports it); the JS heap's slope; start-up on the camera clock (camera open → the model's first answer → first lock, p50); " +
        "remounts (warm: mount → first ML answer → lock); what outlived the flow.",
    );
    out.push("");
    out.push(
      "| session | long tasks /min | long-task share | ML interval p50 / p95 ms | ML passes /min | ML pass ms p50 (main) | heap slope MB/min | camera→ML / →lock ms | remount →ML / →lock ms | lanes | outlived the flow |",
    );
    out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
    for (const [session, { all: a }] of Object.entries(results.summary)) {
      const leaks =
        a.leaks === null || a.leaks === undefined
          ? "–"
          : `workers alive ${a.leaks.workersAliveMax} (+${a.leaks.workersAddedByRemounts} by remounts), bitmaps open ${a.leaks.bitmapsOpenMax}, collected open ${a.leaks.bitmapsCollectedOpenMax}${a.leaks.gcRan ? "" : " (no GC)"}`;
      out.push(
        `| ${session} | ${n(a.longTasksPerMinute, 1)} | ${pct(a.longTaskShare, 1)} | ${ms(a.mlIntervalP50)} / ${ms(a.mlIntervalP95)} | ${n(a.mlPassesPerMinute)} | ` +
          `${n(a.mlPassMsP50, 1)} (${n(a.mlMainMsP50, 1)}) | ${n(a.heapSlopeMBPerMin, 2)} | ${ms(a.cameraToMlMsP50)} / ${ms(a.cameraToLockP50)} | ` +
          `${ms(a.remountToMlMsP50)} / ${ms(a.remountToLockP50)} | ${Object.entries(a.lanes ?? {}).map(([k, v]) => `${k} ×${v}`).join(", ") || "–"} | ${leaks} |`,
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
    if (s.guidance?.auto.fires.length > 0) {
      out.push(`- automatic captures: ${s.guidance.auto.fires.map((f) => `${(f.tapAt / 1000).toFixed(2)} s page ${f.page} ${f.verdict}${f.latencyMs === null ? "" : ` (${ms(f.latencyMs)} ms after stable)`}${f.inTremor ? " **in tremor**" : ""}${f.falseFire ? " **false fire**" : ""}`).join(" · ")}`);
    }
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

/** The overlay shown when camera frame `n` was on screen, and the last accepted pass. */
function overlayFor(record, n) {
  const shown = record.presented.find((p) => (p.n ?? p.k) >= n);
  const at = shown?.at ?? record.startedAt + (n * 1000) / 30;
  let overlay = null;
  let detect = null;
  for (const e of record.events) {
    if (e.type === "overlay" && e.t <= at + 50) overlay = e;
    if (e.type === "detect" && e.accepted && e.frameAt <= at) detect = e;
  }
  let hint = null;
  for (const e of hintSeries(record)) if (e.t <= at) hint = e.key;
  return {
    overlay: overlay !== null && overlay.quad !== null && overlay.opacity >= 0.5 ? toPoints(overlay.quad) : null,
    detect: detect === null ? null : { quad: toPoints(detect.quad), source: detect.source },
    hint,
    ready: overlay?.ready === true,
    countdown: overlay?.countdown ?? null,
  };
}

function filmStrip(script, record, score) {
  const frame = script.frame;
  const times = new Set();
  for (const value of Object.values(script.marks)) if (Number.isFinite(value)) times.add(value + 200);
  // Guidance sessions: the hint windows' edges and the moments after the scene steadies (the ready cue, a fire).
  for (const w of script.marks.hints ?? []) times.add(w.from).add(w.to - 100);
  for (const t of script.marks.stable ?? []) [400, 800, 1200, 1600].forEach((d) => times.add(t + d));
  const step = script.duration > 20000 ? 5000 : 1500;
  for (let t = 500; t < script.duration; t += step) times.add(t);
  // Camera frames; a looped session shows rendered frame `loopedFrame(n)` at camera frame n.
  const frames = [...new Set([...times].map((t) => Math.round((t * 30) / 1000)))].filter((n) =>
    script.loop === undefined ? n < record.frames.length : true,
  );
  const tiles = frames
    .sort((a, b) => a - b)
    .map((n) => {
      const k = script.loop === undefined ? n : loopedFrame(script, n);
      const truth = { ...record.frames[k], t: (n * 1000) / 30 };
      const { overlay, detect, hint, ready, countdown } = overlayFor(record, n);
      const error = overlay !== null && truth.quad !== null ? quadDistance(overlay, truth.quad, frame) : null;
      return {
        frame: k,
        caption: [
          `${script.id} t ${(truth.t / 1000).toFixed(1)} s`,
          overlay === null ? "overlay: none" : `overlay err ${error === null ? "(no page)" : `${(error * 100).toFixed(1)}%`}`,
          detect === null ? "no accepted pass yet" : `last pass: ${detect.source}`,
          `hint: ${hint ?? "none"}${ready ? ` · READY${countdown !== null ? ` ${Math.round(countdown * 100)}%` : ""}` : ""}`,
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

/**
 * The bench-only settings a run hands the app through the probe
 * (`probeSetting`, `src/lib/probe-hook.ts`): `--lane main|worker` forces the
 * detection lane; with `--cpu N` a worker's passes are stretched to N× their
 * cost (`workerSlowdown`) — CDP throttles only the page's own thread, and a
 * worker left at full speed would flatter the worker lane.
 */
export function sessionKnobs(options) {
  const knobs = {};
  if (options.lane !== null && options.lane !== undefined) knobs.lane = options.lane;
  if (options.fit !== null && options.fit !== undefined) knobs.fit = options.fit;
  if (options.cpu > 1) knobs.workerSlowdown = options.cpu;
  return knobs;
}

export async function runSessionSuite({ page, throttle: _unused, options, outDir, log, environment }) {
  const browser = page.context().browser();
  const origin = new URL(page.url()).origin;
  const rows = [];
  const sheets = [];
  const sheetDir = join(outDir, "sheets");
  mkdirSync(sheetDir, { recursive: true });
  const listing = await openSessionPage(browser, origin, options.layout, options.viewport);
  const known = await listing.page.evaluate(() => window.__session.sessions());
  await listing.context.close();
  // A group name (`regression`, `all`, `default` — a plain run's sessions) stands for its sessions.
  const plain = known.filter((s) => s.inDefault !== false).map((s) => s.id);
  const ids = [
    ...new Set(
      (options.sessions ?? plain).flatMap((id) =>
        id === "all"
          ? known.map((s) => s.id)
          : id === "default"
            ? plain
            : known.some((s) => s.group === id)
              ? known.filter((s) => s.group === id).map((s) => s.id)
              : [id],
      ),
    ),
  ];
  for (const id of ids) {
    if (!known.some((s) => s.id === id)) throw new Error(`unknown session "${id}" (known: ${known.map((s) => s.id).join(", ")})`);
  }
  const knobs = sessionKnobs(options);
  const browserVersion = browser.version();
  for (const id of ids) {
    for (let seed = 1; seed <= options.sessionSeeds; seed += 1) {
      const started = Date.now();
      const { context, page: phone, errors } = await openSessionPage(browser, origin, options.layout, options.viewport);
      try {
        const cache = options.frameCache === false ? null : frameCacheKey(id, seed, options.stream, browserVersion);
        const prepared = await phone.evaluate(
          ([name, s, size, key, settings]) => window.__session.prepare(name, s, { size, cache: key, knobs: settings }),
          [id, seed, options.stream, cache, knobs],
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
        const perf = score.perf;
        log(
          `session: ${id} #${seed} — ${((Date.now() - started) / 1000).toFixed(0)} s ` +
            `(prepared ${(prepared.prepare.totalMs / 1000).toFixed(0)} s${prepared.prepare.cached ? " from cache" : ""}, ${score.stream.fps?.toFixed(1) ?? "–"} fps, ` +
            `${score.captures.map((c) => c.verdict).join(", ") || "no capture"}` +
            `${perf?.longTasksPerMinute === null || perf?.longTasksPerMinute === undefined ? "" : `, ${perf.longTasksPerMinute.toFixed(0)} long tasks/min`}` +
            `${perf?.lanes?.length ? `, lane ${perf.lanes.map((l) => `${l.lane} (${l.reason})`).join(" → ")}` : ""})`,
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

/**
 * A fresh phone-shaped context on the session page, ready to prepare — on the
 * given capture layout (`--layout`), or the library's default (`rail`).
 */
export async function openSessionPage(browser, origin, layout = null, viewport = null) {
  const context = await browser.newContext(viewport === null || viewport === undefined ? PHONE : { ...PHONE, viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${origin}/page-session.html${layout === null || layout === undefined ? "" : `?layout=${encodeURIComponent(layout)}`}`);
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
      holdMs: { observed: 0, locked: 0, wrong: 0, none: 0 },
      holdAfterSwapMs: { observed: 0, locked: 0, wrong: 0, none: 0 },
      tapToConfirm: [],
      fallThrough: 0,
      downgraded: null,
      policy: { fellThrough: 0, wrongWith: 0, wrongWithout: 0, severeWith: 0, severeWithout: 0 },
      longTasksPerMinute: [],
      longTaskShare: [],
      heapSlope: [],
      heapEnd: [],
      mlIntervalP50: [],
      mlIntervalP95: [],
      mlPassP50: [],
      mlMainP50: [],
      mlPerMinute: [],
      cameraToMl: [],
      cameraToLock: [],
      mountToCamera: [],
      remountLock: [],
      remountMl: [],
      leaks: [],
      lanes: {},
      guidance: {
        windows: {},
        changes: 0,
        liveSeconds: 0,
        fastChanges: 0,
        holdMs: 0,
        holdHintMs: 0,
        ready: { onMs: 0, judgedMs: 0, onPageMs: 0, noPageMs: 0, eligibleMs: 0, eligibleOnMs: 0 },
        fires: [],
        falseFires: 0,
        firesDuringTremor: 0,
        firesInNoFire: 0,
        firesInHintWindow: 0,
        pages: 0,
        pagesFired: 0,
        repeatFires: 0,
        autoOn: 0,
        manual: { captures: 0, failed: 0, severe: 0 },
        auto: { captures: 0, failed: 0, severe: 0 },
        layoutShifts: 0,
        layoutSamples: 0,
      },
    });
    entry.runs += 1;
    const pool = (target, window) => {
      if (window === undefined || window === null || !(window.observedMs > 0)) return;
      target.observed += window.observedMs;
      target.locked += (window.lockedShare ?? 0) * window.observedMs;
      target.wrong += (window.wrongShare ?? 0) * window.observedMs;
      target.none += (window.noneShare ?? 0) * window.observedMs;
    };
    pool(entry.holdMs, row.score.hold);
    pool(entry.holdAfterSwapMs, row.score.holdAfterSwap);
    for (const c of row.score.captures) if (Number.isFinite(c.tapToConfirmMs)) entry.tapToConfirm.push(c.tapToConfirmMs);
    entry.fallThrough += row.score.captureDetects?.fallThrough ?? 0;
    if (Number.isFinite(row.score.captureDetects?.downgraded)) {
      entry.downgraded = (entry.downgraded ?? 0) + row.score.captureDetects.downgraded;
    }
    const perf = row.score.perf;
    if (perf) {
      if (perf.longTasksPerMinute !== null) entry.longTasksPerMinute.push(perf.longTasksPerMinute);
      if (perf.longTaskShare !== null) entry.longTaskShare.push(perf.longTaskShare);
      if (perf.heapSlopeMBPerMin !== null) entry.heapSlope.push(perf.heapSlopeMBPerMin);
      if (perf.heapEndMB !== null) entry.heapEnd.push(perf.heapEndMB);
      const ml = perf.cadence?.ml;
      if (ml) {
        if (ml.intervalP50 !== null) entry.mlIntervalP50.push(ml.intervalP50);
        if (ml.intervalP95 !== null) entry.mlIntervalP95.push(ml.intervalP95);
        if (ml.passMsP50 !== null) entry.mlPassP50.push(ml.passMsP50);
        if (ml.mainMsP50 !== null) entry.mlMainP50.push(ml.mainMsP50);
        entry.mlPerMinute.push(ml.perMinute);
      }
      for (const lane of perf.lanes ?? []) {
        const key = `${lane.lane} (${lane.reason})`;
        entry.lanes[key] = (entry.lanes[key] ?? 0) + 1;
      }
    }
    const startup = row.score.startup;
    if (startup) {
      if (startup.cameraToMlMs !== null) entry.cameraToMl.push(startup.cameraToMlMs);
      entry.cameraToLock.push(startup.cameraToLockMs);
      if (startup.mountToCameraMs !== null) entry.mountToCamera.push(startup.mountToCameraMs);
    }
    for (const r of row.score.remounts ?? []) {
      entry.remountLock.push(r.mountToLockMs);
      if (r.mountToMlMs !== null) entry.remountMl.push(r.mountToMlMs);
    }
    if (row.score.leaks) entry.leaks.push(row.score.leaks);
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
      if (c.fellThrough) {
        entry.policy.fellThrough += 1;
        if (failed(c.verdict)) entry.policy.wrongWith += 1;
        if (failed(c.alternativeVerdict)) entry.policy.wrongWithout += 1;
        if (failed(c.verdict) || c.contentClipped === true) entry.policy.severeWith += 1;
        if (failed(c.alternativeVerdict) || c.alternativeContentClipped === true) entry.policy.severeWithout += 1;
      }
    }
    const g = row.score.guidance;
    if (g) {
      const G = entry.guidance;
      for (const w of g.windows) {
        const W = (G.windows[w.name] ??= { ms: 0, correct: 0, wrong: 0, none: 0, first: [], expect: w.expect });
        W.ms += w.ms;
        W.correct += (w.share ?? 0) * w.ms;
        W.wrong += (w.wrongShare ?? 0) * w.ms;
        W.none += (w.noneShare ?? 0) * w.ms;
        W.first.push(w.firstCorrectMs);
      }
      G.changes += g.changes;
      G.liveSeconds += g.liveSeconds ?? 0;
      G.fastChanges += g.fastChanges;
      G.holdMs += g.holdMs;
      G.holdHintMs += Object.values(g.holdHintMs).reduce((a, b) => a + b, 0);
      for (const k of Object.keys(G.ready)) G.ready[k] += g.ready[k] ?? 0;
      G.fires.push(...g.auto.fires);
      G.falseFires += g.auto.falseFires;
      G.firesDuringTremor += g.auto.firesDuringTremor;
      G.firesInNoFire += g.auto.firesInNoFire ?? 0;
      G.firesInHintWindow += g.auto.firesInHintWindow ?? 0;
      G.pages += g.auto.pages;
      G.pagesFired += g.auto.pagesFired;
      G.repeatFires += g.auto.repeatFires;
      if (g.auto.on) G.autoOn += 1;
      for (const c of row.score.captures) {
        const bucket = c.trigger === "auto" ? G.auto : G.manual;
        bucket.captures += 1;
        if (CAPTURE_FAILURES.has(c.verdict)) bucket.failed += 1;
        if (CAPTURE_FAILURES.has(c.verdict) || c.contentClipped === true) bucket.severe += 1;
      }
      G.layoutShifts += g.layout.shifts;
      G.layoutSamples += g.layout.samples;
    }
    if (row.score.staleAfterSwap === "stuck") entry.stuck += 1;
    if (Number.isFinite(row.score.staleAfterSwapMs)) entry.stale.push(row.score.staleAfterSwapMs);
    if (row.score.falseLocksPerMinute !== undefined) entry.falseLocks.push(row.score.falseLocksPerMinute);
    if (Number.isFinite(row.score.falseLockExposure?.share)) entry.exposure.push(row.score.falseLockExposure.share);
  }
  const avg = (list) => (list.length > 0 ? list.reduce((s, v) => s + v, 0) / list.length : null);
  /** p50 over runs where a run that never got there counts as never (∞). */
  const p50Never = (list) => {
    if (list.length === 0) return null;
    const sorted = list.map((v) => (v === null ? Infinity : v)).sort((a, b) => a - b);
    const value = sorted[Math.floor((sorted.length - 1) / 2)];
    return Number.isFinite(value) ? value : null;
  };
  const share = (pooled, key) => (pooled.observed > 0 ? pooled[key] / pooled.observed : null);
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
          // The live loop, as the user saw it (Phase 3's gate): the hold
          // windows pooled over runs, time-weighted; time to lock over runs
          // (a run that never locked counts as never); stale overlay p95.
          holdOnPageShare: share(e.holdMs, "locked"),
          holdWrongShare: share(e.holdMs, "wrong"),
          holdNoneShare: share(e.holdMs, "none"),
          holdAfterSwapOnPageShare: share(e.holdAfterSwapMs, "locked"),
          holdAfterSwapWrongShare: share(e.holdAfterSwapMs, "wrong"),
          timeToLockP50: p50Never(e.locks),
          timeToLockMean: avg(e.locks.filter((v) => v !== null)),
          staleAfterSwapP95: e.stale.length > 0 ? percentile(e.stale, 95) : null,
          tapToConfirmP50: e.tapToConfirm.length > 0 ? percentile(e.tapToConfirm, 50) : null,
          tapToConfirmMean: avg(e.tapToConfirm),
          captureFallThrough: e.fallThrough,
          captureDowngraded: e.downgraded,
          // The captures whose corners came from the classical fall-through,
          // judged with them and with what the other policy would have
          // opened with (paired: same capture, same image).
          fallThroughPolicy: e.policy,
          // What it cost (live part of each run).
          longTasksPerMinute: avg(e.longTasksPerMinute),
          longTaskShare: avg(e.longTaskShare),
          heapSlopeMBPerMin: avg(e.heapSlope),
          heapEndMB: avg(e.heapEnd),
          mlIntervalP50: avg(e.mlIntervalP50),
          mlIntervalP95: avg(e.mlIntervalP95),
          mlPassMsP50: avg(e.mlPassP50),
          mlMainMsP50: avg(e.mlMainP50),
          mlPassesPerMinute: avg(e.mlPerMinute),
          lanes: e.lanes,
          // Start-up (cold: a fresh page) and remounts (warm).
          mountToCameraMs: avg(e.mountToCamera),
          cameraToMlMsP50: e.cameraToMl.length > 0 ? percentile(e.cameraToMl, 50) : null,
          cameraToLockP50: p50Never(e.cameraToLock),
          remountToMlMsP50: e.remountMl.length > 0 ? percentile(e.remountMl, 50) : null,
          remountToLockP50: p50Never(e.remountLock),
          remountNeverLocked: e.remountLock.filter((v) => v === null).length,
          guidance: summarizeGuidance(e.guidance),
          leaks:
            e.leaks.length === 0
              ? null
              : {
                  workersAliveMax: Math.max(...e.leaks.map((l) => l.workersAlive)),
                  workersAddedByRemounts: Math.max(...e.leaks.map((l) => l.workersAlive - l.workersAliveBeforeRemounts)),
                  bitmapsOpenMax: Math.max(...e.leaks.map((l) => l.bitmapsOpen)),
                  bitmapsCollectedOpenMax: Math.max(...e.leaks.map((l) => l.bitmapsCollectedOpen)),
                  gcRan: e.leaks.every((l) => l.gcRan),
                },
        },
      },
    ]),
  );
}

/** A session's guidance numbers, pooled over its runs (time-weighted where they are times). */
function summarizeGuidance(G) {
  const share = (a, b) => (b > 0 ? a / b : null);
  const latencies = G.fires.filter((f) => !f.falseFire && Number.isFinite(f.latencyMs)).map((f) => f.latencyMs);
  return {
    windows: Object.fromEntries(
      Object.entries(G.windows).map(([name, W]) => [
        name,
        {
          expect: W.expect,
          ms: W.ms,
          share: share(W.correct, W.ms),
          wrongShare: share(W.wrong, W.ms),
          noneShare: share(W.none, W.ms),
          firstCorrectP50: W.first.length > 0 ? percentileNever(W.first) : null,
          neverCorrect: W.first.filter((v) => v === null).length,
        },
      ]),
    ),
    changes: G.changes,
    changesPerSecond: share(G.changes, G.liveSeconds),
    fastChanges: G.fastChanges,
    holdHintShare: share(G.holdHintMs, G.holdMs),
    readyPrecision: share(G.ready.onPageMs, G.ready.judgedMs),
    readyRecall: share(G.ready.eligibleOnMs, G.ready.eligibleMs),
    readyOnMs: G.ready.onMs,
    readyNoPageMs: G.ready.noPageMs,
    fires: G.fires.length,
    falseFires: G.falseFires,
    firesDuringTremor: G.firesDuringTremor,
    firesInNoFire: G.firesInNoFire,
    firesInHintWindow: G.firesInHintWindow,
    fireLatencyP50: latencies.length > 0 ? percentile(latencies, 50) : null,
    fireLatencies: latencies,
    pages: G.pages,
    pagesFired: G.pagesFired,
    repeatFires: G.repeatFires,
    autoOnRuns: G.autoOn,
    manualCaptures: G.manual,
    autoCaptures: G.auto,
    layoutShifts: G.layoutShifts,
    layoutSamples: G.layoutSamples,
  };
}

/** p50 where null (never) counts as infinitely late. */
function percentileNever(values) {
  const sorted = values.map((v) => (v === null ? Infinity : v)).sort((a, b) => a - b);
  const value = sorted[Math.floor((sorted.length - 1) / 2)];
  return Number.isFinite(value) ? value : null;
}
