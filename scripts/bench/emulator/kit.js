/**
 * The pieces families are sampled from: surfaces, props, a page, a camera that
 * frames it, light and a sensor.
 *
 * Each helper takes its own forked stream and returns plain params, so a family
 * reads as a recipe — "a lab report on dark granite, 25–60 % of the frame" —
 * and a new family (stage 2's low-contrast desks, receipts, fingers) is a new
 * recipe over the same pieces rather than a new renderer.
 *
 * Units: millimetres on the desk, degrees for angles, pixels in the image.
 */

import { cameraFromPose, distanceForCoverage, inFrame, project, projectRect } from "./camera.js";
import { documentSize, documentStock } from "./documents.js";

/* ── surfaces ───────────────────────────────────────────────────────────── */

/** Dark speckled granite — the kitchen-counter black of the D-343 stills. */
export function darkGranite(rng) {
  return {
    material: "granite",
    ground: rng.pick(["#151516", "#1b1a19", "#181a1e", "#211d1a"]),
    crystal: rng.pick(["#8f897f", "#7a7670", "#a3998b", "#6b6862", "#9a948c"]),
    cell: rng.range(2.2, 4.2),
    share: rng.range(0.12, 0.28),
    mottle: rng.range(0.2, 0.4),
    fine: rng.range(0.08, 0.22),
    seed: rng.seed32(),
  };
}

/** Light planked wood — a pine or oak desk. */
export function lightWood(rng) {
  const tone = rng.pick([
    ["#dcbf95", "#b48a5c"],
    ["#e3cba5", "#bf9a6c"],
    ["#cfa77c", "#a57a50"],
    ["#d8c09c", "#b09370"],
  ]);
  return {
    material: "wood",
    early: tone[0],
    late: tone[1],
    ring: rng.range(3, 7),
    plank: rng.range(90, 190),
    angle: rng.range(0, 180),
    figure: rng.range(0.5, 1.5),
    joint: rng.range(0.2, 0.45),
    seed: rng.seed32(),
  };
}

/* ── props ──────────────────────────────────────────────────────────────── */

/**
 * A leather desk mat: a big dark rectangle with its own clean, stitched edge —
 * exactly the kind of outline a contour detector prefers to the page.
 */
export function leatherDeskMat(rng, { center, rotation }) {
  const hide = rng.pick(["#2b2522", "#1f1f20", "#3a2a21", "#4a3326", "#23282e"]);
  return {
    name: "desk-mat",
    material: {
      material: "leather",
      hide,
      pebble: rng.range(0.8, 1.5),
      thread: rng.pick([hide, "#8a7d6b", "#5a4b3e", "#9a9a98"]),
      inset: rng.range(5, 9),
      crease: rng.range(0.3, 0.6),
      dye: rng.range(0.1, 0.25),
      rim: rng.range(0.2, 0.4),
      seed: rng.seed32(),
    },
    center,
    size: [rng.range(600, 900), rng.range(320, 480)],
    rotation,
    radius: rng.range(6, 14),
    height: 2.5,
    shadowHeight: 2.5,
    shadowStrength: rng.range(0.25, 0.45),
    softness: 0.25,
  };
}

/** A document folder: plastic in one of the usual colours, or manila card. */
export function folder(rng, { center, rotation }) {
  const kind = rng.pick(["blue", "smoke", "black", "red", "green", "manila"]);
  const open = rng.chance(0.3);
  const size = open ? [470, 320] : [235, 320];
  const base = {
    name: "folder",
    center,
    size,
    rotation,
    radius: rng.range(2, 5),
    height: 1,
    shadowHeight: 1.2,
    shadowStrength: rng.range(0.2, 0.4),
    softness: 0.2,
  };
  if (kind === "manila") {
    return {
      ...base,
      material: { material: "paper", tint: rng.pick(["#d8b87c", "#cfae74", "#e0c28c"]), fibre: 0.1, edge: 0.15, seed: rng.seed32() },
    };
  }
  const body = { blue: "#2a5caa", smoke: "#5b5f66", black: "#1c1c1e", red: "#a3262a", green: "#2f7d4f" }[kind];
  return {
    ...base,
    material: {
      material: "plastic",
      body,
      sheen: rng.range(0.2, 0.8),
      spine: rng.pick([body, "#202020"]),
      spineWidth: rng.chance(0.5) ? rng.range(8, 20) : 0,
      sheenAngle: rng.range(0, 180),
      peel: rng.range(0.05, 0.15),
      crease: open ? size[0] / 2 : rng.range(6, 14),
      seed: rng.seed32(),
    },
  };
}

/** A white or light-grey table: the page's own colour, give or take — low contrast. */
export function paleTable(rng, { grey = false } = {}) {
  return {
    material: "laminate",
    color: grey
      ? rng.pick(["#cfd1d2", "#c7c9c8", "#d6d4cf", "#bfc3c6"])
      : rng.pick(["#eeede9", "#f1f0ec", "#e9e8e3", "#ecebe6", "#f3f2ee"]),
    mottle: rng.range(0.03, 0.08),
    speckle: rng.range(0, 0.15),
    streak: rng.range(0, 0.08),
    streakAngle: rng.range(0, 180),
    sheen: rng.range(0, 0.06),
    seed: rng.seed32(),
  };
}

/** A tablecloth or a sofa arm: woven cloth, sometimes striped, never flat. */
export function fabric(rng) {
  const [warp, weft] = rng.pick([
    ["#8a9bb0", "#7d8ea3"], ["#b5a58c", "#a39377"], ["#6e7f66", "#627259"], ["#c9c2b8", "#bdb5aa"],
    ["#9b5b4f", "#8c4f44"], ["#3f4a5a", "#374150"], ["#d8d2c4", "#cfc8b8"],
  ]);
  return {
    material: "fabric",
    warp,
    weft,
    pitch: rng.range(0.6, 1.6),
    contrast: rng.range(0.4, 0.9),
    wrinkle: rng.range(0.05, 0.2),
    angle: rng.range(0, 180),
    stripe: rng.chance(0.3) ? rng.range(8, 30) : 0,
    seed: rng.seed32(),
  };
}

/** Any of the desks, for the families that do not care which. */
export function anyDesk(rng) {
  const kind = rng.weighted([
    ["granite", 2],
    ["wood", 3],
    ["white", 2],
    ["grey", 1],
    ["fabric", 1],
  ]);
  const surface =
    kind === "granite" ? darkGranite(rng)
      : kind === "wood" ? lightWood(rng)
        : kind === "white" ? paleTable(rng)
          : kind === "grey" ? paleTable(rng, { grey: true })
            : fabric(rng);
  return { kind, surface };
}

/* ── clutter: rectangles that are not documents ─────────────────────────── */

function prop(name, material, { center, rotation, size, radius, height, shadowStrength, softness = 0.3 }) {
  return {
    name,
    material,
    center,
    size,
    rotation,
    radius,
    height,
    shadowHeight: height,
    shadowStrength,
    softness,
  };
}

export function laptop(rng, { center, rotation, open = rng.chance(0.5) }) {
  return prop("laptop", {
    material: "laptop",
    body: rng.pick(["#b9bcc0", "#8e9196", "#4a4d52", "#d4d2cc", "#2e3035"]),
    brushing: rng.range(0.03, 0.08),
    keys: rng.pick(["#1d1e20", "#2a2b2e", "#e8e8e6"]),
    open,
    seed: rng.seed32(),
  }, {
    center,
    rotation,
    size: rng.pick([[304, 212], [325, 225], [357, 248]]),
    radius: rng.range(6, 12),
    height: open ? 9 : 16,
    shadowStrength: rng.range(0.35, 0.55),
  });
}

export function keyboard(rng, { center, rotation }) {
  const dark = rng.chance(0.6);
  return prop("keyboard", {
    material: "keyboard",
    body: dark ? "#1b1c1e" : "#d9d9d6",
    caps: dark ? rng.pick(["#26272a", "#303134"]) : rng.pick(["#f2f2ef", "#e6e6e2"]),
    pitch: 19,
    legend: rng.range(0.4, 0.9),
    rows: 6,
    border: rng.range(6, 12),
    seed: rng.seed32(),
  }, {
    center,
    rotation,
    size: [rng.range(360, 445), rng.range(120, 140)],
    radius: rng.range(4, 9),
    height: 22,
    shadowStrength: rng.range(0.35, 0.55),
  });
}

/** A notebook, closed: a card cover the size of a page, with a spine or a spiral. */
export function notebook(rng, { center, rotation, open = false }) {
  const cover = rng.pick(["#2d4f7c", "#8c2f39", "#2f6b4f", "#1f1f22", "#c28f2c", "#6a4c93", "#a9a39a"]);
  return prop("notebook", {
    material: "notebook",
    cover,
    label: rng.chance(0.5),
    binding: rng.pick(["#1a1a1a", "#b0b0b0", cover]),
    spiral: rng.chance(0.5),
    open,
    seed: rng.seed32(),
  }, {
    center,
    rotation,
    size: open ? [rng.range(290, 320), rng.range(200, 215)] : rng.pick([[148, 210], [180, 250], [200, 275]]),
    radius: rng.range(1, 4),
    height: open ? 6 : rng.range(6, 14),
    shadowStrength: rng.range(0.3, 0.5),
  });
}

export function phoneProp(rng, { center, rotation }) {
  return prop("phone", {
    material: "phone",
    body: rng.pick(["#101114", "#2b2d31", "#c9c6c0", "#2c3e50", "#7d6f63"]),
    screenUp: rng.chance(0.5),
    reflection: rng.range(0.3, 1),
    reflectionAngle: rng.range(0, 180),
    seed: rng.seed32(),
  }, {
    center,
    rotation,
    size: [rng.range(70, 78), rng.range(146, 163)],
    radius: rng.range(8, 11),
    height: 8.5,
    shadowStrength: rng.range(0.4, 0.6),
  });
}

export function remote(rng, { center, rotation }) {
  return prop("remote", {
    material: "remote",
    body: rng.pick(["#17181a", "#2a2a2c", "#3b3d40"]),
    button: rng.range(2.4, 3.4),
    buttons: rng.pick(["#55585c", "#8a8d91", "#6b2a2a"]),
    seed: rng.seed32(),
  }, {
    center,
    rotation,
    size: [rng.range(40, 50), rng.range(150, 190)],
    radius: rng.range(8, 14),
    height: 18,
    shadowStrength: rng.range(0.4, 0.6),
  });
}

/** A woven place mat: a page-sized rectangle with a clean bound edge. */
export function placemat(rng, { center, rotation }) {
  return prop("placemat", {
    material: "placemat",
    straw: rng.pick(["#c8ad7f", "#b89868", "#d9c7a3", "#8f7a5a", "#a8b3a0"]),
    strand: rng.range(2.5, 5),
    binding: rng.pick(["#6b4f35", "#3e3a36", "#8c2f39", "#c8ad7f"]),
    bindingWidth: rng.range(0, 10),
    contrast: rng.range(0.4, 0.8),
    seed: rng.seed32(),
  }, {
    center,
    rotation,
    size: [rng.range(400, 450), rng.range(290, 330)],
    radius: rng.range(3, 20),
    height: 2,
    shadowStrength: rng.range(0.2, 0.35),
  });
}

const PROP_MAKERS = { laptop, keyboard, notebook, phone: phoneProp, remote, placemat };

/** A named prop, for the families that pick clutter by name. */
export function makeProp(kind, rng, where) {
  const make = PROP_MAKERS[kind];
  if (make === undefined) throw new Error(`unknown prop "${kind}"`);
  return make(rng, where);
}

/**
 * Clutter around a page without covering it: each prop is set down beside
 * the page, at a random bearing, just far enough out that the two outlines
 * do not overlap (props may overlap each other — they stack).
 */
export function scatter(rng, around, kinds) {
  const halfDiagonal = Math.hypot(around.size[0], around.size[1]) / 2;
  return kinds.map((kind, index) => {
    const own = rng.fork(`prop-${index}`);
    const rotation = around.rotation + own.range(-25, 25);
    const made = makeProp(kind, own, { center: [0, 0], rotation });
    const reach = halfDiagonal + Math.hypot(made.size[0], made.size[1]) / 2 * own.range(0.55, 0.9) + own.range(5, 40);
    const bearing = own.range(0, Math.PI * 2);
    return {
      ...made,
      center: [around.center[0] + Math.cos(bearing) * reach, around.center[1] + Math.sin(bearing) * reach],
    };
  });
}

/* ── the page ───────────────────────────────────────────────────────────── */

/**
 * A printed page lying on the desk (or on whatever `height` of stack is under
 * it), on its document's own stock. `curl` and `crease` are chances (the
 * stock's own curl chance when not given): a curled page is a gentle height
 * field — one edge lifting, or a sheet that was rolled — and a crease is a fold
 * that was flattened again.
 */
export function page(rng, { type, center = [0, 0], rotation = 0, height = 0, curl, crease = 0 }) {
  const stock = documentStock(type);
  const docSeed = rng.seed32();
  const size = documentSize(type, docSeed);
  const shape = rng.fork("shape");
  let curled = null;
  if (shape.chance(curl ?? stock.curl)) {
    const long = size[1] >= size[0] ? "y" : "x";
    if (type === "receipt" || shape.chance(0.4)) {
      // Rolled: thermal paper remembers the roll it came off.
      const axis = type === "receipt" ? long : shape.pick(["x", "y"]);
      const half = (axis === "x" ? size[0] : size[1]) / 2;
      curled = {
        mode: `roll-${axis}`,
        lift: Math.min(shape.range(5, type === "receipt" ? 16 : 12), half * 0.25),
        reach: 1,
        side: 1,
      };
    } else {
      const axis = shape.pick(["x", "y"]);
      const extent = axis === "x" ? size[0] : size[1];
      // Paper bends, it does not fold up: the lift stays under a quarter of
      // the stretch it rises over (a slope of at most 1 in 2 at the edge).
      const reach = Math.max(30, extent * shape.range(0.2, 0.45));
      curled = {
        mode: `edge-${axis}`,
        lift: Math.min(shape.range(6, 18), reach * 0.25),
        reach,
        side: shape.pick([-1, 1]),
      };
    }
  }
  const folded = shape.chance(crease)
    ? { offset: shape.range(-0.2, 0.2) * size[1] + size[1] / 6, angle: 90 + shape.range(-2, 2), depth: shape.range(0.15, 0.45) }
    : null;
  return {
    name: "page",
    document: { type, seed: docSeed },
    material: {
      material: "paper",
      tint: rng.pick(stock.tints),
      fibre: rng.range(stock.fibre[0], stock.fibre[1]),
      edge: rng.range(stock.edge[0], stock.edge[1]),
      ...(folded === null ? {} : { crease: folded }),
      seed: rng.seed32(),
    },
    center,
    size,
    rotation,
    radius: stock.radius,
    height: height + stock.thickness,
    shadowHeight: rng.range(0.8, 2.5) + Math.max(0, stock.thickness - 0.1) * 2 + (curled === null ? 0 : curled.lift * 0.3),
    shadowStrength: rng.range(0.2, 0.4),
    softness: rng.range(0.12, 0.25),
    wobble: stock.radius > 1 ? 0 : rng.range(0.15, 0.4),
    ...(curled === null ? {} : { curl: curled }),
  };
}

/** One of the paper documents, weighted towards what people actually scan. */
export function paperDocument(rng) {
  return rng.weighted([
    ["lab-report", 4],
    ["form", 2],
    ["letter", 2],
    ["note", 1],
  ]);
}

/* ── the camera ─────────────────────────────────────────────────────────── */

/**
 * A handheld pose that shows `target` (a layer) at `coverage` of the frame,
 * wholly inside it with `marginFraction` to spare.
 *
 * Coverage fixes the distance; the aim point wanders around the page and is
 * pulled back towards its centre until the page fits. Landscape frames turn
 * the phone, not the page.
 */
export function framingCamera(
  rng,
  frame,
  target,
  { coverage, tilt = [0, 20], roll = [-6, 6], aimSpread = 25, marginFraction = 0.02 },
) {
  const turn = frame.width > frame.height ? 90 : 0;
  const pose = {
    tilt: rng.range(tilt[0], tilt[1]),
    azimuth: rng.range(0, 360),
    roll: rng.range(roll[0], roll[1]) + turn,
    focal35: 26,
  };
  const margin = marginFraction * Math.min(frame.width, frame.height);
  const offset = [rng.normal(0, 1), rng.normal(0, 1)];
  for (let shrink = 1; shrink >= 0; shrink -= 0.05) {
    const aim = [
      target.center[0] + offset[0] * aimSpread * shrink,
      target.center[1] + offset[1] * aimSpread * shrink,
    ];
    const candidate = { ...pose, target: aim };
    const distance = distanceForCoverage(candidate, frame, target, coverage);
    const camera = cameraFromPose({ ...candidate, distance }, frame);
    if (projectRect(camera, target).every((p) => inFrame(camera, p, margin))) {
      return { ...candidate, distance };
    }
  }
  // Too big to fit at this tilt with any aim: back off until it does.
  const aim = [...target.center];
  let distance = distanceForCoverage({ ...pose, target: aim }, frame, target, coverage);
  for (let step = 0; step < 200; step += 1) {
    const camera = cameraFromPose({ ...pose, target: aim, distance }, frame);
    if (projectRect(camera, target).every((p) => inFrame(camera, p, margin))) break;
    distance *= 1.01;
  }
  return { ...pose, target: aim, distance };
}

/**
 * A handheld pose that cuts `cut` (1 or 2) of the target's corners off the
 * frame — the user standing too close, or aiming off to one side. Starts from
 * a pose that fits the page at `coverage` and slides the aim away from the
 * corners it wants to lose until exactly that many have left.
 */
export function partialCamera(rng, frame, target, { coverage, cut = 1, tilt = [0, 18] }) {
  const pose = framingCamera(rng, frame, target, { coverage, tilt, marginFraction: 0.01 });
  const angle = ((target.rotation ?? 0) * Math.PI) / 180;
  const along = cut === 1
    ? rng.pick([[1, 1], [1, -1], [-1, 1], [-1, -1]])
    : rng.pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
  // Towards the corners to lose, in desk coordinates.
  const local = [along[0] * target.size[0], along[1] * target.size[1]];
  const direction = [
    Math.cos(angle) * local[0] - Math.sin(angle) * local[1],
    Math.sin(angle) * local[0] + Math.cos(angle) * local[1],
  ];
  const length = Math.hypot(direction[0], direction[1]);
  const unit = [direction[0] / length, direction[1] / length];
  const outside = (candidate) => {
    const camera = cameraFromPose(candidate, frame);
    return projectRect(camera, target).filter((p) => !inFrame(camera, p)).length;
  };
  // The aim moves AWAY from the corners that should leave the frame.
  let step = 0;
  let candidate = pose;
  while (step < 400) {
    const shifted = {
      ...pose,
      target: [pose.target[0] - unit[0] * step, pose.target[1] - unit[1] * step],
    };
    const out = outside(shifted);
    if (out >= cut) {
      candidate = shifted;
      // A little further, so the lost corners are clearly gone.
      const extra = rng.range(4, 25);
      const deeper = { ...pose, target: [shifted.target[0] - unit[0] * extra, shifted.target[1] - unit[1] * extra] };
      if (outside(deeper) === out) candidate = deeper;
      break;
    }
    step += 1;
  }
  return candidate;
}

/** A pose aimed at a desk point, at a handheld distance, for a scene with no page. */
export function wanderCamera(rng, frame, { target, distance = [220, 450], tilt = [0, 25] }) {
  const turn = frame.width > frame.height ? 90 : 0;
  return {
    tilt: rng.range(tilt[0], tilt[1]),
    azimuth: rng.range(0, 360),
    roll: rng.range(-8, 8) + turn,
    focal35: 26,
    target,
    distance: rng.range(distance[0], distance[1]),
  };
}

/** Where a layer's corners land in the frame, in pixels, for placing screen-space effects. */
export function cornerPixels(pose, frame, layer) {
  const camera = cameraFromPose(pose, frame);
  return projectRect(camera, layer).map((p) => [p.u, p.v]);
}

/** Pixels per millimetre on the desk at a point — the scale a finger or a shadow is drawn at. */
export function pixelsPerMm(pose, frame, point) {
  const camera = cameraFromPose(pose, frame);
  const a = project(camera, [point[0], point[1], 0]);
  const b = project(camera, [point[0] + 1, point[1], 0]);
  return Math.hypot(b.u - a.u, b.v - a.v);
}

/**
 * The shadow of the hand (or the phone) holding the camera: a big, soft,
 * elongated dark blob coming in from one side of the frame, partly over the
 * page. Screen space — the hand moves with the camera.
 */
export function handShadow(rng, frame, over) {
  const side = rng.pick(["left", "right", "top", "bottom"]);
  const { width, height } = frame;
  const [u, v] = over;
  const center = {
    left: [rng.range(-0.1, 0.15) * width, v + rng.range(-0.15, 0.15) * height],
    right: [rng.range(0.85, 1.1) * width, v + rng.range(-0.15, 0.15) * height],
    top: [u + rng.range(-0.15, 0.15) * width, rng.range(-0.05, 0.15) * height],
    bottom: [u + rng.range(-0.15, 0.15) * width, rng.range(0.85, 1.05) * height],
  }[side];
  const long = side === "left" || side === "right";
  const reach = Math.min(width, height);
  return {
    kind: "shadow",
    center,
    radius: long ? [reach * rng.range(0.45, 0.75), reach * rng.range(0.2, 0.35)] : [reach * rng.range(0.2, 0.35), reach * rng.range(0.45, 0.75)],
    angle: rng.range(-20, 20),
    strength: rng.range(0.35, 0.65),
    softness: rng.range(0.5, 0.9),
  };
}

/** A specular hot spot from an overhead lamp, near `over` (pixels). */
export function glare(rng, frame, over) {
  const reach = Math.min(frame.width, frame.height);
  return {
    kind: "glare",
    center: [over[0] + rng.range(-0.08, 0.08) * reach, over[1] + rng.range(-0.08, 0.08) * reach],
    radius: [reach * rng.range(0.06, 0.2), reach * rng.range(0.05, 0.16)],
    angle: rng.range(0, 180),
    strength: rng.range(0.45, 1.1),
    softness: rng.range(0.35, 0.8),
  };
}

/**
 * Hand shake during the exposure: `count` poses spread evenly along a
 * straight smear of `lengthPx` in the image, centred on the pose (so the
 * ground truth — the middle of the exposure — is the pose itself).
 */
export function motionShake(rng, pose, frame, { lengthPx, count = 8 }) {
  const camera = cameraFromPose(pose, frame);
  const mmPerPx = pose.distance / camera.f;
  const angle = rng.range(0, Math.PI * 2);
  const length = lengthPx * mmPerPx;
  const roll = rng.range(-0.6, 0.6);
  return Array.from({ length: count }, (_, i) => {
    const t = (i + 0.5) / count - 0.5;
    return {
      target: [Math.cos(angle) * length * t, Math.sin(angle) * length * t],
      roll: roll * t,
    };
  });
}

/* ── light and sensor ───────────────────────────────────────────────────── */

export function indoorLighting(rng, { exposure = [0.9, 1.1], temperature = [3200, 6500] } = {}) {
  return {
    temperature: rng.range(temperature[0], temperature[1]),
    whiteBalanceResidual: rng.range(0.15, 0.45),
    exposure: rng.range(exposure[0], exposure[1]),
    gradient: { angle: rng.range(0, 360), amount: rng.range(0.05, 0.3), scale: 400, at: [0, 0] },
    shadow: { angle: rng.range(0, 360), length: rng.range(0.4, 1) },
  };
}

/**
 * A phone camera's optics and sensor on an ordinary indoor shot. `gain` > 1
 * is a dim room: the sensor amplifies, and the noise with it.
 */
export function phoneSensor(rng, { gain = 1 } = {}) {
  return {
    blurSigma: rng.range(0.5, 1.1),
    vignette: rng.range(0.1, 0.35),
    noise: {
      shot: rng.range(0.008, 0.025) * Math.sqrt(gain),
      read: rng.range(0.002, 0.005) * gain,
      lumaShare: 0.7,
      seed: rng.seed32(),
    },
    jpeg: rng.range(0.82, 0.95),
  };
}
