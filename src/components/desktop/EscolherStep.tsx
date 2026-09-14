"use client";

import * as React from "react";
import clsx from "clsx";
import { formatBytes } from "@/lib/image";
import { filesFromDrop, totalBytes, type ChosenFile } from "@/lib/desktop-intake";
import type { PageTile } from "@/lib/page-tiles";
import { useBlobUrl, useStore } from "@/hooks/useScanStore";
import { useScanRuntime } from "@/hooks/useScanRuntime";
import { useCopy } from "@/components/I18n";
import { Meta } from "@/components/ui";
import { FolderIcon, UploadIcon } from "@/components/icons";
import type { IntakeState } from "@/components/desktop/DesktopFlow";

/**
 * Step 1 — the pile of files.
 *
 * The whole screen is one gesture with three ways to perform it: drop the files
 * on the panel, click it, or use one of the two buttons inside it. The panel is
 * the drop target rather than the window, deliberately: a full-window drop zone
 * has to guess what a stray drag over the page means, and guessing wrong eats a
 * drag the user meant for their own file manager.
 *
 * **There is no per-file confirm here.** The phone shows every capture on
 * `ConfirmCornersScreen` before it becomes a page, because on a phone the
 * capture just happened and the frame is the only thing on screen. Twenty of
 * those in a row for a folder drop would be a punishment; on this flow step 2
 * IS the confirmation surface, and a file whose edges could not be found simply
 * arrives wearing "bordas não encontradas" there.
 */
export function EscolherStep({
  tiles,
  intake,
  onPick,
  onPickFolder,
  onContinue,
}: {
  tiles: readonly PageTile[];
  intake: IntakeState;
  onPick: () => void;
  onPickFolder: () => void;
  onContinue: () => void;
}) {
  const copy = useCopy();
  const store = useStore();
  const runtime = useScanRuntime();
  const [dragging, setDragging] = React.useState(false);
  /** Nested dragenter/dragleave pairs fire per child; count them, don't guess. */
  const depth = React.useRef(0);

  const files = intake.files;
  const pageCount = tiles.length;
  const refused = files.filter((file) => file.state === "refused");

  /**
   * A drop is read through the entry API, not through `dataTransfer.files`.
   *
   * The panel promises "uma pasta inteira mantém a ordem dos nomes" two lines
   * above this target, and a dropped folder is not in the flat file list at
   * all — so reading only that list turns the promise into a refused row named
   * after the folder. `filesFromDrop` walks the tree and hands back the same
   * shape the folder button produces; the transfer is read synchronously
   * inside it, because a `DataTransfer` is dead the moment this handler
   * returns.
   */
  const handleDrop = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      void filesFromDrop(event.dataTransfer).then(intake.accept);
    },
    [intake],
  );

  const clearAll = React.useCallback(() => {
    intake.clear();
    for (const tile of tiles) store.removePage(tile.pageId);
  }, [intake, store, tiles]);

  return (
    <main className="flex min-h-0 flex-1 flex-col items-center overflow-auto px-[clamp(16px,3vw,40px)] py-[clamp(20px,4vh,52px)]">
      <div className="my-auto flex w-[min(680px,100%)] flex-col gap-5">
        <div className="flex flex-col gap-2 text-center">
          <Meta caps tone="sage" size="sm">
            {copy.desktop.escolher.kicker}
          </Meta>
          <h1 className="font-display text-[clamp(1.625rem,2.4vw,2.125rem)] font-semibold leading-[1.12] text-ink">
            {copy.desktop.escolher.title}
          </h1>
          <p className="mx-auto max-w-[520px] text-[0.90625rem] leading-relaxed text-desk-muted">
            {copy.desktop.escolher.lead(runtime.intake.pdf)}
          </p>
        </div>

        {/* A div, not a button: it contains two buttons of its own, and a
            button inside a button is invalid and unfocusable. The keyboard
            reaches the same picker through those two. */}
        <div
          onClick={onPick}
          onDragEnter={(event) => {
            event.preventDefault();
            depth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => {
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setDragging(false);
          }}
          onDrop={handleDrop}
          className={clsx(
            "flex cursor-pointer flex-col items-center gap-4 rounded-[22px] border-2 border-dashed",
            "px-7 py-[clamp(24px,4vh,42px)] transition-colors duration-200",
            dragging ? "border-mist bg-white" : "border-desk-dash bg-warm hover:border-mist hover:bg-white",
          )}
        >
          <span
            aria-hidden="true"
            className="flex h-[62px] w-[62px] items-center justify-center rounded-[18px] bg-mint text-leaf"
          >
            <UploadIcon size={26} />
          </span>
          <div className="flex flex-col items-center gap-1.5 text-center">
            <span className="font-display text-2xl font-semibold text-ink">
              {copy.desktop.escolher.dropTitle}
            </span>
            <span className="text-sm text-ink-3">
              {copy.desktop.escolher.dropFormats(runtime.intake.pdf)}
            </span>
          </div>
          <div className="flex flex-wrap justify-center gap-2.5">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onPick();
              }}
              className="inline-flex h-12 items-center rounded-xl bg-deep px-[22px] text-sm font-bold text-paper transition-colors duration-200 hover:bg-leaf"
            >
              {copy.desktop.escolher.pickFiles}
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onPickFolder();
              }}
              className="inline-flex h-12 items-center gap-2 rounded-xl border-[1.5px] border-desk-edge bg-warm px-5 text-sm font-semibold text-leaf transition-colors duration-200 hover:border-leaf"
            >
              <FolderIcon size={17} />
              {copy.desktop.escolher.pickFolder}
            </button>
          </div>
        </div>

        {/* The ink is `peach-ink`, not the desktop's own warn ink: #A5613A on
            `peach-bg` computes 4.49:1, which is *just* under AA for text this
            size. The card treatment is the design's; the ink is the one that
            same pairing already uses on the destructive sheet button. */}
        {(refused.length > 0 || intake.atCapacity) && (
          <div className="flex flex-col gap-1.5 rounded-2xl border border-peach-soft bg-peach-bg px-4 py-3">
            {refused.length > 0 && (
              <p className="text-sm leading-snug text-peach-ink">
                {copy.desktop.escolher.refused(
                  refused.map((file) => file.name).join(", "),
                )}
              </p>
            )}
            {intake.atCapacity && (
              <p className="text-sm leading-snug text-peach-ink">
                {copy.desktop.escolher.atCapacity(runtime.maxPages)}
              </p>
            )}
          </div>
        )}

        {files.length > 0 ? (
          <div className="flex flex-col overflow-hidden rounded-[18px] border border-border bg-warm">
            <div className="flex items-center justify-between gap-3 border-b border-desk-hair px-[18px] py-3.5">
              <span className="flex min-w-0 items-center gap-2.5">
                <FolderIcon size={17} className="shrink-0 text-leaf" />
                <span className="truncate font-display text-lg font-semibold text-ink">
                  {intake.source ?? copy.desktop.escolher.listLabel}
                </span>
                <Meta size="xs" className="shrink-0">
                  {intake.busy
                    ? copy.desktop.escolher.opening(intake.done, files.length)
                    : copy.desktop.escolher.summary(
                        files.length,
                        formatBytes(totalBytes(files)),
                      )}
                </Meta>
              </span>
              <button
                type="button"
                onClick={clearAll}
                className="shrink-0 border-b border-desk-off text-xs text-ink-3 transition-colors duration-200 hover:text-ink"
              >
                {copy.desktop.escolher.clear}
              </button>
            </div>

            <ul className="max-h-[38vh] overflow-auto">
              {files.map((file, index) => (
                <FileRow
                  key={file.key}
                  file={file}
                  index={index + 1}
                  tile={intake.tileFor(file)}
                />
              ))}
            </ul>

            {/* The footer is the way on, so it only exists when there is
                somewhere to go: with every file refused, "Conferir 0 páginas"
                greyed out would be the app offering a door into an empty room
                instead of just showing the refusals. */}
            {pageCount > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3.5 px-[18px] py-4">
                <span className="text-xs leading-snug text-desk-muted">
                  {copy.desktop.escolher.noManualCrop}
                </span>
                <button
                  type="button"
                  onClick={onContinue}
                  className={clsx(
                    "inline-flex h-[50px] items-center gap-2.5 rounded-xl px-6",
                    "bg-deep text-[0.90625rem] font-bold text-paper",
                    "transition-colors duration-200 hover:bg-leaf",
                  )}
                >
                  {copy.desktop.escolher.conferirCta(pageCount)}
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <ol className="flex flex-col gap-3 px-2.5 py-1">
            {copy.desktop.escolher.explain.map((line, index) => (
              <li key={line} className="flex items-center gap-3.5">
                <span
                  aria-hidden="true"
                  className="min-w-[32px] font-display text-[2.25rem] font-bold leading-[0.9] text-desk-ghost"
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 text-sm leading-normal text-desk-body">
                  {line}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </main>
  );
}

/** One chosen file: its place in the order, its picture once it has one. */
function FileRow({
  file,
  index,
  tile,
}: {
  file: ChosenFile;
  index: number;
  tile: PageTile | null;
}) {
  const copy = useCopy();
  const thumb = useBlobUrl(tile?.page.thumb ?? null);
  const refused = file.state === "refused";

  return (
    <li className="flex items-center gap-3 border-b border-paper px-[18px] py-2.5 last:border-b-0">
      <Meta size="sm" className="w-5 shrink-0">
        {String(index).padStart(2, "0")}
      </Meta>
      <span className="h-11 w-[34px] shrink-0 overflow-hidden rounded border border-border bg-paper">
        {thumb !== null && (
          // Decoration: the row's own name is right beside it.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
        {file.name}
      </span>
      {refused ? (
        <span className="max-w-[260px] truncate text-xs text-desk-warn">
          {copy.pageErrors[file.error ?? "generic"]}
        </span>
      ) : (
        <Meta size="xs">{formatBytes(file.size)}</Meta>
      )}
      <span className="shrink-0 rounded-md bg-mint px-2 py-1 font-mono text-[0.59375rem] uppercase leading-none tracking-[0.05em] text-leaf">
        {file.kind}
      </span>
    </li>
  );
}
