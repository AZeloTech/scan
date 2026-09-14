/**
 * The bundle entry for scanic, built once into `assets/scanic/`.
 *
 * Not imported by anything in `src/`: this file exists so the build can produce
 * a self-contained copy of scanic — its classical detector, its ML detector and
 * the ONNX Runtime wrapper — as plain files under the host's asset directory.
 *
 * Why scanic cannot travel inside the library's own bundle: the ONNX Runtime
 * locates its own WebAssembly with `new URL("ort.wasm.min.mjs",
 * import.meta.url)`, and webpack reads that as an asset reference it must
 * resolve at build time. Inside a consumer's build it resolves against a
 * hashed chunk in that consumer's output, where the file is not, and the build
 * fails. Vite's library mode has the mirror-image problem. Serving the whole
 * chain as files sidesteps every bundler: the siblings sit next to each other,
 * exactly as their own relative imports expect.
 */

export * from "scanic";
