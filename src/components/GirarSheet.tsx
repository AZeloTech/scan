"use client";

import * as React from "react";
import clsx from "clsx";
import {
  nextRotation,
  previousRotation,
  type PageRotation,
} from "@/lib/rotation";
import type { PageTile } from "@/lib/page-tiles";
import { useStore } from "@/hooks/useScanStore";
import { useCopy } from "@/components/I18n";
import { Sheet, SheetAction } from "@/components/Sheet";
import { LiveRegion, Meta } from "@/components/ui";
import { RotateIcon, RotateLeftIcon, UndoIcon } from "@/components/icons";

/**
 * "Girar a folha" — one button per direction, over the page it turns.
 *
 * The sheet is deliberately small and the picture stays on screen behind it:
 * turning a page is the commonest repair a scan needs and the only way to know
 * it worked is to watch it happen. The editor narrates the turn on its status
 * line while this is open ({@link GirarSheetProps.onTurn}), because a sheet
 * that covers the bottom third of the screen has no room to say it twice.
 *
 * **One button per direction, with the destination written.** The screen this
 * replaced drew two identical buttons both labelled "girar", telling the two
 * apart by an arrow glyph alone.
 *
 * **"desfazer" goes back to the turn the page had when the sheet opened**, in
 * one write rather than three: `setPageRotation` re-renders once,
 * where three `rotatePage` calls would spend three renders getting back to
 * where the user started.
 *
 * There is no separate commit. Every turn is already live in the store (the
 * store re-renders the page from its canonical the instant the button is
 * tapped), so "Salvar giro" only closes the sheet — the same model every other
 * edit in this app follows.
 */

/**
 * One turn, as the status line has to say it: "Girando para a direita — 90°."
 *
 * Both halves come from here because both are this sheet's own facts. The
 * direction is the button that was tapped, and the rotation is where the page
 * lands — not the CSS delta the editor animates, which is back to zero the
 * moment the render arrives and would narrate a turn to 0° under an open sheet.
 */
export interface PageTurn {
  direction: "cw" | "ccw";
  /** Where the page ends up, already normalised. */
  rotation: PageRotation;
}

interface GirarSheetProps {
  tile: PageTile;
  /** Called after every turn, so the editor's status line can narrate it. */
  onTurn: (turn: PageTurn) => void;
  onClose: () => void;
}

export function GirarSheet({ tile, onTurn, onClose }: GirarSheetProps) {
  const copy = useCopy();
  const store = useStore();
  const pageId = tile.pageId;
  const rotation = tile.page.rotation;
  /** Where "desfazer" goes back to. Captured once, at mount. */
  const entryRotation = React.useRef(rotation).current;

  const turn = React.useCallback(
    (direction: "cw" | "ccw") => {
      // The same two helpers the store's own `rotatePage` uses, so the
      // narration can never disagree with the turn it is narrating.
      const next =
        direction === "cw" ? nextRotation(rotation) : previousRotation(rotation);
      store.rotatePage(pageId, direction);
      onTurn({ direction, rotation: next });
    },
    [onTurn, pageId, rotation, store],
  );

  return (
    <Sheet
      title={copy.girar.title}
      label={copy.girar.dialogLabel(tile.humanNumber)}
      onClose={onClose}
    >
      <LiveRegion
        message={copy.girar.announce(tile.humanNumber, copy.rotations[rotation])}
      />

      <div className="flex gap-2.5">
        <TurnButton
          label={copy.girar.leftAria(copy.rotations[rotation])}
          icon={<RotateLeftIcon size={19} />}
          onClick={() => turn("ccw")}
        >
          {copy.girar.left}
        </TurnButton>
        <TurnButton
          label={copy.girar.rightAria(copy.rotations[rotation])}
          icon={<RotateIcon size={19} />}
          onClick={() => turn("cw")}
        >
          {copy.girar.right}
        </TurnButton>
      </div>

      <div className="flex items-center justify-between gap-2.5 border-t border-shell-line pt-3">
        <Meta onNight size="md">
          {copy.girar.current(rotation)}
        </Meta>
        <button
          type="button"
          disabled={rotation === entryRotation}
          onClick={() => {
            store.setPageRotation(pageId, entryRotation);
            // "desfazer" jumps, but the narration still owes a direction — the
            // short way round, which is the way the picture visibly takes
            // (`turnDegrees` picks the same arc).
            const forward = (entryRotation - rotation + 360) % 360;
            onTurn({
              direction: forward > 180 ? "ccw" : "cw",
              rotation: entryRotation,
            });
          }}
          className={clsx(
            "inline-flex h-[38px] shrink-0 items-center gap-1.5 rounded-full px-3.5",
            "border border-shell-line text-xs leading-none text-shell-ink",
            "transition-colors duration-200 hover:border-shell-ink",
            "disabled:cursor-not-allowed disabled:opacity-40",
            // 44px of tap around a 38px pill, taken out of the row's own
            // padding rather than added to it: this sheet's rows sit above a
            // fixed CTA and every pixel they grow by pushes the sheet up over
            // the picture the user is watching turn.
            "relative after:absolute after:-inset-x-1 after:-inset-y-[3px] after:content-['']",
          )}
        >
          <UndoIcon size={15} />
          {copy.girar.undo}
        </button>
      </div>

      <SheetAction onClick={onClose}>{copy.girar.save}</SheetAction>
    </Sheet>
  );
}

/**
 * One direction, 64 px tall, with the destination written next to the arrow.
 *
 * The visible word is the direction alone ("esquerda" / "direita") because two
 * buttons reading "girar para a esquerda" wrap onto two lines each at 320 px;
 * the full sentence, plus the orientation the page is in right now, is what a
 * screen reader is given — without it a tap changes nothing but pixels and is
 * therefore silent.
 */
function TurnButton({
  label,
  icon,
  children,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={clsx(
        "inline-flex h-16 flex-1 items-center justify-center gap-2 rounded-[14px]",
        "border-[1.5px] border-shell-line text-lg font-semibold text-shell-ink",
        "transition-colors duration-200 hover:border-shell-ink",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
