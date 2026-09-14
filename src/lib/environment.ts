"use client";

/**
 * The one question the desktop mode turns on: **is this a computer?**
 *
 * The question used to be narrower — a computer with *no camera* — on the
 * reasoning that a webcam can still take the photo and the capture
 * experience is the product. Field use answered that differently:
 * almost every laptop has a webcam, nobody lifts a laptop over a sheet of paper,
 * and the machine's scans are already in its filesystem. So the camera stopped
 * being part of the question. Any fine-pointer desktop gets the desktop mode,
 * webcam or not; what is left to decide is only which machines are *not*
 * desktops.
 *
 * Three signals, all synchronous, all read from the browser at mount — there is
 * no build arg to distinguish desktop from mobile in this library and there
 * must not be one: it is client-only and learns the device at run time, never
 * at build time. Dropping `enumerateDevices()`
 * dropped the last asynchronous step, so the answer is now available in the same
 * tick the screen renders in.
 *
 *  * `(pointer: fine)` is this library's stand-in for "something other than
 *    a finger drives this" (`CaptureStage`'s `pickerOnly` asks the coarse half
 *    of it). It excludes phones, Android tablets and an iPad in its normal mode
 *    on its own.
 *  * **The iPadOS desktop-site masquerade** is the one device that lies here: an
 *    iPad requesting the desktop site reports a Mac user agent *and* a fine
 *    pointer. It gives itself away with `maxTouchPoints`, which a real Mac
 *    reports as `0` and a touch iPad reports as `5`. The pair is what
 *    identifies it — Mac-ish **and** touch — because either half alone
 *    misfires: a Windows or ChromeOS laptop with a touch screen also reports
 *    `maxTouchPoints > 1` and is a desktop, and a bare touch-point count would
 *    send it to the phone flow.
 *  * **An `Android` user agent** is belt and braces for the same class of
 *    device: a tablet or a DeX session that reports a fine pointer while it is
 *    still, in every way the user cares about, the mobile flow's machine.
 *
 * Every failure answers **false**. A browser without `matchMedia`, a
 * `matchMedia` that throws, a missing `navigator` — all of them fall through to
 * the phone flow, which works on every device this app has ever run on. The
 * desktop mode is an improvement offered where it is certain, never a gate
 * placed in front of the product.
 *
 * Both sides of the fork read this one predicate, and there is no route in it:
 * the library picks the desktop or the phone flow as component state when it
 * mounts. There are no URLs to disagree with each other, so the redirect loop
 * the two-predicate version could produce cannot exist here.
 */
export function isDesktopSurface(): boolean {
  try {
    if (!hasFinePointer()) return false;
    if (isTouchMac()) return false;
    if (isAndroid()) return false;
    return true;
  } catch {
    return false;
  }
}

/** The primary pointer is not a finger. False whenever we cannot tell. */
function hasFinePointer(): boolean {
  if (typeof window === "undefined") return false;
  const query: unknown = window.matchMedia;
  if (typeof query !== "function") return false;
  return window.matchMedia("(pointer: fine)").matches;
}

/**
 * An iPad pretending to be a Mac.
 *
 * A real Mac has no touch screen and reports `maxTouchPoints === 0`, so the
 * conjunction is safe in the direction that matters: no Mac is ever excluded by
 * it, and no touch laptop is excluded either, because it is not Mac-ish.
 */
function isTouchMac(): boolean {
  const agent = userAgent();
  const platform = navigatorPlatform();
  const macish = agent.includes("Mac") || platform === "MacIntel";
  return macish && touchPoints() > 1;
}

/** A tablet or a DeX session that talks itself into a fine pointer. */
function isAndroid(): boolean {
  return userAgent().includes("Android");
}

function userAgent(): string {
  if (typeof navigator === "undefined") return "";
  const agent: unknown = navigator.userAgent;
  return typeof agent === "string" ? agent : "";
}

function navigatorPlatform(): string {
  if (typeof navigator === "undefined") return "";
  // `navigator.platform` is deprecated and typed as always-present; a browser
  // that has withdrawn it hands back `undefined` at runtime regardless.
  const platform: unknown = navigator.platform;
  return typeof platform === "string" ? platform : "";
}

function touchPoints(): number {
  if (typeof navigator === "undefined") return 0;
  const points: unknown = navigator.maxTouchPoints;
  return typeof points === "number" ? points : 0;
}
