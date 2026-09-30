# Changelog

All notable changes to `@azelotech/scan`. The format follows Keep a Changelog.
This package is at 0.x, so the public API is documented but not yet frozen; it
freezes at 1.0.

## [Unreleased]

### Fixed
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

### Added
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
