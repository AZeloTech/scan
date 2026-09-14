#!/usr/bin/env bash
# dewarp-rs/build-wasm.sh
#
# Builds and vendors the classical-dewarp wasm asset.
#
# Pipeline (order matters — wasm-bindgen must run on cargo's raw output
# *before* wasm-opt, so wasm-opt shrinks the already-ABI-fixed-up binary):
#
#   1. cargo build --target wasm32-unknown-unknown --release, with
#      RUSTFLAGS='-C target-feature=+simd128' — stable and needing no runtime
#      detection on Chrome/Firefox/Safari>=16.4. If a dependency ever breaks
#      under simd128, this script is meant to be edited to drop the flag and
#      the reason documented at the top of this comment block — nothing does
#      today (verified 2026-08-18, all deps compile clean under
#      wasm32-unknown-unknown+simd128).
#   2. wasm-bindgen --target web. "web" (an ES module consumed directly via
#      `import`/`init()`, fetch+instantiateStreaming-friendly) was chosen
#      over "no-modules" or "bundler" because the dewarp worker is an ES
#      module resolved by the bundler at build time, not a classic worker
#      needing `importScripts` — and because the loader wants
#      `WebAssembly.instantiateStreaming` fed by an explicit,
#      content-addressed URL, not a bundler-inlined wasm module. "web"'s generated
#      `init()` takes an explicit `module_or_path` override for exactly
#      this, and needs no bundler-side `asyncWebAssembly` experiment enabled.
#   3. wasm-opt -Oz --enable-simd (--enable-simd is required or wasm-opt
#      rejects/strips the simd128 instructions the release build emitted).
#   4. Content-address: sha256 the optimized .wasm, name it
#      `dewarp-classical-<sha8>.wasm`. The wasm-bindgen glue's one
#      self-reference to the pre-content-addressed filename
#      (`new URL('dewarp_rs_bg.wasm', import.meta.url)`, wasm-bindgen's
#      default fallback path when `init()` is called with no explicit
#      argument) is rewritten to match, so the shipped glue and the shipped
#      wasm agree on a name even though the real caller is expected to always
#      pass an explicit URL into `init()` and never hit that fallback.
#   5. Vendor both files into the package's `assets/dewarp/` directory (flat),
#      which is what ships inside the published package and is copied into a
#      host application's public directory at install time.
#   6. Emit a manifest (src/lib/dewarp/wasm-manifest.json) that `assets.ts`
#      can read for DEWARP_WASM_VERSION/_SHA256/_URL/_BYTES without
#      hand-copying numbers.
#
# Requires on PATH: cargo (with the wasm32-unknown-unknown target),
# wasm-bindgen (0.2.127, matching Cargo.toml's "0.2" + this repo's Cargo.lock),
# wasm-opt, sha256sum (or shasum -a 256), gzip.
#
# Usage: ./build-wasm.sh   (run from anywhere; paths are script-relative)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

DIST_DIR="$HERE/dist"
PKG_DIR="$HERE/.."
PKG_DEWARP_DIR="$PKG_DIR/assets/dewarp"
MANIFEST_OUT="$PKG_DIR/src/lib/dewarp/wasm-manifest.json"

WASM_BINDGEN_TARGET="web"
WASM_BINDGEN_VERSION="$(wasm-bindgen --version | awk '{print $2}')"

echo "==> 1/6 cargo build (release, wasm32-unknown-unknown, +simd128)"
RUSTFLAGS='-C target-feature=+simd128' cargo build \
  --target wasm32-unknown-unknown --release

RAW_WASM="target/wasm32-unknown-unknown/release/dewarp_rs.wasm"
if [ ! -f "$RAW_WASM" ]; then
  echo "error: build did not produce $RAW_WASM" >&2
  exit 1
fi

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

echo "==> 2/6 wasm-bindgen --target $WASM_BINDGEN_TARGET"
wasm-bindgen "$RAW_WASM" \
  --target "$WASM_BINDGEN_TARGET" \
  --out-dir "$DIST_DIR" \
  --out-name dewarp_rs \
  --no-typescript

BINDGEN_WASM="$DIST_DIR/dewarp_rs_bg.wasm"
BINDGEN_JS="$DIST_DIR/dewarp_rs.js"
if [ ! -f "$BINDGEN_WASM" ] || [ ! -f "$BINDGEN_JS" ]; then
  echo "error: wasm-bindgen did not produce the expected dewarp_rs_bg.wasm / dewarp_rs.js" >&2
  exit 1
fi

echo "==> 3/6 wasm-opt -Oz --enable-simd"
OPT_WASM="$DIST_DIR/dewarp_rs.opt.wasm"
wasm-opt -Oz --enable-simd "$BINDGEN_WASM" -o "$OPT_WASM"

echo "==> 4/6 content-address + rename"
SHA_FULL="$(sha256sum "$OPT_WASM" | cut -d' ' -f1)"
SHA8="${SHA_FULL:0:8}"
VERSION="dewarp-classical-${SHA8}"
FINAL_WASM="$DIST_DIR/${VERSION}.wasm"
FINAL_JS="$DIST_DIR/${VERSION}.js"

cp "$OPT_WASM" "$FINAL_WASM"
cp "$BINDGEN_JS" "$FINAL_JS"
# Rewrite wasm-bindgen's own fallback self-reference so the glue and the
# wasm ship under the same content-addressed name (see comment block above).
sed -i.bak "s/dewarp_rs_bg\.wasm/${VERSION}.wasm/g" "$FINAL_JS"
rm -f "${FINAL_JS}.bak"

RAW_BYTES="$(stat -c%s "$FINAL_WASM" 2>/dev/null || stat -f%z "$FINAL_WASM")"
GZIP_BYTES="$(gzip -c9 "$FINAL_WASM" | wc -c | tr -d ' ')"
GLUE_BYTES="$(stat -c%s "$FINAL_JS" 2>/dev/null || stat -f%z "$FINAL_JS")"

echo "==> 5/6 vendoring into ${PKG_DEWARP_DIR#$HERE/../}/"
mkdir -p "$PKG_DEWARP_DIR"
cp "$FINAL_WASM" "$PKG_DEWARP_DIR/"
cp "$FINAL_JS" "$PKG_DEWARP_DIR/"

echo "==> 6/6 manifest"
mkdir -p "$(dirname "$MANIFEST_OUT")"
cat > "$MANIFEST_OUT" <<EOF
{
  "\$comment": "Generated by dewarp-rs/build-wasm.sh — do not hand-edit. Mirrors assets.ts's MODEL_VERSION/_SHA256/_URL/_BYTES convention for the classical-dewarp wasm asset.",
  "version": "${VERSION}",
  "sha256": "${SHA_FULL}",
  "wasmUrl": "/dewarp/${VERSION}.wasm",
  "gluePath": "/dewarp/${VERSION}.js",
  "wasmBytes": ${RAW_BYTES},
  "wasmGzipBytes": ${GZIP_BYTES},
  "glueBytes": ${GLUE_BYTES},
  "wasmBindgenTarget": "${WASM_BINDGEN_TARGET}",
  "wasmBindgenVersion": "${WASM_BINDGEN_VERSION}",
  "simd128": true,
  "wasmOptFlags": "-Oz --enable-simd"
}
EOF

echo
echo "wasm:     $PKG_DEWARP_DIR/${VERSION}.wasm  (${RAW_BYTES} bytes raw, ${GZIP_BYTES} bytes gzip)"
echo "glue:     $PKG_DEWARP_DIR/${VERSION}.js  (${GLUE_BYTES} bytes)"
echo "manifest: $MANIFEST_OUT"
echo "sha256:   $SHA_FULL"
