//! RGB(A)→grayscale — `cv2.cvtColor(..., BGR2GRAY)` (`dewarp.py:674`).
//!
//! Port note: OpenCV's `BGR2GRAY` is **fixed-point**,
//! not a naive float `0.299R+0.587G+0.114B`:
//! `gray = (B*3735 + G*19235 + R*9798 + 16384) >> 15`. Match the integer
//! form for bit-parity: this is the very first stage, and it feeds
//! everything downstream.
//!
//! The wasm ABI hands this crate **RGBA8**, not BGR — the
//! coefficients apply per-channel (R gets 9798, G gets 19235, B gets 3735)
//! regardless of byte order in memory, so `rgba_to_gray` below reads R/G/B
//! by name from an RGBA buffer; there is no BGR anywhere in this crate.
//! Alpha is read in and ignored, matching `sampler.ts`'s own
//! alpha-ignored behavior.

use image::{GrayImage, RgbaImage};

/// OpenCV's fixed-point `BGR2GRAY` weights, applied to a single RGB triple.
/// `(b*3735 + g*19235 + r*9798 + 16384) >> 15`.
///
/// Verified byte-exact against `cv2.cvtColor(..., BGR2GRAY)` for a spread of
/// RGB triples (ground truth generated via a throwaway
/// opencv-python-headless docker rig, not checked in — see this module's
/// tests).
pub fn rgb_to_gray_pixel(r: u8, g: u8, b: u8) -> u8 {
    let acc = (b as u32) * 3735 + (g as u32) * 19235 + (r as u32) * 9798 + 16384;
    (acc >> 15) as u8
}

/// Convert a full RGBA image to grayscale, alpha ignored.
pub fn rgba_to_gray(img: &RgbaImage) -> GrayImage {
    let (w, h) = img.dimensions();
    let mut out = GrayImage::new(w, h);
    for (src, dst) in img.pixels().zip(out.pixels_mut()) {
        let [r, g, b, _a] = src.0;
        dst.0[0] = rgb_to_gray_pixel(r, g, b);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)` ground truth for a spread of
    /// (r, g, b) triples covering pure channels, greys, and generic values.
    #[test]
    fn matches_opencv_fixed_point_gray() {
        let cases: &[((u8, u8, u8), u8)] = &[
            ((255, 0, 0), 76),
            ((0, 255, 0), 150),
            ((0, 0, 255), 29),
            ((255, 255, 255), 255),
            ((0, 0, 0), 0),
            ((128, 64, 32), 79),
            ((17, 201, 99), 134),
            ((1, 2, 3), 2),
            ((254, 253, 252), 253),
        ];
        for &((r, g, b), expected) in cases {
            assert_eq!(rgb_to_gray_pixel(r, g, b), expected, "r={r} g={g} b={b}");
        }
    }

    #[test]
    fn rgba_image_alpha_is_ignored() {
        let mut img = RgbaImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgba([255, 0, 0, 0]));
        img.put_pixel(1, 0, image::Rgba([255, 0, 0, 255]));
        let gray = rgba_to_gray(&img);
        assert_eq!(gray.get_pixel(0, 0).0[0], 76);
        assert_eq!(gray.get_pixel(1, 0).0[0], 76);
    }
}
