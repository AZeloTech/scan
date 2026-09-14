/**
 * The one failure type the image pipeline speaks, in a module of its own.
 *
 * Split out of `lib/image.ts` so the encoder (`lib/encode.ts`) — which the
 * render worker imports — can throw it without dragging a main-thread module,
 * and the whole copy deck behind it, into the worker's bundle. `lib/image.ts`
 * re-exports both names, so every existing `from "@/lib/image"` still reads the
 * same class.
 */

/**
 * Which way the image pipeline gave up.
 *
 * A code rather than a sentence: the app is read in pt-BR and en-US, and a
 * failure that happened three screens ago must still be readable after the
 * language changes. `lib/i18n.ts` owns the words.
 */
export type ImagePrepCode =
  /** Decode, canvas allocation or encode failed. The common one. */
  | "prep"
  /** A file type we cannot read at all (HEIC, a PDF, a broken image). */
  | "unsupported"
  /** The camera has no frame yet — `videoWidth` is still zero. */
  | "camera_waking";

/** Thrown by the image pipeline; the screen renders `code` through the copy. */
export class ImagePrepError extends Error {
  readonly code: ImagePrepCode;

  constructor(code: ImagePrepCode) {
    // The message is for a stack trace, never for a user.
    super(`image prep failed: ${code}`);
    this.name = "ImagePrepError";
    this.code = code;
  }
}
