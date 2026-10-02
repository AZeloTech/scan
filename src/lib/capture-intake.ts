"use client";

/**
 * What a photo has to go through before it can become a page — and the one
 * place that knows the order.
 *
 * There are two ways into this app: the shutter (which owns the camera, and
 * measures the frame it already has in memory) and the gallery (which starts
 * from a file the OS handed us). The shutter path lives in `CaptureStage`
 * because it is inseparable from the viewfinder; the gallery path lives here
 * because it now has **two** callers — the capture screen's "galeria" action
 * and the permission primer's "Escolher da galeria", which exists precisely so
 * that a user who will not grant the camera can still finish the job.
 *
 * The order matters and is the reason this is a module rather than a helper on
 * each screen: measure BEFORE the warp (the gate's floors were derived on
 * pre-warp frames), then detect, then hand up. Getting that
 * backwards would silently shift every reading.
 *
 * Intake produces **no warped bytes**. It hands up the canonical and
 * the quad; the warp happens once, inside the page's own render.
 */

import { detectInBlob } from "@/lib/flatten";
import { assessBlob, type GateReading } from "@/lib/capture-gate";
import { type NormalizedQuad } from "@/lib/quad";
import type { CornerCheck } from "@/lib/corner-check";
import type { StillAttention } from "@/lib/still-check";
import { isAcceptedImageType, prepareCapture, ImagePrepError } from "@/lib/image";
import { encodeQuality } from "@/lib/encode";
import type { StillFallbackReason } from "@/lib/still-capture";
import type { AssetUrls } from "@/lib/runtime-config";

/**
 * Which affordance produced a capture.
 *
 * It used to feed a per-capture debug row as well; that log does not exist in
 * this library — there is no debug-metrics module and no `?debug=1` flag — and
 * the value survives only because the store branches on it — a page
 * that arrived through `adjust` keeps its rotation, one that arrived through
 * the shutter does not.
 */
export type CapturePath = "shutter" | "gallery" | "desktop" | "retake" | "adjust";

/**
 * What the page's pixels are, and how they got there — metadata only, for the
 * diagnostics stream's `capture` and `confirm` events.
 */
export interface CaptureSizes {
  /** The camera's still photo, the preview frame, or a picked file. */
  source: "still" | "preview" | "file";
  /** The source as it arrived (the still before its crop, the stream, the decoded file). */
  sourceWidth: number;
  sourceHeight: number;
  /** The canonical's own pixels. */
  width: number;
  height: number;
  /** The canonical's encoded size. */
  bytes: number;
  /** The canonical's JPEG quality. */
  quality: number;
  /** True only when the browser's canvas limit made the canonical smaller than its source. */
  capped: boolean;
  /** Camera path: why the still did not become the page (null when it did, or for a file). */
  stillReason: StillFallbackReason | null;
}

/** One photo, prepared and measured, ready to become a page. */
export interface Capture {
  /**
   * The page's one source: the frame with EXIF applied, at the full
   * resolution it was delivered in, encoded once at the canonical quality.
   * Everything the page ever shows is rendered from it.
   */
  canonical: Blob;
  /** How the canonical was made (sizes, source, quality). Absent for PDF imports. */
  sizes?: CaptureSizes;
  /** The quad, as fractions of the canonical — the corner editor's start. */
  corners: NormalizedQuad | null;
  /**
   * What the capture's refinement said about those corners
   * (`lib/corner-check.ts`): the confirm screen marks a corner something lay
   * over as estimated. Absent when not measured (a gallery pick, an edit).
   */
  cornerCheck?: CornerCheck;
  /**
   * The on-device "will this OCR?" reading, measured on the full-resolution
   * frame BEFORE any warp. It is the page's only quality verdict — there is
   * no server to second-guess it — and it still never blocks a capture: a weak
   * reading is an offer to retake, nothing more. Null when the measurement
   * could not be taken, which the page then reports as "não verificada" —
   * never as a pass.
   */
  gate: GateReading | null;
  /** Which affordance produced it. */
  path: CapturePath;
  /**
   * The camera path's check of the photo (`lib/still-check.ts`): why the
   * confirm screen should ask for a closer look — a corner on the photo's
   * edge, the page not where the viewfinder had it, no page found — or
   * absent/null when the photo holds the page whole. Never stops a capture.
   */
  attention?: StillAttention | null;
}

/**
 * A file the user picked → a {@link Capture}.
 *
 * Throws {@link ImagePrepError} carrying a code the caller renders through the
 * dictionary; a file of a type we cannot read is rejected up front rather than
 * after a decode attempt, so the code can name the actual problem.
 */
export async function captureFromFile(
  file: File,
  assets: AssetUrls,
  path: CapturePath = "gallery",
): Promise<Capture> {
  if (file.type !== "" && !isAcceptedImageType(file)) {
    throw new ImagePrepError("unsupported");
  }
  const prepared = await prepareCapture(file);
  const canonical = prepared.canonical;
  const sizes: CaptureSizes = {
    source: "file",
    sourceWidth: prepared.sourceWidth,
    sourceHeight: prepared.sourceHeight,
    width: prepared.width,
    height: prepared.height,
    bytes: canonical.size,
    quality: encodeQuality("canonical"),
    capped: prepared.capped,
    stillReason: null,
  };
  // Measured before the warp, exactly like the shutter path — an unmeasured
  // capture silently reads as `ok`, so a gallery pick that cannot be read would
  // otherwise reach the user with no warning at all.
  const gate = await assessBlob(canonical);
  const detection = await detectInBlob(canonical, assets);
  return { canonical, corners: detection?.corners ?? null, gate, path, sizes };
}
