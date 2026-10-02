/**
 * `--suite straighten`: Endireitar on synthetic scenes with known truth —
 * the page the user would see after the tap, judged against the flat page of
 * the confirmed outline. Runs in Node (`straighten/suite.mjs` says why);
 * output goes to the git-ignored `.bench-out/`.
 */

import { runStraighten, straightenConfig } from "../straighten/suite.mjs";

export function straightenSuiteConfig(options) {
  return straightenConfig("synthetic", options);
}

export function runStraightenSuite({ options, outDir, log, config }) {
  return runStraighten({ kind: "synthetic", options, outDir, log, config });
}
