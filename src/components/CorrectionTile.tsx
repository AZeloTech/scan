"use client";

import * as React from "react";
import clsx from "clsx";

/**
 * One of the page editor's four corrections: a 66 px block, icon over one
 * lowercase mono word, four to a line.
 *
 * It lives in its own module because two components draw it — the editor's own
 * three tiles and {@link DewarpTile}, which is a `switch` rather than a button
 * and therefore cannot simply be another instance rendered by the editor. Two
 * copies of these class strings is how the row ends up with two slightly
 * different boxes in it, which is exactly what the fixed-band redesign is for.
 *
 * **The applied state lives on the tile**, not on a chip floating over the
 * picture: a correction this page is wearing is a fact about the control that
 * applied it. **Disabled is shown, never hidden** — the row is always four
 * columns wide, so a page that cannot be straightened has the same shape as one
 * that can, and the reader learns the layout once.
 *
 * The label is one word by contract: four equal columns at 375 px leave about
 * 68 px of mono text each (54 px at 320 px), and half a verb is not a control.
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
 * Colour as a closed map, never a `className` override — two `border-*`
 * utilities in one class string are resolved by the generated stylesheet's
 * order, not the string's (the rule `ui.tsx` records on `META_TONE_CLASSES`).
 *
 * `mist` and `peach-soft` are fixed tokens, so their tints may carry an opacity
 * modifier; the border and the text take the **shell's** own accent and warn
 * values, which `lib/shell-theme.ts` guarantees against whatever surface colour
 * the user picked — a fixed `#8fab9b` label would be legible on the design's
 * green and nowhere else on the ramp.
 */
const TILE_STATE_CLASSES: Record<CorrectionTileState, string> = {
  default: "border-shell-line text-shell-ink hover:border-shell-ink",
  applied: "border-shell-accent bg-mist/[0.16] text-shell-accent",
  suggested: "border-shell-warn bg-peach-soft/[0.14] text-shell-warn",
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
  /** The visible word: lowercase, mono, one word. */
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
        "flex h-[66px] flex-1 flex-col items-center justify-center gap-[5px]",
        "overflow-hidden rounded-[14px] border-[1.5px] px-1",
        "transition-colors duration-200",
        "disabled:cursor-not-allowed disabled:opacity-40",
        TILE_STATE_CLASSES[state],
      )}
    >
      {icon}
      <span className="max-w-full truncate font-mono text-4xs leading-none">
        {label}
      </span>
    </button>
  );
}
