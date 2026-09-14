"use client";

import * as React from "react";
import {
  stepPageView,
  type PageView,
  type PageViewChange,
} from "@/lib/page-view";
import type { PageRotation } from "@/lib/rotation";

/**
 * The picture the viewer should paint, and the turn it should wear — as one
 * value that never comes apart. See `lib/page-view.ts` for why they must not.
 *
 * This replaces `useBlobUrl(page.final) + displayRotation(page)` in the two
 * places a full-size page is shown (the phone's page editor and the desktop
 * viewer). Those two read the same store and had the same flick, from the same
 * cause, so they now ask the same question through the same seam rather than
 * each growing its own answer.
 */
export interface PageViewState {
  /** Point the `<img>` at this. `null` before the first picture can be shown. */
  readonly url: string | null;
  /** The CSS turn that picture still needs. */
  readonly rotation: PageRotation;
  /**
   * Bumped once per hand-over — the commit where the render caught up and new
   * bytes replaced the old ones.
   *
   * Watching it is the only way a viewer can tell that commit (which changes
   * nothing on screen, and so must be *placed*) apart from a turn the user
   * actually asked for (which must be animated). Watching the angle cannot do
   * it: a hand-over usually lands on the same angle a turn is leaving.
   */
  readonly handover: number;
}

/**
 * Decodes `url` far enough that painting it will not cost a frame.
 *
 * `decode()` is the whole point — an `<img>` handed a fresh object URL keeps
 * showing the previous bitmap until this resolves, and that gap is where the
 * flick lived. The fallback is for engines without it; a decode that fails
 * resolves anyway, because refusing to hand over on a broken picture would
 * strand the viewer on bytes the store has already replaced.
 */
async function decodeUrl(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  if (typeof image.decode === "function") {
    try {
      await image.decode();
    } catch {
      // A picture that cannot be decoded is still the picture the store means.
    }
    return;
  }
  await new Promise<void>((resolve) => {
    image.onload = () => {
      resolve();
    };
    image.onerror = () => {
      resolve();
    };
  });
}

interface Pending {
  /** The bytes this URL was made from, for identity rather than for reading. */
  readonly blob: Blob | null;
  readonly url: string | null;
  readonly decoded: boolean;
}

const NOTHING_PENDING: Pending = { blob: null, url: null, decoded: true };

export function usePageView(
  blob: Blob | null | undefined,
  rotation: PageRotation,
): PageViewState {
  const [pending, setPending] = React.useState<Pending>(NOTHING_PENDING);

  /**
   * What is on screen right now.
   *
   * A ref written during render rather than state, and deliberately: the value
   * is a pure function of the props and of `pending`, and putting it in state
   * would cost a re-render on every turn — a frame of lag on the one animation
   * in this app that exists to make a tap feel instant. (The same pattern the
   * components around it already use for `rotationRef`/`bakedRef`.)
   */
  const shownRef = React.useRef<PageView>({ url: null, rotation });
  const handoverRef = React.useRef(0);
  /** Retired one commit behind, so it is never revoked while still painted. */
  const retiredRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const target = blob ?? null;
    if (target === null) {
      setPending(NOTHING_PENDING);
      return;
    }
    let cancelled = false;
    const url = URL.createObjectURL(target);
    setPending({ blob: target, url, decoded: false });
    void decodeUrl(url).then(() => {
      if (cancelled) return;
      setPending((current) =>
        current.url === url ? { ...current, decoded: true } : current,
      );
    });
    return () => {
      cancelled = true;
      // Only if it never made it to the screen. Revoking the URL the viewer is
      // still painting — which is exactly what happens when a third revision
      // arrives while the second is decoding — blanks the page.
      if (shownRef.current.url !== url) URL.revokeObjectURL(url);
    };
  }, [blob]);

  const step = stepPageView(
    shownRef.current,
    { url: pending.url, rotation },
    pending.decoded,
  );
  const change: PageViewChange = step.change;
  if (change === "handover") {
    handoverRef.current += 1;
    retiredRef.current = shownRef.current.url;
  }
  shownRef.current = step.view;

  const shownUrl = step.view.url;
  React.useEffect(() => {
    const retired = retiredRef.current;
    if (retired === null || retired === shownUrl) return;
    retiredRef.current = null;
    URL.revokeObjectURL(retired);
  }, [shownUrl]);

  // The last picture goes with the component. Read through the ref rather than
  // closed over, so the cleanup releases whatever was showing at the end.
  React.useEffect(
    () => () => {
      const last = shownRef.current.url;
      if (last !== null) URL.revokeObjectURL(last);
    },
    [],
  );

  return {
    url: step.view.url,
    rotation: step.view.rotation,
    handover: handoverRef.current,
  };
}
