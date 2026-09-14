"use client";

import * as React from "react";
import {
  rotatedFitScale,
  rotatedObjectFit,
  type PageRotation,
  type RotationBox,
  type RotationFit,
} from "@/lib/rotation";

/**
 * Keeps a rotated `<img>` inside the box it was laid out in.
 *
 * A quarter turn swaps the axes of the element, so a thumbnail that fit its
 * frame perfectly at 0° spills over its neighbours at 90°. The compensating
 * scale depends on the frame's real pixel size (thumbnails here range from a
 * 56px rail tile to a full-screen preview) and on the image's intrinsic
 * proportions, so it is measured rather than written into a class.
 *
 * Both are watched: a `ResizeObserver` on the frame, and the image's own
 * `load`, because `naturalWidth` is 0 until the blob has decoded.
 */
export interface RotatedFit {
  /** Goes on the element that defines the space the image may use. */
  frameRef: React.MutableRefObject<HTMLDivElement | null>;
  imageRef: React.MutableRefObject<HTMLImageElement | null>;
  /** Apply in the same `transform` as the rotation itself. */
  scale: number;
  /**
   * The `object-fit` to render with — the caller's choice for half turns, and
   * always `contain` for quarter turns, so a turned page is never cropped
   * twice (see `lib/rotation.ts:rotatedObjectFit`).
   */
  fit: RotationFit;
  /**
   * The scale a given rotation needs, measured **now**.
   *
   * `scale` above is state, and state arrives a commit late — an animation that
   * reads it while turning tweens to the angle it is leaving. Anything that
   * animates the turn asks for its target through this instead.
   */
  scaleFor: (rotation: PageRotation) => number;
  /** Wire to `<img onLoad>` — the intrinsic size only exists once pixels do. */
  handleImageLoad: () => void;
}

/** Below this the difference is invisible and a re-render is pure churn. */
const SCALE_EPSILON = 0.001;

/**
 * The measurement has to land before the browser paints, or a page that is
 * already turned shows one unscaled frame on open. `useLayoutEffect` warns
 * during the static export's server render, where there is nothing to measure
 * anyway.
 */
const useMeasureEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export function useRotatedFit(
  rotation: PageRotation,
  fit: RotationFit,
): RotatedFit {
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const imageRef = React.useRef<HTMLImageElement | null>(null);
  const [scale, setScale] = React.useState(1);

  const scaleFor = React.useCallback((target: PageRotation): number => {
    const frame = frameRef.current;
    if (frame === null) return 1;
    const image = imageRef.current;
    const natural: RotationBox | null =
      image === null || image.naturalWidth === 0
        ? null
        : { width: image.naturalWidth, height: image.naturalHeight };
    return rotatedFitScale(
      target,
      { width: frame.clientWidth, height: frame.clientHeight },
      natural,
    );
  }, []);

  const measure = React.useCallback(() => {
    if (frameRef.current === null) return;
    const next = scaleFor(rotation);
    setScale((current) =>
      Math.abs(current - next) < SCALE_EPSILON ? current : next,
    );
  }, [rotation, scaleFor]);

  useMeasureEffect(() => {
    measure();
    const frame = frameRef.current;
    if (frame === null || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(frame);
    return () => {
      observer.disconnect();
    };
  }, [measure]);

  return {
    frameRef,
    imageRef,
    scale,
    fit: rotatedObjectFit(rotation, fit),
    scaleFor,
    handleImageLoad: measure,
  };
}
