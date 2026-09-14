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
