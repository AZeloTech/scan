/**
 * The diagnostics HUD's text (`experimentalDiagnostics`), one fact per line —
 * pure, so the wording is tested without a DOM. Numbers only: no image, no
 * page content, nothing stored or sent.
 */

import type { LiveDiagnostics } from "@/hooks/useLiveDetect";

export interface HudExtras {
  torch: boolean;
  autoOffered: boolean;
  autoOn: boolean;
  autoFires: number;
  still: { width: number; height: number; attention: string | null } | null;
}

const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)}`);
const pct = (value: number) => `${Math.round(value * 100)}`;

export function hudLines(d: LiveDiagnostics, x: HudExtras, vibrate: boolean, laneReason: string | null): string[] {
  const v = d.visible;
  return [
    `lane ${d.lane ?? "…"}${laneReason !== null && laneReason !== "worker" ? ` (${laneReason})` : ""} · ${d.detector}`,
    `detect ${ms(d.detectMs)} ms · p50 ${ms(d.detectP50)} · every ${ms(d.intervalMs)}`,
    `frame age ${ms(d.frameAgeMs)} ms`,
    `stream ${d.stream === null ? "–" : `${d.stream.width}×${d.stream.height}`} · still ${x.still === null ? "–" : `${x.still.width}×${x.still.height}`}`,
    `visible x${pct(v.x)} y${pct(v.y)} w${pct(v.width)} h${pct(v.height)} % · fit ${d.fit}`,
    `torch ${x.torch ? "yes" : "no"} · vibrate ${vibrate ? "yes" : "no"}`,
    `${d.locked ? "locked" : "searching"} · ready ${d.ready ? "on" : "off"} · auto ${x.autoOffered ? (x.autoOn ? (d.autoArmed ? "armed" : "waiting") : "off") : "hidden"} · fired ${x.autoFires}`,
    ...(x.still?.attention ? [`last photo: ${x.still.attention}`] : []),
  ];
}
