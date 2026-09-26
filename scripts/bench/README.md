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
npm run bench -- --suite emulator --seeds 10               # the emulator's own GT check
npm run bench:play                                         # the playground, in a Chromium window
npm run bench:play -- --no-browser                         # …or serve it and open the URL yourself
node scripts/bench/server.mjs                              # serve the bench pages, print the URL

# Real media — local only, never inside this repository (see "Real media" below)
export SCAN_REAL_MEDIA=/path/to/real/photos-and-clips
npm run bench -- --suite real-stills                       # ~10 s
npm run bench -- --suite real-video                        # ~2 min, incl. replay through the app
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
| `wider-still` | `approach-hold`, but `takePhoto()` returns the whole 4:3 sensor — wider than the 16:9 preview (D-343 RC1) |
| `wider-still-eis` | the still comes back at the preview's shape but 25 % wider (a stabilization crop): it passes the shape check |

**The camera.** `app/fake-camera.js` answers `getUserMedia` with a
`canvas.captureStream()`, `permissions.query({ name: "camera" })` with `prompt`
until the app has asked (then `granted`), `ImageCapture` with a 4000×3000
sensor whose `takePhoto()` renders the pose at the moment of exposure, and the
pointer queries with a coarse pointer — so the phone flow mounts. Each run gets
a fresh 390×844 @ DPR 3 touch context with an Android user agent.

**Rendered ahead, played in real time.** SwiftShader draws a session frame in
~0.1 s, too slow to render thirty a second next to the app. So the page first
renders every frame (desk and props once, as a plate; each page baked once;
then per frame only the pages, the lighting and the sensor), keeps them as
JPEGs with their ground truth, and when the app opens the camera pushes frame
*k* at camera time *k*/30 s. Late frames are skipped, never slowed; the report
gives the achieved rate. The stream is 720×1280 by default (`--stream WxH`):
the live loop samples 640 px either way; only a capture that falls back to the
preview frame sees the difference.

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
holds** (`new VideoFrame(video)`, the frame `drawImage` just took): the canvas
capture stamps every pushed frame with its capture time, one fixed offset
from its push (learnt from the timestamps of the frames the `<video>`
presented), to a millisecond or two against 33 ms between frames — not the
last presentation callback, which lags the frame a draw takes about half the
time — and a timestamp that matches no push names nothing. The fake camera
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
library's own `bitmapToCanvas` (the still path's 3000 px cap).

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
them, it reports `detect` (every live-loop pass), `overlay` (the drawn quad,
≤ every 100 ms), `hint`, `still` (with its `attempt`), `still-call` (right
before `takePhoto()`), `grab` (a preview frame drawn to make a page),
`capture-detect` (`on: "frame"` at capture, `"canonical"` for a confirm/adjust
screen's fresh detect), `refine` (the edge refinement's input, output,
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

## Status

Implemented: probe, server, bench page, the `detector`, `session`,
`real-stills`, `real-video` and `emulator` suites, metrics, report,
`--compare`, families F1–F7, the session emulator and fake camera, real-media
extraction, the labelling page (`bench:label`) and the playground
(`bench:play`); Phase 2's edge refinement with its `refined` / `ml+refine`
variants, flips, the sessions' paired unrefined-vs-refined capture scoring and
the real suites' GT-free move report.
