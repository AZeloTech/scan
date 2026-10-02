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
    occludedCornerErrorP95: percentile(withCovered.map((r) => r.occlusion.occludedCornerError), 95),
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

/** The Markdown section the detector report gets when any row was scored for occlusion ("" otherwise). */
export function renderOcclusionSection(rows) {
  const summary = summarizeOcclusion(rows);
  if (Object.keys(summary).length === 0) return "";
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
    out.push("| variant | scenes | covered | miss | wrong | severe | content clipped | occl. err p50 / p95 | visible err p50 | incl. | modes T/tip/cross/on/in/else/lost | accepted by | refine moved |");
    out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|");
    for (const [variant, s] of Object.entries(byVariant)) {
      const m = s.modes;
      const sources = Object.entries(s.sources).map(([k, v]) => `${k} ${v}`).join(", ") || "–";
      out.push(
        `| ${variant} | ${s.scenes} | ${s.covered} | ${pct(s.missRate)} | ${pct(s.wrongRate)} | ${pct(s.severeRate)} | ${pct(s.contentClippedRate)} | ` +
          `${diag(s.occludedCornerErrorP50)} / ${diag(s.occludedCornerErrorP95)} | ${diag(s.visibleCornerErrorP50)} | ${pct(s.occluderIncludedRate)} | ` +
          `${m["true-corner"]}/${m["occluder-tip"]}/${m["edge-crossing"]}/${m["on-occluder"]}/${m["inside-page"]}/${m.elsewhere}/${m.lost} | ${sources} | ${s.refineChanged} |`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}
