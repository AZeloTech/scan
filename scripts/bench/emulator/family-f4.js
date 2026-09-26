/**
 * F4 — geometry and optics: the page is there, the picture is not clean.
 *
 *  - **tilt** — the phone held at 25–45° off vertical: strong keystone, and
 *    the far edge small;
 *  - **motion** — the hand moved during the exposure: a 6–20 px smear
 *    (rendered, not faked: every sample sits on its own pose along it);
 *  - **defocus** — the lens hunting: a 2–5 px blur;
 *  - **curl** — the page does not lie flat: one edge lifts, or the sheet
 *    keeps the roll it was carried in. The ground-truth corners are the
 *    projected paper corners; the outline is the projected curved boundary.
 */

import { registerFamily } from "./scene.js";
import { anyDesk, framingCamera, indoorLighting, motionShake, page, paperDocument, phoneSensor } from "./kit.js";

registerFamily({
  id: "F4",
  title: "tilt, motion blur, defocus, curl",
  describe: "steep tilt (25-45°), a 6-20 px motion smear, a 2-5 px defocus, or a curled page",
  sample(rng, { frame }) {
    const setting = rng.fork("setting").pick(["tilt", "motion", "defocus", "curl"]);
    const layout = rng.fork("layout");
    const desk = anyDesk(rng.fork("background"));
    const paper = page(rng.fork("page"), {
      type: paperDocument(layout),
      rotation: layout.range(-15, 15),
      curl: setting === "curl" ? 1 : 0,
      crease: 0.1,
    });
    const cameraRng = rng.fork("camera");
    const camera = framingCamera(cameraRng, frame, paper, {
      coverage: cameraRng.range(0.25, 0.6),
      tilt: setting === "tilt" ? [25, 45] : [0, 18],
    });
    const post = phoneSensor(rng.fork("sensor"));
    const optics = rng.fork("optics");
    if (setting === "defocus") post.blurSigma = optics.range(2, 5);
    const smear = optics.range(6, 20) * (Math.min(frame.width, frame.height) / 1080);
    const shake = setting === "motion" ? motionShake(optics, camera, frame, { lengthPx: smear }) : [];
    // Eight poses make eight ghosts; a lens blur of half their spacing
    // melts them into one smear.
    if (setting === "motion") post.blurSigma = Math.max(post.blurSigma, (smear / 8) * 0.6);
    return {
      setting,
      desk: desk.kind,
      camera,
      shake,
      background: desk.surface,
      layers: [paper],
      lighting: indoorLighting(rng.fork("light")),
      post,
    };
  },
});
