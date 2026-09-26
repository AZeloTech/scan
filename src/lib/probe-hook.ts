/**
 * Where the development bench's listener lives, and nothing else.
 *
 * Kept apart from `lib/probe.ts` so that it can be left out of a build
 * whole: `probe.ts` only reaches for it inside branches guarded by a
 * build-time constant, which the published library defines `false`
 * (`scripts/build.mjs`). With the branches dead, nothing imports this module,
 * the bundler drops it, and no byte of it — not its code, not the name of the
 * global it reads, not its source in a source map, not its declarations (tsc
 * emits them; `scripts/prune-probe-types.mjs` takes them out) — ships in
 * `dist/`. The bench bundle (`scripts/bench/build-app.mjs`) defines the
 * constant `true` and keeps it. `scripts/check-dist.mjs` refuses a build
 * where any of it survived.
 */

import type { ProbeEvent } from "@/lib/probe";

/** Where the listener lives. A global, so a test page can install it before mount. */
const HOOK = "__SCAN_PROBE__";

export type ProbeListener = (event: ProbeEvent) => void;

/** The page's listener, if it installed a function there. */
export function probeListener(): ProbeListener | null {
  try {
    const candidate: unknown = (globalThis as Record<string, unknown>)[HOOK];
    return typeof candidate === "function" ? (candidate as ProbeListener) : null;
  } catch {
    // A getter that throws is a listener that is not there.
    return null;
  }
}
