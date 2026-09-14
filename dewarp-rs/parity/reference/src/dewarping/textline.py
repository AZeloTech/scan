"""Text-line detection using connected-component centers and text blocks."""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class TextLine:
    """One text line, with CC centers ``(α, β)`` ordered by increasing x."""

    centers: np.ndarray  # (N, 2) float64
    high_confidence: bool = True  # Strong text structure, safe for geometry fitting

    @property
    def left(self) -> np.ndarray:
        return self.centers[0]

    @property
    def right(self) -> np.ndarray:
        return self.centers[-1]

    @property
    def width(self) -> float:
        return float(self.centers[-1, 0] - self.centers[0, 0])


@dataclass
class TextBlock:
    lines: list[TextLine] = field(default_factory=list)
    alignment: str = "none"  # 'none' | 'left' | 'right' | 'justified'


@dataclass
class TextFeatures:
    blocks: list[TextBlock]
    mean_text_size: float  # Mean major-axis length of text CCs (for segment filtering)
    binary: np.ndarray  # Binary image for debugging document-region detection

    @property
    def lines(self) -> list[TextLine]:
        return [ln for b in self.blocks for ln in b.lines]

    @property
    def high_confidence_lines(self) -> list[TextLine]:
        return [ln for ln in self.lines if ln.high_confidence]

    @property
    def uses_confidence_filter(self) -> bool:
        """Use structural filtering only when at least two strong lines exist.

        Falling back to every validated line preserves the previous behavior on
        documents consisting only of short CJK lines, labels, or sparse text.
        """
        return len(self.high_confidence_lines) >= 2


def binarize(gray: np.ndarray) -> np.ndarray:
    """Binarize with dark text as the foreground (255)."""
    # Derive the block size from the image so the window remains much wider
    # than a character even for large images.
    block = max(31, (min(gray.shape) // 20) | 1)
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 15
    )
    # In images with a black background (CBDAR has black margins), the inverted
    # side may become text. Rebuild with Otsu if the foreground ratio is too high.
    if binary.mean() > 0.5 * 255:
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        if binary.mean() > 0.5 * 255:
            binary = cv2.bitwise_not(binary)
    return binary


def binarize_light(gray: np.ndarray) -> np.ndarray:
    """Binarize with light text, such as reversed or white slide text, as foreground.

    Detecting only dark text would miss all text on slides with a blue
    background and white lettering, so both polarities are supported.
    """
    block = max(31, (min(gray.shape) // 20) | 1)
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, -15
    )
    if binary.mean() > 0.5 * 255:
        return np.zeros_like(binary)  # Invalid if the entire image is foreground (e.g. blank paper)
    return binary


@dataclass
class _CC:
    center: np.ndarray  # (2,)
    x0: float
    x1: float
    y0: float
    y1: float
    height: float
    major_axis: float


def _extract_ccs(binary: np.ndarray) -> list[_CC]:
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)
    h_img, w_img = binary.shape
    ccs: list[_CC] = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 8 or h < 3:
            continue  # Noise
        if h > 0.05 * h_img or w > 0.2 * w_img:
            continue  # Exclude rules, figures, and borders
        aspect = w / h
        if aspect > 15 or aspect < 1 / 15:
            continue  # Thin elongated line
        ccs.append(
            _CC(
                center=centroids[i].astype(np.float64),
                x0=float(x),
                x1=float(x + w),
                y0=float(y),
                y1=float(y + h),
                height=float(h),
                major_axis=float(max(w, h)),
            )
        )
    return ccs


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, a: int) -> int:
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def _link_ccs_into_lines(ccs: list[_CC]) -> list[list[_CC]]:
    """Form lines by chaining neighboring CCs horizontally."""
    if not ccs:
        return []
    med_h = float(np.median([c.height for c in ccs]))
    # Chain only text-sized CCs to exclude noise and fragments of illustrations.
    ccs = [c for c in ccs if 0.25 * med_h <= c.height <= 4.0 * med_h]
    if not ccs:
        return []
    order = np.argsort([c.center[0] for c in ccs])
    uf = _UnionFind(len(ccs))
    # Base linking conditions on the local height of each CC pair. In images
    # containing many small CCs from map symbols or figures, the global median
    # diverges from the body-text height and splits body lines. Use a generous
    # global value only as the search cutoff for breaking the loop.
    h90 = float(np.percentile([c.height for c in ccs], 90))
    reach = 2.5 * max(med_h, h90)
    for oi, i in enumerate(order):
        ci = ccs[i]
        # Looking only at neighbors to the right is sufficient for chaining.
        # Allow up to 2.5 character heights to bridge inter-word spaces of about
        # one or two characters. _validate_line rejects false links with a
        # quadratic-fit check.
        for j in order[oi + 1 :]:
            cj = ccs[j]
            if cj.x0 - ci.x1 > reach:
                break  # Sorted by x, so all subsequent CCs are farther away
            pair_h = 0.5 * (ci.height + cj.height)
            dy = abs(cj.center[1] - ci.center[1])
            v_overlap = min(ci.y1, cj.y1) - max(ci.y0, cj.y0)
            if (
                cj.x0 - ci.x1 <= 2.5 * pair_h
                and dy < 0.5 * pair_h
                and v_overlap > 0.3 * min(ci.height, cj.height)
            ):
                uf.union(i, j)
    groups: dict[int, list[_CC]] = {}
    for i, c in enumerate(ccs):
        groups.setdefault(uf.find(i), []).append(c)
    lines = []
    for g in groups.values():
        # Retain short lines such as slide bullets. Hangul and CJK characters
        # produce one CC per character, so four CCs are enough for _validate_line
        # to determine whether the group is line-like.
        if len(g) < 4:
            continue
        g.sort(key=lambda c: c.center[0])
        if _validate_line(g, med_h):
            lines.append(g)
    return lines


def _validate_line(g: list[_CC], med_h: float) -> bool:
    """Check whether a line group resembles a text line, rejecting noise.

    Width and residual thresholds use the line's own local character height.
    The global median ``med_h`` can be distorted by images containing many
    small CCs, so it is used only as a minimum gate.
    """
    pts = np.array([c.center for c in g])
    heights = np.array([c.height for c in g])
    line_h = float(np.median(heights))
    width = pts[-1, 0] - pts[0, 0]
    if width < 3.0 * line_h:
        return False  # Too short
    # Fit a quadratic to allow curvature, then check endpoint slopes and residuals.
    coef = np.polyfit(pts[:, 0], pts[:, 1], 2)
    slope_ends = np.polyval(np.polyder(coef), [pts[0, 0], pts[-1, 0]])
    if np.max(np.abs(slope_ends)) > 0.6:  # Reject slopes over approximately 31°
        return False
    resid = pts[:, 1] - np.polyval(coef, pts[:, 0])
    if np.sqrt(np.mean(resid**2)) > 0.6 * line_h:
        return False  # Excessive scatter (a cluster of texture noise)
    # Lower bound on CC height (minimum gate based on the global value).
    if line_h < 0.3 * med_h:
        return False
    return True


def _is_high_confidence_line(g: list[_CC]) -> bool:
    """Identify text structure strong enough to constrain page geometry.

    Illustration strokes often pass the permissive four-component validation,
    but tend to be short and have inconsistent component heights. Geometry
    fitting uses this stricter classification while extraction/debugging keeps
    every validated candidate. Thresholds are dimensionless except for the
    component count and therefore scale with the text itself.
    """
    heights = np.array([c.height for c in g], dtype=np.float64)
    centers = np.array([c.center for c in g], dtype=np.float64)
    median_height = float(np.median(heights))
    normalized_width = float(np.ptp(centers[:, 0])) / max(median_height, 1e-6)
    height_cv = float(np.std(heights) / max(np.mean(heights), 1e-6))
    return (
        len(g) >= 12
        and normalized_width >= 8.0
        and height_cv <= 0.5
    )


def _group_lines_into_blocks(lines: list[list[_CC]]) -> list[list[list[_CC]]]:
    """Group lines into blocks by horizontal overlap and vertical proximity."""
    if not lines:
        return []
    n = len(lines)
    spans = [(g[0].center[0], g[-1].center[0]) for g in lines]
    ys = [float(np.median([c.center[1] for c in g])) for g in lines]
    heights = [float(np.median([c.height for c in g])) for g in lines]
    uf = _UnionFind(n)
    for i in range(n):
        for j in range(i + 1, n):
            ov = min(spans[i][1], spans[j][1]) - max(spans[i][0], spans[j][0])
            min_w = min(spans[i][1] - spans[i][0], spans[j][1] - spans[j][0])
            if min_w <= 0:
                continue
            gap = abs(ys[i] - ys[j])
            # Keep lines in one block even across blank paragraph lines. Splitting
            # blocks too finely weakens spacing/alignment constraints and makes
            # optimization more likely to remain in a local solution.
            if ov > 0.5 * min_w and gap < 14.0 * max(heights[i], heights[j]):
                uf.union(i, j)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(uf.find(i), []).append(i)
    blocks = []
    for idxs in groups.values():
        idxs.sort(key=lambda i: ys[i])
        blocks.append([lines[i] for i in idxs])
    return blocks


def extract_text_features(
    gray: np.ndarray, mask: np.ndarray | None = None
) -> TextFeatures:
    binary = binarize(gray)
    light = binarize_light(gray)
    if mask is not None:
        # Restrict extraction to the detected paper/object region so background
        # texture does not become false text lines.
        binary[mask == 0] = 0
        light[mask == 0] = 0
    # Combine CCs of both polarities to support reversed text. Height and
    # alignment checks within each line preserve quality even with mixed polarity.
    ccs = _extract_ccs(binary) + _extract_ccs(light)
    line_groups = _link_ccs_into_lines(ccs)
    block_groups = _group_lines_into_blocks(line_groups)

    blocks = []
    used_ccs: list[_CC] = []
    for bg in block_groups:
        block = TextBlock()
        for g in bg:
            centers = np.array([c.center for c in g])
            high_confidence = _is_high_confidence_line(g)
            block.lines.append(
                TextLine(centers=centers, high_confidence=high_confidence)
            )
            used_ccs.extend(g)
        blocks.append(block)

    # Keep the historical all-candidate scale estimate.  It controls LSD length
    # thresholds, so changing it together with geometry-line selection would
    # unnecessarily alter a second, independent feature source.
    if used_ccs:
        mean_text_size = float(np.mean([c.major_axis for c in used_ccs]))
    else:
        mean_text_size = 20.0
    return TextFeatures(blocks=blocks, mean_text_size=mean_text_size, binary=binary)
