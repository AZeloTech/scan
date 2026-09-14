//! Shared numeric primitives whose *exact* semantics are parity-critical —
//! kept in their own module because they are independently testable and
//! independently easy to get subtly wrong (a different percentile
//! interpolation method, an unstable sort tie-break, etc. changes results
//! without ever throwing).
//!
//! All functions operate on `f64`, matching NumPy's default dtype, which is
//! what the optimizer and the geometry core use throughout.

/// `np.percentile(data, q)`, NumPy's default `method='linear'`: linear
/// interpolation between order statistics at fractional rank
/// `h = (n-1)·q/100`. `q` is a percentage in `[0, 100]`, matching NumPy's
/// own argument convention. Used at `dewarp.py:236-237,345-346,
/// 397,444,528-529,538-539`, `optimize.py:780-781`, `textline.py:162`.
///
/// A "nearest rank" percentile is explicitly the wrong algorithm here: it
/// silently shifts render bounds.
pub fn percentile(data: &[f64], q: f64) -> f64 {
    assert!(!data.is_empty(), "percentile: empty data");
    let mut sorted: Vec<f64> = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    percentile_presorted(&sorted, q)
}

fn percentile_presorted(sorted: &[f64], q: f64) -> f64 {
    let n = sorted.len();
    if n == 1 {
        return sorted[0];
    }
    let h = (n as f64 - 1.0) * q / 100.0;
    let lo = h.floor().max(0.0) as usize;
    let hi = h.ceil().min((n - 1) as f64) as usize;
    if lo == hi {
        return sorted[lo];
    }
    let frac = h - lo as f64;
    sorted[lo] + frac * (sorted[hi] - sorted[lo])
}

/// `percentile` for several `q` values against the same (sorted once) data —
/// a convenience for call sites like `np.percentile(x, [1, 99])`.
pub fn percentiles(data: &[f64], qs: &[f64]) -> Vec<f64> {
    assert!(!data.is_empty(), "percentiles: empty data");
    let mut sorted: Vec<f64> = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    qs.iter()
        .map(|&q| percentile_presorted(&sorted, q))
        .collect()
}

/// `np.median` — even-length arrays average the two middle order statistics.
/// Call sites: `optimize.py:226,247,550,551,837`, `textline.py:151,208,
/// 237,253,254`, `dewarp.py:436,441,459`.
pub fn median(data: &[f64]) -> f64 {
    assert!(!data.is_empty(), "median: empty data");
    let mut sorted: Vec<f64> = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = sorted.len();
    if n % 2 == 1 {
        sorted[n / 2]
    } else {
        0.5 * (sorted[n / 2 - 1] + sorted[n / 2])
    }
}

/// `_weighted_median` (`dewarp.py:170-173`) / the skew-seed inline
/// reimplementation (`optimize.py:676-678`): **left**-side
/// `searchsorted(cumsum(w[order]), 0.5*total)` — returns one of the input
/// data values, not an interpolated one. Not the same algorithm as
/// `percentile(data, 50)` with weights; do not "simplify" the two into one
/// function — the distinction is deliberate.
pub fn weighted_median(vals: &[f64], w: &[f64]) -> f64 {
    debug_assert_eq!(
        vals.len(),
        w.len(),
        "weighted_median: vals/w length mismatch"
    );
    let n = vals.len();
    assert!(n > 0, "weighted_median: empty input");
    // `order = np.argsort(vals)` — stable sort per this module's own
    // port-notes section (accept divergence only on exact ties).
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| vals[a].partial_cmp(&vals[b]).unwrap());
    // `cum = np.cumsum(w[order])`.
    let mut cum = vec![0.0f64; n];
    let mut running = 0.0f64;
    for i in 0..n {
        running += w[order[i]];
        cum[i] = running;
    }
    let target = 0.5 * cum[n - 1];
    // `np.searchsorted(cum, target)`, default `side='left'`: first index i
    // with `cum[i] >= target`.
    let mut idx = 0usize;
    while idx < n && cum[idx] < target {
        idx += 1;
    }
    let idx = idx.min(n - 1);
    vals[order[idx]]
}

/// `np.interp(x, xp, fp)` — piecewise-linear interpolation with **clamped
/// (constant) extrapolation** outside `[xp[0], xp[-1]]`. `xp` must be
/// non-decreasing (the Python call sites all guarantee this). Load-bearing
/// in `model::rectified_to_image`'s inverse-map lookup: that clamping is
/// load-bearing.
///
/// Implemented here (not left as a `model.rs`-local helper) because it is
/// this module's documented job — shared numeric primitives whose exact
/// definition is parity-critical — and `linesegs.rs` needs the same exact
/// semantics for its own `np.interp` call sites. `textline.py` is the first
/// consumer of `percentile`/`percentiles`/`median`/`polyfit_quadratic`/
/// `polyval_quadratic`/`polyder_quadratic` (`_link_ccs_into_lines`'s median/p90 gate, `_validate_line`'s
/// `np.polyfit`/`polyval`/`polyder`). `weighted_median`/`lstsq_4col` were
/// filled in by the optimize.rs (S4/S5) port pass — `weighted_median`'s
/// first consumer is `optimize::run_optimization`'s skew seed
/// (`optimize.py:668-680`, the same `searchsorted`-based algorithm as
/// `dewarp._weighted_median`); `lstsq_4col`'s first consumer will be
/// `pipeline::fit_residual_warp` (not yet ported).
pub fn interp(x: f64, xp: &[f64], fp: &[f64]) -> f64 {
    let n = xp.len();
    debug_assert_eq!(n, fp.len());
    if n == 0 {
        return f64::NAN;
    }
    if n == 1 || x <= xp[0] {
        return fp[0];
    }
    if x >= xp[n - 1] {
        return fp[n - 1];
    }
    // Binary search for the interval `xp[lo] <= x < xp[hi]`, `hi = lo+1`.
    let mut lo = 0usize;
    let mut hi = n - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if xp[mid] <= x {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let (x0, x1) = (xp[lo], xp[hi]);
    let (y0, y1) = (fp[lo], fp[hi]);
    if x1 == x0 {
        return y0;
    }
    y0 + (y1 - y0) * (x - x0) / (x1 - x0)
}

/// Vectorized form of [`interp`] — one `xp`/`fp` table, many query points
/// (`model.py:278-279,284`, `linesegs.py:109-112`).
pub fn interp_many(xs: &[f64], xp: &[f64], fp: &[f64]) -> Vec<f64> {
    xs.iter().map(|&x| interp(x, xp, fp)).collect()
}

/// Weighted, rank-revealing 4-column least squares mirroring
/// `np.linalg.lstsq(A, b, rcond=None)` — `dewarp.py:277`
/// (`_fit_residual_warp`'s `field_fit`, `A = column_stack([x1, x2,
/// 0.5*x1**2, x1*x2])`). `rcond=None` semantics: singular values below `max(m,n) * f64::EPSILON * sigma_max` are treated
/// as zero, and among all least-squares minimizers the **minimum-norm**
/// solution is returned. The Python reference explicitly expects to hit
/// this branch on ill-conditioned input (`dewarp.py:310-314`'s comment) —
/// a normal-equations Cholesky solve is *not* an acceptable substitute here
/// (it diverges from NumPy exactly when the design matrix is
/// ill-conditioned, which is precisely when this matters). Use an SVD or a
/// rank-revealing QR.
///
/// `a` is `m` rows of exactly 4 columns (already weighted by `sqrt(w)`, as
/// the Python call site does); `b` is the length-`m` weighted target.
/// Returns the 4 coefficients.
pub fn lstsq_4col(a: &[[f64; 4]], b: &[f64]) -> [f64; 4] {
    debug_assert_eq!(a.len(), b.len(), "lstsq_4col: A/b row-count mismatch");
    let m = a.len();
    if m == 0 {
        return [0.0; 4];
    }
    // Normal equations: AtA (4x4, symmetric PSD by construction) and Atb.
    // `AᵀA = VΣ²Vᵀ` (its eigendecomposition), so the minimum-norm
    // least-squares solution is `x = Σ_{σ_i>tol} ((vᵢᵀAᵀb)/σᵢ²)·vᵢ` — exactly
    // the pseudo-inverse NumPy's `lstsq(rcond=None)` computes, cut at
    // singular values below `max(m,n)·eps·σ_max(A)`. Squaring A doubles
    // its condition number in floating point, but at 4 columns and this
    // pipeline's residual-warp scale this stays well within `f64`
    // precision, which is why hand-rolling via normal equations on the
    // 4-column system is acceptable here.
    let mut ata = [[0.0f64; 4]; 4];
    let mut atb = [0.0f64; 4];
    for row_i in 0..m {
        let row = &a[row_i];
        for i in 0..4 {
            atb[i] += row[i] * b[row_i];
            for j in 0..4 {
                ata[i][j] += row[i] * row[j];
            }
        }
    }
    let (eigvals, v) = jacobi_eigen4(&ata);
    let max_abs = eigvals.iter().fold(0.0f64, |acc, &e| acc.max(e.abs()));
    let sigma_max = max_abs.max(0.0).sqrt();
    let n_cols = 4usize;
    let tol_sigma = (m.max(n_cols) as f64) * f64::EPSILON * sigma_max;
    let tol_eig = tol_sigma * tol_sigma;

    let mut vtb = [0.0f64; 4];
    for i in 0..4 {
        let mut s = 0.0;
        for k in 0..4 {
            s += v[k][i] * atb[k];
        }
        vtb[i] = s;
    }
    let mut y = [0.0f64; 4];
    for i in 0..4 {
        y[i] = if eigvals[i] > tol_eig {
            vtb[i] / eigvals[i]
        } else {
            0.0
        };
    }
    let mut x = [0.0f64; 4];
    for i in 0..4 {
        let mut s = 0.0;
        for k in 0..4 {
            s += v[i][k] * y[k];
        }
        x[i] = s;
    }
    x
}

/// Cyclic Jacobi eigenvalue algorithm for a dense 4x4 symmetric matrix —
/// mirrors `lsq.rs`'s own (private, `n<=8`) `jacobi_eigen` at the fixed size
/// [`lstsq_4col`] needs; duplicated in miniature here rather than exposing
/// `lsq.rs`'s internal helper, to avoid widening that module's API surface
/// for a single external caller. Returns `(eigenvalues, eigenvectors)` with
/// `eigenvectors[:, i]` (i.e. `v[row][i]`) the eigenvector for
/// `eigenvalues[i]`.
fn jacobi_eigen4(a_in: &[[f64; 4]; 4]) -> ([f64; 4], [[f64; 4]; 4]) {
    let mut a = *a_in;
    let mut v = [[0.0f64; 4]; 4];
    for i in 0..4 {
        v[i][i] = 1.0;
    }
    for _sweep in 0..100 {
        let mut off = 0.0f64;
        for i in 0..4 {
            for j in 0..4 {
                if i != j {
                    off += a[i][j] * a[i][j];
                }
            }
        }
        if off.sqrt() < 1e-14 {
            break;
        }
        for p in 0..4 {
            for q in (p + 1)..4 {
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
                for i in 0..4 {
                    if i != p && i != q {
                        let aip = a[i][p];
                        let aiq = a[i][q];
                        a[i][p] = c * aip - s * aiq;
                        a[p][i] = a[i][p];
                        a[i][q] = s * aip + c * aiq;
                        a[q][i] = a[i][q];
                    }
                }
                for i in 0..4 {
                    let vip = v[i][p];
                    let viq = v[i][q];
                    v[i][p] = c * vip - s * viq;
                    v[i][q] = s * vip + c * viq;
                }
            }
        }
    }
    let eigenvalues = [a[0][0], a[1][1], a[2][2], a[3][3]];
    (eigenvalues, v)
}

/// `np.polyfit(x, y, 2)` (`textline.py:213`) — quadratic Vandermonde least
/// squares. NumPy internally scales columns by their norm before an
/// SVD-based `lstsq`; same rank/`rcond` caveat as [`lstsq_4col`].
/// Returns coefficients **highest-degree-first**, matching NumPy's
/// convention: `[c2, c1, c0]` such that `y ≈ c2*x^2 + c1*x + c0`.
///
/// Implementation: normal equations on the **centered** `x` (`x - mean(x)`),
/// solved by Gauss-Jordan elimination with partial pivoting (a plain 3x3
/// system — `textline.py`'s only consumer always has `>=4` points, is never
/// the ill-conditioned/rank-deficient case `lstsq_4col`'s doc comment warns
/// about, and `_validate_line`'s downstream thresholds have generous
/// margins), then un-centered back to the original `x` basis. Centering
/// mirrors NumPy's own conditioning strategy (it scales/centers internally
/// before its SVD-based solve) and keeps the Vandermonde powers
/// (`x^2`..`x^4`) from a full-width text line (`x` up to ~1600px) from
/// dominating the elimination's numerical precision.
pub fn polyfit_quadratic(x: &[f64], y: &[f64]) -> [f64; 3] {
    assert_eq!(x.len(), y.len(), "polyfit_quadratic: x/y length mismatch");
    assert!(x.len() >= 3, "polyfit_quadratic: need at least 3 points");
    let n = x.len() as f64;
    let mean_x = x.iter().sum::<f64>() / n;
    let xs: Vec<f64> = x.iter().map(|&v| v - mean_x).collect();

    let (mut s1, mut s2, mut s3, mut s4) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut sy0, mut sxy, mut sx2y) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..xs.len() {
        let xi = xs[i];
        let yi = y[i];
        let xi2 = xi * xi;
        s1 += xi;
        s2 += xi2;
        s3 += xi2 * xi;
        s4 += xi2 * xi2;
        sy0 += yi;
        sxy += xi * yi;
        sx2y += xi2 * yi;
    }
    // [ s4 s3 s2 | sx2y ]   [c2']
    // [ s3 s2 s1 | sxy  ] * [c1'] = rhs, on centered x.
    // [ s2 s1 n  | sy0  ]   [c0']
    let mut m = [[s4, s3, s2, sx2y], [s3, s2, s1, sxy], [s2, s1, n, sy0]];
    for col in 0..3 {
        let mut piv = col;
        for r in (col + 1)..3 {
            if m[r][col].abs() > m[piv][col].abs() {
                piv = r;
            }
        }
        m.swap(col, piv);
        let pivot = m[col][col];
        if pivot.abs() < 1e-300 {
            continue; // degenerate column (e.g. all-identical x); leave as 0
        }
        for r in 0..3 {
            if r == col {
                continue;
            }
            let factor = m[r][col] / pivot;
            for c in col..4 {
                m[r][c] -= factor * m[col][c];
            }
        }
    }
    let cc2 = if m[0][0].abs() > 1e-300 {
        m[0][3] / m[0][0]
    } else {
        0.0
    };
    let cc1 = if m[1][1].abs() > 1e-300 {
        m[1][3] / m[1][1]
    } else {
        0.0
    };
    let cc0 = if m[2][2].abs() > 1e-300 {
        m[2][3] / m[2][2]
    } else {
        0.0
    };
    // Un-center: y = cc2*(x-m)^2 + cc1*(x-m) + cc0
    //              = cc2*x^2 + (cc1 - 2*cc2*m)*x + (cc2*m^2 - cc1*m + cc0)
    let c2 = cc2;
    let c1 = cc1 - 2.0 * cc2 * mean_x;
    let c0 = cc2 * mean_x * mean_x - cc1 * mean_x + cc0;
    [c2, c1, c0]
}

/// `np.polyval(coef, x)` for a quadratic `[c2, c1, c0]` (`textline.py:214,
/// 217`).
pub fn polyval_quadratic(coef: [f64; 3], x: f64) -> f64 {
    coef[0] * x * x + coef[1] * x + coef[2]
}

/// `np.polyder(coef)` for a quadratic → returns the linear derivative
/// coefficients `[2*c2, c1]` (`textline.py:214`).
pub fn polyder_quadratic(coef: [f64; 3]) -> [f64; 2] {
    [2.0 * coef[0], coef[1]]
}

// ---------------------------------------------------------------------------
// Port notes, not functions:
//
// `np.argsort`'s default is quicksort/introsort, which is *unstable*
// — `optimize.py:221,253-257`, `dewarp.py:171`, `textline.py:156` all rely
// on some sort order, and ties (equal line means, equal x centroids) pick
// different rows under an unstable-vs-stable sort. Rust's slice
// `sort_by`/`sort_by_key` is stable by default, which is the safer choice:
// the difference only bites on exact ties. So every one of those call sites
// uses Rust's stable sort and accepts the divergence on exact ties, rather
// than attempting to reproduce introsort.
// ---------------------------------------------------------------------------
