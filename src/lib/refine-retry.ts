/**
 * A capture's corner refinement, given a second chance on a slow phone.
 *
 * The capture refines its corners within {@link REFINE_BUDGET_MS}
 * (`lib/refine.ts`); a device several times slower than the bench's 4×
 * throttle runs out of it, and the confirm screen then opened on the
 * detector's corners with nothing measured — a covered corner left out on the
 * covering sheet, unmarked. Off the live loop, one more go is affordable:
 * when (and only when) the first run gave up for time, it runs once more with
 * {@link REFINE_RETRY_BUDGET_MS}, after yielding so the pending frame paints.
 * The live loop's budget is not this one and is not touched: a live pass that
 * runs out is simply unmeasured, and auto-capture holds (fail closed).
 *
 * What the refinement did travels as {@link RefineOutcome}: the confirm screen
 * says "não deu para medir" when it still measured nothing, and the
 * diagnostics stream carries it as metadata.
 *
 * Pure but for the injected `run`, `now` and `pause`: tested in
 * `refine-retry.test.ts` with a fake clock.
 */

import { REFINE_BUDGET_MS, type RefineResult } from "@/lib/refine";

/**
 * The retry's budget, ms: 4× the first. A refinement is deterministic work
 * (the downscale, the planes, the side scans), so a device that overran 250 ms
 * finishes within 1000 ms unless it is more than ~4× slower again — the bench
 * measured a max of 199 ms on a 4× CPU throttle, so this covers phones up to
 * ~16× the bench's desktop (`REFINE_BUDGET_MS`, 250 ms, is the first run's). The worst case a capture can add is this plus one
 * yield; the retry never runs when the first attempt answered.
 */
export const REFINE_RETRY_BUDGET_MS = 1000;

/** What a capture's corner refinement did — metadata only, for the confirm screen and the diagnostics stream. */
export interface RefineOutcome {
  /** The corners' provenance was measured (the last run went to its end). */
  measured: boolean;
  /** The first run gave up for time and a second one ran. */
  retried: boolean;
  /** Both runs and the yield between them, ms. */
  ms: number;
  /** The last run's reason (`refined`, `no-change`, `budget`, …). */
  reason: string;
}

export interface RetryOptions {
  budgetMs?: number;
  retryBudgetMs?: number;
  now?: () => number;
  /** Lets the page paint before the second run; default a zero-delay timeout. */
  pause?: () => Promise<void>;
}

const yieldToPaint = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * `run(budgetMs)` once; when it answers `budget`, yield, then once more with
 * the larger budget. Never more than two runs.
 */
export async function refineWithRetry(
  run: (budgetMs: number) => RefineResult,
  { budgetMs = REFINE_BUDGET_MS, retryBudgetMs = REFINE_RETRY_BUDGET_MS, now = () => performance.now(), pause = yieldToPaint }: RetryOptions = {},
): Promise<{ result: RefineResult; outcome: RefineOutcome }> {
  const started = now();
  let result = run(budgetMs);
  let retried = false;
  if (result.reason === "budget") {
    retried = true;
    await pause();
    result = run(retryBudgetMs);
  }
  return {
    result,
    outcome: { measured: result.measured, retried, ms: now() - started, reason: result.reason },
  };
}

/** The outcome as the diagnostics stream carries it: whole milliseconds, no reason string. */
export function refineDiagnostic(outcome: RefineOutcome | null | undefined): { measured: boolean; retried: boolean; ms: number } | null {
  if (outcome === null || outcome === undefined) return null;
  return { measured: outcome.measured, retried: outcome.retried, ms: Math.max(0, Math.round(outcome.ms)) };
}
