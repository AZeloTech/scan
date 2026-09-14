//! Bounded projected Levenberg–Marquardt least-squares — hand-rolled port
//! of `lsq.py`'s `least_squares_np`, the sole optimizer in the pipeline
//!
//! **No external LM crate**: the `levenberg-marquardt`
//! crate has no box constraints, and reparameterizing 8 bounded params
//! through sigmoid/tanh would change the conditioning `lsq.py`'s exact
//! λ-scaling and active-set logic assumes — exactly the kind of divergence
//! that changes *which* local minimum wins.
//!
//! **No `nalgebra`** either (Cargo.toml's dependency-decision comment):
//! this crate hand-rolls the dense `n×n` (`n ∈ {7, 8}`) normal-equations
//! solve — Cholesky with an LU fallback, mirroring NumPy's
//! `linalg.solve` → LAPACK `gesv` (LU, partial pivoting) with a
//! `linalg.lstsq(rcond=None)` (`gelsd`, divide-and-conquer SVD) fallback on
//! `LinAlgError` (`lsq.py:101-104`).
//!
//! Convergence/termination logic that changes *results*, not just speed,
//! and must be replicated exactly:
//! `ftol = xtol = gtol = 1e-8`; `λ` starts at `1e-3`, ×4 on rejection, `/3`
//! (floor `1e-12`) when `ρ > 0.75`, `×2` (cap `1e12`) when `ρ < 0.25`; trust
//! radius `delta` starts at `‖x0 ⊙ scale_inv‖` or `1`, doubles to
//! `2·s_norm` on `ρ > 0.75`, halves on `ρ < 0.25` and `×0.25` on rejection;
//! **two consecutive** relative drops below `ftol` are required to stop
//! (`small_drops`); step projection **clips per-coordinate** rather than
//! shrinking the whole step (`lsq.py:111-115` — the code's own comment
//! explains why: it lets other free coordinates keep moving once one hits a
//! bound; do not "fix" this into a whole-step shrink).

/// `lsq.LsqResult` (`lsq.py:30-34`).
#[derive(Debug, Clone)]
pub struct LsqResult {
    pub x: Vec<f64>,
    pub cost: f64,
    pub nfev: usize,
}

/// `lsq.least_squares_np` (`lsq.py:37-156`).
///
/// `fun(x) -> residuals` (length `m`); `jac(x) -> Jacobian`, `m` rows of
/// length `x.len()` each (row-major, one `Vec<f64>` per residual row) —
/// same shape contract `optimize::CostFunction::residuals`/`::jacobian`
/// produce. `bounds`, when given, is `(lo, hi)` each of length `x0.len()`
/// (`±f64::INFINITY` entries are treated as unbounded, matching
/// `lsq.py:49-54`'s `None` → `±inf` default). `x0.len()` is 7 or 8 in this
/// crate (the coarse `fix_f` stage solves a 7-variable subproblem by
/// slicing off the `log f` column, `optimize.py:489`).
pub fn least_squares<F, J>(
    mut fun: F,
    x0: &[f64],
    mut jac: J,
    bounds: Option<(&[f64], &[f64])>,
    max_nfev: usize,
) -> LsqResult
where
    F: FnMut(&[f64]) -> Vec<f64>,
    J: FnMut(&[f64]) -> Vec<Vec<f64>>,
{
    const FTOL: f64 = 1e-8;
    const XTOL: f64 = 1e-8;
    const GTOL: f64 = 1e-8;
    const EPS_B: f64 = 1e-10; // lsq.py:69

    let n = x0.len();
    let (lo, hi): (Vec<f64>, Vec<f64>) = match bounds {
        Some((l, h)) => (l.to_vec(), h.to_vec()),
        None => (vec![f64::NEG_INFINITY; n], vec![f64::INFINITY; n]),
    };
    let mut x: Vec<f64> = (0..n).map(|i| x0[i].max(lo[i]).min(hi[i])).collect();

    let mut r = fun(&x);
    let mut nfev = 1usize;
    if r.is_empty() {
        return LsqResult { x, cost: 0.0, nfev };
    }
    let mut jmat = jac(&x);
    let mut cost = 0.5 * dot(&r, &r);

    // x_scale='jac': historical maximum column norm (SciPy's update rule).
    let mut scale_inv = col_norms(&jmat, n);
    for s in scale_inv.iter_mut() {
        if *s == 0.0 {
            *s = 1.0;
        }
    }

    let mut lam = 1e-3_f64;
    let mut small_drops: i32 = 0;
    // delta = ||x0 * scale_inv|| or 1 if that's zero (lsq.py:74).
    let x0_scaled: Vec<f64> = (0..n).map(|i| x[i] * scale_inv[i]).collect();
    let x0_scaled_norm = norm2(&x0_scaled);
    let mut delta = if x0_scaled_norm != 0.0 {
        x0_scaled_norm
    } else {
        1.0
    };

    let lo_thr: Vec<f64> = (0..n)
        .map(|i| {
            if lo[i].is_finite() {
                lo[i] + EPS_B * 1.0_f64.max(lo[i].abs())
            } else {
                f64::NEG_INFINITY
            }
        })
        .collect();
    let hi_thr: Vec<f64> = (0..n)
        .map(|i| {
            if hi[i].is_finite() {
                hi[i] - EPS_B * 1.0_f64.max(hi[i].abs())
            } else {
                f64::INFINITY
            }
        })
        .collect();

    while nfev < max_nfev {
        let g = jt_r(&jmat, &r, n);
        // Active set: freeze variables on a bound whose gradient points outward.
        let at_lo: Vec<bool> = (0..n).map(|i| x[i] <= lo_thr[i]).collect();
        let at_hi: Vec<bool> = (0..n).map(|i| x[i] >= hi_thr[i]).collect();
        let frozen: Vec<bool> = (0..n)
            .map(|i| (at_lo[i] && g[i] > 0.0) || (at_hi[i] && g[i] < 0.0))
            .collect();
        let free: Vec<bool> = frozen.iter().map(|&f| !f).collect();

        // Convergence test on the scaled projected gradient.
        let pg: Vec<f64> = (0..n).map(|i| if frozen[i] { 0.0 } else { g[i] }).collect();
        let max_pg_scaled = (0..n)
            .map(|i| (pg[i] / scale_inv[i]).abs())
            .fold(0.0_f64, f64::max);
        if max_pg_scaled < GTOL {
            break;
        }
        if !free.iter().any(|&f| f) {
            break;
        }

        let free_idx: Vec<usize> = (0..n).filter(|&i| free[i]).collect();
        let nf = free_idx.len();
        let jf: Vec<Vec<f64>> = jmat
            .iter()
            .map(|row| free_idx.iter().map(|&i| row[i]).collect())
            .collect();
        let gf: Vec<f64> = free_idx.iter().map(|&i| g[i]).collect();
        let df: Vec<f64> = free_idx.iter().map(|&i| scale_inv[i]).collect();
        let jtj = jtj_matrix(&jf, nf);

        let mut accepted = false;
        while nfev < max_nfev {
            // A = JtJ + lam*diag(df^2)
            let mut a = jtj.clone();
            for i in 0..nf {
                a[i][i] += lam * df[i] * df[i];
            }
            let neg_gf: Vec<f64> = gf.iter().map(|&v| -v).collect();
            let p_free = solve_normal_equations(&a, &neg_gf);

            let mut p = vec![0.0; n];
            for (k, &i) in free_idx.iter().enumerate() {
                p[i] = p_free[k];
            }

            // Trust region: limit the scaled step length to delta.
            let p_scaled: Vec<f64> = (0..n).map(|i| p[i] * scale_inv[i]).collect();
            let s_norm = norm2(&p_scaled);
            if s_norm > delta {
                let factor = delta / s_norm;
                for v in p.iter_mut() {
                    *v *= factor;
                }
            }

            // Projection: clip per-coordinate, do NOT shrink the whole step
            // (lsq.py:111-115 — this lets other free coordinates keep moving
            // once one hits a bound).
            let x_new: Vec<f64> = (0..n)
                .map(|i| (x[i] + p[i]).max(lo[i]).min(hi[i]))
                .collect();
            let step: Vec<f64> = (0..n).map(|i| x_new[i] - x[i]).collect();
            let step_norm = norm2(&step);
            if step_norm < 1e-15 {
                lam *= 4.0;
                if lam > 1e12 {
                    return LsqResult { x, cost, nfev };
                }
                continue;
            }
            let r_new = fun(&x_new);
            nfev += 1;
            let cost_new = 0.5 * dot(&r_new, &r_new);
            if cost_new < cost {
                // Gain ratio (actual/predicted reduction).
                let j_step = j_matvec(&jmat, &step);
                let jt_jstep = jt_r(&jmat, &j_step, n);
                let pred = -dot(&g, &step) - 0.5 * dot(&step, &jt_jstep);
                let rho = (cost - cost_new) / pred.max(1e-300);
                let rel_drop = (cost - cost_new) / cost.max(1e-300);
                x = x_new;
                r = r_new;
                cost = cost_new;
                if rho > 0.75 {
                    lam = (lam / 3.0).max(1e-12);
                    delta = delta.max(2.0 * s_norm);
                } else if rho < 0.25 {
                    lam = (lam * 2.0).min(1e12);
                    delta *= 0.5;
                }
                accepted = true;
                // Two consecutive small improvements required to avoid
                // stopping early at a local solution (lsq.py:139-145).
                small_drops = if rel_drop < FTOL { small_drops + 1 } else { 0 };
                let x_norm = norm2(&x);
                if small_drops >= 2 || step_norm < XTOL * 1.0_f64.max(x_norm) {
                    return LsqResult { x, cost, nfev };
                }
                break;
            }
            lam *= 4.0;
            delta *= 0.25;
            if lam > 1e12 {
                return LsqResult { x, cost, nfev };
            }
        }
        if !accepted {
            break;
        }
        jmat = jac(&x);
        let new_scale = col_norms(&jmat, n);
        for i in 0..n {
            if new_scale[i] > scale_inv[i] {
                scale_inv[i] = new_scale[i];
            }
        }
    }

    LsqResult { x, cost, nfev }
}

/// `Σ a_i·b_i` — plain accumulation, centralized: no FMA, fixed order.
fn dot(a: &[f64], b: &[f64]) -> f64 {
    let mut s = 0.0;
    for i in 0..a.len() {
        s += a[i] * b[i];
    }
    s
}

/// `Jᵀ·r` — `J` is `m` rows of length `n` (row-major, one `Vec<f64>` per
/// residual row), `r` has length `m`. Returns length `n`.
fn jt_r(jmat: &[Vec<f64>], r: &[f64], n: usize) -> Vec<f64> {
    let mut g = vec![0.0; n];
    for (row, &rv) in jmat.iter().zip(r.iter()) {
        for j in 0..n {
            g[j] += row[j] * rv;
        }
    }
    g
}

/// `J·v` — `J` is `m×n` row-major, `v` has length `n`. Returns length `m`.
fn j_matvec(jmat: &[Vec<f64>], v: &[f64]) -> Vec<f64> {
    jmat.iter().map(|row| dot(row, v)).collect()
}

/// `Jfᵀ·Jf` (`nf×nf`, symmetric) — `jf` is `m` rows of length `nf`.
fn jtj_matrix(jf: &[Vec<f64>], nf: usize) -> Vec<Vec<f64>> {
    let mut jtj = vec![vec![0.0; nf]; nf];
    for row in jf {
        for i in 0..nf {
            let ri = row[i];
            for j in 0..nf {
                jtj[i][j] += ri * row[j];
            }
        }
    }
    jtj
}

/// Dense `n×n` (`n ≤ 8`) solve of `A·x = b` where `A` is (numerically)
/// symmetric positive-(semi)definite by construction (`JtJ + λ·diag(d²)`,
/// `lsq.py:100`) — Cholesky, falling back to Gaussian elimination with
/// partial pivoting (mirroring `np.linalg.solve`'s LAPACK `gesv` path) and,
/// on failure of *that*, a minimum-norm SVD solve (mirroring
/// `np.linalg.lstsq(A, b, rcond=None)`, `lsq.py:104` — a rare path).
/// Internal to [`least_squares`]; not part of the crate's stable API but
/// exposed at `pub(crate)` visibility so `optimize.rs`'s own smaller solves
/// (if any) can reuse it rather than re-deriving.
pub(crate) fn solve_normal_equations(a: &[Vec<f64>], b: &[f64]) -> Vec<f64> {
    if let Some(x) = cholesky_solve(a, b) {
        return x;
    }
    if let Some(x) = lu_solve(a, b) {
        return x;
    }
    min_norm_solve(a, b)
}

/// Cholesky factorization + forward/back substitution. Returns `None` if `a`
/// is not (numerically) positive definite — the common case is PD by
/// construction (`JtJ + λ·diag(d²)`, `λ>0`), so this is the fast, silent
/// path taken almost always.
fn cholesky_solve(a: &[Vec<f64>], b: &[f64]) -> Option<Vec<f64>> {
    let n = a.len();
    let mut l = vec![vec![0.0; n]; n];
    for i in 0..n {
        for j in 0..=i {
            let mut sum = a[i][j];
            for k in 0..j {
                sum -= l[i][k] * l[j][k];
            }
            if i == j {
                if !(sum > 0.0) || !sum.is_finite() {
                    return None;
                }
                l[i][j] = sum.sqrt();
            } else {
                l[i][j] = sum / l[j][j];
            }
        }
    }
    // L y = b
    let mut y = vec![0.0; n];
    for i in 0..n {
        let mut sum = b[i];
        for k in 0..i {
            sum -= l[i][k] * y[k];
        }
        y[i] = sum / l[i][i];
    }
    // Lᵀ x = y
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut sum = y[i];
        for k in (i + 1)..n {
            sum -= l[k][i] * x[k];
        }
        x[i] = sum / l[i][i];
    }
    Some(x)
}

/// Gaussian elimination with partial pivoting — mirrors `np.linalg.solve`'s
/// LAPACK `gesv` path (`lsq.py:102`), used as the fallback when Cholesky
/// reports a non-PD matrix.
fn lu_solve(a: &[Vec<f64>], b: &[f64]) -> Option<Vec<f64>> {
    let n = a.len();
    let mut m: Vec<Vec<f64>> = a.to_vec();
    let mut rhs = b.to_vec();
    for col in 0..n {
        let mut piv = col;
        let mut max_val = m[col][col].abs();
        for r in (col + 1)..n {
            if m[r][col].abs() > max_val {
                max_val = m[r][col].abs();
                piv = r;
            }
        }
        if max_val < 1e-300 {
            return None; // singular
        }
        if piv != col {
            m.swap(col, piv);
            rhs.swap(col, piv);
        }
        for r in (col + 1)..n {
            let factor = m[r][col] / m[col][col];
            if factor == 0.0 {
                continue;
            }
            for c in col..n {
                m[r][c] -= factor * m[col][c];
            }
            rhs[r] -= factor * rhs[col];
        }
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut sum = rhs[i];
        for k in (i + 1)..n {
            sum -= m[i][k] * x[k];
        }
        if m[i][i].abs() < 1e-300 {
            return None;
        }
        x[i] = sum / m[i][i];
    }
    Some(x)
}

/// Minimum-norm solve via a symmetric eigendecomposition — mirrors
/// `np.linalg.lstsq(A, b, rcond=None)` (`gelsd`, divide-and-conquer SVD,
/// `lsq.py:104`) for the case that matters here: `A` is always symmetric by
/// construction (`JtJ + λ·diag(d²)`), so its eigendecomposition *is* an SVD
/// (up to sign) and this is exact, not an approximation. This path is
/// rarely taken.
fn min_norm_solve(a: &[Vec<f64>], b: &[f64]) -> Vec<f64> {
    let n = a.len();
    let (eigvals, v) = jacobi_eigen(a);
    let max_abs = eigvals.iter().fold(0.0_f64, |acc, &e| acc.max(e.abs()));
    // rcond=None cutoff: singular values below `max(m,n)*eps*sigma_max` are
    // treated as zero.
    let tol = f64::EPSILON * (n as f64) * max_abs;
    let mut vtb = vec![0.0; n];
    for i in 0..n {
        let mut s = 0.0;
        for k in 0..n {
            s += v[k][i] * b[k];
        }
        vtb[i] = s;
    }
    let mut y = vec![0.0; n];
    for i in 0..n {
        y[i] = if eigvals[i].abs() > tol {
            vtb[i] / eigvals[i]
        } else {
            0.0
        };
    }
    let mut x = vec![0.0; n];
    for i in 0..n {
        let mut s = 0.0;
        for k in 0..n {
            s += v[i][k] * y[k];
        }
        x[i] = s;
    }
    x
}

/// Cyclic Jacobi eigenvalue algorithm for small dense symmetric matrices
/// (`n ≤ 8` in this crate). Returns `(eigenvalues, eigenvectors)` with
/// `eigenvectors[:, i]` the eigenvector for `eigenvalues[i]` (column `i` of
/// the returned matrix, i.e. `v[row][i]`). Only used by [`min_norm_solve`],
/// which is itself a rare fallback path — classical Jacobi
/// (not a fast/large-matrix algorithm) is appropriate at this size.
fn jacobi_eigen(a_in: &[Vec<f64>]) -> (Vec<f64>, Vec<Vec<f64>>) {
    let n = a_in.len();
    let mut a: Vec<Vec<f64>> = a_in.to_vec();
    let mut v: Vec<Vec<f64>> = (0..n)
        .map(|i| (0..n).map(|j| if i == j { 1.0 } else { 0.0 }).collect())
        .collect();

    for _sweep in 0..100 {
        let mut off = 0.0;
        for i in 0..n {
            for j in 0..n {
                if i != j {
                    off += a[i][j] * a[i][j];
                }
            }
        }
        if off.sqrt() < 1e-14 {
            break;
        }
        for p in 0..n {
            for q in (p + 1)..n {
                if a[p][q].abs() < 1e-300 {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = if theta == 0.0 {
                    1.0
                } else {
                    theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt())
                };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;

                let app = a[p][p];
                let aqq = a[q][q];
                let apq = a[p][q];
                a[p][p] = c * c * app - 2.0 * s * c * apq + s * s * aqq;
                a[q][q] = s * s * app + 2.0 * s * c * apq + c * c * aqq;
                a[p][q] = 0.0;
                a[q][p] = 0.0;
                for i in 0..n {
                    if i != p && i != q {
                        let aip = a[i][p];
                        let aiq = a[i][q];
                        a[i][p] = c * aip - s * aiq;
                        a[p][i] = a[i][p];
                        a[i][q] = s * aip + c * aiq;
                        a[q][i] = a[i][q];
                    }
                }
                for i in 0..n {
                    let vip = v[i][p];
                    let viq = v[i][q];
                    v[i][p] = c * vip - s * viq;
                    v[i][q] = s * vip + c * viq;
                }
            }
        }
    }
    let eigenvalues: Vec<f64> = (0..n).map(|i| a[i][i]).collect();
    (eigenvalues, v)
}

/// Euclidean 2-norm of a slice — `np.linalg.norm` on a 1-D array
/// (`lsq.py:65,74,108,117,143,154`; also used throughout `optimize.rs`).
/// Trivial, but centralized so every call site uses the same summation
/// order: no FMA contraction, fixed summation order.
pub fn norm2(v: &[f64]) -> f64 {
    let mut s = 0.0;
    for &x in v {
        s += x * x;
    }
    s.sqrt()
}

/// Per-column Euclidean 2-norm of a dense `m×n` matrix (row-major, `n`
/// columns per row) — `np.linalg.norm(J, axis=0)`, used for the
/// `x_scale='jac'`-equivalent column scaling (`lsq.py:65,154`).
pub fn col_norms(rows: &[Vec<f64>], n: usize) -> Vec<f64> {
    let mut sumsq = vec![0.0; n];
    for row in rows {
        for j in 0..n {
            sumsq[j] += row[j] * row[j];
        }
    }
    sumsq.iter().map(|&s| s.sqrt()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- solve_normal_equations sanity -----------------------------------

    #[test]
    fn solve_normal_equations_identity() {
        let a = vec![vec![1.0, 0.0], vec![0.0, 1.0]];
        let b = vec![3.0, -4.0];
        let x = solve_normal_equations(&a, &b);
        assert!((x[0] - 3.0).abs() < 1e-12);
        assert!((x[1] + 4.0).abs() < 1e-12);
    }

    #[test]
    fn solve_normal_equations_spd_2x2() {
        // A = [[4,1],[1,3]] (SPD), b=[1,2] -> x = A^-1 b = [1/11, 7/11]
        let a = vec![vec![4.0, 1.0], vec![1.0, 3.0]];
        let b = vec![1.0, 2.0];
        let x = solve_normal_equations(&a, &b);
        assert!((x[0] - 1.0 / 11.0).abs() < 1e-10, "x0={}", x[0]);
        assert!((x[1] - 7.0 / 11.0).abs() < 1e-10, "x1={}", x[1]);
    }

    #[test]
    fn solve_normal_equations_singular_falls_back_to_min_norm() {
        // A is PSD but singular (rank 1): A = [[1,1],[1,1]], b=[2,2] (consistent).
        // Minimum-norm solution to x0+x1=2 is x0=x1=1.
        let a = vec![vec![1.0, 1.0], vec![1.0, 1.0]];
        let b = vec![2.0, 2.0];
        let x = solve_normal_equations(&a, &b);
        assert!((x[0] - 1.0).abs() < 1e-8, "x0={}", x[0]);
        assert!((x[1] - 1.0).abs() < 1e-8, "x1={}", x[1]);
    }

    // -- (b) least_squares on a known bounded problem ---------------------
    //
    // Bounded Rosenbrock as a 2-residual least-squares problem:
    //   r0(x,y) = 1 - x
    //   r1(x,y) = 10*(y - x^2)
    // (minimizing 0.5*(r0^2+r1^2) = 0.5*((1-x)^2 + 100*(y-x^2)^2), the
    // standard Rosenbrock function.) Bounds lo=[-2,-2], hi=[0.8,2.0],
    // x0=[-1.2,1.0] (the classic Rosenbrock starting point) put the
    // unconstrained optimum (1,1) outside the upper bound on x, forcing the
    // active-set/bound-clipping logic to engage — not just the unconstrained
    // LM path.
    //
    // Reference value computed by running the *vendored* `lsq.py` verbatim
    // (parity/reference/src/dewarping/lsq.py) against this exact problem, in
    // a `python:3.12-slim` docker container with numpy 2.1.3 installed:
    //
    //   docker run --rm -v "$PWD:/ref:ro" python:3.12-slim sh -c '
    //     pip install -q numpy==2.1.3
    //     python3 - <<PYEOF
    //   import sys; sys.path.insert(0, "/ref")
    //   import numpy as np
    //   from lsq import least_squares_np
    //   fun = lambda x: np.array([1.0 - x[0], 10.0*(x[1] - x[0]**2)])
    //   jac = lambda x: np.array([[-1.0, 0.0], [-20.0*x[0], 10.0]])
    //   res = least_squares_np(fun, np.array([-1.2, 1.0]), jac,
    //                           bounds=(np.array([-2.0, -2.0]), np.array([0.8, 2.0])))
    //   print(res.x.tolist(), res.cost, res.nfev)
    //   PYEOF'
    //
    // Output (run 2026-08-18, cwd = parity/reference/src/dewarping):
    //   x = [0.8, 0.6400000000292766]
    //   cost = 0.01999999999999999
    //   nfev = 26
    #[test]
    fn bounded_rosenbrock_matches_python_reference() {
        let fun = |x: &[f64]| -> Vec<f64> { vec![1.0 - x[0], 10.0 * (x[1] - x[0] * x[0])] };
        let jac = |x: &[f64]| -> Vec<Vec<f64>> { vec![vec![-1.0, 0.0], vec![-20.0 * x[0], 10.0]] };

        let x0 = [-1.2, 1.0];
        let lo = [-2.0, -2.0];
        let hi = [0.8, 2.0];
        let result = least_squares(fun, &x0, jac, Some((&lo, &hi)), 600);

        // Python reference (provenance above): x = [0.8, 0.6400000000292766].
        let ref_x = [0.8_f64, 0.6400000000292766_f64];
        let ref_cost = 0.01999999999999999_f64;

        assert!(
            (result.x[0] - ref_x[0]).abs() < 1e-6,
            "x[0] = {}, python ref = {}",
            result.x[0],
            ref_x[0]
        );
        assert!(
            (result.x[1] - ref_x[1]).abs() < 1e-6,
            "x[1] = {}, python ref = {}",
            result.x[1],
            ref_x[1]
        );
        assert!(
            (result.cost - ref_cost).abs() < 1e-6,
            "cost = {}, python ref = {}",
            result.cost,
            ref_cost
        );
        // x[0] must sit on its active upper bound (0.8) — this is the
        // active-set/bound-clipping behavior the test exists to exercise.
        assert!((result.x[0] - 0.8).abs() < 1e-9);
    }

    #[test]
    fn unconstrained_rosenbrock_converges_near_the_global_minimum() {
        // Same residuals, no bounds: the global minimum (1,1) is reachable.
        let fun = |x: &[f64]| -> Vec<f64> { vec![1.0 - x[0], 10.0 * (x[1] - x[0] * x[0])] };
        let jac = |x: &[f64]| -> Vec<Vec<f64>> { vec![vec![-1.0, 0.0], vec![-20.0 * x[0], 10.0]] };
        let x0 = [-1.2, 1.0];
        let result = least_squares(fun, &x0, jac, None, 600);
        assert!((result.x[0] - 1.0).abs() < 1e-4, "x[0]={}", result.x[0]);
        assert!((result.x[1] - 1.0).abs() < 1e-4, "x[1]={}", result.x[1]);
        assert!(result.cost < 1e-8, "cost={}", result.cost);
    }
}
