/**
 * Contact sheets: every scene of a family as a tile, the truth in green and a
 * variant's answer over it — magenta when the crop would have been right, red
 * when it would have been wrong. Drawn in the page (it has the pixels); the
 * runner only decides the captions and colours.
 */

export const COLORS = {
  truth: "#00e05a",
  good: "#ff2bd6",
  wrong: "#ff3b30",
  rejected: "#ffb000",
  // Real media without a label: nothing to call right or wrong.
  unlabelled: "#2bb8ff",
};

/** A downscaled copy of a frame, kept after the frame itself is released. */
export async function thumbnail(canvas, longEdge = 480) {
  const scale = Math.min(1, longEdge / Math.max(canvas.width, canvas.height));
  return createImageBitmap(canvas, {
    resizeWidth: Math.max(1, Math.round(canvas.width * scale)),
    resizeHeight: Math.max(1, Math.round(canvas.height * scale)),
    resizeQuality: "high",
  });
}

function strokeQuad(ctx, quad, width, height, color, lineWidth, dashed) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  if (dashed) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  quad.forEach(([x, y], i) => ctx[i === 0 ? "moveTo" : "lineTo"](x * width, y * height));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  quad.forEach(([x, y], i) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    // The first corner is square so the order the detector reported is visible.
    if (i === 0) ctx.fillRect(x * width - 4, y * height - 4, 8, 8);
    else ctx.arc(x * width, y * height, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

/**
 * @param {{ title: string, columns?: number, tiles: { thumb: ImageBitmap,
 *   caption: string[], quads: { quad: number[][], color: string, dashed?: boolean }[] }[] }} spec
 * @returns {string} a JPEG data URL
 */
export function drawSheet({ title, columns = 6, tiles, legend = [] }) {
  const tileW = Math.max(...tiles.map((t) => t.thumb.width));
  const tileH = Math.max(...tiles.map((t) => t.thumb.height));
  const gap = 6;
  const header = 44;
  const cols = Math.min(columns, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = cols * tileW + (cols + 1) * gap;
  canvas.height = header + rows * tileH + (rows + 1) * gap;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#101010";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText(title, gap, 20);
  ctx.font = "12px sans-serif";
  let lx = gap;
  for (const { label, color } of legend) {
    ctx.fillStyle = color;
    ctx.fillRect(lx, 29, 12, 8);
    ctx.fillStyle = "#dddddd";
    ctx.fillText(label, lx + 16, 37);
    lx += 22 + ctx.measureText(label).width + 12;
  }
  tiles.forEach((tile, index) => {
    const x = gap + (index % cols) * (tileW + gap);
    const y = header + gap + Math.floor(index / cols) * (tileH + gap);
    ctx.save();
    ctx.translate(x, y);
    ctx.drawImage(tile.thumb, 0, 0);
    for (const { quad, color, dashed } of tile.quads) {
      if (quad !== null) strokeQuad(ctx, quad, tile.thumb.width, tile.thumb.height, color, 2.5, dashed);
    }
    ctx.font = "11px monospace";
    const lineH = 13;
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(0, 0, tile.thumb.width, tile.caption.length * lineH + 4);
    ctx.fillStyle = "#ffffff";
    tile.caption.forEach((line, i) => ctx.fillText(line, 4, (i + 1) * lineH));
    ctx.restore();
  });
  return canvas.toDataURL("image/jpeg", 0.9);
}
