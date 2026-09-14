// The "scan." design system, compiled at LIBRARY BUILD TIME into one stylesheet.
//
// Tailwind is a devDependency here and never reaches a consumer: `npm run
// build:styles` compiles this config plus `src/styles.css` into `dist/styles.css`,
// which is plain CSS. A host imports that one file and needs no Tailwind, no
// PostCSS and no config of its own — which is what lets this component live
// inside applications that forbid Tailwind in their own source.
//
import type { Config } from "tailwindcss";

// The "scan. by AZelo" system, ported from the Claude Design canvas
// `Scan App 2a` (which builds on the AZelo Social design system, not the
// product apps' sage/Newsreader one). The scanner is destined for open source
// and imports nothing from the rest of the repo — contract §"Boundary rule" —
// so every value is literal here. Never pure #000/#fff.
//
// Three families, three jobs, and none of them overlaps:
//   - `display` (Baloo 2)          — headlines and the "scan." wordmark;
//   - `sans` (Plus Jakarta Sans)   — every sentence;
//   - `mono` (JetBrains Mono)      — the micro-labels that carry state
//                                    ("PASSO 1 DE 3", "2 pág.", the stats rows);
//
// Contrast pairings that pass AA and are the ONLY ones used for text
// (unchanged by the restyle):
//   - body / CTA text: `deep` ↔ `warm` (either direction, ~14:1)
//   - warning text:    `warning-deep` on `warning-bg` (~6.9:1)
//   - success text:    `ok-ink` on `ok-bg` (~6.4:1)
//   - on a night surface: `warm`, `cream` and `mist` all clear AA on `night`.
// `sage`, `mist`, `moss`, `dew`, `frost` and `text-faint` are for large type,
// borders, fills and decoration only. The design canvas puts `peach` on
// `peach-bg` for the "bordas não encontradas" row; that pairing is ~2.2:1, so
// the card treatment is kept and the *text* uses `warning-deep`.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  /**
   * Every utility this file generates is emitted as `.scan-root .thing`, so the
   * stylesheet can only ever style what is inside the component's own root.
   * A host that uses Tailwind of its own keeps its `.flex`; ours wins inside
   * our subtree on specificity, and theirs is untouched everywhere else.
   */
  important: ".scan-root",
  corePlugins: {
    /**
     * No preflight. Tailwind's reset is a global document reset — it would
     * restyle the host's headings, lists, buttons and form controls the moment
     * our stylesheet is imported. `src/styles.css` carries a small reset of its
     * own, scoped to `.scan-root`, covering what the components actually assume.
     */
    preflight: false,
    /**
     * No `.container`. It is emitted as soon as the word appears anywhere in the
     * sources (`containerRef` is enough), and it is a bare class selector with
     * media queries — exactly the kind of rule that would restyle a host's own
     * `.container`. Nothing here uses it.
     */
    container: false,
  },
  theme: {
    extend: {
      colors: {
        sage: "#5C7F6B",
        /** Link and "ótima" green — AA on `warm` and `cream`. */
        pine: "#3E6250",
        leaf: "#2D4A3A",
        deep: "#1F3128",
        warm: "#FAFAF7",
        cream: "#F0EDE5",
        /** The sheet of paper itself: previews, page stacks, thumbnails. */
        paper: "#F4F1E8",
        sand: "#E6E2D5",
        /** Sage read on a dark surface — chips and rules over the viewfinder. */
        mist: "#8FAB9B",
        /** The secondary CTA's outline. */
        moss: "#B0C4B7",
        dew: "#C9D8CE",
        /** The pale sage fill: step-trail track, notes, category chips. */
        frost: "#DDE5DC",
        /** Paler and warmer than `frost` — the canvas's welcome-card fill. */
        mint: "#E6EFE6",
        /** The rule around a `mint` card — one step darker than the fill. */
        "mint-line": "#CFE0D3",
        /**
         * The problem row's own accent: chevron, icons and the ✎ of a page the
         * app could not read. Deeper than `peach` (4.0:1 on `peach-bg`), so it
         * carries a control where `peach` only tints a card.
         */
        clay: "#C9744A",
        /**
         * A control that is switched off but still visible — the ↑ of the first
         * row, the ↓ of the last. Never used for text.
         */
        stone: "#C9CCC2",
        /** The dot in "scan." — the one warm accent in the whole wordmark. */
        ember: "#DD8A5C",
        /**
         * The themeable camera shell. Every one of these is a CSS variable set
         * by `ShellThemeProvider` from a single chosen colour — see
         * `lib/shell-theme.ts` for the derivation and the contrast floors it
         * guarantees. **Never use an opacity modifier on these** (`bg-shell/50`
         * cannot work: the value is already a resolved colour, not channels).
         */
        shell: {
          DEFAULT: "var(--shell)",
          sunken: "var(--shell-sunken)",
          ink: "var(--shell-ink)",
          on: "var(--shell-on)",
          ink2: "var(--shell-ink2)",
          line: "var(--shell-line)",
          accent: "var(--shell-accent)",
          dim: "var(--shell-dim)",
          dim2: "var(--shell-dim2)",
          handle: "var(--shell-handle)",
          warn: "var(--shell-warn)",
          warnline: "var(--shell-warnline)",
        },
        /** Camera and full-bleed page surfaces. */
        night: {
          DEFAULT: "#12160F",
          2: "#1B1F18",
          deep: "#0F120D",
        },
        ink: {
          DEFAULT: "#1B1F1A",
          2: "#3A3A35",
          3: "#7B7C72",
          // The quiet-but-legible grey. `ink-3` is a decoration value (4.04:1
          // on `warm`); this one clears AA on all three paper surfaces —
          // 5.7:1 on `warm`, 5.0:1 on `cream`, 5.2:1 on `paper` — and is what
          // every mono label that carries a fact uses.
          4: "#63645B",
        },
        peach: {
          DEFAULT: "#DD9A74",
          soft: "#F0D3BF",
          bg: "#FDF6F1",
          /**
           * The deep brown the destructive sheet button writes in — the one
           * place `peach-soft` is a *fill under text* rather than a card tint.
           * ~7.4:1 on `peach-soft`, which is what makes that pairing legal at
           * all (the `peach`-on-`peach-bg` pairing above is not, and is why the
           * problem row's own text uses `warning-deep`).
           */
          ink: "#5A2F18",
        },
        text: {
          DEFAULT: "#1B1F1A",
          soft: "#3A3A35",
          faint: "#7B7C72",
        },
        warning: {
          DEFAULT: "#C89B4B",
          bg: "#F4EAD6",
          ink: "#8A6425",
          deep: "#6E4F1B",
        },
        ok: {
          DEFAULT: "#5C7F6B",
          bg: "#E3EAE2",
          ink: "#3E5B4A",
        },
        destroyed: "#C0472E",
        border: "#E2DECF",
        "border-soft": "#E6E2D5",
        /**
         * The desktop mode's own values.
         *
         * The desktop flow commits to one fixed light palette — it never shows
         * the shell-colour picker, so there is nothing for the themeable
         * `shell.*` variables to track. Most of the design's colours already
         * exist above and are used from there (`warm`, `paper`, `deep`, `leaf`,
         * `pine`, `mist`, `frost`, `mint`, `ember`, `peach`); what lives here
         * is only what the desktop artboard introduced and the phone screens
         * have no use for. Mobile never reads any of these.
         */
        desk: {
          /** The app background, a hair darker than `warm` — the desk itself. */
          bg: "#ECEADF",
          /** The dashed rule around the dropzone. */
          dash: "#C6D2C4",
          /** The outline button's border, one step warmer than `moss`. */
          edge: "#CDD6C9",
          /** Body copy inside the desktop cards. */
          body: "#3A3A35",
          /** The quieter sentence — the lead, the status line. */
          muted: "#5C5C54",
          /** Mono micro-labels that carry no state: counters, file sizes. */
          faint: "#9A9A90",
          /** The ghost numerals of the empty-state explainer. */
          ghost: "#D5DCD2",
          /** The viewer canvas, where the page is the only lit thing. */
          canvas: "#22271D",
          /** The one warning ink of the desktop mode ("bordas não encontradas"). */
          warn: "#A5613A",
          /** Its hairline — the `apagar` pill's border. */
          warnline: "#E8CEBA",
          /**
           * The quietest rule the desktop draws — the line under a card header,
           * the one above the rail's footer. `cream`'s value, named here
           * because on these screens it is a hairline and never a surface.
           */
          hair: "#F0EDE5",
          /** The rail's drag grip. Decoration only, never text. */
          grip: "#C2BDAE",
          /** The OCR switch, off. */
          off: "#DAD5C6",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      // One scale for the whole app, in the bands the mobile overhaul fixed and
      // the `Scan App 2a` canvas widened at the top: statements 27–30, screen
      // titles 20–22, body 15–16, helpers 13–14, chips 12–13, mono labels 11.
      // The root font-size is a plain 16px (globals.css), so these are literal.
      //
      // Baloo 2 carries a taller x-height than the Newsreader it replaces, so a
      // headline at the same px reads noticeably larger — which is why the
      // scale gained a step at the top rather than shifting every band up.
      fontSize: {
        // The three sizes below 11 exist only for mono labels, and only where
        // the design names them: the details list on step 3 (10.5), the
        // page counter and the row verdict on step 2 (10), and the second line
        // of a two-line footer button (9.5). Body text never goes here.
        "5xs": ["0.59375rem", { lineHeight: "0.75rem" }], // 9.5
        "4xs": ["0.625rem", { lineHeight: "0.875rem" }], // 10
        "3xs": ["0.65625rem", { lineHeight: "0.9375rem" }], // 10.5
        "2xs": ["0.6875rem", { lineHeight: "1rem" }], // 11 — mono micro-labels
        xs: ["0.75rem", { lineHeight: "1rem" }], // 12 — chips
        sm: ["0.8125rem", { lineHeight: "1.125rem" }], // 13 — helpers
        base: ["0.9375rem", { lineHeight: "1.375rem" }], // 15 — body
        lg: ["1rem", { lineHeight: "1.5rem" }], // 16 — emphasis, buttons
        xl: ["1.125rem", { lineHeight: "1.5rem" }], // 18 — card + header titles
        "2xl": ["1.25rem", { lineHeight: "1.625rem" }], // 20 — section titles
        "3xl": ["1.375rem", { lineHeight: "1.75rem" }], // 22 — screen titles
        "4xl": ["1.6875rem", { lineHeight: "1.13" }], // 27 — screen statements
        "5xl": ["1.875rem", { lineHeight: "1.08" }], // 30 — the largest statement
      },
      minHeight: {
        // 56px is the floor for a STANDALONE control, per the contract's
        // "big tap targets (≥56px)" for an elderly audience on cheap Androids.
        // The one exception — a tight row of icon buttons — is spelled out in
        // `IconButton` (`dense`), where 44px is paired with ≥8px gaps.
        tap: "56px",
        cta: "56px",
      },
      minWidth: {
        tap: "56px",
      },
      // Entrances, pops and reorders are GSAP's job now (`src/lib/motion.ts`).
      // What is left here is the two ambient "work is happening" textures, both
      // of which exist only while a request is genuinely open.
      keyframes: {
        "soft-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        "gentle-sweep": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(220%)" },
        },
      },
      animation: {
        "soft-pulse": "soft-pulse 1.8s ease-in-out infinite",
        "gentle-sweep": "gentle-sweep 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
