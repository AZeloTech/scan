#!/usr/bin/env node
/**
 * `npm run bench:label` — serve the labelling page for the real media in
 * `SCAN_REAL_MEDIA`, print its URL, and stay up until interrupted.
 *
 * Extracts the clips' frames into the cache first if they are not there
 * (`real.mjs`), builds the bench pages from the working tree, and serves them
 * on 127.0.0.1 only. Open the URL in any desktop browser on this machine.
 * Labels are written where `/labels/info` says: next to the media when that
 * is git-ignored there, else the cache — never inside this repository.
 */

import { buildBenchApp, ensureRuntimeAssets } from "../build-app.mjs";
import { prepareRealMedia } from "../real.mjs";
import { startServer } from "../server.mjs";

async function main() {
  const prepared = prepareRealMedia();
  ensureRuntimeAssets({ styles: true });
  await buildBenchApp();
  const server = await startServer({ log: (line) => console.log(line) });
  const frames = prepared.clips.reduce((sum, clip) => sum + clip.sparse.frames, 0);
  console.log(`\nlabelling: ${prepared.stills.length} stills + ${frames} video frames from ${prepared.media}`);
  console.log(`labels → ${server.labels.path}\n         (${server.labels.reason})`);
  console.log(`\n  open  ${server.url}/page-label.html\n\n(loopback only; Ctrl-C to stop)`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error(`bench:label: ${error?.message ?? error}`);
  process.exit(2);
});
