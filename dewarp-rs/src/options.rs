//! Quality presets — mirrors `options.py` verbatim.
//!
//! Port note: only the `"default"` preset is exercised today. `"fast"` was
//! measured to land in different local minima on real photographs, and
//! `"high"` is future work tied to the `WASM_INPUT_MAX_SIDE` input cap.
//! All three presets' constants are carried here regardless, so that
//! enabling one is a configuration change rather than a port.

/// remap interpolation kind — `options.py:19`'s `interp: str` field
/// (`"linear" | "cubic" | "lanczos"`), `dewarp.py:93-97`'s `_INTERP` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interp {
    Linear,
    Cubic,
    Lanczos,
}

/// `options.py:28-45`'s `PRESETS` dict keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Fast,
    Default,
    High,
}

/// `options.QualityOptions` (`options.py:15-25`), field-for-field.
#[derive(Debug, Clone, PartialEq)]
pub struct QualityOptions {
    /// Maximum resized-image side for extraction/optimization.
    /// `dewarp.py:666`: `ratio = min(proc_max_side / max(w,h), 3.0)`.
    pub proc_max_side: u32,
    /// Inverse-map grid resolution per side (`dewarp.py:559-563`).
    pub render_grid: u32,
    /// Remap interpolation.
    pub interp: Interp,
    /// Maximum `least_squares` evaluations per solve (`lsq.py:43` budget;
    /// boundary solves cap at `min(max_nfev, 600)`, `optimize.py:915`).
    pub max_nfev: u32,
    /// Outlier-removal iterations (`optimize.py:795`).
    pub n_outlier_iter: u32,
    /// `false` reduces the coarse-stage pose candidates from 7 to 3
    /// (`optimize.py:703-719`).
    pub full_pose_multistart: bool,
    /// Try multiple initial `f` values (FOV 71°/53°/37°) without EXIF
    /// (`optimize.py:723-724`).
    pub f_scan: bool,
    /// EXIF-derived focal length, in **full-size** pixels — set by the
    /// caller, not by a preset (`options.py:24`; converted to processing
    /// pixels at `dewarp.py:745`). Always `None` today — `f_exif_px` is
    /// reserved, but unused, in the wasm ABI's `opts_json`.
    pub f_exif_px: Option<f64>,
    /// Refine trusted rectangular paper boundaries (§S1b/S5 gate,
    /// `dewarp.py:688-696`).
    pub use_page_boundary: bool,
}

impl Default for QualityOptions {
    /// `options.py:36`: `"default": QualityOptions()` — every field at its
    /// dataclass default.
    fn default() -> Self {
        preset(Preset::Default)
    }
}

/// `options.py:28-45`'s `PRESETS` table, field-for-field:
///
/// | Field | fast | default | high |
/// |---|---|---|---|
/// | `proc_max_side` | 1200 | 1600 | 2200 |
/// | `render_grid` | 65 | 129 | 257 |
/// | `interp` | linear | linear | cubic |
/// | `max_nfev` | 300 | 600 | 1200 |
/// | `n_outlier_iter` | 2 | 3 | 4 |
/// | `full_pose_multistart` | false | true | true |
/// | `f_scan` | false | false | true |
///
/// (`use_page_boundary` is `true` in every preset.)
pub fn preset(which: Preset) -> QualityOptions {
    match which {
        Preset::Fast => QualityOptions {
            proc_max_side: 1200,
            render_grid: 65,
            interp: Interp::Linear,
            max_nfev: 300,
            n_outlier_iter: 2,
            full_pose_multistart: false,
            f_scan: false,
            f_exif_px: None,
            use_page_boundary: true,
        },
        Preset::Default => QualityOptions {
            proc_max_side: 1600,
            render_grid: 129,
            interp: Interp::Linear,
            max_nfev: 600,
            n_outlier_iter: 3,
            full_pose_multistart: true,
            f_scan: false,
            f_exif_px: None,
            use_page_boundary: true,
        },
        Preset::High => QualityOptions {
            proc_max_side: 2200,
            render_grid: 257,
            interp: Interp::Cubic,
            max_nfev: 1200,
            n_outlier_iter: 4,
            full_pose_multistart: true,
            f_scan: true,
            f_exif_px: None,
            use_page_boundary: true,
        },
    }
}

/// Individually-settable overrides — mirrors `make_options`'s `**overrides`
/// kwargs (`options.py:48-52`, `None` values dropped, everything else
/// `dataclasses.replace`d onto the preset). Field set matches what the wasm
/// ABI's `opts_json` is allowed to override — **do not** add fields the
/// Python reference doesn't have, since this struct is the Rust-side mirror
/// of that JSON shape.
#[derive(Debug, Clone, Default)]
pub struct QualityOptionsOverrides {
    pub f_exif_px: Option<f64>,
    pub max_nfev: Option<u32>,
    pub n_outlier_iter: Option<u32>,
}

/// `options.make_options(preset, **overrides)` (`options.py:48-52`).
pub fn make_options(which: Preset, overrides: QualityOptionsOverrides) -> QualityOptions {
    let mut opts = preset(which);
    if let Some(v) = overrides.f_exif_px {
        opts.f_exif_px = Some(v);
    }
    if let Some(v) = overrides.max_nfev {
        opts.max_nfev = v;
    }
    if let Some(v) = overrides.n_outlier_iter {
        opts.n_outlier_iter = v;
    }
    opts
}

// ---------------------------------------------------------------------------
// Hard-coded pipeline constants worth freezing here that are not themselves
// QualityOptions fields. Each is also re-documented at its point of use in
// the owning module (model.rs/optimize.rs/linesegs.rs/pipeline.rs) —
// duplicated here only as a single review-facing checklist, not as the
// canonical definition site.
// ---------------------------------------------------------------------------

/// EXIF orientation/focal-length parsing — `options.py:55-127`
/// (`_exif_f35`, `read_exif_focal_px`). Port note: the browser host has
/// almost certainly already decoded (and possibly EXIF-rotated) the image
/// before this crate ever sees bytes — the wasm ABI takes RGBA8 from an
/// already-decoded `ImageData` — so **this parser is not reachable from the
/// wasm ABI** (`opts_json.f_exif_px` is always `null`). It lives here
/// because `options.rs` is its natural home and a future EXIF seam may
/// resurrect it.
pub mod exif {
    /// `_exif_f35` (`options.py:55-112`): hand-rolled JPEG APP1/Exif parser
    /// reading tag `0xA405 FocalLengthIn35mmFilm`. Operates on raw JPEG
    /// bytes, not a decoded image — unreachable today, per this module's
    /// doc comment.
    pub fn exif_focal_length_35mm(_jpeg_bytes: &[u8]) -> Option<f64> {
        todo!()
    }

    /// `read_exif_focal_px` (`options.py:115-127`):
    /// `f_px = f35 / 43.266 * hypot(img_w, img_h)`.
    pub fn read_exif_focal_px(jpeg_bytes: &[u8], img_w: u32, img_h: u32) -> Option<f64> {
        todo!()
    }
}
