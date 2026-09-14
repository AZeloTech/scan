//! Text-line detection from connected-component centers — mirrors
//! `textline.py` 1:1.
//!
//! Cascade: `binarize`/`binarize_light` → `_extract_ccs` (both polarities)
//! → `_link_ccs_into_lines` (union-find chaining) → `_validate_line`
//! (quadratic-fit sanity check) → `_is_high_confidence_line` classification
//! → `_group_lines_into_blocks`. A handful of pixels flipping
//! at the `adaptiveThreshold` boundary cascades all the way to
//! `uses_confidence_filter`, which gates an 8× change in the downstream
//! segment set — golden-test the binary image, then CC count, then line
//! count and the high-confidence subset, in that order, before testing
//! anything downstream.

use image::GrayImage;

/// Per-block alignment classification. Real values are `None_ | Left |
/// Right | Justified`, matching `optimize.py`'s `alignments: list[str]`
/// (`"none"|"left"|"right"|"justified"`). `Coarse` is `optimize.py`'s
/// `"__coarse__"` sentinel (`optimize.py:659`) that disables both
/// `E_spacing` and `E_align` for the coarse multi-start stage — it is not a
/// real block classification, but is folded into this one enum (rather than
/// a second near-duplicate type) since Python represents both with the same
/// `str` field. See `optimize::classify_alignment` for where the real
/// values are produced.
///
/// Note: `TextBlock::alignment` below (mirroring `textline.py`'s
/// `TextBlock.alignment: str = "none"` dataclass field) is **never actually
/// assigned** by the ported pipeline — `optimize::run_optimization`
/// classifies alignment into a separate `Vec<Alignment>`
/// (`ProblemData::alignments`) keyed by block index, not by writing back
/// into `TextBlock`. The field is carried here only for line-for-line
/// fidelity with the Python dataclass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alignment {
    None_,
    Left,
    Right,
    Justified,
    Coarse,
}

impl Default for Alignment {
    fn default() -> Self {
        Alignment::None_
    }
}

/// `"none"|"left"|"right"|"justified"` — matches `optimize.py`'s string
/// values (`"__coarse__"` for the coarse-stage sentinel). `seam.rs`'s
/// `S4Optimize.alignments: Vec<String>` doc comment names this exact form
/// ("`textline::Alignment`'s `Display`/serialization form").
impl std::fmt::Display for Alignment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Alignment::None_ => "none",
            Alignment::Left => "left",
            Alignment::Right => "right",
            Alignment::Justified => "justified",
            Alignment::Coarse => "__coarse__",
        };
        write!(f, "{s}")
    }
}

/// `textline.TextLine` (`textline.py:12-28`) — one text line, CC centers
/// `(α, β)` ordered by increasing x.
#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    /// `(N, 2)` float64 centers, `centers[i] = [alpha, beta]`.
    pub centers: Vec<[f64; 2]>,
    /// Strong text structure, safe for geometry fitting
    /// (`_is_high_confidence_line`, `textline.py:226-244`).
    pub high_confidence: bool,
}

impl TextLine {
    pub fn left(&self) -> [f64; 2] {
        self.centers[0]
    }
    pub fn right(&self) -> [f64; 2] {
        *self
            .centers
            .last()
            .expect("TextLine.centers is never empty")
    }
    pub fn width(&self) -> f64 {
        self.right()[0] - self.left()[0]
    }
}

/// `textline.TextBlock` (`textline.py:31-34`).
#[derive(Debug, Clone, Default)]
pub struct TextBlock {
    pub lines: Vec<TextLine>,
    pub alignment: Alignment,
}

/// `textline.TextFeatures` (`textline.py:37-58`) — the return type of
/// [`extract_text_features`].
#[derive(Debug, Clone)]
pub struct TextFeatures {
    pub blocks: Vec<TextBlock>,
    /// Mean major-axis length of text CCs — controls LSD length thresholds
    /// (`linesegs.detect_line_segments`) as well as several geometry-side
    /// tolerances; kept as the "historical all-candidate scale estimate"
    /// (`textline.py:307-309`'s comment) independent of which lines end up
    /// used for geometry.
    pub mean_text_size: f64,
    /// Binary image, kept for debugging document-region detection
    /// (`textline.py:41`).
    pub binary: GrayImage,
}

impl TextFeatures {
    /// All lines across all blocks (`textline.py:44-45`'s `lines` property).
    pub fn lines(&self) -> Vec<&TextLine> {
        self.blocks.iter().flat_map(|b| b.lines.iter()).collect()
    }

    /// `textline.py:47-49`'s `high_confidence_lines` property.
    pub fn high_confidence_lines(&self) -> Vec<&TextLine> {
        self.lines()
            .into_iter()
            .filter(|l| l.high_confidence)
            .collect()
    }

    /// `textline.py:51-58`'s `uses_confidence_filter` property: `true` iff
    /// at least two high-confidence lines exist. Surfaced in the wasm
    /// status output as a cheap booklet-case signal.
    pub fn uses_confidence_filter(&self) -> bool {
        self.high_confidence_lines().len() >= 2
    }
}

/// `block = max(31, (min(h,w)//20) | 1)` (`textline.py:65`/`:84`) — shared by
/// both binarization polarities.
fn adaptive_block_size(width: u32, height: u32) -> u32 {
    let m = width.min(height);
    ((m / 20) | 1).max(31)
}

/// Fraction-of-255 mean of a binary (0/255) image, i.e. `binary.mean() /
/// 255` in `textline.py:71,73,88`'s sense — compared against `0.5` there;
/// this returns the raw `0..255` mean to match the Python comparison
/// (`binary.mean() > 0.5*255`) directly.
fn mean255(img: &GrayImage) -> f64 {
    let raw = img.as_raw();
    let sum: u64 = raw.iter().map(|&v| v as u64).sum();
    sum as f64 / raw.len() as f64
}

/// `textline.binarize` (`textline.py:61-75`): dark-text-as-foreground.
/// `adaptiveThreshold(255, GAUSSIAN_C, THRESH_BINARY_INV, block, C=15)` with
/// `block = max(31, (min(h,w)//20) | 1)`; if the foreground ratio exceeds
/// 50%, rebuild with `threshold(0, 255, BINARY_INV + OTSU)`, and if *that*
/// still exceeds 50%, `bitwise_not` it.
pub fn binarize(gray: &GrayImage) -> GrayImage {
    let (w, h) = gray.dimensions();
    let block = adaptive_block_size(w, h);
    let mut binary = crate::imgops::threshold::adaptive_threshold_gaussian(gray, block, 15.0, true);
    if mean255(&binary) > 0.5 * 255.0 {
        binary = crate::imgops::threshold::threshold_otsu(gray, true);
        if mean255(&binary) > 0.5 * 255.0 {
            binary = crate::imgops::threshold::bitwise_not(&binary);
        }
    }
    binary
}

/// `textline.binarize_light` (`textline.py:78-90`): light-text-as-foreground
/// (reversed/white slide text). Same block size, `THRESH_BINARY, C=-15`.
/// Returns an all-zero image if the whole image saturates as foreground
/// (e.g. blank paper) — `textline.py:88-89`.
pub fn binarize_light(gray: &GrayImage) -> GrayImage {
    let (w, h) = gray.dimensions();
    let block = adaptive_block_size(w, h);
    let binary = crate::imgops::threshold::adaptive_threshold_gaussian(gray, block, -15.0, false);
    if mean255(&binary) > 0.5 * 255.0 {
        GrayImage::new(w, h) // all-zero — `np.zeros_like`
    } else {
        binary
    }
}

/// Zero pixels of `img` wherever `mask` is `0` (`textline.py:283-287`:
/// `binary[mask == 0] = 0`, applied identically to both polarities).
fn apply_mask(img: &mut GrayImage, mask: &GrayImage) {
    debug_assert_eq!(img.dimensions(), mask.dimensions());
    for (p, m) in img.pixels_mut().zip(mask.pixels()) {
        if m.0[0] == 0 {
            p.0[0] = 0;
        }
    }
}

/// One connected component's derived text-line fields — `textline._CC`
/// (`textline.py:93-101`).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Cc {
    center: [f64; 2],
    x0: f64,
    x1: f64,
    y0: f64,
    y1: f64,
    height: f64,
    major_axis: f64,
}

/// `textline._extract_ccs` (`textline.py:104-128`): CC filtering —
/// `area >= 8`, `h >= 3`, `h <= 0.05*H`, `w <= 0.2*W`,
/// `1/15 <= w/h <= 15`.
fn extract_ccs(binary: &GrayImage) -> Vec<Cc> {
    let (w_img, h_img) = binary.dimensions();
    let cc = crate::cc::connected_components_with_stats(binary.as_raw(), w_img, h_img);
    let mut out = Vec::new();
    for s in cc.stats.iter().skip(1) {
        let (x, y, w, h, area) = (s.x, s.y, s.width, s.height, s.area);
        if area < 8 || h < 3 {
            continue; // Noise
        }
        if (h as f64) > 0.05 * (h_img as f64) || (w as f64) > 0.2 * (w_img as f64) {
            continue; // Exclude rules, figures, and borders
        }
        let aspect = w as f64 / h as f64;
        if aspect > 15.0 || aspect < 1.0 / 15.0 {
            continue; // Thin elongated line
        }
        out.push(Cc {
            center: [s.centroid.0, s.centroid.1],
            x0: x as f64,
            x1: (x + w) as f64,
            y0: y as f64,
            y1: (y + h) as f64,
            height: h as f64,
            major_axis: w.max(h) as f64,
        });
    }
    out
}

/// Total connected-component count across both binarization polarities,
/// after `_extract_ccs`'s area/height/aspect filters but before
/// line-linking — matches the `raw_cc_count` field of the S2 stage
/// snapshot (`len(_extract_ccs(binary)) + len(_extract_ccs(light))`,
/// `S2TextFeatures.raw_cc_count`). Exposed as `pub` (unlike
/// the module-private `extract_ccs`) purely for parity-harness/debug
/// instrumentation — the production pipeline never needs this count outside
/// of building that seam snapshot.
pub fn raw_cc_count(gray: &GrayImage, mask: Option<&GrayImage>) -> usize {
    let mut binary = binarize(gray);
    let mut light = binarize_light(gray);
    if let Some(m) = mask {
        apply_mask(&mut binary, m);
        apply_mask(&mut light, m);
    }
    extract_ccs(&binary).len() + extract_ccs(&light).len()
}

/// Minimal union-find, mirroring `textline._UnionFind` (`textline.py:131-
/// 144`) — path-halving `find`, union-by-nothing-fancy `union` (parent of
/// `find(b)` set to `find(a)`, matching the Python reference exactly, no
/// union-by-rank — tie-breaking under equal ranks is irrelevant here since
/// only set membership is ever read back, never the root's identity).
fn uf_find(parent: &mut [usize], mut a: usize) -> usize {
    while parent[a] != a {
        parent[a] = parent[parent[a]];
        a = parent[a];
    }
    a
}
fn uf_union(parent: &mut [usize], a: usize, b: usize) {
    let ra = uf_find(parent, a);
    let rb = uf_find(parent, b);
    if ra != rb {
        parent[rb] = ra;
    }
}

/// `textline._link_ccs_into_lines` (`textline.py:147-196`): union-find
/// chaining. Median-height gate `0.25*med_h <= h <= 4*med_h`; sort by
/// centroid x; chain rightward with early break at
/// `reach = 2.5*max(med_h, p90_h)`; link iff `gap <= 2.5*pair_h`,
/// `|dy| < 0.5*pair_h`, `vertical_overlap > 0.3*min(h)`. Groups with fewer
/// than 4 CCs are dropped; survivors are validated via [`validate_line`].
fn link_ccs_into_lines(ccs: &[Cc]) -> Vec<Vec<Cc>> {
    if ccs.is_empty() {
        return Vec::new();
    }
    let heights: Vec<f64> = ccs.iter().map(|c| c.height).collect();
    let med_h = crate::stats::median(&heights);
    let filtered: Vec<Cc> = ccs
        .iter()
        .copied()
        .filter(|c| c.height >= 0.25 * med_h && c.height <= 4.0 * med_h)
        .collect();
    if filtered.is_empty() {
        return Vec::new();
    }
    let n = filtered.len();
    let mut order: Vec<usize> = (0..n).collect();
    // `np.argsort` is unstable by default, but per stats.rs's own port-notes
    // section, this crate deliberately uses Rust's stable sort everywhere
    // and accepts the resulting divergence only on exact ties.
    order.sort_by(|&a, &b| {
        filtered[a].center[0]
            .partial_cmp(&filtered[b].center[0])
            .unwrap()
    });

    let filt_heights: Vec<f64> = filtered.iter().map(|c| c.height).collect();
    let h90 = crate::stats::percentile(&filt_heights, 90.0);
    let reach = 2.5 * med_h.max(h90);

    let mut parent: Vec<usize> = (0..n).collect();
    for (oi, &i) in order.iter().enumerate() {
        let ci = &filtered[i];
        for &j in &order[oi + 1..] {
            let cj = &filtered[j];
            if cj.x0 - ci.x1 > reach {
                break; // sorted by x: everything farther is farther still
            }
            let pair_h = 0.5 * (ci.height + cj.height);
            let dy = (cj.center[1] - ci.center[1]).abs();
            let v_overlap = ci.y1.min(cj.y1) - ci.y0.max(cj.y0);
            if cj.x0 - ci.x1 <= 2.5 * pair_h
                && dy < 0.5 * pair_h
                && v_overlap > 0.3 * ci.height.min(cj.height)
            {
                uf_union(&mut parent, i, j);
            }
        }
    }

    // Group by root, in order of first appearance as `i` iterates `0..n`
    // (matches Python dict insertion-order iteration, `textline.py:183-185`).
    let mut root_to_bucket: std::collections::HashMap<usize, usize> =
        std::collections::HashMap::new();
    let mut buckets: Vec<Vec<Cc>> = Vec::new();
    for (i, &c) in filtered.iter().enumerate() {
        let root = uf_find(&mut parent, i);
        let idx = *root_to_bucket.entry(root).or_insert_with(|| {
            buckets.push(Vec::new());
            buckets.len() - 1
        });
        buckets[idx].push(c);
    }

    let mut lines = Vec::new();
    for mut g in buckets {
        if g.len() < 4 {
            continue; // Retain short lines (>=4 CCs) such as slide bullets
        }
        g.sort_by(|a, b| a.center[0].partial_cmp(&b.center[0]).unwrap());
        if validate_line(&g, med_h) {
            lines.push(g);
        }
    }
    lines
}

/// `textline._validate_line` (`textline.py:199-223`): `width >= 3*line_h`;
/// `np.polyfit(x, y, 2)` endpoint slopes `|g'| <= 0.6`; RMS residual
/// `<= 0.6*line_h`; `line_h >= 0.3*med_h`.
fn validate_line(g: &[Cc], med_h: f64) -> bool {
    let heights: Vec<f64> = g.iter().map(|c| c.height).collect();
    let line_h = crate::stats::median(&heights);
    let xs: Vec<f64> = g.iter().map(|c| c.center[0]).collect();
    let ys: Vec<f64> = g.iter().map(|c| c.center[1]).collect();
    let width = xs[xs.len() - 1] - xs[0];
    if width < 3.0 * line_h {
        return false; // Too short
    }
    let coef = crate::stats::polyfit_quadratic(&xs, &ys);
    let der = crate::stats::polyder_quadratic(coef);
    let slope0 = der[0] * xs[0] + der[1];
    let slope1 = der[0] * xs[xs.len() - 1] + der[1];
    if slope0.abs().max(slope1.abs()) > 0.6 {
        return false; // Reject slopes over approximately 31 degrees
    }
    let mut sq_sum = 0.0f64;
    for i in 0..xs.len() {
        let pred = crate::stats::polyval_quadratic(coef, xs[i]);
        let resid = ys[i] - pred;
        sq_sum += resid * resid;
    }
    let rms = (sq_sum / xs.len() as f64).sqrt();
    if rms > 0.6 * line_h {
        return false; // Excessive scatter (a cluster of texture noise)
    }
    if line_h < 0.3 * med_h {
        return false;
    }
    true
}

/// `textline._is_high_confidence_line` (`textline.py:226-244`):
/// `len >= 12 && ptp(x)/median_h >= 8.0 && std(h)/mean(h) <= 0.5`.
fn is_high_confidence_line(g: &[Cc]) -> bool {
    let heights: Vec<f64> = g.iter().map(|c| c.height).collect();
    let xs: Vec<f64> = g.iter().map(|c| c.center[0]).collect();
    let median_height = crate::stats::median(&heights);
    let x_max = xs.iter().copied().fold(f64::MIN, f64::max);
    let x_min = xs.iter().copied().fold(f64::MAX, f64::min);
    let normalized_width = (x_max - x_min) / median_height.max(1e-6);
    let mean_h = heights.iter().sum::<f64>() / heights.len() as f64;
    let var_h = heights.iter().map(|h| (h - mean_h).powi(2)).sum::<f64>() / heights.len() as f64;
    let height_cv = var_h.sqrt() / mean_h.max(1e-6);
    g.len() >= 12 && normalized_width >= 8.0 && height_cv <= 0.5
}

/// `textline._group_lines_into_blocks` (`textline.py:247-275`): union-find
/// over line pairs with x-overlap `> 0.5*min_width` and
/// `|dy| < 14*max(line_h)`.
fn group_lines_into_blocks(lines: &[Vec<Cc>]) -> Vec<Vec<Vec<Cc>>> {
    if lines.is_empty() {
        return Vec::new();
    }
    let n = lines.len();
    let spans: Vec<(f64, f64)> = lines
        .iter()
        .map(|g| (g[0].center[0], g[g.len() - 1].center[0]))
        .collect();
    let ys: Vec<f64> = lines
        .iter()
        .map(|g| crate::stats::median(&g.iter().map(|c| c.center[1]).collect::<Vec<_>>()))
        .collect();
    let heights: Vec<f64> = lines
        .iter()
        .map(|g| crate::stats::median(&g.iter().map(|c| c.height).collect::<Vec<_>>()))
        .collect();

    let mut parent: Vec<usize> = (0..n).collect();
    for i in 0..n {
        for j in (i + 1)..n {
            let ov = spans[i].1.min(spans[j].1) - spans[i].0.max(spans[j].0);
            let min_w = (spans[i].1 - spans[i].0).min(spans[j].1 - spans[j].0);
            if min_w <= 0.0 {
                continue;
            }
            let gap = (ys[i] - ys[j]).abs();
            // Keep lines in one block even across blank paragraph lines.
            if ov > 0.5 * min_w && gap < 14.0 * heights[i].max(heights[j]) {
                uf_union(&mut parent, i, j);
            }
        }
    }

    let mut root_to_bucket: std::collections::HashMap<usize, usize> =
        std::collections::HashMap::new();
    let mut buckets: Vec<Vec<usize>> = Vec::new();
    for i in 0..n {
        let root = uf_find(&mut parent, i);
        let idx = *root_to_bucket.entry(root).or_insert_with(|| {
            buckets.push(Vec::new());
            buckets.len() - 1
        });
        buckets[idx].push(i);
    }

    let mut blocks = Vec::new();
    for mut idxs in buckets {
        idxs.sort_by(|&a, &b| ys[a].partial_cmp(&ys[b]).unwrap());
        blocks.push(idxs.into_iter().map(|i| lines[i].clone()).collect());
    }
    blocks
}

/// `textline.extract_text_features` (`textline.py:278-314`) — the
/// module's public entry point (stage S2).
/// `mask`, when given, zeroes both binarized images outside it before CC
/// extraction (restricting text detection to the detected paper/object
/// region, `textline.py:283-287`).
pub fn extract_text_features(gray: &GrayImage, mask: Option<&GrayImage>) -> TextFeatures {
    let mut binary = binarize(gray);
    let mut light = binarize_light(gray);
    if let Some(m) = mask {
        apply_mask(&mut binary, m);
        apply_mask(&mut light, m);
    }
    // Combine CCs of both polarities to support reversed text.
    let mut ccs = extract_ccs(&binary);
    ccs.extend(extract_ccs(&light));
    let line_groups = link_ccs_into_lines(&ccs);
    let block_groups = group_lines_into_blocks(&line_groups);

    let mut blocks = Vec::new();
    let mut used_ccs: Vec<Cc> = Vec::new();
    for bg in &block_groups {
        let mut block = TextBlock::default();
        for g in bg {
            let centers: Vec<[f64; 2]> = g.iter().map(|c| c.center).collect();
            let high_confidence = is_high_confidence_line(g);
            block.lines.push(TextLine {
                centers,
                high_confidence,
            });
            used_ccs.extend(g.iter().copied());
        }
        blocks.push(block);
    }

    // Keep the historical all-candidate scale estimate. It controls LSD
    // length thresholds, so changing it together with geometry-line
    // selection would unnecessarily alter a second, independent feature
    // source.
    let mean_text_size = if !used_ccs.is_empty() {
        used_ccs.iter().map(|c| c.major_axis).sum::<f64>() / used_ccs.len() as f64
    } else {
        20.0
    };
    TextFeatures {
        blocks,
        mean_text_size,
        binary,
    }
}
