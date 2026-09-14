//! `cv2.dilate` with a rectangular all-ones kernel — the only morphology op
//! this crate needs.
//!
//! Call site: `linesegs.py:233`, `dilate(filled, np.ones((9,9), np.uint8))`
//! — feature-mask dilation so segments along the page edge survive
//! (`linesegs.detect_paper_region`). `saliency.py:174`'s `ones((7,7))`
//! dilate is scene-only and not ported.
//!
//! Semantics: a separable max filter, `BORDER_CONSTANT` with an effective
//! `-DBL_MAX` border value (i.e. the border never wins the max — equivalent
//! to treating out-of-bounds as background/0 for a binary mask).
//!
//! Port note: for a rectangular all-ones structuring element, 2-D dilation
//! is separable (max over a `kw×kh` box = max-over-rows of max-over-columns)
//! — computing it as two 1-D max-filter passes (verified pixel-exact against
//! `cv2.dilate` ground truth, see this module's tests) avoids an
//! `O(kw·kh)` window scan per pixel.

use image::GrayImage;

/// 1-D sliding-window max over `len` values with `BORDER_CONSTANT`/`0`
/// (out-of-bounds never wins — OpenCV's `-DBL_MAX` border value, equivalent to
/// "doesn't contribute" for a mask whose real values are already `>= 0`).
/// `radius = k/2` (kernel size `k`, either parity — OpenCV anchors an
/// even-sized rect kernel at `(k/2, k/2)` using integer division, same as
/// this crate's odd-kernel case since the only production kernel is `9×9`).
fn max_filter_1d(src: &[u8], len: usize, stride: usize, k: u32, out: &mut [u8]) {
    let radius_before = (k / 2) as i64;
    let radius_after = (k as i64 - 1) - radius_before;
    for i in 0..len {
        let lo = (i as i64 - radius_before).max(0);
        let hi = (i as i64 + radius_after).min(len as i64 - 1);
        let mut m = 0u8;
        let mut j = lo;
        while j <= hi {
            let v = src[j as usize * stride];
            if v > m {
                m = v;
            }
            j += 1;
        }
        out[i * stride] = m;
    }
}

/// Dilate a binary (0/1 or 0/255 — caller's choice, output matches input's
/// value convention) mask with a `kernel_w × kernel_h` all-ones rectangular
/// structuring element, one iteration, `BORDER_CONSTANT` (out-of-bounds
/// treated as background).
pub fn dilate_rect(mask: &GrayImage, kernel_w: u32, kernel_h: u32) -> GrayImage {
    let (w, h) = mask.dimensions();
    let (wu, hu) = (w as usize, h as usize);
    let src = mask.as_raw();

    // Horizontal pass (row-major, stride 1 within a row).
    let mut inter = vec![0u8; wu * hu];
    for y in 0..hu {
        let row_src = &src[y * wu..(y + 1) * wu];
        let row_dst = &mut inter[y * wu..(y + 1) * wu];
        max_filter_1d(row_src, wu, 1, kernel_w, row_dst);
    }
    // Vertical pass (column-major stride = w).
    let mut out = vec![0u8; wu * hu];
    for x in 0..wu {
        // Build a column slice view via a temporary contiguous buffer
        // (image crate storage is row-major, so a column isn't contiguous).
        let col: Vec<u8> = (0..hu).map(|y| inter[y * wu + x]).collect();
        let mut col_out = vec![0u8; hu];
        max_filter_1d(&col, hu, 1, kernel_h, &mut col_out);
        for y in 0..hu {
            out[y * wu + x] = col_out[y];
        }
    }
    GrayImage::from_raw(w, h, out).expect("dilate_rect: buffer length matches dims")
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

    /// `cv2.dilate(src, np.ones((3,3),u8))` ground truth.
    #[test]
    fn dilate_3x3_matches_opencv() {
        let src = gray_from(&[
            &[0, 0, 0, 0, 0, 0],
            &[0, 0, 1, 0, 0, 0],
            &[0, 0, 0, 0, 0, 0],
            &[0, 0, 0, 0, 1, 0],
            &[0, 0, 0, 0, 0, 0],
        ]);
        let dst = dilate_rect(&src, 3, 3);
        #[rustfmt::skip]
        let expected: &[u8] = &[
            0, 1, 1, 1, 0, 0,
            0, 1, 1, 1, 0, 0,
            0, 1, 1, 1, 1, 1,
            0, 0, 0, 1, 1, 1,
            0, 0, 0, 1, 1, 1,
        ];
        assert_eq!(dst.as_raw(), expected);
    }

    /// `cv2.dilate(src, np.ones((5,5),u8))` on corner-touching pixels — the
    /// case that exercises `BORDER_CONSTANT` clamping at all four edges
    /// *and* overlap between two nearby dilated regions (the (0,0) and
    /// (4,4) source pixels' 5×5 neighborhoods overlap at (2,2)).
    #[test]
    fn dilate_5x5_corners_matches_opencv() {
        let mut src = GrayImage::new(9, 9);
        src.put_pixel(0, 0, image::Luma([1]));
        src.put_pixel(4, 4, image::Luma([1]));
        src.put_pixel(8, 8, image::Luma([1]));
        let dst = dilate_rect(&src, 5, 5);
        #[rustfmt::skip]
        let expected: &[u8] = &[
            1, 1, 1, 0, 0, 0, 0, 0, 0,
            1, 1, 1, 0, 0, 0, 0, 0, 0,
            1, 1, 1, 1, 1, 1, 1, 0, 0,
            0, 0, 1, 1, 1, 1, 1, 0, 0,
            0, 0, 1, 1, 1, 1, 1, 0, 0,
            0, 0, 1, 1, 1, 1, 1, 0, 0,
            0, 0, 1, 1, 1, 1, 1, 1, 1,
            0, 0, 0, 0, 0, 0, 1, 1, 1,
            0, 0, 0, 0, 0, 0, 1, 1, 1,
        ];
        assert_eq!(dst.as_raw(), expected);
    }

    /// The real pipeline's own kernel size (`linesegs.py:233`), on an
    /// all-zero mask — must not panic and must stay all-zero.
    #[test]
    fn dilate_9x9_all_zero_stays_zero() {
        let src = GrayImage::new(20, 20);
        let dst = dilate_rect(&src, 9, 9);
        assert!(dst.as_raw().iter().all(|&v| v == 0));
    }
}
