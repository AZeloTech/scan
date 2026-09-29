#!/usr/bin/env node
/**
 * The bench's static server. Loopback only, a random free port, nothing
 * invented: a path that does not exist is a real 404.
 *
 * It serves
 *  - `/<page>.html` — a shell for each bench page in `.bench-out/app/`;
 *  - `/app/*` — the bench bundle;
 *  - `/assets/*` — the library's runtime files, what `assetBaseUrl` points at;
 *  - `/styles.css` — the library's compiled stylesheet (`dist/styles.css`);
 *  - `/real/*` — **only when `SCAN_REAL_MEDIA` is set**, read-only:
 *    `/real/items.json` (every real image the bench knows, `real.mjs`),
 *    `/real/stills/<path>` (exactly the stills `real.mjs` discovers — an
 *    allowlist, not a directory listing) and `/real/frames/*` (video frames
 *    already extracted into the cache);
 *  - `GET|POST /labels` — the labelling page's hand-made corner labels, and
 *    `GET /labels/info` — where they are written, and why there. A POST is
 *    **merged** into the file, item by item, newest `t` winning: a tab opened
 *    an hour ago saves its own work without erasing what another tab saved
 *    since. The version it replaces is kept in the cache.
 *
 * Real media and anything derived from it never leave this machine: the
 * server binds 127.0.0.1, answers only requests addressed to that host, and
 * the labels it writes go either next to the real media — into a directory
 * git ignores there, checked again before every write — or into the cache.
 *
 * Run directly (`node scripts/bench/server.mjs`) it builds the bench app,
 * prints its URL and stays up until interrupted.
 */

import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_ASSETS_DIR,
  APP_BUILD_DIR,
  ASSETS_DIR,
  DIST_DIR,
  FRAME_CACHE_DIR,
  ROOT,
  cacheDir,
  isInside,
  realFramesDir,
  realMediaDir,
} from "./paths.mjs";
import { emptyLabels, mergeLabels, validateLabels } from "./labels.mjs";
import { readLabels, realItems, stillAllowlist } from "./real.mjs";

export { LABELS_VERSION, validateLabels } from "./labels.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".ort": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".icc": "application/octet-stream",
};

/** Largest labels document accepted: a few hundred items is a few hundred KB. */
const MAX_LABELS_BYTES = 5 * 1024 * 1024;

/** Largest frame-cache file accepted: one JPEG frame, or a session's manifest of per-frame truth. */
const MAX_FRAME_CACHE_BYTES = 32 * 1024 * 1024;

/** `/frame-cache/<key>/<file>`: a key the runner derived, a frame or the manifest. */
const FRAME_CACHE_PATH = /^\/frame-cache\/([A-Za-z0-9._-]{1,160})\/(\d{1,5}\.jpg|manifest\.json)$/;

/** A file under `root`, or null when the request path tries to leave it. */
function under(root, requestPath) {
  const base = resolve(root);
  const target = normalize(join(base, requestPath));
  return target === base || target.startsWith(base + sep) ? target : null;
}

function pageShell(name) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>scan bench — ${name}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/app/${name}.js"></script>
</body>
</html>
`;
}

/**
 * git with none of the caller's `GIT_*` settings: `GIT_DIR`, `GIT_WORK_TREE`
 * or `GIT_CEILING_DIRECTORIES` would make it answer about some other
 * repository than the one the labels file sits in.
 */
function git(args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", args, { stdio: "pipe", env, encoding: "utf8" });
}

/** The nearest directory at or above `dir` holding a `.git`, or null. */
function gitMarkerAbove(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

/** Whether git says `path` is ignored in its work tree: exit 0 yes, anything else no. */
function ignoredByGit(dir, path) {
  try {
    git(["-C", dir, "check-ignore", "-q", path]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where hand labels are written, and whether that is allowed.
 *
 * `SCAN_BENCH_LABELS`, else `$SCAN_REAL_MEDIA/scan-bench-labels.json`. A target
 * inside a git work tree must be git-ignored there (that is what keeps it out
 * of a commit), a target inside THIS repository is never allowed, and anything
 * that fails either check falls back to the cache.
 *
 * **Fails closed.** A target counts as outside any work tree only when no
 * `.git` sits in any directory above it *and* git itself, asked, says "not a
 * git repository". git missing, git refusing the repository ("dubious
 * ownership"), any other error: the cache. Called again before every write.
 */
export function resolveLabelsPath() {
  const fallback = join(cacheDir(), "labels", "scan-bench-labels.json");
  const media = realMediaDir();
  const explicit = process.env.SCAN_BENCH_LABELS;
  const candidate = explicit ? resolve(explicit) : media === null ? null : join(media, "scan-bench-labels.json");
  if (candidate === null) return { path: fallback, reason: "no SCAN_REAL_MEDIA or SCAN_BENCH_LABELS" };
  if (isInside(candidate, ROOT)) return { path: fallback, reason: `${candidate} is inside this repository` };
  if (candidate === fallback) return { path: fallback, reason: "the cache" };
  const dir = dirname(candidate);
  if (!existsSync(dir)) return { path: fallback, reason: `${dir} does not exist` };
  const marker = gitMarkerAbove(dir);
  let inRepo;
  try {
    git(["-C", dir, "rev-parse", "--show-toplevel"]);
    inRepo = true;
  } catch (error) {
    const said = String(error?.stderr ?? "");
    if (typeof error?.status !== "number" || !/not a git repository/i.test(said)) {
      const why = error?.code === "ENOENT" ? "git is not installed" : said.trim().split("\n")[0] || String(error?.message ?? error);
      return { path: fallback, reason: `could not ask git whether ${dir} is in a work tree (${why})` };
    }
    inRepo = false;
  }
  if (!inRepo && marker === null) return { path: candidate, reason: "outside any git work tree" };
  if (!inRepo) return { path: fallback, reason: `${marker} holds a .git that git does not recognise` };
  // The temporary file the write goes through lands next to the target too.
  if (ignoredByGit(dir, candidate) && ignoredByGit(dir, `${candidate}.tmp`)) {
    return { path: candidate, reason: "git-ignored in its work tree" };
  }
  return { path: fallback, reason: `${candidate} is NOT git-ignored in its work tree` };
}

/** Where the version a save replaced is kept: the cache, never next to the media. */
function labelsBackupPath() {
  return join(cacheDir(), "labels", "scan-bench-labels.previous.json");
}

function readBytes(request, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readBody(request) {
  return (await readBytes(request, MAX_LABELS_BYTES)).toString("utf8");
}

async function sendFile(response, file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

/**
 * @param {{ appDir?: string, log?: (line: string) => void }} options
 * @returns {Promise<{ url: string, port: number, labels: { path: string, reason: string } | null, close: () => Promise<void> }>}
 */
export function startServer({ appDir = APP_BUILD_DIR, log = () => {} } = {}) {
  const media = realMediaDir();
  const labelling = media !== null || Boolean(process.env.SCAN_BENCH_LABELS);
  const labels = labelling ? resolveLabelsPath() : null;
  let origin = "";

  async function handle(request, response) {
    // Loopback only: a request addressed to any other host name is a DNS
    // rebinding attempt or a mistake, and gets nothing.
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400, { "content-type": "text/plain" }).end("malformed path");
      return;
    }

    if (path === "/labels/info" || path === "/labels") {
      if (!labelling) {
        response.writeHead(404, { "content-type": "text/plain" }).end("labelling needs SCAN_REAL_MEDIA");
        return;
      }
      // Decided again on every request: what was git-ignored at start-up may not be now.
      const target = resolveLabelsPath();
      if (path === "/labels/info") {
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(target));
        return;
      }
      if (request.method === "GET") {
        const body = existsSync(target.path) ? readFileSync(target.path, "utf8") : JSON.stringify(emptyLabels());
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
        return;
      }
      if (request.method === "POST") {
        const sender = request.headers.origin;
        if (sender !== undefined && sender !== origin && sender !== origin.replace("127.0.0.1", "localhost")) {
          response.writeHead(403).end();
          return;
        }
        let doc;
        try {
          doc = JSON.parse(await readBody(request));
        } catch (error) {
          response.writeHead(400, { "content-type": "text/plain" }).end(String(error?.message ?? error));
          return;
        }
        const problem = validateLabels(doc);
        if (problem !== null) {
          response.writeHead(400, { "content-type": "text/plain" }).end(problem);
          return;
        }
        let current;
        try {
          current = readLabels(target.path);
        } catch (error) {
          // Never write over a file this server cannot read: it may be the only copy.
          response.writeHead(409, { "content-type": "text/plain" }).end(`not saved — ${error?.message ?? error}`);
          return;
        }
        const { merged, keptNewer } = mergeLabels(current, doc);
        mkdirSync(dirname(target.path), { recursive: true });
        if (existsSync(target.path)) {
          mkdirSync(dirname(labelsBackupPath()), { recursive: true });
          copyFileSync(target.path, labelsBackupPath());
        }
        const temporary = `${target.path}.tmp`;
        writeFileSync(temporary, JSON.stringify(merged, null, 2));
        renameSync(temporary, target.path);
        log(`labels: ${Object.keys(merged.items).length} item(s) → ${target.path}${keptNewer.length > 0 ? ` (kept ${keptNewer.length} newer from another tab)` : ""}`);
        response
          .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify({ saved: target.path, reason: target.reason, keptNewer, doc: merged }));
        return;
      }
      response.writeHead(405).end();
      return;
    }

    const cached = FRAME_CACHE_PATH.exec(path);
    if (cached !== null) {
      // Synthetic frames only, in the git-ignored output: the session page
      // writes what it rendered and reads it back on the next run.
      const file = join(FRAME_CACHE_DIR, cached[1], cached[2]);
      if (request.method === "PUT") {
        const sender = request.headers.origin;
        if (sender !== undefined && sender !== origin) {
          response.writeHead(403).end();
          return;
        }
        const body = await readBytes(request, MAX_FRAME_CACHE_BYTES);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, body);
        renameSync(`${file}.tmp`, file);
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET") return sendFile(response, file);
      response.writeHead(405).end();
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    if (path === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const page = /^\/(?:([a-z0-9-]+)\.html)?$/.exec(path);
    if (page !== null) {
      const name = page[1] ?? "bench";
      if (!existsSync(join(appDir, `${name}.js`))) {
        response.writeHead(404, { "content-type": "text/plain" }).end(`no bench page "${name}"`);
        return;
      }
      response.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" }).end(pageShell(name));
      return;
    }
    if (path === "/styles.css") return sendFile(response, join(DIST_DIR, "styles.css"));
    if (media !== null && path === "/real/items.json") {
      response
        .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        .end(JSON.stringify(realItems()));
      return;
    }
    if (media !== null && path.startsWith("/real/stills/")) {
      // Only a still `real.mjs` discovered, by its exact path: nothing else in
      // SCAN_REAL_MEDIA (a screen recording, a stray file, `..`) is reachable.
      const file = stillAllowlist().get(path.slice("/real/stills/".length));
      if (file === undefined) {
        response.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      return sendFile(response, file);
    }
    // The working tree's own build of an asset the bench stands in for (the
    // detection worker, with the probe on), ahead of the library's copy.
    if (path.startsWith("/assets/")) {
      const override = under(APP_ASSETS_DIR, path.slice("/assets/".length));
      if (override !== null && existsSync(override)) return sendFile(response, override);
    }
    const routes = [
      ["/app/", appDir],
      ["/assets/", ASSETS_DIR],
      ...(media === null ? [] : [["/real/frames/", realFramesDir()]]),
    ];
    for (const [prefix, root] of routes) {
      if (!path.startsWith(prefix)) continue;
      const file = under(root, path.slice(prefix.length));
      if (file === null) {
        response.writeHead(403).end();
        return;
      }
      return sendFile(response, file);
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }

  const server = createServer((request, response) => {
    // One bad request is that request's problem, never the whole bench run's.
    handle(request, response).catch((error) => {
      log(`server: ${request.method} ${request.url}: ${error?.message ?? error}`);
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" }).end("internal error");
      else response.destroy();
    });
  });

  return new Promise((resolveServer, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      origin = `http://127.0.0.1:${port}`;
      resolveServer({
        url: origin,
        port,
        labels,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { buildBenchApp, ensureRuntimeAssets } = await import("./build-app.mjs");
  ensureRuntimeAssets({ styles: true });
  await buildBenchApp();
  const server = await startServer({ log: (line) => console.log(line) });
  console.log(`bench server: ${server.url}/ (loopback only; Ctrl-C to stop)`);
  if (server.labels !== null) console.log(`labels → ${server.labels.path} (${server.labels.reason})`);
}
