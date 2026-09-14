//! Generalized cylindrical surface (GCS) geometry model — mirrors
//! `model.py` 1:1 — the geometry core.
//!
//! Coordinate conventions (`model.py`'s module doc comment, verbatim):
//! - image point `(α, β)`, principal point `(cx, cy)`,
//!   `p̄ = (α-cx, β-cy, f)`
//! - world point `W = k·p̄ = R·S + O_f`, `O_f = (0,0,f)`, surface point
//!   `S = [x, y, g(x)]`
//! - when `R = I` and `g ≡ 0`, this reduces to the identity mapping
//!   `k=1, x=α-cx, y=β-cy`
//!
//! For numerical stability the polynomial `g` is stored in normalized
//! coordinates: `g(x) = s·h(x/s)`, `h(t) = Σ_{m=1}^{M} a_m·t^m`, `a_0 = 0`
//! fixed. The optimization variables are the normalized coefficients
//! `a_1..a_M`; `s` is the representative image scale `max(w,h)`.
//!
//! **All geometry here is `f64`**, with no FMA contraction and no
//! `rayon`/`fold` reordering — this is a summation-order correctness
//! requirement, not a style preference.

pub mod rodrigues;

/// `model.M_POLY` (`model.py:25`) — polynomial degree.
pub const M_POLY: usize = 4;

/// `model.N_THETA` (`model.py:115`) — `M_POLY + 4` (the 4 pose/focal-length
/// parameters: `r1, r2, r3, log f`). Total optimization parameter count.
pub const N_THETA: usize = M_POLY + 4;

/// `model.DewarpParams` (`model.py:28-55`).
#[derive(Debug, Clone, PartialEq)]
pub struct DewarpParams {
    /// Normalized polynomial coefficients `a_1..a_4`.
    pub a: [f64; M_POLY],
    /// Rodrigues exponential-map rotation.
    pub rvec: [f64; 3],
    /// Focal length in pixels.
    pub f: f64,
    pub cx: f64,
    pub cy: f64,
    /// Polynomial normalization scale `s`.
    pub scale: f64,
}

impl DewarpParams {
    /// `DewarpParams.R` property (`model.py:37-39`):
    /// `cv2.Rodrigues(self.rvec)[0]`.
    pub fn r(&self) -> [[f64; 3]; 3] {
        rodrigues::rodrigues(self.rvec)
    }

    /// `DewarpParams.g` (`model.py:41-47`): `g(x) = s·h(x/s)` via Horner's
    /// method.
    pub fn g(&self, x: &[f64]) -> Vec<f64> {
        x.iter()
            .map(|&xi| {
                let t = xi / self.scale;
                let mut h = 0.0;
                for m in (1..=M_POLY).rev() {
                    h = (h + self.a[m - 1]) * t;
                }
                self.scale * h
            })
            .collect()
    }

    /// `DewarpParams.g_prime` (`model.py:49-55`): `g'(x) = h'(x/s)` via
    /// Horner's method.
    pub fn g_prime(&self, x: &[f64]) -> Vec<f64> {
        x.iter()
            .map(|&xi| {
                let t = xi / self.scale;
                let mut hp = 0.0;
                for m in (2..=M_POLY).rev() {
                    hp = (hp + (m as f64) * self.a[m - 1]) * t;
                }
                hp + self.a[0]
            })
            .collect()
    }

    /// `model._g_second` (`model.py:118-125`): `g''(x) = h''(x/s)/s`. Free
    /// function in Python (takes `params` explicitly); kept as a method
    /// here since it always operates on `self`.
    fn g_second(&self, x: &[f64]) -> Vec<f64> {
        x.iter()
            .map(|&xi| {
                let t = xi / self.scale;
                let mut hpp = 0.0;
                for m in (3..=M_POLY).rev() {
                    hpp = (hpp + (m as f64) * ((m - 1) as f64) * self.a[m - 1]) * t;
                }
                hpp += 2.0 * self.a[1];
                hpp / self.scale
            })
            .collect()
    }
}

/// Result of [`backproject`]: `(Sx, Sy, k)`, one entry per input point.
pub struct BackprojectResult {
    pub sx: Vec<f64>,
    pub sy: Vec<f64>,
    pub k: Vec<f64>,
}

/// `model.backproject` (`model.py:58-93`): back-project `(N,2)` image
/// points into surface coordinates by solving `g(Sx(k)) = Sz(k)` for `k`
/// via Newton-Raphson (≤30 iterations, stop when `max|step| < 1e-10`, with
/// a `1e-12` guard against a near-zero derivative near tangent-ray
/// singularities). `k_init`, when given, warm-starts the iteration — the
/// optimizer's own warm-start cache lives in `optimize::CostFunction`
/// — `reset_cache()` call sites must be preserved exactly, because carrying
/// a stale cache across independent solves can converge to a different
/// Newton branch in high-curvature regions.
pub fn backproject(
    pts: &[[f64; 2]],
    params: &DewarpParams,
    k_init: Option<&[f64]>,
) -> BackprojectResult {
    let n = pts.len();
    let r = params.r();
    let f = params.f;

    // b_i[n] = pbar[n]·R[:,i] (column i of R); c_i = f·R[2][i].
    // (RT[i] in model.py is row i of R.T = column i of R — same quantity.)
    let c0 = f * r[2][0];
    let c1c = f * r[2][1];
    let c2c = f * r[2][2];

    let mut b0 = vec![0.0; n];
    let mut b1v = vec![0.0; n];
    let mut b2v = vec![0.0; n];
    for i in 0..n {
        let px = pts[i][0] - params.cx;
        let py = pts[i][1] - params.cy;
        b0[i] = px * r[0][0] + py * r[1][0] + f * r[2][0];
        b1v[i] = px * r[0][1] + py * r[1][1] + f * r[2][1];
        b2v[i] = px * r[0][2] + py * r[1][2] + f * r[2][2];
    }

    let mut k: Vec<f64> = match k_init {
        Some(ki) => ki.to_vec(),
        None => vec![1.0; n],
    };

    for _iter in 0..30 {
        let sx: Vec<f64> = (0..n).map(|i| k[i] * b0[i] - c0).collect();
        let sz: Vec<f64> = (0..n).map(|i| k[i] * b2v[i] - c2c).collect();
        let gx = params.g(&sx);
        let gpx = params.g_prime(&sx);
        let mut max_step: f64 = 0.0;
        for i in 0..n {
            let phi = gx[i] - sz[i];
            let mut dphi = gpx[i] * b0[i] - b2v[i];
            if dphi.abs() < 1e-12 {
                // np.where(|dphi|<1e-12, sign(dphi)*1e-12 + (dphi==0)*1e-12, dphi)
                dphi = if dphi == 0.0 {
                    1e-12
                } else {
                    dphi.signum() * 1e-12
                };
            }
            let step = phi / dphi;
            k[i] -= step;
            let a = step.abs();
            if a > max_step {
                max_step = a;
            }
        }
        if max_step < 1e-10 {
            break;
        }
    }

    let sx: Vec<f64> = (0..n).map(|i| k[i] * b0[i] - c0).collect();
    let sy: Vec<f64> = (0..n).map(|i| k[i] * b1v[i] - c1c).collect();
    BackprojectResult { sx, sy, k }
}

/// `model.flatten_u` (`model.py:96-106`): approximate
/// `u = ∫_0^x √(1+g'(t)²) dt` with **single-interval Simpson's rule**
/// (`x/6 * (A(0) + 4*A(x/2) + A(x))`, `A = √(1+g'²)`). This is
/// *deliberately not* the same quadrature `rectified_to_image` uses for the
/// inverse map (that one is a 4000-step cumulative trapezoid). Do not
/// "unify" them.
pub fn flatten_u(x: &[f64], params: &DewarpParams) -> Vec<f64> {
    let zeros: Vec<f64> = vec![0.0; x.len()];
    let gp0 = params.g_prime(&zeros);
    let xh: Vec<f64> = x.iter().map(|&xi| xi / 2.0).collect();
    let gph = params.g_prime(&xh);
    let gpx = params.g_prime(x);
    (0..x.len())
        .map(|i| {
            x[i] / 6.0
                * ((1.0 + gp0[i] * gp0[i]).sqrt()
                    + 4.0 * (1.0 + gph[i] * gph[i]).sqrt()
                    + (1.0 + gpx[i] * gpx[i]).sqrt())
        })
        .collect()
}

/// Result of [`backproject_with_grad`]: `Sx`, `Sy`, `k`, and the Jacobians
/// `dSx`/`dSy` — each `dSx[i]`/`dSy[i]` has [`N_THETA`] columns
/// `(a_1..a_4, r_1..r_3, log f)`.
pub struct BackprojectGradResult {
    pub sx: Vec<f64>,
    pub sy: Vec<f64>,
    pub k: Vec<f64>,
    pub d_sx: Vec<[f64; N_THETA]>,
    pub d_sy: Vec<[f64; N_THETA]>,
}

/// `model.backproject_with_grad` (`model.py:128-200`): back-projection plus
/// **fully analytic** derivatives w.r.t. all 8 parameters, via implicit
/// differentiation of `g(Sx(k,θ)) = Sz(k,θ))`:
/// `∂k/∂θ = -(∂φ/∂θ)/(∂φ/∂k)`. Uses [`rodrigues::rodrigues_with_jacobian`]
/// for the `r_1..r_3` columns; the `log f` column is scaled by `f`
/// (`model.py:197-198`, the log-parameterization chain rule).
pub fn backproject_with_grad(
    pts: &[[f64; 2]],
    params: &DewarpParams,
    k_init: Option<&[f64]>,
) -> BackprojectGradResult {
    let n = pts.len();
    let f = params.f;
    // r[row][col]; d_r[j][p][q] = ∂R[p,q]/∂r_j.
    let (r, d_r) = rodrigues::rodrigues_with_jacobian(params.rvec);

    let pbar: Vec<[f64; 3]> = pts
        .iter()
        .map(|p| [p[0] - params.cx, p[1] - params.cy, f])
        .collect();

    // b[n][i] = pbar[n]·R[:,i] (column i of R).
    let mut b = vec![[0.0; 3]; n];
    for i in 0..n {
        for col in 0..3 {
            b[i][col] = pbar[i][0] * r[0][col] + pbar[i][1] * r[1][col] + pbar[i][2] * r[2][col];
        }
    }
    let c = [f * r[2][0], f * r[2][1], f * r[2][2]];

    let mut k: Vec<f64> = match k_init {
        Some(ki) => ki.to_vec(),
        None => vec![1.0; n],
    };

    for _iter in 0..30 {
        let sx: Vec<f64> = (0..n).map(|i| k[i] * b[i][0] - c[0]).collect();
        let sz: Vec<f64> = (0..n).map(|i| k[i] * b[i][2] - c[2]).collect();
        let gx = params.g(&sx);
        let gpx = params.g_prime(&sx);
        let mut max_step: f64 = 0.0;
        for i in 0..n {
            let phi = gx[i] - sz[i];
            let mut dphi = gpx[i] * b[i][0] - b[i][2];
            // Note: unlike `backproject`, this guard is a flat `1e-12`
            // (no sign preservation) — matches `backproject_with_grad`'s
            // Python exactly (`model.py:156`), which differs from
            // `backproject`'s guard (`model.py:86`). This is a real
            // discrepancy in the Python reference, preserved intentionally.
            if dphi.abs() < 1e-12 {
                dphi = 1e-12;
            }
            let step = phi / dphi;
            k[i] -= step;
            let a = step.abs();
            if a > max_step {
                max_step = a;
            }
        }
        if max_step < 1e-10 {
            break;
        }
    }

    let sx: Vec<f64> = (0..n).map(|i| k[i] * b[i][0] - c[0]).collect();
    let sy: Vec<f64> = (0..n).map(|i| k[i] * b[i][1] - c[1]).collect();
    let gp = params.g_prime(&sx);
    let mut dphi_dk: Vec<f64> = (0..n).map(|i| gp[i] * b[i][0] - b[i][2]).collect();
    for v in dphi_dk.iter_mut() {
        if v.abs() < 1e-12 {
            *v = 1e-12;
        }
    }

    let mut d_sx = vec![[0.0; N_THETA]; n];
    let mut d_sy = vec![[0.0; N_THETA]; n];
    let t_norm: Vec<f64> = sx.iter().map(|&sxv| sxv / params.scale).collect();

    // --- a_m: ∂φ/∂a_m|_k = ∂g/∂a_m = s·t^m ---
    for m in 1..=M_POLY {
        for i in 0..n {
            let dphi_dam = params.scale * t_norm[i].powi(m as i32);
            let dk = -dphi_dam / dphi_dk[i];
            d_sx[i][m - 1] = b[i][0] * dk;
            d_sy[i][m - 1] = b[i][1] * dk;
        }
    }

    // --- r_j: explicit dependence of b and c, plus implicit k ---
    for j in 0..3 {
        let dr_j = d_r[j];
        let dc = [f * dr_j[2][0], f * dr_j[2][1], f * dr_j[2][2]];
        for i in 0..n {
            let db0 = pbar[i][0] * dr_j[0][0] + pbar[i][1] * dr_j[1][0] + pbar[i][2] * dr_j[2][0];
            let db1 = pbar[i][0] * dr_j[0][1] + pbar[i][1] * dr_j[1][1] + pbar[i][2] * dr_j[2][1];
            let db2 = pbar[i][0] * dr_j[0][2] + pbar[i][1] * dr_j[1][2] + pbar[i][2] * dr_j[2][2];
            let dsx_k = k[i] * db0 - dc[0];
            let dsy_k = k[i] * db1 - dc[1];
            let dsz_k = k[i] * db2 - dc[2];
            let dphi = gp[i] * dsx_k - dsz_k;
            let dk = -dphi / dphi_dk[i];
            d_sx[i][M_POLY + j] = dsx_k + b[i][0] * dk;
            d_sy[i][M_POLY + j] = dsy_k + b[i][1] * dk;
        }
    }

    // --- log f: both the z component of p̄ and c depend on f ---
    for i in 0..n {
        let dsx_k = (k[i] - 1.0) * r[2][0];
        let dsy_k = (k[i] - 1.0) * r[2][1];
        let dsz_k = (k[i] - 1.0) * r[2][2];
        let dphi = gp[i] * dsx_k - dsz_k;
        let dk = -dphi / dphi_dk[i];
        d_sx[i][M_POLY + 3] = (dsx_k + b[i][0] * dk) * f;
        d_sy[i][M_POLY + 3] = (dsy_k + b[i][1] * dk) * f;
    }

    BackprojectGradResult {
        sx,
        sy,
        k,
        d_sx,
        d_sy,
    }
}

/// `model.flatten_u_with_grad` (`model.py:203-237`): Simpson's
/// approximation of `u` and all derivatives —
/// `du/dθ = ∂u/∂x · dx/dθ + ∂u/∂a_m` (only the `a_m` columns have explicit
/// dependence on the Simpson quadrature itself). `dx` has [`N_THETA`]
/// columns per point (typically `d_sx` from [`backproject_with_grad`]).
/// Returns `(u, du)` with `du[i]` having [`N_THETA`] columns.
pub fn flatten_u_with_grad(
    x: &[f64],
    dx: &[[f64; N_THETA]],
    params: &DewarpParams,
) -> (Vec<f64>, Vec<[f64; N_THETA]>) {
    let n = x.len();

    // Returns (A, dA/dy, dA/da[0..M_POLY]) for each point in `y`.
    let a_and_grads = |y: &[f64]| -> (Vec<f64>, Vec<f64>, Vec<[f64; M_POLY]>) {
        let gp = params.g_prime(y);
        let gpp = params.g_second(y);
        let mut a_vals = vec![0.0; y.len()];
        let mut da_dy = vec![0.0; y.len()];
        let mut da_da = vec![[0.0; M_POLY]; y.len()];
        for i in 0..y.len() {
            let av = (1.0 + gp[i] * gp[i]).sqrt();
            a_vals[i] = av;
            da_dy[i] = gp[i] * gpp[i] / av;
            let ty = y[i] / params.scale;
            for m in 1..=M_POLY {
                da_da[i][m - 1] = gp[i] * (m as f64) * ty.powi((m as i32) - 1) / av;
            }
        }
        (a_vals, da_dy, da_da)
    };

    let zeros = vec![0.0; n];
    let xh: Vec<f64> = x.iter().map(|&v| v / 2.0).collect();

    let (a0, _da0_dy, da0_da) = a_and_grads(&zeros);
    let (ah, dah_dy, dah_da) = a_and_grads(&xh);
    let (ax, dax_dy, dax_da) = a_and_grads(x);

    let mut u = vec![0.0; n];
    let mut du = vec![[0.0; N_THETA]; n];

    for i in 0..n {
        let s = a0[i] + 4.0 * ah[i] + ax[i];
        u[i] = x[i] / 6.0 * s;
        let du_dx = s / 6.0 + x[i] / 6.0 * (4.0 * dah_dy[i] * 0.5 + dax_dy[i]);
        for c in 0..N_THETA {
            du[i][c] = du_dx * dx[i][c];
        }
        for m in 0..M_POLY {
            let du_da_val = (x[i] / 6.0) * (da0_da[i][m] + 4.0 * dah_da[i][m] + dax_da[i][m]);
            du[i][m] += du_da_val;
        }
    }

    (u, du)
}

/// `model.surface_to_rectified` (`model.py:240-246`): image points →
/// rectified `(u, v)` — `backproject` then `flatten_u` on `Sx`, paired with
/// `Sy` unchanged.
pub fn surface_to_rectified(
    pts: &[[f64; 2]],
    params: &DewarpParams,
    k_init: Option<&[f64]>,
) -> Vec<[f64; 2]> {
    let bp = backproject(pts, params, k_init);
    let u = flatten_u(&bp.sx, params);
    (0..pts.len()).map(|i| [u[i], bp.sy[i]]).collect()
}

/// `model.rectified_to_image` (`model.py:249-290`): the **inverse** map
/// used for `cv2.remap`'s coordinate lookup. Inverts the monotonically
/// increasing arc-length function `A(x)` by tabulating it on **4001
/// samples** over `±span` (`span = max(1, 1.5*max|u| + scale)`) and
/// `np.interp`-ing.
///
/// When `x_clamp` is given, the surface is continued **linearly along its
/// tangent** outside that range (the polynomial is unreliable beyond the
/// feature-bearing region — oscillating extrapolation would distort
/// rendering) and arc length is integrated with a **cumulative
/// trapezoidal** rule (not Simpson — see [`flatten_u`]'s doc comment),
/// re-zeroed so `A(0) = 0`. `x_clamp` is `(p1, p99)` of `Sx` at the
/// pipeline's final solve — a quantity that is easy to drop by accident.
pub fn rectified_to_image(
    uv: &[[f64; 2]],
    params: &DewarpParams,
    x_clamp: Option<(f64, f64)>,
) -> Vec<[f64; 2]> {
    let n = uv.len();
    let u: Vec<f64> = uv.iter().map(|p| p[0]).collect();
    let v: Vec<f64> = uv.iter().map(|p| p[1]).collect();

    let max_abs_u = u.iter().fold(0.0_f64, |acc, &ui| acc.max(ui.abs()));
    let span: f64 = (max_abs_u * 1.5 + params.scale).max(1.0);

    const N_SAMPLES: usize = 4001;
    let xs: Vec<f64> = (0..N_SAMPLES)
        .map(|i| -span + 2.0 * span * (i as f64) / ((N_SAMPLES - 1) as f64))
        .collect();

    let (x_vals, g_pt): (Vec<f64>, Vec<f64>) = if let Some((clo, chi)) = x_clamp {
        let xc: Vec<f64> = xs.iter().map(|&xv| xv.max(clo).min(chi)).collect();
        let gp_xc = params.g_prime(&xc);
        // model.py:271 also computes `g_xs = g(xc) + g'(xc)*(xs-xc)` here but never
        // reads it again (dead in the Python reference too) — not ported.
        // Cumulative trapezoidal arc length using seg = sqrt(1 + gp_xs^2), gp_xs == gp_xc
        // per model.py:272-274 (`gp_xs = params.g_prime(xc)`).
        let seg: Vec<f64> = gp_xc.iter().map(|&g| (1.0 + g * g).sqrt()).collect();
        let mut us = vec![0.0; N_SAMPLES];
        let mut cum = 0.0;
        for i in 1..N_SAMPLES {
            cum += 0.5 * (seg[i] + seg[i - 1]) * (xs[i] - xs[i - 1]);
            us[i] = cum;
        }
        let zero_offset = crate::stats::interp(0.0, &xs, &us);
        for uv_val in us.iter_mut() {
            *uv_val -= zero_offset;
        }
        let x: Vec<f64> = u
            .iter()
            .map(|&uu| crate::stats::interp(uu, &us, &xs))
            .collect();
        let xc_pt: Vec<f64> = x.iter().map(|&xv| xv.max(clo).min(chi)).collect();
        let g_xc_pt = params.g(&xc_pt);
        let gp_xc_pt = params.g_prime(&xc_pt);
        let g_pt: Vec<f64> = (0..n)
            .map(|i| g_xc_pt[i] + gp_xc_pt[i] * (x[i] - xc_pt[i]))
            .collect();
        (x, g_pt)
    } else {
        // Monotonically increasing because sqrt(1+g'^2) > 0 (model.py:283).
        let us = flatten_u(&xs, params);
        let x: Vec<f64> = u
            .iter()
            .map(|&uu| crate::stats::interp(uu, &us, &xs))
            .collect();
        let g_pt = params.g(&x);
        (x, g_pt)
    };

    let r = params.r();
    let mut out = vec![[0.0; 2]; n];
    for i in 0..n {
        // S = [x, v, g_pt]; W = S @ R.T + [0,0,f]  ⇒  W[j] = Σ_k R[j][k]·S[k], W[2] += f.
        let s = [x_vals[i], v[i], g_pt[i]];
        let mut w = [0.0; 3];
        for j in 0..3 {
            w[j] = r[j][0] * s[0] + r[j][1] * s[1] + r[j][2] * s[2];
        }
        w[2] += params.f;
        let alpha = params.f * w[0] / w[2] + params.cx;
        let beta = params.f * w[1] / w[2] + params.cy;
        out[i] = [alpha, beta];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The synthetic-cylinder control case's ground-truth params:
    /// `a=[0, 0.6, 0, -0.25]`, `rvec=[0.05, 0, 0]`, `f=1600, cx=600, cy=800,
    /// scale=1600`.
    fn cylinder_params() -> DewarpParams {
        DewarpParams {
            a: [0.0, 0.6, 0.0, -0.25],
            rvec: [0.05, 0.0, 0.0],
            f: 1600.0,
            cx: 600.0,
            cy: 800.0,
            scale: 1600.0,
        }
    }

    /// Forward-projects a known surface point `(Sx, Sy)` to an image point
    /// `(α, β)`, mirroring `rectified_to_image`'s own tail
    /// (`S = [Sx, Sy, g(Sx)]`, `W = R·S + [0,0,f]`, pinhole divide) — used to
    /// manufacture image points that are *known* to backproject to a given
    /// surface point, for the roundtrip tests below.
    fn forward_from_surface(params: &DewarpParams, sx: f64, sy: f64) -> [f64; 2] {
        let gx = params.g(&[sx])[0];
        let r = params.r();
        let s = [sx, sy, gx];
        let mut w = [0.0; 3];
        for j in 0..3 {
            w[j] = r[j][0] * s[0] + r[j][1] * s[1] + r[j][2] * s[2];
        }
        w[2] += params.f;
        [
            params.f * w[0] / w[2] + params.cx,
            params.f * w[1] / w[2] + params.cy,
        ]
    }

    // -- (a) analytic: recover/evaluate known coefficients -------------------

    #[test]
    fn g_and_g_prime_match_the_manual_polynomial() {
        // h(t) = 0.6 t^2 - 0.25 t^4 (a=[0,0.6,0,-0.25]); h'(t) = 1.2 t - t^3.
        let params = cylinder_params();
        for &x in &[-1200.0, -400.0, -1.0, 0.0, 250.0, 900.0, 1500.0] {
            let t = x / params.scale;
            let h = 0.6 * t * t - 0.25 * t.powi(4);
            let hp = 1.2 * t - t.powi(3);
            let g_expected = params.scale * h;
            let gp_expected = hp;
            let g_actual = params.g(&[x])[0];
            let gp_actual = params.g_prime(&[x])[0];
            assert!(
                (g_actual - g_expected).abs() < 1e-9,
                "g({x}) = {g_actual}, expected {g_expected}"
            );
            assert!(
                (gp_actual - gp_expected).abs() < 1e-9,
                "g'({x}) = {gp_actual}, expected {gp_expected}"
            );
        }
    }

    #[test]
    fn backproject_recovers_a_known_surface_point() {
        let params = cylinder_params();
        for &(sx, sy) in &[
            (0.0, 0.0),
            (300.0, -200.0),
            (-500.0, 400.0),
            (800.0, 150.0),
            (-950.0, -700.0),
        ] {
            let img = forward_from_surface(&params, sx, sy);
            let bp = backproject(&[img], &params, None);
            assert!(
                (bp.sx[0] - sx).abs() < 1e-6,
                "Sx: got {} want {sx}",
                bp.sx[0]
            );
            assert!(
                (bp.sy[0] - sy).abs() < 1e-6,
                "Sy: got {} want {sy}",
                bp.sy[0]
            );
        }
    }

    #[test]
    fn surface_to_rectified_then_rectified_to_image_roundtrips() {
        let params = cylinder_params();
        let surface_pts = [(0.0, 0.0), (300.0, -200.0), (-500.0, 400.0), (800.0, 150.0)];
        let img_pts: Vec<[f64; 2]> = surface_pts
            .iter()
            .map(|&(sx, sy)| forward_from_surface(&params, sx, sy))
            .collect();

        let uv = surface_to_rectified(&img_pts, &params, None);
        // No x_clamp: rectified_to_image's own tabulated inverse (4001 samples).
        let back = rectified_to_image(&uv, &params, None);
        for i in 0..img_pts.len() {
            let dx = back[i][0] - img_pts[i][0];
            let dy = back[i][1] - img_pts[i][1];
            assert!(
                dx.abs() < 0.5 && dy.abs() < 0.5,
                "point {i}: roundtrip {:?} vs original {:?} (tabulated-inverse tolerance)",
                back[i],
                img_pts[i]
            );
        }
    }

    #[test]
    fn rectified_to_image_with_x_clamp_roundtrips_inside_the_clamp() {
        let params = cylinder_params();
        // Clamp comfortably contains these surface points' Sx values.
        let x_clamp = (-1000.0, 1000.0);
        let surface_pts = [(0.0, 0.0), (300.0, -200.0), (-500.0, 400.0)];
        let img_pts: Vec<[f64; 2]> = surface_pts
            .iter()
            .map(|&(sx, sy)| forward_from_surface(&params, sx, sy))
            .collect();

        let uv = surface_to_rectified(&img_pts, &params, None);
        let back = rectified_to_image(&uv, &params, Some(x_clamp));
        for i in 0..img_pts.len() {
            let dx = back[i][0] - img_pts[i][0];
            let dy = back[i][1] - img_pts[i][1];
            assert!(
                dx.abs() < 0.5 && dy.abs() < 0.5,
                "point {i}: clamped roundtrip {:?} vs original {:?}",
                back[i],
                img_pts[i]
            );
        }
    }

    // -- (a) analytic: Jacobian vs central finite differences -----------------

    /// `theta` = `(a_1..a_4, r_1..r_3, log f)`, matching
    /// `optimize.pack_theta`'s documented column order (model.rs's own doc
    /// comment on `N_THETA`). `cx`/`cy`/`scale` stay fixed, as in a real
    /// solve (only the 8 `theta` entries are optimization variables).
    fn params_from_theta(theta: &[f64; N_THETA], cx: f64, cy: f64, scale: f64) -> DewarpParams {
        DewarpParams {
            a: [theta[0], theta[1], theta[2], theta[3]],
            rvec: [theta[4], theta[5], theta[6]],
            f: theta[7].exp(),
            cx,
            cy,
            scale,
        }
    }

    /// `(u, v)` for one image point at a given `theta`, via the plain
    /// (non-gradient) forward chain — used as the finite-difference oracle.
    fn uv_at_theta(pt: [f64; 2], theta: &[f64; N_THETA], cx: f64, cy: f64, scale: f64) -> [f64; 2] {
        let params = params_from_theta(theta, cx, cy, scale);
        let bp = backproject(&[pt], &params, None);
        let u = flatten_u(&bp.sx, &params);
        [u[0], bp.sy[0]]
    }

    #[test]
    fn analytic_jacobian_matches_central_finite_differences() {
        let cx = 600.0_f64;
        let cy = 800.0_f64;
        let scale = 1600.0_f64;
        let base_theta: [f64; N_THETA] = [0.0, 0.6, 0.0, -0.25, 0.05, 0.0, 0.0, 1600.0_f64.ln()];
        // A second theta with nonzero rvec on all three axes, to exercise the
        // full rotation-Jacobian chain (not just the single-axis cylinder
        // case), and a near-zero-rvec theta to cross rodrigues.rs's small-θ
        // Taylor branch from inside backproject_with_grad's caller.
        let thetas: [[f64; N_THETA]; 3] = [
            base_theta,
            [0.1, -0.3, 0.05, 0.2, 0.2, -0.15, 0.1, 1500.0_f64.ln()],
            [0.02, 0.1, -0.02, 0.05, 1e-6, -2e-6, 5e-7, 1650.0_f64.ln()],
        ];
        // Fixed "random" image points, scattered around the principal point
        // (no external RNG dependency, per rodrigues.rs's own test pattern).
        let img_pts: [[f64; 2]; 5] = [
            [600.0, 800.0],
            [200.0, 350.0],
            [980.0, 1400.0],
            [50.0, 1500.0],
            [1100.0, 120.0],
        ];

        let h = 1e-6;
        for theta in &thetas {
            let params = params_from_theta(theta, cx, cy, scale);
            let bpg = backproject_with_grad(&img_pts, &params, None);
            let (_u, du) = flatten_u_with_grad(&bpg.sx, &bpg.d_sx, &params);

            for (i, &pt) in img_pts.iter().enumerate() {
                for c in 0..N_THETA {
                    let mut plus = *theta;
                    let mut minus = *theta;
                    plus[c] += h;
                    minus[c] -= h;
                    let uv_plus = uv_at_theta(pt, &plus, cx, cy, scale);
                    let uv_minus = uv_at_theta(pt, &minus, cx, cy, scale);
                    let du_dc_fd = (uv_plus[0] - uv_minus[0]) / (2.0 * h);
                    let dv_dc_fd = (uv_plus[1] - uv_minus[1]) / (2.0 * h);

                    let du_dc = du[i][c];
                    let dv_dc = bpg.d_sy[i][c];

                    for (analytic, fd, label) in [(du_dc, du_dc_fd, "du"), (dv_dc, dv_dc_fd, "dv")]
                    {
                        let denom = fd.abs().max(1e-6);
                        let rel_err = (analytic - fd).abs() / denom;
                        assert!(
                            rel_err <= 1e-6 || (analytic - fd).abs() <= 1e-6,
                            "{label}/dtheta[{c}] at point {i}, theta={theta:?}: analytic={analytic} fd={fd} rel_err={rel_err}"
                        );
                    }
                }
            }
        }
    }
}
