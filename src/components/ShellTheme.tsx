"use client";

import * as React from "react";
import { DEFAULT_SHELL } from "@/lib/shell-theme";

/**
 * The camera shell's colour.
 *
 * The derived palette is CSS custom properties, because the consumers are
 * Tailwind classes (`bg-shell`, `text-shell-ink2`, …). They are set as the
 * inline style of `ScanFlow`'s `.scan-root` element (`SHELL_ROOT_STYLE` in
 * `lib/shell-theme.ts`), which every screen — the `position: fixed` overlays
 * included — descends from. (A provider that wrote them to `<html>` used to
 * live here; it was never mounted, so the variables were never set.)
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


