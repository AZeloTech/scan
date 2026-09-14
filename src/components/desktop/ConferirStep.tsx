"use client";

import * as React from "react";
import clsx from "clsx";
import { displayRotation } from "@/lib/scan-store";
import { isBlocking, type PageTile } from "@/lib/page-tiles";
import type { AppCopy } from "@/lib/i18n";
import type { PageRotation } from "@/lib/rotation";
import type { PageFinish } from "@/lib/page-processing";
import { useBlobUrl } from "@/hooks/useScanStore";
import { usePageTurn } from "@/hooks/usePageTurn";
import { usePageView } from "@/hooks/usePageView";
import { useRotatedFit } from "@/hooks/useRotatedFit";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { useStore } from "@/hooks/useScanStore";
import { useCopy } from "@/components/I18n";
import { Meta } from "@/components/ui";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ContrastIcon,
  CropIcon,
  GripIcon,
  PlusIcon,
  RotateIcon,
  SpinnerIcon,
  TrashIcon,
  WaveIcon,
  XIcon,
} from "@/components/icons";
import {
  DesktopCornerEditor,
  type DesktopCornerEditorHandle,
} from "@/components/desktop/DesktopCornerEditor";

/**
 * Step 2 — the workspace.
 *
 * This is the step the desktop mode exists for. On a phone the same job is
 * spread over a list screen and a full-screen page editor, because 375 px
 * cannot hold both; here the list is a 220 px rail on the left, the page is as
 * large as the window allows, and the four corrections sit under it — so
 * "which page am I on" and "what is wrong with it" are answered at the same
 * time, which is the whole difference between checking twelve pages and
 * dreading it.
 *
 * Two rules from the phone survive unchanged and are load-bearing:
 *
 *  * **Every claim is read off the render, not off the request.** "endireitada"
 *    means `rendered.warped` came back true, "bordas não encontradas" means it
 *    came back false. The `endireitar` tile is therefore a *status*, not a
 *    button: there is nothing to press, because the app already tried.
 *  * **Nothing is deleted silently.** The `apagar` pill and the ⌫ key go
 *    through the same confirm, and that confirm states the consequence — how
 *    many pages the PDF is left with — because a page removed from a document
 *    the user has not seen assembled yet is otherwise unrecoverable and
 *    invisible.
 */
export function ConferirStep({
  tiles,
  current,
  adjusted,
  onAdjusted,
  onSelect,
  onAddFiles,
  onContinue,
}: {
  tiles: readonly PageTile[];
  current: PageTile | null;
  adjusted: ReadonlySet<string>;
  onAdjusted: (pageId: string) => void;
  onSelect: (pageId: string) => void;
  onAddFiles: () => void;
  onContinue: () => void;
}) {
  const copy = useCopy();
  const store = useStore();
  const [mode, setMode] = React.useState<Mode>("none");
  const [confirming, setConfirming] = React.useState(false);
  /** The editor's own readiness, so its confirm cannot be a no-op button. */
  const [cornerPhase, setCornerPhase] = React.useState<CornerPhase>("loading");
  const editorRef = React.useRef<DesktopCornerEditorHandle>(null);

  const index = current === null ? -1 : tiles.indexOf(current);
  const pageCount = tiles.length;
  const readyCount = tiles.filter(
    (tile) => tile.page.status === "ready" && !isBlocking(tile),
  ).length;
  const blocked = tiles.some(isBlocking) || tiles.some((tile) => tile.stage === "processing");

  // A correction panel belongs to the page that opened it; moving to another
  // page closes it rather than silently retargeting it.
  React.useEffect(() => {
    setMode("none");
  }, [current?.pageId]);

  const step = React.useCallback(
    (delta: -1 | 1) => {
      if (pageCount === 0) return;
      const next = tiles[(index + delta + pageCount) % pageCount];
      if (next !== undefined) onSelect(next.pageId);
    },
    [index, onSelect, pageCount, tiles],
  );

  const rotate = React.useCallback(() => {
    if (current !== null) store.rotatePage(current.pageId, "cw");
  }, [current, store]);

  const toggleCantos = React.useCallback(() => {
    // Back to "loading" on every open: the editor remounts per page, and a
    // phase left over from the last one would enable its confirm before the
    // new page has finished decoding.
    setCornerPhase("loading");
    setMode((now) => (now === "cantos" ? "none" : "cantos"));
  }, []);

  useStepKeys({
    active: !confirming && mode !== "cantos",
    onPrevious: () => step(-1),
    onNext: () => step(1),
    onRotate: rotate,
    onCorners: toggleCantos,
    onDelete: () => setConfirming(true),
    // C has to reach the corner editor to close it again, so it is the one key
    // that stays live while the editor is mounted — but not *through* the
    // delete dialog, which is modal: closing the editor behind a modal leaves
    // the user answering a question about a screen that is no longer there.
    onCornersAlways: mode === "cantos" && !confirming ? toggleCantos : null,
  });

  if (current === null) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center px-8">
        <p className="max-w-[420px] text-center text-base leading-snug text-desk-muted">
          {copy.desktop.conferir.empty}
        </p>
      </main>
    );
  }

  const page = current.page;
  const finish: PageFinish = page.rendered?.finish ?? page.finish;
  const noEdges = current.needsCorners || page.corners === null;
  const failed = isBlocking(current);
  const working = current.stage === "processing";

  return (
    <main className="flex min-h-0 flex-1 justify-center overflow-hidden">
      <div className="flex min-h-0 w-[min(1120px,100%)] border-x border-border bg-paper">
        <PageRail
          tiles={tiles}
          current={current}
          adjusted={adjusted}
          readyCount={readyCount}
          onSelect={onSelect}
          onAddFiles={onAddFiles}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-11 flex-none items-center gap-2 border-b border-border px-[clamp(12px,1.6vw,20px)]">
            <span
              aria-hidden="true"
              className={clsx(
                "flex h-4 w-4 flex-none items-center justify-center rounded-full",
                noEdges || failed
                  ? "bg-peach/20 text-desk-warn"
                  : "bg-mint text-pine",
              )}
            >
              {noEdges || failed ? "!" : <CheckIcon size={10} />}
            </span>
            <p
              className={clsx(
                "min-w-0 flex-1 truncate text-xs leading-none",
                noEdges || failed ? "text-desk-warn" : "text-desk-muted",
              )}
            >
              {statusSentence(current, finish, copy)}
            </p>
            <Meta size="xs" tone="deskFaint" className="flex-none">
              {copy.common.pageOfTotal(current.humanNumber, pageCount)}
            </Meta>
            {/* `peach-ink` rather than the desktop's warn ink: this pill fills
                with `peach-bg` on hover, where #A5613A computes 4.49:1 — just
                under AA for text this small. */}
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex h-8 flex-none items-center gap-1.5 rounded-full border border-desk-warnline px-3 text-[0.71875rem] leading-none text-peach-ink transition-colors duration-200 hover:bg-peach-bg"
            >
              <TrashIcon size={13} />
              {copy.desktop.conferir.remove}
            </button>
          </div>

          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-desk-canvas p-[clamp(14px,2.4vh,28px)]">
            {mode === "cantos" ? (
              <DesktopCornerEditor
                ref={editorRef}
                tile={current}
                onPhase={setCornerPhase}
                onApplied={() => {
                  onAdjusted(current.pageId);
                  setMode("none");
                }}
              />
            ) : (
              <PageSheet tile={current} />
            )}
          </div>

          <div className="flex flex-none justify-center px-[clamp(12px,1.6vw,20px)] pt-3">
            <div className="flex w-[min(560px,100%)] gap-2">
              <Tile
                icon={<RotateIcon size={16} />}
                label={copy.desktop.conferir.tiles.rotate(page.rotation)}
                onClick={rotate}
              />
              <Tile
                icon={<CropIcon size={16} />}
                label={copy.desktop.conferir.tiles.corners}
                tone={mode === "cantos" ? "active" : noEdges ? "warn" : "neutral"}
                pressed={mode === "cantos"}
                onClick={toggleCantos}
              />
              {/* No `onClick`, by design: the app already tried to flatten this
                  page, and this square says whether it worked. Offering a
                  button would imply a retry that does not exist. */}
              <Tile
                icon={
                  page.rendered?.warped === true ? (
                    <CheckIcon size={16} />
                  ) : (
                    <WaveIcon size={16} />
                  )
                }
                label={
                  page.rendered?.warped === true
                    ? copy.desktop.conferir.tiles.straightened
                    : copy.desktop.conferir.tiles.straighten
                }
                tone={page.rendered?.warped === true ? "applied" : "neutral"}
                // The same condition the status line and the `cantos` tile
                // read: a page whose quad the app never trusted is a page this
                // square has nothing to say about, and the three of them warn
                // together or the row contradicts itself.
                dimmed={noEdges}
              />
              <Tile
                icon={<ContrastIcon size={16} />}
                label={copy.desktop.conferir.tiles.finish(
                  copy.desktop.conferir.finishShort[finish],
                )}
                tone={mode === "acabamento" ? "active" : "neutral"}
                pressed={mode === "acabamento"}
                onClick={() =>
                  setMode((now) => (now === "acabamento" ? "none" : "acabamento"))
                }
              />
            </div>
          </div>

          {mode === "cantos" && (
            <div className="flex flex-none justify-center px-[clamp(12px,1.6vw,20px)] pt-2.5">
              <div className="flex w-[min(560px,100%)] flex-wrap items-center gap-3 rounded-[14px] border border-border bg-warm px-3.5 py-3">
                {/* The instruction takes the whole first line and the actions
                    the second. With three controls in the card the old single
                    row no longer fits 560px — and 560 is not negotiable, it is
                    the width of the four correction tiles this card sits under.
                    Wrapping *within* the row dropped the primary onto a line of
                    its own, below the cancel, which reads as the wrong button
                    being the last word. */}
                <span className="w-full text-xs leading-snug text-desk-body">
                  {copy.desktop.conferir.cantos.instruction}
                </span>
                {/* The escape hatch, and deliberately the quietest control in
                    the card — underlined text, no border, no fill. It is right
                    for a picture that is already cropped and wrong the rest of
                    the time, so it must never compete with "usar estes cantos".
                    `copy.confirm.*` rather than a desktop twin of the same
                    sentence: it is the same offer the phone makes on
                    `ConfirmCornersScreen`, and two copies of one string drift.
                    Live even when the editor could not load — that state has no
                    other way forward — and only withdrawn while a commit runs. */}
                <button
                  type="button"
                  disabled={cornerPhase === "working"}
                  onClick={() => editorRef.current?.useWholePhoto()}
                  className="ml-auto inline-flex h-10 items-center px-1 text-xs text-desk-muted underline decoration-desk-edge underline-offset-4 transition-colors duration-200 hover:text-leaf hover:decoration-leaf disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copy.confirm.wholeCta}
                </button>
                <button
                  type="button"
                  onClick={() => setMode("none")}
                  className="inline-flex h-10 items-center rounded-[10px] border-[1.5px] border-desk-edge px-3.5 text-xs font-semibold text-leaf transition-colors duration-200 hover:border-leaf"
                >
                  {copy.desktop.conferir.cantos.cancel}
                </button>
                {/* Inert until the editor is actually up: while the page is
                    still decoding — or after scanic failed to load at all —
                    `confirm()` reaches nothing, and a button that swallows the
                    click reads as the app ignoring the user. */}
                <button
                  type="button"
                  disabled={cornerPhase !== "ready"}
                  onClick={() => editorRef.current?.confirm()}
                  className="inline-flex h-10 items-center rounded-[10px] bg-deep px-4 text-xs font-bold text-paper transition-colors duration-200 hover:bg-leaf disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-deep"
                >
                  {copy.desktop.conferir.cantos.confirm}
                </button>
              </div>
            </div>
          )}

          {mode === "acabamento" && (
            <FinishPanel
              finish={finish}
              onPick={(next) => store.setPageFinish(current.pageId, next)}
              onClose={() => setMode("none")}
            />
          )}

          <div className="flex flex-none flex-wrap items-center justify-between gap-3.5 px-[clamp(12px,1.6vw,20px)] pb-3.5 pt-3">
            <div className="flex items-center gap-2">
              <ArrowButton
                label={copy.desktop.conferir.previous}
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon size={18} />
              </ArrowButton>
              <span className="font-mono text-2xs leading-none text-desk-muted">
                {copy.common.pageOfTotal(current.humanNumber, pageCount)}
              </span>
              <ArrowButton label={copy.desktop.conferir.next} onClick={() => step(1)}>
                <ChevronRightIcon size={18} />
              </ArrowButton>
            </div>
            <Meta size="2xs" tone="deskFaint">
              {copy.desktop.conferir.shortcuts}
            </Meta>
            <button
              type="button"
              disabled={blocked}
              onClick={onContinue}
              className={clsx(
                "ml-auto inline-flex h-[46px] items-center gap-2.5 rounded-xl px-5",
                "text-sm font-bold text-paper transition-colors duration-200",
                blocked ? "cursor-not-allowed bg-deep opacity-40" : "bg-deep hover:bg-leaf",
              )}
            >
              {copy.desktop.conferir.goGerar}
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>
      </div>

      {confirming && (
        <RemoveDialog
          humanNumber={current.humanNumber}
          remaining={pageCount - 1}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            store.removePage(current.pageId);
          }}
        />
      )}

      {/* Mounted always, with only its *text* switching. A live region that
          appears together with its first message is announced by only some
          screen readers — the rest need the region to have been on the page
          before the text landed in it. */}
      <span className="scan-sr-only" role="status">
        {working ? copy.desktop.conferir.status.processing : ""}
      </span>
    </main>
  );
}

type Mode = "none" | "cantos" | "acabamento";

/** What {@link DesktopCornerEditor} reports about itself. */
type CornerPhase = "loading" | "ready" | "working" | "unavailable";

/** The one sentence the status bar is allowed to say about this page. */
function statusSentence(
  tile: PageTile,
  finish: PageFinish,
  copy: AppCopy,
): string {
  const status = copy.desktop.conferir.status;
  if (isBlocking(tile)) return status.failed;
  if (tile.stage === "processing") return status.processing;
  if (tile.needsCorners || tile.page.corners === null) return status.noEdges;
  if (finish === "clean") return status.readyClean;
  return status.ready(copy.finish.labels[finish]);
}

/** The rail's own mono line, one state per row. */
function rowLine(
  tile: PageTile,
  adjusted: boolean,
  copy: AppCopy,
): { text: string; warn: boolean } {
  const row = copy.desktop.conferir.row;
  if (isBlocking(tile)) return { text: row.failed, warn: true };
  if (tile.stage === "processing") return { text: row.processing, warn: false };
  if (tile.needsCorners || tile.page.corners === null) {
    return { text: row.noEdges, warn: true };
  }
  if (adjusted) return { text: row.cornersAdjusted, warn: false };
  const finish = tile.page.rendered?.finish ?? tile.page.finish;
  return {
    text: row.straightened(copy.desktop.conferir.finishShort[finish]),
    warn: false,
  };
}

// ── the rail ─────────────────────────────────────────────────────────────────

/**
 * The page list, and the one place the document's order can be changed.
 *
 * Drag-to-reorder is pointer-driven rather than HTML5 drag-and-drop: the native
 * API cannot show a live insertion point without a drag image nobody can style,
 * and this list is 220 px wide with a real thumbnail in every row. A drag only
 * begins after the pointer has actually moved ({@link DRAG_THRESHOLD}), so a
 * click is still a click — the rows are the navigation as well as the ordering.
 */
function PageRail({
  tiles,
  current,
  adjusted,
  readyCount,
  onSelect,
  onAddFiles,
}: {
  tiles: readonly PageTile[];
  current: PageTile;
  adjusted: ReadonlySet<string>;
  readyCount: number;
  onSelect: (pageId: string) => void;
  onAddFiles: () => void;
}) {
  const copy = useCopy();
  const store = useStore();
  const listRef = React.useRef<HTMLUListElement | null>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);

  const handleMove = React.useCallback(
    (event: React.PointerEvent<HTMLLIElement>) => {
      setDrag((now) => {
        if (now === null) return now;
        const moved =
          now.moved || Math.abs(event.clientY - now.startY) > DRAG_THRESHOLD;
        if (!moved) return now;
        const list = listRef.current;
        if (list === null) return { ...now, moved };
        const rows = Array.from(
          list.querySelectorAll<HTMLElement>("[data-page-row]"),
        );
        let target = rows.length - 1;
        for (let position = 0; position < rows.length; position += 1) {
          const box = rows[position].getBoundingClientRect();
          if (event.clientY < box.top + box.height / 2) {
            target = position;
            break;
          }
        }
        return now.to === target && now.moved === moved
          ? now
          : { ...now, moved, to: target };
      });
    },
    [],
  );

  const handleUp = React.useCallback(() => {
    setDrag((now) => {
      if (now !== null && now.moved && now.to !== now.from) {
        store.movePageTo(now.pageId, now.to);
      }
      return null;
    });
  }, [store]);

  return (
    <aside className="flex min-h-0 w-[220px] flex-none flex-col border-r border-border bg-warm">
      <div className="flex flex-col gap-1 px-4 pb-2.5 pt-4">
        <span className="font-display text-lg font-semibold text-ink">
          {copy.desktop.conferir.railTitle}
        </span>
        <Meta size="xs">
          {copy.desktop.conferir.railSummary(tiles.length, readyCount)}
        </Meta>
      </div>

      <ul
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto px-2.5 pb-2.5"
      >
        {tiles.map((tile, position) => {
          const selected = tile.pageId === current.pageId;
          const line = rowLine(tile, adjusted.has(tile.pageId), copy);
          const dropping = drag !== null && drag.moved && drag.to === position;
          return (
            <li
              key={tile.key}
              data-page-row
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                setDrag({
                  pageId: tile.pageId,
                  from: position,
                  to: position,
                  startY: event.clientY,
                  moved: false,
                });
              }}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
              className={clsx(
                "rounded-xl border-[1.5px] transition-colors duration-150",
                selected ? "border-mint-line bg-mint" : "border-transparent",
                dropping && !selected && "border-mist",
                drag !== null && drag.moved && drag.pageId === tile.pageId && "opacity-50",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(tile.pageId)}
                onKeyDown={(event) => {
                  // The order of a document is not a mouse-only fact. The
                  // phone moves a page with two arrow buttons; there is no
                  // room for those in a 220 px row, so the same ±1 move is on
                  // Alt+↑/↓ — a chord the step-2 shortcuts deliberately ignore
                  // (they bail on any modifier), so nothing else claims it.
                  if (!event.altKey || event.metaKey || event.ctrlKey) return;
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  store.movePage(tile.pageId, event.key === "ArrowUp" ? -1 : 1);
                }}
                aria-current={selected ? "true" : undefined}
                className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
              >
                <Meta size="xs" className="w-4 shrink-0">
                  {String(position + 1).padStart(2, "0")}
                </Meta>
                <RailThumb tile={tile} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-xs font-semibold text-ink">
                    {copy.common.page(tile.humanNumber)}
                  </span>
                  {/* Two lines rather than an ellipsis: the rail is 220 px and
                      "endireitada · preto e branco" does not fit on one, and a
                      status cut to "endireitada …" says less than nothing. */}
                  <span
                    className={clsx(
                      "line-clamp-2 break-words font-mono text-5xs leading-tight",
                      line.warn ? "text-desk-warn" : "text-pine",
                    )}
                  >
                    {line.text}
                  </span>
                </span>
                <GripIcon size={15} className="shrink-0 text-desk-grip" />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-none flex-col gap-2 border-t border-desk-hair px-3.5 py-3">
        <button
          type="button"
          onClick={onAddFiles}
          className="inline-flex h-[42px] items-center justify-center gap-2 rounded-[11px] border-[1.5px] border-desk-edge text-xs font-semibold text-leaf transition-colors duration-200 hover:border-leaf"
        >
          <PlusIcon size={15} />
          {copy.desktop.conferir.addFiles}
        </button>
        <Meta size="2xs" tone="deskFaint" className="text-center">
          {copy.desktop.conferir.dragHint}
        </Meta>
      </div>
    </aside>
  );
}

interface Drag {
  pageId: string;
  from: number;
  to: number;
  startY: number;
  moved: boolean;
}

/** Below this a pointer press is a click, not a drag. */
const DRAG_THRESHOLD = 4;

function RailThumb({ tile }: { tile: PageTile }) {
  const url = useBlobUrl(tile.page.thumb);
  return (
    <span className="flex h-12 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[3px] border border-border bg-warm">
      {url === null ? (
        <SpinnerIcon size={14} className="text-mist" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full object-cover" />
      )}
    </span>
  );
}

// ── the viewer ───────────────────────────────────────────────────────────────

/**
 * The page, as large as the pane allows, turning the way the phone turns it.
 *
 * The bytes are the page's `final` — the very stream the PDF will embed — so
 * what is being judged here is the artifact and not a rendering of it. The turn
 * animates because the render that bakes it takes a moment to arrive: without
 * it the picture would sit still after the click and then jump.
 *
 * It used to animate with a `transition-transform` class on the `<img>`, and
 * that is what made it *bounce*: a CSS transition on the transform cannot tell
 * the turn the user asked for from the hand-over that follows it, so when the
 * render landed and the degrees moved from the transform into the pixels, the
 * page played that hand-over as a second quarter turn — backwards, and a beat
 * late. The turn is {@link usePageTurn}'s now, exactly as on
 * the phone: one implementation, so the rule cannot hold on one screen and not
 * the other. Nothing else may write this element's transform, which is why the
 * scale left the inline style with it.
 */
function PageSheet({ tile }: { tile: PageTile }) {
  const copy = useCopy();
  // The picture and its turn as one value: the two used to be read separately,
  // and the hand-over dropped the turn several frames before the `<img>` had
  // decoded the new bytes — the page flicked back to its pre-turn orientation
  // and then popped upright (`lib/page-view.ts`).
  const view = usePageView(tile.page.final, displayRotation(tile.page));
  const url = view.url;
  const rotation: PageRotation = view.rotation;
  const { frameRef, imageRef, scale, scaleFor, fit, handleImageLoad } =
    useRotatedFit(rotation, "contain");
  usePageTurn({
    element: imageRef,
    rotation,
    handover: view.handover,
    scale,
    scaleFor,
    ready: url !== null,
    pageId: tile.pageId,
  });

  return (
    <div ref={frameRef} className="flex h-full w-full items-center justify-center">
      {url === null ? (
        <span className="flex flex-col items-center gap-2">
          <SpinnerIcon size={26} className="text-mist" />
          <span className="font-mono text-2xs leading-none text-mist">
            {copy.common.loadingPage}
          </span>
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imageRef}
          src={url}
          alt={copy.common.page(tile.humanNumber)}
          onLoad={handleImageLoad}
          style={{ objectFit: fit }}
          className="max-h-full max-w-full rounded-[3px] shadow-[0_18px_40px_-24px_rgba(15,18,13,.7)]"
        />
      )}
    </div>
  );
}

// ── the corrections ──────────────────────────────────────────────────────────

type TileTone = "neutral" | "active" | "warn" | "applied";

const TILE_TONES: Record<TileTone, string> = {
  neutral: "border-border bg-warm text-ink",
  active: "border-leaf bg-mint text-deep",
  warn: "border-peach bg-peach-bg text-desk-warn",
  applied: "border-moss bg-mint text-leaf",
};

/** One of the four squares. A tile with no `onClick` is a status, not a control. */
function Tile({
  icon,
  label,
  tone = "neutral",
  dimmed = false,
  pressed,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  tone?: TileTone;
  dimmed?: boolean;
  /**
   * For the two that open a panel. Their state is carried by a border colour
   * and nothing else, which is a state a screen reader cannot see at all.
   */
  pressed?: boolean;
  onClick?: () => void;
}) {
  const body = (
    <>
      {icon}
      <span className="whitespace-nowrap font-mono text-4xs leading-none">
        {label}
      </span>
    </>
  );
  const shape = clsx(
    "flex h-[62px] flex-1 flex-col items-center justify-center gap-1 rounded-[14px] border-[1.5px]",
    TILE_TONES[tone],
    dimmed && "opacity-40",
  );

  if (onClick === undefined) {
    return (
      <span className={shape} aria-disabled={dimmed || undefined}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={clsx(shape, "transition-colors duration-200 hover:border-leaf")}
    >
      {body}
    </button>
  );
}

const FINISHES: readonly PageFinish[] = ["original", "clean", "bw"];

/** The swatch each finish is drawn as — an impression of the paper, not a preview. */
const SWATCHES: Record<PageFinish, string> = {
  original: "bg-[linear-gradient(155deg,#e8e2d0,#d6cfba)]",
  clean: "bg-[#fdfdfa]",
  bw: "bg-white",
};

/** "Acabamento da folha", inline — the choice applies the moment it is made. */
function FinishPanel({
  finish,
  onPick,
  onClose,
}: {
  finish: PageFinish;
  onPick: (finish: PageFinish) => void;
  onClose: () => void;
}) {
  const copy = useCopy();
  return (
    <div className="flex flex-none justify-center px-[clamp(12px,1.6vw,20px)] pt-2.5">
      <div className="flex w-[min(560px,100%)] flex-col gap-3 rounded-2xl border border-border bg-warm p-3.5">
        <div className="flex items-center justify-between gap-2.5">
          <span className="font-display text-base font-semibold text-ink">
            {copy.desktop.conferir.acabamento.title}
          </span>
          <button
            type="button"
            aria-label={copy.desktop.conferir.acabamento.close}
            onClick={onClose}
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-full border border-border text-desk-muted transition-colors duration-200 hover:border-leaf"
          >
            <XIcon size={15} />
          </button>
        </div>
        {/* A named group, not a bare one: three swatch buttons announced with
            no heading between them are three unexplained pictures. */}
        <div
          role="group"
          aria-label={copy.desktop.conferir.acabamento.title}
          className="flex gap-2.5"
        >
          {FINISHES.map((option) => {
            const selected = option === finish;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={selected}
                onClick={() => onPick(option)}
                className="flex flex-1 flex-col items-center gap-2"
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    "h-[58px] w-full rounded-lg",
                    SWATCHES[option],
                    selected ? "border-2 border-leaf" : "border border-border",
                  )}
                />
                <span
                  className={clsx(
                    "text-center text-[0.71875rem] leading-tight",
                    selected ? "font-bold text-deep" : "font-medium text-ink-3",
                  )}
                >
                  {copy.finish.labels[option]}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-xs leading-relaxed text-ink-3">
          {copy.desktop.conferir.acabamento.notes[finish]}
        </p>
      </div>
    </div>
  );
}

function ArrowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] border border-border bg-warm text-ink transition-colors duration-200 hover:border-leaf"
    >
      {children}
    </button>
  );
}

// ── deleting ─────────────────────────────────────────────────────────────────

/**
 * The confirm — and it states the consequence rather than asking twice.
 *
 * "Tem certeza?" tells the user nothing they did not already know. "O PDF fica
 * com 4 páginas" is the fact they are actually deciding about, and it is the
 * only reason this dialog is worth the interruption.
 */
function RemoveDialog({
  humanNumber,
  remaining,
  onCancel,
  onConfirm,
}: {
  humanNumber: number;
  remaining: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = useCopy();
  const containerRef = useDialogChrome<HTMLDivElement>(onCancel);
  const dialog = copy.desktop.conferir.removeDialog;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={dialog.title(humanNumber)}
      className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain"
    >
      <div aria-hidden="true" onClick={onCancel} className="absolute inset-0 bg-deep/40" />
      <div className="relative flex w-[min(400px,calc(100%-2rem))] flex-col gap-3 rounded-2xl border border-border bg-warm p-5">
        <h2 className="font-display text-2xl font-semibold text-ink">
          {dialog.title(humanNumber)}
        </h2>
        <p className="text-[0.90625rem] leading-snug text-desk-body">
          {dialog.body(remaining)}
        </p>
        <div className="flex gap-2.5 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-12 flex-1 items-center justify-center rounded-xl border-[1.5px] border-desk-edge text-sm font-semibold text-leaf transition-colors duration-200 hover:border-leaf"
          >
            {dialog.keep}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-peach-soft text-sm font-bold text-peach-ink transition-colors duration-200 hover:bg-peach"
          >
            <TrashIcon size={16} />
            {dialog.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── the keyboard ─────────────────────────────────────────────────────────────

/**
 * Step 2's four shortcuts, and nothing else in the app has any.
 *
 * Scoped to this step and switched off wherever a keystroke could mean
 * something else: while a dialog is open (it traps its own keys), while the
 * corner editor has the page (arrow keys nudge handles there), and whenever the
 * event came from a field. Modifier chords are left alone entirely — ⌘R is the
 * browser's, not ours.
 */
function useStepKeys({
  active,
  onPrevious,
  onNext,
  onRotate,
  onCorners,
  onDelete,
  onCornersAlways,
}: {
  active: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onRotate: () => void;
  onCorners: () => void;
  onDelete: () => void;
  /** `C` closes the corner editor too — the only key that survives it. */
  onCornersAlways: (() => void) | null;
}) {
  const handlers = React.useRef({
    onPrevious,
    onNext,
    onRotate,
    onCorners,
    onDelete,
    onCornersAlways,
  });
  handlers.current = {
    onPrevious,
    onNext,
    onRotate,
    onCorners,
    onDelete,
    onCornersAlways,
  };

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      const current = handlers.current;
      if (event.key.toLowerCase() === "c" && current.onCornersAlways !== null) {
        event.preventDefault();
        current.onCornersAlways();
        return;
      }
      if (!active) return;
      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          current.onPrevious();
          return;
        case "ArrowRight":
          event.preventDefault();
          current.onNext();
          return;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          current.onDelete();
          return;
        default:
          break;
      }
      const key = event.key.toLowerCase();
      if (key === "r") {
        event.preventDefault();
        current.onRotate();
      } else if (key === "c") {
        event.preventDefault();
        current.onCorners();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);
}

/** A keystroke that belongs to a field is not a shortcut. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
