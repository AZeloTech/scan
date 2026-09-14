import assert from "node:assert/strict";
import test from "node:test";

import { hasSeenEditTip, markCompareTipSeen, markEditTipSeen } from "./tips.ts";

/**
 * The one persisted fact in a library whose whole claim is that it persists
 * nothing. Three things are worth a test: the key is namespaced under `scan.`
 * (this library is a guest in the host's origin and must not squat unprefixed
 * names), the flag is one-way, and a storage that refuses to answer costs the
 * memory rather than the screen.
 */

interface FakeWindow {
  localStorage: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
}

const global = globalThis as { window?: FakeWindow };

/** Runs `body` with a fake `window.localStorage`, whatever it does. */
function withStorage(
  storage: FakeWindow["localStorage"],
  body: () => void,
): void {
  global.window = { localStorage: storage };
  try {
    body();
  } finally {
    delete global.window;
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    getItem: (key: string): string | null => entries.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      entries.set(key, value);
    },
  };
}

test("the tip is shown until it is dismissed, then never again", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    assert.equal(hasSeenEditTip(), false);
    markEditTipSeen();
    assert.equal(hasSeenEditTip(), true);
    // Idempotent: a second dismissal is not a second state.
    markEditTipSeen();
    assert.equal(hasSeenEditTip(), true);
  });
});

test("every key it writes is namespaced under `scan.`", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    markEditTipSeen();
    markCompareTipSeen();
  });
  const keys = [...storage.entries.keys()].sort();
  assert.deepEqual(keys, ["scan.tip.compare", "scan.tip.edit"]);
  for (const key of keys) {
    assert.ok(
      key.startsWith("scan."),
      `${key} is written into the host's localStorage without the scan. prefix`,
    );
  }
});

test("a returning reader is not taught the same gesture twice", () => {
  withStorage(memoryStorage({ "scan.tip.edit": "1" }), () => {
    assert.equal(hasSeenEditTip(), true);
  });
});

test("a storage that throws costs the memory, never the screen", () => {
  const hostile = {
    getItem: (): string | null => {
      throw new Error("storage disabled");
    },
    setItem: (): void => {
      throw new Error("storage disabled");
    },
  };
  withStorage(hostile, () => {
    assert.doesNotThrow(() => markEditTipSeen());
    // Unanswerable, so the tip stays for this session — and that is all.
    assert.equal(hasSeenEditTip(), false);
  });
});

test("on the server there is nothing to ask and nothing to write", () => {
  assert.equal(global.window, undefined);
  assert.equal(hasSeenEditTip(), false);
  assert.doesNotThrow(() => markEditTipSeen());
});
