//! LSD line-segment post-processing + paper-region/page-boundary detection
//! — mirrors `linesegs.py` 1:1.
//!
//! `detect_line_segments` below calls into [`crate::lsd::detect`] for the
//! raw LSD segment set (empty when the `lsd` feature is off) and then
//! applies this module's own filters — those filters run unconditionally
//! either way, per `lsd::detect`'s own doc comment.

use image::{GrayImage, RgbImage};

/// `linesegs.EDGE_STRENGTH_MIN` (`linesegs.py:95`) — segments scoring below
/// this in [`edge_strength`] are dropped as low-contrast texture (e.g. desk
/// wood grain).
pub const EDGE_STRENGTH_MIN: f32 = 15.0;

/// `linesegs.LineSegments` (`linesegs.py:16-36`) — a collection of split
/// segments, one `[px, py, qx, qy]` per row.
#[derive(Debug, Clone, Default)]
pub struct LineSegments {
    pub segments: Vec<[f64; 4]>,
}

impl LineSegments {
    pub fn empty() -> Self {
        LineSegments {
            segments: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.segments.len()
    }

    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    /// `p` endpoints, `segments[:, 0:2]`.
    pub fn p(&self) -> Vec<[f64; 2]> {
        self.segments.iter().map(|s| [s[0], s[1]]).collect()
    }

    /// `q` endpoints, `segments[:, 2:4]`.
    pub fn q(&self) -> Vec<[f64; 2]> {
        self.segments.iter().map(|s| [s[2], s[3]]).collect()
    }

    /// Segment midpoints, `0.5*(p+q)` (`linesegs.py:34-36`).
    pub fn r(&self) -> Vec<[f64; 2]> {
        self.segments
            .iter()
            .map(|s| [0.5 * (s[0] + s[2]), 0.5 * (s[1] + s[3])])
            .collect()
    }
}

/// `linesegs.PageBoundary` (`linesegs.py:39-55`) — trusted, uniformly
/// sampled sides of a visible rectangular page. Each side is 50 sampled
/// `(x, y)` points — 4×50 samples in all.
#[derive(Debug, Clone)]
pub struct PageBoundary {
    pub top: Vec<[f64; 2]>,
    pub bottom: Vec<[f64; 2]>,
    pub left: Vec<[f64; 2]>,
    pub right: Vec<[f64; 2]>,
}

impl PageBoundary {
    /// `(name, points)` for all four sides, in the order the Python
    /// reference iterates them (`linesegs.py:48-55`) — top, bottom, left,
    /// right. `optimize::BoundaryCostFunction` and
    /// `pipeline::quality_metrics` both rely on this exact iteration order.
    pub fn sides(&self) -> [(&'static str, &Vec<[f64; 2]>); 4] {
        [
            ("top", &self.top),
            ("bottom", &self.bottom),
            ("left", &self.left),
            ("right", &self.right),
        ]
    }
}

/// `linesegs.PaperRegion` (`linesegs.py:58-64`) — paper feature mask and an
/// optional high-confidence page boundary.
#[derive(Debug, Clone)]
pub struct PaperRegion {
    pub mask: GrayImage,
    pub contour: Vec<[f64; 2]>,
    pub boundary: Option<PageBoundary>,
}

/// `linesegs._edge_strength` (`linesegs.py:67-92`): mean normal-intensity
/// difference at 3 points along each segment (`t = 0.25/0.5/0.75`), sampled
/// `±2px`/`±4px` along the unit normal, with **nearest-neighbour
/// truncation** (`astype(int32)`, not floor/round) for
/// the sample coordinates. Python clips each sample coordinate to
/// `[0, dim-1]` **before** truncating to `int32` (`linesegs.py:80-82`); on
/// an already-non-negative clipped float, truncation and `floor` coincide,
/// so `x.max(0.0).min(dim-1) as i64` below matches `np.clip(...).astype
/// (int32)` exactly (order matters — truncating first, as `edge_strength`
/// does, then clipping would differ from Python for out-of-frame samples).
fn edge_strength(gray: &GrayImage, segs: &[[f64; 4]]) -> Vec<f32> {
    let (w, h) = gray.dimensions();
    let sample = |x: f64, y: f64| -> f32 {
        let xc = x.max(0.0).min((w as f64) - 1.0);
        let yc = y.max(0.0).min((h as f64) - 1.0);
        gray.get_pixel(xc as u32, yc as u32).0[0] as f32
    };
    segs.iter()
        .map(|s| {
            let (px, py, qx, qy) = (s[0], s[1], s[2], s[3]);
            let dx = qx - px;
            let dy = qy - py;
            // `np.hypot` (`linesegs.py:77`), NOT `sqrt(dx*dx+dy*dy)`: the two
            // differ in the last ULP on ~17% of random f64 pairs, and exact
            // `f64` post-filter parity is a requirement here. Rust's
            // `f64::hypot` forwards to the same libm `hypot` numpy does.
            let length = dx.hypot(dy).max(1e-9);
            let (nx, ny) = (-dy / length, dx / length);
            let mut strength = 0f32;
            for &t in &[0.25, 0.5, 0.75] {
                let (ptx, pty) = (px + t * dx, py + t * dy);
                let mut diff = 0f32;
                for &off in &[2.0, 4.0] {
                    let a = sample(ptx + off * nx, pty + off * ny);
                    let b = sample(ptx - off * nx, pty - off * ny);
                    diff += (a - b).abs();
                }
                strength += diff / 2.0;
            }
            strength / 3.0
        })
        .collect()
}

/// `linesegs._sample_contour_arc` (`linesegs.py:98-113`): cumulative
/// chord-length parameterization, `n` (default 50) targets uniformly spaced
/// over `[3%, 97%]` of the arc's total length (corner trimming). Returns
/// `None` if the arc has fewer than 2 points or near-zero total length.
fn sample_contour_arc(arc: &[[f64; 2]], n: usize) -> Option<Vec<[f64; 2]>> {
    if arc.len() < 2 {
        return None;
    }
    let mut distance = vec![0.0f64; arc.len()];
    for i in 1..arc.len() {
        let dx = arc[i][0] - arc[i - 1][0];
        let dy = arc[i][1] - arc[i - 1][1];
        distance[i] = distance[i - 1] + dx.hypot(dy); // `np.hypot` (`linesegs.py:102`)
    }
    let total = *distance.last().expect("arc.len() >= 2 checked above");
    if total < 1.0 {
        return None;
    }
    let xs: Vec<f64> = arc.iter().map(|p| p[0]).collect();
    let ys: Vec<f64> = arc.iter().map(|p| p[1]).collect();
    let lo = 0.03 * total;
    let hi = 0.97 * total;
    let mut out = Vec::with_capacity(n);
    // `np.linspace(lo, hi, n)` evaluated exactly as numpy does it:
    // `step = (hi - lo) / (n - 1)`, `y[k] = lo + k * step`, then the final
    // sample is *overwritten* with `hi` (endpoint=True). Computing
    // `lo + (k / (n - 1)) * (hi - lo)` instead differs in the last ULP.
    let step = if n <= 1 {
        0.0
    } else {
        (hi - lo) / (n as f64 - 1.0)
    };
    for k in 0..n {
        let target = if n > 1 && k == n - 1 {
            hi
        } else {
            lo + (k as f64) * step
        };
        let x = crate::stats::interp(target, &distance, &xs);
        let y = crate::stats::interp(target, &distance, &ys);
        out.push([x, y]);
    }
    Some(out)
}

/// `linesegs._extract_page_boundary` (`linesegs.py:116-200`): the
/// deliberately conservative quadrilateral test: contour area,
/// strict-interior bounding box,
/// hull-area ratio, exactly-4-vertex `approxPolyDP`, quad-area ratio,
/// distinct corner indices, per-side axis-angle + minimum-length checks,
/// exactly 2 horizontal + 2 vertical sides. `filled` is the **undilated**
/// paper fill mask (`linesegs.py:231`'s `filled`, not the dilated
/// `feature_mask`).
fn extract_page_boundary(filled: &GrayImage) -> Option<PageBoundary> {
    let (w, h) = filled.dimensions();
    let contours = crate::contours::find_contours_external(
        filled.as_raw(),
        w,
        h,
        crate::contours::ChainApprox::None_,
    );
    if contours.is_empty() {
        return None;
    }
    // `max(contours, key=cv2.contourArea)` — Python's `max()` keeps the
    // FIRST element on ties, so this is a manual scan with strict `>`
    // rather than `Iterator::max_by` (which keeps the LAST tied element).
    let mut contour_cv = &contours[0];
    let mut contour_area = crate::contours::contour_area(&contours[0].points);
    for c in &contours[1..] {
        let a = crate::contours::contour_area(&c.points);
        if a > contour_area {
            contour_area = a;
            contour_cv = c;
        }
    }
    let size = (w as f64) * (h as f64);
    if contour_area < 0.15 * size {
        return None;
    }

    let (x, y, bw, bh) = crate::contours::bounding_rect(&contour_cv.points);
    if x <= 0 || y <= 0 || x + bw as i32 >= w as i32 || y + bh as i32 >= h as i32 {
        return None; // A complete four-sided page is not visible.
    }

    let hull = crate::contours::convex_hull(&contour_cv.points);
    let hull_area = crate::contours::contour_area(&hull);
    if contour_area <= 0.0 || hull_area / contour_area > 1.15 {
        return None;
    }
    let perimeter = crate::contours::arc_length_closed(&hull);
    let quad = crate::contours::approx_poly_dp_closed(&hull, 0.01 * perimeter);
    if quad.len() != 4 {
        return None;
    }
    let quad_area_ratio = crate::contours::contour_area(&quad) / contour_area;
    if !(0.85..=1.15).contains(&quad_area_ratio) {
        return None;
    }

    let contour: Vec<[f64; 2]> = contour_cv
        .points
        .iter()
        .map(|p| [p[0] as f64, p[1] as f64])
        .collect();
    let mut corner_indices: Vec<usize> = Vec::with_capacity(4);
    for &corner in &quad {
        let cf = [corner[0] as f64, corner[1] as f64];
        let mut best_i = 0usize;
        let mut best_d = f64::INFINITY;
        for (i, p) in contour.iter().enumerate() {
            let dx = p[0] - cf[0];
            let dy = p[1] - cf[1];
            let d = dx * dx + dy * dy;
            if d < best_d {
                best_d = d;
                best_i = i;
            }
        }
        corner_indices.push(best_i);
    }
    corner_indices.sort_unstable();
    corner_indices.dedup();
    if corner_indices.len() != 4 {
        return None;
    }

    let mut horizontal: Vec<(f64, Vec<[f64; 2]>)> = Vec::new();
    let mut vertical: Vec<(f64, Vec<[f64; 2]>)> = Vec::new();
    for j in 0..4 {
        let start = corner_indices[j];
        let end = corner_indices[(j + 1) % 4];
        let arc: Vec<[f64; 2]> = if j < 3 {
            contour[start..=end].to_vec()
        } else {
            let mut v = contour[start..].to_vec();
            v.extend_from_slice(&contour[..=end]);
            v
        };
        let delta = [
            arc[arc.len() - 1][0] - arc[0][0],
            arc[arc.len() - 1][1] - arc[0][1],
        ];
        let angle = delta[1].abs().atan2(delta[0].abs()).to_degrees();
        let hyp = delta[0].hypot(delta[1]); // `np.hypot(*delta)` (`linesegs.py:173/177`)
        if angle <= 30.0 {
            if hyp < 0.25 * (bw as f64) {
                return None;
            }
            let mean_y = arc.iter().map(|p| p[1]).sum::<f64>() / arc.len() as f64;
            horizontal.push((mean_y, arc));
        } else if angle >= 60.0 {
            if hyp < 0.25 * (bh as f64) {
                return None;
            }
            let mean_x = arc.iter().map(|p| p[0]).sum::<f64>() / arc.len() as f64;
            vertical.push((mean_x, arc));
        } else {
            return None;
        }
    }
    if horizontal.len() != 2 || vertical.len() != 2 {
        return None;
    }
    horizontal.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    vertical.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

    let top = sample_contour_arc(&horizontal[0].1, 50)?;
    let bottom = sample_contour_arc(&horizontal[1].1, 50)?;
    let left = sample_contour_arc(&vertical[0].1, 50)?;
    let right = sample_contour_arc(&vertical[1].1, 50)?;
    Some(PageBoundary {
        top,
        bottom,
        left,
        right,
    })
}

/// `linesegs.detect_paper_region` (`linesegs.py:203-234`): HSV → Otsu on V
/// → `bright & (sat < 60)` → largest CC (must be `>= 15%` of the image) →
/// `findContours(RETR_EXTERNAL, SIMPLE)` → fill → dilate `9×9` ones = the
/// feature mask; the undilated fill feeds [`extract_page_boundary`].
/// `img` is the proc-resolution color image (RGB; the wasm ABI is RGBA —
/// callers pass the RGB view / drop alpha before this call, matching
/// `gray.rs`'s alpha-ignored convention).
pub fn detect_paper_region(img: &RgbImage) -> Option<PaperRegion> {
    let (w, h) = img.dimensions();
    let (sat, val) = crate::imgops::hsv::rgb_to_hsv_sv_planes(img.as_raw(), w, h);
    let val_img = GrayImage::from_raw(w, h, val)
        .expect("rgb_to_hsv_sv_planes: val buffer length matches dims");
    // `cv2.threshold(val, 0, 255, THRESH_BINARY+THRESH_OTSU)` — non-inverted.
    let bright = crate::imgops::threshold::threshold_otsu(&val_img, false);
    let bright_raw = bright.as_raw();
    let mut cand = vec![0u8; (w * h) as usize];
    for i in 0..cand.len() {
        cand[i] = if bright_raw[i] > 0 && sat[i] < 60 {
            1
        } else {
            0
        };
    }

    let cc = crate::cc::connected_components_with_stats(&cand, w, h);
    if cc.stats.len() <= 1 {
        return None; // no foreground components at all
    }
    // `idx = 1 + argmax(stats[1:, AREA])` — NumPy's argmax keeps the FIRST
    // occurrence of the maximum, so this is a manual scan with strict `>`.
    let mut idx = 1usize;
    let mut best_area = cc.stats[1].area;
    for i in 2..cc.stats.len() {
        if cc.stats[i].area > best_area {
            best_area = cc.stats[i].area;
            idx = i;
        }
    }
    let img_area = (w as f64) * (h as f64);
    if (cc.stats[idx].area as f64) < 0.15 * img_area {
        return None; // No large paper-like region
    }

    let component: Vec<u8> = cc
        .labels
        .iter()
        .map(|&l| if l as usize == idx { 1 } else { 0 })
        .collect();
    let contours = crate::contours::find_contours_external(
        &component,
        w,
        h,
        crate::contours::ChainApprox::Simple,
    );
    if contours.is_empty() {
        return None;
    }
    let filled_raw = crate::contours::fill_contours(w, h, &contours);
    let filled =
        GrayImage::from_raw(w, h, filled_raw).expect("fill_contours: buffer length matches dims");

    let mut contour_cv = &contours[0];
    let mut best_a = crate::contours::contour_area(&contours[0].points);
    for c in &contours[1..] {
        let a = crate::contours::contour_area(&c.points);
        if a > best_a {
            best_a = a;
            contour_cv = c;
        }
    }
    let contour: Vec<[f64; 2]> = contour_cv
        .points
        .iter()
        .map(|p| [p[0] as f64, p[1] as f64])
        .collect();

    let boundary = extract_page_boundary(&filled);
    // Dilate slightly so segments along the page edge are retained.
    let feature_mask = crate::imgops::morphology::dilate_rect(&filled, 9, 9);
    Some(PaperRegion {
        mask: feature_mask,
        contour,
        boundary,
    })
}

/// `linesegs.paper_mask` (`linesegs.py:237-240`) — backward-compatible
/// wrapper returning only the feature mask.
pub fn paper_mask(img: &RgbImage) -> Option<GrayImage> {
    detect_paper_region(img).map(|r| r.mask)
}

/// `linesegs.detect_line_segments` (`linesegs.py:243-284`): raw LSD
/// segments ([`crate::lsd::detect`]) →
/// (1) drop `length <= mean_text_size` →
/// (2) drop `edge_strength < EDGE_STRENGTH_MIN` →
/// (3) drop segments whose (int-truncated) midpoint falls outside `mask`
///     (when given) →
/// (4) split every survivor into `n = max(1, round(len / (2*mean_text_size)))`
///     equal-length pieces (longer segments get proportionally more weight
///     in the optimizer's cost).
pub fn detect_line_segments(
    gray: &GrayImage,
    mean_text_size: f64,
    mask: Option<&GrayImage>,
) -> LineSegments {
    let raw = crate::lsd::detect(gray);
    if raw.is_empty() {
        // Nothing detected (a featureless frame, or the `lsd` cargo feature
        // off — the text-lines-only mode). Short-circuit rather than run
        // `edge_strength` (and the split loop) on zero segments, matching
        // `linesegs.py:252-253`'s own `if len(segs):` / `if mask is not
        // None and len(segs):` guards around those exact same steps.
        return LineSegments::empty();
    }
    let mut segs: Vec<[f64; 4]> = raw.segments;

    // Step 1: drop segments no longer than the mean text size.
    segs.retain(|s| {
        let dx = s[2] - s[0];
        let dy = s[3] - s[1];
        dx.hypot(dy) > mean_text_size // `np.hypot` (`linesegs.py:253`)
    });

    // Step 1b: drop low-contrast (background-texture) segments.
    if !segs.is_empty() {
        let strength = edge_strength(gray, &segs);
        segs = segs
            .into_iter()
            .zip(strength)
            .filter(|(_, st)| *st >= EDGE_STRENGTH_MIN)
            .map(|(s, _)| s)
            .collect();
    }

    // Step 1c: drop segments whose (truncated) midpoint falls outside the
    // paper mask. `linesegs.py:258-263`: truncate the midpoint to `int32`
    // FIRST, then clip to `[0, dim-1]` — the reverse order from
    // `edge_strength`'s own sampling above; kept distinct rather than
    // sharing a helper because getting this order backwards is exactly the
    // kind of one-line parity slip that silently changes results.
    if let Some(m) = mask {
        if !segs.is_empty() {
            let (mw, mh) = m.dimensions();
            segs.retain(|s| {
                let mx = (0.5 * (s[0] + s[2])) as i64;
                let my = (0.5 * (s[1] + s[3])) as i64;
                let mx = mx.clamp(0, mw as i64 - 1) as u32;
                let my = my.clamp(0, mh as i64 - 1) as u32;
                m.get_pixel(mx, my).0[0] > 0
            });
        }
    }

    // Step 2: split every survivor into `n = max(1, round(len / (2 *
    // mean_text_size)))` equal-length pieces.
    let t_l = 2.0 * mean_text_size;
    let mut divided: Vec<[f64; 4]> = Vec::new();
    for s in &segs {
        let (px, py, qx, qy) = (s[0], s[1], s[2], s[3]);
        let length = (qx - px).hypot(qy - py); // `np.hypot` (`linesegs.py:272`)
        let n_i = if t_l > 0.0 {
            ((length / t_l).round_ties_even() as i64).max(1)
        } else {
            1
        };
        let n_i = n_i as usize;
        // `np.linspace(0.0, 1.0, n_i + 1)`: numpy evaluates `t_k = k * fl(1/n)`
        // and then *forces* the last sample to exactly `1.0` (endpoint=True).
        // `k as f64 / n as f64` is NOT the same value in the last ULP, and
        // these t's feed the split coordinates directly.
        let step = 1.0 / n_i as f64;
        for i in 0..n_i {
            let t0 = if i == 0 { 0.0 } else { (i as f64) * step };
            let t1 = if i + 1 == n_i {
                1.0
            } else {
                ((i + 1) as f64) * step
            };
            divided.push([
                px + (qx - px) * t0,
                py + (qy - py) * t0,
                px + (qx - px) * t1,
                py + (qy - py) * t1,
            ]);
        }
    }
    LineSegments { segments: divided }
}
