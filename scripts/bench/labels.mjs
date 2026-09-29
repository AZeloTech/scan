/**
 * Hand labels for real media: the schema, its check, and the conventions every
 * reader of the file shares.
 *
 * ```
 * { version: 1,
 *   items: { [id]: { corners: [[x, y] × 4],   // normalized, TL, TR, BR, BL
 *                    uncertain: [bool × 4],   // per corner, same order
 *                    noDocument?: true,       // nothing to crop in this image
 *                    labeller: string, t: ISO time,
 *                    from?: "blank" | "ml" } } }  // how the labeller started
 * ```
 *
 * **Ids** name an image the bench can find again: a still by its path inside
 * `SCAN_REAL_MEDIA` (`capture-issue/<name>.jpg`), a video frame by its clip's
 * path and the frame's time at the replay rate (`pii_free/<name>.mp4@533ms`).
 *
 * **Corners** are fractions of the image **as the app sees it** — EXIF
 * orientation applied (`createImageBitmap(…, { imageOrientation: "from-image" })`)
 * — so they survive any downscale. They may lie a little outside the image, for
 * a page the frame cut off. `corners` of a `noDocument` item are ignored.
 *
 * Pure, no DOM, no I/O: the labelling page imports it too. Unit-tested in
 * `labels.test.mjs`.
 */

/** The labels file's schema version. */
export const LABELS_VERSION = 1;

/** How far outside the image a corner may be placed, as a fraction of it. */
export const CORNER_SLACK = 0.5;

export function emptyLabels() {
  return { version: LABELS_VERSION, items: {} };
}

function isCorner(c) {
  return (
    Array.isArray(c) &&
    c.length === 2 &&
    c.every((v) => Number.isFinite(v) && v >= -CORNER_SLACK && v <= 1 + CORNER_SLACK)
  );
}

/** Structural check of a labels document; answers the first problem, or null. */
export function validateLabels(doc) {
  if (typeof doc !== "object" || doc === null) return "not an object";
  if (doc.version !== LABELS_VERSION) return `version must be ${LABELS_VERSION}`;
  if (typeof doc.items !== "object" || doc.items === null || Array.isArray(doc.items)) return "items must be an object";
  for (const [id, item] of Object.entries(doc.items)) {
    if (typeof item !== "object" || item === null) return `item ${id}: not an object`;
    if (item.noDocument !== undefined && typeof item.noDocument !== "boolean") return `item ${id}: noDocument must be a boolean`;
    if (item.noDocument === true) continue;
    if (!(Array.isArray(item.corners) && item.corners.length === 4 && item.corners.every(isCorner))) {
      return `item ${id}: corners must be four [x, y] pairs, normalized`;
    }
    if (
      item.uncertain !== undefined &&
      !(Array.isArray(item.uncertain) && item.uncertain.length === 4 && item.uncertain.every((u) => typeof u === "boolean"))
    ) {
      return `item ${id}: uncertain must be four booleans`;
    }
  }
  return null;
}

/**
 * Four points in any order → TL, TR, BR, BL, with `carry` (per-point values,
 * e.g. the uncertain flags) reordered alongside.
 *
 * Ordered clockwise on screen around their centroid, starting from the point
 * nearest the image's top-left along the TL–BR diagonal — a stable answer for
 * any page rotated less than 45°, and a consistent one beyond (the metrics
 * match corners cyclically anyway).
 */
export function orderCorners(points, carry = null) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const indexed = points.map((p, i) => ({ p, i, angle: Math.atan2(p[1] - cy, p[0] - cx) }));
  // Clockwise on screen (y down) is increasing atan2.
  indexed.sort((a, b) => a.angle - b.angle);
  let start = 0;
  for (let k = 1; k < indexed.length; k += 1) {
    const [x, y] = indexed[k].p;
    const [bx, by] = indexed[start].p;
    if (x + y < bx + by) start = k;
  }
  const ordered = [0, 1, 2, 3].map((k) => indexed[(start + k) % indexed.length]);
  return {
    corners: ordered.map((e) => [e.p[0], e.p[1]]),
    carry: carry === null ? null : ordered.map((e) => carry[e.i]),
  };
}

/** A still's id: its path inside `SCAN_REAL_MEDIA`, forward slashes. */
export function stillId(relativePath) {
  return relativePath.split("\\").join("/");
}

/** A video frame's id: the clip's path and the frame's time at the replay rate. */
export function frameId(clipPath, index, fps) {
  return `${stillId(clipPath)}@${Math.round((index * 1000) / fps)}ms`;
}

/**
 * The label for one image, reduced to what scoring needs: `null` when the
 * image has none; `{ noDocument: true }`; or `{ quad, uncertain }`.
 */
export function labelFor(doc, id) {
  const item = doc?.items?.[id];
  if (item === undefined || item === null) return null;
  if (item.noDocument === true) return { noDocument: true, quad: null, uncertain: [false, false, false, false] };
  return {
    noDocument: false,
    quad: item.corners,
    uncertain: item.uncertain ?? [false, false, false, false],
  };
}

/**
 * A save from the labelling page folded into the file on disk, item by item:
 * an item only one side has is kept, and where both have one the newer `t`
 * wins (the incoming one on a tie, or when neither is dated). A page posts
 * everything it loaded at start-up plus its edits, so an item another tab
 * re-labelled since then is newer on disk and survives. Nothing is ever
 * removed. Answers `{ merged, keptNewer }` — the ids where the file's label
 * beat the incoming one.
 */
export function mergeLabels(current, incoming) {
  const items = { ...(current?.items ?? {}) };
  const keptNewer = [];
  for (const [id, item] of Object.entries(incoming.items)) {
    const existing = items[id];
    if (existing !== undefined && String(existing.t ?? "") > String(item.t ?? "")) {
      if (JSON.stringify(existing) !== JSON.stringify(item)) keptNewer.push(id);
      continue;
    }
    items[id] = item;
  }
  return { merged: { ...current, ...incoming, version: LABELS_VERSION, items }, keptNewer };
}

/** How many items carry a label, and of what kind. */
export function labelCounts(doc) {
  const items = Object.values(doc?.items ?? {});
  return {
    total: items.length,
    noDocument: items.filter((i) => i.noDocument === true).length,
    withUncertain: items.filter((i) => i.noDocument !== true && (i.uncertain ?? []).some(Boolean)).length,
  };
}
