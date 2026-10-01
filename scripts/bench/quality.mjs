#!/usr/bin/env node
/**
 * Does the PDF keep the camera's full resolution? — `npm run bench:quality`.
 *
 * Drives the real `<ScanFlow>` (`app/page-quality.js`) on a fake phone camera
 * whose still pipeline returns a large photo, through shutter → confirm →
 * step 2 → "Gerar PDF", and reads the finished PDF back: each page's image
 * must be the page region at the full resolution of the image the page was
 * made from — the sensor-native still cut to the preview's field of view, or
 * the stream's native frame when there is no still. Then the edits (girar,
 * cantos, acabamento) through the real store and render pipeline: every
 * render must come from the canonical, at the canonical's pixel size — no
 * generational shrink.
 *
 * With the `s25` case run, the size ladder too (`--budget`): the same page
 * through a host's `maxBytes` — by default 97 %, 80 % and 60 % of that
 * case's own PDF — each must fit, quality must go before any pixel does
 * (a quality rung embeds every pixel of the final), and a budget the
 * as-reviewed PDF meets must not step down at all.
 *
 * Synthetic only: the scene is drawn in code. Output under `.bench-out/`.
 *
 *   node scripts/bench/quality.mjs [--case s25|50mp|safari|timeout|closest …] [--budget x0.97,x0.7,250000 …] [--no-ladder] [--headed]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { launchChromium } from "./browser.mjs";
import { buildBenchApp, ensureRuntimeAssets } from "./build-app.mjs";
import { OUT_DIR } from "./paths.mjs";
import { startServer } from "./server.mjs";

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
};

const STREAM = { width: 2160, height: 3840 };

const S12 = { width: 3000, height: 4000 };
const S50 = { width: 6120, height: 8160 };
const CAPPED = { width: 1080, height: 1920 };

/**
 * The cases. `sensor` is the upright still at the camera's largest size;
 * `expect` is per page: what became the page (`still` → the sensor's full
 * long edge; `preview` → the frame size given), and, with the live stream's
 * cap (`lib/stream-cap.ts`), whether it was capped at the tap and how a
 * restore went.
 */
const CASES = {
  s25: { title: "12 MP still (4000×3000), 2160×3840 stream", sensor: S12, still: "ok", expect: [{ source: "still" }] },
  "50mp": { title: "50 MP still (8160×6120), 2160×3840 stream", sensor: S50, still: "ok", expect: [{ source: "still" }] },
  safari: {
    title: "no ImageCapture (Safari), 2160×3840 stream",
    sensor: S12,
    still: "none",
    expect: [{ source: "preview", reason: "unsupported", frame: STREAM }],
  },
  timeout: {
    title: "takePhoto never answers, 2160×3840 stream",
    sensor: S12,
    still: "hang",
    expect: [{ source: "preview", reason: "timeout", frame: STREAM }],
  },
  closest: {
    title: "driver answers 1704×3648 whatever is asked (the S25 field still)",
    sensor: S12,
    still: "closest",
    expect: [{ source: "preview", reason: "aspect-mismatch", frame: STREAM }],
  },
  cap: {
    title: "two pages: the stream is capped after a still proves itself; page 2 still at full size",
    sensor: S12,
    still: "ok",
    pages: 2,
    expect: [
      { source: "still", streamCapped: false },
      { source: "still", streamCapped: true, stream: CAPPED },
    ],
  },
  "cap-fail": {
    title: "two pages: page 2's still fails on the capped stream — the native stream is restored for it",
    sensor: S12,
    still: "fail-second",
    pages: 2,
    expect: [
      { source: "still", streamCapped: false },
      { source: "preview", reason: "take-failed", streamCapped: true, restore: "ok", frame: STREAM },
    ],
  },
  "cap-stuck": {
    title: "as cap-fail, but the camera never comes back to native: the capped frame is used and flagged",
    sensor: S12,
    still: "fail-second",
    restore: "stuck",
    pages: 2,
    expect: [
      { source: "still", streamCapped: false },
      { source: "preview", reason: "take-failed", streamCapped: true, restore: "timeout", frame: CAPPED, flag: "low-resolution" },
    ],
  },
};

/** The page region the fake camera drew, in the canonical's own pixels (`page-quality.js` PAGE). */
function expectedPage(sensor, source, frame) {
  const aspect = STREAM.width / STREAM.height;
  const fov =
    sensor.width / sensor.height > aspect
      ? { width: sensor.height * aspect, height: sensor.height }
      : { width: sensor.width, height: sensor.width / aspect };
  // The canonical is the FOV at the still's resolution, or the preview frame.
  const scale = source === "still" ? 1 : frame.width / fov.width;
  const width = 0.72 * fov.width * scale;
  return { width, height: width * Math.SQRT2 };
}

/** Every image XObject in a PDF, per page: its pixel size and filter. */
async function pdfImages(base64) {
  const document = await PDFDocument.load(Buffer.from(base64, "base64"));
  return document.getPages().map((page) => {
    const { width, height } = page.getSize();
    const resources = page.node.Resources();
    const xobjects = resources?.lookup(PDFName.of("XObject"));
    const images = [];
    for (const [, ref] of xobjects?.entries() ?? []) {
      const object = document.context.lookup(ref);
      if (!(object instanceof PDFRawStream)) continue;
      const dict = object.dict;
      if (dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
      images.push({
        width: Number(dict.get(PDFName.of("Width"))?.toString()),
        height: Number(dict.get(PDFName.of("Height"))?.toString()),
        filter: dict.get(PDFName.of("Filter"))?.toString() ?? null,
        bytes: object.contents.length,
      });
    }
    return { page: { width, height }, images };
  });
}

/** The ladder's default budgets: shares of the `s25` case's own PDF. */
const DEFAULT_BUDGETS = ["x0.97", "x0.8", "x0.6"];

function parseArgs(argv) {
  const cases = [];
  let headed = false;
  let edits = true;
  let budgets = DEFAULT_BUDGETS;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--case") cases.push(...argv[++i].split(","));
    else if (argv[i] === "--headed") headed = true;
    else if (argv[i] === "--no-edits") edits = false;
    else if (argv[i] === "--no-ladder") budgets = [];
    else if (argv[i] === "--budget") budgets = argv[++i].split(",");
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { cases: cases.length > 0 ? cases : Object.keys(CASES), headed, edits, budgets };
}

const options = parseArgs(process.argv.slice(2));
const log = (line) => console.log(line);
ensureRuntimeAssets({ log, styles: true });
await buildBenchApp();
const server = await startServer({ log });
const { browser } = await launchChromium({ headed: options.headed });
const results = [];
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  return ok;
};

try {
  for (const name of options.cases) {
    const spec = CASES[name];
    if (spec === undefined) throw new Error(`unknown case ${name} (known: ${Object.keys(CASES).join(", ")})`);
    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${server.url}/page-quality.html`);
    await page.waitForFunction(() => window.__qualityReady === true, null, { timeout: 60_000 });
    const started = Date.now();
    let run;
    try {
      run = await page.evaluate((args) => window.__quality.flow(args), {
        sensor: spec.sensor,
        stream: STREAM,
        still: spec.still,
        pages: spec.pages ?? 1,
        restore: spec.restore ?? "ok",
      });
    } catch (error) {
      await page.screenshot({ path: join(OUT_DIR, `quality-fail-${name}.png`) }).catch(() => undefined);
      throw new Error(`${name}: ${error.message}\n${errors.join("\n")}`);
    }
    const captures = run.events.filter((e) => e.type === "capture");
    const confirms = run.events.filter((e) => e.type === "confirm");
    const builds = run.events.filter((e) => e.type === "build");
    const caps = run.events.filter((e) => e.type === "stream-cap");
    const pdf = await pdfImages(run.pdf);
    const within = (a, b) => Math.abs(a - b) / b <= 0.03;
    check(captures.length === spec.expect.length, `${name}: ${captures.length} captures, expected ${spec.expect.length}`);
    check(pdf.length === spec.expect.length, `${name}: the PDF has ${pdf.length} pages`);
    const pages = [];
    for (const [index, want] of spec.expect.entries()) {
      const n = index + 1;
      const capture = captures[index];
      const render = run.events.filter((e) => e.type === "render" && e.page === n).at(-1);
      const build = builds.find((e) => e.page === n);
      const image = pdf[index]?.images[0] ?? null;
      const expected = expectedPage(spec.sensor, want.source, want.frame ?? STREAM);
      const label = `${name} p${n}`;
      pages.push({
        page: n,
        source: capture?.source ?? null,
        stillReason: capture?.stillReason ?? null,
        requested: capture?.requested ?? null,
        still: capture?.still ?? null,
        fov: capture?.fov ?? null,
        stream: capture?.stream ?? null,
        streamCapped: capture?.streamCapped ?? null,
        restore: capture?.restore ?? null,
        flag: capture?.flag ?? null,
        frame: capture?.frame ?? null,
        canonical: capture?.canonical ?? null,
        confirmCanonical: confirms[index]?.canonical ?? null,
        warped: render?.warped ?? null,
        final: render?.final ?? null,
        build: build ?? null,
        pdfPage: pdf[index]?.page ?? null,
        pdfImage: image,
        expectedPage: { width: Math.round(expected.width), height: Math.round(expected.height) },
        captureMs: capture?.ms ?? null,
        stillMs: capture?.stillMs ?? null,
      });
      check(capture?.source === want.source, `${label}: source ${capture?.source}, expected ${want.source}`);
      if (want.source === "still") {
        const long = Math.max(spec.sensor.width, spec.sensor.height);
        check(capture?.frame?.height === long, `${label}: frame ${JSON.stringify(capture?.frame)} does not keep the sensor's ${long} px long edge`);
        const asked = run.stillCalls[index];
        check(
          asked != null && Math.max(asked.imageWidth, asked.imageHeight) === long,
          `${label}: takePhoto was asked for ${JSON.stringify(asked)}, not the sensor's full size`,
        );
      } else {
        const frame = want.frame ?? STREAM;
        check(
          capture?.frame?.width === frame.width && capture?.frame?.height === frame.height,
          `${label}: the preview frame ${JSON.stringify(capture?.frame)} is not ${frame.width}×${frame.height}`,
        );
        check(capture?.stillReason === want.reason, `${label}: stillReason ${capture?.stillReason}, expected ${want.reason}`);
      }
      if (want.streamCapped !== undefined) check(capture?.streamCapped === want.streamCapped, `${label}: streamCapped ${capture?.streamCapped}, expected ${want.streamCapped}`);
      if (want.stream !== undefined) check(capture?.stream?.width === want.stream.width && capture?.stream?.height === want.stream.height, `${label}: stream ${JSON.stringify(capture?.stream)}, expected ${JSON.stringify(want.stream)}`);
      check((capture?.restore ?? null) === (want.restore ?? null), `${label}: restore ${capture?.restore}, expected ${want.restore ?? null}`);
      if (want.flag !== undefined) check(capture?.flag === want.flag, `${label}: flag ${capture?.flag}, expected ${want.flag}`);
      check(capture?.capped === false, `${label}: the canonical was capped`);
      check(
        image !== null && render !== undefined && image.width === render.final.width && image.height === render.final.height,
        `${label}: the PDF image ${JSON.stringify(image)} is not the final's own pixels ${JSON.stringify(render?.final)}`,
      );
      check(image?.filter === "/DCTDecode", `${label}: the PDF image is not the JPEG embedded as-is`);
      check(pdf[index]?.page.width === image?.width && pdf[index]?.page.height === image?.height, `${label}: the PDF page is not one unit per image pixel`);
      check(build?.resampled === false && build?.rung === 0, `${label}: the build resampled the page`);
      // The page region at the full resolution of its source (±3 %: the
      // corners are detected and refined, not given).
      check(
        image !== null && within(image.width, expected.width) && within(image.height, expected.height),
        `${label}: PDF image ${image?.width}×${image?.height}, expected ≈ ${Math.round(expected.width)}×${Math.round(expected.height)}`,
      );
      log(
        `quality: ${label} — ${capture?.source}${capture?.stillReason ? ` (${capture.stillReason})` : ""} · ` +
          `still ${capture?.still ? `${capture.still.width}×${capture.still.height}` : "none"} · stream ${capture?.stream?.width}×${capture?.stream?.height}${capture?.streamCapped ? " (capped)" : ""}` +
          `${capture?.restore ? ` · restore ${capture.restore}` : ""}${capture?.flag ? ` · flag ${capture.flag}` : ""} · ` +
          `frame ${capture?.frame?.width}×${capture?.frame?.height} · warped ${render?.warped?.width ?? "?"}×${render?.warped?.height ?? "?"} · ` +
          `PDF image ${image?.width}×${image?.height} (${Math.round((image?.bytes ?? 0) / 1024)} KB) · expected ≈ ${Math.round(expected.width)}×${Math.round(expected.height)} · ` +
          `capture ${Math.round(capture?.ms ?? -1)} ms`,
      );
    }
    // The first page is always taken on the native stream; the cap follows a
    // still that became a page, and never happens where none did.
    check(captures[0]?.streamCapped === false, `${name}: the first page was taken on a capped stream`);
    if (spec.expect.some((want) => want.source === "still")) {
      check(caps.some((e) => e.applied && e.reason === "still-proven"), `${name}: the stream was never capped after a proven still`);
    } else {
      check(!caps.some((e) => e.applied), `${name}: the stream was capped although no still ever became a page`);
    }
    if (errors.length > 0) failures.push(`${name}: page errors: ${errors.join(" | ")}`);
    results.push({ case: name, title: spec.title, ms: Date.now() - started, pdfBytes: run.bytes, streamCap: caps, streamSizes: run.streamSizes, takePhotoCalls: run.stillCalls, pages });
    await context.close();
  }

  // The size ladder: the s25 page under a host's `maxBytes`.
  const reference = results.find((r) => r.case === "s25");
  if (options.budgets.length > 0 && reference !== undefined) {
    const spec = CASES.s25;
    const asReviewed = reference.pdfBytes;
    for (const text of options.budgets) {
      const budget = text.startsWith("x") ? Math.round(asReviewed * Number(text.slice(1))) : Number(text);
      const label = `ladder ${text} (${Math.round(budget / 1024)} KB)`;
      const context = await browser.newContext(PHONE);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${server.url}/page-quality.html`);
      await page.waitForFunction(() => window.__qualityReady === true, null, { timeout: 60_000 });
      let run = null;
      try {
        run = await page.evaluate((args) => window.__quality.flow(args), { sensor: spec.sensor, stream: STREAM, still: spec.still, maxBytes: budget });
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
      }
      if (run !== null) {
        const build = run.events.find((e) => e.type === "build") ?? null;
        const render = run.events.filter((e) => e.type === "render").at(-1) ?? null;
        const image = (await pdfImages(run.pdf))[0]?.images[0] ?? null;
        check(run.bytes <= budget, `${label}: the PDF is ${run.bytes} bytes, over the budget`);
        if (budget >= asReviewed) check(build?.rung === 0, `${label}: a budget the as-reviewed PDF meets stepped down to rung ${build?.rung}`);
        else check((build?.rung ?? 0) > 0, `${label}: over budget at rung 0 but not stepped down`);
        // Quality before pixels: a rung that kept the final's size is a quality rung.
        const kept = image !== null && render !== null && image.width === render.final.width && image.height === render.final.height;
        check(kept || build?.resampled === true, `${label}: the image changed size without saying it resampled`);
        log(
          `quality: ${label} — rung ${build?.rung} q${build?.quality} · ${build?.resampled ? "resampled" : "every pixel"} · ` +
            `PDF image ${image?.width}×${image?.height} of the final's ${render?.final?.width}×${render?.final?.height} · ${Math.round(run.bytes / 1024)} KB`,
        );
        results.push({ case: `ladder-${text}`, budget, asReviewed, pdfBytes: run.bytes, rung: build?.rung ?? null, quality: build?.quality ?? null, resampled: build?.resampled ?? null, image, final: render?.final ?? null });
      }
      if (errors.length > 0) failures.push(`${label}: page errors: ${errors.join(" | ")}`);
      await context.close();
    }
  }

  if (options.edits) {
    for (const name of ["s25", "50mp"]) {
      const spec = CASES[name];
      const context = await browser.newContext(PHONE);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.goto(`${server.url}/page-quality.html`);
      await page.waitForFunction(() => window.__qualityReady === true, null, { timeout: 60_000 });
      const edits = await page.evaluate((args) => window.__quality.edits(args), { sensor: spec.sensor, stream: STREAM });
      const first = edits.steps[0];
      for (const step of edits.steps) {
        const turned = step.rotation === 90 || step.rotation === 270;
        const [w, h] = turned ? [step.height, step.width] : [step.width, step.height];
        // Every render is from the canonical; a re-crop 2 px inside moves the size by ≤ 4 px.
        check(step.canonicalSame, `edits ${name}: ${step.label} was not rendered from the canonical`);
        check(Math.abs(w - first.width) <= 4 && Math.abs(h - first.height) <= 4, `edits ${name}: ${step.label} ${step.width}×${step.height} shrank from ${first.width}×${first.height}`);
        check(step.decoded.width === step.width && step.decoded.height === step.height, `edits ${name}: ${step.label} final decodes to ${JSON.stringify(step.decoded)}`);
      }
      const last = edits.steps.at(-1);
      check(last.width === first.width || Math.abs(last.width - first.width) <= 4, `edits ${name}: after every edit the page is ${last.width}×${last.height}, first ${first.width}×${first.height}`);
      check(Math.abs(first.width - edits.page.width) <= 2, `edits ${name}: the warp is ${first.width} px wide, the page region ${Math.round(edits.page.width)}`);
      if (errors.length > 0) failures.push(`edits ${name}: page errors: ${errors.join(" | ")}`);
      results.push({ case: `edits-${name}`, canonical: edits.canonical, page: edits.page, steps: edits.steps });
      log(`quality: edits ${name} — canonical ${edits.canonical.width}×${edits.canonical.height} · ${edits.steps.map((s) => `${s.label} ${s.width}×${s.height}`).join(" → ")}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
const dir = join(OUT_DIR, `quality-${stamp}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "results.json"), JSON.stringify({ results, failures }, null, 1));
log(`quality: results → ${join(dir, "results.json")}`);
if (failures.length > 0) {
  console.error(`\nquality: ${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
log("quality: every page kept its full resolution");
