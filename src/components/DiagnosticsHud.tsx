"use client";

import * as React from "react";
import { detectLaneReason } from "@/lib/detect-lane";
import type { LiveDiagnostics } from "@/hooks/useLiveDetect";
import { hudLines, type HudExtras } from "@/lib/diagnostics";

/**
 * The diagnostics HUD (`experimentalDiagnostics` on `<ScanFlow>`, default
 * off) — for the real-phone protocol: what the live loop is doing on THIS
 * device, in a few lines of small type over the viewfinder's top-left
 * corner. Read four times a second from numbers the loop keeps anyway; it
 * stores nothing, sends nothing and never touches a pixel. Not announced
 * (`aria-hidden`): it is an instrument, not part of the scanner.
 */

const TICK_MS = 250;

export function DiagnosticsHud({ read, extras }: { read: () => LiveDiagnostics; extras: () => HudExtras }) {
  const [lines, setLines] = React.useState<string[]>([]);
  React.useEffect(() => {
    const vibrate = typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
    const update = () => setLines(hudLines(read(), extras(), vibrate, detectLaneReason()));
    update();
    const timer = window.setInterval(update, TICK_MS);
    return () => window.clearInterval(timer);
  }, [read, extras]);
  return (
    <div
      aria-hidden="true"
      data-scan-diagnostics=""
      className="pointer-events-none absolute left-2 top-[calc(max(env(safe-area-inset-top),12px)+6.5rem)] z-10 max-w-[70%] whitespace-pre rounded bg-night/70 px-1.5 py-1 font-mono text-[10px] leading-[1.3] text-warm"
    >
      {lines.join("\n")}
    </div>
  );
}
