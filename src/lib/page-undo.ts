/**
 * The page editor's delete, with an undo instead of a confirmation.
 *
 * The bin takes the page out of the document **at once** — as far as the user
 * can see. What actually happens is that the page is *held*: the editor stops
 * showing it and counts the document without it, while the store is not
 * touched at all. "Desfazer" lets go of the hold and the page is simply there
 * again, with every bit of its state — the canonical, the corners, the turn,
 * the finish, the straightening, a render that was still in flight, its gate
 * reading and its place in the order — because none of it ever went anywhere.
 * Restoring from a copy would have to know every field a page has, and the one
 * it forgot is the one the user notices.
 *
 * The removal becomes real (`commit`, which is the store's own `removePage`):
 *
 *  - when the toast has been up for {@link UNDO_MS} without being held;
 *  - when a second page is deleted while the first is still held — one undo at
 *    a time, and the older one is the one that has had its chance;
 *  - when the editor goes away for any reason (closed, Escape, the primary on
 *    the last page, off to retake or to the corner screen, the host unmounting
 *    it). The PDF is built from outside the editor, so a page held here can
 *    never reach a file.
 *
 * Pure bookkeeping with injectable timers, so the rules above are tested
 * without a DOM (`page-undo.test.ts`).
 */

/** How long the undo is offered. The toast is not dismissed while it is held (focused or hovered). */
export const UNDO_MS = 5_000;

export interface HeldPage {
  pageId: string;
  /** 1-based, as the user saw it when they deleted it. */
  humanNumber: number;
}

export interface PendingRemovalOptions {
  /** Makes the removal real — the store's `removePage`. */
  commit: (pageId: string) => void;
  /** Called whenever the held page changes (held, undone, committed). */
  onChange?: (held: HeldPage | null) => void;
  ms?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PendingRemoval {
  /** The page held out of the document, or `null`. */
  held(): HeldPage | null;
  /** Hold this page out; a page already held is committed first. */
  remove(page: HeldPage): void;
  /** Give the held page back. Returns it, or `null` when nothing was held. */
  undo(): HeldPage | null;
  /** Make the held removal real now. */
  commit(): void;
  /** While `true` the countdown is stopped; on `false` it starts over in full. */
  pause(paused: boolean): void;
  /** The editor is going away: whatever is held is removed for good. */
  dispose(): void;
}

export function createPendingRemoval(options: PendingRemovalOptions): PendingRemoval {
  const ms = options.ms ?? UNDO_MS;
  const setTimer =
    options.setTimer ?? ((callback: () => void, delay: number) => globalThis.setTimeout(callback, delay));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let current: HeldPage | null = null;
  let timer: unknown = null;
  let paused = false;
  let disposed = false;

  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const arm = () => {
    stop();
    if (current === null || paused || disposed) return;
    timer = setTimer(() => {
      timer = null;
      commit();
    }, ms);
  };
  const set = (next: HeldPage | null) => {
    current = next;
    options.onChange?.(next);
  };

  function commit(): void {
    stop();
    const page = current;
    if (page === null) return;
    // Cleared before the store hears about it, so a store listener that
    // reads `held()` never sees a page that is both held and gone.
    set(null);
    options.commit(page.pageId);
  }

  return {
    held: () => current,
    remove(page) {
      if (disposed) {
        options.commit(page.pageId);
        return;
      }
      commit();
      // A new toast starts unheld: the hold belonged to the old one's button.
      paused = false;
      set(page);
      arm();
    },
    undo() {
      stop();
      const page = current;
      if (page !== null) set(null);
      return page;
    },
    commit,
    pause(next) {
      paused = next;
      if (paused) stop();
      else arm();
    },
    dispose() {
      commit();
      disposed = true;
    },
  };
}

/**
 * The document as the editor shows it while a page is held: without it, and
 * renumbered, so "Página N de M", the picture's name and every sheet opened
 * from here count the pages the user can see.
 */
export function withoutHeld<T extends { pageId: string; humanNumber: number }>(
  tiles: readonly T[],
  heldId: string | null,
): readonly T[] {
  if (heldId === null || !tiles.some((tile) => tile.pageId === heldId)) return tiles;
  return tiles
    .filter((tile) => tile.pageId !== heldId)
    .map((tile, index) => (tile.humanNumber === index + 1 ? tile : { ...tile, humanNumber: index + 1 }));
}

/**
 * Where the editor lands after a delete: the page that slid into the deleted
 * one's place, or — when the last page went — the one before it. `null` when
 * nothing is left.
 */
export function landingAfterRemoval<T extends { pageId: string }>(
  tiles: readonly T[],
  removedId: string,
): string | null {
  const index = tiles.findIndex((tile) => tile.pageId === removedId);
  const rest = tiles.filter((tile) => tile.pageId !== removedId);
  if (rest.length === 0) return null;
  const at = index === -1 ? 0 : Math.min(index, rest.length - 1);
  return rest[at]?.pageId ?? null;
}
