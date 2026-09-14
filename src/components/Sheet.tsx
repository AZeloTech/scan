"use client";

import * as React from "react";
import clsx from "clsx";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { sheetIn } from "@/lib/motion";
import { useCopy } from "@/components/I18n";
import { XIcon } from "@/components/icons";

/**
 * The app's bottom sheet — one panel, over a dimmed screen, anchored to the
 * bottom edge.
 *
 * It exists because the page editor's redesign gives every correction its own
 * small surface (girar, acabamento, the ⋯ menu, the delete confirmation) and
 * five hand-rolled copies of the same `fixed inset-0` shell is exactly the
 * duplication this app already carries once. Only the four surfaces the design
 * covers use it; the full-screen dialogs (retake, corners, diagnostics) keep
 * their own shell, because they are screens rather than panels.
 *
 * Two constraints it owns for its callers:
 *
 *  * **The editor stays visible behind it.** The overlay is the app's darkest
 *    night at 60 %, and the panel is the `sunken` surface every other panel and
 *    chip in the app sits on — the pair the text tokens are proven against.
 *    The sheet is *about* the page, so the page must still be on screen.
 *  * **It is the innermost surface while it is open.** `useDialogChrome` moves
 *    focus in, traps it and answers Escape; the page editor's own back/Escape
 *    handling defers to whatever it has open (`PagePreview`).
 *
 * The column cap is the app's `30rem`: a phone-shaped sheet stretched across a
 * desktop viewport reads as a toolbar, not as a panel.
 */
export function Sheet({
  title,
  label,
  hideClose,
  onClose,
  children,
}: {
  /** Rendered as the sheet's heading, and its accessible name by default. */
  title: string;
  /** When the heading is not a full sentence for a screen reader. */
  label?: string;
  /**
   * Drops the × from the title row. For the destructive confirmation, where
   * "Manter" is the way out and a second, quieter exit next to it would be two
   * ways to say the same thing.
   */
  hideClose?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const copy = useCopy();
  const backdropRef = React.useRef<HTMLDivElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = useDialogChrome<HTMLDivElement>(onClose);

  React.useEffect(() => {
    sheetIn(backdropRef.current, panelRef.current);
  }, []);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={label ?? title}
      className="fixed inset-0 z-[55] flex flex-col justify-end overscroll-contain"
    >
      <div
        ref={backdropRef}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-night-deep/60"
      />
      <div
        ref={panelRef}
        className={clsx(
          "relative mx-auto w-full max-w-[30rem] rounded-t-[22px] bg-shell-sunken",
          "px-[18px] pt-4 pb-[max(env(safe-area-inset-bottom),20px)]",
          "shadow-[0_-16px_40px_-20px_rgba(0,0,0,0.6)]",
        )}
      >
        <div className="flex items-center justify-between gap-2.5">
          <h2 className="min-w-0 font-display text-xl font-semibold leading-tight text-shell-ink">
            {title}
          </h2>
          {hideClose !== true && (
            <button
              type="button"
              aria-label={copy.common.close}
              onClick={onClose}
              // 44px of tap around a 38px ring, per the design. The row is the
              // sheet's own header rather than one of the editor's fixed bands,
              // so growing it costs no picture and needs no pull-back.
              className="-my-[3px] inline-flex h-11 w-11 shrink-0 items-center justify-center text-shell-ink"
            >
              <span
                aria-hidden="true"
                className="flex h-[38px] w-[38px] items-center justify-center rounded-full border-[1.5px] border-shell-line transition-colors duration-200 hover:border-shell-ink"
              >
                <XIcon size={17} />
              </span>
            </button>
          )}
        </div>

        <div className="mt-3.5 flex flex-col gap-3.5">{children}</div>
      </div>
    </div>
  );
}

/**
 * The full-width filled action at the foot of a sheet — "Aplicar clarear",
 * "Salvar giro", "Apagar a página".
 *
 * Not the kit's `Button`: that one is a pill (or a 12 px block on night) sized
 * by `min-h-cta`, and the design's sheets draw a 56 px, 14 px-radius bar whose
 * `danger` variant is a *filled* peach rather than an outline. Tone is a typed
 * prop with a lookup map for the reason the whole kit does it that way — two
 * `bg-*` utilities in one class string race by stylesheet order.
 */
const SHEET_ACTION_CLASSES: Record<"primary" | "danger", string> = {
  primary: "bg-shell-ink text-shell-on hover:bg-cream",
  // The one destructive fill in the app: `peach-soft` with the design's own
  // deep brown ink, which lands at ~7.4:1 on it. The outlined `danger` the kit
  // uses elsewhere would put the weight on "Manter" instead.
  danger: "bg-peach-soft text-peach-ink hover:bg-peach",
};

export function SheetAction({
  tone = "primary",
  disabled = false,
  onClick,
  children,
}: {
  tone?: "primary" | "danger";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "inline-flex h-14 w-full items-center justify-center rounded-[14px]",
        "text-lg font-bold leading-none transition-colors duration-200",
        "disabled:cursor-not-allowed disabled:opacity-45",
        SHEET_ACTION_CLASSES[tone],
      )}
    >
      {children}
    </button>
  );
}

/** The outlined alternative under a {@link SheetAction} — "Manter". */
export function SheetSecondaryAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex h-[52px] w-full items-center justify-center rounded-[14px]",
        "border-[1.5px] border-shell-line text-lg font-semibold leading-none text-shell-ink",
        "transition-colors duration-200 hover:border-shell-ink",
      )}
    >
      {children}
    </button>
  );
}
