"use client";

import * as React from "react";
import clsx from "clsx";
import type { CornerEditor, CornerPoints } from "scanic";
import { detectInBlob, localizeCornerHandles } from "@/lib/flatten";
import { loadScanic } from "@/lib/scanic-runtime";
import { assessBlob } from "@/lib/capture-gate";
import { decodeCanonical, releaseCanvas } from "@/lib/image";
import { denormalizeQuad, normalizeQuad } from "@/lib/quad";
import { deriveShellTheme, LOUPE_RING } from "@/lib/shell-theme";
import { useCopy } from "@/components/I18n";
import { FullImageView } from "@/components/FullImageView";
import { useShell } from "@/components/ShellTheme";
import type { PageTile } from "@/lib/page-tiles";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { useStore } from "@/hooks/useScanStore";
import { useAssetUrls, useScanRuntime } from "@/hooks/useScanRuntime";
import {
  ArrowLeftIcon,
  ExpandIcon,
  SpinnerIcon,
  UndoIcon,
} from "@/components/icons";
import { Meta, Notice } from "@/components/ui";

/**
 * Manual rescue for the pages the detector got wrong — and the only rescue
 * there is: when scanic finds no trustworthy page outline the raw frame goes
 * into the document untouched and the user is pointed here. No second detector
 * runs.
 *
 * Every capture already passes through `ConfirmCornersScreen`, so this
 * is not the first time the user is shown four handles — it is the LATER escape
 * hatch, opened from the page editor's `cantos` tile when a page turns out
 * wrong after the fact. Same editor, same canonical bytes, a different moment:
 * there the question is "are these the corners?", here it is "these are not,
 * fix them". Both are scanic's own touch corner editor, working on the page's
 * CANONICAL, pre-warp bytes (dragging corners on an already-warped page would
 * compound one crop onto another), with our own translated, full-size actions
 * instead of its compact toolbar.
 *
 * It is the one correction that needs a whole screen rather than a sheet,
 * because it is the one that is a *gesture*: the design gives it the editor's
 * own bands — header, one status line, the photo, the pills, the fixed footer —
 * on the dark surface every screen wears where the page itself is the subject.
 * The handles and the quad have to read against a photograph, and a cream
 * chrome around a dark photo puts the contrast in the wrong place.
 *
 * Confirming stores the new quad and the page re-renders itself from the same
 * canonical, in place, keeping its id and its position in the document. The
 * canonical is byte-immutable across the edit — nothing is re-encoded, so moving
 * the corners a third time costs the page nothing in fidelity.
 */

interface CornerAdjustSheetProps {
  tile: PageTile;
  /** How many pages the document has, for "página 2 de 5". */
  pageCount: number;
  onClose: () => void;
}

type Phase = "loading" | "ready" | "working" | "unavailable";

export function CornerAdjustSheet({
  tile,
  pageCount,
  onClose,
}: CornerAdjustSheetProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<CornerEditor | null>(null);
  const copy = useCopy();
  const store = useStore();
  const urls = useAssetUrls();
  const { reportError } = useScanRuntime();
  const [phase, setPhase] = React.useState<Phase>("loading");
  /**
   * "recomeçar": bumped to tear the editor down and build it again from the
   * corners this screen opened with. There is no undo stack to walk back
   * through — the editor's starting quad *is* the state to go back to.
   */
  const [attempt, setAttempt] = React.useState(0);
  const [fullView, setFullView] = React.useState(false);
  const fullViewRef = React.useRef(fullView);
  fullViewRef.current = fullView;
  const containerRef = useDialogChrome<HTMLDivElement>(() => {
    // The back gesture belongs to the innermost surface.
    if (fullViewRef.current) {
      setFullView(false);
      return;
    }
    onClose();
  });
  const { shell } = useShell();

  const canonical = tile.page.canonical;
  const pageId = tile.pageId;
  /** The pixel grid the editor is working on, for normalising its answer. */
  const frameRef = React.useRef<{ width: number; height: number } | null>(null);

  /** Store the user's corners; the page re-renders itself from them. */
  const apply = React.useCallback(
    async (corners: CornerPoints) => {
      setPhase("working");
      const frame = frameRef.current;
      // Measured on the PRE-warp frame, matching what the shutter path does:
      // the warp resamples the page, so sharpness and text height read
      // differently after it and would not be comparable to a live capture.
      const gate = await assessBlob(canonical);
      store.replaceCapture(pageId, {
        canonical,
        corners:
          frame === null ? null : normalizeQuad(corners, frame.width, frame.height),
        gate,
        path: "adjust",
      });
      onClose();
    },
    [canonical, onClose, pageId],
  );

  const applyRef = React.useRef(apply);
  applyRef.current = apply;

  /** A stable per-language object (the dictionary is a module constant). */
  const handleLabels = copy.corners.handles;

  React.useEffect(() => {
    let cancelled = false;
    let editor: CornerEditor | null = null;

    async function boot(): Promise<void> {
      try {
        const [canvas, detected, scanic] = await Promise.all([
          decodeCanonical(canonical),
          // The page's own quad if it has one; a fresh detect otherwise.
          tile.page.corners !== null
            ? Promise.resolve(tile.page.corners)
            : detectInBlob(canonical, urls).then((d) => d?.corners ?? null),
          loadScanic(urls),
        ]);
        const host = hostRef.current;
        if (cancelled || host === null) {
          releaseCanvas(canvas);
          return;
        }
        frameRef.current = { width: canvas.width, height: canvas.height };
        editor = scanic.createCornerEditor({
          container: host,
          image: canvas,
          // Normalized at rest, pixels only at scanic's own boundary.
          corners:
            detected === null
              ? undefined
              : denormalizeQuad(detected, canvas.width, canvas.height),
          // Our own actions live in the bottom bar, at full tap size.
          toolbar: { enabled: false },
          // Pinned rather than left to scanic's defaults, and in the same
          // values as the confirm screen: this is the same gesture on the same
          // pixels, so it must not magnify differently (see {@link LOUPE_RING}
          // for why the ring is not white). This IS the design's loupe.
          magnifier: {
            enabled: true,
            size: 132,
            zoom: 2.5,
            borderColor: LOUPE_RING,
            crosshairColor: LOUPE_RING,
          },
          // The handles live on the themeable shell, so their colour comes
          // from it: `shell-handle` is guaranteed 3:1 against every shell in
          // the ramp (`lib/shell-theme.ts`), which a fixed sage is not.
          theme: {
            accent: deriveShellTheme(shell).handle,
            handleSize: 28,
            handleHit: 56,
          },
          onConfirm: (corners) => {
            void applyRef.current(corners);
          },
          onCancel: onClose,
        });
        editorRef.current = editor;
        // scanic names its handles in English and offers no option for it.
        localizeCornerHandles(host, handleLabels);
        setPhase("ready");
      } catch {
        if (cancelled) return;
        setPhase("unavailable");
        reportError("asset_load", true);
      }
    }

    setPhase("loading");
    void boot();
    return () => {
      cancelled = true;
      editor?.destroy();
      editorRef.current = null;
    };
  }, [attempt, canonical, handleLabels, onClose, reportError, shell, tile.page.corners, urls]);

  return (
    <>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={copy.corners.dialogLabel(tile.humanNumber)}
        className="fixed inset-0 z-50 flex justify-center overscroll-contain bg-shell"
      >
        <div className="flex h-full w-full max-w-[30rem] flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),18px)] pt-[max(env(safe-area-inset-top),14px)]">
          <div className="flex shrink-0 items-center gap-2 px-3.5">
            <button
              type="button"
              aria-label={copy.corners.back}
              title={copy.corners.back}
              onClick={onClose}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-[1.5px] border-shell-line text-shell-ink transition-colors duration-200 hover:border-shell-ink"
            >
              <ArrowLeftIcon size={20} />
            </button>
            <span className="flex min-w-0 flex-1 flex-col items-center gap-px">
              <span className="max-w-full truncate font-display text-lg font-semibold leading-tight text-shell-ink">
                {copy.corners.title}
              </span>
              <Meta onNight size="xs" className="block max-w-full truncate">
                {copy.common.pageOfTotal(tile.humanNumber, pageCount)}
              </Meta>
            </span>
            {/* The header's third slot stays empty rather than collapsing, so
                the title is centred on the screen and not on what is left. */}
            <span aria-hidden="true" className="h-11 w-11 shrink-0" />
          </div>

          <div className="flex h-[38px] shrink-0 items-center px-4">
            <p className="min-w-0 truncate text-xs leading-none text-shell-ink2">
              {copy.corners.instruction}
            </p>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col px-4">
            {phase === "unavailable" ? (
              <Notice tone="night" title={copy.corners.unavailableTitle}>
                {copy.corners.unavailableBody}
              </Notice>
            ) : (
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-shell-sunken">
                <div ref={hostRef} className="h-full w-full" />
                {phase === "loading" && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-shell-sunken">
                    <SpinnerIcon size={28} className="text-shell-accent" />
                    <Meta onNight>{copy.common.openingPhoto}</Meta>
                  </div>
                )}
                {/* The loupe is invisible until a handle is held, so it needs
                    one line saying it exists — the same line the confirm screen
                    shows. Drawn over the photo rather than above it: this band
                    is `flex-1`, and a line of layout here is a line taken off
                    the picture the user is aiming at. */}
                {phase === "ready" && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-1.5 flex justify-center"
                  >
                    <span className="rounded-full bg-night-deep/[0.6] px-2.5 py-1.5">
                      <Meta tone="warm">{copy.common.magnifyHint}</Meta>
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2.5 px-4 pt-3">
            <CornerPill
              disabled={phase !== "ready"}
              icon={<ExpandIcon size={14} />}
              onClick={() => setFullView(true)}
            >
              {copy.corners.whole}
            </CornerPill>
            <CornerPill
              disabled={phase !== "ready"}
              icon={<UndoIcon size={14} />}
              onClick={() => setAttempt((count) => count + 1)}
            >
              {copy.corners.reset}
            </CornerPill>
          </div>

          <div className="flex h-[70px] shrink-0 items-center gap-2.5 px-4 pt-3.5">
            <button
              type="button"
              onClick={onClose}
              className={clsx(
                "inline-flex h-14 w-24 shrink-0 items-center justify-center whitespace-nowrap rounded-[14px]",
                "border-[1.5px] border-shell-line text-sm font-semibold text-shell-ink",
                "transition-colors duration-200 hover:border-shell-ink",
              )}
            >
              {copy.corners.backCta}
            </button>
            <button
              type="button"
              disabled={phase !== "ready"}
              onClick={() => {
                editorRef.current?.confirm();
              }}
              className={clsx(
                "inline-flex h-14 flex-1 items-center justify-center whitespace-nowrap rounded-[14px] px-3",
                "bg-shell-ink text-lg font-bold leading-none text-shell-on",
                "transition-colors duration-200",
                phase === "ready" ? "hover:bg-cream" : "cursor-not-allowed opacity-45",
              )}
            >
              {phase === "working" ? copy.corners.cropping : copy.corners.confirmCta}
            </button>
          </div>
        </div>
      </div>

      {/* The CANONICAL, deliberately: on this screen the pre-warp frame is what
          the user is marking corners on, so the "whole sheet" they check has to
          be that frame and not the crop it has not produced yet. */}
      {fullView && (
        <FullImageView
          blob={canonical}
          humanNumber={tile.humanNumber}
          pageCount={pageCount}
          onClose={() => setFullView(false)}
        />
      )}
    </>
  );
}

/**
 * One of the two pills under the photo: 38 px of visible control, hit at 44 px
 * through an `::after` box.
 *
 * The pull-out is what keeps the promise the band makes — this row sits between
 * a `flex-1` photograph and a fixed footer, so every pixel it grows by is a
 * pixel off the thing the user is dragging handles on.
 */
function CornerPill({
  icon,
  disabled,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "relative inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-full px-3.5",
        "border border-shell-line text-xs leading-none text-shell-ink",
        "transition-colors duration-200 hover:border-shell-ink",
        "disabled:cursor-not-allowed disabled:opacity-40",
        "after:absolute after:-inset-x-1 after:-inset-y-[3px] after:content-['']",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
