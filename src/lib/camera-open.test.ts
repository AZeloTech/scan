import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAMERA_ATTEMPT_TIMEOUT_MS,
  CAMERA_LADDER,
  CAMERA_UNKNOWN_PERMISSION_TIMEOUT_MS,
  VIDEO_PLAY_TIMEOUT_MS,
  cameraPermissionWatcher,
  classifyCameraError,
  openCamera,
  startPlayback,
  type PermissionReading,
} from "./camera-open.ts";

/** A stream whose tracks remember being stopped. */
function fakeStream(): MediaStream & { stopped: () => boolean } {
  let stopped = false;
  const track = { stop: () => (stopped = true) };
  return { getTracks: () => [track], stopped: () => stopped } as unknown as MediaStream & { stopped: () => boolean };
}

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** Lets settled promises run their continuations (setImmediate is not faked). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A scripted `getUserMedia`: each call takes the next behaviour — a stream,
 * an error name, or "hang" (a promise the test can settle later).
 */
function scripted(script: Array<MediaStream | string | "hang">) {
  const calls: MediaStreamConstraints[] = [];
  const hung: Array<{ resolve: (s: MediaStream) => void; reject: (e: unknown) => void }> = [];
  const getUserMedia = (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    calls.push(constraints);
    const step = script[calls.length - 1];
    if (step === undefined) return Promise.reject(domError("NotReadableError"));
    if (step === "hang") return new Promise((resolve, reject) => hung.push({ resolve, reject }));
    if (typeof step === "string") return Promise.reject(domError(step));
    return Promise.resolve(step);
  };
  return { getUserMedia, calls, hung };
}

test("a 4K ask that hangs times out and the plainer ask opens the camera", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stream = fakeStream();
  const media = scripted(["hang", stream]);
  const attempts: number[] = [];
  const result = openCamera({ getUserMedia: media.getUserMedia, onAttempt: (n) => attempts.push(n) });
  await flush();
  assert.equal(media.calls.length, 1);
  t.mock.timers.tick(CAMERA_ATTEMPT_TIMEOUT_MS - 1);
  await flush();
  assert.equal(media.calls.length, 1, "not before the deadline");
  t.mock.timers.tick(1);
  const outcome = await result;
  assert.deepEqual(outcome, { kind: "live", stream, attempt: 1 });
  assert.deepEqual(attempts, [0, 1]);
  assert.deepEqual(media.calls[0], CAMERA_LADDER[0]!.constraints);
  assert.deepEqual(media.calls[1], { video: { facingMode: { ideal: "environment" } }, audio: false });
});

test("NotReadableError on the 4K ask falls through to the plainer ask", async () => {
  const stream = fakeStream();
  const media = scripted(["NotReadableError", stream]);
  assert.deepEqual(await openCamera({ getUserMedia: media.getUserMedia }), { kind: "live", stream, attempt: 1 });
});

test("AbortError, OverconstrainedError and TypeError also fall through", async () => {
  for (const name of ["AbortError", "OverconstrainedError", "TypeError"]) {
    const stream = fakeStream();
    const media = scripted([name, stream]);
    assert.deepEqual(await openCamera({ getUserMedia: media.getUserMedia }), { kind: "live", stream, attempt: 1 }, name);
  }
});

test("a refusal is camera_denied at once, with no second ask", async () => {
  for (const name of ["NotAllowedError", "SecurityError"]) {
    const media = scripted([name, fakeStream()]);
    assert.deepEqual(await openCamera({ getUserMedia: media.getUserMedia }), { kind: "failed", code: "camera_denied", attempt: 0 });
    assert.equal(media.calls.length, 1, name);
  }
});

test("no device is no_camera, with no second ask", async () => {
  const media = scripted(["NotFoundError", fakeStream()]);
  assert.deepEqual(await openCamera({ getUserMedia: media.getUserMedia }), { kind: "failed", code: "no_camera", attempt: 0 });
  assert.equal(media.calls.length, 1);
});

test("every rung failing is camera_unavailable, not a refusal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const media = scripted(["hang", "NotReadableError", "AbortError"]);
  const result = openCamera({ getUserMedia: media.getUserMedia });
  await flush();
  t.mock.timers.tick(CAMERA_ATTEMPT_TIMEOUT_MS);
  assert.deepEqual(await result, { kind: "failed", code: "camera_unavailable", attempt: 2 });
  assert.equal(media.calls.length, 3);
  assert.deepEqual(media.calls[2], { video: true, audio: false });
});

test("a stream that arrives after its deadline is stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const late = fakeStream();
  const used = fakeStream();
  const media = scripted(["hang", used]);
  const result = openCamera({ getUserMedia: media.getUserMedia });
  await flush();
  t.mock.timers.tick(CAMERA_ATTEMPT_TIMEOUT_MS);
  assert.deepEqual(await result, { kind: "live", stream: used, attempt: 1 });
  media.hung[0]!.resolve(late);
  await flush();
  assert.equal(late.stopped(), true);
  assert.equal(used.stopped(), false);
});

test("a late rejection of an abandoned ask is swallowed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const used = fakeStream();
  const media = scripted(["hang", used]);
  const result = openCamera({ getUserMedia: media.getUserMedia });
  await flush();
  t.mock.timers.tick(CAMERA_ATTEMPT_TIMEOUT_MS);
  await result;
  media.hung[0]!.reject(domError("NotReadableError"));
  await flush(); // an unhandled rejection would fail the run
});

test("the deadline is not armed while the permission prompt is open", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let grant: (reading: PermissionReading) => void = () => undefined;
  const granted = new Promise<PermissionReading>((resolve) => (grant = resolve));
  const media = scripted(["hang", fakeStream()]);
  const result = openCamera({ getUserMedia: media.getUserMedia, whenGranted: () => granted });
  await flush();
  t.mock.timers.tick(CAMERA_ATTEMPT_TIMEOUT_MS * 10);
  await flush();
  assert.equal(media.calls.length, 1, "a person reading the prompt is not a hung camera");
  const stream = fakeStream();
  media.hung[0]!.resolve(stream);
  assert.deepEqual(await result, { kind: "live", stream, attempt: 0 });
  grant("granted");
});

test("an unknown permission gets the longer deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const media = scripted(["hang", fakeStream()]);
  const result = openCamera({ getUserMedia: media.getUserMedia, whenGranted: async () => "unknown" });
  await flush();
  t.mock.timers.tick(CAMERA_ATTEMPT_TIMEOUT_MS);
  await flush();
  assert.equal(media.calls.length, 1);
  t.mock.timers.tick(CAMERA_UNKNOWN_PERMISSION_TIMEOUT_MS - CAMERA_ATTEMPT_TIMEOUT_MS);
  assert.equal((await result).kind, "live");
  assert.equal(media.calls.length, 2);
});

test("cancelled between rungs: no further ask, and a stream that lands is stopped", async () => {
  let cancelled = false;
  const stream = fakeStream();
  const media = scripted([stream]);
  const result = openCamera({
    getUserMedia: (c) => {
      cancelled = true;
      return media.getUserMedia(c);
    },
    isCancelled: () => cancelled,
  });
  assert.deepEqual(await result, { kind: "cancelled" });
  assert.equal(stream.stopped(), true);
});

test("classifyCameraError: only refusals are denials", () => {
  assert.equal(classifyCameraError(domError("NotAllowedError")), "camera_denied");
  assert.equal(classifyCameraError(domError("SecurityError")), "camera_denied");
  assert.equal(classifyCameraError(domError("NotFoundError")), "no_camera");
  assert.equal(classifyCameraError(domError("NotReadableError")), "retry");
  assert.equal(classifyCameraError(domError("AbortError")), "retry");
  assert.equal(classifyCameraError("weird"), "retry");
});

test("startPlayback: a play() that hangs with a frame shows the stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = startPlayback({ play: () => new Promise(() => undefined), videoWidth: 1920 });
  t.mock.timers.tick(VIDEO_PLAY_TIMEOUT_MS);
  assert.equal(await result, true);
});

test("startPlayback: a play() that hangs with no frame is a dead stream", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const result = startPlayback({ play: () => new Promise(() => undefined), videoWidth: 0 });
  await flush();
  t.mock.timers.tick(VIDEO_PLAY_TIMEOUT_MS - 1);
  let done = false;
  void result.then(() => (done = true));
  await flush();
  assert.equal(done, false, "not before the deadline");
  t.mock.timers.tick(1);
  assert.equal(await result, false);
});

test("startPlayback: played or refused (autoplay) both show the stream", async () => {
  assert.equal(await startPlayback({ play: async () => undefined, videoWidth: 0 }), true);
  assert.equal(await startPlayback({ play: () => Promise.reject(domError("NotAllowedError")), videoWidth: 0 }), true);
});

test("cameraPermissionWatcher reads granted, unknown and a prompt answered later", async () => {
  assert.equal(await cameraPermissionWatcher({})(), "unknown");
  assert.equal(await cameraPermissionWatcher({ permissions: { query: async () => ({ state: "granted" }) } })(), "granted");
  assert.equal(await cameraPermissionWatcher({ permissions: { query: async () => ({ state: "denied" }) } })(), "unknown");
  assert.equal(
    await cameraPermissionWatcher({ permissions: { query: () => Promise.reject(new TypeError("camera")) } })(),
    "unknown",
  );
  const status = {
    state: "prompt" as PermissionState,
    listener: null as null | (() => void),
    addEventListener(_type: "change", listener: () => void) {
      this.listener = listener;
    },
    removeEventListener() {
      this.listener = null;
    },
  };
  const reading = cameraPermissionWatcher({ permissions: { query: async () => status } })();
  await flush();
  assert.ok(status.listener !== null);
  status.state = "granted";
  status.listener!();
  assert.equal(await reading, "granted");
});

