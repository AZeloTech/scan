"use client";

import { useCallback } from "react";
import { useStore } from "@/hooks/useScanStore";
import { useScanRuntime } from "@/hooks/useScanRuntime";
import { useCopy } from "@/components/I18n";
import { startPdfBuild } from "@/lib/generate";
import { DEFAULT_MARK } from "@/lib/naming";

/**
 * "Gerar PDF" — the build, with step 3's defaults (see `startPdfBuild`).
 *
 * Step 2's primary button calls this and moves to step 3, which shows the
 * build's progress and falls back to its form only when the build fails; the
 * form's own "Gerar PDF" calls it too, to try again.
 */
export function useGeneratePdf(): () => void {
  const store = useStore();
  const copy = useCopy();
  const { fileName: hostFileName } = useScanRuntime();

  return useCallback(() => {
    void startPdfBuild(store, {
      documentName: copy.gerar.marks[DEFAULT_MARK],
      hostFileName,
    });
  }, [store, copy, hostFileName]);
}
