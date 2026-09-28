/**
 * What the app costs the page it runs in, watched from outside it: the
 * session page installs this before it mounts `<ScanFlow>` and reads it when
 * the run ends. Bench-only; nothing under `src/` knows it exists.
 *
 *  - **long tasks** — every main-thread task over 50 ms (`PerformanceObserver`
 *    `longtask`; Chromium only — elsewhere the list stays empty and says so);
 *  - **heap** — `performance.memory` once a second (Chromium; precise with
 *    `--enable-precise-memory-info`, which the bench's browser is launched
 *    with);
 *  - **workers** — every `Worker` the page constructs, and whether it was
 *    terminated;
 *  - **image bitmaps** — every `ImageBitmap` the app makes through the global
 *    `createImageBitmap` (the player's own decodes go through the browser's
 *    function, taken before this wraps it), and what became of it: closed,
 *    transferred to a worker (the page's copy detached), still open, or
 *    collected by the garbage collector without ever being closed — the one
 *    that holds a camera frame until a GC happens to run.
 *
 * Only numbers leave here; no pixel, and nothing about the page's content.
 */

const LONG_TASK_MS = 50;
const MEMORY_EVERY_MS = 1000;

export function installPerfWatch() {
  const startedAt = performance.now();
  const longTasks = [];
  let longTaskSupported = false;
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime >= startedAt) longTasks.push({ start: entry.startTime, ms: entry.duration });
      }
    });
    observer.observe({ type: "longtask", buffered: false });
    longTaskSupported = PerformanceObserver.supportedEntryTypes?.includes("longtask") ?? false;
  } catch {
    observer = null;
  }

  /**
   * Long animation frames (Chromium): the same blocked time as the long
   * tasks, attributed to the scripts that ran in them — which function,
   * called how, for how long — so a report can say *what* blocked the page.
   */
  const frames = [];
  let frameObserver = null;
  try {
    frameObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime < startedAt) continue;
        frames.push({
          start: entry.startTime,
          ms: entry.duration,
          blockingMs: entry.blockingDuration,
          scripts: (entry.scripts ?? []).map((script) => ({
            ms: script.duration,
            invoker: script.invoker,
            type: script.invokerType,
            fn: script.sourceFunctionName,
            file: String(script.sourceURL ?? "").split("/").pop(),
          })),
        });
      }
    });
    frameObserver.observe({ type: "long-animation-frame", buffered: false });
  } catch {
    frameObserver = null;
  }

  const memory = [];
  const sampleMemory = () => {
    const m = performance.memory;
    if (m !== undefined) memory.push({ at: performance.now(), used: m.usedJSHeapSize, total: m.totalJSHeapSize });
  };
  sampleMemory();
  const memoryTimer = setInterval(sampleMemory, MEMORY_EVERY_MS);

  /**
   * Every app bitmap: its record is updated when it is closed; a poll notices
   * one whose page copy went to zero size without a close (transferred); the
   * registry notices one collected while still open.
   */
  const bitmaps = [];
  const byBitmap = new WeakMap();

  /** Every worker constructed: `{ url, name, createdAt, terminatedAt }`. */
  const workers = [];
  const NativeWorker = window.Worker;
  if (typeof NativeWorker === "function") {
    class WatchedWorker extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.benchRecord = { url: String(url), name: options?.name ?? null, createdAt: performance.now(), terminatedAt: null };
        workers.push(this.benchRecord);
      }

      terminate() {
        this.benchRecord.terminatedAt ??= performance.now();
        super.terminate();
      }

      postMessage(message, transfer) {
        // A bitmap handed over is the worker's to close: the page's copy is detached.
        const list = Array.isArray(transfer) ? transfer : (transfer?.transfer ?? []);
        for (const item of list) {
          const record = byBitmap.get(item);
          if (record !== undefined && !record.closed) record.transferred = true;
        }
        return super.postMessage(message, transfer);
      }
    }
    window.Worker = WatchedWorker;
  }

  const collected = new FinalizationRegistry((record) => {
    if (!record.closed && !record.transferred) record.collectedOpen = true;
    record.collected = true;
  });
  const nativeCreate = typeof window.createImageBitmap === "function" ? window.createImageBitmap.bind(window) : null;
  if (nativeCreate !== null) {
    window.createImageBitmap = async (...args) => {
      const bitmap = await nativeCreate(...args);
      const record = { at: performance.now(), width: bitmap.width, height: bitmap.height, closed: false, transferred: false, collected: false, collectedOpen: false, ref: new WeakRef(bitmap) };
      bitmaps.push(record);
      byBitmap.set(bitmap, record);
      collected.register(bitmap, record);
      return bitmap;
    };
  }
  const nativeClose = typeof ImageBitmap === "function" ? ImageBitmap.prototype.close : null;
  if (nativeClose !== null) {
    ImageBitmap.prototype.close = function close() {
      const record = byBitmap.get(this);
      if (record !== undefined && !record.transferred) record.closed = true;
      return nativeClose.call(this);
    };
  }
  const pollTransfers = () => {
    for (const record of bitmaps) {
      if (record.closed || record.transferred || record.collected) continue;
      const bitmap = record.ref.deref();
      if (bitmap !== undefined && bitmap.width === 0 && bitmap.height === 0) record.transferred = true;
    }
  };
  const pollTimer = setInterval(pollTransfers, 200);

  async function collectGarbage() {
    if (typeof globalThis.gc !== "function") return false;
    for (let i = 0; i < 3; i += 1) {
      globalThis.gc();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  return {
    /** Everything so far, in numbers. `settle` runs the GC first (when the page may) so collected bitmaps are counted. */
    async report({ settle = false, from = startedAt, to = performance.now() } = {}) {
      pollTransfers();
      const gc = settle ? await collectGarbage() : false;
      pollTransfers();
      let open = 0;
      for (const record of bitmaps) {
        if (record.closed || record.transferred || record.collected) continue;
        const bitmap = record.ref.deref();
        if (bitmap === undefined) continue;
        if (bitmap.width > 0) open += 1;
      }
      const inWindow = longTasks.filter((task) => task.start >= from && task.start <= to);
      return {
        from,
        to,
        windowMs: to - from,
        longTaskSupported,
        longTasks: inWindow.map((task) => ({ start: task.start, ms: task.ms })),
        longFrames: frames.filter((f) => f.start >= from && f.start <= to),
        memorySupported: memory.length > 0,
        memory: memory.filter((m) => m.at >= from - MEMORY_EVERY_MS && m.at <= to + MEMORY_EVERY_MS),
        workers: workers.map((w) => ({ ...w })),
        bitmaps: {
          created: bitmaps.length,
          closed: bitmaps.filter((b) => b.closed).length,
          transferred: bitmaps.filter((b) => b.transferred).length,
          open,
          collectedOpen: bitmaps.filter((b) => b.collectedOpen).length,
          gcRan: gc,
        },
      };
    },
    /** Marks where later numbers are read from (e.g. the live session, not the remounts). */
    now: () => performance.now(),
    stop() {
      observer?.disconnect();
      frameObserver?.disconnect();
      clearInterval(memoryTimer);
      clearInterval(pollTimer);
    },
  };
}

export { LONG_TASK_MS };
