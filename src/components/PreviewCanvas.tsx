"use client";

import * as React from "react";
import clsx from "clsx";
import { releaseCanvas } from "@/lib/image";
import { renderPreviewCanvas, type RenderRequest } from "@/lib/page-processing";

/**
 * A page rendered for the eye only — **never encoded**.
 *
 * Two screens need to show pixels that are not (yet) a page's `final`: the
 * press-and-hold "sem melhorias" comparison, and the fresh photo in a retake,
 * which has no page to belong to until the user picks it. Both used to be
 * served by writing another JPEG, which is exactly the extra lossy generation
 * the fidelity rule exists to remove — and, in the comparison's case, absurd: a compressed
 * picture of what the compression is doing.
 *
 * So this renders to a canvas at display scale and paints it. The result feeds
 * nothing: it is not an artifact, cannot be embedded, and dies with the screen.
 *
 * `cacheKey` is what the render is keyed on — a page id and revision, a
 * capture's identity. While it holds, re-activating the canvas repaints from
 * the canvas already in hand instead of running the pass again.
 */
interface PreviewCanvasProps {
  request: RenderRequest;
  /** Changes when the pixels would change. */
  cacheKey: string;
  /** False parks the canvas: nothing renders and nothing is shown. */
  active?: boolean;
  /** Long edge of the render. Display scale, not page scale. */
  longEdge?: number;
  /**
   * What a screen reader should call it. Omitted for a canvas that is a visual
   * flourish over a picture that already has a name.
   */
  label?: string;
  className?: string;
}

export function PreviewCanvas({
  request,
  cacheKey,
  active = true,
  longEdge = 1000,
  label,
  className,
}: PreviewCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const cacheRef = React.useRef<{ key: string; canvas: HTMLCanvasElement } | null>(
    null,
  );
  const [painted, setPainted] = React.useState(false);

  const { canonical, corners, rotation, finish } = request;

  React.useEffect(() => {
    setPainted(false);
    return () => {
      releaseCanvas(cacheRef.current?.canvas ?? null);
      cacheRef.current = null;
    };
  }, [cacheKey]);

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        let cached = cacheRef.current;
        if (cached === null || cached.key !== cacheKey) {
          const canvas = await renderPreviewCanvas(
            { canonical, corners, rotation, finish },
            longEdge,
          );
          if (cancelled) {
            releaseCanvas(canvas);
            return;
          }
          releaseCanvas(cacheRef.current?.canvas ?? null);
          cached = { key: cacheKey, canvas };
          cacheRef.current = cached;
        }
        const host = canvasRef.current;
        if (cancelled || host === null) return;
        host.width = cached.canvas.width;
        host.height = cached.canvas.height;
        host.getContext("2d")?.drawImage(cached.canvas, 0, 0);
        setPainted(true);
      } catch {
        // A preview is a courtesy: failing to build one must never take the
        // screen it sits on down with it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, cacheKey, canonical, corners, finish, longEdge, rotation]);

  return (
    <canvas
      ref={canvasRef}
      {...(label === undefined
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label })}
      className={clsx(
        "transition-opacity duration-150 motion-reduce:transition-none",
        active && painted ? "opacity-100" : "opacity-0",
        className,
      )}
    />
  );
}
