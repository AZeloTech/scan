#!/usr/bin/env node
/**
 * The framing hints against simulated people — `npm run bench:framing`.
 *
 * A closed loop, in plain Node and in milliseconds per thousand holds: a
 * person presents a page the way people do (not quite centred, a little
 * turned, at the size they hold a page at unprompted), the app's own
 * guidance (`src/lib/guidance.ts`: `rawHint`, `HintDebounce`, `ReadyCue`,
 * `motionOf`) reads the page as the live loop would — a pass every
 * `--period` ms, corners with a detector's jitter, the ready cue's stillness
 * rules — and the person answers whatever hint is on screen, after a
 * reaction time, by moving the phone: closer or back (the picture scales
 * about the camera's optical centre, which on a full-bleed layout is not the
 * middle of the part of the screen left clear by the controls — so a page
 * centred on that part drifts towards its top as the phone comes closer,
 * and people only partly correct for it), or re-centring. Nothing is
 * rendered and no detector runs: this measures the *rules* — whether every
 * framing a person can reach has a way to "ready", how long it takes, how
 * often the hint changes, how big the page ends up — not the detector, which
 * the session bench (`--suite session`) does on rendered frames.
 *
 * Geometry: a 9:16 camera frame shown object-cover on the run's viewports
 * (the rail layout's visible regions as `visible` events measured them, with
 * and without safe-area insets); papers A4 and Letter upright and an ID card
 * across; people off-centre by up to `--off` (share of the view, each axis),
 * turned up to `--turn` degrees, presenting at 55–72 % fill. The page's size
 * in the Galaxy S25 Ultra's still (its 4080×3060 photo cut to the preview's
 * 2295×4080 field of view) is the PDF's pixels.
 *
 *   node --import ./scripts/test-alias.mjs scripts/bench/framing-sim.mjs [--trials 400] [--period 150]
 *        [--off 0.08] [--turn 10] [--guidance path/to/guidance.ts] [--json out.json] [--seed 1]
 *
 * `--guidance` swaps the rules for another copy of `guidance.ts` (a "before":
 * `git show <rev>:src/lib/guidance.ts > /tmp/old.ts`), which must export the
 * same names.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const TRIALS = Number(option("trials", 400));
const PERIOD = Number(option("period", 150));
const OFF = Number(option("off", 0.08));
const TURN = Number(option("turn", 10));
const SEED = Number(option("seed", 1));
const JSON_OUT = option("json", null);
const guidancePath = path.resolve(option("guidance", "src/lib/guidance.ts"));
const G = await import(pathToFileURL(guidancePath).href);
/**
 * `--rules fillEnter=0.75,fillExit=0.8,…`: another set of framing lines
 * (`FramingRules`, `guidance.ts`) over the module's own `FRAMING`.
 */
const RULES = (() => {
  const text = option("rules", "");
  if (G.FRAMING === undefined) return undefined;
  const rules = { ...G.FRAMING };
  for (const pair of text.split(",").filter(Boolean)) {
    const [key, value] = pair.split("=");
    if (!(key in rules)) throw new Error(`--rules: unknown ${key} (known: ${Object.keys(rules).join(", ")})`);
    rules[key] = Number(value);
  }
  return rules;
})();

/* ── geometry ─────────────────────────────────────────────────────────── */

/** The camera frame, in units (9:16, upright). */
const FRAME = { width: 9, height: 16 };
/** The S25 Ultra's still cut to the preview's field of view: what the PDF's pixels are a share of. */
const STILL_FOV = { width: 2295, height: 4080 };

/**
 * The rail layout's visible regions (fractions of the frame), as the live
 * loop reports them (`visible` events): the owner's field phone, and the
 * owner's two viewports with and without Android's insets (status bar,
 * gesture bar).
 */
export const VIEWS = [
  { name: "384×726 (S25 field, Chrome UI)", x: 0.049, y: 0, width: 0.901, height: 0.722 },
  { name: "412×891", x: 0.105, y: 0, width: 0.79, height: 0.773 },
  { name: "412×891 inset 0/24", x: 0.105, y: 0, width: 0.79, height: 0.762 },
  { name: "412×891 inset 32/24", x: 0.105, y: 0.036, width: 0.79, height: 0.726 },
  { name: "440×956", x: 0.106, y: 0, width: 0.788, height: 0.789 },
  { name: "440×956 inset 0/24", x: 0.106, y: 0, width: 0.788, height: 0.778 },
  { name: "440×956 inset 36/24", x: 0.106, y: 0.038, width: 0.788, height: 0.741 },
];

/** Paper shapes: height over width as held. */
export const PAPERS = [
  { name: "A4", aspect: Math.SQRT2 },
  { name: "Letter", aspect: 11 / 8.5 },
  { name: "ID card", aspect: 53.98 / 85.6 },
];

/** A deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    normal: () => {
      const u = Math.max(1e-9, next());
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    pick: (list) => list[Math.floor(next() * list.length) % list.length],
  };
}

/**
 * The page's corners in fractions of the visible region. `page`: centre
 * (fractions of the frame), `size` its width as a share of the frame's
 * width, `aspect`, `turn` (radians).
 */
export function cornersInView(page, view) {
  const cx = page.x * FRAME.width;
  const cy = page.y * FRAME.height;
  const hw = (page.size * FRAME.width) / 2;
  const hh = hw * page.aspect;
  const c = Math.cos(page.turn);
  const s = Math.sin(page.turn);
  const at = (dx, dy) => {
    const X = cx + dx * c - dy * s;
    const Y = cy + dx * s + dy * c;
    return { x: (X / FRAME.width - view.x) / view.width, y: (Y / FRAME.height - view.y) / view.height };
  };
  return { topLeft: at(-hw, -hh), topRight: at(hw, -hh), bottomRight: at(hw, hh), bottomLeft: at(-hw, hh) };
}

/** The frame position (fractions) of a point of the visible region. */
function viewToFrame(view, u, v) {
  return { x: view.x + u * view.width, y: view.y + v * view.height };
}

/** The page size (share of the frame's width) at which it fills `fill` of the view, at this turn. */
function sizeForFill(page, view, fill) {
  const probe = { ...page, size: 1 };
  const one = G.fillShare(cornersInView(probe, view));
  // Unclipped reach scales linearly with size; fillShare clips, so measure the box directly.
  const q = cornersInView(probe, view);
  const xs = Object.values(q).map((p) => p.x);
  const ys = Object.values(q).map((p) => p.y);
  const reach = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return fill / (reach || one || 1);
}

/* ── one hold ─────────────────────────────────────────────────────────── */

const DT = 1000 / 60;
const HOLD_LIMIT_MS = 15000;
/** The live loop's frame age: a pass describes a frame this old. */
const LATENCY_MS = 60;
/** The detector's corner jitter (share of the view), and the hand's tremor (share of the view, RMS, slow). */
const CORNER_JITTER = 0.002;
const TREMOR = 0.002;
/** How fast a person moves the phone closer or back: the page's size changes by this factor a second. */
const MOVE_RATE = [1.35, 1.7];

/**
 * One person, one page: presented at t = 0, answered until the ready cue
 * comes on (or {@link HOLD_LIMIT_MS}). Answers the hold's record.
 */
export function hold(view, paper, r, { off = OFF, turn = TURN, period = PERIOD } = {}) {
  const aspectView = (view.height * FRAME.height) / (view.width * FRAME.width);
  // Where the person aims: the middle of what they see, give or take `off`.
  let aim = { u: 0.5 + r.range(-off, off), v: 0.5 + r.range(-off, off) };
  const page = { x: 0, y: 0, size: 0, aspect: paper.aspect, turn: (r.range(-turn, turn) * Math.PI) / 180 };
  const placeAt = (u, v) => {
    const f = viewToFrame(view, u, v);
    page.x = f.x;
    page.y = f.y;
  };
  placeAt(aim.u, aim.v);
  const natural = r.range(0.55, 0.72);
  page.size = sizeForFill(page, view, natural);
  // How well the person keeps the page on their aim while moving closer (1: perfectly; 0: not at all).
  const servo = r.range(0.3, 1);
  const reactMs = () => r.range(600, 1000);
  const lagMs = () => r.range(200, 450);
  const rate = Math.log(r.range(MOVE_RATE[0], MOVE_RATE[1]));

  const debounce = new G.HintDebounce();
  const cue = new G.ReadyCue();
  const readings = [];
  let shownHint = null;
  let changes = 0;
  const shownLog = [];
  let nextPass = r.range(0, period);
  let passes = 0;
  let locked = false;
  let readyVerdict = false;
  // The person: what they are doing, and the hint they are answering.
  let action = null; // { kind, until | stopAt }
  let answering = null;
  let reactAt = null;
  let tremor = { u: 0, v: 0 };
  let stepDoneAt = null;
  let hintFill = null;
  const history = [];

  for (let t = 0; t <= HOLD_LIMIT_MS; t += DT) {
    // ── the person ──
    // A new hint on screen (or the one answered gone): they notice it after a
    // reaction time (a gone hint: after their lag) — and a hint they answered
    // with a step that is still up when the step is done gets another step.
    if (reactAt === null && (shownHint !== answering || (action === null && shownHint !== null && stepDoneAt !== null))) {
      reactAt = t + (shownHint === null ? lagMs() : reactMs());
      stepDoneAt = null;
    }
    if (reactAt !== null && t >= reactAt) {
      answering = shownHint;
      reactAt = null;
      const near = hintFill !== null && hintFill >= G.FILL_NEAR;
      if (answering === "move-closer") action = { kind: "closer", goal: page.size * (near ? r.range(1.08, 1.25) : r.range(1.25, 1.6)) };
      else if (answering === "move-back") action = { kind: "back", goal: page.size / r.range(1.06, 1.18) };
      else if (answering === "move-phone") action = { kind: "center", from: t, ms: r.range(500, 900), residual: { u: r.range(-0.02, 0.02), v: r.range(-0.02, 0.02) } };
      else action = null;
    }
    if (action !== null) {
      if (action.kind === "closer" || action.kind === "back") {
        const k = Math.exp((action.kind === "closer" ? rate : -rate) * (DT / 1000));
        // The picture scales about the optical centre (the frame's middle)…
        page.x = 0.5 + (page.x - 0.5) * k;
        page.y = 0.5 + (page.y - 0.5) * k;
        page.size *= k;
        // …and the person pulls the page back towards their aim, as well as they do.
        const target = viewToFrame(view, aim.u, aim.v);
        const pull = Math.min(1, (servo * DT) / 250);
        page.x += (target.x - page.x) * pull;
        page.y += (target.y - page.y) * pull;
        if (action.kind === "closer" ? page.size >= action.goal : page.size <= action.goal) {
          action = null;
          stepDoneAt = t;
        }
      } else if (action.kind === "center") {
        const goal = { u: 0.5 + action.residual.u, v: 0.5 + action.residual.v };
        const target = viewToFrame(view, goal.u, goal.v);
        const pull = Math.min(1, DT / 200);
        page.x += (target.x - page.x) * pull;
        page.y += (target.y - page.y) * pull;
        if (t - action.from >= action.ms) {
          aim = goal;
          action = null;
          stepDoneAt = t;
        }
      }
    }
    // A person who answered a hint that has since gone stops (after their lag, handled by reactAt).
    // The hand's slow tremor.
    tremor = { u: tremor.u * 0.95 + r.normal() * TREMOR * 0.25, v: tremor.v * 0.95 + r.normal() * TREMOR * 0.25 };
    const seen = { ...page, x: page.x + tremor.u * view.width, y: page.y + tremor.v * view.height };
    history.push({ t, page: seen });
    while (history.length > 0 && t - history[0].t > LATENCY_MS + period) history.shift();

    // ── the app: a pass ──
    if (t >= nextPass) {
      nextPass = t + period * r.range(0.85, 1.15);
      passes += 1;
      const frameAt = t - LATENCY_MS;
      const old = history.find((h) => h.t >= frameAt) ?? history[history.length - 1];
      const quad = cornersInView(old.page, view);
      for (const key of Object.keys(quad)) {
        quad[key] = { x: quad[key].x + r.normal() * CORNER_JITTER, y: quad[key].y + r.normal() * CORNER_JITTER };
      }
      if (passes >= 3) locked = true;
      if (locked) {
        readings.push({ at: frameAt, quad });
        while (readings.length > 0 && frameAt - readings[0].at > 3000) readings.shift();
        readyVerdict = stillEnough(readings, aspectView, period, cue.since, frameAt);
      }
    }
    // ── the app: the guidance, every animation frame ──
    const sheet = readings.length > 0 ? readings[readings.length - 1].quad : null;
    const motion = locked ? G.motionOf(readings, aspectView, Math.max(G.SHAKE_WINDOW_MS, 2.5 * period)) : null;
    const raw = G.rawHint(
      { now: t, since: 0, locked, sheet: locked ? sheet : null, sheetSeenAt: locked ? t : null, cutOff: false, aspect: aspectView, motion, sharp: true, bright: null, glare: null },
      debounce.current,
      RULES,
    );
    const shown = debounce.update(raw, t);
    if (shown !== shownHint) {
      changes += 1;
      shownLog.push({ t: Math.round(t), hint: shown, fill: sheet === null ? null : Math.round(G.fillShare(sheet) * 1000) / 1000 });
      shownHint = shown;
      hintFill = sheet === null ? null : G.fillShare(sheet);
    }
    const strict = locked && raw === null && shown === null && readyVerdict;
    const keep = locked && shown === null && raw === null;
    const ready = cue.update(strict, keep, t);
    if (ready) {
      const quad = cornersInView(page, view);
      return {
        readyMs: t,
        changes,
        hints: shownLog,
        fill: G.fillShare(quad),
        px: Math.round(page.size * STILL_FOV.width),
        margin: G.borderMargin(quad),
      };
    }
  }
  return { readyMs: null, changes, hints: shownLog, fill: G.fillShare(cornersInView(page, view)), px: Math.round(page.size * STILL_FOV.width), margin: G.borderMargin(cornersInView(page, view)) };
}

/** The live loop's stillness verdict (`useLiveDetect.ts` stillEnough), on the readings so far. */
function stillEnough(readings, aspect, intervalMs, since, at) {
  const period = Math.max(intervalMs, G.readingSpacing(readings));
  const stillWindow = Math.max(G.STILL_WINDOW_MS, 1.2 * period);
  const stillness = G.motionOf(readings, aspect, stillWindow);
  const driftWindow = Math.max((since === null ? 0 : at - since) + stillWindow, (G.READY_MIN_READINGS - 0.5) * period);
  const drift = G.motionOf(readings, aspect, driftWindow);
  const newest = readings[readings.length - 1]?.at ?? at;
  const seen = readings.filter((r) => newest - r.at <= driftWindow).length;
  const driftMax = seen >= G.READY_DENSE_READINGS ? G.READY_DRIFT_MAX : G.READY_DRIFT_MAX_SPARSE;
  return seen >= G.READY_MIN_READINGS && stillness !== null && stillness <= G.STILL_MAX && drift !== null && drift <= driftMax;
}

/* ── the run ──────────────────────────────────────────────────────────── */

const q = (xs, f) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};

export function run({ trials = TRIALS, period = PERIOD, off = OFF, turn = TURN, seed = SEED, views = VIEWS, papers = PAPERS } = {}) {
  const rows = [];
  for (const view of views) {
    for (const paper of papers) {
      const r = rng(seed * 7919 + views.indexOf(view) * 131 + papers.indexOf(paper));
      const holds = [];
      for (let i = 0; i < trials; i += 1) holds.push(hold(view, paper, r, { off, turn, period }));
      const ready = holds.filter((h) => h.readyMs !== null);
      const times = holds.map((h) => (h.readyMs === null ? Infinity : h.readyMs));
      const back = holds.reduce((n, h) => n + h.hints.filter((e) => e.hint === "move-back").length, 0);
      const backFalse = holds.reduce(
        (n, h) => n + h.hints.filter((e) => e.hint === "move-back" && e.fill !== null && e.fill < (RULES?.fillExit ?? G.FILL_EXIT)).length,
        0,
      );
      const flips = holds.reduce((n, h) => {
        let k = 0;
        const framing = h.hints.filter((e) => e.hint === "move-back" || e.hint === "move-closer");
        for (let j = 1; j < framing.length; j += 1) if (framing[j].hint !== framing[j - 1].hint) k += 1;
        return n + k;
      }, 0);
      const seconds = holds.reduce((s, h) => s + (h.readyMs ?? HOLD_LIMIT_MS) / 1000, 0);
      rows.push({
        view: view.name,
        paper: paper.name,
        holds: holds.length,
        readyShare: ready.length / holds.length,
        readyMedMs: q(times, 0.5),
        readyP90Ms: q(times, 0.9),
        within2500: holds.filter((h) => h.readyMs !== null && h.readyMs <= 2500).length / holds.length,
        hintChangesPerS: holds.reduce((n, h) => n + h.changes, 0) / seconds,
        hintChangesPerHold: holds.reduce((n, h) => n + h.changes, 0) / holds.length,
        moveBackShown: back,
        moveBackUnderExit: backFalse,
        closerBackFlips: flips,
        centerShown: holds.reduce((n, h) => n + h.hints.filter((e) => e.hint === "move-phone").length, 0),
        fillAtReadyMed: q(ready.map((h) => h.fill), 0.5),
        pxMed: q(ready.map((h) => h.px), 0.5),
        pxP10: q(ready.map((h) => h.px), 0.1),
      });
    }
  }
  return rows;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const rows = run();
  const fmt = (v) => (v === null ? "–" : v === Infinity ? "never" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v);
  const columns = ["view", "paper", "readyShare", "readyMedMs", "readyP90Ms", "within2500", "hintChangesPerS", "hintChangesPerHold", "moveBackShown", "moveBackUnderExit", "closerBackFlips", "centerShown", "fillAtReadyMed", "pxMed", "pxP10"];
  console.log(`framing-sim: ${TRIALS} people per cell · pass every ${PERIOD} ms · off-centre ≤ ${OFF * 100} % · turned ≤ ${TURN}° · rules ${path.relative(process.cwd(), guidancePath)}${RULES === undefined ? "" : ` ${JSON.stringify(RULES)}`}`);
  console.log(columns.join("\t"));
  for (const row of rows) console.log(columns.map((c) => fmt(row[c])).join("\t"));
  const all = rows.flatMap((row) => Array(row.holds).fill(row));
  const med = q(rows.map((row) => row.readyMedMs), 0.5);
  console.log(`overall: median of cell medians ${fmt(med)} ms · ready ${(rows.reduce((s, r) => s + r.readyShare * r.holds, 0) / all.length * 100).toFixed(1)} % · move-back under the exit line ${rows.reduce((s, r) => s + r.moveBackUnderExit, 0)} · closer↔back flips ${rows.reduce((s, r) => s + r.closerBackFlips, 0)} · hint changes/s ${(rows.reduce((s, r) => s + r.hintChangesPerS, 0) / rows.length).toFixed(2)} (per hold ${(rows.reduce((s, r) => s + r.hintChangesPerHold, 0) / rows.length).toFixed(2)}) · within 2.5 s ${(rows.reduce((s, r) => s + r.within2500, 0) / rows.length * 100).toFixed(0)} % · px med ${q(rows.map((r) => r.pxMed), 0.5)} · fill at ready ${q(rows.map((r) => r.fillAtReadyMed), 0.5)?.toFixed(3)}`);
  if (JSON_OUT !== null) writeFileSync(JSON_OUT, JSON.stringify({ trials: TRIALS, period: PERIOD, off: OFF, turn: TURN, rows }, null, 1));
}
