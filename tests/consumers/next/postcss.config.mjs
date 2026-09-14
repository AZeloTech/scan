/**
 * Empty on purpose.
 *
 * This consumer lives inside the library's own repository, so without a config
 * of its own Next walks up the tree and finds the library's PostCSS setup —
 * which exists to compile Tailwind into `dist/styles.css` at build time and has
 * no business running again here. A real host would never see it: the published
 * package ships plain CSS.
 */
export default { plugins: [] };
