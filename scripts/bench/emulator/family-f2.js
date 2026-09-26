/**
 * F2 — low contrast, shadow and glare: the page is findable, but only just.
 *
 *  - **white-table / grey-table** — white paper on a white or light-grey
 *    table: the page's edge is a few grey levels, not a cliff;
 *  - **shadow** — the hand holding the phone throws a big soft shadow across
 *    part of the page, so one side of its edge is dim and the other is not;
 *  - **glare** — an overhead lamp's hot spot sits on the page near an edge or
 *    a corner and washes it out;
 *  - **dim** — a warm, dim room: auto-exposure gains the sensor up, and the
 *    noise with it.
 */

import { registerFamily } from "./scene.js";
import {
  anyDesk,
  cornerPixels,
  framingCamera,
  glare,
  handShadow,
  indoorLighting,
  lightWood,
  page,
  paleTable,
  paperDocument,
  phoneSensor,
} from "./kit.js";

registerFamily({
  id: "F2",
  title: "low contrast, shadow, glare",
  describe:
    "white paper on a white or light-grey table, a hand's shadow across the page, a lamp's glare on it, or a dim warm room",
  sample(rng, { frame }) {
    const setting = rng.fork("setting").pick(["white-table", "grey-table", "shadow", "glare", "dim"]);
    const layout = rng.fork("layout");
    const deskRng = rng.fork("background");
    let background;
    if (setting === "white-table") background = paleTable(deskRng);
    else if (setting === "grey-table") background = paleTable(deskRng, { grey: true });
    else if (setting === "dim") background = anyDesk(deskRng).surface;
    else background = deskRng.chance(0.5) ? paleTable(deskRng, { grey: deskRng.chance(0.3) }) : lightWood(deskRng);
    const paper = page(rng.fork("page"), {
      type: paperDocument(layout),
      rotation: layout.range(-15, 15),
      crease: 0.15,
    });
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, paper, {
      coverage: cameraRng.range(0.25, 0.7),
      tilt: [0, 22],
    });
    const corners = cornerPixels(camera, frame, paper);
    const fx = rng.fork("fx");
    const blobs = [];
    if (setting === "shadow") blobs.push(handShadow(fx, frame, fx.pick(corners)));
    if (setting === "glare") {
      const a = fx.int(0, 3);
      const t = fx.chance(0.4) ? 0 : fx.range(0.2, 0.8);
      const [p, q] = [corners[a], corners[(a + 1) % 4]];
      blobs.push(glare(fx, frame, [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]));
    }
    const dim = setting === "dim";
    return {
      setting,
      camera,
      background,
      layers: [paper],
      blobs,
      lighting: indoorLighting(rng.fork("light"), {
        exposure: dim ? [0.3, 0.5] : [0.95, 1.15],
        temperature: dim ? [2700, 3400] : [3200, 6500],
      }),
      post: phoneSensor(rng.fork("sensor"), { gain: dim ? 3 : 1 }),
    };
  },
});
