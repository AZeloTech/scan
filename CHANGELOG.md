# Changelog

All notable changes to `@azelotech/scan`. The format follows Keep a Changelog.
This package is at 0.x, so the public API is documented but not yet frozen; it
freezes at 1.0.

## [Unreleased]

## [0.2.0] - 2026-10-04

### Added
- **`initialImages`** (`readonly File[]`, read once on mount): photos the host
  already holds become the document's first pages, through the same intake as
  a file pick — quality gate, corner detection, `maxPages`, per-file refusals —
  in the array's order. The phone surface opens on the review step with a
  "Processando N fotos…" line and progress bar; the desktop surface fills step
  1 and moves on to «Conferir» when every photo became a page (it stays on step
  1 when one was refused or left out, so the reason stays on screen).
- **`onPhotoImport({ imported, refused, overflow })`**: fires once when the
  `initialImages` have been read, with each photo's fate as indices into that
  array — e.g. to keep the photos that did not fit (`overflow`) for a second
  document. The same report is on `onComplete`'s result as the optional
  `initialImages` field (`ScanPhotoImportReport`, exported). Photos added
  inside the flow (a multi-pick, a desktop pick or drop) are not reported.
- **`images_unreadable`** error code: none of the `initialImages` could be
  opened. Recoverable on the phone while the camera is offered (the review
  step offers "Fotografar página 1"; no `onCancel`), terminal on the desktop
  (`onCancel("error")` follows). `onPhotoImport` fires first, with every index
  in `refused`.
- **Multi-select on the phone.** "Já tenho a foto" and the permission screen's
  gallery button accept several photos; two or more go straight to the review
  step through the same intake (one still goes through confirm-corners).
- **"Só as primeiras N entram"**: when photos outnumber the room left in the
  document, the review step says so before they are read (en: "Only the first
  N fit; the rest can go in a second document."). Once they are read the
  notice gives the real count — a refused photo frees its slot, so the
  forecast can be wrong — or goes away when nothing was left out.
- **A HEIC the browser cannot decode is named as such**, per file, with the way
  out ("tire a foto pela câmera"), on the phone and on the desktop list
  (`PageErrorCode` gains `heic`).
- **"Já tenho a foto" beside the camera fallback.** When the camera cannot be
  opened here (in-app browser, insecure page, refused permission) the phone's
  fallback surface opens the device's camera app, and the gallery pick now
  stays available next to it.
- **`preloadScanAssets({ assetBaseUrl })`**: warm the detection worker and the
  corner model before the flow mounts; returns a release the host calls when
  its sheet closes, in every case. Each release counts once: a double call
  never takes away a hold that a mounted flow still has.
- `capture` events (`source: "file"`) for every page read from a file.

### Fixed
- **The camera opens on phones that hang on a 4K request.** Some older
  Android phones neither resolve nor reject a high-resolution `getUserMedia`
  for many seconds, then reject it with `NotReadableError` ("Timeout starting
  video source"); the screen sat on «Abrindo a câmera…» and then reported a
  refusal the person never made. The camera is now asked for in up to three
  steps, each with a deadline of about 8 s armed once the permission is
  granted: the 4K back camera, the back camera at any size, any camera. A
  stream that arrives after its deadline is stopped. `video.play()` has a 5 s
  deadline too: a stream that has a frame by then is shown, one with none is
  stopped. The video is muted and inline before the stream is attached
  (autoplay on Chrome for Android).
- **Only a refusal is reported as `camera_denied`.** A camera that was allowed
  but would not open is the new `ScanErrorCode` **`camera_unavailable`**
  (recoverable): the fallback surface says «Não conseguimos abrir a câmera
  deste aparelho.» above the way out — the device's own camera app — with "Já
  tenho a foto" beside it. While a plainer request is under way the opening
  screen says «tentando de outro jeito».
- **A failed asset load is retried.** scanic's module and the pdf.js chunk were
  memoised even when the load failed, so one transient 404 or dropped
  connection broke them for the page's life; a failure is now forgotten and the
  next attempt fetches again. The corner model's failure latch still holds for
  the session, and is lifted once no scanner has been on the page for the idle
  grace (about a minute), so the next session tries the model again. (The
  dewarp engine, the deskew maths and the dewarp worker already retried.)
- **Desktop: «Limpar» ends the host's photos' say.** After the person cleared
  a list that started from `initialImages`, their next pick could be taken for
  the seed — moving the flow on, or ending the session with
  `images_unreadable` when that pick failed. The seed is now followed through
  its own run only.

### Changed
- The package no longer ships source maps (more than half of the tarball); the
  build still writes them locally, unlinked. The release workflow refuses a
  tarball that contains one.

## [0.1.0] - never published (everything below ships in 0.2.0)

### Changed
- **The capture's corner measurement retries on a slow phone, and the
  confirm screen says when it could not measure.** A capture's corner
  refinement that runs out of its 250 ms now yields and runs once more with
  1000 ms (never more than two runs; the live loop's budget is unchanged, and
  a live pass that runs out still holds auto-capture). If the corners are
  still unmeasured, the confirm screen's pill reads "Confira os cantos — não
  deu para medir" (en: "Check the corners — couldn't measure") and every
  handle is drawn hollow and dashed with "confira" under it — not
  "estimado": nothing was inferred. `onDiagnostics`: `capture` and `confirm`
  carry `refine` (`measured`, `retried`, `ms`; new `ScanDiagnosticsRefine`
  type), and `pass` samples `refineBudgetMisses` (live refinements out of
  budget since the previous sample). Synthetic bench, the covered-corner
  scene with the browser on two cores shared with six busy loops: before,
  two of three confirm screens opened on unmeasured, unmarked corners (the
  refinement out of time); now all three retried (the whole refinement
  0.62–0.71 s), two came back measured with the covered corner marked
  "estimado", one says "não deu para medir". Unconstrained (cpu 1) nothing
  retries; under `--cpu 4` two of three do (0.52–0.55 s). Auto-capture
  still never fires on that scene.
- **"Mova o celular para cima" instead of "Centralize a folha".** A page at
  the edge of the view that would fit if re-aimed is told which way to move
  the phone — up, down, left or right (en: "Move the phone up"), one way at a
  time, toward the side it is cut on — with a small arrow at that edge of the
  viewfinder (it nudges the way; not under reduced motion). The way is
  chosen when the hint appears and changes only under the hint's own
  minimum-show rules. `onDiagnostics`: hint id `move-phone` with a
  `direction`.
- **Auto-capture fires sooner on a page held still.** Its countdown starts
  when the page settles, and the ready cue's stillness and the final look at
  a fresh frame are gathered while it runs instead of one after another; a
  page held very still gets the 300 ms countdown. After an "Aproxime" the
  person followed, the end of that move no longer brings up "Segure firme";
  a camera-watch blip under a hand's tremor holds the fire without
  restarting the countdown, and a fire it vetoes is not counted as the
  page's one fire. The detection worker reads faster near a fire and while
  a framing hint is being followed. It never fires sooner than 1.2 s after
  the page was found, and only on a frame read after that; any motion seen
  (a camera-watch trip, the watch's score jumping over its own baseline on
  the page, a pass that lost the page, readings that moved) starts over the
  wait for a frame read after it, stillness gathered after it and 150 ms of
  the camera seen quiet before the shutter. The short countdown is lost when
  the readings stop agreeing. Every safety check stays (a fresh confirming
  frame, the camera watch at the fire, certain corners, once per page). A
  motion that starts after the newest frame the app has is not seen by any of
  this. Synthetic bench, a person who follows the hints: from a steady page to
  the fire, p50 1.1 s → 0.73 s (cpu 1) and 4.0 s → 1.5 s (cpu 4).
- **One automatic capture per presentation.** After a fire, auto-capture
  re-arms only for a sheet somewhere else or once the page has been gone for
  a second — no longer after two seconds of the phone moving over the same
  page, nor on the view's light changing (each took a page held through the
  confirm screen a second time). A page swapped in at the same spot without
  leaving the view is taken with the shutter.
- **"Mova o celular" for a corner under a control** points towards the
  control (moving the phone that way moves the picture off it), not by the
  page's centre.
- A detection pass whose answer arrives after the loop, the detection lane
  or the camera stream changed is dropped, with what was confirmed before
  the lane or stream change. `onDiagnostics`: the ready and
  auto events carry `phases`, where the time went (numbers only).

### Added
- **A covered corner is placed where its edges meet, and the app knows it
  is estimated.** A sheet lying over a corner of the page (a leaflet, the
  next page of a pile), a clip on a corner or an edge: the edge refinement
  fits each side on the visible run of its edge and puts the covered corner
  where two such lines meet rather than on the outline of what lies over
  it, and every corner says whether it was seen, inferred (placed from its
  edges) or unknown (covered, its edges too short to extend). The live
  overlay draws an inferred corner's bracket dashed and an unknown one not
  at all; **auto-capture does not fire while a corner is inferred or
  unknown, while another sheet is seen overlapping the page, or while no
  recent pass has measured the corners of the quad on screen** (the ready
  cue waits too; the shutter always works). A corner is called seen when
  nothing was found over it — on the bench about one real corner in five
  rests on no more than that, so a cover the edges do not show (a white
  sheet on a white desk) can still read as seen. "Canto coberto — afaste a folha de cima" comes up
  once a corner has stayed unknown for 0.7 s, "Separe as folhas" once two
  sheets have; the confirm screen marks each estimated handle — hollow,
  dashed, "estimado" under it, its name saying so — until it is actually
  moved (a touch that leaves it where it was keeps the mark), and its pill
  says one corner was estimated, beside the photo's own reason when there
  is one. A page on a clipboard is mostly cropped at its own edge under the
  clip, the board's margin left out — not yet on a light board on a light
  desk, which can still be taken for the page (on the bench, the board is in
  the crop in about a fifth of clipboard scenes). Two sheets overlapping
  (a page's corner seen lying on another sheet, the desk inside the answer
  between two sheets taken for one, or another sheet past two of its sides)
  hold auto-capture with "Separe as folhas" when the overlap is seen — on
  the bench in about half of such scenes, with about three in four held
  for some reason; a manual capture's confirm screen shows the sheet on
  top.
  `onDiagnostics`: `pass`, `capture` and `confirm` carry `corners` (one of
  `seen` / `inferred` / `unknown` per corner, `tl`/`tr`/`br`/`bl`) and
  `pass`/`capture` `separate`. On the bench's field-case scenes (F8, 20
  seeds a setting) the covered corner is within 3 % of the diagonal in
  100 % of `owner-case` captures (was 60 %) and in 97 % of covered scenes
  over every setting (was 70 %).
- **`onDiagnostics`: why a page is or is not paper.** `pass` samples carry
  `evidence` — the paper evidence's numbers behind `paper` (per-side edge
  support, sides judged, the interior's background / ink / counter-ink /
  ink spread / solid ink / background spread, the margin's evenness and
  brightness, the paper's level and the bright end; rounded) with
  `verdict` (`ok`, `sides`, `surface`) and the first clause each print
  rule failed (`failPrint`, `failPanels`) — and `paperAgeMs`, how long
  since the locked page last read as paper. Numbers and enums only; no
  version bump (optional fields).

### Fixed
- **An imaging report is found in dim, uneven light.** Under one lamp to
  the side, a hand's shadow over a margin or a leaflet over a corner, a
  page of dark image panels read as "not paper" pass after pass and was
  never found ("no page locked"), though the shutter worked. Its white
  margin is now judged against its own level along each side and against
  the page's brightest print next to it, and the region near a covered
  corner is left out; such a page must hold some print (a white lid with a
  logo does not). Synthetic bench (dim warm lamp, 8 seeds, cpu 1): the
  share of a presented page's time it is found — drawn on that page, over
  the whole time it is presented — went from 4 to 17 % for the field case
  (TL corner covered), 28 to 66 % for the same report without the leaflet,
  14 to 21 % for sheet-over reports; the passes reading as paper from 20 to
  66 %, 32 to 78 % and 31 to 59 %. The 80 % this was aimed at is not met:
  most of what is left is the page detector itself in the dim (no outline
  on a third of the passes, or one that jumps).
- **A found page is not dropped for a few readings of its surface.** Once
  a page has read as paper, a reading that is not paper does not count
  against it for up to 5 s while all four of its edges stay clear, every
  corner stays in view (none unknown, no side running off the frame) and
  it stays where it was. 5 s after its last paper reading a page is let go
  at once, however it was being held. Auto-capture does not lean on this:
  it counts down and fires only while the page's own newest reading says
  paper, taken within the last 1.5 s (for the fire, on a frame after the
  last movement) — a cover or lid slid in at the same outline stops it at
  once.
- **A very large photo is read as well as the viewfinder reads it.** The
  page detector squeezed a 4000 px still to its small input with a
  medium-quality resample and lost confidence on it, so a manual capture
  could fall back to a worse outline or to none. Stills over 1920 px are
  now reduced smoothly for the detector only; the PDF keeps the full still.
- **"Canto coberto" and "Separe as folhas" are asked before "Aproxime" and
  "Centralize"** when the page is whole in the view; a page cut off by the
  view's edge still hears how to frame it first.
- **A page of printed images is found.** An imaging report (near-black
  ultrasound panels over most of the page, white margins) read as "not
  paper" to the live loop — its background share and its solid ink are what
  a laptop or a notebook cover shows — so the viewfinder kept saying "Não
  achei a folha". A white margin round solid print, as bright as anything on
  the sheet, is now paper; and the edge refinement reads the page's paper
  from that margin, which had left every side of such a page unfound.
- **The PDF gets the camera's full resolution.** Every camera frame and
  picked photo used to be scaled to a 3000 px long edge before anything else
  ran, and on Android the still photo was asked for at that size — which
  Chrome answers with the *closest* size it supports, often of another shape
  (a Galaxy S25 Ultra returned 3648×1704 for 3000×1688), so the photo was
  discarded and the page was made of a downscaled preview frame. Now the still
  is asked for at the camera's largest size and cut to the preview's field of
  view without a resample; when there is no still (Safari, a timeout, a
  mismatch) the preview frame is used at the stream's native size and the
  reason is reported. Only a source larger than the browser can draw is fitted
  (iOS/iPadOS WebKit: 16,777,216 px of area; elsewhere 268,435,456 px, 32,767
  px a side), and that is reported too. The canonical is written at q95 and
  the final at q95 (was q92/q85); the PDF embeds the final's own bytes at its
  own pixels, and the size ladder (only with `maxBytes`) lowers quality before
  it ever lowers resolution. `onDiagnostics` reports the size at every stage:
  `capture` (still, request, stream, kept field of view, canonical bytes and
  quality, fallback reason), `confirm`, and the new `render` and `build`
  events.
- **The live preview stays at the camera's native size.** A cap that
  lowered Android's preview to 1920 px once a still had proven itself is
  built (the decision, the restore of the native stream when a still fails
  on a capped one, the `low-resolution` flag) but switched off
  (`STREAM_CAP_ENABLED`): on a Galaxy S25 Ultra the capped mode sees a field
  of view ~1.26× tighter than the native one (the still registered at
  `fovScale` 1.256 against 1.006), so the page framed on screen was ~20 %
  smaller in the photo, and from the cap on the live loop found no page for
  the rest of the session while the photo's own detection found it every
  time. The live loop itself survives a stream that changes size and field
  of view (`npm run bench:quality -- --case cap-fov` forces the cap on in
  the bench and checks found share, ready cue and fill against the native
  page). `stream-cap` now reports `disabled`.
- **Endireitar records, shows and claims only what it did to a page.** A
  straighten that could not finish (its code would not download, a readback
  ran out of memory) used to be remembered as "no rotation" for that photo, so
  the tilt was never fixed again until the corners changed, and the card
  offered "tocar de novo dá a mesma resposta". It is now forgotten, the card
  says a retry may help, and the next tap plans again. A turned page came out
  a few percent stretched on a perspective outline (the flattener sized it
  from the turned outline's own sides): it is now rendered at the confirmed
  outline's size, in one resample, and keeps its proportions. The PDF's
  `/Subject` now says a page was turned to level its print and by how much
  (`deskewed 3.5deg`), and whether paper was painted into the corners the
  turn uncovered (`corners filled`). "Sem melhorias" is no longer offered on a
  turned page, whose comparison would have shown a different geometry. The
  "both" card ("endireitamos o texto torto e tiramos a curva") needs the
  engine's page measured level: 3 synthetic pages that kept 0.5–1.6° of tilt
  now say only that the curve was taken out. "A folha, plana" needs a bow
  looked for on at least three lines. A turned page whose curve check failed
  (a timeout, a download) says so and how to try the curve again, in the warn
  tone, instead of "a curva ficou como estava". The deskew's own check now
  refuses a turn whose result it cannot measure, and one that pushes a rule or
  a printed border out of the frame, not only glyphs. The card no longer
  pulses again when you swipe back to a page. On the synthetic bench every
  verdict is unchanged (225 of 255 fixed, no harm) and on the real stills too
  (23 of 30); one synthetic seam flag flips at its threshold (6.0 grey
  levels, the fill's step across its edge still within ±1).
- **Endireitar says what it corrected, and answers a second tap.** After a
  tap the card now names what happened: the tilted text was straightened,
  the curve was taken out, both, or the text was straightened and the curve
  left as it was. Before, a page whose tilt was fixed while the engine left
  the curl alone said nothing about either. When the deskew measures the print
  level and the level page flat, and the engine then declines, the card says
  there was nothing to straighten. Any other decline is a limit of the
  correction, and its sentence now says so ("não deu para endireitar esta
  página com segurança", "está além do que o Endireitar consegue corrigir")
  instead of "Conferimos: esta página fica melhor como está". That old
  sentence was shown over pages the engine simply could not handle. When the
  engine changes a page the deskew measured level and flat, the card claims
  no curl. The support code stays beside every decline, including the curl's
  code under a fixed tilt. Tapping Endireitar again over an answer that
  cannot change for this photo used to do nothing at all. Now the card comes
  forward, is announced again, and says that adjusting the corners or
  retaking the photo is what would change it. The help text and the "about"
  sheet now mention tilted text. On both benches every page's pixels and
  verdict are unchanged. The synthetic bench shows "nothing to straighten" on
  8 pages and the real stills on 10, all of them pages with nothing to do.
- **Endireitar stops reading a sharper page as lost text.** Its before/after
  check compared the flat page (the photo shrunk to 896 px, warped, shrunk
  again) with a straightened page sampled once from the full photo. The
  straightened page's thinner strokes counted as lost ink, so curled pages
  that the correction had fixed were kept flat with "Conferimos: esta página
  fica melhor como está." The straightened page is now judged from the same
  small copy, at the same size, with the page's corners placed on that copy by
  pixel centre and per axis, as the browser's own downscale places them. On
  the synthetic bench, curled pages fixed go from 13 to 25 of 51 and all fixes
  from 49 to 73 of 255. On the labelled real stills they go from 4 to 7 of 30.
  There is one new harm, a 0.3° tilt increase on a page that was already
  nearly level. Three tilted pages that were fixed before are now kept flat.
  On a tilted flat page the check finds only 2 or 3 text lines, and a shift of
  a quarter of a pixel can decide which.
- **Endireitar stops reading a tilted page edge as smeared print.** Its check
  for rows or columns copied inward at the page edge (what a correction that
  runs off the photo leaves) called two strips copies when they were close on
  average. On a mostly blank edge strip a few dark pixels of background or
  glyph could all change and still pass, so small tilts were kept flat. Two
  strips are now copies only when at most a tenth of their marked pixels
  changed, measured against each pixel's own contrast so JPEG noise on a real
  smear does not hide it. A strip also needs 2 % of its pixels clearly off the
  paper, so a band of background pulled in along an edge now counts, and a
  pale mark crossing the edge does not. On the synthetic bench, fixes go from
  73 to 81 of 255 and partial fixes from 17 to 27. Two pages that had the
  table pulled in along an edge are now kept flat. One form tilted 4° is now
  accepted with its edges bent; the old check only turned it down by chance.
  The labelled real stills do not change.
- **The rail's camera fills the whole screen again.** A Phase 5a build
  letterboxed it (`contain`, sized to the screen above the controls); with a
  browser's bars, a gesture bar or larger text a 9:16 stream then shrank on
  both axes to about half the screen. The rail is back to `cover`, with the
  page judged against the visible part of the frame.
- **The ready cue comes on when the loop reads slower than its interval.**
  "Still" needed five readings inside a window sized by the loop's interval;
  a pass that takes longer than that (a 4K stream to grab and shrink, a busy
  worker) reads the page less often, so the window never held five and the
  cue never came on — the page stayed "locked" with auto-capture armed and
  nothing happening. The window now follows how often the page is actually
  read; the five readings, the stillness and the drift limits are unchanged.
- **The corner marks hold still while a photo is taken.** From the tap or
  the automatic fire to the confirm screen the live loop no longer tears
  down (the marks faded out and the framing marks came back) and runs no
  passes on the preview the still pipeline is disturbing; the overlay stays
  on the tapped quad.
- **The corner marks sit on the page's corners under a full-bleed camera.**
  The overlay was clamped to the stage's width by the scoped media reset
  while the cover-fitted frame is wider, so the marks were drawn squeezed
  towards the left, off the corners (worse on 4:3 streams).
- **"Too small to be a page" is judged on the screen.** The detector's
  coverage floor was a share of the whole camera frame; on the full-bleed
  rail a stream wider than the screen shows only part of it, and a page
  filling the screen could sit under the floor. It is now the same share of
  the visible region.
- The diagnostics HUD says what holds the ready cue or auto-capture back
  (`why: …`).
- **The confirm screen's first corner no longer wears a halo at rest.** The
  corner that the arrow keys move is marked only for a keyboard user
  (`:focus-visible`) and while a corner is held; a finger sees four identical
  pucks.
- **No tool in the page editor looks pressed for no reason.** A phone keeps
  `:hover` on whatever was last tapped (the thumbnail that opened the editor
  sits where "Girar" lands), so the editor's hover styles now apply only
  where there is a real hover.

### Changed
- **"Aproxime" asks for a page that fills the viewfinder.** The hint used to
  come up only for a page under 14 % of the view's area; the field showed
  pages held across about half of the photo's width (~125–150 dpi for A4 on
  a Galaxy S25 Ultra). Now it judges the page's reach along the viewfinder's
  limiting axis (`fillShare`: its bounding box's larger share of the visible
  width or height — an area target could never be met on a tall screen):
  "Aproxime" under 70 %, gone at 75 %, worded "Aproxime mais um pouco" for a
  page already at 60 % or more when it appears — and only while the page has
  room to come closer (every corner at least 7 % from the edge; 5 % to clear):
  a page held off the middle that reaches the edge at 65 % or more is taken
  as framed. A page at the edge that would fit if it were centred is asked to
  re-centre ("Centralize a folha", a new hint), never to back off; "Afaste um
  pouco" is for a page already as big as asked, too big to fit, or whose
  paper runs on past the edge. A framing hint whose ask is met clears at
  once (its exit line is its debounce), so people stop moving where they
  should. (A first cut at 78 % / 83 %, with "Afaste" for any corner near the
  edge, made the owner's field run take 42 s to the ready cue: on a
  full-bleed camera the clear part of the screen sits above the camera's
  optical centre, so a page drifts up as the phone comes closer and met the
  edge at 74–80 % — "Aproxime" and "Afaste" took turns. On simulated people
  held off-centre by up to 8 % and turned up to 10°, `npm run bench:framing`,
  the median time to the ready cue goes from 6.1 s, 15 % never, to 2.8 s,
  all reaching it, for ~6 % fewer pixels than 78/83 asked for.) The ready cue
  and auto-capture wait for it; the shutter never does. While a framing hint
  is up, the page moving is the person doing as asked: the slot clears
  instead of switching to "Segure firme" (the ready cue still waits for
  stillness). `onDiagnostics`' `hint` and `ready` events carry `fill`, and
  the HUD shows it.
- **Auto-capture's countdown rides out a wobble the ready cue rides out.** A
  one-reading stillness wobble under a cue that stayed on used to restart
  the countdown (logged as "auto: no sheet"); now it only holds the fire
  until the page is steady again. The HUD's reason names the wobble.
- **The live loop's pass samples say why a page is not found:** `pass`
  carries the model's confidence (`conf`), why its quad was turned away
  (`rejected`), the paper evidence's verdict (`paper`) and `fill`; the HUD
  shows them.
- **The final JPEG is q95** (was q92), the same as the canonical; the size
  ladder for a host's `maxBytes` gains a q92 rung before q85 (quality
  still goes before any pixel).
- **Deleting a page takes one tap and can be undone.** The page editor's bin
  no longer asks for confirmation: the page leaves at once and a toast,
  "Página excluída · Desfazer", offers it back for 5 s (not dismissed while
  it has focus or a mouse over it). Undo brings the page back exactly as it
  was — the page is held out of the document, not removed, until the toast
  goes, another page is deleted, or the editor closes (closing, retaking,
  adjusting the corners or unmounting all make the delete final, so a held
  page can never reach a PDF). Deleting the last page shows the empty
  document with the same toast; when it goes, the editor closes onto the
  empty document. `onDiagnostics` reports `page` `removed` on the tap and
  `undone` when it is undone.
- **"Sobre as melhorias" from any page.** A small (i) beside "Página N de M"
  opens it on every page; a flagged page keeps its "por quê?".
- **The editor's four tools are drawn plain.** A correction the page is
  wearing is a small dot on the tool's icon (described as "aplicado"), the
  recommended "Cantos" on a page that went in flat is a warn-toned dot, and
  a tool is dimmed only when it cannot be used, with the reason as its
  description. "Endireitar" keeps its icon and word when on.

### Added
- **Endireitar straightens tilted print.** A tap on Endireitar now first
  measures the tilt of the print on the flat page and turns the page level
  when the print sits crooked inside a right outline — a photocopy fed
  askew, an outline confirmed a few degrees off. The page's corners stay as
  the user confirmed them; the rotation is applied with them in the same
  single warp. It is refused, and the page left as it was, unless the text
  is plainly in lines at one angle: a page lying on its side, a level heading
  over a skewed body, handwriting across level rules, a graphic or too little
  text all keep their tilt. A page counts as on its side only when its print
  lines up more sharply a quarter turn away, not merely more strongly: a dense
  form's columns line glyphs up vertically too. The turned page is then checked against the flat
  page it came from — more level, lines no less straight, no print pushed
  out of the frame — or the turn is dropped. The corners the turn uncovers
  are filled with the paper right beside them, shading included. Where the
  turn reaches past the photo, the photo's edge is not smeared into the page,
  except along an edge where the frame already showed the table: there the
  table carries on past the photo instead of a patch of paper landing in it. The
  curved-page engine runs only when the level page still shows a curl, on
  the confirmed outline as before, and the turn is what the page keeps when
  the engine declines. On the synthetic bench, pages fixed go from 81 to 225
  of 255 (tilt-only pages 56 → 200 of 204) with no new harm; the engine runs
  on 78 of 279 pages instead of all of them. On the labelled real stills,
  fixes go from 7 to 23 of 30. The switch stays on over a page whose tilt
  was fixed, whatever the engine said about the curl, and a timeout on the
  curl no longer takes the turn away on the next edit. A corner edit
  discards a stored turn or curvature map, which used to be reused on the new
  corners.
- **`onDiagnostics` (experimental): a field-test event stream.** Versioned,
  typed events (`ScanDiagnosticsEvent`) for the session, camera, lane, live
  loop (sampled at most twice in any second), visible region, hints, ready cue,
  auto-capture's countdown / cancel / fire, captures, confirm-corners
  answers, pages removed or retaken, visibility and camera resume, stalls,
  torch and the auto-capture toggle. Numbers, enums and geometry only —
  no pixels, hashes, page text or file names, checked at run time. The
  library only calls the host's function; with no callback nothing is built.
- **The page is judged against what the person sees** (Phase 5a). The hints
  ("Afaste um pouco", "Aproxime"), the ready cue and auto-capture now use the
  visible part of the frame — the video under the layout's fit, clipped by
  the screen and a pinch zoom, minus the safe areas and the chrome a layout
  declares opaque — re-measured on every resize, rotation, zoom, text-size or
  chrome change. The default `rail` layout stays full-bleed (the camera under
  the whole screen, the controls over a dark fade): the part of the frame
  cropped off a tall screen or hidden under the controls simply counts as
  not visible. `standard` is unchanged. Detection still uses the
  whole frame; the photo keeps the camera's full frame.
- **Every photo is checked before the confirm screen.** The corners the
  viewfinder vouched for are mapped onto the photo (its shape, field of view
  and a quarter turn) and compared with the page found on it; a photo from
  the camera's still pipeline is also registered against a small grey
  thumbnail of the viewfinder taken at the tap, so the photo's field of view
  is measured from the pictures rather than trusted to its page detection
  (which can lock onto an inner printed border). A corner on the photo's
  edge, a page not where the viewfinder had it, no page, or an automatic
  photo that could not be checked opens the confirm screen with one short,
  advisory line asking for a closer look. Manual captures are flagged only
  on evidence (a corner on the edge itself, or the registration); nothing is
  blocked or accepted silently.
- Controls drawn over the picture (the top row's glass buttons, the hint
  pill) and the rail's controls as actually laid out (larger text included)
  count as hiding what is under them; a viewfinder scrolled or pinched off
  screen stops the ready cue and auto-capture until it is back.
- **`experimentalDiagnostics`** (default `false`): a small numbers-only HUD
  over the viewfinder for real-phone tests (lane, detection time, cadence,
  frame age, stream/photo size, visible region, fit, torch/vibrate support,
  ready and auto state). Stores nothing, sends nothing.
- **Capture layouts, and a new default capture screen** (`captureLayout`,
  default `"rail"`). Step 1 is now the full-bleed `rail` screen: the camera
  edge to edge, the hint under the top row, a MANUAL · AUTOMÁTICO (BETA)
  mode rail over the shutter, the newest page and the onward button either
  side of it, and "Já tenho a foto" (the gallery pick, same handler as
  before) as a small text button under the shutter. The screen that shipped
  before is kept as `"standard"`. Four experimental alternatives —
  `classic`, `filmstrip`, `onehand`, `collapse` — may change or go away and
  have no in-camera gallery pick. Every layout is the same capture stage:
  detection, hints, ready cue, torch, notices, page limit, confirm-corners
  screen after every photo, retake, camera-refused file surface. `collapse`
  folds its chrome into one capsule while the ready cue is on, with the
  shutter held in place and every transition cut under reduced motion.
  `useLiveDetect` can pin an element to the tracked page's corner and draw
  the countdown as a shutter ring for them. Unknown values fall back to
  `"rail"`.
- **The auto-capture toggle is visible by default** (on `rail`, `onehand`,
  `collapse`), since `rail` is the default: `experimentalAutoCapture` is now
  three-state — omitted lets the layout decide, `false` hides the toggle on
  every layout (the host's escape hatch), `true` also shows it on
  `"standard"`. `"classic"` and `"filmstrip"` never show it. It is still OFF
  at the start of every flow, never stored, the shutter stays live in both
  modes, and the confirm-corners screen follows every capture; what it does
  once switched on is unchanged.
- `<ScanFlow>`: camera capture, corner confirmation, review and PDF assembly,
  entirely on the device. It ends the moment the PDF exists and hands the host a
  `File` through `onComplete`. What happens next — upload, download, share,
  attach to a form — belongs to the host.
- `@azelotech/scan/self-test`: loads the corner-detection model, runs one
  inference and builds a PDF, so a host can prove its asset wiring works before
  anybody relies on it.
- `scan-copy-assets`, a command that copies this package's runtime files into a
  directory the host serves.
- **Corners start on the paper's edge.** The corners a capture (or a gallery
  pick, or a confirm screen's fresh detect) seeds the confirm screen with are
  refined on the full-resolution image before they are shown: each side is
  snapped onto the edge where the page's paper ends, and a side the model
  pulled onto the text block of a page on a light table is searched for
  further out. It reads the page's own stock (a navy card, a kraft envelope,
  not only white paper) and takes a form's printed border for print. It
  never moves a side inward across page content, or without enough of the
  background in view to show it is cutting background, or along the chord of
  a curled side; never searches past a page edge to a repeating background
  (stripes, tiles), across a dark desk or from a side with no paper right
  past it; never turns the quad inside out or onto a neighbour; never places
  a corner off the image; never searches far from a classical-detector quad;
  keeps no copy of the page once it returns; and gives up — keeping the
  detector's corners — on any doubt or after 250 ms, checking the clock every
  few milliseconds of work (`src/lib/refine.ts`).
- **The viewfinder's brackets are where the page is.** The live loop was
  rebuilt around what the person holding the phone sees:
  - **Detection runs in a worker** (`assets/workers/detect.worker.js`, scanic
    itself inside it) where the browser allows one; the main thread only
    grabs the frame. The choice is made once per page, with a reason, and the
    main-thread path that shipped before stays a first-class fallback (no
    `Worker` or `createImageBitmap`, no 2-D `OffscreenCanvas` or no
    WebAssembly in a worker, a worker script that will not load, does not
    answer, stalls, cannot take the camera's frames, loses its model, or
    dies — a model that fails in the worker moves detection to the main
    thread rather than switching the model off). The model's download and
    compile start in the worker while the permission primer is still on
    screen, and the worker is terminated a minute after the last scanner on
    the page unmounts. The viewfinder's focus/light hint is read from the same
    frames there instead of by a second timer on the main thread.
  - **It looks as often as the device can afford** — a share of its thread's
    time, not a fixed 700 ms — up to about eight times a second.
  - **The model's live answer is moved onto the paper's edges** on the frame
    it was found on (the same refinement a capture runs, on the ~640 px
    sample), and drawn through a One-Euro filter that is calm when the page is
    still and quick when it moves. The refined corners are also what a
    capture's buffered quad carries (the corners the user was looking at);
    acceptance — the coverage floor, arbitration — still reads the model's
    own answer.
  - **"Sheet found" needs paper.** A quad is drawn only when the pixels in and
    around it show a page's edges and print (`src/lib/paper-evidence.ts`): the
    model is as sure of a laptop lid as of a page. A sheet the viewfinder
    has just found comes back on one reading (a whip back, a remount), and
    a found sheet still standing on its edges keeps "found" when a steep
    tilt makes its print read as not paper. The classical detector's
    quads are never drawn once the model is ready, and before that only when
    they pass sanity checks (not the frame's border, not a sliver, paper
    inside).
  - The camera's `<video>` is kept rendered (transparent) until the
    viewfinder is live, instead of `display: none`: WebKit left a stream
    attached to an undisplayed video without a frame, and the capture screen
    reported no camera (found by the new WebKit session smoke).
  - `selfTest()` also reports `detectWorker`: whether the worker could start
    on this page (a 404 or a CSP header on its response are the usual
    reasons it could not).
- **The viewfinder guides the aim** (`src/lib/guidance.ts`), the way a
  phone's own document scanner does:
  - **One hint at a time**, in a slot of fixed height at the top of the frame
    (announced politely to screen readers; the frame never moves or resizes):
    "Procurando documento", then after a few seconds "Não achei a folha —
    toque para capturar"; "Afaste um pouco" when a corner is at or past the
    edge of what the viewfinder shows (also when the model drew the page
    short of the edge but its paper runs on past it); "Aproxime" when the page
    is small in the view (also a page too small for the detector's own floor);
    "Pouca luz" when nothing in the frame is bright; "Reflexo — incline o
    celular" when a reflection washes out part of the page; "Segure firme"
    while the found page keeps moving. A hint has to hold 300 ms to appear
    and stays at least a second. They replace the old chips ("folha
    encontrada", "aponte para o documento", "encaixe a página inteira", "não
    achei as bordas") and the stuck-detector tip box.
  - **A ready cue on the brackets**: heavier and inverted — a graphite mark
    (`ready`, #2F3338) on a light halo where the idle marks are white on a
    dark one (graphite 12.7:1 on white paper and 12.2:1 on its halo; the halo
    17.5:1 against a dark scene) — once the page is found, framed, sharp
    and still, on a detection pass of a recent frame that found it where the
    brackets are. It rides out a wobble shorter than 300 ms and drops at once
    when the page is lost or another hint is owed. It comes on only once the
    hint slot is empty, and the slot stays empty while it is on. Once per page it gives one haptic tick (where the browser
    has `navigator.vibrate`) and says "Pronto" to screen readers.
  - **A torch toggle**, only where the camera track advertises one; the
    low-light hint offers it ("Acender lanterna", a 44 px target that hands
    focus to the toggle). Changes are applied one at a time, re-applied to a
    new track, and the torch is off while the viewfinder is covered or the
    page limit is reached. A refusal costs only the light, and the toggle
    then shows it off.
  - **Experimental auto-capture**, behind a new `<ScanFlow>` prop,
    `experimentalAutoCapture` (on the `"standard"` screen: no toggle unless
    the host sets it; on the default `"rail"` screen see "capture layouts"
    above). When offered, a toggle ("auto", "auto ✓" when on, announced) is offered,
    off in every new flow; the flow keeps the choice while it is open and
    nothing is written to storage. Retakes are always manual. Switched on,
    once the ready conditions have held half a second — a countdown grows
    along the brackets as a white line inside the graphite marks — and a detection pass on a frame from within that
    half second found the page where it was, and a last look at the camera
    at that instant shows the same scene, the photo is taken through exactly
    the path a tap takes (still photo, refinement, the confirm-corners
    screen), once per page. It then waits for another page (a page somewhere
    else, the page gone for a second, the scene changed) or two seconds and
    the phone moving — counted from when the confirm screen closed — before
    it fires again. Moving the page enough to lose the ready conditions, or
    the camera leaving the page, cancels the countdown. The shutter and the
    frame tap work in every state. It is experimental because it has not met
    its bar: on the bench it still fires on a screen showing a page and on
    two overlapping sheets the detector takes as one (see the bench README).
- The visual style is graphite rather than green: every green token (`sage`,
  `pine`, `leaf`, `deep`, `mist`, `moss`, `dew`, `frost`, `mint`,
  `mint-line`, `ok.*`, the desktop greens, the loupe ring, the shell ramp and
  its default, now `grafite` #454649) is swapped for a cool grey of the same
  WCAG luminance, so every contrast pairing and floor holds exactly as
  before. Token names are unchanged.
- The live loop lets a page that was slid away go sooner: one reading that
  finds no paper where the page was is enough when the scene moved or the
  model sees a quad elsewhere, and the overlay fades out in 100 ms (instead
  of 300) once the page is known to have gone.
- "Sheet found" is harder for a black keyboard to earn: on a sheet whose
  interior is under three-quarters background, ink must make up at least
  0.22 of the rest. It is harder for a woven place mat too: under 0.04 ink
  spread over more than three-quarters of the sheet is a texture, not print.
- With no live detection on the device (it could not start, or the phone is
  too slow for it), the hint slot says "Não achei a folha — toque para
  capturar" rather than nothing.

### Deprecated
- `experimentalCaptureLayout` → `captureLayout` (same values; read only when
  `captureLayout` is absent).
- The layout value `"default"` → `"standard"`: the pre-`rail` screen is no
  longer the default, so the old name would lie. `"default"` still selects it.

### Changed before first publish — host integration
Found by embedding 0.1.0 in a host page. None of these is on npm yet, so they
land in 0.1.0 itself; each is a behaviour a host can observe.
- **`onCancel("user")` no longer ends the flow.** It used to latch: after the
  first request every control went inert, so a host that asked "discard these
  pages?" and heard "keep scanning" was left with a dead scanner. Now a user
  request is only a request — the flow keeps navigating, can still complete,
  and the next request fires `onCancel("user")` again. A repeat inside the same
  double tap (under 400 ms) is swallowed. `onComplete` and `onCancel("error")`
  remain final (`src/lib/exit-gate.ts`).
- **No history manipulation.** The page preview pushed a history entry, re-pushed
  it on `popstate` and called `history.back()` on close. It now closes through
  its own controls and Escape only; a hygiene test bans the history API in
  `src/`.
- **`defaultFileName` is used verbatim.** It was documented but ignored: the
  file was always named from the marking and the scan's start. When a host
  passes it, the finished `File` carries exactly that name and the flow shows no
  marking chips and no free-text name field (phone "outro" sheet, desktop
  name input). The documented `documento-<yyyymmdd-hhmm>.pdf` default never
  existed and is gone from the docs: without `defaultFileName` the name is
  `<yyyymmdd>-<hhmm>_<marking>.pdf`, as before.
- **`/Title` never carries typed text.** It is the file name without `.pdf`
  (the host's name, or the composed slug) instead of the document name as typed.
- **`lang` now works.** The prop was accepted but no language provider read it,
  so every host got pt-BR. The flow also no longer reads `navigator.languages`,
  no longer writes `scan.lang` to `localStorage`, and no longer sets
  `<html lang>` on the host's page; it sets `lang` on its own root instead.
- **Copy no longer speaks for the host.** Removed or neutralised in pt-BR and
  en-US: "nada é enviado" / "nothing is sent", "sem conta · gratuito",
  "Suas páginas nunca foram enviadas para a internet", "O arquivo vai para a sua
  pasta de downloads", the images-never-sent line on the camera primer, "grande
  demais para enviar", and every unused download/share/WhatsApp/e-mail string
  left from the standalone site. The desktop picker's lead and format line
  mention PDFs only when `intake.pdf` is on.
- **The stylesheet is fully scoped.** Tailwind's `*, ::before, ::after` and
  `::backdrop` variable defaults are rewritten under `.scan-root`
  (`scripts/postcss-scope-root.mjs`) and the `container` core plugin is off. The
  dist guard now parses `dist/styles.css` and refuses any selector not scoped to
  `.scan-root`.
- **`.app-h` was undefined.** `AppFrame` and `DesktopFlow` render the class, but
  no rule answered it — it never made the port from the source app's global
  CSS — so the viewfinder stage measured 0px tall in a plain host page and the
  live overlay never mounted. `.scan-root .app-h` now sets `100svh` (`100vh`
  fallback, `var(--app-h)` last) to match the source app's shell height. This
  assumes the documented full-screen embed (`position: fixed; inset: 0`, as in
  the consumer smoke test); a host that embeds `<ScanFlow>` inside a smaller,
  non-fullscreen container will get a shell sized to the browser viewport
  rather than that container (`src/styles.css`). The dist guard now fails the
  build if the compiled stylesheet lacks a height rule for `.app-h`.
- **`.safe-bottom` was undefined too.** The bottom action bars (`AppFrame`'s
  footer, the confirm-corners buttons, the retake sheet) render it, and no rule
  answered it, so they sat flush on the bottom edge — 0 px under "Usar a foto
  inteira", 4 px under step 2's primary — which on a phone with a home
  indicator or gesture bar (a host page with `viewport-fit=cover`) put the
  last button under it and read as cut off. `.scan-root .safe-bottom` now pads
  `max(env(safe-area-inset-bottom), 14px)`, the capture screen's own floor, and
  the dist guard fails the build if the rule goes missing again.
- **Step 2's primary button is "Gerar PDF"** ("Generate PDF"), and it starts
  the file. It used to read "Ir para o passo 3" and open a form (marking grid,
  name, prévia, a second button) that most people left as it was; its defaults
  are now applied when the build starts — the document is named "exame"
  unless a name was already chosen, and not at all when the host passed
  `defaultFileName` (`src/lib/generate.ts`). Step 3 is where the build is
  watched: progress, and "Cancelar", which returns to step 2. When the build
  fails or is over `maxBytes`, step 3 shows the reason with the form and a
  second "Gerar PDF", as before. The trail keeps its three steps. The desktop
  flow's step 2 does the same; its step 3 form is read-only while a build runs
  or its receipt is up. The step-2 PDF preview's confirm now says "Confirmar e
  gerar" and does exactly that. English "Create PDF" is now "Generate PDF".
- **No spurious "second scan store" warning.** A render React discards before
  committing — a sibling suspending in the host's `<Suspense>`, a lazy chunk
  resolving into a retry, an interrupted transition — created a store that was
  never disposed, so the committed render tripped the one-instance guard (a
  warning in production, a throw in development). The provider now adopts the
  store its discarded render created. The smoke app mounts the flow beside a
  component that suspends once and fails on any console output from the
  library.
- **Documented, unchanged:** the vendored scanic runtime still defaults to a
  jsDelivr CDN when called without a base. It is not modified; this library
  always passes `assetBaseUrl`, `modelUrl` and `wasmPaths`, and `npm run smoke`
  fails on any off-origin request while loading the model.

### Decisions worth knowing
- **Assets are located by a host-provided base URL, never by the bundler.**
  scanic, the ONNX Runtime, the dewarp WebAssembly, pdf.js and both Web Workers
  ship as files under `assets/` and are fetched at runtime. This is not a
  preference: the ONNX Runtime locates its own WebAssembly with
  `new URL(..., import.meta.url)`, which webpack resolves at build time and
  cannot satisfy from inside a consumer's hashed output, and Vite's library mode
  would inline the same files as base64 data URIs, which cannot be
  streaming-compiled as WebAssembly. Both failures appear only in a consumer's
  build, which is why `npm run smoke` builds two real applications and drives
  them in a browser.
- **No OCR.** There is no text layer and no recognition engine: the trained data
  alone would be about 15 MB, and the applications that use this library extract
  text on their own servers. A future `@azelotech/scan-ocr` would consume the
  finished PDF rather than the page images. A guard fails the build if the
  engine's name reappears in the output.
- **The page store is per-instance**, created and disposed with the component,
  and holds encoded bytes rather than decoded pages. Twenty decoded pages at
  full resolution would be around 700 MB and would end a phone tab.
- **The PDF's `/Subject` is transform-only and language-independent**, and
  carries no date. A translated line with a timestamp in it writes the owner's
  locale and the moment they photographed the page into a document that will be
  forwarded onwards.
- **EXIF cannot reach the finished PDF.** Metadata segments are stripped from
  every JPEG before it is embedded, without recompression, so GPS coordinates
  and device models cannot travel with a page somebody photographed.
- **A size ladder** steps quality down to fit a host's `maxBytes` and refuses
  rather than exceed it, saying how many pages would have to go. Being told the
  file is too large after ten minutes of scanning is bad; being told only that
  it failed is worse.
- **Tailwind is a build-time dependency** and never reaches a consumer: it
  compiles into one stylesheet whose every selector is scoped to the component's
  own root, with the global reset switched off, so importing it cannot restyle
  the host's page.
- **GSAP is a peer dependency**, shared with the host rather than bundled.
- **A capture still falls through to the classical detector** when the model
  answers that there is no page. Measured both ways on the bench's scenes, the
  fall-through turns more "no corners" into right crops than into wrong ones
  (300 F7 field-case scenes: of the 26 it answered, 16 right, 10 wrong), and
  a confirm screen opening with no corners leaves the user to place all four.

### Known limitations
- The Rust crate ships its in-module unit tests but no golden/parity suite: the
  fixtures such a suite needs are photographs of documents, and this repository
  admits no photograph of a real document. Restoring it means generating the
  fixtures synthetically first.
- Only one `<ScanFlow>` may be mounted at a time.
- Safari before 16.4 has no 2-D `OffscreenCanvas` in a worker, so live
  detection runs on the main thread there, as it did before the worker
  existed. A host that sends CSP headers on its asset files must allow the
  worker's own response (see the README's host checklist) or it, too, runs
  detection on the main thread.
- The ONNX Runtime runs single-threaded. Threads need a cross-origin-isolated
  page, which a static export cannot arrange for itself.
- Copy is built in: `lang` chooses pt-BR or en-US and a host cannot reword a
  string.
- The hints and auto-capture were tuned on the bench's synthetic sessions,
  whose camera has no auto-exposure: "Pouca luz" reads the frame's
  highlights, and on an emulated black keyboard on a dark desk it says so
  there too. How a real phone's exposure, torch and tremor behave is still
  to be checked on devices; iOS Safari has no torch constraint and no
  `navigator.vibrate`, so an iPhone shows no torch toggle and feels no tick.
- Auto-capture cannot tell a page swapped in at exactly the same place (with
  the phone not moving) from the page it just took; the shutter is there for
  that case.
