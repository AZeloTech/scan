"""LSD line-segment detection and preprocessing.

- Remove segments shorter than the mean text size.
- Split long segments into pieces of length ``t_l``, giving longer segments
  more weight in the alignment term.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class LineSegments:
    """A collection of split segments, one ``[px, py, qx, qy]`` per row."""

    segments: np.ndarray  # (N, 4) float64

    def __len__(self) -> int:
        return len(self.segments)

    @property
    def p(self) -> np.ndarray:
        return self.segments[:, 0:2]

    @property
    def q(self) -> np.ndarray:
        return self.segments[:, 2:4]

    @property
    def r(self) -> np.ndarray:
        """Return segment midpoints."""
        return 0.5 * (self.p + self.q)


@dataclass
class PageBoundary:
    """Trusted, uniformly sampled sides of a visible rectangular page."""

    top: np.ndarray
    bottom: np.ndarray
    left: np.ndarray
    right: np.ndarray

    @property
    def sides(self) -> tuple[tuple[str, np.ndarray], ...]:
        return (
            ("top", self.top),
            ("bottom", self.bottom),
            ("left", self.left),
            ("right", self.right),
        )


@dataclass
class PaperRegion:
    """Paper feature mask and an optional high-confidence page boundary."""

    mask: np.ndarray
    contour: np.ndarray
    boundary: PageBoundary | None


def _edge_strength(gray: np.ndarray, segs: np.ndarray) -> np.ndarray:
    """Measure edge strength as the mean normal intensity difference at three points.

    This separates low-contrast texture segments, such as wood grain on a desk,
    from high-contrast printed borders and rules.
    """
    h, w = gray.shape
    g = gray.astype(np.float32)
    p, q = segs[:, 0:2], segs[:, 2:4]
    d = q - p
    length = np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-9)
    normal = np.column_stack([-d[:, 1] / length, d[:, 0] / length])

    def sample(pts: np.ndarray) -> np.ndarray:
        x = np.clip(pts[:, 0], 0, w - 1).astype(np.int32)
        y = np.clip(pts[:, 1], 0, h - 1).astype(np.int32)
        return g[y, x]

    strength = np.zeros(len(segs), dtype=np.float32)
    for t in (0.25, 0.5, 0.75):
        pt = p + t * d
        diff = np.zeros(len(segs), dtype=np.float32)
        for off in (2.0, 4.0):
            diff += np.abs(sample(pt + off * normal) - sample(pt - off * normal))
        strength += diff / 2.0
    return strength / 3.0


EDGE_STRENGTH_MIN = 15.0  # Lower values are treated as low-contrast texture


def _sample_contour_arc(arc: np.ndarray, n: int = 50) -> np.ndarray | None:
    """Sample an ordered contour arc uniformly by length, excluding its corners."""
    if len(arc) < 2:
        return None
    ds = np.hypot(np.diff(arc[:, 0]), np.diff(arc[:, 1]))
    distance = np.concatenate([[0.0], np.cumsum(ds)])
    total = float(distance[-1])
    if total < 1.0:
        return None
    targets = np.linspace(0.03 * total, 0.97 * total, n)
    return np.column_stack(
        [
            np.interp(targets, distance, arc[:, 0]),
            np.interp(targets, distance, arc[:, 1]),
        ]
    )


def _extract_page_boundary(filled: np.ndarray) -> PageBoundary | None:
    """Extract four trusted page sides from an undilated filled paper mask.

    The boundary is deliberately conservative: partially visible, strongly
    non-convex, non-quadrilateral, or diagonally oriented regions are rejected.
    The text-line extractor expects an approximately upright document as well,
    so requiring each side to lie within 30 degrees of an image axis is
    consistent with the rest of the pipeline.
    """
    h, w = filled.shape
    contours, _ = cv2.findContours(
        filled.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE
    )
    if not contours:
        return None
    contour_cv = max(contours, key=cv2.contourArea)
    contour_area = float(cv2.contourArea(contour_cv))
    if contour_area < 0.15 * filled.size:
        return None

    x, y, bw, bh = cv2.boundingRect(contour_cv)
    if x <= 0 or y <= 0 or x + bw >= w or y + bh >= h:
        return None  # A complete four-sided page is not visible.

    hull = cv2.convexHull(contour_cv)
    hull_area = float(cv2.contourArea(hull))
    if contour_area <= 0.0 or hull_area / contour_area > 1.15:
        return None
    perimeter = float(cv2.arcLength(hull, True))
    quad = cv2.approxPolyDP(hull, 0.01 * perimeter, True)
    if len(quad) != 4:
        return None
    quad_area_ratio = float(cv2.contourArea(quad)) / contour_area
    if not 0.85 <= quad_area_ratio <= 1.15:
        return None

    contour = contour_cv.reshape(-1, 2).astype(np.float64)
    corners = quad.reshape(-1, 2).astype(np.float64)
    corner_indices = []
    for corner in corners:
        i = int(np.argmin(np.sum((contour - corner) ** 2, axis=1)))
        corner_indices.append(i)
    corner_indices = sorted(set(corner_indices))
    if len(corner_indices) != 4:
        return None

    horizontal: list[tuple[float, np.ndarray]] = []
    vertical: list[tuple[float, np.ndarray]] = []
    for j, start in enumerate(corner_indices):
        end = corner_indices[(j + 1) % 4]
        if j < 3:
            arc = contour[start : end + 1]
        else:
            arc = np.vstack([contour[start:], contour[: end + 1]])
        delta = arc[-1] - arc[0]
        angle = float(np.degrees(np.arctan2(abs(delta[1]), abs(delta[0]))))
        if angle <= 30.0:
            if np.hypot(*delta) < 0.25 * bw:
                return None
            horizontal.append((float(np.mean(arc[:, 1])), arc))
        elif angle >= 60.0:
            if np.hypot(*delta) < 0.25 * bh:
                return None
            vertical.append((float(np.mean(arc[:, 0])), arc))
        else:
            return None
    if len(horizontal) != 2 or len(vertical) != 2:
        return None

    horizontal.sort(key=lambda item: item[0])
    vertical.sort(key=lambda item: item[0])
    sampled = [
        _sample_contour_arc(horizontal[0][1]),
        _sample_contour_arc(horizontal[1][1]),
        _sample_contour_arc(vertical[0][1]),
        _sample_contour_arc(vertical[1][1]),
    ]
    if any(side is None for side in sampled):
        return None
    return PageBoundary(
        top=sampled[0],
        bottom=sampled[1],
        left=sampled[2],
        right=sampled[3],
    )


def detect_paper_region(img_bgr: np.ndarray) -> PaperRegion | None:
    """Estimate a paper mask and, when reliable, its four visible sides.

    Background segments and features, such as desk wood grain, lie on a plane
    different from the document surface and contaminate estimation. This mask
    restricts features to the paper. Filling the contour also includes printed
    content on the paper, such as highly saturated slides. Return ``None`` on
    failure.
    """
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    sat, val = hsv[:, :, 1], hsv[:, :, 2]
    _, bright = cv2.threshold(val, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    cand = ((bright > 0) & (sat < 60)).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(cand, 8)
    if n <= 1:
        return None
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    if stats[idx, cv2.CC_STAT_AREA] < 0.15 * cand.size:
        return None  # No large paper-like region
    component = (lab == idx).astype(np.uint8)
    contours, _ = cv2.findContours(
        component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    if not contours:
        return None
    filled = np.zeros_like(component)
    cv2.drawContours(filled, contours, -1, 1, -1)
    contour = max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
    boundary = _extract_page_boundary(filled)
    # Dilate slightly so segments along the page edge are retained.
    feature_mask = cv2.dilate(filled, np.ones((9, 9), np.uint8))
    return PaperRegion(mask=feature_mask, contour=contour, boundary=boundary)


def paper_mask(img_bgr: np.ndarray) -> np.ndarray | None:
    """Backward-compatible wrapper returning only the paper feature mask."""
    region = detect_paper_region(img_bgr)
    return None if region is None else region.mask


def detect_line_segments(
    gray: np.ndarray, mean_text_size: float, mask: np.ndarray | None = None
) -> LineSegments:
    lsd = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    detected = lsd.detect(gray)[0]
    if detected is None or len(detected) == 0:
        return LineSegments(segments=np.empty((0, 4)))
    segs = detected.reshape(-1, 4).astype(np.float64)

    # Step 1: remove segments shorter than the mean text size as noise.
    lengths = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1])
    segs = segs[lengths > mean_text_size]

    # Step 1b: remove low-contrast segments such as background wood grain.
    if len(segs):
        segs = segs[_edge_strength(gray, segs) >= EDGE_STRENGTH_MIN]

    # Step 1c: remove background segments outside the paper mask.
    if mask is not None and len(segs):
        mid = (0.5 * (segs[:, 0:2] + segs[:, 2:4])).astype(np.int32)
        h, w = mask.shape
        mx = np.clip(mid[:, 0], 0, w - 1)
        my = np.clip(mid[:, 1], 0, h - 1)
        segs = segs[mask[my, mx] > 0]

    # Step 2: split at length t_l, proportional to mean text size.
    t_l = 2.0 * mean_text_size
    divided = []
    for px, py, qx, qy in segs:
        length = float(np.hypot(qx - px, qy - py))
        n_i = max(1, int(round(length / t_l)))
        ts = np.linspace(0.0, 1.0, n_i + 1)
        for t0, t1 in zip(ts[:-1], ts[1:]):
            divided.append(
                [
                    px + (qx - px) * t0,
                    py + (qy - py) * t0,
                    px + (qx - px) * t1,
                    py + (qy - py) * t1,
                ]
            )
    return LineSegments(segments=np.array(divided) if divided else np.empty((0, 4)))
