/**
 * The one decision behind the flow's two exits: may this exit fire now?
 *
 * The flow leaves in three ways, and they are not alike:
 *
 *  - **completion** — the PDF exists and went out through `onComplete`. Final.
 *  - **an unrecoverable error** — the session cannot continue. Final.
 *  - **a user cancel** — somebody pressed back, close or Escape. This is a
 *    *request* to the host, and the host may say no: "discard these pages?" →
 *    "keep scanning". So it must not latch. A flow that went dead after the
 *    first request would leave a person holding a scanner whose buttons no
 *    longer do anything.
 *
 * What a user cancel does need is protection from the double tap: a person
 * mashing a close control must not produce five cancel events inside one
 * gesture. So a user request that follows another within
 * {@link USER_CANCEL_DEBOUNCE_MS} is swallowed, and one that comes later — after
 * the host has shown and dismissed its own question — fires again.
 *
 * Pure and clock-injected, so the rule is tested rather than trusted.
 */

import type { ScanCancelReason } from "@/types";

/**
 * Long enough to absorb a double tap or a key repeat, short enough that no
 * host dialog can be read and answered inside it.
 */
export const USER_CANCEL_DEBOUNCE_MS = 400;

export interface ExitGate {
  /** True once the flow has completed or failed. */
  readonly finished: boolean;
  /** Whether a cancel with this reason should reach the host. Latches on `"error"`. */
  requestCancel(reason: ScanCancelReason): boolean;
  /** Whether completion should reach the host. Latches. */
  complete(): boolean;
}

export function createExitGate(now: () => number = defaultNow): ExitGate {
  let finished = false;
  let lastUserCancel = Number.NEGATIVE_INFINITY;

  return {
    get finished(): boolean {
      return finished;
    },

    requestCancel(reason: ScanCancelReason): boolean {
      if (finished) return false;
      if (reason === "error") {
        finished = true;
        return true;
      }
      const at = now();
      if (at - lastUserCancel < USER_CANCEL_DEBOUNCE_MS) return false;
      lastUserCancel = at;
      return true;
    },

    complete(): boolean {
      if (finished) return false;
      finished = true;
      return true;
    },
  };
}

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
