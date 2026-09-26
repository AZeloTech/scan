import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

import { launchChromium } from "./browser.mjs";
import { ROOT } from "./paths.mjs";

/**
 * A crop's content verdict is only as good as the content boxes: the 1 %
 * loss that clips a line of 1.6 mm type is 0.02 mm of it. So the boxes
 * `documentContent` records are held to the page's **ink** as
 * `renderDocument` draws it — the whole page drawn the ordinary way, no
 * recorder in it — to within {@link TOLERANCE_MM}.
 *
 * Needs Chromium (canvas text); skipped where there is none.
 */

/** How far a box's side may sit from its ink's (mm). */
const TOLERANCE_MM = 0.1;

/** A pixel of the rendered page darker than this in any channel is ink. */
const INK_BELOW = 250;

async function openPage() {
  let launched;
  try {
    launched = await launchChromium();
  } catch {
    return null;
  }
  const result = await build({
    stdin: {
      contents: 'import * as D from "./scripts/bench/emulator/documents.js"; window.__documents = D;',
      resolveDir: ROOT,
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    ignoreAnnotations: true,
    logLevel: "silent",
  });
  const page = await launched.browser.newPage();
  await page.goto("about:blank");
  await page.addScriptTag({ content: result.outputFiles[0].text });
  return { browser: launched.browser, page };
}

test("content boxes are their ink's, to 0.1 mm: type of every family and size, curves, a mitred pen", async (t) => {
  const opened = await openPage();
  if (opened === null) {
    t.skip("no Chromium");
    return;
  }
  const { browser, page } = opened;
  try {
    // Pages whose pieces stand well clear of each other, dark on white: the
    // ink around a box is then that piece's and nothing else's.
    const rows = await page.evaluate(
      ([inkBelow]) => {
        const D = window.__documents;
        const families = [
          "Helvetica, Arial, 'Liberation Sans', sans-serif",
          "'DejaVu Sans', Verdana, sans-serif",
          "Georgia, 'Times New Roman', 'Liberation Serif', serif",
          "'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace",
        ];
        const lines = ["Glicose em jejum: 92 mg/dL", "aeiou vxz", "NOME DO PACIENTE", "gjpqy ÁÉÇ Ãõ", "MARIA AZELO"];
        const specs = [];
        families.forEach((family, f) => {
          for (const size of [1.8, 2.2, 3.4, 6]) {
            const id = `ink-probe-${f}-${size}`;
            const step = size * 2 + 8;
            specs.push({ type: id, seed: 1, lines: lines.length });
            D.registerDocument({
              id,
              sizeMm: [size * 16 + 12, 8 + lines.length * step],
              draw(ctx) {
                ctx.fillStyle = "#1c2b3a";
                lines.forEach((line, i) => {
                  ctx.font = `${i === 2 ? "bold" : "normal"} ${size}px ${family}`;
                  ctx.textAlign = i === 1 ? "right" : "left";
                  ctx.fillText(line, i === 1 ? size * 16 + 6 : 6, 4 + step * (i + 0.6));
                });
              },
            });
          }
        });
        D.registerDocument({
          id: "ink-probe-marks",
          sizeMm: [80, 110],
          draw(ctx) {
            ctx.strokeStyle = "#1d2a6b";
            // A signature: its control points reach far past the curve.
            ctx.lineWidth = 0.35;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(8, 20);
            ctx.bezierCurveTo(16, 8, 24, 32, 36, 20);
            ctx.bezierCurveTo(46, 10, 56, 28, 70, 18);
            ctx.stroke();
            // A tick with a mitred corner, which pokes past its points.
            ctx.lineWidth = 0.8;
            ctx.lineCap = "butt";
            ctx.lineJoin = "miter";
            ctx.beginPath();
            ctx.moveTo(10, 50);
            ctx.lineTo(14, 56);
            ctx.lineTo(24, 42);
            ctx.stroke();
            // Half a circle: its box is half the circle's.
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.arc(55, 55, 8, 0, Math.PI);
            ctx.stroke();
            // A loop of handwriting, drawn turned.
            ctx.save();
            ctx.translate(40, 90);
            ctx.rotate(-0.2);
            ctx.lineWidth = 0.4;
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(-30, 0);
            ctx.quadraticCurveTo(-20, -15, -10, 0);
            ctx.quadraticCurveTo(0, 10, 10, -3);
            ctx.stroke();
            ctx.restore();
          },
        });
        specs.push({ type: "ink-probe-marks", seed: 1, lines: 4 });

        const PX = 40;
        const out = [];
        for (const spec of specs) {
          const [w, h] = D.documentSize(spec.type, spec.seed);
          const canvas = D.renderDocument(spec, PX);
          const ctx = canvas.getContext("2d");
          const content = D.documentContent(spec);
          out.push({ type: spec.type, expected: spec.lines, found: content.length, kinds: content.map((c) => c.kind) });
          for (const item of content) {
            const box = [item.box[0] * w, item.box[1] * h, item.box[2] * w, item.box[3] * h];
            // Every probe piece stands at least 4 mm clear of the next.
            const x0 = Math.max(0, Math.floor((box[0] - 3) * PX));
            const y0 = Math.max(0, Math.floor((box[1] - 3) * PX));
            const x1 = Math.min(canvas.width, Math.ceil((box[2] + 3) * PX));
            const y1 = Math.min(canvas.height, Math.ceil((box[3] + 3) * PX));
            const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
            const W = x1 - x0;
            let ink = null;
            for (let y = 0; y < y1 - y0; y += 1) {
              for (let x = 0; x < W; x += 1) {
                const i = (y * W + x) * 4;
                if (Math.min(data[i], data[i + 1], data[i + 2]) >= inkBelow) continue;
                const px = [(x0 + x) / PX, (y0 + y) / PX, (x0 + x + 1) / PX, (y0 + y + 1) / PX];
                ink = ink === null ? px : [Math.min(ink[0], px[0]), Math.min(ink[1], px[1]), Math.max(ink[2], px[2]), Math.max(ink[3], px[3])];
              }
            }
            const miss = ink === null ? Infinity : Math.max(...box.map((v, i) => Math.abs(v - ink[i])));
            out.push({ type: spec.type, kind: item.kind, box, ink, miss });
          }
        }
        return out;
      },
      [INK_BELOW],
    );
    for (const doc of rows.filter((r) => r.expected !== undefined)) {
      assert.equal(doc.found, doc.expected, `${doc.type}: every piece is recorded`);
      if (doc.type === "ink-probe-marks") assert.deepEqual(doc.kinds, ["mark", "mark", "mark", "mark"]);
      else assert.deepEqual(doc.kinds, ["text", "text", "text", "text", "identifier"], doc.type);
    }
    const off = rows.filter((r) => r.expected === undefined && !(r.miss <= TOLERANCE_MM + 1e-9));
    assert.deepEqual(
      off.map((b) => `${b.type} ${b.kind} box ${b.box.map((v) => v.toFixed(3))} ink ${b.ink?.map((v) => v.toFixed(3))} (${b.miss.toFixed(3)} mm)`),
      [],
    );
  } finally {
    await browser.close();
  }
});

test("every document's content boxes are tight on its ink: no side is more than 0.1 mm of blank paper", async (t) => {
  const opened = await openPage();
  if (opened === null) {
    t.skip("no Chromium");
    return;
  }
  const { browser, page } = opened;
  try {
    // Real pages pack pieces close and print rules and bands beside them, so
    // only one direction is sure there: inside each side of a box, within the
    // tolerance, there is ink. (A card's printed background is ink by this
    // measure too; it can hide a loose box, never invent one.)
    const result = await page.evaluate(
      ([tolerance, inkBelow]) => {
        const D = window.__documents;
        const PX = 20;
        const loose = [];
        let boxes = 0;
        for (const type of D.documentTypes().filter((t) => !t.startsWith("ink-probe"))) {
          for (const seed of [1, 2, 3]) {
            const spec = { type, seed };
            const [w, h] = D.documentSize(type, seed);
            const canvas = D.renderDocument(spec, PX);
            const W = canvas.width;
            const H = canvas.height;
            const data = canvas.getContext("2d").getImageData(0, 0, W, H).data;
            const ink = (x, y) => {
              const i = (y * W + x) * 4;
              return Math.min(data[i], data[i + 1], data[i + 2]) < inkBelow;
            };
            const any = (xa, ya, xb, yb) => {
              for (let y = Math.max(0, ya); y < Math.min(H, yb); y += 1) {
                for (let x = Math.max(0, xa); x < Math.min(W, xb); x += 1) if (ink(x, y)) return true;
              }
              return false;
            };
            for (const item of D.documentContent(spec)) {
              boxes += 1;
              const [bx0, by0, bx1, by1] = [item.box[0] * w * PX, item.box[1] * h * PX, item.box[2] * w * PX, item.box[3] * h * PX];
              const band = tolerance * PX;
              const sides = {
                left: any(Math.floor(bx0), Math.floor(by0), Math.ceil(bx0 + band), Math.ceil(by1)),
                top: any(Math.floor(bx0), Math.floor(by0), Math.ceil(bx1), Math.ceil(by0 + band)),
                right: any(Math.floor(bx1 - band), Math.floor(by0), Math.ceil(bx1), Math.ceil(by1)),
                bottom: any(Math.floor(bx0), Math.floor(by1 - band), Math.ceil(bx1), Math.ceil(by1)),
              };
              const blank = Object.entries(sides).filter(([, v]) => !v).map(([k]) => k);
              if (blank.length > 0) loose.push(`${type}#${seed} ${item.kind} [${item.box.map((v) => v.toFixed(4))}] blank at ${blank.join(", ")}`);
            }
          }
        }
        return { loose, boxes };
      },
      [TOLERANCE_MM, INK_BELOW],
    );
    assert.ok(result.boxes > 100, `boxes measured: ${result.boxes}`);
    assert.deepEqual(result.loose, []);
  } finally {
    await browser.close();
  }
});
