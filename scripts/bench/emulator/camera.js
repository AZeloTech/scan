/**
 * The emulator's camera: a pinhole over a desk, and the homographies it makes.
 *
 * Pure maths — no DOM — so the unit tests run it under bare Node and the
 * renderer runs the very same code in the page. Ground truth is computed here,
 * from the pose, in double precision: a page corner's GT is the exact
 * projection of the paper's corner, never something measured off rendered
 * pixels.
 *
 * **World frame**, in millimetres: X to the right, Y down the desk (the way a
 * page reads), Z *into* the desk. The desk top is Z = 0 and anything lying on it
 * sits at Z = −height. That makes a camera looking straight down a camera with
 * no rotation at all: its x/y/z axes are the world's.
 *
 * **Image frame**, in pixels: continuous coordinates, the image spanning
 * [0, W] × [0, H], so pixel (i, j)'s centre is (i + 0.5, j + 0.5). The principal
 * point is the image centre. Normalized GT divides by W and H.
 *
 * 3×3 matrices are flat row-major arrays of nine numbers.
 */

/** A 35 mm frame's diagonal — what "26 mm equivalent" is measured against. */
const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24);

/** The main camera of most phones, in 35 mm-equivalent focal length. */
export const PHONE_FOCAL_35MM = 26;

export function mat3Mul(a, b) {
  const out = new Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return out;
}

export function mat3Transpose(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mat3Inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error("singular matrix");
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

export function mat3Vec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Apply a homography to a 2-D point: `[x', y']` after the homogeneous divide. */
export function applyHomography(h, x, y) {
  const [u, v, w] = mat3Vec(h, [x, y, 1]);
  return [u / w, v / w];
}

/** Rotation by `angle` radians about the unit `axis` (Rodrigues). */
export function rotationAbout(axis, angle) {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

const DEG = Math.PI / 180;

/** Focal length in pixels for a frame, from a 35 mm-equivalent focal length. */
export function focalPx(width, height, focal35 = PHONE_FOCAL_35MM) {
  return (focal35 * Math.hypot(width, height)) / FULL_FRAME_DIAGONAL_MM;
}

/**
 * A camera from a pose a person would describe.
 *
 * - `target` `[x, y]` mm — where the optical axis meets the desk.
 * - `distance` mm — from the lens to that point, along the axis.
 * - `tilt` deg — the axis's angle from straight down (0 = nadir).
 * - `azimuth` deg — which way the camera leans: the direction, on the desk, the
 *   axis travels towards as it tilts (0 = +X).
 * - `roll` deg — rotation about the optical axis (the page turning in frame).
 * - `focal35` — 35 mm-equivalent focal length.
 * - `focalPixels` — the focal length in this frame's pixels, when the frame is
 *   a crop or an enlargement of another one (a still photo from the same lens
 *   as the preview) rather than a frame of its own: overrides `focal35`.
 *
 * @returns {{ width: number, height: number, f: number, cx: number, cy: number,
 *   K: number[], R: number[], C: number[] }} R maps camera axes to world axes
 *   (its columns are the camera's x, y, z in world coordinates); C is the
 *   centre of projection.
 */
export function cameraFromPose(pose, frame) {
  const { width, height } = frame;
  const f = pose.focalPixels ?? focalPx(width, height, pose.focal35 ?? PHONE_FOCAL_35MM);
  const cx = width / 2;
  const cy = height / 2;
  const tilt = (pose.tilt ?? 0) * DEG;
  const azimuth = (pose.azimuth ?? 0) * DEG;
  const roll = (pose.roll ?? 0) * DEG;
  const rollMatrix = rotationAbout([0, 0, 1], roll);
  // Tilting swings the axis (0,0,1) towards (cos az, sin az, ·), about the
  // horizontal axis perpendicular to that direction.
  const tiltMatrix = rotationAbout([-Math.sin(azimuth), Math.cos(azimuth), 0], tilt);
  const R = mat3Mul(tiltMatrix, rollMatrix);
  const axis = [R[2], R[5], R[8]];
  const [tx, ty] = pose.target ?? [0, 0];
  const d = pose.distance;
  const C = [tx - d * axis[0], ty - d * axis[1], -d * axis[2]];
  const K = [f, 0, cx, 0, f, cy, 0, 0, 1];
  const camera = { width, height, f, cx, cy, K, R, C };
  // `frame.view`: the part of the frame the person sees on screen (frame
  // fractions) — what a scripted user frames the page in ({@link inFrame},
  // {@link projectedCoverage}). Rendering and ground truth ignore it.
  if (frame.view) camera.view = viewBounds(frame.view, width, height);
  return camera;
}

/** A `frame.view` (fractions) as pixel bounds. */
export function viewBounds(view, width, height) {
  return { l: view.x * width, t: view.y * height, r: (view.x + view.width) * width, b: (view.y + view.height) * height };
}

/** World point → pixel, with its depth along the optical axis (> 0 in front). */
export function project(camera, point) {
  const { R, C, f, cx, cy } = camera;
  const rel = [point[0] - C[0], point[1] - C[1], point[2] - C[2]];
  const cam = mat3Vec(mat3Transpose(R), rel);
  return { u: (f * cam[0]) / cam[2] + cx, v: (f * cam[1]) / cam[2] + cy, depth: cam[2] };
}

/**
 * The homography taking desk-plane millimetres `(X, Y)` at `height` mm above
 * the desk to pixels.
 */
export function planeHomography(camera, height = 0) {
  const { R, C, K } = camera;
  const Rt = mat3Transpose(R);
  const t = mat3Vec(Rt, [-C[0], -C[1], -height - C[2]]);
  // Columns: the world X and Y axes in camera coordinates, then the plane origin.
  const M = [Rt[0], Rt[1], t[0], Rt[3], Rt[4], t[1], Rt[6], Rt[7], t[2]];
  return mat3Mul(K, M);
}

/**
 * The matrix the shader casts rays with: pixel `(u, v, 1)` → world direction.
 * `R · K⁻¹`, row-major.
 */
export function rayMatrix(camera) {
  return mat3Mul(camera.R, mat3Inv(camera.K));
}

/**
 * A rectangle lying on the desk: its four corners in world mm, TL, TR, BR, BL
 * — lifted off the desk by its height, and by its curl where it has one.
 */
export function rectCorners(rect) {
  const [cx, cy] = rect.center;
  const [w, h] = rect.size;
  const angle = (rect.rotation ?? 0) * DEG;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const base = rect.height ?? 0;
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => [
    cx + c * x - s * y,
    cy + s * x + c * y,
    -(base + curlLift(rect.curl, [x, y], [w / 2, h / 2])),
  ]);
}

/**
 * How far a point of a curled page stands off the page's own plane, in mm —
 * the same function the shader evaluates (`curlLift`, `renderer.js`), so the
 * ground truth of a curled page is where the renderer puts it.
 *
 * `curl` is `{ mode, lift, reach, side }`: mode `edge-x` / `edge-y` lifts the
 * edge at `side` × half the extent along that axis, quadratically over `reach`
 * mm; `roll-x` / `roll-y` raises both edges of that axis (a sheet that was
 * rolled, or kept folded in a bag). `local` is in the page's own frame.
 */
export function curlLift(curl, local, halfSize) {
  if (curl === undefined || curl === null) return 0;
  const [x, y] = [
    Math.max(-halfSize[0], Math.min(halfSize[0], local[0])),
    Math.max(-halfSize[1], Math.min(halfSize[1], local[1])),
  ];
  const side = curl.side ?? 1;
  switch (curl.mode) {
    case "edge-x": {
      const d = halfSize[0] - side * x;
      return curl.lift * Math.max(0, 1 - d / curl.reach) ** 2;
    }
    case "edge-y": {
      const d = halfSize[1] - side * y;
      return curl.lift * Math.max(0, 1 - d / curl.reach) ** 2;
    }
    case "roll-x":
      return curl.lift * (x / halfSize[0]) ** 2;
    case "roll-y":
      return curl.lift * (y / halfSize[1]) ** 2;
    default:
      return 0;
  }
}

/** The shader's code for a curl mode (0 = flat). */
export const CURL_MODES = { "edge-x": 1, "edge-y": 2, "roll-x": 3, "roll-y": 4 };

/**
 * A layer's outline in world mm as a closed polyline, `perEdge` points an
 * edge, TL → TR → BR → BL — lifted where the page curls. A flat layer's
 * polyline is its four corners and the straight edges between them.
 */
export function layerOutline(layer, perEdge = 1) {
  const [cx, cy] = layer.center;
  const half = [layer.size[0] / 2, layer.size[1] / 2];
  const angle = (layer.rotation ?? 0) * DEG;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const base = layer.height ?? 0;
  const corners = [
    [-half[0], -half[1]],
    [half[0], -half[1]],
    [half[0], half[1]],
    [-half[0], half[1]],
  ];
  const out = [];
  for (let edge = 0; edge < 4; edge += 1) {
    const [ax, ay] = corners[edge];
    const [bx, by] = corners[(edge + 1) % 4];
    for (let k = 0; k < perEdge; k += 1) {
      const t = k / perEdge;
      const lx = ax + (bx - ax) * t;
      const ly = ay + (by - ay) * t;
      const lift = curlLift(layer.curl, [lx, ly], half);
      out.push([cx + c * lx - s * ly, cy + s * lx + c * ly, -(base + lift)]);
    }
  }
  return out;
}

/** Shoelace area of a polygon given as `[x, y]` points. Unsigned. */
export function polygonArea(points) {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[(index + 1) % points.length];
    doubled += ax * by - bx * ay;
  }
  return Math.abs(doubled) / 2;
}

/** A rect's projected corners in pixels, plus whether each is in front of the lens. */
export function projectRect(camera, rect) {
  return rectCorners(rect).map((point) => project(camera, point));
}

/**
 * How much of the frame a rect covers, projected — the quantity the families
 * sample ("the page covers 25–60 % of the frame"), not clipped to the frame.
 */
export function projectedCoverage(camera, rect) {
  const corners = projectRect(camera, rect);
  if (corners.some((p) => p.depth <= 0)) return Infinity;
  const v = camera.view;
  const area = v === undefined ? camera.width * camera.height : (v.r - v.l) * (v.b - v.t);
  return polygonArea(corners.map((p) => [p.u, p.v])) / area;
}

/**
 * The distance at which `rect` covers `coverage` of the frame, pose otherwise
 * fixed. Coverage falls monotonically with distance, so a bisection is exact
 * enough (well under a millimetre) in 60 steps.
 */
export function distanceForCoverage(pose, frame, rect, coverage) {
  let near = 30;
  let far = 20000;
  for (let step = 0; step < 60; step += 1) {
    const mid = (near + far) / 2;
    const covered = projectedCoverage(cameraFromPose({ ...pose, distance: mid }, frame), rect);
    if (covered > coverage) near = mid;
    else far = mid;
  }
  return (near + far) / 2;
}

/** Whether a pixel lies inside the frame, with an optional margin in pixels. */
export function inFrame(camera, point, margin = 0) {
  const v = camera.view ?? { l: 0, t: 0, r: camera.width, b: camera.height };
  return point.depth > 0 && point.u >= v.l + margin && point.v >= v.t + margin && point.u <= v.r - margin && point.v <= v.b - margin;
}

/**
 * The pose, re-aimed (its `target` moved on the desk, nothing else) so that
 * the world point `point` lands on pixel `[u, v]` — a few Newton steps on a
 * finite-difference Jacobian; the projection is smooth and near-linear in the
 * aim over a hand's reach.
 */
export function aimAt(pose, frame, point, [u, v]) {
  let out = pose;
  for (let step = 0; step < 6; step += 1) {
    const at = project(cameraFromPose(out, frame), point);
    const du = u - at.u;
    const dv = v - at.v;
    if (Math.hypot(du, dv) < 0.25) break;
    const h = 1;
    const px = project(cameraFromPose({ ...out, target: [out.target[0] + h, out.target[1]] }, frame), point);
    const py = project(cameraFromPose({ ...out, target: [out.target[0], out.target[1] + h] }, frame), point);
    const a = (px.u - at.u) / h;
    const b = (py.u - at.u) / h;
    const c = (px.v - at.v) / h;
    const d = (py.v - at.v) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) break;
    out = { ...out, target: [out.target[0] + (d * du - b * dv) / det, out.target[1] + (-c * du + a * dv) / det] };
  }
  return out;
}

/** The centre of `frame.view` in pixels (the frame's own centre without one). */
export function viewCenter(frame) {
  const v = frame.view;
  if (!v) return [frame.width / 2, frame.height / 2];
  return [(v.x + v.width / 2) * frame.width, (v.y + v.height / 2) * frame.height];
}
