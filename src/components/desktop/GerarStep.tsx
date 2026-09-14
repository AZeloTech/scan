"use client";

import * as React from "react";
import clsx from "clsx";
import {
  estimatedPdfBytes,
  isRendered,
  type BuildStep,
  type PdfBuild,
  type ScanSession,
} from "@/lib/scan-store";
import { isBlocking, type PageTile } from "@/lib/page-tiles";
import { formatBytes } from "@/lib/image";
import { pdfFallbackName, type AppCopy } from "@/lib/i18n";
import {
  DOCUMENT_MARKS,
  documentSlug,
  pdfFileName,
  pdfNamePrefix,
  SLUG_MAX_LENGTH,
  type DocumentMark,
} from "@/lib/naming";
import { useBlobUrl, useStore } from "@/hooks/useScanStore";
import { useScanRuntime } from "@/hooks/useScanRuntime";
import { useCopy, useLang } from "@/components/I18n";
import { Meta } from "@/components/ui";
import { CheckIcon, SpinnerIcon } from "@/components/icons";

/**
 * Step 3 — the form, and then the file.
 *
 * Same decisions as the phone's step 3, laid out for a screen that can show the
 * form and its consequences side by side: the six markings still *derive* the
 * selected chip from the composed name rather than storing a second opinion,
 * and the date prefix is still not editable — it is what makes a downloads
 * folder sorted by name also sorted by time, and a user who deleted it would
 * not find out until the month they needed it.
 *
 * Two things differ from the phone, both deliberate:
 *
 *  * **The name is a field, not a sheet.** On a phone a field is an instruction
 *    to type, which is why `GerarScreen` hides free text behind "✎ editar". At a
 *    keyboard it is the opposite: a read-only string with an edit button is a
 *    step for nothing. The immutable half stays immutable — it is a mono
 *    adornment inside the field, not part of the value.
 * **No "texto pesquisável" toggle, on either surface.** It was once offered
 * here, on the reasoning that a desk is where the wait it buys becomes
 * acceptable; it was pulled again for the first release, so no screen
 * in the product offers it and nothing can switch it on. The engine is dormant,
 * not deleted — the `lib/pdf.ts` text-layer path went with OCR, and
 * `build.searchable` is permanently `false`.
 *
 * **Nothing here hands the file over.** There is no download button, no share
 * offer and no "escanear outro documento": this
 * library's job ends the moment the PDF exists, and the host — which is the
 * only thing that knows whether the file is uploaded, attached or saved — takes
 * it from there through `onComplete`. What is left of the "done" state is a
 * receipt, so the screen does not go silent between the last percent and
 * whatever the host does next.
 */
export function GerarStep({
  session,
  tiles,
  build,
  onBack,
}: {
  session: ScanSession | null;
  tiles: readonly PageTile[];
  build: PdfBuild;
  onBack: () => void;
}) {
  const copy = useCopy();
  const { lang } = useLang();
  const store = useStore();
  const { reportError, fileName: hostFileName } = useScanRuntime();

  /**
   * A build that gave up, told once. Recoverable every time: the pages are all
   * still here and the button below is live again.
   */
  const failure = build.phase === "failed" ? build.error : null;
  React.useEffect(() => {
    if (failure === null) return;
    reportError("build_failed", true);
  }, [failure, reportError]);

  // `isRendered`, not `status === "ready"`: the build embeds a page only when
  // its `final` was rendered from the page **as it stands now**, so a page
  // whose render is one revision behind is one the prévia would count and the
  // file would not contain.
  const readyTiles = tiles.filter((tile) => isRendered(tile.page));
  const pageCount = readyTiles.length;
  const blocked = tiles.some(isBlocking);
  const stillWorking = tiles.some((tile) => tile.stage === "processing");
  // `false`: there is no text layer to account for — nothing can turn one on.
  const estimate = estimatedPdfBytes(session, false);

  const fallback = pdfFallbackName(lang);
  const documentName = session?.documentName ?? null;
  const suffix = documentSlug(documentName, fallback);
  const prefix = session === null ? "" : pdfNamePrefix(new Date(session.createdAt));

  // The grid opens on the marking most of this audience is holding, written
  // into the store rather than merely drawn — so the name on screen and the
  // name the build uses can never be two different strings.
  //
  // Seeded at most once per mount, via `seededRef` rather than a re-check of
  // `documentName`: a name of `null` is also what the store holds the instant
  // a user select-alls the field and deletes it, and without the ref this
  // same effect would see that same `null` and stamp "exame" straight back
  // in while they are still mid-keystroke. The field is allowed to be empty;
  // only its very first paint is not.
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (hostFileName !== null || session === null || seededRef.current) return;
    seededRef.current = true;
    if (session.documentName === null) {
      store.setDocumentName(copy.gerar.marks.exame);
    }
  }, [session, copy, store, hostFileName]);

  /**
   * Which chip is lit. Derived from the name, exactly as on the phone: text
   * that happens to slug to a marking lights that marking, and text that
   * matches nothing leaves the grid unmarked — with no second flag to drift.
   */
  const selected: DocumentMark | null =
    DOCUMENT_MARKS.find(
      (mark) => mark !== "outro" && documentSlug(copy.gerar.marks[mark]) === suffix,
    ) ?? null;

  /**
   * What is actually in the field, which is **not** the slug.
   *
   * The store holds what the user wrote and `documentSlug` is what the file
   * gets called; feeding the slug back into the input as its value makes the
   * two the same string, and then every keystroke round-trips through
   * slugification. A space becomes a trailing hyphen and a trailing hyphen is
   * trimmed, so "exame de sangue" is unreachable — it types out as
   * "examedesangue" — and clearing the field to retype refills it with the
   * fallback before the second character lands. Same shape as the phone's
   * `RenameSheet`: a local draft is the value, the store is written on every
   * change, and the draft is re-synced only when something *else* changed the
   * name — a category chip, or the marking the screen opens with.
   */
  const [draft, setDraft] = React.useState(() =>
    documentSlug(documentName, fallback),
  );
  /** The name our own last keystroke put in the store; anything else is a chip. */
  const typedRef = React.useRef<string | null | undefined>(undefined);
  React.useEffect(() => {
    if (documentName === typedRef.current) return;
    setDraft(documentSlug(documentName, fallback));
  }, [documentName, fallback]);

  const phase: Phase =
    build.phase === "working"
      ? "making"
      : build.phase === "done" && build.blob !== null
        ? "done"
        : "form";

  return (
    <main className="flex min-h-0 flex-1 justify-center overflow-auto px-[clamp(16px,3vw,40px)] py-[clamp(20px,4vh,52px)]">
      <div className="my-auto flex w-[min(900px,100%)] flex-wrap items-start gap-5">
        <div className="flex flex-[3_1_400px] flex-col gap-[18px] rounded-[20px] border border-border bg-warm p-6">
          <div className="flex flex-col gap-2">
            <Meta caps tone="sage" size="sm">
              {copy.desktop.gerar.kicker}
            </Meta>
            <h2 className="font-display text-[1.5625rem] font-semibold leading-[1.15] text-ink">
              {copy.desktop.gerar.title}
            </h2>
          </div>

          {/* A host that named the file gets its name, shown, and nothing to
              type into: no chips, no field. Typed text would have nowhere to
              go, and a field is an instruction to type. */}
          {hostFileName === null ? (
            <>
            <div className="flex flex-col gap-2">
              <Meta caps tone="sage" size="2xs">
                {copy.gerar.question}
              </Meta>
              <div
                role="group"
                aria-label={copy.gerar.markGroup}
                className="grid grid-cols-3 gap-[7px]"
              >
                {DOCUMENT_MARKS.map((mark) => (
                  <button
                    key={mark}
                    type="button"
                    aria-pressed={selected === mark}
                    onClick={() => store.setDocumentName(copy.gerar.marks[mark])}
                    className={clsx(
                      "flex h-11 items-center justify-center rounded-[11px] border text-xs font-semibold transition-colors duration-200",
                      selected === mark
                        ? "border-leaf bg-leaf text-warm"
                        : "border-border bg-warm text-desk-body hover:border-sage",
                    )}
                  >
                    {copy.gerar.marks[mark]}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="desk-file-name">
                <Meta caps tone="sage" size="2xs">
                  {copy.desktop.gerar.nameLabel}
                </Meta>
              </label>
              <div className="flex h-[50px] items-center gap-1 rounded-xl border-[1.5px] border-border bg-white px-3.5 focus-within:border-leaf">
                {/* Not part of the value and not reachable by the caret: the
                    stamp is the scan's own start moment, and editing it would
                    quietly break the one thing the name is for. */}
                <span
                  aria-label={copy.desktop.gerar.namePrefixLabel}
                  className="shrink-0 font-mono text-2xs leading-none text-desk-faint"
                >
                  {prefix}_
                </span>
                <input
                  id="desk-file-name"
                  type="text"
                  value={draft}
                  maxLength={SLUG_MAX_LENGTH}
                  autoComplete="off"
                  autoCapitalize="none"
                  aria-label={copy.desktop.gerar.nameField}
                  onChange={(event) => {
                    const value = event.target.value;
                    // Recorded as the store will hold it — an empty field is a
                    // name of `null` — so the re-sync effect can tell our own
                    // keystroke from a chip's write.
                    typedRef.current = value.length === 0 ? null : value;
                    setDraft(value);
                    store.setDocumentName(value);
                  }}
                  className="min-w-0 flex-1 border-none bg-transparent text-sm text-ink outline-none"
                />
                <span className="shrink-0 font-mono text-2xs leading-none text-desk-faint">
                  .pdf
                </span>
              </div>
            </div>
            </>
          ) : (
            <div className="flex flex-col gap-2">
              <Meta caps tone="sage" size="2xs">
                {copy.desktop.gerar.nameLabel}
              </Meta>
              <span className="break-all font-mono text-2xs leading-normal text-ink">
                {hostFileName}
              </span>
            </div>
          )}

          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              disabled={pageCount === 0 || blocked || stillWorking || phase !== "form"}
              onClick={() => void store.buildPdf()}
              className={clsx(
                "inline-flex h-[54px] min-w-[200px] flex-1 items-center justify-center rounded-[13px]",
                "text-base font-bold text-paper transition-colors duration-200",
                pageCount === 0 || blocked || stillWorking || phase !== "form"
                  ? "cursor-not-allowed bg-deep opacity-40"
                  : "bg-deep hover:bg-leaf",
              )}
            >
              {stillWorking ? copy.gerar.preparing : copy.gerar.generate}
            </button>
            {/* Shut while the build runs, like the step trail: `buildPdf` is
                reading these pages, and a workspace that let them be deleted
                underneath it would produce a file describing a document that
                no longer exists. "Cancelar" on the making card is the way out. */}
            <button
              type="button"
              disabled={phase === "making"}
              onClick={onBack}
              className="inline-flex h-[54px] items-center rounded-[13px] border-[1.5px] border-desk-edge px-[18px] text-[0.84375rem] font-semibold text-leaf transition-colors duration-200 hover:border-leaf disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-desk-edge"
            >
              {copy.desktop.gerar.backToConferir}
            </button>
          </div>

          {blocked && (
            <p className="text-sm leading-snug text-desk-warn">
              {copy.gerar.blocked(tiles.filter(isBlocking).length)}
            </p>
          )}
          {build.phase === "failed" && (
            <p className="text-sm leading-snug text-desk-warn">
              {copy.buildErrors[build.error ?? "build_failed"]}
            </p>
          )}
        </div>

        <div className="flex flex-[2_1_300px] flex-col gap-3.5">
          {phase === "form" && (
            <>
              <div className="flex flex-col gap-3 rounded-[20px] border border-border bg-warm p-5">
                <Meta caps tone="sage" size="2xs">
                  {copy.desktop.gerar.previewLabel}
                </Meta>
                <div className="flex justify-center py-1">
                  <FirstPage tile={readyTiles[0] ?? null} />
                </div>
                <dl className="flex flex-col gap-2">
                  <PreviewRow
                    label={copy.desktop.gerar.rowPages}
                    value={String(pageCount)}
                  />
                  <PreviewRow
                    label={copy.desktop.gerar.rowSize}
                    value={estimate === 0 ? "—" : `~${formatBytes(estimate)}`}
                  />
                  {/* Not "A4 · retrato": this product cuts every PDF page to
                      its own image, and saying otherwise would describe a
                      geometry the file does not have. */}
                  <PreviewRow
                    label={copy.desktop.gerar.rowGeometry}
                    value={copy.desktop.gerar.geometryValue}
                  />
                </dl>
              </div>
            </>
          )}

          {phase === "making" && <MakingCard build={build} />}

          {phase === "done" && (
            <DoneCard
              build={build}
              fileName={
                build.fileName ??
                hostFileName ??
                (session === null
                  ? ""
                  : pdfFileName(documentName, new Date(session.createdAt), fallback))
              }
            />
          )}
        </div>
      </div>
    </main>
  );
}

type Phase = "form" | "making" | "done";

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2.5 font-mono text-3xs leading-none">
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

/** The document's first page, at 120 px — the artefact, not a drawing of it. */
function FirstPage({ tile }: { tile: PageTile | null }) {
  const url = useBlobUrl(tile?.page.thumb ?? null);
  return (
    <span className="flex w-[120px] items-center justify-center overflow-hidden rounded-[3px] border border-border bg-white shadow-[0_12px_24px_-16px_rgba(31,49,40,.5)]">
      {url === null ? (
        <span className="flex aspect-[210/297] w-full items-center justify-center">
          <SpinnerIcon size={18} className="text-mist" />
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="w-full" />
      )}
    </span>
  );
}

/**
 * What the build is doing, read off the build itself.
 *
 * The bar moves on `build.progress` and the checklist on `build.step`; nothing
 * here invents a number or a step it cannot see — which is why there is no OCR
 * line: nothing can switch searchable text on any more, so a "reading the text"
 * step would be a step that never runs, and showing one costs the whole list
 * its credibility.
 */
function MakingCard({ build }: { build: PdfBuild }) {
  const copy = useCopy();
  const store = useStore();
  const percent = Math.round(Math.min(1, Math.max(0, build.progress)) * 100);
  const lines = checklist(copy, build);

  return (
    <div className="flex flex-col gap-4 rounded-[20px] border border-border bg-warm p-5">
      <span className="font-display text-xl font-semibold text-ink">
        {copy.desktop.gerar.makingTitle}
      </span>
      <div className="flex flex-col gap-2">
        <div className="h-2 overflow-hidden rounded-full bg-frost">
          <div
            className="h-2 rounded-full bg-leaf transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="flex justify-between font-mono text-4xs leading-none text-ink-3">
          <span>
            {build.pageIndex > 0
              ? copy.common.pageOfTotal(build.pageIndex, build.pageCount)
              : ""}
          </span>
          <span>{percent}%</span>
        </div>
      </div>
      <ul className="flex flex-col gap-2.5 text-xs text-desk-body">
        {lines.map((line) => (
          <li key={line.key} className="flex items-center gap-2.5">
            {line.state === "done" && <CheckIcon size={13} className="text-pine" />}
            {line.state === "active" && (
              <SpinnerIcon size={13} className="text-pine" />
            )}
            {line.state === "waiting" && (
              <span aria-hidden="true" className="w-[13px] text-center text-desk-faint">
                ·
              </span>
            )}
            <span className={clsx(line.state === "waiting" && "text-desk-faint")}>
              {line.label}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={build.cancelling}
        onClick={() => store.cancelBuild()}
        className="inline-flex h-11 items-center justify-center rounded-[11px] border-[1.5px] border-desk-edge text-sm font-semibold text-leaf transition-colors duration-200 hover:border-leaf disabled:opacity-45"
      >
        {build.cancelling ? copy.pronto.cancelling : copy.common.cancel}
      </button>
    </div>
  );
}

interface ChecklistLine {
  key: string;
  label: string;
  state: "done" | "active" | "waiting";
}

/**
 * The two passes the desktop's checklist opens with are already finished by the
 * time a build starts, and they say so: every page was straightened and given
 * its finish at import, one render each, long before "Gerar PDF" was pressed.
 * They are on the list because they are what the user is waiting to see
 * confirmed, not because the build is doing them.
 */
function checklist(copy: AppCopy, build: PdfBuild): ChecklistLine[] {
  // One step, always: `ocr` is unreachable now that nothing can ask for a text
  // layer, so the list does not carry a branch for it.
  const order: BuildStep[] = ["assembling"];
  const at = build.step === null ? order.length : order.indexOf(build.step);
  const lines: ChecklistLine[] = [
    { key: "straight", label: copy.desktop.gerar.checkStraightened, state: "done" },
    { key: "contrast", label: copy.desktop.gerar.checkContrast, state: "done" },
  ];
  order.forEach((step, index) => {
    lines.push({
      key: step,
      label: copy.pronto.checkAssembling,
      state: index < at ? "done" : index === at ? "active" : "waiting",
    });
  });
  return lines;
}

/**
 * The file exists — and this is all the screen has to say about it.
 *
 * There is no download, no share sheet and no "escanear outro". A
 * library that wrote the bytes to the user's Downloads folder would be making
 * the host's decision for it, and in a host that collects documents that
 * decision is "attach this to the submission", not "save it somewhere the
 * person has to find again". The
 * finished `File` has already left through `onComplete` by the time this paints.
 */
function DoneCard({ build, fileName }: { build: PdfBuild; fileName: string }) {
  const copy = useCopy();
  const blob = build.blob;

  return (
    <>
      <div className="flex flex-col gap-3 rounded-[20px] bg-deep p-5">
        <span className="flex items-center gap-2 font-mono text-4xs uppercase leading-none tracking-[0.07em] text-mist">
          <CheckIcon size={12} />
          {copy.desktop.gerar.doneKicker}
        </span>
        <span className="break-all text-[0.84375rem] leading-normal text-paper">
          {fileName}
        </span>
        <Meta size="xs" tone="warm" className="opacity-60">
          {copy.common.pages(build.pageCount)} · {formatBytes(blob?.size ?? 0)}
        </Meta>
      </div>
      <div className="rounded-2xl bg-frost px-4 py-3.5 text-xs leading-relaxed text-deep">
        {copy.desktop.gerar.trust}
      </div>
    </>
  );
}
