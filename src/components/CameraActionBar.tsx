"use client";

import * as React from "react";
import clsx from "clsx";
import { SpinnerIcon } from "@/components/icons";

/**
 * The camera's control row: one escape hatch, one shutter, one way onward.
 *
 * It replaces three affordances that were only *technically* controls — an 11px
 * underlined "galeria", a 13px "passo 2 →" and a 72px shutter between them. Both
 * words were around 27px tall in the smallest dimension: findable with a mouse,
 * not with a thumb on a bus. The row now spends the same height on three real
 * targets, and it spends LESS of it: the shutter came down from 72px to 62px,
 * which is what pays for two 52px pills either side of it without pushing the
 * viewfinder up.
 *
 * **The pills are equal and the shutter is not.** Left and right are `flex-1`,
 * so the shutter stays centred on the frame no matter how long the labels get in
 * either language — the one geometric promise a camera app owes: the button is
 * where your thumb already is.
 *
 * **Colour is a `tone`, never a `className`** — same rule, same reason as
 * `META_TONE_CLASSES` in the kit: Tailwind resolves two utilities for one
 * property by stylesheet order, not by class-string order.
 */

/**
 * The three jobs a pill can have on the viewfinder.
 *
 * `warning` is the interesting one, and it is deliberately NOT filled: it is
 * worn by the "carry on anyway" action when something on screen wants a second
 * look, and filling it would make the app recommend the thing it is warning
 * about. The eye is supposed to land on the flagged page, not on the way past
 * it.
 */
export type PillTone = "outline" | "primary" | "warning";

const PILL_TONE_CLASSES: Record<PillTone, string> = {
  outline: "border-[1.5px] border-shell-line bg-transparent text-shell-ink",
  primary: "border-[1.5px] border-shell-ink bg-shell-ink text-shell-on",
  warning: "border-[1.5px] border-shell-warnline bg-transparent text-shell-warn",
};

const PILL_TONE_HOVER: Record<PillTone, string> = {
  outline: "hover:border-shell-ink",
  primary: "hover:opacity-90",
  warning: "hover:border-shell-warn",
};

interface CameraPillProps {
  /** See {@link PILL_TONE_CLASSES}. Never pass a colour through `className`. */
  tone?: PillTone;
  /** Stacked above the label. An SVG from the icon set — never a glyph. */
  icon?: React.ReactNode;
  /** The mono micro-line above the label: "PASSO 2". */
  overline?: string;
  /** The visible word. Lowercase here — this row is the camera's own voice. */
  label: string;
  /**
   * The accessible name, when the visible label leaves something out. The
   * onward pill uses it to carry the page count the header shows visually.
   */
  ariaLabel?: string;
  disabled?: boolean;
  onClick?: () => void;
  /**
   * Renders the pill as a `<label>` wrapping this input instead of a button.
   * A file picker has to be opened by the input's own activation — forwarding a
   * click from a button is what makes pickers silently not open on iOS.
   */
  input?: React.ReactNode;
}

/** One half of the row: 52px tall, full pill, icon or overline above a word. */
export function CameraPill({
  tone = "outline",
  icon,
  overline,
  label,
  ariaLabel,
  disabled = false,
  onClick,
  input,
}: CameraPillProps) {
  const shell = clsx(
    "inline-flex h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-px",
    "rounded-full px-2 text-center transition-colors duration-200",
    PILL_TONE_CLASSES[tone],
    !disabled && PILL_TONE_HOVER[tone],
    disabled && "cursor-not-allowed opacity-45",
  );

  const body = (
    <>
      {overline !== undefined && (
        <span
          aria-hidden="true"
          className="font-mono text-[10px] uppercase leading-none tracking-[0.08em] opacity-70"
        >
          {overline}
        </span>
      )}
      {icon}
      {/* The label wraps rather than truncates when it is a sentence rather
          than a word ("já tenho a foto", "I already have the photo"): a pill
          that says "I already have the p…" has lost the only thing it was
          telling the user. Two lines at 10.5px still clear the 52px pill with
          room for the glyph above them; the overline variant keeps `truncate`,
          because its label is one word by construction. */}
      <span
        className={clsx(
          "max-w-full",
          overline === undefined
            ? "line-clamp-2 text-[10.5px] font-semibold leading-[1.15]"
            : "truncate text-[11.5px] font-bold leading-none",
        )}
      >
        {label}
      </span>
    </>
  );

  if (input !== undefined) {
    return (
      <label
        aria-label={ariaLabel}
        className={clsx(shell, !disabled && "cursor-pointer")}
      >
        {input}
        {body}
      </label>
    );
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={shell}
    >
      {body}
    </button>
  );
}

interface CameraShutterProps {
  /** Announced name — "Fotografar página 3". */
  label: string;
  /** A capture is in flight: the ring holds still and shows the spinner. */
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}

/**
 * The shutter: 62px, and the only round control in the app.
 *
 * The ring and the disc are the same ink with a 4px gap between them, which is
 * what a camera shutter has looked like since the first phone had one — the
 * shape is the label, which is why this is the app's one licensed icon-only
 * control.
 */
export function CameraShutter({
  label,
  busy = false,
  disabled = false,
  onClick,
  buttonRef,
}: CameraShutterProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      disabled={disabled || busy}
      onClick={onClick}
      className={clsx(
        "relative flex h-[62px] w-[62px] shrink-0 items-center justify-center rounded-full",
        "border-4 shadow-lg backdrop-blur-sm transition-colors duration-200",
        disabled
          ? "border-shell-line bg-shell-dim"
          : "border-shell-ink bg-shell-dim2",
        "disabled:opacity-70",
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "flex h-[46px] w-[46px] items-center justify-center rounded-full",
          disabled ? "bg-shell-dim" : "bg-shell-ink text-shell-on",
        )}
      >
        {busy && <SpinnerIcon size={22} />}
      </span>
    </button>
  );
}

/**
 * The row itself. Children are laid out in order — left pill, shutter, right
 * pill — and a missing side must still be given its `flex-1` slot, or the
 * shutter drifts off the frame's centre line the moment one of them is absent.
 */
export function CameraActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5">{children}</div>
  );
}

/** The empty half of a row — keeps the shutter centred when a pill is absent. */
export function CameraPillSpacer() {
  return <span aria-hidden="true" className="min-w-0 flex-1" />;
}
