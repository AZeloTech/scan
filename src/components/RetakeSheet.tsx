"use client";

import * as React from "react";
import clsx from "clsx";
import type { PageTile } from "@/lib/page-tiles";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { useStore } from "@/hooks/useScanStore";
import { useScanRuntime } from "@/hooks/useScanRuntime";
import { PageThumb } from "@/components/PageThumb";
import { PreviewCanvas } from "@/components/PreviewCanvas";
import { CameraPill } from "@/components/CameraActionBar";
import { CaptureStage, type Capture } from "@/components/CaptureStage";
import { CameraIcon, CheckIcon, XIcon } from "@/components/icons";
import { ARROW_DELTA } from "@/components/AcabamentoSheet";
import { useCopy, useLang } from "@/components/I18n";
import { localeTag } from "@/lib/i18n";
import { Button, Chip, Meta } from "@/components/ui";

/**
 * Retake, in two calm steps: take the new photo, then decide which one stays.
 *
 * The comparison is two stacked full-width cards with one big toggle — never
 * side by side, which is unreadable at 375 px. Confirming replaces the page's
 * artifacts in place, so it keeps its id and its position in the document.
 *
 * It sits on `night` for the same reason the viewfinder and the page view do:
 * for its whole first half it *is* a viewfinder, and for its second half the
 * two photographs are the subject. Switching surfaces halfway through one
 * decision would make the second half feel like a different screen.
 *
 * It borrows the app shell rather than the AppFrame component because it IS the
 * screen while it is open — and because it covers the screen just as completely
 * as the preview overlay, it owes the same modal semantics (`useDialogChrome`):
 * focus in, trapped, restored; Escape closes.
 */

interface RetakeSheetProps {
  tile: PageTile;
  onClose: () => void;
}

type Choice = "old" | "new";

export function RetakeSheet({ tile, onClose }: RetakeSheetProps) {
  const copy = useCopy();
  const { lang } = useLang();
  const store = useStore();
  const { intake } = useScanRuntime();
  const [fresh, setFresh] = React.useState<Capture | null>(null);
  /** Bumped per photo, so a second retake repaints instead of reusing the first. */
  const [freshKey, setFreshKey] = React.useState(0);
  const [choice, setChoice] = React.useState<Choice>("new");
  const containerRef = useDialogChrome<HTMLDivElement>(onClose);

  const handleCapture = React.useCallback((capture: Capture) => {
    setFresh(capture);
    setFreshKey((key) => key + 1);
    setChoice("new");
  }, []);

  const handleConfirm = React.useCallback(() => {
    if (fresh === null || choice === "old") {
      onClose();
      return;
    }
    store.replaceCapture(tile.pageId, {
      canonical: fresh.canonical,
      corners: fresh.corners,
      gate: fresh.gate,
      path: fresh.path,
    });
    onClose();
  }, [choice, fresh, onClose, store, tile.pageId]);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={copy.retake.dialogLabel(tile.humanNumber)}
      className="fixed inset-0 z-40 flex justify-center overscroll-contain bg-shell"
    >
      <div className="flex h-full w-full max-w-[30rem] flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-[max(env(safe-area-inset-top),14px)]">
          <h1 className="min-w-0 truncate font-display text-xl font-semibold text-shell-ink">
            {copy.retake.title(tile.humanNumber)}
          </h1>
          <button
            type="button"
            aria-label={copy.common.close}
            onClick={onClose}
            className="-mr-2 inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center text-shell-ink"
          >
            <span
              aria-hidden="true"
              className="flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-shell-line transition-colors duration-200 hover:border-shell-ink"
            >
              <XIcon size={20} />
            </span>
          </button>
        </header>

        {fresh === null ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-[max(env(safe-area-inset-bottom),14px)]">
            <p className="shrink-0 text-sm leading-snug text-shell-ink2">
              {copy.retake.lead}
            </p>
            <CaptureStage
              onCapture={handleCapture}
              captureLabel={copy.capture.take(tile.humanNumber)}
              pageNumber={tile.humanNumber}
              // A host that switched the camera off does not get one here
              // either: the stage falls back to the file intake by itself.
              useCamera={intake.camera}
              path="retake"
              rightAction={
                <CameraPill
                  label={copy.common.cancel.toLocaleLowerCase(localeTag(lang))}
                  ariaLabel={copy.retake.cancelAria(tile.humanNumber)}
                  onClick={onClose}
                />
              }
            />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
              <div className="flex flex-col gap-3">
                <div
                  role="radiogroup"
                  aria-label={copy.retake.chooseLabel}
                  // The track is `sunken` + a hairline, the same pairing the
                  // night `Notice` uses. On `dim` the unselected label sat at
                  // 1.86:1; `sunken` puts it at 7.0:1 AND lifts the selected
                  // pill's own contrast against the track from 2.99:1 to
                  // 11.2:1. `sunken` is only 1.2:1 against the shell, so the
                  // border — not the fill — is what still draws the group.
                  className="flex gap-1.5 rounded-xl border border-shell-line bg-shell-sunken p-1.5"
                  onKeyDown={(event) => {
                    if (ARROW_DELTA[event.key] === undefined) return;
                    event.preventDefault();
                    const next: Choice = choice === "old" ? "new" : "old";
                    setChoice(next);
                    event.currentTarget
                      .querySelector<HTMLButtonElement>(`[data-choice="${next}"]`)
                      ?.focus();
                  }}
                >
                  {(
                    [
                      { value: "old", label: copy.retake.optionOld },
                      { value: "new", label: copy.retake.optionNew },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      data-choice={option.value}
                      aria-checked={choice === option.value}
                      tabIndex={choice === option.value ? 0 : -1}
                      onClick={() => setChoice(option.value)}
                      className={clsx(
                        "min-h-tap flex-1 rounded-lg px-3 text-base font-semibold",
                        "transition-colors duration-200",
                        choice === option.value
                          ? "bg-shell-ink text-shell-on"
                          : "text-shell-ink2",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <ComparisonCard
                  title={copy.retake.cardOld}
                  selected={choice === "old"}
                  badge={
                    <Meta onNight>
                      {tile.chipLabel.toLocaleLowerCase(localeTag(lang))}
                    </Meta>
                  }
                >
                  <PageThumb
                    tile={tile}
                    onNight
                    fit="contain"
                    className="h-52 w-full"
                  />
                </ComparisonCard>

                <ComparisonCard
                  title={copy.retake.cardNew}
                  selected={choice === "new"}
                  badge={
                    <Chip mono tone="dim">
                      {copy.retake.badgeNew}
                    </Chip>
                  }
                >
                  {/* Rendered rather than encoded: the new photo has no page
                      yet, and the comparison has to show it the way it would
                      look if kept — straightened and cleaned — without writing
                      a JPEG that would be thrown away the moment they choose. */}
                  <div className="h-52 w-full overflow-hidden rounded-xl border border-shell-line bg-shell">
                    <PreviewCanvas
                      request={{
                        canonical: fresh.canonical,
                        corners: fresh.corners,
                        rotation: 0,
                        finish: tile.page.finish,
                      }}
                      cacheKey={`retake-${freshKey}`}
                      longEdge={640}
                      label={copy.retake.newAlt}
                      className="h-full w-full object-contain"
                    />
                  </div>
                </ComparisonCard>
              </div>
            </div>

            <div className="safe-bottom shrink-0 px-4 pt-2">
              <div className="flex flex-col gap-2">
                <Button
                  fullWidth
                  onNight
                  icon={<CheckIcon size={20} />}
                  onClick={handleConfirm}
                >
                  {choice === "new" ? copy.retake.useNew : copy.retake.keepOld}
                </Button>
                <Button
                  variant="secondary"
                  onNight
                  fullWidth
                  icon={<CameraIcon size={20} />}
                  onClick={() => setFresh(null)}
                >
                  {copy.retake.takeAnother}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

interface ComparisonCardProps {
  title: string;
  selected: boolean;
  badge: React.ReactNode;
  children: React.ReactNode;
}

function ComparisonCard({
  title,
  selected,
  badge,
  children,
}: ComparisonCardProps) {
  return (
    <div
      className={clsx(
        "rounded-2xl border p-3 transition-colors duration-200",
        // Selection is the BORDER's job — `accent` vs `line` against the shell
        // is 5.6:1 vs 2.3:1. The fill is `sunken`, never `dim`: `dim` is a
        // graphic token that owes nothing to text, and it left this card's
        // title at 2.99:1 and its badge at 1.86:1.
        selected ? "border-shell-accent bg-shell-sunken" : "border-shell-line",
      )}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-display text-lg font-semibold text-shell-ink">{title}</p>
        {badge}
      </div>
      {children}
    </div>
  );
}
