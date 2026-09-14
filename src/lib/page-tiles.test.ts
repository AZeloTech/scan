import assert from "node:assert/strict";
import test from "node:test";

import { APP_COPY, type Lang } from "./i18n.ts";
import {
  buildTiles,
  isBlocking,
  isProblemRow,
  isWarned,
  rowVerdict,
  type PageTile,
} from "./page-tiles.ts";
import type { GateReading } from "./capture-gate.ts";
import { resolveGeometryMode } from "./dewarp/engine-mode.ts";
import type { ScanPage, ScanSession } from "./scan-store.ts";

/**
 * The tile is where the app tells the user what it thinks of their photo, so
 * these tests are about honesty rather than plumbing: a capture the gate could
 * not measure must never borrow the words of one it measured and passed.
 */

const LANGS: readonly Lang[] = ["pt", "en"];

function reading(reason: GateReading["reason"]): GateReading {
  return {
    sharpness: 0.42,
    textHeightPx: 24,
    score: 10.08,
    pass: reason === "ok",
    reason,
  };
}

function pageWithGate(gate: GateReading | null): ScanPage {
  const blob = new Blob(["page"]);
  return {
    id: "page-1",
    order: 0,
    revision: 1,
    sourceRevision: 1,
    status: "ready",
    canonical: blob,
    corners: null,
    rotation: 0,
    finish: "clean",
    dewarpRequested: false,
    dewarpEngineMode: resolveGeometryMode(),
    final: blob,
    thumb: blob,
    width: 1240,
    height: 1754,
    rendered: {
      revision: 1,
      rotation: 0,
      finish: "clean",
      warped: true,
      dewarped: false,
      dewarpEngineMode: resolveGeometryMode(),
    },
    gate,
    gateRevision: 1,
    error: null,
    createdAt: 0,
  };
}

function sessionWith(page: ScanPage): ScanSession {
  return {
    id: "session-1",
    createdAt: 0,
    updatedAt: 0,
    pages: [page],
    documentName: null,
  };
}

function tileFor(gate: GateReading | null, lang: Lang): PageTile {
  const tiles = buildTiles(sessionWith(pageWithGate(gate)), APP_COPY[lang]);
  const tile = tiles[0];
  assert.ok(tile !== undefined, "one page in, one tile out");
  return tile;
}

test("a capture the gate could not measure is not called great", () => {
  for (const lang of LANGS) {
    const tile = tileFor(reading("unknown"), lang);
    const copy = APP_COPY[lang];

    assert.equal(tile.stage, "unverified");
    assert.notEqual(tile.chipLabel, copy.tiles.chip.ok);
    assert.notEqual(tile.detail, copy.tiles.detail.ok);
    assert.equal(tile.chipLabel, copy.tiles.chip.unverified);
    assert.equal(tile.detail, copy.tiles.detail.unverified);
  }
});

test("a page with no gate reading at all reads the same way", () => {
  for (const lang of LANGS) {
    const tile = tileFor(null, lang);
    const copy = APP_COPY[lang];

    assert.equal(tile.stage, "unverified");
    assert.notEqual(tile.chipLabel, copy.tiles.chip.ok);
    assert.notEqual(tile.detail, copy.tiles.detail.ok);
  }
});

test("only a measured pass earns the positive verdict", () => {
  for (const lang of LANGS) {
    const tile = tileFor(reading("ok"), lang);
    const copy = APP_COPY[lang];

    assert.equal(tile.stage, "ok");
    assert.equal(tile.chipLabel, copy.tiles.chip.ok);
    assert.equal(tile.detail, copy.tiles.detail.ok);
  }
});

test("the two measured failures stay quality warnings", () => {
  const copy = APP_COPY.pt;

  const blurry = tileFor(reading("blurry"), "pt");
  assert.equal(blurry.stage, "warned");
  assert.equal(blurry.chipLabel, copy.tiles.chip.blurry);
  assert.ok(isWarned(blurry));

  const small = tileFor(reading("too_small"), "pt");
  assert.equal(small.stage, "warned");
  assert.equal(small.chipLabel, copy.tiles.chip.tooSmall);
  assert.ok(isWarned(small));
});

test("unverified is neither a warning nor a blocker", () => {
  const tile = tileFor(reading("unknown"), "pt");

  assert.equal(isWarned(tile), false);
  assert.equal(isBlocking(tile), false);
});

// ── the conferir row ─────────────────────────────────────────────────────────
//
// Step 2 has room for one mono word next to a 34 px thumbnail, so the row's
// vocabulary is coarser than the tile's — and the collapsing is where a lie
// could get in. What must hold: a page that blocks the PDF says so above
// everything else, a page whose edges were not found says the thing the user
// can act on, and a page nobody measured never borrows the word of one that
// passed.

function tileWith(page: ScanPage, lang: Lang): PageTile {
  const tiles = buildTiles(sessionWith(page), APP_COPY[lang]);
  const tile = tiles[0];
  assert.ok(tile !== undefined, "one page in, one tile out");
  return tile;
}

test("a page that could not be prepared owns its row", () => {
  for (const lang of LANGS) {
    const failed: ScanPage = {
      ...pageWithGate(reading("blurry")),
      status: "failed",
      error: "prep",
    };
    const verdict = rowVerdict(tileWith(failed, lang), APP_COPY[lang]);

    // Severity order: the gate also disliked this page, and the row still says
    // the thing that stops the PDF.
    assert.equal(verdict.state, "failed");
    assert.equal(verdict.word, APP_COPY[lang].review.state.failed);
    assert.ok(isProblemRow(verdict.state));
  }
});

test("a page that went in flat says so, above a quality warning", () => {
  for (const lang of LANGS) {
    const page: ScanPage = {
      ...pageWithGate(reading("blurry")),
      // The render could not apply the corners, so the raw frame is in the
      // document — the one case where the row points somewhere useful.
      rendered: {
        revision: 1,
        rotation: 0,
        finish: "clean",
        warped: false,
        dewarped: false,
        dewarpEngineMode: resolveGeometryMode(),
      },
    };
    const verdict = rowVerdict(tileWith(page, lang), APP_COPY[lang]);

    assert.equal(verdict.state, "noCorners");
    assert.equal(verdict.word, APP_COPY[lang].review.state.noCorners);
    assert.ok(isProblemRow(verdict.state));
  }
});

test("the gate's own two warnings keep their specific words", () => {
  const copy = APP_COPY.pt;

  const blurry = rowVerdict(tileWith(pageWithGate(reading("blurry")), "pt"), copy);
  assert.equal(blurry.state, "warned");
  assert.equal(blurry.word, copy.tiles.chip.blurry);
  assert.equal(isProblemRow(blurry.state), false);

  const small = rowVerdict(
    tileWith(pageWithGate(reading("too_small")), "pt"),
    copy,
  );
  assert.equal(small.word, copy.tiles.chip.tooSmall);
});

test("only a measured pass is called ótima, and a row is never left wordless", () => {
  for (const lang of LANGS) {
    const copy = APP_COPY[lang];

    const good = rowVerdict(tileWith(pageWithGate(reading("ok")), lang), copy);
    assert.equal(good.state, "ok");
    assert.equal(good.word, copy.review.state.ok);

    const unmeasured = rowVerdict(tileWith(pageWithGate(null), lang), copy);
    assert.equal(unmeasured.state, "quiet");
    assert.notEqual(unmeasured.word, copy.review.state.ok);
    assert.equal(unmeasured.word, copy.review.state.unverified);

    const working: ScanPage = {
      ...pageWithGate(null),
      status: "processing",
    };
    const busy = rowVerdict(tileWith(working, lang), copy);
    assert.equal(busy.state, "quiet");
    assert.equal(busy.word, copy.review.state.processing);

    for (const verdict of [good, unmeasured, busy]) {
      assert.ok(verdict.word.length > 0, "a row always has a word");
    }
  }
});
