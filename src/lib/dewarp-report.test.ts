import assert from "node:assert/strict";
import test from "node:test";

import type { DewarpDiagnosticEntry } from "./dewarp-stage.ts";
import { formatDewarpReport, type DewarpReportInput } from "./dewarp-report.ts";

/**
 * The report exists to answer one question somebody in the field cannot
 * answer from the screen: *why* was the correction paused. So the tests are
 * about what survives into the text — the engine that struck, the engine's own
 * reason identifier, and the exception behind it.
 */

const DEVICE = {
  userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S911B)",
  language: "pt-BR",
  hardwareConcurrency: 8,
  deviceMemoryGb: 4,
  appVersion: "host-app-v2.9.0",
};

function report(entries: readonly DewarpDiagnosticEntry[]): string {
  const input: DewarpReportInput = {
    generatedAt: "2026-08-18T10:00:00.000Z",
    defaultMode: "classical",
    assetVersions: { classical: "dewarp-classical-2ae72e6f" },
    latch: {
      disabledForSession: true,
      budgetStrikes: 0,
      engineLoadStrikes: 2,
      strikesToLatch: 2,
    },
    device: DEVICE,
    entries,
  };
  return formatDewarpReport(input);
}

test("the build's own facts head the report", () => {
  const text = report([]);
  assert.match(text, /^azelo scan — dewarp diagnostics$/m);
  assert.match(text, /^app {9}host-app-v2\.9\.0$/m);
  assert.match(text, /^engine {6}classical$/m);
  assert.match(text, /^assets {6}classical=dewarp-classical-2ae72e6f$/m);
  assert.match(text, /^device {6}cores=8 memoryGb=4 lang=pt-BR$/m);
  assert.match(
    text,
    /^latch {7}paused=yes budgetStrikes=0 engineLoadStrikes=2 strikesToLatch=2$/m,
  );
});

test("an empty buffer says so rather than trailing off", () => {
  const text = report([]);
  assert.match(text, /^events \(0, oldest first\)\n\(none\)\n$/m);
});

test("the exception behind a latched engine load reaches the text", () => {
  const text = report([
    {
      ts: "2026-08-18T09:59:58.000Z",
      pageId: "page-3",
      engineMode: "classical",
      event: "attempt",
      extra: { generation: 2 },
    },
    {
      ts: "2026-08-18T09:59:59.000Z",
      pageId: "page-3",
      engineMode: "classical",
      event: "engine-load-failed",
      reason: "model-unavailable",
      durationMs: 1204,
      extra: { strikes: 2 },
      message: "TypeError: Failed to fetch dynamically imported module",
      stack: "TypeError: Failed to fetch\n    at loadEngine (dewarp-stage.ts:190)",
    },
    {
      ts: "2026-08-18T09:59:59.500Z",
      pageId: "page-3",
      engineMode: "classical",
      event: "latched",
      reason: "engine-load",
    },
  ]);

  assert.match(text, /^events \(3, oldest first\)$/m);
  assert.match(
    text,
    /^\[1\] 2026-08-18T09:59:58\.000Z classical attempt page=page-3 generation=2$/m,
  );
  assert.match(
    text,
    /^\[2\] 2026-08-18T09:59:59\.000Z classical engine-load-failed page=page-3 reason=model-unavailable 1204ms strikes=2$/m,
  );
  assert.match(
    text,
    /^ {4}message: TypeError: Failed to fetch dynamically imported module$/m,
  );
  assert.match(text, /^ {6}at loadEngine \(dewarp-stage\.ts:190\)$/m);
  assert.match(
    text,
    /^\[3\] 2026-08-18T09:59:59\.500Z classical latched page=page-3 reason=engine-load$/m,
  );
});

test("a browser that will not say is reported as unknown, never as null", () => {
  const text = formatDewarpReport({
    generatedAt: "2026-08-18T10:00:00.000Z",
    defaultMode: "classical",
    assetVersions: { classical: "c" },
    latch: {
      disabledForSession: false,
      budgetStrikes: 1,
      engineLoadStrikes: 0,
      strikesToLatch: 2,
    },
    device: {
      ...DEVICE,
      hardwareConcurrency: null,
      deviceMemoryGb: null,
      appVersion: null,
    },
    entries: [],
  });

  assert.match(text, /^app {9}unknown$/m);
  assert.match(text, /^engine {6}classical$/m);
  assert.match(text, /^device {6}cores=unknown memoryGb=unknown lang=pt-BR$/m);
  assert.doesNotMatch(text, /null/);
});
