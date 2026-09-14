"use client";

/**
 * The camera shell's colour, and everything derived from it.
 *
 * The capture and page-editing screens (viewfinder, confirmar cantos, ver
 * página, ajustar cantos, girar e clarear) share one dark chrome. That chrome
 * is a **single value** the user can move along a 14-step ramp from `carvão`
 * to `papel`, and every other colour on those screens is computed from it — so
 * a pale shell is not a broken dark theme, it is a light one.
 *
 * ## Why the derivation is computed rather than tabulated
 *
 * The obvious implementation is a fixed light/dark split at some luminance and
 * a table of alpha values. That is what was specified, and it does not work:
 *
 *  * A fixed cut (`luminance > 0.55`) misclassifies the middle of the ramp.
 *    `#8FAB9B` has luminance 0.373 — nominally "dark" — but warm text on it is
 *    2.4:1. Polarity is therefore chosen by **whichever ink actually contrasts
 *    more**, which is the question the cut was a proxy for.
 *  * Fixed alphas fail wherever the shell is mid-tone: body copy at 72% over
 *    `#8FAB9B` lands at 1.9:1. The designed alphas are kept as **starting
 *    points** and opacity rises only as far as the contrast floor requires, so
 *    a shell with room to spare looks exactly as drawn and a difficult one
 *    stays readable.
 *  * One shell is impossible at any alpha: at `#5C7F6B` the two brand inks
 *    reach 4.27:1 and 3.75:1, so neither can carry text. It sits exactly on the
 *    crossover, and it is replaced in the ramp by `#587A66`.
 *
 * The floors, and what they protect. Note that text is checked against **two**
 * backgrounds: the shell itself, and `sunken`, which every panel and chip sits
 * on — a token that only clears the floor against the shell is one that
 * disappears inside a tip box.
 *
 * | token | floor | why |
 * |---|---|---|
 * | `ink`, `ink2`, `accent`, `warn` | 4.5:1 | they carry instructions |
 * | `handle`, `dim`, `dim2` | 3:1 | pucks, trail segments and the shutter ring are meaningful graphics |
 * | `onInk` vs `ink` | 4.5:1 | the label on a filled button |
 *
 * `shell-theme.test.ts` asserts all of it across all 14 steps, and is the
 * reason a ramp edit cannot quietly break a shell nobody happened to open.
 */

/** A shell colour and the human name the picker shows. */
export interface ShellStep {
  hex: string;
  name: string;
}

/**
 * Carvão → papel, in 14 steps.
 *
 * Nothing ships a picker over this any more — {@link DEFAULT_SHELL} is
 * the only value this library uses. The ramp stays because the test walks it: it is
 * the proof that the derivation below is safe across the whole range, which is
 * what makes changing the one shipped colour a one-line edit rather than a
 * contrast audit.
 *
 * Index 6 is `#587A66` rather than the sage `#5C7F6B` it interpolates to: that
 * exact value is the crossover where neither brand ink clears 4.5:1, so the
 * ramp steps around it. The difference is invisible; the failure was not.
 */
export const SHELL_RAMP: readonly ShellStep[] = [
  { hex: "#12160F", name: "carvão" },
  { hex: "#1F271F", name: "breu" },
  { hex: "#2D392E", name: "mata" },
  { hex: "#3A4A3E", name: "musgo" },
  { hex: "#455C4D", name: "pinheiro" },
  { hex: "#516D5C", name: "louro" },
  { hex: "#587A66", name: "erva" },
  { hex: "#6D8E7B", name: "salva" },
  { hex: "#7E9C8B", name: "eucalipto" },
  { hex: "#8FAB9B", name: "névoa" },
  { hex: "#ACC2B4", name: "orvalho" },
  { hex: "#C9D8CE", name: "sereno" },
  { hex: "#DEE4DB", name: "linho" },
  { hex: "#F4F1E8", name: "papel" },
];

/** The shell the app opens with. */
export const DEFAULT_SHELL = "#3A4A3E";

/**
 * The corner editor's magnifier ring and crosshair.
 *
 * The one colour on these screens that is **not** derived from the shell: the
 * loupe is drawn over the photograph, and the photograph is a white sheet on
 * whatever the user's table is. Sage clears 4.4:1 against paper white and
 * 4.8:1 against black, so it is legible at both ends where scanic's default
 * white ring disappears into the page it is magnifying.
 */
export const LOUPE_RING = "#5C7F6B";

const INK_DARK = "#1B1F18";
const INK_LIGHT = "#FAFAF7";

type Rgb = readonly [number, number, number];

function toRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(channelLuminance);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

/** `ink` at `alpha` composited over `shell`, as an opaque hex. */
function blend(ink: string, alpha: number, shell: string): string {
  const a = toRgb(ink);
  const b = toRgb(shell);
  return toHex([
    a[0] * alpha + b[0] * (1 - alpha),
    a[1] * alpha + b[1] * (1 - alpha),
    a[2] * alpha + b[2] * (1 - alpha),
  ] as const);
}

/**
 * The weakest version of `ink` over `shell` that still clears `floor`, never
 * weaker than `start`.
 *
 * `start` is the alpha the design asked for; the loop only ever strengthens it.
 * Stepping by 1% is 32 iterations at worst and runs once per theme change.
 */
function resolveAlpha(
  ink: string,
  shell: string,
  floor: number,
  start: number,
): number {
  let alpha = start;
  while (alpha < 1 && contrast(blend(ink, alpha, shell), shell) < floor) {
    alpha = Math.min(1, Math.round((alpha + 0.01) * 100) / 100);
  }
  return alpha;
}

export interface ShellTheme {
  /** The chosen shell itself. */
  shell: string;
  /** A touch deeper than the shell — the viewfinder well, sunken panels. */
  sunken: string;
  /** Titles, and the fill of a primary button. */
  ink: string;
  /** Text sitting ON `ink`. */
  onInk: string;
  /** Body copy and helper text. */
  ink2: string;
  /** Hairlines and outlined-button borders. */
  inkLine: string;
  /** Sage accents and mono labels. */
  accent: string;
  /** Inactive trail segments, translucent panels. */
  dim: string;
  /** A disabled shutter's ring and fill. */
  dim2: string;
  /** The draggable corner pucks. */
  handle: string;
  /** Edge-detection warnings. */
  warn: string;
  /** The warning panel's border, and the dashed guide. */
  warnLine: string;
  /** True when the shell is pale enough to want dark ink. */
  light: boolean;
}

/**
 * Derive the whole palette from one shell colour.
 *
 * Pure and cheap — call it whenever the shell changes, not on every render.
 */
export function deriveShellTheme(shell: string): ShellTheme {
  // Polarity is "which ink can actually be read here", not a luminance cut.
  const light = contrast(INK_DARK, shell) >= contrast(INK_LIGHT, shell);
  const ink = light ? INK_DARK : INK_LIGHT;
  const onInk = light ? "#F4F1E8" : "#1F3128";

  const ink2 = blend(ink, resolveAlpha(ink, shell, 4.5, light ? 0.68 : 0.72), shell);
  const inkLine = blend(ink, resolveAlpha(ink, shell, 1.6, light ? 0.26 : 0.3), shell);
  const dim = blend(ink, resolveAlpha(ink, shell, 3, light ? 0.12 : 0.2), shell);
  const dim2 = blend(ink, resolveAlpha(ink, shell, 3, light ? 0.3 : 0.45), shell);

  // Sage is the house accent, but it cannot carry text on a sage-ish shell —
  // there it steps aside for the body ink rather than becoming decorative.
  const sage = light ? "#3E6250" : "#8FAB9B";
  const accent = contrast(sage, shell) >= 4.5 ? sage : ink2;

  const handleBase = light ? "#1F3128" : INK_LIGHT;
  const handle =
    contrast(handleBase, shell) >= 3
      ? handleBase
      : blend(ink, resolveAlpha(ink, shell, 3, 0.94), shell);

  // The well the document sits in: a step further from the ink, so the page
  // itself is always the brightest (or darkest) thing on the screen — and, as
  // the surface every panel uses, the second background the text tokens must
  // clear.
  const sunken = blend(light ? INK_LIGHT : INK_DARK, 0.35, shell);

  // The single warning accent. It carries the edge-detection message, so it
  // owes the text floor against BOTH surfaces it can appear on; where peach
  // cannot manage that, it steps aside for the body ink.
  const warnBase = light ? "#A5613A" : "#F0D3BF";
  const warn =
    contrast(warnBase, shell) >= 4.5 && contrast(warnBase, sunken) >= 4.5
      ? warnBase
      : ink2;
  const warnLine = blend(warn, 0.55, shell);

  return {
    shell,
    sunken,
    ink,
    onInk,
    ink2,
    inkLine,
    accent,
    dim,
    dim2,
    handle,
    warn,
    warnLine,
    light,
  };
}

/** The CSS custom properties the Tailwind `shell-*` colours read. */
export function shellCssVars(theme: ShellTheme): Record<string, string> {
  return {
    "--shell": theme.shell,
    "--shell-sunken": theme.sunken,
    "--shell-ink": theme.ink,
    "--shell-on": theme.onInk,
    "--shell-ink2": theme.ink2,
    "--shell-line": theme.inkLine,
    "--shell-accent": theme.accent,
    "--shell-dim": theme.dim,
    "--shell-dim2": theme.dim2,
    "--shell-handle": theme.handle,
    "--shell-warn": theme.warn,
    "--shell-warnline": theme.warnLine,
  };
}
