"""Integrated dewarping pipeline.

Load → extract text lines → LSD → iterative optimization → remap rendering.

Implementation notes:
- Feature extraction and optimization run on an image resized to a maximum side
  of ``PROC_MAX_SIDE``. Coordinate-system scaling converts the estimated
  parameters back to full resolution: ``cx``, ``cy``, ``f``, and ``scale`` are
  scaled by the same ratio, while normalized polynomial coefficients ``a`` and
  rotation ``rvec`` are scale-invariant.
- The full input image is mapped to the rectified domain, producing a full-page
  image with black outside the document.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .linesegs import (
    LineSegments,
    PageBoundary,
    detect_line_segments,
    detect_paper_region,
)
from .saliency import salient_object_mask
from .model import (
    DewarpParams,
    backproject,
    rectified_to_image,
    surface_to_rectified,
)
from .optimize import (
    OptimizeResult,
    refine_with_page_boundary,
    run_optimization,
)
from .options import QualityOptions
from .textline import TextFeatures, extract_text_features

PROC_MAX_SIDE = 1600  # Maximum resized-image side for extraction and optimization
OUT_MAX_SCALE = 1.5  # Maximum output-canvas size relative to the input


@dataclass
class DewarpOutput:
    rectified: np.ndarray
    debug_image: np.ndarray | None
    params: DewarpParams


@dataclass
class _PreparedGeometry:
    """Full-resolution geometry and residual warp for one optimization result."""

    result: OptimizeResult
    params: DewarpParams
    feat_uv: np.ndarray
    x_clamp: tuple[float, float] | None
    line_uvs: list[np.ndarray]
    warp: ResidualWarp | None = None


@dataclass(frozen=True)
class _QualityMetrics:
    text_straightness_p90: float
    text_alignment_p90: float
    boundary_sides: tuple[float, float, float, float]

    @property
    def boundary_mean(self) -> float:
        return float(np.mean(self.boundary_sides))


def _scale_params(params: DewarpParams, ratio: float) -> DewarpParams:
    """Scale the coordinate system by ``ratio``.

    When converting resized to full-resolution coordinates,
    ``ratio = full size / resized size > 1``.
    """
    return DewarpParams(
        a=params.a.copy(),
        rvec=params.rvec.copy(),
        f=params.f * ratio,
        cx=params.cx * ratio,
        cy=params.cy * ratio,
        scale=params.scale * ratio,
    )


_INTERP = {
    "linear": cv2.INTER_LINEAR,
    "cubic": cv2.INTER_CUBIC,
    "lanczos": cv2.INTER_LANCZOS4,
}


@dataclass
class ResidualWarp:
    """Correct rotation and the residual field in rectified uv space.

    - ``theta``: in-plane rotation, computed as the weighted median of all
      feature angles folded modulo 90°. It is robust and uses a single rotation
      shared by horizontal and vertical features, so it introduces no shear.
    - ``cs = (s1, s2, s3, s4)``: coefficients of the slope-residual field for
      horizontal features,
      ``r_h(ū,v̄) = s1·ū + s2·v̄ + ½s3·ū² + s4·ū·v̄``. Apply it as the v
      correction ``P = ½s1·ū² + s2·ū·v̄ + ⅙s3·ū³ + ½s4·ū²·v̄``.
      ``s1`` is u-dependent twist, ``s2`` is v-dependent slope variation such
      as a partially lifted page, ``s3`` is residual curvature, and ``s4`` is
      the v dependence of curvature, such as stronger curvature only at the top.
    - ``ct = (t1, t2, t3, t4)``: the symmetric ``du/dv`` residual field for
      vertical features, corresponding to the u correction Q.

    This is a low-order approximate correction for distortions that GCS cannot
    represent, such as a lifted diagonal corner or a partially lifted page.
    """

    theta: float = 0.0
    cs: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    ct: tuple[float, float, float, float] = (0.0, 0.0, 0.0, 0.0)
    u_c: float = 0.0
    v_c: float = 0.0

    def is_identity(self) -> bool:
        return self.theta == 0.0 and not any(self.cs) and not any(self.ct)

    def _P(self, ub: np.ndarray, vb: np.ndarray) -> np.ndarray:
        s1, s2, s3, s4 = self.cs
        return (
            0.5 * s1 * ub**2
            + s2 * ub * vb
            + s3 * ub**3 / 6.0
            + 0.5 * s4 * ub**2 * vb
        )

    def _Q(self, ub: np.ndarray, vb: np.ndarray) -> np.ndarray:
        t1, t2, t3, t4 = self.ct
        return (
            0.5 * t1 * vb**2
            + t2 * vb * ub
            + t3 * vb**3 / 6.0
            + 0.5 * t4 * vb**2 * ub
        )

    def out_to_uv(self, uv_out: np.ndarray) -> np.ndarray:
        u, v = uv_out[:, 0], uv_out[:, 1]
        ub, vb = u - self.u_c, v - self.v_c
        return np.column_stack(
            [
                u - self.theta * v + self._Q(ub, vb),
                v + self.theta * u + self._P(ub, vb),
            ]
        )

    def uv_to_out(self, uv: np.ndarray) -> np.ndarray:
        # The correction is small (<2°), so a first-order inverse is sufficient.
        u, v = uv[:, 0], uv[:, 1]
        ub, vb = u - self.u_c, v - self.v_c
        return np.column_stack(
            [
                u + self.theta * v - self._Q(ub, vb),
                v - self.theta * u - self._P(ub, vb),
            ]
        )


def _weighted_median(vals: np.ndarray, w: np.ndarray) -> float:
    order = np.argsort(vals)
    cum = np.cumsum(w[order])
    return float(vals[order[int(np.searchsorted(cum, 0.5 * cum[-1]))]])


def _fit_residual_warp(
    line_uvs: list[np.ndarray], seg_uv_p: np.ndarray, seg_uv_q: np.ndarray
) -> ResidualWarp:
    """Fit a residual warp from rectified slopes of inlier features.

    Text horizontality and horizontal/vertical border alignment cannot both be
    satisfied when the page has distortion that GCS cannot represent, such as
    twist. This can leave a position-dependent compromise of about one degree.
    Rotation uses the weighted median of folded angles over all features (one
    shear-free rotation). Twist is fitted from the position dependence of slope
    residuals after removing rotation, using a first-order model through the origin.
    """
    # Horizontal features: position (u,v), slope dv/du, weight.
    # Vertical features: position (u,v), slope du/dv, weight.
    hu_pos, hv_pos, hs, hw = [], [], [], []
    vu_pos, vv_pos, vt, vw = [], [], [], []

    def add_h(p0: np.ndarray, p1: np.ndarray) -> None:
        d = p1 - p0
        if abs(d[0]) > 1e-6 and abs(d[1]) < abs(d[0]):
            hu_pos.append(float(0.5 * (p0[0] + p1[0])))
            hv_pos.append(float(0.5 * (p0[1] + p1[1])))
            hs.append(float(d[1] / d[0]))
            hw.append(float(abs(d[0])))

    for uv in line_uvs:
        # Split long lines in two to sample local slopes for fitting residual curvature.
        if len(uv) >= 6:
            m = len(uv) // 2
            add_h(uv[0], uv[m])
            add_h(uv[m], uv[-1])
        else:
            add_h(uv[0], uv[-1])
    if len(seg_uv_p):
        d = seg_uv_q - seg_uv_p
        length = np.hypot(d[:, 0], d[:, 1])
        mid = 0.5 * (seg_uv_p + seg_uv_q)
        ok = np.isfinite(length) & (length > 1e-6) & np.all(np.isfinite(mid), axis=1)
        horiz = ok & (np.abs(d[:, 1]) < 0.5 * np.abs(d[:, 0]))
        vert = ok & (np.abs(d[:, 0]) < 0.5 * np.abs(d[:, 1]))
        hu_pos.extend(mid[horiz, 0].tolist())
        hv_pos.extend(mid[horiz, 1].tolist())
        hs.extend((d[horiz, 1] / d[horiz, 0]).tolist())
        hw.extend(length[horiz].tolist())
        vu_pos.extend(mid[vert, 0].tolist())
        vv_pos.extend(mid[vert, 1].tolist())
        vt.extend((d[vert, 0] / d[vert, 1]).tolist())
        vw.extend(length[vert].tolist())
    hu_pos, hv_pos = np.array(hu_pos), np.array(hv_pos)
    hs, hw = np.array(hs), np.array(hw)
    vu_pos, vv_pos = np.array(vu_pos), np.array(vv_pos)
    vt, vw = np.array(vt), np.array(vw)

    # Robustly clip positions. On strongly curved surfaces such as bottles,
    # back-projection of tangential rays diverges and introduces positions above
    # 1e6. These move the weighted center u_c/v_c far away and make polynomial
    # corrections explode everywhere. Exclude them using quantiles.
    def _pos_keep(us: np.ndarray, vs: np.ndarray) -> np.ndarray:
        if len(us) == 0:
            return np.ones(0, dtype=bool)
        u0, u1 = np.percentile(us, [2, 98])
        v0, v1 = np.percentile(vs, [2, 98])
        du, dv = 2.0 * (u1 - u0) + 1.0, 2.0 * (v1 - v0) + 1.0
        return (
            (us > u0 - du) & (us < u1 + du) & (vs > v0 - dv) & (vs < v1 + dv)
        )

    keep_h = _pos_keep(hu_pos, hv_pos)
    hu_pos, hv_pos, hs, hw = hu_pos[keep_h], hv_pos[keep_h], hs[keep_h], hw[keep_h]
    keep_v = _pos_keep(vu_pos, vv_pos)
    vu_pos, vv_pos, vt, vw = vu_pos[keep_v], vv_pos[keep_v], vt[keep_v], vw[keep_v]

    # 1) Rotation: weighted median of horizontal-feature slopes and negative
    # vertical-feature du/dv, both small-angle approximations. Treat |θ| ≥ 3° as
    # evidence of a poor model and do not apply the correction.
    angs = np.concatenate([hs, -vt]) if len(vt) else hs
    ws = np.concatenate([hw, vw]) if len(vw) else hw
    if len(angs) == 0:
        return ResidualWarp()
    theta = _weighted_median(angs, ws)
    if abs(theta) >= np.tan(np.radians(3.0)):
        theta = 0.0

    # 2) Residual field: regress slope residuals after removing rotation as a
    # function of position through the origin. Horizontal:
    # r_h ≈ s1·ū + s2·v̄ + ½s3·ū² + s4·ū·v̄; the vertical case is symmetric.
    # Exclude only clear outliers above 4°, retaining systematic residuals to fit.
    lim2 = np.tan(np.radians(4.0))

    def field_fit(
        x1: np.ndarray, x2: np.ndarray, r: np.ndarray, w: np.ndarray
    ) -> tuple[float, float, float, float]:
        """Fit centered weighted regression ``r ≈ c1·x1 + c2·x2 + ½c3·x1² + c4·x1·x2``."""
        keep = np.abs(r) < lim2
        if keep.sum() < 10:
            return 0.0, 0.0, 0.0, 0.0
        x1, x2, r, w = x1[keep], x2[keep], r[keep], w[keep]
        if np.ptp(x1) < 1e-6:
            return 0.0, 0.0, 0.0, 0.0
        A = np.column_stack([x1, x2, 0.5 * x1**2, x1 * x2])
        Ws = np.sqrt(w)
        c, *_ = np.linalg.lstsq(A * Ws[:, None], r * Ws, rcond=None)
        return float(c[0]), float(c[1]), float(c[2]), float(c[3])

    # Use the weighted mean over all features as the center.
    pos_u = np.concatenate([hu_pos, vu_pos]) if len(vu_pos) else hu_pos
    pos_v = np.concatenate([hv_pos, vv_pos]) if len(vv_pos) else hv_pos
    pos_w = np.concatenate([hw, vw]) if len(vw) else hw
    if len(pos_u) == 0:
        return ResidualWarp(theta=theta)
    u_c = float(np.average(pos_u, weights=pos_w))
    v_c = float(np.average(pos_v, weights=pos_w))

    zero4 = (0.0, 0.0, 0.0, 0.0)
    cs = field_fit(hu_pos - u_c, hv_pos - v_c, hs - theta, hw) if len(hu_pos) else zero4
    ct = field_fit(vv_pos - v_c, vu_pos - u_c, vt + theta, vw) if len(vu_pos) else zero4

    # Safety limit: constrain the correction slope at the four feature-bounding-box
    # corners to the equivalent of 3°. Scale down rather than zeroing it so large
    # systematic residuals are still partially corrected.
    lim_apply = np.tan(np.radians(3.0))

    def clamp_field(
        c: tuple[float, float, float, float], x1s, x2s
    ) -> tuple[float, float, float, float]:
        m = 0.0
        for a in x1s:
            for b in x2s:
                m = max(m, abs(c[0] * a + c[1] * b + 0.5 * c[2] * a**2 + c[3] * a * b))
        if m > lim_apply:
            k = lim_apply / m
            return tuple(ci * k for ci in c)
        return c

    # Evaluate at the corners of the joint bounding box of all horizontal and
    # vertical features. If one group is tightly clustered, ill-conditioned
    # regression can produce huge coefficients whose corrections remain small
    # within that group's own bounding box, pass the safety limit, and then
    # explode over the full rendered area.
    ue_all = (pos_u.min() - u_c, pos_u.max() - u_c)
    ve_all = (pos_v.min() - v_c, pos_v.max() - v_c)
    if len(hu_pos):
        cs = clamp_field(cs, ue_all, ve_all)
    if len(vu_pos):
        ct = clamp_field(ct, ve_all, ue_all)
    return ResidualWarp(theta=theta, cs=tuple(cs), ct=tuple(ct), u_c=u_c, v_c=v_c)


def _prepare_geometry(
    result: OptimizeResult, ratio: float
) -> _PreparedGeometry | None:
    """Convert one processing-resolution result to render/output coordinates."""
    params = (
        _scale_params(result.params, 1.0 / ratio)
        if abs(ratio - 1.0) > 1e-3
        else result.params
    )
    feat_parts = [p for p in result.data.line_points]
    if len(result.data.segments):
        feat_parts.append(result.data.segments[:, 0:2])
        feat_parts.append(result.data.segments[:, 2:4])
    if not feat_parts:
        return None
    feat_img = np.vstack(feat_parts) / ratio
    Sx_feat, _, _ = backproject(feat_img, params)
    Sx_feat = Sx_feat[np.isfinite(Sx_feat)]
    if not len(Sx_feat):
        return None
    x_clamp = (
        float(np.percentile(Sx_feat, 1)),
        float(np.percentile(Sx_feat, 99)),
    )
    feat_uv = surface_to_rectified(feat_img, params)
    feat_uv = feat_uv[np.all(np.isfinite(feat_uv), axis=1)]
    if not len(feat_uv):
        return None

    line_uvs = [
        surface_to_rectified(p / ratio, params) for p in result.data.line_points
    ]
    if any(not np.all(np.isfinite(uv)) for uv in line_uvs):
        return None
    if len(result.data.segments):
        seg_uv_p = surface_to_rectified(
            result.data.segments[:, 0:2] / ratio, params
        )
        seg_uv_q = surface_to_rectified(
            result.data.segments[:, 2:4] / ratio, params
        )
    else:
        seg_uv_p = seg_uv_q = np.empty((0, 2))
    if not (
        np.all(np.isfinite(seg_uv_p)) and np.all(np.isfinite(seg_uv_q))
    ):
        return None
    warp = _fit_residual_warp(line_uvs, seg_uv_p, seg_uv_q)
    return _PreparedGeometry(
        result=result,
        params=params,
        feat_uv=feat_uv,
        x_clamp=x_clamp,
        line_uvs=line_uvs,
        warp=warp,
    )


def _quality_metrics(
    geometry: _PreparedGeometry,
    boundary: PageBoundary,
    ratio: float,
) -> _QualityMetrics:
    """Measure visible-output text alignment and rectangularity of page sides."""
    warp = geometry.warp or ResidualWarp()
    line_uvs = [warp.uv_to_out(uv) for uv in geometry.line_uvs]

    straightness = [
        float(np.sqrt(np.mean((uv[:, 1] - uv[:, 1].mean()) ** 2)))
        for uv in line_uvs
        if len(uv)
    ]
    straight_p90 = (
        float(np.percentile(straightness, 90)) if straightness else 0.0
    )

    data = geometry.result.data
    widths = np.array(
        [float(np.ptp(pts[:, 0])) for pts in data.line_points], dtype=np.float64
    )
    eligible = np.zeros(len(widths), dtype=bool)
    for bi in set(data.block_of_line):
        idx = [i for i, block in enumerate(data.block_of_line) if block == bi]
        if idx:
            mean_width = float(widths[idx].mean())
            eligible[idx] = widths[idx] >= 0.8 * mean_width

    block_scales: dict[int, list[float]] = {}
    for i, uv in enumerate(line_uvs):
        if i >= len(data.block_of_line) or not len(uv):
            continue
        input_width = float(np.ptp(data.line_points[i][:, 0])) / ratio
        output_width = float(np.ptp(uv[:, 0]))
        if input_width > 1e-6 and output_width > 1e-6:
            block_scales.setdefault(data.block_of_line[i], []).append(
                output_width / input_width
            )

    aligned_edges: dict[tuple[int, str], list[float]] = {}
    for i, uv in enumerate(line_uvs):
        if i >= len(data.block_of_line) or not eligible[i] or not len(uv):
            continue
        bi = data.block_of_line[i]
        alignment = geometry.result.alignments[bi]
        if alignment in ("left", "justified"):
            aligned_edges.setdefault((bi, "left"), []).append(float(uv[:, 0].min()))
        if alignment in ("right", "justified"):
            aligned_edges.setdefault((bi, "right"), []).append(float(uv[:, 0].max()))
    edge_deviations = []
    for (bi, _), values in aligned_edges.items():
        if len(values) >= 2:
            vals = np.asarray(values)
            scales = block_scales.get(bi, [1.0])
            scale = max(float(np.median(scales)), 1e-6)
            # Express deviations in equivalent input pixels so candidates with
            # a slightly different global rectified scale remain comparable.
            edge_deviations.extend(
                (np.abs(vals - np.median(vals)) / scale).tolist()
            )
    align_p90 = (
        float(np.percentile(edge_deviations, 90)) if edge_deviations else 0.0
    )

    side_errors = []
    for name, pts in boundary.sides:
        uv = surface_to_rectified(pts / ratio, geometry.params)
        if not np.all(np.isfinite(uv)):
            side_errors.append(np.inf)
            continue
        uv = warp.uv_to_out(uv)
        if name in ("top", "bottom"):
            coord, along = uv[:, 1], uv[:, 0]
        else:
            coord, along = uv[:, 0], uv[:, 1]
        span = max(float(np.ptp(along)), 1.0)
        error = np.sqrt(np.mean((coord - np.median(coord)) ** 2)) / span
        side_errors.append(float(error))
    return _QualityMetrics(
        text_straightness_p90=straight_p90,
        text_alignment_p90=align_p90,
        boundary_sides=tuple(side_errors),
    )


def _candidate_is_acceptable(
    baseline: _QualityMetrics,
    candidate: _QualityMetrics,
    mean_text_size: float,
) -> bool:
    """Apply the text-first gate and require a material boundary improvement."""
    if not np.all(
        np.isfinite(
            [
                candidate.text_straightness_p90,
                candidate.text_alignment_p90,
                *candidate.boundary_sides,
            ]
        )
    ):
        return False

    for base_value, candidate_value in (
        (baseline.text_straightness_p90, candidate.text_straightness_p90),
        (baseline.text_alignment_p90, candidate.text_alignment_p90),
    ):
        tolerance = max(0.05 * base_value, 0.02 * mean_text_size)
        if candidate_value > base_value + tolerance:
            return False

    if candidate.boundary_mean > 0.5 * baseline.boundary_mean:
        return False
    for base_side, candidate_side in zip(
        baseline.boundary_sides, candidate.boundary_sides
    ):
        if candidate_side > max(1.1 * base_side, base_side + 0.001):
            return False
    return True


def _render(
    img: np.ndarray,
    params: DewarpParams,
    feat_uv: np.ndarray,
    x_clamp: tuple[float, float] | None = None,
    grid: int = 129,
    interp: str = "linear",
    warp: ResidualWarp | None = None,
    page_uv: np.ndarray | None = None,
) -> np.ndarray:
    """Map the document region into the rectified ``(u,v)`` domain and render it.

    Determine output bounds from the inlier features' ``(u,v)`` range plus a
    margin, as a substitute for explicit document-region detection. Do not
    back-project the entire image because the polynomial becomes unstable beyond
    the feature-bearing region.
    """
    h, w = img.shape[:2]
    # Residual-warp correction: use the corrected (u',v') output coordinate system.
    apply_warp = warp is not None and not warp.is_identity()
    if apply_warp:
        feat_uv = warp.uv_to_out(feat_uv)
        if page_uv is not None and len(page_uv):
            page_uv = warp.uv_to_out(page_uv)
    # Default: feature range plus a 15% margin.
    fu0, fu1 = np.percentile(feat_uv[:, 0], [1, 99])
    fv0, fv1 = np.percentile(feat_uv[:, 1], [1, 99])
    fw, fh = fu1 - fu0, fv1 - fv0
    u0, u1 = fu0 - 0.15 * fw, fu1 + 0.15 * fw
    v0, v1 = fv0 - 0.15 * fh, fv1 + 0.15 * fh
    # If a paper-mask boundary is available, switch to document-only framing.
    # Back-projecting the mask contour can
    # be unstable, so accept it only when it nearly contains the feature range
    # (detecting collapse) and stays within three times that range (detecting divergence).
    if page_uv is not None and len(page_uv) > 20:
        pu0, pu1 = np.percentile(page_uv[:, 0], [2, 98])
        pv0, pv1 = np.percentile(page_uv[:, 1], [2, 98])
        contains = (
            pu0 < fu0 + 0.1 * fw
            and pu1 > fu1 - 0.1 * fw
            and pv0 < fv0 + 0.1 * fh
            and pv1 > fv1 - 0.1 * fh
        )
        bounded = (pu1 - pu0) < 3.0 * fw and (pv1 - pv0) < 3.0 * fh
        if contains and bounded:
            mw, mh = 0.02 * (pu1 - pu0), 0.02 * (pv1 - pv0)
            u0, u1 = pu0 - mw, pu1 + mw
            v0, v1 = pv0 - mh, pv1 + mh
    out_w = int(round(u1 - u0))
    out_h = int(round(v1 - v0))
    # Prevent extreme enlargement.
    scale_cap = min(1.0, OUT_MAX_SCALE * max(w, h) / max(out_w, out_h))
    out_w = max(16, int(out_w * scale_cap))
    out_h = max(16, int(out_h * scale_cap))

    # Compute the inverse map on a coarse grid and interpolate it to all pixels.
    gn = grid
    gu = np.linspace(u0, u1, gn)
    gv = np.linspace(v0, v1, gn)
    guu, gvv = np.meshgrid(gu, gv)
    grid_uv = np.column_stack([guu.ravel(), gvv.ravel()])
    if apply_warp:
        grid_uv = warp.out_to_uv(grid_uv)
    ab = rectified_to_image(grid_uv, params, x_clamp=x_clamp)
    map_a = ab[:, 0].reshape(gn, gn).astype(np.float32)
    map_b = ab[:, 1].reshape(gn, gn).astype(np.float32)
    map_x = cv2.resize(map_a, (out_w, out_h), interpolation=cv2.INTER_LINEAR)
    map_y = cv2.resize(map_b, (out_w, out_h), interpolation=cv2.INTER_LINEAR)
    return cv2.remap(
        img,
        map_x,
        map_y,
        interpolation=_INTERP[interp],
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )


def _draw_debug(
    img: np.ndarray,
    text: TextFeatures,
    segs: LineSegments,
    result: OptimizeResult,
    boundary: PageBoundary | None = None,
) -> np.ndarray:
    vis = img.copy()
    if vis.ndim == 2:
        vis = cv2.cvtColor(vis, cv2.COLOR_GRAY2BGR)
    for px, py, qx, qy in segs.segments:
        cv2.line(vis, (int(px), int(py)), (int(qx), int(qy)), (0, 0, 255), 1)
    # Green points are the final text inliers that actually constrained the
    # geometry.  Other detected candidates are retained in gray for diagnosis.
    inlier_ids = {id(points) for points in result.data.line_points}
    for ln in text.lines:
        is_inlier = id(ln.centers) in inlier_ids
        color = (0, 255, 0) if is_inlier else (128, 128, 128)
        radius = 3 if is_inlier else 2
        for c in ln.centers:
            cv2.circle(vis, (int(c[0]), int(c[1])), radius, color, -1)
    if boundary is not None:
        colors = {
            "top": (255, 255, 0),
            "bottom": (0, 255, 255),
            "left": (255, 0, 255),
            "right": (0, 165, 255),
        }
        for name, points in boundary.sides:
            for x, y in points:
                cv2.circle(vis, (int(round(x)), int(round(y))), 4, colors[name], -1)
    return vis


def _filter_segments_by_geometry_support(
    segs: LineSegments,
    text: TextFeatures,
    boundary: PageBoundary,
) -> LineSegments:
    """Keep segments supported by trusted text or the paper perimeter.

    Dense illustrations generate many short, locally straight LSD segments.
    Once a page boundary and multiple strong text lines are both available,
    those interior illustration strokes provide no useful information beyond
    the text and perimeter constraints. Split-segment midpoints must lie close
    to either source; the threshold scales with the detected text size.
    """
    if not len(segs) or not text.high_confidence_lines:
        return segs
    support = np.vstack(
        [
            *(line.centers for line in text.high_confidence_lines),
            *(points for _, points in boundary.sides),
        ]
    )
    threshold2 = (3.0 * text.mean_text_size) ** 2
    keep = np.zeros(len(segs), dtype=bool)
    midpoints = segs.r
    # Bound the temporary distance matrix for high-resolution documents.
    for start in range(0, len(midpoints), 512):
        batch = midpoints[start : start + 512]
        distance2 = np.sum((batch[:, None, :] - support[None, :, :]) ** 2, axis=2)
        keep[start : start + len(batch)] = np.min(distance2, axis=1) <= threshold2
    return LineSegments(segments=segs.segments[keep])


def dewarp_image(
    img: np.ndarray, use_line_term: bool = True, debug: bool = False,
    verbose: bool = False, opts: QualityOptions | None = None,
    scene: bool = False,
) -> DewarpOutput:
    """Dewarp an image; ``scene=True`` enables curved-object scene mode.

    Instead of a paper mask, use a salient-object mask from saliency detection
    and restrict text and line-segment extraction to the object. Optimization
    and rendering are shared with document dewarping; only preprocessing differs.
    """
    if opts is None:
        opts = QualityOptions()
    h, w = img.shape[:2]
    # Always extract features and optimize near proc_max_side resolution. This
    # includes upscaling low-resolution input: around 600 px, characters are only
    # a few pixels high, breaking the assumptions of CC detection, line formation,
    # and segment detection. Rendering still uses the original resolution, with
    # parameters converted by coordinate scaling.
    ratio = min(opts.proc_max_side / max(w, h), 3.0)
    if abs(ratio - 1.0) > 1e-3:
        interp_rs = cv2.INTER_AREA if ratio < 1.0 else cv2.INTER_CUBIC
        proc = cv2.resize(
            img, (round(w * ratio), round(h * ratio)), interpolation=interp_rs
        )
    else:
        proc = img
    gray = cv2.cvtColor(proc, cv2.COLOR_BGR2GRAY) if proc.ndim == 3 else proc

    mask_kind = "no"
    mask = None
    paper_region = None
    if proc.ndim == 3:
        if scene:
            mask = salient_object_mask(proc)
            mask_kind = "saliency" if mask is not None else "no"
        if mask is None:
            paper_region = detect_paper_region(proc)
            if paper_region is not None:
                mask = paper_region.mask
                mask_kind = "paper"
    page_boundary = (
        paper_region.boundary
        if (
            paper_region is not None
            and not scene
            and opts.use_page_boundary
        )
        else None
    )
    # Restrict text extraction to a detected paper/object region. Without this,
    # short groups of background texture (for example desk wood grain) can form
    # individually straight false text lines and survive line-level outlier tests.
    text = extract_text_features(gray, mask=mask)
    segs = detect_line_segments(gray, text.mean_text_size, mask=mask)
    detected_segment_count = len(segs)
    if (
        use_line_term
        and page_boundary is not None
        and text.uses_confidence_filter
    ):
        segs = _filter_segments_by_geometry_support(segs, text, page_boundary)
    if verbose:
        geometry_lines = (
            text.high_confidence_lines
            if text.uses_confidence_filter
            else text.lines
        )
        print(
            f"  text lines: {len(text.lines)} (geometry: {len(geometry_lines)},"
            f" blocks: {len(text.blocks)}),"
            f" segments: {len(segs)}, mean text size: {text.mean_text_size:.1f},"
            f" mask: {mask_kind}"
        )
        if text.uses_confidence_filter:
            rejected = len(text.lines) - len(text.high_confidence_lines)
            print(f"  text geometry filter: rejected {rejected} weak candidate lines")
        elif text.lines:
            print("  text geometry filter: sparse-text fallback")
        if len(segs) != detected_segment_count:
            print(
                f"  segment geometry filter: kept {len(segs)}/"
                f"{detected_segment_count} text/perimeter-supported segments"
            )
        if mask_kind == "paper":
            if not opts.use_page_boundary:
                print("  page boundary: disabled")
            elif scene:
                print("  page boundary: skipped in scene mode")
            elif page_boundary is None:
                print("  page boundary: rejected by confidence checks")
            else:
                print("  page boundary: trusted (50 samples per side)")
    if not text.lines and not len(segs):
        # Return the input unchanged when no features are available.
        return DewarpOutput(rectified=img.copy(), debug_image=None, params=None)

    # EXIF f is in full-resolution pixels; multiply by ratio for resized optimization.
    f_exif_proc = opts.f_exif_px * ratio if opts.f_exif_px else None
    if verbose and f_exif_proc:
        print(f"  EXIF focal length: {opts.f_exif_px:.0f}px (proc: {f_exif_proc:.0f}px)")
    # Scene mode: match the polynomial normalization scale to the object's x width.
    # Image-width scaling gives too small a normalized range on the object to
    # represent strong real curvature.
    poly_scale = None
    if scene and mask is not None:
        cols = np.where(mask.any(axis=0))[0]
        if len(cols) >= 64:
            poly_scale = float(cols[-1] - cols[0])
    result = run_optimization(
        text, segs, gray.shape[1], gray.shape[0],
        use_line_term=use_line_term, verbose=verbose,
        opts=opts, f_exif_px=f_exif_proc,
        a_bound=5.0,
        poly_scale=poly_scale,
    )

    geometry = _prepare_geometry(result, ratio)
    if geometry is None:
        if verbose:
            print("  geometry preparation failed; returning input unchanged")
        return DewarpOutput(rectified=img.copy(), debug_image=None, params=result.params)

    selected_weight = None
    if page_boundary is not None:
        baseline_metrics = _quality_metrics(geometry, page_boundary, ratio)
        candidates = refine_with_page_boundary(
            result,
            page_boundary,
            gray.shape[1],
            gray.shape[0],
            opts,
            f_exif_px=f_exif_proc,
            a_bound=5.0,
        )
        acceptable = []
        mean_text_size_full = text.mean_text_size / ratio
        for candidate in candidates:
            candidate_geometry = _prepare_geometry(candidate.result, ratio)
            if candidate_geometry is None:
                if verbose:
                    print(f"  page boundary candidate w={candidate.weight:g}: invalid")
                continue
            candidate_metrics = _quality_metrics(
                candidate_geometry, page_boundary, ratio
            )
            accepted = _candidate_is_acceptable(
                baseline_metrics, candidate_metrics, mean_text_size_full
            )
            if verbose:
                status = "eligible" if accepted else "rejected"
                print(
                    f"  page boundary candidate w={candidate.weight:g}: {status},"
                    f" text-p90={candidate_metrics.text_straightness_p90:.2f}"
                    f" (base {baseline_metrics.text_straightness_p90:.2f}),"
                    f" align-p90={candidate_metrics.text_alignment_p90:.2f}"
                    f" (base {baseline_metrics.text_alignment_p90:.2f}),"
                    f" edge={candidate_metrics.boundary_mean:.4f}"
                    f" (base {baseline_metrics.boundary_mean:.4f})"
                    f" sides={tuple(f'{v:.4f}' for v in candidate_metrics.boundary_sides)}"
                )
            if accepted:
                acceptable.append(
                    (candidate_metrics.boundary_mean, candidate.weight, candidate_geometry)
                )
        if acceptable:
            _, selected_weight, geometry = min(acceptable, key=lambda item: item[0])
            result = geometry.result
            if verbose:
                print(f"  page boundary: accepted candidate w={selected_weight:g}")
        elif verbose:
            print("  page boundary: no candidate passed; keeping text-first baseline")

    params_full = geometry.params
    feat_uv = geometry.feat_uv
    x_clamp = geometry.x_clamp
    warp = geometry.warp or ResidualWarp()
    if verbose and not warp.is_identity():
        print(
            f"  residual warp: rot={np.degrees(np.arctan(warp.theta)):.2f}deg,"
            f" cs={tuple(f'{c:.1e}' for c in warp.cs)},"
            f" ct={tuple(f'{c:.1e}' for c in warp.ct)}"
        )
    # Paper-mask boundary in uv coordinates, used by _render for page framing.
    page_uv = None
    if mask is not None:
        contours, _ = cv2.findContours(
            mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
        )
        contour = (
            max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
            if contours
            else np.empty((0, 2))
        )
        if len(contour):
            page_uv = surface_to_rectified(contour[::5] / ratio, params_full)
            page_uv = page_uv[np.all(np.isfinite(page_uv), axis=1)]
    rectified = _render(
        img, params_full, feat_uv, x_clamp=x_clamp,
        grid=opts.render_grid, interp=opts.interp, warp=warp, page_uv=page_uv,
    )
    debug_image = (
        _draw_debug(proc, text, segs, result, page_boundary) if debug else None
    )
    return DewarpOutput(rectified=rectified, debug_image=debug_image, params=params_full)
