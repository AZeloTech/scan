"use client";

import * as React from "react";
import clsx from "clsx";
import { useBlobUrl } from "@/hooks/useScanStore";
import { useRotatedFit } from "@/hooks/useRotatedFit";
import { swapIn } from "@/lib/motion";
import { turnDegrees, type PageRotation } from "@/lib/rotation";
import { displayRotation } from "@/lib/scan-store";
import type { PageTile } from "@/lib/page-tiles";
import { useCopy } from "@/components/I18n";
import { RADIUS_CLASSES, Skeleton } from "@/components/ui";

interface PageThumbProps {
  tile: PageTile;
  className?: string;
  /** Larger, calmer rendering for the review cards. */
  fit?: "cover" | "contain";
  /** On the capture rail, where a cream frame would glow against the night. */
  onNight?: boolean;
  /** A prop, not a `className` — two `rounded-*` utilities race each other. */
  radius?: keyof typeof RADIUS_CLASSES;
}

/**
 * Shows the captured frame instantly, then swaps to the normalised thumbnail
 * the moment processing finishes — the "we cleaned it up for you" moment, and
 * the reason the swap is animated rather than silent: it is worth noticing.
 *
 * Both are local blobs now; nothing here waits on a network.
 *
 * A turn is baked into the page's own render, so most of the time the picture
 * arrives already upright and `displayRotation` is 0. It is non-zero only in
 * the window between the tap and that render landing — long enough for the
 * animation to play, which is what keeps "Girar" feeling instant. The
 * compensating scale (`useRotatedFit`) is what stops a quarter-turned tile from
 * spilling into its neighbours in the rail during that window, and a quarter
 * turn is rendered `contain` whatever the caller asked for, so the page the
 * user just chose to look at is never cropped on both axes at once.
 */
export function PageThumb({
  tile,
  className,
  fit = "cover",
  onNight = false,
  radius = "xl",
}: PageThumbProps) {
  const copy = useCopy();
  const { thumb, final, canonical } = tile.page;
  const rotation = displayRotation(tile.page);
  // The canonical is the instant fallback: it is already in hand, so the tile
  // shows the user's own photo the moment it lands and swaps to the cleaned
  // thumbnail when the render finishes.
  const url = useBlobUrl(thumb ?? final ?? canonical);
  const {
    frameRef,
    imageRef,
    scale,
    fit: effectiveFit,
    handleImageLoad,
  } = useRotatedFit(rotation, fit);

  const cleaned = thumb !== null;
  React.useEffect(() => {
    if (!cleaned) return;
    swapIn(imageRef.current);
  }, [cleaned, imageRef]);

  /**
   * Cumulative, so a turn always reads clockwise: the model wraps 270 → 0, and
   * transitioning to a smaller angle would spin the thumbnail three quarters
   * backwards while the button that triggered it said "Girar".
   */
  const spin = React.useRef<{ degrees: number; applied: PageRotation }>({
    degrees: rotation,
    applied: rotation,
  });
  const [degrees, setDegrees] = React.useState<number>(rotation);
  React.useEffect(() => {
    if (spin.current.applied === rotation) return;
    spin.current = {
      degrees: turnDegrees(spin.current.degrees, spin.current.applied, rotation),
      applied: rotation,
    };
    setDegrees(spin.current.degrees);
  }, [rotation]);

  return (
    <div
      ref={frameRef}
      className={clsx(
        "relative overflow-hidden border",
        RADIUS_CLASSES[radius],
        onNight ? "border-warm/25 bg-night-2" : "border-border bg-cream",
        className,
      )}
    >
      {url === null ? (
        <Skeleton onNight={onNight} radius={radius} className="h-full w-full" />
      ) : (
        // The turn lives on this wrapper rather than on the `<img>`: GSAP owns
        // the image's own transform for the swap-in pop, and the two writing to
        // `style.transform` in turn is how a rotated thumb would silently snap
        // back upright.
        <div
          className="h-full w-full transition-transform duration-300 ease-out motion-reduce:transition-none"
          style={{ transform: `rotate(${degrees}deg) scale(${scale})` }}
        >
          {/* A local object URL — next/image cannot take one, and there is no
              remote asset in this product to optimise. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={url}
            alt={copy.common.page(tile.humanNumber)}
            onLoad={handleImageLoad}
            className={clsx(
              "h-full w-full",
              effectiveFit === "cover" ? "object-cover" : "object-contain",
            )}
          />
        </div>
      )}
      {!cleaned && (
        <div
          aria-hidden="true"
          className={clsx(
            "absolute inset-0 motion-safe:animate-soft-pulse",
            onNight ? "bg-warm/10" : "bg-deep/10",
          )}
        />
      )}
    </div>
  );
}
