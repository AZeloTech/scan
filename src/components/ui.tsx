"use client";

import * as React from "react";
import clsx from "clsx";
import { useCopy } from "@/components/I18n";
import { useFlowNavigation } from "@/hooks/useFlowNavigation";

/**
 * The small shared kit. Three rules it enforces for the whole app:
 *
 * **Hierarchy.** There is exactly one `primary` per screen — the thing we want
 * the user to do next. `secondary` is an outlined alternative, `quiet` is a
 * text link, `danger` is the outlined destructive one. A screen with two
 * primaries has no primary.
 *
 * **A disabled primary is still THE action.** It keeps the deep fill at 45%
 * opacity: unmistakably inert, but the eye still lands on it and knows where
 * the journey continues. Greying it out to sand would hide the goal.
 *
 * **Two surfaces, one vocabulary.** Half this app runs on paper (cream/warm)
 * and half on the camera's own darkness (`night`). Rather than fork every
 * component, each one takes `onNight` and swaps its palette — so a button on
 * the viewfinder is the same button, wearing the other coat. Shape follows the
 * surface too, per the `Scan App 2a` canvas: paper screens get full pills,
 * night screens get 12px blocks that sit closer together under a thumb.
 */

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-deep text-warm shadow-sm",
  secondary: "border-[1.5px] border-moss bg-transparent text-leaf",
  quiet: "bg-transparent text-text-soft underline underline-offset-4",
  danger: "border-[1.5px] border-destroyed/60 bg-transparent text-destroyed",
};

/**
 * Hover is a SEPARATE map, applied only when the button is live.
 *
 * Stacking a "cancel the hover" utility on top of the variant's own — the
 * obvious way to write this — is the same stylesheet-order coin flip described
 * on `META_TONE_CLASSES`, because `hover:bg-transparent` and `hover:bg-deep`
 * set the same property in the same state. An inert button simply gets no
 * hover class at all.
 */
const VARIANT_HOVER: Record<ButtonVariant, string> = {
  primary: "hover:bg-leaf",
  secondary: "hover:bg-frost",
  quiet: "hover:text-deep",
  danger: "hover:border-destroyed",
};

/**
 * The same four roles, read against the **themeable camera shell**.
 *
 * Every value here is derived from the one colour the user picked, so these
 * hold on a charcoal shell and on a paper one alike — see `lib/shell-theme.ts`
 * for the contrast floors that guarantee it.
 */
const NIGHT_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-shell-ink text-shell-on shadow-sm",
  secondary: "border border-shell-line bg-transparent text-shell-ink",
  quiet: "bg-transparent text-shell-ink2 underline underline-offset-4",
  danger: "border border-shell-warnline bg-transparent text-shell-warn",
};

const NIGHT_VARIANT_HOVER: Record<ButtonVariant, string> = {
  primary: "hover:opacity-90",
  secondary: "hover:border-shell-ink",
  quiet: "hover:text-shell-ink",
  danger: "hover:border-shell-warn",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
  /** Rendered before the label, already `aria-hidden` by the icon set. */
  icon?: React.ReactNode;
  /** Sitting on a camera or full-bleed page surface. */
  onNight?: boolean;
}

/**
 * `aria-disabled` is deliberately supported alongside `disabled`: a CTA has to
 * be able to LOOK inert while still receiving the tap, so that tapping it can
 * point the user at what is missing instead of doing nothing at all.
 */
export function Button({
  variant = "primary",
  fullWidth = false,
  icon,
  onNight = false,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const ariaDisabled = rest["aria-disabled"];
  const inert =
    rest.disabled === true || ariaDisabled === true || ariaDisabled === "true";

  return (
    <button
      type={type}
      className={clsx(
        "inline-flex min-h-cta items-center justify-center gap-2 px-5",
        onNight ? "rounded-xl" : "rounded-full",
        "text-lg font-semibold leading-tight",
        "transition-colors duration-200",
        fullWidth && "w-full",
        onNight ? NIGHT_VARIANT_CLASSES[variant] : VARIANT_CLASSES[variant],
        !inert && (onNight ? NIGHT_VARIANT_HOVER[variant] : VARIANT_HOVER[variant]),
        inert && "cursor-not-allowed opacity-45",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * "voltar", as a control rather than as a hint.
 *
 * It was an 11px underlined word in the header's right-hand corner, wearing a
 * 56px invisible hit area — which is honest arithmetic and a bad button: what a
 * thumb aims at is what it can see, and what it could see was two centimetres
 * of nothing around a caption. The pill is 44px of visible target on the camera
 * shells and 40px on paper, and it moves to the **leading** edge, where a back
 * affordance has lived since the first phone: the corner people press without
 * reading.
 *
 * The arrow is decoration — the word "voltar" is the label, and the glyph is
 * `aria-hidden` so a screen reader is not made to say it twice.
 */
export function BackPill({
  label,
  onNight = false,
  onClick,
}: {
  label: string;
  onNight?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border-[1.5px]",
        "text-[12.5px] font-semibold leading-none transition-colors duration-200",
        onNight
          ? "h-11 border-shell-line px-[15px] text-shell-ink hover:border-shell-ink"
          : "h-10 border-moss px-[14px] text-leaf hover:bg-frost",
      )}
    >
      <span aria-hidden="true" className="font-mono leading-none">
        ←
      </span>
      {label}
    </button>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Always announced — an icon alone says nothing to a screen reader. */
  label: string;
  /**
   * `sage` is the list-operation outline: an arrow that reorders a document is
   * a sage control, not a neutral one, and it has to read as live at a glance
   * next to its disabled twin at the top of the list.
   */
  tone?: "neutral" | "danger" | "sage";
  onNight?: boolean;
  /**
   * 44px instead of 56px. **The one documented exception to the tap floor**:
   * allowed ONLY inside a row of related icon
   * buttons that also keeps ≥8px between them. Never for a standalone control.
   */
  dense?: boolean;
  /**
   * Radius, as a **prop** — never a `className="rounded-full"`, which would put
   * two utilities on `border-radius` in one class string for Tailwind to
   * resolve by stylesheet order (see the note on `META_TONE_CLASSES`).
   *
   * `circle` is reserved for the one control that has to read as *apart* from
   * the row it sits in: the × that removes a page, which must not look like a
   * sibling of the ↑ ↓ that merely move it.
   */
  shape?: "square" | "circle";
}

/** A square icon control (56px, or 44px in a gapped row), label always announced. */
export function IconButton({
  label,
  tone = "neutral",
  onNight = false,
  dense = false,
  shape = "square",
  className,
  type = "button",
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex items-center justify-center",
        dense ? "h-11 w-11" : "h-14 min-h-tap w-14 min-w-tap",
        // 1.5px, not 1px, and set ONCE here: a tone map that also carried a
        // width would be two utilities racing for `border-width` in one class
        // string, which Tailwind resolves by stylesheet order (see the note on
        // `META_TONE_CLASSES`).
        shape === "circle" ? "rounded-full" : "rounded-xl",
        "border-[1.5px] bg-transparent transition-colors duration-200",
        onNight
          ? tone === "danger"
            ? "border-shell-warnline text-shell-warn hover:border-shell-warn"
            : "border-shell-line text-shell-ink hover:border-shell-ink"
          : tone === "danger"
            ? "border-destroyed/40 text-destroyed hover:border-destroyed"
            : tone === "sage"
              ? "border-moss text-leaf hover:border-sage"
              : "border-border text-deep hover:border-sage",
        "disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export type MetaTone =
  | "faint"
  | "night"
  | "sage"
  | "mist"
  | "pine"
  | "peach"
  | "ink"
  /**
   * The light ink itself (#FAFAF7) — the one tone that is not derived from a
   * surface token, because the surface underneath it is a *photograph* or the
   * PDF reader's dark ground rather than one of the app's own. Only ever used
   * inside a pill that supplies its own dark fill.
   */
  | "warm"
  /**
   * The quietest label the app draws (#7B7C72) — decoration next to a word
   * that already carries the meaning, never a fact on its own. It exists for
   * the second line of the two-line footer buttons the spec draws on step 2.
   */
  | "dim"
  /**
   * The desktop mode's quietest mono ink (#9A9A90) — counters, file sizes and
   * the shortcut hint on its light cards. Fixed, like the rest of that
   * palette: the desktop never shows the shell picker.
   */
  | "deskFaint"
  /**
   * Sage read on a **dark** ground (#8FAB9B), fixed rather than derived. The
   * `mist` tone above is the themeable shell's accent variable, which the
   * desktop viewer has no colour to derive from — this is the literal value.
   */
  | "deskMist";

/**
 * Colour is a `tone`, never a `className`.
 *
 * Tailwind resolves two utilities for the same property by their order in the
 * generated stylesheet, not by their order in the class string — so passing
 * `className="text-mist"` to a component that already sets `text-text-faint`
 * is a coin flip, and the coin lands differently per build. Every component in
 * this kit that owns a colour therefore exposes the choice as a prop.
 */
const META_TONE_CLASSES: Record<MetaTone, string> = {
  faint: "text-ink-4",
  night: "text-shell-ink2",
  sage: "text-sage",
  mist: "text-shell-accent",
  pine: "text-pine",
  peach: "text-peach",
  ink: "text-ink",
  warm: "text-warm",
  dim: "text-ink-3",
  deskFaint: "text-desk-faint",
  deskMist: "text-mist",
};

export type MetaSize = "md" | "sm" | "xs" | "2xs";

/**
 * Size is a `tone`-shaped prop for the same reason colour is: two `text-*`
 * utilities in one class string race each other in the stylesheet.
 *
 * `md` (11px) is the app's own micro-label. The three below it exist only where
 * the design names a size — the details list on step 3, the counter and
 * row verdict on step 2, the second line of a two-line footer button.
 */
const META_SIZE_CLASSES: Record<MetaSize, string> = {
  md: "text-2xs",
  sm: "text-3xs",
  xs: "text-4xs",
  "2xs": "text-5xs",
};

/**
 * The mono micro-label: "PASSO 1 DE 3", "2 pág.", "nada sai deste aparelho".
 *
 * It is the canvas's whole mechanism for state that is *true but not the
 * point* — counts, progress, provenance. Keeping it in one component is what
 * stops it drifting into a second body voice: it is always JetBrains Mono, and
 * `caps` and `size` are the only variations it gets.
 */
export function Meta({
  caps = false,
  onNight = false,
  tone,
  size = "md",
  className,
  children,
}: {
  /** Tracked uppercase — for section markers, never for a live count. */
  caps?: boolean;
  onNight?: boolean;
  /** Overrides the surface default. See {@link META_TONE_CLASSES}. */
  tone?: MetaTone;
  /** A prop, never a `className`. See {@link META_SIZE_CLASSES}. */
  size?: MetaSize;
  /** Layout and type only — never a colour or a size. */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={clsx(
        "font-mono leading-none",
        META_SIZE_CLASSES[size],
        caps && "uppercase tracking-[0.08em]",
        META_TONE_CLASSES[tone ?? (onNight ? "night" : "faint")],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type StepNumber = 1 | 2 | 3;

/**
 * The trail — the canvas's central idea, and the reason the flow is legible at
 * all: three bars and three words, on every screen that belongs to a step, so
 * "where am I and how much is left" never has to be inferred from the copy.
 *
 * Steps *behind* the current one stay filled rather than reverting to the
 * track colour: the bar is progress, not a radio group.
 */
export function StepTrail({
  current,
  onNight = false,
  className,
}: {
  current: StepNumber;
  onNight?: boolean;
  className?: string;
}) {
  const copy = useCopy();
  // The three steps, in the order they happen. Index 0 is "fotografar".
  const steps = copy.common.steps;

  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      <div
        className="flex items-center gap-1.5"
        role="img"
        aria-label={`${copy.common.stepOfThree(current)}: ${steps[current - 1]}`}
      >
        {steps.map((step, index) => (
          <div
            key={step}
            // Selected by `countIntro` so the trail can draw itself in on the
            // first screen. Harmless everywhere else: nothing else queries it.
            data-trail-fill={index < current ? "" : undefined}
            className={clsx(
              "h-1 flex-1 origin-left rounded-full transition-colors duration-300",
              index < current
                ? onNight
                  ? "bg-shell-accent"
                  : "bg-leaf"
                : onNight
                  ? "bg-shell-dim"
                  : "bg-frost",
            )}
          />
        ))}
      </div>
      <div aria-hidden="true" className="flex justify-between gap-2">
        {steps.map((step, index) => (
          <span
            key={step}
            className={clsx(
              "font-mono text-2xs leading-none",
              index + 1 === current
                ? onNight
                  ? "text-shell-accent"
                  : "text-leaf"
                : onNight
                  ? "text-shell-ink2"
                  : "text-ink-4",
            )}
          >
            {index + 1} {step}
          </span>
        ))}
      </div>
    </div>
  );
}

export type ChipTone =
  | "neutral"
  | "ok"
  | "warning"
  | "busy"
  /**
   * A fact the app could not measure: quiet grey, deliberately neither the
   * green of a verdict nor the amber of a warning.
   */
  | "quiet"
  /** Over the viewfinder: neutral guidance. */
  | "night"
  /** Over the viewfinder: the detector locked on. */
  | "found"
  /** Over the viewfinder: something needs the user's hands. */
  | "alert"
  /** On a night surface: a quiet, settled fact. */
  | "dim";

/**
 * Every chip colour, as a closed set — see the note on {@link META_TONE_CLASSES}
 * for why these are tones and not `className` overrides.
 */
export const CHIP_TONE_CLASSES: Record<ChipTone, string> = {
  neutral: "bg-frost text-leaf",
  ok: "bg-ok-bg text-ok-ink",
  warning: "bg-warning-bg text-warning-deep",
  busy: "bg-cream text-text-soft",
  // `ink-4` on `cream` is 5.0:1 — the quiet grey that still clears AA, where
  // `ink-3`/`text-faint` is decoration only.
  quiet: "bg-cream text-ink-4",
  night: "bg-shell-sunken text-shell-ink",
  found: "bg-leaf/90 text-warm",
  // `ink` on `peach`, not the canvas's peach-on-dark: this chip appears exactly
  // when the user has to read it and do something.
  alert: "bg-peach/95 text-ink",
  dim: "bg-shell-sunken text-shell-ink2",
};

/**
 * `sm` (10px) exists for the one place the design names a size: the
 * status pill at the head of the page view. Like {@link MetaSize} it is a prop
 * rather than a `className`, because exactly one `text-*` utility may reach the
 * element — see the note on {@link META_TONE_CLASSES}.
 */
export type ChipSize = "md" | "sm";

interface ChipProps {
  tone?: ChipTone;
  children: React.ReactNode;
  /** Layout only — never a colour or a size. Use `tone` / `size`. */
  className?: string;
  /** Leading SVG — never a glyph character. */
  icon?: React.ReactNode;
  /** Mono, for a chip that carries state rather than a name. */
  mono?: boolean;
  /** A prop, never a `className`. See {@link ChipSize}. */
  size?: ChipSize;
}

export function Chip({
  tone = "neutral",
  children,
  className,
  icon,
  mono = false,
  size = "md",
}: ChipProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1",
        mono ? "font-mono" : "font-semibold",
        // One size utility, chosen here rather than stacked: `sm` when asked
        // for, otherwise the surface's own default.
        size === "sm" ? "text-4xs" : mono ? "text-2xs" : "text-xs",
        "leading-none",
        CHIP_TONE_CLASSES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

type CardTone = "plain" | "highlight";

/** Surface and rule as a prop — same reason as `META_TONE_CLASSES`. */
const CARD_TONE_CLASSES: Record<CardTone, string> = {
  plain: "border border-border bg-warm",
  highlight: "border-[1.5px] border-sage bg-frost",
};

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
}

export function Card({ tone = "plain", children, className, ...rest }: CardProps) {
  return (
    <div
      className={clsx("rounded-2xl p-4", CARD_TONE_CLASSES[tone], className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/*
 * There is no wordmark here.
 *
 * A library renders inside somebody else's page, and a lockup that says who
 * wrote the code is a claim on a surface the host owns — it would
 * sit under the host's own brand, saying a second name to a patient who came to
 * send an exam. Nothing replaces it: the header's leading edge simply holds the
 * back control or the screen's own title, which is what it was always for.
 */

/** Corner radii, as a prop rather than a racing `className`. */
export const RADIUS_CLASSES = {
  sm: "rounded",
  md: "rounded-md",
  xl: "rounded-xl",
} as const;

/** A calm shimmering block — never a spinner in the void. */
export function Skeleton({
  onNight = false,
  radius = "xl",
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  onNight?: boolean;
  /** A prop, not a `className`: see the note on `META_TONE_CLASSES`. */
  radius?: "sm" | "md" | "xl";
}) {
  return (
    <div
      aria-hidden="true"
      className={clsx(
        "relative overflow-hidden",
        RADIUS_CLASSES[radius],
        onNight ? "bg-shell-sunken" : "bg-cream",
        className,
      )}
      {...rest}
    >
      <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-sand to-transparent motion-safe:animate-gentle-sweep" />
    </div>
  );
}

/**
 * Announces what changed on its own, out loud.
 *
 * Everything interesting in this app happens without a click: a page lands, a
 * verdict arrives, an error appears. Sighted users get chips and colour; a
 * screen-reader user got silence until they went hunting. `polite` on purpose —
 * these are updates, not interruptions.
 */
export function LiveRegion({ message }: { message: string }) {
  return (
    <p aria-live="polite" aria-atomic="true" className="scan-sr-only">
      {message}
    </p>
  );
}

/**
 * `Escape` asks the host to close the flow.
 *
 * Every top-level screen calls this; the sheets and overlays that open *inside*
 * a screen keep their own Escape, which closes them and stops there
 * (`useDialogChrome` calls `preventDefault`, and this listener stands down when
 * it sees that). So one press never both closes a sheet and ends the scan.
 *
 * The listener is on `window`, after the document-level one, for exactly that
 * ordering. It asks; it does not close. The host owns the dialog, the focus
 * trap and the "discard these pages?" question — which is why this library
 * renders none of the three.
 */
export function useCancelOnEscape(active = true): void {
  const { requestCancel } = useFlowNavigation();

  React.useEffect(() => {
    if (!active) return;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      requestCancel("user");
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [active, requestCancel]);
}

interface NoticeProps extends React.HTMLAttributes<HTMLDivElement> {
  tone: "warning" | "ok" | "neutral" | "night";
  title?: string;
  children: React.ReactNode;
}

const NOTICE_CLASSES: Record<NoticeProps["tone"], string> = {
  warning: "bg-warning-bg text-warning-deep",
  ok: "bg-frost text-deep",
  neutral: "bg-cream text-text-soft",
  // The over-the-viewfinder tip box. The fill is `sunken`, never `dim`: `dim`
  // is a mid-tone meant for inactive graphics, and stacking warning text on it
  // put two mid-tones together and lost the message on a pale shell.
  night: "border border-shell-warnline bg-shell-sunken text-shell-warn",
};

export function Notice({
  tone,
  title,
  children,
  className,
  ...rest
}: NoticeProps) {
  return (
    <div
      className={clsx(
        "rounded-xl px-3 py-2.5 text-base leading-snug",
        NOTICE_CLASSES[tone],
        className,
      )}
      {...rest}
    >
      {title !== undefined && <p className="font-semibold">{title}</p>}
      <div className={clsx(title !== undefined && "mt-0.5")}>{children}</div>
    </div>
  );
}
