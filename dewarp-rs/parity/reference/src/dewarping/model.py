"""Generalized cylindrical surface (GCS) geometry model.

Coordinate conventions:
- image point ``(α, β)``, principal point ``(c_x, c_y)``,
  ``p̄ = (α-c_x, β-c_y, f)``
- world point ``W = k p̄ = R S + O_f``, ``O_f = (0,0,f)``, surface point
  ``S = [x, y, g(x)]``
- when ``R = I`` and ``g ≡ 0``, this reduces to the identity mapping
  ``k=1, x=α-c_x, y=β-c_y``

For numerical stability, the polynomial ``g`` is stored in normalized
coordinates:
``g(x) = s · h(x/s)``, ``h(t) = Σ_{m=1}^{M} a_m t^m``, with ``a_0 = 0`` fixed
The optimization variables are the normalized coefficients ``a_1..a_M``;
``s`` is the representative image scale ``max(w,h)``.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

M_POLY = 4  # Polynomial degree


@dataclass
class DewarpParams:
    a: np.ndarray  # (M_POLY,) normalized polynomial coefficients a_1..a_4
    rvec: np.ndarray  # (3,) exponential representation of rotation (Rodrigues)
    f: float  # Focal length in pixels
    cx: float
    cy: float
    scale: float  # Polynomial normalization scale s

    @property
    def R(self) -> np.ndarray:
        return cv2.Rodrigues(self.rvec)[0]

    def g(self, x: np.ndarray) -> np.ndarray:
        """Evaluate ``g(x) = s·h(x/s)`` using Horner's method."""
        t = np.asarray(x) / self.scale
        h = np.zeros_like(t)
        for m in range(M_POLY, 0, -1):
            h = (h + self.a[m - 1]) * t
        return self.scale * h

    def g_prime(self, x: np.ndarray) -> np.ndarray:
        """Evaluate ``g'(x) = h'(x/s)`` using Horner's method."""
        t = np.asarray(x) / self.scale
        hp = np.zeros_like(t)
        for m in range(M_POLY, 1, -1):
            hp = (hp + m * self.a[m - 1]) * t
        return hp + self.a[0]


def backproject(
    pts: np.ndarray, params: DewarpParams, k_init: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Back-project ``(N,2)`` image points into surface coordinates.

    Solve ``g(S_x(k)) = S_z(k)`` for ``k`` with Newton-Raphson. Return
    ``(S_x, S_y, k)``.
    """
    pts = np.asarray(pts, dtype=np.float64)
    f = params.f
    RT = params.R.T
    pbar = np.column_stack(
        [pts[:, 0] - params.cx, pts[:, 1] - params.cy, np.full(len(pts), f)]
    )
    b1 = pbar @ RT[0]
    b2 = pbar @ RT[1]
    b3 = pbar @ RT[2]
    c1 = f * RT[0, 2]
    c2 = f * RT[1, 2]
    c3 = f * RT[2, 2]

    k = np.ones(len(pts)) if k_init is None else k_init.copy()
    for _ in range(30):
        Sx = k * b1 - c1
        Sz = k * b3 - c3
        phi = params.g(Sx) - Sz
        dphi = params.g_prime(Sx) * b1 - b3
        # Avoid divergence near singularities where the ray is tangent to the surface.
        dphi = np.where(np.abs(dphi) < 1e-12, np.sign(dphi) * 1e-12 + (dphi == 0) * 1e-12, dphi)
        step = phi / dphi
        k = k - step
        if np.max(np.abs(step)) < 1e-10:
            break
    Sx = k * b1 - c1
    Sy = k * b2 - c2
    return Sx, Sy, k


def flatten_u(x: np.ndarray, params: DewarpParams) -> np.ndarray:
    """Approximate ``u = ∫_0^x √(1+g'(t)²) dt`` with Simpson's rule."""
    x = np.asarray(x, dtype=np.float64)
    gp0 = params.g_prime(np.zeros_like(x))
    gph = params.g_prime(x / 2.0)
    gpx = params.g_prime(x)
    return (
        x
        / 6.0
        * (np.sqrt(1 + gp0**2) + 4.0 * np.sqrt(1 + gph**2) + np.sqrt(1 + gpx**2))
    )


# ---------------------------------------------------------------------------
# Analytical Jacobian using implicit differentiation. Parameter order matches
# optimize.pack_theta:
# (a_1..a_4, r_1..r_3, log f), eight parameters total.
# ---------------------------------------------------------------------------

N_THETA = M_POLY + 4


def _g_second(params: DewarpParams, x: np.ndarray) -> np.ndarray:
    """Evaluate ``g''(x) = h''(x/s)/s``, where ``h''(t) = Σ m(m-1) a_m t^(m-2)``."""
    t = np.asarray(x) / params.scale
    hpp = np.zeros_like(t)
    for m in range(M_POLY, 2, -1):
        hpp = (hpp + m * (m - 1) * params.a[m - 1]) * t
    hpp = hpp + 2.0 * params.a[1]
    return hpp / params.scale


def backproject_with_grad(
    pts: np.ndarray, params: DewarpParams, k_init: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Compute back-projection and derivatives with respect to all parameters.

    Use implicit differentiation of ``g(S_x(k,θ)) = S_z(k,θ)``:
    ``∂k/∂θ = -(∂φ/∂θ)/(∂φ/∂k)``. Return
    ``(Sx, Sy, k, dSx, dSy)``. ``dSx`` and ``dSy``
    have shape ``(N, 8)`` with columns ``(a_1..a_4, r_1..r_3, log f)``.
    """
    pts = np.asarray(pts, dtype=np.float64)
    n = len(pts)
    f = params.f
    R, dR_flat = cv2.Rodrigues(params.rvec)
    # OpenCV's Jacobian is (3,9): dR_flat[j] = ∂vec(R)/∂r_j (row-major).
    dR = dR_flat.reshape(3, 3, 3)  # dR[j, p, q] = ∂R[p,q]/∂r_j

    pbar = np.column_stack([pts[:, 0] - params.cx, pts[:, 1] - params.cy, np.full(n, f)])
    b = pbar @ R  # (N,3): b[:,i] = p̄·R[:,i]
    c = f * R[2, :]  # (3,): c_i = f R[2,i]

    # Newton-Raphson, as in backproject.
    k = np.ones(n) if k_init is None else k_init.copy()
    for _ in range(30):
        Sx = k * b[:, 0] - c[0]
        Sz = k * b[:, 2] - c[2]
        phi = params.g(Sx) - Sz
        dphi = params.g_prime(Sx) * b[:, 0] - b[:, 2]
        dphi = np.where(np.abs(dphi) < 1e-12, 1e-12, dphi)
        step = phi / dphi
        k = k - step
        if np.max(np.abs(step)) < 1e-10:
            break
    Sx = k * b[:, 0] - c[0]
    Sy = k * b[:, 1] - c[1]
    gp = params.g_prime(Sx)
    dphi_dk = gp * b[:, 0] - b[:, 2]
    dphi_dk = np.where(np.abs(dphi_dk) < 1e-12, 1e-12, dphi_dk)

    dSx = np.zeros((n, N_THETA))
    dSy = np.zeros((n, N_THETA))
    t_norm = Sx / params.scale

    # --- a_m: ∂φ/∂a_m|_k = ∂g/∂a_m = s·t^m ---
    for m in range(1, M_POLY + 1):
        dphi_dam = params.scale * t_norm**m
        dk = -dphi_dam / dphi_dk
        dSx[:, m - 1] = b[:, 0] * dk
        dSy[:, m - 1] = b[:, 1] * dk

    # --- r_j: explicit dependence of b and c, plus implicit k ---
    for j in range(3):
        db = pbar @ dR[j]  # (N,3): db[:,i] = p̄·∂R[:,i]/∂r_j
        dc = f * dR[j][2, :]  # (3,)
        dSx_k = k * db[:, 0] - dc[0]
        dSy_k = k * db[:, 1] - dc[1]
        dSz_k = k * db[:, 2] - dc[2]
        dphi = gp * dSx_k - dSz_k
        dk = -dphi / dphi_dk
        dSx[:, M_POLY + j] = dSx_k + b[:, 0] * dk
        dSy[:, M_POLY + j] = dSy_k + b[:, 1] * dk

    # --- log f: both the z component of p̄ and c depend on f ---
    # ∂b_i/∂f = R[2,i], ∂c_i/∂f = R[2,i] → ∂S_i/∂f|_k = (k-1) R[2,i]
    dSx_k = (k - 1.0) * R[2, 0]
    dSy_k = (k - 1.0) * R[2, 1]
    dSz_k = (k - 1.0) * R[2, 2]
    dphi = gp * dSx_k - dSz_k
    dk = -dphi / dphi_dk
    dSx[:, M_POLY + 3] = (dSx_k + b[:, 0] * dk) * f  # log-f parameterization: ×f
    dSy[:, M_POLY + 3] = (dSy_k + b[:, 1] * dk) * f

    return Sx, Sy, k, dSx, dSy


def flatten_u_with_grad(
    x: np.ndarray, dx: np.ndarray, params: DewarpParams
) -> tuple[np.ndarray, np.ndarray]:
    """Compute Simpson's approximation of ``u`` and all derivatives.

    ``du/dθ = ∂u/∂x · dx/dθ + ∂u/∂a_m``, where only the ``a_m`` columns have
    explicit dependence. ``x: (N,), dx: (N,8) → (u, du)``, with ``du`` having
    shape ``(N,8)``.
    """
    x = np.asarray(x, dtype=np.float64)

    def A_and_grads(y: np.ndarray):
        gp = params.g_prime(y)
        gpp = _g_second(params, y)
        A = np.sqrt(1.0 + gp**2)
        dA_dy = gp * gpp / A
        ty = y / params.scale
        # ∂A/∂a_m = g'(y)·m·t^(m-1)/A
        dA_da = np.stack(
            [gp * m * ty ** (m - 1) / A for m in range(1, M_POLY + 1)], axis=-1
        )
        return A, dA_dy, dA_da

    A0, _, dA0_da = A_and_grads(np.zeros_like(x))
    Ah, dAh_dy, dAh_da = A_and_grads(x / 2.0)
    Ax, dAx_dy, dAx_da = A_and_grads(x)

    S = A0 + 4.0 * Ah + Ax
    u = x / 6.0 * S
    du_dx = S / 6.0 + x / 6.0 * (4.0 * dAh_dy * 0.5 + dAx_dy)
    du_da = (x / 6.0)[:, None] * (dA0_da + 4.0 * dAh_da + dAx_da)

    du = du_dx[:, None] * dx
    du[:, 0:M_POLY] += du_da
    return u, du


def surface_to_rectified(
    pts: np.ndarray, params: DewarpParams, k_init: np.ndarray | None = None
) -> np.ndarray:
    """Map ``(N,2)`` image points to ``(N,2)`` rectified-domain points ``(u,v)``."""
    Sx, Sy, _ = backproject(pts, params, k_init)
    u = flatten_u(Sx, params)
    return np.column_stack([u, Sy])


def rectified_to_image(
    uv: np.ndarray,
    params: DewarpParams,
    x_clamp: tuple[float, float] | None = None,
) -> np.ndarray:
    """Map rectified points ``(u,v)`` to input-image points ``(α,β)``.

    This closed form is used for the inverse map passed to ``cv2.remap``.
    Obtain ``u → x`` by 1D interpolation of the inverse of the monotonically
    increasing arc-length function ``A(x)``.

    When ``x_clamp`` is specified, continue the surface linearly along its
    tangent outside that range. The polynomial is unreliable beyond the region
    containing features, where oscillating extrapolation can distort rendering;
    this safeguard applies only during rendering.
    """
    uv = np.asarray(uv, dtype=np.float64)
    u, v = uv[:, 0], uv[:, 1]
    span = max(1.0, np.max(np.abs(u)) * 1.5 + params.scale)
    xs = np.linspace(-span, span, 4001)
    if x_clamp is not None:
        xc = np.clip(xs, x_clamp[0], x_clamp[1])
        g_xs = params.g(xc) + params.g_prime(xc) * (xs - xc)
        gp_xs = params.g_prime(xc)
        # Numerically integrate arc length with a cumulative trapezoidal rule.
        seg = np.sqrt(1.0 + gp_xs**2)
        us = np.concatenate(
            [[0.0], np.cumsum(0.5 * (seg[1:] + seg[:-1]) * np.diff(xs))]
        )
        us -= np.interp(0.0, xs, us)  # Normalize so A(0) = 0
        x = np.interp(u, us, xs)
        xc_pt = np.clip(x, x_clamp[0], x_clamp[1])
        g_pt = params.g(xc_pt) + params.g_prime(xc_pt) * (x - xc_pt)
    else:
        us = flatten_u(xs, params)  # Monotonically increasing because √(1+g'²) > 0
        x = np.interp(u, us, xs)
        g_pt = params.g(x)
    S = np.column_stack([x, v, g_pt])
    W = S @ params.R.T + np.array([0.0, 0.0, params.f])
    alpha = params.f * W[:, 0] / W[:, 2] + params.cx
    beta = params.f * W[:, 1] / W[:, 2] + params.cy
    return np.column_stack([alpha, beta])
