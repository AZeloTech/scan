import assert from "node:assert/strict";
import test from "node:test";

import { classifyConnection, shouldPrefetchHeavyAssets } from "./network.ts";

test("a named radio is taken at its word", () => {
  assert.equal(classifyConnection({ type: "wifi" }), "wifi");
  assert.equal(classifyConnection({ type: "cellular" }), "cellular");
});

test("data saver outranks the radio", () => {
  // Someone who turned data saver on has said "assume I am paying for this",
  // and that is a stronger signal than the access point they happen to be on.
  assert.equal(classifyConnection({ type: "wifi", saveData: true }), "cellular");
  assert.equal(classifyConnection({ saveData: true }), "cellular");
  assert.equal(classifyConnection({ type: "wifi", saveData: false }), "wifi");
});

test("no API, and no answer, are the same answer: unknown", () => {
  // Every iPhone is the first line; the rest are Android reporting something
  // this app has no opinion about.
  assert.equal(classifyConnection(undefined), "unknown");
  assert.equal(classifyConnection({}), "unknown");
  assert.equal(classifyConnection({ type: "ethernet" }), "unknown");
  assert.equal(classifyConnection({ type: "unknown" }), "unknown");
  assert.equal(classifyConnection({ type: "none" }), "unknown");
});

test("only Wi-Fi buys the user 30 MB unasked", () => {
  assert.equal(shouldPrefetchHeavyAssets("wifi"), true);
  assert.equal(shouldPrefetchHeavyAssets("cellular"), false);
  // The one that matters: not knowing is not permission.
  assert.equal(shouldPrefetchHeavyAssets("unknown"), false);
});
