"use client";

import * as React from "react";

/**
 * Locks the document to one viewport for as long as an app screen is mounted,
 * and pins that viewport to what the phone can actually show.
 *
 * The root layout has to leave the document scrollable — the landing at `/` is
 * a long marketing page — so the app's "one viewport, never scrolls" rule
 * cannot live on `<body>` any more. It lives here instead: a class on
 * `<html>`, added when an app route mounts and removed on the way back out.
 *
 * **Why it also measures.** The CSS baseline is `100svh`, the height with
 * every bit of browser chrome showing. That is the right unit and it is enough
 * on any browser that implements it honestly — but the failure it guards
 * against (the bottom action bar sitting underneath a phone's toolbar, out of
 * reach) is severe enough to be worth a second line of defence. `visualViewport`
 * reports the pixels the user can genuinely see, so it is used when present and
 * `100svh` remains the fallback.
 *
 * The one thing it must NOT react to is the on-screen keyboard: opening it
 * shrinks the visual viewport dramatically, and collapsing the whole shell
 * around a focused "Nome do documento" field would be a worse bug than the one
 * this fixes. So a measurement taken while a field has focus is ignored.
 */
const SHELL_CLASS = "app-shell";

/** The measured height, read by `.app-h` and `html.app-shell` in globals.css. */
const HEIGHT_VAR = "--app-h";

function isTyping(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  );
}

export function AppShellLock() {
  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.add(SHELL_CLASS);

    const viewport = window.visualViewport ?? null;

    const measure = (): void => {
      if (isTyping()) return;
      const height = Math.round(viewport?.height ?? window.innerHeight);
      // A zero or absurd reading means the browser is mid-transition; leaving
      // the previous value (or the CSS fallback) is always safer than writing
      // a height that hides the controls.
      if (height > 200) root.style.setProperty(HEIGHT_VAR, `${height}px`);
    };

    measure();
    viewport?.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    // Some browsers settle the toolbar a beat after load or rotation.
    const settle = window.setTimeout(measure, 300);

    return () => {
      window.clearTimeout(settle);
      viewport?.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      root.classList.remove(SHELL_CLASS);
      root.style.removeProperty(HEIGHT_VAR);
    };
  }, []);

  return null;
}
