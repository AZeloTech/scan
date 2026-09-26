/**
 * The bench's suites, by the name `--suite` takes.
 *
 * `synthetic` decides where a suite's output may go: synthetic results into
 * the repo's git-ignored `.bench-out/`, real ones only into the cache outside
 * the repository. A suite that is not built yet says so instead of pretending.
 * Real suites (`synthetic: false`) need `SCAN_REAL_MEDIA`.
 * `--suite all` runs every suite marked `inAll`; the emulator's self-check is
 * run by name.
 */

import { runDetectorSuite } from "./detector.mjs";
import { runEmulatorSuite } from "./emulator.mjs";
import { runRealStillsSuite } from "./real-stills.mjs";
import { runRealVideoSuite } from "./real-video.mjs";
import { runSessionSuite } from "./session.mjs";

export const SUITES = {
  detector: { synthetic: true, run: runDetectorSuite, implemented: true, inAll: true },
  session: { synthetic: true, run: runSessionSuite, implemented: true, inAll: true },
  // Real media: only with SCAN_REAL_MEDIA set; `all` skips them without it.
  "real-stills": { synthetic: false, run: runRealStillsSuite, implemented: true, inAll: true },
  "real-video": { synthetic: false, run: runRealVideoSuite, implemented: true, inAll: true },
  emulator: { synthetic: true, run: runEmulatorSuite, implemented: true, inAll: false },
};
