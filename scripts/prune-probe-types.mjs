#!/usr/bin/env node
// Runs after `tsc -p tsconfig.build.json` (`npm run build:types`).
//
// tsc declares every module its program reaches, and src/lib/probe.ts imports
// src/lib/probe-hook.ts — the bench probe's hook, which the published
// JavaScript never contains (the build switch drops it: scripts/probe-switch.mjs).
// Its declarations go too, so the module is not in dist/ in any form.
// Nothing else declares against it; scripts/check-dist.mjs refuses a dist/
// where it is back.

import { rmSync } from "node:fs";
import { join } from "node:path";

const DIST = join(process.cwd(), "dist");

for (const file of ["lib/probe-hook.d.ts", "lib/probe-hook.d.ts.map"]) {
  rmSync(join(DIST, file), { force: true });
}
