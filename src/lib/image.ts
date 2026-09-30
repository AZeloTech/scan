"use client";

/**
 * Decode, draw and encode — the byte-level plumbing every other module sits on.
 *
 * **No resolution cap.** The page's canonical is made at the size the camera
 * (or the picked file) delivered, pixel for pixel. This file used to cap every
 * source at a 3000 px long edge, which on a 2160×3840 stream threw away 39 %
 * of the pixels before anything else ran, and on a 12 MP photo more than
 * half. The only limit left is the browser's own: a canvas larger than
 * {@link canvasLimit} is not "slower", it is blank or refused, so a source
 * above it is drawn at the largest size that fits — and the caller is told
 * (`capped`), so the downgrade is reported rather than silent.
 *
 * Writing a JPEG belongs to `lib/encode.ts`, which the render worker shares;
 * the encoder's names are re-exported here so this stays the one import every
 * main-thread caller needs.
 */

import {
  countEncode,
  encodeCounts,
  encodeSurface,
  resetEncodeCounts,
  type EncodeRole,
} from "@/lib/encode";
import { releaseSurface } from "@/lib/canvas-surface";
import { ImagePrepError, type ImagePrepCode } from "@/lib/image-error";
import { currentLang, localeTag } from "@/lib/i18n";

export { countEncode, encodeCounts, resetEncodeCounts, ImagePrepError };
export type { EncodeRole, ImagePrepCode };

export const ACCEPTED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const ACCEPT_ATTRIBUTE = ACCEPTED_UPLOAD_TYPES.join(",");

/** The largest canvas a browser will actually allocate and draw. */
export interface CanvasLimit {
  /** Width × height, in pixels. */
  maxArea: number;
  /** Either side, in pixels. */
  maxSide: number;
}

/**
 * iOS and iPadOS WebKit (every browser there): 16,777,216 px (4096 × 4096) of
 * area. Above it the context comes back null or the canvas silently draws
 * nothing — the documented WebKit limit on those devices, and the only limit a
 * phone camera can realistically meet (a 48 MP photo picked from the library).
 */
export const WEBKIT_MOBILE_CANVAS_LIMIT: CanvasLimit = { maxArea: 16_777_216, maxSide: 32_767 };

/**
 * Chromium (Android and desktop), desktop Safari and Firefox: 268,435,456 px
 * (16,384 × 16,384) of area — Chromium's and desktop WebKit's limit, and below
 * Firefox's (472,907,776) — and 32,767 px per side (Firefox's side limit;
 * Chromium allows 65,535). No camera sensor a phone ships reaches it.
 */
export const DEFAULT_CANVAS_LIMIT: CanvasLimit = { maxArea: 268_435_456, maxSide: 32_767 };

/** Whether this is iOS/iPadOS WebKit (iPadOS reports itself as a Mac with touch). */
function isWebKitMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/** The canvas limit of the browser this runs in. */
export function canvasLimit(): CanvasLimit {
  return isWebKitMobile() ? WEBKIT_MOBILE_CANVAS_LIMIT : DEFAULT_CANVAS_LIMIT;
}

/** A size that fits the canvas limit, and whether it had to shrink to. */
export interface FittedSize {
  width: number;
  height: number;
  /** True only when the source was larger than the browser can draw. */
  capped: boolean;
}

/**
 * `width × height` unchanged when the browser can draw it; otherwise the
 * largest same-shape size that fits `limit`. Pure, for the tests.
 */
export function fitCanvasLimit(
  width: number,
  height: number,
  limit: CanvasLimit = canvasLimit(),
): FittedSize {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w * h <= limit.maxArea && w <= limit.maxSide && h <= limit.maxSide) {
    return { width: w, height: h, capped: false };
  }
  const scale = Math.min(Math.sqrt(limit.maxArea / (w * h)), limit.maxSide / Math.max(w, h));
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
    capped: true,
  };
}

/** The main thread's encode, through the one encoder. */
export function encodeCanvas(
  canvas: HTMLCanvasElement,
  role: EncodeRole,
): Promise<Blob> {
  return encodeSurface(canvas, role);
}

/**
 * A canvas that is finished with: drop its backing store now rather than when
 * a phone with 200 MB of headroom gets round to collecting it.
 */
export function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  releaseSurface(canvas);
}

function drawToCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new ImagePrepError("prep");
    }
    context.drawImage(source, 0, 0, width, height);
    return canvas;
  } catch (error) {
    // Every caller answers a failed construction by allocating something else
    // straight away — the preview frame after a still, the un-warped page after
    // a warp — and it does so under exactly the memory pressure that caused
    // this. Handing the backing store back before the throw is what keeps the
    // next allocation from competing with a canvas nobody will ever draw.
    releaseCanvas(canvas);
    throw error;
  }
}

async function encodeSource(
  source: CanvasImageSource,
  width: number,
  height: number,
  role: EncodeRole,
): Promise<Blob> {
  const canvas = drawToCanvas(source, width, height);
  try {
    return await encodeCanvas(canvas, role);
  } finally {
    releaseCanvas(canvas);
  }
}

/** What a picked file became: the canonical and the sizes it went through. */
export interface PreparedCapture {
  canonical: Blob;
  /** The canonical's own pixels. */
  width: number;
  height: number;
  /** The decoded file, upright, before anything else. */
  sourceWidth: number;
  sourceHeight: number;
  /** True only when the file was larger than this browser can draw ({@link canvasLimit}). */
  capped: boolean;
}

/** Fallback for browsers without `createImageBitmap`. */
function prepareWithImageElement(file: Blob): Promise<PreparedCapture> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const fitted = fitCanvasLimit(image.naturalWidth, image.naturalHeight);
      encodeSource(image, fitted.width, fitted.height, "canonical")
        .then((canonical) =>
          resolve({
            canonical,
            width: fitted.width,
            height: fitted.height,
            sourceWidth: image.naturalWidth,
            sourceHeight: image.naturalHeight,
            capped: fitted.capped,
          }),
        )
        .catch(reject)
        .finally(() => URL.revokeObjectURL(url));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImagePrepError("unsupported"));
    };
    image.src = url;
  });
}

/**
 * A picked file → the page's **canonical** JPEG: EXIF honoured exactly once,
 * every pixel of the file kept (only a file larger than the browser can draw is
 * fitted to {@link canvasLimit}, and says so), encoded once at the canonical
 * quality.
 *
 * Rejects with `ImagePrepError` carrying the code the screen renders.
 */
export async function prepareCapture(file: Blob): Promise<PreparedCapture> {
  if (typeof createImageBitmap !== "function") {
    return prepareWithImageElement(file);
  }
  let bitmap: ImageBitmap;
  try {
    // EXIF orientation is honoured HERE and nowhere else: the canonical is
    // upright by construction, so every later decode can take the pixels as
    // they are.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return prepareWithImageElement(file);
  }
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const fitted = fitCanvasLimit(sourceWidth, sourceHeight);
  try {
    if (!fitted.capped) {
      const canonical = await encodeSource(bitmap, sourceWidth, sourceHeight, "canonical");
      return { canonical, width: sourceWidth, height: sourceHeight, sourceWidth, sourceHeight, capped: false };
    }
  } finally {
    if (!fitted.capped) bitmap.close();
  }
  // Too large for this browser's canvas: one high-quality resample during the
  // decode, straight to the largest size it can draw. The full-size bitmap is
  // released first so the two never coexist.
  bitmap.close();
  const resized = await createImageBitmap(file, {
    imageOrientation: "from-image",
    resizeWidth: fitted.width,
    resizeHeight: fitted.height,
    resizeQuality: "high",
  });
  try {
    const canonical = await encodeSource(resized, resized.width, resized.height, "canonical");
    return { canonical, width: resized.width, height: resized.height, sourceWidth, sourceHeight, capped: true };
  } finally {
    resized.close();
  }
}

/** A capture canvas, and whether the browser's canvas limit shrank it. */
export interface CaptureCanvas {
  canvas: HTMLCanvasElement;
  capped: boolean;
}

/**
 * Grabs the current live-preview frame into a canvas at the stream's **native
 * size** — every pixel the camera is delivering, no intermediate downscale.
 *
 * A canvas rather than a JPEG because the frame has three consumers that must
 * agree on one pixel grid: the gate (measured pre-warp), the quad the
 * viewfinder was showing, and the canonical encode.
 */
export function frameToCanvas(video: HTMLVideoElement): CaptureCanvas {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) {
    throw new ImagePrepError("camera_waking");
  }
  const fitted = fitCanvasLimit(width, height);
  return { canvas: drawToCanvas(video, fitted.width, fitted.height), capped: fitted.capped };
}

/**
 * An already-decoded photo → a canvas of `crop` (the whole photo by default)
 * at the photo's own resolution: a crop is a copy of pixels, never a resample.
 *
 * The bitmap is the caller's to close: this only reads it. It arrives upright
 * (the still path decodes with `imageOrientation: "from-image"`), which is why
 * nothing here touches orientation.
 */
export function bitmapToCanvas(
  bitmap: ImageBitmap,
  crop: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: bitmap.width,
    height: bitmap.height,
  },
): CaptureCanvas {
  if (bitmap.width === 0 || bitmap.height === 0 || crop.width <= 0 || crop.height <= 0) {
    throw new ImagePrepError("prep");
  }
  const fitted = fitCanvasLimit(crop.width, crop.height);
  const canvas = document.createElement("canvas");
  try {
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new ImagePrepError("prep");
    context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      fitted.width,
      fitted.height,
    );
    return { canvas, capped: fitted.capped };
  } catch (error) {
    releaseCanvas(canvas);
    throw error instanceof ImagePrepError ? error : new ImagePrepError("prep");
  }
}

/**
 * Decodes a page's canonical JPEG at its own size.
 *
 * The canonical is already upright and already at its final resolution, so
 * this neither resamples nor re-orients — it is the page's pixels exactly as
 * captured.
 * Every render of a page starts here.
 */
export async function decodeCanonical(blob: Blob): Promise<HTMLCanvasElement> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        return drawToCanvas(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch {
      // Fall through to the <img> path below.
    }
  }

  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      try {
        resolve(drawToCanvas(image, image.naturalWidth, image.naturalHeight));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImagePrepError("unsupported"));
    };
    image.src = url;
  });
}

/** Guard for the `<input capture>` path — the picker's `accept` is advisory. */
export function isAcceptedImageType(file: File): boolean {
  return ACCEPTED_UPLOAD_TYPES.some((type) => type === file.type);
}

/**
 * Renders a byte count for a human ("1,2 MB" in pt-BR, "1.2 MB" in en-US).
 *
 * The decimal separator follows the reader, which is why this reaches for the
 * current language rather than hard-coding a comma: "1,2 MB" reads as *twelve*
 * megabytes to an en-US reader, and this number sits next to a download button.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`;
  const megabytes = kilobytes / 1024;
  return `${megabytes.toLocaleString(localeTag(currentLang()), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} MB`;
}
