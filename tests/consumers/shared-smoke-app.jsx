/**
 * One page, shared by both consumer applications.
 *
 * It does two things and reports both through `window.__scanSmoke`:
 *
 *   1. Mounts `<ScanFlow>` under StrictMode. React StrictMode mounts, unmounts
 *      and mounts again in development, which is the cheapest way to catch a
 *      camera stream or a worker that a cleanup failed to release. The Vite
 *      consumer runs a production build, so this mostly proves the component
 *      renders at all in each bundler; the StrictMode wrapper stays because the
 *      Next consumer keeps `reactStrictMode` on.
 *
 *      It also mounts it inside a `<Suspense>` whose sibling suspends on the
 *      first render, which is how a host that lazy-loads the scanner discards
 *      a render before it commits. A store created by that discarded render
 *      used to be orphaned and trip the one-instance warning; the runner fails
 *      on any console message from the library.
 *
 *   2. Runs the library's asset self-test, which loads the corner-detection
 *      model, runs one inference, and builds a PDF from a generated image.
 *      That is the part a build-output assertion cannot reach: every one of
 *      those files is located at runtime by a string, inside third-party code.
 *
 * The image it feeds through is drawn here, in code: a pale rectangle on a dark
 * ground, with a few ruled lines. Nothing in this repository may be a photograph
 * of a real document, and a test fixture is no exception.
 */

import { StrictMode, Suspense, useEffect, useState } from "react";
import { ScanFlow } from "@azelotech/scan";
import { selfTest } from "@azelotech/scan/self-test";
// The stylesheet is imported by each consumer's own entry point rather than
// here: Next only accepts a global stylesheet from the app directory, which is
// how a real host wires it in anyway.

const ASSET_BASE_URL = "/scan-assets";

/** A document-shaped picture, drawn rather than photographed. */
export function drawSyntheticPage(width = 1240, height = 1754) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  // The desk around the page, so corner detection has an edge to find.
  context.fillStyle = "#23281f";
  context.fillRect(0, 0, width, height);

  const margin = Math.round(width * 0.06);
  context.fillStyle = "#f4f1e8";
  context.fillRect(margin, margin, width - margin * 2, height - margin * 2);

  // Ruled lines standing in for text. Deterministic: no randomness, so a
  // failure is reproducible.
  context.fillStyle = "#2f3630";
  const lineHeight = Math.round(height * 0.028);
  let y = margin * 2;
  for (let index = 0; y < height - margin * 2; index += 1) {
    const full = index % 7 !== 6;
    const lineWidth = (width - margin * 4) * (full ? 1 : 0.55);
    context.fillRect(margin * 2, y, lineWidth, Math.max(2, Math.round(lineHeight * 0.18)));
    y += lineHeight;
  }
  return canvas;
}

/**
 * Suspends exactly once, briefly, so the first render of its `<Suspense>`
 * boundary — `<ScanFlow>` included — is thrown away before it commits.
 */
let lateReady = false;
const late = new Promise((resolve) =>
  setTimeout(() => {
    lateReady = true;
    resolve();
  }, 50)
);
function SuspendsOnce() {
  if (!lateReady) throw late;
  return null;
}

function report(patch) {
  window.__scanSmoke = { ...(window.__scanSmoke ?? {}), ...patch };
}

export default function SmokeApp() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    report({ done: false, mounted: true });
    let alive = true;

    (async () => {
      try {
        const canvas = drawSyntheticPage();
        const result = await selfTest({
          assetBaseUrl: ASSET_BASE_URL,
          canvas,
          // pdf.js is off by default and most hosts leave it off; the smoke
          // test turns it on so the runtime that only some consumers enable is
          // still proven to resolve its worker, character maps and fonts.
          includePdfImport: true,
        });
        if (!alive) return;
        report({
          mlReady: result.mlReady,
          pdfBytes: result.pdfBytes,
          pages: result.pages,
          pdfImportReady: result.pdfImportReady,
          done: true,
        });
      } catch (error) {
        if (!alive) return;
        report({ error: String(error?.stack ?? error), done: true });
      }
    })();

    setMounted(true);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <StrictMode>
      <Suspense fallback={null}>
        <div style={{ position: "fixed", inset: 0 }}>
          <ScanFlow
            assetBaseUrl={ASSET_BASE_URL}
            lang="pt-BR"
            maxPages={20}
            maxBytes={26 * 1024 * 1024}
            intake={{ camera: true, images: true, pdf: false }}
            onComplete={({ file, pageCount, bytes }) =>
              report({ uiComplete: { name: file.name, pageCount, bytes } })
            }
            onCancel={(reason) => report({ uiCancel: reason })}
            onPagesChange={(count) => report({ uiPages: count })}
            onEvent={(event) => {
              const seen = window.__scanSmoke?.events ?? [];
              report({ events: [...seen, event.name] });
            }}
          />
        </div>
        <SuspendsOnce />
      </Suspense>
      {mounted ? null : null}
    </StrictMode>
  );
}
