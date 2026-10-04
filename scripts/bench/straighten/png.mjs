/**
 * PNG files for the straighten suite's before/after sheets, from Node alone:
 * the suite runs without a browser, and the repository has no image codec of
 * its own. Pure apart from `zlib`: RGBA in, bytes out.
 *
 * A sheet puts the pages side by side at one height on a neutral gutter — the
 * original flat page (the confirmed outline, straight homography) on the
 * left, the page the user would see on the right — so the eye compares them
 * directly. Captions live in the report, not in the pixels.
 */

import { deflateSync } from "node:zlib";
import { newImage, sampleBilinear } from "./imaging.mjs";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An RGB PNG (alpha dropped) of an RGBA image. */
export function encodePng(img) {
  const { width, height, data } = img;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const o = row + 1 + x * 3;
      raw[o] = data[i];
      raw[o + 1] = data[i + 1];
      raw[o + 2] = data[i + 2];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** `img` scaled (bilinear) to `height` px tall. */
function toHeight(img, height) {
  const width = Math.max(1, Math.round((img.width * height) / img.height));
  const out = newImage(width, height);
  const sx = img.width / width;
  const sy = img.height / height;
  const rgb = new Float64Array(3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      sampleBilinear(img, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, rgb);
      const o = (y * width + x) * 4;
      out.data[o] = rgb[0] + 0.5;
      out.data[o + 1] = rgb[1] + 0.5;
      out.data[o + 2] = rgb[2] + 0.5;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Panels side by side at `height` px on a mid-grey gutter. */
export function sideBySide(panels, { height = 700, gutter = 12 } = {}) {
  const scaled = panels.map((p) => toHeight(p, height));
  const width = scaled.reduce((sum, p) => sum + p.width, 0) + gutter * (scaled.length + 1);
  const out = newImage(width, height + 2 * gutter);
  out.data.fill(128);
  let x0 = gutter;
  for (const p of scaled) {
    for (let y = 0; y < p.height; y += 1) {
      const src = p.data.subarray(y * p.width * 4, (y + 1) * p.width * 4);
      out.data.set(src, ((y + gutter) * width + x0) * 4);
    }
    x0 += p.width + gutter;
  }
  return out;
}
