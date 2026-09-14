//! Low-level image operations — all hand-rolled: `imageproc`/`image`
//! supply only the buffer types (`image::GrayImage`/`RgbImage`/
//! `RgbaImage`) here, not the algorithms. `resize` (no `INTER_AREA` in
//! `imageproc`) and `threshold`/`adaptiveThreshold` (`imageproc`'s
//! `adaptive_threshold` is mean-only, no Gaussian mode) have no usable
//! upstream equivalent. `hsv` is the narrow S/V-only `BGR2HSV` slice
//! `linesegs.detect_paper_region` needs (no H channel — nothing in the
//! ported pipeline reads it).
//!
//! `cc.rs` (connected components) and `contours.rs` (`findContours` +
//! contour geometry) live at the crate root, not under this module, but are
//! the same class of hand-rolled `cv2.*` primitive port — see their own doc
//! comments.

pub mod gray;
pub mod hsv;
pub mod morphology;
pub mod resize;
pub mod threshold;
