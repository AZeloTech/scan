/**
 * Scoring the straighten suite: one verdict per scene, then the numbers a
 * run is judged by. Pure — records in, verdicts and summaries out — so every
 * threshold here is unit-tested (`straighten-score.test.mjs`) and `--compare`
 * gates on exactly these numbers.
 *
 * Every page is judged as **the page the user would see** (the engine's
 * surface when it was accepted, else the flat page — rotated and painted when
 * the text-deskew step acted) against **the ORIGINAL flat page of the
 * confirmed outline**, never against itself.
 *
 * A should-act page (|θ| ≥ 0.5° or any curl) lands in exactly one of five
 * classes, all over the same denominator:
 *
 *  - `noop`       nothing was done: the user sees the flat page;
 *  - `harm`       it acted and made the page worse (more tilt, more bow,
 *                 print lost, background brought into a straight page);
 *  - `unverified` it acted, no harm was found, but a check it needed could
 *                 not be measured (a NaN tilt or bow, too little print) —
 *                 never counted as a success;
 *  - `complete`   acted, no harm, tilt within tolerance and curl reduced;
 *  - `partial`    acted, no harm, measured, but not complete.
 *
 * A page with nothing to do is `left-alone`, `harm`, `unverified` or
 * `acted-ok` (acted without measurable harm).
 */

/** Tolerances: measurement noise, not product judgement. */
export const TOL = {
  /** Final |tilt| above the flat page's by more than this: harm. */
  tiltWorseDeg: 0.3,
  /** Final |tilt| at most this: the tilt is fixed. */
  tiltFixedDeg: 0.35,
  /** Bow worse by more than max(abs, rel × flat bow): harm. */
  bowWorseAbs: 0.0015,
  bowWorseRel: 0.25,
  /** Final bow at most this share of the flat page's: the curl is fixed. */
  bowFixedRel: 0.6,
  /** Background newly visible in the outer 2 % band, as a share of it. */
  wedgeDarkFrac: 0.03,
  /** A should-act page: |θ| at least this, or any curl. */
  shouldActDeg: 0.5,
  /** The finished page's aspect off the flat page's by more than this share: stretched, harm. */
  aspectDrift: 0.01,
};

/** The app's device budget for Endireitar (engine + deskew), ms. */
export const DEVICE_BUDGET_MS = 12_000;

const CURLED = (curl) => curl !== "none" && curl !== "unknown" && curl !== undefined;
const finite = Number.isFinite;
/** A measure as a number: JSON writes NaN as null, and null must stay "unmeasured", never 0. */
const val = (v) => (typeof v === "number" ? v : NaN);

/**
 * One scene's verdict. `r.final` is the measured final page, or null when it
 * is the flat page itself (nothing acted).
 */
export function verdict(r) {
  if (r.error) return { cls: "error", acted: false, accepted: false, deskewed: false, harm: false, harmWhy: [], unverified: false, unverifiedWhy: [] };
  const accepted = r.outcome.accepted === true;
  const deskewed = r.deskew?.act === true;
  const acted = accepted || deskewed;
  const flat = r.flat;
  const page = acted ? r.final : flat;
  const harmWhy = [];
  const unverifiedWhy = [];
  const truthTilt = Math.abs(r.truth.tiltDeg);
  const curled = CURLED(r.truth.curl);
  let darkWedge = false;
  if (acted) {
    const ft = Math.abs(val(flat.tiltDeg)), ot = Math.abs(val(page.tiltDeg));
    if (finite(ft) && finite(ot)) {
      if (ot > ft + TOL.tiltWorseDeg) harmWhy.push(`tilt ${ft.toFixed(1)}→${ot.toFixed(1)}°`);
    } else unverifiedWhy.push(`tilt unmeasured (flat ${ft}, final ${ot})`);
    // Only the engine's surface can bend lines; a homography or a rotation
    // cannot, so a bow change on a deskew-only page is estimator noise.
    if (accepted) {
      const fb = val(flat.bowFrac), ob = val(page.bowFrac);
      if (finite(fb) && finite(ob)) {
        if (ob > fb + Math.max(TOL.bowWorseAbs, TOL.bowWorseRel * fb)) harmWhy.push(`bow ${(fb * 100).toFixed(2)}→${(ob * 100).toFixed(2)}%`);
      } else unverifiedWhy.push("bow unmeasured");
    }
    if (r.clip === null || r.clip === undefined) unverifiedWhy.push("clipping unmeasured");
    else if (r.clip.clipped === true) harmWhy.push(`clipped (${r.clip.why})`);
    else if (r.clip.clipped === null) unverifiedWhy.push(`clipping unmeasured (${r.clip.why})`);
    darkWedge = val(page.borderDarkFrac) > val(flat.borderDarkFrac) + TOL.wedgeDarkFrac;
    // Background brought into the frame is the price of turning print skewed
    // inside a correct outline — by the deskew, or by the engine levelling
    // the lines it models, which uncovers the same corners. Only there: with
    // no tilt to straighten, or with the print shrunk into a frame of it
    // (scaled, not turned), it is harm.
    const shrunk = r.clip?.shrunk === true;
    if (darkWedge && (truthTilt < TOL.shouldActDeg || shrunk)) {
      harmWhy.push(
        `background framed in (${(flat.borderDarkFrac * 100).toFixed(0)}→${(page.borderDarkFrac * 100).toFixed(0)}% of border${shrunk ? ", print shrunk" : ""})`,
      );
    }
    // The page's proportions: a rotation composed with a perspective outline
    // must not stretch it (records without dims predate the check).
    const dims = r.dims;
    if (dims?.flat && dims?.final) {
      const drift = dims.final[0] / dims.final[1] / (dims.flat[0] / dims.flat[1]) - 1;
      if (Math.abs(drift) > TOL.aspectDrift) {
        harmWhy.push(`stretched ${dims.flat.join("×")}→${dims.final.join("×")} (${(drift * 100).toFixed(1)}% aspect)`);
      }
    }
  }
  const harm = harmWhy.length > 0;
  // The fix needs the measurements its own verdict reads.
  const pageTilt = Math.abs(val(page.tiltDeg));
  const tiltOk = truthTilt < TOL.shouldActDeg || (finite(pageTilt) && pageTilt <= TOL.tiltFixedDeg);
  let curlOk = true;
  // Real stills carry no curl truth: a "complete" there is the tilt alone.
  const curlGraded = r.truth.curl !== "unknown";
  if (curled) {
    const fb = val(flat.bowFrac), ob = val(page.bowFrac);
    if (finite(ob) && finite(fb)) curlOk = ob <= TOL.bowFixedRel * fb;
    else {
      curlOk = false;
      if (acted && !unverifiedWhy.includes("bow unmeasured")) unverifiedWhy.push("bow unmeasured");
    }
  }
  const unverified = acted && !harm && unverifiedWhy.length > 0;
  let cls;
  if (r.truth.shouldAct) {
    if (!acted) cls = "noop";
    else if (harm) cls = "harm";
    else if (unverified) cls = "unverified";
    else cls = tiltOk && curlOk ? "complete" : "partial";
  } else if (!acted) cls = "left-alone";
  else if (harm) cls = "harm";
  else if (unverified) cls = "unverified";
  else cls = "acted-ok";
  return {
    cls, acted, accepted, deskewed, harm, harmWhy, unverified, unverifiedWhy: unverified ? unverifiedWhy : [],
    tiltOk, curlOk, curlGraded,
    residualTilt: pageTilt,
    residualBow: val(page.bowFrac),
    darkWedge,
    painted: r.paint?.paintedFrac != null && r.paint.paintedFrac > PAINTED_MIN_FRAC,
    seam: r.paint?.seam === true,
    paintUnmeasured: acted && (r.paint === null || r.paint === undefined || r.paint.paintedFrac === null),
  };
}

/** A page counts as painted with more than this share of painted blocks. */
export const PAINTED_MIN_FRAC = 0.002;

export function quantile(xs, p) {
  const a = xs.filter(finite).sort((u, v) => u - v);
  if (!a.length) return null;
  const i = p * (a.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

const rate = (n, d) => (d > 0 ? n / d : null);
const count = (xs, f) => xs.filter(f).length;
const r4 = (v) => (v === null || v === undefined ? null : Math.round(v * 1e4) / 1e4);

/** Engine + deskew time of one page, ms (what the device budget covers). */
export const pageMs = (r) => (r.timing?.gateMs ?? 0) + (r.timing?.deskewMs ?? 0);

/**
 * The numbers of one group of scene rows (`{ ...record, verdict }`). Counts
 * sit beside every rate; rates are over the should-act pages unless named.
 */
export function summarize(rows) {
  const ok = rows.filter((r) => !r.error);
  const sa = ok.filter((r) => r.truth.shouldAct);
  const ntd = ok.filter((r) => !r.truth.shouldAct);
  const cls = (k) => count(sa, (r) => r.verdict.cls === k);
  const tiltOnly = sa.filter((r) => Math.abs(r.truth.tiltDeg) >= TOL.shouldActDeg && !CURLED(r.truth.curl));
  const curled = sa.filter((r) => CURLED(r.truth.curl));
  const flatStraight = ok.filter((r) => r.truth.flatAndStraight);
  const complete = cls("complete");
  const curlComplete = count(curled, (r) => r.verdict.cls === "complete");
  const tiltComplete = count(tiltOnly, (r) => r.verdict.cls === "complete");
  const acted = ok.filter((r) => r.verdict.acted);
  return {
    scenes: rows.length,
    errors: rows.length - ok.length,
    shouldAct: sa.length,
    acted: acted.length,
    accepted: count(ok, (r) => r.verdict.accepted),
    deskewed: count(ok, (r) => r.verdict.deskewed),
    noop: cls("noop"),
    partial: cls("partial"),
    complete,
    harm: cls("harm"),
    unverified: cls("unverified"),
    noopRate: r4(rate(cls("noop"), sa.length)),
    partialRate: r4(rate(cls("partial"), sa.length)),
    completeRate: r4(rate(complete, sa.length)),
    harmRate: r4(rate(cls("harm"), sa.length)),
    unverifiedRate: r4(rate(cls("unverified"), sa.length)),
    unfixedRate: r4(rate(sa.length - complete, sa.length)),
    // Harms over every page, and on the pages with nothing to do.
    harmCount: count(ok, (r) => r.verdict.harm),
    flatHarms: count(ntd, (r) => r.verdict.harm),
    nothingToDo: ntd.length,
    nothingToDoActed: count(ntd, (r) => r.verdict.acted),
    unverifiedCount: count(ok, (r) => r.verdict.unverified),
    flatAndStraight: flatStraight.length,
    trueNoopRate: r4(rate(count(flatStraight, (r) => !r.verdict.harm), flatStraight.length)),
    tiltCases: tiltOnly.length,
    tiltComplete,
    tiltCompleteRate: r4(rate(tiltComplete, tiltOnly.length)),
    curlCases: curled.length,
    curlComplete,
    curlCompleteRate: r4(rate(curlComplete, curled.length)),
    curlUnfixedRate: r4(rate(curled.length - curlComplete, curled.length)),
    residTiltP50: r4(quantile(sa.map((r) => r.verdict.residualTilt), 0.5)),
    residTiltP90: r4(quantile(sa.map((r) => r.verdict.residualTilt), 0.9)),
    residTiltUnmeasured: count(sa, (r) => !finite(r.verdict.residualTilt)),
    tiltOnlyResidP50: r4(quantile(tiltOnly.map((r) => r.verdict.residualTilt), 0.5)),
    tiltOnlyResidP90: r4(quantile(tiltOnly.map((r) => r.verdict.residualTilt), 0.9)),
    curlResidBowP50: r4(quantile(curled.map((r) => r.verdict.residualBow), 0.5)),
    darkWedges: count(ok, (r) => r.verdict.darkWedge),
    paintedPages: count(ok, (r) => r.verdict.painted),
    seamCount: count(ok, (r) => r.verdict.seam),
    paintUnmeasured: count(ok, (r) => r.verdict.paintUnmeasured),
    timeouts: count(ok, (r) => r.outcome.reason === "timeout"),
    overBudget: count(ok, (r) => pageMs(r) > DEVICE_BUDGET_MS),
    stageMsP50: r4(quantile(ok.map((r) => r.timing.stageMs), 0.5)),
    stageMsP90: r4(quantile(ok.map((r) => r.timing.stageMs), 0.9)),
    deskewMsP50: r4(quantile(ok.filter((r) => r.deskew).map((r) => r.timing.deskewMs), 0.5)),
    deskewMsP90: r4(quantile(ok.filter((r) => r.deskew).map((r) => r.timing.deskewMs), 0.9)),
  };
}

/**
 * The groups a run is summarized (and gated) by: `ALL`, then each synthetic
 * family and the tilted-print-in-a-correct-outline case on its own; for real
 * media, each variant.
 */
export function groupsOf(rows) {
  const groups = [["ALL", () => true]];
  const synthetic = rows.some((r) => r.suite === "synthetic");
  if (synthetic) {
    for (const family of ["tilt", "curl", "rotation"]) {
      if (rows.some((r) => r.axes.family === family)) groups.push([family, (r) => r.axes.family === family]);
    }
    if (rows.some((r) => r.axes.family === "tilt" && r.axes.quadMode === "correct")) {
      groups.push(["tilt/correct", (r) => r.axes.family === "tilt" && r.axes.quadMode === "correct"]);
    }
  } else {
    for (const variant of [...new Set(rows.map((r) => r.axes.variant))]) groups.push([variant, (r) => r.axes.variant === variant]);
  }
  return groups;
}

/** `{ [group]: { final: summary } }` — the shape `report.mjs`'s `--compare` reads. */
export function summarizeRun(rows) {
  const out = {};
  for (const [name, member] of groupsOf(rows)) {
    const group = rows.filter(member);
    if (group.length > 0) out[name] = { final: summarize(group) };
  }
  return out;
}

/**
 * Per-scene regressions against a baseline run's rows: a scene that was a
 * complete fix and no longer is (a lost fix), a scene harmed now that was not
 * (a new harm), and a scene the baseline measured that this run did not.
 * Scenes new in this run are not judged.
 */
export function sceneRegressions(previousRows, currentRows) {
  const now = new Map(currentRows.map((r) => [r.id, r]));
  const lostFixes = [];
  const newHarms = [];
  const missing = [];
  for (const before of previousRows ?? []) {
    const after = now.get(before.id);
    if (after === undefined) {
      missing.push(before.id);
      continue;
    }
    const b = before.verdict?.cls, a = after.verdict?.cls;
    if (b === "complete" && a !== "complete") lostFixes.push({ id: before.id, now: a, why: [...(after.verdict?.harmWhy ?? []), ...(after.verdict?.unverifiedWhy ?? [])] });
    if (a === "harm" && b !== "harm") newHarms.push({ id: before.id, before: b, why: after.verdict.harmWhy });
  }
  return { lostFixes, newHarms, missing };
}

/** The same, as `--compare` regression lines. */
export function sceneRegressionLines(previous, current) {
  const { lostFixes, newHarms, missing } = sceneRegressions(previous.rows, current.rows);
  return [
    ...lostFixes.map((s) => `scene ${s.id}: lost fix (complete → ${s.now}${s.why.length ? `: ${s.why.join("; ")}` : ""})`),
    ...newHarms.map((s) => `scene ${s.id}: new harm (${s.before} → harm: ${s.why.join("; ")})`),
    ...missing.map((id) => `scene ${id}: measured before, missing now`),
  ];
}

/** Scenes whose before/after sheet is worth a look: harms, unverified pages, lost fixes, new acts. */
export function flaggedScenes(rows, previousRows = null) {
  const before = new Map((previousRows ?? []).map((r) => [r.id, r]));
  const out = new Map();
  const flag = (id, why) => out.set(id, [...(out.get(id) ?? []), why]);
  for (const r of rows) {
    if (r.error) continue;
    const v = r.verdict;
    if (v.harm) flag(r.id, "harm");
    if (v.unverified) flag(r.id, "unverified");
    if (v.seam) flag(r.id, "seam");
    const b = before.get(r.id);
    if (b === undefined || b.verdict === undefined) continue;
    if (v.acted && !b.verdict.acted) flag(r.id, "new act");
    if (b.verdict.cls === "complete" && v.cls !== "complete") flag(r.id, "lost fix");
  }
  return out;
}

/** Per-|θ| rows over the synthetic tilt family (optionally one outline mode). */
export function perTilt(rows, quadMode = null) {
  const sel = rows.filter((r) => !r.error && r.axes.family === "tilt" && (quadMode === null || r.axes.quadMode === quadMode));
  const keys = [...new Set(sel.map((r) => Math.abs(r.truth.tiltDeg)))].sort((a, b) => a - b);
  return keys.map((k) => {
    const g = sel.filter((r) => Math.abs(r.truth.tiltDeg) === k);
    const errs = g.filter((r) => r.deskew && finite(r.deskew.deg)).map((r) => Math.abs(r.deskew.deg - r.truth.tiltDeg));
    const abstain = {};
    for (const r of g) if (r.deskew && !r.deskew.act) abstain[r.deskew.reason] = (abstain[r.deskew.reason] ?? 0) + 1;
    return {
      tilt: k, n: g.length,
      deskewed: count(g, (r) => r.verdict.deskewed), accepted: count(g, (r) => r.verdict.accepted),
      complete: count(g, (r) => r.verdict.cls === "complete"), harm: count(g, (r) => r.verdict.harm),
      unverified: count(g, (r) => r.verdict.unverified), noop: count(g, (r) => r.verdict.cls === "noop" || r.verdict.cls === "left-alone"),
      residP50: quantile(g.map((r) => r.verdict.residualTilt), 0.5), residP90: quantile(g.map((r) => r.verdict.residualTilt), 0.9),
      estErrP90: quantile(errs, 0.9), abstain,
    };
  });
}

/** Engine outcomes: accepted or `#code reason`, with should-act / nothing-to-do counts. */
export function outcomeHistogram(rows) {
  const m = new Map();
  for (const r of rows) {
    if (r.error) continue;
    const key = r.outcome.accepted ? "accepted" : `${r.outcome.code ?? "?"} ${r.outcome.reason}`;
    const e = m.get(key) ?? { key, n: 0, shouldAct: 0, nothingToDo: 0 };
    e.n += 1;
    if (r.truth.shouldAct) e.shouldAct += 1;
    else e.nothingToDo += 1;
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

/** scan-store.ts :: dewarpOutcomeIsFinal — the declines a re-run would repeat. */
const FINAL_BUCKETS = new Set(["nothing", "declined", "unverified", "page"]);

/**
 * The sentence the page view's card would show for this page — the app's
 * `straightenOutcome` (scan-store.ts), rebuilt from the record: what the tap
 * corrected (tilt, curl, both, tilt-only), or why it corrected nothing. Null
 * for a page the step never ran on. Held against the verdict, it is how the
 * copy is checked for honesty: "nothing" said over a page that needed work
 * is a false claim, whatever the pixels.
 */
export function cardOf(r) {
  if (r.error || !r.outcome) return null;
  const d = r.deskew ?? null;
  // "Level and flat", as measured: an older record has no `flat` and falls
  // back to the evidence alone, as its app did.
  const levelFlat = !!d?.level && d.level.evidence === false && d.level.flat !== false;
  const bucket = r.outcome.bucket ?? "transient";
  if (r.outcome.accepted) {
    // The tilt is claimed only when the engine's surface measured level.
    if (d?.planned && d.engineLevel !== false) return "both";
    // Accepted on a page measured level and flat: the app claims no curl.
    return levelFlat ? "none" : "curl";
  }
  if (d?.act) {
    if (r.outcome.reason === "curl-absent") return "tilt";
    // The curve could not be checked (the engine failed rather than declined).
    return FINAL_BUCKETS.has(bucket) || bucket === "better-flat" ? "tilt-only" : "tilt-retry";
  }
  // A straighten that could not finish is worth a retry, whatever the engine said.
  if (d?.failed) return "transient";
  if (FINAL_BUCKETS.has(bucket) && levelFlat) return "nothing";
  return bucket === "better-flat" ? "declined" : bucket;
}

/** Pages per card sentence, by what the page needed and what it got. */
export function cardHistogram(rows) {
  const m = new Map();
  for (const r of rows) {
    const key = cardOf(r);
    if (key === null) continue;
    const e = m.get(key) ?? { key, n: 0, complete: 0, partial: 0, noop: 0, harm: 0, unverified: 0, nothingToDo: 0 };
    e.n += 1;
    if (!r.truth.shouldAct) e.nothingToDo += 1;
    else if (r.verdict.cls in e) e[r.verdict.cls] += 1;
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}
