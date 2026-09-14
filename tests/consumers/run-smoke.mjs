#!/usr/bin/env node
/**
 * The test that a build-output assertion cannot replace.
 *
 * This library's hardest failure mode is invisible at build time: the ML
 * detector, the ONNX Runtime and pdf.js each locate their own files at runtime
 * through a string base, inside third-party code. A bundle can be perfectly
 * well-formed and still 404 on a consumer's production build — and it will do
 * that in one bundler and not the other, which is exactly how the old
 * application acquired a postbuild script to paper over it.
 *
 * So: build the library, install it into two real consumer applications (Vite 6
 * and a Next 15 static export), build those, serve them, drive them in a real
 * browser, and fail on any request that leaves the origin or returns 404.
 *
 * Run with `npm run smoke`.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".ort": "application/octet-stream",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".icc": "application/octet-stream",
  ".map": "application/json",
};

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))
    );
  });
}

/** A static server that refuses to invent files: a missing path is a real 404. */
function serve(root) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.includes("..")) {
      response.writeHead(403).end();
      return;
    }
    let file = join(root, path);
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      // fall through to the read, which will 404
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        // The ML path must work without cross-origin isolation, and this is
        // where we prove it: no COOP/COEP headers are sent.
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({ port, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

async function drive(name, port) {
  const { chromium } = await import("@playwright/test");
  /**
   * CI runs `npx playwright install chromium` and gets the build this
   * Playwright expects. A developer machine may already have a working browser
   * from another project and no way to fetch a second one; point this at it
   * rather than making the smoke test unrunnable.
   */
  const executablePath = process.env.SCAN_SMOKE_CHROME;
  const browser = await chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    args: [
      // A deterministic green-and-white pattern stands in for a document. No
      // camera hardware, and no photograph of anything real.
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const context = await browser.newContext({ permissions: ["camera"] });
  const page = await context.newPage();

  const offOrigin = [];
  const notFound = [];
  const origin = `http://127.0.0.1:${port}`;

  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")) {
      offOrigin.push(url);
    }
  });
  page.on("response", (response) => {
    if (response.status() === 404) notFound.push(response.url());
  });
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  // The library speaks to the console only about host wiring mistakes (a bad
  // assetBaseUrl, a second live store). In a correctly wired page it is silent.
  const libraryConsole = [];
  page.on("console", (message) => {
    if (message.text().includes("@azelotech/scan")) {
      libraryConsole.push(`${message.type()}: ${message.text().slice(0, 200)}`);
    }
  });

  await page.goto(origin, { waitUntil: "networkidle" });

  // The page under test drives the library itself and reports through a global,
  // so this file does not have to know the component's internals.
  await page.waitForFunction(() => window.__scanSmoke?.done === true, null, { timeout: 120_000 });
  const report = await page.evaluate(() => window.__scanSmoke);

  await browser.close();

  const failures = [];
  if (report.error) failures.push(`the page reported: ${report.error}`);
  if (!report.mlReady) failures.push("the ML detector never became ready");
  if (!report.pdfBytes) failures.push("no PDF was built");
  if (offOrigin.length > 0) {
    failures.push(
      `${offOrigin.length} off-origin request(s) — this library must never leave the ` +
        `origin:\n      ${offOrigin.slice(0, 10).join("\n      ")}`
    );
  }
  if (notFound.length > 0) {
    failures.push(`${notFound.length} request(s) 404ed:\n      ${notFound.slice(0, 10).join("\n      ")}`);
  }
  if (libraryConsole.length > 0) {
    failures.push(`the library wrote to the console:\n      ${libraryConsole.slice(0, 5).join("\n      ")}`);
  }
  if (consoleErrors.length > 0) {
    failures.push(`uncaught page errors:\n      ${consoleErrors.slice(0, 5).join("\n      ")}`);
  }

  if (failures.length > 0) {
    console.error(`\n${name}: FAILED`);
    for (const failure of failures) console.error("  - " + failure);
    return false;
  }
  console.log(
    `${name}: ok — ML ready, PDF built (${report.pdfBytes} bytes, ${report.pages} page(s)), ` +
      `no off-origin requests, no 404s`
  );
  return true;
}

const consumers = [
  { name: "vite", dir: join(HERE, "vite"), out: "dist", build: ["npm", ["run", "build"]] },
  { name: "next", dir: join(HERE, "next"), out: "out", build: ["npm", ["run", "build"]] },
];

let allPassed = true;
for (const consumer of consumers) {
  if (!existsSync(join(consumer.dir, "package.json"))) {
    console.error(`${consumer.name}: no consumer app at ${consumer.dir} — skipping is not allowed`);
    allPassed = false;
    continue;
  }
  console.log(`\n=== ${consumer.name} consumer ===`);
  await run("npm", ["install", "--no-audit", "--no-fund"], consumer.dir);
  await run(consumer.build[0], consumer.build[1], consumer.dir);
  const server = await serve(join(consumer.dir, consumer.out));
  try {
    const passed = await drive(consumer.name, server.port);
    allPassed &&= passed;
  } finally {
    await server.close();
  }
}

if (!allPassed) {
  console.error("\nsmoke: FAILED\n");
  process.exit(1);
}
console.log("\nsmoke: both consumers green\n");
