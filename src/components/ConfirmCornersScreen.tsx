"use client";

import * as React from "react";
import type { CornerEditor, CornerPoints } from "scanic";
import type { CornerHandleKey } from "@/lib/flatten";
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
import { probe, probing, quadMoved } from "@/lib/probe";
import { maxCornerMovePct } from "@/lib/diagnostics-events";
import { isUncertain, provenanceByNearest, provenanceDiagnostic, type CornerCheck } from "@/lib/corner-check";
import { deriveShellTheme, LOUPE_RING } from "@/lib/shell-theme";
import { fillSlot, flyToSlot } from "@/lib/motion";
import { useBlobUrl } from "@/hooks/useScanStore";
import { useAssetUrls, useScanRuntime } from "@/hooks/useScanRuntime";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { useCopy } from "@/components/I18n";
import { useShell } from "@/components/ShellTheme";
import { CameraIcon, CheckIcon, ExpandIcon, SpinnerIcon } from "@/components/icons";
import { LiveRegion, Meta, Notice } from "@/components/ui";

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
 *
 * ## Layout: "C5 · Uma linha de ações" (owner-approved, 2026-09-29)
 *
 * The photo fills the screen edge to edge on the shell's deepest ground, and
 * everything else floats over it: a pill at the top that says the one thing to
 * do (or, when the photo's check or the detector has a reason, says that
 * instead), a small "Página N · cantos" under it, and ONE bottom bar of three
 * cells — Refazer, Confirmar (the filled primary), Foto inteira. The editor's
 * own box stops short of the pill and the bar, so a handle can never sit under
 * either of them; on a 3:4 photo that box is taller than the photo needs, and
 * what shows around it is the same ground, so the page still reads full-bleed.
 *
 * The confirmed page flies into the Confirmar cell, which pulses as it lands:
 * the screen has no gallery slot any more, and the cell the thumb just pressed
 * is where the eye already is.
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
  const slotRef = React.useRef<HTMLButtonElement | null>(null);
  const flyerRef = React.useRef<HTMLDivElement | null>(null);
  const editorRef = React.useRef<CornerEditor | null>(null);

  const [phase, setPhase] = React.useState<Phase>("loading");
  const [landed, setLanded] = React.useState(false);
  /** False once the editor opened with no page outline to seed it (its own inset quad). */
  const [found, setFound] = React.useState(true);
  /**
   * The seed has a corner the capture could not see (`lib/corner-check.ts`),
   * still where it was estimated: the pill says so until the person moves it.
   */
  const [estimated, setEstimated] = React.useState(false);
  /** What the seed's corners were, for the diagnostics stream. */
  const seedCheckRef = React.useRef<CornerCheck | null>(null);

  const copy = useCopy();
  const urls = useAssetUrls();
  const { reportError, diagnosticsSink } = useScanRuntime();
  const { shell } = useShell();
  // (`retake` is declared below; the dialog's Escape goes through it too.)
  const retakeRef = React.useRef<() => void>(onRetake);
  const containerRef = useDialogChrome<HTMLDivElement>(React.useCallback(() => retakeRef.current(), []));
  const previewUrl = useBlobUrl(capture.canonical);

  const canonical = capture.canonical;
  /** The pixel grid the editor is working on, for normalising its answer. */
  const frameRef = React.useRef<{ width: number; height: number } | null>(null);
  /** What the editor showed at open, so the probe can tell an edit from a nod. */
  const seededRef = React.useRef<NormalizedQuad | null>(null);
  /** The diagnostics stream (`onDiagnostics`): when the screen opened and what seeded it. */
  const openedRef = React.useRef<{ at: number; seededFrom: "capture" | "detected" | "editor-default" | null }>({
    at: performance.now(),
    seededFrom: null,
  });
  const reportAnswer = React.useCallback(
    (result: "accepted" | "adjusted" | "retake" | "whole-photo", maxMovePct: number | null) => {
      diagnosticsSink?.emit({
        type: "confirm",
        page: pageNumber,
        result,
        maxMovePct,
        ms: performance.now() - openedRef.current.at,
        seededFrom: openedRef.current.seededFrom,
        flag: capture.attention ?? null,
        source: capture.sizes?.source ?? null,
        canonical:
          capture.sizes === undefined
            ? null
            : {
                width: capture.sizes.width,
                height: capture.sizes.height,
                bytes: capture.sizes.bytes,
                quality: capture.sizes.quality,
              },
        capped: capture.sizes?.capped ?? null,
        corners: provenanceDiagnostic(seedCheckRef.current),
      });
    },
    [capture.attention, capture.sizes, diagnosticsSink, pageNumber],
  );
  /**
   * Set synchronously by the first answer — Confirmar, Foto inteira, Refazer
   * or Escape — so no second one can follow it. The buttons are disabled once
   * the page is flying, but Escape is not a button: without this, Escape
   * during the flight reported a retake and left the screen while the
   * pending confirmation went on to save the page.
   */
  const answeredRef = React.useRef(false);
  const retake = React.useCallback(() => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    reportAnswer("retake", null);
    onRetake();
  }, [onRetake, reportAnswer]);
  retakeRef.current = retake;

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
      if (answeredRef.current) return;
      answeredRef.current = true;
      if (probing()) {
        probe({
          type: "confirm-done",
          t: performance.now(),
          corners,
          edited:
            seededRef.current === null
              ? null
              : quadMoved(seededRef.current, corners),
          wholePhoto: corners === FULL_FRAME_QUAD,
        });
      }
      if (diagnosticsSink !== null) {
        const seeded = seededRef.current;
        const frame = frameRef.current;
        if (corners === FULL_FRAME_QUAD) reportAnswer("whole-photo", null);
        else if (seeded === null || corners === null || frame === null) reportAnswer("accepted", null);
        else {
          const moved = quadMoved(seeded, corners);
          reportAnswer(moved ? "adjusted" : "accepted", maxCornerMovePct(seeded, corners, frame.width, frame.height));
        }
      }
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
    [canonical, capture.gate, capture.path, diagnosticsSink, onConfirm, reportAnswer],
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
  const estimatedCopy = copy.confirm;

  React.useEffect(() => {
    let cancelled = false;
    let editor: CornerEditor | null = null;
    const theme = deriveShellTheme(shell);

    async function boot(): Promise<void> {
      try {
        const [canvas, seed, scanic] = await Promise.all([
          decodeCanonical(canonical),
          // The live quad if the viewfinder had one; a fresh detect otherwise.
          capture.corners !== null
            ? Promise.resolve({ corners: capture.corners, check: capture.cornerCheck ?? null })
            : detectInBlob(canonical, urls).then((d) => (d === null ? null : { corners: d.corners, check: d.check ?? null })),
          loadScanic(urls),
        ]);
        const detected = seed?.corners ?? null;
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
          // C5: a light outline and round light pucks over the photo — 28 px
          // of visible disc, hit at 56 px (the 44 px floor, with room).
          // No dimming outside the quad: the photo is the ground here, and a
          // tint over the editor's box would draw that box on the screen.
          theme: {
            accent: theme.accent,
            mask: "rgba(0, 0, 0, 0)",
            edgeColor: theme.handle,
            edgeWidth: 2,
            handleSize: 28,
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
        setFound(detected !== null);
        // scanic names its handles in English and offers no option for it.
        localizeCornerHandles(host, handleLabels);
        // A corner something lay over, placed where its edges meet: its
        // handle is marked "estimado" (hollow, dashed, a word under it) and
        // named so, until the person moves it.
        const check = detected === null ? null : (seed?.check ?? null);
        seedCheckRef.current = check;
        if (check !== null && detected !== null && isUncertain(check)) {
          const live = editor;
          markEstimatedHandles(host, check, detected, canvas.width, canvas.height, editor.getCorners(), () => live.getCorners(), handleLabels, estimatedCopy, () => {
            if (!cancelled) setEstimated(false);
          });
          setEstimated(host.querySelector("[data-scan-estimated]") !== null);
        }
        if (probing() || diagnosticsSink !== null) {
          // What the user is looking at: the seed, or — with none — the
          // editor's own inset quad, which is what "confirm" would hand back.
          // Read defensively: the instrument must not be able to fail the boot.
          let shown: NormalizedQuad | null = null;
          try {
            shown = normalizeQuad(
              editor.getCorners(),
              canvas.width,
              canvas.height,
            );
          } catch {
            shown = null;
          }
          seededRef.current = shown;
          openedRef.current = {
            at: performance.now(),
            seededFrom: capture.corners !== null ? "capture" : detected !== null ? "detected" : "editor-default",
          };
        }
        if (probing()) {
          const shown = seededRef.current;
          probe({
            type: "confirm-open",
            t: performance.now(),
            corners: detected,
            shownCorners: shown,
            seededFrom:
              capture.corners !== null
                ? "capture"
                : detected !== null
                  ? "detected"
                  : "editor-default",
            width: canvas.width,
            height: canvas.height,
            attention: capture.attention ?? null,
          });
        }
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
  }, [canonical, capture.corners, capture.cornerCheck, diagnosticsSink, estimatedCopy, handleLabels, reportError, shell, urls]);

  const busy = phase === "flying";

  /**
   * The pill's sentence. A reason — the photo's own check, or no outline to
   * seed the editor with — replaces the instruction rather than stacking under
   * it: one sentence over the photo, and it is the one that matters.
   */
  const reason =
    capture.attention != null
      ? copy.confirm.attention[capture.attention]
      : phase === "ready" && !found
        ? copy.confirm.notFound
        : phase === "ready" && estimated
          ? copy.confirm.estimatedPill
          : null;
  // An estimated corner is said even under the photo's own reason: the two
  // are different asks, and the estimate is the one about these handles.
  const estimateAside = capture.attention != null && phase === "ready" && estimated ? copy.confirm.estimatedPill : null;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={copy.confirm.dialogLabel(pageNumber)}
      className="fixed inset-0 z-50 overflow-hidden overscroll-contain bg-shell-sunken"
    >
      <div className="relative mx-auto h-full w-full max-w-[30rem]">
        {/* ── the photo, under everything ───────────────────────────────
            The box stops at the pill above and the bar below (see the
            file's header): handles are never under a control. */}
        {phase === "unavailable" ? (
          <div className="absolute inset-x-4 top-1/2 -translate-y-1/2">
            <Notice tone="night" title={copy.confirm.unavailableTitle}>
              {copy.confirm.unavailableBody}
            </Notice>
          </div>
        ) : (
          <div
            ref={stageRef}
            className="absolute inset-x-0 bottom-[calc(max(env(safe-area-inset-bottom),12px)+100px)] top-[calc(max(env(safe-area-inset-top),12px)+80px)]"
          >
            <div ref={hostRef} data-scan-confirm-editor="" className="h-full w-full" />
            {phase === "loading" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <SpinnerIcon size={28} className="text-shell-accent" />
                <Meta onNight>{copy.common.openingPhoto}</Meta>
              </div>
            )}
          </div>
        )}

        {/* ── the pill, and which page this is ──────────────────────────
            Fixed colours rather than shell tokens: this floats over a
            photograph, whatever shell the app wears. */}
        <div className="pointer-events-none absolute inset-x-4 top-[calc(max(env(safe-area-inset-top),12px)+4px)] flex flex-col items-center gap-2">
          <p
            // Announced only when it carries a reason: the plain instruction
            // is the live region's `announceReady` below, said once.
            role={reason !== null ? "status" : undefined}
            data-scan-attention={capture.attention ?? undefined}
            className="max-w-full rounded-full bg-night-deep/[0.72] px-4 py-[9px] text-center text-[15px] font-semibold leading-snug text-warm"
          >
            {reason ?? copy.confirm.pill}
          </p>
          {estimateAside !== null && (
            <p
              role="status"
              data-scan-estimated-pill=""
              className="max-w-full rounded-full bg-night-deep/[0.72] px-4 py-[7px] text-center text-[14px] font-semibold leading-snug text-warm"
            >
              {estimateAside}
            </p>
          )}
          <p className="text-[13px] font-semibold leading-none text-warm/[0.85] [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]">
            {copy.confirm.pageCorners(pageNumber)}
          </p>
        </div>

        {/* ── one floating bar, three cells ─────────────────────────────── */}
        <div className="absolute inset-x-4 bottom-[calc(max(env(safe-area-inset-bottom),12px)+8px)]">
          <LiveRegion
            message={
              landed
                ? copy.confirm.announceDone(pageNumber)
                : phase === "ready"
                  ? copy.confirm.announceReady
                  : ""
            }
          />
          <div className="grid h-[84px] grid-cols-3 items-center rounded-[24px] bg-night-deep/[0.82] text-warm">
            <BarCell
              label={copy.confirm.retakeLabel}
              icon={<CameraIcon size={22} />}
              disabled={busy}
              onClick={retake}
            >
              {copy.confirm.retakeCta}
            </BarCell>
            {/* The primary, and the flight's landing place. */}
            <button
              ref={slotRef}
              type="button"
              aria-label={busy ? copy.confirm.savingCta : copy.confirm.confirmLabel}
              disabled={phase !== "ready"}
              onClick={() => {
                editorRef.current?.confirm();
              }}
              className={
                "mx-1 flex h-16 flex-col items-center justify-center gap-1 rounded-[18px] " +
                "bg-warm text-[15px] font-bold leading-none text-night-deep " +
                "transition-opacity duration-200 disabled:cursor-not-allowed " +
                (busy ? "" : "disabled:opacity-45")
              }
            >
              {busy ? <SpinnerIcon size={22} /> : <CheckIcon size={22} strokeWidth={2.6} />}
              {busy ? copy.confirm.savingCta : copy.confirm.confirmCta}
            </button>
            {/* The third answer: a photo that is already cropped has no
                corners to find, and dragging four handles onto the picture's
                own edges is work for nothing. It takes the same path as
                confirming — same quad shape, same gate reading, same flight —
                with the quad the whole frame. */}
            <BarCell
              label={copy.confirm.wholeLabel}
              icon={<ExpandIcon size={22} />}
              disabled={phase !== "ready"}
              onClick={() => {
                void land(FULL_FRAME_QUAD);
              }}
            >
              {copy.confirm.wholeCta}
            </BarCell>
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
            // `contain`: the flight starts from the editor's whole box, which
            // is taller than a 3:4 photo — the picture must not be cropped
            // to fill it on the way out.
            className="h-full w-full object-contain"
          />
        )}
      </div>
    </div>
  );
}

/**
 * Mark the editor's handles whose corner the capture could not see
 * (inferred or unknown, `lib/corner-check.ts`): `data-scan-estimated` (the
 * stylesheet draws it hollow and dashed), a badge word under it, and an
 * accessible name that says so. The
 * editor may hand its handles back in another order than the quad it was
 * seeded with, so each handle takes the provenance of the seed corner nearest
 * it. Moving a handle (pointer or keys) takes its mark away — moving it,
 * not touching it: a press released where it started leaves the estimate
 * marked. `onCleared` runs once none is left.
 */
/** An estimated handle counts as moved once it is this far (editor px) from where it was put. */
const ESTIMATE_MOVED_PX = 1;

function markEstimatedHandles(
  host: HTMLElement,
  check: CornerCheck,
  seed: NormalizedQuad,
  width: number,
  height: number,
  shown: CornerPoints,
  current: () => CornerPoints,
  labels: Record<CornerHandleKey, string>,
  words: { estimatedBadge: string; estimatedHandle: (corner: string) => string },
  onCleared: () => void,
): void {
  const normalized: Record<string, { x: number; y: number }> = {};
  for (const [key, point] of Object.entries(shown)) normalized[key] = { x: point.x / width, y: point.y / height };
  const provenance = provenanceByNearest(check, seed, normalized);
  for (const handle of host.querySelectorAll<HTMLElement>("[data-corner]")) {
    const key = handle.dataset.corner as CornerHandleKey | undefined;
    if (key === undefined || !(key in labels) || provenance[key] === undefined || provenance[key] === "seen") continue;
    handle.setAttribute("data-scan-estimated", provenance[key]);
    handle.setAttribute("aria-label", words.estimatedHandle(labels[key]));
    // The word under the puck (a child: the handle's ::after is scanic's hit area).
    const badge = document.createElement("span");
    badge.setAttribute("data-scan-estimated-badge", "");
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = words.estimatedBadge;
    handle.appendChild(badge);
    const clear = () => {
      if (!handle.hasAttribute("data-scan-estimated")) return;
      handle.removeAttribute("data-scan-estimated");
      badge.remove();
      handle.setAttribute("aria-label", labels[key]);
      if (host.querySelector("[data-scan-estimated]") === null) onCleared();
    };
    // Cleared once the handle has actually moved off where it was put.
    const at = () => {
      const point = current()[key];
      return point === undefined ? null : { x: point.x, y: point.y };
    };
    let from: { x: number; y: number } | null = null;
    const settle = () => {
      const now = at();
      if (from !== null && now !== null && Math.hypot(now.x - from.x, now.y - from.y) >= ESTIMATE_MOVED_PX) clear();
      from = null;
    };
    handle.addEventListener("pointerdown", () => {
      from = at();
      const end = () => {
        window.removeEventListener("pointerup", end, true);
        window.removeEventListener("pointercancel", end, true);
        settle();
      };
      window.addEventListener("pointerup", end, true);
      window.addEventListener("pointercancel", end, true);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key.startsWith("Arrow") && from === null) from = at();
    });
    handle.addEventListener("keyup", (event) => {
      if (event.key.startsWith("Arrow")) settle();
    });
  }
}

/**
 * A side cell of the bottom bar: icon over one word, the full cell height as
 * its target. The accessible name is the full phrase, which contains the word.
 */
function BarCell({
  label,
  icon,
  disabled,
  onClick,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={
        "flex h-full min-w-0 flex-col items-center justify-center gap-1.5 rounded-[24px] px-1 " +
        "text-[13px] font-semibold leading-none text-warm transition-opacity duration-200 " +
        "disabled:cursor-not-allowed disabled:opacity-40"
      }
    >
      {icon}
      <span className="max-w-full truncate">{children}</span>
    </button>
  );
}
