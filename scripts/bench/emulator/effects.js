/**
 * Post-render effects: things that sit between the lens and the desk, drawn
 * over the rendered frame in pixel space.
 *
 * **The finger.** People hold a page flat with a thumb, and it is the most
 * common occluder a scanner meets — landing exactly where it hurts, over a
 * corner or an edge. Drawn as a thumb (a skin-tone capsule shaded across its
 * width, a nail at the tip, knuckle creases) running out from the page to the
 * hand behind it (wider, softer), with a soft shadow on the page — and a
 * little out of focus, being centimetres above the page the lens is focused
 * on.
 *
 * `hides` is pure maths (a capsule test), so the ground truth's per-corner
 * `visible` flags are computed from it in Node exactly as in the page.
 *
 * **A page that is not all there** (F7): a `patch` replaces a polygon of the
 * frame with the frame a little way off — a corner torn away, a receipt's
 * ragged end, showing the desk cloned from just beyond it — and hides the
 * corners inside it; a `flap` is a dog-ear, the corner folded over onto the
 * page.
 *
 * **The phone's own processing** (F7): `sharpen` is the unsharp mask an ISP
 * runs before encoding — a bright and a dark halo either side of every edge —
 * and `exposure` a gain that clips the highlights: paper and a white table
 * both at 255, the edge between them gone.
 */

import { mulberry32 } from "./prng.js";
import { registerEffect } from "./scene.js";

function distanceToSegment(u, v, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(u - (ax + t * dx), v - (ay + t * dy));
}

function scale(hex, factor) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${rgb.map((c) => Math.round(Math.min(255, c * factor))).join(",")})`;
}

function capsule(ctx, from, to) {
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.lineTo(to[0], to[1]);
}

/** A capsule filled with a cylinder's shading across its width. */
function shadedCapsule(ctx, from, to, width, skin, dark) {
  const axis = [to[0] - from[0], to[1] - from[1]];
  const length = Math.hypot(axis[0], axis[1]) || 1;
  const across = [-axis[1] / length, axis[0] / length];
  const half = width / 2;
  const gradient = ctx.createLinearGradient(
    to[0] - across[0] * half, to[1] - across[1] * half,
    to[0] + across[0] * half, to[1] + across[1] * half,
  );
  gradient.addColorStop(0, scale(skin, 0.55 * dark));
  gradient.addColorStop(0.22, scale(skin, 0.88 * dark));
  gradient.addColorStop(0.45, scale(skin, 1.08 * dark));
  gradient.addColorStop(0.75, scale(skin, 0.9 * dark));
  gradient.addColorStop(1, scale(skin, 0.5 * dark));
  ctx.strokeStyle = gradient;
  ctx.lineWidth = width;
  capsule(ctx, from, to);
  ctx.stroke();
}

registerEffect("finger", {
  /**
   * `{ tip, base, width, hand: { to, width }, skin, blur, shadow: { dx, dy, blur, alpha } }`,
   * pixels of the frame: the thumb runs from its tip to its base knuckle,
   * the hand from there out of (or across) the frame, wider and softer.
   */
  apply(ctx, step) {
    const { base, tip, width, skin, hand } = step;
    const axis = [tip[0] - base[0], tip[1] - base[1]];
    const length = Math.hypot(axis[0], axis[1]) || 1;
    const unit = [axis[0] / length, axis[1] / length];
    const across = [-unit[1], unit[0]];
    ctx.save();
    ctx.lineCap = "round";

    const shadow = step.shadow;
    if (shadow !== undefined) {
      ctx.filter = `blur(${shadow.blur}px)`;
      ctx.globalAlpha = shadow.alpha;
      ctx.strokeStyle = "#000000";
      const offset = (p) => [p[0] + shadow.dx, p[1] + shadow.dy];
      ctx.lineWidth = width * 1.05;
      capsule(ctx, offset(base), offset(tip));
      ctx.stroke();
      if (hand !== undefined) {
        ctx.lineWidth = hand.width;
        capsule(ctx, offset(hand.to), offset(base));
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
    if (hand !== undefined) {
      // The hand is higher off the page than the thumb: softer, a little darker.
      ctx.filter = `blur(${step.blur * 1.8}px)`;
      shadedCapsule(ctx, hand.to, base, hand.width, skin, 0.92);
    }
    ctx.filter = `blur(${step.blur}px)`;
    shadedCapsule(ctx, base, tip, width, skin, 1);

    // Knuckle creases: faint darker arcs across the thumb.
    const half = width / 2;
    ctx.strokeStyle = scale(skin, 0.7);
    ctx.lineWidth = Math.max(1, width * 0.035);
    for (const back of [1.15, 1.35]) {
      const at = [tip[0] - unit[0] * width * back, tip[1] - unit[1] * width * back];
      ctx.beginPath();
      ctx.moveTo(at[0] - across[0] * half * 0.6, at[1] - across[1] * half * 0.6);
      ctx.quadraticCurveTo(
        at[0] + unit[0] * width * 0.08, at[1] + unit[1] * width * 0.08,
        at[0] + across[0] * half * 0.6, at[1] + across[1] * half * 0.6,
      );
      ctx.stroke();
    }

    if (step.nail !== false) {
      // The nail: a rounded plate just behind the tip, pinker, with a pale free edge.
      const centre = [tip[0] - unit[0] * width * 0.32, tip[1] - unit[1] * width * 0.32];
      ctx.save();
      ctx.translate(centre[0], centre[1]);
      ctx.rotate(Math.atan2(unit[1], unit[0]));
      ctx.fillStyle = scale(skin, 1.12);
      ctx.beginPath();
      ctx.ellipse(0, 0, width * 0.3, width * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,245,238,0.75)";
      ctx.beginPath();
      ctx.ellipse(width * 0.2, 0, width * 0.08, width * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  },
  hides(step) {
    return (u, v) =>
      distanceToSegment(u, v, step.base, step.tip) <= step.width / 2 ||
      (step.hand !== undefined && distanceToSegment(u, v, step.hand.to, step.base) <= step.hand.width / 2);
  },
});

/** Skin tones the finger is drawn in. */
export const SKIN_TONES = ["#e8b89a", "#d9a07e", "#c68e6e", "#a8704f", "#8a5a3c", "#6b4430", "#f0c8ad"];

/**
 * A thumb holding the page down at `target` (pixels) — a corner or a point
 * on an edge — coming in from outside the page, away from its centre
 * (`centre`, pixels), with the hand behind it. `pxPerMm` sets its size: a
 * thumb is ~16–20 mm across and ~65 mm to its base knuckle.
 */
export function fingerOver(rng, frame, target, pxPerMm, centre) {
  const out = [target[0] - centre[0], target[1] - centre[1]];
  const length = Math.hypot(out[0], out[1]) || 1;
  const turn = rng.range(-0.5, 0.5);
  const dir = [
    (Math.cos(turn) * out[0] - Math.sin(turn) * out[1]) / length,
    (Math.sin(turn) * out[0] + Math.cos(turn) * out[1]) / length,
  ];
  const w = rng.range(16, 20) * pxPerMm;
  // The tip rests just inside the page, over the point it holds.
  const tip = [target[0] - dir[0] * w * rng.range(0.15, 0.35), target[1] - dir[1] * w * rng.range(0.15, 0.35)];
  const reach = w * rng.range(3.2, 3.8);
  const base = [tip[0] + dir[0] * reach, tip[1] + dir[1] * reach];
  const bend = rng.range(-0.4, 0.4);
  const handDir = [Math.cos(bend) * dir[0] - Math.sin(bend) * dir[1], Math.sin(bend) * dir[0] + Math.cos(bend) * dir[1]];
  const handTo = [base[0] + handDir[0] * w * 9, base[1] + handDir[1] * w * 9];
  return {
    type: "finger",
    base,
    tip,
    width: w,
    hand: { to: handTo, width: w * rng.range(2.6, 3.2) },
    skin: rng.pick(SKIN_TONES),
    blur: rng.range(1.5, 3.5) * Math.max(1, pxPerMm / 4),
    shadow: {
      dx: rng.range(-0.4, 0.4) * w,
      dy: rng.range(0.1, 0.5) * w,
      blur: w * rng.range(0.25, 0.5),
      alpha: rng.range(0.25, 0.45),
    },
  };
}

/* ── a page that is not all there: torn, cut, dog-eared (F7) ───────────── */

/** Even–odd point-in-polygon, pixels. Pure maths: the truth's `visible` flags use it. */
export function insidePolygon(u, v, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [ui, vi] = polygon[i];
    const [uj, vj] = polygon[j];
    if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}

function tracePolygon(ctx, polygon, du = 0, dv = 0) {
  ctx.beginPath();
  polygon.forEach(([u, v], i) => (i === 0 ? ctx.moveTo(u + du, v + dv) : ctx.lineTo(u + du, v + dv)));
  ctx.closePath();
}

registerEffect("patch", {
  /**
   * `{ polygon: [[u, v], …], shift: [du, dv] }`, pixels: the frame inside the
   * polygon is replaced by the frame `shift` away — a corner torn off, a
   * ragged cut: what shows there is the desk, cloned from just beyond it, with
   * the renderer's own light, blur and noise.
   */
  apply(ctx, step) {
    const { canvas } = ctx;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext("2d").drawImage(canvas, 0, 0);
    ctx.save();
    tracePolygon(ctx, step.polygon);
    ctx.clip();
    ctx.drawImage(copy, -step.shift[0], -step.shift[1]);
    ctx.restore();
  },
  hides(step) {
    return (u, v) => insidePolygon(u, v, step.polygon);
  },
});

registerEffect("flap", {
  /**
   * `{ polygon: [A, B, F], sample: [u, v], shade: [atFold, atTip], shadow: { dx, dy, blur, alpha }, seed }`,
   * pixels: a dog-ear — the corner folded over onto the page along A–B, its
   * tip at F. The paper's back, read off the page next to it (the brightest
   * decile of a small window at `sample`, so ink does not count), shaded
   * darker at the fold, over its own soft shadow, with a little grain.
   */
  apply(ctx, step) {
    const [A, B, F] = step.polygon;
    const r = 7;
    const [su, sv] = step.sample.map(Math.round);
    const window = ctx.getImageData(su - r, sv - r, 2 * r + 1, 2 * r + 1).data;
    const pixels = [];
    for (let i = 0; i < window.length; i += 4) pixels.push([window[i], window[i + 1], window[i + 2]]);
    pixels.sort((p, q) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] - (0.299 * q[0] + 0.587 * q[1] + 0.114 * q[2]));
    const paper = pixels[Math.floor(pixels.length * 0.9)];
    const tone = (k) => `rgb(${paper.map((c) => Math.round(Math.min(255, c * k))).join(",")})`;

    ctx.save();
    const { dx, dy, blur, alpha } = step.shadow;
    ctx.filter = `blur(${blur}px)`;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#000000";
    tracePolygon(ctx, step.polygon, dx, dy);
    ctx.fill();
    ctx.restore();

    ctx.save();
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const gradient = ctx.createLinearGradient(mid[0], mid[1], F[0], F[1]);
    gradient.addColorStop(0, tone(step.shade[0]));
    gradient.addColorStop(1, tone(step.shade[1]));
    ctx.filter = "blur(0.6px)";
    ctx.fillStyle = gradient;
    tracePolygon(ctx, step.polygon);
    ctx.fill();
    ctx.restore();

    // Grain: the renderer's sensor noise is already in the frame around it.
    const u0 = Math.max(0, Math.floor(Math.min(A[0], B[0], F[0])));
    const v0 = Math.max(0, Math.floor(Math.min(A[1], B[1], F[1])));
    const u1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(A[0], B[0], F[0])));
    const v1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(A[1], B[1], F[1])));
    if (u1 <= u0 || v1 <= v0) return;
    const image = ctx.getImageData(u0, v0, u1 - u0, v1 - v0);
    const random = mulberry32(step.seed ?? 1);
    for (let v = v0; v < v1; v += 1) {
      for (let u = u0; u < u1; u += 1) {
        if (!insidePolygon(u + 0.5, v + 0.5, step.polygon)) continue;
        const o = ((v - v0) * (u1 - u0) + (u - u0)) * 4;
        const n = (random() - 0.5) * 7;
        image.data[o] += n;
        image.data[o + 1] += n;
        image.data[o + 2] += n;
      }
    }
    ctx.putImageData(image, u0, v0);
  },
});

/** A separable box blur of one channel, `radius` px each way, edges clamped. */
function boxBlur(src, dst, width, height, radius) {
  const tmp = new Float32Array(width * height);
  const span = 2 * radius + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += src[row + Math.min(width - 1, Math.max(0, k))];
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / span;
      sum += src[row + Math.min(width - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += tmp[Math.min(height - 1, Math.max(0, k)) * width + x];
    for (let y = 0; y < height; y += 1) {
      dst[y * width + x] = sum / span;
      sum += tmp[Math.min(height - 1, y + radius + 1) * width + x] - tmp[Math.max(0, y - radius) * width + x];
    }
  }
}

registerEffect("sharpen", {
  /**
   * `{ radius, amount }`: an unsharp mask over the whole frame — the frame
   * plus `amount` times its difference from a blur of `radius` px (two box
   * passes, near enough a Gaussian), in sRGB as an ISP does it.
   */
  apply(ctx, step) {
    const { width, height } = ctx.canvas;
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    const n = width * height;
    const channel = new Float32Array(n);
    const once = new Float32Array(n);
    const blurred = new Float32Array(n);
    const radius = Math.max(1, Math.round(step.radius));
    for (let c = 0; c < 3; c += 1) {
      for (let i = 0; i < n; i += 1) channel[i] = data[i * 4 + c];
      boxBlur(channel, once, width, height, radius);
      boxBlur(once, blurred, width, height, radius);
      for (let i = 0; i < n; i += 1) data[i * 4 + c] = channel[i] + step.amount * (channel[i] - blurred[i]);
    }
    ctx.putImageData(image, 0, 0);
  },
});

registerEffect("exposure", {
  /** `{ gain }`: every channel times `gain`, clipped at 255 — an overexposed frame. */
  apply(ctx, step) {
    const { width, height } = ctx.canvas;
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] *= step.gain;
      data[i + 1] *= step.gain;
      data[i + 2] *= step.gain;
    }
    ctx.putImageData(image, 0, 0);
  },
});
