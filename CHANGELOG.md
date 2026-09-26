# Changelog

All notable changes to `@azelotech/scan`. The format follows Keep a Changelog.
This package is at 0.x, so the public API is documented but not yet frozen; it
freezes at 1.0.

## [Unreleased]

### Added
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

### Known limitations
- The Rust crate ships its in-module unit tests but no golden/parity suite: the
  fixtures such a suite needs are photographs of documents, and this repository
  admits no photograph of a real document. Restoring it means generating the
  fixtures synthetically first.
- Only one `<ScanFlow>` may be mounted at a time.
- The ONNX Runtime runs single-threaded. Threads need a cross-origin-isolated
  page, which a static export cannot arrange for itself.
- Copy is built in: `lang` chooses pt-BR or en-US and a host cannot reword a
  string.
