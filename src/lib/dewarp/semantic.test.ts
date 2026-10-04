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

test("a few dark pixels on an edge are not a smeared strip", () => {
  // What a slightly rotated page leaves at its edge: a sliver of background a
  // few pixels long on the outermost row only, and a short run of glyph ink
  // on the outermost column that the next columns do not share.
  const page = textPage(0);
  const paint = (x: number, y: number) => {
    const offset = (y * page.width + x) * 4;
    page.data[offset] = 60;
    page.data[offset + 1] = 60;
    page.data[offset + 2] = 60;
  };
  for (let x = 0; x < 3; x += 1) paint(x, page.height - 1);
  for (let y = 100; y < 112; y += 1) paint(0, y);

  assert.equal(occupancyStats(toGray(page)).borderRepeatScore, 0);
});

test("a shadow darkening towards an edge is not a smeared strip", () => {
  // Every row of the shadow is off the paper and only a little darker than
  // the one inside it — close pixel by pixel, but not a copy.
  const page = textPage(0);
  for (let step = 0; step < 6; step += 1) {
    const row = page.height - 1 - step;
    const level = 150 + step * 8;
    for (let x = 0; x < page.width; x += 1) {
      const offset = (row * page.width + x) * 4;
      page.data[offset] = level;
      page.data[offset + 1] = level;
      page.data[offset + 2] = level;
    }
  }

  assert.equal(occupancyStats(toGray(page)).borderRepeatScore, 0);
});

/** Paints `rows` full rows at the top edge of the page with one grey level. */
function paintTopRows(page: RgbaImage, rows: number, level: number): void {
  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < page.width; x += 1) {
      const offset = (row * page.width + x) * 4;
      page.data[offset] = level;
      page.data[offset + 1] = level;
      page.data[offset + 2] = level;
    }
  }
}

test("a band of background framed in along an edge is a repeated strip", () => {
  // What a dewarp that pulls the table into the page leaves: every row of the
  // band is the same dark background. There is no spread along the strip to
  // see, but there is content on it, and it repeats inward.
  const page = textPage(0);
  paintTopRows(page, 8, 90);

  assert.equal(occupancyStats(toGray(page)).borderRepeatScore, 1);
});

test("a faint grey mark crossing an edge is not content to smear", () => {
  // A few percent of the top row a shade off the paper — the soft edge of a
  // shadow or a pale rule running off the page. It is the same in every row,
  // as anything crossing an edge is, but there is no print on it to lose.
  const page = textPage(0);
  for (let row = 0; row < 20; row += 1) {
    for (let x = 200; x < 214; x += 1) {
      const offset = (row * page.width + x) * 4;
      page.data[offset] = 236;
      page.data[offset + 1] = 236;
      page.data[offset + 2] = 236;
    }
  }

  assert.equal(occupancyStats(toGray(page)).borderRepeatScore, 0);
});

/** IJG's luminance quantisation table (JPEG Annex K), in natural order. */
const JPEG_LUMINANCE = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57,
  69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64,
  81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/**
 * The page through a greyscale JPEG round trip at `quality`: 8×8 DCT,
 * quantised with the IJG table scaled the way libjpeg scales it, and back.
 * Deterministic, and it rings at glyph edges the way a real encoder does —
 * differently on every row of a block, so a smeared strip's copies are no
 * longer equal pixel for pixel.
 */
function jpegRoundTrip(page: RgbaImage, quality: number): RgbaImage {
  const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
  const table = JPEG_LUMINANCE.map((base) =>
    Math.min(255, Math.max(1, Math.floor((base * scale + 50) / 100))),
  );
  const cosines: number[] = [];
  for (let x = 0; x < 8; x += 1) {
    for (let u = 0; u < 8; u += 1) {
      cosines.push(Math.cos(((2 * x + 1) * u * Math.PI) / 16));
    }
  }
  const weight = (u: number) => (u === 0 ? Math.SQRT1_2 : 1);
  const data = new Uint8ClampedArray(page.data);
  const block = new Float64Array(64);
  const coefficients = new Float64Array(64);
  for (let top = 0; top < page.height; top += 8) {
    for (let left = 0; left < page.width; left += 8) {
      // Edge blocks repeat their last row/column, as encoders pad them.
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          const py = Math.min(page.height - 1, top + y);
          const px = Math.min(page.width - 1, left + x);
          block[y * 8 + x] = page.data[(py * page.width + px) * 4] - 128;
        }
      }
      for (let v = 0; v < 8; v += 1) {
        for (let u = 0; u < 8; u += 1) {
          let sum = 0;
          for (let y = 0; y < 8; y += 1) {
            for (let x = 0; x < 8; x += 1) {
              sum += block[y * 8 + x] * cosines[x * 8 + u] * cosines[y * 8 + v];
            }
          }
          const step = table[v * 8 + u];
          coefficients[v * 8 + u] =
            Math.round((0.25 * weight(u) * weight(v) * sum) / step) * step;
        }
      }
      for (let y = 0; y < 8 && top + y < page.height; y += 1) {
        for (let x = 0; x < 8 && left + x < page.width; x += 1) {
          let sum = 0;
          for (let v = 0; v < 8; v += 1) {
            for (let u = 0; u < 8; u += 1) {
              sum +=
                weight(u) * weight(v) * coefficients[v * 8 + u] *
                cosines[x * 8 + u] * cosines[y * 8 + v];
            }
          }
          const offset = ((top + y) * page.width + left + x) * 4;
          const value = 0.25 * sum + 128;
          data[offset] = value;
          data[offset + 1] = value;
          data[offset + 2] = value;
        }
      }
    }
  }
  return { width: page.width, height: page.height, data };
}

/** The same page printed fainter: paper and ink squeezed towards each other. */
function faded(page: RgbaImage, paper: number, ink: number): RgbaImage {
  const data = new Uint8ClampedArray(page.data);
  for (let offset = 0; offset < data.length; offset += 4) {
    const value = ink + ((data[offset] - 20) * (paper - ink)) / (255 - 20);
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
  }
  return { width: page.width, height: page.height, data };
}

test("a smeared strip of text still reads as smeared after JPEG compression", () => {
  // The evasion case for the changed-pixel condition: the clamped rows start
  // out as exact copies, but JPEG rings around every glyph edge and rings
  // differently on each row of an 8×8 block. Crisp print rings hardest. The
  // copies are still copies — the ringing is small against the print's own
  // contrast — so the smear must still be seen, and the same page without it
  // must still read as clean.
  const cases: Array<[string, (page: RgbaImage) => RgbaImage]> = [
    ["crisp print", (page) => page],
    ["grey print", (page) => faded(page, 235, 110)],
    ["faded print", (page) => faded(page, 220, 150)],
    ["faint print", (page) => faded(page, 210, 170)],
  ];
  for (const [label, tone] of cases) {
    // Below 60 the strips drift apart on average too, and the mean
    // condition gives up on them — with or without the changed-pixel one.
    for (const quality of [95, 85, 75, 70, 60]) {
      // Row 545 is inside the last line of text, as in the smear test above.
      const smeared = jpegRoundTrip(tone(withEdgeSmear(textPage(0), 6, 545)), quality);
      const clean = jpegRoundTrip(tone(textPage(0)), quality);

      assert.equal(
        occupancyStats(toGray(smeared)).borderRepeatScore,
        1,
        `${label} at quality ${quality}: smear not seen`,
      );
      assert.equal(
        occupancyStats(toGray(clean)).borderRepeatScore,
        0,
        `${label} at quality ${quality}: clean page read as smeared`,
      );
    }
  }
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
