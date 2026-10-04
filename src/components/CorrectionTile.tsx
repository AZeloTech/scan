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
 * **Drawn plain, as in the mockup** (owner, 2026-09-30): no tinted well behind
 * any state. A correction this page is wearing is a **small dot on the icon's
 * corner**, in the shell's accent; the recommended way out of a flagged state
 * (Cantos, on a page that went in flat) is the same dot in the warn tone. The
 * dot is decoration — what it means is the tool's accessible description
 * (`note`: "aplicado", "recomendado"). The old tinted wells made the finish,
 * which is on by default, read as a greyed-out tool on almost every page.
 *
 * **Dimmed only when the tool really cannot be used**, and then `note` says
 * why ("indisponível — esta página falhou"), as the description and the
 * tooltip. The row is always four columns wide, so a page that cannot be
 * straightened has the same shape as one that can.
 *
 * Hover is only drawn where there is a real hover: a phone keeps `:hover` on
 * whatever sits under the last tap — the thumbnail that opened the editor sits
 * where Girar lands, which is how Girar came to wear a dark well on a page that
 * had done nothing to deserve it.
 *
 * The label is one word by contract: four equal columns at 320 px leave about
 * 70 px of 12 px text each, and half a verb is not a control. 60 px tall and a
 * quarter of the row wide, so the target clears 44 px both ways.
 */
export type CorrectionTileState =
  /** Offered, and this page is not wearing it. */
  | "default"
  /** This page is wearing it: the accent dot. */
  | "applied"
  /**
   * The way out of the state the status line is reporting: the corners tool
   * after a page went in flat. The warn-toned dot — recommended, not reported.
   */
  | "suggested";

/** The dot's colour, as a closed map (never a `className` override). */
const DOT_CLASSES: Record<Exclude<CorrectionTileState, "default">, string> = {
  applied: "bg-shell-accent",
  suggested: "bg-shell-warn",
};

export function CorrectionTile({
  label,
  ariaLabel,
  icon,
  state = "default",
  disabled = false,
  note,
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
  /**
   * What the dot or the dimming means, in words: the accessible description
   * and part of the tooltip. Required in spirit whenever `state` is not
   * `"default"` or the tool is disabled.
   */
  note?: string;
  /** `"switch"` for a standing choice about the page, per {@link DewarpTile}. */
  role?: "switch";
  checked?: boolean;
  /** Ties a switch to whatever the explanation card is saying about it. */
  describedBy?: string;
  /** A hint about *which page this is for* — a tooltip, not an instruction. */
  title?: string;
  onClick: () => void;
}) {
  const noteId = React.useId();
  const hasNote = note !== undefined && note.length > 0;
  const described = [hasNote ? noteId : null, describedBy ?? null].filter(Boolean).join(" ");
  const tooltip = title ?? ariaLabel;
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={described.length > 0 ? described : undefined}
      title={hasNote ? `${tooltip} — ${note}` : tooltip}
      disabled={disabled}
      onClick={onClick}
      data-tool-state={state}
      className={clsx(
        "flex h-[60px] min-w-0 flex-col items-center justify-center gap-1.5",
        "overflow-hidden rounded-[14px] px-1 text-shell-ink",
        "transition-colors duration-200",
        "[@media(hover:hover)_and_(pointer:fine)]:hover:bg-shell-sunken",
        "disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      <span className="relative inline-flex">
        {icon}
        {state !== "default" && (
          <span
            aria-hidden="true"
            data-tool-dot
            className={clsx(
              "absolute -right-[3px] -top-[2px] h-[7px] w-[7px] rounded-full ring-2 ring-shell",
              DOT_CLASSES[state],
            )}
          />
        )}
      </span>
      <span className="max-w-full truncate text-xs font-semibold leading-none">
        {label}
      </span>
      {hasNote && (
        <span id={noteId} hidden>
          {note}
        </span>
      )}
    </button>
  );
}
