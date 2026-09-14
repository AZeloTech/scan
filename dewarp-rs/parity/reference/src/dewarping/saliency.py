"""Salient-object detection for curved objects in real-world scenes.

When flattening curved objects in real-world scenes, such as bottles and cans,
features from the desk or background contaminate the surface estimate.
The detector identifies a salient planar object and restricts text and
line-segment extraction to that region:

1. Partition the image into SLIC-like superpixels (implemented locally because
   opencv-headless does not include ximgproc).
2. Construct a graph whose vertices are regions, whose edges connect adjacent
   and two-hop regions, and whose affinity weights derive from Lab color
   differences. Regions on the image border are mutually connected in a closed
   loop.
3. Stage 1: perform manifold ranking with the regions along each image edge
   (top, bottom, left, and right) as queries. Compute their relevance using
   ``f* = (D - αW)^{-1} y`` and use the product of the complements as the
   background score.
4. Stage 2: threshold the Stage 1 result at its mean to form a foreground query,
   then use the reranked result as the final saliency.
"""

from __future__ import annotations

import cv2
import numpy as np

WORK_MAX_SIDE = 400  # Maximum resized-image side used for saliency
N_SUPERPIXELS = 300  # Target number of superpixels
ALPHA = 0.99  # Manifold-ranking smoothing parameter
SIGMA2 = 0.1  # Edge-weight color-difference scale (Lab normalized to [0,1])


def _slic(lab: np.ndarray, step: int, iters: int = 8, m: float = 20.0) -> np.ndarray:
    """Segment an image into superpixels using SLIC (local k-means).

    ``lab`` is a float32 Lab image on OpenCV's 8-bit scale (0-255). The return
    value is an ``(h, w)`` int32 label map compacted to ``0..K-1``.
    """
    h, w = lab.shape[:2]
    ys = np.arange(step // 2, h, step)
    xs = np.arange(step // 2, w, step)
    cyy, cxx = np.meshgrid(ys, xs, indexing="ij")
    cy = cyy.ravel().astype(np.float64)
    cx = cxx.ravel().astype(np.float64)
    K = len(cy)
    cc = lab[cy.astype(int), cx.astype(int)].astype(np.float64)  # (K, 3)

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    labels = np.zeros((h, w), np.int32)
    dist = np.empty((h, w), np.float64)
    for _ in range(iters):
        dist.fill(np.inf)
        labels.fill(0)
        for k in range(K):
            y0 = max(int(cy[k]) - step, 0)
            y1 = min(int(cy[k]) + step + 1, h)
            x0 = max(int(cx[k]) - step, 0)
            x1 = min(int(cx[k]) + step + 1, w)
            patch = lab[y0:y1, x0:x1].astype(np.float64)
            dc = np.linalg.norm(patch - cc[k], axis=2)
            ds = np.hypot(yy[y0:y1, x0:x1] - cy[k], xx[y0:y1, x0:x1] - cx[k])
            d = dc + (m / step) * ds
            sub = dist[y0:y1, x0:x1]
            better = d < sub
            sub[better] = d[better]
            labels[y0:y1, x0:x1][better] = k
        flat = labels.ravel()
        cnt = np.maximum(np.bincount(flat, minlength=K), 1)
        cy = np.bincount(flat, weights=yy.ravel(), minlength=K) / cnt
        cx = np.bincount(flat, weights=xx.ravel(), minlength=K) / cnt
        for c in range(3):
            cc[:, c] = (
                np.bincount(flat, weights=lab[:, :, c].ravel().astype(np.float64),
                            minlength=K) / cnt
            )
    # Remove gaps left by empty labels.
    _, labels = np.unique(labels, return_inverse=True)
    return labels.reshape(h, w).astype(np.int32)


def _ranking_matrix(labels: np.ndarray, lab: np.ndarray) -> tuple[np.ndarray, int]:
    """Build the manifold-ranking matrix ``A = (D - αW)^{-1}``."""
    h, w = labels.shape
    K = int(labels.max()) + 1
    flat = labels.ravel()
    cnt = np.maximum(np.bincount(flat, minlength=K), 1)
    # Mean color of each region (Lab normalized to [0,1]).
    colors = np.stack(
        [
            np.bincount(flat, weights=lab[:, :, c].ravel().astype(np.float64),
                        minlength=K) / cnt
            for c in range(3)
        ],
        axis=1,
    ) / 255.0

    # Adjacency graph from horizontally and vertically neighboring pixel pairs.
    adj = np.zeros((K, K), dtype=bool)
    for a, b in (
        (labels[:, :-1].ravel(), labels[:, 1:].ravel()),
        (labels[:-1, :].ravel(), labels[1:, :].ravel()),
    ):
        ne = a != b
        adj[a[ne], b[ne]] = True
        adj[b[ne], a[ne]] = True
    # Also connect two-hop neighbors.
    adj2 = adj | (adj.astype(np.uint8) @ adj.astype(np.uint8) > 0)
    # Mutually connect regions on the image border (closed loop).
    border = np.unique(
        np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    )
    adj2[np.ix_(border, border)] = True
    np.fill_diagonal(adj2, False)

    diff = np.linalg.norm(colors[:, None, :] - colors[None, :, :], axis=2)
    W = np.where(adj2, np.exp(-diff / SIGMA2), 0.0)
    D = np.diag(W.sum(axis=1))
    A = np.linalg.inv(D - ALPHA * W)
    return A, K


def _rank(A: np.ndarray, y: np.ndarray) -> np.ndarray:
    f = A @ y
    lo, hi = f.min(), f.max()
    return (f - lo) / (hi - lo) if hi > lo else np.zeros_like(f)


def salient_object_mask(img_bgr: np.ndarray) -> np.ndarray | None:
    """Return a salient-object mask at input resolution (0/1 uint8), or ``None``."""
    h, w = img_bgr.shape[:2]
    ratio = WORK_MAX_SIDE / max(h, w)
    if ratio < 1.0:
        small = cv2.resize(
            img_bgr, (round(w * ratio), round(h * ratio)),
            interpolation=cv2.INTER_AREA,
        )
    else:
        small = img_bgr
    sh, sw = small.shape[:2]
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2Lab).astype(np.float32)

    step = max(8, int(round(np.sqrt(sh * sw / N_SUPERPIXELS))))
    labels = _slic(lab, step)
    A, K = _ranking_matrix(labels, lab)

    # Stage 1: estimate background likelihood using each image edge as a query.
    sal = np.ones(K)
    for seed in (labels[0], labels[-1], labels[:, 0], labels[:, -1]):
        y = np.zeros(K)
        y[np.unique(seed)] = 1.0
        sal *= 1.0 - _rank(A, y)
    # Stage 2: rerank using a foreground query.
    y2 = (sal > sal.mean()).astype(np.float64)
    if y2.sum() == 0:
        return None
    sal2 = _rank(A, y2)

    sal_pix = (sal2[labels] * 255).astype(np.uint8)
    _, binmask = cv2.threshold(sal_pix, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    n, lab_cc, stats, _ = cv2.connectedComponentsWithStats((binmask > 0).astype(np.uint8), 8)
    if n <= 1:
        return None
    idx = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    mask = (lab_cc == idx).astype(np.uint8)
    # Reject regions that are too small or cover almost the entire image.
    frac = mask.sum() / mask.size
    if not (0.05 <= frac <= 0.92):
        return None
    # Fill the contour (including holes inside the object), then dilate slightly
    # to retain line segments on the outline.
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 1, -1)
    filled = cv2.dilate(filled, np.ones((7, 7), np.uint8))
    if ratio < 1.0:
        filled = cv2.resize(filled, (w, h), interpolation=cv2.INTER_NEAREST)
    return filled
