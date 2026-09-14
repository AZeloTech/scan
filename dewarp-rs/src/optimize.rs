//! Cost assembly + multi-start optimization with iterative outlier removal —
//! mirrors `optimize.py` 1:1.
//!
//! Auxiliary variables such as `l^k` (line height) are analytically
//! eliminated during residual evaluation via variable projection (their
//! fixed-θ least-squares optimum is the mean, in closed form) — the only
//! eight optimization variables are `Θ = (a_1..a_4, r_1..r_3, log f)`,
//! [`crate::model::N_THETA`].
//!
//! **Row order is a correctness contract, not an implementation detail**:
//! `residuals`/`jacobian` must be produced by one shared assembly function
//! (mirroring `_assemble`'s `want_jac` branch, `optimize.py:157-364`) so
//! residual and Jacobian rows can never silently fall out of sync.
//!
//! **The cost function is piecewise by construction** (`optimize.py:148-155`'s
//! own comment): `argmin`/`argmax` line
//! edges, an even-K median branch in `E_align`, a clipped-gradient mask in
//! `f_str`, a `min(|dx|,|dy|)` branch in `f_align`, and a subgradient at
//! `f = max(w,h)` in `f_regular`. Each is deliberately linearized on the
//! branch active at the current θ — this is why LM trajectories are never
//! compared directly for parity; only discrete outcomes (which coarse
//! candidate wins, per-iteration inlier masks, the final grid RMS) are.
//!
//! ## Traced variants
//!
//! Comparing S4/S5 behaviour against the Python reference needs an
//! *instrumented* run that records every coarse candidate, every
//! outlier-loop iteration, and every boundary-refinement weight-tier
//! attempt — not just the final answer. Hence the split here:
//! [`run_optimization`]/[`refine_with_page_boundary`] are the production
//! entry points (signatures match `optimize.py`'s public API exactly, used
//! by `pipeline.rs`); [`run_optimization_traced`]/
//! [`refine_with_page_boundary_traced`] are thin wrappers that additionally
//! return the recorded trajectory. The trace is cheap (7 coarse candidates,
//! 2-4 outlier iterations, 5 boundary candidates) so there is no need to
//! feature-gate it out of the wasm build.

use crate::linesegs::{LineSegments, PageBoundary};
use crate::model::{
    backproject, backproject_with_grad, flatten_u, flatten_u_with_grad, surface_to_rectified,
    DewarpParams, M_POLY, N_THETA,
};
use crate::options::QualityOptions;
use crate::textline::{Alignment, TextFeatures};

/// `optimize.LAMBDA1_REGULAR` (`optimize.py:41`) — weight of `f_regular`.
pub const LAMBDA1_REGULAR: f64 = 100.0;

/// `optimize.TAU_SEG_INIT` (`optimize.py:42`) — initial segment-outlier
/// threshold, halved each outlier iteration.
pub const TAU_SEG_INIT: f64 = 0.01;

/// `optimize.N_OUTLIER_ITER` (`optimize.py:43`) — module-level default.
/// **Not** what actually governs the outlier loop's iteration count in the
/// ported pipeline; that is `QualityOptions::n_outlier_iter`
/// (`options.py`'s field, threaded through at `optimize.py:795`). Carried
/// here only so that the module-level default is frozen alongside the one
/// that actually governs.
pub const N_OUTLIER_ITER_MODULE_DEFAULT: u32 = 3;

/// `optimize.ProblemData` (`optimize.py:46-60`) — inlier-only features used
/// for one optimization solve.
#[derive(Debug, Clone)]
pub struct ProblemData {
    /// CC centers for each text line, `line_points[k]` is `(N_k, 2)`.
    pub line_points: Vec<Vec<[f64; 2]>>,
    /// Block index containing each line — `block_of_line[k]` pairs with
    /// `line_points[k]`.
    pub block_of_line: Vec<usize>,
    /// Alignment classification per block (indexed by block id, so
    /// `alignments.len() == n_blocks`, not `line_points.len()`).
    pub alignments: Vec<Alignment>,
    pub segments: Vec<[f64; 4]>,
    pub img_w: u32,
    pub img_h: u32,
    pub mean_text_size: f64,
    pub use_line_term: bool,
}

impl ProblemData {
    /// `ProblemData.n_text_points` (`optimize.py:59-60`).
    pub fn n_text_points(&self) -> usize {
        self.line_points.iter().map(|p| p.len()).sum()
    }
}

/// `optimize.pack_theta` (`optimize.py:63-64`): `[a_1..a_4, r_1..r_3, log f]`.
pub fn pack_theta(params: &DewarpParams) -> [f64; N_THETA] {
    [
        params.a[0],
        params.a[1],
        params.a[2],
        params.a[3],
        params.rvec[0],
        params.rvec[1],
        params.rvec[2],
        params.f.ln(),
    ]
}

/// `optimize.unpack_theta` (`optimize.py:67-75`). `template` supplies
/// `cx`/`cy`/`scale`, which are not optimization variables.
pub fn unpack_theta(theta: &[f64; N_THETA], template: &DewarpParams) -> DewarpParams {
    DewarpParams {
        a: [theta[0], theta[1], theta[2], theta[3]],
        rvec: [theta[4], theta[5], theta[6]],
        f: theta[7].exp(),
        cx: template.cx,
        cy: template.cy,
        scale: template.scale,
    }
}

// ---------------------------------------------------------------------------
// Small numeric helpers, private to this module — plain accumulation, fixed
// order, no FMA contraction.
// ---------------------------------------------------------------------------

fn mean(v: &[f64]) -> f64 {
    let mut s = 0.0;
    for &x in v {
        s += x;
    }
    s / v.len() as f64
}

fn std_dev(v: &[f64]) -> f64 {
    // `np.std` default: population std (ddof=0).
    let m = mean(v);
    let mut var = 0.0;
    for &x in v {
        var += (x - m) * (x - m);
    }
    (var / v.len() as f64).sqrt()
}

fn ptp(v: &[f64]) -> f64 {
    let hi = v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let lo = v.iter().cloned().fold(f64::INFINITY, f64::min);
    hi - lo
}

fn argmin(v: &[f64]) -> usize {
    let mut best = 0usize;
    let mut best_v = v[0];
    for (i, &x) in v.iter().enumerate().skip(1) {
        if x < best_v {
            best_v = x;
            best = i;
        }
    }
    best
}

fn argmax(v: &[f64]) -> usize {
    let mut best = 0usize;
    let mut best_v = v[0];
    for (i, &x) in v.iter().enumerate().skip(1) {
        if x > best_v {
            best_v = x;
            best = i;
        }
    }
    best
}

/// `np.sign` — `-1`/`0`/`1`, distinct from a plain `>=0 ? 1 : -1` branch:
/// `f_align`'s Jacobian (`optimize.py:317-320`) genuinely zeroes the
/// gradient contribution when `dx`/`dy` is exactly zero.
fn np_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        0.0
    }
}

fn colmean(rows: &[[f64; N_THETA]]) -> [f64; N_THETA] {
    let mut out = [0.0; N_THETA];
    for row in rows {
        for c in 0..N_THETA {
            out[c] += row[c];
        }
    }
    let n = rows.len() as f64;
    for c in 0..N_THETA {
        out[c] /= n;
    }
    out
}

/// Append one residual block (and, when `want_jac`, its matching Jacobian
/// rows) — `optimize.py`'s local `add()` closure inside `_assemble`
/// (`optimize.py:170-174`), lifted to a free function so it never captures
/// `&mut self` ambiguously alongside the field-level borrows `_assemble`
/// needs.
fn add_block(
    res: &mut Vec<f64>,
    jac_rows: &mut Vec<[f64; N_THETA]>,
    want_jac: bool,
    r: &[f64],
    j: Option<&[[f64; N_THETA]]>,
) {
    res.extend_from_slice(r);
    if want_jac {
        let j = j.expect("add_block: want_jac=true requires a Jacobian block");
        debug_assert_eq!(j.len(), r.len());
        jac_rows.extend_from_slice(j);
    }
}

/// Insertion-ordered multimap — mirrors a Python `dict`'s iteration-order
/// guarantee (first-seen key order), which `_assemble`'s `line_means`/
/// `align_edges` dicts rely on for the E_spacing/E_align residual **row
/// order** (`optimize.py:177-180,220,244`). A plain `HashMap` would produce
/// an arbitrary (and non-reproducible across runs) row order; `E_align`
/// additionally keys the same dict by both positive (`bi`, the "left" edge
/// group) and negative (`-bi-1`, the "right" edge group) integers within one
/// map (`optimize.py:209,214`), which is why the key type here is `i64`, not
/// `usize`.
struct OrderedMap<V> {
    order: Vec<i64>,
    map: std::collections::HashMap<i64, V>,
}

impl<V> OrderedMap<V> {
    fn new() -> Self {
        OrderedMap {
            order: Vec::new(),
            map: std::collections::HashMap::new(),
        }
    }

    fn entry_or_insert_with(&mut self, key: i64, default: impl FnOnce() -> V) -> &mut V {
        if let std::collections::hash_map::Entry::Vacant(e) = self.map.entry(key) {
            self.order.push(key);
            e.insert(default());
        }
        self.map
            .get_mut(&key)
            .expect("key was just inserted or already present")
    }

    fn iter_in_order(&self) -> impl Iterator<Item = (i64, &V)> {
        self.order.iter().map(move |k| {
            (
                *k,
                self.map
                    .get(k)
                    .expect("order/map kept in sync by entry_or_insert_with"),
            )
        })
    }
}

#[derive(Default)]
struct LineMeansGroup {
    means: Vec<f64>,
    dmeans: Vec<[f64; N_THETA]>,
}

#[derive(Default)]
struct AlignGroup {
    edges: Vec<f64>,
    dedges: Vec<[f64; N_THETA]>,
}

/// `optimize.CostFunction` (`optimize.py:78-384`). Owns the Newton
/// back-projection warm-start caches (`optimize.py:127-143`) — every method
/// that back-projects mutates them, so all of `residuals`/`jacobian`/
/// `segment_align_values`/`textline_straightness` below take `&mut self`
/// even though several are read-only in spirit (the cache write is the
/// exception; see [`CostFunction::reset_cache`]'s doc comment for why
/// carrying stale cache state across independent solves is a parity hazard,
/// not just a performance detail).
pub struct CostFunction {
    data: ProblemData,
    template: DewarpParams,
    /// Fixed feature set for the scale anchor (`optimize.py:83-93`'s
    /// `anchor_pts`), independent of outlier removal.
    anchor_pts: Option<Vec<[f64; 2]>>,
    v_scale_ref: Option<f64>,
    align_eligible: Vec<bool>,
    /// Segment `p`, `q`, `r` (midpoint) points stacked for one combined
    /// back-projection call (`optimize.py:113-120`).
    seg_pts: Vec<[f64; 2]>,
    lambda2: f64,
    lambda3: f64,
    k_cache_anchor: Option<Vec<f64>>,
    k_cache_text: Vec<Option<Vec<f64>>>,
    k_cache_seg: Option<Vec<f64>>,
}

impl CostFunction {
    /// `CostFunction.__init__` (`optimize.py:79-129`).
    pub fn new(
        data: ProblemData,
        template: DewarpParams,
        anchor_pts: Option<Vec<[f64; 2]>>,
        v_scale_ref: Option<f64>,
    ) -> Self {
        // Lines eligible for E_align: exclude lines below 80% of their
        // block's mean width (final paragraph lines etc. don't align at
        // both ends). Widths are image-coordinate (θ-independent) so the
        // eligibility set — and hence residual-vector length — never
        // depends on the parameters (optimize.py:100-112).
        let widths: Vec<f64> = data
            .line_points
            .iter()
            .map(|pts| {
                let xs: Vec<f64> = pts.iter().map(|p| p[0]).collect();
                ptp(&xs)
            })
            .collect();
        let mut align_eligible = vec![false; widths.len()];
        let mut unique_blocks: Vec<usize> = data.block_of_line.clone();
        unique_blocks.sort_unstable();
        unique_blocks.dedup();
        for &bi in &unique_blocks {
            let idx: Vec<usize> = (0..data.block_of_line.len())
                .filter(|&i| data.block_of_line[i] == bi)
                .collect();
            let wmean: f64 = idx.iter().map(|&i| widths[i]).sum::<f64>() / idx.len() as f64;
            for &i in &idx {
                align_eligible[i] = widths[i] >= 0.8 * wmean;
            }
        }

        // Point sequence for back-projecting segment p, q, r together
        // (optimize.py:113-120).
        let seg_pts: Vec<[f64; 2]> = if !data.segments.is_empty() {
            let n = data.segments.len();
            let mut v = Vec::with_capacity(3 * n);
            for s in &data.segments {
                v.push([s[0], s[1]]);
            }
            for s in &data.segments {
                v.push([s[2], s[3]]);
            }
            for s in &data.segments {
                v.push([0.5 * (s[0] + s[2]), 0.5 * (s[1] + s[3])]);
            }
            v
        } else {
            Vec::new()
        };

        let n_text = data.n_text_points().max(1) as f64;
        let n_line = data.segments.len().max(1) as f64;
        let lambda2 = n_text / n_line;
        let lambda3 = (n_text / n_line) * data.mean_text_size * data.mean_text_size;

        let k_cache_text = vec![None; data.line_points.len()];
        CostFunction {
            data,
            template,
            anchor_pts,
            v_scale_ref,
            align_eligible,
            seg_pts,
            lambda2,
            lambda3,
            k_cache_anchor: None,
            k_cache_text,
            k_cache_seg: None,
        }
    }

    /// `CostFunction.reset_cache` (`optimize.py:131-143`). Must be called
    /// at exactly the same points the Python reference calls it (every
    /// independent `_solve`/scoring evaluation, e.g. `_solve`'s first line
    /// and `_coarse_score`'s first line) — carrying warm-start state
    /// between multi-start candidates or independent scoring evaluations
    /// creates hidden coupling: back-projection can converge to a different
    /// Newton branch in high-curvature regions depending on what the
    /// *previous* candidate left in the cache. The Python reference says
    /// so explicitly, and it is easy to "optimize away".
    pub fn reset_cache(&mut self) {
        self.k_cache_anchor = None;
        self.k_cache_text = vec![None; self.data.line_points.len()];
        self.k_cache_seg = None;
    }

    /// `CostFunction.residuals` (`optimize.py:145-146`).
    pub fn residuals(&mut self, theta: &[f64; N_THETA]) -> Vec<f64> {
        self.assemble(theta, false).0
    }

    /// `CostFunction.jacobian` (`optimize.py:148-155`).
    pub fn jacobian(&mut self, theta: &[f64; N_THETA]) -> Vec<Vec<f64>> {
        self.assemble(theta, true)
            .1
            .expect("want_jac=true always returns Some")
    }

    /// `CostFunction._assemble` (`optimize.py:157-364`) — the single
    /// shared residual+Jacobian assembly function. Block order (fixed,
    /// mirrors the Python source exactly):
    ///
    /// 1. `E_str` + `E_spacing` + `E_align`, per text line/block
    ///    (`optimize.py:176-263`);
    /// 2. `f_str` + `f_align`, per segment, only when
    ///    `data.use_line_term && !data.segments.is_empty()`
    ///    (`optimize.py:265-326`);
    /// 3. `f_regular`, exactly 1 row (`optimize.py:328-341`);
    /// 4. the scale anchor, exactly 1 row, only when both `v_scale_ref` and
    ///    `anchor_pts` are set (`optimize.py:343-361`).
    ///
    /// Returns `(residuals, Some(jacobian))` when `want_jac`, else
    /// `(residuals, None)`.
    fn assemble(
        &mut self,
        theta: &[f64; N_THETA],
        want_jac: bool,
    ) -> (Vec<f64>, Option<Vec<Vec<f64>>>) {
        let params = unpack_theta(theta, &self.template);
        let mut res: Vec<f64> = Vec::new();
        let mut jac_rows: Vec<[f64; N_THETA]> = Vec::new();

        // --- f_text: E_str, plus line-means/align-edges bookkeeping -----
        let mut line_means: OrderedMap<LineMeansGroup> = OrderedMap::new();
        let mut align_groups: OrderedMap<AlignGroup> = OrderedMap::new();

        for li in 0..self.data.line_points.len() {
            let pts = &self.data.line_points[li];
            let sx: Vec<f64>;
            let sy: Vec<f64>;
            let d_sx: Option<Vec<[f64; N_THETA]>>;
            let d_sy: Option<Vec<[f64; N_THETA]>>;
            if want_jac {
                let bpg = backproject_with_grad(pts, &params, self.k_cache_text[li].as_deref());
                self.k_cache_text[li] = Some(bpg.k);
                sx = bpg.sx;
                sy = bpg.sy;
                d_sx = Some(bpg.d_sx);
                d_sy = Some(bpg.d_sy);
            } else {
                let bp = backproject(pts, &params, self.k_cache_text[li].as_deref());
                self.k_cache_text[li] = Some(bp.k);
                sx = bp.sx;
                sy = bp.sy;
                d_sx = None;
                d_sy = None;
            }
            let mean_y = mean(&sy);
            let dmean: Option<[f64; N_THETA]> = d_sy.as_ref().map(|d| colmean(d));

            let r_str: Vec<f64> = sy.iter().map(|&v| v - mean_y).collect();
            if want_jac {
                let dsy = d_sy.as_ref().expect("want_jac branch sets d_sy");
                let dm = dmean.expect("want_jac branch sets dmean");
                let j_str: Vec<[f64; N_THETA]> = dsy
                    .iter()
                    .map(|row| {
                        let mut o = [0.0; N_THETA];
                        for c in 0..N_THETA {
                            o[c] = row[c] - dm[c];
                        }
                        o
                    })
                    .collect();
                add_block(&mut res, &mut jac_rows, want_jac, &r_str, Some(&j_str));
            } else {
                add_block(&mut res, &mut jac_rows, want_jac, &r_str, None);
            }

            let bi = self.data.block_of_line[li];
            {
                let group = line_means.entry_or_insert_with(bi as i64, LineMeansGroup::default);
                group.means.push(mean_y);
                if want_jac {
                    group
                        .dmeans
                        .push(dmean.expect("want_jac branch sets dmean"));
                }
            }

            if self.align_eligible[li] {
                let align = self.data.alignments[bi];
                if matches!(
                    align,
                    Alignment::Left | Alignment::Right | Alignment::Justified
                ) {
                    let (u, du): (Vec<f64>, Option<Vec<[f64; N_THETA]>>) = if want_jac {
                        let dsx = d_sx.as_ref().expect("want_jac branch sets d_sx");
                        let (uu, duu) = flatten_u_with_grad(&sx, dsx, &params);
                        (uu, Some(duu))
                    } else {
                        (flatten_u(&sx, &params), None)
                    };
                    if matches!(align, Alignment::Left | Alignment::Justified) {
                        let i0 = argmin(&u);
                        let g = align_groups.entry_or_insert_with(bi as i64, AlignGroup::default);
                        g.edges.push(u[i0]);
                        if want_jac {
                            g.dedges
                                .push(du.as_ref().expect("want_jac branch sets du")[i0]);
                        }
                    }
                    if matches!(align, Alignment::Right | Alignment::Justified) {
                        let i1 = argmax(&u);
                        let key = -(bi as i64) - 1;
                        let g = align_groups.entry_or_insert_with(key, AlignGroup::default);
                        g.edges.push(u[i1]);
                        if want_jac {
                            g.dedges
                                .push(du.as_ref().expect("want_jac branch sets du")[i1]);
                        }
                    }
                }
            }
        }

        // --- E_spacing: second differences of sorted mean line heights --
        for (bi_key, group) in line_means.iter_in_order() {
            let bi = bi_key as usize;
            if matches!(self.data.alignments[bi], Alignment::Coarse) || group.means.len() < 3 {
                continue;
            }
            let m_arr = &group.means;
            let mut order: Vec<usize> = (0..m_arr.len()).collect();
            order.sort_by(|&a, &b| m_arr[a].partial_cmp(&m_arr[b]).unwrap());
            let m: Vec<f64> = order.iter().map(|&i| m_arr[i]).collect();
            let dgap: Vec<f64> = (0..m.len() - 1).map(|i| m[i + 1] - m[i]).collect();
            let med = crate::stats::median(&dgap);
            if med <= 0.0 {
                continue;
            }
            let ok: Vec<bool> = dgap
                .iter()
                .map(|&g| g > 0.6 * med && g < 1.6 * med)
                .collect();
            let pair_ok: Vec<bool> = (0..ok.len() - 1).map(|i| ok[i] && ok[i + 1]).collect();
            let second: Vec<f64> = (0..m.len() - 2)
                .map(|i| m[i] - 2.0 * m[i + 1] + m[i + 2])
                .collect();
            let r: Vec<f64> = (0..pair_ok.len())
                .map(|i| if pair_ok[i] { second[i] } else { 0.0 })
                .collect();
            if want_jac {
                let dm: Vec<[f64; N_THETA]> = order.iter().map(|&i| group.dmeans[i]).collect();
                let dsecond: Vec<[f64; N_THETA]> = (0..dm.len() - 2)
                    .map(|i| {
                        let mut o = [0.0; N_THETA];
                        for c in 0..N_THETA {
                            o[c] = dm[i][c] - 2.0 * dm[i + 1][c] + dm[i + 2][c];
                        }
                        o
                    })
                    .collect();
                let j: Vec<[f64; N_THETA]> = (0..pair_ok.len())
                    .map(|i| {
                        if pair_ok[i] {
                            dsecond[i]
                        } else {
                            [0.0; N_THETA]
                        }
                    })
                    .collect();
                add_block(&mut res, &mut jac_rows, want_jac, &r, Some(&j));
            } else {
                add_block(&mut res, &mut jac_rows, want_jac, &r, None);
            }
        }

        // --- E_align: median centering, outlier exclusion, weight 0.3 ---
        let w_align = 0.3_f64;
        let sw = w_align.sqrt();
        let tol_align = 2.0 * self.data.mean_text_size;
        for (_key, group) in align_groups.iter_in_order() {
            if group.edges.len() < 2 {
                continue;
            }
            let e = &group.edges;
            let med_e = crate::stats::median(e);
            let r: Vec<f64> = e.iter().map(|&v| v - med_e).collect();
            let mask: Vec<bool> = r.iter().map(|&v| v.abs() < tol_align).collect();
            let r_masked: Vec<f64> = (0..r.len())
                .map(|i| if mask[i] { r[i] } else { 0.0 })
                .collect();
            let r_scaled: Vec<f64> = r_masked.iter().map(|&v| sw * v).collect();
            if want_jac {
                let de = &group.dedges;
                let mut order: Vec<usize> = (0..e.len()).collect();
                order.sort_by(|&a, &b| e[a].partial_cmp(&e[b]).unwrap());
                let k = e.len();
                let dmed: [f64; N_THETA] = if k % 2 == 1 {
                    de[order[k / 2]]
                } else {
                    let a = de[order[k / 2 - 1]];
                    let b = de[order[k / 2]];
                    let mut o = [0.0; N_THETA];
                    for c in 0..N_THETA {
                        o[c] = 0.5 * (a[c] + b[c]);
                    }
                    o
                };
                let j: Vec<[f64; N_THETA]> = (0..r.len())
                    .map(|i| {
                        let mut o = [0.0; N_THETA];
                        if mask[i] {
                            for c in 0..N_THETA {
                                o[c] = sw * (de[i][c] - dmed[c]);
                            }
                        }
                        o
                    })
                    .collect();
                add_block(&mut res, &mut jac_rows, want_jac, &r_scaled, Some(&j));
            } else {
                add_block(&mut res, &mut jac_rows, want_jac, &r_scaled, None);
            }
        }

        // --- f_line: f_str + f_align, per segment ------------------------
        if self.data.use_line_term && !self.data.segments.is_empty() {
            let n = self.data.segments.len();
            let u_s: Vec<f64>;
            let v_s: Vec<f64>;
            let du_s: Option<Vec<[f64; N_THETA]>>;
            let dv_s: Option<Vec<[f64; N_THETA]>>;
            if want_jac {
                let bpg =
                    backproject_with_grad(&self.seg_pts, &params, self.k_cache_seg.as_deref());
                self.k_cache_seg = Some(bpg.k);
                let (uu, duu) = flatten_u_with_grad(&bpg.sx, &bpg.d_sx, &params);
                u_s = uu;
                v_s = bpg.sy;
                du_s = Some(duu);
                dv_s = Some(bpg.d_sy);
            } else {
                let bp = backproject(&self.seg_pts, &params, self.k_cache_seg.as_deref());
                self.k_cache_seg = Some(bp.k);
                u_s = flatten_u(&bp.sx, &params);
                v_s = bp.sy;
                du_s = None;
                dv_s = None;
            }
            let pu = &u_s[0..n];
            let pv = &v_s[0..n];
            let qu = &u_s[n..2 * n];
            let qv = &v_s[n..2 * n];
            let ru = &u_s[2 * n..3 * n];
            let rv = &v_s[2 * n..3 * n];
            let dx: Vec<f64> = (0..n).map(|i| qu[i] - pu[i]).collect();
            let dy: Vec<f64> = (0..n).map(|i| qv[i] - pv[i]).collect();
            let l: Vec<f64> = (0..n).map(|i| dx[i].hypot(dy[i]).max(1e-9)).collect();
            let cross: Vec<f64> = (0..n)
                .map(|i| dx[i] * (rv[i] - pv[i]) - dy[i] * (ru[i] - pu[i]))
                .collect();
            let dist: Vec<f64> = (0..n).map(|i| cross[i] / l[i]).collect();
            let c_str = 10.0 * self.data.mean_text_size;
            let in_clip: Vec<bool> = dist.iter().map(|&d| d.abs() < c_str).collect();
            let dist_clipped: Vec<f64> = dist.iter().map(|&d| d.max(-c_str).min(c_str)).collect();
            let ax: Vec<f64> = dx.iter().map(|v| v.abs()).collect();
            let ay: Vec<f64> = dy.iter().map(|v| v.abs()).collect();
            let use_x: Vec<bool> = (0..n).map(|i| ax[i] <= ay[i]).collect();
            let align_r: Vec<f64> = (0..n)
                .map(|i| (if use_x[i] { ax[i] } else { ay[i] }) / l[i])
                .collect();

            let sqrt_l2 = self.lambda2.sqrt();
            let sqrt_l3 = self.lambda3.sqrt();
            let r1: Vec<f64> = dist_clipped.iter().map(|&d| sqrt_l2 * d).collect();
            let r2: Vec<f64> = align_r.iter().map(|&a| sqrt_l3 * a).collect();

            if want_jac {
                let du = du_s.as_ref().expect("want_jac branch sets du_s");
                let dv = dv_s.as_ref().expect("want_jac branch sets dv_s");
                let dpu = &du[0..n];
                let dpv = &dv[0..n];
                let dqu = &du[n..2 * n];
                let dqv = &dv[n..2 * n];
                let dru = &du[2 * n..3 * n];
                let drv = &dv[2 * n..3 * n];
                let mut j1: Vec<[f64; N_THETA]> = Vec::with_capacity(n);
                let mut j2: Vec<[f64; N_THETA]> = Vec::with_capacity(n);
                for i in 0..n {
                    let mut ddx = [0.0; N_THETA];
                    let mut ddy = [0.0; N_THETA];
                    for c in 0..N_THETA {
                        ddx[c] = dqu[i][c] - dpu[i][c];
                        ddy[c] = dqv[i][c] - dpv[i][c];
                    }
                    let mut dl = [0.0; N_THETA];
                    for c in 0..N_THETA {
                        dl[c] = (dx[i] * ddx[c] + dy[i] * ddy[c]) / l[i];
                    }
                    let mut dcross = [0.0; N_THETA];
                    for c in 0..N_THETA {
                        dcross[c] = ddx[c] * (rv[i] - pv[i]) + dx[i] * (drv[i][c] - dpv[i][c])
                            - ddy[c] * (ru[i] - pu[i])
                            - dy[i] * (dru[i][c] - dpu[i][c]);
                    }
                    let mut ddist = [0.0; N_THETA];
                    if in_clip[i] {
                        for c in 0..N_THETA {
                            ddist[c] = dcross[c] / l[i] - (cross[i] / (l[i] * l[i])) * dl[c];
                        }
                    }
                    let mut jr1 = [0.0; N_THETA];
                    for c in 0..N_THETA {
                        jr1[c] = sqrt_l2 * ddist[c];
                    }
                    j1.push(jr1);

                    let mut dnum = [0.0; N_THETA];
                    if use_x[i] {
                        let s = np_sign(dx[i]);
                        for c in 0..N_THETA {
                            dnum[c] = s * ddx[c];
                        }
                    } else {
                        let s = np_sign(dy[i]);
                        for c in 0..N_THETA {
                            dnum[c] = s * ddy[c];
                        }
                    }
                    let mut dalign = [0.0; N_THETA];
                    for c in 0..N_THETA {
                        dalign[c] = dnum[c] / l[i] - (align_r[i] / l[i]) * dl[c];
                    }
                    let mut jr2 = [0.0; N_THETA];
                    for c in 0..N_THETA {
                        jr2[c] = sqrt_l3 * dalign[c];
                    }
                    j2.push(jr2);
                }
                add_block(&mut res, &mut jac_rows, want_jac, &r1, Some(&j1));
                add_block(&mut res, &mut jac_rows, want_jac, &r2, Some(&j2));
            } else {
                add_block(&mut res, &mut jac_rows, want_jac, &r1, None);
                add_block(&mut res, &mut jac_rows, want_jac, &r2, None);
            }
        }

        // --- f_regular ----------------------------------------------------
        let a_img = self.data.img_w.max(self.data.img_h) as f64;
        let ratio = a_img.max(params.f) / a_img.min(params.f);
        let r_reg = LAMBDA1_REGULAR.sqrt() * (ratio - 1.0);
        if want_jac {
            let mut j = [0.0; N_THETA];
            if params.f > a_img * (1.0 + 1e-9) {
                j[N_THETA - 1] = LAMBDA1_REGULAR.sqrt() * ratio;
            } else if params.f < a_img * (1.0 - 1e-9) {
                j[N_THETA - 1] = -LAMBDA1_REGULAR.sqrt() * ratio;
            }
            add_block(
                &mut res,
                &mut jac_rows,
                want_jac,
                &[r_reg],
                Some(std::slice::from_ref(&j)),
            );
        } else {
            add_block(&mut res, &mut jac_rows, want_jac, &[r_reg], None);
        }

        // --- scale anchor ---------------------------------------------------
        if let (Some(v_ref), Some(anchor)) = (self.v_scale_ref, self.anchor_pts.as_ref()) {
            let sy_a: Vec<f64>;
            let dsy_a: Option<Vec<[f64; N_THETA]>>;
            if want_jac {
                let bpg = backproject_with_grad(anchor, &params, self.k_cache_anchor.as_deref());
                self.k_cache_anchor = Some(bpg.k);
                sy_a = bpg.sy;
                dsy_a = Some(bpg.d_sy);
            } else {
                let bp = backproject(anchor, &params, self.k_cache_anchor.as_deref());
                self.k_cache_anchor = Some(bp.k);
                sy_a = bp.sy;
                dsy_a = None;
            }
            let mean_sy = mean(&sy_a);
            let sigma_v = std_dev(&sy_a);
            let w_anchor = (anchor.len() as f64).sqrt() * self.data.mean_text_size;
            let r_anchor = w_anchor * (sigma_v / v_ref - 1.0);
            if want_jac {
                let dsy = dsy_a.as_ref().expect("want_jac branch sets dsy_a");
                let centered: Vec<f64> = sy_a.iter().map(|&v| v - mean_sy).collect();
                let denom = sigma_v.max(1e-9);
                let mut dsigma = [0.0; N_THETA];
                for c in 0..N_THETA {
                    let mut s = 0.0;
                    for i in 0..sy_a.len() {
                        s += centered[i] * dsy[i][c];
                    }
                    dsigma[c] = (s / sy_a.len() as f64) / denom;
                }
                let mut j = [0.0; N_THETA];
                for c in 0..N_THETA {
                    j[c] = (w_anchor / v_ref) * dsigma[c];
                }
                add_block(
                    &mut res,
                    &mut jac_rows,
                    want_jac,
                    &[r_anchor],
                    Some(std::slice::from_ref(&j)),
                );
            } else {
                add_block(&mut res, &mut jac_rows, want_jac, &[r_anchor], None);
            }
        }

        if want_jac {
            let jac: Vec<Vec<f64>> = jac_rows.into_iter().map(|row| row.to_vec()).collect();
            (res, Some(jac))
        } else {
            (res, None)
        }
    }

    /// `CostFunction.segment_align_values` (`optimize.py:366-375`): each
    /// segment's `f_align` value, used by the outlier loop's segment
    /// threshold test (`segment_align_values(theta) < tau`).
    pub fn segment_align_values(&self, theta: &[f64; N_THETA]) -> Vec<f64> {
        if self.data.segments.is_empty() {
            return Vec::new();
        }
        let params = unpack_theta(theta, &self.template);
        let uv = surface_to_rectified(&self.seg_pts, &params, None);
        let n = self.data.segments.len();
        (0..n)
            .map(|i| {
                let dx = uv[n + i][0] - uv[i][0];
                let dy = uv[n + i][1] - uv[i][1];
                let len2 = (dx * dx + dy * dy).max(1e-18);
                (dx * dx).min(dy * dy) / len2
            })
            .collect()
    }

    /// `CostFunction.textline_straightness` (`optimize.py:377-384`): each
    /// text line's RMS straightness residual, used by the outlier loop's
    /// text-line threshold test.
    pub fn textline_straightness(&self, theta: &[f64; N_THETA]) -> Vec<f64> {
        let params = unpack_theta(theta, &self.template);
        self.data
            .line_points
            .iter()
            .map(|pts| {
                let bp = backproject(pts, &params, None);
                let mean_y = mean(&bp.sy);
                let mut sq = 0.0;
                for &v in &bp.sy {
                    sq += (v - mean_y) * (v - mean_y);
                }
                (sq / bp.sy.len() as f64).sqrt()
            })
            .collect()
    }
}

/// `optimize.BoundaryCostFunction` (`optimize.py:387-436`). Python
/// subclasses `CostFunction` and overrides `_assemble` to append page-side
/// residuals after calling `super()._assemble()`; Rust has no class
/// inheritance, so this wraps a [`CostFunction`] by composition and
/// re-exposes the same `residuals`/`jacobian`/`reset_cache` surface,
/// delegating to the base for everything except [`BoundaryCostFunction::assemble`]'s
/// own appended rows.
///
/// Appends, for each of the 4 [`PageBoundary`] sides: `√w·(coord -
/// mean(coord))`, where `coord` is `Sy` for top/bottom and flattened `u`
/// for left/right — `+200` rows total (`4 × 50`). Inliers are frozen at the
/// baseline set (this cost function is only ever used for a fixed-inlier
/// refinement pass, `refine_with_page_boundary` below).
pub struct BoundaryCostFunction {
    base: CostFunction,
    boundary: PageBoundary,
    boundary_weight: f64,
}

impl BoundaryCostFunction {
    pub fn new(
        data: ProblemData,
        template: DewarpParams,
        boundary: PageBoundary,
        boundary_weight: f64,
        anchor_pts: Option<Vec<[f64; 2]>>,
        v_scale_ref: Option<f64>,
    ) -> Self {
        let base = CostFunction::new(data, template, anchor_pts, v_scale_ref);
        BoundaryCostFunction {
            base,
            boundary,
            boundary_weight,
        }
    }

    pub fn reset_cache(&mut self) {
        self.base.reset_cache();
    }

    pub fn residuals(&mut self, theta: &[f64; N_THETA]) -> Vec<f64> {
        self.assemble(theta, false).0
    }

    pub fn jacobian(&mut self, theta: &[f64; N_THETA]) -> Vec<Vec<f64>> {
        self.assemble(theta, true)
            .1
            .expect("want_jac=true always returns Some")
    }

    /// `BoundaryCostFunction._assemble` (`optimize.py:410-436`): base
    /// residuals/Jacobian, then the 4-side boundary block appended.
    fn assemble(
        &mut self,
        theta: &[f64; N_THETA],
        want_jac: bool,
    ) -> (Vec<f64>, Option<Vec<Vec<f64>>>) {
        let (base_r, base_j) = self.base.assemble(theta, want_jac);
        let params = unpack_theta(theta, &self.base.template);
        let scale = self.boundary_weight.sqrt();
        let mut res = base_r;
        let mut jac_rows: Vec<Vec<f64>> = base_j.unwrap_or_default();

        for (name, pts) in self.boundary.sides() {
            if want_jac {
                let bpg = backproject_with_grad(pts, &params, None);
                let (coord, dcoord): (Vec<f64>, Vec<[f64; N_THETA]>) =
                    if name == "top" || name == "bottom" {
                        (bpg.sy, bpg.d_sy)
                    } else {
                        flatten_u_with_grad(&bpg.sx, &bpg.d_sx, &params)
                    };
                let mean_c = mean(&coord);
                let dmean_c = colmean(&dcoord);
                for i in 0..coord.len() {
                    res.push(scale * (coord[i] - mean_c));
                    let mut row = vec![0.0; N_THETA];
                    for c in 0..N_THETA {
                        row[c] = scale * (dcoord[i][c] - dmean_c[c]);
                    }
                    jac_rows.push(row);
                }
            } else {
                let bp = backproject(pts, &params, None);
                let coord: Vec<f64> = if name == "top" || name == "bottom" {
                    bp.sy
                } else {
                    flatten_u(&bp.sx, &params)
                };
                let mean_c = mean(&coord);
                for &c in &coord {
                    res.push(scale * (c - mean_c));
                }
            }
        }

        (res, if want_jac { Some(jac_rows) } else { None })
    }
}

/// Common surface both [`CostFunction`] and [`BoundaryCostFunction`] expose
/// to [`solve_theta`] — lets one `_solve`-equivalent serve both (Python's
/// `_solve` is untyped and works on either via duck typing; Rust needs a
/// trait). Method names/signatures mirror the inherent methods on each type
/// exactly (no behavior difference — this is pure dispatch plumbing).
trait Solvable {
    fn reset_cache(&mut self);
    fn residuals(&mut self, theta: &[f64; N_THETA]) -> Vec<f64>;
    fn jacobian(&mut self, theta: &[f64; N_THETA]) -> Vec<Vec<f64>>;
}

impl Solvable for CostFunction {
    fn reset_cache(&mut self) {
        CostFunction::reset_cache(self)
    }
    fn residuals(&mut self, theta: &[f64; N_THETA]) -> Vec<f64> {
        CostFunction::residuals(self, theta)
    }
    fn jacobian(&mut self, theta: &[f64; N_THETA]) -> Vec<Vec<f64>> {
        CostFunction::jacobian(self, theta)
    }
}

impl Solvable for BoundaryCostFunction {
    fn reset_cache(&mut self) {
        BoundaryCostFunction::reset_cache(self)
    }
    fn residuals(&mut self, theta: &[f64; N_THETA]) -> Vec<f64> {
        BoundaryCostFunction::residuals(self, theta)
    }
    fn jacobian(&mut self, theta: &[f64; N_THETA]) -> Vec<Vec<f64>> {
        BoundaryCostFunction::jacobian(self, theta)
    }
}

/// `optimize.initial_params` (`optimize.py:439-448`): `f0 = max(w,h)`
/// (≈FOV 53°, the zero of `f_regular`), `cx,cy = w/2, h/2`,
/// `scale = max(w,h)`, `a = rvec = 0`.
pub fn initial_params(img_w: u32, img_h: u32) -> DewarpParams {
    let f0 = img_w.max(img_h) as f64;
    DewarpParams {
        a: [0.0; M_POLY],
        rvec: [0.0; 3],
        f: f0,
        cx: img_w as f64 / 2.0,
        cy: img_h as f64 / 2.0,
        scale: f0,
    }
}

/// `optimize._solve` (`optimize.py:451-514`). Bounds: `a ∈ [-a_bound,
/// a_bound]`, `rvec ∈ [-1, 1]`, `log f ∈ [log(0.5·a_img/tan37°),
/// log(0.5·a_img/tan15°)]` (FOV 30°-74°) unless `f_bounds` is given
/// (narrows to `±18%` around an EXIF estimate, taking precedence).
///
/// `fix_f = true` (the coarse multi-start stage): holds `f` at `theta0`'s
/// value and solves only the leading 7 parameters (bounds on `a`/`rvec`
/// only). This was measured: without those bounds the coarse stage's
/// `E_str` degeneracy creates a strong false-attractor basin that can
/// swallow every multi-start candidate and winner selection fails.
///
/// Calls [`CostFunction::reset_cache`] as its first action (`optimize.py:468`) —
/// this is one of the exact points at which the cache must be reset.
/// Generic over [`Solvable`] so both [`CostFunction`] (the
/// ordinary text-first solve) and [`BoundaryCostFunction`] (S5's
/// fixed-inlier refinement, `fix_f` always `false` there) share this one
/// implementation, matching `optimize.py`'s `_solve` being agnostic to which
/// `CostFunction` subclass it's handed.
fn solve_theta<C: Solvable>(
    cost: &mut C,
    theta0: &[f64; N_THETA],
    img_max_side: f64,
    fix_f: bool,
    max_nfev: u32,
    f_bounds: Option<(f64, f64)>,
    a_bound: f64,
) -> [f64; N_THETA] {
    cost.reset_cache();
    let a_img = img_max_side;
    let (f_lo, f_hi) = match f_bounds {
        Some((lo, hi)) => (lo.ln(), hi.ln()),
        None => (
            (0.5 * a_img / 37.0_f64.to_radians().tan()).ln(),
            (0.5 * a_img / 15.0_f64.to_radians().tan()).ln(),
        ),
    };

    if fix_f {
        let f_val = theta0[N_THETA - 1];
        let mut lo7 = [0.0f64; 7];
        let mut hi7 = [0.0f64; 7];
        for i in 0..M_POLY {
            lo7[i] = -a_bound;
            hi7[i] = a_bound;
        }
        for i in M_POLY..7 {
            lo7[i] = -1.0;
            hi7[i] = 1.0;
        }
        let mut t07 = [0.0f64; 7];
        for i in 0..7 {
            t07[i] = theta0[i].max(lo7[i] + 1e-12).min(hi7[i] - 1e-12);
        }

        let cost_cell = std::cell::RefCell::new(cost);
        let fun = |t: &[f64]| -> Vec<f64> {
            let mut full = [0.0; N_THETA];
            full[..7].copy_from_slice(t);
            full[7] = f_val;
            cost_cell.borrow_mut().residuals(&full)
        };
        let jac = |t: &[f64]| -> Vec<Vec<f64>> {
            let mut full = [0.0; N_THETA];
            full[..7].copy_from_slice(t);
            full[7] = f_val;
            let j = cost_cell.borrow_mut().jacobian(&full);
            j.into_iter().map(|row| row[..7].to_vec()).collect()
        };
        let result =
            crate::lsq::least_squares(fun, &t07, jac, Some((&lo7, &hi7)), max_nfev as usize);
        let mut out = [0.0; N_THETA];
        out[..7].copy_from_slice(&result.x);
        out[7] = f_val;
        return out;
    }

    let mut lo = [0.0f64; N_THETA];
    let mut hi = [0.0f64; N_THETA];
    for i in 0..M_POLY {
        lo[i] = -a_bound;
        hi[i] = a_bound;
    }
    for i in M_POLY..M_POLY + 3 {
        lo[i] = -1.0;
        hi[i] = 1.0;
    }
    lo[N_THETA - 1] = f_lo;
    hi[N_THETA - 1] = f_hi;
    let mut t0 = [0.0f64; N_THETA];
    for i in 0..N_THETA {
        t0[i] = theta0[i].max(lo[i] + 1e-12).min(hi[i] - 1e-12);
    }

    let cost_cell = std::cell::RefCell::new(cost);
    let fun = |t: &[f64]| -> Vec<f64> {
        let arr: [f64; N_THETA] = t
            .try_into()
            .expect("solve_theta: theta always has N_THETA entries");
        cost_cell.borrow_mut().residuals(&arr)
    };
    let jac = |t: &[f64]| -> Vec<Vec<f64>> {
        let arr: [f64; N_THETA] = t
            .try_into()
            .expect("solve_theta: theta always has N_THETA entries");
        cost_cell.borrow_mut().jacobian(&arr)
    };
    let result = crate::lsq::least_squares(fun, &t0, jac, Some((&lo, &hi)), max_nfev as usize);
    result
        .x
        .as_slice()
        .try_into()
        .expect("least_squares returns a vector of length N_THETA")
}

/// `optimize.classify_alignment` (`optimize.py:517-561`): per block with
/// `>= 3` lines, rectify centers via [`crate::model::surface_to_rectified`],
/// drop lines below 80% of the mean width, then
/// `left_ratio`/`right_ratio` = fraction of `|edge - median(edge)| <
/// 2*mean_text_size`; `τ1 = 0.4, τ2 = 0.6` →
/// `justified | left | right | none`.
pub fn classify_alignment(
    line_points: &[Vec<[f64; 2]>],
    block_of_line: &[usize],
    n_blocks: usize,
    params: &DewarpParams,
    mean_text_size: f64,
) -> Vec<Alignment> {
    let mut alignments = Vec::with_capacity(n_blocks);
    for bi in 0..n_blocks {
        let idxs: Vec<usize> = (0..block_of_line.len())
            .filter(|&i| block_of_line[i] == bi)
            .collect();
        if idxs.len() < 3 {
            alignments.push(Alignment::None_);
            continue;
        }
        let mut lefts = Vec::with_capacity(idxs.len());
        let mut rights = Vec::with_capacity(idxs.len());
        let mut widths = Vec::with_capacity(idxs.len());
        for &i in &idxs {
            let uv = surface_to_rectified(&line_points[i], params, None);
            let us: Vec<f64> = uv.iter().map(|p| p[0]).collect();
            let lo = us.iter().cloned().fold(f64::INFINITY, f64::min);
            let hi = us.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            lefts.push(lo);
            rights.push(hi);
            widths.push(hi - lo);
        }
        let wmean: f64 = mean(&widths);
        let keep: Vec<bool> = widths.iter().map(|&w| w >= 0.8 * wmean).collect();
        if keep.iter().filter(|&&k| k).count() < 3 {
            alignments.push(Alignment::None_);
            continue;
        }
        let lefts_kept: Vec<f64> = lefts
            .iter()
            .zip(&keep)
            .filter(|(_, &k)| k)
            .map(|(&v, _)| v)
            .collect();
        let rights_kept: Vec<f64> = rights
            .iter()
            .zip(&keep)
            .filter(|(_, &k)| k)
            .map(|(&v, _)| v)
            .collect();
        let tol = 2.0 * mean_text_size;
        let med_left = crate::stats::median(&lefts_kept);
        let med_right = crate::stats::median(&rights_kept);
        let left_ratio = lefts_kept
            .iter()
            .filter(|&&v| (v - med_left).abs() < tol)
            .count() as f64
            / lefts_kept.len() as f64;
        let right_ratio = rights_kept
            .iter()
            .filter(|&&v| (v - med_right).abs() < tol)
            .count() as f64
            / rights_kept.len() as f64;
        let (tau1, tau2) = (0.4, 0.6);
        let a = if left_ratio > tau2 && right_ratio > tau2 {
            Alignment::Justified
        } else if left_ratio > tau2 && right_ratio <= tau1 {
            Alignment::Left
        } else if right_ratio > tau2 && left_ratio <= tau1 {
            Alignment::Right
        } else {
            Alignment::None_
        };
        alignments.push(a);
    }
    alignments
}

/// `optimize.OptimizeResult` (`optimize.py:564-568`).
#[derive(Debug, Clone)]
pub struct OptimizeResult {
    pub params: DewarpParams,
    /// Final inlier features (post outlier loop).
    pub data: ProblemData,
    pub alignments: Vec<Alignment>,
}

/// `optimize.BoundaryCandidate` (`optimize.py:571-577`): one fixed-inlier
/// page-boundary refinement candidate.
#[derive(Debug, Clone)]
pub struct BoundaryCandidate {
    pub result: OptimizeResult,
    pub weight: f64,
}

/// `_feature_x_clamp`, mirroring the relevant slice of `dewarp.py`'s
/// `_prepare_geometry` (`dewarp.py:344-346`): `(p1, p99)` of `Sx` at
/// `params`, back-projecting every inlier text point plus every segment
/// endpoint. Feeds [`RunOptimizationTrace::x_clamp`] — load-bearing, and
/// easy to drop by accident.
fn feature_x_clamp(data: &ProblemData, params: &DewarpParams) -> Option<(f64, f64)> {
    let mut feat: Vec<[f64; 2]> = Vec::new();
    for pts in &data.line_points {
        feat.extend_from_slice(pts);
    }
    if !data.segments.is_empty() {
        for s in &data.segments {
            feat.push([s[0], s[1]]);
        }
        for s in &data.segments {
            feat.push([s[2], s[3]]);
        }
    }
    if feat.is_empty() {
        return None;
    }
    let bp = backproject(&feat, params, None);
    let finite_sx: Vec<f64> = bp.sx.into_iter().filter(|v| v.is_finite()).collect();
    if finite_sx.is_empty() {
        return None;
    }
    Some((
        crate::stats::percentile(&finite_sx, 1.0),
        crate::stats::percentile(&finite_sx, 99.0),
    ))
}

/// `_coarse_score` (`optimize.py:681-700`): scale-normalized coarse cost —
/// `E_str` alone decreases for a solution that vertically collapses the
/// document, so the raw cost is normalized by `v_range²` before comparing
/// candidates.
fn coarse_score(
    coarse_cost: &mut CostFunction,
    t: &[f64; N_THETA],
    template: &DewarpParams,
    anchor_pts: &[[f64; 2]],
) -> f64 {
    let params_t = unpack_theta(t, template);
    if crate::lsq::norm2(&params_t.rvec) > 1.0 {
        return f64::INFINITY;
    }
    coarse_cost.reset_cache();
    if anchor_pts.is_empty() {
        return f64::INFINITY;
    }
    let uv = surface_to_rectified(anchor_pts, &params_t, None);
    let us: Vec<f64> = uv.iter().map(|p| p[0]).collect();
    let vs: Vec<f64> = uv.iter().map(|p| p[1]).collect();
    let u_range = ptp(&us);
    let v_range = ptp(&vs);
    if !(u_range + v_range).is_finite() || v_range < 1e-6 {
        return f64::INFINITY;
    }
    let aspect = v_range / u_range.max(1e-6);
    if !(0.1..=10.0).contains(&aspect) {
        return f64::INFINITY;
    }
    let r = coarse_cost.residuals(t);
    let ss: f64 = r.iter().map(|&v| v * v).sum();
    ss / (v_range * v_range)
}

/// One coarse multi-start candidate's traced result: theta + score only.
/// The starting-point metadata (`rvec0`/`a2_0`/`f0`) is deliberately not
/// carried — nothing compares it.
#[derive(Debug, Clone)]
pub struct CoarseCandidateTrace {
    pub theta: [f64; N_THETA],
    pub score: f64,
}

/// One outlier-removal iteration's traced result. `text_mask`/`seg_mask`
/// are the masks **entering** this iteration (pre-update), matching
/// `S4Optimize.outlier_iterations`.
#[derive(Debug, Clone)]
pub struct OutlierIterTrace {
    pub theta: [f64; N_THETA],
    pub text_mask: Vec<bool>,
    pub seg_mask: Vec<bool>,
}

/// The instrumented optimize result — everything `S4Optimize` needs, plus
/// the plain [`OptimizeResult`] `pipeline.rs` consumes.
#[derive(Debug, Clone)]
pub struct RunOptimizationTrace {
    pub result: OptimizeResult,
    pub coarse_candidates: Vec<CoarseCandidateTrace>,
    /// `-1` only if no coarse candidate was ever scored (unreachable in
    /// practice — every preset has at least one pose × f candidate — kept
    /// `i64` rather than `usize` to represent that Python `None`-turned-`-1`
    /// case explicitly instead of panicking on it).
    pub coarse_winner: i64,
    pub alignments: Vec<Alignment>,
    pub outlier_iterations: Vec<OutlierIterTrace>,
    pub x_clamp: Option<(f64, f64)>,
}

/// `optimize.run_optimization` (`optimize.py:579-856`) — coarse
/// multi-start, alignment classification, and the iterative-outlier-removal
/// refinement loop. `poly_scale`, when set, overrides `template.scale`
/// (scene mode only in the Python reference — not reachable here, since
/// `--scene` is not ported; carried in the signature for fidelity with
/// `optimize.py`'s own parameter list).
///
/// High-level steps, in order:
/// 1. Skew seed: width-weighted median of line-endpoint angles
///    (`optimize.py:668-680`).
/// 2. Coarse multi-start: 7 pose×curvature candidates at `default`/`high`
///    (3 at `fast`, gated by `opts.full_pose_multistart`), × 1-3 `f`
///    candidates depending on EXIF/`f_scan`; each candidate is a 7-variable
///    `fix_f=true` solve, scored by the scale-normalized `_coarse_score`
///    (`optimize.py:681-745`).
/// 3. Alignment classification via [`classify_alignment`]
///    (`optimize.py:747-753`).
/// 4. Scale-anchor target: `std(Sy)` of the fixed anchor set at the coarse
///    solution (`optimize.py:756-760`).
/// 5. Doc-region segment pre-filter when `>=200` text points
///    (`optimize.py:762-791`).
/// 6. Outlier loop, `opts.n_outlier_iter` iterations: full 8-variable solve
///    → recompute masks on the *full* feature set → masks shrink
///    monotonically; early exit once both masks are stable and `it > 0`
///    (`optimize.py:795-852`). The text mask is never allowed to drop below
///    2 lines (`optimize.py:839-840`).
pub fn run_optimization(
    text: &TextFeatures,
    segs: &LineSegments,
    img_w: u32,
    img_h: u32,
    use_line_term: bool,
    opts: &QualityOptions,
    f_exif_px: Option<f64>,
    a_bound: f64,
    poly_scale: Option<f64>,
) -> OptimizeResult {
    run_optimization_traced(
        text,
        segs,
        img_w,
        img_h,
        use_line_term,
        opts,
        f_exif_px,
        a_bound,
        poly_scale,
    )
    .result
}

/// Instrumented variant of [`run_optimization`] — see this module's own doc
/// comment ("Traced variants") for why this exists alongside the plain
/// entry point.
#[allow(clippy::too_many_arguments)]
pub fn run_optimization_traced(
    text: &TextFeatures,
    segs: &LineSegments,
    img_w: u32,
    img_h: u32,
    use_line_term: bool,
    opts: &QualityOptions,
    f_exif_px: Option<f64>,
    a_bound: f64,
    poly_scale: Option<f64>,
) -> RunOptimizationTrace {
    let use_confidence_filter = text.uses_confidence_filter();
    let all_lines = text.lines();
    let initialization_line_points: Vec<Vec<[f64; 2]>> =
        all_lines.iter().map(|l| l.centers.clone()).collect();
    let mut initialization_block_of_line: Vec<usize> = Vec::new();
    let mut line_points: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut block_of_line: Vec<usize> = Vec::new();
    for (bi, block) in text.blocks.iter().enumerate() {
        for _ in &block.lines {
            initialization_block_of_line.push(bi);
        }
        for line in &block.lines {
            if use_confidence_filter && !line.high_confidence {
                continue;
            }
            line_points.push(line.centers.clone());
            block_of_line.push(bi);
        }
    }
    let n_blocks = text.blocks.len();

    let mut template = initial_params(img_w, img_h);
    if let Some(ps) = poly_scale {
        template.scale = ps;
    }
    let mut theta = pack_theta(&template);
    let a_img = img_w.max(img_h) as f64;
    let mut f_bounds: Option<(f64, f64)> = None;
    if let Some(fpx) = f_exif_px {
        theta[N_THETA - 1] = fpx.ln();
        f_bounds = Some((0.82 * fpx, 1.18 * fpx));
    }

    let text_pts: Vec<[f64; 2]> = line_points.iter().flatten().cloned().collect();
    let anchor_pts: Vec<[f64; 2]> = if text_pts.len() >= 200 || segs.segments.is_empty() {
        text_pts.clone()
    } else {
        let mut v = text_pts.clone();
        for s in &segs.segments {
            v.push([0.5 * (s[0] + s[2]), 0.5 * (s[1] + s[3])]);
        }
        v
    };

    let few_text = initialization_line_points.len() < 10;
    let coarse_segments: Vec<[f64; 4]> = if few_text && use_line_term {
        segs.segments.clone()
    } else {
        Vec::new()
    };
    let coarse_data = ProblemData {
        line_points: initialization_line_points.clone(),
        block_of_line: initialization_block_of_line.clone(),
        alignments: vec![Alignment::Coarse; n_blocks],
        segments: coarse_segments,
        img_w,
        img_h,
        mean_text_size: text.mean_text_size,
        use_line_term: few_text && use_line_term,
    };
    let mut coarse_cost = CostFunction::new(coarse_data, template.clone(), None, None);

    // Skew seed: width-weighted median of detected-line endpoint angles
    // (optimize.py:668-680).
    let mut tilts: Vec<f64> = Vec::new();
    let mut tilt_w: Vec<f64> = Vec::new();
    for pts in &initialization_line_points {
        if pts.is_empty() {
            continue;
        }
        let d0 = pts[pts.len() - 1][0] - pts[0][0];
        let d1 = pts[pts.len() - 1][1] - pts[0][1];
        if d0.abs() > 1e-9 {
            tilts.push(d1.atan2(d0));
            tilt_w.push(d0.abs());
        }
    }
    let skew = if !tilts.is_empty() {
        crate::stats::weighted_median(&tilts, &tilt_w)
    } else {
        0.0
    };

    // Initial pose × curvature candidates (optimize.py:702-719).
    let pose_candidates: Vec<([f64; 3], f64)> = if opts.full_pose_multistart {
        vec![
            ([0.0, 0.0, skew], 0.0),
            ([0.35, 0.0, skew], 0.0),
            ([-0.35, 0.0, skew], 0.0),
            ([0.0, 0.35, skew], 0.0),
            ([0.0, -0.35, skew], 0.0),
            ([0.0, 0.0, skew], 0.5),
            ([0.0, 0.0, skew], -0.5),
        ]
    } else {
        vec![
            ([0.0, 0.0, skew], 0.0),
            ([0.0, 0.0, skew], 0.5),
            ([0.0, 0.0, skew], -0.5),
        ]
    };
    let f_candidates: Vec<f64> = if let Some(fpx) = f_exif_px {
        vec![fpx]
    } else if opts.f_scan {
        vec![0.7 * a_img, 1.0 * a_img, 1.5 * a_img]
    } else {
        vec![theta[N_THETA - 1].exp()]
    };

    let mut coarse_candidates: Vec<CoarseCandidateTrace> = Vec::new();
    let mut best_theta: Option<[f64; N_THETA]> = None;
    let mut best_score = f64::INFINITY;
    let mut best_index: i64 = -1;
    for &f0 in &f_candidates {
        for &(rvec0, a2_0) in &pose_candidates {
            let mut t0 = theta;
            t0[M_POLY..M_POLY + 3].copy_from_slice(&rvec0);
            t0[1] = a2_0;
            t0[N_THETA - 1] = f0.ln();
            let t1 = solve_theta(
                &mut coarse_cost,
                &t0,
                img_w.max(img_h) as f64,
                true,
                opts.max_nfev,
                None,
                a_bound,
            );
            let s1 = coarse_score(&mut coarse_cost, &t1, &template, &anchor_pts);
            coarse_candidates.push(CoarseCandidateTrace {
                theta: t1,
                score: s1,
            });
            if s1 < best_score {
                best_theta = Some(t1);
                best_score = s1;
                best_index = (coarse_candidates.len() - 1) as i64;
            }
        }
    }
    let best_theta = match best_theta {
        Some(t) => t,
        None => solve_theta(
            &mut coarse_cost,
            &theta,
            img_w.max(img_h) as f64,
            true,
            opts.max_nfev,
            None,
            a_bound,
        ),
    };
    theta = best_theta;

    // Alignment classification (optimize.py:747-753).
    let alignments = classify_alignment(
        &line_points,
        &block_of_line,
        n_blocks,
        &unpack_theta(&theta, &template),
        text.mean_text_size,
    );

    // Scale-anchor target (optimize.py:756-760).
    let coarse_params = unpack_theta(&theta, &template);
    let bp_anchor_coarse = backproject(&anchor_pts, &coarse_params, None);
    let v_scale_ref = std_dev(&bp_anchor_coarse.sy);

    // Doc-region segment pre-filter (optimize.py:762-791).
    let mut seg_mask: Vec<bool> = vec![true; segs.segments.len()];
    let initialization_text_pts: Vec<[f64; 2]> = initialization_line_points
        .iter()
        .flatten()
        .cloned()
        .collect();
    if use_line_term && !segs.segments.is_empty() && initialization_text_pts.len() >= 200 {
        let text_uv = surface_to_rectified(&initialization_text_pts, &coarse_params, None);
        let mids: Vec<[f64; 2]> = segs
            .segments
            .iter()
            .map(|s| [0.5 * (s[0] + s[2]), 0.5 * (s[1] + s[3])])
            .collect();
        let mid_uv = surface_to_rectified(&mids, &coarse_params, None);
        let us: Vec<f64> = text_uv.iter().map(|p| p[0]).collect();
        let vs: Vec<f64> = text_uv.iter().map(|p| p[1]).collect();
        let (u0, u1) = (
            crate::stats::percentile(&us, 1.0),
            crate::stats::percentile(&us, 99.0),
        );
        let (v0, v1) = (
            crate::stats::percentile(&vs, 1.0),
            crate::stats::percentile(&vs, 99.0),
        );
        let mu = 0.3 * (u1 - u0);
        let mv = 0.3 * (v1 - v0);
        seg_mask = mid_uv
            .iter()
            .map(|p| {
                p[0].is_finite()
                    && p[1].is_finite()
                    && p[0] > u0 - mu
                    && p[0] < u1 + mu
                    && p[1] > v0 - mv
                    && p[1] < v1 + mv
            })
            .collect();
    }

    // Outlier loop (optimize.py:792-852).
    let mut text_mask: Vec<bool> = vec![true; line_points.len()];
    let mut tau = TAU_SEG_INIT;
    let mut data: Option<ProblemData> = None;
    let mut outlier_iterations: Vec<OutlierIterTrace> = Vec::new();

    for it in 0..opts.n_outlier_iter {
        let iter_line_points: Vec<Vec<[f64; 2]>> = line_points
            .iter()
            .zip(&text_mask)
            .filter(|(_, &m)| m)
            .map(|(p, _)| p.clone())
            .collect();
        let iter_block_of_line: Vec<usize> = block_of_line
            .iter()
            .zip(&text_mask)
            .filter(|(_, &m)| m)
            .map(|(&b, _)| b)
            .collect();
        let iter_segments: Vec<[f64; 4]> = if use_line_term {
            segs.segments
                .iter()
                .zip(&seg_mask)
                .filter(|(_, &m)| m)
                .map(|(s, _)| *s)
                .collect()
        } else {
            Vec::new()
        };
        let d = ProblemData {
            line_points: iter_line_points,
            block_of_line: iter_block_of_line,
            alignments: alignments.clone(),
            segments: iter_segments,
            img_w,
            img_h,
            mean_text_size: text.mean_text_size,
            use_line_term,
        };
        let mut cost = CostFunction::new(
            d.clone(),
            template.clone(),
            Some(anchor_pts.clone()),
            Some(v_scale_ref),
        );
        theta = solve_theta(
            &mut cost,
            &theta,
            img_w.max(img_h) as f64,
            false,
            opts.max_nfev,
            f_bounds,
            a_bound,
        );

        outlier_iterations.push(OutlierIterTrace {
            theta,
            text_mask: text_mask.clone(),
            seg_mask: seg_mask.clone(),
        });

        let full_data = ProblemData {
            line_points: line_points.clone(),
            block_of_line: block_of_line.clone(),
            alignments: alignments.clone(),
            segments: segs.segments.clone(),
            img_w,
            img_h,
            mean_text_size: text.mean_text_size,
            use_line_term,
        };
        let full_cost = CostFunction::new(full_data, template.clone(), None, None);
        let mut new_seg_mask = seg_mask.clone();
        if use_line_term && !segs.segments.is_empty() {
            let align_vals = full_cost.segment_align_values(&theta);
            new_seg_mask = (0..seg_mask.len())
                .map(|i| seg_mask[i] && align_vals[i] < tau)
                .collect();
        }
        let straightness = full_cost.textline_straightness(&theta);
        let rho = (3.0 * crate::stats::median(&straightness)).max(0.3 * text.mean_text_size);
        let mut new_text_mask: Vec<bool> = straightness.iter().map(|&s| s < rho).collect();
        if new_text_mask.iter().filter(|&&m| m).count() < 2 {
            new_text_mask = text_mask.clone();
        }
        let stable = new_seg_mask == seg_mask && new_text_mask == text_mask;
        seg_mask = new_seg_mask;
        text_mask = new_text_mask;
        tau /= 2.0;
        data = Some(d);
        if stable && it > 0 {
            break;
        }
    }

    let final_params = unpack_theta(&theta, &template);
    let x_clamp = data
        .as_ref()
        .and_then(|d| feature_x_clamp(d, &final_params));
    let data = data.expect(
        "run_optimization: opts.n_outlier_iter >= 1 in every preset (the minimum is 2), \
         so the outlier loop always runs at least once and sets `data`",
    );
    let result = OptimizeResult {
        params: final_params,
        data,
        alignments: alignments.clone(),
    };

    RunOptimizationTrace {
        result,
        coarse_candidates,
        coarse_winner: best_index,
        alignments,
        outlier_iterations,
        x_clamp,
    }
}

/// One boundary-refinement weight tier's traced attempt. `valid` mirrors
/// `seam::BoundaryCandidateSnapshot.valid`: whether every parameter came
/// out finite, i.e. whether a
/// [`BoundaryCandidate`] was actually produced for this weight.
#[derive(Debug, Clone)]
pub struct BoundaryCandidateTrace {
    pub weight: f64,
    pub theta: [f64; N_THETA],
    pub valid: bool,
}

/// `optimize.refine_with_page_boundary` (`optimize.py:859-936`): from the
/// completed text-first `baseline`, run 5 more 8-variable solves (weights
/// `1.0, 0.5, 0.25, 0.125, 0.12`) with [`BoundaryCostFunction`], keeping the
/// baseline's text/segment inliers fixed. Candidate acceptance is decided
/// later, in `pipeline.rs` (`_candidate_is_acceptable`), not here — this
/// function only returns the finite-parameter survivors.
pub fn refine_with_page_boundary(
    baseline: &OptimizeResult,
    boundary: &PageBoundary,
    img_w: u32,
    img_h: u32,
    opts: &QualityOptions,
    f_exif_px: Option<f64>,
    a_bound: f64,
) -> Vec<BoundaryCandidate> {
    refine_with_page_boundary_traced(baseline, boundary, img_w, img_h, opts, f_exif_px, a_bound).0
}

/// Instrumented variant of [`refine_with_page_boundary`] — see this module's
/// own doc comment ("Traced variants"). Returns `(finite-parameter
/// candidates, one snapshot per weight tier including rejected ones)`.
pub fn refine_with_page_boundary_traced(
    baseline: &OptimizeResult,
    boundary: &PageBoundary,
    img_w: u32,
    img_h: u32,
    opts: &QualityOptions,
    f_exif_px: Option<f64>,
    a_bound: f64,
) -> (Vec<BoundaryCandidate>, Vec<BoundaryCandidateTrace>) {
    let data = &baseline.data;
    let text_pts: Vec<[f64; 2]> = data.line_points.iter().flatten().cloned().collect();
    let anchor_pts: Vec<[f64; 2]> = if text_pts.len() >= 200 || data.segments.is_empty() {
        text_pts.clone()
    } else {
        let mut v = text_pts.clone();
        for s in &data.segments {
            v.push([0.5 * (s[0] + s[2]), 0.5 * (s[1] + s[3])]);
        }
        v
    };
    if anchor_pts.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let bp = backproject(&anchor_pts, &baseline.params, None);
    let v_scale_ref = std_dev(&bp.sy);
    if !v_scale_ref.is_finite() || v_scale_ref < 1e-6 {
        return (Vec::new(), Vec::new());
    }

    let f_bounds = f_exif_px.map(|fpx| (0.82 * fpx, 1.18 * fpx));
    let theta0 = pack_theta(&baseline.params);
    let mut candidates = Vec::new();
    let mut snapshots = Vec::new();
    let weights = [1.0, 0.5, 0.25, 0.125, 0.12];
    let max_nfev = opts.max_nfev.min(600);
    for &weight in &weights {
        let mut cost = BoundaryCostFunction::new(
            data.clone(),
            baseline.params.clone(),
            boundary.clone(),
            weight,
            Some(anchor_pts.clone()),
            Some(v_scale_ref),
        );
        let theta = solve_theta(
            &mut cost,
            &theta0,
            img_w.max(img_h) as f64,
            false,
            max_nfev,
            f_bounds,
            a_bound,
        );
        let params = unpack_theta(&theta, &baseline.params);
        let valid = params.a.iter().all(|v| v.is_finite())
            && params.rvec.iter().all(|v| v.is_finite())
            && params.f.is_finite();
        snapshots.push(BoundaryCandidateTrace {
            weight,
            theta,
            valid,
        });
        if !valid {
            continue;
        }
        candidates.push(BoundaryCandidate {
            result: OptimizeResult {
                params,
                data: data.clone(),
                alignments: baseline.alignments.clone(),
            },
            weight,
        });
    }
    (candidates, snapshots)
}
