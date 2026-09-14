/**
 * The only things this library remembers between visits.
 *
 * Nothing else survives the tab — the scan itself lives in memory and dies with
 * it (`lib/scan-store.ts`), which is this library's whole privacy claim and
 * therefore a rule: no document bytes in any storage, ever. A tip
 * the user has already read is the exception the claim can afford: it is a
 * boolean about the *reader*, carries nothing about any document, and the
 * alternative is teaching somebody the same gesture on every scan they ever
 * make.
 *
 * ## Every storage key this library writes
 *
 * This module is a guest in the host's origin, so each key is namespaced under
 * `scan.` and the complete list is written down here rather than left to be
 * discovered in a storage inspector:
 *
 * | key | value | written by |
 * |---|---|---|
 * | `scan.tip.edit` | `"1"` | {@link markEditTipSeen} |
 * | `scan.tip.compare` | `"1"` | {@link markCompareTipSeen} |
 *
 * There is no language key: the language is the host's `lang` prop and is not
 * remembered. `lib/source-hygiene.test.ts` fails if any other module touches
 * storage.
 *
 * The names used to be the original Portuguese (`dica_edicao_vista`),
 * unprefixed. That was right for an application that owned its origin and is
 * rude for a library that does not: an unprefixed key in somebody else's
 * `localStorage` is a collision waiting to happen, and a line in their storage
 * inspector that nobody can attribute. Renaming costs exactly one thing — a
 * reader who dismissed a tip in the old standalone app is shown it once more.
 *
 * Reads and writes both swallow their errors: a
 * locked-down storage (Safari private mode, a hardened Android WebView) costs
 * the memory, never the screen.
 */

const EDIT_TIP_KEY = "scan.tip.edit";

/**
 * The page view's "segure para comparar", shown once — the first time a page
 * actually has an improvement to compare against.
 *
 * A separate key rather than one "tips seen" flag: the two are learned on
 * different screens, months apart for anybody who scans twice a year, and a
 * shared boolean would spend the first one to pay for the second.
 */
const COMPARE_TIP_KEY = "scan.tip.compare";

/** What a stored "yes" looks like. Any other value is treated as unseen. */
const SEEN = "1";

function hasSeen(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === SEEN;
  } catch {
    // Storage disabled: the tip stays for this session and that is all.
    return false;
  }
}

function markSeen(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, SEEN);
  } catch {
    // As above.
  }
}

/**
 * The user has already been told they can tap a page to edit it — either
 * because they dismissed the card, or because they went and did it.
 *
 * Answers `false` on the server and on the first client render of a static
 * export: the caller must adopt the real answer in an effect, or the markup
 * generated at build time and the first hydration will disagree.
 */
export function hasSeenEditTip(): boolean {
  return hasSeen(EDIT_TIP_KEY);
}

/** One-way and idempotent — the card never comes back. */
export function markEditTipSeen(): void {
  markSeen(EDIT_TIP_KEY);
}

/**
 * The user has already been shown that holding the page compares it with the
 * photo before the improvements. Same server/first-render caveat as
 * {@link hasSeenEditTip}.
 */
export function hasSeenCompareTip(): boolean {
  return hasSeen(COMPARE_TIP_KEY);
}

/** One-way and idempotent — the hint never comes back. */
export function markCompareTipSeen(): void {
  markSeen(COMPARE_TIP_KEY);
}
