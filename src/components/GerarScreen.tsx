"use client";

import * as React from "react";
import clsx from "clsx";
import { estimatedPdfBytes } from "@/lib/scan-store";
import { useScanStore, useStore } from "@/hooks/useScanStore";
import { useFlowNavigation } from "@/hooks/useFlowNavigation";
import { useScanRuntime } from "@/hooks/useScanRuntime";
import { useDialogChrome } from "@/hooks/useDialogChrome";
import { useEntrance } from "@/hooks/useEntrance";
import { formatBytes } from "@/lib/image";
import { pdfFallbackName } from "@/lib/i18n";
import {
  DEFAULT_MARK,
  DOCUMENT_MARKS,
  documentSlug,
  pdfFileName,
  SLUG_MAX_LENGTH,
  type DocumentMark,
} from "@/lib/naming";
import { isBlocking } from "@/lib/page-tiles";
import { AppFrame, FrameStep } from "@/components/AppFrame";
import { useCopy, useLang } from "@/components/I18n";
import { PdfPreviewSheet } from "@/components/PdfPreviewSheet";
import { PencilIcon } from "@/components/icons";
import { Button, LiveRegion, Meta, Notice, useCancelOnEscape } from "@/components/ui";

/**
 * Step 3 — the last screen before the file exists.
 *
 * **The name is composed, not typed.** `20260817-1432_exame.pdf` is two halves
 * and the user writes neither of them by default: the front is the moment the
 * scan began (so a file list sorted by name is sorted by time) and the back is
 * one tap on a grid of six markings. That is the whole point of the redesign —
 * the audience is holding a phone, often standing up, often not wearing their
 * reading glasses, and asking them to type a file name was asking for the one
 * thing this product should never need.
 *
 * The free text has not gone away; it has moved behind "✎ editar", where it is
 * a decision rather than an empty field waiting to be filled. Saving text that
 * happens to match a marking re-selects that marking, because the grid describes
 * the *name*, not a separate choice that could disagree with it.
 *
 * There is no searchable-PDF toggle on this screen: it was pulled from
 * this release (it has shipped and been pulled before). The store flag and the
 * build path that honour it remain, permanently false until the option returns.
 *
 * **The build now runs here rather than on a screen of its own.** There is no
 * separate "done" screen — the library ends the moment the PDF exists and the
 * host takes it from there — so this screen keeps the person while
 * the file is written, and says what is happening. It never announces success:
 * `FlowScreens` watches the store for that and hands the file out, so a build
 * that lands while somebody is looking at something else still leaves through
 * the same door.
 */
export function GerarScreen() {
  const copy = useCopy();
  const { lang } = useLang();
  const store = useStore();
  const { back } = useFlowNavigation();
  const { reportError, fileName: hostFileName } = useScanRuntime();
  const { session, tiles, build } = useScanStore();
  const [preview, setPreview] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [navigating, setNavigating] = React.useState(false);
  const scope = useEntrance<HTMLDivElement>({ y: 12, stagger: 0.05 });

  useCancelOnEscape();

  /**
   * A build that gave up, told once.
   *
   * Every one of these is recoverable: the pages are all still here and the
   * screen offers the button again, so the host is being informed rather than
   * asked to tear anything down. `over_budget` is not even a failure — it is
   * "too much paper for the ceiling you set" — but it reaches the host under
   * the same code, because from outside there is one fact: no file.
   */
  const failure = build.phase === "failed" ? build.error : null;
  React.useEffect(() => {
    if (failure === null) return;
    reportError("build_failed", true);
  }, [failure, reportError]);

  // The grid opens on "exame" — the marking most of this audience is holding.
  // Written into the store rather than merely drawn, so the file the build
  // names and the name on screen can never be two different strings.
  const documentName = session?.documentName ?? null;
  // A host that named the file gets no marking at all: there is nothing for
  // one to change.
  React.useEffect(() => {
    if (hostFileName !== null) return;
    if (session === null || session.documentName !== null) return;
    store.setDocumentName(copy.gerar.marks[DEFAULT_MARK]);
  }, [session, copy, store, hostFileName]);

  const readyTiles = tiles.filter((tile) => tile.page.status === "ready");
  const pageCount = readyTiles.length;
  const stillWorking = tiles.some((tile) => tile.stage === "processing");
  // Reachable directly and by going back, so this screen owes the same refusal
  // the review step makes: a PDF silently missing a photographed page is the one
  // outcome the user would not forgive (the store refuses too, as a backstop).
  const brokenCount = tiles.filter(isBlocking).length;
  const blocked = brokenCount > 0;
  const estimate = estimatedPdfBytes(session, false);

  const fallback = pdfFallbackName(lang);
  const suffix = documentSlug(documentName, fallback);
  // The exact string the download will carry, composed by the very function
  // that will compose it — so this is the file name, not a rendering of one.
  // Without a session there is no capture start to stamp and the screen is
  // about to redirect; a `Date.now()` fallback here would bake the BUILD's
  // clock into the prerendered HTML and hydrate as a text mismatch.
  const fileName =
    hostFileName ??
    (session === null
      ? ""
      : pdfFileName(documentName, new Date(session.createdAt), fallback));

  /**
   * Which block is filled. Derived from the name rather than stored beside it,
   * which is what makes that rule fall out for free: text saved in the
   * sheet that slugs to a marking lights that marking up, and text that matches
   * nothing leaves the whole grid unmarked.
   */
  const selected: DocumentMark | null =
    DOCUMENT_MARKS.find(
      (mark) => mark !== "outro" && documentSlug(copy.gerar.marks[mark]) === suffix,
    ) ?? null;

  /**
   * Start the build and stay. There is nowhere to push to: completion is
   * detected centrally, and until it happens this screen is the progress.
   */
  const handleGenerate = React.useCallback(() => {
    setNavigating(true);
    void store.buildPdf();
  }, [store]);

  const building = build.phase === "working";

  if (preview) {
    return (
      <PdfPreviewSheet
        tiles={readyTiles}
        onConfirm={() => {
          setPreview(false);
          handleGenerate();
        }}
        onClose={() => setPreview(false)}
      />
    );
  }

  return (
    <>
      <AppFrame
        title={copy.gerar.title}
        step={3}
        // No way back out of a build that is reading the very pages the back
        // button would let somebody edit.
        onBack={building ? undefined : back}
        aside={<FrameStep size="xs">{copy.common.pagesShort(pageCount)}</FrameStep>}
        footer={
          building ? (
            <div className="flex flex-col gap-2 pb-1">
              <Button
                variant="secondary"
                fullWidth
                disabled={build.cancelling}
                onClick={() => store.cancelBuild()}
              >
                {build.cancelling ? copy.pronto.cancelling : copy.common.cancel}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 pb-1">
              {blocked && (
                <Notice tone="warning">{copy.gerar.blocked(brokenCount)}</Notice>
              )}
              <Button
                variant="secondary"
                fullWidth
                disabled={pageCount === 0 || blocked || navigating}
                onClick={() => setPreview(true)}
              >
                {copy.gerar.previewCta}
              </Button>
              <Button
                fullWidth
                disabled={pageCount === 0 || stillWorking || blocked || navigating}
                onClick={handleGenerate}
              >
                {stillWorking ? copy.gerar.preparing : copy.gerar.generate}
              </Button>
            </div>
          )
        }
      >
        {building ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
            <LiveRegion
              message={
                build.cancelling
                  ? copy.pronto.announceCancelling
                  : copy.pronto.stageAssembling
              }
            />
            <h2 className="font-display text-3xl font-semibold text-ink">
              {build.cancelling ? copy.pronto.cancelling : copy.pronto.building}
            </h2>
            {/* A real progress bar, because "montando…" on a slow phone with no
                number is indistinguishable from a frozen app. */}
            <div
              role="progressbar"
              aria-label={copy.pronto.progressLabel}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(build.progress * 100)}
              className="h-1.5 w-full max-w-[18rem] overflow-hidden rounded-full bg-cream"
            >
              <span
                className="block h-full rounded-full bg-leaf transition-[width] duration-300"
                style={{ width: `${Math.round(build.progress * 100)}%` }}
              />
            </div>
            <Meta size="sm">
              {build.cancelling
                ? copy.pronto.cancelNotice
                : copy.pronto.keepScreenOn}
            </Meta>
          </div>
        ) : (
          <div ref={scope} className="flex flex-col gap-4 px-4 py-4">
            <LiveRegion message={copy.gerar.announce(pageCount)} />

            {failure !== null && (
              <Notice tone="warning" title={copy.pronto.failureTitle}>
                {copy.buildErrors[failure]}
              </Notice>
            )}

            {hostFileName === null && (
              <div data-enter className="flex flex-col gap-2.5">
                <h2 className="text-sm font-semibold leading-snug text-ink">
                  {copy.gerar.question}
                </h2>
                {/* Toggle buttons in a group rather than a radiogroup, which is the
                    idiom the name chips used before it: a `radio` owes arrow-key
                    roving that also *selects*, and arrowing onto "outro" would open
                    a sheet nobody asked for. Exclusivity is carried by only one
                    being pressed. */}
                <div
                  role="group"
                  aria-label={copy.gerar.markGroup}
                  className="grid grid-cols-3 gap-2"
                >
                  {DOCUMENT_MARKS.map((mark) => (
                    <MarkBlock
                      key={mark}
                      label={copy.gerar.marks[mark]}
                      selected={selected === mark}
                      onClick={() => {
                        if (mark === "outro") {
                          setRenaming(true);
                          return;
                        }
                        store.setDocumentName(copy.gerar.marks[mark]);
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            <dl data-enter className="flex flex-col">
              <div className="flex min-h-[44px] items-center gap-2 border-b border-cream py-1.5">
                <dt className="shrink-0">
                  <Meta size="sm">{copy.gerar.detailFile}</Meta>
                </dt>
                <dd className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-3xs leading-[1.4] text-ink">
                    {fileName}
                  </span>
                  {/* The only door to free text on this screen. There is no name
                      field: a field is an instruction to type, and the whole
                      design is about not asking. Absent when the host named
                      the file: typed text would have nowhere to go. */}
                  {hostFileName === null && (
                    <button
                      type="button"
                      aria-label={copy.gerar.editAria}
                      onClick={() => setRenaming(true)}
                      className={
                        "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[10px] border border-moss " +
                        "px-2.5 font-mono text-3xs leading-none text-leaf " +
                        "transition-colors duration-200 hover:border-sage"
                      }
                    >
                      <PencilIcon size={13} />
                      {copy.gerar.edit}
                    </button>
                  )}
                </dd>
              </div>
              <DetailRow label={copy.gerar.statPages} value={String(pageCount)} />
              <DetailRow
                label={copy.gerar.statSize}
                value={estimate === 0 ? "—" : `~${formatBytes(estimate)}`}
                last
              />
            </dl>

            {stillWorking && (
              <Notice tone="neutral" data-enter>
                {copy.gerar.stillWorking}
              </Notice>
            )}

            {pageCount === 0 && !stillWorking && !blocked && (
              <Notice tone="warning" data-enter title={copy.gerar.nothingReadyTitle}>
                {copy.gerar.nothingReadyBody}
              </Notice>
            )}
          </div>
        )}
      </AppFrame>

      {renaming && hostFileName === null && (
        <RenameSheet
          initial={suffix}
          onSave={(value) => {
            store.setDocumentName(value);
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)}
        />
      )}
    </>
  );
}

/** One of the six markings: a 52px block, filled when it names the file. */
function MarkBlock({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={clsx(
        "flex h-[52px] items-center justify-center rounded-xl px-1.5",
        "text-center text-sm leading-tight transition-colors duration-200",
        selected
          ? "bg-leaf font-semibold text-warm"
          : "border border-border text-ink-2 hover:border-sage",
      )}
    >
      {label}
    </button>
  );
}

/** A line of the details list: mono label, mono value, hairline underneath. */
function DetailRow({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-3 py-2.5",
        !last && "border-b border-cream",
      )}
    >
      <dt>
        <Meta size="sm">{label}</Meta>
      </dt>
      <dd className="font-mono text-3xs leading-none text-ink">{value}</dd>
    </div>
  );
}

/**
 * "Escrever outro nome" — one field, and it is the *suffix* only.
 *
 * The date and time are not in the field and cannot be edited, which the note
 * says out loud: they are what makes a phone's file list chronological, and a
 * user who deleted them would not find out until the month they needed to.
 */
function RenameSheet({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const copy = useCopy();
  const [value, setValue] = React.useState(initial);
  const containerRef = useDialogChrome<HTMLDivElement>(onCancel);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={copy.gerar.rename.title}
      className="fixed inset-0 z-50 flex flex-col items-center justify-end overscroll-contain"
    >
      <div
        aria-hidden="true"
        onClick={onCancel}
        className="absolute inset-0 bg-deep/40"
      />
      {/* max-w-[30rem]: the same cap the app column and the page editor use —
          without it the sheet spans the whole desktop viewport while the
          screen behind stays a phone column. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave(value);
        }}
        className="relative flex w-full max-w-[30rem] flex-col gap-3 rounded-t-2xl border-t border-border bg-warm px-4 pb-[max(env(safe-area-inset-bottom),16px)] pt-4"
      >
        <h2 className="font-display text-xl font-semibold text-ink">
          {copy.gerar.rename.title}
        </h2>
        <label
          htmlFor="sufixo-do-arquivo"
          className="text-sm font-semibold text-ink"
        >
          {copy.gerar.rename.label}
        </label>
        <input
          id="sufixo-do-arquivo"
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          maxLength={SLUG_MAX_LENGTH}
          autoComplete="off"
          autoCapitalize="none"
          enterKeyHint="done"
          className="min-h-tap w-full rounded-xl border border-leaf bg-warm px-3 text-base text-ink focus:border-leaf focus:outline-none"
        />
        <p>
          <Meta size="sm">{copy.gerar.rename.note}</Meta>
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onCancel}>
            {copy.gerar.rename.cancel}
          </Button>
          <Button type="submit" className="flex-1">
            {copy.gerar.rename.save}
          </Button>
        </div>
      </form>
    </div>
  );
}
