import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { ScanDiagnosticsEvent, ScanDiagnosticsPayload, ScanEvent } from "@/types";
import {
  cleanValue,
  createDiagnosticsSink,
  diagnosticsSinkFor,
  flowDiagnostic,
  maxCornerMovePct,
  MAX_DEPTH,
  MAX_STRING,
  PASS_SAMPLE_MS,
  PASS_WINDOW_MS,
} from "./diagnostics-events.ts";

/** One of every event the library emits, as its call sites build them. */
const EVERY_PAYLOAD: ScanDiagnosticsPayload[] = [
  {
    type: "session-start",
    layout: "rail",
    autoOffered: true,
    lang: "pt-BR",
    viewport: { width: 412, height: 891 },
    dpr: 3.5,
    safeArea: { top: 24, right: 0, bottom: 16, left: 0 },
    vibrate: true,
  },
  { type: "camera", state: "live", startMs: 812.4, stream: { width: 2160, height: 3840 }, torch: true, fit: "cover" },
  { type: "lane", lane: "worker", reason: "worker" },
  {
    type: "pass",
    detector: "ml",
    detectMs: 41.4,
    detectP50: 38.6,
    intervalMs: 320,
    frameAgeMs: 97.2,
    passes: 2,
    found: true,
    locked: true,
    ready: false,
    autoArmed: true,
    why: "auto: countdown 40 %",
  },
  { type: "visible", x: 0.2, y: 0, width: 0.6, height: 1, fit: "cover" },
  { type: "hint", id: "move-closer", shown: false, ms: 1200 },
  { type: "ready", on: false, ms: 900, why: "camera moved (watch 0.071)" },
  { type: "auto", phase: "fire", ms: 540, reason: null },
  {
    type: "capture",
    trigger: "auto",
    tap: null,
    page: 1,
    ms: 1430,
    still: { width: 3000, height: 4000 },
    source: "still",
    stillReason: null,
    stillMs: 620,
    requested: { width: 4000, height: 3000 },
    stream: { width: 1080, height: 1920 },
    streamCapped: true,
    restore: null,
    fov: { width: 2250, height: 4000 },
    frame: { width: 2250, height: 4000 },
    capped: false,
    canonical: { width: 2250, height: 4000, bytes: 3768926, quality: 0.95 },
    cornersFrom: "detected",
    registration: { fovScale: 1.02, shiftX: 0.01, shiftY: -0.02, score: 0.91, overlap: 0.97 },
    flag: null,
  },
  {
    type: "confirm",
    page: 1,
    result: "adjusted",
    maxMovePct: 3.2,
    ms: 4100,
    seededFrom: "capture",
    flag: "moved",
    source: "still",
    canonical: { width: 2250, height: 4000, bytes: 3768926, quality: 0.95 },
    capped: false,
  },
  {
    type: "render",
    page: 1,
    warped: { width: 2030, height: 2870 },
    final: { width: 2030, height: 2870, bytes: 2102400, quality: 0.92 },
    flat: false,
    dewarped: false,
  },
  { type: "build", page: 1, pages: 1, width: 2030, height: 2870, bytes: 2102400, rung: 0, quality: 0.92, resampled: false },
  { type: "stream-cap", applied: true, reason: "still-proven", stream: { width: 1080, height: 1920 } },
  { type: "visibility", state: "hidden" },
  { type: "camera-resume", ms: 640 },
  { type: "stall", phase: "start", ms: 2100 },
  { type: "page", action: "removed", page: 2 },
  { type: "torch", on: true },
  { type: "auto-toggle", on: true },
  { type: "flow", event: { name: "step", step: "review" } },
];

/** Field names no event may ever have: they would be the start of carrying a picture or a document's words. */
const FORBIDDEN_KEY = /pixel|image|thumb|blob|bitmap|canvas|hash|signature|text|file|url|base64|^data$|luma|crop/i;

function walk(value: unknown, visit: (key: string, inner: unknown) => void): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    visit(key, inner);
    walk(inner, visit);
  }
}

test("every event carries the envelope: version, sequence and time since the flow mounted", () => {
  let now = 1000;
  const got: ScanDiagnosticsEvent[] = [];
  const sink = createDiagnosticsSink((event) => got.push(event), () => now);
  now = 1250.6;
  sink.emit({ type: "torch", on: true });
  now = 1400;
  sink.emit({ type: "auto-toggle", on: false });
  assert.deepEqual(got, [
    { v: 1, seq: 0, t: 251, type: "torch", on: true },
    { v: 1, seq: 1, t: 400, type: "auto-toggle", on: false },
  ]);
});

test("no event carries image data: numbers, booleans, enums and plain objects only", () => {
  const got: ScanDiagnosticsEvent[] = [];
  const sink = createDiagnosticsSink((event) => got.push(event), () => 0);
  for (const payload of EVERY_PAYLOAD) sink.emit(payload);
  assert.equal(got.length, EVERY_PAYLOAD.length);
  const types = new Set(got.map((event) => event.type));
  assert.equal(types.size, EVERY_PAYLOAD.length, "one sample per event type");
  for (const event of got) {
    walk(event, (key, inner) => {
      assert.doesNotMatch(key, FORBIDDEN_KEY, `${event.type}.${key}`);
      assert.ok(
        inner === null || ["number", "boolean", "string", "object"].includes(typeof inner),
        `${event.type}.${key} is ${typeof inner}`,
      );
      assert.ok(!Array.isArray(inner), `${event.type}.${key} is an array`);
      if (typeof inner === "string") {
        assert.ok(inner.length <= MAX_STRING, `${event.type}.${key} is long`);
        assert.doesNotMatch(inner, /^(data|blob):|base64/i, `${event.type}.${key}`);
      }
    });
    const json = JSON.stringify(event);
    assert.ok(json.length < 600, `${event.type} is ${json.length} bytes`);
  }
});

test("the public type declares no field that could carry a picture or a page's words", () => {
  const types = readFileSync(path.join(process.cwd(), "src", "types.ts"), "utf8");
  const start = types.indexOf("export type ScanDiagnosticsPayload");
  assert.ok(start > 0);
  const block = types.slice(start).replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const keys = [...block.matchAll(/([A-Za-z_]\w*)\??:/g)].map((match) => match[1]);
  assert.ok(keys.includes("type") && keys.includes("maxMovePct"));
  for (const key of keys) assert.doesNotMatch(key, FORBIDDEN_KEY, key);
  // No binary type can appear in it either.
  assert.doesNotMatch(block, /Blob|ImageData|ImageBitmap|Uint8|ArrayBuffer|Canvas|File\b/);
});

test("anything that is not a plain value is dropped before it reaches the host", () => {
  class Bitmap {
    width = 4;
  }
  const cleaned = cleanValue({
    a: 1.23456,
    b: Number.NaN,
    c: Infinity,
    d: new Uint8ClampedArray([1, 2, 3]),
    e: [1, 2],
    f: new Bitmap(),
    g: "x".repeat(500),
    h: { i: null, j: () => 1, k: true },
    l: null,
  });
  assert.deepEqual(cleaned, { a: 1.235, g: "x".repeat(MAX_STRING), h: { i: null, k: true }, l: null });
});

test("the host gets a copy: keeping or mutating an event reaches nothing inside", () => {
  const inner = { width: 10, height: 20 };
  let got: ScanDiagnosticsEvent | null = null;
  const sink = createDiagnosticsSink((event) => (got = event), () => 0);
  sink.emit({ type: "camera", state: "live", startMs: 1, stream: inner, torch: false, fit: "cover" });
  assert.ok(got !== null);
  const event = got as ScanDiagnosticsEvent & { type: "camera" };
  assert.notEqual(event.stream, inner);
  (event.stream as { width: number }).width = 99;
  assert.equal(inner.width, 10);
});

test("pass samples go at most twice a second", () => {
  let now = 0;
  const sink = createDiagnosticsSink(() => undefined, () => now);
  let due = 0;
  for (now = 0; now < 10_000; now += 16) if (sink.passDue()) due += 1;
  assert.ok(due <= 10_000 / PASS_SAMPLE_MS + 1, `${due} samples in 10 s`);
  assert.ok(due >= 10_000 / PASS_SAMPLE_MS - 1, `${due} samples in 10 s`);
});

test("a sampler on a half-second timer with jitter keeps its two samples a second", () => {
  let now = 0;
  const sink = createDiagnosticsSink(() => undefined, () => now);
  let due = 0;
  for (let i = 0; i < 40; i += 1) {
    now = i * PASS_SAMPLE_MS + (i % 2 === 0 ? -3 : 2);
    if (sink.passDue()) due += 1;
  }
  assert.equal(due, 40);
  // Asked twice in the same slot: once.
  now += 10;
  assert.equal(sink.passDue(), false);
});

test("no rolling second ever holds a third pass sample, whatever the timer does", () => {
  // The review's counterexample: asked at 0, 400 and 900 ms.
  let now = 0;
  const sink = createDiagnosticsSink(() => undefined, () => now);
  const accepted: number[] = [];
  for (now of [0, 400, 900]) if (sink.passDue()) accepted.push(now);
  assert.ok(accepted.length <= 2, accepted.join(","));
  // …and a jittery timer, asked at random: check every window.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sink2 = createDiagnosticsSink(() => undefined, () => now);
  const times: number[] = [];
  for (now = 0; now < 60_000; now += 20 + random() * 400) if (sink2.passDue()) times.push(now);
  for (let i = 2; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 2] >= PASS_WINDOW_MS, `3 samples within ${times[i] - times[i - 2]} ms`);
  }
  assert.ok(times.length >= 60 * 1.5, `${times.length} samples in 60 s`);
});

test("a cyclic or deep payload is cut off, never recursed into, and the scanner never throws", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => cleanValue(cyclic));
  let depth = 0;
  let cut: unknown = cleanValue(cyclic);
  while (cut !== null && typeof cut === "object" && "self" in cut) {
    cut = (cut as { self: unknown }).self;
    depth += 1;
  }
  assert.ok(depth < MAX_DEPTH, `${depth} levels`);
  // Through the sink, with a host that is fine: the event still arrives.
  const got: ScanDiagnosticsEvent[] = [];
  const sink = createDiagnosticsSink((event) => got.push(event), () => 0);
  const event = { name: "step", step: "review", extra: cyclic } as unknown as ScanEvent;
  assert.doesNotThrow(() => sink.emit({ type: "flow", event }));
  assert.equal(got.length, 1);
  // A getter that throws while being read is swallowed too.
  const hostile = Object.defineProperty({}, "boom", {
    enumerable: true,
    get() {
      throw new Error("getter");
    },
  });
  assert.doesNotThrow(() => sink.emit({ type: "flow", event: hostile as unknown as ScanEvent }));
});

test("a flow event is rebuilt from an allowlist: what a host adds to its own event never travels", () => {
  const every: ScanEvent[] = [
    { name: "step", step: "corners" },
    { name: "capture", page: 1, source: "camera" },
    { name: "retake", page: 2 },
    { name: "remove", page: 3 },
    { name: "reorder", from: 1, to: 2 },
    { name: "dewarp", page: 1, outcome: "applied" },
    { name: "quality", page: 1, verdict: "blurred" },
    { name: "size_ladder", rung: 1, bytes: 1234 },
    { name: "pdf_built", pages: 2, bytes: 4567, ms: 890 },
    { name: "error", code: "camera_denied", recoverable: true },
    { name: "cancel", reason: "user", pages: 0 },
  ];
  for (const event of every) {
    assert.deepEqual(flowDiagnostic(event), event, event.name);
    // The host decorates its event (a name, a note) and the copy stays clean.
    const decorated = { ...event, patientName: "Fulana de Tal", note: "HIV+" } as unknown as ScanEvent;
    const copy = flowDiagnostic(decorated);
    assert.deepEqual(copy, event, event.name);
    assert.doesNotMatch(JSON.stringify(copy), /Fulana|HIV/);
  }
  // Text where an enum belongs, or an unknown name: no event at all.
  assert.equal(flowDiagnostic({ name: "step", step: "Fulana de Tal" } as unknown as ScanEvent), null);
  assert.equal(flowDiagnostic({ name: "error", code: "HIV+", recoverable: true } as unknown as ScanEvent), null);
  assert.equal(flowDiagnostic({ name: "remove", page: "Fulana" } as unknown as ScanEvent), null);
  assert.equal(flowDiagnostic({ name: "patient", page: 1 } as unknown as ScanEvent), null);
});

test("ScanFlow builds the flow copy before the host's onEvent can touch the event", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "ScanFlow.tsx"), "utf8");
  const start = source.indexOf("const emit = useCallback((event: ScanEvent)");
  assert.ok(start > 0);
  const body = source.slice(start, source.indexOf("}, []);", start));
  const built = body.indexOf("flowDiagnostic(event)");
  const handed = body.indexOf("onEvent?.(event)");
  assert.ok(built > 0 && handed > built, "flowDiagnostic runs before onEvent");
  assert.doesNotMatch(body, /emit\(\{ type: "flow", event \}\)/, "the raw event is never emitted");
});

test("a host that throws cannot break the scanner", () => {
  const sink = createDiagnosticsSink(() => {
    throw new Error("host");
  });
  assert.doesNotThrow(() => sink.emit({ type: "torch", on: true }));
});

test("without a callback there is no sink: nothing is built or called", () => {
  assert.equal(diagnosticsSinkFor(undefined), null);
  let calls = 0;
  const sink = diagnosticsSinkFor(() => (calls += 1), () => 0);
  sink?.emit({ type: "torch", on: true });
  assert.equal(calls, 1);
});

test("every emit in the library is behind a null sink check", () => {
  // `sink?.emit(...)` short-circuits its argument; a bare `.emit(` must sit
  // under a guard a few lines up, so an absent callback builds no event.
  const root = path.join(process.cwd(), "src");
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !full.endsWith("diagnostics-events.ts")) files.push(full);
    }
  };
  collect(root);
  let bare = 0;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/\b(diagnosticsSink|diag|sinkRef\.current)\??\.emit\(/.test(line)) return;
      if (/\?\.emit\(/.test(line)) return;
      bare += 1;
      const above = lines.slice(Math.max(0, index - 90), index).join("\n");
      assert.match(
        above,
        /(diagnosticsSink|diag) !== null|if \((diagnosticsSink|diag) === null[^)]*\) return|diag: DiagnosticsSink/,
        `${path.relative(root, file)}:${index + 1} emits without a guard`,
      );
    });
  }
  assert.ok(bare > 0);
});

test("a corner edit is measured as the largest move over the photo's diagonal", () => {
  const seed = {
    topLeft: { x: 0.1, y: 0.1 },
    topRight: { x: 0.9, y: 0.1 },
    bottomRight: { x: 0.9, y: 0.9 },
    bottomLeft: { x: 0.1, y: 0.9 },
  };
  assert.equal(maxCornerMovePct(seed, seed, 3000, 4000), 0);
  const moved = { ...seed, bottomRight: { x: 0.9 + 150 / 3000, y: 0.9 } };
  assert.equal(Math.round(maxCornerMovePct(seed, moved, 3000, 4000) * 100) / 100, 3);
});
