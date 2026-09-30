/**
 * The text deskew's policy version, on its own so the store can key its cache
 * on it without pulling the deskew maths in (`lib/deskew.ts` arrives lazily,
 * with the first tap on Endireitar).
 *
 * Bumped whenever a change to the deskew would give a different page for the
 * same photo and outline — estimator, judge, curl gate, wedge fill. A cached
 * answer planned under another version is never reused.
 */
export const DESKEW_POLICY_VERSION = "deskew-2";
