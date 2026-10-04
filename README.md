<div align="center">

# @azelotech/scan

**An in-browser document scanner.**
Point a camera at a page and get a PDF — with no app to install, no server to
trust and nobody selling you anything.

[![licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-2f6f4e)](LICENSE)
[![React 18.3 · 19](https://img.shields.io/badge/React-18.3%20%C2%B7%2019-2f6f4e)](#host-checklist)
[![on-device](https://img.shields.io/badge/network%20calls-zero-2f6f4e)](#privacy)

> Scan é um projeto de código aberto para digitalizar documentos de saúde com a
> câmera. Tudo é processado no seu aparelho. Nada sai dele sem você mandar.

</div>

---

## Why this exists

Digitising a piece of paper is one of the most ordinary things a person can
need, and it has become one of the most expensive. The scanner apps want an
install, then the camera, then the whole photo library. Most of them send the
page to a server to "enhance" it. They come with adverts, a subscription prompt,
a watermark on the free tier — and somewhere in that exchange, a photograph of
your exam or your ID ends up on somebody else's computer.

None of it is necessary. A browser already has a camera, WebAssembly and a
canvas. That is a scanner.

So this is one: a React component you drop into a web page. Somebody opens a
link, points the camera at a page, fixes the corners if they need to, and gets a
PDF. Nothing is installed. Nothing is uploaded — **there is no network code in
this library at all**, so there is no server to trust, no account, no tracking,
and nothing to sell. The page is processed where it already is, on the device,
and it leaves only if the person says so.

That last part is the whole design. The library produces exactly one thing — a
`File` — and stops:

```tsx
<ScanFlow assetBaseUrl="/scan-assets" onComplete={({ file }) => upload(file)} onCancel={close} />
```

There is no result screen, no download button and no upload endpoint, because
what happens to the document next is a decision only the host application — and
the person holding the phone — can make.

## What happens inside

| | |
|---|---|
| **Capture** | The camera opens, a neural corner detector finds the page in the frame and guides the aim — one short hint at a time ("Aproxime", "Afaste um pouco", "Mova o celular para cima", "Pouca luz", "Reflexo — incline o celular", "Segure firme"), a ready cue on the corner brackets, the torch where the phone has one — and a person confirms or drags the four corners. The shutter always works. Auto-capture (taking the photo once the page has been ready for a moment, still through the corner confirmation) is experimental: the default capture screen offers it as a MANUAL · AUTOMÁTICO (BETA) switch that starts on MANUAL in every flow, and a host can hide it (`experimentalAutoCapture={false}`). "Já tenho a foto" picks a photo already on the device. No camera? It falls back to picking image files on its own. |
| **Flatten** | A Rust/WebAssembly dewarp straightens curved paper — the bend of a page held in one hand — and falls back gracefully when the geometry is not trustworthy. |
| **Review** | Pages as thumbnails: reorder, retake, remove. Blur and small-text warnings before it is too late to re-shoot. Its primary button is "Gerar PDF": it starts the build straight from the page list. |
| **Build** | One PDF, assembled in the browser, with a progress bar and a cancel (which returns to the page list). Given `maxBytes`, quality steps down a fixed ladder until the exact size fits — and refuses rather than exceed it. A build that fails or does not fit shows why, with every page still there, the file name and a second "Gerar PDF". |

Then `onComplete` fires, once, with the finished `File`.

## Install

```sh
npm install @azelotech/scan gsap
npx scan-copy-assets public          # → public/scan-assets
```

**The copy step is required.** The corner-detection model, the ONNX Runtime pair
and the optional pdf.js runtime locate their own files at runtime through a
*string base* — not through URLs a bundler can rewrite. So they cannot ride your
asset pipeline. Copy them into a folder you serve unhashed and pass its URL as
`assetBaseUrl`. Re-run the command when you upgrade the package; a `prebuild`
script or a `RUN` line in your Dockerfile is the usual home for it.

The folder is about 9 MB on disk, but a session downloads only what it uses:
~3.4 MB of model and runtime on the first capture, and pdf.js (5 MB) only if you
turn `intake.pdf` on.

## Use

```tsx
import { ScanFlow } from "@azelotech/scan";
import "@azelotech/scan/styles.css";

function ScanSheet({ onDone, onClose }) {
  return (
    <div role="dialog" aria-modal="true">
      <ScanFlow
        assetBaseUrl="/scan-assets"
        lang="pt-BR"
        maxPages={20}
        maxBytes={26 * 1024 * 1024}
        intake={{ camera: true, images: true, pdf: false }}
        onComplete={({ file, pageCount }) => onDone(file, pageCount)}
        onCancel={(reason) => onClose(reason)}
        onPagesChange={(count) => setPages(count)}
        onEvent={(event) => analytics.track(event)}
      />
    </div>
  );
}
```

`ScanFlow` fills whatever box you give it and expects to be full-screen on a
phone — give it a box the size of the viewport (`position: fixed; inset: 0`,
as in the consumer smoke test), not a smaller panel. The app shell's height is
`100svh` with a `100vh` fallback, not a percentage of its container, so a
box smaller than the viewport will not shrink it to fit; it will overflow that
box instead. A page with `viewport-fit=cover` is fine: the bottom action bars
keep `env(safe-area-inset-bottom)` (and never less than 14px) clear under their
last button, so nothing sits under an iPhone's home indicator or Android's
gesture bar. It does not render a backdrop, trap focus or handle the back button, and
it never pushes a history entry — not even for its own page preview, which
closes through its own controls and Escape. Those belong to your dialog,
because only you know your navigation. Inside, it
does provide dialog-ready semantics — real buttons, a live region, keyboard
reordering and `prefers-reduced-motion` support.

**The intended shape.** Open it where the person already is — beside the upload
field, not in a separate "scan" area — and hand the result straight to the code
that was waiting for a file:

```tsx
onComplete={({ file }) => {
  const data = new DataTransfer();
  data.items.add(file);
  inputRef.current.files = data.files;   // the form now holds the PDF
  setOpen(false);
}}
```

`onCancel` is a *request* to close, never an announcement: the library never
unmounts itself, so you can ask "discard these pages?" first. `onPagesChange`
tells you whether there is anything to lose. A `"user"` request does not end
anything: if the answer is "keep scanning", simply keep the component mounted —
every control still works, `onComplete` can still fire, and the next close
request calls `onCancel("user")` again. (A second request inside the same double
tap, under ~400 ms, is swallowed.) Only `onComplete` and `onCancel("error")` are
final.

The library's copy says what happens on the device and stops there. It never
claims that nothing is sent, never mentions downloads or sharing, and never
describes what your application does with the file — that is yours to say.

## API

Full types ship with the package (`ScanFlowProps`). In short:

| Prop | Meaning |
|---|---|
| `assetBaseUrl` | **required.** Where `scan-copy-assets` put the files. |
| `lang` | `"pt-BR"` (default) or `"en-US"`. |
| `maxPages` | default 20. |
| `maxBytes` | a hard budget. Quality steps down a fixed ladder to fit, and refuses rather than exceed it. Pass the same limit your upload path enforces. |
| `defaultFileName` | the finished file's name, used **verbatim**. When you pass it, the flow shows no way to name the document (no marking chips, no text field) and the PDF's `/Title` is this name without `.pdf`. Without it the flow composes `<yyyymmdd>-<hhmm>_<marking>.pdf` from the scan's start and a marking — "exame" unless the person picks another ("receita"…, or a short slugged text) on the screen a failed build falls back to, or on the desktop flow's step 3, and `/Title` is that file name without `.pdf` — typed text never reaches the metadata as typed. Keep personal data out of it; pass it if your application must not receive anything a person typed. |
| `intake` | which sources are offered: `camera`, `images`, `pdf`. pdf.js loads only if you enable it, and the file-picker copy only mentions PDFs when it is on. |
| `onComplete` | fires once, with the exact `File`, its page count and its byte size. Final. |
| `onCancel` | a request to close, with `"user"` (never final — see above) or `"error"` (final). |
| `onPagesChange` | how many pages are held, so you can ask before discarding. |
| `onEvent` | step, capture, quality, size and error events. Numbers and enums only — never image data, never a file name. Safe to forward straight to analytics. |
| `className` | applied to the library's root element, for layout only. |
| `captureLayout` | default `"rail"`. The capture screen (step 1). `"rail"`: the camera full-bleed, the hint under the top row, a MANUAL · AUTOMÁTICO (BETA) mode rail over the shutter (see `experimentalAutoCapture`), the newest page and the onward button either side of the shutter, and "Já tenho a foto" (when `intake.images` is on) as a small text button under it. `"standard"`: the screen that shipped before — header, viewfinder card, thumbnail rail, control row with the gallery pill — kept for hosts that want it (`"default"` is its deprecated old name and still works). **Experimental** alternatives, which may change or go away in any release and have no in-camera gallery pick: `"classic"` (translucent bottom bar), `"filmstrip"` (camera on top, the pages as a numbered strip under it), `"onehand"` (no bars, controls down the right edge, the hint hung on the page's corner), `"collapse"` (classic while searching, folding into one capsule while the page is ready). Every layout is the same capture stage — same detection, hints, ready cue on the brackets, torch, notices, page limit, confirm-corners screen after every photo, retake and corner editor, camera-refused file surface, and a shutter that works in every state. Unknown values fall back to `"rail"`. `experimentalCaptureLayout` is the deprecated old name of this prop (read only when `captureLayout` is absent). |
| `experimentalDiagnostics` | **experimental**, default `false`. A small HUD over the viewfinder for testing on a real phone: detection lane (and why, if not the worker), detection time and its median, the loop's cadence, frame age, stream and photo size, the part of the frame the person can see and the layout's fit, torch and vibration support, the ready cue and auto-capture's state and fires, and — while the cue is off or auto-capture has not fired — `why:` the first thing holding it back (no page, a hint, a pass that missed, the camera moved, no fresh pass, too few readings, stillness or drift, the countdown). Numbers only: it stores nothing, sends nothing and reads no pixels. Its glass is 40 % dark, so the picture — and a page corner — stays visible through it. Leave it off in production. |
| `onDiagnostics` | **experimental**. A field-test event stream: `(event: ScanDiagnosticsEvent) => void`. See [Diagnostics events](#diagnostics-events-experimental). Absent by default; nothing is built for it then. |
| `experimentalAutoCapture` | **experimental.** Whether the auto-capture toggle is offered. **Omitted**: the layout decides — `"rail"` (the default), `"onehand"` and `"collapse"` show it, `"standard"` does not. **`false`**: no toggle on any layout, the photo is only ever taken by a tap — pass it for people who will not look at the confirm screen. **`true`**: shows it on `"standard"` too. `"classic"` and `"filmstrip"` never show it. Wherever it shows it starts OFF in every new flow, is never stored, and the shutter stays live in both modes; switched on, the page is taken by itself once framed, sharp and still for about half a second, once per page, through the confirm-corners screen. It still fires on some page-less scenes on the bench — a document shown on a phone or tablet screen, and two overlapping sheets taken as one — so a person must look at the confirm screen; refusing those scenes is planned work, not done yet. |

### Diagnostics events (experimental)

`onDiagnostics` hands the host what the capture loop is doing on the device,
for testing on real phones: the session's facts (layout, viewport, device
pixel ratio, safe-area insets, vibration support), the camera coming up
(stream size, time to a live preview, torch support), the detection lane and
why, the live loop sampled at most twice in any second (detection time and median,
cadence, frame age, found / locked / ready, the HUD's `why:` reason, and the
newest pass's model confidence, why its quad was turned away, the paper
evidence's verdict and the fill),
the visible region, hints shown and for how long and the ready cue on and
off (each with `fill`, the page's reach across the viewfinder at that moment),
auto-capture's countdown, cancellations (with the reason), fires (time from a
steady page) and re-arming — the ready cue coming on, the countdown and the
fire carry `phases`: how many ms before the event each of the cue's
conditions (a found sheet, no hint owed, the hint slot empty, still, corners
certain, a fresh pass) last came true, and for the fire the settling, the cue,
the countdown's start and end, the final confirming frame and the loop's
interval — numbers only; a `move-phone` hint carries its `direction`, each capture (manual or automatic, the photo as
it arrived, the size it was asked for, the stream size, the part of the photo
kept as the preview's field of view, whether the still or the preview became
the page and — when it was the preview — why (`stillReason`), the page's
canonical pixels, bytes and JPEG quality, whether a browser canvas limit had
to shrink it, whether the live stream was capped at the tap and — when a
still failed on a capped stream — whether the native stream came back for
the page, where the corners came from, the still's registration numbers
and the photo check's flag), each confirm-corners answer (kept, moved — the
largest corner move as a percentage of the photo's diagonal —, retake or
whole photo, with the canonical's sizes), the live stream's cap on Android (`stream-cap`: applied or not, and why — `disabled` as shipped),
each page render (the page region's
pixel size and the final JPEG's size, bytes and quality), each page of a
finished PDF (the embedded image's pixels, bytes, ladder rung and quality,
and whether the size ladder resampled it), pages removed
(and brought back by the editor's undo) or retaken, the page hidden and shown and the time until the camera answers
again, stalls, the torch and the auto-capture toggle, and every `onEvent`
event — rebuilt field by field from that event's own allowlisted fields
before your `onEvent` is called, so whatever a host adds to the object it
receives stays its own. Each event has `v` (schema version, now 1), `seq` and `t` (ms since the
flow mounted).

**The privacy contract.** An event carries numbers, booleans, enums,
library-made reason strings and corner-geometry fractions — never pixels,
thumbnails, crops, image hashes or signatures, text read from a page, file
names, or a user agent. That is enforced at run time as well as by the type:
anything that is not a plain value is dropped before the callback is called,
and nesting is cut off a few levels down (a cyclic object cannot stall the
scanner). Anything *you* add to what you forward — a tester's note, a URL
parameter — is outside this contract.
**The library never sends, stores or buffers an event**; it only calls your
function. Whether events leave the device, where they go and on what legal
basis (LGPD, when a person is photographing a medical document) is the host's
decision and responsibility. The shape may change in any release.

### Theming

The stylesheet is one compiled file, scoped entirely to `.scan-root` — including
Tailwind's `--tw-*` variable defaults, which Tailwind itself would emit on `*`
and `::backdrop`; there is no `.container` rule. The dist guard parses the
compiled file and fails the build on any selector outside `.scan-root`. It sets
no global styles, resets nothing of yours and fetches no font. Four variables are
yours to set:

```css
.scan-root {
  --scan-surface: #fafaf7;
  --scan-ink:     #1b1f1a;
  --scan-accent:  #5c7f6b;
  --scan-radius:  14px;
  /* load the faces yourself, then: */
  --scan-font-display: "Baloo 2", cursive;
  --scan-font-body:    "Plus Jakarta Sans", system-ui;
}
```

The capture screen ignores all of it and stays dark on purpose: a viewfinder on
a light shell reads badly, and the corner brackets need the contrast.

### Proving your wiring works

Asset paths are the one thing a build cannot verify, because the files are
located by string inside third-party code. So you can check it in a real
browser:

```ts
import { selfTest } from "@azelotech/scan/self-test";

const r = await selfTest({ assetBaseUrl: "/scan-assets" });
// { mlReady: true, detectWorker: "worker", pdfBytes: 82259, pages: 1, pdfImportReady: null, ms: 1840 }
```

It loads the model, runs one inference, starts the detection worker once
(`detectWorker` says `"worker"`, or why it could not — see the CSP note in the
host checklist) and builds a PDF from a drawn placeholder. Run it once behind a feature flag after wiring `assetBaseUrl` for
the first time, and get a plain answer instead of a mystery 404 in somebody's
console three weeks later.

## Host checklist

**Content Security Policy.** The scanner compiles WebAssembly and decodes images:

```
script-src  'self' 'wasm-unsafe-eval'   # add 'unsafe-eval' to support Safari < 16
worker-src  'self' blob:
img-src     'self' blob: data:
connect-src 'self'
```

`connect-src 'self'` is enough because nothing off-origin is ever fetched. If a
request to another host appears, that is a bug — please report it.

**Workers obey their own response's CSP.** Page detection runs in a module
worker served from your asset directory (`workers/detect.worker.js`), and a
worker is governed by the `Content-Security-Policy` header on *its own* script
response, not by the page's. If your server sends CSP headers on the asset
files, the ones on `<assetBaseUrl>/workers/*.js` must allow at least
`script-src 'self' 'wasm-unsafe-eval'` and `connect-src 'self'` (or send no CSP
there at all). A worker that cannot start — or cannot compile WebAssembly
under its own CSP — is not an error: the scanner detects on the main thread
instead, exactly as it did before the worker existed — it just costs the page
more. `selfTest()` reports which (`detectWorker`: `"worker"`, or the reason,
e.g. `"no-wasm-in-worker"`). The worker lives while a scanner is mounted and
is terminated a minute after the last one unmounts.

One place this is kept rather than given: the vendored scanic runtime, left
unmodified, falls back to a jsDelivr CDN for its model and ONNX Runtime files
when it is called without a base. This library never calls it that way — every
ML call passes `assetBaseUrl`, `modelUrl` and `wasmPaths` derived from your
`assetBaseUrl` (`src/lib/runtime-config.ts`) — and `npm run smoke` drives the
model load in two real consumer builds and fails on any off-origin request.

**Serving the assets.** Serve `scan-assets/` with immutable caching and without
renaming or hashing its files: the ONNX Runtime loader finds its `.wasm` sibling
by name.

**HTTPS.** `getUserMedia` needs a secure context. `localhost` counts; a LAN IP
does not.

**Browsers.** Chrome/Edge 91+, Firefox 90+, Safari 16+. Safari 15 works if your
CSP includes `'unsafe-eval'`. Where there is no camera, the component falls back
to the file intake on its own.

**The torch and haptics.** The torch toggle appears only when the camera track
advertises `torch` in `getCapabilities()` (Chrome on Android does; Safari on
iOS does not, so an iPhone shows no toggle), and it is switched with
`applyConstraints`. If your page sets a `Permissions-Policy`, nothing extra is
needed for either. The ready cue's haptic tick uses `navigator.vibrate`, which
iOS does not have — there it is silently skipped (the cue is also announced
once per page to screen readers).

**The camera stream.** The library asks `getUserMedia` for the back camera
(`facingMode: { ideal: "environment" }`) at an ideal 3840×2160 and nothing
else — no aspect ratio, no resize mode — so the phone picks one of its own
modes (a 4K 9:16 portrait stream on a recent Galaxy; a 4:3 one where the
nearest mode is 4:3). Asking for a 9:16 shape would not show more: on a
screen taller than the stream, the full-bleed viewfinder shows the stream's
whole height either way, so the angle on screen is the same, and a 4:3
stream only carries more margin off screen — which a photo taken from the
preview frame (Safari has no `ImageCapture`) keeps.

**How close.** "Aproxime" asks for the page to fill most of what the
camera shows — not most of its area (a tall phone's viewfinder is about
0.46 as wide as it is tall and an A4 page 0.71, so a page as big as the
screen allows still covers only ~65 % of it) but most of its *reach*: the
page's extent along the viewfinder's limiting axis (its bounding box's
larger share of the width or the height). Under 70 % the hint comes up,
and it goes once the page reaches 75 % (between the two lines, whatever
was showing stays — no ping-pong); a page nearly there (60 % or more when
the hint appears) reads "Aproxime mais um pouco". It asks only while the
page has room to come closer: a page held off the middle that already
reaches the edge of the view at 65 % or more is taken as framed, and one at
the edge that would fit if it were centred hears which way to move the
phone — "Mova o celular para cima / para baixo / para a esquerda / para a
direita", one way at a time, toward the side the page is cut on, with a
small arrow at that edge of the viewfinder —
"Afaste um pouco" is only for a page already as big as asked (a corner
within 1.5 % of the edge), too big to fit, or whose paper runs on past the
edge. The ready cue — and so auto-capture — waits for it; the shutter
does not: a photo can be taken at any size. Why it matters: the photo's
resolution goes to the page in proportion to how much of the frame it
fills (on a Galaxy S25 Ultra a page across 54 % of the photo's width is
~125–150 dpi for A4; held as asked, the page gets ~25 % more pixels each way — ~140–175 dpi).

**What the camera shows is what is judged.** "Afaste um pouco", "Aproxime",
the ready cue and auto-capture judge the page against the part of the frame
the person can actually see — the video under the layout's fit, clipped by
the screen (and a pinch zoom), minus the chrome drawn over it: the notch and
home indicator (`env(safe-area-inset-*)`, so give your page
`viewport-fit=cover` if it runs edge to edge) and, on `"rail"`, the band of
controls over the dark fade (measured from the controls themselves, so
larger text moves it), and any control drawn over the picture away from an
edge — the glass buttons of the top row, the hint pill. A corner hidden
there counts as cut off. A viewfinder that is not on screen at all (the
page scrolled or pinched away from it) shows no ready cue and takes no
photo; the live loop starts afresh when it is back.
`"rail"` is full-bleed: the camera fills the whole screen (`object-fit:
cover`) and the controls sit over a dark fade, so on a tall phone the sides
of the frame and the part under the controls are off screen — and a page
framed in what is left is framed, while one whose side runs off the screen
reads "Afaste um pouco". `"standard"` keeps its viewfinder card. Detection itself still looks at the whole frame, and the photo keeps
the camera's full frame. Before the confirm screen the photo is checked
against what the viewfinder showed. A photo from the camera's still
pipeline (which may see less or more than the preview, and says nothing
about it) is registered against a small grey thumbnail of the viewfinder
taken at the tap, so where the viewfinder's page lies on the photo is
measured from the pictures, not taken from the photo's own page detection.
A photo with a corner on its edge, a page not where the viewfinder had it,
no page at all, or — for an automatic capture — a photo that could not be
checked opens the confirm screen with one short line asking for a closer
look ("Um canto pode ter ficado de fora da foto — confira."). The line is
advisory: the confirm screen, the corner editor and retake work the same
with or without it, a manual capture is never held back, and it is only
flagged on evidence (a corner on the photo's edge, or the registration);
an automatic capture is held to the stricter bar. Nothing is ever accepted
silently, and nothing is blocked. From the tap (or the automatic fire) to the confirm screen the
corner marks stay frozen where they were: a preview that freezes, resizes
or re-exposes while the photo is taken moves nothing on screen.

Auto-capture is experimental: its toggle
shows on the default `"rail"` layout unless the host passes
`experimentalAutoCapture={false}`, it is off in every new flow, the
flow keeps the choice while it is open, and the library writes nothing to
storage for it. Retakes are always manual.

**A corner something lies over.** A sheet over a corner of the page, a clip
on it: the page's corner is placed where the visible runs of its two edges
meet rather than on the outline of what covers it, and it is marked as
estimated — a dashed bracket in the viewfinder, a hollow "estimado" handle
on the confirm screen. Auto-capture does not fire on a page with such a
corner, on two sheets seen overlapping ("Separe as folhas"), or on a page
whose corners no recent pass has measured; the shutter always works. When
the edges are not seen far enough to place the corner, the viewfinder says
"Canto coberto — afaste a folha de cima". A cover the edges do not show at
all (a white sheet on a white desk) can still read as a seen corner, so the
confirm screen after every capture remains the check.

**React.** 18.3 or 19, StrictMode-safe.

**GSAP** is a peer dependency, so install it alongside this package. The motion
vocabulary is built on it — the quarter turn of a page, the reorder, the arrival
of a new thumbnail — and every one of those animates transform and opacity only,
because this runs on cheap phones. It is a peer rather than a dependency so your
application and this component share one copy, and so that nothing of GSAP is
redistributed in our tarball. All motion collapses to nothing under
`prefers-reduced-motion`.

## What it deliberately does not do

No uploading, no storage, no result screen. No OCR and no text extraction. No
server-side rendering — it is a browser component, mounted client-side. No
recovery of a session across a reload: pages live in memory only, and that is a
privacy decision, not an omission.

## Privacy

There is no network code in this library beyond loading its own files from
`assetBaseUrl`, and a test in the suite fails the build if any other appears.
Pages live in memory only: a reload loses them, by design, and no page, image,
file name or typed text is written to IndexedDB, localStorage, sessionStorage
or a cache.

The one thing it does persist is whether a person has already seen two UI tips,
as `localStorage` flags under the host's origin: `scan.tip.edit` and
`scan.tip.compare`, each `"1"` once seen. They carry no personal data and
nothing about any document; a storage that refuses them costs only the memory
of the tip. The language is not remembered — it is the `lang` prop. Every image is
re-encoded through a canvas before it enters the PDF, so EXIF metadata — GPS,
device model, timestamps — never survives. The PDF records only which transforms
were applied.

What your application does with the finished `File` is yours to explain to your
users. If you upload it, say so.

## Development

```sh
npm install
sh scripts/install-hooks.sh   # once per clone: installs the PII pre-commit guard
npm run verify                # guard, typecheck, tests, build, dist guard
npm run smoke                 # real-browser consumer tests (Vite + Next)
```

The smoke test is the one that matters: it builds a Vite application and a Next
static export against the library, drives both in a real browser, and fails on
any off-origin request or any 404.

> **This repository is public and the products built on it handle health
> documents. No personal data enters it — ever.** No photograph of a real
> document, not even cropped or blurred; no real names, identifiers, phone
> numbers or addresses. Fixtures are generated synthetically by scripts in this
> repository and recorded in `fixtures/PROVENANCE.md`. The guard runs before
> every commit and in CI, and has no override flag.

`npm run bench` runs the detection bench: a seeded scene emulator renders
documents on desks in headless Chromium, the library's own detectors run on
them, and every answer is scored against exact ground truth into `.bench-out/`
(git-ignored). `npm run bench -- --suite session` does the same for the whole
flow: the real `<ScanFlow>` on an emulated phone, fed by an emulated camera
watching a document being scanned; `npm run bench:play` opens the same flow in
a playground with a live HUD, and `npm run bench:webkit` plays one session end
to end in WebKit. With `SCAN_REAL_MEDIA` pointing at real photos
and clips **outside** the repository, `--suite real-stills` and
`--suite real-video` score them too, and `npm run bench:label` serves a page
for labelling their corners by hand. Nothing it renders is committed, and
anything derived from real photos stays outside the repository, in
`~/.cache/scan-bench/`. See [`scripts/bench/README.md`](scripts/bench/README.md).

If `npm run smoke` cannot download the Chromium build Playwright expects, point
it at a browser you already have:

```sh
SCAN_SMOKE_CHROME=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome npm run smoke
```

## Licence

Apache-2.0. Third-party components keep their own licences, recorded in
[`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES).
