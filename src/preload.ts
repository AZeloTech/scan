/**
 * Warm the scanner before it is on screen.
 *
 * The first thing a scan needs is the corner-detection model (~3.4 MB) and its
 * runtime, compiled in the detection worker. `<ScanFlow>` starts that as its
 * viewfinder mounts, which is early enough on a fast connection and a second
 * or two of the classical fallback on a slow one. A host that knows a scan is
 * coming — the person tapped the button that opens the sheet — can start it a
 * beat sooner with this.
 *
 * Returns a release, and **the host must call it when its sheet closes — in
 * every case**: after a finished scan, after a cancel, after an error, and
 * when the sheet closes without the flow ever mounting. A mounted
 * `<ScanFlow>` holds the worker on its own while it is on screen, so
 * releasing as soon as the flow has mounted is also fine; never releasing is
 * not — the worker (and the ~30 MB its runtime holds) then stays for the
 * page's life. Once nothing holds it, the warm worker is kept for about a
 * minute, so a sheet opened again soon after starts warm, and then its memory
 * is given back.
 *
 * Each release counts once: calling the same release twice (a close handler
 * and an unmount cleanup both firing) is harmless, and can never release a
 * hold that somebody else — another `preloadScanAssets` call, or a mounted
 * flow — still has.
 *
 * Fetches nothing but this library's own files under `assetBaseUrl`, and does
 * nothing at all until called — importing it has no side effects.
 */

import { assetUrls } from "@/lib/runtime-config";
import { holdDetectLane } from "@/lib/detect-lane";

export interface PreloadScanAssetsOptions {
  /** The same value you pass to `<ScanFlow assetBaseUrl>`. */
  assetBaseUrl: string;
}

export function preloadScanAssets(options: PreloadScanAssetsOptions): () => void {
  if (typeof window === "undefined") return () => undefined;
  const release = holdDetectLane(assetUrls(options.assetBaseUrl));
  let released = false;
  // Idempotent here as well as in the lane: this function is the public
  // promise, and it must hold whatever the lane's internals become.
  return () => {
    if (released) return;
    released = true;
    release();
  };
}
