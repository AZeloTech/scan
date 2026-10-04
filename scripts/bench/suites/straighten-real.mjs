/**
 * `--suite straighten-real`: Endireitar on the labelled real stills of
 * `SCAN_REAL_MEDIA`, with synthetic tilts put into them
 * (`straighten/real-scenes.mjs`). Local only: the stills are decoded in Node
 * on this machine, and the report, results and before/after sheets are
 * written into the cache outside the repository (`paths.mjs`), never
 * committed and never sent anywhere. Labels come from `SCAN_BENCH_LABELS`
 * (or next to the media), exactly as the other real suites read them.
 */

import { labelledStills, runStraighten, straightenConfig } from "../straighten/suite.mjs";
import { REAL_BANNER, runLabels } from "./real-shared.mjs";

function stillsOrThrow() {
  const labels = runLabels();
  const stills = labelledStills(labels.doc);
  if (stills.length === 0) {
    throw new Error(
      `the straighten-real suite needs labelled stills: none of SCAN_REAL_MEDIA's stills has a page label in ${labels.path} (${labels.reason}). ` +
        "Label them with `npm run bench:label`, or point SCAN_BENCH_LABELS at the labels file.",
    );
  }
  return { labels, stills };
}

export function straightenRealSuiteConfig(options) {
  const { labels, stills } = stillsOrThrow();
  return {
    ...straightenConfig("real", options, stills),
    media: options.real.media,
    labels: { path: labels.path, stills: stills.map((s) => s.id) },
  };
}

export function runStraightenRealSuite({ options, outDir, log, config }) {
  const { labels, stills } = stillsOrThrow();
  const banner = `${REAL_BANNER}\n\n- labels: \`${labels.path}\` (${labels.reason}) — ${stills.length} labelled still(s): ${stills.map((s) => `\`${s.id}\``).join(", ")}`;
  return runStraighten({ kind: "real", options, outDir, log, config, stills, banner });
}
