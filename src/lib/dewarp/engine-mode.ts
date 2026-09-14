/**
 * Which geometry producer this library ships. There is exactly one.
 *
 * The classical (Rust/WASM) engine is the only curved-page producer: the
 * UVDoc ONNX path — its 16 MB model, its own ONNX Runtime
 * build and the `NEXT_PUBLIC_DEWARP_ENGINE` build arg that used to choose
 * between them — is gone. What is left is a build-time constant, kept as a
 * *function* on purpose: three surfaces already ask this question
 * (`index.ts::Engine`, `prefetch.ts` for asset choice, `i18n.ts` for the
 * consent-copy size), and they must keep getting their answer without dragging
 * the lazily-loaded engine's ~25 kB of pure maths into the eager bundle
 * (`dewarp-stage.ts::loadEngine`'s whole point).
 */

/**
 * The one geometry a caller can select.
 *
 * `types.ts`'s `GeometryMode` additionally has `"homography"` — what a
 * *fallback* returns, never something a caller selects — which is why this
 * stays its own narrower type rather than a re-export.
 */
export type DewarpEngineMode = "classical";

/**
 * The producer a caller gets when it does not name one — always the classical
 * engine, in every build. No environment is read: the export is static
 * (`output: "export"`), so an engine choice could only ever have been inlined
 * at build time, and with one engine there is nothing left to inline.
 */
export function resolveGeometryMode(): DewarpEngineMode {
  return "classical";
}

/**
 * Whether this build draws two curvatura controls side by side.
 *
 * Permanently `false` — the side-by-side compare existed to hold the two
 * engines against each other and there is only one now. Retained (rather than
 * deleted) so the page view keeps compiling while its own two-tile branch is
 * removed; it is dead the moment that lands.
 */
export function dewarpAbCompare(): boolean {
  return false;
}
