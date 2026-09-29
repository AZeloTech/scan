/**
 * Seeded randomness for the scene emulator.
 *
 * Every scene is a pure function of (family, seed): the same pair renders the
 * same pixels on the same browser build, run after run, so a number in one
 * bench report can be compared with a number in the next. That only survives
 * the emulator growing if adding a parameter to one part of a scene does not
 * shift the random stream every other part draws from — so streams are
 * *forked by name* ({@link Rng#fork}), never shared: the camera draws from
 * `fork("camera")`, the document from `fork("document")`, and a new effect gets
 * a fork of its own instead of a slot in somebody else's sequence.
 *
 * mulberry32: tiny, fast, good enough for procedural content, and trivially
 * identical in Node (the unit tests) and in the page (the renderer).
 */

/** FNV-1a over UTF-16 code units, as an unsigned 32-bit integer. */
export function hash32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A mulberry32 generator: uniform floats in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  /** @param {number} seed an unsigned 32-bit integer */
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  /** Uniform in [min, max). */
  range(min, max) {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max], both ends included. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(probability) {
    return this.next() < probability;
  }

  /** @template T @param {readonly T[]} list @returns {T} */
  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }

  /**
   * Weighted pick from `[[value, weight], ...]`.
   * @template T @param {readonly [T, number][]} entries @returns {T}
   */
  weighted(entries) {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1][0];
  }

  /** Gaussian by Box–Muller. */
  normal(mean = 0, sd = 1) {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * An independent stream, named. Derived from this stream's *seed*, not its
   * position, so the order forks are taken in never changes what they draw.
   */
  fork(label) {
    return new Rng(hash32(`${this.seed}:${label}`));
  }

  /** A seed for something downstream that wants its own integer (a shader, a document). */
  seed32() {
    return Math.floor(this.next() * 4294967296) >>> 0;
  }
}

/** The root stream for one scene. */
export function rngFor(...parts) {
  return new Rng(hash32(parts.map(String).join("\u0000")));
}
