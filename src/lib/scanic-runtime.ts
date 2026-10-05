/**
 * Loading scanic, once, from wherever the host serves this library's assets.
 *
 * Its own module rather than a function inside `flatten.ts` because both the
 * detection arbitration (`ml-detection.ts`) and the flattening helpers need it,
 * and having either import the other makes a cycle whose symptom is a constant
 * read before initialisation — at run time, in whichever of the two a bundler
 * happened to evaluate first.
 */
import type { AssetUrls } from "@/lib/runtime-config";


type ScanicModule = typeof import("scanic");

let modulePromise: Promise<ScanicModule> | null = null;

/**
 * Lazily loaded on the first capture, from the host's asset directory, and
 * memoised — successes only.
 *
 * The specifier is a variable on purpose, and carries both bundlers' opt-out
 * comments: this module must be fetched at run time and never followed at build
 * time. scanic's ML path ends in an ONNX Runtime that finds its own
 * WebAssembly through `new URL(..., import.meta.url)`, which webpack resolves
 * eagerly and cannot satisfy from inside a consumer's hashed output. Shipping
 * the chain as files and loading it by URL is what keeps that out of every
 * consumer's build (`scanic-entry.ts`).
 */
export function loadScanic(urls: AssetUrls): Promise<ScanicModule> {
  if (modulePromise === null) {
    const attempt = import(/* webpackIgnore: true */ /* @vite-ignore */ urls.scanic) as Promise<ScanicModule>;
    // A rejection clears the memo: a remembered failure would turn one 404 or
    // one dropped connection into a broken scanner for the rest of the page's
    // life, every later attempt "failing" without a request leaving the tab.
    // (The browser keeps its own record of a failed module URL in some
    // engines; a retry costs at most a request that fails again.)
    attempt.catch(() => {
      if (modulePromise === attempt) modulePromise = null;
    });
    modulePromise = attempt;
  }
  return modulePromise;
}
