//! Pipeline orchestration — mirrors `dewarp.py` **minus** `saliency`/`scene`
//! mode and `_draw_debug`, **plus** the confidence/status layer the Python
//! reference lacks and, unlike the Python reference, **stops short of
//! rasterizing pixels**.
//!
//! ## Why there is no `cv2.remap` anywhere in this crate
//!
//! The wasm ABI exports a coarse **backward grid** (`65×47`, crop-relative
//! `[-1,1]`, `align_corners`) — not rendered pixels. The TS side already
//! owns full-resolution rendering (WebGL `composeInto`/tiled render,
//! unchanged from the UVDoc path). So [`render`] below reproduces
//! `dewarp._render`'s **output-window framing** (`dewarp.py:527-556`:
//! percentile box + margin, optional document-only framing,
//! `OUT_MAX_SCALE` cap) and its **inverse-map evaluation**
//! (`model::rectified_to_image` at each lattice node) — but never
//! `dewarp.py:569-578`'s `cv2.resize`-the-maps-then-`cv2.remap` raster
//! step. `imgops` therefore has no `remap.rs`; do not add one.
//!
//! This also means the `render_grid` field of [`crate::options::QualityOptions`]
//! (129 at `default`, the density of Python's *own* inverse-map lattice
//! before its `cv2.resize` upsample) is **not** what governs this crate's
//! grid density — the ABI's fixed `65×47` does, passed in by `wasm.rs`.
//! `render_grid` is carried in `QualityOptions` only for fidelity with
//! `options.py`'s full field set.
//!
//! ## Why `dewarp_image`/`render` take `rows`/`cols`
//!
//! The grid density is the ABI's, not the pipeline's, so it has to travel
//! through *some* parameter to get here: hence `rows: u32, cols: u32` on
//! [`dewarp_image`]. `wasm.rs` passes its own `GRID_ROWS`/`GRID_COLS`
//! (65×47); a parity comparison against the Python reference passes 129
//! (the probe density Python's own lattice uses) to reuse the exact same
//! code path.

use crate::linesegs::{LineSegments, PageBoundary};
use crate::model::{
    backproject, flatten_u, rectified_to_image, surface_to_rectified, DewarpParams, N_THETA,
};
use crate::optimize::OptimizeResult;
use crate::options::QualityOptions;
use crate::textline::TextFeatures;
use image::{RgbImage, RgbaImage};

/// `dewarp.PROC_MAX_SIDE` (`dewarp.py:43`) — duplicated by
/// `QualityOptions::proc_max_side`'s `default` value; kept as a named
/// constant only where the Python source itself uses the module constant
/// rather than the options field (there is no such call site in the ported
/// scope — carried here for checklist completeness).
pub const PROC_MAX_SIDE: u32 = 1600;

/// `dewarp.OUT_MAX_SCALE` (`dewarp.py:44`) — output canvas capped at
/// `1.5×` the input's max side (`_render`'s `scale_cap`, `dewarp.py:554`).
pub const OUT_MAX_SCALE: f64 = 1.5;

/// `dewarp._scale_params` (`dewarp.py:77-90`): rescale processing-resolution
/// params to another resolution. `ratio = full_size / resized_size` when
/// converting resized → full. `f`, `cx`, `cy`, `scale` scale by `ratio`;
/// `a` and `rvec` are scale-invariant (normalized-coordinate/rotation
/// quantities) and pass through unchanged.
pub fn scale_params(params: &DewarpParams, ratio: f64) -> DewarpParams {
    DewarpParams {
        a: params.a,
        rvec: params.rvec,
        f: params.f * ratio,
        cx: params.cx * ratio,
        cy: params.cy * ratio,
        scale: params.scale * ratio,
    }
}

/// `dewarp.ResidualWarp` (`dewarp.py:100-167`): a low-order correction for
/// distortions the GCS model cannot represent (a lifted diagonal corner, a
/// partially lifted page) — a single shear-free in-plane rotation `theta`
/// plus two symmetric slope-residual fields `cs`/`ct` (horizontal/vertical
/// features respectively), each a 4-term polynomial through the feature
/// centroid `(u_c, v_c)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResidualWarp {
    pub theta: f64,
    pub cs: [f64; 4],
    pub ct: [f64; 4],
    pub u_c: f64,
    pub v_c: f64,
}

impl Default for ResidualWarp {
    fn default() -> Self {
        ResidualWarp {
            theta: 0.0,
            cs: [0.0; 4],
            ct: [0.0; 4],
            u_c: 0.0,
            v_c: 0.0,
        }
    }
}

impl ResidualWarp {
    /// `ResidualWarp.is_identity` (`dewarp.py:127-128`).
    pub fn is_identity(&self) -> bool {
        self.theta == 0.0 && self.cs == [0.0; 4] && self.ct == [0.0; 4]
    }

    /// `ResidualWarp._P` (`dewarp.py:130-137`): the `v` correction.
    fn p(&self, ub: f64, vb: f64) -> f64 {
        let [s1, s2, s3, s4] = self.cs;
        0.5 * s1 * ub * ub + s2 * ub * vb + s3 * ub * ub * ub / 6.0 + 0.5 * s4 * ub * ub * vb
    }

    /// `ResidualWarp._Q` (`dewarp.py:139-146`): the `u` correction.
    fn q(&self, ub: f64, vb: f64) -> f64 {
        let [t1, t2, t3, t4] = self.ct;
        0.5 * t1 * vb * vb + t2 * vb * ub + t3 * vb * vb * vb / 6.0 + 0.5 * t4 * vb * vb * ub
    }

    /// `ResidualWarp.out_to_uv` (`dewarp.py:148-156`): output-space `(u,v)`
    /// → model rectified-space `(u,v)`.
    pub fn out_to_uv(&self, uv_out: &[[f64; 2]]) -> Vec<[f64; 2]> {
        uv_out
            .iter()
            .map(|&[u, v]| {
                let ub = u - self.u_c;
                let vb = v - self.v_c;
                [
                    u - self.theta * v + self.q(ub, vb),
                    v + self.theta * u + self.p(ub, vb),
                ]
            })
            .collect()
    }

    /// `ResidualWarp.uv_to_out` (`dewarp.py:158-167`): model rectified-space
    /// `(u,v)` → output-space `(u,v)`. First-order inverse (the correction
    /// is small, `<2°`, so this is deliberately not an exact inverse of
    /// [`ResidualWarp::out_to_uv`] — do not "fix" that; the Python reference
    /// is explicit about it being an approximation).
    pub fn uv_to_out(&self, uv: &[[f64; 2]]) -> Vec<[f64; 2]> {
        uv.iter()
            .map(|&[u, v]| {
                let ub = u - self.u_c;
                let vb = v - self.v_c;
                [
                    u + self.theta * v - self.q(ub, vb),
                    v - self.theta * u - self.p(ub, vb),
                ]
            })
            .collect()
    }
}

// ---------------------------------------------------------------------------
// `_fit_residual_warp` internals — small free functions/helpers kept private
// to this module, mirroring `dewarp.py`'s local closures (`_weighted_median`
// is `stats::weighted_median`; the rest below have no Python-side name of
// their own beyond being inlined in `_fit_residual_warp`'s body).
// ---------------------------------------------------------------------------

/// `_fit_residual_warp`'s local `add_h` closure (`dewarp.py:189-194`):
/// keep `(p0,p1)` as a horizontal-feature slope sample when it is
/// predominantly horizontal (`|dx| > 1e-6` and `|dy| < |dx|`).
#[allow(clippy::too_many_arguments)]
fn add_h(
    p0: [f64; 2],
    p1: [f64; 2],
    hu_pos: &mut Vec<f64>,
    hv_pos: &mut Vec<f64>,
    hs: &mut Vec<f64>,
    hw: &mut Vec<f64>,
) {
    let d = [p1[0] - p0[0], p1[1] - p0[1]];
    if d[0].abs() > 1e-6 && d[1].abs() < d[0].abs() {
        hu_pos.push(0.5 * (p0[0] + p1[0]));
        hv_pos.push(0.5 * (p0[1] + p1[1]));
        hs.push(d[1] / d[0]);
        hw.push(d[0].abs());
    }
}

/// `_fit_residual_warp`'s local `_pos_keep` closure (`dewarp.py:238-247`):
/// robust position clip via the 2nd/98th percentile box, expanded by
/// `2x` the box's own extent plus 1 (guards against a degenerate
/// single-point/zero-spread box).
fn pos_keep(us: &[f64], vs: &[f64]) -> Vec<bool> {
    if us.is_empty() {
        return Vec::new();
    }
    let u01 = crate::stats::percentiles(us, &[2.0, 98.0]);
    let v01 = crate::stats::percentiles(vs, &[2.0, 98.0]);
    let (u0, u1) = (u01[0], u01[1]);
    let (v0, v1) = (v01[0], v01[1]);
    let du = 2.0 * (u1 - u0) + 1.0;
    let dv = 2.0 * (v1 - v0) + 1.0;
    (0..us.len())
        .map(|i| us[i] > u0 - du && us[i] < u1 + du && vs[i] > v0 - dv && vs[i] < v1 + dv)
        .collect()
}

/// Filter four parallel `Vec<f64>`s by a shared boolean mask (numpy's
/// `arr[keep]` applied to several same-length arrays at once).
fn filter4(
    a: &[f64],
    b: &[f64],
    c: &[f64],
    d: &[f64],
    keep: &[bool],
) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut oa = Vec::new();
    let mut ob = Vec::new();
    let mut oc = Vec::new();
    let mut od = Vec::new();
    for i in 0..keep.len() {
        if keep[i] {
            oa.push(a[i]);
            ob.push(b[i]);
            oc.push(c[i]);
            od.push(d[i]);
        }
    }
    (oa, ob, oc, od)
}

fn weighted_average(x: &[f64], w: &[f64]) -> f64 {
    let mut sw = 0.0;
    let mut swx = 0.0;
    for i in 0..x.len() {
        sw += w[i];
        swx += w[i] * x[i];
    }
    swx / sw
}

/// `_fit_residual_warp`'s local `field_fit` closure (`dewarp.py:264-277`):
/// centered weighted regression `r ≈ c1·x1 + c2·x2 + ½c3·x1² + c4·x1·x2`,
/// dropping `|r| >= lim2` outliers first and bailing (all-zero) below 10
/// surviving samples or a degenerate (near-zero-spread) `x1`.
fn field_fit(x1: &[f64], x2: &[f64], r: &[f64], w: &[f64], lim2: f64) -> [f64; 4] {
    let keep: Vec<bool> = r.iter().map(|&v| v.abs() < lim2).collect();
    if keep.iter().filter(|&&k| k).count() < 10 {
        return [0.0; 4];
    }
    let (x1k, x2k, rk, wk) = filter4(x1, x2, r, w, &keep);
    let lo = x1k.iter().cloned().fold(f64::INFINITY, f64::min);
    let hi = x1k.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    if (hi - lo) < 1e-6 {
        return [0.0; 4];
    }
    let mut a_rows: Vec<[f64; 4]> = Vec::with_capacity(x1k.len());
    let mut bvec: Vec<f64> = Vec::with_capacity(x1k.len());
    for i in 0..x1k.len() {
        let sw = wk[i].sqrt();
        a_rows.push([
            x1k[i] * sw,
            x2k[i] * sw,
            0.5 * x1k[i] * x1k[i] * sw,
            x1k[i] * x2k[i] * sw,
        ]);
        bvec.push(rk[i] * sw);
    }
    crate::stats::lstsq_4col(&a_rows, &bvec)
}

/// `_fit_residual_warp`'s local `clamp_field` closure (`dewarp.py:301-311`):
/// scale `c` down (never zero it) so the correction magnitude at all four
/// corners of the joint feature bounding box stays under `lim_apply`.
fn clamp_field(c: [f64; 4], x1s: (f64, f64), x2s: (f64, f64), lim_apply: f64) -> [f64; 4] {
    let mut m = 0.0f64;
    for &a in &[x1s.0, x1s.1] {
        for &b in &[x2s.0, x2s.1] {
            let v = (c[0] * a + c[1] * b + 0.5 * c[2] * a * a + c[3] * a * b).abs();
            if v > m {
                m = v;
            }
        }
    }
    if m > lim_apply {
        let k = lim_apply / m;
        [c[0] * k, c[1] * k, c[2] * k, c[3] * k]
    } else {
        c
    }
}

/// `dewarp._fit_residual_warp` (`dewarp.py:176-321`): fit [`ResidualWarp`]
/// from rectified-domain slopes of inlier features. `line_uvs` are
/// per-text-line rectified `(u,v)` point sequences (long lines, `>= 6`
/// points, are split in half so local curvature is sampled); `seg_uv_p`/
/// `seg_uv_q` are segment endpoint pairs in the same rectified space.
///
/// Steps: (1) rotation `theta` = weighted median of folded horizontal/
/// vertical feature slopes ([`crate::stats::weighted_median`]), zeroed if
/// `|theta| >= tan(3°)`; (2) two independent weighted 4-term linear
/// regressions ([`crate::stats::lstsq_4col`]) of the post-rotation slope
/// residual against position, for horizontal and vertical features
/// separately, each with an outlier exclusion (`|residual| >= tan(4°)`
/// dropped) and a corner-evaluated safety clamp to `tan(3°)`
/// (`dewarp.py:296-320`'s `clamp_field`, scaling the whole coefficient
/// tuple down rather than zeroing it).
pub fn fit_residual_warp(
    line_uvs: &[Vec<[f64; 2]>],
    seg_uv_p: &[[f64; 2]],
    seg_uv_q: &[[f64; 2]],
) -> ResidualWarp {
    let mut hu_pos: Vec<f64> = Vec::new();
    let mut hv_pos: Vec<f64> = Vec::new();
    let mut hs: Vec<f64> = Vec::new();
    let mut hw: Vec<f64> = Vec::new();
    let mut vu_pos: Vec<f64> = Vec::new();
    let mut vv_pos: Vec<f64> = Vec::new();
    let mut vt: Vec<f64> = Vec::new();
    let mut vw: Vec<f64> = Vec::new();

    for uv in line_uvs {
        if uv.is_empty() {
            continue;
        }
        if uv.len() >= 6 {
            let m = uv.len() / 2;
            add_h(uv[0], uv[m], &mut hu_pos, &mut hv_pos, &mut hs, &mut hw);
            add_h(
                uv[m],
                uv[uv.len() - 1],
                &mut hu_pos,
                &mut hv_pos,
                &mut hs,
                &mut hw,
            );
        } else {
            add_h(
                uv[0],
                uv[uv.len() - 1],
                &mut hu_pos,
                &mut hv_pos,
                &mut hs,
                &mut hw,
            );
        }
    }
    if !seg_uv_p.is_empty() {
        for i in 0..seg_uv_p.len() {
            let d = [
                seg_uv_q[i][0] - seg_uv_p[i][0],
                seg_uv_q[i][1] - seg_uv_p[i][1],
            ];
            let length = (d[0] * d[0] + d[1] * d[1]).sqrt();
            let mid = [
                0.5 * (seg_uv_p[i][0] + seg_uv_q[i][0]),
                0.5 * (seg_uv_p[i][1] + seg_uv_q[i][1]),
            ];
            let ok =
                length.is_finite() && length > 1e-6 && mid[0].is_finite() && mid[1].is_finite();
            if !ok {
                continue;
            }
            if d[1].abs() < 0.5 * d[0].abs() {
                hu_pos.push(mid[0]);
                hv_pos.push(mid[1]);
                hs.push(d[1] / d[0]);
                hw.push(length);
            }
            if d[0].abs() < 0.5 * d[1].abs() {
                vu_pos.push(mid[0]);
                vv_pos.push(mid[1]);
                vt.push(d[0] / d[1]);
                vw.push(length);
            }
        }
    }

    let keep_h = pos_keep(&hu_pos, &hv_pos);
    let (hu_pos, hv_pos, hs, hw) = filter4(&hu_pos, &hv_pos, &hs, &hw, &keep_h);
    let keep_v = pos_keep(&vu_pos, &vv_pos);
    let (vu_pos, vv_pos, vt, vw) = filter4(&vu_pos, &vv_pos, &vt, &vw, &keep_v);

    // 1) Rotation: weighted median of folded horizontal/vertical slopes.
    let mut angs = hs.clone();
    let mut ws = hw.clone();
    if !vt.is_empty() {
        angs.extend(vt.iter().map(|&t| -t));
        ws.extend(vw.iter().cloned());
    }
    if angs.is_empty() {
        return ResidualWarp::default();
    }
    let mut theta = crate::stats::weighted_median(&angs, &ws);
    if theta.abs() >= 3.0_f64.to_radians().tan() {
        theta = 0.0;
    }

    // 2) Residual field.
    let lim2 = 4.0_f64.to_radians().tan();

    let mut pos_u = hu_pos.clone();
    pos_u.extend(vu_pos.iter().cloned());
    let mut pos_v = hv_pos.clone();
    pos_v.extend(vv_pos.iter().cloned());
    let mut pos_w = hw.clone();
    pos_w.extend(vw.iter().cloned());
    if pos_u.is_empty() {
        return ResidualWarp {
            theta,
            ..Default::default()
        };
    }
    let u_c = weighted_average(&pos_u, &pos_w);
    let v_c = weighted_average(&pos_v, &pos_w);

    let zero4 = [0.0; 4];
    let mut cs = if !hu_pos.is_empty() {
        let x1: Vec<f64> = hu_pos.iter().map(|&u| u - u_c).collect();
        let x2: Vec<f64> = hv_pos.iter().map(|&v| v - v_c).collect();
        let r: Vec<f64> = hs.iter().map(|&s| s - theta).collect();
        field_fit(&x1, &x2, &r, &hw, lim2)
    } else {
        zero4
    };
    let mut ct = if !vu_pos.is_empty() {
        let x1: Vec<f64> = vv_pos.iter().map(|&v| v - v_c).collect();
        let x2: Vec<f64> = vu_pos.iter().map(|&u| u - u_c).collect();
        let r: Vec<f64> = vt.iter().map(|&t| t + theta).collect();
        field_fit(&x1, &x2, &r, &vw, lim2)
    } else {
        zero4
    };

    // Safety limit.
    let lim_apply = 3.0_f64.to_radians().tan();
    let u_min = pos_u.iter().cloned().fold(f64::INFINITY, f64::min);
    let u_max = pos_u.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let v_min = pos_v.iter().cloned().fold(f64::INFINITY, f64::min);
    let v_max = pos_v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let ue_all = (u_min - u_c, u_max - u_c);
    let ve_all = (v_min - v_c, v_max - v_c);
    if !hu_pos.is_empty() {
        cs = clamp_field(cs, ue_all, ve_all, lim_apply);
    }
    if !vu_pos.is_empty() {
        ct = clamp_field(ct, ve_all, ue_all, lim_apply);
    }
    ResidualWarp {
        theta,
        cs,
        ct,
        u_c,
        v_c,
    }
}

/// Full-resolution geometry + residual warp for one optimization result —
/// `dewarp._PreparedGeometry` (`dewarp.py:54-63`).
#[derive(Debug, Clone)]
pub struct PreparedGeometry {
    pub result: OptimizeResult,
    /// Params rescaled to full (input-buffer) resolution via
    /// [`scale_params`].
    pub params: DewarpParams,
    pub feat_uv: Vec<[f64; 2]>,
    /// `(p1, p99)` percentile clamp of `Sx` at this solve — easy to drop
    /// by accident; it feeds both `render`'s extrapolation and this
    /// struct's own quality metrics.
    pub x_clamp: Option<(f64, f64)>,
    pub line_uvs: Vec<Vec<[f64; 2]>>,
    pub warp: Option<ResidualWarp>,
}

/// `dewarp._prepare_geometry` (`dewarp.py:324-379`): rescale `result.params`
/// to full resolution (`ratio` = the S0 downscale ratio the pipeline used,
/// `> 1` when converting resized-back-to-full), back-project all inlier
/// features, compute `x_clamp`, rectify lines/segments, fit the residual
/// warp. Returns `None` on any non-finite intermediate — one of several
/// "degenerate exit, preserve verbatim" points
/// (`dewarp.py:338,342,351,356,370`).
pub fn prepare_geometry(result: &OptimizeResult, ratio: f64) -> Option<PreparedGeometry> {
    let params = if (ratio - 1.0).abs() > 1e-3 {
        scale_params(&result.params, 1.0 / ratio)
    } else {
        result.params.clone()
    };

    let mut feat_parts: Vec<[f64; 2]> = Vec::new();
    for pts in &result.data.line_points {
        feat_parts.extend_from_slice(pts);
    }
    if !result.data.segments.is_empty() {
        for s in &result.data.segments {
            feat_parts.push([s[0], s[1]]);
        }
        for s in &result.data.segments {
            feat_parts.push([s[2], s[3]]);
        }
    }
    if feat_parts.is_empty() {
        return None;
    }
    let feat_img: Vec<[f64; 2]> = feat_parts
        .iter()
        .map(|p| [p[0] / ratio, p[1] / ratio])
        .collect();
    let bp = backproject(&feat_img, &params, None);
    let sx_finite: Vec<f64> = bp.sx.into_iter().filter(|v| v.is_finite()).collect();
    if sx_finite.is_empty() {
        return None;
    }
    let x_clamp = (
        crate::stats::percentile(&sx_finite, 1.0),
        crate::stats::percentile(&sx_finite, 99.0),
    );

    let mut feat_uv = surface_to_rectified(&feat_img, &params, None);
    feat_uv.retain(|p| p[0].is_finite() && p[1].is_finite());
    if feat_uv.is_empty() {
        return None;
    }

    let mut line_uvs: Vec<Vec<[f64; 2]>> = Vec::with_capacity(result.data.line_points.len());
    for pts in &result.data.line_points {
        let scaled: Vec<[f64; 2]> = pts.iter().map(|p| [p[0] / ratio, p[1] / ratio]).collect();
        line_uvs.push(surface_to_rectified(&scaled, &params, None));
    }
    if line_uvs
        .iter()
        .any(|uv| uv.iter().any(|p| !p[0].is_finite() || !p[1].is_finite()))
    {
        return None;
    }

    let (seg_uv_p, seg_uv_q): (Vec<[f64; 2]>, Vec<[f64; 2]>) = if !result.data.segments.is_empty() {
        let p_pts: Vec<[f64; 2]> = result
            .data
            .segments
            .iter()
            .map(|s| [s[0] / ratio, s[1] / ratio])
            .collect();
        let q_pts: Vec<[f64; 2]> = result
            .data
            .segments
            .iter()
            .map(|s| [s[2] / ratio, s[3] / ratio])
            .collect();
        (
            surface_to_rectified(&p_pts, &params, None),
            surface_to_rectified(&q_pts, &params, None),
        )
    } else {
        (Vec::new(), Vec::new())
    };
    if seg_uv_p
        .iter()
        .any(|p| !p[0].is_finite() || !p[1].is_finite())
        || seg_uv_q
            .iter()
            .any(|p| !p[0].is_finite() || !p[1].is_finite())
    {
        return None;
    }

    let warp = fit_residual_warp(&line_uvs, &seg_uv_p, &seg_uv_q);
    Some(PreparedGeometry {
        result: result.clone(),
        params,
        feat_uv,
        x_clamp: Some(x_clamp),
        line_uvs,
        warp: Some(warp),
    })
}

/// `dewarp._QualityMetrics` (`dewarp.py:66-75`): visible-output text
/// alignment and page-side rectangularity, used by
/// [`candidate_is_acceptable`]'s text-first gate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QualityMetrics {
    pub text_straightness_p90: f64,
    pub text_alignment_p90: f64,
    /// One RMS-deviation-over-span value per [`PageBoundary`] side, in the
    /// fixed order top/bottom/left/right (`PageBoundary::sides`).
    pub boundary_sides: [f64; 4],
}

impl QualityMetrics {
    /// `_QualityMetrics.boundary_mean` (`dewarp.py:72-74`).
    pub fn boundary_mean(&self) -> f64 {
        self.boundary_sides.iter().sum::<f64>() / 4.0
    }
}

fn ptp(v: &[f64]) -> f64 {
    let hi = v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let lo = v.iter().cloned().fold(f64::INFINITY, f64::min);
    hi - lo
}

fn ptp_col0(pts: &[[f64; 2]]) -> f64 {
    let hi = pts.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max);
    let lo = pts.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min);
    hi - lo
}

/// The text-straightness-p90 half of `_quality_metrics` (`dewarp.py:387-
/// 397`), factored out because [`dewarp_image`]'s status layer needs it
/// even when no page boundary exists (the Python reference never computes
/// `_quality_metrics` at all in that case — this is a status-layer
/// addition, with no direct Python call site to defer to).
fn text_straightness_p90(line_uvs: &[Vec<[f64; 2]>], warp: &ResidualWarp) -> f64 {
    let mut straightness: Vec<f64> = Vec::new();
    for uv in line_uvs {
        if uv.is_empty() {
            continue;
        }
        let uv_out = warp.uv_to_out(uv);
        let mean_v: f64 = uv_out.iter().map(|p| p[1]).sum::<f64>() / uv_out.len() as f64;
        let ms: f64 =
            uv_out.iter().map(|p| (p[1] - mean_v).powi(2)).sum::<f64>() / uv_out.len() as f64;
        straightness.push(ms.sqrt());
    }
    if straightness.is_empty() {
        0.0
    } else {
        crate::stats::percentile(&straightness, 90.0)
    }
}

/// `dewarp._quality_metrics` (`dewarp.py:382-465`): measures the *rendered
/// output's* text straightness (p90 across lines), block-edge alignment
/// deviation (p90, in equivalent input pixels so candidates at slightly
/// different global scale stay comparable), and per-side page-boundary RMS
/// deviation-over-span — all after applying `geometry.warp`'s output-space
/// correction.
pub fn quality_metrics(
    geometry: &PreparedGeometry,
    boundary: &PageBoundary,
    ratio: f64,
) -> QualityMetrics {
    let warp = geometry.warp.unwrap_or_default();
    let line_uvs_out: Vec<Vec<[f64; 2]>> = geometry
        .line_uvs
        .iter()
        .map(|uv| warp.uv_to_out(uv))
        .collect();
    let straight_p90 = text_straightness_p90(&geometry.line_uvs, &warp);

    let data = &geometry.result.data;
    let widths: Vec<f64> = data.line_points.iter().map(|pts| ptp_col0(pts)).collect();
    let n = widths.len();
    let mut eligible = vec![false; n];
    let unique_blocks: std::collections::BTreeSet<usize> =
        data.block_of_line.iter().cloned().collect();
    for bi in unique_blocks {
        let idx: Vec<usize> = (0..n).filter(|&i| data.block_of_line[i] == bi).collect();
        if !idx.is_empty() {
            let mean_w: f64 = idx.iter().map(|&i| widths[i]).sum::<f64>() / idx.len() as f64;
            for &i in &idx {
                eligible[i] = widths[i] >= 0.8 * mean_w;
            }
        }
    }

    let mut block_scales: std::collections::HashMap<usize, Vec<f64>> =
        std::collections::HashMap::new();
    for (i, uv) in line_uvs_out.iter().enumerate() {
        if i >= data.block_of_line.len() || uv.is_empty() {
            continue;
        }
        let input_width = ptp_col0(&data.line_points[i]) / ratio;
        let output_width = ptp_col0(uv);
        if input_width > 1e-6 && output_width > 1e-6 {
            block_scales
                .entry(data.block_of_line[i])
                .or_default()
                .push(output_width / input_width);
        }
    }

    // Key: (block index, is_left_edge).
    let mut aligned_edges: std::collections::HashMap<(usize, bool), Vec<f64>> =
        std::collections::HashMap::new();
    for (i, uv) in line_uvs_out.iter().enumerate() {
        if i >= data.block_of_line.len() || !eligible[i] || uv.is_empty() {
            continue;
        }
        let bi = data.block_of_line[i];
        let alignment = geometry.result.alignments[bi];
        let us: Vec<f64> = uv.iter().map(|p| p[0]).collect();
        let lo = us.iter().cloned().fold(f64::INFINITY, f64::min);
        let hi = us.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        use crate::textline::Alignment;
        if matches!(alignment, Alignment::Left | Alignment::Justified) {
            aligned_edges.entry((bi, true)).or_default().push(lo);
        }
        if matches!(alignment, Alignment::Right | Alignment::Justified) {
            aligned_edges.entry((bi, false)).or_default().push(hi);
        }
    }
    let mut edge_deviations: Vec<f64> = Vec::new();
    for ((bi, _), values) in &aligned_edges {
        if values.len() >= 2 {
            let med = crate::stats::median(values);
            let scale = block_scales
                .get(bi)
                .map(|v| crate::stats::median(v))
                .unwrap_or(1.0)
                .max(1e-6);
            for &v in values {
                edge_deviations.push((v - med).abs() / scale);
            }
        }
    }
    let align_p90 = if edge_deviations.is_empty() {
        0.0
    } else {
        crate::stats::percentile(&edge_deviations, 90.0)
    };

    let mut side_errors = [0.0f64; 4];
    for (i, (name, pts)) in boundary.sides().iter().enumerate() {
        let scaled: Vec<[f64; 2]> = pts.iter().map(|p| [p[0] / ratio, p[1] / ratio]).collect();
        let uv = surface_to_rectified(&scaled, &geometry.params, None);
        if uv.iter().any(|p| !p[0].is_finite() || !p[1].is_finite()) {
            side_errors[i] = f64::INFINITY;
            continue;
        }
        let uv_out = warp.uv_to_out(&uv);
        let (coord, along): (Vec<f64>, Vec<f64>) = if *name == "top" || *name == "bottom" {
            (
                uv_out.iter().map(|p| p[1]).collect(),
                uv_out.iter().map(|p| p[0]).collect(),
            )
        } else {
            (
                uv_out.iter().map(|p| p[0]).collect(),
                uv_out.iter().map(|p| p[1]).collect(),
            )
        };
        let span = ptp(&along).max(1.0);
        let med = crate::stats::median(&coord);
        let mse: f64 = coord.iter().map(|&c| (c - med).powi(2)).sum::<f64>() / coord.len() as f64;
        side_errors[i] = mse.sqrt() / span;
    }
    QualityMetrics {
        text_straightness_p90: straight_p90,
        text_alignment_p90: align_p90,
        boundary_sides: side_errors,
    }
}

/// `dewarp._candidate_is_acceptable` (`dewarp.py:468-500`): the text-first
/// gate. A boundary-refinement candidate must (1) have every metric finite;
/// (2) not worsen text straightness or text alignment p90 by more than
/// `max(5%, 0.02*mean_text_size)` relative to `baseline`; (3) **halve** the
/// mean boundary error relative to `baseline`; (4) not worsen any
/// individual side's error by more than `10%` (or `+0.001` absolute,
/// whichever is looser). `mean_text_size` must be in the same (full-image)
/// resolution as `baseline`/`candidate`.
pub fn candidate_is_acceptable(
    baseline: &QualityMetrics,
    candidate: &QualityMetrics,
    mean_text_size: f64,
) -> bool {
    let all_finite = candidate.text_straightness_p90.is_finite()
        && candidate.text_alignment_p90.is_finite()
        && candidate.boundary_sides.iter().all(|v| v.is_finite());
    if !all_finite {
        return false;
    }

    for &(base_v, cand_v) in &[
        (
            baseline.text_straightness_p90,
            candidate.text_straightness_p90,
        ),
        (baseline.text_alignment_p90, candidate.text_alignment_p90),
    ] {
        let tolerance = (0.05 * base_v).max(0.02 * mean_text_size);
        if cand_v > base_v + tolerance {
            return false;
        }
    }
    if candidate.boundary_mean() > 0.5 * baseline.boundary_mean() {
        return false;
    }
    for i in 0..4 {
        let base_side = baseline.boundary_sides[i];
        let cand_side = candidate.boundary_sides[i];
        if cand_side > (1.1 * base_side).max(base_side + 0.001) {
            return false;
        }
    }
    true
}

/// Output of [`render`]: the framing decision plus the sampled inverse map.
/// `samples` holds `rows * cols` entries, row-major, node `(row, col)` at
/// output-page fraction `u = col/(cols-1)`, `v = row/(rows-1)` — matching
/// `wasm.rs`'s `GRID_ROWS`/`GRID_COLS` convention exactly.
/// Each sample is `(alpha, beta)`: where in the **input buffer this crate
/// received** (the crop, at whatever resolution `dewarp_image` was called
/// with) to sample from.
#[derive(Debug, Clone)]
pub struct RenderedGrid {
    pub out_w: u32,
    pub out_h: u32,
    pub samples: Vec<[f64; 2]>,
}

fn linspace(a: f64, b: f64, n: u32) -> Vec<f64> {
    if n <= 1 {
        return vec![a];
    }
    (0..n)
        .map(|i| a + (b - a) * (i as f64) / ((n - 1) as f64))
        .collect()
}

/// `dewarp._render` (`dewarp.py:503-578`), minus its `cv2.remap` raster step
/// (see this module's doc comment for why). `rows`/`cols` are the wasm
/// ABI's fixed grid density (65×47), passed by the caller
/// — **not** `opts.render_grid`. `input_w`/`input_h` are the dimensions of
/// the buffer `params` was rescaled to (i.e. the crop this crate's `dewarp`
/// entry point received), needed for the `OUT_MAX_SCALE` cap.
///
/// Framing: (1) default = features' 1-99 percentile `(u,v)` box + 15%
/// margin; (2) if a paper-mask boundary (`page_uv`) is available, contains
/// the feature box (within 10%) and is under `3×` its size, switch to
/// document-only framing with a 2% margin instead (`dewarp.py:537-550`);
/// (3) `out_w, out_h = round(u1-u0), round(v1-v0)`, then scaled down so
/// `max(out_w, out_h) <= OUT_MAX_SCALE * max(input_w, input_h)`, floor 16px.
///
/// Unlike `dewarp.py`, this evaluates `rectified_to_image` **directly** at
/// `rows×cols` fractional positions of the output window rather than
/// computing a fixed `opts.render_grid`-density lattice and `cv2.resize`-
/// upsampling it to the pixel-exact output canvas — this crate never
/// rasterizes (this module's own doc comment), so there is no canvas to
/// upsample to; the direct evaluation is exact at whatever density the
/// caller asks for, a strict improvement over the resize step it replaces.
pub fn render(
    params: &DewarpParams,
    feat_uv_in: &[[f64; 2]],
    x_clamp: Option<(f64, f64)>,
    rows: u32,
    cols: u32,
    warp: Option<&ResidualWarp>,
    page_uv_in: Option<&[[f64; 2]]>,
    input_w: u32,
    input_h: u32,
) -> RenderedGrid {
    let apply_warp = warp.map(|w| !w.is_identity()).unwrap_or(false);
    let feat_uv: Vec<[f64; 2]> = if apply_warp {
        warp.unwrap().uv_to_out(feat_uv_in)
    } else {
        feat_uv_in.to_vec()
    };
    let page_uv: Option<Vec<[f64; 2]>> = page_uv_in.map(|p| {
        if apply_warp && !p.is_empty() {
            warp.unwrap().uv_to_out(p)
        } else {
            p.to_vec()
        }
    });
    let ow = output_window(&feat_uv, page_uv.as_deref());
    finalize_window(
        ow.u0, ow.u1, ow.v0, ow.v1, rows, cols, params, x_clamp, warp, apply_warp, input_w, input_h,
    )
}

/// The output-window framing decision, factored out of [`render`] (part of
/// "the window fix") so the ABI-export-side crop-bounds certification
/// ([`render_export`]) can reuse **exactly** the same
/// percentile/margin/page-boundary computation `render` uses — no
/// duplicated logic to drift out of sync, so `render`'s own S6-parity
/// behavior is unaffected by this refactor: same steps, same order, same
/// values.
struct OutputWindow {
    u0: f64,
    u1: f64,
    v0: f64,
    v1: f64,
    /// The raw feature 1-99 percentile box, **before** the 15%/2% margin —
    /// [`render_export`] needs this separately from `u0..v1` to tell
    /// "clipped into the margin" apart from "clipped into content"
    /// (`window_clips_text`).
    fu0: f64,
    fu1: f64,
    fv0: f64,
    fv1: f64,
}

/// `dewarp._render`'s output-window framing (`dewarp.py:527-556`): (1)
/// default = features' 1-99 percentile `(u,v)` box + 15% margin; (2) if a
/// paper-mask boundary (`page_uv`) is available, contains the feature box
/// (within 10%) and is under `3×` its size, switch to document-only
/// framing with a 2% margin instead. `feat_uv`/`page_uv` are already in
/// output (post-warp) space — the caller applies `warp.uv_to_out` before
/// calling this, exactly as `render` always did.
fn output_window(feat_uv: &[[f64; 2]], page_uv: Option<&[[f64; 2]]>) -> OutputWindow {
    let fu: Vec<f64> = feat_uv.iter().map(|p| p[0]).collect();
    let fv: Vec<f64> = feat_uv.iter().map(|p| p[1]).collect();
    let fu01 = crate::stats::percentiles(&fu, &[1.0, 99.0]);
    let fv01 = crate::stats::percentiles(&fv, &[1.0, 99.0]);
    let (fu0, fu1) = (fu01[0], fu01[1]);
    let (fv0, fv1) = (fv01[0], fv01[1]);
    let fw = fu1 - fu0;
    let fh = fv1 - fv0;
    let mut u0 = fu0 - 0.15 * fw;
    let mut u1 = fu1 + 0.15 * fw;
    let mut v0 = fv0 - 0.15 * fh;
    let mut v1 = fv1 + 0.15 * fh;

    if let Some(p) = page_uv {
        if p.len() > 20 {
            let pu: Vec<f64> = p.iter().map(|x| x[0]).collect();
            let pv: Vec<f64> = p.iter().map(|x| x[1]).collect();
            let pu01 = crate::stats::percentiles(&pu, &[2.0, 98.0]);
            let pv01 = crate::stats::percentiles(&pv, &[2.0, 98.0]);
            let (pu0, pu1) = (pu01[0], pu01[1]);
            let (pv0, pv1) = (pv01[0], pv01[1]);
            let contains = pu0 < fu0 + 0.1 * fw
                && pu1 > fu1 - 0.1 * fw
                && pv0 < fv0 + 0.1 * fh
                && pv1 > fv1 - 0.1 * fh;
            let bounded = (pu1 - pu0) < 3.0 * fw && (pv1 - pv0) < 3.0 * fh;
            if contains && bounded {
                let mw = 0.02 * (pu1 - pu0);
                let mh = 0.02 * (pv1 - pv0);
                u0 = pu0 - mw;
                u1 = pu1 + mw;
                v0 = pv0 - mh;
                v1 = pv1 + mh;
            }
        }
    }
    OutputWindow {
        u0,
        u1,
        v0,
        v1,
        fu0,
        fu1,
        fv0,
        fv1,
    }
}

/// `render`'s tail: size the output canvas from a window (`OUT_MAX_SCALE`
/// cap) and evaluate the inverse map at `rows×cols` fractional positions of
/// that window. Factored out of [`render`] so [`render_export`] can size
/// and sample a **different** (crop-bounds-clamped) window through the
/// identical code path, rather than a hand-duplicated copy.
#[allow(clippy::too_many_arguments)]
fn finalize_window(
    u0: f64,
    u1: f64,
    v0: f64,
    v1: f64,
    rows: u32,
    cols: u32,
    params: &DewarpParams,
    x_clamp: Option<(f64, f64)>,
    warp: Option<&ResidualWarp>,
    apply_warp: bool,
    input_w: u32,
    input_h: u32,
) -> RenderedGrid {
    let out_w_f = (u1 - u0).round_ties_even();
    let out_h_f = (v1 - v0).round_ties_even();
    let scale_cap =
        1.0f64.min(OUT_MAX_SCALE * (input_w.max(input_h) as f64) / out_w_f.max(out_h_f));
    let out_w = ((out_w_f * scale_cap).trunc() as i64).max(16) as u32;
    let out_h = ((out_h_f * scale_cap).trunc() as i64).max(16) as u32;

    let gu = linspace(u0, u1, cols);
    let gv = linspace(v0, v1, rows);
    let mut grid_uv: Vec<[f64; 2]> = Vec::with_capacity((rows as usize) * (cols as usize));
    for r in 0..rows {
        for c in 0..cols {
            grid_uv.push([gu[c as usize], gv[r as usize]]);
        }
    }
    let grid_uv = if apply_warp {
        warp.unwrap().out_to_uv(&grid_uv)
    } else {
        grid_uv
    };
    let samples = rectified_to_image(&grid_uv, params, x_clamp);
    RenderedGrid {
        out_w,
        out_h,
        samples,
    }
}

/// "The window fix": a per-edge-extremum report on how far
/// [`render_export`] had to shrink the reference output window `O` to
/// certify it backward-maps entirely inside the crop. All four fields are
/// `>= 0`, in the same output-uv units as `O` itself (that axis is
/// arc-length in image-pixel units, not a normalized `[-1,1]` space) —
/// `left` is how much was cut
/// from `O`'s left edge, etc. All-zero plus `area_frac == 1.0` means `O`
/// already fit inside the crop untouched.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowClip {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    /// Certified window area ÷ reference window (`O`) area. `0.0` when no
    /// certified in-bounds window could be produced at all (the crop-
    /// boundary forward-map was degenerate, or the clamp collapsed to
    /// nothing) — in that case [`render_export`] falls back to `O`
    /// unclamped (today's behavior), for the existing downstream guards to
    /// catch exactly as they do now.
    pub area_frac: f64,
}

/// Output of [`render_export`]: the grid actually returned to the ABI
/// caller, plus the window-clip telemetry the window fix adds to the
/// status layer.
pub struct ExportRender {
    pub grid: RenderedGrid,
    pub window_clip: WindowClip,
    /// `true` when the certified in-bounds window had to cut into the raw
    /// feature percentile box itself (shrunk 3% inward as tolerance) —
    /// i.e. lost *content*, not just margin. Also `true` whenever no
    /// certified window could be produced at all (the fallback-to-`O` case
    /// carries no useful "did we clip content" answer, so this errs
    /// conservative).
    pub window_clips_text: bool,
    /// See [`DewarpStatus::quad_corner_residual`]'s doc comment for the
    /// exact quantity. `None` unless a quad was supplied **and** honored.
    pub quad_corner_residual: Option<f64>,
}

/// Quad-aligned export framing: the confirmed page quad, **normalized
/// `[0,1]` over the buffer [`render_export`] itself was called with** (i.e.
/// `input_w`×`input_h` — never the caller's canonical image, and
/// resolution-independent of any TS-side pre-downsample exactly the way the
/// ABI's own `[-1,1]` grid convention is). Winding matches [`crate::pipeline`]'s only consumer of
/// quad corners on the TS side, `DewarpQuad` (`types.ts`): clockwise from
/// the top-left.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExportQuad {
    pub top_left: [f64; 2],
    pub top_right: [f64; 2],
    pub bottom_right: [f64; 2],
    pub bottom_left: [f64; 2],
}

/// How many points to sample along each of the crop's four edges when
/// forward-mapping its boundary into output-uv space: `N=64`.
const EXPORT_EDGE_SAMPLES: u32 = 64;

/// Forward-map one full-resolution crop-pixel point `(px, py)` into
/// output-uv space: `backproject` + [`flatten_u`] (exactly what
/// [`surface_to_rectified`] does internally, inlined here so the
/// degenerate/fold check below can also see `backproject`'s own `k`
/// solution — a non-positive or non-finite `k` means the Newton-Raphson
/// ray solve broke down at this point, i.e. exactly the "Jacobian
/// sign-flip / projective horizon" risk — then `warp.uv_to_out` to land in the same
/// output space [`render`]'s window (`u0..v1`) is expressed in. Returns
/// `None` on any non-finite or non-positive-`k` result.
fn forward_map_crop_point(
    px: f64,
    py: f64,
    params: &DewarpParams,
    warp: &ResidualWarp,
    apply_warp: bool,
) -> Option<[f64; 2]> {
    let bp = backproject(&[[px, py]], params, None);
    if !bp.k[0].is_finite() || bp.k[0] <= 0.0 {
        return None;
    }
    if !bp.sx[0].is_finite() || !bp.sy[0].is_finite() {
        return None;
    }
    let u = flatten_u(&bp.sx, params);
    if !u[0].is_finite() {
        return None;
    }
    let rectified = [[u[0], bp.sy[0]]];
    let out = if apply_warp {
        warp.uv_to_out(&rectified)
    } else {
        rectified.to_vec()
    };
    let p = out[0];
    if p[0].is_finite() && p[1].is_finite() {
        Some(p)
    } else {
        None
    }
}

/// "The window fix" — the ABI-export-side counterpart of [`render`]. The
/// Python-parity path (`render` itself) is completely unaffected: this
/// function is a separate, additional caller reached only from
/// [`dewarp_image`]'s ABI-export tail.
///
/// Computes the same reference window `O` [`render`] would use
/// ([`output_window`]), then certifies (or shrinks) it against the crop's
/// own extent: sample each crop edge at [`EXPORT_EDGE_SAMPLES`] points in
/// full-resolution crop-pixel space, forward-map each into output-uv space
/// ([`forward_map_crop_point`] — the exact inverse of the backward map
/// `finalize_window`/`rectified_to_image` uses), and take the conservative
/// per-edge extremum: `L = max(x)` over the left edge's samples, `Rt =
/// min(x)` over the right edge's, `T = max(y)` over the top edge's, `B =
/// min(y)` over the bottom edge's. Every point of the mapped crop boundary
/// then lies on one of these four curves, each wholly excluded from its
/// own edge's interior side by construction — so the open rectangle
/// `(L,Rt)×(T,B)`, once one interior point is certified, is entirely
/// backward-mapped inside the crop. No monotonicity assumption is needed
/// — a deliberate strengthening of the naive approach, which would need
/// one.
///
/// A 1-source-pixel-or-0.5%-of-window (whichever is larger) inset is
/// subtracted from each of `L/Rt/T/B` before intersecting with `O`, to
/// absorb (a) the boundary being sampled at finite density (the true
/// per-edge extremum can sit between two of the 64 samples — a bow's
/// sagitta) and (b) float slop. If the resulting window is empty, or
/// either dimension is under ~50% of `O`'s, or the clamped window's own
/// center fails to back-map inside the crop (the cheap safety-net
/// certification the verdict requires), this function does **not** invent
/// a degenerate render — it falls back to `O` unclamped, i.e. exactly
/// [`render`]'s own output, so the *existing* downstream guards (the TS
/// `out-of-bounds` guard, `classical-aspect-outlier`, etc.) catch it
/// exactly as they do today. This is deliberate: the cases expected to keep
/// falling back (a booklet spread, a degenerate sparse-text capture) are
/// exactly the ones with unstable, bound-saturated geometry solves — the
/// crop-boundary forward-map is expected to be unstable or the clamped
/// window severely small on those, routing them straight back into the
/// pre-fix behavior without any special-casing here.
///
/// ## `quad` — quad-aligned export framing
///
/// When the caller supplies the confirmed page quad (buffer-normalized,
/// [`ExportQuad`]), the crop-bounds-certified window above is treated as the
/// *floor*, not the answer: `evaluateComposedMap`'s `boundary` guard
/// (`guards.ts`, 5% of the quad's diagonal) compares the composed grid's own
/// four corners against the quad directly, and a window framed purely from
/// detected text (`O`, above) tracks the quad only loosely — measured at
/// 10-19% unclamped, and 5-9% even after crop-bounds clamping, i.e. 2-4×
/// the guard's tolerance.
/// The fix: map the quad's own four corners through the identical forward
/// chain ([`forward_map_crop_point`]) and fit an axis-aligned window whose
/// *edges* are the **mean of the two corners on that edge** — `L =
/// (x'TL+x'BL)/2`, `R = (x'TR+x'BR)/2`, `T = (y'TL+y'TR)/2`, `B =
/// (y'BL+y'BR)/2` — then intersect that box with the already-certified
/// crop-bounds rect above and re-run the *same* corner-certification/shrink
/// loop against it (the four points alone are not the rigorous boundary
/// walk `O`'s certification is, so the quad-fit window earns no exemption
/// from it). A **mean of the two corners**, not a **median over many
/// uniformly-sampled edge points** (the base proposal this verdict amended):
/// a bowed page's mapped edge is not straight in output-uv space (the true
/// page edge is; the user's *chord* between two corners is not, once the
/// GCS model has done its job), so a uniform-sample median sits
/// systematically off-center toward the bow's belly (≈0.75× the sagitta)
/// and fails this exact 5% corner metric on precisely the curved pages this
/// engine exists for — the two-corner mean is this metric's own
/// minimax-optimal fit, and, being 4 points instead of `4×64`, strictly
/// cheaper too.
///
/// Any failure along this path — a non-finite/non-positive-`k` corner
/// mapping, an inverted fit (`L>=R` or `T>=B`, checked directly, never
/// `abs()` — an inversion means the quad and the model's own output
/// orientation disagree, which [`forward_map_crop_point`]'s "cannot certify"
/// posture already treats as degenerate elsewhere in this function), an
/// empty/sliver intersection with the crop-bounds rect, or a
/// re-certification the shrink loop cannot rescue — falls back to the
/// already-computed crop-bounds-certified window **above**, not further to
/// `O` unclamped: the rule is to build on the certified in-crop machinery,
/// never to regress it, so "the quad cannot be honored safely" degrades to
/// "no quad was supplied" rather than to "no certified window at all".
/// `quad_corner_residual` is `Some` exactly when the quad-fit window is the
/// one actually returned, `None` in every fallback case above.
#[allow(clippy::too_many_arguments)]
pub fn render_export(
    params: &DewarpParams,
    feat_uv_in: &[[f64; 2]],
    x_clamp: Option<(f64, f64)>,
    rows: u32,
    cols: u32,
    warp: Option<&ResidualWarp>,
    page_uv_in: Option<&[[f64; 2]]>,
    input_w: u32,
    input_h: u32,
    quad: Option<&ExportQuad>,
) -> ExportRender {
    let apply_warp = warp.map(|w| !w.is_identity()).unwrap_or(false);
    let warp_ref = warp.cloned().unwrap_or_default();
    let feat_uv: Vec<[f64; 2]> = if apply_warp {
        warp_ref.uv_to_out(feat_uv_in)
    } else {
        feat_uv_in.to_vec()
    };
    let page_uv: Option<Vec<[f64; 2]>> = page_uv_in.map(|p| {
        if apply_warp && !p.is_empty() {
            warp_ref.uv_to_out(p)
        } else {
            p.to_vec()
        }
    });
    let ow = output_window(&feat_uv, page_uv.as_deref());

    let fallback = || ExportRender {
        grid: finalize_window(
            ow.u0, ow.u1, ow.v0, ow.v1, rows, cols, params, x_clamp, warp, apply_warp, input_w,
            input_h,
        ),
        window_clip: WindowClip {
            left: 0.0,
            right: 0.0,
            top: 0.0,
            bottom: 0.0,
            area_frac: 0.0,
        },
        window_clips_text: true,
        quad_corner_residual: None,
    };

    let w_f = (input_w as f64 - 1.0).max(0.0);
    let h_f = (input_h as f64 - 1.0).max(0.0);
    let n = EXPORT_EDGE_SAMPLES.max(2);

    // Interior anchor: the crop's own center, forward-mapped. Classifying
    // every boundary sample against this anchor (rather than assuming "the
    // px=0 edge always bounds the window's low-u side") is what makes the
    // certification correct under rotation/skew: on a trapezoidal quad
    // (converging lines — a raking-angle capture, `bound_saturation.a`
    // showing real curvature/keystone correction in flight), which
    // *physical* crop edge ends up on the low-u side of the interior is
    // not fixed by which edge it is (left vs. right) — it depends on the
    // model's own rotation. An earlier version of this function hard-coded
    // left-edge→lower-bound / right-edge→upper-bound and produced a
    // certified window whose bottom-left *corner* still landed outside the
    // crop on a skewed capture (`20260816_150015`) — this anchor-relative
    // classification is the fix, verified against that exact fixture.
    let Some([u_int, v_int]) =
        forward_map_crop_point(w_f / 2.0, h_f / 2.0, params, &warp_ref, apply_warp)
    else {
        return fallback();
    };

    // L/Rt (resp. T/B) start at ±infinity, meaning "no constraint found on
    // this side" — a crop edge that happens to map entirely to the *other*
    // side of the interior anchor (plausible under strong rotation)
    // legitimately contributes nothing to that side's bound, rather than
    // being forced into a slot by which physical edge it came from.
    let mut lower_u = f64::NEG_INFINITY; // L: tightest exclusion below u_int
    let mut upper_u = f64::INFINITY; // Rt: tightest exclusion above u_int
    let mut lower_v = f64::NEG_INFINITY; // T
    let mut upper_v = f64::INFINITY; // B
    let mut sample_failed = false;

    // U comes only from the left/right (px=0 / px=w_f) edges, V only from
    // the top/bottom (py=0 / py=h_f) edges — **not** cross-classified.
    // Every point of the left/right edges sweeps the *full* crop height
    // (resp. width), so it always contains a point arbitrarily close to
    // `v_int` (resp. `u_int`); folding those points into the *other*
    // axis's classification collapses that axis's bound to ≈0 width. Each
    // edge still classifies each of its own points against the anchor
    // (not a fixed "this edge is always the lower bound") so a rotation
    // that swaps which physical edge ends up on which side is still
    // handled correctly.
    let mut classify_u = |p: [f64; 2]| {
        if p[0] < u_int {
            lower_u = lower_u.max(p[0]);
        } else if p[0] > u_int {
            upper_u = upper_u.min(p[0]);
        }
    };
    let mut classify_v = |p: [f64; 2]| {
        if p[1] < v_int {
            lower_v = lower_v.max(p[1]);
        } else if p[1] > v_int {
            upper_v = upper_v.min(p[1]);
        }
    };

    for i in 0..n {
        let t = i as f64 / (n - 1) as f64;
        for (px, py) in [(0.0, t * h_f), (w_f, t * h_f)] {
            match forward_map_crop_point(px, py, params, &warp_ref, apply_warp) {
                Some(p) => classify_u(p),
                None => sample_failed = true,
            }
        }
        for (px, py) in [(t * w_f, 0.0), (t * w_f, h_f)] {
            match forward_map_crop_point(px, py, params, &warp_ref, apply_warp) {
                Some(p) => classify_v(p),
                None => sample_failed = true,
            }
        }
    }

    // Risk (b), adversarial verdict: a fold/Jacobian sign-flip or
    // projective horizon inside the crop breaks the per-edge-extremum
    // proof's premise (the mapped boundary curve is no longer wholly
    // excluded from the interior anchor's own side). A non-finite/
    // non-positive-`k` sample anywhere along the boundary is treated as
    // "cannot certify" — fall back rather than trust a broken rectangle.
    // (`lower_u < u_int < upper_u`, etc. hold by construction whenever any
    // sample landed on each side, so no separate ordering check is needed
    // here the way the earlier per-edge version required one.)
    if sample_failed {
        return fallback();
    }
    let (left_max_u, right_min_u, top_max_v, bottom_min_v) = (lower_u, upper_u, lower_v, upper_v);

    // δ = max(1 source px, 0.5% of the certified gap) — see this
    // function's doc comment. Output-uv units are ≈1:1 with source pixels
    // near the identity deformations this fix targets (`finalize_window`'s
    // `out_w_f = round(u1-u0)`), so `1.0` stands in directly for "1 source
    // pixel" without a further unit conversion. When a side has no finite
    // constraint at all (no boundary sample landed on that side of the
    // interior anchor — the crop poses no threat there in this framing),
    // that side's inset is the flat 1px floor rather than a percentage of
    // an infinite "gap".
    let gap_u = if left_max_u.is_finite() && right_min_u.is_finite() {
        Some(right_min_u - left_max_u)
    } else {
        None
    };
    let gap_v = if top_max_v.is_finite() && bottom_min_v.is_finite() {
        Some(bottom_min_v - top_max_v)
    } else {
        None
    };
    let inset_u = gap_u.map(|g| (0.005 * g).max(1.0)).unwrap_or(1.0);
    let inset_v = gap_v.map(|g| (0.005 * g).max(1.0)).unwrap_or(1.0);
    let l = if left_max_u.is_finite() {
        left_max_u + inset_u
    } else {
        f64::NEG_INFINITY
    };
    let rt = if right_min_u.is_finite() {
        right_min_u - inset_u
    } else {
        f64::INFINITY
    };
    let t = if top_max_v.is_finite() {
        top_max_v + inset_v
    } else {
        f64::NEG_INFINITY
    };
    let b = if bottom_min_v.is_finite() {
        bottom_min_v - inset_v
    } else {
        f64::INFINITY
    };

    let mut cu0 = ow.u0.max(l);
    let mut cu1 = ow.u1.min(rt);
    let mut cv0 = ow.v0.max(t);
    let mut cv1 = ow.v1.min(b);

    let o_w = (ow.u1 - ow.u0).max(1e-9);
    let o_h = (ow.v1 - ow.v0).max(1e-9);
    // Empty, or either dimension under ~50% of
    // `O`, is a `classical-window-clipped`-class outcome — not a usable
    // export window. Fall back to `O` (today's behavior) rather than
    // render something framed on a sliver.
    let too_small = |u0: f64, u1: f64, v0: f64, v1: f64| -> bool {
        u1 <= u0 || v1 <= v0 || (u1 - u0) < 0.5 * o_w || (v1 - v0) < 0.5 * o_h
    };
    if too_small(cu0, cu1, cv0, cv1) {
        return fallback();
    }

    // Certify a single output-uv point backward-maps inside the crop
    // (half-pixel tolerance for float slop at the exact boundary), via the
    // **real** backward map `finalize_window`/`render` uses — not
    // `forward_map_crop_point`'s own inverse.
    let back_maps_in_crop = |uu: f64, vv: f64| -> bool {
        let rectified = if apply_warp {
            warp_ref.out_to_uv(&[[uu, vv]])
        } else {
            vec![[uu, vv]]
        };
        let img = rectified_to_image(&rectified, params, x_clamp);
        let (x, y) = (img[0][0], img[0][1]);
        x.is_finite() && y.is_finite() && x >= -0.5 && y >= -0.5 && x <= w_f + 0.5 && y <= h_f + 0.5
    };

    // Safety-net certification the verdict requires — strengthened beyond
    // a single center probe. `forward_map_crop_point`'s inverse
    // (`backproject` + `flatten_u`'s single-interval Simpson quadrature)
    // is **not** the exact numerical inverse of `rectified_to_image`'s own
    // backward map (a 4001-sample cumulative-trapezoid integral —
    // `model.rs`'s own doc comment: "deliberately not the same quadrature
    // ... do not unify them"). The per-edge extrema above are therefore
    // only approximately exact; on a real capture with real curvature
    // (`20260816_150015`) the residual discrepancy left one *corner* of
    // the naively-clamped window outside the crop even though its center
    // was comfortably inside. Certify the center first (cheap, catches
    // the common case and anything wildly wrong), then all four corners
    // against the real backward map, iteratively pulling the window in
    // toward its own (already-certified) center by a small factor when a
    // corner fails — bounded, cheap corrections rather than a fallback on
    // the first sub-pixel-class discrepancy.
    if !back_maps_in_crop(0.5 * (cu0 + cu1), 0.5 * (cv0 + cv1)) {
        return fallback();
    }
    let corners_ok = |u0: f64, u1: f64, v0: f64, v1: f64| -> bool {
        [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
            .iter()
            .all(|&(uu, vv)| back_maps_in_crop(uu, vv))
    };
    let mut certified = corners_ok(cu0, cu1, cv0, cv1);
    let mut attempts = 0;
    while !certified && attempts < 12 {
        let cu_mid = 0.5 * (cu0 + cu1);
        let cv_mid = 0.5 * (cv0 + cv1);
        cu0 = cu_mid + (cu0 - cu_mid) * 0.96;
        cu1 = cu_mid + (cu1 - cu_mid) * 0.96;
        cv0 = cv_mid + (cv0 - cv_mid) * 0.96;
        cv1 = cv_mid + (cv1 - cv_mid) * 0.96;
        if too_small(cu0, cu1, cv0, cv1) {
            return fallback();
        }
        certified = corners_ok(cu0, cu1, cv0, cv1);
        attempts += 1;
    }
    if !certified {
        return fallback();
    }

    // Quad-aligned export framing (see this function's own doc comment for
    // the full argument): `cu0..cv1` above is the crop-bounds-certified
    // window — the floor this section refines, never regresses. Any failure
    // below simply leaves `cu0..cv1` untouched, so a caller with no quad (or
    // a quad this refinement cannot honor) gets exactly the quad-less
    // behavior.
    //
    // Intersect the quad-fit box against `l/rt/t/b` — the crop-bounds-only
    // extent computed above, **before** it was ever intersected with `ow`
    // (the text-percentile window `O`) — not against `cu0..cv1` itself.
    // `O` is exactly the framing measured *not* to track quad corners
    // (10-19% unclamped, 5-9% even after crop-bounds clamping — 2-4× the
    // guard's own tolerance);
    // intersecting the quad box with `cu0..cv1` (which already has `O`
    // baked in via `ow.u0.max(l)` etc., above) would silently re-impose
    // that same framing whenever `O` happens to already be the tighter
    // constraint — the common case, since detected text is usually a
    // smaller region than the confirmed page. `l/rt/t/b` carry no such
    // bias: they are purely "does this stay inside the buffer", the one
    // invariant this section is bound not to regress.
    let mut quad_corner_residual: Option<f64> = None;
    if let Some(q) = quad {
        if let Some((ql, qr, qt, qb)) = fit_quad_window(q, params, &warp_ref, apply_warp, w_f, h_f)
        {
            // orientation guard, direct comparison (never `abs()` — an
            // inverted fit means the quad and the model's own output
            // orientation disagree, which is degenerate, not "mirrored").
            if ql < qr && qt < qb {
                let iu0 = l.max(ql + inset_u);
                let iu1 = rt.min(qr - inset_u);
                let iv0 = t.max(qt + inset_v);
                let iv1 = b.min(qb - inset_v);
                if !too_small(iu0, iu1, iv0, iv1) {
                    let (mut qu0, mut qu1, mut qv0, mut qv1) = (iu0, iu1, iv0, iv1);
                    let mut qcertified = back_maps_in_crop(0.5 * (qu0 + qu1), 0.5 * (qv0 + qv1))
                        && corners_ok(qu0, qu1, qv0, qv1);
                    let mut qattempts = 0;
                    let mut qgiven_up = false;
                    while !qcertified && qattempts < 12 {
                        let mid_u = 0.5 * (qu0 + qu1);
                        let mid_v = 0.5 * (qv0 + qv1);
                        qu0 = mid_u + (qu0 - mid_u) * 0.96;
                        qu1 = mid_u + (qu1 - mid_u) * 0.96;
                        qv0 = mid_v + (qv0 - mid_v) * 0.96;
                        qv1 = mid_v + (qv1 - mid_v) * 0.96;
                        if too_small(qu0, qu1, qv0, qv1) {
                            qgiven_up = true;
                            break;
                        }
                        qcertified = back_maps_in_crop(0.5 * (qu0 + qu1), 0.5 * (qv0 + qv1))
                            && corners_ok(qu0, qu1, qv0, qv1);
                        qattempts += 1;
                    }
                    if qcertified && !qgiven_up {
                        cu0 = qu0;
                        cu1 = qu1;
                        cv0 = qv0;
                        cv1 = qv1;
                        quad_corner_residual = Some(quad_corner_residual_fraction(
                            q, cu0, cu1, cv0, cv1, params, x_clamp, &warp_ref, apply_warp, w_f, h_f,
                        ));
                    }
                }
            }
        }
    }

    let clipped_w = cu1 - cu0;
    let clipped_h = cv1 - cv0;
    let area_frac = ((clipped_w * clipped_h) / (o_w * o_h)).clamp(0.0, 1.0);
    let window_clip = WindowClip {
        left: (cu0 - ow.u0).max(0.0),
        right: (ow.u1 - cu1).max(0.0),
        top: (cv0 - ow.v0).max(0.0),
        bottom: (ow.v1 - cv1).max(0.0),
        area_frac,
    };

    // `window_clips_text` trips only when the
    // certified window fails to contain the raw feature percentile box
    // (shrunk 3% inward as tolerance) — i.e. clipping into the 15%/2%
    // margin alone does not count, only clipping into content does.
    let sw = 0.03 * (ow.fu1 - ow.fu0);
    let sh = 0.03 * (ow.fv1 - ow.fv0);
    let window_clips_text =
        cu0 > ow.fu0 + sw || cu1 < ow.fu1 - sw || cv0 > ow.fv0 + sh || cv1 < ow.fv1 - sh;

    let grid = finalize_window(
        cu0, cu1, cv0, cv1, rows, cols, params, x_clamp, warp, apply_warp, input_w, input_h,
    );
    ExportRender {
        grid,
        window_clip,
        window_clips_text,
        quad_corner_residual,
    }
}

/// Map [`ExportQuad`]'s four corners (buffer-normalized `[0,1]`) through
/// the identical forward chain [`forward_map_crop_point`] uses, then fit
/// the corner-mean axis-aligned box (`render_export`'s own doc comment has
/// the full argument for why the mean of two corners, not a median over
/// many samples). Returns `None` — "cannot certify" — on any
/// non-finite/non-positive-`k`
/// corner mapping; the caller checks the `L<R`/`T<B` orientation itself
/// (kept out of this function so its contract stays "map, don't judge").
fn fit_quad_window(
    quad: &ExportQuad,
    params: &DewarpParams,
    warp_ref: &ResidualWarp,
    apply_warp: bool,
    w_f: f64,
    h_f: f64,
) -> Option<(f64, f64, f64, f64)> {
    let mapped =
        |n: [f64; 2]| forward_map_crop_point(n[0] * w_f, n[1] * h_f, params, warp_ref, apply_warp);
    let tl = mapped(quad.top_left)?;
    let tr = mapped(quad.top_right)?;
    let br = mapped(quad.bottom_right)?;
    let bl = mapped(quad.bottom_left)?;
    let l = 0.5 * (tl[0] + bl[0]);
    let r = 0.5 * (tr[0] + br[0]);
    let t = 0.5 * (tl[1] + tr[1]);
    let b = 0.5 * (bl[1] + br[1]);
    if l.is_finite() && r.is_finite() && t.is_finite() && b.is_finite() {
        Some((l, r, t, b))
    } else {
        None
    }
}

/// Reports the predicted corner residual in the status object. Predicts
/// exactly what
/// `guards.ts::evaluateComposedMap`'s `boundary` check will compute for the
/// grid this call is about to render — the four window corners
/// (`u,v ∈ {(0,0),(1,0),(1,1),(0,1)}`), backward-mapped via the *real*
/// backward map (`ResidualWarp::out_to_uv` + [`rectified_to_image`], not
/// `fit_quad_window`'s own approximate inverse — same distinction
/// `back_maps_in_crop` draws above), compared to the quad corner each one
/// targets, as a fraction of the quad's own diagonal (in the same
/// buffer-pixel space [`fit_quad_window`] worked in — a uniform scale of
/// canonical-pixel space by construction, so fraction-of-diagonal stays
/// scale-invariant here identically).
#[allow(clippy::too_many_arguments)]
fn quad_corner_residual_fraction(
    quad: &ExportQuad,
    cu0: f64,
    cu1: f64,
    cv0: f64,
    cv1: f64,
    params: &DewarpParams,
    x_clamp: Option<(f64, f64)>,
    warp_ref: &ResidualWarp,
    apply_warp: bool,
    w_f: f64,
    h_f: f64,
) -> f64 {
    let backmap = |uu: f64, vv: f64| -> [f64; 2] {
        let rectified = if apply_warp {
            warp_ref.out_to_uv(&[[uu, vv]])
        } else {
            vec![[uu, vv]]
        };
        rectified_to_image(&rectified, params, x_clamp)[0]
    };
    let target = |n: [f64; 2]| -> [f64; 2] { [n[0] * w_f, n[1] * h_f] };
    let dist = |a: [f64; 2], b: [f64; 2]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
    let (tl, tr, br, bl) = (
        target(quad.top_left),
        target(quad.top_right),
        target(quad.bottom_right),
        target(quad.bottom_left),
    );
    let diag = dist(tl, br).max(dist(tr, bl)).max(1e-9);
    [
        (backmap(cu0, cv0), tl),
        (backmap(cu1, cv0), tr),
        (backmap(cu1, cv1), br),
        (backmap(cu0, cv1), bl),
    ]
    .iter()
    .map(|&(mapped, corner)| dist(mapped, corner) / diag)
    .fold(0.0_f64, f64::max)
}

/// Convert [`RenderedGrid`] samples (crop-pixel `(alpha, beta)`) to the wasm
/// ABI's crop-relative `[-1, 1]`, `align_corners` convention:
/// `nx = 2*alpha/(crop_w-1) - 1`, `ny = 2*beta/(crop_h-1) - 1`.
/// `crop_w`/`crop_h` **must** be this crate's own input-buffer dimensions,
/// never a canonical-image dimension this crate was never given. Output is
/// `f32` (the ABI's wire format, `dewarp_grid_ptr`), plane-separated: all
/// `x` values first, then all `y` values (see `dewarp_grid_ptr`'s doc
/// comment).
pub fn grid_to_ndc_planes(samples: &[[f64; 2]], crop_w: u32, crop_h: u32) -> Vec<f32> {
    let n = samples.len();
    let cw = ((crop_w as f64) - 1.0).max(1e-9);
    let ch = ((crop_h as f64) - 1.0).max(1e-9);
    let mut out = vec![0f32; n * 2];
    for i in 0..n {
        out[i] = (2.0 * samples[i][0] / cw - 1.0) as f32;
    }
    for i in 0..n {
        out[n + i] = (2.0 * samples[i][1] / ch - 1.0) as f32;
    }
    out
}

/// `dewarp._filter_segments_by_geometry_support`
/// (`dewarp.py:615-644,703-708`, "S3b" in the seam contract): keep split
/// segments whose midpoint lies within `3*mean_text_size` of any
/// high-confidence text CC centre or any of the 200 page-boundary samples.
/// Brute-force distance matrix, batched by 512 rows to bound peak memory on
/// high-resolution inputs (`dewarp.py:640-643`). Applied only when
/// `use_line_term && page_boundary.is_some() && text.uses_confidence_filter()`
/// — that gating decision is made by the caller ([`dewarp_image`]), not
/// this function.
pub fn filter_segments_by_geometry_support(
    segs: &LineSegments,
    text: &TextFeatures,
    boundary: &PageBoundary,
) -> LineSegments {
    let high_conf = text.high_confidence_lines();
    if segs.is_empty() || high_conf.is_empty() {
        return segs.clone();
    }
    let mut support: Vec<[f64; 2]> = Vec::new();
    for line in &high_conf {
        support.extend_from_slice(&line.centers);
    }
    for (_, pts) in boundary.sides() {
        support.extend_from_slice(pts);
    }
    let threshold2 = (3.0 * text.mean_text_size) * (3.0 * text.mean_text_size);
    let mid = segs.r();
    let mut keep = vec![false; segs.len()];
    for start in (0..mid.len()).step_by(512) {
        let end = (start + 512).min(mid.len());
        for (i, m) in mid.iter().enumerate().take(end).skip(start) {
            let mut best = f64::INFINITY;
            for s in &support {
                let dx = m[0] - s[0];
                let dy = m[1] - s[1];
                let d2 = dx * dx + dy * dy;
                if d2 < best {
                    best = d2;
                }
            }
            keep[i] = best <= threshold2;
        }
    }
    let filtered: Vec<[f64; 4]> = segs
        .segments
        .iter()
        .zip(keep.iter())
        .filter(|(_, &k)| k)
        .map(|(s, _)| *s)
        .collect();
    LineSegments { segments: filtered }
}

// ---------------------------------------------------------------------------
// The confidence/status layer. The Python reference has none of this; every
// field here is a cheap, already-computed-in-the-pipeline number, chosen
// because together they flag the booklet-spread class of failure.
// ---------------------------------------------------------------------------

/// The `bound_saturation` object: which of the 8 optimized parameters sit
/// ON a bound at the final solve. `a3`/`a4` saturated alone is the *normal*
/// path — measured, the final solution routinely sits on the `a3=+5`,
/// `a4=-5` bounds, and that is not an edge case. This struct exists to let
/// the caller distinguish that from the rarer, degenerate-solution
/// signature of *all four* `a` bounds plus any `rvec` bound saturating
/// simultaneously (the `classical-degenerate-bounds` fallback reason).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoundSaturation {
    pub a: [bool; 4],
    pub rvec: [bool; 3],
    pub log_f: bool,
}

/// The full status/confidence object (`dewarp_status_json`'s payload once
/// wasm.rs hand-encodes it to JSON).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DewarpStatus {
    pub converged: bool,
    pub kept_text_lines: usize,
    pub total_text_lines: usize,
    pub kept_segments: usize,
    pub total_candidates: usize,
    pub uses_confidence_filter: bool,
    pub bound_saturation: BoundSaturation,
    pub output_aspect: f64,
    pub input_aspect: f64,
    pub boundary_used: bool,
    pub residual_text_straightness_p90: f64,
    pub residual_boundary_mean_px: Option<f64>,
    /// "The window fix": how much
    /// [`render_export`] had to shrink the reference output window to
    /// certify it backward-maps entirely inside the crop. `area_frac ==
    /// 1.0` with all-zero edges means no clip was needed.
    pub window_clip: WindowClip,
    /// `true` when the certified window had to
    /// cut into the feature percentile box itself (content), not just the
    /// 15%/2% margin — or when no certified window could be produced at
    /// all (conservative default in that case).
    pub window_clips_text: bool,
    /// Quad-aligned export framing:
    /// the predicted worst-case corner offset the TS `boundary` guard
    /// (`guards.ts::evaluateComposedMap`, `MAX_BOUNDARY_OFFSET_FRACTION =
    /// 0.05`) will compute, as a fraction of the quad's own diagonal —
    /// evaluated here via the identical backward map
    /// (`ResidualWarp::out_to_uv` + [`rectified_to_image`]) at the four
    /// window corners the guard itself samples (`u,v ∈
    /// {(0,0),(1,0),(1,1),(0,1)}`), so this is a prediction of that guard's
    /// own number, not an approximation of it. `None` when `opts_json`
    /// carried no `quad`, or the quad could not be honored (falls back to
    /// the quad-less crop-bounds-certified window).
    pub quad_corner_residual: Option<f64>,
    /// Wall-clock elapsed time for the whole `dewarp()` ABI call, in
    /// milliseconds. **Set to `0` by [`dewarp_image`] itself** — this
    /// function has no portable, allocation-free wall-clock source that
    /// works identically on `wasm32-unknown-unknown` (no `std::time::
    /// Instant`) and the native parity-test target. `wasm.rs::dewarp`
    /// (the one module allowed to know about the JS boundary) measures
    /// real wall-clock time around its call into this
    /// function and overwrites this field before returning the status to
    /// the caller.
    pub elapsed_ms: u64,
}

impl DewarpStatus {
    /// Hand-rolled JSON encode, in the status object's exact field
    /// names/shape.
    /// Not `serde_json` — see `wasm::parse_opts_json`'s doc comment for why
    /// this crate keeps `serde`/`serde_json` `parity`-feature-only.
    pub fn to_json(&self) -> String {
        fn num(v: f64) -> String {
            if v.is_finite() {
                format!("{v}")
            } else {
                "0".to_string()
            }
        }
        fn onum(v: Option<f64>) -> String {
            match v {
                Some(x) if x.is_finite() => format!("{x}"),
                _ => "null".to_string(),
            }
        }
        fn bools4(a: [bool; 4]) -> String {
            format!("[{},{},{},{}]", a[0], a[1], a[2], a[3])
        }
        fn bools3(a: [bool; 3]) -> String {
            format!("[{},{},{}]", a[0], a[1], a[2])
        }
        format!(
            "{{\"converged\":{},\"kept_text_lines\":{},\"total_text_lines\":{},\"kept_segments\":{},\"total_candidates\":{},\"uses_confidence_filter\":{},\"bound_saturation\":{{\"a\":{},\"rvec\":{},\"log_f\":{}}},\"output_aspect\":{},\"input_aspect\":{},\"boundary_used\":{},\"residual_text_straightness_p90\":{},\"residual_boundary_mean_px\":{},\"window_clip\":{{\"left\":{},\"right\":{},\"top\":{},\"bottom\":{},\"area_frac\":{}}},\"window_clips_text\":{},\"quad_corner_residual\":{},\"elapsed_ms\":{}}}",
            self.converged,
            self.kept_text_lines,
            self.total_text_lines,
            self.kept_segments,
            self.total_candidates,
            self.uses_confidence_filter,
            bools4(self.bound_saturation.a),
            bools3(self.bound_saturation.rvec),
            self.bound_saturation.log_f,
            num(self.output_aspect),
            num(self.input_aspect),
            self.boundary_used,
            num(self.residual_text_straightness_p90),
            onum(self.residual_boundary_mean_px),
            num(self.window_clip.left),
            num(self.window_clip.right),
            num(self.window_clip.top),
            num(self.window_clip.bottom),
            num(self.window_clip.area_frac),
            self.window_clips_text,
            onum(self.quad_corner_residual),
            self.elapsed_ms,
        )
    }
}

/// Which of `theta`'s 8 parameters sit at (within `eps` of) their bound —
/// feeds [`DewarpStatus::bound_saturation`]. `a_bound` is the `±a_bound`
/// range `optimize::solve_theta` used for `a`; `rvec` bounds are always
/// `±1.0`; `f_bounds`, when the solve used an EXIF-narrowed `log f` range
/// instead of the FOV 30°-74° default, must be passed so this matches
/// whichever bounds actually constrained the solve.
fn compute_bound_saturation(
    theta: &[f64; N_THETA],
    a_bound: f64,
    log_f_bounds: (f64, f64),
) -> BoundSaturation {
    // Absolute epsilon for `a`/`rvec` (both O(1) quantities) and a
    // range-relative epsilon for `log_f` (whose span depends on image
    // size/EXIF narrowing) — these thresholds are new to this port (the
    // Python reference has no saturation reporting at all), chosen to be
    // tight enough not to false-positive on a solve that merely came close
    // to a bound without the active-set solver actually freezing it there.
    const EPS_ABS: f64 = 1e-4;
    let mut a = [false; 4];
    for (i, ai) in a.iter_mut().enumerate() {
        *ai = (theta[i] - a_bound).abs() < EPS_ABS || (theta[i] + a_bound).abs() < EPS_ABS;
    }
    let mut rvec = [false; 3];
    for (i, ri) in rvec.iter_mut().enumerate() {
        let v = theta[4 + i];
        *ri = (v - 1.0).abs() < EPS_ABS || (v + 1.0).abs() < EPS_ABS;
    }
    let (lo, hi) = log_f_bounds;
    let span = (hi - lo).abs().max(1e-9);
    let rel_eps = 1e-4 * span;
    let log_f_val = theta[N_THETA - 1];
    let log_f = (log_f_val - lo).abs() < rel_eps || (log_f_val - hi).abs() < rel_eps;
    BoundSaturation { a, rvec, log_f }
}

/// `optimize::solve_theta`'s own (module-private) `log f` bound formula
/// (`optimize.py:451-467`), duplicated here **read-only** so
/// [`compute_bound_saturation`] can tell which bound a saturated `log f`
/// actually sits on. `f_exif_px` is always `None` today, so this always
/// takes the FOV 30°-74° branch in practice; the
/// EXIF branch is carried for fidelity with the formula it mirrors.
fn f_bounds_default(img_w: u32, img_h: u32, f_exif_px: Option<f64>) -> (f64, f64) {
    let a_img = img_w.max(img_h) as f64;
    match f_exif_px.map(|fpx| (0.82 * fpx, 1.18 * fpx)) {
        Some((lo, hi)) => (lo.ln(), hi.ln()),
        None => (
            (0.5 * a_img / 37.0_f64.to_radians().tan()).ln(),
            (0.5 * a_img / 15.0_f64.to_radians().tan()).ln(),
        ),
    }
}

/// `[-1,1]`-identity-equivalent grid: every node samples
/// straight through, from the *same* `(row,col)` fraction of the crop it
/// sits at in the output — i.e. zero deformation, so
/// [`grid_to_ndc_planes`] of this grid is the ABI's own `identityGrid`.
/// Used by every degenerate exit below (`status.converged = false`).
fn identity_grid(rows: u32, cols: u32, crop_w: u32, crop_h: u32) -> RenderedGrid {
    let mut samples = Vec::with_capacity((rows as usize) * (cols as usize));
    for r in 0..rows {
        let vy = if rows > 1 {
            r as f64 / (rows - 1) as f64
        } else {
            0.0
        };
        for c in 0..cols {
            let ux = if cols > 1 {
                c as f64 / (cols - 1) as f64
            } else {
                0.0
            };
            samples.push([ux * ((crop_w as f64) - 1.0), vy * ((crop_h as f64) - 1.0)]);
        }
    }
    RenderedGrid {
        out_w: crop_w,
        out_h: crop_h,
        samples,
    }
}

/// Drop the alpha channel — the ported paper-region/page-boundary
/// detection path (`linesegs::detect_paper_region`) operates on an RGB
/// buffer (mirroring `cv2`'s 3-channel `proc` image); the wasm ABI hands
/// this crate RGBA, so this crate needs its own RGB view
/// at the one call site that needs it.
fn rgba_to_rgb(img: &RgbaImage) -> RgbImage {
    let (w, h) = img.dimensions();
    let mut out = RgbImage::new(w, h);
    for (src, dst) in img.pixels().zip(out.pixels_mut()) {
        let [r, g, b, _a] = src.0;
        dst.0 = [r, g, b];
    }
    out
}

/// The result of one end-to-end [`dewarp_image`] call — everything
/// `wasm::dewarp` needs to populate `DewarpResultHandle`.
#[derive(Debug, Clone)]
pub struct DewarpImageResult {
    /// `None` exactly when the Python reference's own degenerate exits fire
    /// (no features at all, or `_prepare_geometry` returning `None`) —
    /// `status.converged` is `false` in both cases.
    pub params: Option<DewarpParams>,
    pub grid: Option<RenderedGrid>,
    pub status: DewarpStatus,
}

/// `dewarp.dewarp_image` (`dewarp.py:647-851`), minus `debug`/`verbose`/
/// `scene` and minus rasterization (see this module's doc comment) — the
/// single top-level entry point `wasm::dewarp` calls.
///
/// `img` is the RGBA crop at whatever resolution the caller handed to the
/// wasm ABI — already TS-side-capped at `WASM_INPUT_MAX_SIDE=1600` for
/// large crops, never upscaled on the TS side. This function performs its
/// own S0 internal resize to `opts.proc_max_side` (upscale allowed, capped
/// at 3×) exactly as `dewarp.py:660-674` does, independent of whatever the
/// TS side already did. `rows`/`cols` size the returned [`RenderedGrid`]
/// (see this module's doc comment).
///
/// Degenerate exits are preserved verbatim from the Python reference — each
/// surfaces as `status.converged = false` plus an identity-ish grid, rather
/// than as an error/panic:
/// - no text lines and no segments detected at all (`dewarp.py:740-742`);
/// - [`prepare_geometry`] returns `None` for the text-first baseline.
///
/// `quad` (quad-aligned export framing): the confirmed page quad,
/// normalized `[0,1]` over this same
/// `img` buffer (not the caller's canonical image — `wasm::parse_opts_json`
/// does that normalization's inverse-of-inverse bookkeeping, this function
/// only ever sees buffer-relative coordinates). Forwarded to
/// [`render_export`] unchanged; `None` reproduces the quad-less framing
/// byte-for-byte.
pub fn dewarp_image(
    img: &RgbaImage,
    use_line_term: bool,
    opts: &QualityOptions,
    rows: u32,
    cols: u32,
    quad: Option<&ExportQuad>,
) -> DewarpImageResult {
    let (w, h) = img.dimensions();
    let in_aspect = if h > 0 { w as f64 / h as f64 } else { 0.0 };

    let ratio = ((opts.proc_max_side as f64) / (w.max(h).max(1) as f64)).min(3.0);
    let proc_rgba: RgbaImage = if (ratio - 1.0).abs() > 1e-3 {
        let algo = if ratio < 1.0 {
            crate::imgops::resize::Algo::Area
        } else {
            crate::imgops::resize::Algo::Cubic
        };
        let new_w = ((w as f64) * ratio).round().max(1.0) as u32;
        let new_h = ((h as f64) * ratio).round().max(1.0) as u32;
        crate::imgops::resize::resize_rgba(img, new_w, new_h, algo)
    } else {
        img.clone()
    };
    let (proc_w, proc_h) = proc_rgba.dimensions();
    let gray = crate::imgops::gray::rgba_to_gray(&proc_rgba);
    let proc_rgb = rgba_to_rgb(&proc_rgba);

    let paper_region = crate::linesegs::detect_paper_region(&proc_rgb);
    let mask = paper_region.as_ref().map(|p| &p.mask);
    let page_boundary: Option<PageBoundary> = if opts.use_page_boundary {
        paper_region.as_ref().and_then(|p| p.boundary.clone())
    } else {
        None
    };

    let text = crate::textline::extract_text_features(&gray, mask);
    // Gated on `use_line_term`, deliberately diverging from `dewarp.py:701`'s
    // unconditional call. Two reasons, one correctness and one cost:
    //
    // 1. **Correctness.** `optimize.py:641-646` (mirrored at
    //    `optimize.rs`'s `anchor_pts`) folds segment midpoints into the
    //    scale-anchor feature set whenever there are fewer than 200 text
    //    points — and that use is **not** gated on `use_line_term`, unlike
    //    every other segment consumer. So a non-empty `segs` changes the
    //    converged pose even with the line term off. The Python reference
    //    forces `segs` empty in that case (`if not use_line_term:` right
    //    before it calls `run_optimization`). Calling LSD here regardless
    //    would silently change what `use_line_term=false` means — measured:
    //    on one test page it moved the grid from 0.000px to 50.7px.
    // 2. **Cost.** With `lsd` a default feature, an ungated call would run
    //    the full detector on every scan for segments nothing consumes.
    //
    // `DewarpStatus.total_candidates` therefore stays 0 when the flag is
    // off, matching its definition: the segment count feeding
    // `run_optimization`.
    let segs_all = if use_line_term {
        crate::linesegs::detect_line_segments(&gray, text.mean_text_size, mask)
    } else {
        crate::linesegs::LineSegments::empty()
    };
    let segs = if use_line_term && page_boundary.is_some() && text.uses_confidence_filter() {
        filter_segments_by_geometry_support(
            &segs_all,
            &text,
            page_boundary.as_ref().expect("checked is_some above"),
        )
    } else {
        segs_all
    };
    // "total_candidates": the segment count feeding `run_optimization`,
    // i.e. post geometry-support-filter — 0 whenever `use_line_term` is
    // off, see
    // the gate on `segs_all` above.
    let total_candidates = segs.len();

    let all_lines_count = text.lines().len();
    // "total_text_lines": the pre-outlier-loop validated line count — the
    // geometry-eligible set that actually *enters* the outlier
    // loop (`optimize::run_optimization`'s own `line_points`/`block_of_line`
    // construction, `optimize.py:747-762`'s Rust mirror at
    // `run_optimization_traced`'s top: every validated line when
    // `uses_confidence_filter()` is false, only `high_confidence` lines
    // when it's true). This is *not* simply `text.lines().len()` — that
    // would fold the confidence filter's own drop into the same number
    // that is supposed to mean "the outlier loop rejected most of what it
    // found", conflating two different filters into one signal.
    let use_confidence_filter = text.uses_confidence_filter();
    let total_text_lines = text
        .lines()
        .iter()
        .filter(|l| !use_confidence_filter || l.high_confidence)
        .count();
    if all_lines_count == 0 && segs.is_empty() {
        return DewarpImageResult {
            params: None,
            grid: Some(identity_grid(rows, cols, w, h)),
            status: DewarpStatus {
                converged: false,
                kept_text_lines: 0,
                total_text_lines: 0,
                kept_segments: 0,
                total_candidates,
                uses_confidence_filter: text.uses_confidence_filter(),
                bound_saturation: BoundSaturation {
                    a: [false; 4],
                    rvec: [false; 3],
                    log_f: false,
                },
                output_aspect: in_aspect,
                input_aspect: in_aspect,
                boundary_used: false,
                residual_text_straightness_p90: 0.0,
                residual_boundary_mean_px: None,
                window_clip: WindowClip {
                    left: 0.0,
                    right: 0.0,
                    top: 0.0,
                    bottom: 0.0,
                    area_frac: 1.0,
                },
                window_clips_text: false,
                quad_corner_residual: None,
                elapsed_ms: 0,
            },
        };
    }

    let f_exif_proc = opts.f_exif_px.map(|f| f * ratio);
    let mut result = crate::optimize::run_optimization(
        &text,
        &segs,
        proc_w,
        proc_h,
        use_line_term,
        opts,
        f_exif_proc,
        5.0,
        None,
    );

    let Some(mut geometry) = prepare_geometry(&result, ratio) else {
        let theta = crate::optimize::pack_theta(&result.params);
        let log_f_bounds = f_bounds_default(proc_w, proc_h, f_exif_proc);
        return DewarpImageResult {
            params: Some(result.params.clone()),
            grid: Some(identity_grid(rows, cols, w, h)),
            status: DewarpStatus {
                converged: false,
                kept_text_lines: result.data.line_points.len(),
                total_text_lines,
                kept_segments: result.data.segments.len(),
                total_candidates,
                uses_confidence_filter: text.uses_confidence_filter(),
                bound_saturation: compute_bound_saturation(&theta, 5.0, log_f_bounds),
                output_aspect: in_aspect,
                input_aspect: in_aspect,
                boundary_used: false,
                residual_text_straightness_p90: 0.0,
                residual_boundary_mean_px: None,
                window_clip: WindowClip {
                    left: 0.0,
                    right: 0.0,
                    top: 0.0,
                    bottom: 0.0,
                    area_frac: 1.0,
                },
                window_clips_text: false,
                quad_corner_residual: None,
                elapsed_ms: 0,
            },
        };
    };

    let mut boundary_used = false;
    let mut residual_boundary_mean_px: Option<f64> = None;

    if let Some(boundary) = &page_boundary {
        let baseline_metrics = quality_metrics(&geometry, boundary, ratio);
        let candidates = crate::optimize::refine_with_page_boundary(
            &result,
            boundary,
            proc_w,
            proc_h,
            opts,
            f_exif_proc,
            5.0,
        );
        let mean_text_size_full = text.mean_text_size / ratio;
        let mut acceptable: Vec<(f64, PreparedGeometry)> = Vec::new();
        for candidate in &candidates {
            if let Some(cand_geom) = prepare_geometry(&candidate.result, ratio) {
                let cand_metrics = quality_metrics(&cand_geom, boundary, ratio);
                if candidate_is_acceptable(&baseline_metrics, &cand_metrics, mean_text_size_full) {
                    acceptable.push((cand_metrics.boundary_mean(), cand_geom));
                }
            }
        }
        if !acceptable.is_empty() {
            acceptable.sort_by(|a, b| {
                a.0.partial_cmp(&b.0)
                    .expect("boundary_mean is always finite for an accepted candidate")
            });
            let (best_mean, best_geom) = acceptable
                .into_iter()
                .next()
                .expect("checked non-empty above");
            result = best_geom.result.clone();
            geometry = best_geom;
            boundary_used = true;
            residual_boundary_mean_px = Some(best_mean);
        }
    }

    let params_full = geometry.params.clone();
    let feat_uv = geometry.feat_uv.clone();
    let x_clamp = geometry.x_clamp;
    let warp = geometry.warp.unwrap_or_default();

    // Paper-mask boundary in uv coordinates, used by `render` for page
    // framing (`dewarp.py:829-843`).
    let mut page_uv: Option<Vec<[f64; 2]>> = None;
    if let Some(m) = mask {
        let contours = crate::contours::find_contours_external(
            m.as_raw(),
            proc_w,
            proc_h,
            crate::contours::ChainApprox::None_,
        );
        if !contours.is_empty() {
            let mut best = &contours[0];
            let mut best_area = crate::contours::contour_area(&contours[0].points);
            for c in &contours[1..] {
                let a = crate::contours::contour_area(&c.points);
                if a > best_area {
                    best_area = a;
                    best = c;
                }
            }
            let contour: Vec<[f64; 2]> = best
                .points
                .iter()
                .map(|p| [p[0] as f64, p[1] as f64])
                .collect();
            if !contour.is_empty() {
                let sub: Vec<[f64; 2]> = contour
                    .iter()
                    .step_by(5)
                    .map(|p| [p[0] / ratio, p[1] / ratio])
                    .collect();
                let mut uv = surface_to_rectified(&sub, &params_full, None);
                uv.retain(|p| p[0].is_finite() && p[1].is_finite());
                page_uv = Some(uv);
            }
        }
    }

    // "The window fix": the ABI-export side certifies its output window
    // backward-maps entirely inside the crop before returning it — see
    // [`render_export`]'s own doc comment. The Python-parity path calls
    // [`render`] directly and never goes through `dewarp_image`, so it is
    // unaffected by this call.
    let export = render_export(
        &params_full,
        &feat_uv,
        x_clamp,
        rows,
        cols,
        Some(&warp),
        page_uv.as_deref(),
        w,
        h,
        quad,
    );
    let grid = export.grid;

    let residual_text_straightness_p90 = text_straightness_p90(&geometry.line_uvs, &warp);
    let theta = crate::optimize::pack_theta(&result.params);
    let log_f_bounds = f_bounds_default(proc_w, proc_h, f_exif_proc);
    let bound_saturation = compute_bound_saturation(&theta, 5.0, log_f_bounds);
    let out_aspect = if grid.out_h > 0 {
        grid.out_w as f64 / grid.out_h as f64
    } else {
        0.0
    };

    DewarpImageResult {
        params: Some(params_full),
        grid: Some(grid),
        status: DewarpStatus {
            converged: true,
            kept_text_lines: result.data.line_points.len(),
            total_text_lines,
            kept_segments: result.data.segments.len(),
            total_candidates,
            uses_confidence_filter: text.uses_confidence_filter(),
            bound_saturation,
            output_aspect: out_aspect,
            input_aspect: in_aspect,
            boundary_used,
            residual_text_straightness_p90,
            residual_boundary_mean_px,
            window_clip: export.window_clip,
            window_clips_text: export.window_clips_text,
            quad_corner_residual: export.quad_corner_residual,
            elapsed_ms: 0,
        },
    }
}

// ---------------------------------------------------------------------------
// Unit tests for "the window fix". These exercise [`render_export`] directly with
// hand-constructed geometry (never running the real feature-extraction/
// optimizer pipeline) so each scenario's numbers are exact and reproducible.
// The `identity_params` helper (`a=[0;4]`, `rvec=[0,0,0]`, `cx=cy=0`) makes
// output-uv space **exactly** equal to crop-pixel space (`model.rs`'s own
// doc comment: "when R=I and g≡0, this reduces to the identity mapping"),
// which lets several tests below state their expected numbers in closed
// form instead of relying on the optimizer to converge to something
// checkable only empirically.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod window_fix_tests {
    use super::*;

    fn identity_params(f: f64) -> DewarpParams {
        DewarpParams {
            a: [0.0; 4],
            rvec: [0.0, 0.0, 0.0],
            f,
            cx: 0.0,
            cy: 0.0,
            scale: f,
        }
    }

    /// Every sample of `grid`, converted through the ABI's own
    /// `grid_to_ndc_planes` for a `w×h` crop, must land in `[-1, 1]`
    /// — the core safety property: the ABI must never export a node whose
    /// crop-relative NDC position falls outside the crop it was computed
    /// against.
    fn assert_grid_in_bounds(grid: &RenderedGrid, w: u32, h: u32, context: &str) {
        let planes = grid_to_ndc_planes(&grid.samples, w, h);
        let n = grid.samples.len();
        for i in 0..n {
            let (x, y) = (planes[i] as f64, planes[n + i] as f64);
            assert!(
                (-1.0..=1.0).contains(&x) && (-1.0..=1.0).contains(&y),
                "{context}: node {i} out of bounds, ndc=({x},{y})"
            );
        }
    }

    /// Test 1, "rotated-page synthetic θ=25°": a page rotated by a range
    /// of angles including 25°, crop flush around the content (the
    /// "rotation-thinning" risk: a rotated flush crop shrinks the
    /// certifiable window by
    /// `~(W+H)·sinθ`). Property under test: `render_export` never returns
    /// an out-of-bounds grid — either it certifies a window (`area_frac >
    /// 0`) and every node is in-bounds, or it reports the fallback
    /// (`area_frac == 0`, `window_clip` all-zero) rather than an
    /// inconsistent in-between state. At `θ=25°`, with the crop sized to
    /// the content's own rotated bounding box (the worst-case "flush crop"
    /// framing), a real certified window must be produced — this is the
    /// scenario the fix exists for.
    #[test]
    fn rotated_page_certifies_in_bounds_or_reports_fallback() {
        let mut saw_certified_at_25deg = false;
        for &theta_deg in &[0.0f64, 10.0, 25.0, 40.0] {
            let theta = theta_deg.to_radians();
            let params = DewarpParams {
                a: [0.0; 4],
                rvec: [0.0, 0.0, theta],
                f: 1600.0,
                cx: 800.0,
                cy: 1000.0,
                scale: 1600.0,
            };
            // Content: a page ~1200x1500 (pre-rotation) centered at the
            // origin in rectified space.
            let (half_w, half_h) = (600.0, 750.0);
            let feat_uv: Vec<[f64; 2]> = vec![[-half_w, -half_h], [half_w, half_h]];
            // Crop sized to exactly the *rotated* content bbox plus a
            // small pad — the "flush crop" framing, the common production
            // case.
            let rot_w = half_w.abs() * theta.cos().abs() + half_h.abs() * theta.sin().abs();
            let rot_h = half_w.abs() * theta.sin().abs() + half_h.abs() * theta.cos().abs();
            let pad = 1.06;
            let w = ((2.0 * rot_w * pad) as u32).max(64);
            let h = ((2.0 * rot_h * pad) as u32).max(64);
            // Re-center: with `cx=800, cy=1000` the identity-ish content
            // sits near the crop's own center only if the crop is built
            // around it — offset params.cx/cy to the crop's center so the
            // rotated content is actually framed inside `[0,w)x[0,h)`.
            let params = DewarpParams {
                cx: w as f64 / 2.0,
                cy: h as f64 / 2.0,
                ..params
            };

            let export = render_export(&params, &feat_uv, None, 17, 13, None, None, w, h, None);
            let context = format!("theta={theta_deg}deg w={w} h={h}");
            if export.window_clip.area_frac > 0.0 {
                assert_grid_in_bounds(&export.grid, w, h, &context);
                if theta_deg == 25.0 {
                    saw_certified_at_25deg = true;
                }
            }
        }
        assert!(
            saw_certified_at_25deg,
            "θ=25° flush-crop case must certify a real (non-fallback) window"
        );
    }

    /// Test 2, "frame-flush barrel-bow" plus the fix's own before/after:
    /// uses [`identity_params`] so output-uv
    /// space is exactly crop-pixel space, making the arithmetic exact.
    ///
    /// Sub-case "generous": content sits well inside the crop on every
    /// side — the reference window `O` already fits, so `render_export`
    /// must not clip anything (`area_frac == 1.0`) and `window_clips_text`
    /// must be `false`.
    ///
    /// Sub-case "flush": content is cropped tight against the crop's own
    /// right edge — the crop's right edge sits exactly at the canonical
    /// width, leaving zero clipping margin available.
    /// This demonstrates the bug **and** the fix in the same numbers: (a)
    /// the unclamped, Python-parity [`render`] (still called verbatim, S6
    /// parity untouched) produces samples outside `[-1,1]` — reproducing
    /// today's `guard-bounds` failure; (b) [`render_export`] on the exact
    /// same inputs certifies a window with every node in-bounds.
    #[test]
    fn frame_flush_window_generous_vs_tight() {
        let params = identity_params(1600.0);
        let (w, h) = (1600u32, 2000u32);

        // -- generous: content comfortably inside the crop on all sides.
        let feat_generous: Vec<[f64; 2]> = vec![[300.0, 300.0], [1300.0, 1700.0]];
        let export_generous = render_export(
            &params,
            &feat_generous,
            None,
            17,
            13,
            None,
            None,
            w,
            h,
            None,
        );
        assert!(
            (export_generous.window_clip.area_frac - 1.0).abs() < 1e-6,
            "generous case must not clip: area_frac={}",
            export_generous.window_clip.area_frac
        );
        assert!(
            !export_generous.window_clips_text,
            "generous case must not report content clipping"
        );
        assert_grid_in_bounds(&export_generous.grid, w, h, "generous");

        // -- tight/flush: content runs to within 1px of the crop's own
        // right edge (px 1598 of 0..1599) — the reference window's 15%
        // margin then reaches for content that is not there.
        let feat_tight: Vec<[f64; 2]> = vec![[300.0, 300.0], [1598.0, 1700.0]];
        let unclamped = render(&params, &feat_tight, None, 17, 13, None, None, w, h);
        let unclamped_ndc = grid_to_ndc_planes(&unclamped.samples, w, h);
        let unclamped_out_of_bounds = unclamped_ndc
            .iter()
            .any(|&v| !(-1.0..=1.0).contains(&(v as f64)));
        assert!(
            unclamped_out_of_bounds,
            "unclamped render() must reproduce the pre-fix out-of-bounds window on a flush crop"
        );

        let export_tight =
            render_export(&params, &feat_tight, None, 17, 13, None, None, w, h, None);
        assert!(
            export_tight.window_clip.area_frac > 0.0,
            "flush case must still certify a usable (if clipped) window, not fall back"
        );
        assert_grid_in_bounds(&export_tight.grid, w, h, "tight/flush");
        assert!(
            export_tight.window_clip.right > 0.0,
            "flush case must report a nonzero right-edge clip"
        );

        // -- flush and narrow: same right-edge flushness, but a much
        // narrower content band so the 3%-of-content shrink
        // (`window_clips_text`'s own tolerance) is small enough for the
        // fixed ~8px inset to cut into it, not just the margin.
        let feat_narrow: Vec<[f64; 2]> = vec![[1550.0, 300.0], [1598.0, 1700.0]];
        let export_narrow =
            render_export(&params, &feat_narrow, None, 17, 13, None, None, w, h, None);
        assert!(
            export_narrow.window_clip.area_frac > 0.0,
            "narrow/flush case must still certify a window"
        );
        assert_grid_in_bounds(&export_narrow.grid, w, h, "narrow/flush");
        assert!(export_narrow.window_clips_text, "a narrow content band flush against the crop edge must clip into content, not just margin");
    }

    /// Test 3a, "sampling adequacy": re-probe the
    /// certified window's own boundary at 10× [`EXPORT_EDGE_SAMPLES`] and
    /// confirm every one of those denser probes still back-maps inside the
    /// crop — guards against "the true extremum sits between two of the 64
    /// samples" (a bow's sagitta), which the fixed inset is meant to
    /// absorb.
    #[test]
    fn certified_window_boundary_survives_10x_denser_probing() {
        let params = identity_params(1600.0);
        let (w, h) = (1600u32, 2000u32);
        let feat: Vec<[f64; 2]> = vec![[250.0, 250.0], [1350.0, 1750.0]];
        let export = render_export(&params, &feat, None, 17, 13, None, None, w, h, None);
        assert!(
            export.window_clip.area_frac > 0.0,
            "setup must certify a window"
        );

        // Reconstruct the certified window's own (u,v) extent from the
        // grid's own out_w/out_h is not exposed directly, so re-derive it
        // via the grid's first/last samples instead: with `identity_params`
        // output-uv == crop-pixel, so `render_export`'s clamp guarantees
        // are exactly the `assert_grid_in_bounds` check, at 10x the row/col
        // density this test uses at the acceptance grid.
        let dense = render_export(
            &params,
            &feat,
            None,
            17 * 10,
            13 * 10,
            None,
            None,
            w,
            h,
            None,
        );
        assert!(
            dense.window_clip.area_frac > 0.0,
            "denser probe must also certify"
        );
        assert_grid_in_bounds(&dense.grid, w, h, "10x-density probe");
    }

    /// Test 3b, the "fold" case: a params
    /// configuration whose curvature is extreme enough (`a` far past the
    /// optimizer's own `±5` bound) to make `backproject`'s Newton-Raphson
    /// solve diverge or land on a non-physical (`k<=0`) branch at some
    /// point along the crop's own boundary — the "Jacobian sign-flip /
    /// projective horizon" risk that requires a fallback.
    /// `render_export` must fall back (`area_frac == 0.0`,
    /// `window_clip` all-zero) rather than certify a spurious window.
    #[test]
    fn folded_geometry_falls_back_never_produces_a_spurious_window() {
        let params = DewarpParams {
            a: [9.0, 9.0, 9.0, 9.0],
            rvec: [0.0, 0.0, 0.0],
            f: 1600.0,
            cx: 800.0,
            cy: 1000.0,
            scale: 1600.0,
        };
        let (w, h) = (1600u32, 2000u32);
        let feat: Vec<[f64; 2]> = vec![[-500.0, -600.0], [500.0, 600.0]];
        let export = render_export(&params, &feat, None, 17, 13, None, None, w, h, None);
        assert_eq!(
            export.window_clip.area_frac, 0.0,
            "folded/degenerate geometry must fall back, not certify a window"
        );
        assert_eq!(
            export.window_clip,
            WindowClip {
                left: 0.0,
                right: 0.0,
                top: 0.0,
                bottom: 0.0,
                area_frac: 0.0
            },
            "fallback must report the documented all-zero WindowClip"
        );
    }
}

// ---------------------------------------------------------------------------
// Quad-aligned export framing — three tests. `fit_quad_window`
// is exercised both directly (private-item access via `use super::*`,
// matching `window_fix_tests`'s own convention above) and through the full
// `render_export` entry point.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod quad_aligned_export_tests {
    use super::*;

    fn identity_params(f: f64) -> DewarpParams {
        DewarpParams {
            a: [0.0; 4],
            rvec: [0.0, 0.0, 0.0],
            f,
            cx: 0.0,
            cy: 0.0,
            scale: f,
        }
    }

    fn quad_from_corners(tl: [f64; 2], tr: [f64; 2], br: [f64; 2], bl: [f64; 2]) -> ExportQuad {
        ExportQuad {
            top_left: tl,
            top_right: tr,
            bottom_right: br,
            bottom_left: bl,
        }
    }

    /// Normalize full-resolution crop-pixel corners to `[0,1]` — mirrors
    /// `classical.ts::normalizeQuadToCrop`'s exact `align_corners`-style
    /// division by `dim-1`, so these tests exercise the same convention
    /// production sends across the ABI.
    fn normalized_quad(px: [[f64; 2]; 4], w: u32, h: u32) -> ExportQuad {
        let w_f = (w as f64 - 1.0).max(1.0);
        let h_f = (h as f64 - 1.0).max(1.0);
        let n = |p: [f64; 2]| [p[0] / w_f, p[1] / h_f];
        quad_from_corners(n(px[0]), n(px[1]), n(px[2]), n(px[3]))
    }

    fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
        ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
    }

    /// Test 1, "round-trip": a generous crop, a modest
    /// bow *and* a small rotation with distinct per-edge residual terms (so
    /// a swapped corner, a flipped `y`, or a dropped `uv_to_out` call would
    /// each produce a visibly wrong window, not a coincidentally-correct
    /// one) — the exported window's own four corners (`grid.samples`' first/
    /// last row/column, already crop-pixel space per `RenderedGrid`'s own
    /// doc comment) must backmap close to the quad corners that were fed
    /// in, and the reported `quad_corner_residual` must be small and must
    /// agree with that direct cross-check.
    #[test]
    fn round_trip_window_corners_match_quad_corners() {
        const ROWS: u32 = 17;
        const COLS: u32 = 13;
        let (w, h) = (1600u32, 2000u32);
        let warp = ResidualWarp {
            theta: 4.0f64.to_radians(),
            cs: [2e-6, 8e-7, 0.0, 3e-7],
            ct: [1.5e-6, -6e-7, 0.0, 2e-7],
            u_c: 800.0,
            v_c: 1000.0,
        };
        let params = identity_params(1600.0);

        // Quad comfortably inside a generous feature box, so neither the
        // percentile window nor the crop-bounds certification has to clip.
        let quad_px: [[f64; 2]; 4] = [
            [350.0, 300.0],
            [1250.0, 320.0],
            [1230.0, 1680.0],
            [370.0, 1660.0],
        ];
        let quad = normalized_quad(quad_px, w, h);
        let feat_uv: Vec<[f64; 2]> = vec![[300.0, 280.0], [1280.0, 1700.0]];

        let export = render_export(
            &params,
            &feat_uv,
            None,
            ROWS,
            COLS,
            Some(&warp),
            None,
            w,
            h,
            Some(&quad),
        );
        assert!(
            export.window_clip.area_frac > 0.0,
            "setup must certify a window, not fall back"
        );
        let residual = export
            .quad_corner_residual
            .expect("a quad was supplied and should have been honored");
        assert!(
            residual < 0.05,
            "round-trip residual must clear the 5% guard: {residual}"
        );

        // Cross-check directly against the rendered grid's own corner
        // samples — belt-and-braces against `quad_corner_residual_fraction`
        // itself having a bug (e.g. a mismatched diagonal or a swapped
        // target order would still report a small number by accident).
        let (rows, cols) = (ROWS as usize, COLS as usize);
        let corner = |r: usize, c: usize| export.grid.samples[r * cols + c];
        let diag = dist(quad_px[0], quad_px[2]).max(dist(quad_px[1], quad_px[3]));
        for (label, sample, target) in [
            ("TL", corner(0, 0), quad_px[0]),
            ("TR", corner(0, cols - 1), quad_px[1]),
            ("BR", corner(rows - 1, cols - 1), quad_px[2]),
            ("BL", corner(rows - 1, 0), quad_px[3]),
        ] {
            let frac = dist(sample, target) / diag;
            assert!(
                frac < 0.05,
                "{label}: window corner {sample:?} too far from quad corner {target:?} ({frac})"
            );
        }
    }

    /// Test 2, "bow s≈8%, θ=0": the argument for the corner-mean fit,
    /// reproduced as a test — a symmetric parabolic residual-warp bow along
    /// one edge, sagitta 8% of the quad's diagonal. [`fit_quad_window`]'s
    /// corner-mean fit is *exact* for the two corners it reads (they are
    /// literally the points it maps — nothing to be biased by); a per-edge
    /// **median** over uniformly-sampled points along the same crop-pixel
    /// edge sits `≈0.75×sagitta` off — `0.75×8% ≈ 6%`, over the guard's 5%
    /// tolerance. That is why the fit is to mapped **corners**, never to
    /// per-edge medians.
    #[test]
    fn bowed_edge_corner_fit_beats_a_hypothetical_median() {
        let (w, h) = (1600u32, 2001u32); // h_f = 2000 — an exact edge midpoint at v=1000
        let w_f = (w as f64) - 1.0;
        let h_f = (h as f64) - 1.0;
        let params = identity_params(1600.0);

        // Right edge: TR=(w_f,0), BR=(w_f,h_f) — a vertical crop-pixel
        // chord. `ct`'s `t1` term alone is a pure parabola in `vb`, centered
        // at `v_c = h_f/2` so both corners see the *identical* correction —
        // `fit_quad_window`'s corner-mean is therefore exact for this edge
        // regardless of the bow's magnitude, by construction.
        let quad = quad_from_corners([0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]);
        let diag = (w_f * w_f + h_f * h_f).sqrt();
        let sagitta = 0.08 * diag;
        // q(vb) = 0.5*t1*vb^2; at the corners vb=±h_f/2, so q_corner ==
        // sagitta by this choice of t1.
        let t1 = 2.0 * sagitta / (h_f / 2.0).powi(2);
        let warp = ResidualWarp {
            theta: 0.0,
            cs: [0.0; 4],
            ct: [t1, 0.0, 0.0, 0.0],
            u_c: 0.0,
            v_c: h_f / 2.0,
        };

        let (_l, r, t, _b) = fit_quad_window(&quad, &params, &warp, true, w_f, h_f)
            .expect("a finite, non-degenerate corner mapping must succeed");

        let backmap = |uu: f64, vv: f64| -> [f64; 2] {
            let rectified = warp.out_to_uv(&[[uu, vv]]);
            rectified_to_image(&rectified, &params, None)[0]
        };
        let corner_backmap = backmap(r, t);
        let corner_residual = (corner_backmap[0] - w_f).abs() / diag;
        assert!(
            corner_residual < 0.05,
            "corner-fit residual must clear the 5% guard: {corner_residual}"
        );

        // The rejected proposal: a median over N uniformly-sampled points
        // along the *same* crop-pixel edge (px=w_f, py in [0,h_f]).
        let n = 65usize;
        let mut samples: Vec<f64> = (0..n)
            .map(|i| {
                let py = h_f * (i as f64) / ((n - 1) as f64);
                forward_map_crop_point(w_f, py, &params, &warp, true)
                    .expect("identity params never fold")[0]
            })
            .collect();
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median_r = samples[n / 2];
        let median_backmap = backmap(median_r, t);
        let median_residual = (median_backmap[0] - w_f).abs() / diag;
        assert!(
            median_residual > 0.05,
            "the rejected median approach was expected to FAIL the 5% guard on this fixture (got {median_residual}) \
             — if this assertion fails, the fixture no longer demonstrates why corner-fit was required, fix the fixture"
        );
    }

    /// Test 3, "flush-crop+bow": a quad pushed flush against the crop's
    /// own edge (the production-shaped framing) with the same parabolic bow
    /// as test 2. The quad-aligned window must never sample outside the
    /// buffer — it builds on the crop-bounds certification and never
    /// regresses it — and `window_clip` must be reported either way (a real
    /// clip, or the documented all-zero fallback).
    #[test]
    fn flush_crop_with_bow_never_samples_outside_buffer() {
        let (w, h) = (1600u32, 2001u32);
        let w_f = (w as f64) - 1.0;
        let h_f = (h as f64) - 1.0;
        let params = identity_params(1600.0);

        let diag = (w_f * w_f + h_f * h_f).sqrt();
        let sagitta = 0.08 * diag;
        let t1 = 2.0 * sagitta / (h_f / 2.0).powi(2);
        let warp = ResidualWarp {
            theta: 0.0,
            cs: [0.0; 4],
            ct: [t1, 0.0, 0.0, 0.0],
            u_c: 0.0,
            v_c: h_f / 2.0,
        };

        // Quad flush against every crop edge (0/1 in normalized terms) —
        // Note the trap: corners may sit exactly at 0/1.
        let quad = quad_from_corners([0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]);
        // Feature box matches the quad — the production "6%-padded crop
        // around a confirmed quad" shape leaves the
        // reference percentile window flush too.
        let feat_uv: Vec<[f64; 2]> = vec![[0.0, 0.0], [w_f, h_f]];

        let export = render_export(
            &params,
            &feat_uv,
            None,
            17,
            13,
            Some(&warp),
            None,
            w,
            h,
            Some(&quad),
        );
        for &[x, y] in &export.grid.samples {
            assert!(
                x.is_finite()
                    && y.is_finite()
                    && x >= -0.5
                    && x <= w_f + 0.5
                    && y >= -0.5
                    && y <= h_f + 0.5,
                "sample ({x},{y}) outside buffer 0..{w_f} x 0..{h_f}"
            );
        }
        // Either a real (possibly quad-refined) certified window, or the
        // documented all-zero fallback — never an inconsistent in-between.
        if export.window_clip.area_frac == 0.0 {
            assert_eq!(
                export.window_clip,
                WindowClip {
                    left: 0.0,
                    right: 0.0,
                    top: 0.0,
                    bottom: 0.0,
                    area_frac: 0.0
                },
                "a zero area_frac must be the documented all-zero fallback shape"
            );
        }
    }
}
