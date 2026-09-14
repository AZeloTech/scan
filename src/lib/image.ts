"use client";

/**
 * Decode and downscale — the byte-level plumbing every other module sits on.
 *
 * One number matters here. The 3000 px cap on the long edge is about the phone:
 * the warp, the illumination pass and the PDF embed all work on this grid, and
 * above ~3000 px a cheap Android starts failing canvas allocations rather than
 * getting slower. It is applied exactly once per page, when the camera frame or
 * the picked file becomes the page's **canonical** JPEG — never again, because
 * re-applying it to an already-capped image is a second resample for nothing.
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

export const MAX_LONG_EDGE = 3000;

export const ACCEPTED_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const ACCEPT_ATTRIBUTE = ACCEPTED_UPLOAD_TYPES.join(",");

function targetSize(width: number, height: number): { w: number; h: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= MAX_LONG_EDGE) return { w: width, h: height };
  const scale = MAX_LONG_EDGE / longEdge;
  return {
    w: Math.max(1, Math.round(width * scale)),
    h: Math.max(1, Math.round(height * scale)),
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

/** Fallback for browsers without `createImageBitmap` resize options. */
function prepareWithImageElement(file: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const { w, h } = targetSize(image.naturalWidth, image.naturalHeight);
      encodeSource(image, w, h, "canonical")
        .then(resolve)
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
 * long edge capped, encoded at q92.
 *
 * Rejects with `ImagePrepError` carrying the code the screen renders.
 */
export async function prepareCapture(file: Blob): Promise<Blob> {
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
  try {
    const { w, h } = targetSize(bitmap.width, bitmap.height);
    if (w === bitmap.width && h === bitmap.height) {
      return await encodeSource(bitmap, w, h, "canonical");
    }
    // The resize happens during decode where the browser supports it — much
    // cheaper than a full-resolution canvas on a low-end phone.
    const resized = await createImageBitmap(file, {
      imageOrientation: "from-image",
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: "high",
    });
    try {
      return await encodeSource(resized, resized.width, resized.height, "canonical");
    } finally {
      resized.close();
    }
  } finally {
    bitmap.close();
  }
}

/**
 * Grabs the current live-preview frame into a canvas, capped at the long edge.
 *
 * A canvas rather than a JPEG because the frame has three consumers that must
 * agree on one pixel grid: the gate (measured pre-warp), the quad the
 * viewfinder was showing, and the canonical encode.
 */
export function frameToCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) {
    throw new ImagePrepError("camera_waking");
  }
  const { w, h } = targetSize(width, height);
  return drawToCanvas(video, w, h);
}

/**
 * An already-decoded photo → a canvas on the very same grid `frameToCanvas`
 * produces, so the still and the preview frame are interchangeable downstream.
 *
 * The bitmap is the caller's to close: this only reads it. It arrives upright
 * (the still path decodes with `imageOrientation: "from-image"`), which is why
 * nothing here touches orientation.
 */
export function bitmapToCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  if (bitmap.width === 0 || bitmap.height === 0) {
    throw new ImagePrepError("prep");
  }
  const { w, h } = targetSize(bitmap.width, bitmap.height);
  return drawToCanvas(bitmap, w, h);
}

/**
 * Decodes any accepted image into a canvas, capped at the long edge.
 *
 * For images whose provenance we do not control — a picked file being measured
 * by the gate, a frame handed to the detector. The page's own canonical goes
 * through {@link decodeCanonical} instead, which neither caps nor re-orients.
 */
export async function decodeToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  const draw = (
    source: CanvasImageSource,
    width: number,
    height: number,
  ): HTMLCanvasElement => {
    const { w, h } = targetSize(width, height);
    return drawToCanvas(source, w, h);
  };

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      try {
        return draw(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch {
      // Fall through to the <img> path below.
    }
  }

  return new Promise<HTMLCanvasElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        resolve(draw(image, image.naturalWidth, image.naturalHeight));
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

/**
 * Decodes a page's canonical JPEG at its own size.
 *
 * Deliberately **not** {@link decodeToCanvas}: the canonical is already capped
 * and already upright, so re-applying the cap would resample it a second time
 * and re-applying EXIF would re-orient an image that carries no orientation.
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
