import assert from "node:assert/strict";
import test from "node:test";

import { createExitGate, USER_CANCEL_DEBOUNCE_MS } from "./exit-gate.ts";

/**
 * `onCancel("user")` is a request the host may refuse. These tests hold the
 * library to that: a refused request leaves a working flow, and only completion
 * and an unrecoverable error end it.
 */

function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000;
  return { now: () => at, advance: (ms) => void (at += ms) };
}

test("a user cancel the host ignores does not end the flow", () => {
  const time = clock();
  const gate = createExitGate(time.now);
  assert.equal(gate.requestCancel("user"), true);
  assert.equal(gate.finished, false);

  // The host asked "discard these pages?" and the person kept scanning.
  time.advance(2_000);
  assert.equal(gate.requestCancel("user"), true, "a later request fires again");
  assert.equal(gate.complete(), true, "and the flow can still complete");
});

test("a double tap inside one gesture fires once", () => {
  const time = clock();
  const gate = createExitGate(time.now);
  assert.equal(gate.requestCancel("user"), true);
  time.advance(USER_CANCEL_DEBOUNCE_MS - 1);
  assert.equal(gate.requestCancel("user"), false);
  time.advance(USER_CANCEL_DEBOUNCE_MS);
  assert.equal(gate.requestCancel("user"), true);
});

test("completion latches", () => {
  const gate = createExitGate(clock().now);
  assert.equal(gate.complete(), true);
  assert.equal(gate.finished, true);
  assert.equal(gate.complete(), false);
  assert.equal(gate.requestCancel("user"), false);
  assert.equal(gate.requestCancel("error"), false);
});

test("an unrecoverable error latches, even right after a user cancel", () => {
  const gate = createExitGate(clock().now);
  assert.equal(gate.requestCancel("user"), true);
  assert.equal(gate.requestCancel("error"), true, "not swallowed by the debounce");
  assert.equal(gate.finished, true);
  assert.equal(gate.requestCancel("user"), false);
  assert.equal(gate.complete(), false);
});
