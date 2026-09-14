/**
 * The curvatura failure, written out — the half of the honesty the user's own
 * sentence cannot carry.
 *
 * "A correção não deu conta neste aparelho e foi pausada" is the right thing
 * to tell a person photographing a page and the wrong thing to tell whoever is
 * holding the phone *for diagnosis*: it is the same line whether the engine
 * chunk never arrived, the wasm refused to instantiate, or the device merely
 * spent fourteen seconds twice. This turns the ring buffer in
 * `lib/dewarp-stage.ts` plus the build's own facts into one block of plain
 * text a person can select, copy and paste into a message.
 *
 * Pure and DOM-free on purpose: everything it needs is passed in (the browser
 * readings are collected by the sheet that renders it), which is what makes
 * the format itself testable. The body is English identifiers, not copy — it
 * is an instrument, and every string in it is already the engine's own
 * vocabulary.
 */

import type {
  DewarpDiagnosticEntry,
  DewarpLatchState,
} from "@/lib/dewarp-stage";
import type { DewarpEngineMode } from "@/lib/dewarp/engine-mode";

export interface DewarpReportDevice {
  userAgent: string;
  language: string;
  /** `navigator.hardwareConcurrency`, null where the browser will not say. */
  hardwareConcurrency: number | null;
  /** `navigator.deviceMemory` in GB — Chromium only, null everywhere else. */
  deviceMemoryGb: number | null;
  /**
   * The host application's own version stamp, if it has one it can read at
   * run time — a service worker's shell cache name, say. Null when it has
   * none: this library carries no version of the host's, and a constant
   * maintained by hand would drift.
   */
  appVersion: string | null;
}

export interface DewarpReportInput {
  generatedAt: string;
  /** What a caller that does not name an engine gets. */
  defaultMode: DewarpEngineMode;
  /** `activeModelVersion` per engine: the asset a run would actually fetch. */
  assetVersions: Record<DewarpEngineMode, string>;
  latch: DewarpLatchState;
  device: DewarpReportDevice;
  /** Oldest first, exactly as the ring buffer holds them. */
  entries: readonly DewarpDiagnosticEntry[];
}

const UNKNOWN = "unknown";

function field(label: string, value: string): string {
  return `${label.padEnd(12)}${value}`;
}

function orUnknown(value: string | number | null): string {
  return value === null ? UNKNOWN : String(value);
}

function entryLine(entry: DewarpDiagnosticEntry, index: number): string[] {
  const facts: string[] = [];
  if (entry.pageId !== undefined) facts.push(`page=${entry.pageId}`);
  if (entry.reason !== undefined) facts.push(`reason=${entry.reason}`);
  if (entry.durationMs !== undefined) facts.push(`${Math.round(entry.durationMs)}ms`);
  for (const [key, value] of Object.entries(entry.extra ?? {})) {
    facts.push(`${key}=${String(value)}`);
  }
  const head = `[${index}] ${entry.ts} ${entry.engineMode} ${entry.event}`;
  const lines = [facts.length === 0 ? head : `${head} ${facts.join(" ")}`];
  if (entry.message !== undefined) lines.push(`    message: ${entry.message}`);
  if (entry.stack !== undefined) {
    lines.push("    stack:");
    // The stack arrives newline-separated from the browser; indenting it keeps
    // it visibly subordinate to its own event once this is pasted into a chat.
    for (const frame of entry.stack.split("\n")) {
      lines.push(`      ${frame.trim()}`);
    }
  }
  return lines;
}

export function formatDewarpReport(input: DewarpReportInput): string {
  const { device, latch } = input;
  const lines = [
    "azelo scan — dewarp diagnostics",
    field("generated", input.generatedAt),
    field("app", orUnknown(device.appVersion)),
    field("engine", input.defaultMode),
    field("assets", `classical=${input.assetVersions.classical}`),
    field(
      "device",
      `cores=${orUnknown(device.hardwareConcurrency)} ` +
        `memoryGb=${orUnknown(device.deviceMemoryGb)} lang=${device.language}`,
    ),
    field("userAgent", device.userAgent),
    field(
      "latch",
      `paused=${latch.disabledForSession ? "yes" : "no"} ` +
        `budgetStrikes=${latch.budgetStrikes} ` +
        `engineLoadStrikes=${latch.engineLoadStrikes} ` +
        `strikesToLatch=${latch.strikesToLatch}`,
    ),
    "",
    `events (${input.entries.length}, oldest first)`,
  ];
  if (input.entries.length === 0) {
    lines.push("(none)");
  } else {
    input.entries.forEach((entry, index) => {
      lines.push(...entryLine(entry, index + 1));
    });
  }
  return `${lines.join("\n")}\n`;
}
