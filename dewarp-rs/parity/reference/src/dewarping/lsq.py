"""NumPy-only bounded nonlinear least-squares solver used by this package.

This provides the same role as
``scipy.optimize.least_squares(method='trf', x_scale='jac')`` without an
external dependency; it became the sole solver when the SciPy dependency was
removed. The problem in this project is a small dense problem with eight
variables, hundreds to thousands of residuals, an analytical Jacobian, and box
bounds (surface coefficients ±5, an FOV range for ``f``, and ``rvec`` ±1).
The following design approximates TRF behavior using only NumPy:

- Levenberg-Marquardt (8×8 normal equations; damping uses the diagonal scale
  matrix D²)
- column scaling equivalent to ``x_scale='jac'`` (the historical maximum of
  each column norm of J)
- bounds enforced by freezing the active set (excluding variables on a bound
  whose gradients point outward) and clipping steps to the bounds, similarly
  to SciPy's ``dogbox`` method

The number of evaluations per iteration (one residual and one Jacobian for an
accepted step; one residual for a rejected step) matches TRF, as does runtime.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class LsqResult:
    x: np.ndarray
    cost: float
    nfev: int


def least_squares_np(
    fun,
    x0: np.ndarray,
    jac,
    bounds: tuple[np.ndarray, np.ndarray] | None = None,
    max_nfev: int = 600,
    ftol: float = 1e-8,
    xtol: float = 1e-8,
    gtol: float = 1e-8,
) -> LsqResult:
    x = np.asarray(x0, dtype=np.float64).copy()
    n = len(x)
    if bounds is None:
        lo = np.full(n, -np.inf)
        hi = np.full(n, np.inf)
    else:
        lo = np.asarray(bounds[0], dtype=np.float64)
        hi = np.asarray(bounds[1], dtype=np.float64)
    x = np.clip(x, lo, hi)

    r = np.asarray(fun(x), dtype=np.float64)
    nfev = 1
    if r.size == 0:
        return LsqResult(x=x, cost=0.0, nfev=nfev)
    J = np.asarray(jac(x), dtype=np.float64)
    cost = 0.5 * float(r @ r)

    # x_scale='jac': use the historical maximum column norm (SciPy's update rule).
    scale_inv = np.linalg.norm(J, axis=0)
    scale_inv[scale_inv == 0.0] = 1.0

    lam = 1e-3
    eps_b = 1e-10  # Tolerance for detecting active bounds
    small_drops = 0  # Consecutive small improvements equivalent to ftol
    # Trust-region radius (scaled norm). As in SciPy TRF, initialize it to
    # ||x0 * scale||, or 1 if that is zero. Without this, a large initial step
    # jumps to a corner of the bounds and stalls there (observed on CBDAR_2).
    delta = float(np.linalg.norm(x * scale_inv)) or 1.0
    # Compare only finite bounds; infinite bounds would produce NaNs here.
    lo_thr = np.where(np.isfinite(lo), lo + eps_b * np.maximum(1.0, np.abs(lo)), -np.inf)
    hi_thr = np.where(np.isfinite(hi), hi - eps_b * np.maximum(1.0, np.abs(hi)), np.inf)

    while nfev < max_nfev:
        g = J.T @ r
        # Active set: freeze variables on a bound whose gradient points outward.
        at_lo = x <= lo_thr
        at_hi = x >= hi_thr
        frozen = (at_lo & (g > 0)) | (at_hi & (g < 0))
        free = ~frozen
        # Convergence test on the scaled projected gradient.
        pg = np.where(frozen, 0.0, g)
        if np.max(np.abs(pg) / scale_inv) < gtol:
            break
        if not free.any():
            break

        Jf = J[:, free]
        gf = g[free]
        df = scale_inv[free]
        JtJ = Jf.T @ Jf

        accepted = False
        while nfev < max_nfev:
            A = JtJ + lam * np.diag(df**2)
            try:
                p_free = np.linalg.solve(A, -gf)
            except np.linalg.LinAlgError:
                p_free = np.linalg.lstsq(A, -gf, rcond=None)[0]
            p = np.zeros(n)
            p[free] = p_free
            # Trust region: limit the scaled step length to delta.
            s_norm = float(np.linalg.norm(p * scale_inv))
            if s_norm > delta:
                p *= delta / s_norm
            # Projection: move only coordinates crossing a bound onto that bound.
            # Do not shrink the full step: doing so prevents other variables from
            # moving once one reaches a bound, causing premature stalling in this
            # problem where coefficients commonly remain on bounds.
            x_new = np.clip(x + p, lo, hi)
            step = x_new - x
            step_norm = float(np.linalg.norm(step))
            if step_norm < 1e-15:
                lam *= 4.0
                if lam > 1e12:
                    return LsqResult(x=x, cost=cost, nfev=nfev)
                continue
            r_new = np.asarray(fun(x_new), dtype=np.float64)
            nfev += 1
            cost_new = 0.5 * float(r_new @ r_new)
            if cost_new < cost:
                # Adjust damping using the gain ratio (actual/predicted reduction).
                pred = -(g @ step) - 0.5 * float(step @ (J.T @ (J @ step)))
                rho = (cost - cost_new) / max(pred, 1e-300)
                rel_drop = (cost - cost_new) / max(cost, 1e-300)
                x, r, cost = x_new, r_new, cost_new
                if rho > 0.75:
                    lam = max(lam / 3.0, 1e-12)
                    delta = max(delta, 2.0 * s_norm)
                elif rho < 0.25:
                    lam = min(lam * 2.0, 1e12)
                    delta = 0.5 * delta
                accepted = True
                # Test convergence only on accepted steps. Require two consecutive
                # small improvements to avoid stopping early at a local solution.
                small_drops = small_drops + 1 if rel_drop < ftol else 0
                if small_drops >= 2 or step_norm < xtol * max(
                    1.0, float(np.linalg.norm(x))
                ):
                    return LsqResult(x=x, cost=cost, nfev=nfev)
                break
            lam *= 4.0
            delta *= 0.25
            if lam > 1e12:
                return LsqResult(x=x, cost=cost, nfev=nfev)
        if not accepted:
            break
        J = np.asarray(jac(x), dtype=np.float64)
        scale_inv = np.maximum(scale_inv, np.linalg.norm(J, axis=0))

    return LsqResult(x=x, cost=cost, nfev=nfev)
