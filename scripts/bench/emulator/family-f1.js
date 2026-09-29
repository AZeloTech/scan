/**
 * F1 — desk lock: the regime of the D-343 field report.
 *
 * A lab report photographed from a normal handheld distance, covering 25–60 %
 * of the frame, on one of the two desks from the field stills:
 *
 *  - **dark granite** — high contrast, a clean page edge; the easy half, and
 *    the control;
 *  - **light wood with a leather desk mat** (and, most of the time, a document
 *    folder under the page) — the mat and the folder are large rectangles with
 *    their own clean edges, and at 25–35 % page coverage the page itself sits
 *    under the 0.35 coverage floor while the mat does not. This is where the
 *    classical detector's confident answer is the desk.
 */

import { registerFamily } from "./scene.js";
import {
  darkGranite,
  folder,
  framingCamera,
  indoorLighting,
  leatherDeskMat,
  lightWood,
  page,
  phoneSensor,
} from "./kit.js";

registerFamily({
  id: "F1",
  title: "desk lock",
  describe:
    "A4 lab report at 25-60 % of the frame on dark granite, or on light wood with a leather desk mat and a folder",
  sample(rng, { frame }) {
    const setting = rng.fork("setting").pick(["granite", "wood-mat"]);
    const layout = rng.fork("layout");
    const pageRotation = layout.range(-12, 12);
    const layers = [];
    let background;
    let stack = 0;
    if (setting === "granite") {
      background = darkGranite(rng.fork("background"));
    } else {
      background = lightWood(rng.fork("background"));
      const mat = leatherDeskMat(rng.fork("mat"), {
        center: [layout.range(-160, 160), layout.range(-50, 50)],
        rotation: pageRotation + layout.range(-6, 6),
      });
      layers.push(mat);
      stack += mat.height;
      if (layout.chance(0.75)) {
        const under = folder(rng.fork("folder"), {
          center: [layout.range(-45, 45), layout.range(-35, 35)],
          rotation: pageRotation + layout.range(-8, 8),
        });
        layers.push(under);
        stack += under.height;
      }
    }
    const paper = page(rng.fork("page"), {
      type: "lab-report",
      rotation: pageRotation,
      height: stack,
    });
    layers.push(paper);
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, paper, {
      coverage: cameraRng.range(0.25, 0.6),
      tilt: [0, 20],
    });
    return {
      setting,
      camera,
      background,
      layers,
      lighting: indoorLighting(rng.fork("light"), {
        // A dark counter drives auto-exposure up: the page runs bright.
        exposure: setting === "granite" ? [1.0, 1.25] : [0.9, 1.1],
      }),
      post: phoneSensor(rng.fork("sensor")),
    };
  },
});
