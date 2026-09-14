"use client";

import * as React from "react";
import { DEFAULT_SHELL, deriveShellTheme, shellCssVars } from "@/lib/shell-theme";

/**
 * Paints the camera shell's colour onto the document.
 *
 * The derived palette lands as CSS custom properties on `<html>` rather than in
 * a React context consumed by every component, because the consumers are
 * Tailwind classes (`bg-shell`, `text-shell-ink2`, …). One write, and every
 * camera screen is coloured — including the ones inside `position: fixed`
 * overlays, which a context provider mounted in a layout would not reach as
 * cleanly.
 *
 * **The shell is no longer a choice.** It was a 14-step ramp with a
 * picker over the viewfinder; the picker is gone and the value is fixed at
 * {@link DEFAULT_SHELL}. What is deliberately NOT gone is the derivation in
 * `lib/shell-theme.ts`, or its test across all fourteen steps: the arithmetic
 * that guarantees every token clears its contrast floor is the same arithmetic
 * whether one shell ships or fourteen, and keeping the whole range covered
 * means the next person to change this one colour cannot pick an unreadable
 * one by hand.
 *
 * The context survives for one reader: the two screens that hand a colour to
 * scanic's corner editor, which draws outside Tailwind's reach and so cannot
 * read a CSS variable.
 */

const ShellContext = React.createContext<{ shell: string }>({
  shell: DEFAULT_SHELL,
});

export function useShell(): { shell: string } {
  return React.useContext(ShellContext);
}

/** Stable identity: the value never changes, so it must not be a new object. */
const VALUE = { shell: DEFAULT_SHELL };

export function ShellThemeProvider({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    const root = document.documentElement;
    const vars = shellCssVars(deriveShellTheme(DEFAULT_SHELL));
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value);
    }
    return () => {
      for (const name of Object.keys(vars)) root.style.removeProperty(name);
    };
  }, []);

  return <ShellContext.Provider value={VALUE}>{children}</ShellContext.Provider>;
}
