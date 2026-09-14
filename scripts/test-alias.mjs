/**
 * Teaches `node --test` the `@/…` alias the app itself is written in.
 *
 * The suite runs on bare Node (no bundler, no jsdom) because the things worth
 * testing here — revision bookkeeping, supersede rules, the export transaction,
 * the words a verdict is allowed to use — are all DOM-free by design. Node
 * resolves specifiers itself, though, and knows nothing about `tsconfig`
 * paths, so without this hook importing the store would fail on its first
 * `@/lib/...` line and the only testable modules would be the leaves.
 *
 * Registered through `--import` in the `test` script; it does nothing to the
 * app's own build, which resolves the same alias through `tsconfig.json`.
 */

import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = pathToFileURL(path.join(process.cwd(), "src", "/")).href;

registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("@/")) return next(specifier, context);
    return next(new URL(`${specifier.slice(2)}.ts`, source).href, context);
  },
});
