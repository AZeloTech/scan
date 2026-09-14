// Build-time only. Nothing here reaches a consumer: the output is plain CSS.
import scopeRoot from "./scripts/postcss-scope-root.mjs";

export default {
  plugins: [
    (await import("tailwindcss")).default(),
    // After Tailwind: its variable defaults are emitted unscoped. See the plugin.
    scopeRoot(),
    (await import("autoprefixer")).default(),
  ],
};
