/**
 * Procedural documents: the ink printed on a page, drawn with Canvas 2D.
 *
 * A document is a function of a seed that draws **ink on white** into a canvas
 * at a given resolution; the renderer lays it over the paper stock (tint,
 * fibres, the thickness of the cut edge) and into perspective. Nothing here is
 * a photograph or derived from one, and the only people a page names are the
 * repository's fictional personas — JOÃO AZELO and MARIA AZELO. Numbers are
 * kept short and obviously clinical ("1,19 ng/dL", "Protocolo 4821-A") so no
 * generated page can ever carry a string shaped like an identifier.
 *
 * Registered by id — the A4 lab report, a form, a letter, an 80 mm till
 * receipt, an ID-1 health-plan card and a handwritten note — each with the
 * paper **stock** it is printed on (tint, fibre, corner radius, thickness): a
 * receipt is cool thermal paper that curls, a card is plastic with rounded
 * corners.
 */

import { Rng } from "./prng.js";

const registry = new Map();

/**
 * @param {{ id: string, sizeMm: [number, number] | ((rng: import("./prng.js").Rng) => [number, number]),
 *   stock?: object, draw: (ctx: CanvasRenderingContext2D, rng: import("./prng.js").Rng, sizeMm: [number, number]) => void }} doc
 *   `draw` works in millimetres: the context is already scaled. `sizeMm` may
 *   be sampled (a receipt is as long as its purchase); `stock` describes the
 *   paper — see {@link documentStock}.
 */
export function registerDocument(doc) {
  if (registry.has(doc.id)) throw new Error(`document "${doc.id}" is already registered`);
  registry.set(doc.id, doc);
}

function entryOf(id) {
  const doc = registry.get(id);
  if (doc === undefined) throw new Error(`unknown document "${id}"`);
  return doc;
}

/**
 * A document's size in mm. Fixed for most; sampled from `seed` for the ones
 * whose length depends on their content, so the page's geometry (and its
 * ground truth) is a function of the params alone.
 */
export function documentSize(id, seed = 0) {
  const doc = entryOf(id);
  return typeof doc.sizeMm === "function" ? doc.sizeMm(new Rng(seed ^ 0x5a5a)) : doc.sizeMm;
}

/**
 * The stock a document is printed on: `{ tints, fibre: [min, max], edge:
 * [min, max], radius, thickness, curl }` — `curl` the chance it lies curled.
 */
export function documentStock(id) {
  return { ...DEFAULT_STOCK, ...(entryOf(id).stock ?? {}) };
}

const DEFAULT_STOCK = {
  tints: ["#f7f6f1", "#f4f2ea", "#fbfbf8", "#f1f0ec", "#f6f3ea"],
  fibre: [0.03, 0.07],
  edge: [0.05, 0.12],
  radius: 0.3,
  thickness: 0.1,
  curl: 0,
};

export function documentTypes() {
  return [...registry.keys()];
}

/**
 * The page's ink as a canvas, `pxPerMm` pixels to the millimetre.
 * @param {{ type: string, seed: number }} spec
 */
export function renderDocument(spec, pxPerMm) {
  const doc = entryOf(spec.type);
  const [w, h] = documentSize(spec.type, spec.seed);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * pxPerMm);
  canvas.height = Math.round(h * pxPerMm);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / w, canvas.height / h);
  ctx.textBaseline = "alphabetic";
  doc.draw(ctx, new Rng(spec.seed), [w, h]);
  return canvas;
}

/* ── where the content is: the ground truth a crop is judged by ─────────── */

/**
 * Text that identifies the patient or the document: a persona's name, a
 * date, a protocol / order / membership number, a registry id. A crop that
 * cuts one of these has lost what the scan was for.
 */
const IDENTIFIER_TEXT =
  /(?:MARIA|JOÃO) AZELO|Protocolo|Matrícula|Validade|Nº do pedido|\bCR[BM]{1,2}\b|\b\d{1,4}\/\d{2,4}\b|\b\d{1,2} de [a-zç]+ de \d{4}\b/;

/** The recorder a {@link contentRecorder} context answers to, and nothing else does. */
const RECORDER = Symbol("content recorder");

/**
 * Draw `body` as **one** piece of content of `kind` (`text`, `identifier` or
 * `mark`): however many strokes it takes, the ground truth gets one box. On
 * an ordinary context it just draws. Nested regions belong to the outermost.
 */
function region(ctx, kind, body) {
  const recorder = ctx[RECORDER];
  recorder?.begin(kind);
  try {
    body();
  } finally {
    recorder?.end();
  }
}

/** The resolution a piece's ink is found at: its box is good to a pixel, 0.025 mm. */
export const CONTENT_INK_PX_PER_MM = 40;

/** A piece bigger than this many pixels at that resolution is looked at coarser. */
const INK_MAX_PIXELS = 16e6;

/**
 * How far past a piece's estimated box its ink is looked for (mm). The
 * estimate only says where to look — text metrics come rounded to whole CSS
 * px (a whole millimetre on a page drawn in mm), a curve's control points
 * overshoot it, a mitred corner pokes past its points — and ink that reaches
 * the window's edge doubles the margin and is looked for again.
 */
const INK_SEARCH_MARGIN_MM = 1.5;

/** Path-building calls, recorded to be replayed under the transform each was made in. */
const PATH_CALLS = [
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "quadraticCurveTo",
  "bezierCurveTo",
  "arcTo",
  "arc",
  "ellipse",
  "rect",
  "roundRect",
];

/** Drawing state a piece's ink depends on (paint colour, alpha and shadow do not: ink is coverage). */
const TEXT_STATE = [
  "font",
  "textAlign",
  "textBaseline",
  "direction",
  "letterSpacing",
  "wordSpacing",
  "fontKerning",
  "fontStretch",
  "fontVariantCaps",
  "textRendering",
];
const LINE_STATE = ["lineWidth", "lineCap", "lineJoin", "miterLimit", "lineDashOffset"];

/**
 * A context that records where a page's content is: each `fillText` (a
 * `text` piece, or an `identifier` when it names one — {@link IDENTIFIER_TEXT}),
 * each stroked path (a `mark`: a tick, a line of handwriting), and each
 * {@link region}. Fills, rules and box outlines are layout: not recorded.
 *
 * It paints nothing: `ctx` (in page millimetres) only keeps the state —
 * transform, font, pen — and answers `measureText` for the page's own layout.
 * Each piece is replayed **alone**, opaque black, on a scratch canvas at
 * {@link CONTENT_INK_PX_PER_MM} around where it should be, and its box is the
 * bounding box of the pixels it covers — the ink's, not the font's metrics
 * (Chromium rounds `measureText`'s box to whole CSS px, a millimetre here)
 * and not a curve's control points. Boxes are in page millimetres.
 */
function contentRecorder(ctx, [pageW, pageH]) {
  const boxes = [];
  const open = [];
  let path = [];
  let pathBox = null;
  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true });

  const device = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  const grow = (box, m, x, y) => {
    const [dx, dy] = device(m, x, y);
    if (box === null) return [dx, dy, dx, dy];
    return [Math.min(box[0], dx), Math.min(box[1], dy), Math.max(box[2], dx), Math.max(box[3], dy)];
  };
  const union = (a, b) => (a === null ? b : b === null ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  const snapshot = (keys) => Object.fromEntries(keys.filter((key) => key in ctx).map((key) => [key, ctx[key]]));
  /** A box widened by half the current pen. */
  const penned = (box, m) => {
    if (box === null) return null;
    const half = (ctx.lineWidth * Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d))) / 2;
    return [box[0] - half, box[1] - half, box[2] + half, box[3] + half];
  };

  /**
   * The ink of `ops` replayed on the scratch canvas over `estimate` widened by
   * the search margin, as a box in page mm — `null` when they cover nothing
   * on the page.
   */
  const inkBox = (ops, estimate) => {
    if (estimate === null) estimate = [0, 0, pageW, pageH];
    let margin = INK_SEARCH_MARGIN_MM;
    for (;;) {
      const x0 = Math.max(0, estimate[0] - margin);
      const y0 = Math.max(0, estimate[1] - margin);
      const x1 = Math.min(pageW, estimate[2] + margin);
      const y1 = Math.min(pageH, estimate[3] + margin);
      if (x1 <= x0 || y1 <= y0) return null;
      const pxPerMm = Math.min(CONTENT_INK_PX_PER_MM, Math.sqrt(INK_MAX_PIXELS / ((x1 - x0) * (y1 - y0))));
      const w = Math.max(1, Math.ceil((x1 - x0) * pxPerMm));
      const h = Math.max(1, Math.ceil((y1 - y0) * pxPerMm));
      if (scratch.width < w || scratch.height < h) {
        scratch.width = Math.max(scratch.width, w);
        scratch.height = Math.max(scratch.height, h);
      } else {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(0, 0, w, h);
      }
      const view = new DOMMatrix().scale(pxPerMm).translate(-x0, -y0);
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = "source-over";
      sctx.fillStyle = "#000000";
      sctx.strokeStyle = "#000000";
      for (const op of ops) op(sctx, view);
      const alpha = sctx.getImageData(0, 0, w, h).data;
      let ix0 = Infinity;
      let iy0 = Infinity;
      let ix1 = -Infinity;
      let iy1 = -Infinity;
      for (let y = 0; y < h; y += 1) {
        const row = y * w * 4 + 3;
        for (let x = 0; x < w; x += 1) {
          if (alpha[row + x * 4] === 0) continue;
          if (x < ix0) ix0 = x;
          if (x >= ix1) ix1 = x + 1;
          if (y < iy0) iy0 = y;
          iy1 = y + 1;
        }
      }
      if (ix0 === Infinity) return null;
      const reachesEdge = (ix0 === 0 && x0 > 0) || (iy0 === 0 && y0 > 0) || (ix1 === w && x1 < pageW) || (iy1 === h && y1 < pageH);
      if (reachesEdge) {
        margin *= 2;
        continue;
      }
      return [x0 + ix0 / pxPerMm, y0 + iy0 / pxPerMm, Math.min(x1, x0 + ix1 / pxPerMm), Math.min(y1, y0 + iy1 / pxPerMm)];
    }
  };

  /** One piece painted: inside a region it joins the region's; otherwise its ink is found now. */
  const piece = (kind, op, estimate) => {
    if (open.length > 0) {
      open[0].ops.push(op);
      open[0].estimate = union(open[0].estimate, estimate);
      return;
    }
    const box = inkBox([op], estimate);
    if (box !== null) boxes.push({ kind, box });
  };

  /** The current path, replayable: each call under the transform it was made in. */
  const replayPath = (calls) => (target, view) => {
    target.beginPath();
    for (const { name, args, m } of calls) {
      target.setTransform(view.multiply(m));
      target[name](...args);
    }
  };
  const withPen = (target, pen, dash) => {
    Object.assign(target, pen);
    target.setLineDash(dash);
  };

  /** Where a string's ink should be, from its (rounded) metrics: a window to look in. */
  const textWindow = (value, x, y, m) => {
    const metrics = ctx.measureText(value);
    let box = null;
    for (const [px, py] of [
      [x - metrics.actualBoundingBoxLeft, y - metrics.actualBoundingBoxAscent],
      [x + metrics.actualBoundingBoxRight, y - metrics.actualBoundingBoxAscent],
      [x + metrics.actualBoundingBoxRight, y + metrics.actualBoundingBoxDescent],
      [x - metrics.actualBoundingBoxLeft, y + metrics.actualBoundingBoxDescent],
    ]) {
      box = grow(box, m, px, py);
    }
    return box;
  };
  const text = (method) => (...args) => {
    const [value, x, y] = args;
    const m = ctx.getTransform();
    const type = snapshot(TEXT_STATE);
    const pen = snapshot(LINE_STATE);
    const dash = ctx.getLineDash();
    const window = method === "strokeText" ? penned(textWindow(value, x, y, m), m) : textWindow(value, x, y, m);
    const op = (target, view) => {
      Object.assign(target, type);
      if (method === "strokeText") withPen(target, pen, dash);
      target.setTransform(view.multiply(m));
      target[method](...args);
    };
    piece(IDENTIFIER_TEXT.test(value) ? "identifier" : "text", op, window);
  };

  /**
   * The paints. Content is recorded; layout (a fill or a rectangle outside a
   * region, a box outline, an image) is dropped. None reaches `ctx`.
   */
  const paints = {
    fillText: text("fillText"),
    strokeText: text("strokeText"),
    stroke(...args) {
      const m = ctx.getTransform();
      const pen = snapshot(LINE_STATE);
      const dash = ctx.getLineDash();
      const given = args[0] instanceof Path2D ? args[0] : null;
      const draw = given === null ? replayPath(path.slice()) : null;
      const op = (target, view) => {
        if (draw !== null) draw(target, view);
        withPen(target, pen, dash);
        target.setTransform(view.multiply(m));
        if (given === null) target.stroke();
        else target.stroke(given);
      };
      piece("mark", op, given === null ? penned(pathBox, m) : null);
    },
    // Inside a region a fill is part of the content (a bar of a barcode);
    // outside one it is layout.
    fill(...args) {
      if (open.length === 0) return;
      const m = ctx.getTransform();
      const given = args[0] instanceof Path2D ? args[0] : null;
      const rule = given === null ? args[0] : args[1];
      const draw = given === null ? replayPath(path.slice()) : null;
      const op = (target, view) => {
        if (draw !== null) draw(target, view);
        target.setTransform(view.multiply(m));
        if (given !== null) target.fill(given, rule);
        else if (rule !== undefined) target.fill(rule);
        else target.fill();
      };
      piece("mark", op, given === null ? pathBox : null);
    },
    fillRect(x, y, w, h) {
      if (open.length === 0) return;
      const m = ctx.getTransform();
      const op = (target, view) => {
        target.setTransform(view.multiply(m));
        target.fillRect(x, y, w, h);
      };
      piece("mark", op, grow(grow(null, m, x, y), m, x + w, y + h));
    },
    strokeRect() {},
    clearRect() {},
    drawImage() {},
    putImageData() {},
  };

  /** Keeps the replayable path and the window it spans beside `ctx`'s own. */
  const pathCall = (name, args) => {
    if (name === "beginPath") {
      path = [];
      pathBox = null;
      return;
    }
    const m = ctx.getTransform();
    path.push({ name, args, m });
    const [a0, a1, a2, a3, a4, a5] = args;
    switch (name) {
      case "moveTo":
      case "lineTo":
        pathBox = grow(pathBox, m, a0, a1);
        break;
      case "quadraticCurveTo":
      case "arcTo":
        pathBox = grow(grow(pathBox, m, a0, a1), m, a2, a3);
        break;
      case "bezierCurveTo":
        pathBox = grow(grow(grow(pathBox, m, a0, a1), m, a2, a3), m, a4, a5);
        break;
      case "arc":
        pathBox = grow(grow(pathBox, m, a0 - a2, a1 - a2), m, a0 + a2, a1 + a2);
        break;
      case "ellipse": {
        const r = Math.max(a2, a3);
        pathBox = grow(grow(pathBox, m, a0 - r, a1 - r), m, a0 + r, a1 + r);
        break;
      }
      case "rect":
      case "roundRect":
        pathBox = grow(grow(pathBox, m, a0, a1), m, a0 + a2, a1 + a3);
        break;
      default:
        break;
    }
  };

  const recorder = {
    begin(kind) {
      open.push({ kind, ops: [], estimate: null });
    },
    end() {
      const done = open.pop();
      if (open.length > 0) {
        open[0].ops.push(...done.ops);
        open[0].estimate = union(open[0].estimate, done.estimate);
        return;
      }
      if (done.ops.length === 0) return;
      const box = inkBox(done.ops, done.estimate);
      if (box !== null) boxes.push({ kind: done.kind, box });
    },
  };

  const proxy = new Proxy(ctx, {
    get(target, key) {
      if (key === RECORDER) return recorder;
      if (Object.hasOwn(paints, key)) return paints[key];
      const value = target[key];
      if (typeof value !== "function") return value;
      const recordsPath = PATH_CALLS.includes(key);
      return (...args) => {
        if (recordsPath) pathCall(key, args);
        return value.apply(target, args);
      };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return { ctx: proxy, boxes };
}

/** Content boxes by `type:seed`: measuring means drawing, and a session asks for the same page a lot. */
const contentCache = new Map();

/**
 * Where a document's content is, as fractions of the page (0–1, from its
 * top-left, the way the page is drawn and textured): `[{ kind, box: [u0, v0,
 * u1, v1] }]` — every line of text, every identifier, every mark, each the
 * bounding box of its own ink (see {@link contentRecorder}). Drawn from the
 * same seed as {@link renderDocument}, so it is the same page.
 */
export function documentContent(spec) {
  const key = `${spec.type}:${spec.seed}`;
  const cached = contentCache.get(key);
  if (cached !== undefined) return cached;
  const doc = entryOf(spec.type);
  const [w, h] = documentSize(spec.type, spec.seed);
  // The state the page draws with, in millimetres; nothing is painted on it.
  const base = document.createElement("canvas").getContext("2d");
  base.textBaseline = "alphabetic";
  const { ctx, boxes } = contentRecorder(base, [w, h]);
  doc.draw(ctx, new Rng(spec.seed), [w, h]);
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const content = boxes
    .map(({ kind, box }) => ({ kind, box: [clamp(box[0] / w), clamp(box[1] / h), clamp(box[2] / w), clamp(box[3] / h)] }))
    .filter(({ box }) => box[2] > box[0] && box[3] > box[1]);
  contentCache.set(key, content);
  while (contentCache.size > 64) contentCache.delete(contentCache.keys().next().value);
  return content;
}

/* ── shared typesetting ─────────────────────────────────────────────────── */

const FAMILIES = [
  "Helvetica, Arial, 'Liberation Sans', sans-serif",
  "'DejaVu Sans', Verdana, sans-serif",
  "Georgia, 'Times New Roman', 'Liberation Serif', serif",
];

const MONO = "'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace";

function font(ctx, sizeMm, family, weight = "normal") {
  ctx.font = `${weight} ${sizeMm}px ${family}`;
}

/** A 1-D barcode: bars of random width. Shape only — it encodes nothing. */
function barcode(ctx, rng, x, y, width, height) {
  region(ctx, "identifier", () => {
    let cursor = x;
    while (cursor < x + width) {
      const bar = rng.pick([0.25, 0.25, 0.5, 0.75]);
      if (rng.chance(0.55)) ctx.fillRect(cursor, y, bar, height);
      cursor += bar + rng.pick([0.25, 0.5]);
    }
  });
}

/** A handwritten-looking signature: one continuous wobbly stroke. */
function signature(ctx, rng, x, y, width) {
  region(ctx, "mark", () => signatureStroke(ctx, rng, x, y, width));
}

function signatureStroke(ctx, rng, x, y, width) {
  ctx.save();
  ctx.lineWidth = 0.35;
  ctx.lineCap = "round";
  ctx.strokeStyle = rng.pick(["#1d2a6b", "#1a1a1a", "#23305e"]);
  ctx.beginPath();
  ctx.moveTo(x, y);
  let cx = x;
  const loops = rng.int(4, 7);
  for (let i = 0; i < loops; i += 1) {
    const step = width / loops;
    ctx.bezierCurveTo(
      cx + step * 0.3, y - rng.range(2, 6),
      cx + step * 0.7, y + rng.range(1, 4),
      cx + step, y - rng.range(-1, 2),
    );
    cx += step;
  }
  ctx.stroke();
  ctx.restore();
}

/* ── the A4 lab report ──────────────────────────────────────────────────── */

const LAB_NAMES = ["LABORATÓRIO AZELO", "AZELO DIAGNÓSTICOS", "CENTRO AZELO DE ANÁLISES CLÍNICAS"];
const PATIENTS = ["MARIA AZELO", "JOÃO AZELO"];
const PHYSICIANS = ["Dr. JOÃO AZELO", "Dra. MARIA AZELO"];

/** [exam, result, unit, reference] — values short and plainly clinical. */
const EXAMS = [
  ["TSH", "2,41", "µUI/mL", "0,45 a 4,50"],
  ["T4 livre", "1,19", "ng/dL", "0,70 a 1,80"],
  ["Glicose em jejum", "92", "mg/dL", "70 a 99"],
  ["Hemoglobina glicada", "5,4", "%", "até 5,6"],
  ["Colesterol total", "187", "mg/dL", "até 190"],
  ["HDL colesterol", "54", "mg/dL", "acima de 40"],
  ["LDL colesterol", "108", "mg/dL", "até 130"],
  ["Triglicerídeos", "126", "mg/dL", "até 150"],
  ["Creatinina", "0,91", "mg/dL", "0,60 a 1,20"],
  ["Ureia", "31", "mg/dL", "15 a 45"],
  ["Ácido úrico", "4,8", "mg/dL", "2,4 a 6,0"],
  ["TGO (AST)", "22", "U/L", "até 35"],
  ["TGP (ALT)", "19", "U/L", "até 41"],
  ["Gama GT", "27", "U/L", "8 a 61"],
  ["Ferritina", "84", "ng/mL", "15 a 150"],
  ["Vitamina D (25-OH)", "31,2", "ng/mL", "acima de 30"],
  ["Vitamina B12", "412", "pg/mL", "197 a 771"],
  ["Hemoglobina", "13,8", "g/dL", "12,0 a 15,5"],
  ["Hematócrito", "41,2", "%", "35,0 a 45,0"],
  ["Leucócitos", "6,4", "mil/mm³", "4,0 a 11,0"],
  ["Plaquetas", "245", "mil/mm³", "150 a 450"],
  ["Sódio", "139", "mEq/L", "135 a 145"],
  ["Potássio", "4,3", "mEq/L", "3,5 a 5,1"],
  ["PCR ultrassensível", "0,8", "mg/L", "até 3,0"],
];

const SECTIONS = ["BIOQUÍMICA", "HORMÔNIOS", "HEMATOLOGIA", "PERFIL LIPÍDICO"];

const NOTES = [
  "Método: quimioluminescência. Material: soro.",
  "Os valores de referência podem variar conforme idade, sexo e método.",
  "Resultado liberado após conferência técnica.",
  "Interpretação clínica a critério do médico solicitante.",
  "Amostra colhida em jejum de doze horas.",
];

registerDocument({
  id: "lab-report",
  sizeMm: [210, 297],
  draw(ctx, rng, [W, H]) {
    const family = rng.pick(FAMILIES);
    const ink = rng.pick(["#141414", "#1c1c1c", "#202428"]);
    const accent = rng.pick(["#0f4c5c", "#1f3a68", "#6b1f2a", "#245b3c", "#3b3b3b"]);
    const left = rng.range(14, 22);
    const right = W - rng.range(14, 22);
    let y = rng.range(12, 18);
    const body = rng.range(2.7, 3.3);
    const lab = rng.pick(LAB_NAMES);

    // Header: a coloured band, or a mark beside the name.
    if (rng.chance(0.5)) {
      const band = rng.range(16, 24);
      ctx.fillStyle = accent;
      ctx.fillRect(0, y - 6, W, band);
      ctx.fillStyle = "#ffffff";
      font(ctx, band * 0.34, family, "bold");
      ctx.fillText(lab, left, y - 6 + band * 0.55);
      font(ctx, body * 0.85, family);
      ctx.fillText("Rua das Acácias, 120 — Centro", left, y - 6 + band * 0.85);
      y += band + 4;
    } else {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(left + 7, y + 6, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(left + 5.8, y + 1.5, 2.4, 9);
      ctx.fillRect(left + 2.5, y + 4.8, 9, 2.4);
      ctx.fillStyle = accent;
      font(ctx, 6, family, "bold");
      ctx.fillText(lab, left + 18, y + 7);
      ctx.fillStyle = ink;
      font(ctx, body * 0.85, family);
      ctx.fillText("Unidade Centro · Atendimento de segunda a sábado", left + 18, y + 12);
      y += 20;
      ctx.fillStyle = accent;
      ctx.fillRect(left, y, right - left, 0.6);
      y += 6;
    }

    ctx.fillStyle = ink;
    font(ctx, body * 1.45, family, "bold");
    ctx.fillText(rng.pick(["LAUDO DE EXAMES LABORATORIAIS", "RESULTADO DE EXAMES"]), left, y + 4);
    y += 10;

    // Patient block.
    const boxTop = y;
    const rows = [
      [`Paciente: ${rng.pick(PATIENTS)}`, `Idade: ${rng.int(24, 78)} anos`],
      [`Médico solicitante: ${rng.pick(PHYSICIANS)}`, `Protocolo: ${rng.int(1000, 9999)}-${rng.pick(["A", "B", "C"])}`],
      [`Data da coleta: ${String(rng.int(1, 28)).padStart(2, "0")}/0${rng.int(1, 9)}/2026`, `Convênio: ${rng.pick(["Particular", "Plano Saúde", "SUS"])}`],
    ];
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.25;
    font(ctx, body, family);
    for (const [a, b] of rows) {
      y += body * 1.9;
      ctx.fillText(a, left + 3, y);
      ctx.fillText(b, left + (right - left) * 0.62, y);
    }
    y += body * 1.2;
    ctx.strokeRect(left, boxTop, right - left, y - boxTop);
    y += 8;

    // Results table, in one to three sections.
    const pool = [...EXAMS];
    const titles = [...SECTIONS];
    const sections = rng.int(1, 3);
    const columns = [left, left + (right - left) * 0.42, left + (right - left) * 0.58, left + (right - left) * 0.72];
    for (let section = 0; section < sections && y < H - 70; section += 1) {
      ctx.fillStyle = accent;
      font(ctx, body * 1.15, family, "bold");
      ctx.fillText(titles.splice(rng.int(0, titles.length - 1), 1)[0], left, y);
      y += 2;
      ctx.fillRect(left, y, right - left, 0.4);
      y += body * 1.6;
      ctx.fillStyle = ink;
      font(ctx, body * 0.9, family, "bold");
      ["Exame", "Resultado", "Unidade", "Valores de referência"].forEach((label, i) =>
        ctx.fillText(label, columns[i], y),
      );
      y += body * 0.8;
      ctx.fillRect(left, y, right - left, 0.2);
      const count = rng.int(4, 8);
      const zebra = rng.chance(0.4);
      for (let row = 0; row < count && pool.length > 0 && y < H - 60; row += 1) {
        const [exam, result, unit, reference] = pool.splice(rng.int(0, pool.length - 1), 1)[0];
        y += body * 1.75;
        if (zebra && row % 2 === 0) {
          ctx.fillStyle = "#ececec";
          ctx.fillRect(left, y - body * 1.15, right - left, body * 1.75);
        }
        ctx.fillStyle = ink;
        font(ctx, body, family);
        ctx.fillText(exam, columns[0], y);
        font(ctx, body, family, "bold");
        ctx.fillText(result, columns[1], y);
        font(ctx, body, family);
        ctx.fillText(unit, columns[2], y);
        ctx.fillText(reference, columns[3], y);
      }
      y += body * 1.2;
      ctx.fillRect(left, y, right - left, 0.2);
      y += 10;
    }

    // Notes.
    font(ctx, body * 0.85, family, "italic");
    ctx.fillStyle = ink;
    for (let i = 0, n = rng.int(1, 3); i < n && y < H - 40; i += 1) {
      ctx.fillText(rng.pick(NOTES), left, y);
      y += body * 1.5;
    }

    // Footer: signature, rule, responsible, page number, barcode.
    const footer = H - rng.range(14, 20);
    if (rng.chance(0.7)) signature(ctx, rng, right - 60, footer - 14, rng.range(35, 50));
    ctx.fillStyle = ink;
    ctx.fillRect(left, footer - 5, right - left, 0.25);
    font(ctx, body * 0.8, family);
    ctx.fillText(`Responsável técnico: ${rng.pick(["Dra. MARIA AZELO", "Dr. JOÃO AZELO"])} — CRBM 0000`, left, footer);
    ctx.fillText(`Página 1 de ${rng.int(1, 3)}`, right - 22, footer);
    if (rng.chance(0.6)) barcode(ctx, rng, left, footer + 3, rng.range(30, 45), 6);
  },
});

/* ── handwriting ────────────────────────────────────────────────────────── */

/**
 * A line of pseudo-cursive: words of joined loops with the odd ascender and
 * descender, the way handwriting reads from a metre away. It spells nothing.
 */
function scribble(ctx, rng, x, y, width, xHeight, ink, kind = "text") {
  region(ctx, kind, () => scribbleStrokes(ctx, rng, x, y, width, xHeight, ink));
}

function scribbleStrokes(ctx, rng, x, y, width, xHeight, ink) {
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = xHeight * 0.14;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let cursor = x;
  const slant = rng.range(0.1, 0.35);
  while (cursor < x + width - xHeight * 2) {
    const letters = rng.int(2, 8);
    ctx.beginPath();
    ctx.moveTo(cursor, y);
    for (let i = 0; i < letters && cursor < x + width; i += 1) {
      const w = xHeight * rng.range(0.55, 0.95);
      const tall = rng.chance(0.2) ? xHeight * rng.range(1.6, 2.2) : xHeight * rng.range(0.8, 1.1);
      const deep = rng.chance(0.1) ? xHeight * rng.range(0.6, 1.0) : 0;
      ctx.bezierCurveTo(
        cursor + w * 0.1 + tall * slant, y - tall,
        cursor + w * 0.6 + tall * slant, y - tall,
        cursor + w * 0.5, y + deep,
      );
      ctx.quadraticCurveTo(cursor + w * 0.75, y + xHeight * 0.1, cursor + w, y - xHeight * rng.range(0, 0.2));
      cursor += w;
    }
    ctx.stroke();
    cursor += xHeight * rng.range(0.8, 1.6);
  }
  ctx.restore();
}

/* ── a form ─────────────────────────────────────────────────────────────── */

const FORM_TITLES = ["SOLICITAÇÃO DE EXAMES", "FICHA DE ATENDIMENTO", "AUTORIZAÇÃO DE PROCEDIMENTO"];
const FORM_CHECKS = [
  "Hemograma completo", "Glicemia de jejum", "Perfil lipídico", "TSH e T4 livre",
  "Creatinina", "Urina tipo 1", "Vitamina D", "Ferritina", "Eletrocardiograma", "Raio X de tórax",
];

registerDocument({
  id: "form",
  sizeMm: [210, 297],
  draw(ctx, rng, [W, H]) {
    const family = rng.pick(FAMILIES);
    const ink = "#1a1a1a";
    const accent = rng.pick(["#1f3a68", "#0f4c5c", "#3b3b3b", "#6b1f2a"]);
    const pen = rng.pick(["#1d2a6b", "#1a1a1a", "#23305e"]);
    const left = 18;
    const right = W - 18;
    let y = 18;
    ctx.fillStyle = accent;
    font(ctx, 6, family, "bold");
    ctx.fillText(rng.pick(["CLÍNICA AZELO", "AZELO SAÚDE", "HOSPITAL AZELO"]), left, y + 4);
    font(ctx, 2.6, family);
    ctx.fillStyle = ink;
    ctx.fillText("Formulário padronizado · uso interno", left, y + 9);
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = accent;
    ctx.strokeRect(right - 34, y - 2, 34, 12);
    font(ctx, 2.4, family);
    ctx.fillText("Nº do pedido", right - 32, y + 2);
    font(ctx, 4, family, "bold");
    ctx.fillText(`${rng.int(100, 999)}/26`, right - 32, y + 8);
    y += 20;
    font(ctx, 4.6, family, "bold");
    ctx.fillText(rng.pick(FORM_TITLES), left, y);
    y += 6;

    // Field boxes, some filled in by hand.
    const fields = [
      ["Nome do paciente", rng.pick(PATIENTS), 1],
      ["Data de nascimento", `${String(rng.int(1, 28)).padStart(2, "0")}/0${rng.int(1, 9)}/19${rng.int(50, 99)}`, 0.5],
      ["Convênio", rng.pick(["Particular", "Plano Saúde AZELO", "SUS"]), 0.5],
      ["Médico solicitante", rng.pick(PHYSICIANS), 1],
      ["Indicação clínica", "", 1],
    ];
    ctx.lineWidth = 0.3;
    ctx.strokeStyle = ink;
    let col = 0;
    for (const [label, value, span] of fields) {
      const width = (right - left) * span - (span < 1 ? 2 : 0);
      const x = left + (span < 1 && col === 1 ? (right - left) * 0.5 + 2 : 0);
      ctx.strokeRect(x, y, width, 13);
      font(ctx, 2.4, family);
      ctx.fillStyle = "#555555";
      ctx.fillText(label, x + 1.5, y + 3.5);
      if (value !== "" && rng.chance(0.85)) {
        if (rng.chance(0.5)) {
          font(ctx, 4, family);
          ctx.fillStyle = ink;
          ctx.fillText(value, x + 2, y + 10);
        } else {
          // A name or a birth date written by hand is still an identifier.
          const kind = label === "Nome do paciente" || label === "Data de nascimento" ? "identifier" : "text";
          scribble(ctx, rng, x + 2, y + 10, Math.min(width - 4, value.length * 2.6), 2.4, pen, kind);
        }
      } else if (label === "Indicação clínica") {
        scribble(ctx, rng, x + 2, y + 10, width * rng.range(0.4, 0.9), 2.2, pen);
      }
      if (span < 1 && col === 0) {
        col = 1;
      } else {
        col = 0;
        y += 15;
      }
    }
    y += 4;
    font(ctx, 3.4, family, "bold");
    ctx.fillStyle = accent;
    ctx.fillText("Exames solicitados", left, y);
    y += 5;
    font(ctx, 3, family);
    ctx.fillStyle = ink;
    const checks = [...FORM_CHECKS];
    for (let i = 0; i < 10 && checks.length > 0; i += 1) {
      const label = checks.splice(rng.int(0, checks.length - 1), 1)[0];
      const x = left + (i % 2) * (right - left) * 0.5;
      const yy = y + Math.floor(i / 2) * 7;
      ctx.strokeRect(x, yy - 3, 3.2, 3.2);
      ctx.fillText(label, x + 5, yy);
      if (rng.chance(0.45)) {
        ctx.save();
        ctx.strokeStyle = pen;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x + 0.4, yy - 1.6);
        ctx.lineTo(x + 1.4, yy - 0.2);
        ctx.lineTo(x + 3.6, yy - 4);
        ctx.stroke();
        ctx.restore();
      }
    }
    y += 40;
    font(ctx, 2.8, family, "italic");
    ctx.fillStyle = "#444444";
    for (const line of [
      "Declaro que as informações acima são verdadeiras.",
      "Apresente este formulário na recepção no dia do exame.",
    ]) {
      ctx.fillText(line, left, y);
      y += 5;
    }
    const foot = H - rng.range(35, 55);
    ctx.fillStyle = ink;
    ctx.fillRect(left, foot, 70, 0.3);
    ctx.fillRect(right - 70, foot, 70, 0.3);
    font(ctx, 2.6, family);
    ctx.fillText("Local e data", left, foot + 4);
    ctx.fillText("Assinatura", right - 70, foot + 4);
    scribble(ctx, rng, left + 2, foot - 2, 50, 2.4, pen);
    signature(ctx, rng, right - 62, foot - 3, rng.range(35, 50));
    font(ctx, 2.2, family);
    ctx.fillStyle = "#777777";
    ctx.fillText(`Rev. ${rng.int(1, 9)} · ${rng.pick(["mar", "jun", "set"])}/2026`, left, H - 10);
  },
});

/* ── a letter ───────────────────────────────────────────────────────────── */

const LETTER_PARAGRAPHS = [
  "Encaminho o paciente para avaliação especializada, com história de cansaço e alteração discreta dos exames de rotina.",
  "Os exames laboratoriais recentes seguem em anexo, com valores de referência de cada método.",
  "Solicito, se possível, retorno com parecer e conduta sugerida para acompanhamento conjunto.",
  "Paciente em uso regular da medicação prescrita, sem intercorrências desde a última consulta.",
  "Fico à disposição para qualquer esclarecimento adicional que se faça necessário.",
  "Agradeço a atenção dispensada e aguardo o retorno da avaliação.",
];

registerDocument({
  id: "letter",
  sizeMm: [210, 297],
  draw(ctx, rng, [W, H]) {
    const family = rng.pick(FAMILIES);
    const ink = rng.pick(["#141414", "#1c1c1c", "#202428"]);
    const accent = rng.pick(["#0f4c5c", "#1f3a68", "#245b3c", "#3b3b3b"]);
    const left = rng.range(22, 28);
    const right = W - left;
    let y = rng.range(20, 28);
    ctx.fillStyle = accent;
    font(ctx, 5.5, family, "bold");
    ctx.fillText(rng.pick(["Clínica AZELO", "Consultório Dra. MARIA AZELO", "AZELO Medicina Integrada"]), left, y);
    font(ctx, 2.6, family);
    ctx.fillText("Rua das Acácias, 120 · Centro", left, y + 5);
    ctx.fillRect(left, y + 8, right - left, 0.5);
    y += 24;
    ctx.fillStyle = ink;
    font(ctx, 3.4, family);
    ctx.fillText(`${rng.int(1, 28)} de ${rng.pick(["março", "junho", "setembro", "outubro"])} de 2026`, right - 55, y);
    y += 12;
    font(ctx, 3.6, family, "bold");
    ctx.fillText(rng.pick(["ENCAMINHAMENTO", "RELATÓRIO MÉDICO", "DECLARAÇÃO"]), left, y);
    y += 10;
    font(ctx, 3.4, family);
    ctx.fillText(`Ao(À) ${rng.pick(PHYSICIANS)},`, left, y);
    y += 9;
    const size = 3.3;
    font(ctx, size, family);
    const paragraphs = rng.int(3, 5);
    const pool = [...LETTER_PARAGRAPHS];
    for (let i = 0; i < paragraphs && pool.length > 0; i += 1) {
      let text = pool.splice(rng.int(0, pool.length - 1), 1)[0];
      if (i === 0) text = `Paciente ${rng.pick(PATIENTS)}, ${rng.int(24, 78)} anos. ` + text;
      const words = text.split(" ");
      let line = "";
      for (const word of words) {
        const next = line === "" ? word : `${line} ${word}`;
        if (ctx.measureText(next).width > right - left) {
          ctx.fillText(line, left, y);
          y += size * 1.6;
          line = word;
        } else {
          line = next;
        }
      }
      ctx.fillText(line, left, y);
      y += size * 2.6;
    }
    y += 6;
    ctx.fillText("Atenciosamente,", left, y);
    y += 22;
    signature(ctx, rng, left + 4, y - 6, rng.range(40, 60));
    ctx.fillRect(left, y, 70, 0.3);
    font(ctx, 3, family);
    ctx.fillText(`${rng.pick(PHYSICIANS)} · CRM 0000`, left, y + 5);
    font(ctx, 2.2, family);
    ctx.fillStyle = "#777777";
    ctx.fillText("Documento emitido para fins de acompanhamento clínico.", left, H - 12);
  },
});

/* ── an 80 mm till receipt ──────────────────────────────────────────────── */

const RECEIPT_ITEMS = [
  ["DIPIRONA 500MG 10CP", "12,90"], ["SORO FISIOL 250ML", "8,50"], ["PARACETAMOL 750MG", "14,20"],
  ["GAZE ESTERIL 10UN", "6,80"], ["ESPARADRAPO 10X4", "9,99"], ["VITAMINA C 1G", "22,40"],
  ["TERMOMETRO DIGITAL", "29,90"], ["ALCOOL 70 500ML", "11,50"], ["LUVA PROCED M", "4,30"],
  ["SERINGA 5ML", "1,20"], ["PROTETOR SOLAR", "39,90"], ["ESCOVA DENTAL", "7,60"],
];

registerDocument({
  id: "receipt",
  sizeMm: (rng) => [80, Math.round(rng.range(140, 260))],
  stock: {
    tints: ["#f6f7f8", "#f3f4f6", "#f8f8f6"],
    fibre: [0.01, 0.025],
    edge: [0.03, 0.07],
    radius: 0.2,
    thickness: 0.06,
    curl: 0.6,
  },
  draw(ctx, rng, [W, H]) {
    const ink = rng.pick(["#2a2a2a", "#333333", "#26262b"]);
    ctx.fillStyle = ink;
    const left = 5;
    const right = W - 5;
    let y = 10;
    font(ctx, 4.2, MONO, "bold");
    const store = rng.pick(["FARMÁCIA AZELO", "DROGARIA AZELO", "AZELO SAÚDE LTDA"]);
    ctx.fillText(store, (W - ctx.measureText(store).width) / 2, y);
    y += 5;
    font(ctx, 2.6, MONO);
    for (const line of ["RUA DAS ACÁCIAS, 120 - CENTRO", "CUPOM NÃO FISCAL"]) {
      ctx.fillText(line, (W - ctx.measureText(line).width) / 2, y);
      y += 3.8;
    }
    y += 1;
    ctx.fillText("-".repeat(40), left, y);
    y += 4;
    ctx.fillText(`${String(rng.int(1, 28)).padStart(2, "0")}/09/2026  ${rng.int(8, 21)}:${String(rng.int(0, 59)).padStart(2, "0")}  CX ${rng.int(1, 9)}`, left, y);
    y += 5;
    const pool = [...RECEIPT_ITEMS];
    let total = 0;
    while (y < H - 55 && pool.length > 0) {
      const [name, price] = pool.splice(rng.int(0, pool.length - 1), 1)[0];
      const qty = rng.int(1, 3);
      ctx.fillText(`${qty} ${name}`, left, y);
      const amount = `${price}`;
      ctx.fillText(amount, right - ctx.measureText(amount).width, y);
      total += qty * Number(price.replace(",", "."));
      y += 4;
    }
    y += 1;
    ctx.fillText("-".repeat(40), left, y);
    y += 5;
    font(ctx, 3.6, MONO, "bold");
    const sum = `TOTAL R$ ${total.toFixed(2).replace(".", ",")}`;
    ctx.fillText(sum, right - ctx.measureText(sum).width, y);
    y += 6;
    font(ctx, 2.6, MONO);
    ctx.fillText(`PAGAMENTO: ${rng.pick(["CARTÃO DÉBITO", "CARTÃO CRÉDITO", "DINHEIRO", "PIX"])}`, left, y);
    y += 4;
    ctx.fillText("OBRIGADO PELA PREFERÊNCIA", left, y);
    y += 6;
    // A square code at the foot: shape only.
    const size = 22;
    const x0 = (W - size) / 2;
    const cells = 21;
    region(ctx, "identifier", () => {
      for (let i = 0; i < cells; i += 1) {
        for (let j = 0; j < cells; j += 1) {
          const finder = (i < 7 && j < 7) || (i >= cells - 7 && j < 7) || (i < 7 && j >= cells - 7);
          const on = finder
            ? Math.max(Math.abs((i % (cells - 7)) - 3), Math.abs((j % (cells - 7)) - 3)) !== 2
            : rng.chance(0.5);
          if (on) ctx.fillRect(x0 + (i * size) / cells, y + (j * size) / cells, size / cells + 0.02, size / cells + 0.02);
        }
      }
    });
  },
});

/* ── an ID-1 health-plan card ───────────────────────────────────────────── */

registerDocument({
  id: "id-card",
  sizeMm: [85.6, 53.98],
  stock: {
    tints: ["#fbfbfb", "#f7f7f5"],
    fibre: [0.003, 0.008],
    edge: [0.1, 0.2],
    radius: 3.18,
    thickness: 0.76,
    curl: 0,
  },
  draw(ctx, rng, size) {
    drawCard(ctx, rng, size, [
      ["#0f4c5c", "#2a8c8c"], ["#1f3a68", "#4f79c2"], ["#245b3c", "#58a36f"], ["#6b1f2a", "#b8505e"], ["#e8e8e8", "#c9d6df"],
    ]);
  },
});

/**
 * An ID-1 card's face on a gradient of one of `palettes` (colour pairs; a
 * pair starting `#e8e8e8` is the light one, printed in dark ink).
 */
function drawCard(ctx, rng, [W, H], palettes) {
  const family = rng.pick(FAMILIES.slice(0, 2));
  const [c1, c2] = rng.pick(palettes);
  const light = c1 === "#e8e8e8";
  const gradient = ctx.createLinearGradient(0, 0, W, H);
  gradient.addColorStop(0, c1);
  gradient.addColorStop(1, c2);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, W, H);
  // A soft wave across the card.
  ctx.fillStyle = light ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.10)";
  ctx.beginPath();
  ctx.moveTo(0, H * 0.7);
  ctx.bezierCurveTo(W * 0.3, H * 0.5, W * 0.6, H * 0.95, W, H * 0.6);
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.fill();
  const text = light ? "#1c2b3a" : "#ffffff";
  ctx.fillStyle = text;
  font(ctx, 4.2, family, "bold");
  ctx.fillText(rng.pick(["AZELO SAÚDE", "PLANO AZELO", "AZELO CARE"]), 5, 8.5);
  font(ctx, 2.1, family);
  ctx.fillText("Cartão de identificação do beneficiário", 5, 12);
  // A photo placeholder: a silhouette, never a face.
  ctx.fillStyle = light ? "#b8c2cc" : "rgba(255,255,255,0.85)";
  ctx.fillRect(5, 16, 17, 21);
  ctx.fillStyle = light ? "#8a96a3" : c1;
  ctx.beginPath();
  ctx.arc(13.5, 23.5, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(13.5, 36, 7, 6, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = text;
  font(ctx, 3.2, family, "bold");
  ctx.fillText(rng.pick(PATIENTS), 26, 20);
  font(ctx, 2.2, family);
  const rows = [
    `Plano: ${rng.pick(["Essencial", "Ambulatorial", "Hospitalar", "Completo"])}`,
    `Matrícula: ${rng.int(1000, 9999)}-${rng.int(0, 9)}`,
    `Validade: ${String(rng.int(1, 12)).padStart(2, "0")}/20${rng.int(27, 31)}`,
    `Acomodação: ${rng.pick(["Enfermaria", "Apartamento"])}`,
  ];
  rows.forEach((row, i) => ctx.fillText(row, 26, 25.5 + i * 3.6));
  if (rng.chance(0.4)) {
    ctx.fillStyle = "#c9a640";
    ctx.fillRect(W - 17, 18, 11, 8.5);
    ctx.strokeStyle = "#8a6d1f";
    ctx.lineWidth = 0.2;
    ctx.strokeRect(W - 17, 18, 11, 8.5);
    ctx.beginPath();
    ctx.moveTo(W - 11.5, 18);
    ctx.lineTo(W - 11.5, 26.5);
    ctx.moveTo(W - 17, 22.25);
    ctx.lineTo(W - 6, 22.25);
    ctx.stroke();
  }
  ctx.fillStyle = text;
  font(ctx, 1.8, family);
  ctx.fillText("Central de atendimento no aplicativo AZELO", 5, H - 4);
}

/* ── a handwritten note ─────────────────────────────────────────────────── */

registerDocument({
  id: "note",
  sizeMm: (rng) => rng.pick([[148, 210], [105, 148], [140, 200]]),
  stock: {
    tints: ["#fbf6de", "#fdfbf2", "#f7f6f1", "#fff3c9"],
    fibre: [0.03, 0.06],
    edge: [0.04, 0.1],
    radius: 0.4,
    thickness: 0.08,
    curl: 0.25,
  },
  draw(ctx, rng, [W, H]) {
    const pen = rng.pick(["#1d2a6b", "#1a1a1a", "#23305e", "#2b4a8c"]);
    const ruled = rng.chance(0.6);
    if (ruled) {
      ctx.fillStyle = "#9fb4d8";
      for (let y = 22; y < H - 8; y += 7) ctx.fillRect(6, y, W - 12, 0.2);
      ctx.fillStyle = "#e3a0a0";
      ctx.fillRect(16, 0, 0.3, H);
    }
    const left = ruled ? 19 : rng.range(10, 16);
    let y = ruled ? 21.5 : rng.range(18, 26);
    const step = ruled ? 7 : rng.range(6.5, 8.5);
    const xHeight = rng.range(2.0, 2.6);
    scribble(ctx, rng, left, y, (W - left) * 0.5, xHeight * 1.1, pen);
    y += step * 2;
    const lines = Math.floor((H - y - 30) / step);
    for (let i = 0; i < lines; i += 1) {
      const width = (W - left - 8) * (i === lines - 1 ? rng.range(0.3, 0.7) : rng.range(0.8, 1.0));
      scribble(ctx, rng, left, y, width, xHeight, pen);
      y += step;
    }
    signature(ctx, rng, W - 55, H - 16, rng.range(28, 40));
  },
});

/* ── pages built to fool an edge finder (F7) ────────────────────────────── */

/** Word-wrapped paragraph from `x` to `right`; returns the next baseline. */
function paragraph(ctx, text, x, right, y, size) {
  let line = "";
  for (const word of text.split(" ")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (ctx.measureText(next).width > right - x) {
      ctx.fillText(line, x, y);
      y += size * 1.6;
      line = word;
    } else {
      line = next;
    }
  }
  ctx.fillText(line, x, y);
  return y + size * 1.6;
}

/**
 * A lab report ruled right up to its edges: a header bar 1.5–6 mm below the
 * top edge, a results table whose outer rules run 2–6 mm inside the side
 * edges, and a footer rule 3–8 mm above the bottom edge. Every one of them is
 * a long, straight, dark line parallel to a paper edge and a few millimetres
 * from it — with paper on both sides.
 */
registerDocument({
  id: "edge-ruled",
  sizeMm: [210, 297],
  draw(ctx, rng, [W, H]) {
    const family = rng.pick(FAMILIES);
    const ink = rng.pick(["#141414", "#1c1c1c", "#202428"]);
    const bar = rng.pick(["#1f3a68", "#0f4c5c", "#222222", "#6b1f2a", "#245b3c"]);
    const topGap = rng.range(1.5, 6);
    const barHeight = rng.range(6, 14);
    const barInset = rng.chance(0.5) ? 0 : rng.range(1.5, 5);
    ctx.fillStyle = bar;
    ctx.fillRect(barInset, topGap, W - 2 * barInset, barHeight);
    ctx.fillStyle = "#ffffff";
    font(ctx, barHeight * 0.45, family, "bold");
    ctx.fillText(rng.pick(LAB_NAMES), barInset + 8, topGap + barHeight * 0.68);

    const ruleIn = rng.range(2, 6);
    const ruleWidth = rng.range(0.4, 1.1);
    const left = ruleIn + ruleWidth + 3;
    const right = W - left;
    const body = rng.range(2.7, 3.2);
    let y = topGap + barHeight + 9;
    ctx.fillStyle = ink;
    font(ctx, body * 1.3, family, "bold");
    ctx.fillText("RESULTADO DE EXAMES", left, y);
    y += body * 2.2;
    font(ctx, body, family);
    ctx.fillText(`Paciente: ${rng.pick(PATIENTS)}   Médico: ${rng.pick(PHYSICIANS)}`, left, y);
    y += body * 3;

    const bottomGap = rng.range(3, 8);
    const footWidth = rng.range(0.5, 1.5);
    const tableTop = y;
    const tableBottom = H - bottomGap - footWidth - rng.range(12, 22);
    ctx.fillRect(ruleIn, tableTop, W - 2 * ruleIn, ruleWidth);
    ctx.fillRect(ruleIn, tableTop, ruleWidth, tableBottom - tableTop);
    ctx.fillRect(W - ruleIn - ruleWidth, tableTop, ruleWidth, tableBottom - tableTop);
    ctx.fillRect(ruleIn, tableBottom - ruleWidth, W - 2 * ruleIn, ruleWidth);
    const columns = [left, left + (right - left) * 0.45, left + (right - left) * 0.6, left + (right - left) * 0.74];
    const pool = [...EXAMS];
    y = tableTop + body * 2.2;
    while (y < tableBottom - body * 1.5 && pool.length > 0) {
      const [exam, result, unit, reference] = pool.splice(rng.int(0, pool.length - 1), 1)[0];
      ctx.fillText(exam, columns[0], y);
      font(ctx, body, family, "bold");
      ctx.fillText(result, columns[1], y);
      font(ctx, body, family);
      ctx.fillText(unit, columns[2], y);
      ctx.fillText(reference, columns[3], y);
      ctx.fillRect(ruleIn, y + body * 0.8, W - 2 * ruleIn, 0.2);
      y += body * 2.3;
    }

    const foot = H - bottomGap - footWidth;
    font(ctx, body * 0.8, family);
    ctx.fillText(rng.pick(NOTES), left, foot - 4);
    ctx.fillRect(ruleIn, foot, W - 2 * ruleIn, footWidth);
  },
});

/**
 * A letterhead printed to the edge: a dark full-bleed band across the top
 * (14–40 mm), often a footer band, sometimes a stripe down the left edge. On
 * a dark desk the band's outer edge is no edge at all — the page's outline
 * there is where the band *begins*, which is exactly what an edge finder must
 * not believe.
 */
registerDocument({
  id: "bleed-band",
  sizeMm: [210, 297],
  draw(ctx, rng, [W, H]) {
    const family = rng.pick(FAMILIES);
    const ink = rng.pick(["#141414", "#1c1c1c", "#202428"]);
    const band = rng.pick(["#1b2a4a", "#111111", "#1f3d2b", "#4a1520", "#2b2b2b", "#0c3b5e"]);
    const top = rng.range(14, 40);
    const stripe = rng.chance(0.35) ? rng.range(5, 14) : 0;
    const foot = rng.chance(0.6) ? rng.range(8, 24) : 0;
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, W, top);
    if (stripe > 0) ctx.fillRect(0, 0, stripe, H);
    if (foot > 0) ctx.fillRect(0, H - foot, W, foot);
    ctx.fillStyle = "#ffffff";
    font(ctx, Math.min(9, top * 0.3), family, "bold");
    ctx.fillText(rng.pick(["AZELO SAÚDE", "Clínica AZELO", "AZELO Medicina Integrada"]), stripe + 14, top * 0.6);
    if (foot > 0) {
      font(ctx, Math.min(3, foot * 0.3), family);
      ctx.fillText("Rua das Acácias, 120 · Centro", stripe + 14, H - foot * 0.45);
    }
    const left = stripe + rng.range(16, 24);
    const right = W - rng.range(16, 24);
    let y = top + rng.range(14, 22);
    ctx.fillStyle = ink;
    font(ctx, 3.8, family, "bold");
    ctx.fillText(rng.pick(["RELATÓRIO MÉDICO", "ENCAMINHAMENTO", "RESULTADO DE EXAMES"]), left, y);
    y += 10;
    const size = 3.2;
    font(ctx, size, family);
    y = paragraph(ctx, `Paciente ${rng.pick(PATIENTS)}, ${rng.int(24, 78)} anos.`, left, right, y, size) + 2;
    const pool = [...LETTER_PARAGRAPHS];
    for (let i = 0; i < 3 && pool.length > 0; i += 1) {
      y = paragraph(ctx, pool.splice(rng.int(0, pool.length - 1), 1)[0], left, right, y, size) + size;
    }
    const exams = [...EXAMS];
    const end = H - Math.max(foot, 10) - 30;
    while (y < end && exams.length > 0) {
      const [exam, result, unit] = exams.splice(rng.int(0, exams.length - 1), 1)[0];
      ctx.fillText(`${exam}: ${result} ${unit}`, left, y);
      y += size * 1.8;
    }
    signature(ctx, rng, right - 55, H - Math.max(foot, 10) - 14, rng.range(35, 50));
  },
});

/* ── field cases for the edge refinement (F7, adv-p2) ───────────────────── */

/**
 * A page on dark card stock — navy, bottle green, burgundy, black — printed
 * in white: a clinic's appointment card or folder insert. The stock is drawn
 * full-bleed (the paper under it is white), so white print stays white. Most
 * carry a white panel with the details in dark ink, up to 45 % of the page;
 * half have a thin white rule 4–10 mm inside the edge. With a panel that
 * size the page's bright end is the white print, not the stock.
 */
registerDocument({
  id: "dark-stock",
  sizeMm: (rng) => rng.pick([[148, 210], [210, 297], [105, 148]]),
  stock: { tints: ["#fbfbf8", "#f7f6f1"], fibre: [0.02, 0.05], edge: [0.02, 0.06], thickness: 0.3 },
  draw(ctx, rng, [W, H]) {
    const family = rng.pick(FAMILIES);
    const card = rng.pick(["#1b2a4a", "#14213d", "#1f3d2b", "#4a1520", "#1c1c1e", "#0c3b5e"]);
    const white = rng.pick(["#ffffff", "#f4f1e8", "#e9eef5"]);
    ctx.fillStyle = card;
    ctx.fillRect(0, 0, W, H);
    const unit = Math.min(W, H) / 148;
    if (rng.chance(0.5)) {
      const inset = rng.range(4, 10);
      const rule = rng.range(0.3, 0.8);
      ctx.fillStyle = white;
      ctx.fillRect(inset, inset, W - 2 * inset, rule);
      ctx.fillRect(inset, H - inset - rule, W - 2 * inset, rule);
      ctx.fillRect(inset, inset, rule, H - 2 * inset);
      ctx.fillRect(W - inset - rule, inset, rule, H - 2 * inset);
    }
    const left = 14 * unit;
    let y = 22 * unit;
    ctx.fillStyle = white;
    font(ctx, 7 * unit, family, "bold");
    ctx.fillText(rng.pick(["CLÍNICA AZELO", "AZELO SAÚDE", "AZELO CARDIOLOGIA"]), left, y);
    y += 8 * unit;
    font(ctx, 3.2 * unit, family);
    ctx.fillText(rng.pick(["Cartão de retorno", "Orientações ao paciente", "Agendamento de exames"]), left, y);
    y += 10 * unit;
    font(ctx, 3.6 * unit, family, "bold");
    ctx.fillText(`Paciente: ${rng.pick(PATIENTS)}`, left, y);
    y += 6 * unit;
    font(ctx, 3.2 * unit, family);
    ctx.fillText(`Retorno: ${rng.int(1, 28)} de ${rng.pick(["março", "junho", "outubro"])} de 2026`, left, y);
    y += 6 * unit;
    const panel = rng.chance(0.65) ? rng.range(0.2, 0.45) : 0;
    if (panel > 0) {
      const top = y + 4 * unit;
      const height = panel * H;
      ctx.fillStyle = white;
      ctx.fillRect(left - 4 * unit, top, W - 2 * (left - 4 * unit), height);
      ctx.fillStyle = "#1a1a1a";
      font(ctx, 3 * unit, family);
      let row = top + 7 * unit;
      const pool = [...EXAMS];
      while (row < top + height - 4 * unit && pool.length > 0) {
        const [exam, result, measure] = pool.splice(rng.int(0, pool.length - 1), 1)[0];
        ctx.fillText(`${exam}: ${result} ${measure}`, left, row);
        row += 5.2 * unit;
      }
      y = top + height + 8 * unit;
    }
    ctx.fillStyle = white;
    font(ctx, 2.8 * unit, family);
    for (const line of NOTES.slice(0, rng.int(1, 3))) {
      if (y > H - 14 * unit) break;
      ctx.fillText(line, left, y);
      y += 5 * unit;
    }
    font(ctx, 2.6 * unit, family);
    ctx.fillText("Rua das Acácias, 120 · Centro", left, H - 10 * unit);
  },
});

/**
 * A kraft envelope for lab results: brown stock drawn full-bleed, the lab's
 * name printed in dark ink, and a white address label stuck on it — the
 * label brighter than the stock, the stock darker than a white table.
 */
registerDocument({
  id: "kraft-envelope",
  sizeMm: (rng) => rng.pick([[229, 324], [162, 229], [250, 353]]),
  stock: { tints: ["#fbfbf8", "#f7f6f1"], fibre: [0.06, 0.12], edge: [0.05, 0.12], thickness: 0.25 },
  draw(ctx, rng, [W, H]) {
    const family = rng.pick(FAMILIES);
    ctx.fillStyle = rng.pick(["#c8a577", "#bd9866", "#d2b287", "#b58f5e", "#a88257"]);
    ctx.fillRect(0, 0, W, H);
    const unit = W / 229;
    const ink = rng.pick(["#2a1d12", "#1a1a1a", "#3a2415"]);
    ctx.fillStyle = ink;
    font(ctx, 8 * unit, family, "bold");
    ctx.fillText(rng.pick(LAB_NAMES), 16 * unit, 26 * unit);
    font(ctx, 4 * unit, family);
    ctx.fillText("RESULTADO DE EXAMES · CONFIDENCIAL", 16 * unit, 34 * unit);
    const lw = rng.range(0.45, 0.6) * W;
    const lh = rng.range(0.14, 0.2) * H;
    const lx = rng.range(0.25, 0.4) * W;
    const ly = rng.range(0.4, 0.55) * H;
    ctx.fillStyle = rng.pick(["#fbfbf8", "#f6f6f2"]);
    ctx.fillRect(lx, ly, lw, lh);
    ctx.fillStyle = "#1a1a1a";
    font(ctx, 5 * unit, family, "bold");
    ctx.fillText(rng.pick(PATIENTS), lx + 6 * unit, ly + 12 * unit);
    font(ctx, 4 * unit, family);
    ctx.fillText(`Protocolo ${rng.int(1000, 9999)}-${rng.pick(["A", "B", "C"])}`, lx + 6 * unit, ly + 20 * unit);
    ctx.fillText(`Médico: ${rng.pick(PHYSICIANS)}`, lx + 6 * unit, ly + 27 * unit);
    ctx.fillStyle = ink;
    font(ctx, 3.4 * unit, family);
    ctx.fillText("Rua das Acácias, 120 · Centro", 16 * unit, H - 18 * unit);
  },
});

/** An ID-1 card on a dark gradient only: black, navy, bottle green, burgundy. */
registerDocument({
  id: "dark-card",
  sizeMm: [85.6, 53.98],
  stock: {
    tints: ["#fbfbfb", "#f7f7f5"],
    fibre: [0.003, 0.008],
    edge: [0.1, 0.2],
    radius: 3.18,
    thickness: 0.76,
    curl: 0,
  },
  draw(ctx, rng, size) {
    drawCard(ctx, rng, size, [
      ["#0b0f1a", "#1f2a44"], ["#111111", "#3a3a3a"], ["#0f2a1c", "#245b3c"], ["#2a0b12", "#6b1f2a"], ["#0c1c33", "#1f3a68"],
    ]);
  },
});

/**
 * A form inside a printed border 3–8 mm from the page's edges (0.3–1.2 mm
 * thick, sometimes doubled): a long, straight, dark line parallel to every
 * edge with white paper on both sides of it. Most carry their form code or
 * page number in the margin *outside* the border — content a crop stopped at
 * the border cuts off.
 */
registerDocument({
  id: "bordered-form",
  sizeMm: [210, 297],
  draw(ctx, rng, [W, H]) {
    const family = rng.pick(FAMILIES);
    const ink = rng.pick(["#141414", "#1c1c1c", "#202428"]);
    const accent = rng.pick(["#1f3a68", "#0f4c5c", "#222222", "#6b1f2a"]);
    const inset = rng.range(3, 8);
    const rule = rng.range(0.3, 1.2);
    const frame = (d, w) => {
      ctx.fillRect(d, d, W - 2 * d, w);
      ctx.fillRect(d, H - d - w, W - 2 * d, w);
      ctx.fillRect(d, d, w, H - 2 * d);
      ctx.fillRect(W - d - w, d, w, H - 2 * d);
    };
    ctx.fillStyle = accent;
    frame(inset, rule);
    if (rng.chance(0.3)) frame(inset + rule + rng.range(0.6, 1.2), 0.25);
    ctx.fillStyle = ink;
    // In the margin, outside the border.
    const small = Math.min(2.4, inset * 0.45);
    font(ctx, small, family);
    if (rng.chance(0.65)) {
      const code = `Formulário AZ-${rng.int(10, 99)} · pág. 1 de ${rng.int(1, 3)}`;
      ctx.fillText(code, rng.chance(0.5) ? inset + 4 : W - inset - 4 - ctx.measureText(code).width, H - inset / 2 + small / 3);
    }
    if (rng.chance(0.35)) ctx.fillText("Via do paciente", W - inset - 30, inset / 2 + small / 3);

    const left = inset + rule + 8;
    const right = W - left;
    let y = inset + 16;
    ctx.fillStyle = accent;
    font(ctx, 6, family, "bold");
    ctx.fillText(rng.pick(["CLÍNICA AZELO", "AZELO SAÚDE", "HOSPITAL AZELO"]), left, y);
    y += 9;
    ctx.fillStyle = ink;
    font(ctx, 4.4, family, "bold");
    ctx.fillText(rng.pick(FORM_TITLES), left, y);
    y += 7;
    ctx.lineWidth = 0.3;
    ctx.strokeStyle = ink;
    for (const [label, value] of [
      ["Nome do paciente", rng.pick(PATIENTS)],
      ["Médico solicitante", rng.pick(PHYSICIANS)],
      ["Convênio", rng.pick(["Particular", "Plano Saúde AZELO", "SUS"])],
    ]) {
      ctx.strokeRect(left, y, right - left, 12);
      font(ctx, 2.4, family);
      ctx.fillStyle = "#555555";
      ctx.fillText(label, left + 1.5, y + 3.5);
      font(ctx, 4, family);
      ctx.fillStyle = ink;
      ctx.fillText(value, left + 2, y + 9.5);
      y += 14;
    }
    y += 4;
    font(ctx, 3, family);
    const checks = [...FORM_CHECKS];
    for (let i = 0; i < 10 && checks.length > 0; i += 1) {
      const label = checks.splice(rng.int(0, checks.length - 1), 1)[0];
      const x = left + (i % 2) * (right - left) * 0.5;
      const yy = y + Math.floor(i / 2) * 7;
      ctx.strokeRect(x, yy - 3, 3.2, 3.2);
      ctx.fillText(label, x + 5, yy);
    }
    y += 42;
    font(ctx, 2.8, family, "italic");
    ctx.fillStyle = "#444444";
    ctx.fillText("Apresente este formulário na recepção no dia do exame.", left, y);
    const foot = H - inset - rng.range(22, 40);
    ctx.fillStyle = ink;
    ctx.fillRect(right - 70, foot, 70, 0.3);
    font(ctx, 2.6, family);
    ctx.fillText("Assinatura", right - 70, foot + 4);
    signature(ctx, rng, right - 62, foot - 3, rng.range(35, 50));
  },
});
