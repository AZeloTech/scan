// Build-time PostCSS plugin. Runs after Tailwind, before the file is written.
//
// Tailwind's `important: ".scan-root"` scopes every utility, and preflight is
// off, but Tailwind 3 still emits its variable defaults at the top of the file
// unscoped:
//
//   *, ::before, ::after { --tw-translate-x: 0; … }
//   ::backdrop           { --tw-translate-x: 0; … }
//
// Only custom properties, but on *every element of the host's page* — and a
// host that runs Tailwind of its own gets its defaults overwritten by ours, in
// whatever order the two stylesheets happened to load. This rewrites those two
// selectors under `.scan-root`. The dist guard (`scripts/check-dist.mjs`) then
// refuses any selector that still escapes the root.

const ROOT = ".scan-root";

/** Tailwind's own spellings of the two rules, before minification. */
const REWRITES = new Map([
  ["*, ::before, ::after", `${ROOT}, ${ROOT} *, ${ROOT} ::before, ${ROOT} ::after`],
  ["::backdrop", `${ROOT} ::backdrop`],
]);

function normalize(selector) {
  return selector.split(",").map((part) => part.trim()).join(", ");
}

export default function scopeRoot() {
  return {
    postcssPlugin: "scan-scope-root",
    Rule(rule) {
      const next = REWRITES.get(normalize(rule.selector));
      if (next !== undefined) rule.selector = next;
    },
  };
}
scopeRoot.postcss = true;
