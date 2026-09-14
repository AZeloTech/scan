"use client";

import * as React from "react";
import type { CornerEditor, CornerPoints } from "scanic";
import { detectInBlob, localizeCornerHandles } from "@/lib/flatten";
import { loadScanic } from "@/lib/scanic-runtime";
import { decodeCanonical, releaseCanvas } from "@/lib/image";
import {
  denormalizeQuad,
  normalizeQuad,
  FULL_FRAME_QUAD,
  type NormalizedQuad,
} from "@/lib/quad";
import type { Capture } from "@/lib/capture-intake";
import { deriveShellTheme, LOUPE_RING } from "@/lib/shell-theme";
import { fillSlot, flyToSlot } from "@/lib/motion";
import { useBlobUrl } from "@/hooks/useScanStore";
import { useAssetUrls, useScanRuntime } from "@/hooks/useScanRuntime";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { useCopy } from "@/components/I18n";
import { useShell } from "@/components/ShellTheme";
import { CameraIcon, CheckIcon, SpinnerIcon } from "@/components/icons";
import { Button, LiveRegion, Meta, Notice } from "@/components/ui";

/**
 * Every capture stops here.
 *
 * **This reverses an earlier decision, deliberately.** The default path used
 * not to ask at all: a detected page was flattened silently, because an
 * interstitial on every capture taxes exactly the people this is built for.
 * The cost of a *wrong* crop turned out to be worse than the cost of a
 * confirmation. A crooked page is discovered three screens later, when fixing
 * it means finding "ajustar cantos" and understanding what it does; here it is
 * four handles and one sentence, at the moment the user still remembers what
 * they photographed.
 *
 * The screen answers two questions and no others: are these the corners, and
 * where does the page go? The second is answered by the flight — the sheet
 * shrinks into the gallery slot, which lights up as it lands — because a
 * confirmation that simply returns to the viewfinder leaves the user to infer
 * that anything was kept at all.
 *
 * The first question has a third answer, added after somebody hit it from
 * the gallery: **"usar a foto inteira"**. A picture that arrives already
 * cropped — someone else's scan, a screenshot, a photo trimmed in the phone's
 * own gallery — has no corners to find, because its corners are the page's. It
 * is the same confirmation with {@link FULL_FRAME_QUAD} instead of the
 * editor's answer: same store path, same gate reading, same flight, and the
 * `cantos` tile in the page editor still lets the user change their mind later.
 *
 * It sits on the themeable shell like every other camera surface, so the
 * outline and the pucks stay legible from `carvão` through to `papel`.
 */

interface ConfirmCornersScreenProps {
  /** The capture awaiting confirmation. Its `canonical` is what gets edited. */
  capture: Capture;
  /** 1-based number this page will take. */
  pageNumber: number;
  /** The user accepted these corners; the re-warped capture is handed back. */
  onConfirm: (capture: Capture) => void;
  /** Throw it away and go back to the viewfinder. */
  onRetake: () => void;
}

type Phase = "loading" | "ready" | "flying" | "unavailable";

export function ConfirmCornersScreen({
  capture,
  pageNumber,
  onConfirm,
  onRetake,
}: ConfirmCornersScreenProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const slotRef = React.useRef<HTMLDivElement | null>(null);
  const flyerRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<CornerEditor | null>(null);

  const [phase, setPhase] = React.useState<Phase>("loading");
  const [landed, setLanded] = React.useState(false);

  const copy = useCopy();
  const urls = useAssetUrls();
  const { reportError } = useScanRuntime();
  const { shell } = useShell();
  const containerRef = useDialogChrome<HTMLDivElement>(onRetake);
  const previewUrl = useBlobUrl(capture.canonical);

  const canonical = capture.canonical;
  /** The pixel grid the editor is working on, for normalising its answer. */
  const frameRef = React.useRef<{ width: number; height: number } | null>(null);

  /**
   * Keep this quad and fly the page into the slot.
   *
   * Nothing is warped here any more, and nothing is encoded: the quad is stored
   * on the page (normalized, so it survives every later decode) and applied
   * once, inside the page's own render. That is what makes the confirmation
   * instant instead of a 12 MP pass the user waits through.
   *
   * The gate reading travels through untouched, whichever quad this is: it was
   * measured on the pre-warp frame at intake precisely so that no crop decision
   * made here can move it.
   */
  const land = React.useCallback(
    async (corners: NormalizedQuad | null) => {
      setPhase("flying");
      await flyToSlot(flyerRef.current, stageRef.current, slotRef.current);
      setLanded(true);
      fillSlot(slotRef.current);
      // A beat so the slot's fill is seen before the screen changes under it.
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      onConfirm({
        canonical,
        corners,
        gate: capture.gate,
        path: capture.path,
      });
    },
    [canonical, capture.gate, capture.path, onConfirm],
  );

  /** The editor's answer, in the pixel grid it was drawn on. */
  const accept = React.useCallback(
    async (corners: CornerPoints) => {
      const frame = frameRef.current;
      await land(
        frame === null ? null : normalizeQuad(corners, frame.width, frame.height),
      );
    },
    [land],
  );

  const acceptRef = React.useRef(accept);
  acceptRef.current = accept;

  /** A stable per-language object (the dictionary is a module constant). */
  const handleLabels = copy.corners.handles;

  React.useEffect(() => {
    let cancelled = false;
    let editor: CornerEditor | null = null;
    const theme = deriveShellTheme(shell);

    async function boot(): Promise<void> {
      try {
        const [canvas, detected, scanic] = await Promise.all([
          decodeCanonical(canonical),
          // The live quad if the viewfinder had one; a fresh detect otherwise.
          capture.corners !== null
            ? Promise.resolve(capture.corners)
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
          // scanic magnifies while a handle is held, and would do it by
          // default — pinned here because "by default" is not a contract, and
          // because both its size and its ring colour are wrong for us out of
          // the box: 120 px is small under a thumb, and a white ring vanishes
          // into the white sheet it is showing (see {@link LOUPE_RING}).
          magnifier: {
            enabled: true,
            size: 132,
            zoom: 2.5,
            borderColor: LOUPE_RING,
            crosshairColor: LOUPE_RING,
          },
          theme: {
            accent: theme.accent,
            edgeColor: theme.accent,
            edgeWidth: 1.5,
            handleSize: 24,
            handleHit: 56,
            handleColor: theme.handle,
            handleRingColor: theme.accent,
          },
          // Named so the stylesheet can make them look grabbable.
          classNames: { handle: "scan-corner-handle" },
          onConfirm: (corners) => {
            void acceptRef.current(corners);
          },
        });
        editorRef.current = editor;
        // scanic names its handles in English and offers no option for it.
        localizeCornerHandles(host, handleLabels);
        setPhase("ready");
      } catch {
        if (cancelled) return;
        // The editor could not be built: the model or its runtime did not
        // arrive. Recoverable — the screen falls back to "usar a foto inteira",
        // which is a whole page, just not a straightened one.
        setPhase("unavailable");
        reportError("asset_load", true);
      }
    }

    void boot();
    return () => {
      cancelled = true;
      editor?.destroy();
      editorRef.current = null;
    };
  }, [canonical, capture.corners, handleLabels, reportError, shell, urls]);

  const busy = phase === "flying";

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={copy.confirm.dialogLabel(pageNumber)}
      className="fixed inset-0 z-50 flex justify-center overscroll-contain bg-shell"
    >
      <div className="flex h-full w-full max-w-[30rem] flex-col overflow-hidden">
        <header className="flex shrink-0 flex-col gap-1 px-4 pb-2 pt-[max(env(safe-area-inset-top),14px)]">
          <Meta caps onNight>
            {copy.common.stepOfThree(1)} · {copy.common.page(pageNumber)}
          </Meta>
          <h1 className="font-display text-xl font-semibold text-shell-ink">
            {copy.confirm.title}
          </h1>
          <p className="text-base leading-snug text-shell-ink2">
            {copy.confirm.help}
          </p>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-2">
          {phase === "unavailable" ? (
            <Notice tone="night" title={copy.confirm.unavailableTitle}>
              {copy.confirm.unavailableBody}
            </Notice>
          ) : (
            <div
              ref={stageRef}
              className="relative min-h-0 flex-1 overflow-hidden rounded-md bg-shell-sunken"
            >
              <div ref={hostRef} className="h-full w-full" />
              {phase === "loading" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-shell-sunken">
                  <SpinnerIcon size={28} className="text-shell-accent" />
                  <Meta onNight>{copy.common.openingPhoto}</Meta>
                </div>
              )}
            </div>
          )}

          {/* Where the page is going. Muted until it arrives, then sage.
              The flying picture is the canonical rather than a warp of it: the
              page is not rendered until it reaches the store, and encoding a
              throwaway crop for a 42 px slot would be a lossy generation spent
              on an animation. */}
          <div className="flex shrink-0 items-center gap-3">
            <div
              ref={slotRef}
              className={
                "h-[54px] w-[42px] shrink-0 rounded-md border transition-colors duration-300 " +
                (landed
                  ? "border-shell-accent bg-shell-dim"
                  : "border-shell-line bg-transparent")
              }
            >
              {landed && previewUrl !== null && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt=""
                  className="h-full w-full rounded-md object-cover"
                />
              )}
            </div>
            {/* Two static lines: where the page is going, and the one thing
                about this editor a user would otherwise never discover. Both
                are always rendered, so nothing shifts when the page lands. */}
            <div className="flex min-w-0 flex-col gap-0.5">
              <Meta onNight>{copy.confirm.slotCaption}</Meta>
              <Meta onNight>{copy.common.magnifyHint}</Meta>
            </div>
          </div>
        </div>

        <div className="safe-bottom shrink-0 px-4 pt-2">
          <LiveRegion
            message={
              landed
                ? copy.confirm.announceDone(pageNumber)
                : phase === "ready"
                  ? copy.confirm.announceReady
                  : ""
            }
          />
          <div className="flex flex-col gap-2">
            <Button
              fullWidth
              onNight
              icon={<CheckIcon size={20} />}
              disabled={phase !== "ready"}
              onClick={() => {
                editorRef.current?.confirm();
              }}
            >
              {busy ? copy.confirm.savingCta : copy.confirm.confirmCta}
            </Button>
            <Button
              variant="secondary"
              onNight
              fullWidth
              icon={<CameraIcon size={20} />}
              disabled={busy}
              onClick={onRetake}
            >
              {copy.confirm.retakeCta}
            </Button>
            {/* The third answer, and deliberately the quietest one: a photo
                that is already cropped has no corners to find, and dragging
                four handles onto the picture's own edges is work for nothing.
                It takes the same path as confirming — same quad shape, same
                gate reading, same flight into the slot — with the quad the
                whole frame. 38 px of visible control hit at 44 px through the
                `::after` box, because this band sits under a `flex-1` photo and
                every pixel it grows by is a pixel off the thing the user is
                dragging handles on. */}
            <button
              type="button"
              disabled={phase !== "ready"}
              onClick={() => {
                void land(FULL_FRAME_QUAD);
              }}
              className={
                "relative mx-auto inline-flex h-[38px] items-center justify-center px-3 " +
                "text-sm leading-none text-shell-ink2 underline underline-offset-4 " +
                "transition-colors duration-200 hover:text-shell-ink " +
                "disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40 " +
                "after:absolute after:-inset-x-2 after:-inset-y-[3px] after:content-['']"
              }
            >
              {copy.confirm.wholeCta}
            </button>
          </div>
        </div>
      </div>

      {/* The travelling sheet. Parked and invisible until the flight starts. */}
      <div
        ref={flyerRef}
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 opacity-0"
      >
        {previewUrl !== null && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt=""
            className="h-full w-full rounded-md object-cover shadow-2xl"
          />
        )}
      </div>
    </div>
  );
}
