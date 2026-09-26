/**
 * Chromium for the bench, and the CPU throttle.
 *
 * Playwright pins one Chromium revision per release, and a machine can easily
 * have a different one cached (this one: Playwright 1.63 wants 1243, the cache
 * holds 1234). The bench does not refuse to run over that: it tries
 * Playwright's own build first, then `SCAN_BENCH_CHROMIUM` if set, then the
 * newest `chromium-*` already in Playwright's cache.
 *
 * WebGL is pinned to SwiftShader so a scene renders the same pixels on every
 * machine with the same browser build, GPU or none. 2-D canvas is kept on the
 * CPU: the detectors read their input back with `getImageData`, and a canvas
 * rasterized on (software) GPU made every ML pass ~3× slower than on a phone —
 * a latency column measuring the bench instead of the detector.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const RENDER_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--disable-accelerated-2d-canvas",
  // A backgrounded bench tab must not have its timers throttled.
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

function playwrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  if (platform() === "win32") return join(homedir(), "AppData", "Local", "ms-playwright");
  return join(homedir(), ".cache", "ms-playwright");
}

const EXECUTABLES = [
  ["chrome-linux64", "chrome"],
  ["chrome-linux", "chrome"],
  ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-win64", "chrome.exe"],
  ["chrome-win", "chrome.exe"],
];

/** The newest Chromium already in Playwright's cache, or null. */
export function cachedChromium() {
  const cache = playwrightCache();
  if (!existsSync(cache)) return null;
  const builds = readdirSync(cache)
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((match) => match !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [name] of builds) {
    for (const parts of EXECUTABLES) {
      const candidate = join(cache, name, ...parts);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @returns {Promise<{ browser: import("@playwright/test").Browser, executable: string }>}
 */
export async function launchChromium({ headed = false, args = [] } = {}) {
  const { chromium } = await import("@playwright/test");
  const options = { headless: !headed, args: [...RENDER_ARGS, ...args] };
  const override = process.env.SCAN_BENCH_CHROMIUM;
  if (override) {
    if (!existsSync(override)) throw new Error(`SCAN_BENCH_CHROMIUM=${override} does not exist`);
    return { browser: await chromium.launch({ ...options, executablePath: override }), executable: override };
  }
  try {
    return { browser: await chromium.launch(options), executable: "playwright default" };
  } catch (error) {
    if (!/Executable doesn't exist/.test(String(error?.message))) throw error;
    const cached = cachedChromium();
    if (cached === null) {
      throw new Error(
        "Playwright's Chromium is not installed and none is cached. Run " +
          "`npx playwright install chromium`, or set SCAN_BENCH_CHROMIUM to a Chromium binary.",
      );
    }
    return { browser: await chromium.launch({ ...options, executablePath: cached }), executable: cached };
  }
}

/**
 * CDP CPU throttling for a page. `rate` 1 is no throttle; 4 is roughly a
 * mid-range Android phone against a desktop, 6 a low-end one.
 */
export async function cpuThrottle(page) {
  const session = await page.context().newCDPSession(page);
  let current = 1;
  return {
    async set(rate) {
      if (rate === current) return;
      await session.send("Emulation.setCPUThrottlingRate", { rate });
      current = rate;
    },
    get rate() {
      return current;
    },
  };
}
