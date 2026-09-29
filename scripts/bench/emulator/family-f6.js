/**
 * F6 — hard negatives: no document anywhere in the frame.
 *
 * Every scene here is a desk with things on it that are rectangles with
 * clean edges and a page's proportions — a laptop, a closed notebook, a woven
 * place mat, a keyboard, a phone and a remote — or nothing at all. Any quad a
 * variant accepts here is a false positive: the viewfinder would have told
 * the user it had found their page.
 */

import { registerFamily } from "./scene.js";
import {
  anyDesk,
  framingCamera,
  indoorLighting,
  makeProp,
  phoneSensor,
  scatter,
  wanderCamera,
} from "./kit.js";

registerFamily({
  id: "F6",
  title: "hard negatives",
  describe: "no document: an empty desk, a laptop, a closed notebook, a place mat, a keyboard, or a phone and a remote",
  sample(rng, { frame }) {
    const setting = rng.fork("setting").pick(["empty-desk", "laptop", "notebook", "placemat", "keyboard", "clutter"]);
    const layout = rng.fork("layout");
    const desk = anyDesk(rng.fork("background"));
    const cameraRng = rng.fork("camera");
    const layers = [];
    let camera;
    if (setting === "empty-desk") {
      camera = wanderCamera(cameraRng, frame, { target: [layout.range(-200, 200), layout.range(-200, 200)] });
    } else if (setting === "clutter") {
      const spot = { center: [0, 0], size: [120, 160], rotation: layout.range(-20, 20) };
      layers.push(...scatter(rng.fork("props"), spot, layout.pick([["phone", "remote"], ["phone", "notebook"], ["remote", "phone", "notebook"]])));
      camera = wanderCamera(cameraRng, frame, { target: spot.center, distance: [300, 480] });
    } else {
      const main = makeProp(setting, rng.fork("main"), { center: [0, 0], rotation: layout.range(-25, 25) });
      if (layout.chance(0.4)) layers.push(...scatter(rng.fork("props"), main, [layout.pick(["phone", "remote"])]));
      layers.push(main);
      camera = framingCamera(cameraRng, frame, main, { coverage: cameraRng.range(0.2, 0.6), tilt: [0, 22] });
    }
    return {
      setting,
      desk: desk.kind,
      camera,
      background: desk.surface,
      layers,
      lighting: indoorLighting(rng.fork("light")),
      post: phoneSensor(rng.fork("sensor")),
    };
  },
});
