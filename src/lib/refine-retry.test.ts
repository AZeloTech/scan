import assert from "node:assert/strict";
import test from "node:test";

import type { NormalizedQuad } from "./quad.ts";
import type { RefineResult } from "./refine.ts";
import { REFINE_BUDGET_MS } from "./refine.ts";
import { REFINE_RETRY_BUDGET_MS, refineWithRetry } from "./refine-retry.ts";

const QUAD: NormalizedQuad = {
  topLeft: { x: 0.1, y: 0.1 },
  topRight: { x: 0.9, y: 0.1 },
  bottomRight: { x: 0.9, y: 0.9 },
  bottomLeft: { x: 0.1, y: 0.9 },
};

function answer(reason: string, measured: boolean, ms: number): RefineResult {
  return {
    quad: QUAD,
    changed: false,
    sides: [],
    corners: [],
    occlusion: { suspected: false, separate: false },
    measured,
    ms,
    reason,
  };
}

/**
 * A fake clock and a scripted refinement: each run advances the clock by its
 * cost (capped at the budget it was given, as the real one gives up there)
 * and answers `budget` when its cost would pass that budget.
 */
function scripted(costs: number[]) {
  let clock = 1000;
  const budgets: number[] = [];
  let pauses = 0;
  const run = (budgetMs: number): RefineResult => {
    budgets.push(budgetMs);
    const cost = costs[budgets.length - 1];
    if (cost > budgetMs) {
      clock += budgetMs;
      return answer("budget", false, budgetMs);
    }
    clock += cost;
    return answer("refined", true, cost);
  };
  return {
    run,
    budgets,
    now: () => clock,
    pause: async () => {
      pauses += 1;
      clock += 4;
    },
    get pauses() {
      return pauses;
    },
  };
}

test("the retry is 4× the capture's budget, and bounded", () => {
  assert.equal(REFINE_BUDGET_MS, 250);
  assert.equal(REFINE_RETRY_BUDGET_MS, 4 * REFINE_BUDGET_MS);
});

test("a refinement that answers in time runs once: no retry, no yield", async () => {
  const s = scripted([120]);
  const { result, outcome } = await refineWithRetry(s.run, { now: s.now, pause: s.pause });
  assert.deepEqual(s.budgets, [REFINE_BUDGET_MS]);
  assert.equal(s.pauses, 0);
  assert.equal(result.reason, "refined");
  assert.deepEqual(outcome, { measured: true, retried: false, ms: 120, reason: "refined" });
});

test("a run that is not out of time is never retried, measured or not", async () => {
  let clock = 0;
  let runs = 0;
  const { outcome } = await refineWithRetry(
    () => {
      runs += 1;
      clock += 30;
      return answer("no-paper", false, 30);
    },
    { now: () => clock, pause: async () => assert.fail("no yield without a retry") },
  );
  assert.equal(runs, 1);
  assert.deepEqual(outcome, { measured: false, retried: false, ms: 30, reason: "no-paper" });
});

test("out of time once: yields, then runs again with the larger budget and is measured", async () => {
  const s = scripted([600, 600]);
  const { result, outcome } = await refineWithRetry(s.run, { now: s.now, pause: s.pause });
  assert.deepEqual(s.budgets, [REFINE_BUDGET_MS, REFINE_RETRY_BUDGET_MS]);
  assert.equal(s.pauses, 1);
  assert.equal(result.measured, true);
  // Both runs and the yield: 250 + 4 + 600.
  assert.deepEqual(outcome, { measured: true, retried: true, ms: 854, reason: "refined" });
});

test("out of time twice: two runs only, unmeasured, and the time is bounded", async () => {
  const s = scripted([5000, 5000, 5000]);
  const { result, outcome } = await refineWithRetry(s.run, { now: s.now, pause: s.pause });
  assert.deepEqual(s.budgets, [REFINE_BUDGET_MS, REFINE_RETRY_BUDGET_MS]);
  assert.equal(result.reason, "budget");
  assert.equal(result.measured, false);
  assert.deepEqual(outcome, { measured: false, retried: true, ms: REFINE_BUDGET_MS + 4 + REFINE_RETRY_BUDGET_MS, reason: "budget" });
});
