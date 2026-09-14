/**
 * What kind of connection this phone is on — as much as a browser will say.
 *
 * The Network Information API is the only thing on the platform that answers
 * the question, and it answers it on roughly half the phones in the world:
 * Chrome on Android has `navigator.connection.type`, Safari on iOS has no
 * `navigator.connection` at all. So this module has exactly three answers, and
 * the third one is a real answer rather than a failure: **unknown**.
 *
 * The whole point of the distinction is what the app is allowed to do without
 * being asked. Wi-Fi is the only case where ~30 MB may be fetched on the user's
 * behalf; unknown is NOT Wi-Fi. On an iPhone we can never know, and spending
 * someone's mobile data without asking is precisely the trust this library is
 * built on — so the unknown case pays nothing and gets a better hint
 * instead ({@link shouldPrefetchHeavyAssets}).
 *
 * `saveData` is treated as the user speaking directly: someone who turned data
 * saver on has said "assume I am paying for this", and that outranks whatever
 * radio the phone reports.
 *
 * Nothing here reacts to a change of network. A phone that leaves Wi-Fi
 * mid-session simply never gets the prefetch it did not already start, and one
 * that joins Wi-Fi later gets it on the next capture screen — a live listener
 * would buy nothing that a single reading at the right moment does not.
 */

/**
 * The slice of `NetworkInformation` this library reads.
 *
 * Declared here rather than taken from lib.dom, which types only part of it and
 * not on every TypeScript version: all three fields are optional because all
 * three are genuinely absent on some engine that ships today.
 */
export interface NetworkInformation {
  /** "wifi" | "cellular" | "ethernet" | "none" | "unknown" | … */
  type?: string;
  /** "slow-2g" | "2g" | "3g" | "4g" — read for nothing yet, kept for honesty. */
  effectiveType?: string;
  /** The user asked the browser to spend less data. */
  saveData?: boolean;
}

/** Wi-Fi, something metered, or no idea. */
export type ConnectionKind = "wifi" | "cellular" | "unknown";

/**
 * The reading itself, with no browser in sight so it can be tested.
 *
 * Order matters: `saveData` is checked before the radio, so data saver on a
 * Wi-Fi connection still reads as metered. The user's stated preference is the
 * stronger signal, and honouring it costs nothing but a download we were only
 * ever going to make as a favour.
 */
export function classifyConnection(
  info: { type?: string; saveData?: boolean } | undefined,
): ConnectionKind {
  if (info === undefined) return "unknown";
  if (info.saveData === true) return "cellular";
  if (info.type === "wifi") return "wifi";
  if (info.type === "cellular") return "cellular";
  return "unknown";
}

/** What this device is on right now, or "unknown" when the browser won't say. */
export function connectionKind(): ConnectionKind {
  if (typeof navigator === "undefined") return "unknown";
  const connection = (
    navigator as Navigator & { connection?: NetworkInformation }
  ).connection;
  return classifyConnection(connection);
}

/**
 * Whether the app may spend the user's bytes on the optional engine unasked.
 *
 * True for Wi-Fi and nothing else. This is deliberately not a heuristic with a
 * middle: "probably fine" is how a 30 MB surprise ends up on a metered plan.
 */
export function shouldPrefetchHeavyAssets(kind: ConnectionKind): boolean {
  return kind === "wifi";
}
