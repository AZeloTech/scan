"use client";

import * as React from "react";
import clsx from "clsx";
import { useCopy } from "@/components/I18n";
import {
  BackPill,
  Meta,
  StepTrail,
  type MetaSize,
  type StepNumber,
} from "@/components/ui";

/**
 * The app shell — a phone app, not a scrolling web page.
 *
 * The frame is exactly one viewport tall and splits into three flex rows: the
 * header, the middle, and (optionally) the bottom action bar. The bar is a flex
 * SIBLING of the middle rather than a `position: fixed` overlay, which is the
 * whole point: content physically cannot slide under it mid-scroll, so there is
 * no bottom-padding-equal-to-the-bar-height rule to get wrong.
 *
 * Two middles exist:
 *  - default: scrolls, and only when the content genuinely overflows;
 *  - `fill`: never scrolls, and hands its height to a `flex-1` child — this is
 *    how the capture surface grows to fill whatever the phone has left.
 *
 * Two surfaces exist, and they are the `Scan App 2a` canvas's own split:
 *  - `paper` (default) — cream/warm, for everything the user reads;
 *  - `night` — the camera and the full-bleed page, where the document is the
 *    only light in the frame.
 *
 * And the header carries the **step trail** whenever the screen belongs to one
 * of the three steps. That is what makes the flow legible without the copy
 * having to say "you are nearly there": three bars, three words, always in the
 * same place, on paper and on night alike.
 *
 * On a desktop it becomes a centred phone-width column, so the demo never looks
 * like a stretched form.
 */

interface AppFrameProps {
  children: React.ReactNode;
  /** Header title, in the display face. Omit it to show the wordmark instead. */
  title?: string;
  /** Right-hand contextual slot: a page count, a step label. */
  aside?: React.ReactNode;
  /** Renders the step trail under the title, and drives the "PASSO n DE 3" mark. */
  step?: StepNumber;
  /** A "voltar" pill on the header's leading edge. See {@link BackPill}. */
  onBack?: () => void;
  /** The bottom action bar. Omit it on screens with nothing to act on. */
  footer?: React.ReactNode;
  /** Middle fills the shell and never scrolls (the capture screen). */
  fill?: boolean;
  /** The camera's own surface. */
  tone?: "paper" | "night";
  className?: string;
}

export function AppFrame({
  children,
  title,
  aside,
  step,
  onBack,
  footer,
  fill = false,
  tone = "paper",
  className,
}: AppFrameProps) {
  const copy = useCopy();
  const night = tone === "night";
  const stepLabel =
    step === undefined ? copy.common.camera : copy.common.stepOfThree(step);

  return (
    <div
      className={clsx(
        // The app's shell rule lives here now that `/` is a scrolling landing
        // page: exactly one viewport tall, and the page itself never scrolls —
        // the middle row owns scrolling so the action bar can never be
        // scrolled away from, or slid under.
        //
        // `app-h`, not `h-dvh`: `dvh` reports the *dynamic* viewport and on a
        // real phone can hand back the tall, toolbar-hidden height while the
        // toolbar is still on screen — which puts the bottom action bar out of
        // reach. `.app-h` is `100svh` plus the height `AppShellLock` measures
        // from `visualViewport`. See globals.css.
        "app-h flex min-h-0 w-full shrink-0 justify-center overflow-hidden",
        night ? "bg-shell" : "bg-cream",
      )}
    >
      {/* Height comes from `align-items: stretch` on the row above, NOT from
          `h-full`. A percentage height here resolves against a containing
          block the browser treats as indefinite, silently falls back to
          `auto`, and the column sizes to its content — which collapses every
          `flex-1` beneath it, including the viewfinder. That shipped once as a
          zero-height camera. `min-h-0` keeps the children shrinkable. */}
      <div
        className={clsx(
          "flex min-h-0 w-full max-w-[30rem] flex-col overflow-hidden",
          night ? "bg-shell" : "bg-warm shadow-[0_0_60px_rgba(31,49,40,0.08)]",
        )}
      >
        <header
          className={clsx(
            "flex shrink-0 flex-col gap-2.5 px-4 pb-3",
            // The notch is the header's problem, not the content's.
            "pt-[max(env(safe-area-inset-top),12px)]",
            !night && "border-b border-cream",
          )}
        >
          {/* Leading edge: the way back, when there is one. Everything the
              screen wants to *say* about itself — its title on paper, its step
              marker on night, its count — sits opposite it, right-aligned.
              That is the phone-app convention, and it is also what lets the
              back affordance be a 44px pill instead of a caption in a corner
              (see `BackPill`). */}
          <div className="flex min-h-[28px] items-center justify-between gap-3">
            {onBack !== undefined ? (
              <BackPill
                label={copy.common.back}
                onNight={night}
                onClick={onBack}
              />
            ) : night ? (
              // On the viewfinder the title would compete with the document.
              // The step marker is all the orientation the screen needs.
              <Meta caps tone="mist">
                {stepLabel}
              </Meta>
            ) : title === undefined ? null : (
              <h1 className="min-w-0 truncate font-display text-xl font-semibold text-ink">
                {title}
              </h1>
            )}

            {/* The title steps aside for the pill and comes back one size
                down: at 16px it shares the row instead of fighting for it. */}
            {onBack !== undefined &&
              !night &&
              (title === undefined ? null : (
                <h1 className="min-w-0 flex-1 truncate text-right font-display text-lg font-semibold text-ink">
                  {title}
                </h1>
              ))}

            <div
              className={clsx(
                "flex shrink-0",
                // With the pill on the left, the night header's two facts
                // stack right-aligned rather than straddling the row.
                onBack !== undefined && night
                  ? "flex-col items-end gap-[3px]"
                  : "items-center gap-3",
              )}
            >
              {onBack !== undefined && night && (
                <Meta caps tone="mist">
                  {stepLabel}
                </Meta>
              )}
              {aside}
            </div>
          </div>

          {step !== undefined && <StepTrail current={step} onNight={night} />}
        </header>

        <main
          className={clsx(
            fill
              ? "flex min-h-0 flex-1 flex-col overflow-hidden"
              : "min-h-0 flex-1 overflow-y-auto overscroll-contain",
            className,
          )}
        >
          {children}
        </main>

        {footer !== undefined && (
          <div
            className={clsx(
              "safe-bottom shrink-0 px-4 pt-3",
              night ? "bg-shell" : "border-t border-cream bg-warm",
            )}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** The header's right-hand label — "3 páginas", "2 pág.", "passo 3 de 3". */
export function FrameStep({
  children,
  onNight = false,
  size,
}: {
  children: React.ReactNode;
  onNight?: boolean;
  /** The two flow screens set the spec's 10px counter; see {@link Meta}. */
  size?: MetaSize;
}) {
  return (
    <Meta onNight={onNight} size={size}>
      {children}
    </Meta>
  );
}
