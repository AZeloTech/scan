#!/usr/bin/env node
/**
 * `npm run bench` — the detection bench's command line.
 *
 *   npm run bench -- --suite detector [--family F1,F2] [--seeds 40] [--setting mat-edge,screen]
 *                    [--variants ml,classical,production,refined,ml+refine] [--cpu 1|4|6]
 *                    [--size portrait|landscape|WxH] [--compare prev/results.json]
 *                    [--out dir] [--headed]
 *   npm run bench -- --suite session [--session approach-hold,page-swap]
 *                    [--seeds 1] [--stream 720x1280] [--cpu 4] [--lane main|worker]
 *                    [--no-frame-cache] [--layout rail|standard|classic|…]
 *                    [--viewport 390x844] [--fit cover|contain|maxcrop]
 *   SCAN_REAL_MEDIA=<dir> npm run bench -- --suite real-stills|real-video
 *                    [--variants …] [--cpu 4] [--skip-replay]
 *   npm run bench -- --suite straighten [--quick] [--jobs 8] [--engine-root dir]
 *                    [--deskew auto|off|paper|crop] [--only regex] [--sheets]
 *   SCAN_REAL_MEDIA=<dir> SCAN_BENCH_LABELS=<labels.json> npm run bench -- --suite straighten-real [same flags]
 *
 * Builds the bench page from the working tree, serves it on 127.0.0.1, drives
 * it in Chromium and writes `report.md`, `results.json` and contact sheets.
 * The straighten suites (Endireitar) need no page: they run the engine in
 * Node processes, and a command that runs only them launches no browser.
 * Synthetic suites write into the git-ignored `.bench-out/`; real-media suites
 * only ever into the cache outside the repository (`paths.mjs`).
 *
 * `--setting` narrows a synthetic run to the scenes whose setting is one of
 * those named (`F7/screen`, `F1/granite`): `--seeds N` is then N scenes of
 * each setting — the first N seeds that sample it, found in Node from the
 * params alone, before anything is rendered.
 *
 * With `--compare`, prints the headline deltas against an earlier
 * `results.json` and exits 1 on any regression beyond the tolerances in
 * `report.mjs`, on a headline that lost its number, and on any breach of the
 * absolute limits (missing captures, missing data…) whatever the baseline
 * said. The earlier run is read before anything runs — so
 * `.bench-out/latest-<suite>/results.json` means the previous run, not the
 * one this command is about to write — and a run over a different sample
 * (seeds, frame, throttle) or of another results schema is refused before
 * any time is spent on it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildBenchApp, ensureRuntimeAssets } from "./build-app.mjs";
import { cpuThrottle, launchChromium } from "./browser.mjs";
import { isInside, OUT_DIR, realMediaDir, realRunsDir, ROOT } from "./paths.mjs";
import { prepareRealMedia } from "./real.mjs";
import { absoluteViolations, checkComparable, compareSummaries, RESULTS_SCHEMA } from "./report.mjs";
import { startServer } from "./server.mjs";
import { SUITES } from "./suites/index.mjs";
import { buildScene, frameSize } from "./emulator/index.js";
import { DEFAULT_STREAM } from "./suites/session.mjs";
import { DEFAULT_JOBS } from "./straighten/suite.mjs";

const USAGE = `usage: npm run bench -- [--suite detector|session|real-stills|real-video|all|emulator|straighten|straighten-real]
       [--family F1,F2,…] [--setting name,…] [--seeds N] [--variants ml,classical,production,refined,ml+refine,ml+live]
       [--session approach-hold,…] [--stream WxH] [--skip-replay] [--lane main|worker] [--no-frame-cache]
       [--layout rail|standard|classic|filmstrip|onehand|collapse] [--viewport WxH] [--fit cover|contain|maxcrop]
       [--frame-by screen|sensor] [--stream-scale N]
       [--cpu 1|4|6] [--size portrait|landscape|WxH] [--compare results.json]
       [--out dir] [--headed]
       straighten, straighten-real: [--quick] [--jobs N] [--engine-root dir] [--deskew auto|off|paper|crop]
       [--only regex] [--sheets]
real-stills / real-video / straighten-real need SCAN_REAL_MEDIA=<dir>; their output goes to the cache, never the repo.`;

const DEFAULT_SEEDS = 40;

/** How far `--setting` looks for a setting's seeds before giving up on it. */
const SETTING_SEARCH_LIMIT = 20_000;

/** A session is a real-time run of the whole app: one seed each unless asked. */
const DEFAULT_SESSION_SEEDS = 1;
const DEFAULT_VARIANTS = ["ml", "classical", "production", "refined", "ml+refine", "ml+live"];

function log(line) {
  console.log(line);
}

/**
 * How the scripted user frames the page (`--frame-by`): `screen` — in what
 * the layout under test actually shows (its visible region, measured once
 * per layout × viewport × stream, minus the controls drawn over the top of
 * it), as a person aims by the screen; `sensor` — in the camera's whole
 * frame, as every session did before. Default: `screen`, except on
 * `standard`, whose sessions stay comparable with the earlier phases.
 */
function parseFrameBy(value, layout) {
  if (value === undefined) return layout === "standard" ? "sensor" : "screen";
  if (value !== "screen" && value !== "sensor") throw new Error(`--frame-by ${value}: expected screen or sensor`);
  return value;
}

/** `--stream-scale N`: the fake camera delivers each frame scaled up N× (a 4K stream from 720×1280 frames). */
function parseStreamScale(value) {
  if (value === undefined) return 1;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 4) throw new Error(`--stream-scale ${value}: expected 1 to 4`);
  return n;
}

function parse() {
  const { values } = parseArgs({
    options: {
      suite: { type: "string", default: "detector" },
      family: { type: "string" },
      setting: { type: "string" },
      seeds: { type: "string" },
      variants: { type: "string" },
      session: { type: "string" },
      stream: { type: "string", default: DEFAULT_STREAM },
      cpu: { type: "string", default: "1" },
      size: { type: "string", default: "portrait" },
      compare: { type: "string" },
      out: { type: "string" },
      headed: { type: "boolean", default: false },
      "skip-replay": { type: "boolean", default: false },
      lane: { type: "string" },
      "no-frame-cache": { type: "boolean", default: false },
      layout: { type: "string" },
      viewport: { type: "string" },
      fit: { type: "string" },
      "frame-by": { type: "string" },
      "stream-scale": { type: "string" },
      quick: { type: "boolean", default: false },
      jobs: { type: "string" },
      "engine-root": { type: "string" },
      deskew: { type: "string" },
      only: { type: "string" },
      sheets: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const cpu = Number(values.cpu);
  if (!Number.isFinite(cpu) || cpu < 1 || cpu > 20) throw new Error(`--cpu ${values.cpu}: expected a rate from 1 to 20`);
  const seeds = values.seeds === undefined ? DEFAULT_SEEDS : Number(values.seeds);
  if (!Number.isInteger(seeds) || seeds < 1) throw new Error(`--seeds ${values.seeds}: expected a positive integer`);
  frameSize(values.size);
  frameSize(values.stream);
  const suites =
    values.suite === "all"
      ? Object.entries(SUITES).filter(([, suite]) => suite.inAll).map(([name]) => name)
      : values.suite.split(",");
  for (const suite of suites) {
    if (!(suite in SUITES)) throw new Error(`unknown suite "${suite}"\n${USAGE}`);
  }
  const straightenFlags = ["quick", "jobs", "engine-root", "deskew", "only", "sheets"].filter(
    (flag) => values[flag] !== undefined && values[flag] !== false,
  );
  if (straightenFlags.length > 0 && !suites.every((name) => name.startsWith("straighten"))) {
    throw new Error(`only the straighten suites take --${straightenFlags.join(", --")}`);
  }
  return {
    suites,
    all: values.suite === "all",
    families: values.family?.split(",").map((f) => f.trim().toUpperCase()) ?? null,
    settings: values.setting?.split(",").map((v) => v.trim()) ?? null,
    seeds,
    sessionSeeds: values.seeds === undefined ? DEFAULT_SESSION_SEEDS : seeds,
    sessions: values.session?.split(",").map((v) => v.trim()) ?? null,
    stream: values.stream,
    variants: values.variants?.split(",").map((v) => v.trim()) ?? DEFAULT_VARIANTS,
    cpu,
    size: values.size,
    compare: values.compare === undefined ? null : readPrevious(values.compare),
    out: values.out ?? null,
    headed: values.headed,
    skipReplay: values["skip-replay"],
    lane: parseLane(values.lane),
    frameCache: !values["no-frame-cache"],
    layout: parseLayout(values.layout),
    viewport: parseViewport(values.viewport),
    fit: parseFit(values.fit),
    frameBy: parseFrameBy(values["frame-by"], values.layout),
    streamScale: parseStreamScale(values["stream-scale"]),
    profile: values.quick ? "quick" : "full",
    jobs: parseJobs(values.jobs),
    engineRoot: parseEngineRoot(values["engine-root"]),
    deskew: values.deskew ?? "auto",
    only: parseOnly(values.only),
    sheets: values.sheets,
  };
}

/**
 * `--jobs N`: the straighten suites' parallel engine processes (default
 * {@link DEFAULT_JOBS}). Recorded in the run's config: runtime counts
 * (timeouts, pages over the device budget) compare only between runs at the
 * same `--jobs`.
 */
function parseJobs(value) {
  if (value === undefined) return DEFAULT_JOBS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error(`--jobs ${value}: expected an integer from 1 to 64`);
  return n;
}

/**
 * `--engine-root dir` (or `ENGINE_ROOT`): the checkout whose Endireitar
 * engine the straighten suites run — this one by default, or another
 * worktree to score a prototype with this bench's metrics.
 */
function parseEngineRoot(value) {
  const root = resolve(value ?? process.env.ENGINE_ROOT ?? ROOT);
  if (!existsSync(join(root, "src/lib/dewarp/index.ts"))) {
    throw new Error(`--engine-root ${root}: no src/lib/dewarp/index.ts there — not a checkout of this library`);
  }
  return root;
}

/** `--only regex`: narrow a straighten run to the scene ids it matches (a different sample: never compared with a full one). */
function parseOnly(value) {
  if (value === undefined) return null;
  try {
    new RegExp(value);
  } catch (error) {
    throw new Error(`--only ${value}: not a regular expression (${error?.message ?? error})`);
  }
  return value;
}

/**
 * `--viewport WxH`: the phone's CSS viewport for the session, real-video and
 * WebKit runs (default 390×844). Tall phones crop a full-bleed layout's video
 * differently, so a run records it (`config.viewport`, null = the default).
 */
function parseViewport(value) {
  if (value === undefined) return null;
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value);
  if (match === null) throw new Error(`--viewport ${value}: expected WxH in CSS px, e.g. 412x891`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * `--fit`: force the capture layout's video fit (a bench-only probe setting,
 * `probeSetting("fit")`) — to evaluate fit policies on one build. Absent,
 * the layout's own choice.
 */
const FITS = ["cover", "contain", "maxcrop"];
function parseFit(value) {
  if (value === undefined) return null;
  if (!FITS.includes(value)) throw new Error(`--fit ${value}: expected one of ${FITS.join(", ")}`);
  return value;
}

/**
 * `--layout`: the capture layout the session and real-video suites drive
 * (`captureLayout` on `<ScanFlow>`); absent, the library's default (`rail`).
 * Checked here because the library itself falls back to the default on a
 * typo — a bench run must not silently measure another screen.
 */
const LAYOUTS = ["rail", "standard", "classic", "filmstrip", "onehand", "collapse"];
function parseLayout(value) {
  if (value === undefined) return null;
  if (!LAYOUTS.includes(value)) throw new Error(`--layout ${value}: expected one of ${LAYOUTS.join(", ")}`);
  return value;
}

/** `--lane main|worker`: force the app's detection lane (a bench knob, through the probe). */
function parseLane(value) {
  if (value === undefined) return null;
  if (value !== "main" && value !== "worker") throw new Error(`--lane ${value}: expected main or worker`);
  return value;
}

/**
 * The `--compare` baseline, read now: the path may be the `latest-<suite>`
 * link this run is about to move.
 */
function readPrevious(path) {
  let file;
  try {
    file = realpathSync(resolve(path));
  } catch {
    throw new Error(`--compare ${path}: no such file`);
  }
  let results;
  try {
    results = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`--compare ${path}: not a results.json (${error?.message ?? error})`);
  }
  if (typeof results?.suite !== "string" || typeof results?.summary !== "object") {
    throw new Error(`--compare ${path}: not a bench results.json`);
  }
  // An older schema measured other things under the same names: refused now,
  // before anything runs, rather than compared into a verdict.
  if ((results.schema ?? 1) !== RESULTS_SCHEMA) {
    throw new Error(
      `--compare ${path}: a schema ${results.schema ?? 1} results.json; this bench writes schema ${RESULTS_SCHEMA} ` +
        "and will not compare across them — re-run the baseline with this bench",
    );
  }
  return { path, file, results };
}

/**
 * With `--setting`: for each family, the first `perSetting` seeds whose scene
 * samples each named setting, in seed order. A family that samples none of
 * them is left out; a setting no family samples is an error.
 */
function seedsBySetting(families, settings, perSetting, size) {
  const plan = {};
  const seen = new Set();
  for (const family of families) {
    const found = new Map(settings.map((setting) => [setting, []]));
    for (let seed = 1; seed <= SETTING_SEARCH_LIMIT; seed += 1) {
      const setting = buildScene(family, seed, { size }).setting;
      // A family that samples no setting at all has none of them.
      if (setting === undefined) break;
      const list = found.get(setting);
      if (list !== undefined && list.length < perSetting) list.push(seed);
      if ([...found.values()].every((list) => list.length >= perSetting)) break;
    }
    for (const [setting, list] of found) if (list.length > 0) seen.add(setting);
    const seeds = [...found.values()].flat().sort((a, b) => a - b);
    if (seeds.length > 0) plan[family] = seeds;
  }
  const missing = settings.filter((setting) => !seen.has(setting));
  if (missing.length > 0) throw new Error(`--setting: no scene of ${families.join(", ")} samples ${missing.join(", ")}`);
  return plan;
}

function gitState() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
    return { commit, dirty };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

/**
 * Where a run writes. Synthetic runs default into `.bench-out/`; an explicit
 * `--out` inside the repository must still be under it. Real runs go to the
 * cache and may never land inside the repository at all.
 */
function outputDir(suite, synthetic, requested) {
  const dir = requested === null
    ? join(synthetic ? OUT_DIR : realRunsDir(), `${suite}-${stamp()}`)
    : resolve(requested);
  if (synthetic) {
    if (isInside(dir, ROOT) && !isInside(dir, OUT_DIR)) {
      throw new Error(`--out ${dir}: inside the repository, synthetic output belongs under .bench-out/`);
    }
  } else if (isInside(dir, ROOT)) {
    throw new Error(`--out ${dir}: real-media output may never be written inside the repository`);
  }
  return dir;
}

async function main() {
  const options = parse();
  // Real media: only through SCAN_REAL_MEDIA, extracted into the cache before
  // anything is served. `all` without it runs the synthetic suites only.
  const real = options.suites.filter((name) => !SUITES[name].synthetic);
  if (real.length > 0) {
    if (realMediaDir() === null) {
      if (!options.all) throw new Error(`--suite ${real.join(",")} needs SCAN_REAL_MEDIA=<directory of real photos and clips>`);
      log(`bench: skipping ${real.join(", ")} — SCAN_REAL_MEDIA is not set`);
      options.suites = options.suites.filter((name) => SUITES[name].synthetic);
    } else {
      // Clips are decoded (ffmpeg) only for the suite that plays them.
      options.real = prepareRealMedia({ log, clips: options.suites.includes("real-video") });
    }
  }
  if (options.settings !== null && options.suites.some((name) => name !== "detector" && name !== "emulator")) {
    throw new Error("--setting narrows the detector and emulator suites only");
  }
  if (options.compare !== null && !options.suites.includes(options.compare.results.suite)) {
    throw new Error(
      `--compare ${options.compare.path} is a ${options.compare.results.suite} run; this command runs ${options.suites.join(", ")}`,
    );
  }
  const git = gitState();
  // A command that runs only Node suites (straighten) builds and launches nothing.
  const needsBrowser = options.suites.some((name) => SUITES[name].runtime !== "node");
  let server = null;
  let browser = null;
  let executable = null;
  if (needsBrowser) {
    log(`bench: building the bench page from the working tree (${git.commit}${git.dirty ? ", dirty" : ""})`);
    // The session and real-video suites drive the real <ScanFlow>, whose layout
    // (and so the probe's visible crop) needs the library's stylesheet.
    ensureRuntimeAssets({ log, styles: true });
    await buildBenchApp();
    server = await startServer({ log });
    ({ browser, executable } = await launchChromium({ headed: options.headed }));
    log(`bench: ${server.url} · chromium ${executable}`);
  } else {
    log(`bench: Node suites only (${git.commit}${git.dirty ? ", dirty" : ""}) — no bench page, no browser`);
  }
  let exitCode = 0;
  try {
    let page = null;
    let throttle = null;
    let init = null;
    const pageErrors = [];
    if (needsBrowser) {
      page = await browser.newPage();
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      page.on("console", (message) => {
        if (message.type() === "error") log(`[page] ${message.text().slice(0, 400)}`);
      });
      await page.goto(`${server.url}/bench.html`);
      await page.waitForFunction(() => window.__benchReady === true, null, { timeout: 60_000 });
      init = await page.evaluate(() => window.__bench.init({ assetBase: "/assets/" }));
      if (!init.mlReady) log("bench: WARNING — the ML runtime did not come up; ML rows will be fallbacks");
      log(`bench: ML ready ${init.mlReady} (warm-up ${init.mlWarmUpMs.toFixed(0)} ms) · WebGL ${init.renderer}`);
      throttle = await cpuThrottle(page);
    }
    const knownFamilies = init?.families.map((f) => f.id) ?? [];
    let families = options.families ?? knownFamilies;
    for (const family of init === null ? [] : families) {
      if (!knownFamilies.includes(family)) {
        throw new Error(`unknown family "${family}" (registered: ${knownFamilies.join(", ")})`);
      }
    }
    const seedPlan = options.settings === null ? null : seedsBySetting(families, options.settings, options.seeds, options.size);
    if (seedPlan !== null) {
      families = families.filter((family) => family in seedPlan);
      log(`bench: --setting ${options.settings.join(",")}: ${families.map((f) => `${f} ${seedPlan[f].length} scenes`).join(", ")}`);
    }
    for (const variant of init === null ? [] : options.variants) {
      if (!(variant in init.variants)) {
        throw new Error(`unknown variant "${variant}" (known: ${Object.keys(init.variants).join(", ")})`);
      }
    }

    for (const suiteName of options.suites) {
      const suite = SUITES[suiteName];
      if (!suite.implemented) {
        if (options.all) {
          log(`bench: skipping ${suiteName} — not implemented yet`);
          continue;
        }
        throw new Error(`the ${suiteName} suite is not implemented yet (Phase 1, stage 3)`);
      }
      const outDir = outputDir(
        suiteName,
        suite.synthetic,
        options.out !== null && options.suites.length > 1 ? join(options.out, suiteName) : options.out,
      );
      mkdirSync(outDir, { recursive: true });
      const environment = suite.runtime === "node"
        ? { runtime: "node", node: process.version, platform: `${process.platform}-${process.arch}`, cpus: cpus().length }
        : {
            executable,
            renderer: init.renderer,
            userAgent: init.userAgent,
            mlReady: init.mlReady,
            mlWarmUpMs: init.mlWarmUpMs,
            variants: init.variants,
          };
      const config = suite.config !== undefined
        ? suite.config(options)
        : suite.synthetic
        ? {
            families,
            seeds: suiteName === "session" ? options.sessionSeeds : options.seeds,
            ...(seedPlan === null ? {} : { settings: options.settings, seedPlan }),
            variants: options.variants,
            cpu: options.cpu,
            size: options.size,
            frame: frameSize(options.size),
            ...(suiteName === "session"
              ? {
                  sessions: options.sessions,
                  stream: options.stream,
                  lane: options.lane,
                  layout: options.layout ?? "rail",
                  viewport: options.viewport === null ? null : `${options.viewport.width}x${options.viewport.height}`,
                  fit: options.fit,
                  frameBy: options.frameBy,
                  streamScale: options.streamScale,
                }
              : {}),
          }
        : {
            variants: options.variants,
            cpu: options.cpu,
            media: options.real.media,
            skipReplay: options.skipReplay,
            ...(suiteName === "real-video" ? { layout: options.layout ?? "rail" } : {}),
          };
      const comparing = options.compare !== null && options.compare.results.suite === suiteName;
      // Refuse an incomparable baseline now, not after the run.
      if (comparing) checkComparable(options.compare.results, { schema: RESULTS_SCHEMA, suite: suiteName, synthetic: suite.synthetic, config });
      const result = await suite.run({
        page,
        throttle,
        options: { ...options, families, seedPlan },
        outDir,
        log,
        environment,
        config,
      });
      const results = {
        schema: RESULTS_SCHEMA,
        suite: suiteName,
        synthetic: result.synthetic,
        createdAt: new Date().toISOString(),
        git,
        config,
        environment: { ...environment, ...(result.environment ?? {}) },
        families: init?.families ?? [],
        summary: result.summary,
        sheets: result.sheets,
        scenes: result.scenes,
        rows: result.rows,
        ...(result.labels ? { labels: result.labels } : {}),
        ...(result.extraction ? { extraction: result.extraction } : {}),
      };
      writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 1));
      const report = result.render(results);
      writeFileSync(join(outDir, "report.md"), report + "\n");
      if (suite.synthetic && isInside(outDir, OUT_DIR)) {
        const latest = join(OUT_DIR, `latest-${suiteName}`);
        rmSync(latest, { force: true });
        try {
          symlinkSync(relative(OUT_DIR, outDir), latest);
        } catch {
          // A filesystem without symlinks just goes without the shortcut.
        }
      }
      if (result.failed !== undefined && result.failed.length > 0) {
        log(`bench: ${suiteName} FAILED for ${result.failed.join(", ")} — see the report`);
        exitCode = 1;
      }
      log(`\nbench: ${suiteName} → ${outDir}`);
      log(`       report ${join(outDir, "report.md")}`);
      log(`       results ${join(outDir, "results.json")}`);

      if (comparing) {
        const { table, regressions } = compareSummaries(options.compare.results, results);
        log(`\ncompare against ${options.compare.path} (${options.compare.results.createdAt ?? "undated"}):\n${table}`);
        if (regressions.length > 0) {
          log(`\nREGRESSIONS beyond tolerance or absolute limits:\n  ${regressions.join("\n  ")}`);
          exitCode = 1;
        } else {
          log("\nno regressions beyond tolerance; absolute limits met");
        }
      } else {
        // Without a baseline the absolute limits still say something.
        const breaches = absoluteViolations(results);
        if (breaches.length > 0) log(`\nbench: absolute limits not met (fails --compare):\n  ${breaches.join("\n  ")}`);
      }
    }
    if (pageErrors.length > 0) {
      log(`\nbench: uncaught page errors:\n  ${pageErrors.slice(0, 5).join("\n  ")}`);
      exitCode = exitCode || 1;
    }
  } finally {
    await browser?.close();
    await server?.close();
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`\nbench: ${error?.message ?? error}`);
  process.exit(2);
});

