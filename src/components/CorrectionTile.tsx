"use client";

import * as React from "react";
import clsx from "clsx";

/**
 * One of the page editor's four tools: an icon over one short word, four to a
 * row, no box of its own (the owner-approved "E3 · Deslizar + Editar" design).
 *
 * It lives in its own module because two components draw it — the editor's own
 * three tools and {@link DewarpTile}, which is a `switch` rather than a button
 * and therefore cannot simply be another instance rendered by the editor. Two
 * copies of these class strings is how the row ends up with two slightly
 * different controls in it.
 *
 * **The applied state lives on the tool**, not on a chip floating over the
 * picture: a correction this page is wearing is a fact about the control that
 * applied it, drawn as a tinted well behind it. **Disabled is shown, never
 * hidden** — the row is always four columns wide, so a page that cannot be
 * straightened has the same shape as one that can.
 *
 * The label is one word by contract: four equal columns at 320 px leave about
 * 70 px of 12 px text each, and half a verb is not a control. 60 px tall and a
 * quarter of the row wide, so the target clears 44 px both ways.
 */
export type CorrectionTileState =
  /** Offered, and this page is not wearing it. */
  | "default"
  /** This page is wearing it — mist, the app's "yes, that happened" accent. */
  | "applied"
  /**
   * The way out of the state the status line is reporting: the corners tile
   * after a page went in flat. Warn-toned, because it is being *recommended*
   * rather than reported.
   */
  | "suggested";

/**
 * Colour as a closed map, never a `className` override — two `bg-*` utilities
 * in one class string are resolved by the generated stylesheet's order, not
 * the string's (the rule `ui.tsx` records on `META_TONE_CLASSES`).
 *
 * `mist` and `peach-soft` are fixed tokens, so their tints may carry an opacity
 * modifier; the text takes the **shell's** own accent and warn values, which `lib/shell-theme.ts` guarantees against whatever surface colour
 * the user picked — a fixed `#a2a5a8` label would be legible on the design's
 * green and nowhere else on the ramp.
 */
const TILE_STATE_CLASSES: Record<CorrectionTileState, string> = {
  default: "text-shell-ink hover:bg-shell-sunken",
  applied: "bg-mist/[0.16] text-shell-accent",
  suggested: "bg-peach-soft/[0.14] text-shell-warn",
};

export function CorrectionTile({
  label,
  ariaLabel,
  icon,
  state = "default",
  disabled = false,
  role,
  checked,
  describedBy,
  title,
  onClick,
}: {
  /** The visible word: one word. */
  label: string;
  /** The full phrase — the visible word is an abbreviation of it. */
  ariaLabel: string;
  icon: React.ReactNode;
  state?: CorrectionTileState;
  disabled?: boolean;
  /** `"switch"` for a standing choice about the page, per {@link DewarpTile}. */
  role?: "switch";
  checked?: boolean;
  /** Ties a switch to whatever the explanation card is saying about it. */
  describedBy?: string;
  /** A hint about *which page this is for* — a tooltip, not an instruction. */
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      title={title ?? ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex h-[60px] min-w-0 flex-col items-center justify-center gap-1.5",
        "overflow-hidden rounded-[14px] px-1",
        "transition-colors duration-200",
        "disabled:cursor-not-allowed disabled:opacity-40",
        TILE_STATE_CLASSES[state],
      )}
    >
      {icon}
      <span className="max-w-full truncate text-xs font-semibold leading-none">
        {label}
      </span>
    </button>
  );
}
