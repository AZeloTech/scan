"use client";

import * as React from "react";
import {
  copyFor,
  setCurrentLang,
  type AppCopy,
  type Lang,
} from "@/lib/i18n";

/**
 * Holds the language the host chose and hands it to the tree.
 *
 * The language is a prop (`<ScanFlow lang>`), and nothing else: this library
 * does not read the browser's languages, does not remember a choice in storage
 * and renders no language switch. Those are the host's, like the rest of the
 * page around the component.
 *
 * It mirrors the prop into two places, and both are load-bearing:
 *
 *  * React context, for the components;
 *  * the i18n module's own `current`, for the store and `lib/naming.ts`, which
 *    compose strings from outside any component.
 *
 * It does not touch `<html lang>`: that attribute belongs to the host's page.
 * `ScanFlow` sets `lang` on its own root element instead, which is what a
 * screen reader reads for the subtree.
 */

interface LangContextValue {
  lang: Lang;
  copy: AppCopy;
}

const LangContext = React.createContext<LangContextValue>({
  lang: "pt",
  copy: copyFor("pt"),
});

export function useLang(): LangContextValue {
  return React.useContext(LangContext);
}

/** The shorthand every screen uses. */
export function useCopy(): AppCopy {
  return React.useContext(LangContext).copy;
}

export function LangProvider({
  lang,
  children,
}: {
  lang: Lang;
  children: React.ReactNode;
}) {
  // During render, not in an effect: the store and the naming helper read the
  // module value from callbacks that can run before any effect of ours has.
  setCurrentLang(lang);

  const value = React.useMemo<LangContextValue>(
    () => ({ lang, copy: copyFor(lang) }),
    [lang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}
