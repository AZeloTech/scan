import assert from "node:assert/strict";
import test from "node:test";

import {
  curvedSurface,
  dewarpMemoFor,
  newDewarpMemo,
  renderWithFallback,
  RenderStageError,
  type RenderRequest,
  type RenderedPage,
} from "./page-processing.ts";

/**
 * The ladder's two rules, from the outside: what a failure is allowed to cost,
 * and what a *retry* is allowed to cost on top of it.
 *
 * The second one is the subtle half. The ladder concedes the enhancement and
 * runs the pass again — and the pass it runs again contains a twelve-second
 * inference whose second attempt can fail for reasons that have nothing to do
 * with the page. If that were allowed to change the geometry, "we dropped the
 * enhancement" would quietly also mean "we dropped the correction you asked
 * for", and nothing in the result would say so.
 */

const REQUEST: RenderRequest = {
  canonical: new Blob(),
  corners: { topLeft: { x: 0, y: 0 }, topRight: { x: 1, y: 0 }, bottomRight: { x: 1, y: 1 }, bottomLeft: { x: 0, y: 1 } },
  rotation: 0,
  finish: "clean",
};

function page(overrides: Partial<RenderedPage> = {}): RenderedPage {
  return {
    final: new Blob(),
    thumb: null,
    width: 100,
    height: 200,
    finish: "clean",
    warped: true,
    dewarped: true,
    rotation: 0,
    ...overrides,
  };
}

/** The accepted map is opaque here; only its identity matters. */
const ACCEPTED = { grid: null, crop: null, width: 10, height: 20 } as never;

test("a retry inside one render resamples the accepted map instead of inferring again", async () => {
  const memo = newDewarpMemo();
  let inferences = 0;
  let resamples = 0;
  const lane = {
    infer: async () => {
      inferences += 1;
      return { canvas: "curved", reason: null, replay: ACCEPTED };
    },
    resample: async () => {
      resamples += 1;
      return "curved-again";
    },
  };

  const first = await curvedSurface<string>(memo, lane);
  assert.deepEqual(first, { canvas: "curved", reason: null });
  const second = await curvedSurface<string>(memo, lane);
  assert.deepEqual(second, { canvas: "curved-again", reason: null });
  assert.equal(inferences, 1, "the model was asked twice for one render");
  assert.equal(resamples, 1);
});

test("a decline is remembered too — a retry does not pay for the same refusal", async () => {
  const memo = newDewarpMemo();
  let inferences = 0;
  const lane = {
    infer: async () => {
      inferences += 1;
      return {
        canvas: null,
        reason: "guard-boundary" as const,
        replay: null,
      };
    },
    resample: async () => {
      throw new Error("nothing was ever accepted");
    },
  };

  assert.equal((await curvedSurface<string>(memo, lane)).reason, "guard-boundary");
  assert.equal((await curvedSurface<string>(memo, lane)).reason, "guard-boundary");
  assert.equal(inferences, 1);
});

test("a failed finish costs the finish, and the curved geometry survives it", async () => {
  // The whole point, end to end: the first pass dewarps and then dies in the
  // illumination stage; the ladder retries with `finish: "original"`; the retry
  // must come back curved. The second inference is deliberately made to fail —
  // if the ladder still asked for one, this page would lose its correction and
  // claim only to have lost the enhancement.
  const memo = newDewarpMemo();
  const lane = {
    infer: async () => {
      if (memo.accepted !== null) throw new Error("asked twice");
      return { canvas: "curved", reason: null, replay: ACCEPTED };
    },
    resample: async () => "curved-again",
  };

  const attempts: string[] = [];
  const rendered = await renderWithFallback(REQUEST, async (finish) => {
    const curved = await curvedSurface<string>(memo, lane);
    attempts.push(`${finish}:${curved.canvas ?? "flat"}`);
    if (finish !== "original") {
      throw new RenderStageError("finish", new Error("threshold pass failed"));
    }
    return page({ finish, dewarped: curved.canvas !== null });
  });

  assert.deepEqual(attempts, ["clean:curved", "original:curved-again"]);
  assert.equal(rendered.finish, "original");
  assert.equal(rendered.dewarped, true);
});

test("a request with no stored replay starts with an empty memo, as before", () => {
  assert.deepEqual(dewarpMemoFor(REQUEST), { accepted: null, declined: null });
});

test("a request carrying a stored replay seeds the memo — the switch-off, switch-on-again path", () => {
  const memo = dewarpMemoFor({
    ...REQUEST,
    dewarp: { sourceId: "page-1", generation: 3, replay: ACCEPTED },
  });
  assert.equal(memo.accepted, ACCEPTED, "the caller's map is used, not re-derived");
  assert.equal(memo.declined, null);
});
