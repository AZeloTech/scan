import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { APP_COPY } from "./i18n.ts";

/**
 * The page editor's delete, its (i) and its tools, as far as they can be seen
 * without a browser.
 *
 * The suite runs on bare Node, which cannot load `.tsx`; the one component
 * here small enough to render on its own ({@link CorrectionTile}) is compiled
 * with the esbuild the build already uses and rendered to markup. The editor
 * itself needs a store, a runtime and a DOM, so its wiring is read as source —
 * the same technique `diagnostics-events.test.ts` uses on `ScanFlow` — and the
 * behaviour is covered in a browser by the test app's screenshots.
 */

const ROOT = process.cwd();
const EDITOR = readFileSync(path.join(ROOT, "src", "components", "PagePreview.tsx"), "utf8");

async function renderTile(props: Record<string, unknown>): Promise<string> {
  const { build } = await import("esbuild");
  const result = await build({
    stdin: {
      contents: `
        import * as React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import { CorrectionTile } from "./src/components/CorrectionTile.tsx";
        export function render(props) {
          return renderToStaticMarkup(React.createElement(CorrectionTile, props));
        }
      `,
      resolveDir: ROOT,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    external: ["react", "react-dom", "clsx"],
    logLevel: "silent",
  });
  const dir = path.join(ROOT, "node_modules", ".cache", "scan-tests");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `correction-tile-${process.pid}.mjs`);
  writeFileSync(file, result.outputFiles[0]?.text ?? "");
  const module = (await import(pathToFileURL(file).href)) as { render: (p: unknown) => string };
  return module.render({ onClick: () => {}, icon: null, label: "Girar", ariaLabel: "Girar a página", ...props });
}

test("a tool is drawn plain: no tinted well in any state", async () => {
  for (const state of ["default", "applied", "suggested"]) {
    const html = await renderTile({ state });
    assert.doesNotMatch(html, /bg-mist|bg-peach|text-shell-accent/, `${state}: no tint`);
  }
});

test("an applied tool wears the dot, and says 'aplicado' in words", async () => {
  const plain = await renderTile({ state: "default" });
  assert.doesNotMatch(plain, /data-tool-dot/);
  assert.doesNotMatch(plain, /aria-describedby/);

  const applied = await renderTile({ state: "applied", note: APP_COPY.pt.preview.toolNotes.applied });
  assert.match(applied, /data-tool-dot/);
  assert.match(applied, /bg-shell-accent/);
  const describedBy = /aria-describedby="([^"]+)"/.exec(applied)?.[1];
  assert.ok(describedBy !== undefined, "the note is the tool's description");
  const escaped = describedBy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(applied, new RegExp(`id="${escaped}"[^>]*>aplicado<`));
  // The dot itself is decoration.
  assert.match(applied, /aria-hidden="true"[^>]*data-tool-dot|data-tool-dot[^>]*aria-hidden="true"/);
});

test("the recommended tool's dot is the warn tone, not the applied one", async () => {
  const html = await renderTile({ state: "suggested", note: APP_COPY.pt.preview.toolNotes.suggested });
  assert.match(html, /bg-shell-warn/);
  assert.doesNotMatch(html, /bg-shell-accent/);
});

test("a dimmed tool says why", async () => {
  const html = await renderTile({ disabled: true, note: APP_COPY.pt.preview.toolNotes.failed });
  assert.match(html, /disabled=""/);
  assert.match(html, /indisponível — esta página falhou/);
  assert.match(html, /title="[^"]*indisponível/);
});

test("hover is drawn only where there is a real hover (a phone keeps it after a tap)", async () => {
  const html = await renderTile({});
  assert.doesNotMatch(html, /(^|\s)hover:/);
  assert.match(html, /\[@media\(hover:hover\)_and_\(pointer:fine\)\]:hover:/);
});

test("the delete has no confirmation sheet: it deletes, and offers an undo", () => {
  assert.doesNotMatch(EDITOR, /DeletePageSheet|confirmDelete/);
  assert.match(EDITOR, /removal\.remove\(/);
  assert.match(EDITOR, /role="status"[\s\S]{0,80}data-undo-toast|data-undo-toast[\s\S]{0,80}role="status"/);
  for (const lang of ["pt", "en"] as const) {
    const copy = APP_COPY[lang].preview.undoDelete;
    assert.ok(copy.message.length > 0 && copy.action.length > 0);
    // Label-in-name: the Undo button's accessible name starts with its visible word.
    assert.ok(copy.actionLabel(2).startsWith(copy.action), lang);
  }
  assert.equal(APP_COPY.pt.preview.undoDelete.message + " · " + APP_COPY.pt.preview.undoDelete.action, "Página excluída · Desfazer");
  assert.equal(APP_COPY.en.preview.undoDelete.message + " · " + APP_COPY.en.preview.undoDelete.action, "Page deleted · Undo");
});

test("leaving the editor, however it happens, commits a held delete", () => {
  // The hold is disposed in the cleanup of the effect that made it: every way
  // out (close, Escape, the primary, retake, the corner screen, the host
  // unmounting the editor) unmounts it, and the PDF is built from outside.
  assert.match(EDITOR, /return \(\) => \{\s*removalRef\.current = null;\s*removal\.dispose\(\);\s*\};/);
  assert.match(EDITOR, /commit: \(id\) => store\.removePage\(id\)/);
  // The editor closes onto an empty document only once the hold is real.
  assert.match(EDITOR, /if \(tiles\.length === 0\) onClose\(\);/);
});

test("the (i) sits in the position line, on every page — not behind a flag", () => {
  const position = EDITOR.indexOf("copy.preview.position(index + 1, pageCount)");
  const info = EDITOR.indexOf("<InfoButton", position);
  assert.ok(position > 0 && info > position, "the (i) follows the position line");
  // Nothing between the two decides whether it is drawn.
  const between = EDITOR.slice(position, info);
  assert.doesNotMatch(between, /&&|\?\s*\(/);
  assert.match(EDITOR.slice(info, info + 200), /onClick=\{\(\) => setAbout\(true\)\}/);
  // "por quê?" is still on a flagged page's line.
  assert.match(EDITOR, /status\.trailing === "why"[\s\S]{0,120}setAbout\(true\)/);
  for (const lang of ["pt", "en"] as const) assert.ok(APP_COPY[lang].preview.aboutButton.length > 0);
});
