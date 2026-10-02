# Detection bench

A development-only harness that measures the scanner's page detection the way
the person holding the phone experiences it: **would the crop have been right?**
Nothing here ships — `package.json` publishes `dist/`, `assets/` and
`scripts/copy-assets.mjs` only — and nothing under `src/` imports it.

```sh
npm run bench -- --suite detector --family F1 --seeds 10   # one family, quick
npm run bench -- --suite detector --seeds 10               # F1–F7, ~1 min
npm run bench -- --suite detector                          # every family, 40 seeds, ~4 min
npm run bench -- --suite detector --cpu 4                  # a mid-range phone's CPU
npm run bench -- --suite detector --seeds 10 --compare .bench-out/latest-detector/results.json
npm run bench -- --suite detector --family F7 --setting screen,booklet --seeds 20   # 20 scenes of each setting
npm run bench -- --suite session                           # every session once, ~7 min
npm run bench -- --suite session --session page-swap --seeds 3 --cpu 4
npm run bench -- --suite session --session sustained-hold --seeds 3 --cpu 4   # 75 s, remounts, leaks
npm run bench -- --suite session --seeds 3 --lane main     # force the main-thread detection lane
npm run bench -- --suite session --seeds 3 --layout standard   # on the pre-rail capture screen (default: rail)
npm run bench -- --suite session --session regression --seeds 5   # the adversarial sessions (fast pans, steep tilts…)
npm run bench -- --suite session --session guidance --seeds 5     # hints, the ready cue, auto-capture (Phase 4)
npm run bench:webkit                                       # the flow end to end in WebKit, both lanes
npm run bench -- --suite emulator --seeds 10               # the emulator's own GT check
npm run bench -- --suite straighten --quick               # Endireitar, 83 scenes, ~1 min (Node, no browser)
npm run bench -- --suite straighten                        # all 279 scenes, ~4 min at --jobs 8 (12 cores)
npm run bench -- --suite straighten --compare .bench-out/latest-straighten/results.json
npm run bench -- --suite straighten --engine-root ../other-worktree --sheets   # score another checkout's engine
npm run bench:play                                         # the playground, in a Chromium window
npm run bench:play -- --no-browser                         # …or serve it and open the URL yourself
node scripts/bench/server.mjs                              # serve the bench pages, print the URL

# Real media — local only, never inside this repository (see "Real media" below)
export SCAN_REAL_MEDIA=/path/to/real/photos-and-clips
npm run bench -- --suite real-stills                       # ~10 s
npm run bench -- --suite real-video                        # ~2 min, incl. replay through the app
SCAN_BENCH_LABELS=~/.cache/scan-bench/labels/scan-bench-labels.json \
  npm run bench -- --suite straighten-real                  # Endireitar on the labelled stills, ~1 min
npm run bench:label                                        # label pages by hand, print the URL
node scripts/bench/real.mjs                                # extract clip frames, list what was found
```

## Privacy — the rules this directory is built around

- **Synthetic output** (reports, contact sheets, the page bundle) goes to the
  git-ignored `.bench-out/`. Every synthetic pixel is rendered from a seed at run
  time; no image is ever committed.
- **Real media** is found only through `SCAN_REAL_MEDIA`. Anything derived from
  it — frames, overlays, reports that embed pixels — is written only under
  `${XDG_CACHE_HOME:-~/.cache}/scan-bench/`, never inside this repository
  (`run.mjs` refuses an `--out` that would be), and never uploaded anywhere.
- The bench server binds `127.0.0.1` only and answers only requests addressed
  to it. `/real/` exists only when `SCAN_REAL_MEDIA` is set.
- Hand labels (`POST /labels`) go to `SCAN_BENCH_LABELS`, else
  `$SCAN_REAL_MEDIA/scan-bench-labels.json` — but only after `git check-ignore`
  confirms the target (and its `.tmp`) is ignored in whatever work tree it is
  in; otherwise, and always for a path inside this repository, they fall back
  to the cache. The check runs again before every write and **fails closed**:
  git is asked with the caller's `GIT_*` variables stripped, and a target
  counts as outside any work tree only when no `.git` sits above it *and* git
  says "not a git repository" — git missing, a repository git refuses
  ("dubious ownership") or any other error sends the labels to the cache.
- Real stills are served byte for byte, and only the ones `real.mjs`
  discovers (`/real/stills/…` is an allowlist, not a directory listing); video
  frames only from the cache. A screen recording is never detector input.
- The real reports print file names and numbers; their contact sheets and
  film strips hold real pixels and stay in the cache with them.
- Generated documents name only the repository's personas (JOÃO AZELO, MARIA
  AZELO) and carry only short, plainly clinical numbers.

## How a run works

`run.mjs` bundles `scripts/bench/app/` with esbuild **from the library's source**
(the working tree, not a packed build), makes sure `assets/` holds the detector
runtime (running `build-assets.mjs` / `build.mjs` if not) and that
`dist/styles.css` is current (rebuilt when missing or older than `src/` or the
Tailwind config — the session and replay suites lay `<ScanFlow>` out with it),
serves them, and drives the page in Chromium through `window.__bench`:

| call | what it does |
|---|---|
| `init({ assetBase })` | points the library at `/assets/`, warms the ML runtime (`warmUpMl`) |
| `scene(family, seed, { size })` | renders one scene; answers its params and ground truth |
| `load(id, url, { thumbLongEdge })` | decodes a real image the way the app decodes a photo, keeps it by id |
| `detect(variant, sceneId)` | runs one detector variant on that frame |
| `evidence(sceneId, quads)` | the live loop's paper evidence (`src/lib/paper-evidence.ts`) for each quad on the frame's 640 px sample, with its raw readings — for tuning the rules in Node |
| `refineLive(sceneId, quad)` | a quad refined on the frame's 640 px live sample, as the live loop refines the model's answer |
| `sheet(spec)` | draws a contact sheet |
| `selfCheck(family, seed)` | renders the scene as white-on-black and measures it against its GT |
| `emulator` | the scene emulator module itself, for a console or a one-off script |

The session suite drives a second page, `/page-session.html`, through
`window.__session` (`prepare` or `prepareClip`, `run`, `sheet`; see below). The
labelling page is `/page-label.html`, the playground `/page-play.html`.

Pixels stay in the page; only numbers, quads and finished sheet images travel
to Node.

**Chromium.** Playwright's own build if installed; else `SCAN_BENCH_CHROMIUM`;
else the newest `chromium-*` in Playwright's cache. WebGL is pinned to
SwiftShader (deterministic pixels on any machine with the same browser build);
2-D canvas stays on the CPU, as the detectors' `getImageData` expects.
`--headed` shows the window. `--cpu N` applies CDP CPU throttling **only while a
detector runs**.

## Detector variants (`app/detectors.js`)

Every variant calls `src/lib/flatten.ts` exactly as the product does — same
options, same coverage floors, same fallback chain.

| variant | what it is |
|---|---|
| `ml` | one live-loop ML pass: the frame drawn down to 640 px, `detectOnCanvasMl`, the loop's conditioned coverage floor |
| `classical` | one live-loop classical pass: same sample, `detectOnCanvas` (0.35 `minDocumentCoverageRatio`), same floor |
| `production` | the capture path **before** edge refinement: `detectInCanvas(…, { refine: false })` on the full frame — ML first, trusted floor, classical fallback |
| `refined` | the capture path as the product runs it: `production` + the edge refinement (`src/lib/refine.ts`) on the full frame |
| `ml+refine` | the `ml` pass, its quad then refined on the full frame the way a capture refines a carried live quad (`refineCorners`) |
| `ml+live` | the `ml` pass, its quad refined on its own 640 px sample — what the live overlay draws; the real-video replay also scores the overlay against it |

The refining variants carry the refinement's own report (`det.refine`: its
input quad, ms, per-side mode and verdict). The report adds, per family, how
often it moved the quad, how its sides went (snapped **local**ly, searched
**wide**, or **kept**), its time p50/p95, and its **flips** against
its unrefined twin (`refined` against `production`, `ml+refine` against `ml`)
on the same scenes: right → wrong (the number that must stay 0) and wrong →
right, with the seeds — and **off image**, how many of its answers have a
corner outside the frame (a `NormalizedQuad` is 0–1; this must stay 0). On
the contact sheets a refining variant's input is drawn thin, dashed light
blue, under its answer.

## Edge refinement (`src/lib/refine.ts`)

What the product does to the corners that seed the confirm screen, after
every gate: the detector's quad is a prior, each side is searched for the
paper's edge. Per side, 64 profiles normal to it (8 % of the side skipped at
each end), sampled on a 1200 px copy of the captured image:

1. **local** — a box step (inside minus outside, 3 px each, luma plus two
   chroma channels) along each profile within ±2.5 % of the diagonal; per
   profile the strongest few steps, the strongest in each stretch of it and
   the outermost two (a dense run of rules cannot crowd a faint edge out); a
   Hough vote over (slope ≤ 4°, offset), at most 24 peaks per slope and 512
   in all; each peak refitted with one polarity-consistent point per profile
   (Tukey IRLS), and dropped if the refit turned it more than 2 px (at the
   last profile) past the slope limit. A line with fewer than 60 % of the
   profiles backing it away from a better-supported line is that line's
   *twin* and is dropped (a printed rule a few degrees off the edge, meeting
   it at one end, has points of its own). A line is *eligible* with ≥ 60 % of
   the profiles, RMS residual ≤ 1.5 px and **paper just inside it** on ≥ 60 %
   of them — the page's **stock**, whatever its colour: the 90th-percentile
   luma of the page for white paper, or the dominant material along the
   prior's border when that covers most of it and is another stock (a navy
   card printed in white, a kraft envelope with a white label), read next to
   each profile. A thin printed line just inside the edge (a form's border)
   still counts as paper inside it; a line that is a flank of a thin printed
   line with the page's paper on both sides is **print**, never eligible. The
   **outermost** eligible line wins — a header band's or a table rule's edge
   has paper beyond it — except that a contact shadow's outer flank gives way
   to the paper's edge within 12 px inside it when the shadow between them
   (read a pixel in from each) is darker than both the paper and the table;
   never past a confident line (80 % of the profiles) with paper-coloured
   surface right outside it (the sheet below, a white table: *paper meets
   paper*), nor to an outer
   line that only **repeats the background**: the same even, non-paper
   surface just outside it as just outside a nearer confident edge (a striped
   cloth's next white stripe, the next tile). An **inward** move (content
   protection: a sliver of desk beats a clipped report) must cut away only a
   strip that looks like the background outside the prior and unlike the paper
   inside the new line, with no 12 px stretch of *different* paper beyond it
   (the white margin above a header band the prior sat in) — on 60 % of the
   profiles deep enough to measure and on half of those in each end quarter
   of the side (a curled receipt's chord cuts its corners off) — and fails
   closed: with fewer than 3 (or half) of those profiles able to see the
   background past the prior, the side stays. Deeper than 0.5 % of the
   diagonal, the strip must not end in a straight edge of its own further
   out — a band that does (a fold's shaded margin, a full-bleed header, a
   lab's name bar, a curled strip) is the page's. The check runs wherever the
   line is inside the prior, not only at its middle (a line turned against
   the prior can be on it at the middle and well inside at one end), leaving
   6 px of turn unjudged.
2. **wide** — only for the ML detector's quads, only when the local pass
   found no page edge on that side (a found edge with paper right outside it,
   or background — neither paper nor a band of ink — stops it; a dark even
   surface that matches the desk seen past the other sides is background,
   not ink) and paper lies within 5 % of the diagonal past the side. The same
   search out to 18 % of the diagonal at slopes up to 25°, the outermost
   eligible line past the local one that does not repeat the background
   outside the prior and does not cross 12 px of that dark desk after paper
   on 30 % of its profiles (the page's edge, a black mat, a sheet beyond).
   This is what takes a corner the model pulled onto the text block or a
   shading band (or a header band the model took for the top) back to the
   page. A side moved this far counts only when at least one of the two sides
   it meets was found too.
3. **steep** — a side still unfound between two found sides is searched once
   more, turning up to 40°: a corner the model pulled far along one side
   leaves the side between it and the next corner at a steep angle to the
   page's edge, and the two found sides say where its corners must be.
4. corners are the intersections of adjacent lines; the quad must stay convex,
   wound as the prior is, with every angle in [20°, 160°], every corner on the
   image (0.5 px of slack; an input corner already off it may stay as far
   off), within 0.7–2.5× the prior's area and sharing 85 % of the smaller of
   the two with the prior (the same page, not a neighbour) — else sides fall
   back one step at a time (wide to local, local to the prior; the biggest
   move first), and last, to the input. `changed` means a corner moved by
   half a working pixel or more.

The classical detector's quads (and a carried quad of unknown origin) are
refined locally only: their confident failure is the desk, and a wide search
from the desk only makes the desk look more like a page. Any error, doubt or
the 250 ms budget (the downscale included; checked inside every loop that
grows with the image or the side — ~2 ms of work between two checks on
this bench's desktop) answers the input unchanged. Nothing is kept between
calls: the working canvas is released as soon as it is read, and the planes
are per call.

## The live loop (`src/hooks/useLiveDetect.ts`)

What the viewfinder draws while the person aims — tuned on this bench, and
what the session suite measures. In order of a pass:

1. **Where it runs** (`src/lib/detect-lane.ts`, `detect-protocol.ts`,
   `detect.worker.ts`). The page decides once, with a reason (probe event
   `lane`): the **worker** lane — scanic imported inside a module worker
   from `assets/scanic/`, its ML detector on the same self-hosted ONNX
   Runtime files, one worker per page, created as the capture screen mounts
   (the model downloads and compiles while the primer is read) — or the
   **main** lane, the path that shipped before: no `Worker` or
   `createImageBitmap`, no hello within 5 s, a load error (a 404, or a CSP
   header on the worker's *own* response), no 2-D `OffscreenCanvas` in the
   worker, no WebAssembly there (`no-wasm-in-worker`: the worker compiles the
   smallest module before its hello — a CSP on its response without
   `'wasm-unsafe-eval'` refuses it), scanic not loading there, or, later in
   the page, a worker that died (`worker-crashed`), whose model failed
   (`worker-ml-failed` — not a latch: the main thread warms its own model
   and latches only if that fails too), that timed out three passes running
   (`worker-stalled`) or could not take five frames running
   (`frame-grab-failed`, `createImageBitmap` rejecting or empty, or the
   worker unable to draw it). On the worker lane a live pass that times out
   is a missed pass, never the hopeless verdict or the ML latch: the worker
   runs one job at a time, so a timeout there is a pass queued behind a
   capture, not two detections overlapping; a pass whose budget ran out is
   cancelled in the worker if it has not started. The loop's first measured
   pass waits for the worker's `ready` (scanic loaded there), as the main
   lane's waits for scanic's import. The worker is held by the mounted
   capture screens and terminated a minute after the last one unmounts (a
   remount within that minute gets it warm); a mount with other asset URLs
   while nothing else holds it starts a new one. The main thread
   grabs the frame with `createImageBitmap(video, { resizeWidth,
   resizeHeight })` at the default resize quality (a finer one changed the
   model's answers on half the spike's frames) and transfers it; the worker
   keeps one live frame at most (a newer one replaces it) and puts a
   capture's frame first, yielding to its event loop before each pick. While
   the worker lane is on, the model never runs on the main thread (one ONNX
   session per page).
2. **How often** (`src/lib/cadence.ts`): `interval = clamp(ewma(cost) /
   duty, min, max)` — worker lane 35 % of its thread, 120–700 ms; main lane
   15 %, 150–700 ms, a pass over 50 ms charged double (the ceiling is the
   old fixed beat: at 1400 ms the main lane under `--cpu 4` held the page
   less of the time than before the rework). On this desktop the worker lane
   settles at 120 ms (8 passes a second); under `--cpu 4` (worker slowed 4×)
   it backs off by itself. The *hopeless* verdict (`adapt`) averages the
   detector's own time, not the refinement and evidence riding on the pass:
   charged with them, a main-lane classical loop under `--cpu 4` crossed its
   250 ms line in 4 of 42 runs before the model was ready and live
   detection stayed off for the whole session.
3. **What it answers**: the model's quad, the motion probe's 24×24 luma of
   the same frame, the hint chip's focus/light reading (every 200 ms — the
   capture screen's own timer does not run on the worker lane), and:
4. **Refined onto the paper's edges on its own frame** (`refineQuad`, the
   refinement a capture runs, on the ~640 px sample, 60 ms budget). Measured
   with `refineLive` on 58 F1/F2 scenes where the model answered: its live
   answer within 2 % of the page went from 41 to 53, wrong crops from 13 to
   4, corner error p50 from 1.01 to 0.08 % of the diagonal (two already-wrong
   answers got slightly worse), for 6.8 ms p50 / 17 ms p95 a pass. The
   refined quad is what is drawn, what the evidence reads, what a jump to
   another page is judged on (the model's own answer can swing between two
   readings of one page that the refinement puts back on the same edges) and
   what the capture buffer carries — the corners the user was looking at;
   acceptance (the coverage floor, arbitration) and the stale horizon read
   the model's own answer and its frame's time.
5. **Paper evidence** (`src/lib/paper-evidence.ts`): edges — per side, 20
   profiles, the strongest inside/outside step within 2.5 % of the short
   side, and the side is supported when most of them step the same way on
   one straight line (a white page on a white table steps only 3–8 luma
   levels, but steadily) — and a paper surface with print: most of the
   interior on its own smooth background (block medians), ink deviating one
   way, spread over the page, strokes rather than solid areas. The rules
   (`PAPER`) were searched over the model's own quads on 186 synthetic pages
   (F1–F7), 55 page-less F6 scenes it answered on and 94 real stills and clip
   frames (numbers only): they keep 98.9 % of the synthetic pages and 94.7 %
   of the real ones and pass 4 of the 55 laptops, keyboards, notebooks and
   place mats. (A search on synthetic data alone found rules that passed 0 of
   55 and failed all five capture-issue stills.) One allowance came from the
   real-video replay: on the sparse, pale `pii_free` page at 1080p the ink
   share sat under the 2.5 % floor, so the overlay was hidden on 36 % of the
   hold. On an interior at least 92 % background, 1.2 % ink is enough — the
   evidence then passed 102 of that clip's 107 readings instead of 74, the
   real stills and frames 89 of 94 instead of 86, and one more place mat (4
   of 55). It was chosen with that clip in view, so the replay's hidden share
   is no longer an unseen measure. The background floor was then raised from
   0.65 to 0.68 after a black keyboard on a wooden desk (`empty-desk-sweep`
   seed 3) locked at ~0.67 and was captured as a page: over the model's
   passes in 10-seed session runs, the empty-desk readings passing as paper
   fell from 35 of 676 to 12, with none of the hold sessions' 7896 readings,
   the synthetic pages or the real stills lost (3 of the 55 F6 scenes pass).
   The same keyboard still passed at 0.68–0.71 with little ink (0.03–0.05:
   0.09–0.15 of the non-background share), so a sheet under 0.75 background
   must hold ink of at least 0.22 of the rest (`marginalBackground`,
   `minInkOfRest`): every real and synthetic page there holds 0.31 or more.
   Over the Phase 3 session runs (cpu 1 and 4) the page-less readings passing
   as paper fell from 30 of 1165 to 4, and not one reading of a page changed
   (8064 hold-session readings, the 186 synthetic pages, the 94 real stills,
   the replayed clips). The evidence also reports, outside its verdict, the
   interior's share clipped white on paper that is not itself clipped (the
   "reflection" hint's `glare`) and how many edgeless sides have the page's
   own paper running on past them to the frame's edge (`open`: a page cut
   off whose quad the model drew short of the edge).
6. **Found**: two readings in a row that say paper, with every visible side
   at least 30 % supported (a quad with a corner pulled onto the text has a
   side with no edge under it at all); let go after two readings that do not
   (a thumb over an edge keeps it). Two allowances for a sheet this page has
   just seen (both from the `regression` sessions): a reading within 8 % of
   the diagonal of the last found sheet, seen in the last 10 s, with every
   side at least 80 % supported, is found on one reading (a whip back, a
   remount, a page put down where the last one was — under `--cpu 4` a second
   reading is ~450 ms away); and a found sheet that is strongly foreshortened
   (a pair of opposite sides at most 0.75 of each other) and whose sides all
   stay 80 % supported does not lose a reading to its surface alone (a page tilted
   45–55°, its print foreshortened into solid-looking blocks and its light
   into a gradient, read as not paper: `steep-tilt` seed 1 hid a right quad
   for the whole 2 s steep hold; the foreshortening condition keeps it
   from a black keyboard seen head-on, whose four edges are as strong and
   which, kept "found", was carried into an `empty-desk-sweep` capture). The 80 % bar is what keeps both from
   carrying a quad with a corner pulled onto the table (`steep-tilt` seed 2,
   whose sides stay at 5–65 %). A pass that finds nothing reads the
   evidence where the found sheet was drawn: a page slid away — on a white
   table the motion probe barely sees it go — leaves no edges there, and two
   such readings end the hold (on `page-swap` the stale overlay's p95 went
   from ~950 to ~590 ms) — one, when the scene moved (motion score 0.05 and
   up) or the model answered a quad elsewhere that the loop did not take (the
   worker then reads the evidence at the held place too). A sheet known to
   have gone — a hold broken so, or a jump to another page — fades out in
   100 ms instead of 300. Only a found quad is drawn, says "sheet found", and
   may travel with a capture as its buffered corners (an unconvincing quad
   the model was sure of — a laptop lid — was never on screen, and on the
   empty desk it had been carried into captures).
7. **Classical quads** (before the model is ready, or after it failed): never
   drawn once the model is ready; before that only if they touch at most one
   frame border, have no interior angle under 35°, are not slivers (short
   over long side ≥ 0.18) and pass the evidence.
8. **Drawn** through a per-corner One-Euro filter (`src/lib/one-euro.ts`,
   min cutoff 1 Hz, β 64, derivative cutoff 5 Hz) and a 16 ms glide, reset on
   a new detector, a jump of 8 % of the diagonal, a lost hold or a new frame
   box. Replaying the recorded detections through a grid of settings, every
   setting kept the overlay on the page within a point of drawing each
   answer as it came; this one cut the drawn corners' frame-to-frame motion
   by ~8 %, and the overlay's RMS motion over a hold now matches the page's
   own (the old two-sample average and 35 %-per-frame easing lagged it).

**Capture: the classical fall-through.** When the model is ready and answers
"no page", the capture path still asks the classical detector
(`CAPTURE_CLASSICAL_FALL_THROUGH`, `src/lib/flatten.ts`). Both policies are
scored on every capture where it matters (the capture's probe carries
`alternative`: what the no-fall-through policy would have opened with) and on
the detector suite's `refined` rows: on 300 F7 field-case scenes the
fall-through answered 26, 16 of them right and 10 wrong (without it: 26 more
"no corners"); on F1–F7 × 20 it answered 2 (one wrong, one on an empty desk).
Counting a capture with no corners as the failure it is for the user, the
fall-through fails fewer captures, so it stays.

## Metrics and verdicts (`metrics.mjs`)

Quads are four `[x, y]` points normalized to the frame; corner errors come
from the best cyclic correspondence (rotations and both windings); distances
are fractions of the frame diagonal. Thresholds are named constants:

| verdict | rule |
|---|---|
| wrong crop | IoU < `WRONG_CROP_MIN_IOU` (0.90), any corner the frame shows > `WRONG_CROP_MAX_CORNER_ERROR` (3 % of the diagonal), or a **corner order** the warp would mirror or turn (`cornerOrder`: the corners must run clockwise from the one nearest the image's top-left, as the library names them) |
| clipped | more than `CLIPPED_MAX_FRACTION` (1 %) of the page outside the quad |
| content clipped | the quad cuts more than `CONTENT_CLIP_MIN_FRACTION` (1 %) off any content box — a line of text, an identifier (a persona's name, a date, a protocol / order / membership number, a barcode) or a mark (signature, handwriting, tick). The emulator records where it printed each (`documentContent`: every piece replayed alone at 40 px/mm and boxed by the pixels it covers — its ink, to 0.025 mm, not the font's metrics, which Chromium rounds to a whole millimetre here, nor a curve's control points; `content-ink.test.mjs` holds the boxes to the rendered page's ink within 0.1 mm) and projects the boxes with the page (`gt.content`); a hand label has no content truth, so real runs report **n/a**, never 0 |
| margin clipped | clipped, but no content box cut: only the margin went |
| severe | wrong crop or content clipped (`severe = wrongCrop \|\| contentClipped`) |
| loose | non-page area inside the quad > `LOOSE_MAX_FRACTION` (3 %) of the page |
| miss | no quad survived the variant's own gates |
| false positive | any accepted quad on a scene with no page |

**A page the frame cuts off is judged on what the frame shows**: the crop is
taken of the image, so both quads are clipped to the frame before the area
terms, and a true corner outside the frame is reported (`maxCornerErrorAll`)
but not judged — following the page to the frame's edge and extrapolating the
hidden corner exactly are both right. With no true corner in frame only the
IoU decides. The overlay is judged by the same rule (`visibleDistance`): its
corners against the true corners the frame shows, whether the page is whole
or cut off. A content box is judged on its part inside the frame.

The session metrics (time to lock, static jitter, stale overlay after a page
swap, false locks per minute, tap → confirm latency, corners at confirm) read
the overlay as **time**, not samples: each probe sample holds until the next,
and a gap longer than `MAX_SAMPLE_GAP_MS` (250 ms) is *unobserved* — nothing
is concluded about it. A lock must be observed throughout its 300 ms hold
(every sample on the page, one at or past the hold included, none a gap
apart). The stale overlay after a swap runs until the overlay's *final*
departure from the old page (one noisy sample is not "it left") and says what
it was: `left`, `never-on`, `stuck`, or `unobserved` when any of the window
from the swap to the end of the hold after it went unobserved — each outcome
is a claim about the whole window (never on the old page, gone from it for
good), so one sample after the swap and silence is not "never on". Overlay shares
(on the page / near / wrong / none / on nothing) are time-weighted, and on an
empty desk the **exposure** — how long a quad was shown at all, however
briefly — is reported beside the false locks, which need an observed 300 ms.

`--compare prev/results.json` prints the headline deltas and exits 1 when a
headline got worse than `REGRESSION_TOLERANCE` (`report.mjs`) — for the
detector `wrongRate`, `missRate`, `falsePositiveRate`, `cornerErrorP50`,
`severeRate`, `contentClippedRate`; for sessions `captureWrongRate` (the
proposal), `captureWrongRateFinal` (what the user left with),
`severeCaptureRate`, `pagelessCaptureRate`, `cornersAtConfirmMax`,
`falseLocksPerMinute`, `falseLockExposure` and `staleStuck` — or when a
headline that had a number lost it (a capture that stopped happening is a
regression, not a "–"). Each family, each **setting** of a family (`F6/laptop`,
`F1/granite` — so one negative scene cannot hide in its family's average) and
each session is gated on its own. On top of the deltas, **absolute limits**
(`ABSOLUTE_LIMITS`) hold whatever the baseline said: no tap without a capture,
no confirm screen that never opened, no seed off the image, and no missing
data — a capture whose image could not be named, a window mostly unobserved, a
synthetic crop without its content truth; a key that is there with no number
breaks its limit too. A session's capture rate is over the taps the script
made: a tap that produced no capture, or a capture whose confirm screen never
opened, counts as a failed capture. Latency is reported, never gated.

The baseline file is read **before** the run starts (so
`.bench-out/latest-<suite>/results.json` is the previous run, not this one),
and a baseline over a different sample is refused before any time is spent:
seeds, frame size, CPU throttle (and the stream size for sessions, the media
directory for real runs) must match. Families, sessions and variants may
differ — only what both runs measured is compared, and the pooled `ALL` rows
are then skipped. Synthetic and real runs are never compared with each other,
and neither are two results schemas: `results.json` carries `schema` (now 2 —
corner order, content, time-weighted overlay, observed locks, id-named
captures), and a baseline of another schema is refused, never mapped: re-run
the baseline with the same bench.
A session runs in real time, so two runs of one script are close but not
identical (~1 % of the diagonal on corners at confirm): compare sessions over
several seeds.

## Output

```
.bench-out/detector-<stamp>/report.md       tables per family × variant, per setting, worst crops
.bench-out/detector-<stamp>/results.json    config, environment, scene params + GT, every row, summary
.bench-out/detector-<stamp>/sheets/*.jpg    GT green; right crop magenta, wrong red, gated-out dashed amber
.bench-out/latest-detector                  symlink to the newest run

~/.cache/scan-bench/frames/<clip>/{replay,sparse}/   real clips' frames (ffmpeg, once)
~/.cache/scan-bench/runs/real-{stills,video}-<stamp>/ real reports, results, sheets — never in the repo
.bench-out/straighten-<stamp>/{report.md,results.json,sheets/*.png}   Endireitar, synthetic
~/.cache/scan-bench/runs/straighten-real-<stamp>/       Endireitar on real stills — never in the repo
~/.cache/scan-bench/labels/scan-bench-labels.json    labels, when next to the media is not allowed
```

Every scene's params are in `results.json`, so any row can be re-rendered
exactly.

## The scene emulator (`emulator/`)

Every scene is a pure function of `(family, seed)`: a JSON params object
sampled from named, forked PRNG streams (`prng.js`), from which the ground truth
(`scene.js` → `groundTruth`, pure maths) and the pixels (WebGL, in the page)
both follow.

- **Camera** (`camera.js`): a pinhole over the desk — distance, tilt, azimuth,
  roll, aim point, 26 mm-equivalent focal length (or an explicit focal length
  in pixels, for a still taken through the preview's lens). World in
  millimetres (X right, Y down the desk, Z into it); image in continuous pixels
  (pixel centres at `i + 0.5`). GT corners are the exact projections of the
  paper's corners — lifted, when the page curls.
- **Renderer** (`renderer.js`): one ray per pixel onto the desk plane at each
  layer's own height, so every layer has exact perspective and parallax, and the
  page's outline lands exactly on its GT (`npm run bench -- --suite emulator`
  measures it, curled pages included: area error < 0.01 %, edge crossings
  within 0.25 px). Edges get analytic coverage; paper gets a soft cut edge,
  thickness shading, a slight wave tapered to zero at the corners, and a
  contact shadow. A curled page is a height field the ray is walked onto
  (Newton steps), shaded by its tilt against the light. Then lens blur,
  vignetting, shot + read noise, and a JPEG round-trip. It also renders
  *orthographically* into a texture (a **plate**) for the session player.
- **Materials** (`materials.js`): procedural GLSL in desk millimetres —
  granite, flat-sawn wood (cathedral figure, uneven rings, pores), a white or
  grey laminate table, woven fabric, pebbled leather with a stitched border, a
  plastic folder, paper (with an optional flattened fold), and the clutter:
  laptop (lid or deck), keyboard, notebook, phone, remote, place mat. Each
  scene compiles only the materials it uses.
- **Documents** (`documents.js`): Canvas 2D ink on white, each on its own stock
  — the A4 lab report, a form (boxes, ticks, handwriting), a letter, an 80 mm
  till receipt (thermal paper, often rolled), an ID-1 health-plan card
  (plastic, rounded corners, full-bleed colour, a silhouette where a photo
  would be) and a handwritten note (pseudo-cursive strokes and a signature);
  for F7, a lab report ruled to within millimetres of its edges
  (`edge-ruled`) and a letterhead printed to the edge (`bleed-band`).
  Only the repository's personas are named; numbers stay short and clinical.
- **Effects** (`effects.js`): a finger or thumb over a corner or an edge —
  a shaded skin capsule with a nail, knuckle creases, a soft shadow, out of
  focus — whose capsule feeds the GT's per-corner `visible` flags; a `patch`
  (a torn-off corner or a ragged receipt end: the desk cloned in from just
  beyond it, its polygon hiding the corners it takes) and a `flap` (a
  dog-ear folded over onto the page).
- **Families** (`family-*.js`, built from `kit.js`; the `setting` column in the
  report is the sub-case):

| family | what it is | settings |
|---|---|---|
| F1 desk lock | the D-343 regime: an A4 lab report at 25–60 % of the frame | `granite`, `wood-mat` (leather desk mat + folder) |
| F2 low contrast, shadow, glare | findable, but only just | `white-table`, `grey-table`, `shadow` (the hand's), `glare`, `dim` (gain noise) |
| F3 size mix | not every document is A4 at arm's length | `a4` 15–80 %, `receipt`, `card`, `note`, `tiny` 3–10 % |
| F4 tilt, motion, defocus, curl | the page is there, the picture is not clean | `tilt` 25–45°, `motion` 6–20 px, `defocus` 2–5 px, `curl` |
| F5 occlusion, partial, two docs | not all there, or not alone | `finger`, `partial` (1–2 corners out), `two-docs`, `object-on-page` |
| F6 hard negatives | no document at all | `empty-desk`, `laptop`, `notebook`, `placemat`, `keyboard`, `clutter` |
| F7 refine-adversarial | a straight edge where the page's is not, or the page's own edge taken away — built against the edge refinement | outside the page: `mat-edge`, `folder`, `table-edge`, `white-board`, `parallel-object`, `shadow-out`, `neighbour`, `stacked`, `striped-cloth`, `tiles`, `compound` (a white table's or a shadow's edge 3–12 % out while a thumb or glare weakens the page's own); on it: `shadow-in`, `margin-rule`, `bleed-band`, `crease`, `glare-edge`, `blind-shadow`; the edge itself: `white-on-white`, `finger-edge`, `curl`, `dog-ear`, `receipt-tear`; the field cases of the refinement's review: `dark-stock` (navy or black card printed in white, a kraft envelope with a white label, a dark ID card — on a white, grey or wooden table, with a dark object, the table's edge or both past it), `black-table` (a white page on a black table or leather mat whose edge is 3–12 % out, often a white sheet, receipt or card lying across that edge), `form-border` (a printed border 3–8 mm inside the edges, the form's code in the margin outside it), `stack-offset` (sheets under the page offset 1–5 mm along both axes), `screen` (a document on a tablet or a phone: bezel, the viewer's bars), `booklet` (the right-hand page of an open booklet: facing page, gutter shadow, page block, cover), `curled-receipt` (rolled along or across, or one end curling up), `jpeg-strong` (quality 0.2–0.45), `sharpen-halo` (an unsharp mask), `clipped-highlights` (a gain that clips paper and white tables to 255) |

F7 is a regression family: its setting is assigned **by seed**, cycling
through the 32 settings in that order (seed 1 `mat-edge`, seed 33 `mat-edge`
again), so `--family F7 --seeds 96` runs every setting three times. The ten
field cases were appended (seeds 23–32 of each cycle): seeds 1–22 kept their
settings, so a baseline of up to 22 F7 seeds still compares; a longer one
sampled other scenes and must be re-run. `--setting a,b` runs only the
scenes of those settings — `--seeds N` of each, the first N seeds that
sample it (found from the params in Node before anything renders); a
baseline must have been run with the same `--setting`. Its
params carry the attacked side (`target`, 0–3 = the page's top, right,
bottom, left) and, where there is one, how far off it the distractor lies
(`gapFrac`, fraction of the frame diagonal; negative = inside the page).

To grow it, register — nothing in the runner changes:

| add | where |
|---|---|
| a family | `registerFamily({ id, title, describe, sample(rng, { frame, seed }) })` in `emulator/family-<id>.js`, imported from `emulator/index.js` |
| a material | `registerMaterial(name, { glsl, pack })` in `materials.js` |
| a document | `registerDocument({ id, sizeMm, stock, draw })` in `documents.js` |
| a post-render effect | `registerEffect(name, { apply, hides })` — `hides` feeds the GT's per-corner `visible` flags |
| a session | `registerSession({ id, title, describe, build })` in `emulator/session.js` |
| a detector variant | an entry in `VARIANTS`, `app/detectors.js` |
| a suite | an entry in `suites/index.mjs` |

## Sessions: a document being scanned (`--suite session`)

A session is a **script** (`emulator/session.js`) over one scene — keyframed
camera poses with 1/f handheld tremor (0.5–3 Hz, RMS given as a fraction of the
frame height), pages that slide out and in, a thumb that comes in, a light that
dims, what the fake still pipeline does, and what the scripted user does — and
`sessionAt(script, t)` turns it into ordinary scene params, so every frame has
exact ground truth.

| session | what happens |
|---|---|
| `approach-hold` | opens far and off to one side, comes in over 2 s, holds; shutter at 6.5 s (F1/F2 scenes) |
| `tremor-hold` | framed from the start, 1.2 % tremor; a thumb holds the page at 2 s; light drops 40 % at 4.5 s |
| `page-swap` | a page is slid away and another document put down elsewhere; shutter on the new one |
| `empty-desk-sweep` | an F6 desk with no page, wandered over for 10 s; shutter anyway |
| `partial-frame` | 1–2 corners out of frame, shutter there; then backs off, holds, shoots again |
| `wider-still` | `approach-hold`, but `takePhoto()` returns the whole 4:3 sensor — wider than the 16:9 preview (D-343 RC1). The app now asks for the whole sensor itself and cuts the preview's field of view out of it (`stillCropFor`), so this and `approach-hold` take the same path |
| `wider-still-eis` | the still comes back at the preview's shape but 25 % wider (a stabilization crop): it passes the shape check |
| `sustained-hold` | **not in a plain run** (name it): framed and held 75 s — 10 s of frames played forward and back — with the shutter at 20, 40 and 60 s; then the page unmounts and remounts the flow three times (warm start-up), unmounts it for good and counts what outlived it |
| `sustained-90` | **not in a plain run**: 90 s on one page — a hold, a pan off and back, a tilt to 35° and back — the shutter at 20, 40, 60 and 80 s; then three remounts and a final unmount |

**The `regression` group** — **not in a plain run**; `--session regression`
runs all seven (`--session all` runs every session). Adversarial sessions the
live loop is re-checked on before it changes, each with its own windows,
events and locks:

| session | what happens |
|---|---|
| `fast-pan` | framed and held; at 1.6 s the camera whips off the page in 250 ms, stays off 1 s, whips back in 300 ms; at 5 s a fast half-pan puts half the page out for 0.7 s; shutter at 7.5 s |
| `swap-rush` | at 1.8 s the page is slid away and a second document slid in (600 ms); at 3.6 s that one goes and the first comes back elsewhere, turned; shutter at 6.2 s |
| `light-flicker` | exposure steps (0.45×, 1.6× clipping the paper, 0.5×), then 2 s of flicker between 0.6× and 1.35× every 120–220 ms with the light's gradient swinging; shutter at 6.8 s |
| `steep-tilt` | framed flat; at 1.5 s the phone tilts to 45–55° over 1 s and shoots at the slant at 4.5 s; tilts back from 6.5 s and shoots again at 10.5 s |
| `hand-pass` | a hand reaches over the page (fingertip well inside) at 1.5–3 s; another from a different side at 4.5–5.8 s; shutter at 7.2 s |
| `slide-across` | camera still; the page slides in from half out of frame (turning 12°) over 2.5 s, rests, is slid quickly (0.8 s) elsewhere, rests; shutter at 8.5 s |
| `paper-lookalikes` | no document: a closed white laptop, a white place mat, a white box and a cream book, each framed 1.8 s; shutter at 10 s over the last |

**The `guidance` group** — **not in a plain run**; `--session guidance` runs
all ten (Phase 4: the hint engine, the ready cue and auto-capture,
`src/lib/guidance.ts`). The scripted user switches the auto-capture toggle on
as the camera goes live wherever a script says `autoCapture`, confirms every
confirm screen that opens (its own taps' and auto-capture's) 1.1 s after it
opens, never taps while one is open, and at the end waits for any capture
still owed its confirmation. Besides the usual marks each carries
`marks.hints` (windows where a named hint is owed), `marks.ready` (where the
ready cue is owed), `marks.stable` (when the scene became still with a page
framed — an automatic capture's latency is counted from the last one before
it), `marks.tremor` (no automatic capture may fire inside) and, page-less,
`marks.pageless` (every automatic capture is a false fire):

| session | what happens |
|---|---|
| `too-far` | held still far from the page (7–10 % of the frame: under the model's own coverage floor) for 4.5 s — "Aproxime" owed; comes in over 1.5 s and holds; shutter at 9 s |
| `cut-off` | held still too close, one or two corners outside the frame, 4.5 s — "Afaste um pouco" owed; backs off, holds; shutter at 9 s |
| `low-light` | framed in a dim room (exposure ×0.06–0.1) for 6 s — "Pouca luz" owed, no automatic capture; the light comes back, holds; shutter at 9.5 s |
| `glare` | framed with a lamp's hot spot washing out part of the page until 5.5 s — "Reflexo — incline o celular" owed, no automatic capture; tilted out of it, holds; shutter at 9 s |
| `shaky-hold` | framed with a 1.5 % tremor for 4.5 s — "Segure firme" owed, no automatic capture; the hand steadies (0.3 %); shutter at 9 s |
| `tremor-hold-auto` | `tremor-hold` with auto-capture on: none may fire |
| `page-swap-auto` | `page-swap` with auto-capture on: one automatic capture per page |
| `empty-desk-auto`, `lookalikes-auto`, `desk-hold-auto` | `empty-desk-sweep`, `paper-lookalikes` and `desk-hold` (an F6 desk with no page held still 9 s — not in any group on its own) with auto-capture on: "Procurando documento" / "Não achei a folha" owed, and every automatic capture is a false fire |

**The `breaker` group** — **not in a plain run**; `--session breaker` runs
all thirteen (Phase 4's adversarial sessions, kept as a permanent group).
Every one has auto-capture on (the scripted page mounts `<ScanFlow>` with
`experimentalAutoCapture` whenever a script says `autoCapture`, and leaves
the prop out otherwise — as a host that says nothing does — and switches it
on through whichever control the layout has: `rail`'s MANUAL · AUTOMÁTICO
radios or the pressed-state toggle elsewhere); besides the
guidance marks, each may carry `marks.noFire` — windows where an automatic
capture would take a bad image (the page cut off, a hot spot on it, still
moving) — scored as "not owed" fires:

| session | what happens |
|---|---|
| `still-lookalikes-auto` | no document: a closed white laptop, a white woven place mat, a white box, a cream book, a white cutting board and a white plastic folder, each held still (0.25 % tremor) 3.6 s — every automatic capture is a false fire |
| `screen-page-auto` | a phone and then a tablet lying screen up, each showing a page, held still 4.5 s — scored page-less (a screen is not the paper); whether a person means to scan a document on a screen is an owner's call |
| `half-out-auto` | about half of the page outside the view (two corners gone), still 6.5 s — "Afaste um pouco" owed, no automatic capture; backs off and holds |
| `overlap-auto` | a second page laid over the first (offset 15–50 %), both in view, still 9 s; the top page is the scan — a capture of the bottom page or of both is wrong |
| `slow-drift-auto` | the camera panning steadily across the page for 6 s at 0.8–3.2 % of the diagonal a second — `noFire` while it moves |
| `hand-rest-auto` | a hand and thumb resting on the page |
| `dim-page-auto`, `dim-desk-auto` | a page (exposure ×0.12–0.26), and an F6 desk with none (×0.15–0.3, page-less), held still 9 s |
| `glare-sweep-auto` | a lamp's hot spot on the page from the start, sliding off it by 7.5 s — `noFire` while it is on the page |
| `hover-far`, `hover-edge`, `hover-light` | the page's size, its corner margin and the exposure swinging across the too-far, cut-off and low-light thresholds — the hint's churn |
| `whip-off-auto` | six times: held on the page 0.9–1.9 s (the countdown under way), then whipped off to bare desk in 200 ms and kept off 1.5 s — a capture off the page, or on the way, is a false fire |

The report's **Guidance** table gives, per session: each hint window's share
with the owed hint / another hint (wrong) / none, and the time from the
condition's start to the first right hint; the hint's churn (changes per
second of live viewfinder, and changes within 1.5 s of the one before); the
share of the default sessions' framed holds with a hint up; the ready cue's
precision (cue-on time with the overlay on the page, within 2 % of the
diagonal) and recall (over `marks.ready`) and its time over a frame with no
page; automatic captures, false fires, fires in a tremor window, pages that
got one, repeat fires, fires where none is owed (a `noFire` window, or a
hint window other than "searching") and their latency from stable; failed/severe of
automatic against manual captures in the same sessions; and whether the
viewfinder's box ever moved (the scripted page samples it every 100 ms and
on every hint change). One hint replaced by another is one change, not two
(`hintSeries`). A build from before the single hint slot is scored
too: its chips are mapped onto the nearest key (`hintSeries`,
`session-score.mjs`). The overlay samples carry `watch`: the last look at
the camera between passes while the cue was on (its motion score against
the confirmed frame, `hooks/useLiveDetect.ts`).

**The camera.** `app/fake-camera.js` answers `getUserMedia` with a stream the
player feeds, `permissions.query({ name: "camera" })` with `prompt` until the
app has asked (then `granted`), `ImageCapture` with a 4000×3000 sensor whose
`takePhoto()` answers with the pose at the moment of exposure, the pointer
queries with a coarse pointer — so the phone flow mounts — and its track
advertises a **torch** (`getCapabilities().torch`; `applyConstraints` switches
it and the run records when, as `record.torch`: the frames were rendered
ahead, so the light proves the control, not the photo). Each run gets a
fresh 390×844 @ DPR 3 touch context with an Android user agent. Asked for the
camera again after the app stopped it (a remounted flow), it answers a new
track on the same clock.

**Rendered ahead, played in real time.** SwiftShader draws a session frame in
~0.1 s, too slow to render thirty a second next to the app. So the page first
renders every frame (desk and props once, as a plate; each page baked once;
then per frame only the pages, the lighting and the sensor), keeps them as
JPEGs with their ground truth, and when the app opens the camera pushes frame
*k* at camera time *k*/30 s. Late frames are skipped, never slowed; the report
gives the achieved rate. The stream is 720×1280 by default (`--stream WxH`):
the live loop samples 640 px either way; only a capture that falls back to the
preview frame sees the difference. A looped script (`loop.frames`) renders
that many frames and plays them forward and back (`loopedFrame`), so a 75 s
hold costs 10 s of rendering.

**The frame cache.** Rendering is two thirds of a run, and a script's frames
depend only on the script, the stream size, the emulator's source and the
browser build — so the first run of a session writes its JPEGs and their
truth to `.bench-out/frame-cache/<key>/` (`PUT /frame-cache/…`, synthetic only)
and every later run with the same key reads them back (`--no-frame-cache`
renders anyway). The key hashes the script itself (as `buildSession` builds
it), `emulator/*.js` — of `session.js` only the part before the first
`registerSession`, the code that plays a script: a script's own change is
already in the script, so editing one session re-renders that session only —
the player's `FRAME_CACHE_VERSION` (bump it when rendering or encoding changes
there) and the browser version, so a stale frame is never replayed.

**A camera the page's main thread cannot slow down.** Where the browser has
`MediaStreamTrackGenerator` (Chromium), frames are pumped by a worker
(`app/camera-worker.js`) on its own clock and written as `VideoFrame`s stamped
with their camera time — a phone's camera does not slow down with the page,
and CDP's `--cpu N` throttles only the page's own thread. (Pumped from the
page, a `--cpu 4` run's camera fell to 6–18 fps and most captures could not be
named.) Stills a script's taps will ask for are **rendered before the clock
starts** — at the tap's scripted time plus the exposure delay, at the size the
app's own `pickPhotoSize` requests — and a `takePhoto()` within 400 ms of it
gets that one: rendering on demand blocked the page's main thread for as long
as the software GPU took (2.6 s under `--cpu 4`), which a phone's still
pipeline never does. A tap far from its time (a person in the playground) is
rendered on demand, as before. WebKit has neither: it plays frames from the
page (`canvas.captureStream()`) and has no still pipeline at all.

**The flow.** The scripted user taps "Permitir a câmera" on the primer, taps the
shutter at the script's times, and confirms the corners 1.1 s after the confirm
screen opens (it never moves one). The probe's events are scored against the
frame the `<video>` was presenting when they happened (`session-score.mjs`;
before its first presentation the frame is unknown, never frame 0):
time to lock, what the overlay showed during the hold (on the page / wrong /
nothing), static jitter (displayed vs the truth's own tremor), stale overlay
after a page swap, false locks per minute and exposure on an empty desk, every
detect pass — the ML warm-up's as its own row, wrong answers over answers
accepted on a page and false positives over passes on a page-less frame — and
every capture.

**A capture names its image by id.** The app numbers the preview frames it
draws to make a page (probe event `grab`) and the still attempts it hands the
camera (`still-call`, emitted synchronously right before `takePhoto()`); its
`capture` event carries both. The page's probe listener, called inside the
app's draw, names each grab by the **timestamp of the frame the `<video>`
holds** (`new VideoFrame(video)`, the frame `drawImage` just took). From the
worker camera that timestamp *is* the frame's camera time, so the name is
exact; from a page-pumped camera the canvas capture stamps every pushed frame
with its capture time, one fixed offset from its push (learnt from the
timestamps of the frames the `<video>` presented), to a millisecond or two
against 33 ms between frames — not the last presentation callback, which lags
the frame a draw takes about half the time — and a timestamp that matches no
push names nothing. The fake camera
stamps each still with the attempt it answered — so a capture is scored
against the image it actually took, and one whose ids name nothing is
**unscored** (missing data), never guessed by time. Each capture is judged
three ways, never blended: the **proposal** the confirm screen opened with
(`verdict`), the crop the editor **showed** (`shownVerdict`: the proposal, or
its inset default), and the **final** crop the user left with
(`finalVerdict`: the corners confirmed, or the whole image) — plus
`contentClipped` against the image's content boxes and `severe`. An image with
no page that went into the capture flow is a **page-less capture**: its own
failure class, counted and gated apart — the detector finding nothing on it is
not "ok". Also where its corners came from and tap → confirm latency. When the edge refinement produced
the seed, the capture is also scored with the refinement's **input** — the
corners the confirm screen would have opened with before refinement — so the
report's summary gives the capture wrong rate and corners-at-confirm
*unrefined → refined* on the same run (a paired comparison: two real-time runs
never see the same frames). Output: `report.md`, `results.json`
(every event and every frame's truth), and a film strip per session (truth
green; the overlay magenta when on the page, red when not; the last accepted
pass dashed amber; and each capture's image with its confirm corners).

**What it cost** (`app/perf-watch.js`, installed before the flow mounts).
Over the live part of each run — camera live to the end of the script — the
report's *What it cost* table gives main-thread **long tasks** (> 50 ms,
`PerformanceObserver`) per minute and their share of the time, attributed to
the scripts that ran in them (`long-animation-frame`, kept in `results.json`);
the **heap** (`performance.memory`, precise: the browser is launched with
`--enable-precise-memory-info`) at the start and end and its slope; the
detection loop's **cadence** as it ran (interval between regular passes,
captures excluded; pass time, and the main thread's own share of a pass where
the probe reports it); the **lane** each run's detection took and why; and
start-up on the camera clock (camera open → the model's first answer → first
lock). Chromium only; elsewhere the numbers say they are unknown, never 0.
A script with `remounts` (`sustained-hold`) then unmounts and remounts the flow
— warm start-up: mount → the model's first answer → lock — and finally
unmounts it, collects garbage (`--js-flags=--expose-gc`) and counts what
outlived it: **workers** constructed and not terminated, and **image bitmaps**
the app made (through the global `createImageBitmap`) that were neither
closed nor transferred to a worker — open, or collected by the GC while still
open (the one that holds a camera frame until a collection happens to run).

**The capture layout.** The session and real-video suites (and
`bench:webkit`) drive the library's default capture screen, `rail`, unless
`--layout` names another (`standard`, `classic`, `filmstrip`, `onehand`,
`collapse`); the run records it in `config.layout`. It is not part of the
sample, so `--compare` across layouts is allowed — that is how a layout
switch is checked for regressions. `rail` is full-bleed: on a viewport
taller than the stream the video is cropped at its sides, so the probe's
visible crop (and every overlay/guidance number measured against it) is not
the `standard` card's.

**Lanes and a slow phone's worker.** `--lane main|worker` forces the app's
detection lane through the probe (a bench-only setting the page hangs on its
listener, `probeSetting` in `src/lib/probe.ts`, compiled out of the library).
CDP's `--cpu N` throttles the page's own thread and never a worker's, so a
throttled run also tells the app's detection worker to stretch every pass —
and its warm-up — to N times what it cost (`workerSlowdown`): an upper bound
on a slow phone's core, honoured only by the bench's own build of the worker
(`build-app.mjs` builds `src/lib/detect.worker.ts` with the probe on and the
server serves it ahead of `assets/`). Without it the worker lane would look
better under `--cpu 4` than it is.

### The visible region (Phase 5a)

A full-bleed layout does not show the whole frame: its fit crops or
letterboxes the video, and its chrome covers part of it. `page-session.js`
measures the part the person can see on its own — the `<video>`'s content
box under its computed `object-fit` / `object-position`, clipped by every
clipping ancestor and the visual viewport, minus the opaque bands the layout
declares (`[data-scan-occluder]`) — at every viewfinder box sample, and the
report's **Visible region** table judges the page against it. Each sample
also carries `blocks`: every element drawn over the picture whose painted
background is at least half opaque (a glass button, the hint pill, a HUD),
found from the page's own computed styles — not from anything the app
declares — so a control the app forgot to declare still hides the corner
under it. The table: framed holds that reached the ready cue — counted only
from a cue **onset of that hold's own page** (after the previous hold
ended) with all four corners visible and uncovered at the onset, so a cue
lingering from the sheet before does not make the next hold "ready"; the
share of hold time the whole page was visible; "Afaste um pouco" shown while
it was **clearly** visible (every corner ≥ 3 % of the region inside it — the
app's own exit threshold; a tighter page counts neither way) or while it was
not; the ready cue judged at every displayed instant (every 50 ms while the
overlay keeps reporting; a silence over 300 ms is no viewfinder), a
violation being a corner outside the region, a corner under a control
(`blocked`), or no page at all (`pageless`), and the same at the cue's
onsets; automatic captures whose page
has a corner outside the photo, and how many of those the app flagged for
the confirm screen (`attention`); and the region's share of the viewport
(the camera the person perceives).

`--viewport WxH` sets the phone's CSS viewport (default 390×844; the owner's
phones are 412×891 and 440×956), `--stream` the camera's shape (`720x1280`
9:16, `960x1280` 3:4, `1280x720` 16:9), and `--fit cover|contain|maxcrop`
forces the layout's fit for an evaluation (`probeSetting("fit")`; absent,
the layout's own). `--session default` names a plain run's sessions (to
combine with a group: `--session default,guidance`).

    npm run bench -- --suite session --layout rail --viewport 412x891 --stream 960x1280 --seeds 5
    npm run bench -- --suite session --session approach-hold,wider-still --layout rail --viewport 440x956 --fit contain

**The scripted user frames the page by the screen** (`--frame-by screen`,
the default on every layout but `standard`). Before the sessions are built
the runner opens the flow once on a page-less desk (`view-probe`) at the run's
layout, viewport and stream, measures the visible region there (the same
measurement the scorer uses) and trims off the opaque controls drawn over
its top and bottom (the top row, the hint pill); every pose that frames a
page — the families' cameras, `withMargin`, `partialCamera`, the placements —
then fits the page in that part of the frame, centred in it, and a coverage
("25–60 % of the frame") is a share of it. So on a full-bleed layout whose
cover crop hides the frame's sides, a held page sits where a person holding
the phone would put it — on the screen — and a cut-off one is cut off on the
screen. `--frame-by sensor` frames in the whole frame, as every run before
did (and `standard` keeps doing by default, so its numbers stay comparable).
The view is logged and is part of the frame-cache key.

**The scripted user holds the page as people do, and follows "Aproxime"**
(`followHint`, `emulator/session.js`). In every framed hold the page is held
at the size people hold it at unprompted — 55–72 % of the visible region's
reach (`NATURAL_FILL`, from the owner's field run), seeded per hold. A hold
whose page the app would call too far gets an approach, as a person answers
the hint: 0.7–1.2 s after the hold starts they come in over 0.7–1.2 s,
re-centring the page on screen, to a little past the line the hint clears
at (×1.02–1.08), or as close as their tremor leaves the corners clear of
the edge — and hold there; the ready window and the `stable` mark start at
the arrival (`marks.follow` records each approach). `--follow` names the
rule followed: `fill` (default: the app's own, `FILL_ENTER` / `FILL_EXIT`,
mirrored as `FOLLOW_RULES` and held to the source by `session.test.mjs`),
`area` (the rule before it: `--follow area` against a build of that time
measures "before" with the same people), `fill:ENTER:EXIT` (a candidate) or
`off` (the script as written). `hover-far` swings across whichever line is
followed. The report's framing numbers (`scoreFraming`) give, per hold, the
page's fill when presented and at the ready cue, the time from presenting
to the cue, "Aproxime" shown and shown over a page plainly big enough, the
hint's changes, and for every capture the page's size in the Galaxy S25
Ultra's still (its 4080×3060 photo cut to the preview's field of view) and
the dpi that is for A4.

`--stream-scale N` delivers every frame scaled up N× (`--stream 720x1280
--stream-scale 3` is a 2160×3840 stream, what a 4K phone camera negotiates):
the scene and its truth are the same; only the pixels the app grabs and
resizes grow. Chromium's worker pump only.

A still-pipeline fault can be scripted through a prepare's `still`
(scratch drivers; not a CLI flag): `still.disrupt` (`{ freeze: true }`, or
`{ size, gain }`, for `ms` or the still's latency) makes the preview freeze,
change size or jump in exposure while a photo is taken, as Android does.
The scorer's `captureFreeze` reports, for every capture, how far the overlay
moved between the tap (or auto fire) and the confirm screen.

## Resolution (`npm run bench:quality`)

Does the PDF keep every pixel the camera gave the page? `quality.mjs` drives
the real `<ScanFlow>` (`app/page-quality.js`) on a fake phone camera — a drawn
page on a dark desk, a 2160×3840 stream that is the centre 9:16 crop of the
sensor, and an `ImageCapture` whose largest photo is the whole sensor —
through shutter → confirm → step 2 → "Gerar PDF", and reads the PDF back with
pdf-lib. Cases: `s25` (a 4000×3000 still), `50mp` (8160×6120), `safari` (no
`ImageCapture`), `timeout` (`takePhoto` never answers), `closest` (a driver
that answers 1704×3648 whatever is asked — the Galaxy S25 Ultra's field
still). It fails unless: the still is asked for at the sensor's full size and
becomes the page at its full resolution (or, without one, the stream's native
frame does, with the reason reported); the PDF's image is the final JPEG's
own pixels, embedded as-is (`/DCTDecode`, one PDF unit per pixel, rung 0);
and it is the drawn page at the full resolution of its source (±3 %). Then
girar + cantos + acabamento through the real store and render pipeline: every
render from the canonical, at the canonical's size — no generational shrink.
Then the size ladder: the `s25` page again under a host's `maxBytes` (by
default 97, 80 and 60 % of its own PDF; `--budget x0.5,300000`, or
`--no-ladder`): each must fit, a quality rung must embed every pixel of the
final, and a budget the as-reviewed PDF meets must not step down.
`--case s25,50mp`, `--no-edits`, `--headed`. Output: `.bench-out/quality-*/`.

## WebKit (`npm run bench:webkit`)

The flow end to end in Playwright's WebKit — primer, a live viewfinder that
finds the page and guides the aim, auto-capture switched on and firing, a
tap, the confirm screens — on one session (`--session too-far --seed 1` by
default: "Aproxime" owed while the page is far, then the ready cue and an
automatic capture once it is framed), twice: on the lane the app picks
by itself (and the reason it gives) and on the main-thread lane forced.
Chromium renders the session's frames into the frame cache first; WebKit plays
them from the page (no `MediaStreamTrackGenerator` there) with no still
pipeline (Safari has no `ImageCapture`), so every capture is a preview frame.
It checks the camera went live, the lane was reported, the model answered,
the overlay found the page, the owed hint was shown, the ready cue came on
over the page, the auto-capture toggle was found and an automatic capture
fired, every tap made a capture, every confirm screen opened, and the page
threw nothing; it writes
`.bench-out/webkit-smoke-<stamp>/results.json` and exits non-zero on any
failure. Linux WebKit is not iOS Safari: it proves the paths run, not how a
phone feels.

Two things the page camera does differently for WebKit: its canvas stream runs
at the session's frame rate (`captureStream(fps)` — WebKit's
`captureStream(0)` + `requestFrame()` delivered no frame), and the fake
`getUserMedia` is defined (`Object.defineProperty`) on `mediaDevices` and
the object kept referenced for the page's life (with a plain assignment the
app was seen to meet WebKit's real, denied camera). The first runs found an app bug: the capture screen
hid its `<video>` with `display: none` until the viewfinder went live, and
WebKit gives a stream attached to an undisplayed video no frame, then or
later — the screen said "no camera". It is now transparent instead. With
that, WebKit 26.6 passes on both lanes: the worker lane (reason `worker`)
50 model passes, the page under the overlay 70 % of the hold; the main lane
29 passes, 67 %; one capture each, confirm opened, no page errors.

## Real media (`--suite real-stills`, `--suite real-video`)

Local only: `SCAN_REAL_MEDIA` names a directory **outside** this repository
(`real.mjs` refuses one that overlaps it). Without it, `--suite all` runs the
synthetic suites and says so; asking for a real suite by name is an error.

**What is used** (`real.mjs`): stills are `*.jpg` in the directory itself, in
`pii_free/` and in `capture-issue/`; clips are `*.mp4` in `pii_free/` and
`capture-issue/`, **minus any screen recording** (it films the app's screen,
overlay and all — not a camera's view of a page). Each clip is decoded once by
the system `ffmpeg`, which applies the clip's rotation, into
`~/.cache/scan-bench/frames/<clip>/` — only when something plays clips
(`real-video`, `bench:label`, `bench:play`): `real-stills` needs no ffmpeg, and
a clip that cannot be decoded is skipped with its reason rather than stopping
the run:

| set | what | used by |
|---|---|---|
| `replay/` | 15 fps, 1080 px long edge | the per-frame detector pass; the replay through the app |
| `sparse/` | every 8th replay frame (≈ 0.53 s) at 1920 px — a 1080p preview frame | labelling; the detector-level evaluation |

Sparse frame *j* is replay frame 8*j*, so a label on it is the truth of that
replay frame too. A clip is re-extracted only when its source (size, mtime) or
these settings change.

**Stills are decoded the way the app decodes a photo**: `__bench.load` fetches
the bytes, `createImageBitmap(…, { imageOrientation: "from-image" })`, then the
library's own `bitmapToCanvas` (the still path's draw, at full resolution).

**real-stills** runs every variant on every still. GT-free: how often each
variant finds a page, the share of the photo its quad claims, and how often ML
and classical **disagree** (a matched corner > 5 % of the diagonal apart) —
and, when they do, whether classical claimed ≥ 5 points more of the photo
(**classical wider**: the desk-lock signature). Labelled images add the
synthetic suites' verdicts (good / wrong / miss / clipped / loose / FP; the
corner order counts; content clipping and severe are **n/a** — a label says
where the paper is, not where the print is). For
the refining variants, how far the refinement moved each corner of the
detector's own answer (% of the diagonal); a move > 3 % is **flagged**, listed
by file name with its per-side verdicts, and drawn on
`sheets/refine-audit.jpg` (before dashed amber, after blue) for a person to
look at — locally, in the cache — and answers left with a corner **off the
image** are counted. The real-video suite reports the same per replay frame;
the session suite counts confirm screens seeded off the image.

**real-video**, per clip:

1. every replay frame through every variant — detection rate, **motion**
   (largest matched corner move between consecutive frames; the page barely
   moves in 1/15 s), jumps > 5 %, ML vs classical disagreement;
2. the sparse frames — detection rate, and the labelled verdicts where labels
   exist;
3. **the clip replayed through the real `<ScanFlow>`** — the session page with
   the clip as its camera (`app/clip-player.js`), on the bench phone, in real
   time. The overlay is compared, on the frame that was on screen, with the
   per-frame ML answer from step 1 — a **proxy** that exposes lag and
   staleness (on / near / off / nothing shown, time to lock, the longest
   stretch shown off the page), not correctness — and with labels where
   frames have them. As in a session these are **time**: each overlay sample
   holds until the next, a gap past `MAX_SAMPLE_GAP_MS` and a frame with no
   reference are unobserved, and the longest off-page stretch is one that was
   observed from end to end. The shutter is tapped once, in the steadiest second of
   the clip by that reference; a still is the frame on screen (there is no
   larger sensor behind a recording), and the confirm corners are scored
   against the reference and the frame's label (a capture of a frame labelled
   "no document" is a `page-less capture`, never "ok"). The captured frame is named
   by id, as in a session; one that cannot be named is counted
   (`unidentifiedCaptures`, an absolute limit of `--compare`). Against labels
   — one frame in eight — a 300 ms hold cannot be observed, so the time to
   lock there is "unobservable", not "never".

`--skip-replay` leaves step 3 out. `--compare` works between two real runs of
the same suite (never against a synthetic one): the labelled headlines where
both runs have them, and the GT-free `undetectedRate`, `jitterP50` and the
replay's `offShare`.

## Labels (`npm run bench:label`)

```
{ "version": 1,
  "items": { "<id>": { "corners": [[x, y] × 4],   normalized, TL, TR, BR, BL
                       "uncertain": [bool × 4],   per corner, same order
                       "noDocument": true,        optional: nothing to crop here
                       "labeller": "…", "t": "<ISO time>",
                       "from": "blank" | "ml" } } }
```

Ids: a still is its path inside `SCAN_REAL_MEDIA` (`capture-issue/<name>.jpg`);
a video frame is its clip's path and its time at the replay rate
(`pii_free/<name>.mp4@533ms`). Corners are fractions of the image **as the app
sees it** (EXIF applied), may lie up to half an image outside it (a page the
frame cut off), and are stored TL, TR, BR, BL whatever order they were placed
in (`labels.mjs`). An *uncertain* corner never makes a crop wrong on its own
(it still counts in the IoU), and nor does a corner labelled outside the image.

A save is **merged** into the file item by item, the newer `t` winning, so a
tab left open since yesterday saves its own work without erasing labels
another tab saved since; the page then takes the merged file and says which
labels it did not overwrite. The version a save replaced is kept at
`~/.cache/scan-bench/labels/scan-bench-labels.previous.json`. A labels file
the server cannot parse is never written over.

The page (`label/page-label.js`, any desktop browser): the image list with
status (✓ labelled, ? a corner uncertain, ∅ no document, • unsaved), the image,
four corner handles and a loupe (×3–×16, wheel to zoom). **New images start
blank**, so the detector's answer cannot anchor the labeller; "start from ML"
fills the corners from the ML detector — per image (<kbd>M</kbd>), or as the
mode — and the label records which it was. Keys: <kbd>1</kbd>–<kbd>4</kbd>
select a corner, arrows nudge one image pixel (<kbd>Shift</kbd> ×10,
<kbd>Alt</kbd> ×¼), <kbd>U</kbd> uncertain, <kbd>N</kbd> no document,
<kbd>Del</kbd> remove a corner, <kbd>C</kbd> clear, <kbd>Enter</kbd> save and
go to the next unlabelled image, <kbd>[</kbd> <kbd>]</kbd> previous / next,
<kbd>Ctrl</kbd>+<kbd>S</kbd> save. Saving POSTs the whole document; the server
validates it and writes it atomically where `/labels/info` says.

## Playground (`npm run bench:play`)

The real `<ScanFlow>` on the bench camera with a control panel and a HUD
(`app/page-play.js`). The phone is an `<iframe>` of the session page, sized
390×844, so the library's full-screen layers stay inside it.

- **camera**: any registered session, its seed, the scene family it uses
  (F1–F5), the stream size — or, with `SCAN_REAL_MEDIA` set, a real clip, whose
  labelled frames are its truth;
- **fake still**: the preview's shape or the whole 4:3 sensor, and a field of
  view multiplier (1.25 = a stabilization-cropped preview);
- **run**: the suites' scripted user, or a manual one (you tap); the CPU
  throttle (works in the window `bench:play` opens — it is CDP, driven from
  Node; greyed out in a plain browser tab); the truth drawn over the
  viewfinder (dashed green, mapped through the video's object-fit).

The HUD shows the last pass (source, confidence, coverage, pass time), the
loop's cadence (announced and measured), the overlay's error against the
truth on the frame on screen, time to lock, the hints and event counts; the
captures table scores each capture's confirm corners against the truth of the
image that became the page; a scripted run ends with the suite's own session
score. `--no-browser` only serves it; `--smoke` plays one scripted session
headless and checks the HUD received events and a capture was scored
(`--clip <key>` for a real clip).

## The probe (`src/lib/probe.ts`)

The one seam in the library: at the points where the scanner already knows
them, it reports `detect` (every live-loop pass: its lane, the main thread's
share of it, the worker's compute and queue time, the live-refined quad, the
paper evidence and whether the sheet counts as found), `overlay` (the drawn
quad, ≤ every 100 ms, and whether it is a found sheet), `hint`, `still` (with its `attempt`), `still-call` (right
before `takePhoto()`), `grab` (a preview frame drawn to make a page),
`capture-detect` (`on: "frame"` at capture, `"canonical"` for a confirm/adjust
screen's fresh detect; with its lane, its wait in the worker's queue, whether
it fell through to the classical detector and why the model was skipped —
`busy` is a downgrade), `lane` (the session's detection lane and why),
`ml-ready` (the model came up or was latched off), `refine` (the edge refinement's input, output,
per-side verdicts, time, and whose corners it refined: `detected`, `live`,
`fallback` or `canonical`), `capture` (with the `stillAttempt` and `grab` that
name its image), `confirm-open` (the seed, and `shownCorners` — what the editor
drew, its own inset default when there was no seed) and `confirm-done`
(`edited` against what was shown; `null` when nobody listened at open).

**Compiled out of the published library.** The probe forwards only in a build
that defines `globalThis.__SCAN_PROBE_BUILD__` as `true` — this bench's bundle
(`build-app.mjs`, from `scripts/probe-switch.mjs`). The library build defines
it `false` and drops the `BENCH_PROBE`-labelled branches: `probing()` answers
`false` without reading anything, `probe()` is empty, and
`src/lib/probe-hook.ts` — the only module that knows the listener lives at
`globalThis.__SCAN_PROBE__` — is not in `dist/` at all, not even in a source
map. `npm run guard:dist` refuses a build where that name appears anywhere in
`dist/` or `assets/`, or where a script still reads the switch at run time;
`probe-build.test.mjs` bundles the module both ways and checks that a page
cannot switch the compiled-out probe back on. In the bench build the listener
receives a `structuredClone` of each event: nothing it keeps or mutates can
reach a quad the scanner is using. Nothing is buffered or sent; events are
numbers and normalized corners, never pixels.

## Endireitar: the straighten suites (`--suite straighten`, `--suite straighten-real`)

The detector suites ask "would the crop have been right?"; these ask the same
of the **Endireitar** tap: *is the page the user now sees straighter than the
flat page of the outline they confirmed, and did anything get worse?*

**What runs.** The real engine — the checkout's `src/lib/dewarp/*.ts` and the
dewarp wasm named by its own `wasm-manifest.json` — driven the way
`dewarp-stage.ts` drives it: a 896 px baseline, the padded crop, the output
size, the engine's A/B verdict and its guards (`straighten/engine-host.mjs`).
The baseline's corners go onto the 896 px copy per axis, by the engine's own
`quadOnScaledCopy` (pixel centre to pixel centre) when the engine exports it
and linearly, as older app code did, when it does not; the copy is handed to
the engine as `baselineSource`, which older engines ignore. The app's worker is replaced by an in-thread stand-in that makes exactly the
worker's calls. When the engine root has a text-deskew module
(`src/lib/deskew.ts`), the step runs first (`straighten/deskew-step.mjs`,
`--deskew auto|off|paper|crop`; `auto` = `paper` when the module exists). A
module that exports `planStraighten` (the app's own step) is driven the way
`dewarp-stage.ts` drives it: one 896 px copy, B₀ of the confirmed outline, the
rotation estimated and judged against B₀, and the engine run — on the
confirmed outline, with B₀ as its A/B baseline — only when the step asks for
it (no rotation, or a level page that still shows a curl). The page the user
sees is the engine's surface (never rotated) when it accepts, else the flat
page of the rotated outline with its wedges painted. A page the step levelled
with no curl is recorded as engine outcome `#050 curl-absent`, with no engine
time. `SCAN_STRAIGHTEN_CURL_GATE=always|never` forces the engine on or off on
every rotated page — a diagnostic for choosing the curl gate from two runs,
never the app's behaviour. An older module (`planDeskew`, the F5 prototype's)
is driven the way that prototype drove it: the rotated outline replaces the
confirmed one and the engine always runs.

**Why Node, not the bench page.** The engine has no DOM in its path, a page
takes seconds of single-threaded wasm, and a run is 279 of them: the suite
shards its scenes over `--jobs` Node processes (`straighten/worker.mjs`,
default 8), which one Chromium page cannot do, and it can load the engine from
**any** checkout (`--engine-root dir`, or `ENGINE_ROOT`) so a prototype
worktree is scored with this bench's metrics. A command that runs only
straighten suites builds no bench page and launches no browser.

**Scenes.** `straighten/scenes.mjs` renders a photo and its confirmed outline
from a physical chain with the truth known exactly: print tilted θ on the
sheet, a cylinder curl seen by a pinhole camera, the sheet turned φ in the
frame, sensor noise, uneven light and a camera blur. The full profile is 279
scenes — tilt × layout (paragraphs, block, two columns, form) × outline
(correct, full-frame, jittered), in-frame rotation, curl × tilt × outline,
rotation × curl — of which 255 should act (|θ| ≥ 0.5° or any curl). `--quick`
is an 83-scene screen of the same (every layout, family and outline mode).
`--only regex` narrows either by scene id. `straighten-real` puts the same θ
into every labelled real still (`straighten/real-scenes.mjs`): the print
rotated inside a right outline (`interior`, the common case), the whole photo
rotated with its outline (`rot-quad`, nothing to do) or without it
(`rot-origquad`), plus the still itself — 16 scenes a still, 7 in `--quick`.

**Verdicts** (`straighten/score.mjs`, unit-tested in `straighten-*.test.mjs`).
Every finished page is judged against **the original flat page of the
confirmed outline** — never against itself, and never against a rotated
outline. A should-act page lands in exactly one of five classes, all over the
same denominator:

| class | the page the user sees |
|---|---|
| `noop` | the flat page: nothing acted |
| `harm` | acted and got worse: \|tilt\| up by > 0.3°, bow up by > max(0.15 %, 25 %) (engine surfaces only — a rotation cannot bend lines), print lost, table brought into a straight page or around print shrunk into it, or the page's aspect off the flat page's by > 1 % (stretched) |
| `unverified` | acted, no harm found, but a check it needed could not be measured (a NaN tilt or bow, too little print) — **never** a success |
| `complete` | no harm, \|tilt\| ≤ 0.35°, bow ≤ 60 % of the flat page's |
| `partial` | acted, measured, no harm, not complete |

A page with nothing to do is `left-alone`, `harm`, `unverified` or `acted-ok`.
**Print lost** is judged on absolute ink (the ink over the whole page area,
< 92 % of the flat page's), on the ink in each border band and on the ink's
bounding box (print pushed into a border the flat page's print kept clear
of) — not on ink density over the visible sheet, which a kept wedge of table
fools one way and a sheet that grew the other. Print that lost ink but shrank
with its bounding box alike on both axes, touching no new border, was scaled
down, not cut: it is reported as shrunk, not as print lost (a page shrunk into
a frame of table is still harm, as background brought in). Table newly in the border of a *tilted* page is the price of turning its
print — by the deskew or by the engine levelling the lines it models, which
uncovers the same corners — unless the print shrank with it (`shrunk`): a
page scaled into a frame of table is harm whatever its tilt. A shrink too
mild to lose 8 % of the ink is not detected; that is this check's blind spot.
**Painted** pages carry fill
without the photo's grain; a **seam** is a fill that steps more than 6 grey
levels against the paper beside it; both are net of what the flat page
itself shows, and **dark wedges** count table newly in the border band. The
seam looks for paper up to two blocks (about 2 % of the long edge) from each
painted block, so on a sheet lit steeply toward its edge it also counts the
light's own gradient; each deskewed record therefore carries `fillStep`, the
fill against the real paper right across the fill's edge (p10/p50/p90, grey
levels, + = fill brighter).
Counts sit beside every rate in the report.

**What the card says.** The report also tallies the sentence the page view
would show after the tap (`straightenOutcome` in `scan-store.ts`, rebuilt from
each record by `cardOf` in `straighten/score.mjs`: tilt, curl, both,
tilt-only, nothing, or the decline's bucket) against each page's verdict.
`nothing` ("already level and flat") comes from the deskew's own measurement
of a page it found level (`deskew.level`), and only when that measurement
looked for a bow on enough lines (`level.flat`, `measuredFlat`); on a
should-act page it is a false claim, and every such page is listed by name.
`both` needs the engine's surface measured level (`deskew.engineLevel`,
`measuredLevel`): otherwise the card is `curl`. `tilt-retry` is a turned page
whose curve could not be checked (the engine failed rather than declined). `none` is a page the engine
changed although the deskew measured it level and flat: the app shows no
card there rather than claim a curl.

**Provenance and runtime.** `config.engine` records the engine root, its HEAD
and — when it has uncommitted changes — a sha256 over its diff and untracked
files, so "the same dirty worktree" is provably the same code or not. The
engine's hard timeout is the app's own, capped at 30 s: a slower page is the
timeout the app would show, counted as such. Timeouts and pages over the 12 s
device budget (engine + deskew) depend on load, so they only compare between
runs at the same `--jobs`.

**`--compare`.** Only runs over the same scenes (profile, `--only`, scene
hash, rendering), `--jobs` and timeout compare; the engine root and deskew
mode are what is being compared. The gated headlines (larger is worse) are
`unfixedRate` (1 − complete), `noopRate`, `harmCount`, `flatHarms`,
`unverifiedCount`, `curlUnfixedRate`, `residTiltP90`, `seamCount`, `timeouts`
and `overBudget`, per group (`ALL`, each family, `tilt/correct`; per variant
for real media). On top, **every scene** that was a complete fix and no longer
is (a lost fix), and every scene harmed now that was not (a new harm), fails
the run by name, whatever the totals say. A scene that crashed is an absolute
failure.

**Sheets.** `--sheets` writes a before/after PNG (flat page | page the user
sees) for each flagged scene — harms, unverified pages, seams, and with
`--compare` lost fixes and newly acted pages — into the run's `sheets/`
(for `straighten-real`, in the cache: real pixels never enter the repository).

**Curl on real stills is not graded.** Their truth has no curl (`"unknown"`):
a real page is `complete` on its tilt and on no harm alone, and a still's own
base and `rot-quad` variants are "nothing to do" only in the tilt the suite
added, not in whatever skew or curl the photo itself has. The real report
says so above its headline.

**Baseline** (engine 1e0548d, no deskew step, full profile, `--jobs 8`): of
255 should-act synthetic pages 49 complete (19.2 %), 7 partial, 198 no-op
(77.6 %), 1 harm, 0 unverified; 3 harms over all 279 pages (a bowed
full-frame form and two pages shrunk into a frame of table at 10° in-frame
rotation); tilt-only pages 36/204 complete (tilted print in a correct outline
9/64); curl 13/51; residual tilt p50/p90 3.0°/10.0°; 6 pages over the 12 s
budget, no timeouts. Real stills (3 labelled): 4/30 complete, 26 no-op, no
harm.

**The deskew step** (engine d24bdb2 plus `src/lib/deskew.ts`, full profile,
`--jobs 8`, against the same engine without it): complete 81 → 225 of 255
(tilt-only 56 → 200 of 204, tilted print in a correct outline 64/64), harms
3 → 1 (the bowed full-frame form, untouched by the step), curl 25/51
unchanged, residual tilt p90 10° → 0°, seams 0, 1 page over the 12 s budget
(6 before: the engine now runs on 78 of 279 pages). The one lost fix,
`tilt/form/jitter/t2`, is a jittered outline whose leftover perspective the
engine used to straighten; the step levels it to 0.41° and, finding no curl,
does not ask the engine. The step itself costs 297/464 ms (p50/p90) in
Node at `--jobs 8`. Real stills: 7 → 21 of 30 complete, no harm, no lost fix; 12–14
pages flag a seam while the fill's own step across its edge stays within
±3 grey levels at p90 on all but two.

The sideways refusal then compared raw projection energy, and a dense form
(still 145830) read as on its side at every tilt from 2° to 8°: 12 of the
real pages' abstains. Compared by peak sharpness instead, real stills go to
23 of 30 complete, 3 partial, 4 no-op, no harm, no lost fix; the synthetic
run is unchanged scene for scene (its 9 sideways abstains become
low-confidence ones).

The two real pages whose fill stepped far from the paper beside it
(145810 `interior` at 6° and 8°, `fillStep` p90 146 and 173 grey levels)
were one case: a wedge kept because the frame already showed the table
there, running past the photo, where everything was painted paper — a paper
patch inside a strip of table. Past the photo, such a wedge now keeps
scanic's clamp (the photo's edge, which is that table), and a wedge with
nothing inside the photo to judge follows the border it lies beyond. Every
deskewed real page's `fillStep` p90 is now within 2 grey levels; the
synthetic fill is unchanged pixel for pixel (no synthetic scene has such a
wedge). `seamCount` on the real stills stays at 18: on these photos the
flat page's own paper blocks within two blocks of each other already differ
by 18–22 grey levels at p90 (43–58 at p99), against the 6 the seam flag
allows, so there it counts the light more than the fill.

**After the review fixes** (engine 7b48f49, bench 1d41453, full profile,
`--jobs 8`, verdicts of both runs by this scorer): against the step-0
baseline, complete 49 → 225 of 255 (tilt-only 36 → 200 of 204, tilted print
in a correct outline 64/64 at every tilt from 0.5° to 15°), curl 13 → 25 of
51, no-op 198 → 20, harms 3 → 1 (the bowed full-frame form), unverified 0,
residual tilt p90 10° → 0°, 1 page over the 12 s budget (6 before), deskew
323/418 ms p50/p90 in Node. Scene for scene against 0c95359 nothing changed
class: the turned pages now keep the flat page's size (their aspect drifted
by up to a few percent before, unscored), three `both` cards whose engine
surface kept 0.5–1.6° of tilt now read `curl`, and one seam flag flips at
its own threshold (tilt/twocol/jitter/t5: 3 blocks at 6.0 grey levels
against 5.8 before; the fill's step across its edge is −1/0/+1 at
p10/p50/p90 in both). Real stills: 4 → 23 of 30 complete (interior 2 → 12
of 15), no harm, no lost fix, identical classes to 0c95359; the seam count
stays at 18 for the reason above.

## Status

Phase 3 (the live loop) added the sustained session, remounts and leak
counts, the frame cache, the worker camera and stills rendered ahead, the
cost report (long tasks, heap, cadence, lanes, start-up), `--lane`, the
worker slowdown, the `ml+live` variant, the evidence and live-refinement
APIs, the paired capture-policy scoring and the WebKit smoke.

Phase 4 (guidance) added the `guidance` session group, the hint / ready-cue
/ auto-capture scoring (`scoreGuidance`, the report's **Guidance** table),
the scripted user's auto-capture toggle and confirm watcher, the viewfinder
box samples, the bench camera's torch, the frame cache keyed by the script,
and the WebKit smoke's hint, ready-cue and auto-capture checks. Over 5 seeds
at `--cpu 1` (Phase 4 final): hint right 80 % of `too-far`, 79 % of
`cut-off`, 100 % of `low-light`, 60 % of `glare`, 88 % of `shaky-hold`, 75–95 %
of the page-less windows (a dark F6 desk says "Pouca luz" — the frame is as
dark as the low-light session's; this camera has no auto-exposure); ready cue
on the page 99.4 % of its on-time, never on a page-less frame; 31 automatic
captures, none on a page-less session, none in a tremor window, none failed
(manual taps in the same sessions: 12 of 50, most of them the page-less
sessions' own taps), latency from the scene steadying p50 0.93 s (1.0 s
p75); no viewfinder box change in 12,265 samples. Under `--cpu 4`: no false
fire and no fire in a tremor window either, latency p50 2.3 s (the ready cue
waits for five readings of a still page).

Implemented: probe, server, bench page, the `detector`, `session`,
`real-stills`, `real-video`, `emulator`, `straighten` and `straighten-real` suites, metrics, report,
`--compare`, families F1–F7, the session emulator and fake camera, real-media
extraction, the labelling page (`bench:label`) and the playground
(`bench:play`); Phase 2's edge refinement with its `refined` / `ml+refine`
variants, flips, the sessions' paired unrefined-vs-refined capture scoring and
the real suites' GT-free move report.
