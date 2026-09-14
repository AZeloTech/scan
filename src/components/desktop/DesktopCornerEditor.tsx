"use client";

import * as React from "react";
import type { CornerEditor, CornerPoints } from "scanic";
import { detectInBlob, localizeCornerHandles } from "@/lib/flatten";
import { loadScanic } from "@/lib/scanic-runtime";
import { assessBlob } from "@/lib/capture-gate";
import { decodeCanonical, releaseCanvas } from "@/lib/image";
import {
  FULL_FRAME_QUAD,
  denormalizeQuad,
  normalizeQuad,
  type NormalizedQuad,
} from "@/lib/quad";
import { LOUPE_RING } from "@/lib/shell-theme";
import type { PageTile } from "@/lib/page-tiles";
import { useStore } from "@/hooks/useScanStore";
import { useAssetUrls, useScanRuntime } from "@/hooks/useScanRuntime";
import { useCopy } from "@/components/I18n";
import { Meta } from "@/components/ui";
import { SpinnerIcon } from "@/components/icons";

/**
 * scanic's corner editor, mounted **inside** the desktop viewer.
 *
 * On the phone this same editor is a full screen twice over
 * (`ConfirmCornersScreen` after every capture, `CornerAdjustSheet` from the
 * page editor) because a phone has no other way to give it room. A desktop
 * already has the room: the viewer pane is the biggest thing on the workspace
 * and the page is already in it, so opening a modal over it would replace a
 * picture with the same picture and lose the page list on the way.
 *
 * Nothing about the editor itself changes for that. `createCornerEditor` only
 * ever asked for a bounded box (`container`), a decoded canvas (`image`) and a
 * quad in that canvas's own pixels — the full-screen wrapper was always the
 * app's chrome, never scanic's requirement. What differs here is only the
 * palette: the desktop has no themeable shell, so the handles are pinned to the
 * design's own values, which are legible both on the dark canvas and on the
 * white sheet they are dragged across.
 *
 * The commit is `CornerAdjustSheet`'s, move for move — normalise the quad
 * against the frame it was drawn on, re-measure the gate on the pre-warp bytes,
 * then `replaceCapture(..., path: "adjust")` so the page keeps its id, its
 * place and its rotation. Anything else here would be a second way to crop a
 * page, and the two would drift.
 */
export interface DesktopCornerEditorHandle {
  confirm: () => void;
  /**
   * "Usar a foto inteira" — commit the frame's own four corners.
   *
   * The same escape hatch the phone offers on `ConfirmCornersScreen`, for the
   * same picture: one that is already cropped, so there is nothing to find
   * because the photo's corners *are* the page's. It goes through the same
   * commit as dragging the handles and confirming, because it is the same
   * answer — a real quad, never `null`. `null` means "no outline found", which
   * is the app's own uncertainty, and this is the user settling it.
   *
   * It does not go through scanic at all, so it still works when the editor
   * could not load — the one state that otherwise offers no way forward.
   */
  useWholePhoto: () => void;
}

type Phase = "loading" | "ready" | "working" | "unavailable";

export const DesktopCornerEditor = React.forwardRef<
  DesktopCornerEditorHandle,
  {
    tile: PageTile;
    onApplied: () => void;
    onPhase?: (phase: "loading" | "ready" | "working" | "unavailable") => void;
  }
>(function DesktopCornerEditor({ tile, onApplied, onPhase }, ref) {
  const copy = useCopy();
  const store = useStore();
  const urls = useAssetUrls();
  const { reportError } = useScanRuntime();
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<CornerEditor | null>(null);
  const frameRef = React.useRef<{ width: number; height: number } | null>(null);
  const [phase, setPhase] = React.useState<Phase>("loading");

  React.useEffect(() => {
    onPhase?.(phase);
  }, [phase, onPhase]);

  const canonical = tile.page.canonical;
  const pageId = tile.pageId;

  /**
   * The one commit, whichever way the user answered.
   *
   * Both the dragged handles and "usar a foto inteira" land here rather than
   * each writing its own `replaceCapture`, so the two cannot drift into two
   * different ways to crop a page.
   */
  const commit = React.useCallback(
    async (corners: NormalizedQuad | null) => {
      setPhase("working");
      // Pre-warp, exactly like every other capture path: the warp resamples the
      // sheet, and a reading taken after it is not comparable with one taken
      // before.
      const gate = await assessBlob(canonical);
      store.replaceCapture(pageId, {
        canonical,
        corners,
        gate,
        // "adjust" is what tells `replaceCapture` to keep the page's rotation:
        // the user turned this frame, and re-cropping it does not un-turn it.
        path: "adjust",
      });
      onApplied();
    },
    [canonical, onApplied, pageId],
  );

  const apply = React.useCallback(
    async (corners: CornerPoints) => {
      const frame = frameRef.current;
      await commit(
        frame === null ? null : normalizeQuad(corners, frame.width, frame.height),
      );
    },
    [commit],
  );

  const applyRef = React.useRef(apply);
  applyRef.current = apply;

  React.useImperativeHandle(
    ref,
    () => ({
      confirm: () => editorRef.current?.confirm(),
      useWholePhoto: () => {
        void commit(FULL_FRAME_QUAD);
      },
    }),
    [commit],
  );

  const handleLabels = copy.corners.handles;

  React.useEffect(() => {
    let cancelled = false;
    let editor: CornerEditor | null = null;

    async function boot(): Promise<void> {
      try {
        const [canvas, detected, scanic] = await Promise.all([
          decodeCanonical(canonical),
          tile.page.corners !== null
            ? Promise.resolve(tile.page.corners)
            : detectInBlob(canonical, urls).then((found) => found?.corners ?? null),
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
          corners:
            detected === null
              ? undefined
              : denormalizeQuad(detected, canvas.width, canvas.height),
          // Our own Cancelar/Usar estes cantos live in the helper card below.
          toolbar: { enabled: false },
          // The same 132/2.5 loupe both phone call sites pin, for the same
          // reason: this is one gesture on one set of pixels, and it must not
          // magnify differently depending on which screen opened it.
          magnifier: {
            enabled: true,
            size: 132,
            zoom: 2.5,
            borderColor: LOUPE_RING,
            crosshairColor: LOUPE_RING,
          },
          // Fixed, because the desktop has no shell colour to derive from: mist
          // on the near-black viewer canvas and on white paper both, with a
          // warm-white puck so the handle is findable over dark print.
          theme: {
            accent: HANDLE_RING,
            edgeColor: HANDLE_RING,
            edgeWidth: 1.5,
            handleSize: 26,
            handleHit: 56,
            handleColor: HANDLE_FILL,
            handleRingColor: HANDLE_RING,
          },
          classNames: { handle: "scan-corner-handle" },
          onConfirm: (corners) => {
            void applyRef.current(corners);
          },
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
  }, [canonical, handleLabels, reportError, tile.page.corners, urls]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" />
      {phase !== "ready" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-desk-canvas">
          {phase === "unavailable" ? (
            <p className="max-w-[320px] text-center text-sm leading-snug text-mist">
              {copy.desktop.conferir.cantos.unavailable}
            </p>
          ) : (
            <>
              <SpinnerIcon size={26} className="text-mist" />
              {/* `deskMist`, not `mist`: that tone resolves to the themeable
                  shell's accent variable, and this flow never shows the shell
                  picker — the value would be whatever a phone session last
                  chose. Fixed palette, like the handles above. */}
              <Meta tone="deskMist">
                {phase === "working"
                  ? copy.desktop.conferir.cantos.working
                  : copy.common.openingPhoto}
              </Meta>
            </>
          )}
        </div>
      )}
    </div>
  );
});

/** The design's own handle values — see the component docblock. */
const HANDLE_RING = "#8FAB9B";
const HANDLE_FILL = "#FAFAF7";
