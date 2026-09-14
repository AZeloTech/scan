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
| **Capture** | The camera opens, a neural corner detector finds the page in the frame, and a person confirms or drags the four corners. No camera? It falls back to picking image files on its own. |
| **Flatten** | A Rust/WebAssembly dewarp straightens curved paper — the bend of a page held in one hand — and falls back gracefully when the geometry is not trustworthy. |
| **Review** | Pages as thumbnails: reorder, retake, remove. Blur and small-text warnings before it is too late to re-shoot. |
| **Build** | One PDF, assembled in the browser. Given `maxBytes`, quality steps down a fixed ladder until the exact size fits — and refuses rather than exceed it. |

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
phone. It does not render a backdrop, trap focus or handle the back button, and
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
| `defaultFileName` | the finished file's name, used **verbatim**. When you pass it, the flow shows no way to name the document (no marking chips, no text field) and the PDF's `/Title` is this name without `.pdf`. Without it the flow composes `<yyyymmdd>-<hhmm>_<marking>.pdf` from the scan's start and a marking the person picks ("exame", "receita"…, or a short slugged text), and `/Title` is that file name without `.pdf` — typed text never reaches the metadata as typed. Keep personal data out of it; pass it if your application must not receive anything a person typed. |
| `intake` | which sources are offered: `camera`, `images`, `pdf`. pdf.js loads only if you enable it, and the file-picker copy only mentions PDFs when it is on. |
| `onComplete` | fires once, with the exact `File`, its page count and its byte size. Final. |
| `onCancel` | a request to close, with `"user"` (never final — see above) or `"error"` (final). |
| `onPagesChange` | how many pages are held, so you can ask before discarding. |
| `onEvent` | step, capture, quality, size and error events. Numbers and enums only — never image data, never a file name. Safe to forward straight to analytics. |
| `className` | applied to the library's root element, for layout only. |

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
// { mlReady: true, pdfBytes: 82259, pages: 1, pdfImportReady: null, ms: 1840 }
```

It loads the model, runs one inference and builds a PDF from a drawn
placeholder. Run it once behind a feature flag after wiring `assetBaseUrl` for
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

If `npm run smoke` cannot download the Chromium build Playwright expects, point
it at a browser you already have:

```sh
SCAN_SMOKE_CHROME=~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome npm run smoke
```

## Licence

Apache-2.0. Third-party components keep their own licences, recorded in
[`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES).
