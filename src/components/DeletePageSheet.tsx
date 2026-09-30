"use client";

import * as React from "react";
import { useCopy } from "@/components/I18n";
import { Sheet, SheetAction, SheetSecondaryAction } from "@/components/Sheet";

/**
 * The confirmation behind the page editor's top-right bin.
 *
 * It states the **consequence** rather than asking "tem certeza?": what leaves
 * the document, what the PDF is left with, and that there is no way back. The
 * page count in that sentence is the one the document would have *after* the
 * deletion, which is the number the reader is actually deciding about.
 *
 * The destructive answer is the filled one here and the outlined "Manter" sits
 * under it — the reverse of the app's usual hierarchy, and deliberate: this
 * sheet only exists because the user asked for it, so the button that does what
 * they asked is the one that reads as the action. There is no × in the title
 * row for the same reason: "Manter" is the way out, and a second, quieter exit
 * beside it is two ways to say one thing.
 */
export function DeletePageSheet({
  humanNumber,
  remaining,
  onConfirm,
  onClose,
}: {
  humanNumber: number;
  /** Pages the document is left with — the consequence, not the current count. */
  remaining: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const copy = useCopy().preview.confirmDelete;

  return (
    <Sheet hideClose title={copy.title(humanNumber)} onClose={onClose}>
      <p className="text-[12.5px] leading-relaxed text-shell-ink2">
        {copy.body(remaining)}
      </p>
      <div className="flex flex-col gap-2.5">
        <SheetAction tone="danger" onClick={onConfirm}>
          {copy.confirm}
        </SheetAction>
        <SheetSecondaryAction onClick={onClose}>{copy.keep}</SheetSecondaryAction>
      </div>
    </Sheet>
  );
}
