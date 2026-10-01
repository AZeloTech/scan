/**
 * **The only module in `src/` allowed to write a JPEG** (enforced by
 * `source-hygiene.test.ts`).
 *
 * It is its own module rather than part of `lib/image.ts` because the render
 * worker needs it: `image.ts` is a main-thread module — it reaches for
 * `document`, and it pulls the whole copy deck in through `lib/i18n.ts` — and
 * neither belongs in the bundle a worker downloads to encode a page. Splitting
 * the encoder out is what keeps the promise honest across *both* threads:
 * there is still exactly one quality table and exactly one call site per canvas
 * kind, so a lane cannot quietly ship a different generation from the other.
 *
 * The quality ladder is the fidelity contract. A page reaches the PDF through
 * exactly **two** encodes: the canonical (q95, the app's own first generation
 * of the camera frame, at the camera's full resolution) and the final (q92,
 * what the review screen shows and what `embedJpg` copies into the file,
 * byte for byte). The thumbnail is a third encode but
 * feeds nothing — it is a picture of a picture, never an input.
 *
 * Every encode is counted by role ({@link encodeCounts}), because "how many
 * lossy generations did this page suffer" is a claim the product makes out loud
 * and a number a test can therefore assert. The counter is per *realm*: the
 * worker's own tally is a shadow nobody reads, and the roles it wrote come back
 * in its reply so the main thread's ledger stays the one true account
 * (`lib/render-remote.ts`).
 *
 * What the ledger counts is **delivered generations, not encode attempts**: an
 * encode whose bytes never reached this thread — a worker that wrote a final and
 * then died before it could answer, a reply that arrived after its generation
 * was retired — is counted nowhere, because no page ever carried it and the
 * render was re-run from the canonical. The number is therefore the lineage of
 * the JPEGs the app is actually holding (`deliveredEncodes` in
 * `lib/render-protocol.ts` is where that rule is applied).
 */

import { isOffscreen, type CanvasSurface } from "@/lib/canvas-surface";
import { ImagePrepError } from "@/lib/image-error";

/**
 * What a JPEG is being written for. The role picks the quality and is the unit
 * the encode ledger counts in.
 */
export type EncodeRole = "canonical" | "final" | "thumb";

/**
 * Canonical sits above the final on purpose: it is the source every later
 * render decodes, so its own generation loss is paid once and inherited by
 * everything.
 *
 * Measured on a synthetic 2250×4000 phone photo of a printed page (text from
 * 14 to 64 px, a colour stamp, σ≈3 sensor noise), Chromium's encoder, PSNR of
 * what reaches the PDF against the camera's own pixels:
 *
 * | canonical → final | canonical | final (in the PDF) | PSNR |
 * |---|---|---|---|
 * | q0.92 → q0.85 (before) | 2.78 MB | 2.34 MB | 33.6 dB |
 * | q0.95 → q0.92          | 3.77 MB | 3.22 MB | 36.5 dB |
 * | q0.95 → q0.95 (now)    | 3.77 MB | 3.76 MB | 39.8 dB |
 * | single q1.0 (ceiling)  | —       | 8.58 MB | 52.7 dB |
 *
 * q0.95/q0.92 bought ~3 dB (half the squared error) for ~38 % more bytes per
 * page over the old chain; the final at q0.95 buys ~3 dB more for ~17 %
 * more (the owner's call, once the page fills more of the frame and the
 * pixels are worth keeping); q1.0 costs 2.7× the bytes for noise the camera
 * made. The canonical is never shipped (the store holds it, the PDF gets the
 * final), so its extra megabyte is memory, not file size. A host that sets
 * `maxBytes` gets q0.92 back first (`SIZE_LADDER`, `lib/pdf.ts`).
 */
const JPEG_QUALITY: Record<EncodeRole, number> = {
  canonical: 0.95,
  final: 0.95,
  thumb: 0.8,
};

/** The quality a role is encoded at — for the diagnostics stream. */
export function encodeQuality(role: EncodeRole): number {
  return JPEG_QUALITY[role];
}

const encodes: Record<EncodeRole, number> = {
  canonical: 0,
  final: 0,
  thumb: 0,
};

/**
 * Record one encode against a role.
 *
 * Exported so a fake codec in a test — and the seam that receives the worker's
 * reply — report on the same ledger the real one writes to. The lineage
 * assertion ("one canonical, N finals, and the finals all came from that
 * canonical") is only meaningful if there is a single counter for all of them
 * to agree on.
 */
export function countEncode(role: EncodeRole): void {
  encodes[role] += 1;
}

/** How many JPEGs this session has written, by role. */
export function encodeCounts(): Readonly<Record<EncodeRole, number>> {
  return { ...encodes };
}

export function resetEncodeCounts(): void {
  encodes.canonical = 0;
  encodes.final = 0;
  encodes.thumb = 0;
}

function encodeHtml(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new ImagePrepError("prep"));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality,
    );
  });
}

/**
 * Encode a surface as JPEG at its role's quality, on either thread.
 *
 * The two branches are the same encoder reached through the two APIs the
 * platform offers — same engine, same quality argument, same output — which is
 * the reason the worker lane is allowed to exist at all.
 *
 * `quality` overrides the role's table entry, and exists for exactly one
 * caller: the size ladder in `lib/pdf.ts`, which walks a page down q92 → q75 →
 * q65 to fit a host's `maxBytes`. It still counts as a `final`, because that is
 * what it produces — a generation of the page that really ships — and the
 * ledger's claim is about delivered generations, not about which table row
 * picked the number.
 */
export async function encodeSurface(
  surface: CanvasSurface,
  role: EncodeRole,
  quality: number = JPEG_QUALITY[role],
): Promise<Blob> {
  const blob = isOffscreen(surface)
    ? await surface.convertToBlob({ type: "image/jpeg", quality })
    : await encodeHtml(surface, quality);
  countEncode(role);
  return blob;
}
