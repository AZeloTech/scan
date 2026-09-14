"use client";

import * as React from "react";
import {
  createScanStore,
  type DewarpActivity,
  type PdfBuild,
  type ScanSession,
  type ScanState,
  type ScanStore,
  type ScanStoreOptions,
} from "@/lib/scan-store";
import { buildTiles, type PageTile } from "@/lib/page-tiles";
import { useCopy } from "@/components/I18n";

/**
 * The scan store, as React sees it.
 *
 * There is no module singleton any more. One `<ScanStoreProvider>` owns one
 * `createScanStore()` instance for as long as it is mounted and disposes it on
 * unmount — so a second mount of the flow starts from nothing, which is the
 * lifetime the privacy claim depends on.
 *
 * There is no `hydrated` flag either. The store holds the scan in memory and
 * nothing else (see `lib/scan-store.ts`), so its state is complete from the
 * first render — a screen that finds no session can act immediately instead of
 * waiting a tick for storage to answer.
 */
const ScanStoreContext = React.createContext<ScanStore | null>(null);

export interface ScanStoreProviderProps extends ScanStoreOptions {
  children: React.ReactNode;
}

/**
 * A store created by a render that has not committed yet.
 *
 * React may throw a render away before committing it: a sibling suspends inside
 * the same `<Suspense>` boundary, a lazy chunk resolves into a retry, an urgent
 * update interrupts a transition, React 18's StrictMode double render. A
 * render that is discarded runs no effect and no cleanup, so a store it created
 * is never disposed — and against the one-instance guard that orphan is a
 * "second scan store" warning (a throw in development) the moment the retry
 * creates the real one. That is exactly what a host lazily mounting the flow
 * inside its own `<Suspense>` saw.
 *
 * So the retry adopts the orphan instead of creating beside it. A store in this
 * slot has never been handed to a committed tree, so nothing has written to it:
 * reads during render are all a discarded render can do.
 */
let uncommitted: { store: ScanStore; key: string } | null = null;

/** Stores some provider has committed. A second committer builds its own. */
const committed = new WeakSet<ScanStore>();

/** What makes two creations interchangeable. The pipeline is a test-only seam. */
function optionsKey(options: ScanStoreOptions): string {
  return JSON.stringify([
    options.assets ?? null,
    options.maxBytes ?? null,
    options.maxPages ?? null,
    options.fileName ?? null,
  ]);
}

function createInRender(options: ScanStoreOptions): ScanStore {
  const key = optionsKey(options);
  if (uncommitted !== null) {
    const orphan = uncommitted;
    uncommitted = null;
    if (!orphan.store.disposed && orphan.key === key && options.pipeline === undefined) {
      uncommitted = orphan;
      return orphan.store;
    }
    // Built for another configuration by a render nobody will commit: give its
    // slot back before claiming a new one.
    orphan.store.dispose();
  }
  const store = createScanStore(options);
  uncommitted = { store, key };
  return store;
}

/**
 * Creates the store on mount, disposes it on unmount — StrictMode, Suspense
 * retries and interrupted renders included.
 *
 * **The ordering, which is the only hard part of this file.** React 18/19 in
 * development mount, unmount and mount again, and they also run the render body
 * twice; in every mode a render can be thrown away before it commits. Each of
 * the obvious placements breaks on one of those:
 *
 *  * `useState(createScanStore)` — StrictMode double-invokes the initialiser,
 *    so two stores are created and one of them is never disposed. Against the
 *    one-instance invariant that is not a leak, it is a throw.
 *  * Creating in the effect and keeping it in state — correct, but the first
 *    committed render then has no store and the flow is blank for a frame.
 *  * Creating in the effect and holding it in a ref — correct until the second
 *    mount, which finds the ref holding the store the first cleanup has just
 *    disposed. That is the bug this note exists for: the flow comes back
 *    visibly alive and silently inert.
 *
 * So the responsibilities are split. The **render body** creates the store,
 * through a ref, and a render that React discards and retries adopts the store
 * its discarded attempt created ({@link uncommitted}) instead of building a
 * second one — so there is exactly one live store per mount, which is what the
 * one-instance guard needs.
 *
 * The **effect** owns the lifetime. It marks the store committed, and its first
 * act is the abort guard: it asks whether the store it is holding was disposed
 * underneath it (the StrictMode remount — cleanup ran, then this effect ran
 * again on the same ref) or already belongs to another provider, and builds a
 * replacement and republishes it to the tree rather than hand the flow a dead
 * or shared instance.
 *
 * The cleanup disposes unconditionally, and it runs *before* the successor is
 * created, so two stores are never live at the same instant and the first
 * store's in-flight render is cancelled on the way out. That cancellation is
 * owner-scoped (`lib/render-remote.ts`), which is what keeps this ordering safe
 * in the other direction too: were the cleanup ever to run late, it still could
 * not reach into a job the successor owns.
 */
export function ScanStoreProvider({
  children,
  ...options
}: ScanStoreProviderProps): React.JSX.Element {
  const held = React.useRef<ScanStore | null>(null);
  const [, republish] = React.useReducer((count: number) => count + 1, 0);

  if (held.current === null || held.current.disposed) {
    held.current = createInRender(options);
  }
  const store = held.current;

  React.useEffect(() => {
    let current = held.current;
    if (current !== null && uncommitted?.store === current) uncommitted = null;
    if (current === null || current.disposed || committed.has(current)) {
      current = createScanStore(options);
      held.current = current;
      republish();
    }
    committed.add(current);
    const owned = current;
    return () => {
      owned.dispose();
    };
    // Mount/unmount only: re-creating the store because an option changed would
    // discard the user's pages, which no prop is allowed to do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return React.createElement(ScanStoreContext.Provider, { value: store }, children);
}

/** The store this part of the tree belongs to. Throws outside the provider. */
export function useStore(): ScanStore {
  const store = React.useContext(ScanStoreContext);
  if (store === null) {
    throw new Error(
      "@azelotech/scan: no scan store in context. Render this inside <ScanFlow>.",
    );
  }
  return store;
}

/** A slice of the store's state, subscribed the way `useSyncExternalStore` wants. */
function useStoreState<T>(select: (state: ScanState) => T): T {
  const store = useStore();
  return React.useSyncExternalStore(
    store.subscribe,
    () => select(store.getSnapshot()),
    () => select(store.getServerSnapshot()),
  );
}

export interface ScanStoreState {
  session: ScanSession | null;
  tiles: PageTile[];
  build: PdfBuild;
}

export function useScanStore(): ScanStoreState {
  const store = useStore();
  const state = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const copy = useCopy();

  // The tiles carry rendered words (the verdict chip, its longer sentence), so
  // the copy is an input: switching language has to re-derive them, not leave
  // yesterday's chip on today's page.
  const tiles = React.useMemo(
    () => buildTiles(state.session, copy),
    [state.session, copy],
  );

  return {
    session: state.session,
    tiles,
    build: state.build,
  };
}

/**
 * Whether the curved-page correction has already been explained this session.
 *
 * Its own hook rather than a field off {@link useScanStore}: it is one boolean
 * the page view reads, and reading it here means no re-render on every page,
 * thumbnail and build tick the full snapshot carries. React's own bail-out on
 * an unchanged boolean does the rest.
 */
export function useDewarpConsented(): boolean {
  return useStoreState((state) => state.dewarpConsented);
}

/**
 * What the user called this document, or null while it is still unnamed.
 *
 * Its own hook rather than a field off {@link useScanStore}: the page editor's
 * header is the only reader, it needs one string, and subscribing to the whole
 * snapshot there would re-render the editor on every render tick, thumbnail and
 * build progress event the scan produces. The value is a plain string, so
 * React's own bail-out does the rest.
 */
export function useDocumentName(): string | null {
  return useStoreState((state) => state.session?.documentName ?? null);
}

/**
 * The correction running right now, or null.
 *
 * Identity-stable by construction: the store writes a new object only when a
 * phase or a byte count actually changed, so this can be compared by reference.
 */
export function useDewarpActivity(): DewarpActivity | null {
  return useStoreState((state) => state.dewarpActivity);
}

/**
 * A `Blob` as an object URL, revoked on change and on unmount.
 *
 * Every picture in the app is now a local blob (there is no authenticated fetch
 * left to make), so this is the only image plumbing there is — and the reason
 * the store keeps no URL registry of its own to revoke on dispose: the revoke
 * belongs with the component that made the URL, which is the only thing that
 * knows when the picture stopped being on screen.
 */
export function useBlobUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (blob === null || blob === undefined) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
    };
  }, [blob]);

  return url;
}
