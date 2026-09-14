//! `dewarp-rs` — Rust/WASM port of `PINTO0309/doc-dewarping` (classical GCS
//! document dewarper, Kil et al. ICDAR 2017 text-lines + line-segments
//! method).
//!
//! The MIT-licensed Python reference each module below mirrors line by line
//! is vendored under `parity/reference/src/dewarping/*.py`.
//!
//! Module boundary mirrors the Python package 1:1:
//!
//! | Python | Rust |
//! |---|---|
//! | `textline.py` | `textline.rs` |
//! | `linesegs.py` | `linesegs.rs` |
//! | `model.py` | `model.rs` (+ `model/rodrigues.rs`) |
//! | `lsq.py` | `lsq.rs` |
//! | `optimize.py` | `optimize.rs` |
//! | `dewarp.py` | `pipeline.rs` |
//! | `options.py` | `options.rs` |
//! | n/a (scattered NumPy calls) | `stats.rs` |
//!
//! `saliency.py` (`--scene` mode) is **not ported**: this crate only ever
//! dewarps document pages, so the scene-mode saliency path has no caller.
//!
//! Standing invariant: the crate must compile (`cargo build`,
//! `cargo build --features parity`) and `cargo test [--features parity]`
//! must run at every commit.
#![allow(dead_code)] // several items exist for the parity harness / public API only
#![allow(unused_variables)] // kept for signature parity with the Python reference
#![allow(clippy::too_many_arguments)] // several Python functions this mirrors take 6-9 args

pub mod options;
pub mod stats;

pub mod cc;
pub mod contours;
pub mod imgops;

pub mod linesegs;
pub mod lsd;
pub mod textline;

pub mod model;

pub mod lsq;
pub mod optimize;

pub mod pipeline;

/// Stage-boundary snapshot types used by the native parity
/// harness (`cargo test --features parity`). Never compiled into the wasm
/// `cdylib` target — see `seam.rs`'s own module doc comment.
#[cfg(feature = "parity")]
pub mod seam;

/// `wasm-bindgen` ABI surface. The **only** module that knows
/// about JS/wasm-linear-memory concerns — everything above is pure,
/// platform-agnostic Rust. Compiles on the native target too (its
/// `#[wasm_bindgen]` attributes are `cfg_attr(target_arch = "wasm32", ...)`
/// gated) so `cargo build`/`cargo test` on the host exercises the same code.
pub mod wasm;
