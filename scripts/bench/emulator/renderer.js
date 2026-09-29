/**
 * The scene renderer: a desk seen through a pinhole, drawn by casting a ray per
 * sample in a WebGL2 fragment shader.
 *
 * Why rays rather than a warped bitmap: the desk, the desk mat, the folder and
 * the page all lie on (nearly) the same plane, so one camera sees all of them
 * through one homography — but the page is the only one that has a bitmap.
 * Casting each sample's ray onto the plane at the layer's own height gives
 * every layer exact perspective (and exact parallax for things that are not
 * flat, like a mat 3 mm thick), lets the procedural materials be evaluated at
 * whatever scale the camera is at, and makes the page's outline in the image
 * *exactly* the projection the ground truth is computed from — no mesh, no
 * interpolation error to argue about.
 *
 * Three passes:
 *  1. scene — one sample per pixel with analytic edge coverage (4 when a scene
 *     asks, 8 with motion blur, each on its own pose along the shake),
 *     lighting, colour temperature, screen-space soft shadows and glare;
 *     encoded to sRGB;
 *  2. horizontal Gaussian — the lens's own softness plus any defocus;
 *  3. vertical Gaussian, vignetting and sensor noise, onto the canvas.
 *
 * A curled page is a height field over its own rectangle: the ray is walked
 * onto it by a few fixed-point steps (the curl is gentle, so four converge far
 * below a pixel) and it is shaded by its tilt against the light.
 *
 * **Plates, for the session player.** A camera that moves 30 times a second
 * cannot afford to shade a metre of granite per frame on a software GPU. So
 * the same pass also renders *orthographically* — straight down, a fixed
 * number of millimetres a pixel — into a texture ({@link SceneRenderer#renderPlate}):
 * the desk and every prop, once per session. Each streamed frame then draws the
 * desk as the `plate` material (one texture read) and only the pages
 * analytically, so the pages keep their exact outline, parallax and ground
 * truth while the desk costs almost nothing.
 *
 * Headless Chromium runs this on SwiftShader (the bench launches it pinned
 * there), which also makes the output the same on every machine running the
 * same browser build.
 */

import { NOISE_GLSL, SURFACE_GLSL, materialFunction, materialGlsl } from "./materials.js";
import { CURL_MODES, mat3Transpose, rayMatrix } from "./camera.js";

export const MAX_LAYERS = 10;
export const MAX_POSES = 8;
export const MAX_BLOBS = 4;

const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

/**
 * The scene shader, specialized for one composition: the background's material
 * and each layer's material and ink are compiled in, so a sample only ever
 * runs the materials it can see. (A shader that dispatched on a material id at
 * run time paid for every material on every sample on the software rasterizer
 * — 3× slower.) Programs are cached by {@link compositionKey}.
 *
 * @param {{ background: string, layers: { material: string, ink: number }[] }} composition
 */
function sceneFragmentShader(composition) {
  const count = composition.layers.length;
  const used = [...new Set([composition.background, ...composition.layers.map((l) => l.material)])];
  const coverTests = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const hit = composition.layers[i].curl ? `hitCurled(${i}, C, dir)` : `(-uLayerGeo2[${i}].w - C.z) / dir.z`;
    coverTests.push(`  if (base < 0 && fullyCovers(${i}, ${hit}, C, dir, cosIncidence, spacing)) base = ${i};`);
  }
  const layerBlocks = composition.layers.map((layer, i) => {
    const inkLine =
      layer.ink >= 0 ? `      shade *= ink${layer.ink}(local, geo.zw, fp);\n` : "";
    const curlLine = layer.curl
      ? `      shade *= curlShade(local, geo.zw, geo2, uLayerCurl[${i}]);\n`
      : "";
    return `  if (base <= ${i}) {
    vec4 geo = uLayerGeo[${i}];
    vec4 geo2 = uLayerGeo2[${i}];
    vec4 look = uLayerShade[${i}];
    if (base < ${i} && look.y > 0.0) {
      float d = sdRoundBox(toLocal(P0 - uShadowDir * look.x, geo, geo2), geo.zw, geo2.z);
      float penumbra = 0.6 + look.x * 0.9;
      col *= 1.0 - look.y * (1.0 - smoothstep(-penumbra, penumbra, d));
    }
    float si = ${layer.curl ? `hitCurled(${i}, C, dir)` : "(-geo2.w - C.z) / dir.z"};
    vec2 P = C.xy + si * dir.xy;
    float fp = footprint(si, cosIncidence, spacing);
    vec2 local = toLocal(P, geo, geo2);
    float edge = sdRoundBox(local, geo.zw, geo2.z);
    if (look.w > 0.0 && edge > -look.w - 1.0) {
      edge += edgeWobble(local, geo.zw, look.w, uint(uLayerC[${i}].w) ^ 0xa5u);
    }
    float cover = base == ${i} ? 1.0 : clamp(0.5 - edge / (look.z + fp), 0.0, 1.0);
    if (cover > 0.0) {
      vec3 shade = ${materialFunction(layer.material)}(Surface(P, local, geo.zw, edge, fp, uLayerA[${i}], uLayerB[${i}], uLayerC[${i}]));
${inkLine}${curlLine}      col = mix(col, shade, cover);
    }
  }`;
  });
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform vec2 uFrame;
uniform float uFocal;
uniform int uSamples;
uniform int uPoseCount;
uniform vec3 uCamC[${MAX_POSES}];
uniform mat3 uCamM[${MAX_POSES}];

uniform vec4 uBgA;
uniform vec4 uBgB;
uniform vec4 uBgC;

uniform vec4 uLayerGeo[${MAX_LAYERS}];    // centre x, y (mm), half w, half h (mm)
uniform vec4 uLayerGeo2[${MAX_LAYERS}];   // cos, sin of rotation, corner radius (mm), height (mm)
uniform vec4 uLayerShade[${MAX_LAYERS}];  // shadow height (mm), shadow strength, edge softness (mm), edge wobble (mm)
uniform vec4 uLayerA[${MAX_LAYERS}];
uniform vec4 uLayerB[${MAX_LAYERS}];
uniform vec4 uLayerC[${MAX_LAYERS}];
uniform vec4 uLayerCurl[${MAX_LAYERS}];  // mode (0 flat), lift (mm), reach (mm), side

uniform float uCurlShading; // 1: curls shade against the light; 0 for the geometry check
uniform int uOrtho;        // 1: straight down, uOrthoRect.xy + px * uOrthoRect.zw (a plate)
uniform vec4 uOrthoRect;   // origin x, y (mm); mm per pixel x, y

uniform sampler2D uInk0;
uniform sampler2D uInk1;
uniform vec2 uInkSize0;
uniform vec2 uInkSize1;

uniform vec2 uShadowDir;   // desk offset of a shadow per mm of height
uniform vec4 uGradient;    // direction x, y; amount; scale (mm)
uniform vec2 uGradientAt;  // mm
uniform vec3 uTint;        // white balance × exposure, linear

uniform int uBlobCount;
uniform vec4 uBlobGeo[${MAX_BLOBS}];  // centre x, y (px), radius x, y (px)
uniform vec4 uBlobFx[${MAX_BLOBS}];   // angle (rad), strength, kind (0 shadow, 1 glare), softness 0–1

${NOISE_GLSL}
${SURFACE_GLSL}
${used.map(materialGlsl).join("\n")}

const vec2 SAMPLES[8] = vec2[8](
  vec2(-0.125, -0.375), vec2(0.375, -0.125), vec2(0.125, 0.375), vec2(-0.375, 0.125),
  vec2(-0.3125, -0.1875), vec2(0.1875, -0.3125), vec2(0.3125, 0.1875), vec2(-0.1875, 0.3125)
);

/* Millimetres one sample covers where the ray met the plane. */
float footprint(float si, float cosIncidence, float spacing) {
  return uOrtho == 1 ? uOrthoRect.z * spacing : si / uFocal / cosIncidence * spacing;
}

vec2 toLocal(vec2 p, vec4 geo, vec4 geo2) {
  vec2 d = p - geo.xy;
  return vec2(geo2.x * d.x + geo2.y * d.y, -geo2.y * d.x + geo2.x * d.y);
}

/* A paper edge is not a ruler: a little low-frequency waviness, tapered to zero
   at the corners so the corners stay exactly where the ground truth says. */
float edgeWobble(vec2 local, vec2 halfSize, float amount, uint seed) {
  vec2 toCorner = halfSize - abs(local);
  float taper = smoothstep(0.0, 12.0, length(toCorner));
  return amount * (valueNoise(local / 38.0, seed) - 0.5) * 2.0 * taper;
}

/* A curled page's height over its own plane (mm, towards the camera) and its
   slope, in the page's frame — \`curlLift\` in camera.js, differentiated. */
vec3 curlLift(vec2 local, vec2 halfSize, vec4 curl) {
  vec2 p = clamp(local, -halfSize, halfSize);
  int mode = int(curl.x + 0.5);
  float lift = curl.y;
  if (mode == 1 || mode == 2) {
    int axis = mode - 1;
    float coord = axis == 0 ? p.x : p.y;
    float halfExt = axis == 0 ? halfSize.x : halfSize.y;
    float d = halfExt - curl.w * coord;
    float r = max(0.0, 1.0 - d / curl.z);
    float slope = 2.0 * lift * r / curl.z * curl.w;
    return axis == 0 ? vec3(lift * r * r, slope, 0.0) : vec3(lift * r * r, 0.0, slope);
  }
  if (mode == 3) return vec3(lift * pow(p.x / halfSize.x, 2.0), 2.0 * lift * p.x / (halfSize.x * halfSize.x), 0.0);
  if (mode == 4) return vec3(lift * pow(p.y / halfSize.y, 2.0), 0.0, 2.0 * lift * p.y / (halfSize.y * halfSize.y));
  return vec3(0.0);
}

/* The ray walked onto the curled surface: Newton steps on the ray parameter
   from the flat plane. The curl's slope is bounded (kit.js), so this lands
   far below a pixel in a handful of steps. */
float hitCurled(int i, vec3 C, vec3 dir) {
  vec4 geo = uLayerGeo[i];
  vec4 geo2 = uLayerGeo2[i];
  float si = (-geo2.w - C.z) / dir.z;
  // The ray's direction in the page's own frame, for the slope term.
  vec2 dl = vec2(geo2.x * dir.x + geo2.y * dir.y, -geo2.y * dir.x + geo2.x * dir.y);
  for (int k = 0; k < 8; k++) {
    vec2 local = toLocal(C.xy + si * dir.xy, geo, geo2);
    vec3 h = curlLift(local, geo.zw, uLayerCurl[i]);
    // f(s) = C.z + s·dir.z + geo2.w + lift(local(s)); f'(s) = dir.z + ∇lift·dl.
    float f = C.z + si * dir.z + geo2.w + h.x;
    float df = dir.z + dot(h.yz, dl);
    si -= f / (abs(df) > 1e-4 ? df : dir.z);
  }
  return si;
}

/* Lambert against the light the shadows fall away from, relative to a flat
   page: a curl that faces the light brightens, one that turns away darkens. */
float curlShade(vec2 local, vec2 halfSize, vec4 geo2, vec4 curl) {
  vec3 h = curlLift(local, halfSize, curl);
  vec2 lw = -uShadowDir;
  vec2 ll = vec2(geo2.x * lw.x + geo2.y * lw.y, -geo2.y * lw.x + geo2.x * lw.y);
  vec3 L = normalize(vec3(ll, 1.0));
  vec3 n = normalize(vec3(-h.y, -h.z, 1.0));
  return mix(1.0, dot(n, L) / L.z, 0.85 * uCurlShading);
}

vec3 ink0(vec2 local, vec2 halfSize, float footprint) {
  vec2 uv = (local + halfSize) / (2.0 * halfSize);
  float lod = log2(max(footprint * uInkSize0.x / (2.0 * halfSize.x), 1.0));
  return pow(textureLod(uInk0, uv, lod).rgb, vec3(2.2));
}
vec3 ink1(vec2 local, vec2 halfSize, float footprint) {
  vec2 uv = (local + halfSize) / (2.0 * halfSize);
  float lod = log2(max(footprint * uInkSize1.x / (2.0 * halfSize.x), 1.0));
  return pow(textureLod(uInk1, uv, lod).rgb, vec3(2.2));
}

/* Well inside a layer's outline — past the wobble's reach and the soft edge —
   the layer hides everything under it. */
bool fullyCovers(int i, float si, vec3 C, vec3 dir, float cosIncidence, float spacing) {
  vec4 geo = uLayerGeo[i];
  vec4 geo2 = uLayerGeo2[i];
  vec4 look = uLayerShade[i];
  float fp = footprint(si, cosIncidence, spacing);
  vec2 local = toLocal(C.xy + si * dir.xy, geo, geo2);
  return sdRoundBox(local, geo.zw, geo2.z) + look.w <= -0.5 * (look.z + fp);
}

vec3 sampleScene(vec2 px, int pose, float spacing) {
  vec3 C = uCamC[pose];
  vec3 dir = uCamM[pose] * vec3(px, 1.0);
  if (uOrtho == 1) {
    C = vec3(uOrthoRect.xy + px * uOrthoRect.zw, -5000.0);
    dir = vec3(0.0, 0.0, 1.0);
  }
  if (dir.z <= 1e-6) return vec3(0.0);
  float cosIncidence = max(dir.z / length(dir), 0.15);
  float s0 = -C.z / dir.z;
  vec2 P0 = C.xy + s0 * dir.xy;

  // Top-down first: nothing under the topmost layer that fully covers this
  // sample is shaded at all.
  int base = -1;
${coverTests.join("\n")}

  vec3 col = vec3(0.0);
  if (base < 0) {
    float fp0 = footprint(s0, cosIncidence, spacing);
    col = ${materialFunction(composition.background)}(Surface(P0, P0, vec2(1e6), -1e6, fp0, uBgA, uBgB, uBgC));
  }
${layerBlocks.join("\n")}
  float light = 1.0 + uGradient.z * dot(P0 - uGradientAt, uGradient.xy) / uGradient.w;
  return col * clamp(light, 0.2, 2.0);
}

void main() {
  // A plate is stored the way it is sampled: row 0 at the smallest desk Y.
  vec2 fragPx = uOrtho == 1 ? gl_FragCoord.xy : vec2(gl_FragCoord.x, uFrame.y - gl_FragCoord.y);
  vec3 acc = vec3(0.0);
  if (uSamples == 1) {
    acc = sampleScene(fragPx, 0, 1.0);
  } else {
    // Supersampled: each sample spans a fraction of the pixel, and with motion
    // blur each one sits on its own pose along the shake.
    float spacing = uSamples > 4 ? 0.35 : 0.5;
    for (int k = 0; k < 8; k++) {
      if (k >= uSamples) break;
      acc += sampleScene(fragPx + SAMPLES[k], k % uPoseCount, spacing);
    }
  }
  vec3 col = acc / float(uSamples) * uTint;
  for (int b = 0; b < ${MAX_BLOBS}; b++) {
    if (b >= uBlobCount) break;
    vec4 geo = uBlobGeo[b];
    vec4 fx = uBlobFx[b];
    vec2 d = fragPx - geo.xy;
    float ca = cos(fx.x);
    float sa = sin(fx.x);
    vec2 q = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / geo.zw;
    float r = length(q);
    float falloff = 1.0 - smoothstep(1.0 - fx.w, 1.0 + fx.w, r);
    if (fx.z < 0.5) col *= 1.0 - fx.y * falloff;
    else col += vec3(fx.y * falloff);
  }
  outColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}
`;
}

/** Which compiled scene program a frame needs. */
export function compositionKey(frame) {
  return JSON.stringify({
    background: frame.background.material,
    layers: frame.layers.map((l) => ({ material: l.material, ink: l.ink ?? -1, curl: Boolean(l.curl) })),
  });
}

const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec2 uSize;
uniform vec2 uDirection;
uniform float uSigma;
uniform int uFinish;          // 1 on the last pass: vignette + noise
uniform float uVignette;
uniform vec3 uNoise;          // shot, read (linear units), luma share
uniform uint uNoiseSeed;

uint hashU(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}
float uniform01(uint h) { return (float(h >> 8u) + 0.5) * (1.0 / 16777216.0); }
vec2 gauss(uint h) {
  float u = uniform01(h);
  float v = uniform01(hashU(h ^ 0x68bc21ebu));
  return sqrt(-2.0 * log(u)) * vec2(cos(6.2831853 * v), sin(6.2831853 * v));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 col;
  if (uSigma < 0.05) {
    col = texture(uSource, uv).rgb;
  } else {
    int radius = min(int(ceil(uSigma * 3.0)), 60);
    vec3 acc = vec3(0.0);
    float total = 0.0;
    for (int i = 0; i <= 120; i++) {
      if (i > 2 * radius) break;
      float k = float(i - radius);
      float w = exp(-0.5 * k * k / (uSigma * uSigma));
      acc += w * texture(uSource, uv + uDirection * k / uSize).rgb;
      total += w;
    }
    col = acc / total;
  }
  if (uFinish == 1) {
    vec3 lin = pow(col, vec3(2.2));
    // Squared distance from the centre, 1 at the corners.
    vec2 centred = (gl_FragCoord.xy / uSize - 0.5) * 2.0 * uSize / length(uSize);
    float r2 = dot(centred, centred);
    lin *= 1.0 - uVignette * (0.6 * r2 + 0.4 * r2 * r2);
    float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
    float sd = sqrt(uNoise.x * uNoise.x * lum + uNoise.y * uNoise.y);
    uvec2 p = uvec2(gl_FragCoord.xy);
    uint h = hashU(p.x * 0x9e3779b1u ^ hashU(p.y * 0x85ebca77u ^ uNoiseSeed));
    vec2 g1 = gauss(h);
    vec2 g2 = gauss(hashU(h + 0x1234567u));
    vec3 noise = vec3(g1.x) * uNoise.z + vec3(g1.y, g2.x, g2.y) * (1.0 - uNoise.z);
    lin = max(lin + noise * sd, 0.0);
    col = pow(clamp(lin, 0.0, 1.0), vec3(1.0 / 2.2));
  }
  outColor = vec4(col, 1.0);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const numbered = source
      .split("\n")
      .map((line, index) => `${String(index + 1).padStart(4)} ${line}`)
      .join("\n");
    throw new Error(`shader compile failed: ${log}\n${numbered}`);
  }
  return shader;
}

function program(gl, fragmentSource) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, FULLSCREEN_VS));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.bindAttribLocation(prog, 0, "aPos");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

/** A flat Float32Array of a list of vec4s, padded to `count`. */
function vec4s(list, count) {
  const out = new Float32Array(count * 4);
  list.forEach((v, i) => out.set(v, i * 4));
  return out;
}

export class SceneRenderer {
  constructor() {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", {
      antialias: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (gl === null) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;
    this.scenePrograms = new Map();
    this.blur = null;
    this.inks = [null, null];
    this.targets = null;
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.blank = this.makeTexture(1, 1, new Uint8Array([255, 255, 255, 255]));
  }

  /** The renderer that answers: e.g. SwiftShader, for the report. */
  describe() {
    const gl = this.gl;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }

  makeTexture(width, height, data = null) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /**
   * Put a rendered texture (a baked page, from {@link SceneRenderer#renderPlate})
   * in ink slot 0 or 1. The caller keeps owning it.
   */
  setInkTexture(slot, plate) {
    const previous = this.inks[slot];
    if (previous !== null && previous.owned) this.gl.deleteTexture(previous.texture);
    this.inks[slot] = { texture: plate.texture, width: plate.width, height: plate.height, owned: false };
  }

  /** Upload a printed page (a 2-D canvas of ink on white) into ink slot 0 or 1. */
  setInk(slot, source) {
    const gl = this.gl;
    const previous = this.inks[slot];
    if (previous !== null && previous.owned) gl.deleteTexture(previous.texture);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.inks[slot] = { texture, width: source.width, height: source.height, owned: true };
  }

  sceneProgram(frame) {
    const key = compositionKey(frame);
    let prog = this.scenePrograms.get(key);
    if (prog === undefined) {
      prog = program(this.gl, sceneFragmentShader(JSON.parse(key)));
      this.scenePrograms.set(key, prog);
    }
    if (this.blur === null) this.blur = program(this.gl, BLUR_FS);
    return prog;
  }

  ensureTargets(width, height) {
    const gl = this.gl;
    if (this.targets !== null && this.targets.width === width && this.targets.height === height) {
      return this.targets;
    }
    if (this.targets !== null) {
      for (const t of this.targets.list) {
        gl.deleteTexture(t.texture);
        gl.deleteFramebuffer(t.framebuffer);
      }
    }
    const list = [0, 1].map(() => {
      const texture = this.makeTexture(width, height);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return { texture, framebuffer };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targets = { width, height, list };
    return this.targets;
  }

  /**
   * Draw one frame. `frame` is the renderer's own vocabulary (see
   * `scene.js`'s `buildFrame`): cameras, layers already resolved to material
   * indices, lighting, post-processing. Returns the WebGL canvas, valid until
   * the next call.
   */
  render(frame) {
    const gl = this.gl;
    const { width, height } = frame;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const targets = this.ensureTargets(width, height);
    this.drawScene(frame, targets.list[0].framebuffer, width, height, null);

    // ── passes 2 and 3: optics, then the sensor ──
    const post = frame.post;
    const b = this.blur;
    gl.useProgram(b);
    const ub = (name) => gl.getUniformLocation(b, name);
    gl.uniform2f(ub("uSize"), width, height);
    gl.uniform1f(ub("uSigma"), post.blurSigma);
    gl.uniform1f(ub("uVignette"), post.vignette);
    gl.uniform3f(ub("uNoise"), post.noiseShot, post.noiseRead, post.noiseLumaShare);
    gl.uniform1ui(ub("uNoiseSeed"), post.noiseSeed >>> 0);
    gl.uniform1i(ub("uSource"), 0);
    gl.activeTexture(gl.TEXTURE0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.list[1].framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, targets.list[0].texture);
    gl.uniform2f(ub("uDirection"), 1, 0);
    gl.uniform1i(ub("uFinish"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, targets.list[1].texture);
    gl.uniform2f(ub("uDirection"), 0, 1);
    gl.uniform1i(ub("uFinish"), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  /** The largest texture this context holds on a side. */
  maxTextureSize() {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
  }

  /**
   * Render `frame` straight down onto the desk — `rect` `[x0, y0, x1, y1]` in
   * mm at `mmPerPx` — into a mipmapped texture the caller owns
   * ({@link SceneRenderer#releasePlate}). No lens, no sensor: a plate is the
   * desk's albedo under neutral light, and every streamed frame adds its own.
   */
  renderPlate(frame, rect, mmPerPx) {
    const gl = this.gl;
    const width = Math.max(1, Math.ceil((rect[2] - rect[0]) / mmPerPx));
    const height = Math.max(1, Math.ceil((rect[3] - rect[1]) / mmPerPx));
    const max = this.maxTextureSize();
    if (width > max || height > max) throw new Error(`plate ${width}×${height} exceeds this GPU's ${max} px textures`);
    const texture = this.makeTexture(width, height);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    this.drawScene(frame, framebuffer, width, height, [rect[0], rect[1], mmPerPx, mmPerPx]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    return { texture, rect: [rect[0], rect[1], width * mmPerPx, height * mmPerPx], mmPerPx, width, height };
  }

  releasePlate(plate) {
    if (plate !== null && plate !== undefined) this.gl.deleteTexture(plate.texture);
  }

  /** Pass 1 — the scene, one sample (or up to eight) per pixel — into `framebuffer`. */
  drawScene(frame, framebuffer, width, height, ortho) {
    if (frame.layers.length > MAX_LAYERS) throw new Error(`at most ${MAX_LAYERS} layers per scene`);
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const p = this.sceneProgram(frame);
    gl.useProgram(p);
    const u = (name) => gl.getUniformLocation(p, name);
    gl.uniform2f(u("uFrame"), width, height);
    gl.uniform1i(u("uOrtho"), ortho === null ? 0 : 1);
    gl.uniform1f(u("uCurlShading"), frame.curlShading ?? 1);
    gl.uniform4fv(u("uOrthoRect"), ortho ?? [0, 0, 1, 1]);
    const poses = frame.cameras.slice(0, MAX_POSES);
    gl.uniform1f(u("uFocal"), poses[0].f);
    gl.uniform1i(u("uPoseCount"), poses.length);
    // One sample a pixel is enough for a still frame: outlines get analytic
    // coverage, the ink is mipmapped and every material fades detail against
    // its footprint. Supersampling is for motion blur (a pose per sample) or
    // when a scene asks for it.
    gl.uniform1i(u("uSamples"), poses.length > 1 ? 8 : (frame.samples ?? 1));
    gl.uniform3fv(u("uCamC"), new Float32Array(poses.flatMap((c) => c.C)));
    gl.uniformMatrix3fv(
      u("uCamM"),
      false,
      new Float32Array(poses.flatMap((c) => mat3Transpose(rayMatrix(c)))),
    );
    const bg = frame.background;
    gl.uniform4fv(u("uBgA"), bg.a);
    gl.uniform4fv(u("uBgB"), bg.b);
    gl.uniform4fv(u("uBgC"), bg.c);

    const layers = frame.layers;
    gl.uniform4fv(u("uLayerGeo"), vec4s(layers.map((l) => [l.center[0], l.center[1], l.size[0] / 2, l.size[1] / 2]), MAX_LAYERS));
    gl.uniform4fv(
      u("uLayerGeo2"),
      vec4s(
        layers.map((l) => {
          const angle = ((l.rotation ?? 0) * Math.PI) / 180;
          return [Math.cos(angle), Math.sin(angle), l.radius ?? 0, l.height ?? 0];
        }),
        MAX_LAYERS,
      ),
    );
    gl.uniform4fv(
      u("uLayerShade"),
      vec4s(
        layers.map((l) => [l.shadowHeight ?? 0, l.shadowStrength ?? 0, l.softness ?? 0.1, l.wobble ?? 0]),
        MAX_LAYERS,
      ),
    );
    gl.uniform4fv(u("uLayerA"), vec4s(layers.map((l) => l.a), MAX_LAYERS));
    gl.uniform4fv(u("uLayerB"), vec4s(layers.map((l) => l.b), MAX_LAYERS));
    gl.uniform4fv(u("uLayerC"), vec4s(layers.map((l) => l.c), MAX_LAYERS));
    gl.uniform4fv(
      u("uLayerCurl"),
      vec4s(
        layers.map((l) =>
          l.curl ? [CURL_MODES[l.curl.mode] ?? 0, l.curl.lift, l.curl.reach ?? 1, l.curl.side ?? 1] : [0, 0, 1, 1],
        ),
        MAX_LAYERS,
      ),
    );

    for (const slot of [0, 1]) {
      gl.activeTexture(gl.TEXTURE0 + slot);
      const ink = this.inks[slot];
      gl.bindTexture(gl.TEXTURE_2D, ink === null ? this.blank : ink.texture);
      gl.uniform1i(u(`uInk${slot}`), slot);
      gl.uniform2f(u(`uInkSize${slot}`), ink?.width ?? 1, ink?.height ?? 1);
    }
    const plate = frame.plate ?? null;
    const plateLocation = u("uPlate");
    if (plateLocation !== null) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, plate === null ? this.blank : plate.texture);
      gl.uniform1i(plateLocation, 2);
      gl.uniform4fv(u("uPlateRect"), plate === null ? [0, 0, 1, 1] : plate.rect);
      gl.uniform1f(u("uPlateTexel"), plate === null ? 1 : plate.mmPerPx);
    }

    const light = frame.lighting;
    gl.uniform2fv(u("uShadowDir"), light.shadowDir);
    gl.uniform4fv(u("uGradient"), [light.gradientDir[0], light.gradientDir[1], light.gradientAmount, light.gradientScale]);
    gl.uniform2fv(u("uGradientAt"), light.gradientAt);
    gl.uniform3fv(u("uTint"), light.tint);
    const blobs = (frame.blobs ?? []).slice(0, MAX_BLOBS);
    gl.uniform1i(u("uBlobCount"), blobs.length);
    gl.uniform4fv(u("uBlobGeo"), vec4s(blobs.map((b) => [b.center[0], b.center[1], b.radius[0], b.radius[1]]), MAX_BLOBS));
    gl.uniform4fv(
      u("uBlobFx"),
      vec4s(
        blobs.map((b) => [((b.angle ?? 0) * Math.PI) / 180, b.strength, b.kind === "glare" ? 1 : 0, b.softness ?? 0.5]),
        MAX_BLOBS,
      ),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
