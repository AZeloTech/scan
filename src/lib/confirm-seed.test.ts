import assert from "node:assert/strict";
import test from "node:test";

import type { CornerCheck } from "./corner-check.ts";
import { ALL_SEEN } from "./corner-check.ts";
import { confirmPill, seedMarkOf } from "./confirm-seed.ts";
import { APP_COPY } from "./i18n.ts";

const INFERRED: CornerCheck = {
  corners: { topLeft: "inferred", topRight: "seen", bottomRight: "seen", bottomLeft: "seen" },
  separate: false,
};

test("corners the refinement measured nothing about are 'unmeasured', never 'estimated'", () => {
  // Out of time even on the retry: the detector's corners, unchecked.
  assert.equal(seedMarkOf(true, null, { measured: false }), "unmeasured");
  assert.equal(seedMarkOf(true, undefined, { measured: false }), "unmeasured");
  // A measured check: estimated only when uncertain.
  assert.equal(seedMarkOf(true, INFERRED, { measured: true }), "estimated");
  assert.equal(seedMarkOf(true, { ...ALL_SEEN, separate: true }, { measured: true }), "estimated");
  assert.equal(seedMarkOf(true, ALL_SEEN, { measured: true }), "clear");
  // No seed: the pill's "not found" says that. A seed nobody refined: nothing to say.
  assert.equal(seedMarkOf(false, null, { measured: false }), "clear");
  assert.equal(seedMarkOf(true, null, null), "clear");
  assert.equal(seedMarkOf(true, undefined, undefined), "clear");
});

test("the not-measured pill replaces the instruction, in pt-BR and en-US", () => {
  const pt = APP_COPY.pt.confirm;
  const en = APP_COPY.en.confirm;
  assert.equal(pt.unmeasuredPill, "Confira os cantos — não deu para medir");
  assert.equal(en.unmeasuredPill, "Check the corners — couldn't measure");
  for (const copy of [pt, en]) {
    const shown = confirmPill(copy, { attention: null, ready: true, found: true, mark: "unmeasured" });
    assert.deepEqual(shown, { text: copy.unmeasuredPill, reason: true, aside: null });
    assert.notEqual(shown.text, copy.pill);
    // Not "estimado": nothing was inferred.
    assert.doesNotMatch(copy.unmeasuredPill + copy.unmeasuredBadge + copy.unmeasuredHandle("x"), /estimad/i);
    // Before the editor is up, and once every handle is moved: the instruction.
    assert.equal(confirmPill(copy, { attention: null, ready: false, found: true, mark: "unmeasured" }).text, copy.pill);
    assert.deepEqual(confirmPill(copy, { attention: null, ready: true, found: true, mark: "clear" }), { text: copy.pill, reason: false, aside: null });
    // The photo's own reason keeps the pill; the corners' ask goes under it.
    assert.deepEqual(confirmPill(copy, { attention: "moved", ready: true, found: true, mark: "unmeasured" }), {
      text: copy.attention.moved,
      reason: true,
      aside: copy.unmeasuredPill,
    });
    // The estimated state is unchanged.
    assert.equal(confirmPill(copy, { attention: null, ready: true, found: true, mark: "estimated" }).text, copy.estimatedPill);
    // No seed at all: "not found" wins.
    assert.equal(confirmPill(copy, { attention: null, ready: true, found: false, mark: "clear" }).text, copy.notFound);
  }
  assert.equal(pt.unmeasuredBadge, "confira");
  assert.equal(en.unmeasuredBadge, "check");
  assert.equal(pt.unmeasuredHandle("Canto superior esquerdo"), "Canto superior esquerdo: canto não medido — confira");
  assert.equal(en.unmeasuredHandle("Top-left corner"), "Top-left corner: corner not measured — check it");
});
