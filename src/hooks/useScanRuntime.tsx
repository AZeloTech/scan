/**
 * What every screen needs to know about the world it is running in.
 *
 * An application can reach for module constants: it owns its own origin, its
 * own language preference and its own asset paths. A library owns
 * none of those — they arrive as props on one component and have to reach a
 * corner-adjustment sheet six levels down. This is that pipe.
 *
 * It is deliberately a plain value, not a store: none of it changes while the
 * flow is open. The one field that could — the language — is read from a prop
 * the host is free to change, and React re-renders the tree when it does.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { AssetUrls } from "@/lib/runtime-config";
import type { ScanErrorCode, ScanEvent, ScanLang } from "@/types";

export interface ScanRuntime {
  /** Every runtime file, already resolved against the host's base. */
  readonly urls: AssetUrls;
  readonly lang: ScanLang;
  readonly maxPages: number;
  /** A hard ceiling on the finished PDF, or null when the host set none. */
  readonly maxBytes: number | null;
  /**
   * The host's name for the finished file, verbatim, or null when the flow
   * composes its own. When set, no screen offers a way to name the document.
   */
  readonly fileName: string | null;
  readonly intake: {
    readonly camera: boolean;
    readonly images: boolean;
    readonly pdf: boolean;
  };
  /** Report something that happened. Numbers and enums only. */
  emit(event: ScanEvent): void;
  /**
   * Report something that went wrong.
   *
   * `recoverable` is the screen's judgement, not the code's: the same
   * `asset_load` is recoverable while the classical detector can carry the
   * session, and fatal if it was the PDF engine that failed to arrive. A
   * non-recoverable error ends the flow through the host's `onCancel`.
   */
  reportError(code: ScanErrorCode, recoverable: boolean): void;
}

const ScanRuntimeContext = createContext<ScanRuntime | null>(null);

export function ScanRuntimeProvider({
  value,
  children,
}: {
  value: ScanRuntime;
  children: ReactNode;
}) {
  return <ScanRuntimeContext.Provider value={value}>{children}</ScanRuntimeContext.Provider>;
}

export function useScanRuntime(): ScanRuntime {
  const runtime = useContext(ScanRuntimeContext);
  if (runtime === null) {
    throw new Error(
      "useScanRuntime was called outside <ScanFlow>. Screens in this library " +
        "read their asset URLs, language and limits from the flow's runtime, so " +
        "they cannot be rendered on their own."
    );
  }
  return runtime;
}

/** The asset URLs alone — the thing most callers actually want. */
export function useAssetUrls(): AssetUrls {
  return useScanRuntime().urls;
}
