/**
 * How often the live loop looks: a duty-cycle controller.
 *
 * The loop used to poll the model at a fixed 700 ms — policy, not a limit: a
 * pass costs ~11 ms on a desktop and ~45 ms on a mid-range phone. At that
 * beat the overlay is always most of a second behind the hand. Instead the
 * interval now follows what a pass actually costs:
 *
 *     interval = clamp(ewma(cost) / targetDuty, minMs, maxMs)
 *
 * so the detector spends about `targetDuty` of its thread's time on the job —
 * a fast phone looks eight times a second, a slow one backs off by itself, and
 * a pass that suddenly gets expensive (thermal throttling, a background tab
 * coming back) slows the loop within a pass or two.
 *
 * `cost` is **what the pass cost the thread it ran on**: on the main-thread
 * lane that is the whole pass, and a pass long enough to be a long task
 * (> 50 ms, the point where a tap waits for it) is charged twice over —
 * the main thread's time is the user's. On the worker lane it is the worker's
 * own compute time; the main thread's share of a worker pass is a grab and a
 * hand-over, a millisecond or two, and it is not what bounds the rate.
 *
 * The EWMA keeps one odd pass from moving the beat; the clamp keeps a very
 * fast device from polling for nothing and a very slow one from going blind.
 * Whether a device is *hopeless* for a detector is decided elsewhere (the
 * loop's `adapt`), on the same measurements — this only sets the pace.
 *
 * Pure: tested in `cadence.test.ts`.
 */

export interface CadenceProfile {
  /** Share of its thread's time the loop may spend detecting (0–1). */
  targetDuty: number;
  /** Never poll faster than this. */
  minMs: number;
  /** Never slower than this. */
  maxMs: number;
  /** Where the loop starts, before anything has been measured. */
  initialMs: number;
}

/** A task this long or longer blocks input: a main-thread pass over it is charged double. */
export const LONG_TASK_MS = 50;

/** Weight of the newest pass in the cost average. */
const COST_EWMA = 0.3;

export class CadenceController {
  private profile: CadenceProfile;
  /** Main-thread passes: long ones are charged double. */
  private readonly mainThread: boolean;
  private costMs: number | null = null;
  private interval: number;

  constructor(profile: CadenceProfile, mainThread: boolean) {
    this.profile = profile;
    this.mainThread = mainThread;
    this.interval = profile.initialMs;
  }

  /** The current interval between pass starts, ms. */
  get intervalMs(): number {
    return this.interval;
  }

  /** The smoothed cost a pass is charged, ms, or null before the first. */
  get averageCostMs(): number | null {
    return this.costMs;
  }

  /** Measure one pass; answers the interval until the next one starts. */
  record(passCostMs: number): number {
    if (!Number.isFinite(passCostMs) || passCostMs < 0) return this.interval;
    const charged = this.mainThread && passCostMs >= LONG_TASK_MS ? passCostMs * 2 : passCostMs;
    this.costMs = this.costMs === null ? charged : this.costMs * (1 - COST_EWMA) + charged * COST_EWMA;
    this.interval = cadenceInterval(this.costMs, this.profile);
    return this.interval;
  }

  /**
   * The interval at another duty (a short burst of faster reading — never
   * slower than the current one): `clamp(cost / duty, min, max)` on the same
   * smoothed cost. Before anything is measured, the current interval.
   */
  intervalAt(duty: number): number {
    if (this.costMs === null) return this.interval;
    return Math.min(this.interval, cadenceInterval(this.costMs, { ...this.profile, targetDuty: duty }));
  }

  /** A new detector or a new lane: its costs start from nothing. */
  reset(profile: CadenceProfile = this.profile): void {
    this.profile = profile;
    this.costMs = null;
    this.interval = profile.initialMs;
  }
}

/** `clamp(cost / duty, min, max)`, the controller's rule on its own. */
export function cadenceInterval(costMs: number, profile: CadenceProfile): number {
  const wanted = costMs / Math.max(1e-3, profile.targetDuty);
  return Math.min(profile.maxMs, Math.max(profile.minMs, wanted));
}
