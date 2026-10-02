/**
 * Where the time goes between a page being found and auto-capture firing.
 *
 * The ready cue is the AND of several conditions (`lib/guidance.ts`
 * `ReadyCue`, judged by the live loop in `hooks/useLiveDetect.ts`): a found
 * sheet, no hint owed and the hint slot empty, the page still on enough readings, its corners
 * measured and certain, a fresh confirming pass under it. The cue waits for
 * whichever of them comes true LAST; auto-capture's countdown and its final
 * fresh-frame confirmation follow. {@link FireTimeline} keeps, for each
 * condition, when it last became true (and has stayed true since), so a fire
 * (or a ready cue coming on) can say which wait it was standing in.
 *
 * Numbers only — times on the caller's clock; nothing about the page. The
 * diagnostics stream carries them as milliseconds before the event
 * ({@link phasesBefore}); the bench as absolute probe times.
 *
 * Pure: no clock of its own; tested in `fire-timeline.test.ts`.
 */

/** The ready cue's conditions, in the order the live loop usually meets them. */
export const TIMELINE_CONDITIONS = ["lock", "hint", "slot", "still", "check", "footing"] as const;
export type TimelineCondition = (typeof TIMELINE_CONDITIONS)[number];

/** When each condition last came true and has held since (null: false right now). */
export type TimelineMarks = Record<TimelineCondition, number | null>;

export class FireTimeline {
  private marks: TimelineMarks = emptyMarks();

  /** One moment: each condition's truth at `now`. */
  update(now: number, conditions: Record<TimelineCondition, boolean>): void {
    for (const key of TIMELINE_CONDITIONS) {
      if (conditions[key]) this.marks[key] ??= now;
      else this.marks[key] = null;
    }
  }

  /** A copy of the marks now. */
  snapshot(): TimelineMarks {
    return { ...this.marks };
  }

  reset(): void {
    this.marks = emptyMarks();
  }
}

function emptyMarks(): TimelineMarks {
  return { lock: null, hint: null, slot: null, still: null, check: null, footing: null };
}

/**
 * The marks as whole milliseconds before `at` (≥ 0; a mark after `at` reads
 * 0), null where a mark is null — what the diagnostics stream carries.
 */
export function phasesBefore<K extends string>(at: number, marks: Record<K, number | null>): Record<K, number | null> {
  const out = {} as Record<K, number | null>;
  for (const key of Object.keys(marks) as K[]) {
    const value = marks[key];
    out[key] = value === null || !Number.isFinite(value) ? null : Math.max(0, Math.round(at - value));
  }
  return out;
}

/**
 * The serial waits in a chain of marks: sorted by time, each condition is
 * charged the time from the one before it (the first from `from`) — which
 * condition the cue was waiting on, and for how long. Null marks are left out.
 */
export function serialWaits(from: number, marks: Record<string, number | null>): { key: string; ms: number }[] {
  const entries = Object.entries(marks)
    .filter((entry): entry is [string, number] => entry[1] !== null && Number.isFinite(entry[1]))
    .sort((a, b) => a[1] - b[1]);
  const out: { key: string; ms: number }[] = [];
  let previous = from;
  for (const [key, at] of entries) {
    out.push({ key, ms: Math.max(0, at - previous) });
    previous = Math.max(previous, at);
  }
  return out;
}
