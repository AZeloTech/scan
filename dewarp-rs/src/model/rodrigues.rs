//! Rodrigues rotation: `cv2.Rodrigues` — `model.py:39` (`R` only) and
//! `model.py:141` (`R` + the `3×9` Jacobian). ~40 lines closed-form each;
//! the Jacobian is the part that is easy to get wrong.
//!
//! Submodule of [`crate::model`].
//!
//! Port note: rather than transliterating OpenCV's internal `cvRodrigues2`
//! variable-by-variable, this is a from-scratch closed-form derivative of
//! the standard Rodrigues formula expressed directly in the *raw* (non-unit)
//! rotation vector `r` (the actual optimization variable — `model.py`'s
//! `rvec`, never renormalized by the caller):
//!
//! ```text
//! θ = |r|,  c1(θ) = sin(θ)/θ,  c2(θ) = (1-cos(θ))/θ²
//! R(r) = cos(θ)·I + c1(θ)·[r]_x + c2(θ)·(r rᵀ)
//! ```
//!
//! which is algebraically the same rotation OpenCV computes (§ the `unit
//! axis · sinθ·[k]_x + (1-cosθ)·k kᵀ` form reduces to this when `k = r/θ`)
//! — only the *values* of `R` and `∂R/∂r_j` are parity-relevant (they are
//! what `model.backproject_with_grad` consumes), not OpenCV's particular
//! internal computation graph, so a from-scratch derivation checked against
//! central finite differences (this module's own golden test) is
//! sufficient. `c1`/`c2` and their θ-derivatives switch to a Taylor
//! expansion below `THETA_SMALL` to avoid the removable `0/0` singularity at
//! `θ=0` in both value *and* derivative (a small-`rvec` regime the pipeline
//! visits at every coarse multi-start seed, `optimize.py`'s `rvec0` near
//! `[0,0,~0]`).

const THETA_SMALL: f64 = 1e-4;

/// `[v]_x`, the skew-symmetric cross-product matrix: `[v]_x w = v × w`.
fn skew(v: [f64; 3]) -> [[f64; 3]; 3] {
    [[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]]
}

/// `[e_j]_x` for the `j`-th standard basis vector — used for `∂[r]_x/∂r_j`,
/// which is exactly `skew(e_j)` (the skew map is linear in its argument).
fn skew_basis(j: usize) -> [[f64; 3]; 3] {
    let mut e = [0.0; 3];
    e[j] = 1.0;
    skew(e)
}

/// Returns `(sin(θ)/θ, d/dθ [sin(θ)/θ])`, Taylor-expanded below
/// `THETA_SMALL` (both the value and derivative have a removable
/// singularity at `θ=0` — `sinc(0)=1`, `sinc'(0)=0`).
fn sinc_and_deriv(theta: f64, sin_t: f64, cos_t: f64) -> (f64, f64) {
    if theta > THETA_SMALL {
        let c1 = sin_t / theta;
        let dc1 = (theta * cos_t - sin_t) / (theta * theta);
        (c1, dc1)
    } else {
        let t2 = theta * theta;
        let c1 = 1.0 - t2 / 6.0 + t2 * t2 / 120.0;
        let dc1 = -theta / 3.0 + theta * t2 / 30.0;
        (c1, dc1)
    }
}

/// Returns `((1-cos(θ))/θ², d/dθ [(1-cos(θ))/θ²])`, Taylor-expanded below
/// `THETA_SMALL` for the same reason as [`sinc_and_deriv`] (`versinc(0) =
/// 1/2`, `versinc'(0) = 0`).
fn versinc_and_deriv(theta: f64, sin_t: f64, cos_t: f64) -> (f64, f64) {
    if theta > THETA_SMALL {
        let t2 = theta * theta;
        let t3 = t2 * theta;
        let c2 = (1.0 - cos_t) / t2;
        let dc2 = (theta * sin_t - 2.0 * (1.0 - cos_t)) / t3;
        (c2, dc2)
    } else {
        let t2 = theta * theta;
        let c2 = 0.5 - t2 / 24.0 + t2 * t2 / 720.0;
        let dc2 = -theta / 12.0 + theta * t2 / 180.0;
        (c2, dc2)
    }
}

/// `cv2.Rodrigues(rvec)[0]` — exponential-map rotation vector to a 3×3
/// rotation matrix, row-major (`R[row][col]`).
pub fn rodrigues(rvec: [f64; 3]) -> [[f64; 3]; 3] {
    let theta2 = rvec[0] * rvec[0] + rvec[1] * rvec[1] + rvec[2] * rvec[2];
    let theta = theta2.sqrt();
    let cos_t = theta.cos();
    let sin_t = theta.sin();
    let (c1, _) = sinc_and_deriv(theta, sin_t, cos_t);
    let (c2, _) = versinc_and_deriv(theta, sin_t, cos_t);
    let rx = skew(rvec);

    let mut r = [[0.0; 3]; 3];
    for p in 0..3 {
        for q in 0..3 {
            let ident = if p == q { 1.0 } else { 0.0 };
            let outer = rvec[p] * rvec[q];
            r[p][q] = cos_t * ident + c1 * rx[p][q] + c2 * outer;
        }
    }
    r
}

/// `cv2.Rodrigues(rvec)` returning both outputs: `R` and its Jacobian.
/// OpenCV's raw Jacobian is `(3, 9)`: `dR_flat[j] = ∂vec(R)/∂r_j`
/// (row-major flatten of `R`). `model.py:143` reshapes this to `(3,3,3)`
/// with `dR[j, p, q] = ∂R[p,q]/∂r_j` — this function returns that already
/// reshaped: `jacobian[j][p][q] = ∂R[p,q]/∂r_j`.
pub fn rodrigues_with_jacobian(rvec: [f64; 3]) -> ([[f64; 3]; 3], [[[f64; 3]; 3]; 3]) {
    let theta2 = rvec[0] * rvec[0] + rvec[1] * rvec[1] + rvec[2] * rvec[2];
    let theta = theta2.sqrt();
    let cos_t = theta.cos();
    let sin_t = theta.sin();
    let (c1, dc1) = sinc_and_deriv(theta, sin_t, cos_t);
    let (c2, dc2) = versinc_and_deriv(theta, sin_t, cos_t);
    let rx = skew(rvec);

    let mut r = [[0.0; 3]; 3];
    for p in 0..3 {
        for q in 0..3 {
            let ident = if p == q { 1.0 } else { 0.0 };
            let outer = rvec[p] * rvec[q];
            r[p][q] = cos_t * ident + c1 * rx[p][q] + c2 * outer;
        }
    }

    let mut jac = [[[0.0; 3]; 3]; 3];
    for j in 0..3 {
        let dtheta_drj = if theta > 0.0 { rvec[j] / theta } else { 0.0 };
        let skew_ej = skew_basis(j);
        for p in 0..3 {
            for q in 0..3 {
                let ident = if p == q { 1.0 } else { 0.0 };
                let d_cos_term = -sin_t * dtheta_drj * ident;
                let d_c1_term = dc1 * dtheta_drj * rx[p][q] + c1 * skew_ej[p][q];
                let outer_p = if p == j { rvec[q] } else { 0.0 };
                let outer_q = if q == j { rvec[p] } else { 0.0 };
                let d_c2_term = dc2 * dtheta_drj * (rvec[p] * rvec[q]) + c2 * (outer_p + outer_q);
                jac[j][p][q] = d_cos_term + d_c1_term + d_c2_term;
            }
        }
    }
    (r, jac)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn central_diff_jacobian(rvec: [f64; 3]) -> [[[f64; 3]; 3]; 3] {
        let h = 1e-6;
        let mut jac = [[[0.0; 3]; 3]; 3];
        for j in 0..3 {
            let mut plus = rvec;
            let mut minus = rvec;
            plus[j] += h;
            minus[j] -= h;
            let r_plus = rodrigues(plus);
            let r_minus = rodrigues(minus);
            for p in 0..3 {
                for q in 0..3 {
                    jac[j][p][q] = (r_plus[p][q] - r_minus[p][q]) / (2.0 * h);
                }
            }
        }
        jac
    }

    #[test]
    fn rodrigues_identity_at_zero() {
        let r = rodrigues([0.0, 0.0, 0.0]);
        for p in 0..3 {
            for q in 0..3 {
                let expect = if p == q { 1.0 } else { 0.0 };
                assert!((r[p][q] - expect).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn rodrigues_is_orthonormal() {
        for rvec in [
            [0.1, 0.2, 0.3],
            [0.5, -0.4, 0.05],
            [-1.0, 0.0, 0.7],
            [1e-6, -2e-6, 5e-7],
        ] {
            let r = rodrigues(rvec);
            // R Rᵀ = I
            for p in 0..3 {
                for q in 0..3 {
                    let mut s = 0.0;
                    for k in 0..3 {
                        s += r[p][k] * r[q][k];
                    }
                    let expect = if p == q { 1.0 } else { 0.0 };
                    assert!(
                        (s - expect).abs() < 1e-10,
                        "R Rt[{p}][{q}] = {s}, rvec={rvec:?}"
                    );
                }
            }
            // det(R) = 1
            let det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
                - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
                + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
            assert!((det - 1.0).abs() < 1e-10, "det(R)={det}, rvec={rvec:?}");
        }
    }

    #[test]
    fn jacobian_matches_central_differences() {
        // "random" f64 points, fixed for reproducibility (no external RNG dep).
        let points: [[f64; 3]; 6] = [
            [0.123, -0.456, 0.789],
            [0.05, 0.0, -0.35],
            [1.3, -0.2, 0.4],
            [0.0002344666515853808, 0.0, 0.0],
            [-0.9, 0.9, -0.9],
            [0.0, 0.0, 0.0],
        ];
        for rvec in points {
            let (_r, analytic) = rodrigues_with_jacobian(rvec);
            let fd = central_diff_jacobian(rvec);
            for j in 0..3 {
                for p in 0..3 {
                    for q in 0..3 {
                        let a = analytic[j][p][q];
                        let f = fd[j][p][q];
                        let denom = f.abs().max(1e-8);
                        let rel_err = (a - f).abs() / denom;
                        assert!(
                            rel_err <= 1e-6 || (a - f).abs() <= 1e-8,
                            "jac[{j}][{p}][{q}] analytic={a} fd={f} rel_err={rel_err} rvec={rvec:?}"
                        );
                    }
                }
            }
        }
    }
}
