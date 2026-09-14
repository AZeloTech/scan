//! Connected components with stats — `cv2.connectedComponentsWithStats`
//! Two-pass union-find labelling, 8-connectivity
//! only (the pipeline never requests 4-connectivity).
//!
//! Call sites: `textline.py:105` (`_extract_ccs`, needs `stats[x,y,w,h,area]`
//! **and float64 centroids** — the centroid becomes the text-line point
//! cloud, so it must match to sub-pixel precision), `linesegs.py:216`
//! (paper-region largest-CC search). `saliency.py:160` is scene-only, not
//! ported.
//!
//! Port note: accumulate `Σx, Σy` per label during the same
//! pass that computes bbox/area; `centroid = Σ / area` as `f64` — do not
//! round through an intermediate `f32` or integer average.
//!
//! ## Label numbering — deliberately NOT bit-identical to `cv2`
//!
//! OpenCV's default connected-components algorithm for 8-connectivity is a
//! block-based decision-tree labeller (Grana's BBDT), and even a naive
//! two-pass scan doesn't reproduce its exact numeric label IDs — verified
//! empirically against `cv2` ground truth: a hand-traced 2×2 + 1×1 +
//! 1×1 + L-shape test case gets labels `{1,2,3,4}` from `cv2` in a *different*
//! order (`A=1,B=2,D=3,C=4`, not raster-first-appearance `A=1,B=2,C=3,D=4`)
//! than any single-pixel-at-a-time raster-order labeller produces. **This
//! does not matter for correctness**: both of this crate's call sites
//! (`textline._extract_ccs`, `linesegs.detect_paper_region`) only iterate
//! `1..n` reading `stats[i]`/`centroids[i]` for **each** component
//! independently, or pick `argmax` over areas — neither compares label IDs
//! *across* implementations. The S2 parity tolerance only requires the
//! **raw CC count** to be exact and per-line centroids to be within `0.5px`
//! RMS, never label-ID parity. This module's tests
//! therefore compare the **set** of `(area, bbox, centroid)` tuples against
//! `cv2` ground truth, order-independent, rather than the raw label grid.

/// One connected component's stats, matching
/// `cv2.connectedComponentsWithStats`'s per-row layout
/// (`stats[i] = [x, y, w, h, area]`) plus the float64 centroid from the
/// separate `centroids` output array.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ComponentStats {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub area: u32,
    /// `f64` centroid — `textline.py:119`'s `centroids[i].astype(np.float64)`.
    pub centroid: (f64, f64),
}

/// Output of one `connected_components_with_stats` call. `labels` is a
/// `width * height` row-major label image (label `0` = background,
/// matching OpenCV's convention); `stats[0]` is the background component's
/// stats (present for index alignment with OpenCV, generally unused by
/// callers, which all start their loop at index 1 — `textline.py:108`,
/// `linesegs.py:219`).
#[derive(Debug, Clone)]
pub struct ConnectedComponents {
    pub labels: Vec<u32>,
    pub width: u32,
    pub height: u32,
    pub stats: Vec<ComponentStats>,
}

/// 8-connectivity only — the one connectivity value every call site in this
/// pipeline uses (`connectivity=8` at every `cv2.connectedComponentsWithStats`
/// call).
///
/// Two-pass union-find: pass 1 assigns
/// provisional labels in raster order, unioning a new foreground pixel with
/// any already-labeled neighbor among {W, NW, N, NE} (the four
/// already-scanned 8-neighbors); pass 2 resolves each provisional label to
/// its union-find root and compacts roots to a dense `1..=n` numbering
/// (order = first raster appearance of each root — see the module doc
/// comment for why this numbering doesn't need to match `cv2`'s).
/// `binary` is nonzero = foreground, any nonzero value.
pub fn connected_components_with_stats(
    binary: &[u8],
    width: u32,
    height: u32,
) -> ConnectedComponents {
    let w = width as usize;
    let h = height as usize;
    assert_eq!(binary.len(), w * h);

    let mut provisional = vec![0u32; w * h]; // 0 = unlabeled/background
    let mut parent: Vec<u32> = vec![0]; // union-find; index 0 unused (labels start at 1)

    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            parent[x as usize] = parent[parent[x as usize] as usize];
            x = parent[x as usize];
        }
        x
    }
    fn union(parent: &mut [u32], a: u32, b: u32) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            let (lo, hi) = if ra < rb { (ra, rb) } else { (rb, ra) };
            parent[hi as usize] = lo;
        }
    }

    // Pass 1: provisional labels.
    for y in 0..h {
        for x in 0..w {
            if binary[y * w + x] == 0 {
                continue;
            }
            let mut neighbor_labels: Vec<u32> = Vec::with_capacity(4);
            // W
            if x > 0 && provisional[y * w + x - 1] != 0 {
                neighbor_labels.push(provisional[y * w + x - 1]);
            }
            if y > 0 {
                // NW, N, NE
                if x > 0 && provisional[(y - 1) * w + x - 1] != 0 {
                    neighbor_labels.push(provisional[(y - 1) * w + x - 1]);
                }
                if provisional[(y - 1) * w + x] != 0 {
                    neighbor_labels.push(provisional[(y - 1) * w + x]);
                }
                if x + 1 < w && provisional[(y - 1) * w + x + 1] != 0 {
                    neighbor_labels.push(provisional[(y - 1) * w + x + 1]);
                }
            }
            if neighbor_labels.is_empty() {
                let new_label = parent.len() as u32;
                parent.push(new_label);
                provisional[y * w + x] = new_label;
            } else {
                let first = neighbor_labels[0];
                provisional[y * w + x] = first;
                for &lbl in &neighbor_labels[1..] {
                    union(&mut parent, first, lbl);
                }
            }
        }
    }

    // Pass 2: resolve roots, compact to dense 1..=n in order of first
    // raster appearance of each root.
    let mut root_to_final: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();
    let mut next_final = 1u32;
    let mut labels = vec![0u32; w * h];
    // Accumulators, index 0 reserved for background (kept for OpenCV index
    // alignment — see the struct doc comment).
    struct Acc {
        min_x: u32,
        min_y: u32,
        max_x: u32,
        max_y: u32,
        area: u32,
        sum_x: f64,
        sum_y: f64,
    }
    // Index 0 = background; accumulated in the same pass as every other
    // label below (kept for OpenCV index alignment — see the struct doc
    // comment; `x`/`y`/`width`/`height` for the background row are set to
    // the whole-image bounds when building `stats`, matching `cv2`'s own
    // background bbox convention).
    let mut accs: Vec<Acc> = vec![Acc {
        min_x: 0,
        min_y: 0,
        max_x: 0,
        max_y: 0,
        area: 0,
        sum_x: 0.0,
        sum_y: 0.0,
    }];

    for y in 0..h {
        for x in 0..w {
            let p = provisional[y * w + x];
            if p == 0 {
                let acc = &mut accs[0];
                acc.area += 1;
                acc.sum_x += x as f64;
                acc.sum_y += y as f64;
                continue;
            }
            let root = find(&mut parent, p);
            let final_label = *root_to_final.entry(root).or_insert_with(|| {
                let l = next_final;
                next_final += 1;
                accs.push(Acc {
                    min_x: x as u32,
                    min_y: y as u32,
                    max_x: x as u32,
                    max_y: y as u32,
                    area: 0,
                    sum_x: 0.0,
                    sum_y: 0.0,
                });
                l
            });
            labels[y * w + x] = final_label;
            let acc = &mut accs[final_label as usize];
            acc.min_x = acc.min_x.min(x as u32);
            acc.min_y = acc.min_y.min(y as u32);
            acc.max_x = acc.max_x.max(x as u32);
            acc.max_y = acc.max_y.max(y as u32);
            acc.area += 1;
            acc.sum_x += x as f64;
            acc.sum_y += y as f64;
        }
    }

    let mut stats = Vec::with_capacity(accs.len());
    for (i, a) in accs.iter().enumerate() {
        if i == 0 {
            let (cx, cy) = if a.area > 0 {
                (a.sum_x / a.area as f64, a.sum_y / a.area as f64)
            } else {
                (0.0, 0.0)
            };
            stats.push(ComponentStats {
                x: 0,
                y: 0,
                width,
                height,
                area: a.area,
                centroid: (cx, cy),
            });
            continue;
        }
        let cx = a.sum_x / a.area as f64;
        let cy = a.sum_y / a.area as f64;
        stats.push(ComponentStats {
            x: a.min_x,
            y: a.min_y,
            width: a.max_x - a.min_x + 1,
            height: a.max_y - a.min_y + 1,
            area: a.area,
            centroid: (cx, cy),
        });
    }

    ConnectedComponents {
        labels,
        width,
        height,
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(area, x, y, w, h, centroid)` tuples for every **foreground**
    /// component (index `>=1`), sorted for order-independent comparison —
    /// see the module doc comment for why label *order* isn't part of the
    /// parity contract.
    fn foreground_set(cc: &ConnectedComponents) -> Vec<(u32, u32, u32, u32, u32, (i64, i64))> {
        let mut v: Vec<_> = cc.stats[1..]
            .iter()
            .map(|s| {
                // Centroids compared at 1e-6 precision via scaled integers
                // so the Vec can be sorted/deduped exactly.
                let cx = (s.centroid.0 * 1_000_000.0).round() as i64;
                let cy = (s.centroid.1 * 1_000_000.0).round() as i64;
                (s.area, s.x, s.y, s.width, s.height, (cx, cy))
            })
            .collect();
        v.sort();
        v
    }

    fn scaled(v: f64) -> i64 {
        (v * 1_000_000.0).round() as i64
    }

    /// `cv2.connectedComponentsWithStats(src, connectivity=8)` ground truth
    /// — 4 separate foreground components including one diagonal-adjacency
    /// case (8-connectivity), compared as an order-independent set
    /// (see module doc comment) plus an exact background-row check.
    #[test]
    fn matches_opencv_stats_as_a_set() {
        #[rustfmt::skip]
        let src: &[u8] = &[
            1, 1, 0, 0, 0, 1,
            1, 1, 0, 0, 0, 0,
            0, 0, 0, 1, 0, 0,
            0, 1, 0, 1, 1, 0,
            0, 0, 0, 0, 0, 0,
        ];
        let cc = connected_components_with_stats(src, 6, 5);
        assert_eq!(cc.stats.len(), 5); // background + 4 components

        // Background row: bbox = whole image, area = 30 - 9 = 21.
        assert_eq!(cc.stats[0].x, 0);
        assert_eq!(cc.stats[0].y, 0);
        assert_eq!(cc.stats[0].width, 6);
        assert_eq!(cc.stats[0].height, 5);
        assert_eq!(cc.stats[0].area, 21);

        let got = foreground_set(&cc);
        let expected = {
            let mut v = vec![
                (4u32, 0u32, 0u32, 2u32, 2u32, (scaled(0.5), scaled(0.5))),
                (1, 5, 0, 1, 1, (scaled(5.0), scaled(0.0))),
                (1, 1, 3, 1, 1, (scaled(1.0), scaled(3.0))),
                (
                    3,
                    3,
                    2,
                    2,
                    2,
                    (scaled(3.333_333_333_333_333), scaled(2.666_666_666_666_667)),
                ),
            ];
            v.sort();
            v
        };
        assert_eq!(got, expected);
    }

    /// Three pixels on a diagonal, each only touching the next via a
    /// corner — must merge into ONE component under 8-connectivity (the
    /// pipeline's only connectivity mode). `cv2` ground truth: `n=2`
    /// (background + 1), bbox `(0,0,3,3)`, area 3, centroid `(1,1)`.
    #[test]
    fn diagonal_chain_merges_under_8_connectivity() {
        #[rustfmt::skip]
        let src: &[u8] = &[
            1, 0, 0,
            0, 1, 0,
            0, 0, 1,
        ];
        let cc = connected_components_with_stats(src, 3, 3);
        assert_eq!(cc.stats.len(), 2); // background + exactly one component
        let comp = cc.stats[1];
        assert_eq!(
            (comp.x, comp.y, comp.width, comp.height, comp.area),
            (0, 0, 3, 3, 3)
        );
        assert!((comp.centroid.0 - 1.0).abs() < 1e-9);
        assert!((comp.centroid.1 - 1.0).abs() < 1e-9);
    }

    #[test]
    fn all_background_has_no_components() {
        let src = vec![0u8; 20];
        let cc = connected_components_with_stats(&src, 5, 4);
        assert_eq!(cc.stats.len(), 1);
        assert_eq!(cc.stats[0].area, 20);
    }

    #[test]
    fn labels_are_self_consistent_with_stats() {
        #[rustfmt::skip]
        let src: &[u8] = &[
            1, 1, 0, 0, 0, 1,
            1, 1, 0, 0, 0, 0,
            0, 0, 0, 1, 0, 0,
            0, 1, 0, 1, 1, 0,
            0, 0, 0, 0, 0, 0,
        ];
        let cc = connected_components_with_stats(src, 6, 5);
        // Every foreground pixel's label must point at a stats row whose
        // bbox contains that pixel, and vice versa: each stats row's `area`
        // must equal the number of pixels carrying its label.
        let mut counts = vec![0u32; cc.stats.len()];
        for (i, &lbl) in cc.labels.iter().enumerate() {
            counts[lbl as usize] += 1;
            let x = (i % 6) as u32;
            let y = (i / 6) as u32;
            let s = &cc.stats[lbl as usize];
            if lbl != 0 {
                assert!(x >= s.x && x < s.x + s.width);
                assert!(y >= s.y && y < s.y + s.height);
            }
        }
        for (i, s) in cc.stats.iter().enumerate() {
            assert_eq!(counts[i], s.area, "label {i} area mismatch");
        }
    }
}
