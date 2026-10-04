"use client";

/**
 * Capture-time edge refinement: the corners that seed the confirm screen,
 * moved onto the paper's actual edge.
 *
 * Neither detector answers at the paper's edge. The model (DocCornerNet, on a
 * ~256 px view of the frame) sits slightly *inside* the page as a rule —
 * clipping 1–6 % of it on the bench's synthetic desks — and on a low-contrast
 * table it can pull a corner onto the edge of the text block or a shading
 * band, 5–25 % of the diagonal in. The classical detector's confident failure
 * is the desk. Refinement measures the edge itself, on the full-resolution
 * capture, with the detector's quad as a **prior**:
 *
 *  1. **Local** (every side): 64 profiles across the side, within ±2.5 % of
 *     the diagonal. Along each, a box step (the mean of the 3 px inside minus
 *     the 3 px outside, in luma and two chroma channels) marks where one
 *     material ends — the strongest few per profile, the strongest in each
 *     stretch of it and the outermost two, so a dense run of printed rules
 *     cannot crowd out a faint edge; a vote over lines within 4° of the side,
 *     each refitted through one colour-consistent point per profile, gives
 *     the candidate edges. An edge counts when most profiles agree, it is
 *     straight, and the strip just inside it is **paper** — the page's stock,
 *     whatever its colour: the dominant material along the page's border (a
 *     white sheet's white, a navy card's navy, a kraft envelope's brown), read
 *     next to each profile so a hand's shadow or a lamp's glare does not
 *     change what paper looks like. A thin printed line just inside the edge
 *     (a form's border a few px in) still leaves paper inside; a thin printed
 *     line with the page's paper past it is print, never an edge. Of the
 *     edges, the **outermost** wins: a header band's edge, a table rule, the
 *     text block all have more paper beyond them; the page's edge does not.
 *     (A line turned a degree off a better one, running close to it along
 *     most of the side, is not a line of its own.)
 *  2. **Wide** (the model's quads only): when no page edge was found nearby
 *     and paper lies right beyond the side (within 5 % of the diagonal, not
 *     a white object across the desk), the same search out to 18 %, at
 *     up to 25° from the prior side — the corner the model pulled onto the
 *     text, taken back to the page's. The move must stay on the page: no
 *     stretch of a dark desk seen outside the other sides (one dark enough to
 *     pass for a band of ink) may lie between the side's edge and the new
 *     line, and past a found edge with paper or the desk right outside it
 *     there is no search at all. A side moved this far is believed only
 *     when at least one of the two sides it meets was found as well; a side
 *     still unfound between two found ones is searched once more at up to 40°.
 *  3. Corners are where adjacent lines cross. The quad must stay convex, wound
 *     as the input was, with sane angles, on the image, over most of the
 *     input and within a bounded area change; if not, sides fall back one at
 *     a time — wide to local, local to the prior — and, last, to the input.
 *  4. **Occluded** (the model's quads; 5d+): a side still unfound — or found
 *     on the outline of a sheet lying over the page (the occluder guard) — is
 *     read again, deeper, and fitted on the longest **visible run** of its
 *     edge alone: a straight paper edge with the background outside, running
 *     from one end of the side at up to 40° from the prior, and past its open
 *     end the edge covered (paper where the desk was, a clip across it). A
 *     covered corner is where two such lines meet — never the occluder's own
 *     outline. A page on a board (a clipboard) has its edges found against
 *     the board. Every corner then says how it was got
 *     ({@link CornerProvenance}: seen, inferred, unknown — by walking each of
 *     its edges' lines from it), and whether another sheet overlaps the page
 *     ({@link OcclusionReport}); a run line is kept only when it places a
 *     covered corner.
 *
 * The paper read along the sides is the page's white margin when its print
 * fills the interior (an imaging report's near-black panels).
 *
 * What it will not do, by construction:
 *  - **move a side inward across page content**: an inward move is allowed
 *    only over a strip that looks like the background outside the prior and
 *    unlike the paper inside, with no different paper beyond it, and — unless
 *    it is shallow — that has no straight edge of its own further out (a band
 *    that ends in an edge is the page's: a fold's shaded margin, a full-bleed
 *    header, a curled strip); and only when enough of the side can see the
 *    background to say so — a prior on the frame's edge stays — and both
 *    ends of it cut background too: a side bowed in at its middle (a curled
 *    receipt) is not cut along its chord. A sliver of desk in the crop beats
 *    a clipped report;
 *  - **go past paper meeting paper**: an edge with paper-coloured surface
 *    right outside it (the sheet underneath, a white table) ends the search,
 *    because two sheets of one stock differ by nothing but a thin shadow;
 *  - **go past a page's edge to the desk and beyond**: an edge with background
 *    right outside it is not searched past (a dark surface outside it is a
 *    printed band only when it is not the desk seen past the other sides),
 *    and an outer line with the same even surface outside it as a nearer edge
 *    is the pattern again — a striped cloth, a tiled counter;
 *  - **put a corner off the image**: the side that would falls back;
 *  - **search wide from a classical quad** (`mode: "local"`): that detector's
 *    confident failure is the desk, and a wide search from the desk would
 *    only make the desk look more like a page.
 *
 * The core ({@link refineQuad}) is pure: an RGBA or grey buffer in, a quad
 * out, deterministic, never throws, bounded in time — on any doubt it answers
 * the input unchanged with its reasons. {@link refineOnCanvas} is the thin
 * wrapper the capture path calls: one downscale into a reused canvas, one
 * read-back. No pixels leave it; no JPEG is encoded here.
 */

import { releaseSurface } from "@/lib/canvas-surface";
import type { NormalizedQuad } from "@/lib/quad";

/** A frame as the core reads it: RGBA (4 bytes a pixel) or grey (1 byte a pixel). */
export interface RefineImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/**
 * How a side ended up: snapped nearby, found by the wide search, fitted on
 * the visible run of an edge something lies over ({@link CornerReport}), or
 * left where it was.
 */
export type SideMode = "local" | "wide" | "occluded" | "kept";

/**
 * Where a corner of the answer comes from: `seen` — the page's own corner,
 * or nothing says otherwise; `inferred` — something lies over it (a sheet, a
 * clip) and it is where the visible runs of its two edges meet, extended;
 * `unknown` — something lies over it and its edges are not seen well enough
 * to extend (the corner is the detector's, and nobody should trust it).
 */
export type CornerProvenance = "seen" | "inferred" | "unknown";

/** One corner's provenance — TL, TR, BR, BL, the input's order. */
export interface CornerReport {
  provenance: CornerProvenance;
  /** 0–1: how far the visible runs carry it (1: both edges seen to the corner). 0 when nothing could be measured. */
  confidence: number;
  /** Share of each of its two edges (the side before it, the side after it) seen running up to it; 0 when not measured. */
  runs: [number, number];
  /** What the provenance rests on ({@link CornerBasis}); absent on old reports. */
  basis?: CornerBasis;
}

/**
 * What a corner's provenance rests on: `edges` (both edges walked to it),
 * `rounded` (an edge stops short at the desk — a rounded or torn corner),
 * `on-sheet` (its edges seen over another sheet), `off-image`, `covered`
 * (something found over it: inferred or unknown) — or, short of evidence,
 * `no-edge` (neither edge found), `one-edge` (one edge found, the other not),
 * `short` (an edge stops short with nothing seen to say why) — called seen:
 * on the bench about a fifth of real corners rest on no more than that, and
 * calling them unknown would hold auto-capture on most pages — and
 * `unmeasured` (the refinement never got to the corners).
 */
export type CornerBasis = "edges" | "rounded" | "on-sheet" | "off-image" | "covered" | "no-edge" | "one-edge" | "short" | "unmeasured";

/** What lies over the page, as the edges show it. */
export interface OcclusionReport {
  /** A corner is covered: some corner is `inferred` or `unknown`. */
  suspected: boolean;
  /**
   * Another sheet overlaps this one: paper reaching well past two sides whose
   * own edges run to seen corners (the sheet below, or the one on top seen
   * past it); a corner of the page seen lying on another sheet; or the desk
   * inside the answer, between two sheets it spans. Two sheets, not one
   * page: "Separe as folhas".
   */
  separate: boolean;
}

/** One side's verdict — TL→TR, TR→BR, BR→BL, BL→TL. */
export interface SideReport {
  accepted: boolean;
  /**
   * `edge` (snapped), `page-continues` (moved out by the wide search), or why
   * it was kept: `no-edge`, `no-paper-edge`, `content-inside`, `fallback`.
   */
  reason: string;
  /** Share of the side's profiles that agree with its line (0–1). */
  support: number;
  /** RMS distance of the agreeing edge points from the line, in working px. */
  residualPx: number;
  /** How far the side moved at its middle, fraction of the diagonal (+ = outward). */
  shiftFrac: number;
  mode: SideMode;
}

export interface RefineResult {
  /** The refined quad — the input itself when nothing changed. */
  quad: NormalizedQuad;
  /** A corner moved by half a working pixel or more. */
  changed: boolean;
  sides: SideReport[];
  /** Each corner's provenance, TL, TR, BR, BL (all `unknown`, confidence 0, when nothing was measured: see `measured`). */
  corners: CornerReport[];
  occlusion: OcclusionReport;
  /**
   * The corners' provenance was measured on the quad returned: the run went
   * to its end and an answer's edges were walked. False for every early
   * return (budget, bad image, no paper, nothing found to measure on) — its
   * `corners` are placeholders, and nothing downstream may read them as seen.
   */
  measured: boolean;
  ms: number;
  /**
   * `refined`, `no-change` (nothing found, or every corner found where it
   * already was), or why the input came back: `budget`, `bad-quad`, `insane`, …
   */
  reason: string;
}

export interface RefineOptions {
  /** `local` never searches wide: the classical detector's quads. Default `full`. */
  mode?: "full" | "local";
  /**
   * Time bound, ms. It is checked inside every loop that grows with the image
   * or the side — every 32 rows of the planes, per profile, per 8 slopes of
   * the line vote and 256 of its peaks, per candidate line — and before the
   * corners are assembled; once past it, the input comes back unchanged.
   * What runs between two checks is ~2 ms at most on this bench's desktop
   * (noise and checkerboard textures, 1200 px) — about four times that under
   * a 4× CPU throttle.
   */
  budgetMs?: number;
  /** A clock, for tests. */
  now?: () => number;
}

// ── what the search looks for ────────────────────────────────────────────────

/** Local search reach, each way, as a fraction of the image diagonal. */
const LOCAL_BAND = 0.025;
/** Wide search reach outward, fraction of the diagonal. */
const WIDE_REACH = 0.18;
/** How deep inside a side the page's paper colour is read, fraction of the diagonal. */
const PAPER_DEPTH = 0.06;
/** Profiles per side (at most; one per 6 px of side, at least 12). */
const PROFILES = 64;
/** Share of each side's length left out at each end: the corner belongs to two sides. */
const CORNER_SKIP = 0.08;
/** Half-width of the box step, working px. */
const STEP_HALF = 3;
/**
 * Weakest step worth a candidate (0–255 scale, luma and chroma together): a
 * white page on a white table is a step of 6–10; sensor noise over 3 px, ~2.
 */
const MIN_STEP = 5;
/**
 * Candidates kept per profile: the strongest this many; then the strongest
 * of each of as many equal stretches of the profile (a dense run of rules or
 * text fills one stretch, not the profile); then the outermost
 * {@link OUTER_CANDIDATES} (a faint edge on a plain table is the last step
 * there is).
 */
const LOCAL_CANDIDATES = 6;
const WIDE_CANDIDATES = 16;
const OUTER_CANDIDATES = 2;
/**
 * Line-vote peaks kept per slope, strongest first: a textured desk peaks in
 * every bin, and the lines worth refitting are among the strongest few.
 */
const PEAKS_PER_SLOPE = 24;
/** Line-vote peaks sorted and de-duplicated, strongest first, at most (ties aside). */
const PEAK_POOL = 512;
/**
 * How far a refined side may turn from the prior: local; wide; and wide
 * between two sides already found (a corner pulled far along a side). Past
 * the limit by {@link TURN_SLACK_PX} at the side's last profile, no further —
 * on a short side that slack is a few degrees (8° at 60 px, 5° at 200 px).
 */
const LOCAL_MAX_ANGLE_DEG = 4;
const WIDE_MAX_ANGLE_DEG = 25;
const STEEP_MAX_ANGLE_DEG = 40;
/** How far past its angle limit a refitted line may turn, in px at the side's last profile. */
const TURN_SLACK_PX = 2;
/** A point this close to a line (working px) supports it. */
const INLIER_PX = 3;
/** Share of the profiles a line needs, and the share that makes it confident. */
const MIN_SUPPORT = 0.6;
const CONFIDENT_SUPPORT = 0.8;
/** A paper edge is straight: RMS residual of its points, working px. */
const MAX_RESIDUAL_PX = 1.5;
/** Share of a line's profiles that must have paper just inside it. */
const MIN_INNER_PAPER = 0.6;
/** The strips either side of a line that are judged paper or not: this many px from it. */
const STRIP_NEAR = 3;
const STRIP_FAR = 8;
/**
 * Paper is the bright end of a white page: its luma is this percentile of what
 * lies inside, its colour the median of what is that bright.
 */
const PAPER_PERCENTILE = 0.9;
/**
 * …unless the page is another stock: the grid rows and columns (of 24) along
 * the prior's border that its stock is read on, and the share of them that
 * one material must cover to be the page's stock rather than print on it.
 */
const PAPER_RING = 6;
const STOCK_SHARE = 0.5;
/** Where the page's own margin is read (fractions of the quad in from each side): a white page's border, whatever its print. */
const MARGIN_BAND = [0.015, 0.03];
/** Share of the border band one material must cover to be the page's margin. */
const MARGIN_SHARE = 0.3;
/**
 * Two paper readings are one paper in two lights (a shade, a blind's bands)
 * while the darker keeps this share of the lighter's luma and their colour
 * (chroma over luma) stays this close.
 */
const SHADE_FLOOR = 0.45;
const SHADE_CHROMA = 0.12;
/** Paper-like: luma within max(14, 10 %), chroma within max(10, 5 % of the luma). */
const PAPER_LUMA_TOLERANCE = 14;
const PAPER_LUMA_SHARE = 0.1;
const PAPER_CHROMA_TOLERANCE = 10;
const PAPER_CHROMA_SHARE = 0.05;
/**
 * Print on the paper: a luma this share of the paper's headroom away from it
 * (towards black on white stock, towards white on dark) — a printed rule's
 * core is 0.3–0.55 of a white page's luma, a contact shadow's 0.85–0.97.
 */
const PRINT_CONTRAST = 0.3;
/** A printed line is at most this wide (working px) — a border, a table rule — its blurred flanks aside. */
const THIN_PRINT_PX = 5;
/**
 * Share of the profiles with paper beyond a line that says the page goes on
 * past it — found within this reach of the line (fraction of the diagonal):
 * right past it, not a white object somewhere across the desk.
 */
const PAGE_CONTINUES = 0.3;
const PAGE_CONTINUES_REACH = 0.05;
/**
 * The background repeats past a line when at least this share of its profiles
 * has something other than paper just outside it, and this share of those
 * finds the same outside the outer line.
 */
const REPEAT_OTHER = 0.25;
const REPEAT_SAME = 0.6;
/**
 * A wide move crosses the desk when this share of its profiles has 12 px of
 * the desk (as seen outside the other sides) between the side's edge and the
 * new line.
 */
const CROSSES_DESK = 0.3;
/** An even strip darker than this share of the paper's luma is ink: a printed band. */
const INK_LUMA_SHARE = 0.5;
/** Luma spread (0–255) within which a strip counts as one even material. */
const UNIFORM_SPREAD = 16;
/** A wide answer must lie at least this far (working px) past the local one. */
const WIDE_MIN_GAIN_PX = 4;
/**
 * An inward move no deeper than this (fraction of the diagonal) is allowed
 * even when the strip it cuts has an edge of its own beyond it.
 */
const SHALLOW_CUT = 0.005;
/**
 * How far inside the prior (working px, at a side's last profile) a line may
 * run, from being turned against it, before its inward move is checked.
 */
const INWARD_TURN_SLACK_PX = 6;
/** Profiles that must see the strip an inward move cuts, and the background past the prior, for it to be judged at all. */
const MIN_CUT_PROFILES = 3;
/**
 * Share of a side's profiles at each of its ends that an inward move must
 * cut background on, as well as along the side: half of those it measures.
 */
const CUT_ENDS = 0.25;
/** An inward move must cross this close a match to the background outside the prior (0–255 colour distance). */
const BACKGROUND_MATCH = 20;
/**
 * Two 6 px strips this far apart in colour (0–255) are two materials, not one
 * paper and its noise: a sheet on a white table differs by ~8, paper from
 * itself by ~1–2.
 */
const MATERIAL_STEP = 4;
/** The refined quad: every angle within [this, 180 − this] degrees. */
const MIN_CORNER_ANGLE_DEG = 20;
/**
 * A refined corner stays on the image (a normalized quad is 0–1 on each axis):
 * this much slack, in working px — or, for an input corner already off the
 * image, no further off than it was.
 */
const FRAME_SLACK_PX = 0.5;
/** Area of the refined quad over the prior's. */
const MIN_AREA_RATIO = 0.7;
const MAX_AREA_RATIO = 2.5;
/**
 * …down to this when a side is fitted on a visible run (pass 4): a prior
 * whose corner sat out on the sheet over the page is the union of the two,
 * often well over half again the page. The new quad must still lie inside
 * the prior ({@link MIN_OVERLAP}).
 */
const MIN_AREA_RATIO_OCCLUDED = 0.4;
/** The refined quad and the prior share at least this share of the smaller: the same page, not a neighbour. */
const MIN_OVERLAP = 0.85;
/** A corner closer than this to where it was (working px) did not move. */
const MOVED_PX = 0.5;
/** Default time bound of the core. */
const DEFAULT_BUDGET_MS = 150;

// ── time ─────────────────────────────────────────────────────────────────────

/** Thrown by {@link Clock.check} past the budget; caught in {@link refineQuad}. */
const OUT_OF_TIME = { outOfTime: true } as const;

interface Clock {
  /** Past the budget: throw {@link OUT_OF_TIME}. */
  check(): void;
}

// ── planes ───────────────────────────────────────────────────────────────────

/**
 * Luma, warmth (R − B) and tint (G − (R + B)/2): the three channels a step is
 * measured in. Whole units are plenty — sensor noise is several levels. Five
 * bytes a pixel: 4.1 MB for a 1200 × 675 frame, 5.4 MB for a 1200 × 900
 * (4:3) still, 7.2 MB for a square one — beside the RGBA read-back they come
 * from (four bytes a pixel: 3.2, 4.3, 5.8 MB), and the four sides' profiles
 * (13 bytes a sample: ~1.2 MB when the search goes wide, ~0.4 MB local).
 */
interface Planes {
  width: number;
  height: number;
  lum: Uint8ClampedArray;
  warm: Int16Array;
  tint: Int16Array;
}

/**
 * Allocated per call and dropped with it: nothing derived from a page outlives
 * the refinement of that page (a module-level cache would keep the last
 * captured report readable in memory after the scan is wiped).
 */
function toPlanes(image: RefineImage, clock: Clock): Planes | null {
  const { data, width, height } = image;
  const n = width * height;
  if (!(width > 1 && height > 1) || (data.length !== n * 4 && data.length !== n)) return null;
  const planes: Planes = { width, height, lum: new Uint8ClampedArray(n), warm: new Int16Array(n), tint: new Int16Array(n) };
  const { lum, warm, tint } = planes;
  if (data.length === n) {
    for (let i = 0; i < n; i += 1) lum[i] = data[i];
    return planes;
  }
  for (let y = 0, i = 0, o = 0; y < height; y += 1) {
    if ((y & 31) === 0) clock.check();
    for (let x = 0; x < width; x += 1, i += 1, o += 4) {
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      warm[i] = r - b;
      tint[i] = Math.round(g - 0.5 * (r + b));
    }
  }
  return planes;
}

/** The three channels at a continuous point (pixel centres at i + 0.5), bilinear; false off the image. */
function sampleInto(planes: Planes, x: number, y: number, out: Float32Array, offset: number): boolean {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const { width, height } = planes;
  if (!(fx >= 0 && fy >= 0 && fx <= width - 1 && fy <= height - 1)) return false;
  const x0 = Math.min(width - 2, Math.floor(fx));
  const y0 = Math.min(height - 2, Math.floor(fy));
  const ax = fx - x0;
  const ay = fy - y0;
  const i = y0 * width + x0;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  const { lum, warm, tint } = planes;
  out[offset] = lum[i] * w00 + lum[i + 1] * w10 + lum[i + width] * w01 + lum[i + width + 1] * w11;
  out[offset + 1] = warm[i] * w00 + warm[i + 1] * w10 + warm[i + width] * w01 + warm[i + width + 1] * w11;
  out[offset + 2] = tint[i] * w00 + tint[i + 1] * w10 + tint[i + width] * w01 + tint[i + width + 1] * w11;
  return true;
}

// ── small geometry ───────────────────────────────────────────────────────────

type Vec = [number, number];

/** A point on the line and its unit direction. */
interface Line {
  px: number;
  py: number;
  dx: number;
  dy: number;
}

function intersect(a: Line, b: Line): Vec | null {
  const det = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / det;
  return [a.px + a.dx * t, a.py + a.dy * t];
}

function polygonArea(points: Vec[]): number {
  let doubled = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    doubled += a[0] * b[1] - b[0] * a[1];
  }
  return doubled / 2;
}

/** Convex, consistently wound, every interior angle within [min, 180 − min] degrees. */
function saneQuad(points: Vec[], minAngleDeg: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const o = points[i];
    const a = points[(i + 1) % 4];
    const b = points[(i + 2) % 4];
    const c = (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    if (!Number.isFinite(c) || c === 0) return false;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  const maxCos = Math.cos((minAngleDeg * Math.PI) / 180);
  for (let i = 0; i < 4; i += 1) {
    const p = points[i];
    const a = points[(i + 3) % 4];
    const b = points[(i + 1) % 4];
    const ax = a[0] - p[0];
    const ay = a[1] - p[1];
    const bx = b[0] - p[0];
    const by = b[1] - p[1];
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
    if (!(Math.abs(cos) <= maxCos)) return false;
  }
  return true;
}

/** Area shared by two convex polygons of the same winding (Sutherland–Hodgman). */
function overlapArea(subject: Vec[], clip: Vec[]): number {
  const sign = Math.sign(polygonArea(clip));
  let out = subject;
  for (let i = 0; i < clip.length && out.length > 0; i += 1) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const side = (p: Vec) => sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j += 1) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out.length < 3 ? 0 : Math.abs(polygonArea(out));
}

// ── one side: profiles and edge candidates ───────────────────────────────────

/** A side's own frame: its midpoint, its direction, its outward normal. */
interface SideFrame {
  ox: number;
  oy: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  length: number;
}

/**
 * A place along one profile where one material ends: `u` along the side from
 * its middle, `s` along the outward normal (sub-pixel), and the step inside
 * minus outside in each channel.
 */
interface Candidate {
  profile: number;
  u: number;
  s: number;
  strength: number;
  dl: number;
  dw: number;
  dt: number;
}

interface SideScan {
  /** s of each profile's first sample; samples per profile; profiles. */
  lo: number;
  n: number;
  count: number;
  us: Float32Array;
  /** count × n samples × 3 channels, and whether each sample is on the image. */
  prof: Float32Array;
  valid: Uint8Array;
  candidates: Candidate[];
}

/**
 * The candidates one profile keeps out of every step it has: the strongest
 * `perProfile`; the strongest in each of `perProfile` equal stretches of
 * [kMin, kMax]; the outermost {@link OUTER_CANDIDATES}.
 */
function keepCandidates(found: Candidate[], perProfile: number, sMin: number, sMax: number): Candidate[] {
  if (found.length <= perProfile + OUTER_CANDIDATES) return found;
  const keep = new Set<Candidate>();
  const byStrength = [...found].sort((p, q) => q.strength - p.strength);
  for (let i = 0; i < perProfile; i += 1) keep.add(byStrength[i]);
  const width = (sMax - sMin + 1) / perProfile;
  const bins = new Array<Candidate | undefined>(perProfile);
  for (const c of found) {
    const bin = Math.min(perProfile - 1, Math.max(0, Math.floor((c.s - sMin) / width)));
    const held = bins[bin];
    if (held === undefined || c.strength > held.strength) bins[bin] = c;
  }
  for (const c of bins) if (c !== undefined) keep.add(c);
  // `found` is in order of s: the outermost are its last.
  for (let i = Math.max(0, found.length - OUTER_CANDIDATES); i < found.length; i += 1) keep.add(found[i]);
  return found.filter((c) => keep.has(c));
}

/**
 * Samples `count` profiles across one side from `depth` px inside to
 * `outward` px outside the prior line (and a strip's width further, so a line
 * at the end of the search has its outside strip too), and finds edge
 * candidates between `inward` px inside and `outward` px outside.
 */
function scanSide(
  planes: Planes,
  frame: SideFrame,
  inward: number,
  outward: number,
  depth: number,
  perProfile: number,
  clock: Clock,
): SideScan {
  const w = STEP_HALF;
  const count = Math.max(12, Math.min(PROFILES, Math.round(frame.length / 6)));
  const lo = -Math.round(Math.max(inward, depth)) - w - 1;
  const hi = Math.round(outward) + Math.max(w + 1, STRIP_FAR + 2);
  const n = hi - lo + 1;
  const prof = new Float32Array(count * n * 3);
  const valid = new Uint8Array(count * n);
  const us = new Float32Array(count);
  const candidates: Candidate[] = [];
  const strength = new Float32Array(n);
  const dls = new Float32Array(n);
  const dws = new Float32Array(n);
  const dts = new Float32Array(n);
  const kMin = Math.max(w + 1, -Math.round(inward) - lo);
  const kMax = Math.min(n - w - 2, Math.round(outward) - lo);
  for (let i = 0; i < count; i += 1) {
    clock.check();
    const t = CORNER_SKIP + ((1 - 2 * CORNER_SKIP) * (i + 0.5)) / count;
    const u = (t - 0.5) * frame.length;
    us[i] = u;
    const bx = frame.ox + frame.tx * u;
    const by = frame.oy + frame.ty * u;
    const base = i * n;
    for (let k = 0; k < n; k += 1) {
      const s = lo + k;
      valid[base + k] = sampleInto(planes, bx + frame.nx * s, by + frame.ny * s, prof, (base + k) * 3) ? 1 : 0;
    }
    strength.fill(0);
    for (let k = kMin - 1; k <= kMax + 1; k += 1) {
      let ok = 1;
      let il = 0;
      let iw = 0;
      let it = 0;
      let ol = 0;
      let ow = 0;
      let ot = 0;
      for (let j = 1; j <= w; j += 1) {
        const a = (base + k - j) * 3;
        const b = (base + k + j) * 3;
        ok &= valid[base + k - j] & valid[base + k + j];
        il += prof[a];
        iw += prof[a + 1];
        it += prof[a + 2];
        ol += prof[b];
        ow += prof[b + 1];
        ot += prof[b + 2];
      }
      if (!ok) continue;
      const dl = (il - ol) / w;
      const dw = (iw - ow) / w;
      const dt = (it - ot) / w;
      dls[k] = dl;
      dws[k] = dw;
      dts[k] = dt;
      strength[k] = Math.sqrt(dl * dl + dw * dw + dt * dt);
    }
    const found: Candidate[] = [];
    for (let k = kMin; k <= kMax; k += 1) {
      const v = strength[k];
      if (v < MIN_STEP || v < strength[k - 1] || v <= strength[k + 1]) continue;
      // Sub-pixel: the vertex of the parabola through the peak and its neighbours.
      const a = strength[k - 1];
      const c = strength[k + 1];
      const denom = a - 2 * v + c;
      const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
      found.push({ profile: i, u, s: lo + k + delta, strength: v, dl: dls[k], dw: dws[k], dt: dts[k] });
    }
    for (const c of keepCandidates(found, perProfile, lo + kMin, lo + kMax)) candidates.push(c);
  }
  return { lo, n, count, us, prof, valid, candidates };
}

/** Index of s on profile `i`'s samples, or −1 when it is past the scan or off the image. */
function sampleAt(scan: SideScan, i: number, s: number): number {
  const k = Math.round(s) - scan.lo;
  return k >= 0 && k < scan.n && scan.valid[i * scan.n + k] ? i * scan.n + k : -1;
}

/**
 * Mean colour of profile `i` over s ∈ [from, to] px; false when any of it is
 * off the image or past either end of the scan — a strip is judged whole or
 * not at all.
 */
function stripMean(scan: SideScan, i: number, from: number, to: number, out: Float32Array): boolean {
  const k0 = Math.round(from) - scan.lo;
  const k1 = Math.round(to) - scan.lo;
  if (k1 < k0 || k0 < 0 || k1 > scan.n - 1) return false;
  let l = 0;
  let w = 0;
  let t = 0;
  const base = i * scan.n;
  for (let k = k0; k <= k1; k += 1) {
    if (!scan.valid[base + k]) return false;
    const o = (base + k) * 3;
    l += scan.prof[o];
    w += scan.prof[o + 1];
    t += scan.prof[o + 2];
  }
  const m = k1 - k0 + 1;
  out[0] = l / m;
  out[1] = w / m;
  out[2] = t / m;
  return true;
}

// ── one side: line hypotheses ────────────────────────────────────────────────

/** A line in side coordinates, s = a + b·u, and how well the profiles back it. */
interface Hypothesis {
  a: number;
  b: number;
  support: number;
  residual: number;
  /** Median step strength of its points. */
  strength: number;
  /** Mean luma step of its points (+ = brighter inside). */
  dl: number;
  /** Its points: (u, s) of each, interleaved. */
  points: Float32Array;
  /** The profile each point is on. */
  profiles: Int16Array;
}

/** Tukey-weighted line fit s = a + b·u, started from (a0, b0). */
function fitLine(points: Candidate[], a0: number, b0: number, scale: number): { a: number; b: number; residual: number } {
  let a = a0;
  let b = b0;
  for (let iter = 0; iter < 6; iter += 1) {
    let sw = 0;
    let su = 0;
    let ss = 0;
    let suu = 0;
    let sus = 0;
    for (const p of points) {
      const r = (p.s - (a + b * p.u)) / scale;
      const weight = Math.abs(r) >= 1 ? 0 : (1 - r * r) ** 2;
      sw += weight;
      su += weight * p.u;
      ss += weight * p.s;
      suu += weight * p.u * p.u;
      sus += weight * p.u * p.s;
    }
    if (sw < 2) break;
    const det = sw * suu - su * su;
    if (Math.abs(det) < 1e-9) break;
    b = (sw * sus - su * ss) / det;
    a = (ss - b * su) / sw;
  }
  let sum = 0;
  let used = 0;
  for (const p of points) {
    const r = p.s - (a + b * p.u);
    if (Math.abs(r) < scale) {
      sum += r * r;
      used += 1;
    }
  }
  return { a, b, residual: used > 0 ? Math.sqrt(sum / used) : Infinity };
}

/**
 * The line near (a0, b0), refitted: the nearest candidate of each profile,
 * those whose step agrees in direction with the rest (one material pair along
 * the whole side — a text line's edges alternate), Tukey IRLS.
 */
function evaluate(candidates: Candidate[], profiles: number, a0: number, b0: number): Hypothesis | null {
  const nearest = new Array<Candidate | null>(profiles).fill(null);
  for (const c of candidates) {
    const r = Math.abs(c.s - (a0 + b0 * c.u));
    if (r > INLIER_PX) continue;
    const current = nearest[c.profile];
    if (current === null || r < Math.abs(current.s - (a0 + b0 * current.u))) nearest[c.profile] = c;
  }
  const near = nearest.filter((c): c is Candidate => c !== null);
  if (near.length < 3) return null;
  let rl = 0;
  let rw = 0;
  let rt = 0;
  for (const c of near) {
    rl += c.dl / c.strength;
    rw += c.dw / c.strength;
    rt += c.dt / c.strength;
  }
  const rn = Math.hypot(rl, rw, rt) || 1;
  const consistent = near.filter((c) => (c.dl * rl + c.dw * rw + c.dt * rt) / (rn * c.strength) >= 0.5);
  if (consistent.length < 3) return null;
  const fit = fitLine(consistent, a0, b0, INLIER_PX);
  const strengths: number[] = [];
  const points = new Float32Array(consistent.length * 2);
  const onProfiles = new Int16Array(consistent.length);
  let dl = 0;
  for (const c of consistent) {
    if (Math.abs(c.s - (fit.a + fit.b * c.u)) > INLIER_PX) continue;
    points[strengths.length * 2] = c.u;
    points[strengths.length * 2 + 1] = c.s;
    onProfiles[strengths.length] = c.profile;
    strengths.push(c.strength);
    dl += c.dl;
  }
  strengths.sort((p, q) => p - q);
  return {
    a: fit.a,
    b: fit.b,
    support: strengths.length / profiles,
    residual: fit.residual,
    strength: strengths.length > 0 ? strengths[strengths.length >> 1] : 0,
    dl: strengths.length > 0 ? dl / strengths.length : 0,
    points: points.subarray(0, strengths.length * 2),
    profiles: onProfiles.subarray(0, strengths.length),
  };
}

/** Two lines within `px` of each other at both ends of a side of this length. */
function sameLine(p: { a: number; b: number }, q: { a: number; b: number }, length: number, px: number): boolean {
  const half = length / 2;
  return Math.abs(q.a - p.a - (q.b - p.b) * half) < px && Math.abs(q.a - p.a + (q.b - p.b) * half) < px;
}

/**
 * Candidate lines for one side: a Hough vote over (slope, offset) restricted
 * to lines within `maxAngleDeg` of the prior side and inside the search band,
 * its strongest peaks refitted ({@link evaluate}) and de-duplicated.
 */
function hypotheses(
  candidates: Candidate[],
  profiles: number,
  inward: number,
  outward: number,
  length: number,
  maxAngleDeg: number,
  keep: number,
  clock: Clock,
): Hypothesis[] {
  if (candidates.length < 2) return [];
  const maxSlope = Math.tan((maxAngleDeg * Math.PI) / 180);
  // One slope step moves the line's ends by a pixel.
  const slopeStep = Math.max(1 / (length / 2), 0.002);
  const slopes = Math.floor(maxSlope / slopeStep);
  const reach = maxSlope * (length / 2);
  const dLo = Math.floor(-inward - reach) - 2;
  const bins = Math.ceil(outward + reach) + 2 - dLo + 1;
  const acc = new Float32Array(bins);
  const votes = candidates.map((c) => 0.5 + 0.5 * Math.min(1, c.strength / (4 * MIN_STEP)));
  const peaks: { votes: number; a: number; b: number }[] = [];
  const row: { votes: number; a: number; b: number }[] = [];
  for (let si = -slopes; si <= slopes; si += 1) {
    if ((si & 7) === 0) clock.check();
    const b = si * slopeStep;
    acc.fill(0);
    for (let j = 0; j < candidates.length; j += 1) {
      const c = candidates[j];
      const d = c.s - b * c.u - dLo;
      const d0 = Math.floor(d);
      const f = d - d0;
      // Every candidate counts; a strong step up to twice as much.
      const vote = votes[j];
      if (d0 >= 0 && d0 < bins) acc[d0] += vote * (1 - f);
      if (d0 + 1 >= 0 && d0 + 1 < bins) acc[d0 + 1] += vote * f;
    }
    row.length = 0;
    for (let k = 1; k < bins - 1; k += 1) {
      const v = acc[k - 1] + acc[k] + acc[k + 1];
      if (v < 3) continue;
      const left = k >= 2 ? acc[k - 2] + acc[k - 1] + acc[k] : 0;
      const right = k < bins - 2 ? acc[k] + acc[k + 1] + acc[k + 2] : 0;
      if (v < left || v <= right) continue;
      row.push({ votes: v, a: k + dLo, b });
    }
    if (row.length > PEAKS_PER_SLOPE) {
      row.sort((p, q) => q.votes - p.votes);
      row.length = PEAKS_PER_SLOPE;
    }
    for (const p of row) peaks.push(p);
  }
  clock.check();
  // The strongest few hundred are all the refits will reach: a threshold from
  // a numeric sort of the votes (fast), then the object sort on those alone.
  if (peaks.length > PEAK_POOL) {
    const votes = Float32Array.from(peaks, (p) => p.votes).sort();
    const floor = votes[votes.length - PEAK_POOL];
    let kept = 0;
    for (const p of peaks) if (p.votes >= floor) peaks[kept++] = p;
    peaks.length = kept;
    clock.check();
  }
  peaks.sort((p, q) => q.votes - p.votes);
  const chosen: { votes: number; a: number; b: number }[] = [];
  for (let j = 0; j < peaks.length && chosen.length < keep * 6; j += 1) {
    if ((j & 255) === 255) clock.check();
    const p = peaks[j];
    if (!chosen.some((q) => sameLine(p, q, length, 4))) chosen.push(p);
  }
  // The refit may turn a line a little past the vote's limit — by
  // {@link TURN_SLACK_PX} at the side's last profile, what a pixel of edge
  // noise does — and no further, however short the side.
  const turnLimit = maxSlope + TURN_SLACK_PX / (length * (0.5 - CORNER_SKIP));
  const refit: Hypothesis[] = [];
  for (const peak of chosen) {
    clock.check();
    const h = evaluate(candidates, profiles, peak.a, peak.b);
    if (h !== null && Math.abs(h.b) <= turnLimit) refit.push(h);
  }
  refit.sort((p, q) => q.support - p.support || q.strength - p.strength);
  // Different peaks often refit onto one line: keep each line once.
  const unique: Hypothesis[] = [];
  for (const h of refit) {
    if (!unique.some((q) => sameLine(h, q, length, 2))) unique.push(h);
    if (unique.length >= keep) break;
  }
  return unique;
}

// ── paper ────────────────────────────────────────────────────────────────────

interface Paper {
  l: number;
  w: number;
  t: number;
}

/**
 * The paper's colour among `count` samples (three floats each).
 *
 * `bright` — the luma at {@link PAPER_PERCENTILE}: a white page is the bright
 * end of what lies on it, ink and shadow the dark (and a blind's bands of
 * shade across it are still the same paper, darker).
 *
 * `dominant` — the most common luma: the densest window of ±max(6, 4 %)
 * levels, and the median of what falls in it. On a navy card printed in white
 * it is the navy.
 *
 * Either way the warmth and tint are the medians of the samples that bright.
 * `share` is the fraction of the samples within the window of that luma.
 */
function paperFromSamples(buf: Float32Array, count: number, dominant: boolean): (Paper & { share: number }) | null {
  if (count < 16) return null;
  const histogram = new Uint32Array(512);
  for (let i = 0; i < count; i += 1) histogram[Math.max(0, Math.min(511, Math.floor(buf[i * 3] * 2)))] += 1;
  const window = (l: number) => Math.max(6, 0.04 * l);
  let l0 = 0;
  if (dominant) {
    const cumulative = new Uint32Array(513);
    for (let b = 0; b < 512; b += 1) cumulative[b + 1] = cumulative[b] + histogram[b];
    let most = -1;
    for (let b = 0; b < 512; b += 1) {
      const l = (b + 0.5) / 2;
      const lo = Math.max(0, Math.floor((l - window(l)) * 2));
      const hi = Math.min(511, Math.floor((l + window(l)) * 2));
      const inside = cumulative[hi + 1] - cumulative[lo];
      if (inside > most) {
        most = inside;
        l0 = l;
      }
    }
  } else {
    const rank = Math.round(PAPER_PERCENTILE * (count - 1));
    let seen = 0;
    let bin = 0;
    for (; bin < 511; bin += 1) {
      seen += histogram[bin];
      if (seen > rank) break;
    }
    l0 = (bin + 0.5) / 2;
  }
  const columns = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const near = (l: number) => {
    let m = 0;
    for (let i = 0; i < count; i += 1) {
      if (Math.abs(buf[i * 3] - l) > window(l)) continue;
      for (let j = 0; j < 3; j += 1) columns[j][m] = buf[i * 3 + j];
      m += 1;
    }
    return m;
  };
  let m = near(l0);
  if (m === 0) return { l: l0, w: 0, t: 0, share: 0 };
  // The dominant window's own median: the centre of the material, not of the window.
  const l = dominant ? columns[0].subarray(0, m).sort()[m >> 1] : l0;
  if (dominant) m = near(l);
  return { l, w: columns[1].subarray(0, m).sort()[m >> 1], t: columns[2].subarray(0, m).sort()[m >> 1], share: m / count };
}

/**
 * Two readings of paper are two stocks, not one paper in two lights: one is
 * less than {@link SHADE_FLOOR} of the other's luma — no shade on a desk is
 * that deep — or their colour (chroma over luma) differs by more than
 * {@link SHADE_CHROMA}: a shadow darkens paper without turning it navy or
 * brown.
 */
function otherStock(a: Paper, b: Paper): boolean {
  const [dark, light] = a.l < b.l ? [a, b] : [b, a];
  if (dark.l < SHADE_FLOOR * light.l) return true;
  const la = Math.max(a.l, 16);
  const lb = Math.max(b.l, 16);
  return Math.hypot(a.w / la - b.w / lb, a.t / la - b.t / lb) > SHADE_CHROMA;
}

/**
 * The page's paper over the whole prior quad (a 24 × 24 grid inside it), and
 * which reading the sides use. A page's stock shows along its border, a white
 * panel or a photo printed on it sits in the middle: when the dominant
 * material of the grid's outer {@link PAPER_RING} rows and columns covers
 * most of them and is another stock than the bright end — a navy card printed
 * in white, a kraft envelope with a white label — that material is the paper
 * (`dominant`). Otherwise the paper is the bright end, as on any white page.
 */
function quadPaper(planes: Planes, corners: Vec[]): { paper: Paper; dominant: boolean } | null {
  const steps = 24;
  const all = new Float32Array(steps * steps * 3);
  const ring = new Float32Array(steps * steps * 3);
  let count = 0;
  let ringCount = 0;
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < steps; j += 1) {
      const u = 0.08 + (0.84 * (i + 0.5)) / steps;
      const v = 0.08 + (0.84 * (j + 0.5)) / steps;
      const x =
        corners[0][0] * (1 - u) * (1 - v) + corners[1][0] * u * (1 - v) + corners[2][0] * u * v + corners[3][0] * (1 - u) * v;
      const y =
        corners[0][1] * (1 - u) * (1 - v) + corners[1][1] * u * (1 - v) + corners[2][1] * u * v + corners[3][1] * (1 - u) * v;
      if (!sampleInto(planes, x, y, all, count * 3)) continue;
      if (Math.min(i, j, steps - 1 - i, steps - 1 - j) < PAPER_RING) {
        ring.set(all.subarray(count * 3, count * 3 + 3), ringCount * 3);
        ringCount += 1;
      }
      count += 1;
    }
  }
  const found = paperFromSamples(all, count, false);
  if (found === null) return null;
  // A white page whose print fills it — an imaging report's near-black
  // panels, their grey content as the "bright end" — still has its white
  // margin: a border band clearly brighter than that, and mostly one
  // material, is the paper. A navy card is navy to its edge.
  const margin = borderPaper(planes, corners);
  const marginPaper =
    margin !== null && margin.share >= MARGIN_SHARE && margin.l > found.l + Math.max(PAPER_LUMA_TOLERANCE, PAPER_LUMA_SHARE * found.l)
      ? margin
      : null;
  const bright = marginPaper ?? found;
  const stock = paperFromSamples(ring, ringCount, true);
  if (stock !== null && stock.share >= STOCK_SHARE && otherStock(stock, bright)) {
    if (marginPaper !== null || (margin !== null && margin.share >= MARGIN_SHARE && !otherStock(margin, bright))) {
      return { paper: bright, dominant: false };
    }
    return { paper: stock, dominant: true };
  }
  return { paper: bright, dominant: false };
}

/**
 * The dominant material of a thin band just inside the prior's sides
 * ({@link MARGIN_BAND}, as fractions of the quad): the page's own margin.
 */
function borderPaper(planes: Planes, corners: Vec[]): (Paper & { share: number }) | null {
  const steps = 48;
  const buf = new Float32Array(steps * 4 * MARGIN_BAND.length * 3);
  let count = 0;
  const at = (u: number, v: number) => {
    const x = corners[0][0] * (1 - u) * (1 - v) + corners[1][0] * u * (1 - v) + corners[2][0] * u * v + corners[3][0] * (1 - u) * v;
    const y = corners[0][1] * (1 - u) * (1 - v) + corners[1][1] * u * (1 - v) + corners[2][1] * u * v + corners[3][1] * (1 - u) * v;
    if (sampleInto(planes, x, y, buf, count * 3)) count += 1;
  };
  for (const d of MARGIN_BAND) {
    for (let i = 0; i < steps; i += 1) {
      const t = 0.1 + (0.8 * (i + 0.5)) / steps;
      at(t, d);
      at(t, 1 - d);
      at(d, t);
      at(1 - d, t);
    }
  }
  return paperFromSamples(buf, count, true);
}

/**
 * The paper next to one side, per profile: the light on a page changes along
 * a side — a hand's shadow, a lamp's glare. A profile whose own reading is
 * implausibly far from the side's (a logo, a photo, ink all the way in) uses
 * the side's; a side implausibly far from the whole quad's uses the quad's.
 */
function sidePaper(scan: SideScan, depth: number, skip: number, quad: Paper, dominant: boolean): Paper[] {
  const k0 = Math.max(0, -Math.round(depth) - scan.lo);
  const k1 = Math.min(scan.n - 1, -Math.round(skip) - scan.lo);
  const span = Math.max(0, k1 - k0 + 1);
  const all = new Float32Array(scan.count * span * 3);
  const own = new Float32Array(span * 3);
  let allCount = 0;
  const owns: (Paper | null)[] = [];
  for (let i = 0; i < scan.count; i += 1) {
    const base = i * scan.n;
    let ownCount = 0;
    for (let k = k0; k <= k1; k += 1) {
      if (!scan.valid[base + k]) continue;
      const o = (base + k) * 3;
      own.set(scan.prof.subarray(o, o + 3), ownCount * 3);
      ownCount += 1;
      if ((k & 1) === 0) {
        all.set(scan.prof.subarray(o, o + 3), allCount * 3);
        allCount += 1;
      }
    }
    owns.push(paperFromSamples(own, ownCount, dominant));
  }
  const measured = paperFromSamples(all, allCount, dominant);
  const side = measured === null || Math.abs(measured.l - quad.l) > 0.2 * Math.max(quad.l, 255 - quad.l) ? quad : measured;
  return owns.map((p) => (p === null || p.l < 0.55 * side.l || p.l > 1.25 * side.l ? side : p));
}

function paperLike(c: Float32Array, paper: Paper): boolean {
  return (
    Math.abs(c[0] - paper.l) <= Math.max(PAPER_LUMA_TOLERANCE, PAPER_LUMA_SHARE * paper.l) &&
    Math.hypot(c[1] - paper.w, c[2] - paper.t) <= Math.max(PAPER_CHROMA_TOLERANCE, PAPER_CHROMA_SHARE * paper.l)
  );
}

/** {@link paperLike} for one sample of a profile (its index into the scan's samples). */
function samplePaperLike(scan: SideScan, k: number, paper: Paper): boolean {
  const o = k * 3;
  const l = scan.prof[o];
  return (
    Math.abs(l - paper.l) <= Math.max(PAPER_LUMA_TOLERANCE, PAPER_LUMA_SHARE * paper.l) &&
    Math.hypot(scan.prof[o + 1] - paper.w, scan.prof[o + 2] - paper.t) <= Math.max(PAPER_CHROMA_TOLERANCE, PAPER_CHROMA_SHARE * paper.l)
  );
}

/** A luma far enough from the paper's, either way, to be print on it: ink on white, white on navy. */
function printLike(l: number, paper: Paper): boolean {
  return Math.abs(l - paper.l) > PRINT_CONTRAST * Math.max(paper.l, 255 - paper.l);
}

/**
 * Walking profile `i` from `s0` one px at a time in `dir` (+1 outward, −1
 * inward): `lead` px of paper (between `leadMin` and `leadMax`), then a thin
 * printed line — at most {@link THIN_PRINT_PX} px of non-paper, its blurred
 * flanks aside, some of it print — then paper again. A border, a table rule:
 * one sheet's paper either side of a line of ink. A contact shadow is not
 * dark enough to be print; a dark desk is not thin; speckle is not paper.
 * Answers the lead (how far from `s0` the printed line starts), −1 if none.
 */
function thinPrint(scan: SideScan, i: number, s0: number, dir: 1 | -1, paper: Paper, leadMin: number, leadMax: number): number {
  let s = s0;
  let lead = 0;
  for (; lead <= leadMax; lead += 1, s += dir) {
    const k = sampleAt(scan, i, s);
    if (k < 0) return -1;
    if (!samplePaperLike(scan, k, paper)) break;
  }
  if (lead < leadMin || lead > leadMax) return -1;
  let run = 0;
  let print = false;
  for (; ; run += 1, s += dir) {
    const k = sampleAt(scan, i, s);
    if (k < 0) return -1;
    if (samplePaperLike(scan, k, paper)) break;
    if (run >= THIN_PRINT_PX + 2) return -1;
    if (printLike(scan.prof[k * 3], paper)) print = true;
  }
  if (!print) return -1;
  for (let j = 0; j < 3; j += 1, s += dir) {
    const k = sampleAt(scan, i, s);
    if (k < 0 || !samplePaperLike(scan, k, paper)) return -1;
  }
  return lead;
}

interface Judged extends Hypothesis {
  /** Share of the profiles with paper just inside the line. */
  innerPaper: number;
  /** The line is a flank of a thin printed line with the page's paper either side of it: print, not an edge. */
  print: boolean;
}

function judge(scan: SideScan, h: Hypothesis, paper: Paper[], clock: Clock): Judged {
  clock.check();
  const c = new Float32Array(3);
  let inner = 0;
  let seen = 0;
  let print = 0;
  let printSeen = 0;
  const leads: number[] = [];
  for (let i = 0; i < scan.count; i += 1) {
    const s = h.a + h.b * scan.us[i];
    if (stripMean(scan, i, s - STRIP_FAR, s - STRIP_NEAR, c)) {
      seen += 1;
      if (paperLike(c, paper[i])) inner += 1;
      else {
        // Paper with a thin printed line in it: a form's border a few px
        // inside the page's edge — counted below, if it runs along the line.
        const lead = thinPrint(scan, i, s - 2, -1, paper[i], 1, STRIP_FAR);
        if (lead >= 0) leads.push(lead);
      }
    }
    if (sampleAt(scan, i, s - 2 * STRIP_FAR) >= 0 && sampleAt(scan, i, s + 2 * STRIP_FAR) >= 0) {
      printSeen += 1;
      // Either flank of a printed line: paper, the line, paper.
      if (thinPrint(scan, i, s - STRIP_NEAR, 1, paper[i], 2, 6) >= 0 || thinPrint(scan, i, s + STRIP_NEAR, -1, paper[i], 2, 6) >= 0) {
        print += 1;
      }
    }
  }
  // A border runs parallel to the page's edge, at one distance from it, and
  // is what fills the strip wherever it is not plain paper: a line that only
  // crosses print here and there (text rows it is turned against, a
  // signature) does not have paper inside it.
  if (leads.length > 0) {
    leads.sort((p, q) => p - q);
    const median = leads[leads.length >> 1];
    const along = leads.filter((lead) => Math.abs(lead - median) <= 2).length;
    if (along >= 0.5 * (seen - inner)) inner += along;
  }
  return { ...h, innerPaper: seen > 0 ? inner / seen : 0, print: printSeen > 0 && print >= 0.5 * printSeen };
}

function eligible(h: Judged): boolean {
  return h.support >= MIN_SUPPORT && h.residual <= MAX_RESIDUAL_PX && h.innerPaper >= MIN_INNER_PAPER && !h.print;
}

/**
 * Share of the profiles with a stretch of paper somewhere beyond the line
 * (from `from` px past it, up to `to` px or the end of the scan): the page
 * goes on past it.
 */
function paperBeyond(scan: SideScan, h: { a: number; b: number }, paper: Paper[], from: number, to: number): number {
  const c = new Float32Array(3);
  let seen = 0;
  let hits = 0;
  const end = scan.lo + scan.n - 1;
  for (let i = 0; i < scan.count; i += 1) {
    const s0 = h.a + h.b * scan.us[i];
    const last = Math.min(end - 6, s0 + to);
    let looked = false;
    for (let s = s0 + from; s <= last; s += 3) {
      if (!stripMean(scan, i, s, s + 6, c)) continue;
      looked = true;
      if (paperLike(c, paper[i])) {
        hits += 1;
        break;
      }
    }
    if (looked) seen += 1;
  }
  return seen > 0 ? hits / seen : 0;
}

/**
 * A confident edge with paper-coloured surface right outside it — a white
 * table, the sheet underneath. From the pixels the two cannot be told apart
 * (two sheets of one stock differ by nothing but the thin shadow between
 * them), so the search stops there: moving past it would trade a sliver of
 * margin for the risk of taking the sheet below, or the table. (The rest of
 * the page past a printed rule is paper-coloured too — but a printed line is
 * print, never a candidate edge: {@link judge}.)
 */
function paperMeetsPaper(scan: SideScan, h: Judged, paper: Paper[]): boolean {
  return h.support >= CONFIDENT_SUPPORT && paperOutside(scan, h, paper) >= 0.5;
}

/** Distance between two colours (luma, warmth, tint). */
function colourDistance(a: Float32Array, b: Float32Array): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * The desk as seen past one side of the page: its colour, and whether it is
 * even (a black laminate, a leather mat) or textured (granite, wood).
 */
interface Desk {
  colour: Float32Array;
  even: boolean;
}

/**
 * The strip `c` (s ∈ [from, to] of profile `i`) is that desk: its colour, and
 * its texture — a textured desk is never one even strip, a printed band is.
 */
function deskLike(scan: SideScan, i: number, from: number, to: number, c: Float32Array, desk: Desk[]): boolean {
  return desk.some((d) => colourDistance(c, d.colour) <= BACKGROUND_MATCH && (d.even || !uniform(scan, i, from, to)));
}

/**
 * A confident paper edge with the background right outside it: not paper
 * (that would be the sheet below), and not a band of ink (a header printed
 * across the page, which the page's own margin may lie beyond) — on most
 * profiles, an even surface neither paper-coloured nor far darker than paper.
 * A dark, even surface that is what lies past the page's other sides (`desk`)
 * is the desk, however dark: a black table, a leather mat.
 */
function pageEdgeLike(scan: SideScan, h: Judged, paper: Paper[], desk: Desk[]): boolean {
  const c = new Float32Array(3);
  let seen = 0;
  let background = 0;
  for (let i = 0; i < scan.count; i += 1) {
    const s = h.a + h.b * scan.us[i];
    if (!stripMean(scan, i, s + STRIP_NEAR, s + STRIP_FAR, c)) continue;
    seen += 1;
    if (paperLike(c, paper[i])) continue;
    if (
      c[0] < INK_LUMA_SHARE * paper[i].l &&
      uniform(scan, i, s + STRIP_NEAR, s + STRIP_FAR) &&
      !deskLike(scan, i, s + STRIP_NEAR, s + STRIP_FAR, c, desk)
    ) {
      continue;
    }
    background += 1;
  }
  return seen > 0 && background >= 0.5 * seen;
}

/** Share of the profiles with paper-coloured surface just outside the line. */
function paperOutside(scan: SideScan, h: { a: number; b: number }, paper: Paper[]): number {
  const c = new Float32Array(3);
  let seen = 0;
  let outside = 0;
  for (let i = 0; i < scan.count; i += 1) {
    const s = h.a + h.b * scan.us[i];
    if (!stripMean(scan, i, s + STRIP_NEAR, s + STRIP_FAR, c)) continue;
    seen += 1;
    if (paperLike(c, paper[i])) outside += 1;
  }
  return seen > 0 ? outside / seen : 0;
}

/**
 * What lies just outside a found edge where it is not paper — the desk past
 * that side of the page: the median colour of those strips, and whether most
 * of them are even, when a third of the side's profiles or more see it; null
 * otherwise.
 */
function outsideDesk(scan: SideScan, h: { a: number; b: number }, paper: Paper[]): Desk | null {
  const c = new Float32Array(3);
  const columns = [new Float32Array(scan.count), new Float32Array(scan.count), new Float32Array(scan.count)];
  let m = 0;
  let even = 0;
  for (let i = 0; i < scan.count; i += 1) {
    const s = h.a + h.b * scan.us[i];
    if (!stripMean(scan, i, s + STRIP_NEAR, s + STRIP_FAR, c) || paperLike(c, paper[i])) continue;
    for (let j = 0; j < 3; j += 1) columns[j][m] = c[j];
    m += 1;
    if (uniform(scan, i, s + STRIP_NEAR, s + STRIP_FAR)) even += 1;
  }
  if (m < Math.max(3, scan.count / 3)) return null;
  return { colour: Float32Array.from(columns.map((col) => col.subarray(0, m).sort()[m >> 1])), even: even >= 0.5 * m };
}

/**
 * A wide move from `base` to `far` crosses a page's edge onto a dark desk: on
 * at least {@link CROSSES_DESK} of the profiles, walking out from `base`,
 * paper, and past it 12 px (three 6 px strips) as dark as ink that match what
 * lies past the page's other sides — the page's margin, its edge, then the
 * black mat between it and the white sheet beyond. Dark from the start is
 * what lies right outside `base` — a header band the prior sat on, or (when
 * `base` is a found edge) the desk, which {@link pageEdgeLike} has judged. Only
 * a desk dark enough to pass for a printed band needs this: a lighter one
 * past a found edge stops the search already, and a shade across the page (a
 * blind's bands) can match a light table's colour.
 */
function crossesDesk(scan: SideScan, paper: Paper[], base: { a: number; b: number }, far: { a: number; b: number }, desk: Desk[]): boolean {
  if (desk.length === 0) return false;
  const c = new Float32Array(3);
  let seen = 0;
  let crossing = 0;
  for (let i = 0; i < scan.count; i += 1) {
    const s0 = base.a + base.b * scan.us[i] + STRIP_NEAR;
    const s1 = far.a + far.b * scan.us[i] - STRIP_NEAR;
    let looked = false;
    let paperFirst = false;
    let run = 0;
    for (let s = s0; s + 6 <= s1; s += 3) {
      if (!stripMean(scan, i, s, s + 6, c)) {
        run = 0;
        continue;
      }
      looked = true;
      if (!paperFirst) {
        paperFirst = paperLike(c, paper[i]);
        continue;
      }
      const isDesk = c[0] < INK_LUMA_SHARE * paper[i].l && deskLike(scan, i, s, s + 6, c, desk);
      run = isDesk ? run + 1 : 0;
      // Two strips 3 px apart overlap: three in a row cover 12 px.
      if (run >= 3) break;
    }
    if (!looked) continue;
    seen += 1;
    if (run >= 3) crossing += 1;
  }
  return seen > 0 && crossing >= CROSSES_DESK * seen;
}

/**
 * The background repeating: on the profiles where an even, non-paper surface
 * lies just outside `inner`, the same lies just outside `outer` — the grey
 * stripe past a page on a striped cloth and the grey stripe past the next
 * white one, the grout past a page and past the next tile. `inner` was already
 * where the paper ended; `outer` is the pattern again. (A header band or a
 * page's own rule is not the desk beyond the page, and does not match it.)
 */
function repeats(
  scan: SideScan,
  paper: Paper[],
  inner: { a: number; b: number },
  outer: { a: number; b: number },
  paperBetween: boolean,
): boolean {
  const a = new Float32Array(3);
  const b = new Float32Array(3);
  let seen = 0;
  let other = 0;
  let same = 0;
  for (let i = 0; i < scan.count; i += 1) {
    const si = inner.a + inner.b * scan.us[i];
    const so = outer.a + outer.b * scan.us[i];
    if (!stripMean(scan, i, si + STRIP_NEAR, si + STRIP_FAR, a) || !stripMean(scan, i, so + STRIP_NEAR, so + STRIP_FAR, b)) {
      continue;
    }
    seen += 1;
    if (paperLike(a, paper[i]) || !uniform(scan, i, si + STRIP_NEAR, si + STRIP_FAR)) continue;
    other += 1;
    if (colourDistance(a, b) > BACKGROUND_MATCH) continue;
    if (!paperBetween) {
      same += 1;
      continue;
    }
    for (let t = si + STRIP_FAR; t + 6 <= so - STRIP_NEAR; t += 3) {
      if (stripMean(scan, i, t, t + 6, b) && paperLike(b, paper[i])) {
        same += 1;
        break;
      }
    }
  }
  return seen > 0 && other >= REPEAT_OTHER * seen && same >= REPEAT_SAME * other;
}

/**
 * One even material over s ∈ [from, to] of profile `i` (luma spread within
 * {@link UNIFORM_SPREAD}): a stripe, a tile, a table — not a text line, whose
 * ink and paper can average to any grey. False when any of it is off the
 * image or past the scan.
 */
function uniform(scan: SideScan, i: number, from: number, to: number): boolean {
  const k0 = Math.round(from) - scan.lo;
  const k1 = Math.round(to) - scan.lo;
  if (k1 < k0 || k0 < 0 || k1 > scan.n - 1) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = k0; k <= k1; k += 1) {
    if (!scan.valid[i * scan.n + k]) return false;
    const l = scan.prof[(i * scan.n + k) * 3];
    lo = Math.min(lo, l);
    hi = Math.max(hi, l);
  }
  return hi - lo <= UNIFORM_SPREAD;
}

/**
 * `lines` (outermost first) less the outer ones that only repeat the
 * background already met outside a nearer one — or outside `base`.
 */
function withoutRepeats(scan: SideScan, paper: Paper[], lines: Judged[], base: { a: number; b: number }, clock: Clock): Judged[] {
  const repeat = (h: Judged) => {
    clock.check();
    return (
      (h.a - base.a > STRIP_FAR && repeats(scan, paper, base, h, true)) ||
      lines.some(
        (q) =>
          q.support >= CONFIDENT_SUPPORT && q.a >= base.a - STRIP_NEAR && h.a - q.a > STRIP_FAR && repeats(scan, paper, q, h, false),
      )
    );
  };
  let first = 0;
  while (first < lines.length && repeat(lines[first])) first += 1;
  return lines.slice(first);
}

/**
 * Content protection for an inward move to line `h`: on most profiles the
 * strip it would cut away must look like the background just outside the
 * prior line, must differ from the paper just inside the new line (a margin
 * is paper; a table is not quite), and no stretch of *different* paper-like
 * surface may lie beyond it — the white strip above a header band the prior
 * sat in, the paper past a full-bleed band. Paper-coloured table beyond it,
 * the same as what is cut away, is not more page.
 */
function inwardAllowed(
  scan: SideScan,
  h: Hypothesis,
  paper: Paper[],
  band: number,
  lines: Hypothesis[],
  shallow: number,
): boolean {
  if (!backgroundCut(scan, h, paper, band)) return false;
  // A cut this shallow is the model's usual looseness taken back, whatever
  // lies beyond: at most a sliver of margin.
  const deepest = h.a - Math.abs(h.b) * scan.us[scan.count - 1];
  return deepest >= -shallow || !bandEnds(scan, h, lines);
}

/**
 * A straight edge outward of `h` where the strip it would cut away ends: that
 * strip is a band with an edge of its own — the shaded margin past a fold, a
 * full-bleed header, a lab's name bar, the curled-up strip of a page — and
 * the page goes at least to that edge. Open background has no such edge
 * (checked when the prior sits inside the page, where "just outside the
 * prior" is still page and cannot tell the two apart).
 */
function bandEnds(scan: SideScan, h: Hypothesis, lines: Hypothesis[]): boolean {
  const cut = new Float32Array(3);
  const beyond = new Float32Array(3);
  const last = scan.us[scan.count - 1];
  for (const g of lines) {
    if (g.support < MIN_SUPPORT || g.residual > MAX_RESIDUAL_PX) continue;
    if (Math.min(g.a - h.a - (g.b - h.b) * last, g.a - h.a + (g.b - h.b) * last) < 2 * STRIP_NEAR + 2) continue;
    let seen = 0;
    let ends = 0;
    for (let i = 0; i < scan.count; i += 1) {
      const sh = h.a + h.b * scan.us[i];
      const sg = g.a + g.b * scan.us[i];
      if (!stripMean(scan, i, sh + STRIP_NEAR, sg - STRIP_NEAR, cut) || !stripMean(scan, i, sg + STRIP_NEAR, sg + STRIP_FAR, beyond)) {
        continue;
      }
      seen += 1;
      if (colourDistance(cut, beyond) >= MATERIAL_STEP) ends += 1;
    }
    if (seen > 0 && ends >= MIN_SUPPORT * seen) return true;
  }
  return false;
}

/**
 * The strip an inward move to `h` cuts away is background, on most of the
 * profiles where the move is deep enough to measure (4 px or more), and on
 * at least half of those measured at each end of the side
 * ({@link CUT_ENDS}). Fails closed: when too few of those profiles can see
 * both the strip and the background past the prior — a prior on the frame's
 * edge has no "outside" — the cut is not established, and the side stays.
 */
function backgroundCut(scan: SideScan, h: Hypothesis, paper: Paper[], band: number): boolean {
  const inner = new Float32Array(3);
  const between = new Float32Array(3);
  const outside = new Float32Array(3);
  const strip = new Float32Array(3);
  const stock = new Float32Array(3);
  const end = scan.lo + scan.n - 1;
  let inside = 0;
  let seen = 0;
  let ok = 0;
  // The profiles of each end of the side, seen and judged background.
  const endSeen = [0, 0];
  const endOk = [0, 0];
  for (let i = 0; i < scan.count; i += 1) {
    const s = h.a + h.b * scan.us[i];
    if (s > -4) continue;
    inside += 1;
    const tip = i < CUT_ENDS * scan.count ? 0 : i >= (1 - CUT_ENDS) * scan.count ? 1 : -1;
    if (
      !stripMean(scan, i, s - STRIP_FAR, s - STRIP_NEAR, inner) ||
      !stripMean(scan, i, s + STRIP_NEAR, -1, between) ||
      !stripMean(scan, i, 2, 10, outside)
    ) {
      continue;
    }
    seen += 1;
    if (tip >= 0) endSeen[tip] += 1;
    stock[0] = paper[i].l;
    stock[1] = paper[i].w;
    stock[2] = paper[i].t;
    // Unlike the background past the prior, or like the paper — the strip
    // just inside the new line, or the page's own paper: a blank margin
    // below a footer is paper, whatever text the line runs along.
    if (
      colourDistance(between, outside) > BACKGROUND_MATCH ||
      colourDistance(between, inner) < MATERIAL_STEP ||
      colourDistance(between, stock) < MATERIAL_STEP
    ) {
      continue;
    }
    // A stretch of paper, not a speck: 12 px of it (two strips running).
    let morePage = false;
    let run = 0;
    for (let t = s + 4; t <= Math.min(end - 6, band); t += 6) {
      const hit = stripMean(scan, i, t, t + 5, strip) && paperLike(strip, paper[i]) && colourDistance(strip, between) > BACKGROUND_MATCH;
      run = hit ? run + 1 : 0;
      if (run >= 2) {
        morePage = true;
        break;
      }
    }
    if (!morePage) {
      ok += 1;
      if (tip >= 0) endOk[tip] += 1;
    }
  }
  // A move of a few pixels cuts nothing that could be measured, or clipped.
  if (inside === 0) return true;
  if (seen < Math.max(Math.min(MIN_CUT_PROFILES, inside), 0.5 * inside)) return false;
  // Background along the middle of the side and paper at an end is a bowed
  // edge — a curled receipt, a page lifting off the desk — whose chord cuts
  // the page's corners off: the side stays.
  if ([0, 1].some((t) => endSeen[t] >= 2 && endOk[t] < 0.5 * endSeen[t])) return false;
  return ok / seen >= 0.6;
}

/**
 * `lines` less the twins: a line turned a degree or so off a better-supported
 * one crosses it, borrows its points near the crossing (they are within
 * {@link INLIER_PX}), fills the rest from desk speckle — and, its middle a few
 * px further out, would win "outermost" while standing off the edge at one
 * end. A twin is a line without the support of its own: fewer than
 * {@link MIN_SUPPORT} of the profiles back it away from the better line. A
 * printed rule a few degrees off the edge, meeting it at one end only, has
 * its own points everywhere else: a line of its own.
 */
function withoutTwins(lines: Judged[], profiles: number): Judged[] {
  const own = (h: Judged, q: Judged) => {
    let away = 0;
    for (let j = 0; j < h.points.length; j += 2) {
      if (Math.abs(h.points[j + 1] - (q.a + q.b * h.points[j])) >= INLIER_PX) away += 1;
    }
    return away / profiles;
  };
  return lines.filter((h) => !lines.some((q) => q !== h && q.support > h.support && own(h, q) < MIN_SUPPORT));
}

/**
 * The outermost of `lines` (sorted outermost first) — except that a thin dark
 * line along the edge (the paper's own shading plus its contact shadow, which
 * is all a white page on a white table shows) answers twice: where the paper
 * turns dark, and where the shadow turns back into table. The page ends at the
 * first of the two. Only a line darker than both the paper inside it and the
 * surface outside it is such a shadow: a navy page's own white rule inside
 * its edge has the page's paper between the two, not a shadow. The shadow is
 * read a pixel in from each of the two lines: a faint one two or three pixels
 * wide, averaged with the blurred flanks either side of it, is as light as a
 * light table — and its outer flank, the table's side of the shadow, would
 * then pass for the page's edge, a few pixels out.
 */
function outermost(scan: SideScan, paper: Paper[], lines: Judged[]): Judged | undefined {
  const top = lines[0];
  if (top === undefined || top.dl >= 0) return top;
  const between = new Float32Array(3);
  const outside = new Float32Array(3);
  const shadowBetween = (h: Judged) => {
    let seen = 0;
    let dark = 0;
    for (let i = 0; i < scan.count; i += 1) {
      const sh = h.a + h.b * scan.us[i];
      const st = top.a + top.b * scan.us[i];
      if (!stripMean(scan, i, sh + 1, Math.max(sh + 1, st - 1), between) || !stripMean(scan, i, st + STRIP_NEAR, st + STRIP_FAR, outside)) {
        continue;
      }
      seen += 1;
      if (between[0] < paper[i].l - MATERIAL_STEP && between[0] < outside[0] - MATERIAL_STEP) dark += 1;
    }
    return seen > 0 && dark >= 0.5 * seen;
  };
  return (
    lines.find(
      (h) =>
        h !== top &&
        h.dl > 0 &&
        top.a - h.a >= 1.5 &&
        top.a - h.a <= 4 * STEP_HALF &&
        Math.abs(h.b - top.b) < 0.02 &&
        shadowBetween(h),
    ) ?? top
  );
}

// ── occluded corners ─────────────────────────────────────────────────────────
//
// A sheet over a corner, a clip on an edge: the page's edge is seen along
// part of a side only. Its line is fitted on that visible run, the corner is
// where two such lines cross, and each corner says how it was got
// ({@link CornerProvenance}) — measured by walking each of its edges' lines
// from the corner: the page's own corner shows its edge (paper inside, the
// desk outside, a step between) right up to it; a covered one shows the
// edge stopping short, under paper where the desk was (a sheet), or under
// something that is neither (a clip, a shaded sheet). A corner that is
// merely missing — rounded, torn, cut — has the desk inside its edges'
// lines instead, and is the page's own as far as anyone can say.

/** A side fitted on the visible run of its edge. */
interface RunLine {
  h: Hypothesis;
  /** Share of the side's profiles in the run. */
  share: number;
  /** The run's bow: the largest gap between its line and a parabola through it, px. */
  sagittaPx: number;
}

/** One rung of a side's fallback ladder, with the hypothesis behind an accepted line. */
interface Rung {
  line: Line;
  report: SideReport;
  edge: Hypothesis | undefined;
  sagittaPx: number;
}

/**
 * What one edge looks like where it is seen: the surface outside it (and
 * whether that is paper-coloured — a white table), the step across it, the
 * page's paper inside.
 */
interface EdgeLook {
  outer: Float32Array;
  outerPaper: boolean;
  step: number;
  paper: Paper;
}

/** Along a line: the page's edge, paper over the desk, something across the line, the desk on both sides, none of those, off the image. */
type Stretch = "edge" | "paper" | "object" | "desk" | "other" | "off";

/** Paper in shade still reads as the page's paper down to this share of its luma (a hand's soft shadow). */
const PAPER_LIGHT = 0.7;
/**
 * A board's margin is looked for up to this far inside the prior's sides
 * (fraction of the diagonal): at least this wide (px), one even material
 * other than the desk and the paper, on this share of a side's middle
 * profiles (at least {@link BOARD_MIN_PROFILES} of them).
 */
const BOARD_REACH = 0.1;
const BOARD_MIN_PX = 3;
const BOARD_BLUR = 5;
const BOARD_SHARE = 0.4;
/** …and on at least this many of them. */
const BOARD_MIN_PROFILES = 6;
/**
 * The occluder guard ({@link overSheet}): a paper-on-paper line at least this
 * far inside a found side (fraction of the diagonal), near parallel to it
 * (slope difference), along this share of the side.
 */
const OCCLUDER_GAP = 0.01;
const GUARD_SLOPE = 0.04;
const GUARD_SUPPORT = 0.3;
/** …or the page's own edge inside it, on profiles the found line mostly does not hold (at most this share of them). */
const GUARD_SHARED = 0.3;
/** How far inside the prior a visible run is looked for, fraction of the diagonal. */
const OCCLUDED_INWARD = 0.15;
/** A run line may turn this far from the prior side: the model's corner pulled along an edge onto the occluder turns it. */
const OCCLUDED_MAX_ANGLE_DEG = 40;
/** Lines the run search weighs per side (a page's text rows are lines too, and many). */
const OCCLUDED_LINES = 24;
/**
 * A visible run covers at least this share of the side's profiles… (The
 * prior's side may run far out onto the sheet over the corner, so the
 * page's edge, seen nearly whole, can be a third of it; whether the corner
 * so placed is trusted is the provenance's call, on the answer's own sides.)
 */
const OCCLUDED_MIN_RUN = 0.3;
/** …with gaps of at most this many profiles (a strip of print, a speck)… */
const RUN_GAP = 2;
/**
 * …or this share, for a side the occluder guard sent back ({@link overSheet}):
 * the page's own edge already seen inside the found line. A corner extended
 * that far is placed but not trusted (unknown): never the sheet's outline.
 */
const GUARDED_MIN_RUN = 0.3;
/** …and reaches within this many profiles of one end of the side: it runs from the seen corner. */
const RUN_END_SLACK = 2;
/** A run that covers this share of the side is the whole edge, turned past the local pass's limit. */
const RUN_WHOLE = 0.85;
/** A visible run is straight: a parabola through it bows off its line by at most this (px). */
const MAX_SAGITTA_PX = 1;
/** Share of a run's profiles that must see the background just outside it. */
const RUN_BACKGROUND = 0.6;
/** The profiles past a run's open end that must show what covers the edge there, at least this share of those measured. */
const STOP_PROFILES = 6;
const STOP_SHARE = 0.5;
/** Walking a corner's edge: first sample this far from the corner (px; the strips there are clear of the other edge), then every this many px. */
const WALK_START = STRIP_FAR + 2;
const WALK_STEP = 2;
/** The edge is back when this many samples in a row, but at most one, show it. */
const WALK_WINDOW = 6;
/** A step across the line counts as the edge when it is this share of the edge's own (or {@link MATERIAL_STEP}). */
const WALK_STEP_SHARE = 0.35;
/** A corner its edges reach within max(this px, share of the diagonal) of is seen. */
const REACH_PX = WALK_START + 4;
const REACH_DIAG = 0.01;
/** Where the corner's tip is read (px along each edge from the corner, inside the page), and its surroundings (px past it on each edge's line). */
const TIP_INSIDE: [number, number][] = [
  [5, 5],
  [9, 4],
  [4, 9],
  [9, 9],
];
const TIP_OUTSIDE = [5, 9];
/** A shadow round a corner darkens the desk to no less than this share of its luma; darker is something else. */
const TIP_SHADE_FLOOR = 0.55;
/** The desk next to a corner is read this far along its edge past where the edge is first seen (px). */
const DESK_NEAR_FROM = 24;
const DESK_NEAR_TO = 48;
/** The desk this close outside the line (max of px, share of the diagonal) means the edge is right there, bent off the line. */
const NEAR_DESK_PX = 14;
const NEAR_DESK_DIAG = 0.01;
/** A stretch short of the corner is covered when this share of its samples is paper over the desk or something across the line. */
const COVER_SHARE = 0.5;
/** …at least this many of them (12 px)… */
const COVER_MIN_SAMPLES = 6;
/** …ending where the surface outside the line changes this sharply ({@link Walk}): an outline, not a glare's fade. */
const COVER_SHARP = 0.4;
/**
 * An inferred corner is trusted only when each of its edges is seen along
 * this share of its side, and extended by at most this share of what is seen.
 */
const INFER_MIN_RUN = 0.4;
const INFER_MAX_EXTEND = 0.6;
/** {@link deskInside}: profiles per side, start and step inside it, and the wedge's depth and share (fractions of the diagonal / of the profiles). */
const WEDGE_PROFILES = 16;
const WEDGE_FROM = 0.01;
const WEDGE_STEP = 0.004;
const WEDGE_DEPTH = 0.05;
const WEDGE_SHARE = 0.25;
/**
 * The page's corner on another sheet (two sheets overlapping, the page on
 * top): along each edge short of where the desk is outside it, at least this
 * share of what was measured shows the edge over the other sheet — paper
 * outside at least {@link UNDER_LIGHT} of the page's luma (in the page's
 * contact shadow, darker), and still {@link UNDER_FAR} px further out.
 */
const UNDER_SHARE = 0.6;
const UNDER_LIGHT = 0.6;
const UNDER_FAR = 14;
/**
 * Two sheets: paper right outside a side, reaching at least this far past it
 * (fraction of the diagonal), along at least this share of its profiles.
 */
const SEPARATE_REACH = 0.04;
const SEPARATE_SHARE = 0.25;
/** …with the desk (not paper) right past at least this share of it. */
const SEPARATE_DESK = 0.15;
/** …past this many sides. */
const SEPARATE_SIDES = 2;

/** The longest stretch of profiles holding the line's points, gaps of {@link RUN_GAP} allowed: [first, last] and how many hold one. */
function longestRun(profiles: Int16Array, count: number): { i0: number; i1: number; hits: number } {
  const on = new Uint8Array(count);
  for (const i of profiles) on[i] = 1;
  let best = { i0: 0, i1: -1, hits: 0 };
  let i0 = -1;
  let last = -1;
  let hits = 0;
  for (let i = 0; i < count; i += 1) {
    if (!on[i]) continue;
    if (i0 < 0 || i - last - 1 > RUN_GAP) {
      i0 = i;
      hits = 0;
    }
    hits += 1;
    last = i;
    if (hits > best.hits) best = { i0, i1: i, hits };
  }
  return best;
}

/** How far a parabola through the points bows off the line through them, at the middle of their span (px). */
function sagitta(points: { u: number; s: number }[], line: { a: number; b: number }): number {
  if (points.length < 5) return 0;
  // Residuals off the line, fitted by r = c·(u − m)² + d: the bow is |c|·(half span)².
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    lo = Math.min(lo, p.u);
    hi = Math.max(hi, p.u);
  }
  const m = (lo + hi) / 2;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const x = (p.u - m) ** 2;
    const y = p.s - (line.a + line.b * p.u);
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const n = points.length;
  const det = n * sxx - sx * sx;
  if (Math.abs(det) < 1e-9) return 0;
  const c = (n * sxy - sx * sy) / det;
  return Math.abs(c) * ((hi - lo) / 2) ** 2;
}

/** The inner and outer strips of profile `i` at the line, or false where either is not measurable. */
function stripsAt(scan: SideScan, i: number, h: { a: number; b: number }, inner: Float32Array, outer: Float32Array): boolean {
  const s = h.a + h.b * scan.us[i];
  return stripMean(scan, i, s - STRIP_FAR, s - STRIP_NEAR, inner) && stripMean(scan, i, s + STRIP_NEAR, s + STRIP_FAR, outer);
}

/** What one edge looks like over the profiles that hold its points (null when too few can be measured). */
function edgeLook(st: SideState, h: Hypothesis): EdgeLook | null {
  const inner = new Float32Array(3);
  const outer = new Float32Array(3);
  const cols = [[], [], []] as number[][];
  const ins = [[], [], []] as number[][];
  const steps: number[] = [];
  let outerPaper = 0;
  for (const i of h.profiles) {
    if (!stripsAt(st.scan, i, h, inner, outer)) continue;
    for (let j = 0; j < 3; j += 1) {
      cols[j].push(outer[j]);
      ins[j].push(inner[j]);
    }
    steps.push(colourDistance(inner, outer));
    if (paperLike(outer, st.paper[i])) outerPaper += 1;
  }
  if (steps.length < 3) return null;
  const median = (v: number[]) => v.sort((p, q) => p - q)[v.length >> 1];
  // The page's paper as this edge shows it: what lies just inside it where it is seen.
  const [l, w, t] = ins.map(median);
  return {
    outer: Float32Array.from(cols.map(median)),
    outerPaper: outerPaper >= 0.5 * steps.length,
    step: median(steps),
    paper: { l, w, t },
  };
}

/**
 * One place along an edge's line: which {@link Stretch} its two strips say it
 * is. The edge is a step from paper to what lies outside; where something
 * lies over the edge there is no step — the same material on both sides of
 * the line, and not the desk: a sheet's paper ({@link Stretch} `paper`), or a
 * clip, a sheet in shade (`object`). `nearDesk` says the desk is close
 * outside the line here — the edge bent off it (a curl), not covered.
 */
function classify(inner: Float32Array, outer: Float32Array, look: EdgeLook, nearDesk = false): Stretch {
  const innerPaper = paperLike(inner, look.paper);
  const step = colourDistance(inner, outer);
  const minStep = Math.max(MATERIAL_STEP, WALK_STEP_SHARE * look.step);
  if (innerPaper && step >= minStep) return "edge";
  const outerFromDesk = colourDistance(outer, look.outer);
  const innerFromDesk = colourDistance(inner, look.outer);
  if (!innerPaper && innerFromDesk <= BACKGROUND_MATCH && outerFromDesk <= BACKGROUND_MATCH) return "desk";
  if (step >= minStep || nearDesk) return "other";
  // Where the edge has the desk outside it, paper over the line is a sheet lying past it.
  if (!look.outerPaper && paperLike(outer, look.paper) && outerFromDesk >= Math.max(2 * MATERIAL_STEP, 0.5 * look.step)) return "paper";
  if (
    !innerPaper &&
    outerFromDesk >= Math.max(BACKGROUND_MATCH, 0.5 * look.step) &&
    innerFromDesk >= BACKGROUND_MATCH &&
    !inShade(outer, look.outer)
  ) {
    return "object";
  }
  return "other";
}

/**
 * The guard against a quad grown onto a sheet lying over the page: inside
 * the found line `h`, at least `gap` px in (a stack's edges and a page's
 * shadow are nearer), another line of the side's hypotheses, near parallel,
 * with paper on both sides of it — paper-coloured surface right outside it
 * and the page's paper inside — and a step between: one sheet's edge over
 * another. Judged on the profiles that hold that line, at least
 * {@link GUARD_SUPPORT} of the side.
 */
function overSheet(scan: SideScan, h: Hypothesis, lines: Judged[], paper: Paper[], gap: number): boolean {
  const inner = new Float32Array(3);
  const outer = new Float32Array(3);
  const onH = new Set(h.profiles);
  for (const q of lines) {
    if (q === h || q.support < GUARD_SUPPORT || q.print || q.residual > MAX_RESIDUAL_PX) continue;
    if (Math.abs(q.b - h.b) > GUARD_SLOPE) continue;
    // The page's own edge, a little inside the found line and along the
    // stretch of the side it does not hold: the found line is something
    // else's edge (a sheet over the corner, its edge parallel past the page's).
    if (h.a - q.a >= STRIP_FAR && [...q.profiles].filter((i) => onH.has(i)).length <= GUARD_SHARED * q.profiles.length) {
      // Paper inside it and the desk outside, where it is seen.
      let seenQ = 0;
      let edgeQ = 0;
      for (const i of q.profiles) {
        if (!stripsAt(scan, i, q, inner, outer)) continue;
        seenQ += 1;
        if (paperLike(inner, paper[i]) && !paperLike(outer, paper[i])) edgeQ += 1;
      }
      if (seenQ >= 3 && edgeQ >= MIN_INNER_PAPER * seenQ) return true;
    }
    if (h.a - q.a < gap) continue;
    let seen = 0;
    let sheet = 0;
    for (const i of q.profiles) {
      if (!stripsAt(scan, i, q, inner, outer)) continue;
      seen += 1;
      if (paperLike(inner, paper[i]) && paperLike(outer, paper[i]) && colourDistance(inner, outer) >= MATERIAL_STEP) sheet += 1;
    }
    if (seen >= 3 && sheet >= 0.6 * seen) return true;
  }
  return false;
}

/**
 * The page on a board — a clipboard, a mat — taken for the page: on two
 * or more sides the page's own edge lies a few px or more inside the
 * prior, and what lies between the two is one even material, not paper,
 * reaching out to the prior — the board, the same on those sides (in
 * whatever light), with something else past the prior on one of them at
 * least. (A board's margin can be too thin to read on the other sides, and
 * its top is under the clip.) That material is the background the page's
 * edges are found against, and cutting it away clips nothing.
 */
function boardInside(states: SideState[], diag: number): Desk | null {
  const strip = new Float32Array(3);
  const first = new Float32Array(3);
  const colours: Float32Array[] = [];
  const beyond: (Float32Array | null)[] = [];
  const reach = BOARD_REACH * diag;
  for (const st of states) {
    const { scan, paper } = st;
    const cols = [[], [], []] as number[][];
    const outs = [[], [], []] as number[][];
    let seen = 0;
    for (let i = Math.floor(0.15 * scan.count); i < Math.ceil(0.85 * scan.count); i += 1) {
      // Walking in from outside the prior to the page's paper…
      let end: number | null = null;
      for (let s = STRIP_FAR; s - 3 >= -reach; s -= 2) {
        if (!stripMean(scan, i, s - 3, s, strip)) break;
        if (paperLike(strip, paper[i])) {
          end = s;
          break;
        }
      }
      // (The page's edge right at the prior — a board's margin too thin to
      // read there — says nothing either way.)
      if (end === null || end > -BOARD_MIN_PX) continue;
      seen += 1;
      // …then back out over one material, to the prior at least.
      // (Past the edge's blur: a few px.)
      if (!stripMean(scan, i, end + BOARD_BLUR, end + BOARD_BLUR + 3, first) || paperLike(first, paper[i])) continue;
      let out = end + BOARD_BLUR + 3;
      while (out + 3 <= STRIP_FAR && stripMean(scan, i, out, out + 3, strip) && colourDistance(strip, first) <= BACKGROUND_MATCH && !paperLike(strip, paper[i])) {
        out += 2;
      }
      if (out + 3 < -BOARD_BLUR) continue;
      for (let j = 0; j < 3; j += 1) cols[j].push(first[j]);
      // What lies past the prior: the board again, or the desk past it.
      if (stripMean(scan, i, STRIP_FAR + 2, STRIP_FAR + 8, strip)) for (let j = 0; j < 3; j += 1) outs[j].push(strip[j]);
    }
    if (cols[0].length < BOARD_MIN_PROFILES || cols[0].length < BOARD_SHARE * seen) continue;
    const median = (v: number[]) => v.sort((p, q) => p - q)[v.length >> 1];
    colours.push(Float32Array.from(cols.map(median)));
    beyond.push(outs[0].length === 0 ? null : Float32Array.from(outs.map(median)));
  }
  if (colours.length < 2) return null;
  for (let i = 0; i < colours.length; i += 1) {
    const agree = colours.map((q, j) => j).filter((j) => sameMaterial(colours[j], colours[i]));
    // A board ends somewhere: on two of its sides at least, the prior is its
    // outline, with the desk — something else — past it. A loose prior on an
    // even desk has the desk on both sides of it.
    const outlined = agree.filter((j) => beyond[j] !== null && colourDistance(beyond[j]!, colours[i]) > BACKGROUND_MATCH).length;
    if (agree.length >= 2 && outlined >= 1) return { colour: colours[i], even: true };
  }
  return null;
}

/** Two readings of one material, in the same light or another (a board's lit and shaded ends). */
function sameMaterial(a: Float32Array, b: Float32Array): boolean {
  return colourDistance(a, b) <= BACKGROUND_MATCH || !otherStock({ l: a[0], w: a[1], t: a[2] }, { l: b[0], w: b[1], t: b[2] });
}

/**
 * Pass 4 for one side: the line of the longest visible run of its edge — a
 * straight paper edge with the background outside it along a stretch of
 * the side that runs from one end, at up to {@link OCCLUDED_MAX_ANGLE_DEG}
 * from the prior — and, past the run's open end, the edge covered (paper
 * where the desk was, or something across it). A run over (nearly) the whole
 * side is the edge turned further than the local pass looks.
 */
function occludedSide(
  st: SideState,
  band: number,
  outward: number,
  desk: Desk[],
  stock: Paper,
  clock: Clock,
  board = false,
  minRun = OCCLUDED_MIN_RUN,
): RunLine | undefined {
  const { scan, paper } = st;
  const inner = new Float32Array(3);
  const outer = new Float32Array(3);
  let best: RunLine | undefined;
  let bestHits = 0;
  for (const h of hypotheses(scan.candidates, scan.count, band, outward, st.length, OCCLUDED_MAX_ANGLE_DEG, OCCLUDED_LINES, clock)) {
    clock.check();
    // On a board, the edge is all its runs together (a clip mid-edge splits it in two).
    const run = board ? { i0: 0, i1: scan.count - 1, hits: h.profiles.length } : longestRun(h.profiles, scan.count);
    if (run.hits < minRun * scan.count || run.hits < bestHits) continue;
    const fromStart = run.i0 <= RUN_END_SLACK;
    const toEnd = run.i1 >= scan.count - 1 - RUN_END_SLACK;
    if (!fromStart && !toEnd) continue;
    const points: Candidate[] = [];
    for (let j = 0; j < h.profiles.length; j += 1) {
      const i = h.profiles[j];
      if (i < run.i0 || i > run.i1) continue;
      points.push({ profile: i, u: h.points[j * 2], s: h.points[j * 2 + 1], strength: 0, dl: 0, dw: 0, dt: 0 });
    }
    const fit = fitLine(points, h.a, h.b, INLIER_PX);
    if (fit.residual > MAX_RESIDUAL_PX) continue;
    const bow = sagitta(points, fit);
    if (bow > MAX_SAGITTA_PX) continue;
    // Paper inside, the background outside, no printed line: along the run.
    let seen = 0;
    let innerPaper = 0;
    let background = 0;
    // Judged where the edge is seen: the profiles that hold its points.
    for (const { profile: i } of points) {
      if (!stripsAt(scan, i, fit, inner, outer)) continue;
      seen += 1;
      // The page's paper, in whatever light falls on this stretch of it.
      // (Not on a board: a clip's grey metal is the page's white in shade, as far as colour goes.)
      if (
        (!board && paperLike(inner, paper[i])) ||
        paperLike(inner, stock) ||
        (!board && !otherStock({ l: inner[0], w: inner[1], t: inner[2] }, stock) && inner[0] >= PAPER_LIGHT * stock.l)
      ) {
        innerPaper += 1;
      }
      // The background: not the paper, not the paper in shade (a hand's
      // shadow across the page ends in a line too), the desk when it is known.
      if (
        !paperLike(outer, paper[i]) &&
        otherStock({ l: outer[0], w: outer[1], t: outer[2] }, paper[i]) &&
        (desk.length === 0 ||
          (board
            ? desk.some((d) => sameMaterial(outer, d.colour))
            : // The desk past the other sides — or, the desk changing (a mat's
              // edge, the wood beyond it), anything not dark enough to be ink.
              outer[0] >= INK_LUMA_SHARE * paper[i].l ||
              deskLike(scan, i, fit.a + fit.b * scan.us[i] + STRIP_NEAR, fit.a + fit.b * scan.us[i] + STRIP_FAR, outer, desk)))
      ) {
        background += 1;
      }
    }
    if (seen < 3 || innerPaper < MIN_INNER_PAPER * seen || background < RUN_BACKGROUND * seen) continue;
    // Never out across the desk to another sheet beyond it.
    if (!board && fit.a > WIDE_MIN_GAIN_PX && crossesDesk(scan, paper, { a: 0, b: 0 }, fit, desk)) continue;
    const runPoints = new Float32Array(points.length * 2);
    const runProfiles = new Int16Array(points.length);
    points.forEach((p, j) => {
      runPoints[j * 2] = p.u;
      runPoints[j * 2 + 1] = p.s;
      runProfiles[j] = p.profile;
    });
    const fitted: Hypothesis = { ...h, a: fit.a, b: fit.b, residual: fit.residual, support: run.hits / scan.count, points: runPoints, profiles: runProfiles };
    if (!board && run.hits < RUN_WHOLE * scan.count) {
      // Past the open end: the edge covered, not merely faint.
      const look = edgeLook(st, fitted);
      if (look === null || look.outerPaper) continue;
      const step = fromStart ? 1 : -1;
      let measured = 0;
      let covered = 0;
      for (let i = fromStart ? run.i1 + 1 : run.i0 - 1, n = 0; i >= 0 && i < scan.count && n < STOP_PROFILES; i += step, n += 1) {
        if (!stripsAt(scan, i, fit, inner, outer)) continue;
        measured += 1;
        const what = classify(inner, outer, look);
        if (what === "paper" || what === "object") covered += 1;
      }
      if (measured < 2 || covered < STOP_SHARE * measured) continue;
    }
    if (best === undefined || run.hits > bestHits || fit.a > best.h.a) {
      best = { h: fitted, share: run.hits / scan.count, sagittaPx: bow };
      bestHits = run.hits;
    }
  }
  return best;
}

/** A corner's walk along one of its edges: how far from the corner the edge is first seen, and what lies before that. */
interface Walk {
  /** Distance from the corner (px) to where the edge is seen; Infinity when it never is. */
  reach: number;
  /** Samples short of `reach`: covered (paper over the line, an object across it), the desk on both sides, measured at all. */
  covered: number;
  /**
   * Samples short of `reach` where the edge is there after all, over another
   * sheet: the page's paper inside, a step at the line, and paper — not the
   * desk — outside it and on past it (the sheet the page lies on).
   */
  under: number;
  desk: number;
  measured: number;
  /**
   * How sharply the surface outside the line changes where the edge comes
   * back (its largest change over 6 px, over the edge's own step): an
   * occluder's outline crosses there; a lamp's glare fades out.
   */
  sharp: number;
  /** The surface outside the edge where it is first seen: the desk next to the corner (null when never seen). */
  deskNear: Float32Array | null;
}

/**
 * Walk from `corner` along `dir` (unit, into the side), with `inward`
 * the unit normal towards the page, out to `maxT` px: the first place where
 * {@link WALK_WINDOW} samples in a row (but one) are the edge.
 */
function walkEdge(planes: Planes, corner: Vec, dir: Vec, inward: Vec, start: number, maxT: number, look: EdgeLook, nearPx: number, clock: Clock): Walk {
  const inner = new Float32Array(3);
  const outer = new Float32Array(3);
  const at = new Float32Array(3);
  const strip = (x: number, y: number, sign: number, out: Float32Array) => {
    out.fill(0);
    let n = 0;
    for (let d = STRIP_NEAR; d <= STRIP_FAR; d += 1) {
      if (!sampleInto(planes, x + sign * inward[0] * d, y + sign * inward[1] * d, at, 0)) return false;
      out[0] += at[0];
      out[1] += at[1];
      out[2] += at[2];
      n += 1;
    }
    out[0] /= n;
    out[1] /= n;
    out[2] /= n;
    return true;
  };
  // The desk within `nearPx` outside the line: the edge is right there, bent off it.
  const deskNear = (x: number, y: number) => {
    for (let d = STRIP_FAR + 2; d + STRIP_FAR - STRIP_NEAR <= nearPx; d += 2) {
      if (strip(x - inward[0] * (d - STRIP_NEAR), y - inward[1] * (d - STRIP_NEAR), -1, at3) && colourDistance(at3, look.outer) <= BACKGROUND_MATCH) return true;
    }
    return false;
  };
  const at3 = new Float32Array(3);
  const far = new Float32Array(3);
  // The page's edge over another sheet: a step at the line, the page's
  // paper inside, light paper — not the desk — outside and further out.
  const overSheetAt = (x: number, y: number) => {
    if (!paperLike(inner, look.paper) || colourDistance(inner, outer) < MATERIAL_STEP) return false;
    const light = (c: Float32Array) =>
      c[0] >= UNDER_LIGHT * look.paper.l && colourDistance(c, look.outer) > BACKGROUND_MATCH && !inShade(c, look.outer) && !otherStock({ l: c[0], w: c[1], t: c[2] }, look.paper);
    if (!light(outer)) return false;
    return strip(x - inward[0] * UNDER_FAR, y - inward[1] * UNDER_FAR, -1, far) && light(far);
  };
  const unders: boolean[] = [];
  const kinds: Stretch[] = [];
  const ts: number[] = [];
  const outers: number[] = [];
  for (let t = start, tick = 0; t <= maxT; t += WALK_STEP, tick += 1) {
    if ((tick & 15) === 15) clock.check();
    const x = corner[0] + dir[0] * t;
    const y = corner[1] + dir[1] * t;
    let kind: Stretch = strip(x, y, 1, inner) && strip(x, y, -1, outer) ? classify(inner, outer, look) : "off";
    if (kind === "paper" && deskNear(x, y)) kind = "other";
    unders.push(kind !== "off" && kind !== "edge" && kind !== "desk" && overSheetAt(x, y));
    kinds.push(kind);
    ts.push(t);
    outers.push(outer[0], outer[1], outer[2]);
    const n = kinds.length;
    if (n >= WALK_WINDOW) {
      let edge = 0;
      for (let j = n - WALK_WINDOW; j < n; j += 1) if (kinds[j] === "edge") edge += 1;
      if (edge >= WALK_WINDOW - 1) {
        const first = n - WALK_WINDOW;
        let covered = 0;
        let desk = 0;
        let measured = 0;
        let under = 0;
        for (let j = 0; j < first; j += 1) {
          if (kinds[j] === "off") continue;
          measured += 1;
          if (unders[j]) under += 1;
          if (kinds[j] === "paper" || kinds[j] === "object") covered += 1;
          if (kinds[j] === "desk") desk += 1;
        }
        // The change outside the line around where the edge came back.
        let sharp = 0;
        const span = Math.round(6 / WALK_STEP);
        for (let j = Math.max(0, first - 12); j + span < Math.min(n, first + 4); j += 1) {
          if (kinds[j] === "off" || kinds[j + span] === "off") continue;
          const d = Math.hypot(outers[j * 3] - outers[(j + span) * 3], outers[j * 3 + 1] - outers[(j + span) * 3 + 1], outers[j * 3 + 2] - outers[(j + span) * 3 + 2]);
          sharp = Math.max(sharp, d / Math.max(look.step, MATERIAL_STEP));
        }
        // The desk next to the corner: outside the edge a little past where it
        // came back — clear of whatever lay over the corner and its shadow.
        const deskNear = new Float32Array(3);
        let m = 0;
        for (let t2 = ts[first] + DESK_NEAR_FROM; t2 <= Math.min(maxT, ts[first] + DESK_NEAR_TO); t2 += WALK_STEP * 2) {
          if (!strip(corner[0] + dir[0] * t2, corner[1] + dir[1] * t2, -1, at3)) continue;
          for (let q = 0; q < 3; q += 1) deskNear[q] += at3[q];
          m += 1;
        }
        if (m === 0) {
          for (let j = first; j < n; j += 1) {
            if (kinds[j] !== "edge") continue;
            for (let q = 0; q < 3; q += 1) deskNear[q] += outers[j * 3 + q];
            m += 1;
          }
        }
        for (let q = 0; q < 3; q += 1) deskNear[q] /= Math.max(1, m);
        return { reach: ts[first], covered, under, desk, measured, sharp, deskNear };
      }
    }
  }
  let covered = 0;
  let desk = 0;
  let measured = 0;
  let under = 0;
  kinds.forEach((kind, j) => {
    if (kind === "off") return;
    measured += 1;
    if (unders[j]) under += 1;
    if (kind === "paper" || kind === "object") covered += 1;
    if (kind === "desk") desk += 1;
  });
  return { reach: Infinity, covered, under, desk, measured, sharp: 1, deskNear: null };
}

/**
 * `c` is the surface `d` in shade: darker, by no more than a soft shadow
 * darkens (to {@link TIP_SHADE_FLOOR} of its luma), and the same colour.
 */
function inShade(c: Float32Array, d: Float32Array): boolean {
  if (c[0] > d[0] || c[0] < TIP_SHADE_FLOOR * d[0]) return false;
  const lc = Math.max(c[0], 16);
  const ld = Math.max(d[0], 16);
  return Math.hypot(c[1] / lc - d[1] / ld, c[2] / lc - d[2] / ld) <= SHADE_CHROMA;
}

/**
 * Something lies right on the corner — a binder clip turned over it, a
 * thumb: the page's tip (just inside both edges) and the corner's
 * surroundings past it (on both edges' lines, extended) are one material that
 * is neither the paper nor the desk. A full-bleed band printed to the corner
 * has the desk past it; a rounded or torn corner has the desk on it.
 */
function tipCovered(planes: Planes, corner: Vec, towardA: Vec, towardB: Vec, look: EdgeLook, desks: Float32Array[]): boolean {
  const unit = (q: Vec): Vec => {
    const d = Math.hypot(q[0] - corner[0], q[1] - corner[1]);
    return [(q[0] - corner[0]) / d, (q[1] - corner[1]) / d];
  };
  const a = unit(towardA);
  const b = unit(towardB);
  // Neither the paper nor the desk next to the corner — nor either of them in
  // shade (a hand's shadow over the corner is the same two materials, darker).
  const notDesk = (c: Float32Array) => desks.every((d) => colourDistance(c, d) > BACKGROUND_MATCH && !inShade(c, d));
  const object = (c: Float32Array, under: Paper | null) =>
    !paperLike(c, look.paper) && notDesk(c) && (under === null || otherStock({ l: c[0], w: c[1], t: c[2] }, under));
  const around: Float32Array[] = [];
  for (const d of TIP_OUTSIDE) {
    for (const u of [a, b]) {
      const c = new Float32Array(3);
      if (!sampleInto(planes, corner[0] - u[0] * d, corner[1] - u[1] * d, c, 0) || !object(c, null)) return false;
      around.push(c);
    }
  }
  // The page's tip itself under something that is not its paper. What lies
  // outside a corner alone never says it is covered: a mat's border or a
  // table's bright edge just past a real corner (in glare, its edges fading
  // short of it) is one material all round it too.
  const c = new Float32Array(3);
  let inside = 0;
  for (const [i, j] of TIP_INSIDE) {
    if (sampleInto(planes, corner[0] + a[0] * i + b[0] * j, corner[1] + a[1] * i + b[1] * j, c, 0) && object(c, look.paper)) inside += 1;
  }
  // One thing all round the corner's outside (a clip's body), not the desk
  // changing past it: one colour — and over the tip as well, on half of it.
  let one = true;
  for (let i = 0; i < around.length && one; i += 1) {
    for (let j = i + 1; j < around.length; j += 1) if (colourDistance(around[i], around[j]) > BACKGROUND_MATCH) one = false;
  }
  if (one && inside >= TIP_INSIDE.length / 2) return true;
  return inside >= TIP_INSIDE.length - 1;
}

/**
 * Each corner's provenance on the chosen lines, and whether another sheet
 * overlaps this one.
 */
function provenance(
  planes: Planes,
  states: SideState[],
  rungs: Rung[],
  points: Vec[],
  diag: number,
  clock: Clock,
  cache: Map<string, { walk: Walk; length: number } | null> = new Map(),
): { corners: CornerReport[]; occlusion: OcclusionReport } {
  clock.check();
  const reachDiag = REACH_DIAG * diag;
  const nearPx = Math.max(NEAR_DESK_PX, NEAR_DESK_DIAG * diag);
  const cx = (points[0][0] + points[1][0] + points[2][0] + points[3][0]) / 4;
  const cy = (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4;
  const looks = rungs.map((rung, k) => (rung.report.accepted && rung.edge !== undefined ? edgeLook(states[k], rung.edge) : null));
  const { width, height } = planes;
  // Side k runs from corner k to corner k + 1.
  const walkSide = (k: number, from: number, start: number): { walk: Walk; length: number } | null => {
    const look = looks[k];
    if (look === null) return null;
    const a = points[from];
    const b = points[from === k ? (k + 1) % 4 : k];
    // The fallback ladder measures many combinations of the same sides: a
    // walk from the same corner along the same edge is walked once.
    const key = `${k}:${from}:${start.toFixed(1)}:${a[0].toFixed(2)},${a[1].toFixed(2)}:${b[0].toFixed(2)},${b[1].toFixed(2)}:${rungKey(rungs[k])}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    clock.check();
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir: Vec = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    let inward: Vec = [-dir[1], dir[0]];
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if ((cx - mx) * inward[0] + (cy - my) * inward[1] < 0) inward = [-inward[0], -inward[1]];
    const answer = { walk: walkEdge(planes, a, dir, inward, start, 0.7 * length, look, nearPx, clock), length };
    cache.set(key, answer);
    return answer;
  };
  const reports: CornerReport[] = [];

  let sheetCorners = 0;
  for (let c = 0; c < 4; c += 1) {
    const p = points[c];
    const before = (c + 3) % 4;
    // A corner off the picture is the framing hints' business.
    if (p[0] < 0 || p[1] < 0 || p[0] > width || p[1] > height) {
      reports.push({ provenance: "seen", confidence: 0, runs: [0, 0], basis: "off-image" });
      continue;
    }
    // The walk starts where its inner strip is clear of the other edge: at an
    // acute corner, further from it.
    const u = [points[before][0] - p[0], points[before][1] - p[1]];
    const v = [points[(c + 1) % 4][0] - p[0], points[(c + 1) % 4][1] - p[1]];
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]));
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    const start = angle >= Math.PI / 2 ? WALK_START : Math.min(4 * WALK_START, (STRIP_FAR + 1) / Math.tan(angle) + 3);
    const reachPx = Math.max(Math.max(WALK_START, start) + REACH_PX - WALK_START, reachDiag);
    const walks = [walkSide(before, c, Math.max(WALK_START, start)), walkSide(c, c, Math.max(WALK_START, start))];
    if (walks.every((w) => w === null)) {
      reports.push({ provenance: "seen", confidence: 0, runs: [0, 0], basis: "no-edge" });
      continue;
    }
    const runs = walks.map((w) => (w === null ? 0 : Math.max(0, 1 - Math.min(w.walk.reach, w.length) / w.length))) as [number, number];
    const coveredWalk = walks.some(
      (w) =>
        w !== null &&
        w.walk.reach > reachPx &&
        w.walk.covered >= COVER_MIN_SAMPLES &&
        w.walk.covered >= COVER_SHARE * w.walk.measured &&
        w.walk.covered > w.walk.desk &&
        w.walk.sharp >= COVER_SHARP,
    );
    // The edges seen right up to the corner after all, over another sheet:
    // the page lies on it (or it on the page's corner, seen past it) — the
    // corner is seen; the two sheets are another matter ("Separe as folhas").
    const onSheet =
      walks.some((w) => w !== null && w.walk.reach > reachPx) &&
      walks.every(
        (w) =>
          w === null ||
          w.walk.reach <= reachPx ||
          (w.walk.under >= COVER_MIN_SAMPLES && w.walk.under >= UNDER_SHARE * w.walk.measured),
      );
    if (onSheet) {
      sheetCorners += 1;
      reports.push({ provenance: "seen", confidence: 1, runs, basis: "on-sheet" });
      continue;
    }
    const look = looks[before] ?? looks[c];
    // Every desk seen round the page: a clip is none of them; the desk
    // changing past the corner (a mat's border, a table's edge) is one of
    // them somewhere along the page.
    const desks = [
      ...walks.flatMap((w) => (w === null || w.walk.deskNear === null ? [] : [w.walk.deskNear])),
      ...looks.flatMap((l) => (l === null ? [] : [l.outer])),
    ];
    // (Only where an edge is not seen right up to the corner: a clip's body
    // over it hides a few px of each; a desk changing past a seen corner hides none.)
    const coveredTip =
      look !== null &&
      desks.length > 0 &&
      walks.some((w) => w !== null && w.walk.reach >= reachPx) &&
      tipCovered(planes, p, points[before], points[(c + 1) % 4], look, desks);
    if (!coveredWalk && !coveredTip) {
      // Seen on evidence: each edge reaches the corner, or — short of it —
      // runs into the desk on both sides of its line (a rounded or torn
      // corner: background where the tip would be).
      const reaches = walks.every((w) => w !== null && w.walk.reach <= reachPx);
      const evidenced = walks.every(
        (w) =>
          w !== null &&
          (w.walk.reach <= reachPx || (w.walk.desk >= COVER_MIN_SAMPLES && w.walk.desk >= COVER_SHARE * w.walk.measured)),
      );
      const basis: CornerBasis = reaches ? "edges" : evidenced ? "rounded" : walks.some((w) => w === null) ? "one-edge" : "short";
      reports.push({ provenance: "seen", confidence: reaches ? 1 : 0.5, runs, basis });
      continue;
    }
    // Covered: inferred when both edges are seen far enough to extend, unknown otherwise.
    const trusted = walks.every((w, j) => {
      if (w === null) return false;
      const rung = rungs[j === 0 ? before : c];
      const seenPx = w.length - Math.min(w.walk.reach, w.length);
      return (
        seenPx >= INFER_MIN_RUN * w.length &&
        Math.min(w.walk.reach, w.length) <= INFER_MAX_EXTEND * seenPx &&
        rung.report.residualPx <= MAX_RESIDUAL_PX &&
        rung.sagittaPx <= MAX_SAGITTA_PX
      );
    });
    const confidence = trusted ? Math.min(1, Math.max(0, (Math.min(runs[0], runs[1]) - INFER_MIN_RUN) / (1 - INFER_MIN_RUN))) : 0;
    reports.push({ provenance: trusted ? "inferred" : "unknown", confidence, runs, basis: "covered" });
  }
  // Another sheet past sides whose own two corners are seen: the page lies
  // on it or under it whole — not a sheet over one of its corners.
  // (Never on a paper-coloured desk: there the "sheet" past a side is the table.)
  const deskNotPaper = looks.some((look) => look !== null && !look.outerPaper);
  // A corner seen lying on another sheet; the desk inside the answer (two
  // sheets spanned as one); a whole sheet offset under or over this one,
  // showing past two of its sides.
  const outsides = looks.flatMap((l) => (l === null || l.outerPaper ? [] : [l.outer]));
  const paperOf = looks.find((l) => l !== null)?.paper ?? null;
  const separate =
    deskNotPaper &&
    (sheetCorners > 0 ||
      (paperOf !== null && deskInside(planes, points, outsides, paperOf, diag, clock)) ||
    rungs.filter(
      (rung, k) =>
        rung.report.accepted &&
        rung.edge !== undefined &&
        reports[k].provenance === "seen" &&
        reports[(k + 1) % 4].provenance === "seen" &&
        sheetBeyond(states[k], rung.edge, diag),
    ).length >= SEPARATE_SIDES);
  return { corners: reports, occlusion: { suspected: reports.some((r) => r.provenance !== "seen"), separate } };
}

/** A stable name for a rung's line within one refinement (the walk cache's key). */
const rungIds = new WeakMap<Rung, number>();
let nextRungId = 0;
function rungKey(rung: Rung): number {
  let id = rungIds.get(rung);
  if (id === undefined) {
    id = nextRungId += 1;
    rungIds.set(rung, id);
  }
  return id;
}

/**
 * Two sheets taken for one: the answer reaches over both, and the desk
 * between them lies inside it — a wedge of the desk running in from a side.
 * Along {@link WEDGE_PROFILES} profiles of each side, walked in from
 * {@link WEDGE_FROM} of the diagonal inside it: the desk (the colour outside
 * the found edges, not the page's paper) for at least {@link WEDGE_DEPTH} of
 * the diagonal, on at least {@link WEDGE_SHARE} of a side's profiles.
 */
function deskInside(planes: Planes, points: Vec[], desks: Float32Array[], paper: Paper, diag: number, clock: Clock): boolean {
  // Only a desk well apart from the paper: on a white table the page's own
  // blank margin reads as the desk.
  const ref = Float32Array.of(paper.l, paper.w, paper.t);
  desks = desks.filter((d) => colourDistance(d, ref) > 2 * BACKGROUND_MATCH);
  if (desks.length === 0) return false;
  const cx = (points[0][0] + points[1][0] + points[2][0] + points[3][0]) / 4;
  const cy = (points[0][1] + points[1][1] + points[2][1] + points[3][1]) / 4;
  const c = new Float32Array(3);
  const at = new Float32Array(3);
  const step = WEDGE_STEP * diag;
  const deskAt = (x: number, y: number, ux: number, uy: number) => {
    // Three samples across the walk, averaged: one speck is not the desk.
    c.fill(0);
    for (const o of [-2, 0, 2]) {
      if (!sampleInto(planes, x + uy * o, y - ux * o, at, 0)) return false;
      c[0] += at[0] / 3;
      c[1] += at[1] / 3;
      c[2] += at[2] / 3;
    }
    return !paperLike(c, paper) && desks.some((d) => colourDistance(c, d) <= BACKGROUND_MATCH);
  };
  for (let k = 0; k < 4; k += 1) {
    const a = points[k];
    const b = points[(k + 1) % 4];
    let wedges = 0;
    for (let j = 0; j < WEDGE_PROFILES; j += 1) {
      clock.check();
      const f = (j + 0.5) / WEDGE_PROFILES;
      const x0 = a[0] + (b[0] - a[0]) * f;
      const y0 = a[1] + (b[1] - a[1]) * f;
      const toC = Math.hypot(cx - x0, cy - y0);
      if (toC < 1) continue;
      const ux = (cx - x0) / toC;
      const uy = (cy - y0) / toC;
      let run = 0;
      let miss = 0;
      for (let d = WEDGE_FROM * diag; d < 0.5 * toC; d += step) {
        if (deskAt(x0 + ux * d, y0 + uy * d, ux, uy)) {
          run += step;
          miss = 0;
        } else if (run > 0 && miss === 0) {
          miss = 1;
        } else {
          break;
        }
        if (run >= WEDGE_DEPTH * diag) break;
      }
      if (run >= WEDGE_DEPTH * diag) wedges += 1;
    }
    if (wedges >= WEDGE_SHARE * WEDGE_PROFILES) return true;
  }
  return false;
}

/**
 * Another sheet past a side: paper right outside its edge reaching
 * {@link SEPARATE_REACH} of the diagonal on, along {@link SEPARATE_SHARE}
 * of its profiles — not a stack's few px of side face, not a sheet a desk's
 * width away.
 */
function sheetBeyond(st: SideState, h: { a: number; b: number }, diag: number): boolean {
  const { scan, paper } = st;
  const c = new Float32Array(3);
  const reach = SEPARATE_REACH * diag;
  let seen = 0;
  let sheet = 0;
  let desk = 0;
  for (let i = 0; i < scan.count; i += 1) {
    const s0 = h.a + h.b * scan.us[i];
    if (!stripMean(scan, i, s0 + STRIP_NEAR, s0 + STRIP_FAR, c)) continue;
    seen += 1;
    if (!paperLike(c, paper[i])) {
      desk += 1;
      continue;
    }
    let all = true;
    for (let s = s0 + STRIP_FAR; s + 6 <= s0 + reach; s += 6) {
      if (!stripMean(scan, i, s, s + 6, c) || !paperLike(c, paper[i])) {
        all = false;
        break;
      }
    }
    if (all) sheet += 1;
  }
  // …and the desk past the rest of it: a sheet the page overlaps, not a
  // paper-coloured table all round.
  return seen > 0 && sheet >= SEPARATE_SHARE * seen && desk >= SEPARATE_DESK * seen;
}

// ── the quad ─────────────────────────────────────────────────────────────────

const KEYS = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;

/** Four corners nothing was measured at: never `seen` — a reader that skips `measured` still holds auto-capture. */
function unmeasured(): CornerReport[] {
  return [0, 1, 2, 3].map(() => ({ provenance: "unknown", confidence: 0, runs: [0, 0], basis: "unmeasured" }));
}

const NO_OCCLUSION: OcclusionReport = { suspected: false, separate: false };

function unchanged(
  quad: NormalizedQuad,
  started: number,
  now: () => number,
  reason: string,
  sides: SideReport[] = [],
  corners: CornerReport[] = unmeasured(),
  occlusion: OcclusionReport = NO_OCCLUSION,
  measured = false,
): RefineResult {
  return { quad, changed: false, sides, corners, occlusion, measured, ms: now() - started, reason };
}

function kept(reason: string, h?: Hypothesis): SideReport {
  return { accepted: false, reason, support: h?.support ?? 0, residualPx: h?.residual ?? 0, shiftFrac: 0, mode: "kept" };
}

/**
 * Move each side of `quad` (normalized to `image`) onto the paper edge it sits
 * near. Never throws: a bad image, a bad quad, an error, a blown budget or a
 * result that fails its sanity checks all answer the input unchanged, with the
 * reason.
 */
export function refineQuad(image: RefineImage, quad: NormalizedQuad, options: RefineOptions = {}): RefineResult {
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const started = now();
  try {
    return refine(image, quad, options, started, now);
  } catch (error) {
    return unchanged(quad, started, now, error === OUT_OF_TIME ? "budget" : "error");
  }
}

/** One side between the local and the wide pass. */
interface SideState {
  scan: SideScan;
  paper: Paper[];
  length: number;
  frame: SideFrame;
  toLine: (h: { a: number; b: number }) => Line;
  best: Judged | undefined;
}

function refine(
  image: RefineImage,
  quad: NormalizedQuad,
  options: RefineOptions,
  started: number,
  now: () => number,
): RefineResult {
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const clock: Clock = {
    check() {
      if (now() - started > budget) throw OUT_OF_TIME;
    },
  };
  const planes = toPlanes(image, clock);
  if (planes === null) return unchanged(quad, started, now, "bad-image");
  const { width, height } = planes;
  const diag = Math.hypot(width, height);
  const corners: Vec[] = KEYS.map((k) => [quad[k].x * width, quad[k].y * height]);
  if (corners.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)) || !saneQuad(corners, 5)) {
    return unchanged(quad, started, now, "bad-quad");
  }
  const cx = (corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4;
  const cy = (corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4;
  const quadStock = quadPaper(planes, corners);
  if (quadStock === null) return unchanged(quad, started, now, "no-paper");

  const wide = options.mode !== "local";
  const band = LOCAL_BAND * diag;
  const depth = Math.max(band, PAPER_DEPTH * diag);
  const outward = wide ? WIDE_REACH * diag : band;

  // Pass 1, every side: the edge nearby.
  const states: SideState[] = [];
  const priorLines: Line[] = [];
  const localLines: Line[] = [];
  const localReports: SideReport[] = [];
  const guarded: boolean[] = [];
  for (let k = 0; k < 4; k += 1) {
    clock.check();
    const a = corners[k];
    const b = corners[(k + 1) % 4];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tx = (b[0] - a[0]) / length;
    const ty = (b[1] - a[1]) / length;
    let nx = -ty;
    let ny = tx;
    const ox = (a[0] + b[0]) / 2;
    const oy = (a[1] + b[1]) / 2;
    if ((ox - cx) * nx + (oy - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const toLine = (h: { a: number; b: number }): Line => {
      const len = Math.hypot(1, h.b);
      return { px: ox + nx * h.a, py: oy + ny * h.a, dx: (tx + nx * h.b) / len, dy: (ty + ny * h.b) / len };
    };
    priorLines.push({ px: ox, py: oy, dx: tx, dy: ty });
    const scan = scanSide(
      planes,
      { ox, oy, tx, ty, nx, ny, length },
      band,
      outward,
      depth,
      wide ? WIDE_CANDIDATES : LOCAL_CANDIDATES,
      clock,
    );
    const paper = sidePaper(scan, depth, STEP_HALF + 3, quadStock.paper, quadStock.dominant);
    const nearby = scan.candidates.filter((c) => c.s <= band);
    const local = hypotheses(nearby, scan.count, band, band, length, LOCAL_MAX_ANGLE_DEG, 6, clock).map((h) =>
      judge(scan, h, paper, clock),
    );
    let pool = withoutTwins(local.filter(eligible), scan.count).sort((p, q) => q.a - p.a);
    // Outermost — but never past a confident edge with paper-coloured surface
    // right outside it (the sheet below, a white table).
    const stop = pool.filter((h) => h.a > -3 && paperMeetsPaper(scan, h, paper)).sort((p, q) => p.a - q.a)[0];
    if (stop !== undefined) pool = pool.filter((h) => h.a <= stop.a + 0.5);
    let best = outermost(scan, paper, withoutRepeats(scan, paper, pool, { a: 0, b: 0 }, clock));
    let reason = best === undefined ? (local.length === 0 ? "no-edge" : "no-paper-edge") : "edge";
    // Content protection: inward only over background, and never short of
    // paper — judged wherever the line runs inside the prior, not only at its
    // middle: a line turned against the prior can be on it at the middle and
    // well inside it at one end. (A few px of turn is left to the per-profile
    // check: on a coarse desk a strip that narrow is too few samples to judge.)
    if (best !== undefined && Math.min(best.a, best.a - Math.abs(best.b) * scan.us[scan.count - 1] + INWARD_TURN_SLACK_PX) < -2) {
      if (!inwardAllowed(scan, best, paper, band, local, SHALLOW_CUT * diag)) {
        best = undefined;
        reason = "content-inside";
      }
    }
    // The occluder guard (model's quads): a side found on the outline of a
    // sheet lying over the page — its paper inside, the desk outside, all a
    // page's edge looks like — has, between it and the page, that sheet's
    // edge over the page: a step with paper on both sides of it, along the
    // side. Such a side is looked at again by the occlusion pass, whose
    // visible run, when it places a covered corner, outranks it. (A stack's
    // sheets a few px apart are not that: see OCCLUDER_GAP.)
    guarded.push(best !== undefined && wide && overSheet(scan, best, local, paper, OCCLUDER_GAP * diag));
    states.push({ scan, paper, length, frame: { ox, oy, tx, ty, nx, ny, length }, toLine, best });
    localLines.push(best === undefined ? priorLines[k] : toLine(best));
    localReports.push(
      best === undefined
        ? kept(reason, local[0])
        : { accepted: true, reason, support: best.support, residualPx: best.residual, shiftFrac: best.a / diag, mode: "local" },
    );
  }

  // The desk as the local pass saw it: what lies past each found edge where
  // it is not paper. A side's own is no help to it (its edge may be a band's).
  const desks = states.map((st) => (st.best === undefined ? null : outsideDesk(st.scan, st.best, st.paper)));
  const deskBeside = (k: number) => desks.filter((d, j): d is Desk => j !== k && d !== null);

  // Pass 2, the model's quads: sides the page goes on past.
  const wideLines: Line[] = [...localLines];
  const wideReports: SideReport[] = [...localReports];
  // The hypothesis behind each side's answer, for the corners' provenance.
  const wideFound: (Hypothesis | undefined)[] = states.map((st) => st.best);
  const farthest = (st: SideState, base: { a: number; b: number }, maxAngleDeg: number, desk: Desk[]) =>
    outermost(
      st.scan,
      st.paper,
      withoutRepeats(
        st.scan,
        st.paper,
        hypotheses(st.scan.candidates, st.scan.count, band, outward, st.length, maxAngleDeg, 12, clock)
          .map((h) => judge(st.scan, h, st.paper, clock))
          .filter((h) => eligible(h) && (h.a <= base.a + WIDE_MIN_GAIN_PX || !crossesDesk(st.scan, st.paper, base, h, desk)))
          .sort((p, q) => q.a - p.a),
        base,
        clock,
      ),
    );
  if (wide) {
    for (let k = 0; k < 4; k += 1) {
      clock.check();
      const st = states[k];
      const base = st.best ?? { a: 0, b: 0 };
      const desk = deskBeside(k);
      // A paper edge found nearby with background right outside it is what a
      // page's edge looks like: searching past it for more paper is how a
      // striped cloth, a tiled counter, the sheet beyond a gap get taken for
      // the page. With paper right outside it, it is where one sheet lies on
      // another — the sheet below, the facing page of a booklet, a white
      // table (a printed rule, the one edge with its own page past it, is
      // print and never found). Only a side with no edge found, or one with a
      // band of ink right outside it (a header the model took for the top),
      // searches on.
      if (st.best !== undefined && (paperOutside(st.scan, st.best, st.paper) >= 0.5 || pageEdgeLike(st.scan, st.best, st.paper, desk))) {
        continue;
      }
      if (paperBeyond(st.scan, base, st.paper, 4, PAGE_CONTINUES_REACH * diag) < PAGE_CONTINUES) continue;
      const far = farthest(st, base, WIDE_MAX_ANGLE_DEG, desk);
      if (far === undefined || far.a <= base.a + WIDE_MIN_GAIN_PX) continue;
      wideFound[k] = far;
      wideLines[k] = st.toLine(far);
      wideReports[k] = {
        accepted: true,
        reason: "page-continues",
        support: far.support,
        residualPx: far.residual,
        shiftFrac: far.a / diag,
        mode: "wide",
      };
    }
  }

  // A wide move needs a neighbour: a side found far from its prior is only
  // believed when at least one of the two sides it meets was found too — the
  // new corners are where it crosses them.
  for (let k = 0; k < 4; k += 1) {
    if (wideReports[k].mode !== "wide") continue;
    if (wideReports[(k + 3) % 4].accepted || wideReports[(k + 1) % 4].accepted) continue;
    wideLines[k] = localLines[k];
    wideReports[k] = localReports[k];
    wideFound[k] = states[k].best;
  }

  // Pass 3: a side still unfound between two found ones may be further off its
  // prior than the wide pass turns — a corner pulled far along a side leaves
  // the side between at a steep angle to the page's edge. Its two neighbours
  // are where its corners must be, which is what makes the steeper turn safe.
  if (wide) {
    for (let k = 0; k < 4; k += 1) {
      if (wideReports[k].accepted) continue;
      if (!wideReports[(k + 3) % 4].accepted || !wideReports[(k + 1) % 4].accepted) continue;
      clock.check();
      const st = states[k];
      if (paperBeyond(st.scan, { a: 0, b: 0 }, st.paper, 4, PAGE_CONTINUES_REACH * diag) < PAGE_CONTINUES) continue;
      const far = farthest(st, { a: 0, b: 0 }, STEEP_MAX_ANGLE_DEG, deskBeside(k));
      if (far === undefined || far.a <= WIDE_MIN_GAIN_PX) continue;
      wideFound[k] = far;
      wideLines[k] = st.toLine(far);
      wideReports[k] = {
        accepted: true,
        reason: "page-continues",
        support: far.support,
        residualPx: far.residual,
        shiftFrac: far.a / diag,
        mode: "wide",
      };
    }
  }

  // Pass 4, the model's quads: a side something lies over. A sheet over a
  // corner, a clip on an edge — the side's edge is seen along part of its
  // length only, and the model's corner sat on the occluder, turning the
  // prior side away from the edge. Its line is fitted on the visible run
  // alone ({@link occludedSide}); the corner is where the runs' lines cross.
  const occludedLines: (RunLine | undefined)[] = [undefined, undefined, undefined, undefined];
  // A page on a board (a clipboard): every side is looked for inside the
  // board's outline, against the board.
  const board = wide ? boardInside(states, diag) : null;
  if (wide) {
    for (let k = 0; k < 4; k += 1) {
      if (wideReports[k].accepted && board === null && !guarded[k]) continue;
      clock.check();
      // The visible run may lie well inside the prior (a corner pulled out
      // onto the sheet over it turns the side outward): this side is read
      // again, deeper. Same profiles, so the paper read for them still holds.
      const inward = OCCLUDED_INWARD * diag;
      const deep = scanSide(planes, states[k].frame, inward, outward, Math.max(depth, inward), WIDE_CANDIDATES, clock);
      states[k] = { ...states[k], scan: deep };
      occludedLines[k] =
        board === null
          ? occludedSide(states[k], inward, outward, deskBeside(k), quadStock.paper, clock, false, guarded[k] ? GUARDED_MIN_RUN : OCCLUDED_MIN_RUN)
          : occludedSide(states[k], inward, outward, [board], quadStock.paper, clock, true);
    }
  }

  // Corners, and the fallback ladder: every side at its answer; then, one
  // step at a time, occluded and wide back to local, local back to the prior;
  // last, the input itself.
  clock.check();
  const offImage = ([x, y]: Vec) => Math.max(0, -x, -y, x - width, y - height);
  const ladders = [0, 1, 2, 3].map((k) => {
    const rungs: Rung[] = [];
    const run = occludedLines[k];
    if (run !== undefined) {
      rungs.push({
        line: states[k].toLine(run.h),
        report: {
          accepted: true,
          reason: board !== null ? "board" : guarded[k] ? "occluder-edge" : "occluded",
          support: run.share,
          residualPx: run.h.residual,
          shiftFrac: run.h.a / diag,
          mode: "occluded",
        },
        edge: run.h,
        sagittaPx: run.sagittaPx,
      });
    }
    rungs.push({ line: wideLines[k], report: wideReports[k], edge: wideReports[k].accepted ? wideFound[k] : undefined, sagittaPx: 0 });
    if (wideReports[k].mode === "wide") {
      rungs.push({ line: localLines[k], report: localReports[k], edge: localReports[k].accepted ? states[k].best : undefined, sagittaPx: 0 });
    }
    if (rungs[rungs.length - 1].report.accepted) rungs.push({ line: priorLines[k], report: kept("fallback"), edge: undefined, sagittaPx: 0 });
    return rungs;
  });
  const priorArea = polygonArea(corners);
  const corneredBy = (lines: Line[], minRatio = MIN_AREA_RATIO): Vec[] | null => {
    const points: Vec[] = [];
    for (let k = 0; k < 4; k += 1) {
      const p = intersect(lines[(k + 3) % 4], lines[k]);
      if (p === null) return null;
      points.push(p);
    }
    // Off the image, a corner would seed the confirm screen's handle off the
    // picture and, confirmed as is, warp the frame's edge row into a stripe:
    // the side that put it there falls back instead.
    const inFrame = points.every((p, k) => offImage(p) <= Math.max(FRAME_SLACK_PX, offImage(corners[k])));
    const area = polygonArea(points);
    const ratio = Math.abs(area) / Math.abs(priorArea);
    // The same page, wound the same way: a quad turned inside out would warp
    // the page into its mirror image, and one that has slid off most of the
    // prior is a neighbour's crop.
    if (!inFrame || Math.sign(area) !== Math.sign(priorArea) || !saneQuad(points, MIN_CORNER_ANGLE_DEG)) return null;
    if (!(ratio > minRatio && ratio < MAX_AREA_RATIO)) return null;
    return overlapArea(points, corners) >= MIN_OVERLAP * Math.min(Math.abs(area), Math.abs(priorArea)) ? points : null;
  };
  const combos: number[][] = [[]];
  for (const rungs of ladders) {
    const next: number[][] = [];
    for (const combo of combos) for (let r = 0; r < rungs.length; r += 1) next.push([...combo, r]);
    combos.splice(0, combos.length, ...next);
  }
  // Fewest steps down first; among equals, the biggest move is the first
  // suspect (Array.prototype.sort is stable: ties keep side order).
  const stepsDown = (combo: number[]) => combo.reduce((s, v) => s + v, 0);
  const dropped = (combo: number[]) =>
    combo.reduce((s, r, k) => s + (r > 0 ? Math.abs(ladders[k][0].report.shiftFrac) : 0), 0);
  combos.sort((p, q) => stepsDown(p) - stepsDown(q) || dropped(q) - dropped(p));
  const walks = new Map<string, { walk: Walk; length: number } | null>();
  const measure = (rungs: Rung[], points: Vec[]) => provenance(planes, states, rungs, points, diag, clock, walks);
  for (const combo of combos) {
    const rungs = combo.map((r, k) => ladders[k][r]);
    if (!rungs.some((rung) => rung.report.accepted)) break;
    const points = corneredBy(
      rungs.map((rung) => rung.line),
      rungs.some((rung) => rung.report.mode === "occluded") ? MIN_AREA_RATIO_OCCLUDED : MIN_AREA_RATIO,
    );
    if (points === null) continue;
    const sides = rungs.map((rung) => rung.report);
    const { corners: reports, occlusion } = measure(rungs, points);
    // Well inside the prior on the strength of visible runs alone: only when
    // every corner they place is trusted. (Two sheets side by side would
    // otherwise give the strip where they overlap.)
    if (Math.abs(polygonArea(points)) <= MIN_AREA_RATIO * Math.abs(priorArea) && reports.some((r) => r.provenance === "unknown")) continue;
    // A side fitted on a visible run is believed only for the corner it was
    // fitted to infer: one of its two corners must show something over it.
    if (
      rungs.some(
        (rung, k) =>
          (rung.report.reason === "occluded" || rung.report.reason === "occluder-edge") &&
          reports[k].provenance === "seen" &&
          reports[(k + 1) % 4].provenance === "seen",
      )
    ) {
      continue;
    }
    // Every corner found where it already was: the prior confirmed, not changed.
    if (points.every((p, k) => Math.hypot(p[0] - corners[k][0], p[1] - corners[k][1]) < MOVED_PX)) {
      return unchanged(quad, started, now, "no-change", sides, reports, occlusion, true);
    }
    const refined = {} as NormalizedQuad;
    KEYS.forEach((key, k) => {
      // Within the slack, onto the image; an input already off it keeps its reach.
      const { x, y } = quad[key];
      refined[key] = {
        x: Math.min(Math.max(1, x), Math.max(Math.min(0, x), points[k][0] / width)),
        y: Math.min(Math.max(1, y), Math.max(Math.min(0, y), points[k][1] / height)),
      };
    });
    return { quad: refined, changed: true, sides, corners: reports, occlusion, measured: true, ms: now() - started, reason: "refined" };
  }
  const moved = wideReports.some((side) => side.accepted);
  return unchanged(quad, started, now, moved ? "insane" : "no-change", wideReports);
}

// ── the canvas wrapper ───────────────────────────────────────────────────────

/**
 * Long edge of the image refinement reads. The bench measured 1000, 1200 and
 * 1600 px as equally accurate on its synthetic families; 1200 reads a little
 * over half of 1600's pixels.
 */
export const REFINE_LONG_EDGE = 1200;

/**
 * How long a capture may spend refining, the downscale included. Measured on
 * 3000 px captures: p95 31 ms on this bench's desktop, 112 ms (max 124) under a
 * 4× CPU throttle, a mid-range phone; on 1080 × 1920 frames at 4×, max 199 ms
 * — a 150 ms bound threw away ~4 % of the refinements there, which is why it is
 * not tighter. Past it, the detector's corners go through unrefined.
 */
export const REFINE_BUDGET_MS = 250;

/**
 * {@link refineQuad} on a canvas the caller holds (the captured frame, the
 * decoded canonical): drawn once into a working canvas at
 * {@link REFINE_LONG_EDGE}, read back, refined. The working canvas is released
 * as soon as it is read and nothing is kept between calls — no copy of a page
 * outlives its refinement. Never throws; a canvas that cannot be read answers
 * the input unchanged.
 */
export function refineOnCanvas(
  source: HTMLCanvasElement,
  quad: NormalizedQuad,
  options: RefineOptions = {},
): RefineResult {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const budget = options.budgetMs ?? REFINE_BUDGET_MS;
  let work: HTMLCanvasElement | null = null;
  try {
    const scale = Math.min(1, REFINE_LONG_EDGE / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    work = document.createElement("canvas");
    work.width = width;
    work.height = height;
    const context = work.getContext("2d", { willReadFrequently: true });
    if (context === null) return unchanged(quad, started, now, "no-context");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    releaseSurface(work);
    work = null;
    const remaining = budget - (now() - started);
    if (!(remaining > 0)) return unchanged(quad, started, now, "budget");
    const result = refineQuad(image, quad, { ...options, now, budgetMs: remaining });
    return { ...result, ms: now() - started };
  } catch {
    return unchanged(quad, started, now, "error");
  } finally {
    releaseSurface(work);
  }
}
