import * as React from "react";
import clsx from "clsx";

/**
 * The whole icon vocabulary of the app, hand-drawn on a 24×24 grid in the
 * lucide idiom: 1.75px stroke, round caps and joins, `currentColor`, no fill.
 *
 * There are NO emoji anywhere in this UI. Emoji render differently on every
 * Android skin, ignore the sage palette, and read as a toy — these do neither.
 * Every icon is `aria-hidden`: the meaning always lives in the text or the
 * `aria-label` of the control wrapping it.
 */

export interface IconProps {
  /** Both axes, in px. The design band is 20–24; 40 for the capture surface. */
  size?: number;
  className?: string;
  strokeWidth?: number;
}

interface GlyphProps extends IconProps {
  children: React.ReactNode;
}

function Glyph({
  size = 22,
  strokeWidth = 1.75,
  className,
  children,
}: GlyphProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={clsx("shrink-0", className)}
    >
      {children}
    </svg>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M14.7 4H9.3L7.9 6.5H5.5A2.5 2.5 0 0 0 3 9v8a2.5 2.5 0 0 0 2.5 2.5h13A2.5 2.5 0 0 0 21 17V9a2.5 2.5 0 0 0-2.5-2.5h-2.4L14.7 4Z" />
      <circle cx="12" cy="13" r="3.4" />
    </Glyph>
  );
}

/** The gallery — a framed picture, distinct from the camera that takes one. */
export function ImageIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <circle cx="8.5" cy="10" r="1.6" />
      <path d="M3.5 16.5l4.6-4.1a2 2 0 0 1 2.7 0l3.4 3.1a2 2 0 0 0 2.7 0l1.9-1.7 1.7 1.5" />
    </Glyph>
  );
}

/** Anticlockwise quarter turn — the mirror of {@link RotateIcon}. */
export function RotateLeftIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4.5 9.5h5v-5" />
      <path d="M4.9 9.2A7.5 7.5 0 1 1 4.5 14" />
    </Glyph>
  );
}

/**
 * The header's back arrow, on the two surfaces the page editor opens over
 * itself (the corner editor and the full-size view). `BackPill` draws its own
 * "←" as a mono glyph inside a worded control; these headers have no word to
 * lean on, so the arrow has to be a real icon.
 */
export function ArrowLeftIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M19.5 12h-15" />
      <path d="M11 5.5 4.5 12l6.5 6.5" />
    </Glyph>
  );
}

/**
 * The page editor's overflow menu — three dots, and the only icon in the set
 * drawn as filled discs rather than as strokes: a 1.75 px ring at r=1.2 closes
 * up into a blob at any size a header uses.
 */
export function MoreIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="5.2" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="18.8" cy="12" r="1.35" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/**
 * "desfazer" — an arrow turning back on itself, distinct from
 * {@link RotateLeftIcon}: that one turns the *page* a quarter to the left,
 * this one puts the turn back where it was found.
 */
export function UndoIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9 14.5 4 9.5l5-5" />
      <path d="M4 9.5h9.5a5.5 5.5 0 0 1 0 11H8.5" />
    </Glyph>
  );
}

/**
 * The bang inside the status line's 16 px warn chip. Deliberately *not*
 * {@link AlertTriangleIcon}: the chip already supplies the round, tinted
 * container, and a triangle inside a circle at 10 px is two shapes fighting.
 */
export function ExclamationIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 6v7" />
      <path d="M12 17.4h.01" />
    </Glyph>
  );
}

/** One step back, for the PDF preview's page pager. */
export function ChevronLeftIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </Glyph>
  );
}

/** One step forward, for the PDF preview's page pager. */
export function ChevronRightIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9.5 5.5 16 12l-6.5 6.5" />
    </Glyph>
  );
}

/**
 * The GitHub mark. The only glyph in the set that is a filled logo rather than
 * a 1.75px stroke drawing — it is a trademark with a fixed shape, and redrawing
 * it in the house style would make it not-GitHub.
 */
export function GitHubIcon({ size = 22, className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={clsx("shrink-0", className)}
    >
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6l-.01-2.2c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.66-.3-5.46-1.33-5.46-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.4 11.4 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .33.2.72.81.6A12 12 0 0 0 12 .3z" />
    </svg>
  );
}


export function SparklesIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M11 3.5l1.5 4.1 4.1 1.5-4.1 1.5L11 14.7 9.5 10.6 5.4 9.1l4.1-1.5L11 3.5Z" />
      <path d="M18 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </Glyph>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M12 15V3" />
    </Glyph>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 6h17" />
      <path d="M8.5 6V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V6" />
      <path d="M18.5 6l-.9 13.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6" />
      <path d="M10 10.5v6" />
      <path d="M14 10.5v6" />
    </Glyph>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 19.5V4.5" />
      <path d="M5.5 11 12 4.5l6.5 6.5" />
    </Glyph>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 4.5v15" />
      <path d="M18.5 13 12 19.5 5.5 13" />
    </Glyph>
  );
}

/**
 * The verdict tick. `pathLength={1}` normalises the stroke so GSAP can draw it
 * with a plain 1→0 `strokeDashoffset` tween, whatever the icon's size.
 */
export function CheckIcon({ className, ...rest }: IconProps) {
  return (
    <Glyph className={className} {...rest}>
      <path d="M20 6.5 9.2 17.3 4 12.1" pathLength={1} data-draw="check" />
    </Glyph>
  );
}

export function AlertTriangleIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10.3 4.3 2.7 17.4a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 17.2h.01" />
    </Glyph>
  );
}

export function ShareIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="18" cy="5.5" r="2.8" />
      <circle cx="6" cy="12" r="2.8" />
      <circle cx="18" cy="18.5" r="2.8" />
      <path d="M8.5 13.4 15.5 17.1" />
      <path d="M15.5 6.9 8.5 10.6" />
    </Glyph>
  );
}

export function WhatsAppIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.8L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5Z" />
      <path d="M9.2 8.6c.5-.1.8 0 1 .5l.6 1.3c.1.3 0 .6-.2.8l-.5.5c.5 1 1.4 1.9 2.4 2.4l.5-.5c.2-.2.5-.3.8-.2l1.3.6c.5.2.6.5.5 1-.2.7-1 1.2-1.7 1.1-2.7-.4-5.2-2.9-5.6-5.6-.1-.7.4-1.5 1-1.7l-.1-.2Z" />
    </Glyph>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="m4 7.5 8 5.8 8-5.8" />
    </Glyph>
  );
}

export function FileTextIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7" />
      <path d="M8.5 16.5h5" />
    </Glyph>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
      <path d="M20.5 3.5V9H15" />
    </Glyph>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </Glyph>
  );
}

/** Crop marks — "ajustar cantos", the manual rescue for a bad detection. */
export function CropIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6.5 2.5v15h15" />
      <path d="M2.5 6.5h15v15" />
    </Glyph>
  );
}

/**
 * "Girar" — a page with an arrow turning clockwise over its corner. The sheet
 * is drawn as a rounded rectangle so it reads as paper next to `FileTextIcon`,
 * and the arc opens to the right because the button always turns that way.
 */
export function RotateIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.5" y="8.5" width="12" height="12" rx="2" />
      <path d="M12 4.2a7.5 7.5 0 0 1 7.5 7.5" />
      <path d="M17.8 9.2 19.5 11.7 21.2 9.2" />
    </Glyph>
  );
}

/** "Toque numa página para girar, clarear ou ajustar os cantos." */
export function PencilIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M16.5 3.9a2.1 2.1 0 0 1 3 3L8.6 17.8l-4 1 1-4L16.5 3.9Z" />
      <path d="M14.5 5.9l3.6 3.6" />
    </Glyph>
  );
}

/** "＋ mais uma página" — the footer's second offer. */
export function PlusIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Glyph>
  );
}

/**
 * "Ver a imagem inteira" — four corners opening outwards. The page view's way
 * into the full-resolution render, where the user judges the quality of the
 * very bytes the PDF will carry.
 */
export function ExpandIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9 3.5H3.5V9" />
      <path d="M15 3.5h5.5V9" />
      <path d="M9 20.5H3.5V15" />
      <path d="M15 20.5h5.5V15" />
    </Glyph>
  );
}

/**
 * "sem melhorias" — a disc with one half inked, the universal mark for *how
 * much improvement is being applied*. It replaces the eye on the page view's
 * floating chip: an eye says "look", and what that control does is take the
 * improvements away, which is a contrast question rather than a visibility one.
 * It is also the "Acabamento" tile's mark, for the same reason: what that
 * screen changes is how much ink is on the sheet.
 *
 * The filled half is the one place in this set a path carries `fill`; the
 * outline is still the house 1.75px stroke.
 */
export function ContrastIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/**
 * "o que são as melhorias" — the question mark in a ring, next to the row of
 * controls it explains. A ring rather than a bare glyph: at 15 px a lone "?"
 * beside a hairline rule reads as punctuation left behind by a label.
 *
 * The mark is drawn as a path rather than set as text, like every other glyph
 * in this set — a `<text>` node would inherit the app's display face and shift
 * with it.
 */
export function HelpIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.6c0 1.7-2.4 1.9-2.4 3.6" />
      <path d="M12 17.1h.01" />
    </Glyph>
  );
}

/**
 * "curvatura" — the tilde of a page that will not lie flat, which is exactly
 * the document the dewarp model exists for (a page out of a bound book, a sheet
 * that keeps its fold).
 */
export function WaveIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 13.5c2.5-5.5 6-5.5 8.5 0s6 5.5 8.5 0" />
    </Glyph>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2.5 12S6.3 5.5 12 5.5 21.5 12 21.5 12 17.7 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3.1" />
    </Glyph>
  );
}

/**
 * Work-in-flight. This is the ONE looping animation in the app and it exists
 * only while a request is actually open — CSS, so `prefers-reduced-motion`
 * flattens it without any JS.
 */
export function SpinnerIcon({
  size = 22,
  strokeWidth = 1.75,
  className,
}: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className={clsx("shrink-0 motion-safe:animate-spin", className)}
    >
      <circle cx="12" cy="12" r="8.5" opacity="0.28" />
      <path d="M20.5 12A8.5 8.5 0 0 0 12 3.5" />
    </svg>
  );
}

/**
 * The dropzone's glyph: an arrow coming down into an open tray.
 *
 * Deliberately not {@link ImageIcon} — a picture frame says "here is a photo",
 * and the desktop's step 1 is asking for a *gesture*: put something in here.
 * The tray is open at the top because that is where the files land.
 */
export function UploadIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M12 3.5v10.5" />
      <path d="M8 10.2l4 3.8 4-3.8" />
      <path d="M4 15.5v2.5A2.5 2.5 0 0 0 6.5 20.5h11a2.5 2.5 0 0 0 2.5-2.5v-2.5" />
    </Glyph>
  );
}

/** A folder — the "Escolher uma pasta" affordance and the file card's header. */
export function FolderIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.5 7.2A2 2 0 0 1 5.5 5.2h3.3a2 2 0 0 1 1.5.7l1.1 1.3h7.1a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.2Z" />
    </Glyph>
  );
}

/**
 * The drag grip on a page row — two columns of dots, the desktop convention
 * for "this thing can be picked up and put somewhere else".
 *
 * Dots rather than the usual three bars: the row is 48 px tall and already
 * carries a thumbnail, a numeral and two lines of text, and bars at that size
 * read as a menu button.
 */
export function GripIcon({ size = 22, className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
      className={clsx("shrink-0", className)}
    >
      <circle cx="9.5" cy="7" r="1.35" />
      <circle cx="9.5" cy="12" r="1.35" />
      <circle cx="9.5" cy="17" r="1.35" />
      <circle cx="14.5" cy="7" r="1.35" />
      <circle cx="14.5" cy="12" r="1.35" />
      <circle cx="14.5" cy="17" r="1.35" />
    </svg>
  );
}
