"use client";

import * as React from "react";
import { ACCEPT_ATTRIBUTE, ImagePrepError } from "@/lib/image";
import { captureFromFile, type Capture } from "@/lib/capture-intake";
import { useEntrance } from "@/hooks/useEntrance";
import { useAssetUrls, useScanRuntime } from "@/hooks/useScanRuntime";
import { AppFrame } from "@/components/AppFrame";
import { useCopy } from "@/components/I18n";
import { Button, Meta, Notice } from "@/components/ui";
import { CameraIcon, ImageIcon, SpinnerIcon } from "@/components/icons";

/**
 * The screen before the OS dialog.
 *
 * A permission prompt that arrives unannounced is the single most common way a
 * camera app loses a user: the system sheet says nothing about *why*, "Não
 * permitir" is one tap, and Android will not ask twice. So this screen spends
 * one beat saying what the camera is for, that the photos stay here, and that
 * the decision is reversible — and only then triggers the prompt, from a
 * deliberate tap.
 *
 * It also carries the escape hatch, and that is not a consolation prize: a user
 * who has already photographed their exam with the normal camera app, or who
 * simply will not grant access, can finish the whole job from the gallery.
 *
 * Skipped entirely when the answer is already known — see
 * {@link cameraAccessState}. Nobody who has granted the camera should meet this
 * screen on their second document.
 */

interface PermissionPrimerProps {
  /** `denied` changes the copy: no dialog is coming, the gallery is the path. */
  access: CameraAccess;
  /** The user chose the camera: stop rendering this and mount the viewfinder. */
  onAllow: () => void;
  /** A photo arrived from the gallery instead. */
  onCapture: (capture: Capture) => void;
  /** Back to wherever they came from. */
  onBack: () => void;
}

export function PermissionPrimer({
  access,
  onAllow,
  onCapture,
  onBack,
}: PermissionPrimerProps) {
  const copy = useCopy();
  const urls = useAssetUrls();
  const { intake, reportError } = useScanRuntime();
  const denied = access === "denied";
  const scope = useEntrance<HTMLDivElement>({ y: 14, stagger: 0.05 });
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  /**
   * The three lines, with the one word that has to be bold left as its own
   * fragment: it names the button in the OS dialog, and a user hunting for it
   * finds it faster than they read the sentence around it.
   */
  const reasons: React.ReactNode[] = denied
    ? [
        <>
          {copy.primer.unlockLead}
          <strong className="font-semibold text-ink">
            {copy.primer.unlockWord}
          </strong>
          {copy.primer.unlockTail}
        </>,
        <>{copy.primer.stays}</>,
        <>{intake.images ? copy.primer.galleryWorks : copy.primer.stays}</>,
      ]
    : [
        <>
          {copy.primer.allowLead}
          <strong className="font-semibold text-ink">
            {copy.primer.allowWord}
          </strong>
          {copy.primer.allowTail}
        </>,
        <>{copy.primer.stays}</>,
        <>{copy.primer.revoke}</>,
      ];

  const handleFile = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file === undefined) return;
      setBusy(true);
      setMessage(null);
      try {
        onCapture(await captureFromFile(file, urls, "gallery"));
      } catch (error) {
        setMessage(
          error instanceof ImagePrepError
            ? copy.pageErrors[error.code]
            : copy.primer.galleryFailed,
        );
        // Same rule as the viewfinder's: only an allocation/decode failure is
        // the host's business, and it is recoverable — the picker is still here.
        if (error instanceof ImagePrepError && error.code === "prep") {
          reportError("out_of_memory", true);
        }
      } finally {
        setBusy(false);
      }
    },
    [copy, onCapture, reportError, urls],
  );

  return (
    <AppFrame
      title={copy.primer.title}
      step={1}
      onBack={onBack}
      footer={
        <div className="flex flex-col gap-2 pb-1">
          <Button
            fullWidth
            icon={<CameraIcon size={20} />}
            disabled={busy}
            onClick={onAllow}
          >
            {denied ? copy.primer.ctaAllowDenied : copy.primer.ctaAllow}
          </Button>
          {intake.images && (
            <label className="block">
              <input
                type="file"
                accept={ACCEPT_ATTRIBUTE}
                disabled={busy}
                className="scan-sr-only"
                onChange={(event) => {
                  void handleFile(event);
                }}
              />
              {/* A label, not a button: it wraps the input so the tap opens the
                  picker directly, with no click-forwarding in between. */}
              <span
                className={
                  "inline-flex min-h-cta w-full cursor-pointer items-center justify-center gap-2 " +
                  "rounded-full border-[1.5px] border-moss px-5 text-lg font-semibold " +
                  "leading-tight text-leaf transition-colors duration-200 hover:bg-frost"
                }
              >
                {busy ? <SpinnerIcon size={20} /> : <ImageIcon size={20} />}
                {busy ? copy.primer.preparing : copy.primer.ctaGallery}
              </span>
            </label>
          )}
        </div>
      }
    >
      <div ref={scope} className="flex flex-col gap-4 px-4 py-4">
        <div data-enter className="flex flex-col gap-2">
          <h2 className="font-display text-4xl font-semibold text-ink">
            {denied ? copy.primer.headingDenied : copy.primer.heading}
          </h2>
          <p className="text-base leading-relaxed text-ink-2">
            {denied ? copy.primer.bodyDenied : copy.primer.body}
          </p>
        </div>

        {message !== null && (
          <Notice tone="warning" data-enter>
            {message}
          </Notice>
        )}

        <ol
          data-enter
          className="flex flex-col gap-3 rounded-2xl border border-frost p-4 text-base leading-snug text-ink-2"
        >
          {reasons.map((reason, index) => (
            <li key={index} className="flex gap-3">
              <Meta tone="pine" className="mt-1 shrink-0">
                {String(index + 1).padStart(2, "0")}
              </Meta>
              <span className="min-w-0 flex-1">{reason}</span>
            </li>
          ))}
        </ol>

        {intake.images && (
          <p
            data-enter
            className="rounded-xl bg-cream p-3 text-base leading-snug text-deep"
          >
            {copy.primer.galleryNote}
          </p>
        )}
      </div>
    </AppFrame>
  );
}

export type CameraAccess = "granted" | "prompt" | "denied" | "impossible";

/**
 * What we already know about the camera, without asking for it.
 *
 * Three answers, and each one earns a different screen:
 *
 *  * `granted` — the Permissions API says yes, so the primer would be a screen
 *    explaining a dialog that will never appear. Straight to the viewfinder.
 *  * `impossible` — there is no `mediaDevices` at all, which on a phone means
 *    an insecure origin. Priming for a camera we cannot open would be a lie;
 *    the capture screen's gallery fallback is the honest path.
 *  * `prompt` — a dialog is coming. This is what the primer is for, and it is
 *    also the safe reading for a browser that does not implement
 *    `permissions.query` for cameras (Safari, notably).
 *  * `denied` — the primer still shows, because it is the only screen offering
 *    the gallery, but its copy stops promising a dialog that will not appear.
 *
 * Never throws — a browser that rejects the query is simply `unknown`.
 */
export async function cameraAccessState(): Promise<CameraAccess> {
  if (typeof navigator === "undefined") return "prompt";
  const media: MediaDevices | undefined = navigator.mediaDevices;
  if (media === undefined || typeof media.getUserMedia !== "function") {
    return "impossible";
  }
  const permissions: Permissions | undefined = navigator.permissions;
  if (permissions === undefined || typeof permissions.query !== "function") {
    // Safari, notably. `prompt` is the safe reading: the primer is exactly
    // right if a dialog is coming, and merely redundant if it is not.
    return "prompt";
  }
  try {
    // `camera` is not in the standard `PermissionName` union that TypeScript
    // ships, but it is what every Chromium browser implements.
    const status = await permissions.query({
      name: "camera" as PermissionName,
    });
    if (status.state === "granted") return "granted";
    return status.state === "denied" ? "denied" : "prompt";
  } catch {
    return "prompt";
  }
}
