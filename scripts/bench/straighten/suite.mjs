/**
 * The straighten suites — Endireitar judged on the page the user would see.
 *
 * Runs in Node, not in the bench page: the engine is TypeScript plus a wasm
 * module with no DOM in its path (the app's worker is replaced by an
 * in-thread stand-in making the same calls), the solve is single-threaded
 * and takes seconds a page, so a run shards its scenes over `--jobs` Node
 * processes (`worker.mjs`) — something one Chromium page cannot do — and the
 * engine can be loaded from any checkout (`--engine-root`) to score a
 * prototype worktree with this bench's metrics.
 *
 * `straighten` renders synthetic scenes (`scenes.mjs`: 279 in `full`, 83 in
 * `--quick`); `straighten-real` puts synthetic tilts into the labelled real
 * stills of `SCAN_REAL_MEDIA` (`real-scenes.mjs`) and writes only into the
 * cache outside the repository.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { labelFor } from "../labels.mjs";
import { discoverRealMedia } from "../real.mjs";
import { realMediaDir } from "../paths.mjs";
import { resolveDeskewMode } from "./deskew-step.mjs";
import { HARD_TIMEOUT_CAP_MS } from "./engine-host.mjs";
import { realMatrix } from "./real-scenes.mjs";
import { renderStraightenReport } from "./report.mjs";
import { SCENE_OPTIONS, sceneProfile } from "./scenes.mjs";
import { summarizeRun, verdict } from "./score.mjs";

const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));

/** Parallel engine processes a run uses unless told otherwise; runtime counts compare only at equal `--jobs`. */
export const DEFAULT_JOBS = 8;

/**
 * Where the engine under test comes from, and exactly which code it is: the
 * checkout's HEAD and, when it has uncommitted changes, a sha256 over its
 * diff against HEAD plus every untracked file (so two runs of "the same dirty
 * worktree" are the same code or visibly not).
 */
export function engineProvenance(root) {
  const git = (args, options = {}) => execFileSync("git", ["-C", root, ...args], { maxBuffer: 256 * 1024 * 1024, ...options });
  try {
    const head = git(["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const hash = createHash("sha256");
    hash.update(git(["diff", "HEAD", "--binary"]));
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter((f) => f !== "" && f !== "node_modules" && !f.startsWith("node_modules/"))
      .sort();
    for (const file of untracked) {
      const path = join(root, file);
      const info = lstatSync(path);
      hash.update(`\0${file}\0`);
      if (info.isFile() && info.size < 32 * 1024 * 1024) hash.update(readFileSync(path));
    }
    const dirty = git(["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" })
      .split("\n")
      .some((line) => line.trim() !== "" && !/ node_modules$/.test(line));
    return { root, head, dirty, patchHash: dirty ? hash.digest("hex").slice(0, 16) : null };
  } catch {
    return { root, head: null, dirty: null, patchHash: null };
  }
}

/** The labelled real stills: `{ id, corners }` for every still with a page label. */
export function labelledStills(labelsDoc) {
  const media = realMediaDir();
  if (media === null) return [];
  const out = [];
  for (const still of discoverRealMedia(media).stills) {
    const label = labelFor(labelsDoc, still.id);
    if (label !== null && !label.noDocument) out.push({ id: still.id, corners: label.quad });
  }
  return out;
}

/** The scene specs a run measures: the profile's, narrowed by `--only`. */
export function straightenSpecs(kind, options, stills = []) {
  let specs = kind === "synthetic" ? sceneProfile(options.profile) : realMatrix(stills, options.profile);
  if (options.only !== null) {
    const re = new RegExp(options.only);
    specs = specs.filter((s) => re.test(s.id));
  }
  if (specs.length === 0) throw new Error(`the ${kind === "synthetic" ? "straighten" : "straighten-real"} suite has no scenes to run${options.only ? ` (--only ${options.only})` : ""}`);
  return specs;
}

const hashOf = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

/**
 * A run's config — what `--compare` checks before anything runs: the sample
 * (profile, scene set, scene rendering, jobs, timeout) must match; the engine
 * and its deskew step are what is being compared, so they may differ.
 */
export function straightenConfig(kind, options, stills = []) {
  const specs = straightenSpecs(kind, options, stills);
  const deskew = resolveDeskewMode(options.deskew, options.engineRoot);
  return {
    profile: options.profile,
    only: options.only,
    scenes: specs.length,
    sceneHash: hashOf(specs),
    ...(kind === "synthetic" ? { scene: { ...SCENE_OPTIONS } } : {}),
    jobs: options.jobs,
    timeoutCapMs: HARD_TIMEOUT_CAP_MS,
    deskew,
    sheets: options.sheets,
    engine: engineProvenance(options.engineRoot),
  };
}

function runShard(job, file, log) {
  writeFileSync(file, JSON.stringify(job));
  return new Promise((resolveShard, reject) => {
    const args = [...(process.features?.typescript ? [] : ["--experimental-strip-types"]), "--no-warnings", WORKER, file];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-4000);
      for (const line of text.split("\n")) if (line.trim() !== "") log(`  ${line}`);
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolveShard() : reject(new Error(`straighten shard exited ${code}: ${tail.split("\n").slice(-5).join(" | ")}`))));
  });
}

/**
 * Run a straighten suite. `options.compare` (the runner's parsed baseline)
 * decides which scenes are "new acts" and "lost fixes" for the sheets.
 */
export async function runStraighten({ kind, options, outDir, log, config, stills = [], banner = null }) {
  const specs = straightenSpecs(kind, options, stills);
  const jobs = Math.max(1, Math.min(options.jobs, specs.length));
  const partDir = join(outDir, "partials");
  rmSync(partDir, { recursive: true, force: true });
  mkdirSync(partDir, { recursive: true });
  const previousRows = options.compare?.results?.suite === (kind === "synthetic" ? "straighten" : "straighten-real") ? options.compare.results.rows ?? [] : null;
  const previous = previousRows === null ? null : Object.fromEntries(previousRows.filter((r) => r.verdict).map((r) => [r.id, r.verdict]));
  const shards = Array.from({ length: jobs }, () => []);
  // Interleaved, so heavy scenes spread and the shards finish together.
  specs.forEach((spec, i) => shards[i % jobs].push(spec));
  log(`bench: ${specs.length} scenes over ${jobs} jobs · engine ${options.engineRoot} · deskew ${config.deskew ?? "off"}`);
  const started = Date.now();
  await Promise.all(
    shards.map((shard, k) =>
      runShard(
        {
          engineRoot: options.engineRoot,
          deskew: config.deskew,
          kind,
          specs: shard,
          sceneOptions: SCENE_OPTIONS,
          mediaDir: kind === "real" ? realMediaDir() : null,
          sheetsDir: options.sheets ? join(outDir, "sheets") : null,
          previous,
          out: join(partDir, `part-${k}.json`),
        },
        join(partDir, `job-${k}.json`),
        log,
      ),
    ),
  );
  const records = [];
  const sheets = [];
  let meta = {};
  for (let k = 0; k < jobs; k += 1) {
    const file = join(partDir, `part-${k}.json`);
    if (!existsSync(file)) continue;
    const part = JSON.parse(readFileSync(file, "utf8"));
    meta = part.meta;
    records.push(...part.records);
    sheets.push(...part.sheets);
  }
  rmSync(partDir, { recursive: true, force: true });
  const order = new Map(specs.map((s, i) => [s.id, i]));
  records.sort((a, b) => order.get(a.id) - order.get(b.id));
  sheets.sort((a, b) => order.get(a.id) - order.get(b.id));
  const measured = new Set(records.map((r) => r.id));
  for (const spec of specs) {
    if (!measured.has(spec.id)) records.push({ id: spec.id, suite: kind, axes: {}, error: "the shard never reported this scene" });
  }
  // The verdict is recomputed here from the stored record: the pure scorer is
  // the one source of truth, whatever the worker thought.
  const rows = records.map((r) => (r.error ? r : { ...r, verdict: verdict(r) }));
  log(`bench: ${records.length} scenes in ${Math.round((Date.now() - started) / 1000)} s`);
  return {
    synthetic: kind === "synthetic",
    summary: summarizeRun(rows),
    sheets,
    scenes: specs.map((s) => ({ ...s })),
    rows,
    environment: meta,
    render: (results) => renderStraightenReport(results, { banner }),
  };
}

