"use client";

import * as React from "react";

/**
 * The modal behaviours every full-screen surface in this app owes the user:
 * focus moves in, stays in, and goes back where it came from; Escape closes.
 *
 * It exists because the preview overlay had all of this and the retake sheet —
 * which covers the screen just as completely — had none of it. A keyboard or
 * screen-reader user could tab straight out of the sheet into the page
 * underneath and never find their way back.
 */

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialogChrome<T extends HTMLElement>(
  onDismiss: () => void,
): React.MutableRefObject<T | null> {
  const containerRef = React.useRef<T | null>(null);
  const dismissRef = React.useRef(onDismiss);
  dismissRef.current = onDismiss;

  React.useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusables = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));

    focusables()[0]?.focus();

    function handleKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, []);

  return containerRef;
}
