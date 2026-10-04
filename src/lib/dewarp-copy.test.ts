import assert from "node:assert/strict";
import test from "node:test";

import { APP_COPY } from "./i18n.ts";

/**
 * What the Endireitar card may say, per outcome of a tap (`scan-store.ts`'s
 * `StraightenOutcome`), held to the honesty rule in both languages: a limit of
 * the correction never claims to be a verdict on the page.
 */

const OUTCOMES = [
  "tilt",
  "curl",
  "both",
  "tilt-only",
  "tilt-retry",
  "nothing",
  "declined",
  "unverified",
  "page",
  "download",
  "transient",
] as const;

/** The declines that are a limit of the engine, not a fact about the page. */
const LIMITS = ["declined", "unverified", "page"] as const;

test("every outcome of a tap has its own sentence, in both languages", () => {
  for (const [lang, copy] of Object.entries(APP_COPY)) {
    const outcomes = copy.preview.dewarp.outcomes;
    assert.deepEqual(Object.keys(outcomes).sort(), [...OUTCOMES].sort(), lang);
    const sentences = OUTCOMES.map((outcome) => outcomes[outcome]);
    assert.equal(new Set(sentences).size, sentences.length, `${lang}: no two outcomes read alike`);
  }
});

test("a limit of the correction never says the page reads better as it is", () => {
  const certain = [/conferimos/i, /fica melhor/i, /ficou melhor/i, /we checked/i, /reads better/i, /looked better/i];
  for (const [lang, copy] of Object.entries(APP_COPY)) {
    for (const outcome of LIMITS) {
      const sentence = copy.preview.dewarp.outcomes[outcome];
      for (const claim of certain) {
        assert.doesNotMatch(sentence, claim, `${lang} ${outcome}: "${sentence}"`);
      }
    }
  }
});

test("a tilt corrected with the curl left as it was says both halves", () => {
  const pt = APP_COPY.pt.preview.dewarp.outcomes;
  assert.match(pt["tilt-only"], /torto/);
  assert.match(pt["tilt-only"], /curva/);
  assert.doesNotMatch(pt["tilt-only"], /mantivemos a original/i);
  const en = APP_COPY.en.preview.dewarp.outcomes;
  assert.match(en["tilt-only"], /tilted/);
  assert.match(en["tilt-only"], /curve/);
});

test("the help and the about sheet mention tilted text, not only the curve", () => {
  const pt = APP_COPY.pt.preview;
  assert.match(pt.dewarp.help, /texto torto/);
  assert.match(pt.about.dewarpBody, /inclinação do texto/);
  const en = APP_COPY.en.preview;
  assert.match(en.dewarp.help, /tilted text/);
  assert.match(en.about.dewarpBody, /tilt of the text/);
});

test("a re-tap is answered with what would change the answer", () => {
  assert.match(APP_COPY.pt.preview.dewarp.retapHint, /cantos|refaça/);
  assert.match(APP_COPY.en.preview.dewarp.retapHint, /corners|retake/);
});

test("a tilt corrected while the curve could not be checked says so, and how to try the curve again", () => {
  const pt = APP_COPY.pt.preview.dewarp;
  assert.match(pt.outcomes["tilt-retry"], /torto/);
  assert.match(pt.outcomes["tilt-retry"], /curva/);
  // Not "ficou como estava": the engine may never have run.
  assert.doesNotMatch(pt.outcomes["tilt-retry"], /como estava/);
  assert.match(pt.retryCurlHint, /desligue e ligue/);
  const en = APP_COPY.en.preview.dewarp;
  assert.match(en.outcomes["tilt-retry"], /tilted/);
  assert.doesNotMatch(en.outcomes["tilt-retry"], /as it was/);
  assert.match(en.retryCurlHint, /off and on/);
});

