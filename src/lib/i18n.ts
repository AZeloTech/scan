/**
 * Every word this library says, in pt-BR and en-US.
 *
 * Two languages on purpose. The narrower theory — that a tool for Brazilian
 * patients holding Brazilian paperwork only ever needs pt-BR — does not hold:
 * a scanner that runs entirely on the device, needs no account and is offered
 * as open source has readers who are not Brazilian, and an English speaker
 * holding a Brazilian exam is not a rare case in a country with the migration
 * this one has.
 *
 * Three rules keep the two versions honest:
 *
 *  * **One dictionary, one shape.** A missing key is a type error rather than a
 *    blank paragraph, which is the only reason a translation stays complete
 *    through six months of copy edits.
 *  * **Interpolation is a function, never a template with holes.** Plural rules
 *    and word order differ ("2 páginas prontas" / "2 pages ready"), so the
 *    dictionary owns the whole sentence.
 *  * **State stores codes, not sentences.** A page that failed and a build that
 *    stopped carry an enum through the store (`PageErrorCode`, `BuildErrorCode`,
 *    `ImagePrepCode`); the words are looked up at render. Otherwise switching
 *    language would leave yesterday's error in yesterday's language.
 *
 * The **debug panel is deliberately not translated**: it is an instrument for
 * the operator running a calibration session, never a user-facing screen.
 *
 * **How the name is written** is settled in `lib/landing-copy.ts` and holds
 * here too: `scan`, lowercase, no full stop, never at the head of a sentence.
 * The one wrinkle on this side is `start.welcome`, which renders through
 * `<Meta caps>` and is therefore uppercased by CSS — a display transform on a
 * micro-label, not a second spelling of the name.
 */

import { resolveGeometryMode } from "@/lib/dewarp/engine-mode";
import type { CornerHandleKey } from "@/lib/flatten";
import type { DewarpPhase } from "@/lib/dewarp/index";
import type { DocumentMark } from "@/lib/naming";
import type { BuildErrorCode, PageErrorCode } from "@/lib/scan-store";
import type { PageFinish } from "@/lib/page-processing";
import type { PageRotation } from "@/lib/rotation";

/**
 * The consent paragraph's honest download size — `NEXT_PUBLIC_DEWARP_ENGINE`-
 * dependent, so the "~19 MB" figure stays exactly what it always was while the
 * flag is off, and the classical engine's own ~130 KB (gzipped) module gets
 * its own honest, much smaller sentence the moment it is on. In the "ab"
 * build this is
 * also "~19 MB" — `resolveGeometryMode()` answers "uvdoc" there — which is
 * correct on its own terms: the consent sheet only ever gates uvdoc's own
 * "Curvatura · IA" tile (`dewarpConsentRequired`, `scan-store.ts`), and uvdoc
 * is exactly what this sentence is about in every build that shows it.
 */
const DEWARP_ASSET_SIZE_LABEL =
  resolveGeometryMode() === "classical" ? "~130 KB" : "~19 MB";

export type Lang = "pt" | "en";

/** What goes in the root's `lang` attribute, and what `toLocaleLowerCase` is given. */
export const LANG_TAGS: Record<Lang, string> = { pt: "pt-BR", en: "en-US" };

export function localeTag(lang: Lang): string {
  return LANG_TAGS[lang];
}

/** The word an unnamed PDF is filed under. */
export function pdfFallbackName(lang: Lang): string {
  return lang === "pt" ? "documento" : "document";
}

// ── the dictionary ───────────────────────────────────────────────────────────

export interface AppCopy {
  common: {
    back: string;
    close: string;
    cancel: string;
    retry: string;
    discard: string;
    camera: string;
    /** "Passo 2 de 3" */
    stepOfThree: (step: number) => string;
    /** The three trail words, in order. */
    steps: readonly [string, string, string];
    /** "Página 3" — a page's name, capitalised. */
    page: (n: number) => string;
    /** "página 3 de 5" — a position, lowercase, for `Meta`. */
    pageOfTotal: (n: number, total: number) => string;
    /** "3 pág." — the header count. */
    pagesShort: (n: number) => string;
    /** "3 páginas" / "1 página". */
    pages: (n: number) => string;
    loadingPage: string;
    openingPhoto: string;
    /** Both corner editors: scanic's loupe only appears while a handle is held. */
    magnifyHint: string;
  };

  lang: {
    /** `aria-label` on the switch. */
    label: string;
    /** What the switch says about itself on the welcome screen. */
    hint: string;
  };

  primer: {
    title: string;
    heading: string;
    headingDenied: string;
    body: string;
    bodyDenied: string;
    /** Reason 01 is rich text elsewhere; these are the plain halves. */
    allowLead: string;
    allowWord: string;
    allowTail: string;
    unlockLead: string;
    unlockWord: string;
    unlockTail: string;
    stays: string;
    revoke: string;
    galleryWorks: string;
    ctaAllow: string;
    ctaAllowDenied: string;
    ctaGallery: string;
    preparing: string;
    galleryNote: string;
    galleryFailed: string;
  };

  capture: {
    /** The shutter's label and the fallback surface's title. */
    take: (n: number) => string;
    /**
     * The same surface's title where tapping it cannot reach a camera — a
     * desktop browser, which ignores the file input's `capture` attribute.
     *
     * The fallback surface is one control with two honest names: on a phone it
     * opens the camera app and "Fotografar página 3" is the truth; on a laptop
     * it opens a file chooser, and promising a photograph there is the app
     * offering something it has no way to deliver.
     */
    pick: (n: number) => string;
    opening: string;
    preparing: string;
    tapHere: string;
    /** {@link AppCopy.capture.tapHere}'s other half, for the picker. */
    clickToPick: string;
    oneMoment: string;
    /**
     * The left pill on the viewfinder. It says what the user *has* ("já tenho
     * a foto") rather than where it lives ("galeria"): people who arrive with
     * a photo already on the phone do not think of it as a place.
     */
    gallery: string;
    /** The pill's full name — the label alone does not say what will happen. */
    galleryAria: string;
    videoLabel: string;
    tapToCapture: string;
    sheetFound: string;
    aimAtDocument: string;
    fitWholePage: string;
    edgesNotFound: string;
    /** The only live hint that still earns a chip — see `lib/hints.ts`. */
    lowLight: string;
    /**
     * The one tip the stuck-detector box shows. It was two sentences on two
     * lines; over a viewfinder, where the box is stealing height from the
     * thing the user is trying to aim, two lines read as a lecture.
     */
    tip: string;
    captured: (n: number) => string;
    atCapacity: (max: number) => string;
    capacityFallback: string;
    railLabel: string;
    railEmpty: string;
    tileLabel: (n: number, verdict: string) => string;
    sheetCount: (n: number) => string;
    /**
     * The flagged-sheet line above the rail, which sits in a line-box of fixed
     * height so that having something to say cannot resize the viewfinder.
     * **Keep it to one line at 320 px** — around 40 mono characters at the
     * largest count (20 sheets). It ends without a full stop and without "para
     * ver"/"to see" for that reason: the rail is right underneath it.
     */
    needAttention: (n: number) => string;
    announce: (n: number, verdict: string, total: number) => string;
    /** The onward pill's mono overline — the step it leads to. */
    nextOverline: string;
    /** Its visible word. */
    nextLabel: string;
    /**
     * Its accessible name. The pill shows two short lines; the sheet count
     * lives in the header, where a screen-reader user is not looking when they
     * reach the control, so it is spoken here.
     */
    nextAria: (sheets: number) => string;
    preparingCamera: string;
  };

  confirm: {
    title: string;
    help: string;
    slotCaption: string;
    confirmCta: string;
    savingCta: string;
    retakeCta: string;
    /**
     * "Use the whole photo": the escape hatch for a picture that is already
     * cropped — a gallery pick of a scan someone else made, usually — where
     * there are no corners to find because the photo's own corners are the
     * page's. Deliberately the quietest control on the screen: it is right
     * sometimes, and confirming the corners is right the rest of the time.
     */
    wholeCta: string;
    dialogLabel: (n: number) => string;
    unavailableTitle: string;
    unavailableBody: string;
    announceReady: string;
    announceDone: (n: number) => string;
  };

  review: {
    title: string;
    /**
     * The dismissible card at the top of the list, shown until the user has
     * either dismissed it or edited a page. It teaches the one gesture the list
     * cannot show: the row is a door.
     */
    tip: string;
    dismissTip: string;
    /**
     * The single mono word under a page's name. Short by contract — the row is
     * 375 px wide and the word shares it with a thumbnail, two arrows and a
     * chevron — and lowercase, because it is a label rather than a verdict.
     */
    state: {
      ok: string;
      processing: string;
      unverified: string;
      /** scanic found no outline: the one state with an obvious next step. */
      noCorners: string;
      failed: string;
    };
    blockedNotice: string;
    /** Its accessible name: the two-line label is not a sentence. */
    addPage: string;
    /** The footer's two square offers, each drawn on two lines. */
    footer: {
      preview: readonly [string, string];
      add: readonly [string, string];
    };
    next: string;
    preparing: string;
    emptyTitle: string;
    emptyBody: string;
    open: (n: number, verdict: string) => string;
    moveUp: (n: number) => string;
    moveDown: (n: number) => string;
    announceBlocked: (n: number) => string;
    announceWorking: string;
    announceReady: (n: number) => string;
  };

  gerar: {
    title: string;
    /** The screen's one question, above the grid of markings. */
    question: string;
    /** The grid's accessible name — it is a radio group, not six buttons. */
    markGroup: string;
    /** One word per marking. These become the file name's suffix, slugged. */
    marks: Record<DocumentMark, string>;
    previewCta: string;
    generate: string;
    preparing: string;
    blocked: (n: number) => string;
    /** The details list: "arquivo", "páginas", "tamanho estimado". */
    detailFile: string;
    statPages: string;
    statSize: string;
    /** The one way into free text — there is no name field on the screen. */
    edit: string;
    editAria: string;
    /** The bottom sheet behind "✎ editar". */
    rename: {
      title: string;
      label: string;
      /** Why the field is shorter than the file name it changes. */
      note: string;
      cancel: string;
      save: string;
    };
    stillWorking: string;
    nothingReadyTitle: string;
    nothingReadyBody: string;
    announce: (n: number) => string;
  };

  pdfPreview: {
    title: string;
    claim: string;
    previous: string;
    next: string;
    back: string;
    confirm: string;
    orientation: (landscape: boolean) => string;
    announce: (n: number, total: number) => string;
    firstPageAlt: (n: number) => string;
  };

  pronto: {
    building: string;
    cancelling: string;
    progressLabel: string;
    checkOcr: string;
    checkOcrPage: (n: number, total: number) => string;
    checkAssembling: string;
    stageOcr: (n: number, total: number) => string;
    stageAssembling: string;
    cancelNotice: string;
    keepScreenOn: string;
    announceCancelling: string;
    failureTitle: string;
    failureBack: string;
  };

  preview: {
    dialogLabel: (n: number) => string;
    close: string;
    /** The header's mono second line: "de 5 · exame". */
    ofTotal: (total: number, document: string) => string;
    /** What an unnamed document is called there — the name lands on step 3. */
    documentWord: string;
    /** The ⋯ button's accessible name. */
    menu: string;
    failedLine: string;
    /** The full phrase behind the `cantos` tile's one lowercase word. */
    adjustCorners: string;
    /**
     * The mono band label over the four tiles — the line where the page stops
     * being looked at and starts being changed. Written lowercase and
     * uppercased by `Meta caps`, like every other section marker.
     */
    correctLabel: string;
    /** The four tiles' visible words. One lowercase word each, by contract:
     *  four equal columns at 375 px leave ~68 px of mono text. */
    tiles: {
      rotate: string;
      corners: string;
      straighten: string;
      /** The switch's word once the page is actually wearing the correction. */
      straightenApplied: string;
      finish: string;
    };
    /**
     * The 38 px status line — the ONE place on this screen that talks about
     * state. Every sentence is composed at render from `rendered.*` and
     * {@link effectiveFinish}; none of them is ever stored.
     */
    status: {
      /** The settled page, per the finish it actually came out wearing. */
      ready: (finish: PageFinish) => string;
      /** scanic found no trustworthy outline, so the frame went in flat. */
      noCorners: string;
      /** A plain re-render (a turn, a finish change, a new crop). */
      working: string;
      /** The curvature correction is the thing taking the time. */
      straightening: string;
      /** The right-aligned mono affordance on a warned line. */
      why: string;
      /** The right-aligned mono seconds counter while work is in flight. */
      elapsed: (seconds: number) => string;
      /**
       * Narrated while the girar sheet is open, in place of the verdict:
       * "Girando para a direita — 90°."
       *
       * The direction is the word the tapped button wears
       * ({@link AppCopy.girar.left} / `right`) rather than a re-translation of
       * it, and the degrees are the turn the page lands on — the same number
       * {@link AppCopy.girar.current} shows inside the sheet.
       */
      turning: (direction: string, degrees: number) => string;
    };
    /**
     * The card between the sheet and the tiles — the band that is allowed to
     * appear and disappear, because it only exists when one line is not enough.
     */
    cards: {
      noCorners: string;
      failed: string;
    };
    /** The pager, on a document of more than one page. */
    pager: {
      previous: string;
      next: string;
      /** "3 / 5" */
      count: (n: number, total: number) => string;
      thumb: (n: number) => string;
    };
    /** Press-and-hold: the same page with the improvements left out. */
    compare: string;
    compareHint: string;
    /**
     * The one-time hint under the compare chip, shown the first time a page has
     * something to compare against and never again (`lib/tips.ts`).
     *
     * It says "hold **and release**" because a tester pressed the chip
     * expecting a toggle and got a flicker: the control is a hold, and the one
     * sentence that prevents that reading is the one that names both halves of
     * the gesture.
     */
    holdTip: string;
    /**
     * "O que são as melhorias" — the `?` beside the improve row.
     *
     * It exists because this row now offers two very different things under one
     * word, and one of them collides with a label the app already uses:
     * "Endireitar" is about the sheet's *curve*, while the "já endireitada" chip
     * over the picture is about the crop the app did by itself at capture. The
     * sheet says both out loud rather than leaving the reader to guess.
     */
    about: {
      title: string;
      dewarpTitle: string;
      /** What it does, how it differs from the automatic crop, and the honest
       *  part: some pages come out better without it, and those keep the
       *  original. */
      dewarpBody: string;
      finishTitle: string;
      /** One line above the finish names, which are reused verbatim from
       *  {@link AppCopy.finish} rather than written twice. */
      finishIntro: string;
      /** The gesture, said once more for whoever missed the hint. */
      holdNote: string;
    };
    /**
     * The full-resolution view of the page's own `final` — the exact JPEG the
     * PDF will carry, so the quality being judged is the quality that ships.
     */
    full: {
      /** The `⤢ ver inteira` pill that opens it. */
      open: string;
      label: (n: number) => string;
      /** The header's own screen title. */
      title: string;
      /** The ← back button's accessible name. */
      close: string;
      /**
       * The header's mono second line: "página 1 de 2 · 100%". The zoom half
       * is one of the two words below — a state, not the control.
       */
      position: (n: number, total: number, zoom: string) => string;
      zoomActual: string;
      zoomFit: string;
      /** Toggles fit ↔ 1:1. Two words, because it is one control. */
      actualSize: string;
      fitToScreen: string;
      hint: string;
      /** The footer's outline exit, back to the editor's own bands. */
      correct: string;
      /** The footer when there is no editor primary to mirror. */
      back: string;
    };
    /**
     * "Endireitar a folha curvada" — the per-page beta control.
     *
     * Descriptive, never diagnostic, and never a promise: the words say what
     * the app will *try*, and {@link AppCopy.preview.dewarp.outcomes} is the
     * other half of the same honesty — what actually happened, per bucket.
     */
    dewarp: {
      label: string;
      /** What kind of page it is for. */
      help: string;
      /**
       * What to do next, for the two outcomes that are worth retrying.
       *
       * It is what the explanation card says *instead of* the outcome sentence
       * there: the status line already carries that sentence and already
       * announces it, so the card would be the same words twice on one screen
       * and two live regions saying them for one event. The card keeps the
       * support code, which is the half a screenshot needs.
       */
      retryHint: string;
      /**
       * The whole of what is downloaded, said once per session before anything
       * is fetched: the size, that the cache may lose it, and that the picture
       * stays here.
       */
      consent: string;
      /**
       * The same paragraph when the model is already on the device — the
       * download is not a cost the user is being asked to accept any more,
       * because there is no download.
       */
      consentCached: string;
      /**
       * The same paragraph on mobile data, or on a connection the browser
       * refuses to name (every iPhone). One added sentence: Wi-Fi is better,
       * because on a plan these megabytes are the user's own.
       */
      consentMetered: string;
      consentConfirm: string;
      /** The confirm when the model is already here — nothing to download. */
      consentConfirmCached: string;
      consentCancel: string;
      /** One short word per engine phase; several phases share a word. */
      phases: Record<DewarpPhase, string>;
      /** "3,1 MB de 16,0 MB" — the two sizes are already formatted. */
      downloaded: (received: string, total: string) => string;
      cancel: string;
      /** The cancel was tapped and the run is unwinding — instant, honest. */
      cancelling: string;
      /**
       * One sentence per outcome bucket, never a technical reason.
       * `better-flat` is a confirmation, not a warning: the A/B ran and kept
       * the better image. Only `download` and `transient` earn the warn tone,
       * because only they are worth a retry.
       */
      outcomes: Record<
        "better-flat" | "unverified" | "page" | "download" | "transient",
        string
      >;
      /** This device missed the budget twice; the control is off for the session. */
      unavailable: string;
      /**
       * `?debug=1` only (`lib/debug-metrics.ts`'s sticky flag): the report
       * behind a paused or failed correction, which the user-facing sentence
       * deliberately does not carry. Dev-facing — the report body itself is
       * the engine's own vocabulary and is not translated.
       */
      diagnostics: {
        title: string;
        /** Says the report stays on the device until it is copied out. */
        intro: string;
        copy: string;
        /** Shown for a moment once the clipboard took it. */
        copied: string;
        /** While the report is still being collected. */
        empty: string;
      };
      /**
       * The two-control field comparison's names — **not rendered by any build
       * today**. The uvdoc tile was pulled from the page view, so the
       * "ab" build now draws the classical control alone, under the plain
       * {@link AppCopy.preview.tiles}. The engine layer still knows both
       * modes, so this copy is kept for the day the comparison comes back
       * rather than re-invented then. "IA"/"AI" and "nova"/"new" are dev-facing
       * beta labels; that build is never shipped to patients.
       */
      ab: {
        /** uvdoc's tile — "Curvatura · IA". Gated by consent, same as today. */
        ia: string;
        /** the classical engine's tile — "Curvatura · nova". No consent. */
        nova: string;
      };
    };
    retake: string;
    useAsIs: string;
    /** The primary on any page but the last one of a multi-page document. */
    nextPage: string;
    /** The primary while a render runs — inert, and saying why. */
    oneMoment: string;
    closeAction: string;
    /** The ⋯ menu's three rows. */
    menuItems: {
      about: string;
      /** `?debug=1` only. Dev-facing, and the sheet behind it is untranslated. */
      diagnostics: string;
      remove: string;
    };
    /**
     * The confirmation the ⋯ menu opens. It states the consequence — what the
     * document is left with — rather than asking "are you sure?".
     */
    confirmDelete: {
      title: (n: number) => string;
      /**
       * `remaining` is what the document is left with. Zero has its own
       * sentence: "o PDF fica com 0 páginas" is a count nobody thinks in, and
       * what actually happens there is that the document ends.
       */
      body: (remaining: number) => string;
      confirm: string;
      keep: string;
    };
  };

  /** The rotate sheet: one button per direction, with the destination written. */
  girar: {
    title: string;
    dialogLabel: (n: number) => string;
    left: string;
    right: string;
    leftAria: (rotation: string) => string;
    rightAria: (rotation: string) => string;
    /** "giro atual: 90°" */
    current: (degrees: number) => string;
    /** Back to the turn the page had when the sheet opened. */
    undo: string;
    save: string;
    announce: (n: number, rotation: string) => string;
  };

  finish: {
    title: string;
    dialogLabel: (n: number) => string;
    labels: Record<PageFinish, string>;
    help: Record<PageFinish, string>;
    /** "Aplicar clarear" — the CTA carries the choice, per the design. */
    apply: (label: string) => string;
    announce: (n: number, finish: string) => string;
  };

  corners: {
    title: string;
    dialogLabel: (n: number) => string;
    instruction: string;
    unavailableTitle: string;
    unavailableBody: string;
    cropping: string;
    confirmCta: string;
    /** The two pills under the photo. */
    whole: string;
    reset: string;
    /** The ← in the header, and the footer's outline exit. */
    back: string;
    backCta: string;
    /**
     * The four drag handles' accessible names.
     *
     * scanic draws the handles and names them in English with no option to say
     * otherwise, so the app renames them after the editor is built
     * (`lib/flatten.ts`'s `localizeCornerHandles`). They are the only words on
     * these two screens that come from the library rather than from here.
     */
    handles: Record<CornerHandleKey, string>;
  };

  retake: {
    dialogLabel: (n: number) => string;
    title: (n: number) => string;
    lead: string;
    /** The viewfinder pill that abandons the retake. */
    cancelAria: (n: number) => string;
    chooseLabel: string;
    optionOld: string;
    optionNew: string;
    cardOld: string;
    cardNew: string;
    badgeNew: string;
    newAlt: string;
    useNew: string;
    keepOld: string;
    takeAnother: string;
  };


  tiles: {
    chip: {
      ok: string;
      /** The gate could not measure the capture — a fact, not a verdict. */
      unverified: string;
      blurry: string;
      tooSmall: string;
      processing: string;
      retry: string;
    };
    detail: {
      ok: string;
      unverified: string;
      blurry: string;
      tooSmall: string;
      processing: string;
    };
  };

  /**
   * The desktop mode — one page, three steps, a keyboard and a mouse.
   *
   * A section of its own rather than words borrowed from the phone screens,
   * because the register is different: a person at a desk has a file manager
   * open, drags things, and reads a line of shortcuts. Where a sentence is
   * genuinely the same one the phone already says (the page counter, the
   * finish labels, the OCR checklist), the desktop reads the existing key
   * rather than a copy of it — a second spelling of the same fact is how the
   * two versions drift.
   */
  desktop: {
    /** The three trail words. Numbered, because the trail is the navigation. */
    trail: readonly [string, string, string];
    trailLabel: string;
    /** The header's standing promise, uppercased by CSS. */
    processing: string;

    escolher: {
      kicker: string;
      title: string;
      /**
       * Both follow the host's `intake.pdf`: a line that offers PDFs to a
       * picker that refuses them is a promise the next click breaks.
       */
      lead: (pdf: boolean) => string;
      dropTitle: string;
      dropFormats: (pdf: boolean) => string;
      dropzoneLabel: string;
      pickFiles: string;
      pickFolder: string;
      /** The file card's header when the files came loose, not from a folder. */
      listLabel: string;
      /** "3 arquivos · 7,3 MB" */
      summary: (files: number, size: string) => string;
      clear: string;
      noManualCrop: string;
      conferirCta: (n: number) => string;
      /** The three ghost-numbered lines, shown only while nothing is chosen. */
      explain: readonly [string, string, string];
      /** While the batch is being opened, one file at a time. */
      opening: (done: number, total: number) => string;
      /** The one line that names every file we had to refuse, and why. */
      refused: (names: string) => string;
      /** The cap is proactive: the user is told before a file is dropped. */
      atCapacity: (max: number) => string;
    };

    conferir: {
      railTitle: string;
      /** "3 páginas · 2 prontas" */
      railSummary: (pages: number, ready: number) => string;
      addFiles: string;
      dragHint: string;
      /** The rail row's own mono line, one state per row. */
      row: {
        straightened: (finish: string) => string;
        cornersAdjusted: string;
        noEdges: string;
        processing: string;
        failed: string;
      };
      /** The status bar's one sentence. */
      status: {
        readyClean: string;
        ready: (finish: string) => string;
        noEdges: string;
        processing: string;
        failed: string;
      };
      remove: string;
      /** The four tiles. `finishShort` is the tile's own abbreviation. */
      tiles: {
        rotate: (degrees: number) => string;
        corners: string;
        straighten: string;
        straightened: string;
        finish: (label: string) => string;
      };
      finishShort: Record<PageFinish, string>;
      cantos: {
        instruction: string;
        cancel: string;
        confirm: string;
        working: string;
        unavailable: string;
      };
      acabamento: {
        title: string;
        close: string;
        /** One line per option, said the way the design says it. */
        notes: Record<PageFinish, string>;
      };
      previous: string;
      next: string;
      shortcuts: string;
      goGerar: string;
      empty: string;
      /** The confirm before a page goes away — it states the consequence. */
      removeDialog: {
        title: (n: number) => string;
        body: (remaining: number) => string;
        confirm: string;
        keep: string;
      };
    };

    gerar: {
      kicker: string;
      title: string;
      nameLabel: string;
      /** The field's accessible name: the date prefix is not in it. */
      nameField: string;
      namePrefixLabel: string;
      backToConferir: string;
      previewLabel: string;
      rowPages: string;
      rowSize: string;
      rowGeometry: string;
      /**
       * What the page geometry really is. The artboard said "A4 · retrato";
       * this product cuts every PDF page to its own image, so it says so.
       */
      geometryValue: string;
      makingTitle: string;
      checkStraightened: string;
      checkContrast: string;
      doneKicker: string;
      /**
       * Where the file was made — and nothing about where it goes next. The
       * library ends at `onComplete`; what the host does with the file (send
       * it, attach it, store it) is the host's to say, so no line here may
       * promise that nothing is sent, nor point at a downloads folder.
       */
      trust: string;
    };
  };

  /** Why a page could not be prepared. */
  pageErrors: Record<PageErrorCode, string>;
  /** Why a build stopped. */
  buildErrors: Record<BuildErrorCode, string>;
  /** How a page is sitting, for the screen reader. */
  rotations: Record<PageRotation, string>;
}

const PT: AppCopy = {
  common: {
    back: "voltar",
    close: "Fechar",
    cancel: "Cancelar",
    retry: "Tentar de novo",
    discard: "Descartar",
    camera: "câmera",
    stepOfThree: (step) => `Passo ${step} de 3`,
    steps: ["fotografar", "conferir", "gerar"],
    page: (n) => `Página ${n}`,
    pageOfTotal: (n, total) => `página ${n} de ${total}`,
    pagesShort: (n) => `${n} pág.`,
    pages: (n) => `${n} ${n === 1 ? "página" : "páginas"}`,
    loadingPage: "Carregando a página…",
    openingPhoto: "abrindo sua foto…",
    magnifyHint: "segure um ponto para ampliar",
  },

  lang: {
    label: "Idioma",
    hint: "idioma",
  },

  primer: {
    title: "Permissão da câmera",
    heading: "O celular vai pedir acesso à câmera.",
    headingDenied: "A câmera está bloqueada neste site.",
    body: "É a câmera que fotografa a folha. Sem ela não dá para escanear.",
    bodyDenied:
      "O celular não vai perguntar de novo sozinho. Dá para liberar nas configurações do navegador — ou usar uma foto que você já tem.",
    allowLead: "Toque em ",
    allowWord: "Permitir",
    allowTail: " na janela do sistema.",
    unlockLead: "Abra o cadeado ao lado do endereço e libere a ",
    unlockWord: "câmera",
    unlockTail: ".",
    stays: "As fotos são processadas no aparelho.",
    revoke: "Você pode revogar o acesso quando quiser.",
    galleryWorks: "Ou siga pela galeria, aqui embaixo. Funciona igual.",
    ctaAllow: "Permitir a câmera",
    ctaAllowDenied: "Tentar a câmera mesmo assim",
    ctaGallery: "Escolher da galeria",
    preparing: "Preparando a foto…",
    galleryNote:
      "Se já tiver fotos na galeria, dá para usá-las em vez da câmera.",
    galleryFailed: "Não conseguimos usar essa foto. Vamos tentar de novo?",
  },

  capture: {
    take: (n) => `Fotografar página ${n}`,
    pick: (n) => `Escolher imagem da página ${n}`,
    opening: "Abrindo a câmera…",
    preparing: "Preparando a foto…",
    tapHere: "toque aqui",
    clickToPick: "clique para selecionar o arquivo",
    oneMoment: "só um instante",
    gallery: "Já tenho a foto",
    galleryAria: "Usar uma foto que já está no aparelho",
    videoLabel: "Imagem da câmera",
    tapToCapture: "toque na tela para capturar",
    sheetFound: "folha encontrada",
    aimAtDocument: "aponte para o documento",
    fitWholePage: "encaixe a página inteira",
    edgesNotFound: "não achei as bordas",
    lowLight: "Pouca luz — procure um lugar mais claro",
    tip: "Apoie o papel numa superfície lisa, acenda a luz e afaste o celular até a folha inteira caber.",
    captured: (n) => `Página ${n} capturada`,
    atCapacity: (max) =>
      `Por enquanto cabem ${max} páginas por documento. Conclua este e comece outro — leva menos de um minuto.`,
    capacityFallback: "Você já tem o máximo de páginas por documento.",
    railLabel: "Páginas fotografadas",
    railEmpty: "suas páginas vão aparecer aqui",
    tileLabel: (n, verdict) => `Página ${n} — ${verdict}. Toque para ver.`,
    sheetCount: (n) => (n === 0 ? "nenhuma folha" : `${n} ${n === 1 ? "folha" : "folhas"}`),
    needAttention: (n) =>
      n === 1
        ? "1 folha merece atenção — toque nela"
        : `${n} folhas merecem atenção — toque nelas`,
    announce: (n, verdict, total) =>
      `Página ${n}: ${verdict}. ${total} ${total === 1 ? "página" : "páginas"} no total.`,
    nextOverline: "PASSO 2",
    nextLabel: "seguir →",
    nextAria: (sheets) =>
      `Seguir para o passo 2 — ${sheets} ${sheets === 1 ? "folha" : "folhas"}`,
    preparingCamera: "preparando a câmera…",
  },

  confirm: {
    title: "Confirme os cantos",
    help: "Arraste se algum canto estiver fora da folha.",
    slotCaption: "a página confirmada entra na galeria",
    confirmCta: "Confirmar cantos",
    savingCta: "Guardando…",
    retakeCta: "Refazer foto",
    wholeCta: "Usar a foto inteira",
    dialogLabel: (n) => `Confirme os cantos da página ${n}`,
    unavailableTitle: "Não dá para conferir esta foto",
    unavailableBody:
      "Não conseguimos abrir a foto neste aparelho. Refaça a foto — leva alguns segundos.",
    announceReady: "Confira os quatro cantos da folha.",
    announceDone: (n) => `Página ${n} confirmada.`,
  },

  review: {
    title: "Confira suas páginas",
    tip: "Toque numa página para girar, clarear ou ajustar os cantos.",
    dismissTip: "Dispensar a dica",
    state: {
      ok: "ótima",
      processing: "preparando…",
      unverified: "não verificada",
      noCorners: "bordas não encontradas",
      failed: "não deu certo",
    },
    blockedNotice: "Resolva as páginas com problema antes de gerar o PDF",
    addPage: "Fotografar mais uma página",
    footer: {
      preview: ["prévia", "do PDF"],
      add: ["mais uma", "página"],
    },
    next: "Ir para o passo 3",
    preparing: "Preparando suas páginas…",
    emptyTitle: "Nenhuma página ainda",
    emptyBody: "Volte e fotografe a primeira página — leva alguns segundos.",
    open: (n, verdict) => `Abrir a página ${n} — ${verdict}`,
    moveUp: (n) => `Subir a página ${n}`,
    moveDown: (n) => `Descer a página ${n}`,
    announceBlocked: (n) =>
      `${n} ${n === 1 ? "página com problema" : "páginas com problema"}. Resolva antes de gerar o PDF.`,
    announceWorking: "Ainda estamos preparando suas páginas.",
    announceReady: (n) =>
      `${n} ${n === 1 ? "página pronta" : "páginas prontas"}.`,
  },

  gerar: {
    title: "Gerar o PDF",
    question: "O que você escaneou?",
    markGroup: "O que você escaneou",
    marks: {
      exame: "exame",
      receita: "receita",
      vacina: "vacina",
      laudo: "laudo",
      atestado: "atestado",
      outro: "outro",
    },
    previewCta: "Ver prévia do PDF",
    generate: "Gerar PDF",
    preparing: "Preparando suas páginas…",
    blocked: (n) =>
      n === 1
        ? "1 página não ficou pronta. Volte ao passo 2 e resolva antes de gerar."
        : `${n} páginas não ficaram prontas. Volte ao passo 2 e resolva antes de gerar.`,
    detailFile: "arquivo",
    statPages: "páginas",
    statSize: "tamanho estimado",
    edit: "editar",
    editAria: "Escrever outro nome para o arquivo",
    rename: {
      title: "Escrever outro nome",
      label: "Nome do arquivo",
      note: "a data e a hora continuam na frente do nome",
      cancel: "Cancelar",
      save: "Salvar nome",
    },
    stillWorking: "Ainda estamos preparando uma das páginas. Só um instante.",
    nothingReadyTitle: "Nenhuma página pronta",
    nothingReadyBody:
      "Volte ao passo 2 e resolva as páginas que ficaram com problema.",
    announce: (n) =>
      `${n} ${n === 1 ? "página pronta" : "páginas prontas"} para gerar.`,
  },

  pdfPreview: {
    title: "Prévia do PDF",
    claim: "É assim que o arquivo vai sair: uma página por foto, nesta ordem.",
    previous: "Página anterior",
    next: "Próxima página",
    back: "Voltar e corrigir uma página",
    confirm: "Confirmar e gerar",
    orientation: (landscape) => `página · ${landscape ? "paisagem" : "retrato"}`,
    announce: (n, total) => `Prévia da página ${n} de ${total}.`,
    firstPageAlt: (n) => `Página ${n} do PDF`,
  },

  pronto: {
    building: "Montando seu PDF",
    cancelling: "Cancelando…",
    progressLabel: "Progresso",
    checkOcr: "lendo o texto das páginas",
    checkOcrPage: (n, total) => `lendo o texto da página ${n} de ${total}`,
    checkAssembling: "montando o arquivo",
    stageOcr: (n, total) => `Lendo o texto — página ${n} de ${total}…`,
    stageAssembling: "Montando seu PDF…",
    cancelNotice:
      "Vamos parar assim que a página atual terminar. Suas fotos continuam aqui.",
    keepScreenOn:
      "Isso acontece no seu celular. Pode deixar a tela ligada até terminar.",
    announceCancelling: "Cancelando a geração do PDF.",
    failureTitle: "Não conseguimos terminar",
    failureBack: "Voltar para minhas páginas",
  },

  preview: {
    dialogLabel: (n) => `Página ${n} ampliada`,
    close: "Fechar a visualização",
    ofTotal: (total, document) => `de ${total} · ${document}`,
    documentWord: "documento",
    menu: "Mais opções desta página",
    failedLine: "Esta página falhou — tente de novo.",
    adjustCorners: "Ajustar cantos",
    correctLabel: "corrigir",
    tiles: {
      rotate: "girar",
      corners: "cantos",
      straighten: "endireitar",
      straightenApplied: "endireitada",
      finish: "acabamento",
    },
    status: {
      ready: (finish) =>
        finish === "original"
          ? "Endireitada. Acabamento: original."
          : finish === "bw"
            ? "Endireitada e em preto e branco. Pode usar assim."
            : "Endireitada e clareada. Pode usar assim.",
      noCorners: "Não achei as bordas da folha.",
      working: "Preparando a folha…",
      straightening: "Endireitando a folha…",
      why: "por quê?",
      elapsed: (seconds) => `${seconds} s`,
      turning: (direction, degrees) =>
        `Girando para a ${direction} — ${degrees}°.`,
    },
    cards: {
      noCorners:
        "A folha ficou muito perto da borda da foto. Você pode marcar os cantos na mão ou usar a página como ela está.",
      failed:
        "Não conseguimos preparar esta página. Tente de novo ou refaça a foto.",
    },
    pager: {
      previous: "Página anterior",
      next: "Próxima página",
      count: (n, total) => `${n} / ${total}`,
      thumb: (n) => `Ir para a página ${n}`,
    },
    // Deliberately not "original": what it shows is the photo without the
    // clareamento, and that photo is already the app's own JPEG of the frame —
    // not the untouched thing the camera sensor saw.
    compare: "Sem melhorias",
    compareHint: "Segure para ver a foto sem as melhorias.",
    holdTip: "segure e solte para comparar",
    about: {
      title: "As melhorias desta página",
      dewarpTitle: "Endireitar",
      dewarpBody:
        "Tira a curva da folha — a barriga de uma página de livro ou de um " +
        "papel que não fica reto. É diferente do endireitamento automático: " +
        "assim que você fotografa, o app já recorta a folha pelos cantos e " +
        "corrige a inclinação, e é isso que a etiqueta “já endireitada” quer " +
        "dizer. O Endireitar cuida da curva que sobra depois disso. Em algumas " +
        "páginas o resultado fica pior; quando isso acontece, o app avisa e " +
        "mantém a original. Tudo é feito no seu aparelho.",
      finishTitle: "Acabamento",
      finishIntro:
        "Muda a luz e a tinta da folha, nunca o formato. Também é onde você " +
        "gira a página.",
      holdNote: "Segure a página para ver como ela estava antes das melhorias.",
    },
    full: {
      open: "ver inteira",
      label: (n) => `Página ${n} em tamanho real`,
      title: "Folha inteira",
      close: "Voltar para a página",
      position: (n, total, zoom) => `página ${n} de ${total} · ${zoom}`,
      zoomActual: "100%",
      zoomFit: "na tela",
      actualSize: "Tamanho real",
      fitToScreen: "Caber na tela",
      hint: "Toque duas vezes para aproximar e conferir o texto miúdo.",
      correct: "Corrigir esta página",
      back: "Voltar",
    },
    dewarp: {
      label: "Endireitar a folha curvada",
      help: "Para folha de livro ou papel que não fica reto.",
      retryHint: "Dá para tentar de novo: toque em endireitar.",
      consent:
        `Baixa um modelo de ${DEWARP_ASSET_SIZE_LABEL} uma vez para endireitar ` +
        "folhas curvadas neste aparelho. A melhoria leva alguns segundos por " +
        "página. A imagem não sai do aparelho.",
      consentCached:
        "O modelo já está neste aparelho — ativar agora não baixa nada. " +
        "A melhoria leva alguns segundos por página. " +
        "A imagem não sai do aparelho.",
      consentMetered:
        `Baixa um modelo de ${DEWARP_ASSET_SIZE_LABEL} uma vez para endireitar ` +
        "folhas curvadas neste aparelho. Melhor no Wi-Fi: nos dados móveis esse " +
        "download conta no seu plano. A melhoria leva alguns segundos por " +
        "página. A imagem não sai do aparelho.",
      consentConfirm: "Baixar e endireitar",
      consentConfirmCached: "Endireitar",
      consentCancel: "Agora não",
      phases: {
        checking: "preparando…",
        downloading: "baixando…",
        initializing: "preparando…",
        inferring: "endireitando…",
        validating: "conferindo…",
        rendering: "endireitando…",
      },
      downloaded: (received, total) => `${received} de ${total}`,
      cancel: "Cancelar",
      cancelling: "cancelando…",
      outcomes: {
        "better-flat": "Conferimos: esta página fica melhor como está.",
        unverified:
          "Mantivemos a página como estava — não deu para conferir se a " +
          "melhoria ajudaria.",
        page: "Esta página ficou melhor sem a melhoria — mantivemos a original.",
        download:
          "Não deu para baixar o arquivo da melhoria. Confira a conexão e " +
          "tente de novo.",
        transient:
          "Algo deu errado e a página foi mantida como estava. " +
          "Dá para tentar de novo.",
      },
      unavailable:
        "A melhoria de curvatura não deu conta neste aparelho e foi pausada.",
      diagnostics: {
        title: "Diagnóstico da curvatura",
        intro:
          "Relatório técnico deste aparelho. Nada sai daqui até você copiar — " +
          "copie e mande para quem estiver ajudando.",
        copy: "Copiar",
        copied: "copiado",
        empty: "Nada registrado ainda.",
      },
      ab: {
        ia: "Curvatura · IA",
        nova: "Curvatura · nova",
      },
    },
    retake: "Refazer",
    useAsIs: "Usar assim",
    nextPage: "Próxima página",
    oneMoment: "Um instante…",
    closeAction: "Fechar",
    menuItems: {
      about: "Sobre as melhorias",
      diagnostics: "Detalhes técnicos",
      remove: "Apagar a página",
    },
    confirmDelete: {
      title: (n) => `Apagar a página ${n}?`,
      body: (remaining) =>
        remaining === 0
          ? "A foto sai do documento e ele fica vazio. Não tem como voltar atrás."
          : `A foto sai do documento e o PDF fica com ${remaining} ${
              remaining === 1 ? "página" : "páginas"
            }. Não tem como voltar atrás.`,
      confirm: "Apagar a página",
      keep: "Manter",
    },
  },

  girar: {
    title: "Girar a folha",
    dialogLabel: (n) => `Girar a página ${n}`,
    left: "esquerda",
    right: "direita",
    leftAria: (rotation) =>
      `Girar a página para a esquerda — agora ${rotation}`,
    rightAria: (rotation) => `Girar a página para a direita — agora ${rotation}`,
    current: (degrees) => `giro atual: ${degrees}°`,
    undo: "desfazer",
    save: "Salvar giro",
    announce: (n, rotation) => `Página ${n} ${rotation}.`,
  },

  finish: {
    title: "Acabamento da folha",
    dialogLabel: (n) => `Acabamento da página ${n}`,
    labels: {
      original: "original",
      clean: "clarear",
      bw: "preto e branco",
    },
    help: {
      original: "A foto como saiu da câmera, sem melhorias de luz.",
      clean: "Tira a sombra e deixa o papel branco. É o que a maioria usa.",
      bw: "Só preto e branco — bom para fotocópia sem graça.",
    },
    apply: (label) => `Aplicar ${label}`,
    announce: (n, finish) => `Página ${n}, acabamento ${finish}.`,
  },

  corners: {
    title: "Cantos da folha",
    dialogLabel: (n) => `Ajustar os cantos da página ${n}`,
    instruction: "Arraste até as quatro pontas do papel.",
    unavailableTitle: "Não dá para ajustar esta página",
    unavailableBody:
      "Não conseguimos abrir a foto original neste aparelho. Você pode refazer a foto — leva alguns segundos.",
    cropping: "Recortando…",
    confirmCta: "Usar estes cantos",
    whole: "folha inteira",
    reset: "recomeçar",
    back: "Voltar sem mudar os cantos",
    backCta: "Voltar",
    handles: {
      topLeft: "Canto de cima, à esquerda",
      topRight: "Canto de cima, à direita",
      bottomRight: "Canto de baixo, à direita",
      bottomLeft: "Canto de baixo, à esquerda",
    },
  },

  retake: {
    dialogLabel: (n) => `Refazer a página ${n}`,
    title: (n) => `Refazer a página ${n}`,
    lead: "Sem pressa — depois você escolhe qual das duas fica.",
    cancelAria: (n) => `Cancelar e manter a página ${n} como está`,
    chooseLabel: "Escolha a foto",
    optionOld: "A que eu tinha",
    optionNew: "A nova",
    cardOld: "A que você já tinha",
    cardNew: "A nova",
    badgeNew: "acabou de sair",
    newAlt: "A nova foto desta página",
    useNew: "Usar a foto nova",
    keepOld: "Manter a que eu tinha",
    takeAnother: "Tirar outra foto",
  },


  tiles: {
    chip: {
      ok: "Nítida",
      unverified: "Não verificada",
      blurry: "Tremida",
      tooSmall: "Letras pequenas",
      processing: "Preparando…",
      retry: "Tentar de novo",
    },
    detail: {
      // Says what the gate measured — sharpness and letter size — and stops
      // there. "Dá para ler tudo" was a readability promise two numbers cannot
      // make.
      ok: "Nítida e com letras em bom tamanho — vale conferir antes de gerar o PDF.",
      unverified:
        "Não conseguimos verificar esta página — dê uma olhada antes de continuar.",
      blurry: "Ficou um pouco tremida. Quer tentar de novo?",
      tooSmall: "As letras ficaram pequenas — quer chegar mais perto?",
      processing: "Estamos endireitando e clareando esta página.",
    },
  },

  desktop: {
    trail: ["1 escolher", "2 conferir", "3 gerar"],
    trailLabel: "Os três passos",
    processing: "processamento neste computador",

    escolher: {
      kicker: "passo 1 de 3",
      title: "Traga o documento para cá.",
      lead: (pdf) =>
        pdf
          ? "Fotos do celular, imagens digitalizadas ou PDFs. Cada imagem vira uma página."
          : "Fotos do celular ou imagens digitalizadas. Cada imagem vira uma página.",
      dropTitle: "Solte os arquivos aqui",
      dropFormats: (pdf) =>
        pdf
          ? "JPG, PNG, HEIC ou PDF · uma pasta inteira mantém a ordem dos nomes"
          : "JPG, PNG ou HEIC · uma pasta inteira mantém a ordem dos nomes",
      dropzoneLabel: "Escolher arquivos do computador",
      pickFiles: "Escolher arquivos",
      pickFolder: "Escolher uma pasta",
      listLabel: "Arquivos escolhidos",
      summary: (files, size) =>
        `${files} ${files === 1 ? "arquivo" : "arquivos"} · ${size}`,
      clear: "limpar",
      noManualCrop: "Sem recorte manual: o passo 2 endireita e limpa cada folha.",
      conferirCta: (n) => `Conferir ${n} ${n === 1 ? "página" : "páginas"}`,
      explain: [
        "Cada imagem vira uma página do PDF, na ordem dos nomes.",
        "No passo 2 você confere página por página e corrige o que precisar.",
        "Tudo roda neste computador. Nada fica guardado depois que você fecha.",
      ],
      opening: (done, total) => `Abrindo ${done} de ${total}…`,
      refused: (names) => `Não conseguimos abrir: ${names}.`,
      atCapacity: (max) =>
        `Um documento vai até ${max} páginas. As que passaram disso ficaram de fora.`,
    },

    conferir: {
      railTitle: "Páginas",
      railSummary: (pages, ready) =>
        `${pages} ${pages === 1 ? "página" : "páginas"} · ${ready} ${
          ready === 1 ? "pronta" : "prontas"
        }`,
      addFiles: "Adicionar arquivos",
      dragHint: "arraste para reordenar · alt + ↑ ↓ no teclado",
      row: {
        straightened: (finish) => `endireitada · ${finish}`,
        cornersAdjusted: "cantos ajustados",
        noEdges: "bordas não encontradas",
        processing: "preparando",
        failed: "não ficou pronta",
      },
      status: {
        readyClean: "Endireitada e clareada. Pode usar assim.",
        ready: (finish) => `Endireitada. Acabamento: ${finish}.`,
        noEdges:
          "Não achei as bordas da folha. Marque os cantos na mão ou use como está.",
        processing: "Preparando esta página…",
        failed: "Esta página não ficou pronta.",
      },
      remove: "apagar",
      tiles: {
        rotate: (degrees) => `girar · ${degrees}°`,
        corners: "cantos",
        straighten: "endireitar",
        straightened: "endireitada",
        finish: (label) => `acabamento · ${label}`,
      },
      finishShort: {
        original: "original",
        clean: "clarear",
        bw: "p&b",
      },
      cantos: {
        instruction: "Arraste os cantos até as pontas do papel.",
        cancel: "Cancelar",
        confirm: "Usar estes cantos",
        working: "Recortando…",
        unavailable: "Não conseguimos abrir a foto original desta página.",
      },
      acabamento: {
        title: "Acabamento da folha",
        close: "Fechar o acabamento",
        notes: {
          original: "Como a foto veio, sem tratamento.",
          clean: "Tira a sombra e deixa o papel branco. É o que a maioria usa.",
          bw: "Contraste máximo e arquivo menor. Bom para texto puro.",
        },
      },
      previous: "Página anterior",
      next: "Próxima página",
      shortcuts: "← → páginas · R girar · C cantos · ⌫ apagar",
      goGerar: "Ir para o passo 3",
      empty: "Nenhuma página aberta. Volte ao passo 1 e escolha os arquivos.",
      removeDialog: {
        title: (n) => `Apagar a página ${n}?`,
        body: (remaining) =>
          remaining === 0
            ? "O documento fica sem nenhuma página."
            : `O PDF fica com ${remaining} ${remaining === 1 ? "página" : "páginas"}.`,
        confirm: "Apagar a página",
        keep: "Manter",
      },
    },

    gerar: {
      kicker: "passo 3 de 3",
      title: "Gerar o PDF",
      nameLabel: "nome do arquivo",
      nameField: "Nome do arquivo, depois da data",
      namePrefixLabel: "data e hora do escaneamento",
      backToConferir: "Voltar a conferir",
      previewLabel: "prévia do PDF",
      rowPages: "páginas",
      rowSize: "tamanho estimado",
      rowGeometry: "página",
      geometryValue: "no tamanho da foto",
      makingTitle: "Montando seu PDF",
      checkStraightened: "folhas endireitadas",
      checkContrast: "contraste ajustado",
      doneKicker: "PDF pronto",
      trust: "O PDF foi montado neste computador.",
    },
  },

  pageErrors: {
    prep: "Não conseguimos preparar a foto. Tente de novo.",
    unsupported:
      "Esse tipo de foto a gente ainda não consegue ler. Tire a foto de novo pela câmera, por favor.",
    camera_waking: "A câmera ainda está acordando. Tente de novo em um instante.",
    generic: "Não conseguimos preparar esta página. Quer tentar de novo?",
  },

  buildErrors: {
    pages_failed:
      "Há páginas que não ficaram prontas. Volte e resolva cada uma antes de gerar o PDF.",
    pages_processing:
      "Ainda estamos preparando suas páginas. Tente de novo em alguns segundos.",
    no_pages: "Nenhuma página está pronta ainda.",
    pages_changed:
      "Alguma página mudou enquanto o PDF era montado. Nada se perdeu — é só gerar de novo.",
    build_failed:
      "Não conseguimos montar o PDF agora. Suas páginas continuam aqui — vamos tentar de novo?",
    // Não é falha: é papel demais para o limite de quem recebe. As páginas
    // continuam todas aqui; a tela diz quantas precisam sair.
    over_budget:
      "Este documento passou do tamanho máximo. Tente remover algumas páginas — as suas continuam todas aqui.",
  },

  rotations: {
    0: "em pé",
    90: "virada um quarto para a direita",
    180: "de cabeça para baixo",
    270: "virada um quarto para a esquerda",
  },
};

const EN: AppCopy = {
  common: {
    back: "back",
    close: "Close",
    cancel: "Cancel",
    retry: "Try again",
    discard: "Discard",
    camera: "camera",
    stepOfThree: (step) => `Step ${step} of 3`,
    steps: ["capture", "check", "create"],
    page: (n) => `Page ${n}`,
    pageOfTotal: (n, total) => `page ${n} of ${total}`,
    pagesShort: (n) => `${n} pg.`,
    pages: (n) => `${n} ${n === 1 ? "page" : "pages"}`,
    loadingPage: "Loading the page…",
    openingPhoto: "opening your photo…",
    magnifyHint: "hold a handle to magnify",
  },

  lang: {
    label: "Language",
    hint: "language",
  },

  primer: {
    title: "Camera permission",
    heading: "Your phone is about to ask for the camera.",
    headingDenied: "The camera is blocked on this site.",
    body: "The camera is what photographs the sheet. Without it there is nothing to scan.",
    bodyDenied:
      "Your phone will not ask again on its own. You can allow it in the browser settings — or use a photo you already have.",
    allowLead: "Tap ",
    allowWord: "Allow",
    allowTail: " in the system dialog.",
    unlockLead: "Open the padlock next to the address and allow the ",
    unlockWord: "camera",
    unlockTail: ".",
    stays: "The photos are processed on the device.",
    revoke: "You can revoke access whenever you want.",
    galleryWorks: "Or carry on from the gallery, below. It works the same.",
    ctaAllow: "Allow the camera",
    ctaAllowDenied: "Try the camera anyway",
    ctaGallery: "Choose from the gallery",
    preparing: "Preparing the photo…",
    galleryNote:
      "If you already have photos in the gallery, you can use those instead of the camera.",
    galleryFailed: "We could not use that photo. Shall we try again?",
  },

  capture: {
    take: (n) => `Photograph page ${n}`,
    pick: (n) => `Choose an image for page ${n}`,
    opening: "Opening the camera…",
    preparing: "Preparing the photo…",
    tapHere: "tap here",
    clickToPick: "click to select a file",
    oneMoment: "one moment",
    gallery: "I already have the photo",
    galleryAria: "Use a photo already on this device",
    videoLabel: "Camera image",
    tapToCapture: "tap the screen to capture",
    sheetFound: "sheet found",
    aimAtDocument: "point at the document",
    fitWholePage: "fit the whole page in",
    edgesNotFound: "no edges found",
    lowLight: "Low light — find a brighter spot",
    tip: "Rest the paper on a flat surface, turn on the light and move the phone back until the whole sheet fits.",
    captured: (n) => `Page ${n} captured`,
    atCapacity: (max) =>
      `For now a document holds ${max} pages. Finish this one and start another — it takes less than a minute.`,
    capacityFallback: "You already have the maximum number of pages per document.",
    railLabel: "Photographed pages",
    railEmpty: "your pages will show up here",
    tileLabel: (n, verdict) => `Page ${n} — ${verdict}. Tap to see it.`,
    sheetCount: (n) =>
      n === 0 ? "no sheets yet" : `${n} ${n === 1 ? "sheet" : "sheets"}`,
    needAttention: (n) =>
      n === 1
        ? "1 sheet deserves a look — tap it"
        : `${n} sheets deserve a look — tap them`,
    announce: (n, verdict, total) =>
      `Page ${n}: ${verdict}. ${total} ${total === 1 ? "page" : "pages"} in total.`,
    nextOverline: "STEP 2",
    nextLabel: "continue →",
    nextAria: (sheets) =>
      `Continue to step 2 — ${sheets} ${sheets === 1 ? "sheet" : "sheets"}`,
    preparingCamera: "getting the camera ready…",
  },

  confirm: {
    title: "Confirm the corners",
    help: "Drag any corner that sits outside the sheet.",
    slotCaption: "the confirmed page goes to the gallery",
    confirmCta: "Confirm corners",
    savingCta: "Saving…",
    retakeCta: "Retake photo",
    wholeCta: "Use the whole photo",
    dialogLabel: (n) => `Confirm the corners of page ${n}`,
    unavailableTitle: "This photo cannot be checked",
    unavailableBody:
      "We could not open the photo on this device. Take it again — it only takes a few seconds.",
    announceReady: "Check the four corners of the sheet.",
    announceDone: (n) => `Page ${n} confirmed.`,
  },

  review: {
    title: "Check your pages",
    tip: "Tap a page to rotate it, lighten it or adjust its corners.",
    dismissTip: "Dismiss the tip",
    state: {
      ok: "great",
      processing: "preparing…",
      unverified: "not verified",
      noCorners: "edges not found",
      failed: "did not work",
    },
    blockedNotice: "Resolve the pages with problems before creating the PDF",
    addPage: "Photograph one more page",
    footer: {
      preview: ["preview", "of the PDF"],
      add: ["one more", "page"],
    },
    next: "Go to step 3",
    preparing: "Preparing your pages…",
    emptyTitle: "No pages yet",
    emptyBody: "Go back and photograph the first page — it takes a few seconds.",
    open: (n, verdict) => `Open page ${n} — ${verdict}`,
    moveUp: (n) => `Move page ${n} up`,
    moveDown: (n) => `Move page ${n} down`,
    announceBlocked: (n) =>
      `${n} ${n === 1 ? "page has a problem" : "pages have problems"}. Resolve them before creating the PDF.`,
    announceWorking: "We are still preparing your pages.",
    announceReady: (n) => `${n} ${n === 1 ? "page" : "pages"} ready.`,
  },

  gerar: {
    title: "Create the PDF",
    question: "What did you scan?",
    markGroup: "What you scanned",
    marks: {
      exame: "exam",
      receita: "prescription",
      vacina: "vaccine",
      laudo: "report",
      atestado: "certificate",
      outro: "other",
    },
    previewCta: "See the PDF preview",
    generate: "Create PDF",
    preparing: "Preparing your pages…",
    blocked: (n) =>
      n === 1
        ? "1 page is not ready. Go back to step 2 and resolve it before creating the file."
        : `${n} pages are not ready. Go back to step 2 and resolve them before creating the file.`,
    detailFile: "file",
    statPages: "pages",
    statSize: "estimated size",
    edit: "edit",
    editAria: "Write another name for the file",
    rename: {
      title: "Write another name",
      label: "File name",
      note: "the date and time stay at the front of the name",
      cancel: "Cancel",
      save: "Save name",
    },
    stillWorking: "One of the pages is still being prepared. Just a moment.",
    nothingReadyTitle: "No page is ready",
    nothingReadyBody:
      "Go back to step 2 and resolve the pages that ran into problems.",
    announce: (n) => `${n} ${n === 1 ? "page" : "pages"} ready to create.`,
  },

  pdfPreview: {
    title: "PDF preview",
    claim: "This is how the file will come out: one page per photo, in this order.",
    previous: "Previous page",
    next: "Next page",
    back: "Go back and fix a page",
    confirm: "Confirm and create",
    orientation: (landscape) => `page · ${landscape ? "landscape" : "portrait"}`,
    announce: (n, total) => `Preview of page ${n} of ${total}.`,
    firstPageAlt: (n) => `Page ${n} of the PDF`,
  },

  pronto: {
    building: "Building your PDF",
    cancelling: "Cancelling…",
    progressLabel: "Progress",
    checkOcr: "reading the text of the pages",
    checkOcrPage: (n, total) => `reading the text of page ${n} of ${total}`,
    checkAssembling: "assembling the file",
    stageOcr: (n, total) => `Reading the text — page ${n} of ${total}…`,
    stageAssembling: "Assembling your PDF…",
    cancelNotice:
      "We will stop as soon as the current page finishes. Your photos stay here.",
    keepScreenOn:
      "This happens on your phone. You can leave the screen on until it finishes.",
    announceCancelling: "Cancelling the PDF build.",
    failureTitle: "We could not finish",
    failureBack: "Back to my pages",
  },

  preview: {
    dialogLabel: (n) => `Page ${n} enlarged`,
    close: "Close the preview",
    ofTotal: (total, document) => `of ${total} · ${document}`,
    documentWord: "document",
    menu: "More options for this page",
    failedLine: "This page failed — try again.",
    adjustCorners: "Adjust corners",
    correctLabel: "fix",
    tiles: {
      rotate: "rotate",
      corners: "corners",
      straighten: "straighten",
      straightenApplied: "straightened",
      finish: "finish",
    },
    status: {
      ready: (finish) =>
        finish === "original"
          ? "Straightened. Finish: original."
          : finish === "bw"
            ? "Straightened and in black and white. You can use it as is."
            : "Straightened and lightened. You can use it as is.",
      noCorners: "I could not find the edges of the sheet.",
      working: "Preparing the sheet…",
      straightening: "Straightening the sheet…",
      why: "why?",
      elapsed: (seconds) => `${seconds} s`,
      turning: (direction, degrees) => `Turning ${direction} — ${degrees}°.`,
    },
    cards: {
      noCorners:
        "The sheet ended up too close to the edge of the photo. You can mark the corners by hand, or use the page as it is.",
      failed:
        "We could not prepare this page. Try again, or retake the photo.",
    },
    pager: {
      previous: "Previous page",
      next: "Next page",
      count: (n, total) => `${n} / ${total}`,
      thumb: (n) => `Go to page ${n}`,
    },
    compare: "No enhancements",
    compareHint: "Press and hold to see the photo without the enhancements.",
    holdTip: "press and hold to compare",
    about: {
      title: "This page's improvements",
      dewarpTitle: "Straighten",
      dewarpBody:
        "Takes the curve out of the sheet — the belly of a page from a book, " +
        "or of paper that will not lie flat. It is not the automatic " +
        "straightening: the moment you take the photo the app already crops " +
        "the sheet by its corners and fixes the tilt, and that is what the " +
        "“already straightened” label means. Straighten deals with the curve " +
        "left over after that. On some pages the result is worse; when that " +
        "happens the app says so and keeps the original. It all runs on your " +
        "device.",
      finishTitle: "Finish",
      finishIntro:
        "Changes the light and the ink on the sheet, never its shape. It is " +
        "also where you rotate the page.",
      holdNote:
        "Hold the page to see how it looked before the improvements.",
    },
    full: {
      open: "see it whole",
      label: (n) => `Page ${n} at actual size`,
      title: "The whole sheet",
      close: "Back to the page",
      position: (n, total, zoom) => `page ${n} of ${total} · ${zoom}`,
      zoomActual: "100%",
      zoomFit: "fitted",
      actualSize: "Actual size",
      fitToScreen: "Fit to screen",
      hint: "Double-tap to zoom in and check the small print.",
      correct: "Fix this page",
      back: "Back",
    },
    dewarp: {
      label: "Straighten the curved sheet",
      help: "For a page from a book, or paper that will not lie flat.",
      retryHint: "You can try again: tap straighten.",
      consent:
        `Downloads a ${DEWARP_ASSET_SIZE_LABEL} model once to straighten curved ` +
        "sheets on this device. The improvement takes a few seconds per page. " +
        "The image never leaves the device.",
      consentCached:
        "The model is already on this device — turning it on now downloads " +
        "nothing. The improvement takes a few seconds per page. " +
        "The image never leaves the device.",
      consentMetered:
        `Downloads a ${DEWARP_ASSET_SIZE_LABEL} model once to straighten curved ` +
        "sheets on this device. Wi-Fi is better: on mobile data this download " +
        "counts against your plan. The improvement takes a few seconds per " +
        "page. The image never leaves the device.",
      consentConfirm: "Download and straighten",
      consentConfirmCached: "Straighten it",
      consentCancel: "Not now",
      phases: {
        checking: "preparing…",
        downloading: "downloading…",
        initializing: "preparing…",
        inferring: "straightening…",
        validating: "checking…",
        rendering: "straightening…",
      },
      downloaded: (received, total) => `${received} of ${total}`,
      cancel: "Cancel",
      cancelling: "cancelling…",
      outcomes: {
        "better-flat": "We checked: this page reads better as it is.",
        unverified:
          "We kept the page as it was — there was not enough to tell " +
          "whether the improvement would help.",
        page: "This page looked better without the improvement — we kept the original.",
        download:
          "The improvement could not be downloaded. Check the connection and " +
          "try again.",
        transient:
          "Something went wrong and the page was kept as it was. " +
          "You can try again.",
      },
      unavailable:
        "The curvature improvement was too slow on this device and is paused.",
      diagnostics: {
        title: "Curvature diagnostics",
        intro:
          "A technical report from this device. Nothing leaves it until you " +
          "copy — copy it and send it to whoever is helping.",
        copy: "Copy",
        copied: "copied",
        empty: "Nothing recorded yet.",
      },
      ab: {
        ia: "Curvature · AI",
        nova: "Curvature · new",
      },
    },
    retake: "Retake",
    useAsIs: "Use as is",
    nextPage: "Next page",
    oneMoment: "One moment…",
    closeAction: "Close",
    menuItems: {
      about: "About the improvements",
      diagnostics: "Technical details",
      remove: "Delete this page",
    },
    confirmDelete: {
      title: (n) => `Delete page ${n}?`,
      body: (remaining) =>
        remaining === 0
          ? "The photo leaves the document and it becomes empty. There is no way back."
          : `The photo leaves the document and the PDF is left with ${remaining} ${
              remaining === 1 ? "page" : "pages"
            }. There is no undo.`,
      confirm: "Delete the page",
      keep: "Keep it",
    },
  },

  girar: {
    title: "Rotate the sheet",
    dialogLabel: (n) => `Rotate page ${n}`,
    left: "left",
    right: "right",
    leftAria: (rotation) => `Rotate the page left — currently ${rotation}`,
    rightAria: (rotation) => `Rotate the page right — currently ${rotation}`,
    current: (degrees) => `current turn: ${degrees}°`,
    undo: "undo",
    save: "Save the turn",
    announce: (n, rotation) => `Page ${n} ${rotation}.`,
  },

  finish: {
    title: "Sheet finish",
    dialogLabel: (n) => `Finish of page ${n}`,
    labels: {
      original: "original",
      clean: "lighten",
      bw: "black and white",
    },
    help: {
      original: "The photo straight out of the camera, with no light enhancement.",
      clean: "Removes the shadow and whitens the paper. Most people use this one.",
      bw: "Black and white only — good for a dull photocopy.",
    },
    apply: (label) => `Apply ${label}`,
    announce: (n, finish) => `Page ${n}, finish ${finish}.`,
  },

  corners: {
    title: "Corners of the sheet",
    dialogLabel: (n) => `Adjust the corners of page ${n}`,
    instruction: "Drag to the four tips of the paper.",
    unavailableTitle: "This page cannot be adjusted",
    unavailableBody:
      "We could not open the original photo on this device. You can retake it — it only takes a few seconds.",
    cropping: "Cropping…",
    confirmCta: "Use these corners",
    whole: "whole sheet",
    reset: "start over",
    back: "Go back without changing the corners",
    backCta: "Back",
    handles: {
      topLeft: "Top-left corner",
      topRight: "Top-right corner",
      bottomRight: "Bottom-right corner",
      bottomLeft: "Bottom-left corner",
    },
  },

  retake: {
    dialogLabel: (n) => `Retake page ${n}`,
    title: (n) => `Retake page ${n}`,
    lead: "No rush — you choose which of the two stays afterwards.",
    cancelAria: (n) => `Cancel and keep page ${n} as it is`,
    chooseLabel: "Choose the photo",
    optionOld: "The one I had",
    optionNew: "The new one",
    cardOld: "The one you already had",
    cardNew: "The new one",
    badgeNew: "just taken",
    newAlt: "The new photo of this page",
    useNew: "Use the new photo",
    keepOld: "Keep the one I had",
    takeAnother: "Take another photo",
  },


  tiles: {
    chip: {
      ok: "Sharp",
      unverified: "Not verified",
      blurry: "Blurry",
      tooSmall: "Small letters",
      processing: "Preparing…",
      retry: "Try again",
    },
    detail: {
      ok: "Sharp, with good letter size — worth a quick look before you make the PDF.",
      unverified:
        "We could not verify this page — please take a look before continuing.",
      blurry: "It came out a little blurry. Shall we try again?",
      tooSmall: "The letters came out small — want to get closer?",
      processing: "We are straightening and cleaning this page.",
    },
  },

  desktop: {
    trail: ["1 choose", "2 check", "3 create"],
    trailLabel: "The three steps",
    processing: "processed on this computer",

    escolher: {
      kicker: "step 1 of 3",
      title: "Bring the document over here.",
      lead: (pdf) =>
        pdf
          ? "Phone photos, scanned images or PDFs. Each image becomes a page."
          : "Phone photos or scanned images. Each image becomes a page.",
      dropTitle: "Drop the files here",
      dropFormats: (pdf) =>
        pdf
          ? "JPG, PNG, HEIC or PDF · a whole folder keeps the name order"
          : "JPG, PNG or HEIC · a whole folder keeps the name order",
      dropzoneLabel: "Choose files from this computer",
      pickFiles: "Choose files",
      pickFolder: "Choose a folder",
      listLabel: "Chosen files",
      summary: (files, size) => `${files} ${files === 1 ? "file" : "files"} · ${size}`,
      clear: "clear",
      noManualCrop: "No manual cropping: step 2 straightens and cleans each sheet.",
      conferirCta: (n) => `Check ${n} ${n === 1 ? "page" : "pages"}`,
      explain: [
        "Each image becomes a page of the PDF, in the order of the names.",
        "In step 2 you check page by page and fix whatever needs it.",
        "Everything runs on this computer. Nothing is kept once you close it.",
      ],
      opening: (done, total) => `Opening ${done} of ${total}…`,
      refused: (names) => `We could not open: ${names}.`,
      atCapacity: (max) =>
        `A document goes up to ${max} pages. The ones past that were left out.`,
    },

    conferir: {
      railTitle: "Pages",
      railSummary: (pages, ready) =>
        `${pages} ${pages === 1 ? "page" : "pages"} · ${ready} ready`,
      addFiles: "Add files",
      dragHint: "drag to reorder · alt + ↑ ↓ on the keyboard",
      row: {
        straightened: (finish) => `straightened · ${finish}`,
        cornersAdjusted: "corners adjusted",
        noEdges: "edges not found",
        processing: "preparing",
        failed: "not ready",
      },
      status: {
        readyClean: "Straightened and lightened. You can use it as it is.",
        ready: (finish) => `Straightened. Finish: ${finish}.`,
        noEdges:
          "I could not find the edges of the sheet. Mark the corners by hand or use it as it is.",
        processing: "Preparing this page…",
        failed: "This page did not come out ready.",
      },
      remove: "delete",
      tiles: {
        rotate: (degrees) => `turn · ${degrees}°`,
        corners: "corners",
        straighten: "straighten",
        straightened: "straightened",
        finish: (label) => `finish · ${label}`,
      },
      finishShort: {
        original: "original",
        clean: "lighten",
        bw: "b&w",
      },
      cantos: {
        instruction: "Drag the corners to the tips of the paper.",
        cancel: "Cancel",
        confirm: "Use these corners",
        working: "Cropping…",
        unavailable: "We could not open the original photo of this page.",
      },
      acabamento: {
        title: "Sheet finish",
        close: "Close the finish panel",
        notes: {
          original: "As the photo came, with no treatment.",
          clean: "Removes the shadow and whitens the paper. Most people use this one.",
          bw: "Maximum contrast and a smaller file. Good for plain text.",
        },
      },
      previous: "Previous page",
      next: "Next page",
      shortcuts: "← → pages · R turn · C corners · ⌫ delete",
      goGerar: "Go to step 3",
      empty: "No page open. Go back to step 1 and choose the files.",
      removeDialog: {
        title: (n) => `Delete page ${n}?`,
        body: (remaining) =>
          remaining === 0
            ? "The document is left with no pages at all."
            : `The PDF is left with ${remaining} ${remaining === 1 ? "page" : "pages"}.`,
        confirm: "Delete the page",
        keep: "Keep",
      },
    },

    gerar: {
      kicker: "step 3 of 3",
      title: "Create the PDF",
      nameLabel: "file name",
      nameField: "File name, after the date",
      namePrefixLabel: "date and time of the scan",
      backToConferir: "Back to checking",
      previewLabel: "PDF preview",
      rowPages: "pages",
      rowSize: "estimated size",
      rowGeometry: "page",
      geometryValue: "at photo size",
      makingTitle: "Assembling your PDF",
      checkStraightened: "sheets straightened",
      checkContrast: "contrast adjusted",
      doneKicker: "PDF ready",
      trust: "The PDF was put together on this computer.",
    },
  },

  pageErrors: {
    prep: "We could not prepare the photo. Try again.",
    unsupported:
      "We cannot read that kind of photo yet. Please take the photo again with the camera.",
    camera_waking: "The camera is still waking up. Try again in a moment.",
    generic: "We could not prepare this page. Shall we try again?",
  },

  buildErrors: {
    pages_failed:
      "Some pages are not ready. Go back and resolve each one before creating the PDF.",
    pages_processing:
      "We are still preparing your pages. Try again in a few seconds.",
    no_pages: "No page is ready yet.",
    pages_changed:
      "A page changed while the PDF was being put together. Nothing was lost — just create it again.",
    build_failed:
      "We could not build the PDF right now. Your pages are still here — shall we try again?",
    over_budget:
      "This document is over the size limit. Try removing a few pages — all of yours are still here.",
  },

  rotations: {
    0: "upright",
    90: "turned a quarter to the right",
    180: "upside down",
    270: "turned a quarter to the left",
  },
};

export const APP_COPY: Record<Lang, AppCopy> = { pt: PT, en: EN };

// ── the current language ─────────────────────────────────────────────────────

/**
 * The chosen language, as module state.
 *
 * React reads it through `useLang()`; the store and the naming helper read it
 * through {@link currentLang}, because they are called from places that have no
 * component around them. The provider — fed by `<ScanFlow lang>` — is the only
 * writer.
 */
let current: Lang = "pt";

export function currentLang(): Lang {
  return current;
}

/** Provider-only. Returns true when the value actually changed. */
export function setCurrentLang(lang: Lang): boolean {
  if (current === lang) return false;
  current = lang;
  return true;
}

export function copyFor(lang: Lang): AppCopy {
  return APP_COPY[lang];
}
