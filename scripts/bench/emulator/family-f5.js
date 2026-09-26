/**
 * F5 — occlusion, partial frame, two documents: the page is not all there,
 * or not alone.
 *
 *  - **finger** — a thumb holding the page down, over a corner or an edge;
 *  - **partial** — the user is too close or aimed off to one side: one or
 *    two corners are outside the frame (the ground truth keeps them, out
 *    there, with `inFrame` false);
 *  - **two-docs** — a second document beside the first, or tucked under it;
 *    the scan is about the one the camera is centred on (`primaryPage`);
 *  - **object-on-page** — a phone or a remote lying across one corner.
 */

import { registerFamily } from "./scene.js";
import {
  anyDesk,
  cornerPixels,
  framingCamera,
  indoorLighting,
  makeProp,
  page,
  paperDocument,
  partialCamera,
  phoneSensor,
  pixelsPerMm,
} from "./kit.js";
import { fingerOver } from "./effects.js";

const DEG = Math.PI / 180;

/** A desk point in a layer's own frame → world mm. */
function toWorld(layer, [x, y]) {
  const a = (layer.rotation ?? 0) * DEG;
  return [
    layer.center[0] + Math.cos(a) * x - Math.sin(a) * y,
    layer.center[1] + Math.sin(a) * x + Math.cos(a) * y,
  ];
}

registerFamily({
  id: "F5",
  title: "occlusion, partial frame, two documents",
  describe: "a finger over a corner or edge, one or two corners out of frame, a second document, or an object on the page",
  sample(rng, { frame }) {
    const setting = rng.fork("setting").pick(["finger", "partial", "two-docs", "object-on-page"]);
    const layout = rng.fork("layout");
    const desk = anyDesk(rng.fork("background"));
    const paper = page(rng.fork("page"), { type: paperDocument(layout), rotation: layout.range(-15, 15) });
    const cameraRng = rng.fork("camera");
    const fx = rng.fork("fx");
    const layers = [];
    const effects = [];
    let camera;
    let primaryPage = 0;
    if (setting === "two-docs") {
      const other = page(rng.fork("second"), {
        type: layout.pick(["lab-report", "form", "letter", "receipt", "id-card", "note"]),
        rotation: paper.rotation + layout.range(-25, 25),
      });
      const tucked = layout.chance(0.4);
      const bearing = layout.range(0, Math.PI * 2);
      const reach = tucked
        ? layout.range(0.3, 0.6) * Math.hypot(...paper.size) / 2
        : (Math.hypot(...paper.size) + Math.hypot(...other.size)) / 2 * layout.range(0.75, 1.0);
      other.center = [Math.cos(bearing) * reach, Math.sin(bearing) * reach];
      if (tucked) {
        // Under the primary page: the primary stays whole, the other peeks out.
        paper.height += other.height;
        layers.push(other, paper);
        primaryPage = 1;
      } else {
        layers.push(paper, other);
      }
      // Frame both: the camera aims between them, sized to hold the pair.
      const span = {
        center: [other.center[0] * 0.3, other.center[1] * 0.3],
        size: [paper.size[0] + Math.abs(other.center[0]) * 0.8, paper.size[1] + Math.abs(other.center[1]) * 0.8],
        rotation: paper.rotation,
      };
      camera = framingCamera(cameraRng, frame, span, { coverage: cameraRng.range(0.45, 0.75), tilt: [0, 18] });
    } else if (setting === "partial") {
      layers.push(paper);
      camera = partialCamera(cameraRng, frame, paper, {
        coverage: cameraRng.range(0.35, 0.7),
        cut: cameraRng.chance(0.55) ? 1 : 2,
      });
    } else {
      layers.push(paper);
      camera = framingCamera(cameraRng, frame, paper, { coverage: cameraRng.range(0.3, 0.65), tilt: [0, 18] });
      const corner = fx.int(0, 3);
      const halfW = paper.size[0] / 2;
      const halfH = paper.size[1] / 2;
      const local = [
        [-halfW, -halfH],
        [halfW, -halfH],
        [halfW, halfH],
        [-halfW, halfH],
      ];
      if (setting === "finger") {
        const px = cornerPixels(camera, frame, paper);
        const onEdge = fx.chance(0.4);
        const target = onEdge
          ? [
              px[corner][0] + (px[(corner + 1) % 4][0] - px[corner][0]) * fx.range(0.25, 0.75),
              px[corner][1] + (px[(corner + 1) % 4][1] - px[corner][1]) * fx.range(0.25, 0.75),
            ]
          : px[corner];
        const world = toWorld(paper, local[corner]);
        const centre = px.reduce((sum, p) => [sum[0] + p[0] / 4, sum[1] + p[1] / 4], [0, 0]);
        effects.push(fingerOver(fx, frame, target, pixelsPerMm(camera, frame, world), centre));
      } else {
        const kind = fx.pick(["phone", "remote"]);
        const made = makeProp(kind, fx, { center: [0, 0], rotation: paper.rotation + fx.range(-40, 40) });
        // Set down across the corner: its centre a little outside it.
        const out = [local[corner][0] * 1.05, local[corner][1] * 1.02];
        made.center = toWorld(paper, out);
        made.height += paper.height;
        made.shadowHeight = made.height;
        layers.push(made);
      }
    }
    return {
      setting,
      desk: desk.kind,
      camera,
      background: desk.surface,
      layers,
      effects,
      primaryPage,
      lighting: indoorLighting(rng.fork("light")),
      post: phoneSensor(rng.fork("sensor")),
    };
  },
});
