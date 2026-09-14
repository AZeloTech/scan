"use client";

import * as React from "react";
import clsx from "clsx";
import { useCopy } from "@/components/I18n";
import { CorrectionTile } from "@/components/CorrectionTile";
import { CheckIcon, WaveIcon } from "@/components/icons";
import { Button } from "@/components/ui";
import { useDewarpActivity, useDewarpConsented, useStore } from "@/hooks/useScanStore";
import { useAssetUrls } from "@/hooks/useScanRuntime";
import { dewarpAvailable, dewarpLatchCode } from "@/lib/dewarp-stage";
import { resolveGeometryMode, type DewarpEngineMode } from "@/lib/dewarp/engine-mode";
import { dewarpAssetsCached } from "@/lib/dewarp/prefetch";
import { formatBytes } from "@/lib/image";
import { connectionKind, shouldPrefetchHeavyAssets } from "@/lib/network";
import {
  dewarpConsentRequired,
  dewarpOutcome,
  dewarpOutcomeCode,
  type DewarpOutcome,
  type ScanPage,
} from "@/lib/scan-store";

/**
 * "Endireitar (beta)" — one page's curved-page correction, on the page view.
 *
 * It is a switch rather than a button because it is a *standing choice about
 * this page*, like the finish: it survives a turn, a re-crop and a retake, and
 * the page is re-rendered from the canonical whenever it changes.
 *
 * Three decisions are worth stating, because none of them is arbitrary:
 *
 *  * **The switch reflects the page, not the wish.** When a run falls
 *    back, the store hands the switch back to OFF and the line under it says
 *    what happened — per outcome bucket, in the outcome's own tone: "we
 *    checked, it reads better flat" is a confirmation, not the amber the
 *    blurry-page warning wears. The first shape of this control kept the
 *    switch ON to honor the *request*; a field report showed what
 *    that reads as — a control claiming a correction the page visibly does
 *    not have. The old cost argument (a retry re-pays twelve seconds for a
 *    deterministic answer) is now carried by the store instead: it refuses to
 *    re-run a verdict that is final for these exact pixels.
 *  * **Consent is asked once per session, before a byte is fetched — for the
 *    engine whose download is worth asking about.** uvdoc's ~19 MB earns the
 *    paragraph: the size, the per-page seconds and the on-device promise, and
 *    the second page is not asked again — the model is already here. The
 *    classical engine's ~130 KB does not: {@link dewarpConsentRequired} is
 *    `false` for it, so its own control runs the instant it is tapped, in
 *    every build that reaches it — the classical-only build, and the "ab"
 *    build, which the page view now resolves to the classical engine too.
 *  * **While it runs, the switch is inert and "Cancelar" is the whole
 *    interface.** One decision per screen: a live switch beside a live cancel
 *    is two ways to say stop, and one of them costs an extra render. The tap
 *    is acknowledged instantly ("cancelando…") even though the run can only
 *    unwind at its next checkpoint — a cancel that sits mute for seconds
 *    reads as a hang.
 *
 * ## Why this is a hook and two components
 *
 * The control used to be one card that owned its own state and drew everything
 * it needed inside itself. The page view's reorganisation splits it in two
 * *places*: the toggle is one column of the three-up improve row, and
 * everything that needs a paragraph — the consent sheet, the download progress,
 * the "kept the original" line — belongs below that row, at full width. Two
 * components would be two copies of `asking`, so the state is lifted into
 * {@link useDewarpControl} and both halves are given the same object. The flow
 * itself, and every decision above, is unchanged.
 */

export interface DewarpControlState {
  /** This device cleared the budget; false latches the control off for good. */
  available: boolean;
  /** This page's own correction is running right now, on *this* engine. */
  running: boolean;
  /** What the last attempt came to, when it did not correct. */
  outcome: DewarpOutcome | null;
  /**
   * The support code behind whatever line the panel is about to show — the
   * guard's own `#0xx` for a per-page outcome, the latch's `#1xx` when the
   * feature is paused for the session, and null when there is nothing to say.
   *
   * Never part of a translated string: it is composed onto the sentence in
   * {@link DewarpPanel}, so every locale carries the same number.
   */
  code: string | null;
  /** The consent paragraph is up, and nothing has been fetched yet. */
  asking: boolean;
  /** What the toggle asks for — the *request*, never the outcome. */
  requested: boolean;
  /** Ties the toggle to whatever paragraph the panel is showing. */
  hintId: string;
  /** The toggle's whole behaviour: off → on (asking first), or on → off. */
  toggle: () => void;
  /** The consent paragraph's two ways out — the only writers of `asking`. */
  acceptConsent: () => void;
  dismissConsent: () => void;
}

/**
 * `mode` defaults to {@link resolveGeometryMode}; the page view passes it
 * explicitly, because the "ab" build's default resolves to uvdoc while its
 * one visible control is the classical engine.
 *
 * Every field below reads `page` filtered to *that* engine, which is what let
 * the two-engine comparison call this twice over one page and get two
 * independent {@link DewarpControlState} objects rather than two views of the
 * same one. Nothing calls it twice today; the filtering stays, because it is
 * also what keeps a page dewarped by the *other* engine from lighting this
 * control up.
 */
export function useDewarpControl(
  page: ScanPage,
  mode: DewarpEngineMode = resolveGeometryMode(),
): DewarpControlState {
  const consented = useDewarpConsented();
  const activity = useDewarpActivity();
  const hintId = React.useId();
  const [asking, setAsking] = React.useState(false);
  // Read once at mount rather than on every render: the value is a module
  // latch, and reading it during render on the server would answer for a
  // machine that is not the one holding the phone.
  const store = useStore();
  const [available, setAvailable] = React.useState(() => dewarpAvailable());

  // The session latch flips inside the render pipeline, which has no way to
  // tell React. Every flip happens as a render lands, so this is the tick.
  React.useEffect(() => {
    setAvailable(dewarpAvailable());
  }, [page.rendered]);

  const reason = page.rendered?.dewarpFallbackReason;
  React.useEffect(() => {
    if (reason === undefined) return;
    // The only console call in the app, and deliberately `debug`: the reason is
    // a stable engine identifier for whoever is diagnosing a device, and the
    // user is told something short and non-technical instead.
    console.debug(`[dewarp] page ${page.id} kept the flat geometry: ${reason}`);
  }, [page.id, reason]);

  // "On", for this control specifically. In every build but "ab" `mode`
  // always equals `page.dewarpEngineMode`, so this is exactly
  // `page.dewarpRequested` — unchanged. In "ab" it is what keeps the inactive
  // tile from also drawing itself as on.
  const requested = page.dewarpRequested && page.dewarpEngineMode === mode;
  const running =
    activity !== null && activity.pageId === page.id && page.dewarpEngineMode === mode;

  const toggle = React.useCallback(() => {
    if (requested) {
      store.setPageDewarp(page.id, false, mode);
      return;
    }
    // uvdoc's download earns the consent sheet; the classical engine's ~130
    // KB does not (`dewarpConsentRequired`) — so its own tile runs the
    // instant it is tapped, consented or not.
    if (!dewarpConsentRequired(mode) || consented) {
      store.setPageDewarp(page.id, true, mode);
    } else {
      setAsking(true);
    }
  }, [consented, mode, page.id, requested, store]);

  const acceptConsent = React.useCallback(() => {
    store.acceptDewarpConsent();
    store.setPageDewarp(page.id, true, mode);
    setAsking(false);
  }, [mode, page.id, store]);
  const dismissConsent = React.useCallback(() => setAsking(false), []);

  const outcome = dewarpOutcome(page, mode);
  // The latch's own code wins whenever the feature is paused, because that is
  // the line the panel shows there — the page's last outcome is behind it and
  // no longer what the reader is being told.
  const code = !available
    ? dewarpLatchCode()
    : outcome === null
      ? null
      : dewarpOutcomeCode(page, mode);

  return React.useMemo(
    () => ({
      available,
      running,
      outcome,
      code,
      asking,
      requested,
      hintId,
      toggle,
      acceptConsent,
      dismissConsent,
    }),
    [
      acceptConsent,
      asking,
      available,
      code,
      dismissConsent,
      hintId,
      outcome,
      requested,
      running,
      toggle,
    ],
  );
}

/**
 * The toggle itself — the third of the editor's four correction tiles, drawn by
 * the shared {@link CorrectionTile} so the row cannot end up with two slightly
 * different boxes in it.
 *
 * On, it says "endireitada" over a check rather than "endireitar" over the
 * curve glyph: the accent alone was read as an offer being highlighted rather
 * than as a state the page is already in, and a switch that cannot be told
 * apart from a button is a switch nobody taps twice.
 *
 * `offered` is false on a page with nothing to predict a surface for (no
 * outline) or one that could not be prepared at all. It renders **disabled
 * rather than hidden**: the row is four columns wide on every page, so the
 * layout is learned once.
 */
export function DewarpTile({
  control,
  offered,
  label,
}: {
  control: DewarpControlState;
  offered: boolean;
  /**
   * The two-engine comparison's own name for this tile — "Curvatura · IA" or
   * "Curvatura · nova" (`copy.ab`) — replacing `copy.label` / the tile's own
   * word for both the accessible name and the visible one, so two switches in
   * the same row can be told apart.
   *
   * **No build passes it today**: the uvdoc tile was pulled from the
   * page view, so every build draws one control under the plain copy. It is
   * kept for the day the comparison comes back (`i18n.ts`'s `dewarp.ab`).
   */
  label?: string;
}) {
  const copy = useCopy().preview;
  const dewarp = copy.dewarp;
  const on = control.requested;

  return (
    <CorrectionTile
      role="switch"
      checked={on}
      ariaLabel={label ?? dewarp.label}
      describedBy={control.hintId}
      // The sentence that used to sit under the card permanently. It is a hint
      // about *which page this is for*, not an instruction, so it earns a
      // tooltip rather than a permanent line.
      title={dewarp.help}
      icon={on ? <CheckIcon size={16} /> : <WaveIcon size={16} />}
      label={
        label ?? (on ? copy.tiles.straightenApplied : copy.tiles.straighten)
      }
      state={on ? "applied" : "default"}
      disabled={!offered || !control.available || control.running}
      onClick={control.toggle}
    />
  );
}

/**
 * Whether {@link DewarpPanel} has anything visible to say.
 *
 * The editor's explanation card is the one band allowed to appear and
 * disappear, so it has to know before it draws its padding. The panel still
 * renders when this is false — as a screen-reader-only description, so the
 * switch's `aria-describedby` is never a dangling reference.
 */
export function dewarpPanelVisible(control: DewarpControlState): boolean {
  return control.asking || !control.available || control.outcome !== null;
}

/**
 * Everything the toggle cannot say in one column: the consent paragraph and the
 * honest line about what was and was not achieved.
 *
 * It is the editor's **explanation card**, and it owns no spacing of its own —
 * the card band around it does, because that band has to collapse to nothing
 * when there is nothing to explain. The run *in flight* is no longer drawn
 * here at all: the fixed-band redesign gives the editor one status line and one
 * only, so progress and cancelling live there and this renders a
 * screen-reader-only phase line so the switch's `aria-describedby` still
 * resolves.
 */
export function DewarpPanel({
  control,
  label,
}: {
  control: DewarpControlState;
  /** Same comparison-only override as {@link DewarpTile}'s, for the consent
   * sheet's own heading — passed by no build today. */
  label?: string;
}) {
  const copy = useCopy().preview.dewarp;
  const urls = useAssetUrls();
  const activity = useDewarpActivity();
  const [consentTone, setConsentTone] = React.useState<"free" | "metered" | "cached">(
    "free",
  );
  /**
   * Which of the three consent paragraphs this device has earned.
   *
   * Both readings are client-only — one is async, the other is a browser API
   * that does not exist while this renders on a build machine — so the plain
   * paragraph is the default and the others replace it a tick later. It is
   * re-read whenever the panel opens, because a Wi-Fi prefetch may well have
   * finished between the first page of a scan and this one.
   */
  React.useEffect(() => {
    let alive = true;
    void dewarpAssetsCached(urls).then((cached) => {
      if (!alive) return;
      if (cached) setConsentTone("cached");
      else if (shouldPrefetchHeavyAssets(connectionKind())) setConsentTone("free");
      else setConsentTone("metered");
    });
    return () => {
      alive = false;
    };
  }, [control.asking, urls]);

  if (control.asking) {
    return (
      <div className="rounded-[13px] border border-shell-line bg-shell-sunken p-3">
        <p className="text-base font-semibold text-shell-ink">{label ?? copy.label}</p>
        <p id={control.hintId} className="mt-1 text-sm leading-snug text-shell-ink2">
          {consentTone === "cached"
            ? copy.consentCached
            : consentTone === "metered"
              ? copy.consentMetered
              : copy.consent}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            onNight
            className="flex-1 whitespace-nowrap px-3 text-base"
            onClick={control.acceptConsent}
          >
            {/* A dialog that says "nothing will be downloaded" cannot offer a
                button that says "download" — the confirm follows the tone. */}
            {consentTone === "cached" ? copy.consentConfirmCached : copy.consentConfirm}
          </Button>
          <Button
            onNight
            variant="secondary"
            className="flex-1 whitespace-nowrap px-3 text-base"
            onClick={control.dismissConsent}
          >
            {copy.consentCancel}
          </Button>
        </div>
      </div>
    );
  }

  if (control.running) {
    // The visible half of this is the editor's status line — spinner, phase
    // sentence, elapsed seconds — and its "Cancelar" is the footer's secondary
    // slot. What is left here is the description the switch points at, which a
    // screen reader still needs while the run is in flight.
    return (
      <p id={control.hintId} className="scan-sr-only">
        {activity === null
          ? copy.help
          : activity.total > 0
            ? `${copy.phases[activity.phase]} ${copy.downloaded(
                formatBytes(activity.received),
                formatBytes(activity.total),
              )}`
            : copy.phases[activity.phase]}
      </p>
    );
  }

  // Two things are worth the card: this device cannot run it, or the last
  // attempt came to something. A switched-on correction that worked says so on
  // the tile and in the status line; a third sentence here is the clutter the
  // fixed-band redesign exists to remove.
  const outcome = control.outcome;
  const message = !control.available
    ? copy.unavailable
    : outcome !== null
      ? copy.outcomes[outcome]
      : null;

  if (message === null) {
    return (
      <p id={control.hintId} className="scan-sr-only">
        {copy.help}
      </p>
    );
  }

  // Amber is this app's genuine-warning tone (the blurry page wears it). Of
  // the outcomes, only the two retryable ones have earned it: "we checked and
  // it reads better flat" is the feature *working*, and painting it amber was
  // exactly the "odd error" reported from the field.
  const warn = outcome === "download" || outcome === "transient";

  // The editor's status line already carries — and announces — the sentence for
  // exactly those two outcomes, with its own `por quê?` beside it. Repeating it
  // here printed the same words twice on one screen and had a screen reader say
  // them twice for one event, because both were live regions. So the card keeps
  // the half the line has no room for: what to do next, and the support code a
  // screenshot can carry. Every other outcome is verbalised nowhere
  // else, so there the card is still the whole sentence and still the announcer.
  const echoed = warn;

  return (
    <div
      className={clsx(
        "rounded-[13px] border p-3 text-[12.5px] leading-relaxed",
        warn
          ? "border-shell-warnline bg-shell-sunken text-shell-warn"
          : "border-shell-line bg-shell-sunken text-shell-ink2",
      )}
    >
      <p id={control.hintId} role={echoed ? undefined : "status"}>
        {echoed ? copy.retryHint : message}
        {/* The one thing a screenshot can carry that the sentence cannot: five
            sentences cover twenty-two guards, and this names the exact one. Not
            part of the copy — composed here, so every locale shows the same
            number — and `ink2` rather than `dim`, which is a 3:1 graphic token
            and was never checked as text (`lib/shell-theme.ts`). */}
        {control.code !== null && (
          <>
            {"  "}
            <span className="font-mono text-[11px] text-shell-ink2">
              {control.code}
            </span>
          </>
        )}
      </p>
    </div>
  );
}
