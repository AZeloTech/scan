/**
 * Turning bench rows into the report people read and the numbers `--compare`
 * gates on.
 *
 * Pure: rows in, summaries and Markdown out. Synthetic and real results are
 * never mixed in one table — every report says in its first line which one it
 * is, and `--compare` refuses to compare across the two.
 */

import {
  CLIPPED_MAX_FRACTION,
  CONTENT_CLIP_MIN_FRACTION,
  LOOSE_MAX_FRACTION,
  mean,
  offImage,
  percentile,
  rate,
  WRONG_CROP_MAX_CORNER_ERROR,
  WRONG_CROP_MIN_IOU,
} from "./metrics.mjs";

/**
 * The shape of `results.json`. Bumped whenever a number's meaning or a
 * summary's shape changes, and `--compare` refuses a baseline of another
 * schema rather than compare two different measures under one name.
 *
 * 2: the corner order counts in `wrongCrop`; content clipping and `severe`;
 * overlay shares time-weighted and judged on visible corners; locks and stale
 * overlays observed or unknown; captures named by id with proposal / shown /
 * final verdicts and page-less captures; warm-up passes scored; per-setting
 * detector groups; missing data counted.
 */
export const RESULTS_SCHEMA = 2;

/**
 * How much worse a headline number may get before `--compare` fails the run.
 * Rates are absolute (0.02 = two percentage points); corner error is a fraction
 * of the frame diagonal. Latency is reported but never gated: it measures the
 * machine as much as the code.
 */
export const REGRESSION_TOLERANCE = {
  wrongRate: 0.02,
  missRate: 0.02,
  falsePositiveRate: 0.02,
  cornerErrorP50: 0.002,
  // A crop that cut into content, and the severe crops (wrong or clipped).
  contentClippedRate: 0.02,
  severeRate: 0.02,
  // Sessions: a capture that went wrong, corners that opened farther off, the
  // overlay locking onto an empty desk more often. A session runs in real
  // time, so two runs of one script differ (the still is exposed a few ms
  // apart on a trembling hand): measured at ~1 % of the diagonal on
  // corners-at-confirm between identical runs. Gate on several seeds.
  captureWrongRate: 0,
  cornersAtConfirmMax: 0.015,
  falseLocksPerMinute: 1,
  // What the user left with, the severe captures, page-less captures, the
  // share of an empty desk's time a quad was shown, and overlays that never
  // left a swapped-out page.
  captureWrongRateFinal: 0,
  severeCaptureRate: 0,
  pagelessCaptureRate: 0,
  falseLockExposure: 0.05,
  staleStuck: 0,
  // 5d-paper: the presented time a dim-lamp page was not held as found.
  paperUnlockedShare: 0.05,
  // A session page-less as a whole (a document on a screen): the share of it held as a found sheet.
  pagelessLockedShare: 0.05,
  // Real media, GT-free: a real image that stopped being detected at all, the
  // quad moving more between consecutive frames of a clip, the replayed
  // overlay spending more of the clip off the page the detector sees.
  undetectedRate: 0.02,
  jitterP50: 0.002,
  offShare: 0.05,
};

/**
 * Limits a run must meet whatever its baseline said — failures that are never
 * a matter of degree: a tap that made no capture, a confirm screen that never
 * opened, a seed off the image, and anything the bench could not measure
 * (a capture whose image it could not name, a window it did not observe, a
 * synthetic crop without its content truth). A baseline that already had them
 * does not make them acceptable.
 */
export const ABSOLUTE_LIMITS = {
  detector: { contentUnknown: 0 },
  session: { missingCaptures: 0, confirmNeverOpened: 0, confirmOffImage: 0, unscoredCaptures: 0, contentUnknownCaptures: 0, missingData: 0 },
  "real-stills": {},
  "real-video": { unidentifiedCaptures: 0 },
};

/**
 * 5d-paper: the dim-lamp paper lock, gated per CPU rate on runs of
 * {@link PAPER_LOCK_MIN_RUNS} seeds or more (`paperLock`, pooled over runs;
 * scored on the presented page only, over the whole presented window:
 * `session-score.mjs` `scorePaperLock`).
 *
 * - `floors`: the least share of the window locked on the page — under the
 *   measured level by the run-to-run spread, so the margin rule, the
 *   held-sheet exclusion or the memory going back fails the run.
 * - `firstLockP50Ms`: the most the median first lock may take (cpu 1 only;
 *   the spec's 1.5 s).
 *
 * The spec's target, 80 % of the presented time locked
 * ({@link PAPER_LOCK_TARGET}), is reported against every run, not gated:
 * the dim scenes' detector (no quad on a third of the passes, quads that
 * jump) holds every page under it, and a gate that always fails gates
 * nothing — it is the named follow-up (5d-detector), not a floor.
 *
 * With `--paper-gate` (npm run bench:paper) the four sessions are
 * required: one absent, or run on fewer seeds, fails the run instead of
 * passing silently ungated.
 */
export const PAPER_LOCK_MIN_RUNS = 8;
export const PAPER_LOCK_TARGET = 0.8;
export const PAPER_LOCK_SESSIONS = ["dim-owner-case", "dim-owner-bare", "dim-sheet-over", "dim-text-page"];
export const PAPER_LOCK_GATES = {
  1: {
    // Measured (on the page, whole window, 8 seeds): 17 / 66 / 21 / 67 %; before 5d-paper 4 / 28 / 14 / 63 %.
    floors: { "dim-owner-case": 0.12, "dim-owner-bare": 0.58, "dim-sheet-over": 0.15, "dim-text-page": 0.6 },
    firstLockP50Ms: 1500,
  },
  4: {
    // Measured (8 seeds; owner and sheet-over two runs): 9–10 / 55 / 12–15 / 54 %; the code before the
    // adv-paper fixes, run twice: 7–17 / 56 / 10–15 / 50 %; before 5d-paper 1 / 25 / 8 / 52 %.
    floors: { "dim-owner-case": 0.05, "dim-owner-bare": 0.45, "dim-sheet-over": 0.08, "dim-text-page": 0.4 },
    firstLockP50Ms: null,
  },
};
/** @deprecated the cpu-1 floors; {@link PAPER_LOCK_GATES} holds every rate's. */
export const PAPER_LOCK_FLOORS = PAPER_LOCK_GATES[1].floors;

/** Headline numbers where a larger value is worse, in report order: the detector's, then a session's. */
const HEADLINES = {
  detector: ["wrongRate", "missRate", "falsePositiveRate", "cornerErrorP50", "severeRate", "contentClippedRate"],
  session: [
    "captureWrongRate",
    "cornersAtConfirmMax",
    "falseLocksPerMinute",
    "captureWrongRateFinal",
    "severeCaptureRate",
    "pagelessCaptureRate",
    "falseLockExposure",
    "staleStuck",
    "paperUnlockedShare",
    "pagelessLockedShare",
  ],
  // Real media: the labelled verdicts where labels exist ("–" where not), then the GT-free ones.
  "real-stills": ["wrongRate", "missRate", "falsePositiveRate", "cornerErrorP50", "undetectedRate"],
  "real-video": ["wrongRate", "missRate", "cornerErrorP50", "undetectedRate", "jitterP50", "offShare"],
};

/** One variant over a group of scored rows (`{ det, score }`): the detector table's numbers. */
export function summarizeGroup(rows) {
  const positives = rows.filter((r) => r.score.hasTruth);
  const negatives = rows.filter((r) => !r.score.hasTruth);
  const accepted = positives.filter((r) => r.score.detected);
  const wrong = accepted.filter((r) => r.score.wrongCrop);
  // Content: judged where the truth knows it (the emulator's scenes); a hand
  // label does not, and then these are null — n/a, never zero.
  const contentJudged = accepted.filter((r) => r.score.contentClipped === true || r.score.contentClipped === false);
  const contentClipped = contentJudged.filter((r) => r.score.contentClipped);
  const contentUnknown = accepted.filter((r) => !r.score.degenerate && (r.score.contentClipped === null || r.score.contentClipped === undefined));
  const severe = accepted.filter((r) => r.score.severe === true);
  const severeUnknown = accepted.filter((r) => r.score.severe !== true && r.score.severe !== false);
  const sources = {};
  for (const row of rows) {
    if (row.det.accepted && row.det.source !== null) sources[row.det.source] = (sources[row.det.source] ?? 0) + 1;
  }
  return {
    scenes: rows.length,
    positives: positives.length,
    negatives: negatives.length,
    answeredRate: rate(rows.filter((r) => r.det.ok).length, rows.length),
    acceptedRate: rate(accepted.length, positives.length),
    good: accepted.length - wrong.length,
    wrong: wrong.length,
    miss: positives.length - accepted.length,
    goodRate: rate(accepted.length - wrong.length, positives.length),
    wrongRate: rate(wrong.length, positives.length),
    missRate: rate(positives.length - accepted.length, positives.length),
    clippedRate: rate(accepted.filter((r) => r.score.clipped).length, accepted.length),
    looseRate: rate(accepted.filter((r) => r.score.loose).length, accepted.length),
    orderWrong: accepted.filter((r) => r.score.orderWrong).length,
    contentJudged: contentJudged.length,
    contentUnknown: contentUnknown.length,
    contentClipped: contentClipped.length,
    // Over accepted crops whose content is known.
    contentClippedRate: contentJudged.length === 0 ? null : rate(contentClipped.length, contentJudged.length),
    identifierClippedRate: contentJudged.length === 0 ? null : rate(contentJudged.filter((r) => r.score.content?.identifierClipped).length, contentJudged.length),
    // Page lost with no content lost: the margin, reported apart.
    marginClippedRate: contentJudged.length === 0 ? null : rate(contentJudged.filter((r) => r.score.marginClipped).length, contentJudged.length),
    // Wrong or content-clipped, over scenes with a page like `wrongRate` —
    // null when some crop's content is unknown.
    severe: severe.length,
    severeRate: severeUnknown.length > 0 ? null : rate(severe.length, positives.length),
    iouP50: percentile(accepted.map((r) => r.score.iou), 50),
    cornerErrorP50: percentile(accepted.map((r) => r.score.maxCornerError), 50),
    cornerErrorP95: percentile(accepted.map((r) => r.score.maxCornerError), 95),
    meanCornerError: mean(accepted.map((r) => r.score.meanCornerError)),
    falsePositives: negatives.filter((r) => r.score.falsePositive).length,
    falsePositiveRate: rate(negatives.filter((r) => r.score.falsePositive).length, negatives.length),
    msP50: percentile(rows.map((r) => r.det.ms), 50),
    msP95: percentile(rows.map((r) => r.det.ms), 95),
    sources,
    ...refineSummary(rows),
  };
}

/**
 * The edge refinement's own numbers over the rows that ran it (variants
 * `refined`, `ml+refine`): its time, how often it moved the quad, and how
 * often each side was snapped locally, searched wide or kept, and how many
 * answers it left with a corner off the image (the contract says none).
 * Empty for the variants that do not refine.
 */
export function refineSummary(rows) {
  const ran = rows.filter((r) => r.det.refine != null);
  if (ran.length === 0) return {};
  const sides = { local: 0, wide: 0, kept: 0 };
  for (const r of ran) for (const side of r.det.refine.sides ?? []) sides[side.mode] = (sides[side.mode] ?? 0) + 1;
  return {
    refineRuns: ran.length,
    refineChanged: ran.filter((r) => r.det.refine.changed).length,
    refineMsP50: percentile(ran.map((r) => r.det.refine.ms), 50),
    refineMsP95: percentile(ran.map((r) => r.det.refine.ms), 95),
    refineSides: sides,
    refineOffImage: ran.filter((r) => offImage(r.det.quad)).length,
  };
}

/** Each refining variant's unrefined twin, for flips. */
export const UNREFINED = { refined: "production", "ml+refine": "ml" };

/**
 * Verdict flips of `variant` against `base` on the same scenes: a right crop
 * that became wrong (or missed), and a wrong or missed one that became right.
 * Scenes without a page are compared as false positives.
 */
export function flipsAgainst(rows, variant, base = "production") {
  const byScene = new Map();
  for (const r of rows) {
    if (r.variant === variant || r.variant === base) {
      byScene.set(r.sceneId, { ...(byScene.get(r.sceneId) ?? {}), [r.variant === base ? "base" : "other"]: r });
    }
  }
  const goodToWrong = [];
  const wrongToGood = [];
  const good = (s) => s.hasTruth && s.detected && !s.wrongCrop;
  for (const { base: b, other: o } of byScene.values()) {
    if (b === undefined || o === undefined || !b.score.hasTruth) continue;
    if (good(b.score) && !good(o.score)) goodToWrong.push(o);
    if (!good(b.score) && good(o.score)) wrongToGood.push(o);
  }
  return { goodToWrong, wrongToGood };
}

/**
 * `{ [family]: { [variant]: summary } }`, plus an `ALL` family across every
 * family in the run, and one group per setting of a family that samples one
 * (`F6/laptop`, `F1/granite`) — so `--compare` gates each negative scene and
 * each setting on its own, and a regression in one cannot hide in its
 * family's average.
 */
export function summarizeDetector(rows) {
  const out = {};
  const families = [...new Set(rows.map((r) => r.family))];
  const variants = [...new Set(rows.map((r) => r.variant))];
  const groups = [...families.map((family) => [family, (r) => r.family === family]), ["ALL", () => true]];
  for (const family of families) {
    const settings = [...new Set(rows.filter((r) => r.family === family && r.setting != null).map((r) => r.setting))];
    for (const setting of settings) groups.push([`${family}/${setting}`, (r) => r.family === family && r.setting === setting]);
  }
  for (const [key, member] of groups) {
    out[key] = {};
    for (const variant of variants) {
      const group = rows.filter((r) => member(r) && r.variant === variant);
      if (group.length > 0) out[key][variant] = summarizeGroup(group);
    }
  }
  return out;
}

/** Per-setting breakdown for families that sample one (F1: granite / wood-mat). */
export function summarizeBySetting(rows) {
  const out = {};
  for (const row of rows) {
    if (row.setting === undefined || row.setting === null) continue;
    const key = `${row.family}\u0000${row.setting}\u0000${row.variant}`;
    (out[key] ??= []).push(row);
  }
  return Object.entries(out).map(([key, group]) => {
    const [family, setting, variant] = key.split("\u0000");
    return { family, setting, variant, ...summarizeGroup(group) };
  });
}

const pct = (v) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(1)} %`);
const pctDiag = (v) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(2)}`);
const num = (v, digits = 3) => (v === null || v === undefined ? "–" : v.toFixed(digits));
const ms = (v) => (v === null || v === undefined ? "–" : v.toFixed(0));

export function detectorTable(byVariant) {
  const lines = [
    "| variant | scenes | answered | good | wrong | miss | clipped | content clipped | severe | loose | IoU p50 | corner err p50 / p95 (% diag) | FP | ms p50 / p95 | accepted by |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  const na = (s, value) => (s.contentJudged > 0 || s.positives === 0 ? pct(value) : "n/a");
  for (const [variant, s] of Object.entries(byVariant)) {
    const sources = Object.entries(s.sources).map(([k, v]) => `${k} ${v}`).join(", ") || "–";
    lines.push(
      `| ${variant} | ${s.scenes} | ${pct(s.answeredRate)} | ${pct(s.goodRate)} | **${pct(s.wrongRate)}**${s.orderWrong > 0 ? ` (${s.orderWrong} order)` : ""} | ${pct(s.missRate)} | ` +
        `${pct(s.clippedRate)} | ${na(s, s.contentClippedRate)} | **${na(s, s.severeRate)}** | ${pct(s.looseRate)} | ${num(s.iouP50)} | ${pctDiag(s.cornerErrorP50)} / ${pctDiag(s.cornerErrorP95)} | ` +
        `${s.negatives > 0 ? `${s.falsePositives}/${s.negatives}` : "–"} | ${ms(s.msP50)} / ${ms(s.msP95)} | ${sources} |`,
    );
  }
  return lines.join("\n");
}

/** The Markdown report for a detector-suite run. */
export function renderDetectorReport(results) {
  const { config, environment, summary, rows, families, sheets } = results;
  const kind = results.synthetic ? "SYNTHETIC" : "REAL";
  const out = [];
  out.push(`# Detection bench — detector suite (${kind})`);
  out.push("");
  if (results.synthetic) {
    out.push(
      "> Synthetic scenes rendered by the emulator from seeds. These numbers are **never** comparable " +
        "with real-media results and are reported separately by design.",
    );
    out.push("");
  }
  out.push(`- run: ${results.createdAt} · commit ${results.git.commit}${results.git.dirty ? " (dirty)" : ""}`);
  out.push(`- browser: ${environment.executable} · WebGL: ${environment.renderer}`);
  out.push(`- ML runtime ready: ${environment.mlReady ? "yes" : "**NO — every ML number below is a fallback**"} (warm-up ${ms(environment.mlWarmUpMs)} ms)`);
  if (environment.mlLatchedOff) {
    out.push("- **the ML runtime latched itself off during the run: later ML and production rows are classical fallbacks**");
  }
  out.push(
    `- families: ${config.families.join(", ")} · seeds 1–${config.seeds} · frame ${config.frame.width}×${config.frame.height} · CPU throttle ${config.cpu}×`,
  );
  out.push(`- variants: ${Object.entries(environment.variants).filter(([k]) => config.variants.includes(k)).map(([k, v]) => `\`${k}\` = ${v}`).join("; ")}`);
  out.push(
    `- verdicts: **wrong** = IoU < ${WRONG_CROP_MIN_IOU}, any corner > ${(WRONG_CROP_MAX_CORNER_ERROR * 100).toFixed(1)} % of the diagonal, ` +
      `or the corners in an order the warp would mirror or turn; ` +
      `**miss** = no quad survived the variant's own gates; **clipped** = > ${(CLIPPED_MAX_FRACTION * 100).toFixed(0)} % of the page outside the quad; ` +
      `**content clipped** = the quad cut > ${(CONTENT_CLIP_MIN_FRACTION * 100).toFixed(0)} % off a line of text, an identifier or a mark (the emulator knows where the print is; ` +
      `n/a for hand labels); **severe** = wrong or content clipped; ` +
      `**loose** = non-page area > ${(LOOSE_MAX_FRACTION * 100).toFixed(0)} % of the page. Rates are over scenes with a page; clipped/content/loose over accepted quads.`,
  );
  out.push("");
  for (const family of [...config.families, "ALL"]) {
    const byVariant = summary[family];
    if (byVariant === undefined) continue;
    const info = families.find((f) => f.id === family);
    out.push(`## ${family}${info ? ` — ${info.title}` : " — every family"}`);
    out.push("");
    if (info) out.push(`${info.describe}.`, "");
    out.push(detectorTable(byVariant));
    out.push("");
    const familyRows = rows.filter((r) => family === "ALL" || r.family === family);
    const refining = Object.entries(byVariant).filter(([, s]) => s.refineRuns > 0);
    if (refining.length > 0) {
      out.push("| variant | refine ran | moved | sides local / wide / kept | off image | refine ms p50 / p95 | flips vs unrefined: right → wrong | wrong → right |");
      out.push("|---|---:|---:|---:|---:|---:|---|---|");
      for (const [variant, s] of refining) {
        const base = UNREFINED[variant] ?? "production";
        const flips = byVariant[base] ? flipsAgainst(familyRows, variant, base) : null;
        const ids = (list) => (list.length === 0 ? "0" : `**${list.length}** (${list.map((r) => `${r.family === family ? "" : `${r.family} `}#${r.seed}`).join(", ")})`);
        out.push(
          `| ${variant} | ${s.refineRuns} | ${s.refineChanged} | ${s.refineSides.local} / ${s.refineSides.wide} / ${s.refineSides.kept} | ${s.refineOffImage} | ` +
            `${num(s.refineMsP50, 1)} / ${num(s.refineMsP95, 1)} | ${flips ? ids(flips.goodToWrong) : "–"} | ${flips ? ids(flips.wrongToGood) : "–"} |`,
        );
      }
      out.push("");
    }
    const settings = summarizeBySetting(rows.filter((r) => r.family === family));
    if (settings.length > 0) {
      out.push("| setting | variant | scenes | good | wrong | miss | severe | FP | corner err p50 (% diag) |");
      out.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
      for (const s of settings) {
        out.push(
          `| ${s.setting} | ${s.variant} | ${s.scenes} | ${pct(s.goodRate)} | ${pct(s.wrongRate)} | ${pct(s.missRate)} | ${pct(s.severeRate)} | ` +
            `${s.negatives > 0 ? `${s.falsePositives}/${s.negatives}` : "–"} | ${pctDiag(s.cornerErrorP50)} |`,
        );
      }
      out.push("");
    }
    const clippedRows = rows
      .filter((r) => r.family === family && r.score.detected && !r.score.wrongCrop && r.score.contentClipped)
      .sort((a, b) => (b.score.content?.maxLostFraction ?? 0) - (a.score.content?.maxLostFraction ?? 0))
      .slice(0, 8);
    if (clippedRows.length > 0) {
      out.push("Right by geometry, but content clipped:");
      out.push("");
      for (const r of clippedRows) {
        out.push(
          `- ${r.variant} · seed ${r.seed}${r.setting ? ` (${r.setting})` : ""}: ${r.score.content.clippedBoxes} of ${r.score.content.judged} boxes cut, ` +
            `worst lost ${pct(r.score.content.maxLostFraction)}${r.score.content.identifierClipped ? ", **an identifier**" : ""}, IoU ${num(r.score.iou)}`,
        );
      }
      out.push("");
    }
    const worst = rows
      .filter((r) => r.family === family && r.score.detected && r.score.wrongCrop)
      .sort((a, b) => a.score.iou - b.score.iou)
      .slice(0, 8);
    if (worst.length > 0) {
      out.push("Worst wrong crops:");
      out.push("");
      for (const r of worst) {
        out.push(
          `- ${r.variant} · seed ${r.seed}${r.setting ? ` (${r.setting})` : ""}: IoU ${num(r.score.iou)}, worst corner ${pctDiag(r.score.maxCornerError)} % diag, ` +
            `quad coverage ${num(r.det.coverage)}, page coverage ${num(r.pageCoverage)}, by ${r.det.source} @ ${num(r.det.confidence)}`,
        );
      }
      out.push("");
    }
    const familySheets = (sheets ?? []).filter((s) => s.family === family);
    if (familySheets.length > 0) {
      out.push(`Contact sheets: ${familySheets.map((s) => `[${s.variant}${s.part > 1 ? ` ${s.part}` : ""}](${s.file})`).join(" · ")}`);
      out.push("");
    }
  }
  return out.join("\n");
}

/**
 * What two runs must share for their numbers to be compared at all: the same
 * seeds on the same frame under the same throttle measure the same thing; a
 * different seed count or frame size is a different sample, and its deltas
 * would be noise dressed as a verdict.
 */
const MUST_MATCH = {
  detector: ["seeds", "settings", "frame", "cpu"],
  session: ["seeds", "stream", "cpu", "viewport"],
  "real-stills": ["media", "cpu"],
  "real-video": ["media", "cpu", "skipReplay"],
};

/**
 * What may differ: only the families (sessions, variants) both runs measured
 * are compared — and when the families differ, the `ALL` rows, which pool a
 * different set of scenes in each run, are not.
 */
const MAY_NARROW = {
  detector: ["families", "variants"],
  session: ["sessions", "variants"],
  "real-stills": ["variants"],
  "real-video": ["variants"],
};

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Whether two runs can be compared: throws when they cannot be (synthetic vs
 * real, two suites, a different sample — {@link MUST_MATCH}); otherwise
 * answers `{ narrowed, pooledDiffers }`: the scope keys on which they differ,
 * and whether that changes what an `ALL` row pools.
 */
export function checkComparable(previous, current) {
  // Schema 1 files predate the field.
  const previousSchema = previous.schema ?? 1;
  const currentSchema = current.schema ?? 1;
  if (previousSchema !== currentSchema) {
    throw new Error(
      `refusing to compare a schema ${previousSchema} baseline with a schema ${currentSchema} run: the numbers ` +
        "measure different things under the same names — re-run the baseline with this bench",
    );
  }
  if (previous.synthetic !== current.synthetic) {
    throw new Error("refusing to compare a synthetic run with a real one");
  }
  if (previous.suite !== current.suite) {
    throw new Error(`refusing to compare a ${previous.suite} run with a ${current.suite} run`);
  }
  const differing = (keys) => (keys ?? []).filter((key) => !same(previous.config?.[key], current.config?.[key]));
  const describe = (key) => `${key} ${JSON.stringify(previous.config?.[key] ?? null)} → ${JSON.stringify(current.config?.[key] ?? null)}`;
  const problems = differing(MUST_MATCH[current.suite]).map(describe);
  if (problems.length > 0) {
    throw new Error(`refusing to compare runs that measured different samples: ${problems.join("; ")}`);
  }
  const narrowedKeys = differing(MAY_NARROW[current.suite]);
  return { narrowed: narrowedKeys.map(describe), pooledDiffers: narrowedKeys.includes("families") };
}

/**
 * Headline deltas between two runs' summaries, and the regressions beyond
 * {@link REGRESSION_TOLERANCE}. A headline that had a number and lost it — a
 * capture that stopped happening, a family that stopped being measured — is
 * a regression too, never a "–".
 */
export function compareSummaries(previous, current, tolerance = REGRESSION_TOLERANCE) {
  const { narrowed, pooledDiffers } = checkComparable(previous, current);
  const scoped = narrowed.length > 0;
  const headlines = HEADLINES[current.suite] ?? HEADLINES.detector;
  const lines = [
    "| family | variant | " + headlines.join(" | ") + " |",
    "|---|---|" + headlines.map(() => "---:").join("|") + "|",
  ];
  const regressions = [];
  const notes = scoped
    ? [`compared only what both runs measured (${narrowed.join("; ")})${pooledDiffers ? "; the pooled ALL rows are skipped" : ""}`]
    : [];
  const has = (v) => v !== null && v !== undefined;
  for (const [family, byPrevious] of Object.entries(previous.summary ?? {})) {
    if (pooledDiffers && family === "ALL") continue;
    const byVariant = current.summary?.[family];
    if (byVariant === undefined) {
      if (!scoped) regressions.push(`${family}: measured before, missing now`);
      continue;
    }
    for (const [variant, before] of Object.entries(byPrevious)) {
      const now = byVariant[variant];
      if (now === undefined) {
        if (!scoped) regressions.push(`${family}/${variant}: measured before, missing now`);
        continue;
      }
      const cells = headlines.map((key) => {
        const a = before[key];
        const b = now[key];
        if (!has(a)) return has(b) ? `${b.toFixed(4)} (new)` : "–";
        if (!has(b)) {
          regressions.push(`${family}/${variant}: ${key} ${a.toFixed(4)} → no value (it is no longer measured)`);
          return "**none** ✗";
        }
        const delta = b - a;
        const regressed = delta > tolerance[key] + 1e-12;
        if (regressed) {
          regressions.push(`${family}/${variant}: ${key} ${a.toFixed(4)} → ${b.toFixed(4)} (+${delta.toFixed(4)}, tolerance ${tolerance[key]})`);
        }
        const sign = delta > 0 ? "+" : "";
        return `${b.toFixed(4)} (${sign}${delta.toFixed(4)})${regressed ? " ✗" : ""}`;
      });
      lines.push(`| ${family} | ${variant} | ${cells.join(" | ")} |`);
    }
  }
  regressions.push(...absoluteViolations(current));
  return { table: [...notes, ...(notes.length > 0 ? [""] : []), ...lines].join("\n"), regressions, notes };
}

/**
 * Every {@link ABSOLUTE_LIMITS} breach in a run, whatever it is compared
 * with: `family/variant: key value > limit`, for each summary that carries
 * the key. A key it carries with no number is a breach too: unmeasured is
 * not within limits.
 */
/** The dim-lamp sessions against {@link PAPER_LOCK_GATES} at the run's CPU rate — a run that has them fails, compared or not. */
export function paperLockViolations(results) {
  const out = [];
  if (results.suite !== "session") return out;
  const cpu = results.config?.cpu ?? 1;
  const required = results.config?.paperGate === true;
  const gate = PAPER_LOCK_GATES[cpu];
  if (gate === undefined) {
    if (required) out.push(`paper gate: no floors measured at --cpu ${cpu} (only ${Object.keys(PAPER_LOCK_GATES).join(", ")})`);
    return out;
  }
  for (const session of PAPER_LOCK_SESSIONS) {
    const floor = gate.floors[session];
    const lock = results.summary?.[session]?.all?.paperLock;
    if (lock === undefined) {
      if (required) out.push(`${session}/all: required by --paper-gate, not run`);
      continue;
    }
    if (lock.runs < PAPER_LOCK_MIN_RUNS) {
      if (required) out.push(`${session}/all: ${lock.runs} runs < ${PAPER_LOCK_MIN_RUNS} required by --paper-gate`);
      continue;
    }
    if (lock.lockedShare === null || !Number.isFinite(lock.lockedShare)) out.push(`${session}/all: paperLock.lockedShare has no value (floor ${floor})`);
    else if (lock.lockedShare < floor) out.push(`${session}/all: paperLock.lockedShare ${lock.lockedShare.toFixed(3)} < floor ${floor}`);
    if (gate.firstLockP50Ms !== null && !(lock.firstLockP50 !== null && lock.firstLockP50 <= gate.firstLockP50Ms)) {
      out.push(`${session}/all: paperLock.firstLockP50 ${lock.firstLockP50 === null ? "never" : Math.round(lock.firstLockP50)} > ${gate.firstLockP50Ms} ms`);
    }
  }
  return out;
}

/** The spec's 80 % target against each dim-lamp session in the run — reported, not gated ({@link PAPER_LOCK_TARGET}). */
export function paperTargetLines(results) {
  if (results.suite !== "session") return [];
  return PAPER_LOCK_SESSIONS.flatMap((session) => {
    const lock = results.summary?.[session]?.all?.paperLock;
    if (lock === undefined || lock.lockedShare === null) return [];
    const met = lock.lockedShare >= PAPER_LOCK_TARGET;
    return [`${session}: locked ${(lock.lockedShare * 100).toFixed(0)} % of the presented time — target ${PAPER_LOCK_TARGET * 100} %: ${met ? "met" : "NOT met (reported, not gated: 5d-detector)"}`];
  });
}

export function absoluteViolations(results) {
  const limits = ABSOLUTE_LIMITS[results.suite] ?? {};
  const out = paperLockViolations(results);
  for (const [family, byVariant] of Object.entries(results.summary ?? {})) {
    for (const [variant, summary] of Object.entries(byVariant)) {
      for (const [key, limit] of Object.entries(limits)) {
        if (!(key in summary)) continue;
        const value = summary[key];
        if (value === null || value === undefined || !Number.isFinite(value)) {
          out.push(`${family}/${variant}: ${key} has no value (absolute limit ${limit})`);
        } else if (value > limit) {
          out.push(`${family}/${variant}: ${key} ${value} > absolute limit ${limit}`);
        }
      }
    }
  }
  return out;
}
