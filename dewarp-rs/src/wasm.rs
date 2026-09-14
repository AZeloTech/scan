//! `wasm-bindgen` ABI surface. The **only** module in this
//! crate that knows about JS/wasm-linear-memory concerns; everything else
//! (`pipeline`, `optimize`, `model`, ...) is plain, platform-agnostic Rust.
//!
//! Every `#[wasm_bindgen]` attribute below is
//! `#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]`-gated so this module
//! — and therefore `cargo build`/`cargo test` on the native host — keeps
//! compiling and exercising the exact same function bodies. The
//! `wasm_bindgen` crate itself is an unconditional dependency; only the
//! attribute *application* is gated.
//!
//! ## Why this module hand-rolls JSON instead of using `serde_json`
//!
//! `serde`/`serde_json` are `parity`-feature-only dependencies
//! (`Cargo.toml`): they exist for `seam.rs`'s stage-boundary fixtures, a
//! native-test-only concern, and are never linked into the wasm `cdylib`.
//! `opts_json` (5 fields plus the optional `quad`) and `dewarp_status_json`
//! (a dozen scalars, one nested object) are both small, fixed, hand-writable
//! shapes — parsing/encoding them without pulling `serde_json` into the
//! shipped wasm binary keeps the crate's only JSON dependency scoped to the
//! native parity harness, and keeps the shipped binary under its ≤500KB
//! gzip ceiling. `quad`'s value is the one nested-array shape this ABI ever
//! receives (`[[f64;2];4]`); the parser below grows exactly enough array
//! support for that one shape — additive, not a general JSON parser
//! rewrite.

use crate::options::{Preset, QualityOptions, QualityOptionsOverrides};
use crate::pipeline::{DewarpStatus, ExportQuad};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::wasm_bindgen;

/// `Date.now()` binding, wasm-only — the portable wall-clock source for
/// `elapsed_ms`. `std::time::Instant` is not available on
/// `wasm32-unknown-unknown` (no OS clock without `web-sys`, which is not a
/// dependency of this crate and is deliberately kept off the frozen
/// dependency list); this is the minimal `wasm_bindgen` `extern` binding to
/// get one JS call without adding `js-sys`/`web-sys` to `Cargo.toml`.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date)]
    fn now() -> f64;
}

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    now()
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// The wasm ABI's backward-grid density: `65×47`, replacing UVDoc's
/// `45×31`. `GRID_ROWS` = height (`v` axis), `GRID_COLS` = width (`u` axis)
/// — matches `parseGridTensor`'s existing unpack order and the TS side's
/// `CLASSICAL_GRID_HEIGHT`/`CLASSICAL_GRID_WIDTH` constants.
pub const GRID_ROWS: u32 = 65;
pub const GRID_COLS: u32 = 47;

/// `WASM_INPUT_MAX_SIDE` — documented here (not enforced
/// here) because it governs what a well-behaved caller hands to
/// [`dewarp_alloc_input`]; the TS side, not this crate, is responsible for
/// the pre-downsample. This crate's own internal S0 resize
/// (`opts.proc_max_side`, capped at 3× upscale) runs regardless of input
/// size.
pub const WASM_INPUT_MAX_SIDE: u32 = 1600;

/// The `opts_json` shape, parsed. Mirrors `options.py`'s `QualityOptions`
/// plus the `use_line_term` pipeline switch (which is a `dewarp_image`
/// parameter in Python, not a `QualityOptions` field), the two
/// forward-looking overrides, and the optional confirmed-quad framing hint
/// — the one field with no Python-reference counterpart, since the
/// confidence/status layer itself has none either.
/// **Do not add fields the Python reference doesn't have** beyond that one,
/// documented exception.
#[derive(Debug, Clone, PartialEq)]
pub struct DewarpOptsJson {
    pub preset: Preset,
    pub use_line_term: bool,
    pub f_exif_px: Option<f64>,
    pub max_nfev: Option<u32>,
    pub n_outlier_iter: Option<u32>,
    pub quad: Option<ExportQuad>,
}

/// Minimal parsed JSON value — every field except `quad` is flat
/// (`opts_json`'s base shape: `{"key": <string|bool|null|number>,
/// ...}`); `quad`'s value is the one nested shape this ABI ever receives
/// (an array of arrays), so `Arr` exists for exactly that, not for JSON
/// arrays in general. See this module's doc comment for why this isn't
/// `serde_json`.
#[derive(Debug, Clone, PartialEq)]
enum JsonVal {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsonVal>),
}

impl JsonVal {
    fn as_str(&self) -> Option<&str> {
        if let JsonVal::Str(s) = self {
            Some(s.as_str())
        } else {
            None
        }
    }

    fn as_bool(&self) -> Option<bool> {
        if let JsonVal::Bool(b) = self {
            Some(*b)
        } else {
            None
        }
    }

    /// `null` and a missing key both read as `None`; a present number reads
    /// as `Some` — matches how `opts_json`'s optional fields (`f_exif_px`,
    /// `max_nfev`, `n_outlier_iter`) are used: null means preset default.
    fn as_f64_opt(&self) -> Option<f64> {
        if let JsonVal::Num(v) = self {
            Some(*v)
        } else {
            None
        }
    }

    fn as_arr(&self) -> Option<&[JsonVal]> {
        if let JsonVal::Arr(a) = self {
            Some(a.as_slice())
        } else {
            None
        }
    }
}

fn skip_ws(b: &[char], i: &mut usize) {
    while *i < b.len() && b[*i].is_whitespace() {
        *i += 1;
    }
}

/// Parse one JSON value: string/bool/null/number, or a `[` ... `]` array
/// (see this module's own doc comment) whose elements
/// recurse through this same function — enough to cover `quad`'s
/// `[[f64;2];4]` shape without a general-purpose JSON array grammar (no
/// trailing commas, no whitespace-only arrays beyond what `skip_ws` already
/// handles — `opts_json` is producer-controlled, `classical.ts`'s own
/// `JSON.stringify`, never hand-authored).
fn parse_json_value(b: &[char], i: &mut usize) -> Result<JsonVal, String> {
    let n = b.len();
    skip_ws(b, i);
    if *i >= n {
        return Err("opts_json: unexpected end of input".to_string());
    }
    if b[*i] == '"' {
        *i += 1;
        let vs = *i;
        while *i < n && b[*i] != '"' {
            *i += 1;
        }
        if *i >= n {
            return Err("opts_json: unterminated string value".to_string());
        }
        let sval: String = b[vs..*i].iter().collect();
        *i += 1;
        Ok(JsonVal::Str(sval))
    } else if b[*i..].starts_with(&['t', 'r', 'u', 'e']) {
        *i += 4;
        Ok(JsonVal::Bool(true))
    } else if b[*i..].starts_with(&['f', 'a', 'l', 's', 'e']) {
        *i += 5;
        Ok(JsonVal::Bool(false))
    } else if b[*i..].starts_with(&['n', 'u', 'l', 'l']) {
        *i += 4;
        Ok(JsonVal::Null)
    } else if b[*i] == '[' {
        *i += 1;
        let mut items = Vec::new();
        skip_ws(b, i);
        if *i < n && b[*i] == ']' {
            *i += 1;
            return Ok(JsonVal::Arr(items));
        }
        loop {
            items.push(parse_json_value(b, i)?);
            skip_ws(b, i);
            if *i < n && b[*i] == ',' {
                *i += 1;
                continue;
            }
            if *i < n && b[*i] == ']' {
                *i += 1;
                break;
            }
            return Err("opts_json: expected ',' or ']'".to_string());
        }
        Ok(JsonVal::Arr(items))
    } else {
        let vs = *i;
        while *i < n && (b[*i].is_ascii_digit() || matches!(b[*i], '-' | '+' | '.' | 'e' | 'E')) {
            *i += 1;
        }
        let numstr: String = b[vs..*i].iter().collect();
        let v: f64 = numstr
            .parse()
            .map_err(|_| format!("opts_json: invalid number {numstr:?}"))?;
        Ok(JsonVal::Num(v))
    }
}

/// Parse a flat `{"key": value, ...}` JSON object — "flat" meaning no
/// *nested objects*. There is exactly one array-valued key (`quad`),
/// handled by [`parse_json_value`]'s recursion, not a second top-level
/// shape.
#[allow(unused_assignments)] // the final `i += 1` (consuming the closing '}') is followed by `break`
fn parse_flat_json_object(s: &str) -> Result<std::collections::HashMap<String, JsonVal>, String> {
    let b: Vec<char> = s.chars().collect();
    let n = b.len();
    let mut i = 0usize;

    skip_ws(&b, &mut i);
    if i >= n || b[i] != '{' {
        return Err("opts_json: expected '{'".to_string());
    }
    i += 1;
    skip_ws(&b, &mut i);

    let mut map = std::collections::HashMap::new();
    if i < n && b[i] == '}' {
        return Ok(map);
    }

    loop {
        skip_ws(&b, &mut i);
        if i >= n || b[i] != '"' {
            return Err("opts_json: expected key string".to_string());
        }
        i += 1;
        let key_start = i;
        while i < n && b[i] != '"' {
            i += 1;
        }
        if i >= n {
            return Err("opts_json: unterminated key string".to_string());
        }
        let key: String = b[key_start..i].iter().collect();
        i += 1;
        skip_ws(&b, &mut i);
        if i >= n || b[i] != ':' {
            return Err("opts_json: expected ':'".to_string());
        }
        i += 1;
        let val = parse_json_value(&b, &mut i)?;
        map.insert(key, val);

        skip_ws(&b, &mut i);
        if i < n && b[i] == ',' {
            i += 1;
            continue;
        }
        if i < n && b[i] == '}' {
            i += 1;
            break;
        }
        return Err("opts_json: expected ',' or '}'".to_string());
    }
    Ok(map)
}

/// Parse `opts_json` by hand — see this module's doc comment for why this
/// isn't `serde_json`. Unknown fields are ignored (forward-compatible,
/// matching how the status JSON is additive-forward); a missing `preset` or
/// `use_line_term` is an error, since those are the only two fields the TS
/// caller is ever required to set.
fn parse_opts_json(s: &str) -> Result<DewarpOptsJson, String> {
    let map = parse_flat_json_object(s)?;
    let preset_str = map
        .get("preset")
        .and_then(JsonVal::as_str)
        .ok_or_else(|| "opts_json: missing/invalid \"preset\"".to_string())?;
    let preset = match preset_str {
        "fast" => Preset::Fast,
        "default" => Preset::Default,
        "high" => Preset::High,
        other => return Err(format!("opts_json: unknown preset {other:?}")),
    };
    let use_line_term = map
        .get("use_line_term")
        .and_then(JsonVal::as_bool)
        .ok_or_else(|| "opts_json: missing/invalid \"use_line_term\"".to_string())?;
    let f_exif_px = map.get("f_exif_px").and_then(JsonVal::as_f64_opt);
    let max_nfev = map
        .get("max_nfev")
        .and_then(JsonVal::as_f64_opt)
        .map(|v| v as u32);
    let n_outlier_iter = map
        .get("n_outlier_iter")
        .and_then(JsonVal::as_f64_opt)
        .map(|v| v as u32);
    let quad = map.get("quad").and_then(parse_quad);
    Ok(DewarpOptsJson {
        preset,
        use_line_term,
        f_exif_px,
        max_nfev,
        n_outlier_iter,
        quad,
    })
}

/// `opts_json.quad`, when present, is
/// `[[tlx,tly],[trx,try],[brx,bry],[blx,bly]]` — buffer-normalized `[0,1]`,
/// clockwise from the top-left (matching `DewarpQuad`'s own winding,
/// `types.ts`). Absent or malformed both read as `None` — a quad this ABI
/// cannot parse is treated exactly like "no quad was supplied" (no quad ⇒
/// current framing), never a hard `opts_json` parse error: a caller-side
/// mistake must degrade gracefully, not panic or reject the call.
fn parse_quad(val: &JsonVal) -> Option<ExportQuad> {
    let arr = val.as_arr()?;
    if arr.len() != 4 {
        return None;
    }
    let point = |v: &JsonVal| -> Option<[f64; 2]> {
        let pair = v.as_arr()?;
        if pair.len() != 2 {
            return None;
        }
        Some([pair[0].as_f64_opt()?, pair[1].as_f64_opt()?])
    };
    Some(ExportQuad {
        top_left: point(&arr[0])?,
        top_right: point(&arr[1])?,
        bottom_right: point(&arr[2])?,
        bottom_left: point(&arr[3])?,
    })
}

/// Resolve `opts_json` into a concrete [`QualityOptions`] via
/// [`crate::options::make_options`].
fn resolve_options(parsed: &DewarpOptsJson) -> QualityOptions {
    let overrides = QualityOptionsOverrides {
        f_exif_px: parsed.f_exif_px,
        max_nfev: parsed.max_nfev,
        n_outlier_iter: parsed.n_outlier_iter,
    };
    crate::options::make_options(parsed.preset, overrides)
}

/// Opaque result handle — a boxed pointer, opaque to JS.
/// Owns the grid buffer and the status; freed via [`dewarp_free_result`].
pub struct DewarpResultHandle {
    /// `ROWS*COLS*2` `f32`s: plane 0 = x, plane 1 = y, each plane row-major
    /// `ROWS × COLS`.
    grid: Vec<f32>,
    status: DewarpStatus,
}

/// Exported allocator. `len` is the RGBA byte length
/// (`w*h*4`). The caller writes the crop's pixels into the returned
/// pointer before calling [`dewarp`], then must **not** free it —
/// `dewarp` takes ownership.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn dewarp_alloc_input(len: usize) -> *mut u8 {
    let mut buf = vec![0u8; len].into_boxed_slice();
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// Run one dewarp. `input_ptr`/`width`/`height` describe
/// the RGBA8 buffer previously allocated by [`dewarp_alloc_input`] and
/// filled by the caller, `width*height*4` bytes, row-major, no padding.
/// `opts_json` is the options JSON string.
///
/// Never panics into JS: any internal failure — no
/// features detected, or [`pipeline::prepare_geometry`] returning `None` —
/// surfaces as `status.converged = false` plus a still-valid identity-ish
/// grid (every node maps straight through, no deformation), so
/// [`dewarp_grid_ptr`]/[`dewarp_grid_len`] are always safe to read
/// afterward. `panic = "abort"` (`Cargo.toml`'s release profile) plus a
/// debug-only `console_error_panic_hook` (the `console_error_panic_hook`
/// feature, stripped from release builds) covers the "never panics into
/// JS" contract for genuinely unexpected failures; the *expected* failure
/// modes above are represented as data, not as a panic, so the TS caller
/// never needs to catch anything to get a usable (if `converged: false`)
/// result.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn dewarp(
    input_ptr: *mut u8,
    width: u32,
    height: u32,
    opts_json: &str,
) -> *mut DewarpResultHandle {
    let t0 = now_ms();
    let len = (width as usize) * (height as usize) * 4;

    // SAFETY: `input_ptr` was returned by `dewarp_alloc_input(len)` — which
    // leaked a `Box<[u8]>` of exactly that length (`core::mem::forget`) —
    // and the caller has since filled it with `len` bytes of RGBA pixels
    // before calling here: the caller writes the crop's pixels into the
    // returned pointer before calling `dewarp`, then must NOT free it —
    // `dewarp` takes ownership. Reconstructing the boxed
    // slice with the same length it was allocated at is exactly the
    // inverse of `dewarp_alloc_input`'s leak, so this recovers the
    // allocation without a double-free or a layout mismatch.
    let boxed: Box<[u8]> =
        unsafe { Box::from_raw(core::slice::from_raw_parts_mut(input_ptr, len)) };
    let buf: Vec<u8> = boxed.into_vec();
    let img = image::RgbaImage::from_raw(width, height, buf).expect(
        "dewarp: width*height*4 always equals the buffer length dewarp_alloc_input allocated",
    );

    let parsed = parse_opts_json(opts_json).unwrap_or_else(|_| {
        // Malformed opts_json never panics into JS — fall
        // back to a conservative, always-valid configuration (the default
        // preset, no line term) rather than aborting the call.
        DewarpOptsJson {
            preset: Preset::Default,
            use_line_term: false,
            f_exif_px: None,
            max_nfev: None,
            n_outlier_iter: None,
            quad: None,
        }
    });
    let options = resolve_options(&parsed);

    let result = crate::pipeline::dewarp_image(
        &img,
        parsed.use_line_term,
        &options,
        GRID_ROWS,
        GRID_COLS,
        parsed.quad.as_ref(),
    );

    let grid_f32 = match &result.grid {
        Some(g) => crate::pipeline::grid_to_ndc_planes(&g.samples, width, height),
        None => vec![0f32; (GRID_ROWS * GRID_COLS * 2) as usize],
    };

    let mut status = result.status;
    status.elapsed_ms = (now_ms() - t0).max(0.0).round() as u64;

    Box::into_raw(Box::new(DewarpResultHandle {
        grid: grid_f32,
        status,
    }))
}

/// Pointer to the backward grid: `f32`,
/// `GRID_ROWS × GRID_COLS × 2` planes. Valid until [`dewarp_free_result`].
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn dewarp_grid_ptr(handle: *const DewarpResultHandle) -> *const f32 {
    let handle = unsafe { &*handle };
    handle.grid.as_ptr()
}

/// `= GRID_ROWS * GRID_COLS * 2`.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn dewarp_grid_len(handle: *const DewarpResultHandle) -> usize {
    let handle = unsafe { &*handle };
    handle.grid.len()
}

/// Status/confidence, as a UTF-8 JSON string.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn dewarp_status_json(handle: *const DewarpResultHandle) -> String {
    let handle = unsafe { &*handle };
    handle.status.to_json()
}

/// Frees a handle returned by [`dewarp`]. Must be called exactly once per
/// handle.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn dewarp_free_result(handle: *mut DewarpResultHandle) {
    if handle.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(handle));
    }
}
