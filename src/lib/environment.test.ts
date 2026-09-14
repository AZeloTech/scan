import assert from "node:assert/strict";
import test from "node:test";

import { isDesktopSurface } from "./environment.ts";

/**
 * The one fork in the whole product, so its failure direction matters more than
 * its success one: every "I cannot tell" has to come out **false** and leave
 * the user on the flow that works on every device this app has ever run on.
 *
 * The globals it reads are installed by hand here rather than through a DOM
 * shim — the function is a handful of branches over three browser fields, and a
 * jsdom would test jsdom's opinion of `matchMedia` rather than ours.
 */

interface Fake {
  /** What `(pointer: fine)` answers. */
  fine?: boolean;
  matchMediaThrows?: boolean;
  noMatchMedia?: boolean;
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

/** A desktop Chrome on Windows: the plain case every exclusion is measured against. */
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
/** A real Mac — and, byte for byte, what an iPad on "Request Desktop Website" sends. */
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function install(fake: Fake): () => void {
  // Node 22 defines `globalThis.navigator` as a getter, so a plain assignment
  // throws in strict mode; both stubs go in the same way for symmetry.
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );

  const windowStub: Record<string, unknown> = {};
  if (fake.noMatchMedia !== true) {
    windowStub.matchMedia = (query: string) => {
      if (fake.matchMediaThrows === true) throw new Error("no");
      return { matches: query.includes("fine") && fake.fine === true };
    };
  }

  define("window", windowStub);
  define("navigator", {
    userAgent: fake.userAgent ?? WINDOWS,
    platform: fake.platform ?? "Win32",
    maxTouchPoints: fake.maxTouchPoints ?? 0,
  });

  return () => {
    restore("window", previousWindow);
    restore("navigator", previousNavigator);
  };
}

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

function restore(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    delete (globalThis as unknown as Record<string, unknown>)[name];
    return;
  }
  Object.defineProperty(globalThis, name, descriptor);
}

function answerFor(fake: Fake): boolean {
  const restore = install(fake);
  try {
    return isDesktopSurface();
  } finally {
    restore();
  }
}

test("a fine pointer is the desktop mode, webcam or not", () => {
  // A machine with a camera used to be held on the phone flow. Nobody lifts a
  // laptop over a sheet of paper, so the camera stopped being part of the
  // question — this case used to answer false.
  assert.equal(answerFor({ fine: true }), true);
});

test("a computer with no camera is still the desktop mode", () => {
  assert.equal(answerFor({ fine: true, userAgent: WINDOWS }), true);
});

test("a coarse pointer is never sent to the desktop mode", () => {
  assert.equal(
    answerFor({
      fine: false,
      userAgent: ANDROID_TABLET,
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    }),
    false,
  );
});

test("an iPad asking for the desktop site is not a Mac", () => {
  // It sends a Mac user agent and reports a fine pointer; `maxTouchPoints` is
  // the only field that gives it away.
  assert.equal(
    answerFor({
      fine: true,
      userAgent: MAC,
      platform: "MacIntel",
      maxTouchPoints: 5,
    }),
    false,
  );
});

test("a real Mac reports no touch points and gets the desktop mode", () => {
  assert.equal(
    answerFor({
      fine: true,
      userAgent: MAC,
      platform: "MacIntel",
      maxTouchPoints: 0,
    }),
    true,
  );
});

test("a touch-screen laptop is a desktop, not a tablet", () => {
  // The trap a bare `maxTouchPoints` check falls into: a Windows or ChromeOS
  // convertible has a touch screen AND a mouse, and belongs at the desk.
  assert.equal(
    answerFor({ fine: true, userAgent: WINDOWS, maxTouchPoints: 10 }),
    true,
  );
});

test("an Android that claims a fine pointer stays on the phone flow", () => {
  // A tablet with a stylus or a DeX session; the user agent settles it.
  assert.equal(
    answerFor({
      fine: true,
      userAgent: ANDROID_TABLET,
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    }),
    false,
  );
});

test("every way of not knowing answers false", () => {
  const cases: Fake[] = [
    { noMatchMedia: true },
    { matchMediaThrows: true },
    // `(pointer: fine)` not matching is itself an "I cannot tell" on a browser
    // that does not implement the media feature: it answers false, and false is
    // the phone flow.
    { fine: false },
  ];
  for (const fake of cases) {
    assert.equal(
      answerFor(fake),
      false,
      `an unanswerable question must leave the user on the phone flow: ${JSON.stringify(fake)}`,
    );
  }
});

test("on the server there is no surface to detect", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  restore("window", undefined);
  try {
    assert.equal(isDesktopSurface(), false);
  } finally {
    restore("window", previousWindow);
  }
});
