/**
 * F3 — size mix: not every document is an A4 sheet at arm's length.
 *
 *  - **a4** — the lab report, a form or a letter at 15–80 % of the frame;
 *  - **receipt** — an 80 mm till receipt, often curled, at 10–50 %;
 *  - **card** — an ID-1 health-plan card (plastic, rounded corners, a
 *    coloured full-bleed design) at 10–45 %;
 *  - **note** — a handwritten note on a pad sheet at 15–60 %;
 *  - **tiny** — a card or a receipt at 3–10 %: the user has not come closer
 *    yet, and the coverage floor meets a real page far below it.
 *
 * Coverage is sampled log-uniformly: small documents are where sizes differ.
 * Clutter sometimes lies around (a phone, a remote, a notebook).
 */

import { registerFamily } from "./scene.js";
import { anyDesk, framingCamera, indoorLighting, page, phoneSensor, scatter } from "./kit.js";

const RANGES = {
  a4: [0.15, 0.8],
  receipt: [0.1, 0.5],
  card: [0.1, 0.45],
  note: [0.15, 0.6],
  tiny: [0.03, 0.1],
};

function logUniform(rng, [low, high]) {
  return Math.exp(rng.range(Math.log(low), Math.log(high)));
}

registerFamily({
  id: "F3",
  title: "size mix",
  describe: "A4 sheets, 80 mm receipts, ID-1 cards and handwritten notes at 3-80 % of the frame",
  sample(rng, { frame }) {
    const setting = rng.fork("setting").weighted([
      ["a4", 3],
      ["receipt", 2],
      ["card", 2],
      ["note", 1],
      ["tiny", 2],
    ]);
    const layout = rng.fork("layout");
    const type =
      setting === "a4" ? layout.pick(["lab-report", "form", "letter"])
        : setting === "receipt" ? "receipt"
          : setting === "card" ? "id-card"
            : setting === "note" ? "note"
              : layout.pick(["receipt", "id-card"]);
    const desk = anyDesk(rng.fork("background"));
    const paper = page(rng.fork("page"), { type, rotation: layout.range(-20, 20), crease: setting === "a4" ? 0.2 : 0 });
    const layers = [];
    const clutterRng = rng.fork("clutter");
    if (clutterRng.chance(0.4)) {
      const kinds = clutterRng.pick([["phone"], ["remote"], ["notebook"], ["phone", "remote"]]);
      layers.push(...scatter(clutterRng, paper, kinds));
    }
    layers.push(paper);
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, paper, {
      coverage: logUniform(cameraRng, RANGES[setting]),
      tilt: [0, 20],
    });
    return {
      setting,
      desk: desk.kind,
      camera,
      background: desk.surface,
      layers,
      primaryPage: 0,
      lighting: indoorLighting(rng.fork("light")),
      post: phoneSensor(rng.fork("sensor")),
    };
  },
});
