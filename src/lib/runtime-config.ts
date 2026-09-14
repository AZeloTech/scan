/**
 * Where this library's runtime files live, and how each consumer is told.
 *
 * The scanner needs four kinds of file at runtime: the dewarp WebAssembly, the
 * corner-detection model, the ONNX Runtime pair, and (only if the host enables
 * PDF import) the pdf.js runtime. None of them can ride a bundler's asset
 * pipeline, because each is located by a *string base* inside third-party code
 * we do not control: ORT appends fixed file names to `wasmPaths`, pdf.js appends
 * font and character-map names to its own URL options. A library cannot rewrite
 * its consumer's emitted asset names, so the host copies the files somewhere it
 * serves and tells us where with one string.
 *
 * Everything in this module derives from that one string. Nothing here fetches:
 * these are URLs, and the modules that need them do the loading.
 */

/** Absolute, with a trailing slash, so `new URL(name, base)` behaves. */
function normalise(assetBaseUrl: string): string {
  const withSlash = assetBaseUrl.endsWith("/") ? assetBaseUrl : `${assetBaseUrl}/`;
  if (typeof location === "undefined") return withSlash;
  return new URL(withSlash, location.href).href;
}

export interface AssetUrls {
  /** `<base>/` — absolute, trailing slash. */
  readonly base: string;
  readonly dewarpWasm: string;
  readonly dewarpGlue: string;
  /** The directory the ONNX Runtime pair and the model share. Trailing slash. */
  readonly mlBase: string;
  readonly model: string;
  /** The directory pdf.js worker, cmaps, fonts and wasm live under. Trailing slash. */
  readonly pdfjsBase: string;
  readonly pdfWorker: string;
  /**
   * This library's own Web Workers, pre-bundled and served from the host's
   * asset directory like everything else here.
   *
   * They are NOT loaded through `new Worker(new URL("./x.worker.ts",
   * import.meta.url))`. That form is a bundler instruction, and it only works
   * when the bundler compiling it is the one emitting the page: inside a
   * published library the specifier survives into the output pointing at a
   * TypeScript file that does not exist, and the consumer's build fails — or
   * worse, resolves to nothing at run time. Serving them as assets makes the
   * worker a file rather than a promise about somebody else's build.
   */
  readonly renderWorker: string;
  readonly dewarpWorker: string;
  /**
   * scanic, pre-bundled with its ML detector and ONNX Runtime wrapper.
   *
   * Loaded with a runtime `import()` of this URL rather than a static import,
   * so the chain never reaches a consumer's bundler. See `scanic-entry.ts`.
   */
  readonly scanic: string;
}

/**
 * The dewarp engine's WebAssembly is content-addressed: the first eight hex
 * characters of its sha256 are in the file name, so a rebuild is a different URL
 * rather than a stale blob in somebody's phone. These two constants are mirrored
 * by hand from `dewarp-rs/build-wasm.sh`'s manifest; `assets.ts` holds the
 * sha256 and byte counts that go with them.
 */
export const DEWARP_WASM_VERSION = "dewarp-classical-2ae72e6f";

export function assetUrls(assetBaseUrl: string): AssetUrls {
  const base = normalise(assetBaseUrl);
  const mlBase = `${base}scanic-ml/`;
  const pdfjsBase = `${base}pdfjs/`;
  return {
    base,
    dewarpWasm: `${base}dewarp/${DEWARP_WASM_VERSION}.wasm`,
    dewarpGlue: `${base}dewarp/${DEWARP_WASM_VERSION}.js`,
    mlBase,
    model: `${mlBase}doccornernet_lean.ort`,
    pdfjsBase,
    pdfWorker: `${pdfjsBase}pdf.worker.min.mjs`,
    renderWorker: `${base}workers/render.worker.js`,
    dewarpWorker: `${base}workers/dewarp-classical.worker.js`,
    scanic: `${base}scanic/scanic-entry.js`,
  };
}

/**
 * The options scanic needs to find its ML corner detector on our origin.
 *
 * `numThreads: 1` is a decision, not a default. Threads need SharedArrayBuffer,
 * which needs a cross-origin-isolated page; neither consumer sets COOP/COEP, and
 * a static export cannot set headers at all. Asking for threads there buys a
 * bigger set-up for nothing, and pushes ORT onto a blob-worker path that would
 * be a fourth thing to serve.
 *
 * `modelUrl` and `wasmPaths` are redundant with `assetBaseUrl` today. They are
 * stated anyway so that a scanic upgrade which renames either default fails
 * loudly here rather than quietly reaching for a CDN.
 */
export function mlDetectorOptions(urls: AssetUrls, minScore = 0.5) {
  return {
    assetBaseUrl: urls.mlBase,
    modelUrl: urls.model,
    wasmPaths: urls.mlBase,
    numThreads: 1,
    proxy: false,
    minScore,
    modelFetchTimeoutMs: 30_000,
  } as const;
}

/**
 * The URL options pdf.js needs. pdf.js picks which font and character map it
 * wants at runtime from the document itself, so these are directories, and the
 * whole directories ship.
 */
export function pdfjsOptions(urls: AssetUrls) {
  return {
    cMapUrl: `${urls.pdfjsBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${urls.pdfjsBase}standard_fonts/`,
    iccUrl: `${urls.pdfjsBase}iccs/`,
    wasmUrl: `${urls.pdfjsBase}wasm/`,
  } as const;
}

/**
 * A base URL that cannot work, caught before it produces a confusing 404.
 *
 * Returns a sentence to show a developer, or null when the value is fine. This
 * is a developer-facing check: it never reaches a person using the scanner.
 */
export function explainBadAssetBaseUrl(assetBaseUrl: unknown): string | null {
  if (typeof assetBaseUrl !== "string" || assetBaseUrl.trim() === "") {
    return (
      "assetBaseUrl is required. Run `npx scan-copy-assets <your public dir>` and " +
      'pass the path it prints, for example assetBaseUrl="/scan-assets".'
    );
  }
  if (/^https?:\/\//i.test(assetBaseUrl) && typeof location !== "undefined") {
    const target = new URL(assetBaseUrl);
    if (target.origin !== location.origin) {
      return (
        `assetBaseUrl points at ${target.origin}, which is not this page's origin. ` +
        "This library never fetches across origins: copy the assets into something " +
        "you serve yourself."
      );
    }
  }
  return null;
}
