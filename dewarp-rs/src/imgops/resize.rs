//! Resize — hand-rolled, because `imageproc` has no `INTER_AREA`
//! equivalent. Two call sites in the ported pipeline:
//!
//! - S0 (`dewarp.py:669`): the color proc-resolution resize —
//!   `INTER_AREA` when downscaling (`ratio < 1`), `INTER_CUBIC` when
//!   upscaling. **This is the very first pipeline stage and feeds
//!   everything downstream** — get it exact or nothing else is
//!   trustworthy.
//! - `_render`'s inverse-map upsample (`dewarp.py:569-570`): `INTER_LINEAR`
//!   only, applied to the two `f32` coordinate planes (`map_x`/`map_y`),
//!   129(default)→output-resolution.
//!
//! The **TS-side** pre-downsample (for crops over
//! `WASM_INPUT_MAX_SIDE=1600`) must also be area-average-equivalent — that
//! resize happens in TypeScript, not here, but this module's `Algo::Area`
//! is the Rust-side algorithm to compare it against for the *internal* S0
//! stage.
//!
//! ## Parity notes (verified against opencv-python-headless 5.0.0 — see
//! this module's tests)
//!
//! - **`Algo::Area`** and **`Algo::Cubic`** on `u8` images are the two
//!   `Algo` variants the ported pipeline actually exercises (S0,
//!   `dewarp.py:669`): a separable, double-precision fractional-area-weight
//!   computation (`Area`) or a separable double-precision 4-tap cubic
//!   convolution with `a = -0.75` (`Cubic`), both using half-pixel-center
//!   sampling, `BORDER_REPLICATE` clamped taps, and a **single** final
//!   round-half-to-even (`f64::round_ties_even`, **not** `f64::round`,
//!   which is round-half-*away-from-zero* — see the `round_half_even_u8`
//!   helper below) to `u8` — this is the only rounding step, no
//!   intermediate `f32`/`u8` truncation. Verified against ground truth
//!   generated from a throwaway opencv-python-headless docker rig
//!   (opencv-python-headless 5.0.0 / numpy 2.5.1, matching
//!   `parity/reference/pyproject.toml`'s pin):
//!   - `Area`: **pixel-exact** on every hand-built synthetic fixture (this
//!     module's own tests) *and* on a real 400×300→187×141 photographic
//!     downscale — 0 differing pixels.
//!   - `Cubic`: pixel-exact on the small synthetic fixture, but **not**
//!     quite pixel-exact on a real 400×300→511×383 photographic upscale — 1
//!     pixel of 195,713 differs by 1 LSB. Root cause traced: this crate's
//!     unquantized double-precision cubic formula computes that pixel a
//!     hair above the `x.5` rounding boundary, `159.50000381094026`, while
//!     `cv2`'s actual `u8` fast path
//!     — fixed-point, `INTER_RESIZE_COEF_BITS=11`-quantized coefficients,
//!     same mechanism as `Linear`/`Lanczos` below — lands a hair on the
//!     other side for this specific pixel. So the honest bound for the
//!     `ratio>=1`/`Cubic` branch is `<=1` LSB on a small handful of pixels,
//!     not bit-exactness — empirically the achievable bound for an
//!     unquantized double-precision port. Revisit if bit-exactness on this
//!     branch turns out to matter downstream.
//! - **`Algo::Linear`** on `u8` images and **`Algo::Lanczos`** are
//!   implemented per the standard formulas (half-pixel-center bilinear /
//!   8-tap windowed-sinc Lanczos-4, `BORDER_REPLICATE`) but are **not**
//!   bit-exact with `cv2.resize`'s `u8` fast path, which uses a fixed-point
//!   (`INTER_RESIZE_COEF_BITS=11`, 1/2048-quantized) coefficient table for
//!   8-bit images — confirmed empirically (off-by-one-LSB on a handful of
//!   pixels per test image). Neither variant is exercised by the ported
//!   pipeline on `u8` data (`Linear` is only ever used on the `f32` map
//!   planes below, where OpenCV takes the float path and this module's
//!   [`resize_f32_linear`] **is** verified bit-exact; `Lanczos` is
//!   `"high"`-preset-only, which nothing ships today). Revisit the
//!   fixed-point table if `u8` `Linear`/`Lanczos` parity is ever needed.

use image::{GrayImage, RgbImage, RgbaImage};

/// OpenCV interpolation flags this crate needs (a strict subset of
/// `cv2.INTER_*` — see the module doc comment for which call site uses
/// which).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algo {
    /// Fractional-area-weighted box average (`cv2.INTER_AREA`). **Not** a
    /// naive block mean — OpenCV computes exact per-pixel fractional-area
    /// contribution weights. Downscale only.
    Area,
    /// Bilinear.
    Linear,
    /// 4×4 Catmull-Rom-like cubic convolution, `a = -0.75` (OpenCV's own
    /// coefficient).
    Cubic,
    /// 8×8 sinc-windowed Lanczos (`options.py`'s `"high"` preset only).
    Lanczos,
}

/// `cv2`'s `saturate_cast<uchar>` rounding for a nonnegative `f64` in
/// `[0, 255]`-ish range: round-half-**to-even**, not round-half-away-from-
/// zero. Confirmed empirically against `cv2.resize(..., INTER_AREA)` output
/// (see `tests::` below) — OpenCV's `cvRound` uses the CPU's default
/// IEEE-754 rounding mode (round-to-nearest-even), not `(x + 0.5).floor()`.
/// `f64::round_ties_even` is stable since Rust 1.77 (this crate's toolchain,
/// see `rust-toolchain.toml`).
fn round_half_even_u8(v: f64) -> u8 {
    v.round_ties_even().clamp(0.0, 255.0) as u8
}

fn clamp_index(i: i64, len: u32) -> usize {
    i.clamp(0, len as i64 - 1) as usize
}

/// Per-destination-index fractional-area overlap weights for one axis:
/// `weights[dst][k] = (src_index, weight)`, weights for a given `dst`
/// summing to `1.0`. `cv2.INTER_AREA`'s decimation table — exact per-pixel
/// fractional-area contribution weights, not a block mean.
fn area_weights(src_len: u32, dst_len: u32) -> Vec<Vec<(usize, f64)>> {
    let scale = src_len as f64 / dst_len as f64;
    let mut out = Vec::with_capacity(dst_len as usize);
    for d in 0..dst_len {
        let lo = d as f64 * scale;
        let hi = (d as f64 + 1.0) * scale;
        let i0 = lo.floor() as i64;
        let i1 = hi.ceil() as i64;
        let mut row = Vec::new();
        for i in i0..i1.min(src_len as i64) {
            if i < 0 {
                continue;
            }
            let overlap_lo = lo.max(i as f64);
            let overlap_hi = hi.min(i as f64 + 1.0);
            let w = (overlap_hi - overlap_lo).max(0.0);
            if w > 0.0 {
                row.push((i as usize, w / scale));
            }
        }
        out.push(row);
    }
    out
}

/// Separable fractional-area resize of one `channels`-interleaved `u8`
/// plane. `src`/returned buffer are row-major, `channels`-interleaved
/// (`channels=1` gray, `3` RGB, `4` RGBA).
fn resize_area_u8(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    channels: usize,
) -> Vec<u8> {
    let wx = area_weights(src_w, dst_w);
    let wy = area_weights(src_h, dst_h);
    // Horizontal pass: (src_h x dst_w x channels) f64 intermediate.
    let mut inter = vec![0.0f64; src_h as usize * dst_w as usize * channels];
    for y in 0..src_h as usize {
        for (dx, taps) in wx.iter().enumerate() {
            for &(sx, w) in taps {
                let src_off = (y * src_w as usize + sx) * channels;
                let dst_off = (y * dst_w as usize + dx) * channels;
                for c in 0..channels {
                    inter[dst_off + c] += w * src[src_off + c] as f64;
                }
            }
        }
    }
    // Vertical pass: (dst_h x dst_w x channels), rounded to u8 once here.
    let mut out = vec![0.0f64; dst_h as usize * dst_w as usize * channels];
    for (dy, taps) in wy.iter().enumerate() {
        for &(sy, w) in taps {
            for x in 0..dst_w as usize {
                let src_off = (sy * dst_w as usize + x) * channels;
                let dst_off = (dy * dst_w as usize + x) * channels;
                for c in 0..channels {
                    out[dst_off + c] += w * inter[src_off + c];
                }
            }
        }
    }
    out.into_iter().map(round_half_even_u8).collect()
}

/// OpenCV's cubic convolution weight, `a = -0.75`. `x` is the
/// (signed) distance from the tap to the sample point, in source-pixel
/// units.
fn cubic_weight(x: f64) -> f64 {
    const A: f64 = -0.75;
    let x = x.abs();
    if x <= 1.0 {
        (A + 2.0) * x * x * x - (A + 3.0) * x * x + 1.0
    } else if x < 2.0 {
        A * x * x * x - 5.0 * A * x * x + 8.0 * A * x - 4.0 * A
    } else {
        0.0
    }
}

/// 4-tap weights (unnormalized — cubic convolution weights already sum to 1
/// by construction for any fractional offset in `[0,1)`) for a fractional
/// offset `frac` (the position within the `[i0, i0+1)` source interval),
/// taps at source indices `i0-1, i0, i0+1, i0+2`.
fn cubic_taps(frac: f64) -> [f64; 4] {
    [
        cubic_weight(frac + 1.0),
        cubic_weight(frac),
        cubic_weight(frac - 1.0),
        cubic_weight(frac - 2.0),
    ]
}

fn resize_cubic_u8(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    channels: usize,
) -> Vec<u8> {
    let scale_x = src_w as f64 / dst_w as f64;
    let scale_y = src_h as f64 / dst_h as f64;
    let mut out = vec![0.0f64; dst_h as usize * dst_w as usize * channels];
    // Precompute per-destination-column taps + clamped source columns.
    let mut col_taps: Vec<([f64; 4], [usize; 4])> = Vec::with_capacity(dst_w as usize);
    for dx in 0..dst_w {
        let fx = (dx as f64 + 0.5) * scale_x - 0.5;
        let x0 = fx.floor() as i64;
        let taps = cubic_taps(fx - x0 as f64);
        let idx = [
            clamp_index(x0 - 1, src_w),
            clamp_index(x0, src_w),
            clamp_index(x0 + 1, src_w),
            clamp_index(x0 + 2, src_w),
        ];
        col_taps.push((taps, idx));
    }
    for dy in 0..dst_h {
        let fy = (dy as f64 + 0.5) * scale_y - 0.5;
        let y0 = fy.floor() as i64;
        let wy = cubic_taps(fy - y0 as f64);
        let rows = [
            clamp_index(y0 - 1, src_h),
            clamp_index(y0, src_h),
            clamp_index(y0 + 1, src_h),
            clamp_index(y0 + 2, src_h),
        ];
        for dx in 0..dst_w as usize {
            let (wx, cols) = &col_taps[dx];
            let dst_off = (dy as usize * dst_w as usize + dx) * channels;
            for c in 0..channels {
                let mut acc = 0.0f64;
                for j in 0..4 {
                    let row_off = rows[j] * src_w as usize;
                    let mut row_acc = 0.0f64;
                    for i in 0..4 {
                        row_acc += wx[i] * src[(row_off + cols[i]) * channels + c] as f64;
                    }
                    acc += wy[j] * row_acc;
                }
                out[dst_off + c] = acc;
            }
        }
    }
    out.into_iter().map(round_half_even_u8).collect()
}

/// Half-pixel-center bilinear, `BORDER_REPLICATE`. Used for `Algo::Linear`
/// on `u8` planes (not bit-exact with `cv2`'s fixed-point `u8` fast path —
/// see the module doc comment) and shares its core formula with
/// [`resize_f32_linear`] (which *is* bit-exact, since `cv2` takes the float
/// path for `f32` sources).
fn resize_linear_u8(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    channels: usize,
) -> Vec<u8> {
    let scale_x = src_w as f64 / dst_w as f64;
    let scale_y = src_h as f64 / dst_h as f64;
    let mut out = vec![0.0f64; dst_h as usize * dst_w as usize * channels];
    for dy in 0..dst_h {
        let fy = (dy as f64 + 0.5) * scale_y - 0.5;
        let y0 = fy.floor() as i64;
        let wy = fy - y0 as f64;
        let y0c = clamp_index(y0, src_h);
        let y1c = clamp_index(y0 + 1, src_h);
        for dx in 0..dst_w {
            let fx = (dx as f64 + 0.5) * scale_x - 0.5;
            let x0 = fx.floor() as i64;
            let wx = fx - x0 as f64;
            let x0c = clamp_index(x0, src_w);
            let x1c = clamp_index(x0 + 1, src_w);
            let dst_off = (dy as usize * dst_w as usize + dx as usize) * channels;
            for c in 0..channels {
                let v00 = src[(y0c * src_w as usize + x0c) * channels + c] as f64;
                let v01 = src[(y0c * src_w as usize + x1c) * channels + c] as f64;
                let v10 = src[(y1c * src_w as usize + x0c) * channels + c] as f64;
                let v11 = src[(y1c * src_w as usize + x1c) * channels + c] as f64;
                let top = v00 * (1.0 - wx) + v01 * wx;
                let bot = v10 * (1.0 - wx) + v11 * wx;
                out[dst_off + c] = top * (1.0 - wy) + bot * wy;
            }
        }
    }
    out.into_iter().map(round_half_even_u8).collect()
}

/// `sinc(x) * sinc(x/4)` windowed to `|x| < 4` — OpenCV's `INTER_LANCZOS4`
/// kernel: an 8×8 sinc-windowed Lanczos.
fn lanczos4_weight(x: f64) -> f64 {
    const A: f64 = 4.0;
    let x = x.abs();
    if x >= A {
        return 0.0;
    }
    fn sinc(x: f64) -> f64 {
        if x == 0.0 {
            1.0
        } else {
            (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
        }
    }
    sinc(x) * sinc(x / A)
}

fn lanczos_taps(frac: f64) -> [f64; 8] {
    let mut t = [0.0; 8];
    for (k, item) in t.iter_mut().enumerate() {
        *item = lanczos4_weight(frac - (k as f64 - 3.0));
    }
    t
}

fn resize_lanczos_u8(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    channels: usize,
) -> Vec<u8> {
    let scale_x = src_w as f64 / dst_w as f64;
    let scale_y = src_h as f64 / dst_h as f64;
    let mut out = vec![0.0f64; dst_h as usize * dst_w as usize * channels];
    let mut col_taps: Vec<([f64; 8], [usize; 8])> = Vec::with_capacity(dst_w as usize);
    for dx in 0..dst_w {
        let fx = (dx as f64 + 0.5) * scale_x - 0.5;
        let x0 = fx.floor() as i64;
        let taps = lanczos_taps(fx - x0 as f64);
        let mut idx = [0usize; 8];
        for (k, item) in idx.iter_mut().enumerate() {
            *item = clamp_index(x0 - 3 + k as i64, src_w);
        }
        col_taps.push((taps, idx));
    }
    for dy in 0..dst_h {
        let fy = (dy as f64 + 0.5) * scale_y - 0.5;
        let y0 = fy.floor() as i64;
        let wy = lanczos_taps(fy - y0 as f64);
        let mut rows = [0usize; 8];
        for (k, item) in rows.iter_mut().enumerate() {
            *item = clamp_index(y0 - 3 + k as i64, src_h);
        }
        for dx in 0..dst_w as usize {
            let (wx, cols) = &col_taps[dx];
            let dst_off = (dy as usize * dst_w as usize + dx) * channels;
            for c in 0..channels {
                let mut acc = 0.0f64;
                for j in 0..8 {
                    let row_off = rows[j] * src_w as usize;
                    let mut row_acc = 0.0f64;
                    for i in 0..8 {
                        row_acc += wx[i] * src[(row_off + cols[i]) * channels + c] as f64;
                    }
                    acc += wy[j] * row_acc;
                }
                out[dst_off + c] = acc;
            }
        }
    }
    out.into_iter().map(round_half_even_u8).collect()
}

fn resize_plane_u8(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    channels: usize,
    algo: Algo,
) -> Vec<u8> {
    assert_eq!(src.len(), src_w as usize * src_h as usize * channels);
    if dst_w == 0 || dst_h == 0 {
        return Vec::new();
    }
    match algo {
        Algo::Area => resize_area_u8(src, src_w, src_h, dst_w, dst_h, channels),
        Algo::Cubic => resize_cubic_u8(src, src_w, src_h, dst_w, dst_h, channels),
        Algo::Linear => resize_linear_u8(src, src_w, src_h, dst_w, dst_h, channels),
        Algo::Lanczos => resize_lanczos_u8(src, src_w, src_h, dst_w, dst_h, channels),
    }
}

/// Resize a single-channel `u8` (grayscale) image.
pub fn resize_gray(src: &GrayImage, new_w: u32, new_h: u32, algo: Algo) -> GrayImage {
    let (w, h) = src.dimensions();
    let out = resize_plane_u8(src.as_raw(), w, h, new_w, new_h, 1, algo);
    GrayImage::from_raw(new_w, new_h, out).expect("resize_gray: buffer length matches dims")
}

/// Resize a 3-channel `u8` (RGB) image — used for S0's color proc-resolution
/// resize (`dewarp.py:669`) before the `BGR2GRAY` conversion.
pub fn resize_rgb(src: &RgbImage, new_w: u32, new_h: u32, algo: Algo) -> RgbImage {
    let (w, h) = src.dimensions();
    let out = resize_plane_u8(src.as_raw(), w, h, new_w, new_h, 3, algo);
    RgbImage::from_raw(new_w, new_h, out).expect("resize_rgb: buffer length matches dims")
}

/// Resize a 4-channel `u8` (RGBA) image — the wasm ABI's own input format;
/// provided so S0 can run directly on the RGBA crop without an
/// intermediate RGB copy.
pub fn resize_rgba(src: &RgbaImage, new_w: u32, new_h: u32, algo: Algo) -> RgbaImage {
    let (w, h) = src.dimensions();
    let out = resize_plane_u8(src.as_raw(), w, h, new_w, new_h, 4, algo);
    RgbaImage::from_raw(new_w, new_h, out).expect("resize_rgba: buffer length matches dims")
}

/// Resize a single-channel `f32` plane — `_render`'s `map_x`/`map_y` upsample
/// (`dewarp.py:569-570`), always `INTER_LINEAR`. `src` is `src_w * src_h`
/// row-major; returns `new_w * new_h` row-major.
///
/// Half-pixel-center bilinear, `BORDER_REPLICATE` — verified bit-exact
/// (within `f32` ULP noise) against `cv2.resize(f32_src, ..., INTER_LINEAR)`
/// (`cv2` takes the direct floating-point path for `f32` sources, unlike
/// the fixed-point `u8` fast path — see this module's doc comment).
pub fn resize_f32_linear(src: &[f32], src_w: u32, src_h: u32, new_w: u32, new_h: u32) -> Vec<f32> {
    assert_eq!(src.len(), src_w as usize * src_h as usize);
    if new_w == 0 || new_h == 0 {
        return Vec::new();
    }
    let scale_x = src_w as f64 / new_w as f64;
    let scale_y = src_h as f64 / new_h as f64;
    let mut out = vec![0.0f32; new_h as usize * new_w as usize];
    for dy in 0..new_h {
        let fy = (dy as f64 + 0.5) * scale_y - 0.5;
        let y0 = fy.floor() as i64;
        let wy = fy - y0 as f64;
        let y0c = clamp_index(y0, src_h);
        let y1c = clamp_index(y0 + 1, src_h);
        for dx in 0..new_w {
            let fx = (dx as f64 + 0.5) * scale_x - 0.5;
            let x0 = fx.floor() as i64;
            let wx = fx - x0 as f64;
            let x0c = clamp_index(x0, src_w);
            let x1c = clamp_index(x0 + 1, src_w);
            let v00 = src[y0c * src_w as usize + x0c] as f64;
            let v01 = src[y0c * src_w as usize + x1c] as f64;
            let v10 = src[y1c * src_w as usize + x0c] as f64;
            let v11 = src[y1c * src_w as usize + x1c] as f64;
            let top = v00 * (1.0 - wx) + v01 * wx;
            let bot = v10 * (1.0 - wx) + v11 * wx;
            out[dy as usize * new_w as usize + dx as usize] = (top * (1.0 - wy) + bot * wy) as f32;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gray_from(rows: &[&[u8]]) -> GrayImage {
        let h = rows.len() as u32;
        let w = rows[0].len() as u32;
        let mut buf = Vec::with_capacity((w * h) as usize);
        for r in rows {
            buf.extend_from_slice(r);
        }
        GrayImage::from_raw(w, h, buf).unwrap()
    }

    /// `cv2.resize(g7, (3,3), INTER_AREA)` ground truth (`dewarp-cv2-truth`
    /// docker rig, opencv 5.0.0).
    #[test]
    fn area_7x7_to_3x3_matches_opencv() {
        let src = gray_from(&[
            &[0, 5, 10, 15, 20, 25, 30],
            &[35, 40, 45, 50, 55, 60, 65],
            &[70, 75, 80, 85, 90, 95, 100],
            &[105, 110, 115, 120, 125, 130, 135],
            &[140, 145, 150, 155, 160, 165, 170],
            &[175, 180, 185, 190, 195, 200, 205],
            &[210, 215, 220, 225, 230, 235, 240],
        ]);
        let dst = resize_gray(&src, 3, 3, Algo::Area);
        let expected: &[u8] = &[29, 40, 51, 109, 120, 131, 189, 200, 211];
        assert_eq!(dst.as_raw(), expected);
    }

    /// Integer-ratio (2:1) case — exercises the "fast"-equivalent path
    /// through the same general formula. There is deliberately ONE
    /// algorithm here, not a fast/general split, since the general formula
    /// is exact for integer ratios too.
    #[test]
    fn area_6x6_to_3x3_matches_opencv() {
        let src = gray_from(&[
            &[10, 20, 30, 40, 50, 60],
            &[15, 25, 35, 45, 55, 65],
            &[70, 80, 90, 100, 110, 120],
            &[75, 85, 95, 105, 115, 125],
            &[130, 140, 150, 160, 170, 180],
            &[135, 145, 155, 165, 175, 185],
        ]);
        let dst = resize_gray(&src, 3, 3, Algo::Area);
        let expected: &[u8] = &[18, 38, 58, 78, 98, 118, 138, 158, 178];
        assert_eq!(dst.as_raw(), expected);
    }

    /// This is the case that disambiguates round-half-to-even from
    /// round-half-away-from-zero (dst[0][1] = 52.5 exactly): OpenCV rounds
    /// to 52 (even), not 53.
    #[test]
    fn area_8x4_to_3x2_matches_opencv_and_uses_round_half_even() {
        let src = gray_from(&[
            &[0, 7, 14, 21, 28, 35, 42, 49],
            &[56, 63, 70, 77, 84, 91, 98, 105],
            &[112, 119, 126, 133, 140, 147, 154, 161],
            &[168, 175, 182, 189, 196, 203, 210, 217],
        ]);
        let dst = resize_gray(&src, 3, 2, Algo::Area);
        let expected: &[u8] = &[34, 52, 71, 146, 164, 183];
        assert_eq!(dst.as_raw(), expected);
    }

    #[test]
    fn area_5x5_to_2x2_matches_opencv() {
        let src = gray_from(&[
            &[9, 18, 27, 36, 45],
            &[54, 63, 72, 81, 90],
            &[99, 108, 117, 126, 135],
            &[144, 153, 162, 171, 180],
            &[189, 198, 207, 216, 225],
        ]);
        let dst = resize_gray(&src, 2, 2, Algo::Area);
        assert_eq!(dst.as_raw(), &[52, 74, 160, 182]);
    }

    /// `cv2.resize(g4, (7,7), INTER_CUBIC)` ground truth.
    #[test]
    fn cubic_4x4_to_7x7_matches_opencv() {
        let src = gray_from(&[
            &[10, 20, 30, 40],
            &[50, 60, 70, 80],
            &[90, 100, 110, 120],
            &[130, 140, 150, 160],
        ]);
        let dst = resize_gray(&src, 7, 7, Algo::Cubic);
        let expected: &[u8] = &[
            5, 9, 15, 21, 27, 33, 37, 20, 24, 30, 36, 42, 48, 52, 45, 49, 55, 61, 67, 73, 77, 69,
            73, 79, 85, 91, 97, 101, 93, 97, 103, 109, 115, 121, 125, 118, 122, 128, 134, 140, 146,
            150, 133, 137, 143, 149, 155, 161, 165,
        ];
        assert_eq!(dst.as_raw(), expected);
    }

    /// `cv2.resize(f32_src, (5,5), INTER_LINEAR)` ground truth — half-pixel
    /// center bilinear on the float path.
    #[test]
    fn f32_linear_3x3_to_5x5_matches_opencv() {
        let src: [f32; 9] = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        let dst = resize_f32_linear(&src, 3, 3, 5, 5);
        let expected: [f32; 25] = [
            0.0, 0.4, 1.0, 1.6, 2.0, 1.2, 1.6, 2.2, 2.8, 3.2, 3.0, 3.4, 4.0, 4.6, 5.0, 4.8, 5.2,
            5.8, 6.4, 6.8, 6.0, 6.4, 7.0, 7.6, 8.0,
        ];
        for (got, want) in dst.iter().zip(expected.iter()) {
            assert!((got - want).abs() < 1e-5, "got {got} want {want}");
        }
    }

    #[test]
    fn f32_linear_rect_3x2_to_6x4_matches_opencv() {
        let src: [f32; 6] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let dst = resize_f32_linear(&src, 3, 2, 6, 4);
        let expected: [f32; 24] = [
            1.0, 1.25, 1.75, 2.25, 2.75, 3.0, 1.75, 2.0, 2.5, 3.0, 3.5, 3.75, 3.25, 3.5, 4.0, 4.5,
            5.0, 5.25, 4.0, 4.25, 4.75, 5.25, 5.75, 6.0,
        ];
        for (got, want) in dst.iter().zip(expected.iter()) {
            assert!((got - want).abs() < 1e-5, "got {got} want {want}");
        }
    }

    /// RGB variant exercises the multi-channel path with the same weights
    /// applied per-channel — sanity check against a manual per-channel
    /// `resize_gray` call rather than a fresh cv2 fixture (the algorithm is
    /// channel-independent by construction).
    #[test]
    fn rgb_area_matches_per_channel_gray() {
        let w = 6u32;
        let h = 4u32;
        let mut rgb_buf = Vec::with_capacity((w * h * 3) as usize);
        let mut r_buf = Vec::with_capacity((w * h) as usize);
        let mut g_buf = Vec::with_capacity((w * h) as usize);
        let mut b_buf = Vec::with_capacity((w * h) as usize);
        for i in 0..(w * h) {
            let r = (i * 7 % 256) as u8;
            let g = (i * 13 % 256) as u8;
            let b = (i * 3 % 256) as u8;
            rgb_buf.extend_from_slice(&[r, g, b]);
            r_buf.push(r);
            g_buf.push(g);
            b_buf.push(b);
        }
        let rgb = RgbImage::from_raw(w, h, rgb_buf).unwrap();
        let r_img = GrayImage::from_raw(w, h, r_buf).unwrap();
        let g_img = GrayImage::from_raw(w, h, g_buf).unwrap();
        let b_img = GrayImage::from_raw(w, h, b_buf).unwrap();

        let dst_rgb = resize_rgb(&rgb, 3, 2, Algo::Area);
        let dst_r = resize_gray(&r_img, 3, 2, Algo::Area);
        let dst_g = resize_gray(&g_img, 3, 2, Algo::Area);
        let dst_b = resize_gray(&b_img, 3, 2, Algo::Area);

        for i in 0..(3 * 2) as usize {
            assert_eq!(dst_rgb.as_raw()[i * 3], dst_r.as_raw()[i]);
            assert_eq!(dst_rgb.as_raw()[i * 3 + 1], dst_g.as_raw()[i]);
            assert_eq!(dst_rgb.as_raw()[i * 3 + 2], dst_b.as_raw()[i]);
        }
    }

    #[test]
    fn area_upscale_identity_when_same_size() {
        let src = gray_from(&[&[1, 2, 3], &[4, 5, 6], &[7, 8, 9]]);
        let dst = resize_gray(&src, 3, 3, Algo::Area);
        assert_eq!(dst.as_raw(), src.as_raw());
    }
}
