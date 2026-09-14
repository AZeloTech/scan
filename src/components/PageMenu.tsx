"use client";

import * as React from "react";
import clsx from "clsx";
import { useCopy } from "@/components/I18n";
import { Sheet, SheetAction, SheetSecondaryAction } from "@/components/Sheet";
import { HelpIcon, TrashIcon } from "@/components/icons";

/**
 * The page editor's ⋯ menu.
 *
 * It exists to take the bin off the header. A destructive control one tap from
 * done, sitting in the corner a thumb rests in, was the wrong trade even with a
 * confirmation behind it; the design moves it into a menu with the two other
 * things that are *about the page* rather than corrections *to* it.
 *
 * It is a bottom sheet rather than an anchored popover for two reasons: the
 * editor's panel is `overflow-hidden`, so a popover would have to escape it
 * through a second fixed layer anyway, and a menu row on a phone should be a
 * 56 px target rather than the 32 px line a desktop dropdown draws.
 *
 * There is no `?debug=1` "Detalhes técnicos" row: a library ships no debug
 * surface inside somebody else's page.
 */
export function PageMenu({
  humanNumber,
  onAbout,
  onRemove,
  onClose,
}: {
  humanNumber: number;
  onAbout: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const copy = useCopy();

  return (
    <Sheet
      title={copy.common.page(humanNumber)}
      label={copy.preview.menu}
      onClose={onClose}
    >
      <div className="flex flex-col">
        <MenuRow icon={<HelpIcon size={18} />} onClick={onAbout}>
          {copy.preview.menuItems.about}
        </MenuRow>
        <MenuRow danger icon={<TrashIcon size={18} />} onClick={onRemove}>
          {copy.preview.menuItems.remove}
        </MenuRow>
      </div>
    </Sheet>
  );
}

function MenuRow({
  icon,
  danger = false,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex min-h-tap items-center gap-3 rounded-xl px-2 text-left",
        "text-lg font-semibold leading-tight transition-colors duration-200",
        danger
          ? "text-shell-warn hover:bg-shell"
          : "text-shell-ink hover:bg-shell",
      )}
    >
      <span aria-hidden="true" className="shrink-0">
        {icon}
      </span>
      {children}
    </button>
  );
}

/**
 * The confirmation behind "Apagar a página".
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
