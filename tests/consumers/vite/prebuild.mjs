// Hosts copy the library's assets into whatever they serve. Both consumers do
// it the documented way, so the documented way is what gets tested.
import { execFileSync } from "node:child_process";
execFileSync("node", ["../../../scripts/copy-assets.mjs", "public"], { stdio: "inherit" });
