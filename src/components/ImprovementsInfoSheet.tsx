"use client";

import * as React from "react";
import { useCopy } from "@/components/I18n";
import { FINISH_ORDER } from "@/components/AcabamentoSheet";
import { XIcon } from "@/components/icons";
import { useDialogChrome } from "@/hooks/useDialogChrome";

/**
 * "O que são as melhorias" — the short explanation behind the `?` on the page
 * view's improve row.
 *
 * It exists because that row now offers two very different things under one
 * word, and one of them collides with a label the app already uses elsewhere:
 * **Endireitar** is about the sheet's *curve*, while the "já endireitada" chip
 * over the picture is about the crop the app performs by itself at capture. A
 * user who reads both in the same minute is entitled to think one of them is
 * broken. So the sheet names both, says which is automatic, and repeats the
 * one honest thing about the beta: some pages come out better without it, and
 * those keep the original.
 *
 * The finish half is not written here at all — it is the sheet's own copy
 * ({@link AppCopy.finish}), read in {@link FINISH_ORDER}, so the two screens
 * cannot drift.
 *
 * Same dialog shell as the diagnostics sheet: full-screen on the shell, capped
 * at the app column, focus trapped, Escape and the back gesture close it.
 *
 * It used to hang off a `?` at the end of the editor's improve rule, wearing a
 * 44 px hit target pulled back to exactly `-my-[17px]` so it would not steal
 * height from the picture above it. The rule is gone with the fixed-band
 * redesign and so is that construct: the sheet is now a row of the editor's ⋯
 * menu, where a control is allowed to be 56 px tall.
 */
export function ImprovementsInfoSheet({ onClose }: { onClose: () => void }) {
  const copy = useCopy();
  const about = copy.preview.about;
  const containerRef = useDialogChrome<HTMLDivElement>(onClose);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={about.title}
      className="fixed inset-0 z-50 flex justify-center overscroll-contain bg-shell"
    >
      <div className="flex h-full w-full max-w-[30rem] flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between gap-3 px-4 pb-2 pt-[max(env(safe-area-inset-top),14px)]">
          <h1 className="min-w-0 truncate font-display text-xl font-semibold text-shell-ink">
            {about.title}
          </h1>
          <button
            type="button"
            aria-label={copy.common.close}
            onClick={onClose}
            className="-mr-2 inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center text-shell-ink"
          >
            <span
              aria-hidden="true"
              className="flex h-11 w-11 items-center justify-center rounded-full border-[1.5px] border-shell-line transition-colors duration-200 hover:border-shell-ink"
            >
              <XIcon size={20} />
            </span>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(env(safe-area-inset-bottom),14px)]">
          <section>
            <h2 className="font-display text-lg font-semibold text-shell-ink">
              {about.dewarpTitle}
            </h2>
            <p className="mt-1 text-base leading-snug text-shell-ink2">
              {about.dewarpBody}
            </p>
          </section>

          <section className="mt-5">
            <h2 className="font-display text-lg font-semibold text-shell-ink">
              {about.finishTitle}
            </h2>
            <p className="mt-1 text-base leading-snug text-shell-ink2">
              {about.finishIntro}
            </p>
            <dl className="mt-2 flex flex-col gap-1.5">
              {FINISH_ORDER.map((finish) => (
                <div key={finish} className="text-base leading-snug">
                  <dt className="inline font-semibold text-shell-ink">
                    {copy.finish.labels[finish]}
                  </dt>{" "}
                  <dd className="inline text-shell-ink2">
                    — {copy.finish.help[finish]}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <p className="mt-5 rounded-xl border border-shell-line bg-shell-sunken p-3 text-base leading-snug text-shell-ink2">
            {about.holdNote}
          </p>
        </div>
      </div>
    </div>
  );
}
