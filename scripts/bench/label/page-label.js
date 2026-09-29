/**
 * The labelling page: a person places the four corners of the page in each
 * real photo and video frame, and the bench scores detectors against them.
 *
 * Served by the bench server (`npm run bench:label`), on 127.0.0.1 only, and
 * only when `SCAN_REAL_MEDIA` is set. It reads the image list from
 * `/real/items.json`, the images from `/real/stills/` and `/real/frames/`, and
 * reads and writes the labels through `GET|POST /labels` — the server decides
 * where they are kept (`/labels/info` says where, and why). Nothing leaves the
 * machine.
 *
 * Images are decoded the way the app decodes them (EXIF applied), so a label
 * is in the coordinates the detectors see. Corners are saved TL, TR, BR, BL,
 * normalized (`labels.mjs`), whatever order they were placed in.
 *
 * **Blank by default.** A new image starts with no corners: the labeller
 * places them, without the detector's answer to anchor on. "Start from ML"
 * (per image, or as the mode) fills them from the ML detector instead, and the
 * label records which it was (`from`).
 *
 * Mouse: click to place the next corner, drag a handle to move it; the loupe
 * magnifies around the cursor or the handle (wheel over it to zoom).
 * Keys: 1–4 select a corner · arrows nudge it one image pixel (Shift ×10,
 * Alt ×¼) · U uncertain · N no document · M start from ML · Del remove the
 * corner · C clear · Enter save and next unlabelled · [ ] previous / next ·
 * Ctrl+S save.
 */

import { detect, initDetectors } from "../app/detectors.js";
import { CORNER_SLACK, emptyLabels, orderCorners, validateLabels } from "../labels.mjs";

const NAMES = ["TL", "TR", "BR", "BL"];
const HANDLE_HIT_PX = 14;
const LOUPE_PX = 240;
const LOUPE_ZOOM = { min: 3, max: 16, start: 4 };
/** Room around the image, as a fraction of the view, for corners a frame cut off. */
const VIEW_MARGIN = 0.06;
const DECODED_KEPT = 4;
const LABELLER_KEY = "scan-bench-labeller";

const state = {
  items: [],
  doc: emptyLabels(),
  info: null,
  index: -1,
  image: null,
  work: null,
  selected: null,
  drag: null,
  pointer: null,
  loupeZoom: LOUPE_ZOOM.start,
  mode: "blank",
  filter: "all",
  drafts: new Map(),
  decoded: new Map(),
  mlReady: null,
  busy: false,
};

/* ── DOM ───────────────────────────────────────────────────────────────── */

const css = `
:root { color-scheme: dark; }
html, body { margin: 0; height: 100%; background: #15171a; color: #e8e8e8; font: 13px/1.4 system-ui, sans-serif; }
#root { height: 100%; }
.lb { display: grid; grid-template-rows: auto 1fr; height: 100%; }
.lb header { display: flex; gap: 12px; align-items: center; padding: 8px 12px; background: #1f2226; border-bottom: 1px solid #2c3036; flex-wrap: wrap; }
.lb header b { font-size: 14px; }
.lb header .where { color: #9aa3ad; font-size: 12px; }
.lb main { display: grid; grid-template-columns: 280px 1fr 280px; min-height: 0; }
.lb nav { overflow: auto; border-right: 1px solid #2c3036; }
.lb nav .row { display: flex; gap: 6px; padding: 3px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lb nav .row:hover { background: #262a30; }
.lb nav .row.on { background: #33415c; }
.lb nav .group { padding: 8px 10px 2px; color: #9aa3ad; font-weight: 600; text-transform: uppercase; font-size: 11px; }
.lb nav .mark { width: 14px; text-align: center; flex: none; }
.lb .stage { position: relative; min-width: 0; min-height: 0; background: #0c0d0f; }
.lb .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; }
.lb aside { border-left: 1px solid #2c3036; padding: 10px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.lb aside canvas { width: ${LOUPE_PX}px; height: ${LOUPE_PX}px; background: #000; border: 1px solid #2c3036; align-self: center; }
.lb button, .lb select, .lb input { background: #2a2f36; color: #e8e8e8; border: 1px solid #3a414b; border-radius: 4px; padding: 4px 8px; font: inherit; }
.lb button:hover { background: #343b44; }
.lb button.on { background: #7a5b12; border-color: #b8871a; }
.lb .corners div { display: flex; justify-content: space-between; gap: 6px; padding: 2px 4px; border-radius: 3px; cursor: pointer; }
.lb .corners div.on { background: #33415c; }
.lb .status { color: #9aa3ad; }
.lb .status.bad { color: #ff8a80; }
.lb .status.ok { color: #7ee2a8; }
.lb kbd { background: #2a2f36; border: 1px solid #3a414b; border-radius: 3px; padding: 0 4px; font-size: 11px; }
.lb .help { color: #9aa3ad; font-size: 12px; }
`;

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

const ui = {};

function buildUi() {
  document.head.append(el("style", { textContent: css }));
  const root = document.getElementById("root");
  ui.labeller = el("input", { placeholder: "your name", size: 12 });
  try {
    ui.labeller.value = localStorage.getItem(LABELLER_KEY) ?? "";
  } catch {
    // No storage: the name is asked again next time.
  }
  ui.labeller.addEventListener("change", () => {
    try {
      localStorage.setItem(LABELLER_KEY, ui.labeller.value);
    } catch {
      // Per-page convenience only.
    }
  });
  ui.mode = el(
    "select",
    { title: "How an image nobody labelled starts" },
    el("option", { value: "blank", textContent: "new images start blank" }),
    el("option", { value: "ml", textContent: "new images start from ML" }),
  );
  ui.mode.addEventListener("change", () => (state.mode = ui.mode.value));
  ui.filter = el(
    "select",
    {},
    ...["all", "unlabelled", "labelled", "uncertain", "no document"].map((v) => el("option", { value: v, textContent: v })),
  );
  ui.filter.addEventListener("change", () => {
    state.filter = ui.filter.value;
    renderList();
  });
  ui.where = el("span", { className: "where" });
  ui.count = el("span", { className: "where" });
  ui.save = el("button", { textContent: "Save (Ctrl+S)", onclick: () => save() });
  ui.saveStatus = el("span", { className: "status" });
  root.append(
    el(
      "div",
      { className: "lb" },
      el("header", {}, el("b", { textContent: "scan bench · labels" }), ui.count, "labeller", ui.labeller, ui.mode, ui.filter, ui.save, ui.saveStatus, ui.where),
      el(
        "main",
        {},
        (ui.list = el("nav")),
        el("div", { className: "stage" }, (ui.canvas = el("canvas"))),
        el(
          "aside",
          {},
          (ui.loupe = el("canvas", { width: LOUPE_PX, height: LOUPE_PX, title: "wheel to zoom" })),
          (ui.itemInfo = el("div", { className: "status" })),
          (ui.corners = el("div", { className: "corners" })),
          el(
            "div",
            {},
            (ui.noDoc = el("button", { textContent: "No document (N)", onclick: () => toggleNoDocument() })),
            " ",
            el("button", { textContent: "Start from ML (M)", onclick: () => startFromMl() }),
            " ",
            el("button", { textContent: "Clear (C)", onclick: () => clearCorners() }),
          ),
          el(
            "div",
            {},
            el("button", { textContent: "◀ [", onclick: () => go(state.index - 1) }),
            " ",
            el("button", { textContent: "Save & next ⏎", onclick: () => saveAndNext() }),
            " ",
            el("button", { textContent: "] ▶", onclick: () => go(state.index + 1) }),
          ),
          (ui.message = el("div", { className: "status" })),
          el("div", {
            className: "help",
            innerHTML:
              "Click to place the next corner; drag a handle to move it.<br>" +
              "<kbd>1</kbd>–<kbd>4</kbd> select · arrows nudge 1 px (<kbd>Shift</kbd> ×10, <kbd>Alt</kbd> ×¼)<br>" +
              "<kbd>U</kbd> uncertain corner · <kbd>N</kbd> no document · <kbd>M</kbd> from ML<br>" +
              "<kbd>Del</kbd> remove corner · <kbd>C</kbd> clear · <kbd>⏎</kbd> save &amp; next unlabelled<br>" +
              "<kbd>[</kbd> <kbd>]</kbd> previous / next · <kbd>Ctrl</kbd>+<kbd>S</kbd> save<br>" +
              "Corners are saved TL, TR, BR, BL whatever order you place them in.",
          }),
        ),
      ),
    ),
  );
  const resize = new ResizeObserver(() => draw());
  resize.observe(ui.canvas);
  ui.canvas.addEventListener("pointerdown", onPointerDown);
  ui.canvas.addEventListener("pointermove", onPointerMove);
  ui.canvas.addEventListener("pointerup", onPointerUp);
  ui.canvas.addEventListener("pointerleave", () => {
    state.pointer = null;
    drawLoupe();
  });
  ui.loupe.addEventListener("wheel", (event) => {
    event.preventDefault();
    const next = state.loupeZoom * (event.deltaY < 0 ? 1.25 : 0.8);
    state.loupeZoom = Math.min(LOUPE_ZOOM.max, Math.max(LOUPE_ZOOM.min, next));
    drawLoupe();
  });
  window.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", (event) => {
    if ([...state.drafts.values()].some((d) => d.dirty)) event.preventDefault();
  });
}

/* ── items and labels ──────────────────────────────────────────────────── */

function current() {
  return state.items[state.index] ?? null;
}

function statusOf(item) {
  const saved = state.doc.items[item.id];
  const draft = state.drafts.get(item.id);
  if (draft?.dirty) return { mark: "•", title: "unsaved changes" };
  if (saved === undefined) return { mark: "", title: "unlabelled" };
  if (saved.noDocument) return { mark: "∅", title: "no document" };
  if ((saved.uncertain ?? []).some(Boolean)) return { mark: "?", title: "labelled, some corner uncertain" };
  return { mark: "✓", title: "labelled" };
}

function visible(item) {
  const saved = state.doc.items[item.id];
  switch (state.filter) {
    case "unlabelled":
      return saved === undefined;
    case "labelled":
      return saved !== undefined;
    case "uncertain":
      return saved !== undefined && !saved.noDocument && (saved.uncertain ?? []).some(Boolean);
    case "no document":
      return saved?.noDocument === true;
    default:
      return true;
  }
}

function renderList() {
  ui.list.replaceChildren();
  let group = null;
  state.items.forEach((item, index) => {
    if (!visible(item)) return;
    const heading = item.kind === "still" ? `stills · ${item.group}` : `clip · ${item.clip}`;
    if (heading !== group) {
      group = heading;
      ui.list.append(el("div", { className: "group", textContent: heading }));
    }
    const status = statusOf(item);
    const name = item.kind === "still" ? item.id.split("/").pop() : `t ${item.t.toFixed(2)} s`;
    const row = el(
      "div",
      { className: `row${index === state.index ? " on" : ""}`, title: `${item.id} — ${status.title}`, onclick: () => go(index) },
      el("span", { className: "mark", textContent: status.mark }),
      el("span", { textContent: name }),
    );
    ui.list.append(row);
    if (index === state.index) row.scrollIntoView({ block: "nearest" });
  });
  const labelled = state.items.filter((i) => state.doc.items[i.id] !== undefined).length;
  ui.count.textContent = `${labelled} / ${state.items.length} labelled`;
}

/** The working label of the current image. */
function work() {
  return state.work;
}

function workFromSaved(saved) {
  if (saved === undefined) return { points: [], uncertain: [], noDocument: false, from: "blank", dirty: false };
  return {
    points: saved.noDocument ? [] : saved.corners.map((c) => [...c]),
    uncertain: saved.noDocument ? [] : [...(saved.uncertain ?? [false, false, false, false])],
    noDocument: saved.noDocument === true,
    from: saved.from ?? "blank",
    dirty: false,
  };
}

async function decode(item) {
  if (state.decoded.has(item.id)) return state.decoded.get(item.id);
  const response = await fetch(item.url);
  if (!response.ok) throw new Error(`${item.url}: HTTP ${response.status}`);
  const blob = await response.blob();
  // As the app decodes a photo: EXIF orientation applied, once.
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const canvas = el("canvas", { width: bitmap.width, height: bitmap.height });
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  state.decoded.set(item.id, canvas);
  while (state.decoded.size > DECODED_KEPT) {
    const oldest = state.decoded.keys().next().value;
    const stale = state.decoded.get(oldest);
    stale.width = 0;
    state.decoded.delete(oldest);
  }
  return canvas;
}

async function go(index) {
  if (index < 0 || index >= state.items.length || state.busy) return;
  keepDraft();
  state.index = index;
  const item = current();
  state.work = state.drafts.get(item.id) ?? workFromSaved(state.doc.items[item.id]);
  state.selected = state.work.points.length > 0 ? 0 : null;
  state.image = null;
  message("");
  draw();
  renderList();
  try {
    state.busy = true;
    state.image = await decode(item);
  } catch (error) {
    message(String(error?.message ?? error), true);
  } finally {
    state.busy = false;
  }
  ui.itemInfo.textContent = `${item.id}${state.image ? ` · ${state.image.width}×${state.image.height}` : ""}`;
  if (state.doc.items[item.id] === undefined && !state.drafts.has(item.id) && state.mode === "ml") await startFromMl();
  draw();
}

function keepDraft() {
  const item = current();
  if (item !== null && state.work !== null && state.work.dirty) state.drafts.set(item.id, state.work);
}

function touch() {
  state.work.dirty = true;
  const item = current();
  if (item !== null) state.drafts.set(item.id, state.work);
  renderList();
  draw();
}

/* ── editing ───────────────────────────────────────────────────────────── */

function clamp(v) {
  return Math.min(1 + CORNER_SLACK, Math.max(-CORNER_SLACK, v));
}

function placeCorner(point) {
  const w = work();
  if (w.noDocument || w.points.length >= 4) return;
  w.points.push(point);
  w.uncertain.push(false);
  state.selected = w.points.length - 1;
  touch();
}

function removeSelected() {
  const w = work();
  if (state.selected === null || state.selected >= w.points.length) return;
  w.points.splice(state.selected, 1);
  w.uncertain.splice(state.selected, 1);
  state.selected = w.points.length === 0 ? null : Math.min(state.selected, w.points.length - 1);
  touch();
}

function clearCorners() {
  const w = work();
  if (w === null) return;
  w.points = [];
  w.uncertain = [];
  w.from = "blank";
  state.selected = null;
  touch();
}

function toggleNoDocument() {
  const w = work();
  if (w === null) return;
  w.noDocument = !w.noDocument;
  touch();
}

function toggleUncertain() {
  const w = work();
  if (state.selected === null || state.selected >= w.points.length) return;
  w.uncertain[state.selected] = !w.uncertain[state.selected];
  touch();
}

function nudge(dx, dy) {
  const w = work();
  if (state.selected === null || state.selected >= w.points.length || state.image === null) return;
  const p = w.points[state.selected];
  w.points[state.selected] = [clamp(p[0] + dx / state.image.width), clamp(p[1] + dy / state.image.height)];
  touch();
}

async function startFromMl() {
  const item = current();
  if (item === null || state.image === null) return;
  message("running the ML detector…");
  try {
    if (state.mlReady === null) state.mlReady = (await initDetectors("/assets/")).mlReady;
    if (!state.mlReady) {
      message("the ML runtime did not start", true);
      return;
    }
    const answer = await detect("ml", state.image);
    if (answer.quad === null) {
      message("ML found nothing here — place the corners by hand");
      return;
    }
    const w = work();
    w.points = answer.quad.map((p) => [...p]);
    w.uncertain = [false, false, false, false];
    w.noDocument = false;
    w.from = "ml";
    state.selected = 0;
    touch();
    message(`ML suggestion${answer.accepted ? "" : " (the app would have gated it out)"}, confidence ${answer.confidence?.toFixed(2) ?? "–"} — check every corner`);
  } catch (error) {
    message(`ML failed: ${error?.message ?? error}`, true);
  }
}

/** The current image's label as it would be saved, or an error. */
function asLabel() {
  const w = work();
  const labeller = ui.labeller.value.trim() || "local";
  const t = new Date().toISOString();
  if (w.noDocument) return { label: { noDocument: true, labeller, t, from: w.from } };
  if (w.points.length !== 4) return { error: `place all four corners (${w.points.length} of 4), or mark "no document"` };
  const { corners, carry } = orderCorners(w.points, w.uncertain);
  return { label: { corners, uncertain: carry, labeller, t, from: w.from } };
}

async function save() {
  const item = current();
  if (item === null) return false;
  const w = work();
  if (w.dirty || state.doc.items[item.id] === undefined) {
    const { label, error } = asLabel();
    if (error) {
      message(error, true);
      return false;
    }
    state.doc.items[item.id] = label;
  }
  // Every other finished draft goes in the same write.
  for (const [id, draft] of state.drafts) {
    if (id === item.id || !draft.dirty) continue;
    if (draft.noDocument) state.doc.items[id] = { noDocument: true, labeller: ui.labeller.value.trim() || "local", t: new Date().toISOString(), from: draft.from };
    else if (draft.points.length === 4) {
      const { corners, carry } = orderCorners(draft.points, draft.uncertain);
      state.doc.items[id] = { corners, uncertain: carry, labeller: ui.labeller.value.trim() || "local", t: new Date().toISOString(), from: draft.from };
    }
  }
  const problem = validateLabels(state.doc);
  if (problem !== null) {
    message(`not saved: ${problem}`, true);
    return false;
  }
  try {
    const response = await fetch("/labels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.doc),
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const answer = await response.json();
    for (const [id, draft] of [...state.drafts]) {
      if (state.doc.items[id] !== undefined && (draft.noDocument || draft.points.length === 4 || id === item.id)) state.drafts.delete(id);
    }
    // The server merged this save into the file: what it wrote includes any
    // label another tab saved since this one loaded, and where that label was
    // newer it won. Take the file as it is now.
    if (answer.doc !== undefined) state.doc = answer.doc;
    if ((answer.keptNewer ?? []).length > 0) {
      message(`${answer.keptNewer.length} label(s) had been changed in another tab since this one loaded — kept the newer: ${answer.keptNewer.slice(0, 3).join(", ")}${answer.keptNewer.length > 3 ? "…" : ""}`, true);
    }
    state.work = workFromSaved(state.doc.items[item.id]);
    state.selected = state.work.points.length > 0 ? Math.min(state.selected ?? 0, 3) : null;
    ui.saveStatus.className = "status ok";
    ui.saveStatus.textContent = `saved ${new Date().toLocaleTimeString()}`;
    ui.where.textContent = `→ ${answer.saved}`;
    renderList();
    draw();
    return true;
  } catch (error) {
    ui.saveStatus.className = "status bad";
    ui.saveStatus.textContent = `NOT saved: ${error?.message ?? error}`;
    return false;
  }
}

async function saveAndNext() {
  if (!(await save())) return;
  for (let step = 1; step <= state.items.length; step += 1) {
    const index = (state.index + step) % state.items.length;
    if (state.doc.items[state.items[index].id] === undefined) return go(index);
  }
  message("every image has a label");
}

function message(text, bad = false) {
  ui.message.className = `status${bad ? " bad" : ""}`;
  ui.message.textContent = text;
}

/* ── the view ──────────────────────────────────────────────────────────── */

/** Image-normalized ↔ canvas CSS px. */
function view() {
  const box = ui.canvas.getBoundingClientRect();
  if (state.image === null || box.width === 0) return null;
  const room = { w: box.width * (1 - 2 * VIEW_MARGIN), h: box.height * (1 - 2 * VIEW_MARGIN) };
  const scale = Math.min(room.w / state.image.width, room.h / state.image.height);
  const w = state.image.width * scale;
  const h = state.image.height * scale;
  return {
    box,
    scale,
    w,
    h,
    x0: (box.width - w) / 2,
    y0: (box.height - h) / 2,
    toScreen: ([x, y]) => [(box.width - w) / 2 + x * w, (box.height - h) / 2 + y * h],
    toImage: ([sx, sy]) => [clamp((sx - (box.width - w) / 2) / w), clamp((sy - (box.height - h) / 2) / h)],
  };
}

function strokeQuad(ctx, points, map, color, dashed) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  if (dashed) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  points.forEach((p, i) => {
    const [x, y] = map(p);
    ctx[i === 0 ? "moveTo" : "lineTo"](x, y);
  });
  if (points.length === 4) ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function draw() {
  const canvas = ui.canvas;
  const dpr = window.devicePixelRatio || 1;
  const box = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(box.width * dpr));
  canvas.height = Math.max(1, Math.round(box.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0c0d0f";
  ctx.fillRect(0, 0, box.width, box.height);
  const v = view();
  renderCorners();
  if (v === null) {
    ctx.fillStyle = "#9aa3ad";
    ctx.fillText(state.index < 0 ? "no images" : "loading…", 16, 24);
    drawLoupe();
    return;
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(state.image, v.x0, v.y0, v.w, v.h);
  ctx.strokeStyle = "#3a414b";
  ctx.strokeRect(v.x0 - 0.5, v.y0 - 0.5, v.w + 1, v.h + 1);
  const w = work();
  if (w.noDocument) {
    ctx.fillStyle = "rgba(255,80,80,0.18)";
    ctx.fillRect(v.x0, v.y0, v.w, v.h);
    ctx.fillStyle = "#ff8a80";
    ctx.font = "bold 18px system-ui";
    ctx.fillText("NO DOCUMENT", v.x0 + 12, v.y0 + 28);
  } else {
    strokeQuad(ctx, w.points, v.toScreen, "#00e05a", w.points.length < 4);
    w.points.forEach((p, i) => {
      const [x, y] = v.toScreen(p);
      ctx.save();
      ctx.strokeStyle = w.uncertain[i] ? "#ffb000" : "#00e05a";
      ctx.lineWidth = i === state.selected ? 3 : 1.5;
      if (w.uncertain[i]) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x - 3, y);
      ctx.lineTo(x + 3, y);
      ctx.moveTo(x, y - 3);
      ctx.lineTo(x, y + 3);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "11px system-ui";
      ctx.fillText(`${i + 1}${w.uncertain[i] ? "?" : ""}`, x + 10, y - 10);
      ctx.restore();
    });
  }
  drawLoupe();
}

function drawLoupe() {
  const ctx = ui.loupe.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, LOUPE_PX, LOUPE_PX);
  const v = view();
  if (v === null) return;
  const w = work();
  let focus = null;
  if (state.drag !== null) focus = w.points[state.drag];
  else if (state.pointer !== null) focus = v.toImage(state.pointer);
  else if (state.selected !== null && state.selected < w.points.length) focus = w.points[state.selected];
  if (focus === undefined || focus === null) return;
  // `loupeZoom` times what the main view shows.
  const pxPerImage = v.scale * state.loupeZoom;
  const span = LOUPE_PX / pxPerImage;
  const cx = focus[0] * state.image.width;
  const cy = focus[1] * state.image.height;
  ctx.imageSmoothingEnabled = pxPerImage < 2;
  ctx.drawImage(state.image, cx - span / 2, cy - span / 2, span, span, 0, 0, LOUPE_PX, LOUPE_PX);
  const map = ([x, y]) => [
    LOUPE_PX / 2 + (x * state.image.width - cx) * pxPerImage,
    LOUPE_PX / 2 + (y * state.image.height - cy) * pxPerImage,
  ];
  if (!w.noDocument) {
    strokeQuad(ctx, w.points, map, "rgba(0,224,90,0.8)", w.points.length < 4);
    w.points.forEach((p, i) => {
      const [x, y] = map(p);
      ctx.strokeStyle = w.uncertain[i] ? "#ffb000" : "#00e05a";
      ctx.lineWidth = i === state.selected ? 2 : 1;
      ctx.strokeRect(x - 4, y - 4, 8, 8);
    });
  }
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LOUPE_PX / 2, LOUPE_PX / 2 - 14);
  ctx.lineTo(LOUPE_PX / 2, LOUPE_PX / 2 + 14);
  ctx.moveTo(LOUPE_PX / 2 - 14, LOUPE_PX / 2);
  ctx.lineTo(LOUPE_PX / 2 + 14, LOUPE_PX / 2);
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = "11px system-ui";
  ctx.fillText(`×${state.loupeZoom.toFixed(1)} · ${(cx).toFixed(1)}, ${(cy).toFixed(1)} px`, 6, LOUPE_PX - 6);
}

function renderCorners() {
  const w = work();
  ui.corners.replaceChildren();
  if (w === null) return;
  ui.noDoc.className = w.noDocument ? "on" : "";
  for (let i = 0; i < 4; i += 1) {
    const p = w.points[i];
    const row = el(
      "div",
      { className: i === state.selected ? "on" : "", onclick: () => select(i) },
      el("span", { textContent: `${i + 1} ${p ? "" : "(not placed)"}` }),
      el("span", { textContent: p ? `${p[0].toFixed(4)}, ${p[1].toFixed(4)}` : "" }),
      el("span", { textContent: p && w.uncertain[i] ? "uncertain" : "" }),
    );
    ui.corners.append(row);
  }
  ui.corners.append(
    el("div", {
      className: "status",
      textContent: `${w.points.length === 4 ? `saved as ${NAMES.join(", ")}` : "click the image to place corners"} · started ${w.from}${w.dirty ? " · unsaved" : ""}`,
    }),
  );
}

function select(i) {
  if (i < work().points.length) {
    state.selected = i;
    draw();
  }
}

/* ── input ─────────────────────────────────────────────────────────────── */

function local(event) {
  const box = ui.canvas.getBoundingClientRect();
  return [event.clientX - box.left, event.clientY - box.top];
}

function onPointerDown(event) {
  const v = view();
  if (v === null) return;
  const at = local(event);
  const w = work();
  let hit = -1;
  let best = HANDLE_HIT_PX;
  w.points.forEach((p, i) => {
    const [x, y] = v.toScreen(p);
    const d = Math.hypot(x - at[0], y - at[1]);
    if (d <= best) {
      best = d;
      hit = i;
    }
  });
  if (hit >= 0) {
    state.selected = hit;
    state.drag = hit;
    ui.canvas.setPointerCapture(event.pointerId);
    draw();
    return;
  }
  placeCorner(v.toImage(at));
}

function onPointerMove(event) {
  state.pointer = local(event);
  const v = view();
  if (state.drag !== null && v !== null) {
    work().points[state.drag] = v.toImage(state.pointer);
    touch();
    return;
  }
  drawLoupe();
}

function onPointerUp(event) {
  if (state.drag !== null) ui.canvas.releasePointerCapture(event.pointerId);
  state.drag = null;
  draw();
}

function onKey(event) {
  if (event.target instanceof HTMLInputElement) return;
  if (work() === null) return;
  const step = event.shiftKey ? 10 : event.altKey ? 0.25 : 1;
  const key = event.key;
  if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "s") {
    event.preventDefault();
    save();
    return;
  }
  if (event.ctrlKey || event.metaKey) return;
  const actions = {
    ArrowLeft: () => nudge(-step, 0),
    ArrowRight: () => nudge(step, 0),
    ArrowUp: () => nudge(0, -step),
    ArrowDown: () => nudge(0, step),
    1: () => select(0),
    2: () => select(1),
    3: () => select(2),
    4: () => select(3),
    u: toggleUncertain,
    U: toggleUncertain,
    n: toggleNoDocument,
    N: toggleNoDocument,
    m: startFromMl,
    M: startFromMl,
    c: clearCorners,
    C: clearCorners,
    Delete: removeSelected,
    Backspace: removeSelected,
    Enter: saveAndNext,
    "[": () => go(state.index - 1),
    "]": () => go(state.index + 1),
    PageUp: () => go(state.index - 1),
    PageDown: () => go(state.index + 1),
  };
  const action = actions[key];
  if (action === undefined) return;
  event.preventDefault();
  action();
}

/* ── start ─────────────────────────────────────────────────────────────── */

async function start() {
  buildUi();
  try {
    const [itemsResponse, labelsResponse, infoResponse] = await Promise.all([
      fetch("/real/items.json"),
      fetch("/labels"),
      fetch("/labels/info"),
    ]);
    if (!itemsResponse.ok) throw new Error("no real media here — start it with SCAN_REAL_MEDIA set (npm run bench:label)");
    state.items = (await itemsResponse.json()).items;
    if (labelsResponse.ok) state.doc = await labelsResponse.json();
    const problem = validateLabels(state.doc);
    if (problem !== null) throw new Error(`the labels file is malformed (${problem}); not editing it`);
    if (infoResponse.ok) {
      state.info = await infoResponse.json();
      ui.where.textContent = `→ ${state.info.path} (${state.info.reason})`;
    }
  } catch (error) {
    ui.saveStatus.className = "status bad";
    ui.saveStatus.textContent = String(error?.message ?? error);
    ui.save.disabled = true;
    return;
  }
  renderList();
  const first = state.items.findIndex((i) => state.doc.items[i.id] === undefined);
  await go(first >= 0 ? first : 0);
}

window.__label = { state, go, save };
start();
