//! Stage-boundary snapshot types — one struct per pipeline stage, field
//! names matching 1:1 the JSON keys the stage dumper writes.
//!
//! **`parity`-feature-only** (`Cargo.toml`'s `[features] parity =
//! ["dep:serde", "dep:serde_json"]`): these are the **only** types allowed
//! to cross the JSON seam into a stage snapshot. This module —
//! and the `serde`/`serde_json` dependencies it needs — is compiled **only**
//! for the native `cargo test --features parity` harness; the wasm `cdylib`
//! target never sees this module at all (it costs nothing in the shipped
//! binary, per `lib.rs`'s `#[cfg(feature = "parity")] pub mod seam;`).
//!
//! **Resolution note, binding:** [`S4Optimize`] and
//! [`S5BoundaryRefine`]'s `theta`/`x_clamp` fields are in the pipeline's
//! **internal working (proc-)resolution** — feature extraction and
//! optimization run on the S0-resized image, never on the input resolution
//! directly. [`S6Render`]'s fields are **after** `_scale_params`'s rescale
//! back to the resolution `dewarp_image` actually received. These are
//! deliberately two different struct shapes, not one struct reused at two
//! resolutions, so comparing `S4Optimize.final_theta` against
//! `S6Render.theta_full_res` without accounting for the rescale is a type
//! error, not a silent unit bug.

use serde::{Deserialize, Serialize};

/// `S0Resize`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S0Resize {
    pub ratio: f64,
    pub proc_w: u32,
    pub proc_h: u32,
}

/// `S1RegionMask`. The mask itself is dumped as a lossless
/// PNG, not JSON; `mask_rle` here is a
/// run-length-encoded summary carried alongside it for a cheap sanity check
/// without decoding the PNG (`(run_value, run_length)` pairs, row-major,
/// the mask being binary).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S1RegionMask {
    pub mask_rle: Vec<(u32, u32)>,
    pub kept: bool,
}

/// `S1bPageBoundary`. `sides`, when `found`, is
/// `[top, bottom, left, right]`, each 50 sampled `[x, y]` points
/// (`linesegs::PageBoundary::sides`'s own order).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S1bPageBoundary {
    pub found: bool,
    pub sides: Option<[Vec<[f64; 2]>; 4]>,
}

/// One text line as dumped for the S2 fixture — a superset of
/// `textline::TextLine` (which carries only `centers`/`high_confidence`):
/// this also carries the derived `height` and `block_id` the seam wants
/// visible for debugging: centers, height, block id, high_confidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeamTextLine {
    pub centers: Vec<[f64; 2]>,
    /// Median CC height for this line.
    pub height: f64,
    /// The stage dumper writes this JSON key as `"block"`, not `"block_id"`
    /// — without this rename an `s2_text_features.json` snapshot fails to
    /// deserialize (`missing field 'block_id'`). Renamed here rather than in
    /// the generator, since the generator's key name is the one already
    /// baked into every snapshot on disk.
    #[serde(rename = "block")]
    pub block_id: usize,
    pub high_confidence: bool,
}

/// `S2TextFeatures`. `blocks[i]` lists the indices into
/// `lines` belonging to block `i`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S2TextFeatures {
    pub raw_cc_count: usize,
    pub lines: Vec<SeamTextLine>,
    pub blocks: Vec<Vec<usize>>,
    pub mean_text_size: f64,
    pub uses_confidence_filter: bool,
}

/// `S3LineSegments`. `filtered` is the post-filter,
/// post-split segment set (`linesegs::LineSegments::segments`). Vacuous
/// (`raw_count = 0`, `filtered = []`) whenever `use_line_term = false`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3LineSegments {
    pub raw_count: usize,
    pub filtered: Vec<[f64; 4]>,
}

/// `S3bGeometrySupport`. `kept_indices` indexes into
/// `S3LineSegments.filtered`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S3bGeometrySupport {
    pub kept_count: usize,
    pub kept_indices: Vec<usize>,
}

/// One coarse multi-start candidate: theta + score, all 7.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoarseCandidate {
    pub theta: [f64; 8],
    pub score: f64,
}

/// One outlier-removal iteration's snapshot: theta, text mask and seg mask
/// per iteration. `text_mask`/`seg_mask` are indexed against the *full*
/// (pre-outlier-loop) feature sets, so their lengths are stable across
/// iterations even as the `true` count shrinks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutlierIterSnapshot {
    pub theta: [f64; 8],
    pub text_mask: Vec<bool>,
    pub seg_mask: Vec<bool>,
}

/// `S4Optimize`. **Proc resolution** (see this module's
/// doc comment's resolution note).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S4Optimize {
    pub coarse_candidates: Vec<CoarseCandidate>,
    pub coarse_winner: usize,
    /// Per-block alignment classification, as strings
    /// (`"none"|"left"|"right"|"justified"` — `textline::Alignment`'s
    /// `Display`/serialization form; `"__coarse__"` never appears here,
    /// that sentinel is internal to the coarse stage only).
    pub alignments: Vec<String>,
    pub outlier_iterations: Vec<OutlierIterSnapshot>,
    pub final_theta: [f64; 8],
    /// `(p1, p99)` of `Sx` at the final solve — load-bearing, and easy to
    /// drop by accident.
    pub x_clamp: [f64; 2],
}

/// One page-boundary refinement candidate snapshot: five of them, each
/// weight + theta + accepted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundaryCandidateSnapshot {
    pub weight: f64,
    pub theta: [f64; 8],
    pub accepted: bool,
    /// The dumper's `row["valid"]`: finite params — a
    /// [`crate::optimize::BoundaryCandidate`] was actually produced for this
    /// weight tier. Distinct from `accepted`, which is decided by the
    /// `_candidate_is_acceptable` gate one level up in `pipeline.rs`, so
    /// `valid` is what a test against `optimize::refine_with_page_boundary`
    /// alone can check. `#[serde(default)]` so this stays optional for any
    /// producer that doesn't emit it.
    #[serde(default)]
    pub valid: Option<bool>,
    /// The dumper's `row["boundary_mean"]` — present only when
    /// `valid` and a boundary quality metric was computed.
    #[serde(default)]
    pub boundary_mean: Option<f64>,
}

/// `S5BoundaryRefine`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S5BoundaryRefine {
    pub candidates: Vec<BoundaryCandidateSnapshot>,
    /// The dumper writes a top-level `"skipped"` reason string
    /// (`"no_page_boundary"` / `"geometry_prep_failed"`) instead of
    /// `candidates` when S5 never ran at all, so a test can distinguish
    /// "ran, zero candidates accepted" from "never ran."
    /// `#[serde(default)]`: absent when S5 did run and populated
    /// `candidates` normally.
    #[serde(default)]
    pub skipped: Option<String>,
}

/// `S6Render`. **Full (input-buffer) resolution**, post
/// `_scale_params` (see this module's doc comment's resolution note) — do
/// **not** compare `theta_full_res`/`x_clamp_full_res` directly against
/// `S4Optimize`'s proc-resolution fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct S6Render {
    pub out_w: u32,
    pub out_h: u32,
    pub theta_full_res: [f64; 8],
    pub x_clamp_full_res: [f64; 2],
    pub used_boundary: bool,
}

/// `meta.json`: `{input_path, image_sha256, opts, dewarping_git_sha}`. Not
/// itself a stage-boundary struct, but every snapshot directory carries one,
/// and a consumer needs it to know which preset/flags produced the snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureMeta {
    pub input_path: String,
    pub image_sha256: String,
    pub opts: serde_json::Value,
    pub dewarping_git_sha: String,
}
