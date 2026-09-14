//! `cv2.cvtColor(..., BGR2HSV)` — **only** the S and V channels, which is
//! all `linesegs.detect_paper_region` uses (`linesegs.py:211-212`:
//! `hsv = cvtColor(img_bgr, COLOR_BGR2HSV); sat, val = hsv[:,:,1], hsv[:,:,2]`).
//! Only S and V are ever used: `V = max(B,G,R)`, `S = 255·(V−min)/V`.
//!
//! Not registered as a fully general BGR2HSV port (no H channel) — the H
//! channel is never read anywhere in the ported pipeline scope
//! (the ported pipeline has exactly one `BGR2HSV` call site, and it only
//! destructures channels 1 and 2), so computing it would be dead code.
//!
//! Port note: verified against `cv2.cvtColor` ground truth (opencv-python-
//! headless 5.0.0) for a spread of RGB triples including pure channels,
//! greys, and generic values — `V = max(r,g,b)` (exact integer max);
//! `S = round(255*(V-min)/V)` when `V != 0`, else `0`; round-half-to-even
//! (same `saturate_cast` convention as every other primitive in this
//! module).

/// `(S, V)` for one RGB triple (the wasm ABI is RGBA — alpha
/// ignored, same convention as `gray.rs`). Channel order doesn't matter to
/// the formula (it's a max/min over the three color channels), so this
/// works identically whether called on RGB or BGR triples.
pub fn rgb_to_hsv_sv(r: u8, g: u8, b: u8) -> (u8, u8) {
    let v = r.max(g).max(b);
    let vmin = r.min(g).min(b);
    let s = if v == 0 {
        0
    } else {
        let diff = (v - vmin) as f64;
        (255.0 * diff / v as f64).round_ties_even() as u8
    };
    (s, v)
}

/// S/V planes for a full RGB image, row-major, one byte each per pixel.
/// `img` is `width*height*3` (RGB, alpha already stripped — see
/// [`rgb_to_hsv_sv`]'s doc comment).
pub fn rgb_to_hsv_sv_planes(img: &[u8], width: u32, height: u32) -> (Vec<u8>, Vec<u8>) {
    let n = (width as usize) * (height as usize);
    assert_eq!(img.len(), n * 3);
    let mut s = vec![0u8; n];
    let mut v = vec![0u8; n];
    for i in 0..n {
        let (si, vi) = rgb_to_hsv_sv(img[i * 3], img[i * 3 + 1], img[i * 3 + 2]);
        s[i] = si;
        v[i] = vi;
    }
    (s, v)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cv2.cvtColor(bgr, COLOR_BGR2HSV)[:, :, 1:3]` ground truth.
    #[test]
    fn matches_opencv_sv() {
        let cases: &[((u8, u8, u8), (u8, u8))] = &[
            ((255, 0, 0), (255, 255)),
            ((0, 255, 0), (255, 255)),
            ((0, 0, 255), (255, 255)),
            ((255, 255, 255), (0, 255)),
            ((0, 0, 0), (0, 0)),
            ((128, 64, 32), (191, 128)),
            ((17, 201, 99), (233, 201)),
            ((200, 200, 200), (0, 200)),
            ((10, 250, 130), (245, 250)),
        ];
        for &((r, g, b), (s, v)) in cases {
            assert_eq!(rgb_to_hsv_sv(r, g, b), (s, v), "r={r} g={g} b={b}");
        }
    }
}
