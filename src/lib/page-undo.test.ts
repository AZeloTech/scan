import assert from "node:assert/strict";
import test from "node:test";

import type { RenderRequest, RenderedPage } from "./page-processing.ts";
import type { NormalizedQuad } from "./quad.ts";
import {
  createPendingRemoval,
  landingAfterRemoval,
  UNDO_MS,
  withoutHeld,
  type HeldPage,
} from "./page-undo.ts";
import { createScanStore, type ScanPdfPage, type ScanPipeline, type ScanStore } from "./scan-store.ts";

// ── a hand-cranked clock ─────────────────────────────────────────────────────

class Clock {
  private next = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();
  now = 0;
  setTimer = (run: () => void, ms: number): unknown => {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, run });
    return id;
  };
  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.run();
      }
    }
  }
  get pending(): number {
    return this.timers.size;
  }
}

function controller(clock: Clock) {
  const committed: string[] = [];
  const changes: (HeldPage | null)[] = [];
  const removal = createPendingRemoval({
    commit: (id) => committed.push(id),
    onChange: (held) => changes.push(held),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { removal, committed, changes };
}

const P2: HeldPage = { pageId: "p2", humanNumber: 2 };
const P3: HeldPage = { pageId: "p3", humanNumber: 3 };

// ── the rules ────────────────────────────────────────────────────────────────

test("a delete is held for the undo window, then made real", () => {
  const clock = new Clock();
  const { removal, committed } = controller(clock);
  removal.remove(P2);
  assert.deepEqual(removal.held(), P2);
  clock.advance(UNDO_MS - 1);
  assert.deepEqual(committed, [], "nothing is removed while the undo is on offer");
  clock.advance(1);
  assert.deepEqual(committed, ["p2"]);
  assert.equal(removal.held(), null);
});

test("undo gives the page back and nothing is ever removed", () => {
  const clock = new Clock();
  const { removal, committed } = controller(clock);
  removal.remove(P2);
  assert.deepEqual(removal.undo(), P2);
  assert.equal(removal.held(), null);
  assert.equal(clock.pending, 0, "the countdown is gone with it");
  clock.advance(UNDO_MS * 3);
  removal.dispose();
  assert.deepEqual(committed, []);
  assert.equal(removal.undo(), null, "a second undo has nothing to give back");
});

test("leaving the editor commits what is held, at once", () => {
  const clock = new Clock();
  const { removal, committed } = controller(clock);
  removal.remove(P2);
  removal.dispose();
  assert.deepEqual(committed, ["p2"]);
  assert.equal(clock.pending, 0);
  // Anything after the editor is gone is not held for an undo nobody can see.
  removal.remove(P3);
  assert.deepEqual(committed, ["p2", "p3"]);
});

test("a second delete commits the first: one undo at a time", () => {
  const clock = new Clock();
  const { removal, committed } = controller(clock);
  removal.remove(P2);
  clock.advance(2_000);
  removal.remove(P3);
  assert.deepEqual(committed, ["p2"]);
  assert.deepEqual(removal.held(), P3);
  // The new one gets its whole window, not what was left of the old one's.
  clock.advance(UNDO_MS - 1);
  assert.deepEqual(committed, ["p2"]);
  clock.advance(1);
  assert.deepEqual(committed, ["p2", "p3"]);
});

test("a held toast (focused or hovered) is never dismissed; letting go starts the window over", () => {
  const clock = new Clock();
  const { removal, committed } = controller(clock);
  removal.remove(P2);
  clock.advance(4_000);
  removal.pause(true);
  clock.advance(60_000);
  assert.deepEqual(committed, []);
  removal.pause(false);
  clock.advance(UNDO_MS - 1);
  assert.deepEqual(committed, []);
  clock.advance(1);
  assert.deepEqual(committed, ["p2"]);
});

test("a hold left over from the last toast does not freeze the next one", () => {
  const clock = new Clock();
  const { removal, committed } = controller(clock);
  removal.remove(P2);
  removal.pause(true); // the Undo button took focus…
  removal.undo(); // …and was pressed; the button is gone without a blur.
  removal.remove(P3);
  clock.advance(UNDO_MS);
  assert.deepEqual(committed, ["p3"]);
});

test("the held page is cleared before the store hears about the commit", () => {
  const clock = new Clock();
  let seen: HeldPage | null | undefined;
  const removal = createPendingRemoval({
    commit: () => {
      seen = removal.held();
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  removal.remove(P2);
  removal.commit();
  assert.equal(seen, null);
});

// ── what the editor shows ────────────────────────────────────────────────────

const TILES = [
  { pageId: "p1", humanNumber: 1 },
  { pageId: "p2", humanNumber: 2 },
  { pageId: "p3", humanNumber: 3 },
];

test("the editor counts the document without the held page, renumbered", () => {
  assert.equal(withoutHeld(TILES, null), TILES);
  assert.deepEqual(withoutHeld(TILES, "p2"), [
    { pageId: "p1", humanNumber: 1 },
    { pageId: "p3", humanNumber: 2 },
  ]);
  // A held id the document no longer has (already committed) changes nothing.
  assert.equal(withoutHeld(TILES, "gone"), TILES);
});

test("after a delete the editor lands on the next page, or the one before the last", () => {
  assert.equal(landingAfterRemoval(TILES, "p1"), "p2");
  assert.equal(landingAfterRemoval(TILES, "p2"), "p3");
  assert.equal(landingAfterRemoval(TILES, "p3"), "p2");
  assert.equal(landingAfterRemoval([{ pageId: "p1" }], "p1"), null);
});

// ── against the real store ───────────────────────────────────────────────────

const QUAD: NormalizedQuad = {
  topLeft: { x: 0.05, y: 0.05 },
  topRight: { x: 0.95, y: 0.06 },
  bottomRight: { x: 0.94, y: 0.95 },
  bottomLeft: { x: 0.06, y: 0.94 },
};

/** Just enough pipeline for pages to settle and a file to be written. */
function pipeline(assembled: ScanPdfPage[][]): ScanPipeline {
  return {
    render: async (request: RenderRequest): Promise<RenderedPage> => ({
      final: new Blob([`final-${request.rotation}-${request.finish}`]),
      thumb: new Blob(["thumb"]),
      width: 1240,
      height: 1754,
      warpedWidth: 1240,
      warpedHeight: 1754,
      finish: request.finish,
      warped: request.corners !== null,
      dewarped: false,
      rotation: request.rotation,
    }),
    assemble: async (pages) => {
      assembled.push([...pages]);
      return {
        ok: true,
        blob: new Blob(["pdf"]),
        pageCount: pages.length,
        bytes: 1024,
        rung: 0,
        embedded: pages.map((page) => ({ width: 1240, height: 1754, bytes: page.jpeg.size })),
        quality: 0.92,
      };
    },
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function threePages(assembled: ScanPdfPage[][]): Promise<ScanStore> {
  const store = createScanStore({ pipeline: pipeline(assembled) });
  store.start();
  for (let index = 0; index < 3; index += 1) {
    store.addCapture({ canonical: new Blob([`frame-${index}`]), corners: QUAD, gate: null, path: "shutter" });
  }
  await settle();
  // Give the middle page state of its own: a turn and a finish.
  const middle = store.getSnapshot().session?.pages[1];
  assert.ok(middle !== undefined);
  store.rotatePage(middle.id, "cw");
  store.setPageFinish(middle.id, "bw");
  await settle();
  return store;
}

test("undo restores the page exactly: the store was never touched", async () => {
  const assembled: ScanPdfPage[][] = [];
  const store = await threePages(assembled);
  const before = store.getSnapshot();
  const middle = before.session?.pages[1];
  assert.ok(middle !== undefined);

  const clock = new Clock();
  const removal = createPendingRemoval({
    commit: (id) => store.removePage(id),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  removal.remove({ pageId: middle.id, humanNumber: 2 });
  clock.advance(UNDO_MS - 1);
  removal.undo();
  removal.dispose();

  const after = store.getSnapshot();
  // Not "equal after a restore" — the very same state object: the page, its
  // canonical, corners, turn, finish, rendered bytes and place in the order.
  assert.equal(after, before);
  assert.equal(after.session?.pages[1], middle);
  assert.equal(middle.rotation, 90);
  assert.equal(middle.finish, "bw");
  store.dispose();
});

test("a delete made real before the PDF is built is not in the PDF", async () => {
  const assembled: ScanPdfPage[][] = [];
  const store = await threePages(assembled);
  const pages = store.getSnapshot().session?.pages ?? [];
  const [first, middle, last] = pages;
  assert.ok(first !== undefined && middle !== undefined && last !== undefined);

  const clock = new Clock();
  const removal = createPendingRemoval({
    commit: (id) => store.removePage(id),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  removal.remove({ pageId: middle.id, humanNumber: 2 });
  // The user leaves the editor for the generate step while the toast is up.
  removal.dispose();
  await store.buildPdf();

  assert.equal(store.getSnapshot().build.phase, "done");
  assert.deepEqual(
    assembled[0]?.map((page) => page.jpeg),
    [first.final, last.final],
    "the file is the two pages left, in order",
  );
  store.dispose();
});
