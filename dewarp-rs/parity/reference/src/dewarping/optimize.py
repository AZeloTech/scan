"""Cost function and optimization with iterative outlier removal.

Implementation notes:
- Auxiliary variables such as ``l^k`` (line height) and ``l_left`` are
  analytically eliminated during residual evaluation using variable projection.
  For fixed Θ, their least-squares optimum is available in closed form as the
  mean. The only eight optimization variables are
  ``Θ = (a_1..a_4, θ_1..θ_3, f)``.
- ``E_spacing`` is expressed as second differences of the eliminated mean line
  heights ``ȳ^k``.
- LM optimization uses the locally implemented bounded, NumPy-only solver in
  ``lsq.py`` with a sum-of-squared-residuals formulation.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .lsq import least_squares_np
from .linesegs import LineSegments, PageBoundary
from .model import (
    DewarpParams,
    M_POLY,
    N_THETA,
    backproject,
    backproject_with_grad,
    flatten_u,
    flatten_u_with_grad,
    surface_to_rectified,
)
from .options import QualityOptions
from .textline import TextFeatures


def _lsq(fun, x0, jac, bounds=None, max_nfev=600):
    """Common solver wrapper; the return value has an ``.x`` attribute."""
    return least_squares_np(fun, x0, jac, bounds=bounds, max_nfev=max_nfev)

LAMBDA1_REGULAR = 100.0  # Weight of f_regular
TAU_SEG_INIT = 0.01  # Initial segment-outlier threshold, halved each iteration
N_OUTLIER_ITER = 3  # Outlier-removal iterations; usually stable in 1-3


@dataclass
class ProblemData:
    """Inlier-only features used for optimization."""

    line_points: list[np.ndarray]  # CC centers for each text line (N_k, 2)
    block_of_line: list[int]  # Block index containing each line
    alignments: list[str]  # 'none'|'left'|'right'|'justified' for each block
    segments: np.ndarray  # (N_s, 4) line segments
    img_w: int
    img_h: int
    mean_text_size: float
    use_line_term: bool

    def n_text_points(self) -> int:
        return sum(len(p) for p in self.line_points)


def pack_theta(params: DewarpParams) -> np.ndarray:
    return np.concatenate([params.a, params.rvec, [np.log(params.f)]])


def unpack_theta(theta: np.ndarray, template: DewarpParams) -> DewarpParams:
    return DewarpParams(
        a=theta[0:M_POLY].copy(),
        rvec=theta[M_POLY : M_POLY + 3].copy(),
        f=float(np.exp(theta[M_POLY + 3])),
        cx=template.cx,
        cy=template.cy,
        scale=template.scale,
    )


class CostFunction:
    def __init__(
        self,
        data: ProblemData,
        template: DewarpParams,
        anchor_pts: np.ndarray | None = None,
        v_scale_ref: float | None = None,
    ):
        """Initialize the cost function and optional scale anchor.

        ``anchor_pts`` is a fixed feature set containing all text points and all
        segment midpoints, independent of outlier removal. ``v_scale_ref`` is
        its Y standard deviation in the coarse solution. When both are given,
        an anchor residual is added. ``E_str``, ``E_spacing``, and segment
        alignment all decrease for a solution that vertically collapses the
        document, so the anchor blocks this degenerate direction.
        """
        self.data = data
        self.template = template
        self.anchor_pts = anchor_pts
        self.v_scale_ref = v_scale_ref
        self._k_cache_anchor: np.ndarray | None = None
        # Lines eligible for E_align. Exclude lines below 80% of the mean width,
        # because short lines such as final paragraph lines do not align at both
        # ends. Precompute from image-coordinate widths to keep the
        # residual-vector length independent of the parameters.
        widths = np.array(
            [pts[:, 0].max() - pts[:, 0].min() for pts in data.line_points]
        ) if data.line_points else np.empty(0)
        self.align_eligible = np.zeros(len(widths), dtype=bool)
        for bi in set(data.block_of_line):
            idx = [i for i, b in enumerate(data.block_of_line) if b == bi]
            wmean = widths[idx].mean()
            for i in idx:
                self.align_eligible[i] = widths[i] >= 0.8 * wmean
        # Point sequence for back-projecting segment p, q, and r together.
        if len(data.segments):
            p = data.segments[:, 0:2]
            q = data.segments[:, 2:4]
            r = 0.5 * (p + q)
            self.seg_pts = np.vstack([p, q, r])
        else:
            self.seg_pts = np.empty((0, 2))
        # Term weights: λ2, λ3 ∝ N_text/N_line.
        n_text = max(1, data.n_text_points())
        n_line = max(1, len(data.segments))
        self.lambda2 = n_text / n_line
        # f_align is dimensionless (≤1), so scale it to text residuals in pixels.
        self.lambda3 = (n_text / n_line) * data.mean_text_size**2
        # Caches used to warm-start Newton-Raphson.
        self._k_cache_text: list[np.ndarray | None] = [None] * len(data.line_points)
        self._k_cache_seg: np.ndarray | None = None

    def reset_cache(self) -> None:
        """Discard the back-projection Newton warm-start caches.

        The caches are a useful acceleration within one optimization trajectory,
        but carrying them between multi-start candidates or independent scoring
        evaluations creates hidden state coupling: residuals then depend on the
        previous candidate. In high-curvature regions, back-projection can be
        multivalued, and the warm-start value can change which branch converges.
        Call this before every independent optimization or evaluation.
        """
        self._k_cache_anchor = None
        self._k_cache_text = [None] * len(self.data.line_points)
        self._k_cache_seg = None

    def residuals(self, theta: np.ndarray) -> np.ndarray:
        return self._assemble(theta, want_jac=False)[0]

    def jacobian(self, theta: np.ndarray) -> np.ndarray:
        """Return the analytical Jacobian for all terms.

        Piecewise structures such as min, max, median, and outlier masks are
        linearized on the branch active at the current θ. Numerical
        differentiation has the same nonsmoothness.
        """
        return self._assemble(theta, want_jac=True)[1]

    def _assemble(
        self, theta: np.ndarray, want_jac: bool
    ) -> tuple[np.ndarray, np.ndarray | None]:
        """Assemble residuals and, when requested, the Jacobian in one code path.

        Sharing this function structurally prevents the row-order mismatches
        that separate residual and Jacobian implementations can introduce.
        """
        params = unpack_theta(theta, self.template)
        data = self.data
        res: list[np.ndarray] = []
        jac: list[np.ndarray] = []

        def add(r: np.ndarray, J: np.ndarray | None = None) -> None:
            r = np.atleast_1d(np.asarray(r, dtype=np.float64))
            res.append(r)
            if want_jac:
                jac.append(np.asarray(J, dtype=np.float64).reshape(len(r), N_THETA))

        # --- f_text: straightness E_str plus line spacing/block alignment ---
        line_means: dict[int, list[float]] = {}
        line_dmeans: dict[int, list[np.ndarray]] = {}
        align_edges: dict[int, list[float]] = {}
        align_dedges: dict[int, list[np.ndarray]] = {}
        for li, pts in enumerate(data.line_points):
            if want_jac:
                Sx, Sy, k, dSx, dSy = backproject_with_grad(
                    pts, params, self._k_cache_text[li]
                )
            else:
                Sx, Sy, k = backproject(pts, params, self._k_cache_text[li])
                dSx = dSy = None
            self._k_cache_text[li] = k
            mean_y = Sy.mean()
            dmean = dSy.mean(axis=0) if want_jac else None
            # E_str: centered residual after eliminating l^k as the mean.
            add(Sy - mean_y, (dSy - dmean) if want_jac else None)
            bi = data.block_of_line[li]
            line_means.setdefault(bi, []).append(float(mean_y))
            if want_jac:
                line_dmeans.setdefault(bi, []).append(dmean)
            # Endpoint u coordinates for block alignment; exclude short lines.
            if self.align_eligible[li]:
                align = data.alignments[bi]
                if align in ("left", "right", "justified"):
                    if want_jac:
                        u, du = flatten_u_with_grad(Sx, dSx, params)
                    else:
                        u = flatten_u(Sx, params)
                        du = None
                    if align in ("left", "justified"):
                        i0 = int(np.argmin(u))
                        align_edges.setdefault(bi, []).append(float(u[i0]))
                        if want_jac:
                            align_dedges.setdefault(bi, []).append(du[i0])
                    if align in ("right", "justified"):
                        i1 = int(np.argmax(u))
                        align_edges.setdefault(-bi - 1, []).append(float(u[i1]))
                        if want_jac:
                            align_dedges.setdefault(-bi - 1, []).append(du[i1])

        # E_spacing: second differences of mean line heights. Zero-fill positions
        # whose spacing differs greatly from the median, such as paragraph boundaries.
        for bi, means in line_means.items():
            if data.alignments[bi] != "__coarse__" and len(means) >= 3:
                m_arr = np.array(means)
                order = np.argsort(m_arr)
                m = m_arr[order]
                dgap = np.diff(m)
                med = float(np.median(dgap))
                if med <= 0:
                    continue
                ok = (dgap > 0.6 * med) & (dgap < 1.6 * med)
                pair_ok = ok[:-1] & ok[1:]
                second = m[:-2] - 2 * m[1:-1] + m[2:]
                r = np.where(pair_ok, second, 0.0)
                if want_jac:
                    dm = np.array(line_dmeans[bi])[order]  # (K, 8)
                    dsecond = dm[:-2] - 2 * dm[1:-1] + dm[2:]
                    add(r, np.where(pair_ok[:, None], dsecond, 0.0))
                else:
                    add(r)

        # E_align: median centering, exclusion of endpoint outliers, and a
        # conservative weight.
        w_align = 0.3
        tol_align = 2.0 * data.mean_text_size
        for key, edges in align_edges.items():
            if len(edges) >= 2:
                e = np.array(edges)
                r = e - np.median(e)
                mask = np.abs(r) < tol_align
                r = np.where(mask, r, 0.0)
                if want_jac:
                    de = np.array(align_dedges[key])  # (K, 8)
                    order = np.argsort(e)
                    K = len(e)
                    if K % 2 == 1:
                        dmed = de[order[K // 2]]
                    else:
                        dmed = 0.5 * (de[order[K // 2 - 1]] + de[order[K // 2]])
                    add(
                        np.sqrt(w_align) * r,
                        np.sqrt(w_align) * np.where(mask[:, None], de - dmed, 0.0),
                    )
                else:
                    add(np.sqrt(w_align) * r)

        # --- f_line ---
        if data.use_line_term and len(data.segments):
            if want_jac:
                Sx_s, Sy_s, k, dSx_s, dSy_s = backproject_with_grad(
                    self.seg_pts, params, self._k_cache_seg
                )
                u_s, du_s = flatten_u_with_grad(Sx_s, dSx_s, params)
                dv_s = dSy_s
            else:
                Sx_s, Sy_s, k = backproject(self.seg_pts, params, self._k_cache_seg)
                u_s = flatten_u(Sx_s, params)
                du_s = dv_s = None
            self._k_cache_seg = k
            v_s = Sy_s
            n = len(data.segments)
            pu, pv = u_s[:n], v_s[:n]
            qu, qv = u_s[n : 2 * n], v_s[n : 2 * n]
            ru, rv = u_s[2 * n :], v_s[2 * n :]
            dx = qu - pu
            dy = qv - pv
            L = np.maximum(np.hypot(dx, dy), 1e-9)
            cross = dx * (rv - pv) - dy * (ru - pu)
            dist = cross / L
            # Robustify f_str: back-projection diverges for segments outside the
            # document, making d_i orders of magnitude larger and dominating the
            # total cost. This drives optimization to distort the geometry just to
            # reduce those terms. Clip them to bound their influence and use zero
            # gradient in the clipped region.
            c_str = 10.0 * data.mean_text_size
            in_clip = np.abs(dist) < c_str
            dist = np.clip(dist, -c_str, c_str)
            ax, ay = np.abs(dx), np.abs(dy)
            use_x = ax <= ay
            align_r = np.where(use_x, ax, ay) / L
            if want_jac:
                dpu, dpv = du_s[:n], dv_s[:n]
                dqu, dqv = du_s[n : 2 * n], dv_s[n : 2 * n]
                dru, drv = du_s[2 * n :], dv_s[2 * n :]
                ddx = dqu - dpu
                ddy = dqv - dpv
                dL = (dx[:, None] * ddx + dy[:, None] * ddy) / L[:, None]
                dcross = (
                    ddx * (rv - pv)[:, None]
                    + dx[:, None] * (drv - dpv)
                    - ddy * (ru - pu)[:, None]
                    - dy[:, None] * (dru - dpu)
                )
                ddist = dcross / L[:, None] - (cross / L**2)[:, None] * dL
                ddist = np.where(in_clip[:, None], ddist, 0.0)
                # f_str
                add(np.sqrt(self.lambda2) * dist, np.sqrt(self.lambda2) * ddist)
                # f_align: fix the min branch and sign at the current value.
                dnum = np.where(
                    use_x[:, None],
                    np.sign(dx)[:, None] * ddx,
                    np.sign(dy)[:, None] * ddy,
                )
                dalign = dnum / L[:, None] - (align_r / L)[:, None] * dL
                add(np.sqrt(self.lambda3) * align_r, np.sqrt(self.lambda3) * dalign)
            else:
                add(np.sqrt(self.lambda2) * dist)
                add(np.sqrt(self.lambda3) * align_r)

        # --- f_regular ---
        a_img = float(max(data.img_w, data.img_h))
        ratio = max(a_img, params.f) / min(a_img, params.f)
        r_reg = np.sqrt(LAMBDA1_REGULAR) * (ratio - 1.0)
        if want_jac:
            J = np.zeros(N_THETA)
            # Return subgradient zero at the nonsmooth minimum f ≈ a_img.
            if params.f > a_img * (1.0 + 1e-9):
                J[M_POLY + 3] = np.sqrt(LAMBDA1_REGULAR) * ratio
            elif params.f < a_img * (1.0 - 1e-9):
                J[M_POLY + 3] = -np.sqrt(LAMBDA1_REGULAR) * ratio
            add(r_reg, J)
        else:
            add(r_reg)

        # --- Scale anchor ---
        if self.v_scale_ref is not None and self.anchor_pts is not None:
            if want_jac:
                _, Sy_a, k_a, _, dSy_a = backproject_with_grad(
                    self.anchor_pts, params, self._k_cache_anchor
                )
            else:
                _, Sy_a, k_a = backproject(self.anchor_pts, params, self._k_cache_anchor)
                dSy_a = None
            self._k_cache_anchor = k_a
            sigma_v = float(np.std(Sy_a))
            w_anchor = np.sqrt(len(self.anchor_pts)) * self.data.mean_text_size
            r_anchor = w_anchor * (sigma_v / self.v_scale_ref - 1.0)
            if want_jac:
                centered = Sy_a - Sy_a.mean()
                dsigma = (centered[:, None] * dSy_a).mean(axis=0) / max(sigma_v, 1e-9)
                add(r_anchor, (w_anchor / self.v_scale_ref) * dsigma)
            else:
                add(r_anchor)

        r_full = np.concatenate(res)
        return (r_full, np.vstack(jac)) if want_jac else (r_full, None)

    def segment_align_values(self, theta: np.ndarray) -> np.ndarray:
        """Return each segment's f_align value for outlier tests."""
        if not len(self.data.segments):
            return np.empty(0)
        params = unpack_theta(theta, self.template)
        uv = surface_to_rectified(self.seg_pts, params)
        n = len(self.data.segments)
        d = uv[n : 2 * n] - uv[:n]
        len2 = np.maximum(d[:, 0] ** 2 + d[:, 1] ** 2, 1e-18)
        return np.minimum(d[:, 0] ** 2, d[:, 1] ** 2) / len2

    def textline_straightness(self, theta: np.ndarray) -> np.ndarray:
        """Return each text line's RMS straightness residual for outlier tests."""
        params = unpack_theta(theta, self.template)
        vals = []
        for pts in self.data.line_points:
            _, Sy, _ = backproject(pts, params)
            vals.append(float(np.sqrt(np.mean((Sy - Sy.mean()) ** 2))))
        return np.array(vals)


class BoundaryCostFunction(CostFunction):
    """Append page-side straightness residuals to the established GCS cost.

    The ordinary optimization determines a text-first solution and its inlier
    set. This cost is used only for a subsequent refinement with those inliers
    fixed. Horizontal page sides share one surface ``Sy`` value, while vertical
    sides share one flattened ``u`` value. The unknown constant for each side
    is eliminated as its mean, exactly like the per-text-line height.
    """

    def __init__(
        self,
        data: ProblemData,
        template: DewarpParams,
        boundary: PageBoundary,
        boundary_weight: float,
        anchor_pts: np.ndarray | None = None,
        v_scale_ref: float | None = None,
    ):
        super().__init__(data, template, anchor_pts, v_scale_ref)
        self.boundary = boundary
        self.boundary_weight = float(boundary_weight)

    def _assemble(
        self, theta: np.ndarray, want_jac: bool
    ) -> tuple[np.ndarray, np.ndarray | None]:
        base_r, base_j = super()._assemble(theta, want_jac)
        params = unpack_theta(theta, self.template)
        scale = np.sqrt(self.boundary_weight)
        residuals = [base_r]
        jacobians = [base_j] if want_jac else None

        for name, pts in self.boundary.sides:
            if want_jac:
                Sx, Sy, _, dSx, dSy = backproject_with_grad(pts, params)
                if name in ("top", "bottom"):
                    coord, dcoord = Sy, dSy
                else:
                    coord, dcoord = flatten_u_with_grad(Sx, dSx, params)
                residuals.append(scale * (coord - coord.mean()))
                jacobians.append(scale * (dcoord - dcoord.mean(axis=0)))
            else:
                Sx, Sy, _ = backproject(pts, params)
                coord = Sy if name in ("top", "bottom") else flatten_u(Sx, params)
                residuals.append(scale * (coord - coord.mean()))

        return (
            np.concatenate(residuals),
            np.vstack(jacobians) if want_jac else None,
        )


def initial_params(img_w: int, img_h: int) -> DewarpParams:
    f0 = float(max(img_w, img_h))  # Equivalent to FOV ≈ 53° and the zero of f_regular
    return DewarpParams(
        a=np.zeros(M_POLY),
        rvec=np.zeros(3),
        f=f0,
        cx=img_w / 2.0,
        cy=img_h / 2.0,
        scale=float(max(img_w, img_h)),
    )


def _solve(
    cost: CostFunction,
    theta0: np.ndarray,
    img_max_side: float,
    fix_f: bool = False,
    max_nfev: int = 600,
    f_bounds: tuple[float, float] | None = None,
    a_bound: float = 5.0,
) -> np.ndarray:
    """Constrain ``f`` to the range corresponding to FOV 30°-74°.

    With ``fix_f=True`` during coarse optimization, hold ``f`` at its initial
    value. This constraint is required because ``E_str`` has a trivial solution
    that vertically collapses the document by making ``f`` extremely small.
    When specified, ``f_bounds`` in pixels takes precedence; it narrows the
    range around an EXIF estimate.
    """
    cost.reset_cache()  # Start independently without state from the previous candidate
    a_img = img_max_side
    if f_bounds is not None:
        f_lo, f_hi = np.log(f_bounds[0]), np.log(f_bounds[1])
    else:
        f_lo, f_hi = np.log(0.5 * a_img / np.tan(np.radians(37))), np.log(
            0.5 * a_img / np.tan(np.radians(15))
        )
    if fix_f:
        f_val = theta0[M_POLY + 3]
        # Apply bounds to a and rvec in the coarse stage as well. Previously they
        # were unconstrained, and the E_str degeneracy (a4 diverging to around
        # -1e4 with a nearly side-on view) created a strong basin of attraction.
        # If every multi-start candidate entered it, winner selection failed
        # (CBDAR_2).
        lo7 = np.concatenate([np.full(M_POLY, -a_bound), np.full(3, -1.0)])
        hi7 = -lo7
        t07 = np.clip(theta0[: M_POLY + 3], lo7 + 1e-12, hi7 - 1e-12)
        result = _lsq(
            lambda t: cost.residuals(np.append(t, f_val)),
            t07,
            jac=lambda t: cost.jacobian(np.append(t, f_val))[:, : M_POLY + 3],
            bounds=(lo7, hi7),
            max_nfev=max_nfev,
        )
        return np.append(result.x, f_val)
    lo = np.full(M_POLY + 4, -np.inf)
    hi = np.full(M_POLY + 4, np.inf)
    # Prevent surface coefficients from diverging. ±5 is sufficient for documents,
    # but real cylindrical objects such as bottles and cans have stronger curvature
    # and saturate, so scene mode widens the range.
    lo[0:M_POLY], hi[0:M_POLY] = -a_bound, a_bound
    # Constrain pose to the same range as the coarse-stage rejection criterion
    # (over 57° is rejected). This is especially necessary for real-world objects
    # such as bottles, where the full stage can escape toward a nearly side-on
    # degenerate solution with lower E_str.
    lo[M_POLY : M_POLY + 3], hi[M_POLY : M_POLY + 3] = -1.0, 1.0
    lo[M_POLY + 3], hi[M_POLY + 3] = f_lo, f_hi
    t0 = np.clip(theta0, lo + 1e-12, hi - 1e-12)
    result = _lsq(
        cost.residuals,
        t0,
        jac=cost.jacobian,
        bounds=(lo, hi),
        max_nfev=max_nfev,
    )
    return result.x


def classify_alignment(
    line_points: list[np.ndarray],
    block_of_line: list[int],
    n_blocks: int,
    params: DewarpParams,
    mean_text_size: float,
) -> list[str]:
    """Classify each block's alignment from the coarse rectification.

    Classification uses the proportion of lines whose endpoint u coordinates
    lie within the text size of the median. After coarse rectification, the
    endpoints should form nearly vertical lines. Thresholds are
    ``τ1=0.4, τ2=0.6``.
    """
    alignments = []
    for bi in range(n_blocks):
        idxs = [i for i, b in enumerate(block_of_line) if b == bi]
        if len(idxs) < 3:
            alignments.append("none")
            continue
        lefts, rights, widths = [], [], []
        for i in idxs:
            uv = surface_to_rectified(line_points[i], params)
            lefts.append(uv[:, 0].min())
            rights.append(uv[:, 0].max())
            widths.append(uv[:, 0].max() - uv[:, 0].min())
        lefts, rights, widths = map(np.array, (lefts, rights, widths))
        # Exclude short lines below 80% of the mean line width.
        keep = widths >= 0.8 * widths.mean()
        if keep.sum() < 3:
            alignments.append("none")
            continue
        tol = 2.0 * mean_text_size
        left_ratio = np.mean(np.abs(lefts[keep] - np.median(lefts[keep])) < tol)
        right_ratio = np.mean(np.abs(rights[keep] - np.median(rights[keep])) < tol)
        tau1, tau2 = 0.4, 0.6
        if left_ratio > tau2 and right_ratio > tau2:
            alignments.append("justified")
        elif left_ratio > tau2 and right_ratio <= tau1:
            alignments.append("left")
        elif right_ratio > tau2 and left_ratio <= tau1:
            alignments.append("right")
        else:
            alignments.append("none")
    return alignments


@dataclass
class OptimizeResult:
    params: DewarpParams
    data: ProblemData  # Final inlier features
    alignments: list[str]


@dataclass
class BoundaryCandidate:
    """One fixed-inlier page-boundary refinement candidate."""

    result: OptimizeResult
    weight: float


def run_optimization(
    text: TextFeatures,
    segs: LineSegments,
    img_w: int,
    img_h: int,
    use_line_term: bool = True,
    verbose: bool = False,
    opts: QualityOptions | None = None,
    f_exif_px: float | None = None,
    a_bound: float = 5.0,
    poly_scale: float | None = None,
) -> OptimizeResult:
    """Run coarse optimization, alignment classification, and iterative refinement.

    The refinement includes outlier removal. ``f_exif_px`` is the EXIF-derived
    focal length in this function's coordinate system (pixels in
    the resized image). When supplied, it initializes ``f`` and narrows the full
    optimization range to ±18%. It is not fixed because EXIF is not highly
    accurate.
    """
    if opts is None:
        opts = QualityOptions()
    # Illustration fragments can satisfy the deliberately permissive text-line
    # detector.  When the page contains enough unmistakable text structure, use
    # only those high-confidence lines as geometry constraints.  Sparse and
    # short-text documents keep the historical all-line behavior.
    use_confidence_filter = text.uses_confidence_filter
    initialization_line_points = [line.centers for line in text.lines]
    initialization_block_of_line = []
    line_points = []
    block_of_line = []
    for bi, block in enumerate(text.blocks):
        initialization_block_of_line.extend([bi] * len(block.lines))
        for line in block.lines:
            if use_confidence_filter and not line.high_confidence:
                continue
            line_points.append(line.centers)
            block_of_line.append(bi)
    n_blocks = len(text.blocks)

    template = initial_params(img_w, img_h)
    if poly_scale is not None:
        # Match the polynomial normalization scale to object width in scene mode.
        # For an object occupying only part of the image, an image-width-based s
        # makes the normalized t range too small for high-order terms to act. The
        # coefficients merely saturate at their bounds and cannot represent the
        # true curvature. Changing s is safe because it is purely numerical scaling.
        template.scale = float(poly_scale)
    theta = pack_theta(template)
    a_img = float(max(img_w, img_h))
    f_bounds = None
    if f_exif_px is not None:
        theta[M_POLY + 3] = np.log(f_exif_px)
        f_bounds = (0.82 * f_exif_px, 1.18 * f_exif_px)

    # Fixed feature set for the scale anchor, independent of outlier removal.
    # Use only text when enough text points exist, because segments may contain
    # texture noise. Add segment midpoints only for images with little text to
    # provide sufficient constraints.
    text_pts = (
        np.vstack(line_points) if line_points else np.empty((0, 2))
    )
    if len(text_pts) >= 200 or not len(segs.segments):
        anchor_pts = text_pts
    else:
        anchor_pts = np.vstack(
            [text_pts, 0.5 * (segs.segments[:, 0:2] + segs.segments[:, 2:4])]
        )

    # 1) Coarse optimization: E_str (+f_regular) only, with no segment,
    # spacing, or alignment terms.  The permissive candidate set is retained in
    # this initialization-only stage because its broad page coverage avoids an
    # underconstrained pose/curvature basin.  Weak candidates are absent from all
    # subsequent full optimizations. For images with few text lines, E_str alone
    # is underconstrained, so also include the segment term. Use multi-start,
    # initialized from a typical view and plane.
    few_text = len(initialization_line_points) < 10
    coarse_data = ProblemData(
        line_points=initialization_line_points,
        block_of_line=initialization_block_of_line,
        alignments=["__coarse__"] * n_blocks,  # Disable both spacing and alignment
        segments=segs.segments if (few_text and use_line_term) else np.empty((0, 4)),
        img_w=img_w,
        img_h=img_h,
        mean_text_size=text.mean_text_size,
        use_line_term=few_text and use_line_term,
    )
    coarse_cost = CostFunction(coarse_data, template)
    # Initialize in-plane rotation from the width-weighted median slope of
    # detected lines. Weight longer lines more to resist short false lines in figures.
    tilts, tilt_w = [], []
    for pts in initialization_line_points:
        d = pts[-1] - pts[0]
        if abs(d[0]) > 1e-9:
            tilts.append(float(np.arctan2(d[1], d[0])))
            tilt_w.append(abs(float(d[0])))
    if tilts:
        order = np.argsort(tilts)
        cum = np.cumsum(np.array(tilt_w)[order])
        skew = tilts[order[int(np.searchsorted(cum, 0.5 * cum[-1]))]]
    else:
        skew = 0.0
    def _coarse_score(t: np.ndarray) -> float:
        """Return the scale-normalized coarse cost.

        E_str also decreases for a solution that vertically collapses the
        document, so comparing raw costs selects a degenerate solution. Normalize
        by the squared v range before comparing.
        """
        params_t = unpack_theta(t, template)
        if np.linalg.norm(params_t.rvec) > 1.0:  # Reject rotations over 57°
            return np.inf
        coarse_cost.reset_cache()  # Evaluate candidates independently
        uv = surface_to_rectified(anchor_pts, params_t)
        u_range = float(np.ptp(uv[:, 0]))
        v_range = float(np.ptp(uv[:, 1]))
        if not np.isfinite(u_range + v_range) or v_range < 1e-6:
            return np.inf
        aspect = v_range / max(u_range, 1e-6)
        if aspect < 0.1 or aspect > 10.0:  # Implausible aspect ratio for a sheet
            return np.inf
        return float(np.sum(coarse_cost.residuals(t) ** 2)) / v_range**2

    # Initial pose × curvature candidates.
    if opts.full_pose_multistart:
        pose_candidates = [
            ([0.0, 0.0, skew], 0.0),
            ([0.35, 0.0, skew], 0.0),
            ([-0.35, 0.0, skew], 0.0),
            ([0.0, 0.35, skew], 0.0),
            ([0.0, -0.35, skew], 0.0),
            # Curvature initializations for entering a strong page-curl basin.
            ([0.0, 0.0, skew], 0.5),
            ([0.0, 0.0, skew], -0.5),
        ]
    else:
        pose_candidates = [
            ([0.0, 0.0, skew], 0.0),
            ([0.0, 0.0, skew], 0.5),
            ([0.0, 0.0, skew], -0.5),
        ]
    # Initial f candidates: use EXIF if available, or scan an FOV range.
    if f_exif_px is not None:
        f_candidates = [f_exif_px]
    elif opts.f_scan:
        f_candidates = [0.7 * a_img, 1.0 * a_img, 1.5 * a_img]  # FOV ≈ 71°/53°/37°
    else:
        f_candidates = [float(np.exp(theta[M_POLY + 3]))]

    best_theta, best_score = None, np.inf
    for f0 in f_candidates:
        for rvec0, a2_0 in pose_candidates:
            t0 = theta.copy()
            t0[M_POLY : M_POLY + 3] = rvec0
            t0[1] = a2_0  # a_2 (quadratic coefficient)
            t0[M_POLY + 3] = np.log(f0)
            t1 = _solve(
                coarse_cost, t0, max(img_w, img_h), fix_f=True, max_nfev=opts.max_nfev
            )
            s1 = _coarse_score(t1)
            if s1 < best_score:
                best_theta, best_score = t1, s1
    if best_theta is None:
        best_theta = _solve(
            coarse_cost, theta, max(img_w, img_h), fix_f=True, max_nfev=opts.max_nfev
        )
    theta = best_theta

    # 2) Alignment classification.
    alignments = classify_alignment(
        line_points, block_of_line, n_blocks, unpack_theta(theta, template),
        text.mean_text_size,
    )
    if verbose:
        print(f"  alignments: {alignments}")

    # 3) Optimization with iterative outlier removal.
    # Scale-anchor target: Y standard deviation of the fixed feature set in
    # the coarse solution.
    coarse_params = unpack_theta(theta, template)
    _, anchor_Sy_coarse, _ = backproject(anchor_pts, coarse_params)
    v_scale_ref = float(np.std(anchor_Sy_coarse))

    seg_mask = np.ones(len(segs.segments), dtype=bool)
    # Pre-remove segments outside the document. In the coarse solution, segments
    # outside an expanded
    # box around the text uv range lie beyond the polynomial's reliable domain;
    # their back-projection diverges and dominates f_str by orders of magnitude.
    # Do not apply this when text is sparse and segments are the primary features.
    initialization_text_pts = (
        np.vstack(initialization_line_points)
        if initialization_line_points
        else np.empty((0, 2))
    )
    if use_line_term and len(segs.segments) and len(initialization_text_pts) >= 200:
        # The broad candidate extent is useful here even when some candidates
        # are illustration strokes: it defines only the document-region box and
        # does not contribute a fitting residual.
        text_uv = surface_to_rectified(initialization_text_pts, coarse_params)
        mids = 0.5 * (segs.segments[:, 0:2] + segs.segments[:, 2:4])
        mid_uv = surface_to_rectified(mids, coarse_params)
        u0, u1 = np.percentile(text_uv[:, 0], [1, 99])
        v0, v1 = np.percentile(text_uv[:, 1], [1, 99])
        mu, mv = 0.3 * (u1 - u0), 0.3 * (v1 - v0)
        seg_mask = (
            np.all(np.isfinite(mid_uv), axis=1)
            & (mid_uv[:, 0] > u0 - mu)
            & (mid_uv[:, 0] < u1 + mu)
            & (mid_uv[:, 1] > v0 - mv)
            & (mid_uv[:, 1] < v1 + mv)
        )
        if verbose:
            print(f"  doc-region seg filter: {seg_mask.sum()}/{len(segs.segments)}")
    text_mask = np.ones(len(line_points), dtype=bool)
    tau = TAU_SEG_INIT
    data = None
    for it in range(opts.n_outlier_iter):
        data = ProblemData(
            line_points=[p for p, m in zip(line_points, text_mask) if m],
            block_of_line=[b for b, m in zip(block_of_line, text_mask) if m],
            alignments=alignments,
            segments=segs.segments[seg_mask] if use_line_term else np.empty((0, 4)),
            img_w=img_w,
            img_h=img_h,
            mean_text_size=text.mean_text_size,
            use_line_term=use_line_term,
        )
        cost = CostFunction(
            data, template, anchor_pts=anchor_pts, v_scale_ref=v_scale_ref
        )
        theta = _solve(
            cost,
            theta,
            max(img_w, img_h),
            max_nfev=opts.max_nfev,
            f_bounds=f_bounds,
            a_bound=a_bound,
        )

        # Update inliers.
        full_data = ProblemData(
            line_points=line_points,
            block_of_line=block_of_line,
            alignments=alignments,
            segments=segs.segments,
            img_w=img_w,
            img_h=img_h,
            mean_text_size=text.mean_text_size,
            use_line_term=use_line_term,
        )
        full_cost = CostFunction(full_data, template)
        new_seg_mask = seg_mask
        if use_line_term and len(segs.segments):
            align_vals = full_cost.segment_align_values(theta)
            # The inlier set decreases monotonically and preserves pre-removal
            # outside the document.
            new_seg_mask = seg_mask & (align_vals < tau)
        straightness = full_cost.textline_straightness(theta)
        rho = max(3.0 * float(np.median(straightness)), 0.3 * text.mean_text_size)
        new_text_mask = straightness < rho
        if new_text_mask.sum() < 2:
            new_text_mask = text_mask  # Avoid removing every text line
        if verbose:
            print(
                f"  iter {it + 1}: text inliers {new_text_mask.sum()}/{len(line_points)},"
                f" seg inliers {new_seg_mask.sum()}/{len(segs.segments)}"
            )
        stable = np.array_equal(new_seg_mask, seg_mask) and np.array_equal(
            new_text_mask, text_mask
        )
        seg_mask, text_mask = new_seg_mask, new_text_mask
        tau /= 2.0
        if stable and it > 0:
            break

    return OptimizeResult(
        params=unpack_theta(theta, template), data=data, alignments=alignments
    )


def refine_with_page_boundary(
    baseline: OptimizeResult,
    boundary: PageBoundary,
    img_w: int,
    img_h: int,
    opts: QualityOptions,
    f_exif_px: float | None = None,
    a_bound: float = 5.0,
) -> list[BoundaryCandidate]:
    """Generate text-preserving boundary refinements from a completed solution.

    All candidates start from the same baseline parameters and keep its text and
    line-segment inliers fixed. Candidate acceptance is intentionally deferred
    until after residual-warp fitting in :mod:`dewarping.dewarp`, where the
    actual output-coordinate text and page-boundary metrics are available.
    """
    data = baseline.data
    text_pts = (
        np.vstack(data.line_points) if data.line_points else np.empty((0, 2))
    )
    if len(text_pts) >= 200 or not len(data.segments):
        anchor_pts = text_pts
    else:
        anchor_pts = np.vstack(
            [text_pts, 0.5 * (data.segments[:, 0:2] + data.segments[:, 2:4])]
        )
    if not len(anchor_pts):
        return []

    _, anchor_sy, _ = backproject(anchor_pts, baseline.params)
    v_scale_ref = float(np.std(anchor_sy))
    if not np.isfinite(v_scale_ref) or v_scale_ref < 1e-6:
        return []

    f_bounds = None
    if f_exif_px is not None:
        f_bounds = (0.82 * f_exif_px, 1.18 * f_exif_px)

    theta0 = pack_theta(baseline.params)
    candidates = []
    # The first three are the standard candidates. Two gentler continuations
    # cover cases where strong, localized text evidence and a broad perimeter
    # constraint have a narrow acceptable trade-off without relaxing the gate.
    for weight in (1.0, 0.5, 0.25, 0.125, 0.12):
        cost = BoundaryCostFunction(
            data,
            baseline.params,
            boundary,
            weight,
            anchor_pts=anchor_pts,
            v_scale_ref=v_scale_ref,
        )
        theta = _solve(
            cost,
            theta0,
            max(img_w, img_h),
            max_nfev=min(opts.max_nfev, 600),
            f_bounds=f_bounds,
            a_bound=a_bound,
        )
        params = unpack_theta(theta, baseline.params)
        if not (
            np.all(np.isfinite(params.a))
            and np.all(np.isfinite(params.rvec))
            and np.isfinite(params.f)
        ):
            continue
        candidates.append(
            BoundaryCandidate(
                result=OptimizeResult(
                    params=params,
                    data=data,
                    alignments=baseline.alignments,
                ),
                weight=weight,
            )
        )
    return candidates
