"use client";

import * as React from "react";
import { motionScope, rise, type RiseOptions } from "@/lib/motion";

/**
 * The one entrance hook every screen uses. Attach the returned ref to the
 * screen's content root; anything inside it carrying `data-enter` rises and
 * fades in, in DOM order, staggered.
 *
 * If nothing is marked, the scope itself animates — so a screen gets a decent
 * entrance for free and only opts into a cascade when the cascade is worth it
 * (the landing's hero → steps → consent unit).
 *
 * Every tween lives inside a `gsap.matchMedia()` bound to the scope, so React
 * unmounting the screen reverts it: no orphaned inline transforms, and reduced
 * motion collapses the whole thing to a fade.
 */
export function useEntrance<T extends HTMLElement>(
  options: RiseOptions = {},
  deps: React.DependencyList = [],
  // `RefObject<T | null>` rather than `RefObject<T>`: React 19 stopped
  // pretending a ref initialised to null holds an element. The ref is passed
  // straight to a JSX `ref=`, which accepts the nullable shape in both 18 and
  // 19, so this is a type correction and not a behaviour change.
): React.RefObject<T | null> {
  const scope = React.useRef<T>(null);
  const optionsRef = React.useRef(options);
  optionsRef.current = options;

  React.useEffect(() => {
    const element = scope.current;
    return motionScope(element, (api) => {
      if (element === null) return;
      const marked = element.querySelectorAll("[data-enter]");
      rise(api, marked.length > 0 ? marked : element, optionsRef.current);
    });
    // The caller decides when an entrance should replay (e.g. the build
    // screen switching from "assembling" to "done").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return scope;
}
