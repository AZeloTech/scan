/**
 * The bench's camera: the browser APIs `<ScanFlow>` reaches for, answered by a
 * session player instead of a sensor. Installed by the bench and playground
 * pages only, before the component mounts; nothing under `src/` knows it
 * exists.
 *
 *  - `navigator.mediaDevices.getUserMedia` → a `canvas.captureStream()` the
 *    player pushes frames into at 30 fps, in real time;
 *  - `navigator.permissions.query({ name: "camera" })` → `prompt` until the
 *    app has asked for the camera once, `granted` after (a first visit whose
 *    OS dialog was accepted) — or `granted` from the start when asked to;
 *  - `ImageCapture` → capabilities of a 4000×3000 sensor, and a `takePhoto()`
 *    the player renders from the pose the phone is in when it is called;
 *  - a coarse pointer and five touch points, so the library mounts its phone
 *    flow (`isDesktopSurface()` false) in any desktop browser as well as in
 *    the bench's emulated phone.
 */

/** Platform objects whose script wrappers carry the fakes (see {@link installFakeCamera}). */
const keep = [];

/**
 * Replace a method of a platform object. A plain assignment is enough in
 * Chromium; WebKit ignores it on `navigator.mediaDevices` (the app then met
 * the real, denied camera), so the property is defined — on the object, or
 * failing that on its prototype.
 */
function override(target, name, value) {
  try {
    Object.defineProperty(target, name, { value, configurable: true, writable: true });
  } catch {
    // Not configurable on the instance.
  }
  if (target[name] === value) return;
  Object.defineProperty(Object.getPrototypeOf(target), name, { value, configurable: true, writable: true });
}

/**
 * The phone's torch on a bench track: `getCapabilities()` says `torch`,
 * `applyConstraints({ advanced: [{ torch }] })` switches it (logged in
 * `globalThis.__benchTorch` as `{ at, on }`, page time) and `getSettings()`
 * reports it. The light itself changes nothing in the frames — they were
 * rendered ahead — so a run proves the control, not the photo.
 */
function withTorch(track) {
  if (track === undefined || track.__benchTorch === true) return;
  const log = (globalThis.__benchTorch ??= []);
  let on = false;
  const capabilities = typeof track.getCapabilities === "function" ? track.getCapabilities.bind(track) : () => ({});
  const settings = typeof track.getSettings === "function" ? track.getSettings.bind(track) : () => ({});
  const define = (name, value) => Object.defineProperty(track, name, { value, configurable: true, writable: true });
  define("__benchTorch", true);
  define("getCapabilities", () => ({ ...capabilities(), torch: true }));
  define("getSettings", () => ({ ...settings(), torch: on }));
  define("applyConstraints", async (constraints = {}) => {
    const wanted = constraints.advanced?.find((c) => c !== null && typeof c === "object" && "torch" in c)?.torch ?? constraints.torch;
    if (typeof wanted === "boolean" && wanted !== on) {
      on = wanted;
      log.push({ at: performance.now(), on });
    }
  });
}

/**
 * @param {{ player: import("./session-player.js").SessionPlayer, permission?: "prompt" | "granted", stills?: boolean, torch?: boolean }} options
 * `stills: false` is a camera with no still pipeline at all — no
 * `ImageCapture`, as on Safari — so every capture is a preview frame;
 * `torch: false` a camera without a torch (see {@link withTorch}).
 */
export function installFakeCamera({ player, permission = "prompt", stills = true, torch = true }) {
  let state = permission;
  const media = navigator.mediaDevices;
  if (media === undefined) throw new Error("navigator.mediaDevices is missing: the bench page must be served from 127.0.0.1");
  // Held for the page's life: WebKit may drop a DOM object's script wrapper
  // once nothing references it and hand out a fresh one later — without the
  // methods defined on it here (the app then met the real, denied camera).
  keep.push(media, navigator.permissions);

  override(media, "getUserMedia", async (constraints) => {
    if (constraints === undefined || !constraints.video) {
      throw new DOMException("the bench camera has no audio", "NotFoundError");
    }
    let stream;
    try {
      stream = player.open(constraints);
    } catch (error) {
      // A camera that failed to open is the bench's own bug: say so where a run can see it.
      console.error(`bench camera: ${error?.stack ?? error}`);
      throw error;
    }
    state = "granted";
    if (torch) withTorch(stream.getVideoTracks()[0]);
    return stream;
  });
  override(media, "enumerateDevices", async () => [
    { deviceId: "bench-camera", kind: "videoinput", label: "bench camera (synthetic)", groupId: "bench", toJSON() { return this; } },
  ]);

  const permissions = navigator.permissions;
  if (permissions !== undefined) {
    const query = permissions.query.bind(permissions);
    override(permissions, "query", async (descriptor) => {
      if (descriptor?.name !== "camera") return query(descriptor);
      return {
        name: "camera",
        get state() {
          return state;
        },
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return true;
        },
      };
    });
  }

  class BenchImageCapture {
    constructor(track) {
      if (!player.owns(track)) throw new DOMException("not a bench camera track", "NotSupportedError");
      this.track = track;
    }

    async getPhotoCapabilities() {
      const { width, height } = player.script.still.sensor;
      return {
        redEyeReduction: "never",
        imageWidth: { min: 640, max: width, step: 1 },
        imageHeight: { min: 480, max: height, step: 1 },
        fillLightMode: ["off"],
      };
    }

    async getPhotoSettings() {
      const { width, height } = player.script.still.sensor;
      return { imageWidth: width, imageHeight: height, redEyeReduction: false, fillLightMode: "off" };
    }

    async takePhoto(settings) {
      return player.takePhoto(settings ?? null);
    }

    async grabFrame() {
      return createImageBitmap(player.canvas);
    }
  }
  if (stills) window.ImageCapture = BenchImageCapture;
  else {
    try {
      delete window.ImageCapture;
    } catch {
      // Not configurable: shadow it instead.
    }
    if (typeof window.ImageCapture === "function") window.ImageCapture = undefined;
  }

  // A finger, not a mouse: the phone flow, whatever the host machine is.
  const matchMedia = window.matchMedia.bind(window);
  const answer = (query, matches) => ({
    matches,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
  window.matchMedia = (query) => {
    if (/\(\s*pointer\s*:\s*fine\s*\)/.test(query)) return answer(query, false);
    if (/\(\s*pointer\s*:\s*coarse\s*\)/.test(query)) return answer(query, true);
    if (/\(\s*hover\s*:\s*none\s*\)/.test(query)) return answer(query, true);
    return matchMedia(query);
  };
  try {
    Object.defineProperty(Navigator.prototype, "maxTouchPoints", { configurable: true, get: () => 5 });
  } catch {
    // An emulated phone already says so.
  }
}
