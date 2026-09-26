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

/** @param {{ player: import("./session-player.js").SessionPlayer, permission?: "prompt" | "granted" }} options */
export function installFakeCamera({ player, permission = "prompt" }) {
  let state = permission;
  const media = navigator.mediaDevices;
  if (media === undefined) throw new Error("navigator.mediaDevices is missing: the bench page must be served from 127.0.0.1");

  media.getUserMedia = async (constraints) => {
    if (constraints === undefined || !constraints.video) {
      throw new DOMException("the bench camera has no audio", "NotFoundError");
    }
    const stream = player.open(constraints);
    state = "granted";
    return stream;
  };
  media.enumerateDevices = async () => [
    { deviceId: "bench-camera", kind: "videoinput", label: "bench camera (synthetic)", groupId: "bench", toJSON() { return this; } },
  ];

  const permissions = navigator.permissions;
  if (permissions !== undefined) {
    const query = permissions.query.bind(permissions);
    permissions.query = async (descriptor) => {
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
    };
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
  window.ImageCapture = BenchImageCapture;

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
