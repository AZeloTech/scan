import assert from "node:assert/strict";
import test from "node:test";

import { APP_COPY } from "./i18n.ts";

/**
 * The confirm screen's pill (C5) carries one sentence over the photo, and a
 * reason replaces the instruction rather than stacking under it — so every
 * sentence that can land there must fit the pill in two lines at a 360 px
 * phone (about 60 characters of 15 px text).
 */
test("every sentence the confirm pill can carry is pill-sized, in both languages", () => {
  for (const [lang, copy] of Object.entries(APP_COPY)) {
    const sentences = [copy.confirm.pill, copy.confirm.notFound, copy.confirm.estimatedPill, copy.confirm.unmeasuredPill, ...Object.values(copy.confirm.attention)];
    for (const sentence of sentences) {
      assert.ok(sentence.length <= 60, `${lang}: "${sentence}" is ${sentence.length} characters`);
    }
  }
});

test("the bottom bar's words are contained in their accessible names", () => {
  for (const copy of Object.values(APP_COPY)) {
    const c = copy.confirm;
    for (const [word, name] of [
      [c.confirmCta, c.confirmLabel],
      [c.retakeCta, c.retakeLabel],
    ] as const) {
      assert.ok(name.toLowerCase().includes(word.toLowerCase()), `"${name}" should contain "${word}"`);
    }
    // "Foto inteira" / "Whole photo": the name says the same words, in the language's order.
    for (const token of c.wholeCta.toLowerCase().split(" ")) {
      assert.ok(c.wholeLabel.toLowerCase().includes(token), `"${c.wholeLabel}" should contain "${token}"`);
    }
  }
});
