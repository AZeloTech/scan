//! Line Segment Detector (LSD) — a faithful Rust port of OpenCV's
//! `LineSegmentDetectorImpl` running in `LSD_REFINE_STD` mode.
//!
//! `linesegs.detect_line_segments` (`linesegs.py:246-247`):
//! `cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD).detect(gray)` —
//! constructed with default everything except `refine`:
//! `scale=0.8, sigma_scale=0.6, quant=2.0, ang_th=22.5, log_eps=0,
//! density_th=0.7, n_bins=1024`. Only the four
//! endpoint coordinates (`detected[..., 0:4]`) are consumed anywhere
//! downstream — widths, precisions and NFA scores are discarded by the
//! Python reference. Internal *decisions* still have to be reproduced
//! exactly, because they decide **which** segments exist; the NFA apparatus
//! itself does not, because `LSD_REFINE_STD` never executes it (see
//! "Dead code" below).
//!
//! ## Attribution and license
//!
//! Ported from `modules/imgproc/src/lsd.cpp` of **opencv/opencv @ tag
//! `5.0.0`**, sha256
//! `3b27ddfbd30c73fe27b6ab966753fd1da83b41fa577332a0f88fab58bd265a34`,
//! vendored verbatim at `parity/reference/opencv-lsd/lsd.cpp` with the
//! provenance/licence record in `parity/reference/opencv-lsd/NOTICE`.
//! The repository LICENSE at that tag is **Apache-2.0**; the file itself
//! carries OpenCV's legacy **BSD-3-Clause** header (both permissive, both
//! compatible with this crate's `license = "Apache-2.0"`).
//!
//! OpenCV's own documentation records that the implementation was *removed*
//! in 3.4.6–3.4.15 / 4.1.0–4.5.3 "due original code license conflict" and
//! "restored again after Computation of a NFA code published under the MIT
//! license" (rafael-grompone-von-gioi/binomial_nfa, MIT, by the LSD author).
//! That NFA computation — the historically contested part — is precisely the
//! code this port **excludes entirely** (see below), so this file's licence
//! position is strictly stronger than OpenCV's own. Grompone von Gioi's IPOL
//! reference `lsd.c` (AGPL-3.0) was never fetched, read, or consulted.
//!
//! ## Dead code under `LSD_REFINE_STD` — deliberately not ported
//!
//! `flsd` gates `rect_improve` on `doRefine >= LSD_REFINE_ADV`, so
//! `rect_improve` / `rect_nfa` / `nfa` / `log_gamma_windschitl` /
//! `log_gamma_lanczos` / `AsmallerB_YoverX` / `get_slope` / `get_limit` are
//! never called and `log_nfa` stays `-1` and is discarded.
//! `LOG_NT` survives, but only as a scalar feeding `min_reg_size`.
//! `drawSegments`/`compareSegments` and the `width`/`prec`/`nfa` outputs are
//! likewise unused by the Python reference.
//!
//! ## Float semantics — the traps this port must not "clean up"
//!
//! * The pre-blur and the 0.8 downsample are OpenCV's **bit-exact
//!   fixed-point** paths (`GaussianBlurFixedPoint`, `INTER_LINEAR_EXACT`).
//!   They are pure integer arithmetic — implementing them as a "cleaner"
//!   float Gaussian/bilinear is the single most likely cause of a
//!   whole-image parity failure.
//! * [`fast_atan2`] is OpenCV's **degree-domain f32 polynomial**, not
//!   `atan2`. See its own doc comment (there is an `__EMSCRIPTEN__` fork
//!   upstream that swaps in real `atan2` — we must NOT take it).
//! * `sumdx`/`sumdy` in [`region_grow`] are `f32`, and the seed vs. loop
//!   trigonometry narrows in *different* orders (`f64::cos` then `as f32`
//!   for the seed, `as f32` then `f32::cos` in the loop).
//! * Emission narrows to `f32` *before* widening back to `f64`.
//! * The pseudo-ordering sort is `std::stable_sort`; `sort_unstable_by`
//!   would make region-growing order implementation-defined.
//!
//! Every item above is a deliberate choice, not an oversight: changing any
//! of them changes which segments the detector emits.

use crate::linesegs::LineSegments;
use image::GrayImage;

/// Detect raw line segments in a grayscale (proc-resolution) image.
///
/// Without the `lsd` cargo feature this returns [`LineSegments::empty`] —
/// the Kim 2015 "text-lines-only" mode the Python reference supports as a
/// first-class path, kept alive as a binary-size kill switch.
/// `linesegs::detect_line_segments` calls this unconditionally (mirroring
/// `dewarp.py:701`), and the *runtime* switch is `use_line_term`, not this
/// feature, so an A/B is a JSON flag rather than a rebuild.
pub fn detect(gray: &GrayImage) -> LineSegments {
    #[cfg(feature = "lsd")]
    {
        LineSegments {
            segments: imp::flsd(gray),
        }
    }
    #[cfg(not(feature = "lsd"))]
    {
        let _ = gray;
        LineSegments::empty()
    }
}

/// The LSD-internal primitives the parity harness needs to gate S3a.1/S3a.2
/// (the two fixed-point pre-passes) against `cv2.GaussianBlur`/`cv2.resize`
/// directly. Compiled **only** for the native parity build — they stay
/// LSD-private in the shipped wasm artifact, because their semantics
/// (`BORDER_REFLECT_101`, Q0.8 fixed point) differ from every `imgops`
/// primitive and must not grow accidental callers.
#[cfg(all(feature = "lsd", feature = "parity"))]
pub mod parity_internals {
    pub use super::imp::{fast_atan2, gaussian_blur_7x7_q8, resize_linear_exact};
}

#[cfg(feature = "lsd")]
mod imp {
    use image::GrayImage;

    // ---- Frozen LSD parameters -------------------------------------------
    const SCALE: f64 = 0.8;
    const SIGMA_SCALE: f64 = 0.6;
    const QUANT: f64 = 2.0;
    const ANG_TH: f64 = 22.5;
    const DENSITY_TH: f64 = 0.7;
    const N_BINS: i32 = 1024;

    const NOTDEF: f64 = -1024.0;
    const NOTUSED: u8 = 0;
    const USED: u8 = 1;
    const RELATIVE_ERROR_FACTOR: f64 = 100.0;

    const CV_PI: f64 = std::f64::consts::PI;
    const DEG_TO_RADS: f64 = CV_PI / 180.0;
    /// `#define M_3_2_PI (3 * CV_PI) / 2` — expanded exactly as written.
    const M_3_2_PI: f64 = (3.0 * CV_PI) / 2.0;
    /// `#define M_2__PI (2 * CV_PI)`.
    const M_2__PI: f64 = 2.0 * CV_PI;

    // ---- fastAtan2 --------------------------------------------------------

    /// `(float)(180/CV_PI)` — the f32 constant the C++ coefficients are
    /// multiplied by.
    const RAD2DEG_F32: f32 = (180.0 / CV_PI) as f32;
    // The C++ initializers are `<double literal>f * (float)(180/CV_PI)`,
    // i.e. **f32 x f32 evaluated in f32**. Computing the product in f64 and
    // narrowing at the end gives a different (1 ULP off) `p1`. The bit
    // patterns are pinned by `fast_atan2_coefficients_are_bit_exact`.
    const ATAN2_P1: f32 = 0.9997878412794807_f32 * RAD2DEG_F32;
    const ATAN2_P3: f32 = -0.3258083974640975_f32 * RAD2DEG_F32;
    const ATAN2_P5: f32 = 0.1555786518463281_f32 * RAD2DEG_F32;
    const ATAN2_P7: f32 = -0.04432655554792128_f32 * RAD2DEG_F32;
    /// `(float)DBL_EPSILON` — a denormal-scale f32 guard against `0/0`.
    const DBL_EPSILON_F32: f32 = f64::EPSILON as f32;

    /// OpenCV's `atan_f32` (`modules/core/src/mathfuncs_core.simd.hpp`) —
    /// the scalar degree-domain polynomial `fastAtan2` dispatches to on
    /// native builds. Result is in `[0, 360)` **degrees**.
    ///
    /// **Do not replace this with `f32::atan2` or `f64::atan2`.** Upstream
    /// OpenCV *does* substitute real `atan2` under `#ifdef __EMSCRIPTEN__`;
    /// our parity oracle is the native x86-64 Linux wheel, which uses this
    /// polynomial, and our production target is wasm — so taking the
    /// EMSCRIPTEN fork would silently break parity in exactly the build we
    /// ship. Everything here is `f32`, including the epsilon.
    #[inline]
    pub fn fast_atan2(y: f32, x: f32) -> f32 {
        let ax = x.abs();
        let ay = y.abs();
        let mut a;
        if ax >= ay {
            let c = ay / (ax + DBL_EPSILON_F32);
            let c2 = c * c;
            a = (((ATAN2_P7 * c2 + ATAN2_P5) * c2 + ATAN2_P3) * c2 + ATAN2_P1) * c;
        } else {
            let c = ax / (ay + DBL_EPSILON_F32);
            let c2 = c * c;
            a = 90.0_f32 - (((ATAN2_P7 * c2 + ATAN2_P5) * c2 + ATAN2_P3) * c2 + ATAN2_P1) * c;
        }
        if x < 0.0 {
            a = 180.0_f32 - a;
        }
        if y < 0.0 {
            a = 360.0_f32 - a;
        }
        a
    }

    // ---- Border handling --------------------------------------------------

    /// `cv::borderInterpolate(p, len, BORDER_REFLECT_101)` —
    /// `gfedcb|abcdefgh|gfedcba`. Used by the Gaussian pre-blur **only**;
    /// `resize` replicates its edge samples instead — the two rules are
    /// adjacent and must not be unified.
    #[inline]
    fn reflect101(p: i64, len: i64) -> usize {
        if p >= 0 && p < len {
            return p as usize;
        }
        if len == 1 {
            return 0;
        }
        let mut p = p;
        loop {
            if p < 0 {
                p = -p;
            } else {
                p = 2 * len - 2 - p;
            }
            if p >= 0 && p < len {
                return p as usize;
            }
        }
    }

    // ---- S3a.1: Gaussian pre-blur (bit-exact fixed point) -----------------

    /// The Q0.8 (`ufixedpoint16`, 8 fractional bits) 7-tap Gaussian OpenCV's
    /// `getGaussianKernelBitExact` produces for `n = 7, sigma = 0.6/0.8`.
    /// Sums to exactly 256. The outer taps quantize to zero, so this is
    /// effectively a 5-tap — but the kernel *size* still fixes the border
    /// reflection distance, so the zeros are kept explicit.
    ///
    /// **Hard-coded on purpose**: the coefficients come out
    /// of OpenCV's `softdouble` `exp`, which is not guaranteed last-ULP-equal
    /// to Rust's `f64::exp`. Recomputing at runtime would be a coin flip.
    /// [`gaussian_blur_7x7_q8`] therefore only accepts `(scale, sigma_scale)
    /// == (0.8, 0.6)`, which is the only pair anything in this pipeline uses.
    const GAUSS_Q8: [u32; 7] = [0, 4, 56, 136, 56, 4, 0];
    const GAUSS_RADIUS: i64 = 3;

    /// OpenCV's `GaussianBlur(src, dst, Size(7,7), 0.6/0.8)` on `CV_8UC1`,
    /// which takes the **bit-exact fixed-point** path
    /// (`GaussianBlurFixedPoint`), not a float filter.
    ///
    /// Horizontal pass: `u8 x Q0.8 -> Q0.8 u16` with saturating adds.
    /// Vertical pass: `Q0.8 x Q0.8 -> Q0.16 u32` with saturating adds, then
    /// `u8 = sat((acc + 32768) >> 16)`. There is no floating point in the
    /// filter body at all, which is what makes blur+downsample bit-exact
    /// across x86-64 and wasm32 for free.
    ///
    /// Kept LSD-private: its semantics (`BORDER_REFLECT_101`, Q0.8 fixed
    /// point) differ from every `imgops` primitive, and `threshold.rs`'s
    /// `gaussian_blur_replicate` (f32, `BORDER_REPLICATE`) must not be
    /// reused here.
    pub fn gaussian_blur_7x7_q8(src: &GrayImage) -> GrayImage {
        let (w, h) = src.dimensions();
        let (wi, hi) = (w as i64, h as i64);
        let src = src.as_raw();

        // Horizontal pass -> Q0.8 u16 rows.
        let mut hbuf = vec![0u16; (w as usize) * (h as usize)];
        for y in 0..h as usize {
            let row = &src[y * w as usize..(y + 1) * w as usize];
            for x in 0..w as i64 {
                let mut acc: u16 = 0;
                for (j, &k) in GAUSS_Q8.iter().enumerate() {
                    let sx = reflect101(x + j as i64 - GAUSS_RADIUS, wi);
                    let term = (k * row[sx] as u32) as u16;
                    acc = acc.saturating_add(term);
                }
                hbuf[y * w as usize + x as usize] = acc;
            }
        }

        // Vertical pass -> u8.
        let mut out = vec![0u8; (w as usize) * (h as usize)];
        for y in 0..h as i64 {
            for x in 0..w as usize {
                let mut acc: u32 = 0;
                for (j, &k) in GAUSS_Q8.iter().enumerate() {
                    let sy = reflect101(y + j as i64 - GAUSS_RADIUS, hi);
                    acc = acc.saturating_add(k * hbuf[sy * w as usize + x] as u32);
                }
                let v = (acc + 32768) >> 16;
                out[y as usize * w as usize + x] = if v > 255 { 255 } else { v as u8 };
            }
        }
        GrayImage::from_raw(w, h, out).expect("dimensions unchanged")
    }

    // ---- S3a.2: INTER_LINEAR_EXACT downsample ----------------------------

    /// `cvRound` — round half to **even** (`saturate_cast<int>(double)`).
    #[inline]
    fn cv_round(v: f64) -> i64 {
        v.round_ties_even() as i64
    }

    /// One axis' bit-exact `INTER_LINEAR_EXACT` tab entry: the left source
    /// index and the Q0.8 weight of the *right* sample.
    struct XyTab {
        idx: usize,
        c1: u32,
    }

    /// `cv::resize(src, dst, Size(), 0.8, 0.8, INTER_LINEAR_EXACT)`.
    ///
    /// `dsize = (cvRound(W*0.8), cvRound(H*0.8))`; because `dsize` was passed
    /// empty, `inv_scale` stays exactly `0.8` and is **not** recomputed as
    /// `dst/src`. Per-output coefficients are
    /// `fval = (1/0.8)*(d + 0.5) - 0.5`, `ival = floor(fval)`,
    /// `c1 = Q0.8(fval - ival)`, `c0 = 256 - c1`.
    ///
    /// At `inv_scale = 0.8` this is exact with no rounding ambiguity at all:
    /// `1/0.8 == 1.25` in IEEE f64, so `fval = 1.25*d + 0.125` and the
    /// fractional part cycles through `{0.125, 0.375, 0.625, 0.875}` — each
    /// an exact multiple of `1/256`, so `c1 in {32, 96, 160, 224}` with no
    /// rounding step to get wrong. Out-of-range `ival` replicates the edge
    /// sample (**not** reflect — see [`reflect101`]'s note).
    pub fn resize_linear_exact(src: &GrayImage, inv_scale: f64) -> GrayImage {
        let (sw, sh) = src.dimensions();
        let dw = cv_round(sw as f64 * inv_scale).max(1) as usize;
        let dh = cv_round(sh as f64 * inv_scale).max(1) as usize;
        let scale = 1.0 / inv_scale;

        let tab = |dsize: usize, ssize: usize| -> Vec<XyTab> {
            (0..dsize)
                .map(|d| {
                    let fval = scale * (d as f64 + 0.5) - 0.5;
                    let ival = fval.floor();
                    let frac = fval - ival;
                    let c1 = (frac * 256.0).round_ties_even() as i64;
                    let c1 = c1.clamp(0, 256) as u32;
                    let idx = (ival as i64).clamp(0, ssize as i64 - 1) as usize;
                    XyTab { idx, c1 }
                })
                .collect()
        };
        let xtab = tab(dw, sw as usize);
        let ytab = tab(dh, sh as usize);

        let sraw = src.as_raw();
        let sw_us = sw as usize;

        // Horizontal pass -> Q0.8 u16, full source height.
        let mut hbuf = vec![0u16; dw * sh as usize];
        for y in 0..sh as usize {
            let row = &sraw[y * sw_us..(y + 1) * sw_us];
            for (d, t) in xtab.iter().enumerate() {
                let i0 = t.idx;
                let i1 = (t.idx + 1).min(sw_us - 1);
                let c0 = 256 - t.c1;
                hbuf[y * dw + d] = (c0 * row[i0] as u32 + t.c1 * row[i1] as u32) as u16;
            }
        }

        // Vertical pass -> u8.
        let mut out = vec![0u8; dw * dh];
        for (dy, t) in ytab.iter().enumerate() {
            let j0 = t.idx;
            let j1 = (t.idx + 1).min(sh as usize - 1);
            let c0 = 256 - t.c1;
            for x in 0..dw {
                let acc = c0 * hbuf[j0 * dw + x] as u32 + t.c1 * hbuf[j1 * dw + x] as u32;
                let v = (acc + 32768) >> 16;
                out[dy * dw + x] = if v > 255 { 255 } else { v as u8 };
            }
        }
        GrayImage::from_raw(dw as u32, dh as u32, out).expect("dimensions computed above")
    }

    // ---- LSD state --------------------------------------------------------

    struct LsdState {
        angles: Vec<f64>,
        modgrad: Vec<f64>,
        used: Vec<u8>,
        img_width: i32,
        img_height: i32,
    }

    /// `LineSegmentDetectorImpl::RegionPoint`. The C++ member is a raw
    /// `uchar*` aliasing the `used` Mat so `refine`/`reduce_region_radius`
    /// can un-mark points; a flat index into `used` is equivalent (the
    /// buffer is never reallocated) and safe.
    #[derive(Clone, Copy)]
    struct RegionPoint {
        x: i32,
        y: i32,
        idx: usize,
        angle: f64,
        modgrad: f64,
    }

    /// `LineSegmentDetectorImpl::rect`. `width`/`prec`/`p`/`x`/`y`/`theta`
    /// are kept because `refine`/`reduce_region_radius` read them, even
    /// though only the four endpoint coordinates are ever emitted.
    #[derive(Clone, Copy)]
    struct Rect {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        width: f64,
        x: f64,
        y: f64,
        #[allow(dead_code)]
        theta: f64,
        #[allow(dead_code)]
        dx: f64,
        #[allow(dead_code)]
        dy: f64,
        #[allow(dead_code)]
        prec: f64,
        #[allow(dead_code)]
        p: f64,
    }

    #[inline]
    fn dist_sq(x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
        (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)
    }

    /// `dist` — C++ writes `sqrt(distSq(...))`, **not** `hypot`.
    #[inline]
    fn dist(x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
        dist_sq(x1, y1, x2, y2).sqrt()
    }

    #[inline]
    fn angle_diff_signed(a: f64, b: f64) -> f64 {
        let mut diff = a - b;
        while diff <= -CV_PI {
            diff += M_2__PI;
        }
        while diff > CV_PI {
            diff -= M_2__PI;
        }
        diff
    }

    #[inline]
    fn angle_diff(a: f64, b: f64) -> f64 {
        angle_diff_signed(a, b).abs()
    }

    /// `double_equal` — relative-error comparison, only reachable from
    /// `get_theta`'s null-inertia assert.
    fn double_equal(a: f64, b: f64) -> bool {
        if a == b {
            return true;
        }
        let abs_diff = (a - b).abs();
        let aa = a.abs();
        let bb = b.abs();
        let mut abs_max = if aa > bb { aa } else { bb };
        if abs_max < f64::MIN_POSITIVE {
            abs_max = f64::MIN_POSITIVE;
        }
        abs_diff / abs_max <= RELATIVE_ERROR_FACTOR * f64::EPSILON
    }

    impl LsdState {
        #[inline]
        fn is_aligned(&self, x: i32, y: i32, theta: f64, prec: f64) -> bool {
            if x < 0 || y < 0 || x >= self.img_width || y >= self.img_height {
                return false;
            }
            let a = self.angles[y as usize * self.img_width as usize + x as usize];
            if a == NOTDEF {
                return false;
            }
            let mut n_theta = theta - a;
            if n_theta < 0.0 {
                n_theta = -n_theta;
            }
            if n_theta > M_3_2_PI {
                n_theta -= M_2__PI;
                if n_theta < 0.0 {
                    n_theta = -n_theta;
                }
            }
            n_theta <= prec
        }

        /// `ll_angle` — gradient + pseudo-ordering. Returns the
        /// `ordered_points` list, stable-sorted **descending** by bin.
        fn ll_angle(&mut self, scaled: &GrayImage, threshold: f64, n_bins: i32) -> Vec<(u32, i32)> {
            let w = scaled.width() as usize;
            let h = scaled.height() as usize;
            self.img_width = w as i32;
            self.img_height = h as i32;
            // `angles` last row + last column are NOTDEF; the corresponding
            // `modgrad` entries are uninitialized in C++ and provably never
            // read (every read is gated on `isAligned`, false on NOTDEF).
            // Zero-init here.
            self.angles = vec![NOTDEF; w * h];
            self.modgrad = vec![0.0; w * h];
            let raw = scaled.as_raw();

            let mut max_grad = -1.0f64;
            for y in 0..h.saturating_sub(1) {
                for x in 0..w.saturating_sub(1) {
                    let i00 = raw[y * w + x] as i32;
                    let i01 = raw[y * w + x + 1] as i32;
                    let i10 = raw[(y + 1) * w + x] as i32;
                    let i11 = raw[(y + 1) * w + x + 1] as i32;
                    let da = i11 - i00;
                    let bc = i01 - i10;
                    let gx = da + bc;
                    let gy = da - bc;
                    let norm = (((gx * gx + gy * gy) as f64) / 4.0).sqrt();
                    self.modgrad[y * w + x] = norm;
                    if norm <= threshold {
                        self.angles[y * w + x] = NOTDEF;
                    } else {
                        // NOTE the argument order: `fastAtan2(float(gx),
                        // float(-gy))`, i.e. y=gx and x=-gy, with `-gy`
                        // negated as an `int` *before* the f32 cast. The
                        // result lands in `[0, 2*pi)`, not `[-pi, pi]` — the
                        // `isAligned` comment claiming otherwise is wrong;
                        // the `M_3_2_PI` wrap is what saves it.
                        self.angles[y * w + x] =
                            f64::from(fast_atan2(gx as f32, (-gy) as f32)) * DEG_TO_RADS;
                        if norm > max_grad {
                            max_grad = norm;
                        }
                    }
                }
            }

            let bin_coef = if max_grad > 0.0 {
                f64::from(n_bins - 1) / max_grad
            } else {
                0.0
            };
            let mut ordered: Vec<(u32, i32)> =
                Vec::with_capacity(w.saturating_sub(1) * h.saturating_sub(1));
            for y in 0..h.saturating_sub(1) {
                for x in 0..w.saturating_sub(1) {
                    // C `int()` truncation toward zero.
                    let i = (self.modgrad[y * w + x] * bin_coef) as i32;
                    ordered.push(((y * w + x) as u32, i));
                }
            }
            // `std::stable_sort(..., compare_norm)` with
            // `compare_norm(a,b) = a.norm > b.norm`. Rust's `sort_by` is
            // stable; `sort_unstable_by` would make the whole region-growing
            // outcome implementation-defined.
            ordered.sort_by(|a, b| b.1.cmp(&a.1));
            ordered
        }

        /// `region_grow` — BFS over an index-growing `reg` vector (not a
        /// queue), updating `reg_angle` after **every single** acceptance.
        fn region_grow(
            &mut self,
            sx: i32,
            sy: i32,
            reg: &mut Vec<RegionPoint>,
            reg_angle: &mut f64,
            prec: f64,
        ) {
            reg.clear();
            let w = self.img_width as usize;
            let sidx = sy as usize * w + sx as usize;
            *reg_angle = self.angles[sidx];
            reg.push(RegionPoint {
                x: sx,
                y: sy,
                idx: sidx,
                angle: *reg_angle,
                modgrad: self.modgrad[sidx],
            });

            // Seed: `float(std::cos(reg_angle))` = f64 cos, then narrow.
            let mut sumdx: f32 = reg_angle.cos() as f32;
            let mut sumdy: f32 = reg_angle.sin() as f32;
            // The seed is marked used *after* sumdx/sumdy are initialized.
            self.used[sidx] = USED;

            let mut i = 0usize;
            while i < reg.len() {
                let (rx, ry) = (reg[i].x, reg[i].y);
                let xx_min = (rx - 1).max(0);
                let xx_max = (rx + 1).min(self.img_width - 1);
                let yy_min = (ry - 1).max(0);
                let yy_max = (ry + 1).min(self.img_height - 1);
                for yy in yy_min..=yy_max {
                    for xx in xx_min..=xx_max {
                        let idx = yy as usize * w + xx as usize;
                        if self.used[idx] != USED && self.is_aligned(xx, yy, *reg_angle, prec) {
                            let angle = self.angles[idx];
                            self.used[idx] = USED;
                            reg.push(RegionPoint {
                                x: xx,
                                y: yy,
                                idx,
                                angle,
                                modgrad: self.modgrad[idx],
                            });
                            // Loop: `std::cos(float(angle))` = narrow first,
                            // then f32 cos — the mirror image of the seed's
                            // narrowing. Swapping them drifts `reg_angle`.
                            sumdx += (angle as f32).cos();
                            sumdy += (angle as f32).sin();
                            *reg_angle = f64::from(fast_atan2(sumdy, sumdx)) * DEG_TO_RADS;
                        }
                    }
                }
                i += 1;
            }
        }

        /// `region2rect`. Returns `None` where C++ would throw
        /// `CV_Assert(sum > 0)` (unreachable for a region that passed
        /// `min_reg_size`): a wasm panic in the caller's worker is a hard
        /// failure, skipping one seed is not.
        fn region2rect(
            &self,
            reg: &[RegionPoint],
            reg_angle: f64,
            prec: f64,
            p: f64,
        ) -> Option<Rect> {
            let mut x = 0.0f64;
            let mut y = 0.0f64;
            let mut sum = 0.0f64;
            for pnt in reg {
                let weight = pnt.modgrad;
                x += f64::from(pnt.x) * weight;
                y += f64::from(pnt.y) * weight;
                sum += weight;
            }
            debug_assert!(sum > 0.0, "region2rect: CV_Assert(sum > 0)");
            if !(sum > 0.0) {
                return None;
            }
            x /= sum;
            y /= sum;

            let theta = self.get_theta(reg, x, y, reg_angle, prec)?;

            let dx = theta.cos();
            let dy = theta.sin();
            let (mut l_min, mut l_max, mut w_min, mut w_max) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for pt in reg {
                let regdx = f64::from(pt.x) - x;
                let regdy = f64::from(pt.y) - y;
                let l = regdx * dx + regdy * dy;
                let ww = -regdx * dy + regdy * dx;
                if l > l_max {
                    l_max = l;
                } else if l < l_min {
                    l_min = l;
                }
                if ww > w_max {
                    w_max = ww;
                } else if ww < w_min {
                    w_min = ww;
                }
            }

            let mut rec = Rect {
                x1: x + l_min * dx,
                y1: y + l_min * dy,
                x2: x + l_max * dx,
                y2: y + l_max * dy,
                width: w_max - w_min,
                x,
                y,
                theta,
                dx,
                dy,
                prec,
                p,
            };
            if rec.width < 1.0 {
                rec.width = 1.0;
            }
            Some(rec)
        }

        /// `get_theta` — principal inertia axis. `None` where C++ would
        /// throw on a null inertia matrix (see [`LsdState::region2rect`]).
        fn get_theta(
            &self,
            reg: &[RegionPoint],
            x: f64,
            y: f64,
            reg_angle: f64,
            prec: f64,
        ) -> Option<f64> {
            let mut ixx = 0.0f64;
            let mut iyy = 0.0f64;
            let mut ixy = 0.0f64;
            for pt in reg {
                let regx = f64::from(pt.x);
                let regy = f64::from(pt.y);
                let weight = pt.modgrad;
                let dx = regx - x;
                let dy = regy - y;
                ixx += dy * dy * weight;
                iyy += dx * dx * weight;
                ixy -= dx * dy * weight;
            }
            let null_matrix =
                double_equal(ixx, 0.0) && double_equal(iyy, 0.0) && double_equal(ixy, 0.0);
            debug_assert!(!null_matrix, "get_theta: CV_Assert(!null inertia matrix)");
            if null_matrix {
                return None;
            }

            let lambda = 0.5 * (ixx + iyy - ((ixx - iyy) * (ixx - iyy) + 4.0 * ixy * ixy).sqrt());
            // f64 subtraction, *then* narrow to f32 at each argument.
            let mut theta = if ixx.abs() > iyy.abs() {
                f64::from(fast_atan2((lambda - ixx) as f32, ixy as f32))
            } else {
                f64::from(fast_atan2(ixy as f32, (lambda - iyy) as f32))
            };
            theta *= DEG_TO_RADS;
            if angle_diff(theta, reg_angle) > prec {
                theta += CV_PI;
            }
            Some(theta)
        }

        /// `refine` — the `LSD_REFINE_STD` step. Note that the post-re-grow
        /// `region2rect` (and `reduce_region_radius`) receive the **original**
        /// `prec`/`p`; only the re-grow itself uses `tau`.
        fn refine(
            &mut self,
            reg: &mut Vec<RegionPoint>,
            mut reg_angle: f64,
            prec: f64,
            p: f64,
            rec: &mut Rect,
            density_th: f64,
        ) -> bool {
            let mut density = reg.len() as f64 / (dist(rec.x1, rec.y1, rec.x2, rec.y2) * rec.width);
            if density >= density_th {
                return true;
            }

            let xc = f64::from(reg[0].x);
            let yc = f64::from(reg[0].y);
            let ang_c = reg[0].angle;
            let mut sum = 0.0f64;
            let mut s_sum = 0.0f64;
            let mut n = 0i32;
            for pt in reg.iter() {
                self.used[pt.idx] = NOTUSED;
                if dist(xc, yc, f64::from(pt.x), f64::from(pt.y)) < rec.width {
                    let ang_d = angle_diff_signed(pt.angle, ang_c);
                    sum += ang_d;
                    s_sum += ang_d * ang_d;
                    n += 1;
                }
            }
            debug_assert!(n > 0, "refine: CV_Assert(n > 0)");
            if n <= 0 {
                return false;
            }
            let mean_angle = sum / f64::from(n);
            // 2 * standard deviation. There is **no** non-negativity guard
            // upstream: this can legitimately be NaN, in which case
            // `isAligned`'s `n_theta <= NaN` is false, the re-grow yields a
            // 1-point region and the segment is rejected. Do not "fix" it
            // with a `.max(0.0)` — that changes which segments exist.
            let tau = 2.0
                * ((s_sum - 2.0 * mean_angle * sum) / f64::from(n) + mean_angle * mean_angle)
                    .sqrt();

            let (sx, sy) = (reg[0].x, reg[0].y);
            self.region_grow(sx, sy, reg, &mut reg_angle, tau);
            if reg.len() < 2 {
                return false;
            }
            let Some(new_rec) = self.region2rect(reg, reg_angle, prec, p) else {
                return false;
            };
            *rec = new_rec;
            density = reg.len() as f64 / (dist(rec.x1, rec.y1, rec.x2, rec.y2) * rec.width);

            if density < density_th {
                self.reduce_region_radius(reg, reg_angle, prec, p, rec, density, density_th)
            } else {
                true
            }
        }

        /// `reduce_region_radius`. The C++ `std::swap(reg[i], reg.back());
        /// reg.pop_back(); --i;` is `swap_remove(i)` with the index
        /// **re-examined**, not skipped.
        fn reduce_region_radius(
            &mut self,
            reg: &mut Vec<RegionPoint>,
            reg_angle: f64,
            prec: f64,
            p: f64,
            rec: &mut Rect,
            mut density: f64,
            density_th: f64,
        ) -> bool {
            let xc = f64::from(reg[0].x);
            let yc = f64::from(reg[0].y);
            let rad_sq1 = dist_sq(xc, yc, rec.x1, rec.y1);
            let rad_sq2 = dist_sq(xc, yc, rec.x2, rec.y2);
            let mut rad_sq = if rad_sq1 > rad_sq2 { rad_sq1 } else { rad_sq2 };

            while density < density_th {
                rad_sq *= 0.75 * 0.75;
                let mut i = 0usize;
                while i < reg.len() {
                    if dist_sq(xc, yc, f64::from(reg[i].x), f64::from(reg[i].y)) > rad_sq {
                        self.used[reg[i].idx] = NOTUSED;
                        reg.swap_remove(i);
                    } else {
                        i += 1;
                    }
                }
                if reg.len() < 2 {
                    return false;
                }
                let Some(new_rec) = self.region2rect(reg, reg_angle, prec, p) else {
                    return false;
                };
                *rec = new_rec;
                density = reg.len() as f64 / (dist(rec.x1, rec.y1, rec.x2, rec.y2) * rec.width);
            }
            true
        }
    }

    /// `LineSegmentDetectorImpl::flsd` in `LSD_REFINE_STD` mode.
    ///
    /// Returns `[px, py, qx, qy]` per segment, in **proc-resolution pixels**
    /// (the internal 0.8 downsample is undone here and is invisible above
    /// this module), each coordinate rounded to `f32` and widened back —
    /// `Vec4f` is what OpenCV emits and what Python's `float32` array
    /// carries, so emitting the f64 intermediate would break exact match.
    pub(crate) fn flsd(gray: &GrayImage) -> Vec<[f64; 4]> {
        let (w, h) = gray.dimensions();
        if w == 0 || h == 0 {
            return Vec::new();
        }

        let prec = CV_PI * ANG_TH / 180.0;
        let p = ANG_TH / 180.0;
        let rho = QUANT / prec.sin();

        // `SCALE != 1` branch. sigma is `SIGMA_SCALE / SCALE` computed in
        // f64 — 0.7499999999999999, not 0.75; never write the literal.
        let sigma = SIGMA_SCALE / SCALE;
        let sprec = 3.0f64;
        let khalf = (sigma * (2.0 * sprec * 10.0f64.ln()).sqrt()).ceil() as u32;
        assert_eq!(
            (khalf, GAUSS_Q8.len()),
            (GAUSS_RADIUS as u32, 2 * GAUSS_RADIUS as usize + 1),
            "the hard-coded Q0.8 Gaussian kernel is only valid for (scale, sigma_scale) == (0.8, 0.6)"
        );
        let blurred = gaussian_blur_7x7_q8(gray);
        let scaled = resize_linear_exact(&blurred, SCALE);

        let (sw, sh) = scaled.dimensions();
        let mut st = LsdState {
            angles: Vec::new(),
            modgrad: Vec::new(),
            used: vec![NOTUSED; (sw as usize) * (sh as usize)],
            img_width: 0,
            img_height: 0,
        };
        let ordered = st.ll_angle(&scaled, rho, N_BINS);

        let log_nt = 5.0 * (f64::from(st.img_width).log10() + f64::from(st.img_height).log10())
            / 2.0
            + 11.0f64.log10();
        // `size_t(-LOG_NT/log10(p))` — C truncation toward zero.
        let min_reg_size = (-log_nt / p.log10()) as usize;

        let mut lines: Vec<[f64; 4]> = Vec::new();
        let mut reg: Vec<RegionPoint> = Vec::new();
        let sw_us = sw as usize;
        for &(idx, _bin) in &ordered {
            let idx = idx as usize;
            if st.used[idx] != NOTUSED || st.angles[idx] == NOTDEF {
                continue;
            }
            let px = (idx % sw_us) as i32;
            let py = (idx / sw_us) as i32;
            let mut reg_angle = 0.0f64;
            st.region_grow(px, py, &mut reg, &mut reg_angle, prec);

            if reg.len() < min_reg_size {
                continue;
            }
            let Some(mut rec) = st.region2rect(&reg, reg_angle, prec, p) else {
                continue;
            };
            if !st.refine(&mut reg, reg_angle, prec, p, &mut rec, DENSITY_TH) {
                continue;
            }

            // `+0.5` on all four coordinates, **then** `/= SCALE` — a
            // corner->centre shift of the *scaled* grid, with no
            // compensating `-0.5`. `linesegs.rs` inherits it unchanged.
            rec.x1 += 0.5;
            rec.y1 += 0.5;
            rec.x2 += 0.5;
            rec.y2 += 0.5;
            rec.x1 /= SCALE;
            rec.y1 /= SCALE;
            rec.x2 /= SCALE;
            rec.y2 /= SCALE;

            lines.push([
                f64::from(rec.x1 as f32),
                f64::from(rec.y1 as f32),
                f64::from(rec.x2 as f32),
                f64::from(rec.y2 as f32),
            ]);
        }
        lines
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// The C++ initializers are `f32 x f32` products, not f64 products
        /// narrowed at the end (which
        /// gives `p1 = 0x4265226e`, 1 ULP low).
        #[test]
        fn fast_atan2_coefficients_are_bit_exact() {
            assert_eq!(ATAN2_P1.to_bits(), 0x4265_226f, "atan2_p1");
            assert_eq!(ATAN2_P3.to_bits(), 0xc195_56ee, "atan2_p3");
            assert_eq!(ATAN2_P5.to_bits(), 0x410e_9fbf, "atan2_p5");
            assert_eq!(ATAN2_P7.to_bits(), 0xc022_8ad9, "atan2_p7");
        }

        #[test]
        fn fast_atan2_quadrants_and_degenerates() {
            // Degree domain, [0, 360).
            assert!((fast_atan2(0.0, 1.0) - 0.0).abs() < 1e-4);
            assert!((fast_atan2(1.0, 0.0) - 90.0).abs() < 1e-4);
            assert!((fast_atan2(0.0, -1.0) - 180.0).abs() < 1e-4);
            assert!((fast_atan2(-1.0, 0.0) - 270.0).abs() < 1e-4);
            // The polynomial is a ~0.3-degree-accurate approximation, not
            // `atan2`; bit-exactness is gated by the coefficient test
            // above, not by this tolerance check.
            assert!((fast_atan2(1.0, 1.0) - 45.0).abs() < 0.3);
            assert!((fast_atan2(-1.0, -1.0) - 225.0).abs() < 0.3);
            // Both zero: ax >= ay branch, c = 0 => 0 degrees (no NaN).
            assert_eq!(fast_atan2(0.0, 0.0), 0.0);
        }

        #[test]
        fn reflect101_matches_border_interpolate() {
            // gfedcb|abcdefgh|gfedcba for len = 8
            let len = 8;
            let got: Vec<usize> = (-3..11).map(|p| reflect101(p, len)).collect();
            assert_eq!(got, vec![3, 2, 1, 0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4]);
            assert_eq!(reflect101(-5, 1), 0);
        }

        /// The Q0.8 kernel must sum to exactly 256 — otherwise the blur
        /// shifts the image's mean brightness and nothing downstream matches.
        #[test]
        fn gaussian_kernel_sums_to_unity() {
            assert_eq!(GAUSS_Q8.iter().sum::<u32>(), 256);
        }

        /// At `inv_scale = 0.8` the
        /// fractional part of `1.25*d + 0.125` is always an exact multiple
        /// of `1/8`, so the Q0.8 weights need no rounding decision.
        #[test]
        fn resize_coefficients_are_exact_eighths() {
            for d in 0..4096u32 {
                let fval = 1.25 * f64::from(d) + 0.125;
                let frac = fval - fval.floor();
                let scaled = frac * 8.0;
                assert_eq!(scaled, scaled.round(), "d={d} frac={frac}");
                assert!([32.0, 96.0, 160.0, 224.0].contains(&(frac * 256.0)));
            }
        }

        /// A constant image must survive both fixed-point pre-passes exactly
        /// (kernel sums to 256, resize weights sum to 256).
        #[test]
        fn prepasses_preserve_a_constant_image() {
            let img = GrayImage::from_pixel(37, 23, image::Luma([200u8]));
            let b = gaussian_blur_7x7_q8(&img);
            assert!(
                b.as_raw().iter().all(|&v| v == 200),
                "blur must preserve a flat field"
            );
            let s = resize_linear_exact(&b, 0.8);
            assert_eq!(s.dimensions(), (30, 18));
            assert!(
                s.as_raw().iter().all(|&v| v == 200),
                "resize must preserve a flat field"
            );
        }

        /// A flat image has no gradient anywhere, so LSD must find nothing
        /// (and must not panic on the all-NOTDEF / `max_grad <= 0` path).
        #[test]
        fn flat_image_yields_no_segments() {
            let img = GrayImage::from_pixel(64, 48, image::Luma([128u8]));
            assert!(flsd(&img).is_empty());
        }

        /// A hard black/white edge must produce at least one segment roughly
        /// along it — a smoke test that the region-growing path runs at all.
        #[test]
        fn vertical_edge_yields_a_vertical_segment() {
            let mut img = GrayImage::from_pixel(80, 120, image::Luma([250u8]));
            for y in 0..120u32 {
                for x in 40..80u32 {
                    img.put_pixel(x, y, image::Luma([10u8]));
                }
            }
            let segs = flsd(&img);
            assert!(
                !segs.is_empty(),
                "expected at least one segment on a hard edge"
            );
            let vertical = segs
                .iter()
                .any(|s| (s[2] - s[0]).abs() < 5.0 && (s[3] - s[1]).abs() > 30.0);
            assert!(
                vertical,
                "expected a long, near-vertical segment, got {segs:?}"
            );
        }
    }
}
