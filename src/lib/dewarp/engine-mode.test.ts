import assert from "node:assert/strict";
import test from "node:test";

import { dewarpAbCompare, resolveGeometryMode } from "./engine-mode.ts";

/**
 * One engine, no environment. What used to be a five-value flag table is now a
 * single fact worth pinning: nothing a build (or a stray env var left over from
 * the two-engine era) can do changes which producer the app selects — there is
 * no other producer to select.
 */

test("the geometry mode is classical, whatever the environment says", () => {
  const original = process.env.NEXT_PUBLIC_DEWARP_ENGINE;
  process.env.NEXT_PUBLIC_DEWARP_ENGINE = "uvdoc";
  try {
    assert.equal(resolveGeometryMode(), "classical");
    assert.equal(dewarpAbCompare(), false);
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_DEWARP_ENGINE;
    else process.env.NEXT_PUBLIC_DEWARP_ENGINE = original;
  }
});

test("with nothing set at all, the answer is the same", () => {
  const original = process.env.NEXT_PUBLIC_DEWARP_ENGINE;
  delete process.env.NEXT_PUBLIC_DEWARP_ENGINE;
  try {
    assert.equal(resolveGeometryMode(), "classical");
    assert.equal(dewarpAbCompare(), false);
  } finally {
    if (original !== undefined) process.env.NEXT_PUBLIC_DEWARP_ENGINE = original;
  }
});
