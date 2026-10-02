/**
 * Occlusion metrics for the detector suite (5d+): what a quad did with a
 * page corner that something lies over.
 *
 * Scored wherever the truth lists an occluder (`gt.occluders`, a layer laid
 * over the page on purpose — F8's sheet, clip, staple, second page) or a
 * corner of the page in frame that is covered (`gt.pages[i].occluded`):
 *
 *  - **occluded-corner error** — the distance from the quad's corner matched
 *    to a covered corner to the true one (the corner's own position, hidden
 *    as it is), as a fraction of the frame diagonal; the worst covered
 *    corner when there are two. `null` when no corner is covered.
 *  - **occluder included** — the quad reaches onto an occluder past the
 *    page: the area of `quad ∩ occluder` outside the true page, over the
 *    page's area (both clipped to the frame), above
 *    {@link OCCLUDER_INCLUDED_MIN_FRACTION}. The union of page and sheet,
 *    a corner dragged out along the sheet's edge.
 *  - **mode** — where the quad put the covered corner: `true-corner`
 *    (within {@link NEAR_FEATURE} of the truth), `occluder-tip` (on a corner
 *    of the occluder that lies on the page — the sheet's own corner taken
 *    for the page's), `edge-crossing` (where the occluder's edge crosses a
 *    page edge — the corner cut off), `on-occluder` (out past the page on
 *    the occluder), `inside-page`, `elsewhere`; a quad gated out is `lost`.
 *
 * Pure maths over normalized quads and the truth, so it runs in Node.
 */

import {
  clipPolygon,
  cornerErrors,
  frameDiagonal,
  isDegenerateQuad,
  matchCorners,
  percentile,
  polygonArea,
  rate,
  signedArea,
  toPixels,
} from "../metrics.mjs";

/** Quad area on an occluder outside the page, over the page's area, above which the occluder counts as included. */
export const OCCLUDER_INCLUDED_MIN_FRACTION = 0.005;

/** How near (fraction of the diagonal) a corner must be to a feature to be said to sit on it. */
export const NEAR_FEATURE = 0.015;

/** The target for the occluded corner (5d+): its error p50 at most this (fraction of the diagonal). */
export const OCCLUDED_CORNER_TARGET_P50 = 0.015;

/** The owner's gate (2026-10-02): a covered corner more than this far off (fraction of the diagonal) in at most 10 % of covered corners. */
export const OCCLUDED_CORNER_GATE = 0.03;

function framePolygon(frame) {
  return [
    [0, 0],
    [frame.width, 0],
    [frame.width, frame.height],
    [0, frame.height],
  ];
}

function isConvex(points) {
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    const [cx, cy] = points[(i + 2) % points.length];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}

/** Ray casting: whether `p` lies inside the polygon. */
export function insidePolygon([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentIntersection(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

/** Where an occluder's outline crosses the page's edges (pixels). */
function crossings(occluder, page) {
  const out = [];
  for (let i = 0; i < occluder.length; i += 1) {
    for (let k = 0; k < page.length; k += 1) {
      const p = segmentIntersection(occluder[i], occluder[(i + 1) % occluder.length], page[k], page[(k + 1) % page.length]);
      if (p !== null) out.push(p);
    }
  }
  return out;
}

const nearest = (p, points) => (points.length === 0 ? Infinity : Math.min(...points.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))));

/**
 * The occlusion score of one answer (`quad`, normalized, or null when the
 * variant gated it out) against a scene's truth — or `null` for a scene with
 * no page, or with nothing over it.
 */
export function scoreOcclusion(quad, gt) {
  if (gt.quad === null || gt.primary === null) return null;
  const occluders = gt.occluders ?? [];
  const primary = gt.pages[gt.primary];
  const occluded = primary.occluded ?? [];
  if (occluders.length === 0 && occluded.length === 0) return null;
  const base = { occludedCorners: occluded, occluderKinds: occluders.map((o) => o.kind) };
  if (quad === null) return { ...base, detected: false, mode: "lost", occludedCornerError: null, occluderIncluded: null };
  const { frame } = gt;
  const diagonal = frameDiagonal(frame);
  const box = framePolygon(frame);
  const det = toPixels(quad, frame);
  const truth = toPixels(gt.quad, frame);
  const errors = cornerErrors(quad, gt.quad, frame);
  const { matched } = matchCorners(det, truth);
  const occludedCornerError = occluded.length === 0 ? null : Math.max(...occluded.map((i) => errors[i]));
  const visible = [0, 1, 2, 3].filter((i) => primary.inFrame[i] && !occluded.includes(i));
  const visibleCornerError = visible.length === 0 ? null : Math.max(...visible.map((i) => errors[i]));

  // Area on the occluders outside the page.
  const pageIn = clipPolygon(truth, box);
  const pageArea = pageIn.length < 3 ? 0 : polygonArea(pageIn);
  let excess = null;
  if (!isDegenerateQuad(det) && isConvex(det) && pageArea > 0) {
    const detIn = clipPolygon(det, box);
    excess = 0;
    if (detIn.length >= 3) {
      for (const occluder of occluders) {
        const poly = toPixels(occluder.polygon, frame);
        const onQuad = clipPolygon(poly, detIn);
        if (onQuad.length < 3) continue;
        const onPage = clipPolygon(onQuad, truth);
        excess += polygonArea(onQuad) - (onPage.length < 3 ? 0 : polygonArea(onPage));
      }
    }
  }
  const occluderIncludedFraction = excess === null ? null : Math.max(0, excess) / pageArea;
  const occluderIncluded = occluderIncludedFraction === null ? null : occluderIncludedFraction > OCCLUDER_INCLUDED_MIN_FRACTION;

  // Where the worst covered corner went.
  let mode = null;
  let worst = null;
  if (occluded.length > 0) {
    worst = occluded.reduce((a, b) => (errors[b] > errors[a] ? b : a));
    const p = matched[worst];
    const polys = occluders.map((o) => toPixels(o.polygon, frame));
    const tips = polys.flatMap((poly) => poly.filter((v) => insidePolygon(v, truth)));
    const cross = polys.flatMap((poly) => crossings(poly, truth));
    if (errors[worst] <= NEAR_FEATURE) mode = "true-corner";
    else if (nearest(p, tips) / diagonal <= NEAR_FEATURE) mode = "occluder-tip";
    else if (nearest(p, cross) / diagonal <= NEAR_FEATURE) mode = "edge-crossing";
    else if (!insidePolygon(p, truth) && polys.some((poly) => insidePolygon(p, poly))) mode = "on-occluder";
    else if (insidePolygon(p, truth)) mode = "inside-page";
    else mode = "elsewhere";
  }
  return {
    ...base,
    detected: true,
    worstOccluded: worst,
    mode,
    occludedCornerError,
    visibleCornerError,
    occluderIncludedFraction,
    occluderIncluded,
    winding: Math.sign(signedArea(det)),
  };
}

/**
 * A covered corner is judged by the provenance flags only when what covers
 * it hides at least this much (fraction of the frame diagonal) of one of its
 * two edges, from the corner. The product calls a corner whose edges are
 * seen to within max(14 px, 1 % of the diagonal) of it `seen`
 * (`REACH_DIAG` in `lib/refine.ts`) — 1 % on a 1200 px capture, nearly 2 %
 * on the live loop's 640 px sample — and a corner hidden for less than 2 %
 * is within the 3 % "wrong" bound even when placed on what covers it. So a
 * clip's jaw over a corner's very tip is neither a miss nor a hit.
 */
export const SHALLOW_COVER = 0.02;

/**
 * How far from corner `i` of the primary page each of its two edges is
 * hidden under the occluders (px, the larger of the two) — `null` when the
 * truth has no occluder outline (an effect's cover, F5's finger): judged as
 * covered, deeply.
 */
export function hiddenReach(gt, i) {
  const occluders = (gt.occluders ?? []).map((o) => toPixels(o.polygon, gt.frame));
  if (occluders.length === 0) return null;
  const page = toPixels(gt.pages[gt.primary].corners, gt.frame);
  const p = page[i];
  let worst = 0;
  for (const q of [page[(i + 3) % 4], page[(i + 1) % 4]]) {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const dir = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
    let t = 0;
    while (t < 0.5 * length && occluders.some((poly) => insidePolygon([p[0] + dir[0] * t, p[1] + dir[1] * t], poly))) t += 0.5;
    worst = Math.max(worst, t);
  }
  return worst;
}

/**
 * The answer's corner provenance (`lib/refine.ts`: each corner `seen`,
 * `inferred` or `unknown`, in the answer's own corner order) against the
 * truth: per true corner in frame, whether it is covered (`gt.pages[i].occluded`)
 * and whether the answer flagged it (inferred or unknown). `refused`: the
 * answer would hold auto-capture (a flagged corner, or `separate`).
 * `null` without a page, an answer or provenance.
 */
export function scoreProvenance(quad, gt, provenance, separate = false) {
  if (quad === null || provenance === null || provenance === undefined || gt.quad === null || gt.primary === null) return null;
  const primary = gt.pages[gt.primary];
  const det = toPixels(quad, gt.frame);
  const truth = toPixels(gt.quad, gt.frame);
  const { shift, reversed } = matchCorners(det, truth);
  const covered = primary.occluded ?? [];
  const diagonal = frameDiagonal(gt.frame);
  const corners = [0, 1, 2, 3].map((i) => {
    const j = reversed ? 3 - ((i + shift) % 4) : (i + shift) % 4;
    const reach = covered.includes(i) ? hiddenReach(gt, i) : null;
    // Covered only at its very tip: not judged (see SHALLOW_COVER).
    const shallow = reach !== null && reach < SHALLOW_COVER * diagonal;
    return { inFrame: primary.inFrame[i], covered: covered.includes(i), shallow, flagged: provenance[j] !== "seen", provenance: provenance[j] };
  });
  return { corners, refused: separate === true || provenance.some((p) => p !== "seen"), separate: separate === true };
}

/** Precision / recall of the provenance flags over rows carrying `provenance` (in-frame corners only). */
export function summarizeProvenance(rows) {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let seen = 0;
  let inferred = 0;
  let unknown = 0;
  let refused = 0;
  let separate = 0;
  let scored = 0;
  let shallow = 0;
  let shallowFlagged = 0;
  for (const r of rows) {
    if (r.provenance == null) continue;
    scored += 1;
    if (r.provenance.refused) refused += 1;
    if (r.provenance.separate) separate += 1;
    for (const c of r.provenance.corners) {
      if (!c.inFrame) continue;
      if (c.provenance === "inferred") inferred += 1;
      if (c.provenance === "unknown") unknown += 1;
      if (c.shallow) {
        shallow += 1;
        if (c.flagged) shallowFlagged += 1;
      } else if (c.covered) c.flagged ? (tp += 1) : (fn += 1);
      else {
        seen += 1;
        if (c.flagged) fp += 1;
      }
    }
  }
  return {
    scenes: scored,
    covered: tp + fn,
    shallow,
    shallowFlagged,
    recall: tp + fn === 0 ? null : tp / (tp + fn),
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    falseFlags: fp,
    seenCorners: seen,
    falseFlagRate: seen === 0 ? null : fp / seen,
    inferred,
    unknown,
    refusedRate: scored === 0 ? null : refused / scored,
    separateRate: scored === 0 ? null : separate / scored,
  };
}

const MODES = ["true-corner", "occluder-tip", "edge-crossing", "on-occluder", "inside-page", "elsewhere", "lost"];

/** One variant over a group of rows carrying `occlusion`: the numbers the occlusion table prints. */
export function summarizeOcclusionGroup(rows) {
  const scored = rows.filter((r) => r.occlusion != null);
  const accepted = scored.filter((r) => r.score.detected);
  const withCovered = accepted.filter((r) => r.occlusion.occludedCornerError !== null);
  const judgedInclusion = accepted.filter((r) => r.occlusion.occluderIncluded !== null);
  const modes = Object.fromEntries(MODES.map((m) => [m, 0]));
  for (const r of scored) {
    if (!r.score.detected) modes.lost += 1;
    else if (r.occlusion.mode !== null) modes[r.occlusion.mode] += 1;
  }
  const sources = {};
  for (const r of accepted) if (r.det.source != null) sources[r.det.source] = (sources[r.det.source] ?? 0) + 1;
  const contentJudged = accepted.filter((r) => r.score.contentClipped === true || r.score.contentClipped === false);
  return {
    scenes: scored.length,
    covered: scored.filter((r) => r.occlusion.occludedCorners.length > 0).length,
    accepted: accepted.length,
    missRate: rate(scored.length - accepted.length, scored.length),
    wrongRate: rate(accepted.filter((r) => r.score.wrongCrop).length, scored.length),
    severeRate: rate(accepted.filter((r) => r.score.severe === true).length, scored.length),
    contentClippedRate: contentJudged.length === 0 ? null : rate(contentJudged.filter((r) => r.score.contentClipped).length, contentJudged.length),
    occludedCornerErrorP50: percentile(withCovered.map((r) => r.occlusion.occludedCornerError), 50),
    occludedCornerErrorP90: percentile(withCovered.map((r) => r.occlusion.occludedCornerError), 90),
    occludedCornerErrorP95: percentile(withCovered.map((r) => r.occlusion.occludedCornerError), 95),
    // The owner's gate (2026-10-02): covered corners more than 3 % of the diagonal off, over all covered scenes (a lost page counts as off).
    occludedOver3Rate:
      scored.filter((r) => r.occlusion.occludedCorners.length > 0).length === 0
        ? null
        : rate(
            scored.filter((r) => r.occlusion.occludedCorners.length > 0 && (!r.score.detected || r.occlusion.occludedCornerError > OCCLUDED_CORNER_GATE)).length,
            scored.filter((r) => r.occlusion.occludedCorners.length > 0).length,
          ),
    visibleCornerErrorP50: percentile(accepted.map((r) => r.occlusion.visibleCornerError).filter((v) => v !== null), 50),
    occluderIncludedRate: judgedInclusion.length === 0 ? null : rate(judgedInclusion.filter((r) => r.occlusion.occluderIncluded).length, judgedInclusion.length),
    modes,
    sources,
    refineChanged: accepted.filter((r) => r.det.refine?.changed).length,
  };
}

/** `{ "<family>/<setting>": { [variant]: summary } }` (and `<family>` for the whole family) over rows that carry `occlusion`. */
export function summarizeOcclusion(rows) {
  const scored = rows.filter((r) => r.occlusion != null);
  const out = {};
  const keyed = (key, member) => {
    const group = {};
    for (const variant of [...new Set(scored.map((r) => r.variant))]) {
      const these = scored.filter((r) => member(r) && r.variant === variant);
      if (these.length > 0) group[variant] = summarizeOcclusionGroup(these);
    }
    if (Object.keys(group).length > 0) out[key] = group;
  };
  for (const family of [...new Set(scored.map((r) => r.family))]) {
    keyed(family, (r) => r.family === family);
    for (const setting of [...new Set(scored.filter((r) => r.family === family && r.setting != null).map((r) => r.setting))]) {
      keyed(`${family}/${setting}`, (r) => r.family === family && r.setting === setting);
    }
  }
  return out;
}

const pct = (v) => (v === null || v === undefined ? "–" : `${(v * 100).toFixed(1)} %`);
const diag = (v) => (v === null || v === undefined ? "–" : (v * 100).toFixed(2));

/** `{ key: { variant: summary } }` of {@link summarizeProvenance} per family, per F8 setting, and over F1–F7 together. */
export function provenanceByGroup(rows) {
  const scored = rows.filter((r) => r.provenance != null);
  const out = {};
  const keyed = (key, member) => {
    const group = {};
    for (const variant of [...new Set(scored.map((r) => r.variant))]) {
      const these = scored.filter((r) => member(r) && r.variant === variant);
      if (these.length > 0) group[variant] = summarizeProvenance(these);
    }
    if (Object.keys(group).length > 0) out[key] = group;
  };
  const families = [...new Set(scored.map((r) => r.family))];
  if (families.some((f) => f !== "F8")) keyed("F1–F7", (r) => r.family !== "F8");
  for (const family of families) {
    keyed(family, (r) => r.family === family);
    if (family !== "F8") continue;
    for (const setting of [...new Set(scored.filter((r) => r.family === family && r.setting != null).map((r) => r.setting))]) {
      keyed(`${family}/${setting}`, (r) => r.family === family && r.setting === setting);
    }
  }
  return out;
}

/** The Markdown section on corner provenance ("" when no row carries it). */
export function renderProvenanceSection(rows) {
  const groups = provenanceByGroup(rows);
  if (Object.keys(groups).length === 0) return "";
  const out = [
    "",
    "## Corner provenance (5d+ phase B)",
    "",
    "Per true corner in frame: **flagged** = the answer called it `inferred` or `unknown`. **recall** = covered corners flagged; " +
      "**precision** = flagged corners that are covered; **false** = seen corners flagged (count / rate); **refused** = scenes where " +
      `auto-capture would hold (a flagged corner, or another sheet overlapping: \`separate\`). **tip only** = covered corners whose edges are hidden for less than ${(SHALLOW_COVER * 100).toFixed(0)} % of the diagonal from the corner (a clip's jaw on the very tip), judged neither way (flagged of them).`,
    "",
    "| group | variant | scenes | covered | recall | precision | false | tip only (flagged) | inferred / unknown | refused | separate |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [key, byVariant] of Object.entries(groups)) {
    for (const [variant, s] of Object.entries(byVariant)) {
      out.push(
        `| ${key} | ${variant} | ${s.scenes} | ${s.covered} | ${pct(s.recall)} | ${pct(s.precision)} | ${s.falseFlags} / ${s.seenCorners} (${pct(s.falseFlagRate)}) | ` +
          `${s.shallow} (${s.shallowFlagged}) | ${s.inferred} / ${s.unknown} | ${pct(s.refusedRate)} | ${pct(s.separateRate)} |`,
      );
    }
  }
  out.push("");
  return out.join("\n");
}

/** The Markdown section the detector report gets when any row was scored for occlusion ("" otherwise). */
export function renderOcclusionSection(rows) {
  const summary = summarizeOcclusion(rows);
  if (Object.keys(summary).length === 0) return renderProvenanceSection(rows);
  const out = [
    "",
    "## Occluded corners (5d+)",
    "",
    `Scenes with an occluder over the page or a covered corner. **occl. err** = the covered corner's error (% of the diagonal; target p50 ≤ ${(OCCLUDED_CORNER_TARGET_P50 * 100).toFixed(1)}); ` +
      `**incl.** = the quad reaches onto an occluder past the page (> ${(OCCLUDER_INCLUDED_MIN_FRACTION * 100).toFixed(1)} % of the page's area); ` +
      "**modes** = where the covered corner went (true corner / the occluder's tip on the page / where its edge crosses the page's / out on the occluder / inside the page / elsewhere / lost).",
    "",
  ];
  for (const [key, byVariant] of Object.entries(summary)) {
    out.push(`### ${key}`, "");
    out.push("| variant | scenes | covered | miss | wrong | severe | content clipped | occl. err p50 / p90 / p95 | occl. > 3 % | visible err p50 | incl. | modes T/tip/cross/on/in/else/lost | accepted by | refine moved |");
    out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|");
    for (const [variant, s] of Object.entries(byVariant)) {
      const m = s.modes;
      const sources = Object.entries(s.sources).map(([k, v]) => `${k} ${v}`).join(", ") || "–";
      out.push(
        `| ${variant} | ${s.scenes} | ${s.covered} | ${pct(s.missRate)} | ${pct(s.wrongRate)} | ${pct(s.severeRate)} | ${pct(s.contentClippedRate)} | ` +
          `${diag(s.occludedCornerErrorP50)} / ${diag(s.occludedCornerErrorP90)} / ${diag(s.occludedCornerErrorP95)} | ${pct(s.occludedOver3Rate)} | ${diag(s.visibleCornerErrorP50)} | ${pct(s.occluderIncludedRate)} | ` +
          `${m["true-corner"]}/${m["occluder-tip"]}/${m["edge-crossing"]}/${m["on-occluder"]}/${m["inside-page"]}/${m.elsewhere}/${m.lost} | ${sources} | ${s.refineChanged} |`,
      );
    }
    out.push("");
  }
  return out.join("\n") + renderProvenanceSection(rows);
}
