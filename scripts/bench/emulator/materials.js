/**
 * Surface materials for the scene renderer, as GLSL, registered by name.
 *
 * Everything on the desk is shaded **procedurally, in desk-plane
 * millimetres**, per sample, inside the renderer's fragment shader: granite
 * speckle, wood grain, the pebbled leather of a desk mat. That is what makes
 * the emulator's desks perspective-correct at any distance without a texture
 * large enough to hold a metre of granite at 4 px/mm — and why a material is a
 * snippet of GLSL rather than an image.
 *
 * A material is a function `vec3 mat_<id>(Surface s)` returning **linear** RGB.
 * Colour parameters arrive already linear (see {@link srgbToLinear}); the
 * renderer lights, averages and encodes. A new material registers here and the
 * renderer picks it up the next time it compiles — nothing else changes.
 *
 * Detail that would be smaller than one sample fades out against
 * `s.footprint` (millimetres covered by one sample) — the procedural
 * equivalent of a mipmap, so far-away wood does not shimmer into noise.
 */

/** The noise library every material may use. Integer hashing: identical on every GPU. */
export const NOISE_GLSL = /* glsl */ `
uint hashU(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
uint hashCell(ivec2 cell, uint seed) {
  return hashU(uint(cell.x) * 0x8da6b343u ^ hashU(uint(cell.y) * 0xd8163841u ^ seed));
}
float hash01(ivec2 cell, uint seed) {
  return float(hashCell(cell, seed) >> 8u) * (1.0 / 16777216.0);
}
float valueNoise(vec2 p, uint seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 c = ivec2(i);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash01(c, seed);
  float b = hash01(c + ivec2(1, 0), seed);
  float d = hash01(c + ivec2(0, 1), seed);
  float e = hash01(c + ivec2(1, 1), seed);
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
float fbm(vec2 p, uint seed, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * valueNoise(p, seed + uint(i) * 0x9e37u);
    norm += amp;
    amp *= 0.5;
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(17.3, -9.1);
  }
  return sum / norm;
}
/* Worley: (F1, F2, id of the nearest feature). */
vec3 worley(vec2 p, uint seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 c = ivec2(i);
  float best = 8.0;
  float second = 8.0;
  float id = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      uint h = hashCell(c + ivec2(x, y), seed);
      vec2 jitter = vec2(float(h & 0xffffu), float(h >> 16u)) * (1.0 / 65535.0);
      vec2 d = vec2(float(x), float(y)) + jitter - f;
      float dist = dot(d, d);
      if (dist < best) {
        second = best;
        best = dist;
        id = float(hashU(h) >> 8u) * (1.0 / 16777216.0);
      } else if (dist < second) {
        second = dist;
      }
    }
  }
  return vec3(sqrt(best), sqrt(second), id);
}
float sdBox(vec2 p, vec2 halfSize) {
  vec2 q = abs(p) - halfSize;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
float sdRoundBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}
`;

/** What a material is handed for one sample. */
export const SURFACE_GLSL = /* glsl */ `
struct Surface {
  vec2 world;      // desk-plane point, mm
  vec2 local;      // the same point in the layer's own frame, mm, origin at its centre
  vec2 halfSize;   // the layer's half extent, mm
  float edge;      // signed distance to the layer's outline, mm (negative inside)
  float footprint; // mm one sample covers here
  vec4 a;
  vec4 b;
  vec4 c;          // c.w is always the material's integer seed
};
`;

const registry = new Map();

/**
 * Register a material.
 *
 * - `glsl` defines `vec3 mat_<id>(Surface s)`, `<id>` being `name` with dashes
 *   as underscores;
 * - `pack(spec)` turns the readable spec a family writes into the scene
 *   (`{ material: "granite", ground: "#1a1b1d", cell: 2.4, … }`) into the
 *   shader's `{ a, b, c }` vec4s. Colours are converted to linear here.
 */
export function registerMaterial(name, { glsl, pack, describe = "" }) {
  if (registry.has(name)) throw new Error(`material "${name}" is already registered`);
  registry.set(name, { name, glsl, pack, describe, index: registry.size });
}

/** A readable material spec → `{ material, a, b, c }` for the renderer. */
export function packMaterial(spec) {
  const entry = registry.get(spec.material);
  if (entry === undefined) throw new Error(`unknown material "${spec.material}"`);
  const { a = [0, 0, 0, 0], b = [0, 0, 0, 0], c = [0, 0, 0, 0] } = entry.pack(spec);
  // The seed rides in c.w as a float, so it must stay an exact integer there.
  return { material: spec.material, a, b, c: [c[0], c[1], c[2], (spec.seed ?? 0) % 16777216] };
}

function entryOf(name) {
  const entry = registry.get(name);
  if (entry === undefined) throw new Error(`unknown material "${name}"`);
  return entry;
}

/** The GLSL function a material compiles to. */
export function materialFunction(name) {
  return `mat_${entryOf(name).name.replace(/-/g, "_")}`;
}

/** A material's GLSL source. */
export function materialGlsl(name) {
  return entryOf(name).glsl;
}

export function materialNames() {
  return [...registry.keys()];
}

/** An sRGB colour (0–255 or a `#rrggbb` string) as linear 0–1 components. */
export function srgbToLinear(color) {
  const rgb =
    typeof color === "string"
      ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
      : color;
  return rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

const lin = srgbToLinear;
const rad = (deg) => (deg * Math.PI) / 180;

/* ── desks ──────────────────────────────────────────────────────────────── */

registerMaterial("solid", {
  glsl: /* glsl */ `
vec3 mat_solid(Surface s) {
  // a.rgb colour, a.w mottling amount
  float n = fbm(s.world / 25.0, uint(s.c.w), 3) - 0.5;
  return s.a.rgb * (1.0 + s.a.w * n);
}`,
  pack: (m) => ({ a: [...lin(m.color), m.mottle ?? 0.05] }),
  describe: "flat colour with a faint mottle",
});

registerMaterial("granite", {
  glsl: /* glsl */ `
vec3 mat_granite(Surface s) {
  // a.rgb ground mass, a.w crystal size (mm); b.rgb light crystals, b.w their
  // share; c.x mottling, c.y fine-speck share. Crystals are whole Voronoi cells
  // — angular, like a polished cut — with a dark seam between neighbours.
  uint seed = uint(s.c.w);
  float cell = s.a.w;
  vec2 p = s.world;
  float mottle = fbm(p / (cell * 12.0), seed, 3);
  vec3 w = worley(p / cell, seed ^ 0x51u);
  float seam = smoothstep(0.0, 0.1, w.y - w.x);
  float tone = fract(w.z * 57.0);
  vec3 col = s.a.rgb * (0.65 + 0.7 * tone) * mix(1.0 - s.c.x, 1.0 + s.c.x, mottle);
  // Three minerals, not one chip colour: pale feldspar/quartz, a mid grey,
  // and the dark ground mass — each crystal clouded inside.
  if (w.z < s.b.w) col = s.b.rgb * (0.55 + 0.8 * tone);
  else if (w.z < s.b.w * 1.5) col = mix(s.a.rgb, s.b.rgb, 0.12 + 0.18 * tone);
  float innerDetail = 1.0 - smoothstep(cell * 0.06, cell * 0.2, s.footprint);
  col *= 1.0 + 0.3 * (valueNoise(p / (cell * 0.22), seed ^ 0x77u) - 0.5) * innerDetail;
  col *= mix(0.72, 1.0, seam);
  float fineDetail = 1.0 - smoothstep(cell * 0.08, cell * 0.25, s.footprint);
  vec3 w2 = worley(p / (cell * 0.3), seed ^ 0x93u);
  if (w2.z < s.c.y) {
    col = mix(col, s.b.rgb * 0.8, smoothstep(0.03, 0.1, w2.y - w2.x) * fineDetail * 0.6);
  }
  return col;
}`,
  pack: (m) => ({
    a: [...lin(m.ground), m.cell],
    b: [...lin(m.crystal), m.share],
    c: [m.mottle, m.fine, 0],
  }),
  describe: "dark speckled stone",
});

registerMaterial("wood", {
  glsl: /* glsl */ `
vec3 mat_wood(Surface s) {
  // a.rgb earlywood, a.w ring spacing (mm); b.rgb latewood, b.w plank width (mm);
  // c.x grain angle (rad), c.y figure, c.z joint darkness
  uint seed = uint(s.c.w);
  float ca = cos(s.c.x);
  float sa = sin(s.c.x);
  vec2 q = vec2(ca * s.world.x + sa * s.world.y, -sa * s.world.x + ca * s.world.y);
  float plankWidth = s.b.w;
  float plank = floor(q.y / plankWidth);
  float ph = hash01(ivec2(int(plank), 7), seed);
  vec2 pq = vec2(q.x + ph * 5000.0, q.y);
  // Flat-sawn figure: the saw cut the growth rings at a slant, so along the
  // board the rings swing across it by several of their own spacings and come
  // back — nested arches ("cathedrals"), never parallel stripes.
  float arch = (fbm(vec2(pq.x / 380.0, plank * 1.7 + 3.0), seed ^ 0x1234u, 3) - 0.5) * s.c.y * 200.0;
  float wander = (fbm(vec2(pq.x / 90.0, pq.y / 25.0), seed ^ 0x4321u, 2) - 0.5) * 6.0;
  float rings = (pq.y + arch + wander) / s.a.w;
  // Uneven years: some rings wide, some narrow.
  rings += 1.4 * valueNoise(vec2(rings * 0.23, plank), seed ^ 0x777u);
  float r = fract(rings);
  float late = smoothstep(0.62, 0.86, r) * (1.0 - smoothstep(0.9, 1.0, r));
  float ringContrast = 0.18 + 0.22 * valueNoise(vec2(pq.x / 300.0, pq.y / 40.0), seed ^ 0x31u);
  float ringDetail = 1.0 - smoothstep(s.a.w * 0.12, s.a.w * 0.45, s.footprint);
  vec3 col = mix(s.a.rgb, s.b.rgb, clamp(late * ringContrast * ringDetail + (ph - 0.5) * 0.3, 0.0, 1.0));
  // Colour drifts along the board.
  col *= 0.94 + 0.12 * fbm(vec2(pq.x / 160.0, pq.y / 30.0), seed ^ 0x99u, 3);
  // Pores: short dark dashes along the grain, sparse, gone once they are smaller than a sample.
  float poreDetail = 1.0 - smoothstep(0.08, 0.22, s.footprint);
  float pore = smoothstep(0.78, 0.9, valueNoise(vec2(pq.x / 1.6, (pq.y + arch) / 0.28), seed ^ 0x55u));
  col *= 1.0 - 0.18 * pore * poreDetail;
  float fy = q.y - plank * plankWidth;
  float joint = min(fy, plankWidth - fy);
  col *= mix(1.0 - s.c.z, 1.0, smoothstep(0.15, 0.9 + s.footprint, joint));
  return col;
}`,
  pack: (m) => ({
    a: [...lin(m.early), m.ring],
    b: [...lin(m.late), m.plank],
    c: [rad(m.angle), m.figure, m.joint],
  }),
  describe: "planked wood: flat-sawn figure, uneven rings, pores",
});

registerMaterial("leather", {
  glsl: /* glsl */ `
vec3 mat_leather(Surface s) {
  // a.rgb hide, a.w pebble size (mm); b.rgb thread, b.w stitch inset (mm);
  // c.x crease depth, c.y dye unevenness, c.z rim darkening
  uint seed = uint(s.c.w);
  vec2 p = s.local;
  vec3 w = worley(p / s.a.w, seed);
  float crease = smoothstep(0.0, 0.3, w.y - w.x);
  float detail = 1.0 - smoothstep(s.a.w * 0.35, s.a.w * 1.1, s.footprint);
  vec3 col = s.a.rgb * mix(1.0, 0.75 + 0.25 * crease, detail * s.c.x);
  col *= 1.0 + s.c.y * (fbm(p / 45.0, seed ^ 0x3u, 3) - 0.5);
  float inset = s.b.w;
  if (inset > 0.0) {
    vec2 inner = s.halfSize - vec2(inset);
    float sdInset = sdBox(p, inner);
    float along = (abs(p.x) - inner.x) > (abs(p.y) - inner.y) ? p.y : p.x;
    float dash = step(0.35, fract(along / 4.0));
    float thread = (1.0 - smoothstep(0.22, 0.42 + s.footprint, abs(sdInset))) * dash;
    col *= 1.0 - 0.18 * (1.0 - smoothstep(0.35, 1.1, abs(sdInset))) * (1.0 - dash);
    col = mix(col, s.b.rgb, thread * 0.9);
  }
  col *= mix(1.0 - s.c.z, 1.0, smoothstep(0.0, 2.5, -s.edge));
  return col;
}`,
  pack: (m) => ({
    a: [...lin(m.hide), m.pebble],
    b: [...lin(m.thread), m.inset],
    c: [m.crease, m.dye, m.rim],
  }),
  describe: "pebbled leather with a stitched border (a desk mat)",
});

registerMaterial("plastic", {
  glsl: /* glsl */ `
vec3 mat_plastic(Surface s) {
  // a.rgb body, a.w sheen; b.rgb spine, b.w spine width (mm);
  // c.x sheen direction (rad), c.y orange peel, c.z crease offset from the spine (mm)
  uint seed = uint(s.c.w);
  vec3 col = s.a.rgb;
  float peelDetail = 1.0 - smoothstep(0.2, 0.6, s.footprint);
  col *= 1.0 + s.c.y * (valueNoise(s.local / 0.7, seed) - 0.5) * peelDetail;
  float along = dot(s.local, vec2(cos(s.c.x), sin(s.c.x)));
  col += s.a.w * exp(-pow(along / (s.halfSize.x * 0.5), 2.0)) * vec3(0.12);
  float crease = abs(s.local.x + s.halfSize.x - s.c.z);
  col *= 1.0 - 0.3 * (1.0 - smoothstep(0.25, 0.9 + s.footprint, crease));
  if (s.local.x < -s.halfSize.x + s.b.w) col = s.b.rgb;
  return col;
}`,
  pack: (m) => ({
    a: [...lin(m.body), m.sheen],
    b: [...lin(m.spine), m.spineWidth],
    c: [rad(m.sheenAngle), m.peel, m.crease],
  }),
  describe: "a document folder: plastic body, darker spine, one crease",
});

registerMaterial("paper", {
  glsl: /* glsl */ `
vec3 mat_paper(Surface s) {
  // a.rgb tint, a.w fibre contrast; b.x edge darkening (the cut edge's
  // thickness); b.y crease offset (mm, along the crease normal), b.z crease
  // angle (rad), b.w crease depth (0 = no crease)
  uint seed = uint(s.c.w);
  float fineDetail = 1.0 - smoothstep(0.12, 0.35, s.footprint);
  float fibre = valueNoise(s.local * 1.3, seed) * 0.6 +
    valueNoise(s.local * 4.0, seed ^ 0x2u) * 0.4 * fineDetail;
  vec3 col = s.a.rgb * (1.0 - s.a.w * (fibre - 0.5));
  // Cloud: paper is never evenly thick, and the light through it is not even.
  col *= 1.0 + 0.5 * s.a.w * (fbm(s.local / 22.0, seed ^ 0x5u, 2) - 0.5);
  col *= 1.0 - s.b.x * (1.0 - smoothstep(0.0, 0.5 + s.footprint, -s.edge));
  if (s.b.w > 0.0) {
    // A fold that was flattened again: the two halves meet at a shallow
    // angle, so one faces the light a little more than the other, and the
    // ridge itself is a thin dark line with a bright lip beside it.
    vec2 n = vec2(cos(s.b.z), sin(s.b.z));
    float d = dot(s.local, n) - s.b.y;
    float w = 0.35 + s.footprint;
    col *= d > 0.0 ? 1.0 - 0.35 * s.b.w : 1.0 + 0.12 * s.b.w;
    col *= 1.0 - 0.9 * s.b.w * exp(-pow(d / w, 2.0));
    col *= 1.0 + 0.6 * s.b.w * exp(-pow((d + 1.2 * w) / w, 2.0));
  }
  return col;
}`,
  pack: (m) => ({
    a: [...lin(m.tint), m.fibre],
    b: [m.edge, m.crease?.offset ?? 0, rad(m.crease?.angle ?? 0), m.crease?.depth ?? 0],
  }),
  describe: "paper stock, optionally with a flattened fold; the renderer multiplies the printed ink over it",
});

/* ── plates: a pre-rendered desk, for the session player ────────────────── */

registerMaterial("flat", {
  glsl: /* glsl */ `
vec3 mat_flat(Surface s) {
  return s.a.rgb;
}`,
  pack: (m) => ({ a: [...lin(m.color ?? "#ffffff"), 0] }),
  describe: "one colour, nothing else: a page whose paper and ink were baked into its ink texture",
});

registerMaterial("plate", {
  glsl: /* glsl */ `
uniform sampler2D uPlate;
uniform vec4 uPlateRect;   // origin x, y (mm), extent x, y (mm)
uniform float uPlateTexel; // mm per texel
vec3 mat_plate(Surface s) {
  vec2 uv = (s.world - uPlateRect.xy) / uPlateRect.zw;
  float lod = log2(max(s.footprint / uPlateTexel, 1.0));
  return pow(textureLod(uPlate, uv, lod).rgb, vec3(2.2));
}`,
  pack: () => ({}),
  describe: "the desk and its props, rendered once from straight above (SceneRenderer.renderPlate)",
});

/* ── stage-2 desks ──────────────────────────────────────────────────────── */

registerMaterial("laminate", {
  glsl: /* glsl */ `
vec3 mat_laminate(Surface s) {
  // a.rgb colour, a.w mottle; b.x speckle share, b.y streak strength,
  // b.z streak angle (rad), b.w sheen
  uint seed = uint(s.c.w);
  vec2 p = s.world;
  vec3 col = s.a.rgb * (1.0 + s.a.w * (fbm(p / 60.0, seed, 3) - 0.5));
  float ca = cos(s.b.z);
  float sa = sin(s.b.z);
  vec2 q = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
  float streakDetail = 1.0 - smoothstep(0.3, 1.2, s.footprint);
  col *= 1.0 + s.b.y * (valueNoise(vec2(q.x / 40.0, q.y / 0.8), seed ^ 0x7u) - 0.5) * streakDetail;
  float speckDetail = 1.0 - smoothstep(0.15, 0.5, s.footprint);
  vec3 w = worley(p / 1.4, seed ^ 0x3u);
  if (w.z < s.b.x) col *= 1.0 - 0.25 * (1.0 - smoothstep(0.08, 0.2, w.x)) * speckDetail;
  col *= 1.0 + s.b.w * smoothstep(0.3, 1.0, fbm(p / 300.0, seed ^ 0x11u, 2));
  return col;
}`,
  pack: (m) => ({ a: [...lin(m.color), m.mottle], b: [m.speckle, m.streak, rad(m.streakAngle), m.sheen] }),
  describe: "a white or light-grey table top: faint mottle, speckle and brush streaks",
});

registerMaterial("fabric", {
  glsl: /* glsl */ `
vec3 mat_fabric(Surface s) {
  // a.rgb warp colour, a.w thread pitch (mm); b.rgb weft colour, b.w weave
  // contrast; c.x wrinkle depth, c.y weave angle (rad), c.z stripe width (mm, 0 none)
  uint seed = uint(s.c.w);
  vec2 p = s.world;
  float ca = cos(s.c.y);
  float sa = sin(s.c.y);
  vec2 q = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y) / s.a.w;
  float detail = 1.0 - smoothstep(s.a.w * 0.35, s.a.w * 1.2, s.footprint);
  // Plain weave: over-under, alternating per cell; each crossing is a lozenge.
  vec2 cell = floor(q);
  vec2 f = fract(q) - 0.5;
  bool warpUp = mod(cell.x + cell.y, 2.0) < 1.0;
  float bump = warpUp ? 1.0 - 4.0 * f.x * f.x : 1.0 - 4.0 * f.y * f.y;
  vec3 thread = warpUp ? s.a.rgb : s.b.rgb;
  vec3 mean = 0.5 * (s.a.rgb + s.b.rgb);
  vec3 col = mix(mean, thread * (0.8 + 0.3 * bump), detail * s.b.w);
  if (s.c.z > 0.0) {
    float stripe = step(0.5, fract(q.y * s.a.w / s.c.z));
    col *= mix(1.0, 0.72, stripe);
  }
  col *= 1.0 + 0.08 * (valueNoise(q * 0.5, seed) - 0.5) * detail;
  // Wrinkles: a cloth on a table is never flat.
  float wr = fbm(p / 70.0, seed ^ 0x21u, 3);
  col *= 1.0 - s.c.x * smoothstep(0.35, 0.75, wr) + 0.5 * s.c.x * smoothstep(0.55, 0.9, wr);
  return col;
}`,
  pack: (m) => ({
    a: [...lin(m.warp), m.pitch],
    b: [...lin(m.weft), m.contrast],
    c: [m.wrinkle, rad(m.angle), m.stripe ?? 0],
  }),
  describe: "woven cloth: plain weave, optional stripes, wrinkles",
});

registerMaterial("placemat", {
  glsl: /* glsl */ `
vec3 mat_placemat(Surface s) {
  // a.rgb straw, a.w strand width (mm); b.rgb binding, b.w binding width (mm);
  // c.x strand contrast
  uint seed = uint(s.c.w);
  vec2 p = s.local;
  float detail = 1.0 - smoothstep(s.a.w * 0.25, s.a.w * 0.9, s.footprint);
  float strand = floor(p.y / s.a.w);
  float h = hash01(ivec2(int(strand), 3), seed);
  float f = fract(p.y / s.a.w);
  vec3 col = s.a.rgb * (0.85 + 0.3 * h);
  col *= mix(1.0, 0.7 + 0.3 * sin(3.14159 * f), detail * s.c.x);
  // Cross threads every so often.
  float tie = abs(fract(p.x / 24.0) - 0.5) * 24.0;
  col *= 1.0 - 0.35 * (1.0 - smoothstep(0.3, 0.8 + s.footprint, tie));
  if (-s.edge < s.b.w) col = s.b.rgb * (0.9 + 0.2 * valueNoise(p / 2.0, seed));
  return col;
}`,
  pack: (m) => ({ a: [...lin(m.straw), m.strand], b: [...lin(m.binding), m.bindingWidth], c: [m.contrast, 0, 0] }),
  describe: "a woven place mat with a bound edge — a rectangle the size of a page that is not one",
});

/* ── props: clutter that is rectangular and is not a document ───────────── */

registerMaterial("keyboard", {
  glsl: /* glsl */ `
vec3 mat_keyboard(Surface s) {
  // a.rgb body, a.w key pitch (mm); b.rgb key caps, b.w legend strength;
  // c.x rows, c.y border (mm)
  uint seed = uint(s.c.w);
  vec2 p = s.local + s.halfSize;          // origin at the top-left corner
  float border = s.c.y;
  vec3 col = s.a.rgb;
  vec2 inner = p - vec2(border);
  vec2 area = 2.0 * s.halfSize - 2.0 * vec2(border);
  if (inner.x > 0.0 && inner.y > 0.0 && inner.x < area.x && inner.y < area.y) {
    float pitch = s.a.w;
    float row = floor(inner.y / pitch);
    // Rows are staggered like a real layout.
    float stagger = row == 1.0 ? 0.5 : row == 2.0 ? 0.75 : row == 3.0 ? 1.25 : 0.0;
    vec2 k = vec2(inner.x / pitch - stagger, inner.y / pitch);
    vec2 cell = floor(k);
    vec2 f = (fract(k) - 0.5) * pitch;
    float cap = sdRoundBox(f, vec2(pitch * 0.40), pitch * 0.12);
    float key = 1.0 - smoothstep(-0.2 - s.footprint, 0.2 + s.footprint, cap);
    if (row == s.c.x - 1.0 && abs(inner.x - area.x * 0.45) < pitch * 3.0) {
      // The space bar.
      float bar = sdRoundBox(vec2(inner.x - area.x * 0.45, f.y), vec2(pitch * 2.9, pitch * 0.40), pitch * 0.12);
      key = 1.0 - smoothstep(-0.2 - s.footprint, 0.2 + s.footprint, bar);
    }
    vec3 capCol = s.b.rgb * (0.95 + 0.1 * hash01(ivec2(cell), seed));
    // A legend: a small bright mark in the upper-left of each cap.
    float legend = step(hash01(ivec2(cell) + ivec2(9, 1), seed), 0.9) *
      (1.0 - smoothstep(0.4, 0.9 + s.footprint, length(f - vec2(-pitch * 0.15, -pitch * 0.15)) - pitch * 0.07));
    capCol = mix(capCol, vec3(0.8), legend * s.b.w * (1.0 - smoothstep(0.2, 0.6, s.footprint)));
    col = mix(col * 0.6, capCol, key);
  }
  return col;
}`,
  pack: (m) => ({ a: [...lin(m.body), m.pitch], b: [...lin(m.caps), m.legend], c: [m.rows, m.border, 0] }),
  describe: "a keyboard seen from above: staggered key caps on a darker deck",
});

registerMaterial("laptop", {
  glsl: /* glsl */ `
vec3 mat_laptop(Surface s) {
  // a.rgb aluminium, a.w brushing; b.rgb keys, b.w open (1: the deck with
  // keyboard and trackpad; 0: the closed lid with a logo)
  uint seed = uint(s.c.w);
  vec2 p = s.local;
  float brushDetail = 1.0 - smoothstep(0.1, 0.4, s.footprint);
  vec3 col = s.a.rgb * (1.0 + s.a.w * (valueNoise(vec2(p.x / 30.0, p.y / 0.15), seed) - 0.5) * brushDetail);
  col *= 1.0 + 0.06 * (fbm(p / 120.0, seed ^ 0x4u, 2) - 0.5);
  if (s.b.w > 0.5) {
    vec2 h = s.halfSize;
    // Keyboard well: upper 55 %, inset.
    vec2 kc = vec2(0.0, -h.y * 0.22);
    vec2 kh = vec2(h.x * 0.86, h.y * 0.42);
    float well = sdRoundBox(p - kc, kh, 3.0);
    if (well < 0.0) {
      vec2 q = (p - kc + kh) / 18.5;
      vec2 f = (fract(q) - 0.5) * 18.5;
      float cap = sdRoundBox(f, vec2(7.6), 1.6);
      float key = 1.0 - smoothstep(-0.2 - s.footprint, 0.2 + s.footprint, cap);
      col = mix(col * 0.35, s.b.rgb, key);
    }
    col *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.6 + s.footprint, abs(well)));
    // Trackpad.
    float pad = sdRoundBox(p - vec2(0.0, h.y * 0.55), vec2(h.x * 0.3, h.y * 0.28), 4.0);
    col *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.5 + s.footprint, abs(pad)));
  } else {
    float logo = length(p) - 11.0;
    col = mix(col, col * 1.18, 1.0 - smoothstep(-0.4 - s.footprint, 0.4 + s.footprint, logo));
  }
  col *= mix(0.8, 1.0, smoothstep(0.0, 1.5 + s.footprint, -s.edge));
  return col;
}`,
  pack: (m) => ({ a: [...lin(m.body), m.brushing], b: [...lin(m.keys), m.open ? 1 : 0] }),
  describe: "a laptop from above: closed lid with a logo, or the open deck with keys and trackpad",
});

registerMaterial("notebook", {
  glsl: /* glsl */ `
vec3 mat_notebook(Surface s) {
  // a.rgb cover, a.w label (0/1); b.rgb binding, b.w spiral (0/1);
  // c.x ruled pages (0: closed cover, 1: open on ruled pages)
  uint seed = uint(s.c.w);
  vec2 p = s.local;
  vec2 h = s.halfSize;
  vec3 col;
  if (s.c.x > 0.5) {
    col = vec3(0.93, 0.92, 0.88) * (1.0 + 0.04 * (valueNoise(p * 1.2, seed) - 0.5));
    float line = abs(fract((p.y + h.y) / 7.0) - 0.5) * 7.0;
    col = mix(col, vec3(0.55, 0.65, 0.85), (1.0 - smoothstep(0.1, 0.25 + s.footprint, line)) * 0.7);
    float margin = abs(p.x + h.x * 0.55);
    col = mix(col, vec3(0.85, 0.35, 0.35), (1.0 - smoothstep(0.1, 0.3 + s.footprint, margin)) * 0.6);
    float gutter = abs(p.x);
    col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 6.0, gutter));
  } else {
    col = s.a.rgb * (1.0 + 0.1 * (fbm(p / 8.0, seed, 3) - 0.5));
    if (s.a.w > 0.5) {
      float label = sdRoundBox(p - vec2(0.0, -h.y * 0.4), vec2(h.x * 0.45, h.y * 0.12), 2.0);
      col = mix(col, vec3(0.92, 0.9, 0.84), 1.0 - smoothstep(-0.2 - s.footprint, 0.2 + s.footprint, label));
    }
  }
  float spine = p.x + h.x;
  if (s.b.w > 0.5) {
    float ring = abs(fract((p.y + h.y) / 8.0) - 0.5) * 8.0;
    float rings = (1.0 - smoothstep(1.4, 1.8 + s.footprint, ring)) * (1.0 - smoothstep(4.0, 5.0 + s.footprint, spine));
    col = mix(col, s.b.rgb, rings);
  } else if (spine < 9.0) {
    col = s.b.rgb * (0.9 + 0.1 * valueNoise(p, seed));
  }
  return col;
}`,
  pack: (m) => ({ a: [...lin(m.cover), m.label ? 1 : 0], b: [...lin(m.binding), m.spiral ? 1 : 0], c: [m.open ? 1 : 0, 0, 0] }),
  describe: "a notebook: a card cover with a spine or spiral, or open on ruled pages",
});

registerMaterial("phone", {
  glsl: /* glsl */ `
vec3 mat_phone(Surface s) {
  // a.rgb body, a.w screen up (1) or back up (0); b.x reflection strength, b.y reflection angle (rad)
  uint seed = uint(s.c.w);
  vec2 p = s.local;
  vec2 h = s.halfSize;
  vec3 col = s.a.rgb;
  float along = dot(p, vec2(cos(s.b.y), sin(s.b.y)));
  if (s.a.w > 0.5) {
    float screen = sdRoundBox(p, h - vec2(2.0), 6.0);
    col = mix(col, vec3(0.015), 1.0 - smoothstep(-0.3 - s.footprint, 0.3 + s.footprint, screen));
    col += s.b.x * vec3(0.12) * smoothstep(-h.x * 0.8, 0.0, along) * (1.0 - smoothstep(0.0, h.x * 0.6, along));
  } else {
    float lens = min(length(p - vec2(-h.x + 12.0, -h.y + 12.0)) - 5.0, length(p - vec2(-h.x + 12.0, -h.y + 26.0)) - 5.0);
    col = mix(col, vec3(0.02), 1.0 - smoothstep(-0.3 - s.footprint, 0.3 + s.footprint, lens));
    col *= 1.0 + 0.05 * (valueNoise(p / 4.0, seed) - 0.5);
    col += s.b.x * vec3(0.05) * (1.0 - smoothstep(0.0, h.x, abs(along)));
  }
  col *= mix(0.7, 1.0, smoothstep(0.0, 1.2 + s.footprint, -s.edge));
  return col;
}`,
  pack: (m) => ({ a: [...lin(m.body), m.screenUp ? 1 : 0], b: [m.reflection, rad(m.reflectionAngle), 0, 0] }),
  describe: "a phone lying on the desk, screen or back up",
});

registerMaterial("remote", {
  glsl: /* glsl */ `
vec3 mat_remote(Surface s) {
  // a.rgb body, a.w button radius (mm); b.rgb buttons
  uint seed = uint(s.c.w);
  vec2 p = s.local;
  vec2 h = s.halfSize;
  vec3 col = s.a.rgb * (1.0 + 0.06 * (valueNoise(p / 3.0, seed) - 0.5));
  float soft = 0.2 + s.footprint;
  // A power button, a round d-pad, then a keypad: small buttons, never a grid of discs.
  float power = length(p - vec2(h.x * 0.45, -h.y * 0.78)) - s.a.w * 0.9;
  col = mix(col, vec3(0.45, 0.08, 0.08), 1.0 - smoothstep(-soft, soft, power));
  vec2 pad = p - vec2(0.0, -h.y * 0.35);
  float ring = abs(length(pad) - h.x * 0.55) - h.x * 0.14;
  col = mix(col, s.b.rgb * 0.8, 1.0 - smoothstep(-soft, soft, ring));
  float ok = length(pad) - h.x * 0.22;
  col = mix(col, s.b.rgb, 1.0 - smoothstep(-soft, soft, ok));
  vec2 grid = vec2(3.0, 4.0);
  vec2 cellSize = vec2(h.x * 0.5, h.y * 0.14);
  vec2 q = (p - vec2(-h.x * 0.75, h.y * 0.12)) / cellSize;
  if (q.x > 0.0 && q.y > 0.0 && q.x < grid.x && q.y < grid.y) {
    vec2 f = (fract(q) - 0.5) * cellSize;
    float b = sdRoundBox(f, vec2(s.a.w * 0.9, s.a.w * 0.6), s.a.w * 0.5);
    col = mix(col, s.b.rgb, 1.0 - smoothstep(-soft, soft, b));
  }
  col *= mix(0.75, 1.0, smoothstep(0.0, 1.5 + s.footprint, -s.edge));
  return col;
}`,
  pack: (m) => ({ a: [...lin(m.body), m.button], b: [...lin(m.buttons), 0] }),
  describe: "a TV remote: dark plastic, a power button, a d-pad and a small keypad",
});
