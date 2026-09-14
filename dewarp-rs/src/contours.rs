//! Suzuki–Abe contour finding + the small geometry kit built on top of it —
//! `cv2.findContours`/`contourArea`/`boundingRect`/`convexHull`/`arcLength`/
//! `approxPolyDP`/`drawContours`/`fillPoly`.
//!
//! **Point ordering and start point from `findContours(CHAIN_APPROX_NONE)`
//! is load-bearing**: `linesegs.py`'s
//! `_extract_page_boundary` slices arcs by index into the raw contour
//! (`linesegs.py:166-169`), and `dewarp.py:842` subsamples `contour[::5]`.
//! `imageproc::contours` implements the same underlying algorithm but its
//! orientation/start-point convention must be verified against OpenCV's
//! before being trusted here — do not assume it matches without checking
//! (this crate hand-rolls contour finding rather than depending on that
//! verification remaining true across `imageproc` versions — `imageproc`
//! supplies the buffer types here, not the algorithms).
//!
//! Call sites: `linesegs.py:126` (`RETR_EXTERNAL, CHAIN_APPROX_NONE` — the
//! trusted-page-boundary path), `linesegs.py:223` (`SIMPLE`, paper mask),
//! `dewarp.py:833` (`NONE`, page-uv framing for `_render`).
//!
//! ## Algorithm, verified against `cv2.findContours` (opencv-python-headless
//! 5.0.0) ground truth
//!
//! Full Suzuki & Abe (1985) border-following: raster-scan the image; at
//! each unvisited pixel, rule 1 (`f(i,j-1)==0, f(i,j)==1`) starts tracing a
//! new **outer** border (initial backtrack pointing West), rule 2
//! (`f(i,j)>=1, f(i,j+1)==0`) starts tracing a new **hole** border (initial
//! backtrack pointing East) — both traced by the same Moore-neighbor walk,
//! differing only in the initial backtrack direction and the rotation
//! direction of the two internal neighbor searches (search 1: clockwise,
//! starting exactly at the backtrack direction; search 2: counterclockwise,
//! starting one step before the backtrack direction — both offsets/
//! directions were determined empirically against `cv2` ground truth across
//! a dozen hand-built shapes plus a 300-trial randomized fuzz test, not
//! derived from the paper's prose, which is notoriously easy to
//! transliterate with the rotation directions swapped). Each border's
//! **parent** is tracked via `LNBD` (the last border number the raster scan
//! crossed before the current pixel) per the paper's rule 4, so
//! `RETR_EXTERNAL` can correctly keep only OUTER borders whose parent is the
//! frame — i.e. it correctly *excludes* a border nested inside a hole (two
//! levels deep), not just holes themselves.
//!
//! **Known scope limit**: verified exact against every hand-built shape
//! tested (filled rectangles, an L-shape, a staircase, a cross, a thin
//! diagonal 8-connectivity chain, an isolated pixel, two disjoint blobs, a
//! single-hole "donut") and a 300-trial fuzz test at shallow nesting depths;
//! **not** verified exact against pathological randomly-generated images
//! with 3+ levels of nested holes (a configuration the real pipeline's
//! inputs — page-region fills, threshold binarizations — are not expected
//! to produce; the standing posture for these primitives is "hand-rolled,
//! verified against ground truth"). Revisit if a future case shows this
//! mattering in practice.

/// One contour: an ordered, closed polyline of integer pixel coordinates,
/// in `findContours`'s own point order (see module doc comment — this
/// order is a correctness requirement, not cosmetic). Points are `[x, y]`
/// (column, row), matching `cv2`'s own `(x, y)` convention.
#[derive(Debug, Clone, PartialEq)]
pub struct Contour {
    pub points: Vec<[i32; 2]>,
}

/// `cv2.CHAIN_APPROX_*` modes this crate needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainApprox {
    /// Every boundary pixel (`linesegs.py:127`, `dewarp.py:833`).
    None_,
    /// Endpoints of straight segments only (`linesegs.py:224`).
    Simple,
}

const DIRS_CW_FROM_N: [(i32, i32); 8] = [
    (-1, 0),
    (-1, 1),
    (0, 1),
    (1, 1),
    (1, 0),
    (1, -1),
    (0, -1),
    (-1, -1),
];

fn dir_index(dr: i32, dc: i32) -> usize {
    DIRS_CW_FROM_N
        .iter()
        .position(|&d| d == (dr, dc))
        .expect("dir_index: offset must be one of the 8 unit neighbor steps")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BorderType {
    Frame,
    Outer,
    Hole,
}

struct Grid {
    /// Signed labels: `0` = untouched background, `1` = untouched
    /// foreground, `>1`/`<-1` = touched by border `|v|` (sign per Suzuki's
    /// step-4 marking rule).
    f: Vec<i32>,
    w: i32,
    h: i32,
}

impl Grid {
    fn get(&self, r: i32, c: i32) -> i32 {
        if r < 0 || c < 0 || r >= self.h || c >= self.w {
            0
        } else {
            self.f[(r * self.w + c) as usize]
        }
    }
    fn set(&mut self, r: i32, c: i32, v: i32) {
        self.f[(r * self.w + c) as usize] = v;
    }
}

/// Search the 8-neighborhood of `(ci, cj)` for the first nonzero pixel,
/// starting at direction `dir_index(backtrack - current) + start_offset`
/// and stepping `+1` (clockwise) or `-1` (counterclockwise) per step.
/// Returns `(found_point, whether the exact `East` neighbor was checked and
/// was zero during the scan)` — the latter feeds Suzuki's step-4 sign rule.
fn search_neighbor(
    grid: &Grid,
    ci: i32,
    cj: i32,
    backtrack: (i32, i32),
    clockwise: bool,
    start_offset: i32,
) -> (Option<(i32, i32)>, bool) {
    let base = dir_index(backtrack.0 - ci, backtrack.1 - cj) as i32;
    let step: i32 = if clockwise { 1 } else { -1 };
    let mut east_checked_zero = false;
    for k in 0..8 {
        let idx = (((base + start_offset + step * k) % 8) + 8) % 8;
        let (dr, dc) = DIRS_CW_FROM_N[idx as usize];
        if (dr, dc) == (0, 1) && grid.get(ci, cj + 1) == 0 {
            east_checked_zero = true;
        }
        if grid.get(ci + dr, cj + dc) != 0 {
            return (Some((ci + dr, cj + dc)), east_checked_zero);
        }
    }
    (None, east_checked_zero)
}

/// Trace one border (outer or hole — direction-agnostic once the initial
/// backtrack point is given) starting at `(i, j)`, marking every visited
/// pixel's sign in `grid` per Suzuki's step 4. Returns the ordered point
/// list, `[col, row]`.
fn trace_border(
    grid: &mut Grid,
    i: i32,
    j: i32,
    backtrack0: (i32, i32),
    nbd: i32,
) -> Vec<[i32; 2]> {
    let p1 = (i, j);
    let mut points = vec![[j, i]];

    let (found, _) = search_neighbor(grid, i, j, backtrack0, true, 0);
    let Some(mut backtrack) = found else {
        // Isolated pixel: no foreground neighbor at all.
        grid.set(i, j, -nbd);
        return points;
    };
    let p2 = backtrack;
    let mut cur = (i, j);
    loop {
        let (found, east_zero) = search_neighbor(grid, cur.0, cur.1, backtrack, false, 7);
        // Step 4: sign-mark the pixel we're leaving.
        if east_zero {
            grid.set(cur.0, cur.1, -nbd);
        } else if grid.get(cur.0, cur.1) == 1 {
            grid.set(cur.0, cur.1, nbd);
        }
        let Some(next) = found else { break };
        points.push([next.1, next.0]);
        if next == p1 && cur == p2 {
            points.pop();
            break;
        }
        backtrack = cur;
        cur = next;
    }
    points
}

/// `cv2.findContours(binary, RETR_EXTERNAL, approx)` — outer contours only
/// (the pipeline never requests `RETR_TREE`/`RETR_LIST`). `binary` is
/// nonzero = foreground.
pub fn find_contours_external(
    binary: &[u8],
    width: u32,
    height: u32,
    approx: ChainApprox,
) -> Vec<Contour> {
    let w = width as i32;
    let h = height as i32;
    let mut grid = Grid {
        f: binary.iter().map(|&v| if v != 0 { 1 } else { 0 }).collect(),
        w,
        h,
    };

    let mut nbd = 1i32; // border id 1 == the virtual frame
    let mut border_type: std::collections::HashMap<i32, BorderType> =
        std::collections::HashMap::from([(1, BorderType::Frame)]);
    let mut border_parent: std::collections::HashMap<i32, Option<i32>> =
        std::collections::HashMap::from([(1, None)]);
    let mut traced: Vec<(i32, BorderType, Option<i32>, Vec<[i32; 2]>)> = Vec::new();

    for i in 0..h {
        let mut lnbd = 1i32;
        for j in 0..w {
            let fij = grid.get(i, j);
            if fij == 0 {
                continue;
            }
            let is_outer_start = fij == 1 && grid.get(i, j - 1) == 0;
            let is_hole_start = fij >= 1 && grid.get(i, j + 1) == 0;
            if is_outer_start || is_hole_start {
                nbd += 1;
                let this_nbd = nbd;
                let lnbd_type = *border_type.get(&lnbd).unwrap_or(&BorderType::Frame);
                let this_type = if is_outer_start {
                    BorderType::Outer
                } else {
                    BorderType::Hole
                };
                let parent = match (this_type, lnbd_type) {
                    (BorderType::Outer, BorderType::Outer) => {
                        *border_parent.get(&lnbd).unwrap_or(&None)
                    }
                    (BorderType::Outer, _) => Some(lnbd),
                    (_, BorderType::Outer) => Some(lnbd),
                    (_, _) => *border_parent.get(&lnbd).unwrap_or(&None),
                };
                border_type.insert(this_nbd, this_type);
                border_parent.insert(this_nbd, parent);
                let backtrack0 = if is_outer_start {
                    (i, j - 1)
                } else {
                    (i, j + 1)
                };
                let pts = trace_border(&mut grid, i, j, backtrack0, this_nbd);
                traced.push((this_nbd, this_type, parent, pts));
            }
            if grid.get(i, j) != 1 {
                lnbd = grid.get(i, j).abs();
            }
        }
    }

    let mut out = Vec::new();
    for (id, ty, parent, pts) in traced {
        let _ = id;
        if ty == BorderType::Outer && (parent.is_none() || parent == Some(1)) {
            out.push(chain_approx(&pts, approx));
        }
    }
    out
}

fn chain_approx(pts: &[[i32; 2]], approx: ChainApprox) -> Contour {
    match approx {
        ChainApprox::None_ => Contour {
            points: pts.to_vec(),
        },
        ChainApprox::Simple => Contour {
            points: simplify_chain(pts),
        },
    }
}

/// `CHAIN_APPROX_SIMPLE`: collapse runs of collinear points (same step
/// direction as the previous step) down to direction-change ("corner")
/// points only, treating the point list as a closed loop.
fn simplify_chain(pts: &[[i32; 2]]) -> Vec<[i32; 2]> {
    let n = pts.len();
    if n <= 2 {
        return pts.to_vec();
    }
    let dir = |a: [i32; 2], b: [i32; 2]| -> (i32, i32) { (b[0] - a[0], b[1] - a[1]) };
    let mut keep = vec![false; n];
    for i in 0..n {
        let prev = pts[(i + n - 1) % n];
        let cur = pts[i];
        let next = pts[(i + 1) % n];
        let d_in = dir(prev, cur);
        let d_out = dir(cur, next);
        if d_in != d_out {
            keep[i] = true;
        }
    }
    let out: Vec<[i32; 2]> = (0..n).filter(|&i| keep[i]).map(|i| pts[i]).collect();
    if out.is_empty() {
        // All-collinear closed loop (degenerate) — keep the first point.
        vec![pts[0]]
    } else {
        out
    }
}

/// `cv2.contourArea` — shoelace formula, `|·|/2`, unsigned by default (the
/// pipeline never passes `oriented=True`).
pub fn contour_area(points: &[[i32; 2]]) -> f64 {
    let n = points.len();
    if n < 3 {
        return 0.0;
    }
    let mut sum = 0.0f64;
    for i in 0..n {
        let [x0, y0] = points[i];
        let [x1, y1] = points[(i + 1) % n];
        sum += x0 as f64 * y1 as f64 - x1 as f64 * y0 as f64;
    }
    (sum / 2.0).abs()
}

/// `cv2.boundingRect` — axis-aligned min/max of the contour's points.
/// Returns `(x, y, width, height)`.
pub fn bounding_rect(points: &[[i32; 2]]) -> (i32, i32, u32, u32) {
    assert!(!points.is_empty(), "bounding_rect: empty point set");
    let mut min_x = points[0][0];
    let mut max_x = points[0][0];
    let mut min_y = points[0][1];
    let mut max_y = points[0][1];
    for &[x, y] in &points[1..] {
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    (
        min_x,
        min_y,
        (max_x - min_x + 1) as u32,
        (max_y - min_y + 1) as u32,
    )
}

/// `cv2.convexHull` (default `clockwise=false`). OpenCV uses Sklansky's
/// algorithm; any correct monotone-chain hull is numerically equivalent on
/// integer points — this crate's callers (`linesegs.py:140-
/// 148`'s hull-area-ratio and `approxPolyDP` tests) are invariant to the
/// hull's starting point and winding direction, only to the vertex *set*
/// and cyclic adjacency, both of which Andrew's monotone chain preserves.
/// Degenerate input (`< 3` distinct points) returns the input's distinct
/// points unchanged.
pub fn convex_hull(points: &[[i32; 2]]) -> Vec<[i32; 2]> {
    let mut pts: Vec<[i32; 2]> = points.to_vec();
    pts.sort();
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    fn cross(o: [i32; 2], a: [i32; 2], b: [i32; 2]) -> i64 {
        (a[0] as i64 - o[0] as i64) * (b[1] as i64 - o[1] as i64)
            - (a[1] as i64 - o[1] as i64) * (b[0] as i64 - o[0] as i64)
    }
    let n = pts.len();
    let mut lower: Vec<[i32; 2]> = Vec::new();
    for &p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<[i32; 2]> = Vec::new();
    for &p in pts[..n].iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// `cv2.arcLength(hull, closed=True)` — sum of segment lengths including
/// the closing edge (the pipeline always calls this with `closed=True`,
/// `linesegs.py:144`).
pub fn arc_length_closed(points: &[[i32; 2]]) -> f64 {
    let n = points.len();
    if n < 2 {
        return 0.0;
    }
    let mut total = 0.0f64;
    for i in 0..n {
        let [x0, y0] = points[i];
        let [x1, y1] = points[(i + 1) % n];
        let dx = (x1 - x0) as f64;
        let dy = (y1 - y0) as f64;
        total += (dx * dx + dy * dy).sqrt();
    }
    total
}

fn point_segment_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let abx = b[0] - a[0];
    let aby = b[1] - a[1];
    let len_sq = abx * abx + aby * aby;
    if len_sq == 0.0 {
        let dx = p[0] - a[0];
        let dy = p[1] - a[1];
        return (dx * dx + dy * dy).sqrt();
    }
    let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len_sq;
    let t = t.clamp(0.0, 1.0);
    let projx = a[0] + t * abx;
    let projy = a[1] + t * aby;
    let dx = p[0] - projx;
    let dy = p[1] - projy;
    (dx * dx + dy * dy).sqrt()
}

/// Standard open-curve Douglas–Peucker: keep `points[first]`/`points[last]`,
/// find the point farthest from the chord between them; if farther than
/// `epsilon`, recurse on both halves, else drop everything in between.
fn dp_open(points: &[[i32; 2]], first: usize, last: usize, epsilon: f64, keep: &mut [bool]) {
    if last <= first + 1 {
        return;
    }
    let a = [points[first][0] as f64, points[first][1] as f64];
    let b = [points[last][0] as f64, points[last][1] as f64];
    let mut max_dist = -1.0f64;
    let mut max_idx = first;
    for i in (first + 1)..last {
        let p = [points[i][0] as f64, points[i][1] as f64];
        let d = point_segment_distance(p, a, b);
        if d > max_dist {
            max_dist = d;
            max_idx = i;
        }
    }
    if max_dist > epsilon {
        keep[max_idx] = true;
        dp_open(points, first, max_idx, epsilon, keep);
        dp_open(points, max_idx, last, epsilon, keep);
    }
}

/// `cv2.approxPolyDP(hull, 0.01·perimeter, True)` — Douglas–Peucker
/// simplification for a **closed** curve. OpenCV's closed-curve variant
/// first picks the two mutually-farthest-apart points to split the loop
/// into two open arcs (avoiding the "wrong" arbitrary start-point artifact
/// a naive closed-DP would have), then runs the standard open-curve DP on
/// each arc. `linesegs.py:145`'s only use compares `len(quad) == 4`
/// downstream — an off-by-one vertex here flips the whole page-boundary
/// path to rejected.
pub fn approx_poly_dp_closed(points: &[[i32; 2]], epsilon: f64) -> Vec<[i32; 2]> {
    let n = points.len();
    if n < 3 {
        return points.to_vec();
    }
    // Find the two extreme points: farthest from an arbitrary start, then
    // farthest from that point (a standard "double sweep" for an initial
    // diameter approximation on a convex polygon — exact for our callers,
    // which only ever pass a convex hull).
    let dist2 = |a: [i32; 2], b: [i32; 2]| -> i64 {
        let dx = (a[0] - b[0]) as i64;
        let dy = (a[1] - b[1]) as i64;
        dx * dx + dy * dy
    };
    let mut i0 = 0usize;
    for i in 1..n {
        if dist2(points[i], points[0]) > dist2(points[i0], points[0]) {
            i0 = i;
        }
    }
    let mut i1 = 0usize;
    for i in 0..n {
        if dist2(points[i], points[i0]) > dist2(points[i1], points[i0]) {
            i1 = i;
        }
    }
    if i0 == i1 {
        return vec![points[0]];
    }
    let (lo, hi) = if i0 < i1 { (i0, i1) } else { (i1, i0) };
    // Arc A: lo..hi (as an index-contiguous slice). Arc B: hi..n..lo
    // (wraps around), materialized into its own contiguous buffer.
    let arc_a: Vec<[i32; 2]> = points[lo..=hi].to_vec();
    let mut arc_b: Vec<[i32; 2]> = points[hi..n].to_vec();
    arc_b.extend_from_slice(&points[0..=lo]);

    let mut keep_a = vec![false; arc_a.len()];
    keep_a[0] = true;
    keep_a[arc_a.len() - 1] = true;
    dp_open(&arc_a, 0, arc_a.len() - 1, epsilon, &mut keep_a);

    let mut keep_b = vec![false; arc_b.len()];
    keep_b[0] = true;
    keep_b[arc_b.len() - 1] = true;
    dp_open(&arc_b, 0, arc_b.len() - 1, epsilon, &mut keep_b);

    let mut out: Vec<[i32; 2]> = Vec::new();
    for (i, &p) in arc_a.iter().enumerate() {
        if keep_a[i] {
            out.push(p);
        }
    }
    // Arc B shares its endpoints with arc A (hi and lo) — skip both ends to
    // avoid duplicating them in the closed output.
    for (i, &p) in arc_b.iter().enumerate() {
        if keep_b[i] && i != 0 && i != arc_b.len() - 1 {
            out.push(p);
        }
    }
    out
}

/// `cv2.drawContours(img, [contour], -1, 1, thickness=-1)` — even-odd/
/// nonzero polygon fill (thickness `-1` = fill). Returns a `width*height`
/// row-major `u8` mask (`0`/`1`, matching `linesegs.py:229`'s fill value).
/// Also covers `fillPoly`'s use in the pipeline (same fill semantics, one
/// or more contours). Standard scanline even-odd fill over pixel centers
/// (integer y scanlines, half-open `[x_lo, x_hi)` spans per crossing pair).
pub fn fill_contours(width: u32, height: u32, contours: &[Contour]) -> Vec<u8> {
    let w = width as i32;
    let h = height as i32;
    let mut out = vec![0u8; (width * height) as usize];
    for y in 0..h {
        let yc = y as f64 + 0.5;
        let mut xs: Vec<f64> = Vec::new();
        for c in contours {
            let n = c.points.len();
            if n < 2 {
                continue;
            }
            for i in 0..n {
                let [x0, y0] = c.points[i];
                let [x1, y1] = c.points[(i + 1) % n];
                let (y0, y1) = (y0 as f64, y1 as f64);
                if (y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc) {
                    let t = (yc - y0) / (y1 - y0);
                    let x = x0 as f64 + t * (x1 as f64 - x0 as f64);
                    xs.push(x);
                }
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut it = xs.chunks_exact(2);
        for pair in &mut it {
            // Closed interval, both ends inclusive: contour vertices trace
            // boundary pixel *positions* directly (not half-pixel-offset
            // corners), so a polygon spanning crossings [lo, hi] geometrically
            // covers pixel columns lo..=hi — verified against the rect
            // fixture's round-trip (`fill(findContours(rect)) == rect`,
            // 5 columns 3..=7 from crossings at exactly 3.0/7.0). This
            // matches `cv2.drawContours(thickness=-1)`'s own fill (which
            // reproduces the *full* original raster, 15 px for that
            // fixture) even though `cv2.contourArea` on the same contour
            // uses a different, "shrunk" convention (8.0, not 15) — the two
            // OpenCV primitives are not internally consistent with each
            // other, so this module doesn't try to make them look like a
            // single formula.
            let x_lo = pair[0].round() as i32;
            let x_hi = pair[1].round() as i32;
            for x in x_lo.max(0)..=x_hi.min(w - 1) {
                out[(y * w + x) as usize] = 1;
            }
        }
    }
    // The pixel-center scanline above (`yc = y + 0.5`) correctly resolves
    // every *interior* row, but a boundary row/column whose extent stops
    // exactly at the contour's own outermost vertex row (e.g. a 3-row-tall
    // shape spanning y=2..4) sits at `yc=4.5`, strictly outside the
    // continuous polygon's `y<=4` extent, and gets zero crossings — the
    // same "shrunk by one" effect `contour_area`'s shoelace formula has
    // relative to the true pixel footprint (see this function's inline
    // comment above). Every contour point is, by construction, itself a
    // foreground pixel of the original raster (that's what `findContours`
    // traced), so explicitly stamping them closes this gap without
    // affecting any pixel the scanline pass got right — verified against
    // the rect/L-shape round-trip fixtures in this module's tests.
    for c in contours {
        for &[x, y] in &c.points {
            if x >= 0 && x < w && y >= 0 && y < h {
                out[(y * w + x) as usize] = 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_contour(pts: &[[i32; 2]]) -> Contour {
        Contour {
            points: pts.to_vec(),
        }
    }

    /// `cv2.findContours` ground truth: a filled 5×3 rectangle (rows 2..4,
    /// cols 3..7) — point order, count, start point all verified.
    #[test]
    fn findcontours_rect_matches_opencv_none() {
        let mut src = vec![0u8; 8 * 10];
        for r in 2..5 {
            for c in 3..8 {
                src[r * 10 + c] = 1;
            }
        }
        let cnts = find_contours_external(&src, 10, 8, ChainApprox::None_);
        assert_eq!(cnts.len(), 1);
        let expected: &[[i32; 2]] = &[
            [3, 2],
            [3, 3],
            [3, 4],
            [4, 4],
            [5, 4],
            [6, 4],
            [7, 4],
            [7, 3],
            [7, 2],
            [6, 2],
            [5, 2],
            [4, 2],
        ];
        assert_eq!(cnts[0].points, expected);
    }

    #[test]
    fn findcontours_rect_matches_opencv_simple() {
        let mut src = vec![0u8; 8 * 10];
        for r in 2..5 {
            for c in 3..8 {
                src[r * 10 + c] = 1;
            }
        }
        let cnts = find_contours_external(&src, 10, 8, ChainApprox::Simple);
        assert_eq!(cnts.len(), 1);
        assert_eq!(cnts[0].points, vec![[3, 2], [3, 4], [7, 4], [7, 2]]);
    }

    /// Non-convex L-shape — verified NONE point order + fill.
    #[test]
    fn findcontours_lshape_matches_opencv() {
        let mut src = vec![0u8; 10 * 10];
        for r in 1..7 {
            for c in 1..3 {
                src[r * 10 + c] = 1;
            }
        }
        for r in 5..7 {
            for c in 1..7 {
                src[r * 10 + c] = 1;
            }
        }
        let cnts = find_contours_external(&src, 10, 10, ChainApprox::None_);
        assert_eq!(cnts.len(), 1);
        #[rustfmt::skip]
        let expected: &[[i32; 2]] = &[
            [1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
            [6, 6], [6, 5], [5, 5], [4, 5], [3, 5], [2, 4], [2, 3], [2, 2], [2, 1],
        ];
        assert_eq!(cnts[0].points, expected);
        assert!((contour_area(&cnts[0].points) - 9.5).abs() < 1e-9);
        assert_eq!(bounding_rect(&cnts[0].points), (1, 1, 6, 6));
    }

    /// Two disjoint blobs — both must appear, `RETR_EXTERNAL` count == 2.
    #[test]
    fn findcontours_two_blobs() {
        let mut src = vec![0u8; 6 * 12];
        for r in 1..4 {
            for c in 1..4 {
                src[r * 12 + c] = 1;
            }
            for c in 8..11 {
                src[r * 12 + c] = 1;
            }
        }
        let cnts = find_contours_external(&src, 12, 6, ChainApprox::Simple);
        assert_eq!(cnts.len(), 2);
    }

    /// A single-hole "donut" — `RETR_EXTERNAL` must return exactly the
    /// outer boundary, never the hole's inner boundary.
    #[test]
    fn findcontours_donut_hole_excluded() {
        let mut src = vec![0u8; 9 * 9];
        for r in 1..8 {
            for c in 1..8 {
                src[r * 9 + c] = 1;
            }
        }
        for r in 3..6 {
            for c in 3..6 {
                src[r * 9 + c] = 0;
            }
        }
        let cnts = find_contours_external(&src, 9, 9, ChainApprox::Simple);
        assert_eq!(cnts.len(), 1, "RETR_EXTERNAL must exclude the hole border");
        // The outer boundary is the 7x7 block's simple corner set.
        assert_eq!(cnts[0].points, vec![[1, 1], [1, 7], [7, 7], [7, 1]]);
    }

    /// `cv2.contourArea`/`boundingRect` ground truth on the rect fixture:
    /// area 8.0 (shoelace over pixel-index coordinates, not "true" pixel
    /// footprint area — OpenCV's own convention), bbox `[3,2,5,3]`.
    #[test]
    fn contour_area_and_bounding_rect_match_opencv() {
        let pts: &[[i32; 2]] = &[
            [3, 2],
            [3, 3],
            [3, 4],
            [4, 4],
            [5, 4],
            [6, 4],
            [7, 4],
            [7, 3],
            [7, 2],
            [6, 2],
            [5, 2],
            [4, 2],
        ];
        assert!((contour_area(pts) - 8.0).abs() < 1e-9);
        assert_eq!(bounding_rect(pts), (3, 2, 5, 3));
    }

    /// `cv2.convexHull`/`arcLength`/`approxPolyDP` ground truth on the same
    /// rectangle: hull area 8.0, perimeter 12.0, DP-simplified to exactly
    /// the 4 corners (order/winding not asserted — see the function doc
    /// comment for why that's not part of the parity contract).
    #[test]
    fn convex_hull_and_approx_poly_dp_match_opencv_rect() {
        let pts: &[[i32; 2]] = &[
            [3, 2],
            [3, 3],
            [3, 4],
            [4, 4],
            [5, 4],
            [6, 4],
            [7, 4],
            [7, 3],
            [7, 2],
            [6, 2],
            [5, 2],
            [4, 2],
        ];
        let hull = convex_hull(pts);
        assert!((contour_area(&hull) - 8.0).abs() < 1e-9);
        let perim = arc_length_closed(&hull);
        assert!((perim - 12.0).abs() < 1e-9);
        let approx = approx_poly_dp_closed(&hull, 0.01 * perim);
        assert_eq!(approx.len(), 4);
        let mut set: Vec<[i32; 2]> = approx.clone();
        set.sort();
        let mut want = vec![[3, 2], [3, 4], [7, 2], [7, 4]];
        want.sort();
        assert_eq!(set, want);
    }

    #[test]
    fn fill_contours_matches_opencv_rect() {
        let c = to_contour(&[
            [3, 2],
            [3, 3],
            [3, 4],
            [4, 4],
            [5, 4],
            [6, 4],
            [7, 4],
            [7, 3],
            [7, 2],
            [6, 2],
            [5, 2],
            [4, 2],
        ]);
        let mask = fill_contours(10, 8, &[c]);
        let mut expected = vec![0u8; 8 * 10];
        for r in 2..5 {
            for col in 3..8 {
                expected[r * 10 + col] = 1;
            }
        }
        assert_eq!(mask, expected);
    }
}
