"use client";

import * as React from "react";
import clsx from "clsx";
import {
  chosenFrom,
  DESKTOP_ACCEPT,
  folderLabel,
  orderForIntake,
  runIntake,
  type ChosenFile,
} from "@/lib/desktop-intake";
import type { Capture } from "@/lib/capture-intake";
import { isPdfFile } from "@/lib/pdf-import";
import type { AssetUrls } from "@/lib/runtime-config";
import type { ScanStore } from "@/lib/scan-store";
import { useScanStore, useStore } from "@/hooks/useScanStore";
import { useScanRuntime } from "@/hooks/useScanRuntime";
import { useCancelOnEscape } from "@/components/ui";
import type { PageTile } from "@/lib/page-tiles";
import { useCopy } from "@/components/I18n";
import { DesktopPicker, type DesktopPickerHandle } from "@/components/desktop/DesktopPicker";
import { EscolherStep } from "@/components/desktop/EscolherStep";
import { ConferirStep } from "@/components/desktop/ConferirStep";
import { GerarStep } from "@/components/desktop/GerarStep";

/**
 * The whole desktop mode — one route, three steps, no phone frame.
 *
 * It exists because the phone flow's first screen is built for a hand holding a
 * phone over a sheet of paper: the capture step opens a viewfinder, and at a desk
 * that is a dead end dressed as the product — with no camera it can never fill,
 * and with a webcam nobody is going to lift the machine over the page. What
 * such a machine has instead is a filesystem full of scans and e-mailed PDFs, a
 * mouse and a keyboard — so this is the same three-step contract (escolher →
 * conferir → gerar) rebuilt around those. `FlowScreens` decides once, at mount,
 * which of the two flows is on: a window that crosses a breakpoint mid-scan must
 * not swap the whole interface out from under the person using it.
 *
 * **One URL, three steps, on purpose.** The store is memory-only by design
 * (`scan-store.ts`) — a reload loses the scan wherever you are — so three
 * routes would buy nothing but three ways to land on an empty screen. The step
 * is component state; the trail in the header navigates it, gated the way the
 * mobile flow is gated (there is nothing to check and nothing to generate until
 * a page exists).
 *
 * It reuses the app's shell lock and nothing else of the phone's chrome: no
 * `AppFrame`, and above all no 30 rem column — the whole point of this mode is
 * a 1120 px workspace where the page is big enough to judge. Nothing in the
 * phone flow is touched from this tree.
 */
export function DesktopFlow() {
  const copy = useCopy();
  const store = useStore();
  const runtime = useScanRuntime();
  const { session, tiles, build } = useScanStore();
  const [step, setStep] = React.useState<Step>("escolher");
  const pickerRef = React.useRef<DesktopPickerHandle>(null);

  // Escape asks the host to close. Sheets inside the steps take it first.
  useCancelOnEscape();

  // Arriving IS beginning: there is no separate "começar" tap on a desk.
  React.useEffect(() => {
    if (session === null) store.start();
  }, [session, store]);

  const intake = useIntake(
    tiles,
    store,
    runtime.urls,
    runtime.maxPages,
    runtime.intake.pdf,
  );

  /** Which page the workspace is looking at. Null until step 2 first opens. */
  const [cursor, setCursor] = React.useState<string | null>(null);

  /**
   * The pages whose corners the user re-marked by hand.
   *
   * A view fact, not a page fact: the store records the quad, not who chose it,
   * and adding a "was this hand-drawn" field would be a second piece of state
   * every render, retake and reorder has to carry for one word in a 220 px rail.
   * It lives up here rather than in step 2 so that the word survives a trip to
   * step 3 and back, and it is dropped with the document like everything else.
   */
  const [adjusted, setAdjusted] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const noteAdjusted = React.useCallback((pageId: string) => {
    setAdjusted((current) => new Set(current).add(pageId));
  }, []);
  const found = tiles.findIndex((tile) => tile.pageId === cursor);
  /**
   * Where the cursor last actually was.
   *
   * Deleting the page under the cursor is the one moment its index cannot be
   * looked up any more — the id is gone from the list — and without this the
   * lookup answers `-1`, which clamps to the top and throws the user back to
   * page 1 from wherever they were working. Remembering the row means a delete
   * lands on the *neighbour*, which is where the eye already is.
   */
  const lastIndex = React.useRef(0);
  if (found >= 0) lastIndex.current = found;
  const neighbour = Math.min(lastIndex.current, tiles.length - 1);
  const current: PageTile | null = tiles[found >= 0 ? found : neighbour] ?? null;

  // The cursor follows the document rather than pinning to a page that is no
  // longer in it: deleting page 3 of 3 leaves the eye on the new last page.
  React.useEffect(() => {
    if (tiles.length === 0) {
      if (cursor !== null) setCursor(null);
      return;
    }
    if (found === -1) setCursor(current?.pageId ?? null);
  }, [tiles, cursor, found, current]);

  const pageCount = tiles.length;
  const building = build.phase === "working";
  const goto = React.useCallback(
    (next: Step) => {
      // A build reads the pages as it goes. Leaving step 3 while one is
      // running would let the user delete or turn a page underneath
      // `buildPdf()`, and the file would come out describing a document that
      // no longer exists.
      if (building) return;
      if (next !== "escolher" && pageCount === 0) return;
      setStep(next);
    },
    [building, pageCount],
  );

  /**
   * The only way out of step 3, and therefore the only way *into* the others.
   *
   * A finished build that the user walks away from is a stale file named for
   * pages they are about to change, so the build is reset on the way out. The
   * header trail
   * goes through here too rather than straight to {@link goto}: a trail that
   * bypassed it would leave the done card and its old blob sitting in step 3
   * while the user deleted the pages it was made of.
   */
  const leaveGerar = React.useCallback(
    (next: Step) => {
      if (build.phase === "done" || build.phase === "failed") store.resetBuild();
      goto(next);
    },
    [build.phase, goto, store],
  );

  return (
    <div className="app-h flex w-full flex-col overflow-hidden bg-desk-bg">
      <DesktopHeader
        step={step}
        pageCount={pageCount}
        locked={building}
        onStep={leaveGerar}
      />

      {step === "escolher" && (
        <EscolherStep
          tiles={tiles}
          intake={intake}
          onPick={() => pickerRef.current?.pickFiles()}
          onPickFolder={() => pickerRef.current?.pickFolder()}
          onContinue={() => goto("conferir")}
        />
      )}

      {step === "conferir" && (
        <ConferirStep
          tiles={tiles}
          current={current}
          adjusted={adjusted}
          onAdjusted={noteAdjusted}
          onSelect={setCursor}
          onAddFiles={() => pickerRef.current?.pickFiles()}
          onContinue={() => goto("gerar")}
        />
      )}

      {step === "gerar" && (
        <GerarStep
          session={session}
          tiles={tiles}
          build={build}
          onBack={() => leaveGerar("conferir")}
        />
      )}

      <DesktopPicker
        ref={pickerRef}
        onFiles={intake.accept}
        accept={acceptAttribute(runtime.intake.pdf)}
        label={copy.desktop.escolher.dropzoneLabel}
      />
    </div>
  );
}

export type Step = "escolher" | "conferir" | "gerar";

/**
 * What the file dialog offers, which is also what it must NOT offer.
 *
 * `intake.pdf` is off by default and costs about 4 MB of pdf.js when it is on,
 * so a host that left it off must not see a picker advertising PDFs — a dialog
 * that lists a file type and then refuses it is worse than one that never
 * listed it.
 */
function acceptAttribute(pdf: boolean): string {
  if (pdf) return DESKTOP_ACCEPT;
  return DESKTOP_ACCEPT.split(",")
    .filter((type) => type !== "application/pdf" && type !== ".pdf")
    .join(",");
}

const STEP_ORDER: readonly Step[] = ["escolher", "conferir", "gerar"];

/**
 * The only chrome the desktop mode has: the mark, the trail, and the promise.
 *
 * The promise is on the header rather than in a footer because on a computer
 * the question "where did my document just go" is asked *while* the files are
 * being read, not after — and a pulsing dot next to "processamento neste
 * computador" answers it in the corner of the eye, which is the only attention
 * it will get.
 */
function DesktopHeader({
  step,
  pageCount,
  locked,
  onStep,
}: {
  step: Step;
  pageCount: number;
  /** A build is running: the pages it is reading are not to be walked away from. */
  locked: boolean;
  onStep: (step: Step) => void;
}) {
  const copy = useCopy();
  const index = STEP_ORDER.indexOf(step);

  return (
    <header className="flex-none border-b border-border bg-warm">
      <div className="mx-auto flex h-16 max-w-[1160px] items-center gap-6 px-[clamp(16px,2vw,28px)]">
        <nav
          aria-label={copy.desktop.trailLabel}
          className="flex min-w-0 flex-1 justify-center"
        >
          <ol className="flex w-[min(440px,100%)] gap-2.5">
            {STEP_ORDER.map((entry, position) => {
              const reached = position <= index;
              // Going forward needs something to go forward *to*: the mobile
              // flow gates its "Continuar" the same way, and a trail that
              // navigates to an empty workspace is a trail that lies.
              const reachable = !locked && (position === 0 || pageCount > 0);
              return (
                <li key={entry} className="flex min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => onStep(entry)}
                    disabled={!reachable}
                    aria-current={position === index ? "step" : undefined}
                    className={clsx(
                      "flex w-full flex-col gap-1.5 text-left",
                      reachable ? "cursor-pointer" : "cursor-default",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={clsx(
                        "h-1 rounded-sm",
                        reached ? "bg-leaf" : "bg-frost",
                      )}
                    />
                    <span
                      className={clsx(
                        "truncate font-mono text-4xs leading-none",
                        position === index ? "text-leaf" : "text-ink-3",
                      )}
                    >
                      {copy.desktop.trail[position]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <span className="flex flex-none items-center gap-2 font-mono text-4xs uppercase leading-none tracking-[0.06em] text-ink-3">
          <span
            aria-hidden="true"
            className="h-[7px] w-[7px] rounded-full bg-mist motion-safe:animate-soft-pulse"
          />
          {copy.desktop.processing}
        </span>
      </div>
    </header>
  );
}

/** Everything the step-1 list and the step-2 rail need to know about intake. */
export interface IntakeState {
  files: readonly ChosenFile[];
  source: string | null;
  busy: boolean;
  /** How many rows have settled, for the "Abrindo 3 de 8…" line. */
  done: number;
  atCapacity: boolean;
  accept: (files: FileList | readonly File[] | null) => void;
  clear: () => void;
  /** The pages a chosen row became, so a row can show its own thumbnail. */
  tileFor: (file: ChosenFile) => PageTile | null;
}

/**
 * The pile of files, and how far into it we are.
 *
 * Kept here rather than in the store: a chosen file is not a page — it is the
 * *provenance* of one, useful for the twenty seconds step 1 is on screen and
 * meaningless afterwards. Putting it in the store would mean the document
 * carried a second list that has to be kept in step with the first one through
 * every delete and reorder, for a card that is gone by then.
 */
function useIntake(
  tiles: readonly PageTile[],
  store: ScanStore,
  assets: AssetUrls,
  maxPages: number,
  allowPdf: boolean,
): IntakeState {
  const [files, setFiles] = React.useState<readonly ChosenFile[]>([]);
  const [source, setSource] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [atCapacity, setAtCapacity] = React.useState(false);
  /** Bumped to abandon a run in flight — "limpar" and "escanear outro". */
  const runRef = React.useRef(0);
  const seedRef = React.useRef(0);
  /**
   * The tail of the queue, so two piles never decode at once.
   *
   * A drop of twenty photos takes a while, and the rail's "＋ Adicionar
   * arquivos" is right there during all of it. Two runners in flight would put
   * two full-resolution decode pipelines in memory at the same time — the one
   * budget this whole library is built around — and interleave the
   * two piles' pages in the document. Chaining costs the second pile nothing
   * but the wait it was going to have anyway.
   */
  const queueRef = React.useRef<Promise<void>>(Promise.resolve());
  /** How many piles are still queued or running, for the "Abrindo…" line. */
  const pendingRef = React.useRef(0);

  const patch = React.useCallback(
    (key: string, change: Partial<ChosenFile>) => {
      setFiles((current) =>
        current.map((file) => (file.key === key ? { ...file, ...change } : file)),
      );
    },
    [],
  );

  const accept = React.useCallback(
    (incoming: FileList | readonly File[] | null) => {
      const chosen = Array.from(incoming ?? []);
      // Dropped folders and drag-and-drop reach here without passing the
      // dialog's `accept`, so the refusal has to be here as well — this is the
      // line that guarantees pdf.js is never fetched when the host said no.
      const allowed = allowPdf ? chosen : chosen.filter((file) => !isPdfFile(file));
      const ordered = orderForIntake(allowed);
      if (ordered.length === 0) return;
      const label = folderLabel(ordered);
      const seed = (seedRef.current += 1);
      const rows = chosenFrom(ordered, seed);
      const generation = runRef.current;

      if (label !== null) setSource(label);
      setFiles((current) => [...current, ...rows]);
      setBusy(true);

      const items = rows.map((row, index) => ({
        key: row.key,
        file: ordered[index],
      }));

      pendingRef.current += 1;
      queueRef.current = queueRef.current
        .then(() =>
          runIntake(
            items,
            {
              capacity: () =>
                maxPages - (store.getSnapshot().session?.pages.length ?? 0),
              add: (capture: Capture) => {
                const before = store.getSnapshot().session?.pages.length ?? 0;
                store.addCapture(capture);
                const pages = store.getSnapshot().session?.pages ?? [];
                // The store refuses past its cap silently, so the page that
                // "arrived" has to be proven to exist before it is claimed.
                if (pages.length <= before) return null;
                return pages[pages.length - 1]?.id ?? null;
              },
              onStart: (key) => patch(key, { state: "opening" }),
              onSettled: (key, pageIds, error) =>
                patch(key, {
                  pageIds: [...pageIds],
                  error,
                  state:
                    error !== null
                      ? "refused"
                      : pageIds.length > 0
                        ? "added"
                        : "skipped",
                }),
              onCapacityHit: () => setAtCapacity(true),
              cancelled: () => runRef.current !== generation,
            },
            assets,
          ),
        )
        // The queue outlives any one pile: a runner that threw must not take
        // the piles behind it down with it.
        .catch(() => undefined)
        .finally(() => {
          pendingRef.current -= 1;
          if (pendingRef.current === 0) setBusy(false);
        });
    },
    [allowPdf, assets, maxPages, patch, store],
  );

  const clear = React.useCallback(() => {
    runRef.current += 1;
    setFiles([]);
    setSource(null);
    setBusy(false);
    setAtCapacity(false);
  }, []);

  const byId = React.useMemo(() => {
    const map = new Map<string, PageTile>();
    for (const tile of tiles) map.set(tile.pageId, tile);
    return map;
  }, [tiles]);

  const tileFor = React.useCallback(
    (file: ChosenFile) => {
      const first = file.pageIds[0];
      return first === undefined ? null : (byId.get(first) ?? null);
    },
    [byId],
  );

  const done = files.filter(
    (file) => file.state !== "waiting" && file.state !== "opening",
  ).length;

  return { files, source, busy, done, atCapacity, accept, clear, tileFor };
}
