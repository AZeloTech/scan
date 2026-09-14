/**
 * The name the finished PDF carries when the host did not pass its own.
 *
 * `AAAAMMDD-HHmm_<sufixo>.pdf` — `20260817-1432_exame.pdf`. Two halves, and
 * neither is typed:
 *
 *  * the **prefix** is the local date and time the scan began, so that *sorting
 *    by name sorts by time*. On a phone's file list the default order is
 *    alphabetical, and a leading ISO-ish stamp is the only cheap way to make
 *    that order also be chronological. It is minted once per session rather
 *    than at build time, so a document is filed under the moment the user
 *    photographed it, not the moment they got round to tapping "Gerar";
 *  * the **suffix** is the marking they chose on step 3 — `exame`, `receita`,
 *    `vacina`, `laudo`, `atestado` — or the free text behind "✎ editar".
 *
 * The suffix is slugged hard: lowercase, no accents, no spaces, no punctuation.
 * That is a change from the version that preserved "Exame de sangue da Maria"
 * verbatim, and it is deliberate — the name is now composed rather than typed,
 * so it is a *label* in a file list rather than a sentence, and a label that
 * every filesystem, share sheet and messaging app carries unchanged is worth
 * more than one that keeps its capitals.
 *
 * Worked examples (a scan begun at 2026-08-17 14:32 local time):
 *
 * | input | output |
 * |---|---|
 * | `"exame"` | `20260817-1432_exame.pdf` |
 * | `"Vacinação da Ana"` | `20260817-1432_vacinacao-da-ana.pdf` |
 * | `"Raio-X: coluna / lombar"` | `20260817-1432_raio-x-coluna-lombar.pdf` |
 * | `null` or `"   "` or `"///"` | `20260817-1432_documento.pdf` |
 * | more than 24 characters | cut at 24, never mid-word-separator |
 */

/**
 * The six markings step 3 offers, in the order the grid draws them.
 *
 * They are **keys, not words**: the label the user reads comes from the
 * dictionary and the suffix in the file name is that label, slugged — so an
 * English reader files `20260817-1432_prescription.pdf` and a Brazilian one
 * files `…_receita.pdf`, and neither has a file named in a language they do not
 * read. `outro` is the only one that names no document: it opens the sheet
 * where the user writes their own suffix.
 */
export const DOCUMENT_MARKS = [
  "exame",
  "receita",
  "vacina",
  "laudo",
  "atestado",
  "outro",
] as const;

export type DocumentMark = (typeof DOCUMENT_MARKS)[number];

/** The marking a document carries until the user says otherwise. */
export const DEFAULT_MARK: DocumentMark = "exame";

/**
 * Empty, blank, or nothing but punctuation we had to strip.
 *
 * The default is pt-BR because the product is; callers reading the app in
 * another language pass their own word, so the one part of the file name the
 * user did not choose is still in the language they are reading.
 */
const FALLBACK_SLUG = "documento";

/**
 * The cap on the free-text suffix, and therefore on every suffix:
 * long enough for "vacinacao-da-ana", short enough that the date prefix stays
 * visible in a file list that truncates.
 */
export const SLUG_MAX_LENGTH = 24;

/**
 * Everything that is not a letter or a digit becomes a hyphen.
 *
 * Unicode-aware on purpose. The obvious `[^a-z0-9]` would also erase Cyrillic,
 * Greek and CJK entirely and file those documents under "documento" — this
 * keeps any script's own letters and drops only the punctuation, the control
 * codes and the whitespace that a file name cannot carry.
 */
const NOT_A_WORD = /[^\p{Letter}\p{Number}]+/gu;

/** The combining marks left behind by NFD — what "sem acento" actually means. */
const COMBINING_MARKS = /\p{Mark}+/gu;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The suffix as one file-name-safe token: lowercase, unaccented, hyphenated,
 * capped.
 *
 * Exported so step 3 can show the file's name before the file exists;
 * {@link pdfFileName} is what actually names the download.
 */
export function documentSlug(
  name: string | null,
  fallback: string = FALLBACK_SLUG,
): string {
  const slug = slugify(name ?? "");
  if (slug.length > 0) return slug;
  // The caller's fallback is slugged the same way, so a stray space or accent
  // in a translated word cannot reach the file name.
  const safeFallback = slugify(fallback);
  return safeFallback.length === 0 ? FALLBACK_SLUG : safeFallback;
}

function slugify(value: string): string {
  const cleaned = value
    // Decompose first: "ç" is one code point until NFD splits it into "c" plus
    // a cedilla, and only then can the accent be dropped without the letter.
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NOT_A_WORD, "-")
    .replace(/^-+|-+$/g, "");
  return (
    [...cleaned]
      // Spread first: `slice` counts UTF-16 units, so a cap landing inside an
      // astral character would leave a lone surrogate and the file would be
      // named with a replacement character nobody typed.
      .slice(0, SLUG_MAX_LENGTH)
      .join("")
      // The cut can land on a separator, and a name ending in "-" reads as
      // truncated even when nothing was lost.
      .replace(/-+$/g, "")
  );
}

/**
 * `20260817-1432_exame.pdf`.
 *
 * `when` is the moment the **scan began**, read in **local time** on purpose:
 * the user sorts these next to photos taken the same afternoon, and a UTC stamp
 * would put an evening scan on tomorrow's date for every Brazilian time zone.
 *
 * There are no seconds. Two documents begun in the same minute would collide,
 * which the old `HHMMSS` form ruled out — but the browser's own download
 * handler already de-duplicates (`…(1).pdf`), and four digits the user can read
 * back to somebody over the phone are worth more than six they cannot.
 */
export function pdfFileName(
  name: string | null,
  when: Date,
  fallback?: string,
): string {
  return `${pdfNamePrefix(when)}_${documentSlug(name, fallback)}.pdf`;
}

/**
 * The prefix on its own — `20260817-1432`.
 *
 * Step 3 composes the name from this and the chosen marking, so the two are
 * assembled from the same function the download will use: the string on screen
 * is the file name, not a rendering of it.
 */
export function pdfNamePrefix(when: Date): string {
  const date = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
  return `${date}-${pad(when.getHours())}${pad(when.getMinutes())}`;
}
