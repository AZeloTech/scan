//! Otsu global threshold + Gaussian adaptive threshold — hand-rolled
//! because `imageproc`'s `adaptive_threshold` is mean-only, with no
//! Gaussian-weighted mode.
//!
//! Call sites:
//! - Otsu: `textline.py:72` (binarize's foreground-ratio-too-high fallback),
//!   `linesegs.py:214` (paper-region V-channel), `saliency.py:159`
//!   (scene-only, not ported).
//! - `adaptiveThreshold(GAUSSIAN_C, ...)`: `textline.py:66-68` (dark text,
//!   `THRESH_BINARY_INV`, `C=15`) and `textline.py:85-87` (light text,
//!   `THRESH_BINARY`, `C=-15`), both with
//!   `block = max(31, (min(h,w)//20) | 1)` — note the `|1` on an even value
//!   adds one, equivalent here to `+1 if even` only because the value is
//!   non-negative.
//!
//! Port note: OpenCV derives the Gaussian
//! σ from the kernel size as `0.3*((k-1)*0.5 - 1) + 0.8`
//! (`cv2::getGaussianKernel`'s formula), uses a separable pass with
//! `BORDER_REPLICATE`, then thresholds against
//! `dst = src > saturate_cast<uchar>(mean - C) ? maxval : 0` — the
//! `saturate_cast` rounding of the blurred mean is part of the parity
//! contract: a single flipped pixel here cascades all the way to
//! `uses_confidence_filter`, an 8× change in the downstream segment set.
//! Blocks are large (61 at proc size for a 1200×1600 image) — a
//! separable float pass, not an O(k²) window sum, is required for
//! performance as well as correctness.
//!
//! ## Parity notes (verified against opencv-python-headless 5.0.0)
//!
//! - [`otsu_threshold`]: the classic incremental between-class-variance scan
//!   (`cv2`'s own `getThreshVal_Otsu_8u`, transcribed field-for-field —
//!   cumulative `q1`/`mu1`, `FLT_EPSILON` guard, strict `>` so the **first**
//!   maximizing threshold wins on ties) — verified pixel/value-exact,
//!   including the degenerate uniform-image case (threshold `0`).
//! - [`adaptive_threshold_gaussian`]: `GaussianBlur`'s `sigma<=0` path
//!   computes σ via the formula above **except** for odd kernel sizes
//!   `<= 7`, where `cv2::getGaussianKernel` substitutes a hardcoded
//!   `small_gaussian_tab` lookup instead of evaluating the Gaussian formula
//!   (an internal OpenCV special case for the common small-blur-kernel
//!   sizes). This port implements **only** the general σ-formula path,
//!   because the real pipeline's block size is always
//!   `max(31, (min(h,w)//20)|1) >= 31`, never `<=7` — confirmed against
//!   `cv2` ground truth at block sizes 9/11/13/17 (all `>7`, all exact);
//!   deliberately **not** tested at block `<=7` since that would be pinning
//!   a code path this module does not implement. Also mirrors
//!   `adaptiveThreshold`'s actual internal precision: it converts the source
//!   to `CV_32F` **before** blurring (not `f64`), so the Gaussian pass here
//!   runs in `f32` (kernel table and horizontal/vertical accumulation), then
//!   the blurred mean is rounded (round-half-to-even, `saturate_cast<uchar>`)
//!   back to `u8` before the final compare.

use image::GrayImage;

/// Otsu's method on a 256-bin histogram — classic between-class-variance
/// argmax. OpenCV picks the **first** maximizing threshold on ties.
/// Returns the raw threshold value; `src > threshold` is foreground
/// (caller applies `BINARY`/`BINARY_INV` polarity).
pub fn otsu_threshold(gray: &GrayImage) -> u8 {
    let mut hist = [0.0f64; 256];
    for p in gray.pixels() {
        hist[p.0[0] as usize] += 1.0;
    }
    let n = gray.width() as f64 * gray.height() as f64;
    if n == 0.0 {
        return 0;
    }
    let scale = 1.0 / n;
    let mut mu = 0.0f64;
    for (i, &h) in hist.iter().enumerate() {
        mu += i as f64 * h;
    }
    mu *= scale;

    let mut mu1 = 0.0f64;
    let mut q1 = 0.0f64;
    let mut max_sigma = 0.0f64;
    let mut max_val = 0u8;
    // `FLT_EPSILON` — OpenCV's `getThreshVal_Otsu_8u` uses the float
    // epsilon here even though everything else is double (transcribed
    // verbatim — match the exact form, never "clean it up").
    const FLT_EPSILON: f64 = 1.192_092_9e-7;
    for (i, &h) in hist.iter().enumerate() {
        let p_i = h * scale;
        mu1 *= q1;
        q1 += p_i;
        let q2 = 1.0 - q1;
        if q1.min(q2) < FLT_EPSILON || q1.max(q2) > 1.0 - FLT_EPSILON {
            continue;
        }
        mu1 = (mu1 + i as f64 * p_i) / q1;
        let mu2 = (mu - q1 * mu1) / q2;
        let sigma = q1 * q2 * (mu1 - mu2) * (mu1 - mu2);
        if sigma > max_sigma {
            max_sigma = sigma;
            max_val = i as u8;
        }
    }
    max_val
}

/// `cv2.threshold(gray, 0, 255, THRESH_BINARY[_INV] + THRESH_OTSU)` — Otsu
/// threshold selection followed by a binary (optionally inverted) apply.
/// `inverted = false` ⇒ `THRESH_BINARY` (`src > thr ? 255 : 0`);
/// `inverted = true` ⇒ `THRESH_BINARY_INV` (`src > thr ? 0 : 255`, i.e.
/// `src <= thr ? 255 : 0`).
pub fn threshold_otsu(gray: &GrayImage, inverted: bool) -> GrayImage {
    let thr = otsu_threshold(gray);
    apply_binary(gray, thr as f64, inverted)
}

fn apply_binary(gray: &GrayImage, thr: f64, inverted: bool) -> GrayImage {
    let (w, h) = gray.dimensions();
    let mut out = GrayImage::new(w, h);
    for (src, dst) in gray.pixels().zip(out.pixels_mut()) {
        let above = (src.0[0] as f64) > thr;
        let fg = above != inverted;
        dst.0[0] = if fg { 255 } else { 0 };
    }
    out
}

/// `cv2.bitwise_not` — `255 - x` per pixel (`textline.py:74`).
pub fn bitwise_not(img: &GrayImage) -> GrayImage {
    let (w, h) = img.dimensions();
    let mut out = GrayImage::new(w, h);
    for (src, dst) in img.pixels().zip(out.pixels_mut()) {
        dst.0[0] = 255 - src.0[0];
    }
    out
}

/// `cv2::getGaussianKernel`'s σ-from-kernel-size formula (used whenever
/// `sigma<=0` is passed, which `adaptiveThreshold`'s `GaussianBlur(sigmaX=0,
/// sigmaY=0)` call always does). **Not** valid for odd `ksize <= 7` — see
/// the module doc comment.
fn gaussian_sigma_for_ksize(ksize: u32) -> f64 {
    0.3 * ((ksize as f64 - 1.0) * 0.5 - 1.0) + 0.8
}

/// 1-D Gaussian kernel, `f32` (matches `adaptiveThreshold`'s internal
/// `CV_32F` precision), normalized to sum to `1.0`.
fn gaussian_kernel_1d(ksize: u32, sigma: f64) -> Vec<f32> {
    let center = (ksize as f64 - 1.0) / 2.0;
    let mut k: Vec<f64> = (0..ksize)
        .map(|i| (-((i as f64 - center).powi(2)) / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f64 = k.iter().sum();
    for v in k.iter_mut() {
        *v /= sum;
    }
    k.into_iter().map(|v| v as f32).collect()
}

/// Separable Gaussian blur, `BORDER_REPLICATE`, `f32` precision throughout
/// (matches `adaptiveThreshold`'s internal `convertTo(CV_32F)` step).
/// `ksize` must be odd.
fn gaussian_blur_replicate(gray: &GrayImage, ksize: u32) -> Vec<f32> {
    let (w, h) = gray.dimensions();
    let (w, h) = (w as usize, h as usize);
    let sigma = gaussian_sigma_for_ksize(ksize);
    let kernel = gaussian_kernel_1d(ksize, sigma);
    let r = (ksize / 2) as i64;
    let src = gray.as_raw();

    let clamp = |i: i64, len: usize| -> usize { i.clamp(0, len as i64 - 1) as usize };

    // Horizontal pass.
    let mut inter = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0f32;
            for (k, &kw) in kernel.iter().enumerate() {
                let sx = clamp(x as i64 + k as i64 - r, w);
                acc += kw * src[y * w + sx] as f32;
            }
            inter[y * w + x] = acc;
        }
    }
    // Vertical pass.
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0f32;
            for (k, &kw) in kernel.iter().enumerate() {
                let sy = clamp(y as i64 + k as i64 - r, h);
                acc += kw * inter[sy * w + x];
            }
            out[y * w + x] = acc;
        }
    }
    out
}

/// `cv2.adaptiveThreshold(gray, 255, ADAPTIVE_THRESH_GAUSSIAN_C,
/// THRESH_BINARY[_INV], block_size, c)`.
///
/// `inverted = true` ⇒ `THRESH_BINARY_INV` (foreground = `src <= mean - C`,
/// `textline.py:66-68`'s dark-text pass, `c = 15.0`);
/// `inverted = false` ⇒ `THRESH_BINARY` (foreground = `src > mean - C`,
/// `textline.py:85-87`'s light-text pass, `c = -15.0`). `block_size` must be
/// odd (the Python call sites guarantee this via `| 1`).
pub fn adaptive_threshold_gaussian(
    gray: &GrayImage,
    block_size: u32,
    c: f64,
    inverted: bool,
) -> GrayImage {
    debug_assert!(block_size % 2 == 1, "block_size must be odd");
    let (w, h) = gray.dimensions();
    let blurred = gaussian_blur_replicate(gray, block_size);
    let mut out = GrayImage::new(w, h);
    for (i, (src, dst)) in gray.pixels().zip(out.pixels_mut()).enumerate() {
        // `convertTo(CV_8U)`'s saturate_cast rounding of the f32 mean.
        let mean = (blurred[i] as f64).round_ties_even().clamp(0.0, 255.0);
        let thr = mean - c;
        let fg = if inverted {
            (src.0[0] as f64) <= thr
        } else {
            (src.0[0] as f64) > thr
        };
        dst.0[0] = if fg { 255 } else { 0 };
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

    /// `cv2.threshold(src, 0, 255, THRESH_BINARY+THRESH_OTSU)` ground truth.
    #[test]
    fn otsu_matches_opencv() {
        let src = gray_from(&[
            &[10, 12, 9, 11, 200, 210, 205, 195],
            &[11, 13, 8, 10, 198, 202, 208, 199],
            &[9, 11, 10, 12, 201, 199, 203, 197],
            &[12, 10, 11, 9, 205, 207, 200, 202],
        ]);
        assert_eq!(otsu_threshold(&src), 13);
        let dst = threshold_otsu(&src, false);
        // row0: [10,12,9,11,200,210,205,195] -> >13 ? 255:0
        assert_eq!(
            dst.as_raw(),
            &[
                0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255,
                255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255
            ]
        );
    }

    /// Degenerate uniform image — every histogram bin except one is empty,
    /// `q1`/`q2` never both clear `FLT_EPSILON`, so the loop never updates
    /// `max_val` and OpenCV returns threshold `0`.
    #[test]
    fn otsu_uniform_image_returns_zero() {
        let src = GrayImage::from_pixel(4, 4, image::Luma([100u8]));
        assert_eq!(otsu_threshold(&src), 0);
    }

    #[test]
    fn bitwise_not_matches_opencv() {
        let src = gray_from(&[&[0, 255, 10, 245], &[1, 254, 128, 127]]);
        let dst = bitwise_not(&src);
        assert_eq!(dst.as_raw(), &[255, 0, 245, 10, 254, 1, 127, 128]);
    }

    /// `cv2.adaptiveThreshold(src, 255, ADAPTIVE_THRESH_GAUSSIAN_C,
    /// THRESH_BINARY_INV, 9, 15)` ground truth — block=9 deliberately (>7,
    /// so it exercises the general σ-formula path, not `getGaussianKernel`'s
    /// small-table special case; see the module doc comment).
    #[test]
    fn adaptive_threshold_block9_dark_text_matches_opencv() {
        #[rustfmt::skip]
        let src_rows: [[u8; 13]; 13] = [
            [136, 38, 217, 22, 205, 251, 33, 198, 193, 255, 145, 167, 97],
            [86, 90, 112, 36, 22, 218, 110, 194, 18, 205, 219, 141, 136],
            [0, 22, 14, 182, 134, 178, 235, 129, 147, 51, 181, 1, 28],
            [24, 140, 83, 199, 134, 237, 98, 194, 249, 113, 68, 90, 188],
            [47, 13, 218, 194, 64, 151, 172, 183, 163, 130, 59, 201, 19],
            [209, 98, 131, 22, 14, 204, 32, 110, 189, 249, 214, 41, 126],
            [76, 115, 41, 16, 23, 128, 139, 158, 236, 94, 175, 146, 187],
            [46, 102, 120, 64, 237, 6, 206, 20, 200, 49, 88, 212, 164],
            [182, 160, 4, 103, 77, 129, 160, 210, 35, 62, 161, 139, 202],
            [151, 131, 113, 58, 81, 81, 115, 30, 81, 44, 58, 34, 56],
            [150, 23, 195, 68, 249, 141, 175, 191, 76, 227, 227, 83, 86],
            [16, 110, 250, 184, 219, 240, 162, 223, 211, 44, 185, 217, 70],
            [16, 194, 180, 161, 245, 115, 76, 42, 195, 9, 18, 194, 31],
        ];
        #[rustfmt::skip]
        let expected_inv15: [[u8; 13]; 13] = [
            [0, 255, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 255],
            [0, 0, 0, 255, 255, 0, 255, 0, 255, 0, 0, 0, 0],
            [255, 255, 255, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255],
            [255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0],
            [255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255],
            [0, 0, 0, 255, 255, 0, 255, 255, 0, 0, 0, 255, 0],
            [255, 0, 255, 255, 255, 0, 0, 0, 0, 255, 0, 0, 0],
            [255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0],
            [0, 0, 255, 0, 255, 0, 0, 0, 255, 255, 0, 0, 0],
            [0, 0, 0, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255],
            [0, 255, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 255],
            [255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 255],
            [255, 0, 0, 0, 0, 255, 255, 255, 0, 255, 255, 0, 255],
        ];
        #[rustfmt::skip]
        let expected_cneg15: [[u8; 13]; 13] = [
            [255, 0, 255, 0, 255, 255, 0, 255, 255, 255, 0, 255, 0],
            [0, 0, 0, 0, 0, 255, 0, 255, 0, 255, 255, 0, 255],
            [0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 255, 0, 0],
            [0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 0, 255],
            [0, 0, 255, 255, 0, 255, 255, 255, 0, 0, 0, 255, 0],
            [255, 0, 255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0],
            [0, 255, 0, 0, 0, 0, 0, 255, 255, 0, 255, 0, 255],
            [0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255],
            [255, 255, 0, 0, 0, 0, 255, 255, 0, 0, 255, 0, 255],
            [255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [255, 0, 255, 0, 255, 0, 255, 255, 0, 255, 255, 0, 0],
            [0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 0],
            [0, 255, 255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0],
        ];
        let rows: Vec<&[u8]> = src_rows.iter().map(|r| r.as_slice()).collect();
        let src = gray_from(&rows);

        let dst_inv = adaptive_threshold_gaussian(&src, 9, 15.0, true);
        let want_inv: Vec<u8> = expected_inv15.iter().flatten().copied().collect();
        assert_eq!(dst_inv.as_raw(), &want_inv);

        let dst_light = adaptive_threshold_gaussian(&src, 9, -15.0, false);
        let want_light: Vec<u8> = expected_cneg15.iter().flatten().copied().collect();
        assert_eq!(dst_light.as_raw(), &want_light);
    }

    /// Second, independent block-size case (11, still `>7`) at a different
    /// image size, guarding against a block-size-specific off-by-one in the
    /// σ formula or the replicate-border clamping.
    #[test]
    fn adaptive_threshold_block11_matches_opencv() {
        #[rustfmt::skip]
        let src_rows: [[u8; 17]; 17] = [
            [190, 54, 194, 90, 137, 52, 99, 17, 109, 170, 127, 248, 60, 147, 24, 114, 247],
            [149, 163, 228, 176, 25, 140, 173, 15, 36, 68, 199, 16, 197, 136, 194, 164, 215],
            [211, 49, 23, 242, 40, 93, 23, 7, 123, 119, 57, 68, 111, 127, 61, 185, 54],
            [11, 160, 250, 235, 139, 34, 132, 127, 39, 43, 226, 77, 190, 211, 75, 220, 174],
            [212, 200, 42, 236, 142, 187, 168, 190, 11, 75, 220, 93, 195, 183, 174, 247, 34],
            [125, 45, 105, 105, 74, 105, 83, 34, 49, 209, 231, 129, 114, 214, 94, 31, 58],
            [139, 19, 69, 207, 52, 120, 208, 174, 177, 203, 234, 49, 129, 48, 246, 69, 131],
            [118, 40, 137, 66, 33, 57, 9, 189, 175, 76, 204, 199, 121, 53, 191, 135, 84],
            [41, 187, 22, 58, 167, 16, 131, 144, 17, 238, 120, 171, 122, 230, 183, 240, 42],
            [48, 233, 111, 1, 220, 34, 41, 244, 101, 42, 213, 183, 59, 56, 161, 223, 146],
            [68, 179, 63, 216, 227, 24, 157, 66, 247, 79, 53, 107, 145, 196, 116, 250, 14],
            [213, 10, 92, 106, 111, 116, 9, 5, 206, 74, 30, 121, 215, 117, 200, 49, 99],
            [22, 18, 233, 229, 224, 222, 207, 73, 177, 168, 83, 61, 125, 6, 184, 174, 177],
            [210, 2, 163, 154, 209, 198, 35, 69, 60, 46, 213, 23, 47, 45, 51, 71, 222],
            [13, 206, 99, 126, 226, 1, 49, 224, 253, 203, 65, 224, 115, 201, 187, 244, 197],
            [199, 109, 170, 51, 170, 215, 159, 184, 120, 223, 183, 133, 180, 93, 113, 241, 70],
            [151, 219, 221, 199, 21, 225, 62, 142, 23, 129, 123, 117, 73, 105, 111, 129, 228],
        ];
        #[rustfmt::skip]
        let expected_inv15: [[u8; 17]; 17] = [
            [0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 255, 0, 255, 255, 0],
            [0, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 255, 0, 0, 0, 0, 0],
            [0, 255, 255, 0, 255, 255, 255, 255, 0, 0, 255, 255, 255, 0, 255, 0, 255],
            [255, 0, 0, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 0, 255, 0, 0],
            [0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 0, 255, 0, 0, 0, 0, 255],
            [0, 255, 0, 0, 255, 0, 255, 255, 255, 0, 0, 0, 255, 0, 255, 255, 255],
            [0, 255, 255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 0, 255, 0, 255, 0],
            [0, 255, 0, 255, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255],
            [255, 0, 255, 255, 0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255],
            [255, 0, 0, 255, 0, 255, 255, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0],
            [255, 0, 255, 0, 0, 255, 0, 255, 0, 255, 255, 255, 0, 0, 255, 0, 255],
            [0, 255, 255, 255, 255, 0, 255, 255, 0, 255, 255, 0, 0, 0, 0, 255, 255],
            [255, 255, 0, 0, 0, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 0, 0],
            [0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 0],
            [255, 0, 255, 255, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0],
            [0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 255],
            [0, 0, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 0],
        ];
        let rows: Vec<&[u8]> = src_rows.iter().map(|r| r.as_slice()).collect();
        let src = gray_from(&rows);
        let dst = adaptive_threshold_gaussian(&src, 11, 15.0, true);
        let want: Vec<u8> = expected_inv15.iter().flatten().copied().collect();
        assert_eq!(dst.as_raw(), &want);
    }
}
