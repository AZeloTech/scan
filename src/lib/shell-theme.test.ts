import assert from "node:assert/strict";
import { test } from "node:test";

import {
  contrast,
  DEFAULT_SHELL,
  deriveShellTheme,
  SHELL_RAMP,
  type ShellTheme,
} from "./shell-theme.ts";

/**
 * The camera screens' whole palette is computed from one colour the user
 * picks, so "is the instruction text readable" is not a question a designer
 * can settle by looking at one screenshot — it has to hold for all fourteen
 * shells, and it has to keep holding when somebody edits the ramp.
 *
 * These are the floors from the design brief, asserted as arithmetic.
 */
const TEXT_TOKENS: ReadonlyArray<[keyof ShellTheme, string]> = [
  ["ink", "titles and filled-button fills"],
  ["ink2", "instruction and body text"],
  ["accent", "mono labels"],
  ["warn", "the edge-detection warning"],
];

/** Meaningful graphics, per WCAG 1.4.11. */
const GRAPHIC_TOKENS: ReadonlyArray<[keyof ShellTheme, string]> = [
  ["handle", "draggable corner pucks"],
  ["dim", "inactive step-trail segments"],
  ["dim2", "a disabled shutter's ring"],
];

test("every shell in the ramp keeps text at or above 4.5:1", () => {
  for (const step of SHELL_RAMP) {
    const theme = deriveShellTheme(step.hex);
    for (const [token, what] of TEXT_TOKENS) {
      const ratio = contrast(theme[token] as string, theme.shell);
      assert.ok(
        ratio >= 4.5,
        `${step.hex} (${step.name}): ${token} is ${ratio.toFixed(2)}:1 — ${what} would be unreadable`,
      );
    }
  }
});

test("text also clears 4.5:1 on `sunken`, the surface panels use", () => {
  // Chips, tip boxes and the viewfinder well all sit on `sunken` rather than
  // on the shell itself. A token that only clears the floor against the shell
  // is one that disappears inside a panel — which is exactly what happened to
  // the warning box on a pale shell.
  for (const step of SHELL_RAMP) {
    const theme = deriveShellTheme(step.hex);
    for (const [token, what] of TEXT_TOKENS) {
      const ratio = contrast(theme[token] as string, theme.sunken);
      assert.ok(
        ratio >= 4.5,
        `${step.hex} (${step.name}): ${token} on sunken is ${ratio.toFixed(2)}:1 — ${what} would vanish in a panel`,
      );
    }
  }
});

test("corner handles and trail segments stay visible at both ends", () => {
  for (const step of SHELL_RAMP) {
    const theme = deriveShellTheme(step.hex);
    for (const [token, what] of GRAPHIC_TOKENS) {
      const ratio = contrast(theme[token] as string, theme.shell);
      assert.ok(
        ratio >= 3,
        `${step.hex} (${step.name}): ${token} is ${ratio.toFixed(2)}:1 — ${what} would disappear`,
      );
    }
  }
});

test("text on a filled button reads against the fill", () => {
  for (const step of SHELL_RAMP) {
    const theme = deriveShellTheme(step.hex);
    const ratio = contrast(theme.onInk, theme.ink);
    assert.ok(
      ratio >= 4.5,
      `${step.hex} (${step.name}): onInk over ink is ${ratio.toFixed(2)}:1`,
    );
  }
});

test("the ramp runs carvão to papel and contains the default", () => {
  assert.equal(SHELL_RAMP.length, 14);
  assert.equal(SHELL_RAMP[0].hex, "#12160F");
  assert.equal(SHELL_RAMP[SHELL_RAMP.length - 1].hex, "#F4F1E8");
  assert.ok(
    SHELL_RAMP.some((step) => step.hex === DEFAULT_SHELL),
    "the default shell must be one the picker can return to",
  );
});

test("polarity follows readability, not a fixed luminance cut", () => {
  // The brief's `luminance > 0.55` cut called this one dark, which put warm
  // text on it at 2.4:1. It is light.
  assert.equal(deriveShellTheme("#8FAB9B").light, true);
  assert.equal(deriveShellTheme("#12160F").light, false);
  assert.equal(deriveShellTheme(DEFAULT_SHELL).light, false);
});

test("the impossible shell is not in the ramp", () => {
  // Neither brand ink clears 4.5:1 on #5C7F6B — it is the crossover.
  assert.ok(!SHELL_RAMP.some((step) => step.hex === "#5C7F6B"));
});
