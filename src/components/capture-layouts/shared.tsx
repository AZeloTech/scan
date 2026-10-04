"use client";

import * as React from "react";
import clsx from "clsx";
import type { PageTile } from "@/lib/page-tiles";
import type { CaptureChromeParts } from "@/components/CaptureStage";
import { useCopy } from "@/components/I18n";
import { PageThumb } from "@/components/PageThumb";
import { ChevronRightIcon, ImageIcon, SpinnerIcon, TorchIcon, XIcon } from "@/components/icons";
import { ACCEPT_ATTRIBUTE } from "@/lib/image";
import type { OccluderEdge } from "@/lib/visible-region";

/**
 * The pieces the full-bleed capture layouts share (`captureLayout`: `rail`, the
 * default, and the experimental ones).
 *
 * Everything here is drawn over the camera image, which is whatever the person
 * is pointing at — so none of it takes its colours from the themeable shell:
 * light marks on dark glass (`night` at 55–80 %), and `warm` fills with `deep`
 * type where a control must be the brightest thing on screen. Every icon-only
 * control is ≥ 44 px and named; the whole chrome lets taps through to the
 * frame (a tap on the image is a capture) except on its own controls.
 *
 * **No `backdrop-filter`.** Glass here is translucency only: a backdrop blur
 * over the live video crashed Linux WebKit in about half the runs (and is the
 * most expensive thing a phone compositor can be asked to do every frame
 * over a camera); without it, five runs out of five were clean.
 */

/** What a layout needs from the screen around it — pages, and where to go. */
export interface LayoutScreenBits {
  pageCount: number;
  maxPages: number;
  tiles: readonly PageTile[];
  /** Pages flagged by the quality gate — the onward control stops recommending itself. */
  warnedCount: number;
  onClose: () => void;
  onReview: () => void;
  /** The pages button: the newest page, in the page editor. */
  onShowPages: () => void;
  onTileTap: (tile: PageTile) => void;
}

export type LayoutChromeProps = { parts: CaptureChromeParts; bits: LayoutScreenBits };

/** The stage element's classes in every full-bleed layout: it fills its box. */
export const LAYOUT_STAGE_CLASS = "absolute inset-0 overflow-hidden bg-night";

/** The notch is the chrome's problem: the top row's padding. */
export const SAFE_TOP = "pt-[max(env(safe-area-inset-top),12px)]";

/**
 * An opaque band over the camera, declared for the live loop
 * (`lib/visible-region.ts`): an invisible box along one edge of the stage
 * whose extent the person cannot see the picture through — the notch, the
 * home indicator, a bar of controls. The loop measures it (and follows it
 * when it resizes) and judges the page only against what is left: a corner
 * under a band is cut off to the person holding the phone. A band hugs its
 * edge; only its inner side counts.
 */
/**
 * An opaque band along one stage edge, for the live loop (`lib/visible-region.ts`):
 * an invisible mark sized to where the chrome hides the picture. A control
 * drawn over the picture AWAY from an edge (a glass button, the hint pill)
 * is not a band: it carries `data-scan-occluder="spot"` on itself, so the
 * loop measures its actual box while it is drawn. A band can also be the
 * control itself (`data-scan-occluder="bottom"` on the mode rail): its
 * real box then follows large text rather than a fixed height.
 */
export function OccluderMark({ edge, className }: { edge: OccluderEdge; className: string }) {
  return (
    <div
      aria-hidden="true"
      data-scan-occluder={edge}
      className={clsx("pointer-events-none invisible absolute", className)}
    />
  );
}

/** The notch and the home indicator — the safe areas a full-bleed stage runs under. */
export function SafeAreaOccluders({ bottom = true }: { bottom?: boolean }) {
  return (
    <>
      <OccluderMark edge="top" className="inset-x-0 top-0 h-[env(safe-area-inset-top)]" />
      {bottom && <OccluderMark edge="bottom" className="inset-x-0 bottom-0 h-[env(safe-area-inset-bottom)]" />}
    </>
  );
}

/** A glass circle: close, torch. 44 px, named, and pressed state spoken where it has one. */
export function GlassButton({
  label,
  pressed,
  onClick,
  children,
  className,
  buttonRef,
  tabIndex,
  hidden = false,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
  tabIndex?: number;
  /** Faded out by a layout: out of the tab order and the accessibility tree too. */
  hidden?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : tabIndex}
      data-scan-occluder="spot"
      onClick={onClick}
      className={clsx(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
        "motion-safe:transition-[opacity,background-color,color] motion-safe:duration-300",
        pressed ? "bg-warm text-deep" : "bg-night/55 text-warm",
        hidden ? "pointer-events-none opacity-0" : "pointer-events-auto",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function CloseButton({ pages, onClick, dim = false }: { pages: number; onClick: () => void; dim?: boolean }) {
  const copy = useCopy();
  return (
    <GlassButton
      label={copy.captureLayout.closeAria(pages)}
      onClick={onClick}
      className={dim ? "opacity-75" : undefined}
    >
      <XIcon size={20} strokeWidth={2} />
    </GlassButton>
  );
}

/** The torch toggle, or an empty 44 px slot where the camera has none — the row keeps its shape. */
export function TorchButton({
  torch,
  hidden = false,
  className,
}: {
  torch: CaptureChromeParts["torch"];
  hidden?: boolean;
  className?: string;
}) {
  const copy = useCopy();
  if (!torch.available) return <span aria-hidden="true" className={clsx("block h-11 w-11 shrink-0", className)} />;
  return (
    <GlassButton
      label={copy.capture.torch}
      pressed={torch.on}
      onClick={torch.toggle}
      buttonRef={torch.ref}
      hidden={hidden}
      className={className}
    >
      <TorchIcon size={20} on={torch.on} />
    </GlassButton>
  );
}

/** The one line the camera says: the notice when there is one, else the hint. */
export function hintLine(parts: CaptureChromeParts): { text: string; tone: "night" | "alert" | "warning" } | null {
  if (parts.notice !== null) return { text: parts.notice, tone: "alert" };
  return parts.hint;
}

/**
 * The hint pill, in a polite live region that is always mounted — a hint
 * coming or going is announced, and never moves anything: every layout
 * positions this absolutely, over the stage, never beside it.
 */
export function HintPill({ parts, className }: { parts: CaptureChromeParts; className?: string }) {
  const copy = useCopy();
  const line = hintLine(parts);
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx("pointer-events-none flex flex-wrap items-center justify-center gap-2 px-4", className)}
    >
      {line !== null && <HintBubble text={line.text} tone={line.tone} />}
      {parts.torchOffer !== null && (
        <button
          type="button"
          onClick={parts.torchOffer}
          data-scan-occluder="spot"
          className="pointer-events-auto -my-1 inline-flex min-h-11 items-center"
        >
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warm px-3 py-1.5 text-sm font-semibold text-deep shadow-sm">
            <TorchIcon size={16} on />
            {copy.capture.torchOffer}
          </span>
        </button>
      )}
    </div>
  );
}

/** The pill itself: dark glass, one line where it can, a tone dot where the hint wants action. */
export function HintBubble({ text, tone }: { text: string; tone: "night" | "alert" | "warning" }) {
  return (
    <span data-scan-occluder="spot" className="inline-flex max-w-full items-center gap-2 rounded-full bg-night/75 px-4 py-2 text-center text-base font-semibold leading-tight text-warm shadow-sm">
      {tone !== "night" && (
        <span
          aria-hidden="true"
          className={clsx("h-2 w-2 shrink-0 rounded-full", tone === "warning" ? "bg-warning" : "bg-peach")}
        />
      )}
      {text}
    </span>
  );
}

/**
 * The shutter, in the layouts' own proportions: a `warm` disc inside a ring.
 * With `ringRef` the ring is drawn as SVG and carries the auto-capture
 * countdown (the live loop paints it); the track dims while auto-capture is
 * on so the countdown reads against it. Where the stage is not live (starting,
 * fallback, at capacity) an empty box of the same size keeps its place.
 */
export function LayoutShutter({
  parts,
  size,
  ringRef,
  className,
}: {
  parts: CaptureChromeParts;
  size: number;
  ringRef?: React.Ref<SVGCircleElement>;
  className?: string;
}) {
  const box = { width: size, height: size };
  if (!parts.live) return <span aria-hidden="true" className={clsx("block shrink-0", className)} style={box} />;
  const { shutter } = parts;
  const stroke = 4;
  const radius = size / 2 - stroke / 2 - 1;
  const circumference = 2 * Math.PI * radius;
  const inset = Math.round(size * 0.12);
  return (
    <button
      ref={shutter.ref}
      type="button"
      aria-label={shutter.label}
      disabled={shutter.busy}
      onClick={shutter.onClick}
      className={clsx(
        "pointer-events-auto relative shrink-0 rounded-full disabled:opacity-80",
        ringRef === undefined && "border-4 border-warm",
        className,
      )}
      style={box}
    >
      {ringRef !== undefined && (
        <svg aria-hidden="true" className="absolute inset-0" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            className={clsx(
              "motion-safe:transition-[stroke] motion-safe:duration-300",
              parts.autoCapture.on ? "stroke-warm/35" : "stroke-warm",
            )}
          />
          <circle
            ref={ringRef}
            data-length={circumference.toFixed(2)}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference.toFixed(2)}
            strokeDashoffset={circumference.toFixed(2)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="stroke-warm"
          />
        </svg>
      )}
      <span
        aria-hidden="true"
        className="absolute flex items-center justify-center rounded-full bg-warm text-deep"
        style={{ inset: ringRef === undefined ? inset - 4 : inset }}
      >
        {shutter.busy && <SpinnerIcon size={24} />}
      </span>
    </button>
  );
}

/** The newest page's thumbnail, or nothing yet. */
export function latestTile(bits: LayoutScreenBits): PageTile | null {
  return bits.tiles[bits.tiles.length - 1] ?? null;
}

/** The count badge on a pages button; peach while a page wants a second look. */
export function CountBadge({ bits, className }: { bits: LayoutScreenBits; className?: string }) {
  if (bits.pageCount === 0) return null;
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "absolute flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-xs font-bold leading-none shadow-sm",
        bits.warnedCount > 0 ? "bg-peach text-peach-ink" : "bg-warm text-deep",
        className,
      )}
    >
      {bits.pageCount}
    </span>
  );
}

/** The pages button's name: how many, and whether one wants a look. */
export function usePagesLabel(bits: LayoutScreenBits): string {
  const copy = useCopy();
  const base = copy.captureLayout.pagesAria(bits.pageCount);
  return bits.warnedCount > 0 ? `${base}. ${copy.capture.needAttention(bits.warnedCount)}` : base;
}

/**
 * The classic pages button: the newest page on top of a stack, the count on
 * its corner. Disabled with nothing to show.
 */
export function ThumbStack({ bits }: { bits: LayoutScreenBits }) {
  const tile = latestTile(bits);
  return (
    <button
      type="button"
      aria-label={usePagesLabel(bits)}
      disabled={tile === null}
      onClick={bits.onShowPages}
      className="pointer-events-auto relative h-[60px] w-[60px] shrink-0"
    >
      {tile === null ? (
        <span aria-hidden="true" className="absolute left-2 top-[3px] h-[54px] w-11 rounded border-2 border-dashed border-warm/40" />
      ) : (
        <>
          {bits.pageCount > 1 && (
            <span aria-hidden="true" className="absolute left-1.5 top-1 h-[54px] w-11 -rotate-6 rounded bg-mist" />
          )}
          <PageThumb tile={tile} onNight radius="sm" className="absolute left-2 top-[3px] h-[54px] w-11 border-2 !border-warm" />
        </>
      )}
      <CountBadge bits={bits} className="-right-0.5 -top-1.5" />
    </button>
  );
}

/** "Conferir ›" — the white pill onward. Outlined instead of filled while a page is flagged. */
export function ReviewPill({ bits, className }: { bits: LayoutScreenBits; className?: string }) {
  const copy = useCopy();
  const flagged = bits.warnedCount > 0;
  return (
    <button
      type="button"
      aria-label={copy.captureLayout.reviewAria(bits.pageCount)}
      disabled={bits.pageCount === 0}
      onClick={bits.onReview}
      className={clsx(
        "pointer-events-auto flex h-12 shrink-0 items-center gap-1.5 rounded-full px-4 text-[15px] font-bold",
        // The colours dim rather than `opacity`, which painted a dark box
        // round the pill in Chrome over the bar.
        flagged
          ? "border-[1.5px] border-peach bg-night/55 text-warm"
          : "bg-warm text-deep disabled:bg-warm/35 disabled:text-deep/70",
        className,
      )}
    >
      {copy.captureLayout.review}
      <ChevronRightIcon size={16} strokeWidth={2.5} />
    </button>
  );
}

/** The step, as a pill: "Passo 1 de 3 · Capturar". */
export function StepPill({ className, short = false }: { className?: string; short?: boolean }) {
  const copy = useCopy();
  return (
    <span
      className={clsx(
        "truncate rounded-full bg-night/55 px-3.5 py-2 text-sm font-semibold tracking-[0.01em] text-warm",
        className,
      )}
    >
      {short ? copy.captureLayout.stepShort : copy.captureLayout.stepPill}
    </span>
  );
}

/**
 * "Já tenho a foto" as a quiet text button: the `standard` screen's gallery
 * pill, for a layout whose bottom row belongs to the shutter. Small, no fill,
 * `warm` at 80 % — it must never read as a second shutter — with a 44 px
 * target all the same. A `<label>` round the input, never a button forwarding
 * a click: that is what makes a picker silently not open on iOS. Keeps its
 * box while there is nothing to pick (starting, fallback, at the page limit),
 * so nothing moves when it comes and goes.
 */
export function GalleryLink({ parts, className }: { parts: CaptureChromeParts; className?: string }) {
  const copy = useCopy();
  const gallery = parts.gallery;
  if (gallery === null) return <span aria-hidden="true" className={clsx("block h-11", className)} />;
  return (
    <label
      className={clsx(
        "pointer-events-auto inline-flex h-11 items-center gap-1.5 px-3 text-[13px] font-semibold text-warm/80",
        gallery.busy ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:text-warm",
        className,
      )}
    >
      <input
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        aria-label={copy.capture.galleryAria}
        disabled={gallery.busy}
        className="scan-sr-only"
        onChange={gallery.onChange}
      />
      <ImageIcon size={16} />
      <span aria-hidden="true">{copy.capture.gallery}</span>
    </label>
  );
}
