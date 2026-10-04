/**
 * What a live detection pass was started under, so that its answer is
 * judged against the camera it describes. A pass reads one frame and
 * answers 100–600 ms later; in between, the camera can change under it —
 * the loop restarted or a capture froze it (`epoch`), the detection lane
 * restarted or was demoted (`lane`, the lane's generation), the stream
 * renegotiated or the phone turned (`width` × `height` of the video).
 * An answer from before any of that describes geometry, stillness and a
 * camera-watch baseline that belong to an earlier camera: it is dropped, not
 * folded into the ready cue's footing or auto-capture's final look.
 */
export interface PassTicket {
  epoch: number;
  lane: number;
  width: number;
  height: number;
}

/** Whether a pass started under `started` still describes the camera as it is (`now`). */
export function passStillCurrent(started: PassTicket, now: PassTicket): boolean {
  return started.epoch === now.epoch && started.lane === now.lane && started.width === now.width && started.height === now.height;
}

/** Whether what changed between the two is the camera itself (lane or stream), not just the question (epoch). */
export function cameraChanged(started: PassTicket, now: PassTicket): boolean {
  return started.lane !== now.lane || started.width !== now.width || started.height !== now.height;
}
