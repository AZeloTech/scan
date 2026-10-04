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
 * Returns a release. The warm worker is kept while anything holds it (this
 * call, or a mounted `<ScanFlow>`), and for about a minute after the last
 * release, then its memory is given back. Call the release when the host's
 * sheet closes without scanning; calling it twice is harmless.
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
  return holdDetectLane(assetUrls(options.assetBaseUrl));
}
