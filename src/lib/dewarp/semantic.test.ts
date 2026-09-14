/**
 * The A/B check, on pages built to have a known answer.
 *
 * Straightness is measured against synthetic "text" whose bow is set by
 * construction: a baseline drawn with a sagitta of S pixels must come back as
 * S/height, because that is the definition the metric claims to compute. The
 * verdict table is then exercised on measurements alone — no pixels — because
 * the policy it encodes ("fall back unless the dewarp is clearly better") is
 * the part that has to stay auditable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CURVATURE_IMPROVEMENT_RATIO,
  LARGE_DEFORMATION_MEAN_FRACTION,
  MIN_LINE_EVIDENCE,
  type SemanticMeasurement,
  lineStraightness,
  occupancyStats,
  semanticVerdict,
  toGray,
} from "./semantic.ts";
import type { RgbaImage } from "./types.ts";

const PAGE_WIDTH = 448;
const PAGE_HEIGHT = 600;

/**
 * A page of "text": rows of dark blobs on white, each row bowed by `sagitta`
 * pixels away from the chord through its own ends.
 */
function textPage(sagitta: number): RgbaImage {
  const data = new Uint8ClampedArray(PAGE_WIDTH * PAGE_HEIGHT * 4);
  data.fill(255);
  const firstX = 40;
  const lastX = 400;
  const middle = (firstX + lastX) / 2;
  const half = (lastX - firstX) / 2;
  for (let lineY = 60; lineY <= PAGE_HEIGHT - 60; lineY += 40) {
    for (let x = firstX; x <= lastX; x += 20) {
      const t = (x - middle) / half;
      const y = Math.round(lineY + sagitta * t * t);
      for (let dy = 0; dy < 10; dy += 1) {
        for (let dx = 0; dx < 12; dx += 1) {
          const px = x + dx;
          const py = y + dy;
          if (px >= PAGE_WIDTH || py >= PAGE_HEIGHT) continue;
          const offset = (py * PAGE_WIDTH + px) * 4;
          data[offset] = 20;
          data[offset + 1] = 20;
          data[offset + 2] = 20;
        }
      }
    }
  }
  return { width: PAGE_WIDTH, height: PAGE_HEIGHT, data };
}

/**
 * The same page with its last rows overwritten by a copy of a row that has
 * text on it — what edge-clamped sampling does when the map runs off the page.
 */
function withEdgeSmear(page: RgbaImage, rows: number, sourceRow: number): RgbaImage {
  const data = new Uint8ClampedArray(page.data);
  for (let row = page.height - rows; row < page.height; row += 1) {
    data.copyWithin(
      row * page.width * 4,
      sourceRow * page.width * 4,
      (sourceRow + 1) * page.width * 4,
    );
  }
  return { width: page.width, height: page.height, data };
}

test("straightness reports the sagitta the page was drawn with", () => {
  const straight = lineStraightness(toGray(textPage(0)));
  const bowed = lineStraightness(toGray(textPage(12)));

  assert.ok(straight.lineCount >= 10, `only ${straight.lineCount} straight lines`);
  assert.ok(bowed.lineCount >= 10, `only ${bowed.lineCount} bowed lines`);

  // A ruler-straight page: the fit finds no bow worth speaking of.
  assert.ok(
    straight.medianCurvature < 0.002,
    `straight page measured ${straight.medianCurvature}`,
  );
  // 12 px of sagitta on a 600 px page is 0.02 by construction.
  assert.ok(
    Math.abs(bowed.medianCurvature - 12 / PAGE_HEIGHT) < 0.005,
    `bowed page measured ${bowed.medianCurvature}, expected ~${12 / PAGE_HEIGHT}`,
  );
});

test("occupancy sees a repeated edge strip and does not see one on a clean page", () => {
  const clean = occupancyStats(toGray(textPage(0)));
  // Row 545 is inside the last line of text, so the smeared strip has content.
  const smeared = occupancyStats(toGray(withEdgeSmear(textPage(0), 6, 545)));

  // A page whose margins are simply blank must not read as smeared.
  assert.equal(clean.borderRepeatScore, 0, `clean page scored ${clean.borderRepeatScore}`);
  assert.equal(smeared.borderRepeatScore, 1);
  // The page is mostly white, so both readings agree there is a page there.
  assert.ok(clean.inkFraction > 0.05 && clean.inkFraction < 0.3);
});

test("occupancy notices ink that has been pushed off the page", () => {
  const full = occupancyStats(toGray(textPage(0)));
  const blanked = textPage(0);
  const half = new Uint8ClampedArray(blanked.data);
  half.fill(255, 0, half.length / 2);
  const emptied = occupancyStats(
    toGray({ width: blanked.width, height: blanked.height, data: half }),
  );
  assert.ok(
    full.inkFraction - emptied.inkFraction > 0.02,
    `ink went from ${full.inkFraction} to ${emptied.inkFraction}`,
  );
});

/* ── Verdict policy ────────────────────────────────────────────────────── */

function measurement(
  lineCount: number,
  curvature: number,
  occupancy: Partial<SemanticMeasurement["occupancy"]> = {},
): SemanticMeasurement {
  return {
    occupancy: {
      inkFraction: 0.12,
      blankBorderFraction: 0.6,
      borderRepeatScore: 0,
      ...occupancy,
    },
    straightness: { lineCount, medianCurvature: curvature },
  };
}

test("a failed structural guard ends it, whatever the pixels say", () => {
  const verdict = semanticVerdict({
    baseline: measurement(10, 0.02),
    candidate: measurement(10, 0.0),
    structuralOk: false,
    meanDisplacementFraction: 0.01,
    boundaryOffsetFraction: 0.0,
  });
  assert.deepEqual(verdict, { accept: false, rejection: "structural" });
});

test("a dewarp that straightens the text is accepted", () => {
  const verdict = semanticVerdict({
    baseline: measurement(12, 0.02),
    candidate: measurement(12, 0.004),
    structuralOk: true,
    meanDisplacementFraction: 0.03,
    boundaryOffsetFraction: 0.01,
  });
  assert.deepEqual(verdict, { accept: true });
});

test("a dewarp that bends the text further is rejected", () => {
  const verdict = semanticVerdict({
    baseline: measurement(12, 0.01),
    candidate: measurement(12, 0.05),
    structuralOk: true,
    meanDisplacementFraction: 0.03,
    boundaryOffsetFraction: 0.01,
  });
  assert.deepEqual(verdict, { accept: false, rejection: "regression" });
});

test("a large deformation has to pay for itself, not merely break even", () => {
  const large = LARGE_DEFORMATION_MEAN_FRACTION + 0.01;
  // Break-even at a large deformation: the risk is not worth nothing in return.
  assert.deepEqual(
    semanticVerdict({
      baseline: measurement(12, 0.02),
      candidate: measurement(12, 0.02),
      structuralOk: true,
      meanDisplacementFraction: large,
      boundaryOffsetFraction: 0.01,
    }),
    { accept: false, rejection: "regression" },
  );
  // The same reading at a small deformation is fine — "not worse" is enough.
  assert.deepEqual(
    semanticVerdict({
      baseline: measurement(12, 0.02),
      candidate: measurement(12, 0.02),
      structuralOk: true,
      meanDisplacementFraction: 0.01,
      boundaryOffsetFraction: 0.01,
    }),
    { accept: true },
  );
  // A measurable improvement clears the large-deformation bar.
  assert.deepEqual(
    semanticVerdict({
      baseline: measurement(12, 0.02),
      candidate: measurement(12, 0.02 * CURVATURE_IMPROVEMENT_RATIO - 0.001),
      structuralOk: true,
      meanDisplacementFraction: large,
      boundaryOffsetFraction: 0.01,
    }),
    { accept: true },
  );
});

test("losing page content is a regression even when the lines got straighter", () => {
  const verdict = semanticVerdict({
    baseline: measurement(12, 0.02, { inkFraction: 0.12 }),
    candidate: measurement(12, 0.0, { inkFraction: 0.05 }),
    structuralOk: true,
    meanDisplacementFraction: 0.02,
    boundaryOffsetFraction: 0.01,
  });
  assert.deepEqual(verdict, { accept: false, rejection: "regression" });
});

test("a repeated border strip is a regression on its own", () => {
  const verdict = semanticVerdict({
    baseline: measurement(12, 0.02, { borderRepeatScore: 0 }),
    candidate: measurement(12, 0.0, { borderRepeatScore: 1 }),
    structuralOk: true,
    meanDisplacementFraction: 0.02,
    boundaryOffsetFraction: 0.01,
  });
  assert.deepEqual(verdict, { accept: false, rejection: "regression" });
});

test("with too little text, only a timid, boundary-consistent dewarp is accepted", () => {
  const thin = MIN_LINE_EVIDENCE - 1;
  assert.deepEqual(
    semanticVerdict({
      baseline: measurement(thin, 0),
      candidate: measurement(thin, 0),
      structuralOk: true,
      meanDisplacementFraction: 0.01,
      boundaryOffsetFraction: 0.01,
    }),
    { accept: true },
  );
  // The same page with a deformation big enough to matter is not taken on faith.
  assert.deepEqual(
    semanticVerdict({
      baseline: measurement(thin, 0),
      candidate: measurement(thin, 0),
      structuralOk: true,
      meanDisplacementFraction: 0.2,
      boundaryOffsetFraction: 0.01,
    }),
    { accept: false, rejection: "insufficient-evidence" },
  );
  // …nor is one whose corners have drifted from the confirmed ones.
  assert.deepEqual(
    semanticVerdict({
      baseline: measurement(thin, 0),
      candidate: measurement(thin, 0),
      structuralOk: true,
      meanDisplacementFraction: 0.01,
      boundaryOffsetFraction: 0.04,
    }),
    { accept: false, rejection: "insufficient-evidence" },
  );
});
