import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LABELS_VERSION } from "./labels.mjs";
import { resolveLabelsPath, startServer } from "./server.mjs";

/**
 * The server is where real media meets a browser: it must never write the
 * labels (which name every real photo) into a work tree git would commit,
 * never lose one tab's labels to another's save, and never go down on a
 * request it cannot parse. Everything here lives in a throwaway directory,
 * with the cache pointed into it.
 */

const scratch = mkdtempSync(join(tmpdir(), "scan-bench-server-"));
// The "outside any work tree" cases need a temporary directory that is.
const tmpInRepo = (() => {
  try {
    execFileSync("git", ["-C", scratch, "rev-parse"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
process.env.XDG_CACHE_HOME = join(scratch, "cache");
delete process.env.SCAN_REAL_MEDIA;
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const FALLBACK = join(scratch, "cache", "scan-bench", "labels", "scan-bench-labels.json");

function gitRepo(name, ignore = "") {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "media"), { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, ".gitignore"), ignore);
  return dir;
}

/** `resolveLabelsPath()` under `env`, restoring the environment after. */
function resolveWith(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return resolveLabelsPath();
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("labels go next to the media only when git ignores them there", () => {
  const ignored = gitRepo("ignored", "media/\n");
  const target = join(ignored, "media", "labels.json");
  assert.deepEqual(resolveWith({ SCAN_BENCH_LABELS: target }), { path: target, reason: "git-ignored in its work tree" });
  const tracked = gitRepo("tracked");
  assert.equal(resolveWith({ SCAN_BENCH_LABELS: join(tracked, "media", "labels.json") }).path, FALLBACK);
  if (tmpInRepo) return;
  // Outside any work tree: allowed.
  const loose = join(scratch, "loose");
  mkdirSync(loose, { recursive: true });
  const looseTarget = join(loose, "labels.json");
  assert.equal(resolveWith({ SCAN_BENCH_LABELS: looseTarget }).path, looseTarget);
});

test("a git that cannot answer sends the labels to the cache, never into the work tree", () => {
  const tracked = gitRepo("broken-git");
  const target = join(tracked, "media", "labels.json");
  // GIT_DIR pointing nowhere: stripped, so git still sees the work tree the file is in.
  assert.equal(resolveWith({ SCAN_BENCH_LABELS: target, GIT_DIR: "/nonexistent" }).path, FALLBACK);
  // No git at all.
  const noGit = resolveWith({ SCAN_BENCH_LABELS: target, PATH: "/nonexistent" });
  assert.equal(noGit.path, FALLBACK);
  assert.match(noGit.reason, /could not ask git/);
});

function send(url, { method = "GET", path, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      { host: target.hostname, port: target.port, method, path, headers: body ? { "content-type": "application/json" } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("the server survives a malformed path and merges concurrent saves", { skip: tmpInRepo && "the temporary directory is inside a git work tree" }, async () => {
  const labelsFile = join(scratch, "loose-server", "labels.json");
  mkdirSync(join(scratch, "loose-server"), { recursive: true });
  process.env.SCAN_BENCH_LABELS = labelsFile;
  const server = await startServer();
  try {
    assert.equal((await send(server.url, { path: "/app/%E0%A4%A" })).status, 400);
    assert.equal((await send(server.url, { path: "/" })).status < 500, true, "still up");
    const corners = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
    const doc = (items) => JSON.stringify({ version: LABELS_VERSION, items });
    // Two tabs opened on the same empty file; each saves a different image.
    const first = await send(server.url, { method: "POST", path: "/labels", body: doc({ "a.jpg": { corners, labeller: "x", t: "2026-01-01T00:01:00Z" } }) });
    assert.equal(first.status, 200, first.body);
    const second = await send(server.url, { method: "POST", path: "/labels", body: doc({ "b.jpg": { corners, labeller: "x", t: "2026-01-01T00:02:00Z" } }) });
    assert.equal(second.status, 200, second.body);
    const saved = JSON.parse(readFileSync(labelsFile, "utf8"));
    assert.deepEqual(Object.keys(saved.items).sort(), ["a.jpg", "b.jpg"]);
    assert.deepEqual(Object.keys(JSON.parse(second.body).doc.items).sort(), ["a.jpg", "b.jpg"]);
    // The version the second save replaced is kept in the cache.
    const backup = join(scratch, "cache", "scan-bench", "labels", "scan-bench-labels.previous.json");
    assert.ok(existsSync(backup));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(backup, "utf8")).items), ["a.jpg"]);
    // A file on disk the server cannot read is never overwritten.
    writeFileSync(labelsFile, "{ not json");
    const refused = await send(server.url, { method: "POST", path: "/labels", body: doc({}) });
    assert.equal(refused.status, 409);
    assert.equal(readFileSync(labelsFile, "utf8"), "{ not json");
  } finally {
    await server.close();
    delete process.env.SCAN_BENCH_LABELS;
  }
});
