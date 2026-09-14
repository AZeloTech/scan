"use client";

/**
 * The desktop mode's front door: a pile of files → pages, in order, one at a
 * time.
 *
 * The phone has one file per interaction and a confirm screen after each; a
 * desktop hands over a whole folder in one drop and expects a list to appear.
 * So this module owns the two things that are genuinely new — **what order the
 * pile is in** and **how far down it we get before the document is full** — and
 * nothing else: every file still becomes a page through `captureFromFile`, the
 * same measure-then-detect path the gallery pick uses, because a second way to
 * make a page would be a second set of gate readings that are not comparable
 * with the first.
 *
 * Strictly sequential, and that is the point rather than a simplification: the
 * library's memory budget is one full-resolution image at a time, and
 * a twenty-file drop processed in parallel is twenty 3000 px canvases racing
 * each other on a machine that may have none to spare. The user sees the whole
 * list immediately — rows first, thumbnails as they land — so the sequence
 * costs them nothing they can perceive.
 */

import { captureFromFile, type Capture } from "@/lib/capture-intake";
import { ACCEPTED_UPLOAD_TYPES, isAcceptedImageType } from "@/lib/image";
import { ImagePrepError } from "@/lib/image-error";
import { importPdf, isPdfFile, type PdfPageSink } from "@/lib/pdf-import";
import type { PageErrorCode } from "@/lib/scan-store";
import type { AssetUrls } from "@/lib/runtime-config";

/**
 * The picker's `accept`, wider than the phone's by exactly two formats.
 *
 * PDF because the desktop can read one now, and HEIC because a Mac's own
 * Photos app writes them and the file chooser would otherwise grey out the very
 * files the user is looking at. HEIC is **best effort**: Safari decodes it
 * natively, other browsers do not, and one that cannot says so per file rather
 * than pretending the format is unsupported everywhere.
 */
export const DESKTOP_ACCEPT = [
  ...ACCEPTED_UPLOAD_TYPES,
  "application/pdf",
  ".pdf",
  "image/heic",
  "image/heif",
  ".heic",
  ".heif",
].join(",");

/** Where a chosen file has got to. One row of the step-1 list. */
export type ChosenState = "waiting" | "opening" | "added" | "refused" | "skipped";

export interface ChosenFile {
  /** Stable for the row's whole life; the file name is not unique. */
  key: string;
  name: string;
  /** Bytes, for the mono size column. */
  size: number;
  /** The badge: `JPG`, `PNG`, `PDF`, `HEIC`… */
  kind: string;
  state: ChosenState;
  /** The pages this file became — more than one only for a PDF. */
  pageIds: readonly string[];
  /** Why it was refused, as a code the dictionary renders. */
  error: PageErrorCode | null;
}

/**
 * The badge word, from the extension first and the MIME type second.
 *
 * The extension first because it is what the user sees in their own file
 * manager, and because a browser that reports `""` for a HEIC (several do) would
 * otherwise badge it as nothing at all.
 */
export function fileKind(file: File): string {
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toUpperCase();
  if (extension !== undefined) {
    return extension === "JPEG" ? "JPG" : extension;
  }
  const subtype = file.type.split("/")[1];
  if (subtype === undefined || subtype.length === 0) return "?";
  return subtype === "jpeg" ? "JPG" : subtype.toUpperCase();
}

/**
 * The folder the user picked, or null when the files came loose.
 *
 * `webkitDirectory` reports each file's path relative to the chosen folder, so
 * the first segment is the folder's own name — the only place the browser
 * exposes it. A drop of loose files has no path at all, which is what tells the
 * two apart.
 */
export function folderLabel(files: readonly File[]): string | null {
  for (const file of files) {
    const relative: string | undefined = (file as { webkitRelativePath?: string })
      .webkitRelativePath;
    if (relative === undefined || relative.length === 0) continue;
    const [first] = relative.split("/");
    if (first !== undefined && first.length > 0) return first;
  }
  return null;
}

const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * The order the pages will be in.
 *
 * A folder is sorted by name, because that is the promise step 1 makes out loud
 * ("uma pasta inteira mantém a ordem dos nomes") and because the browser hands
 * a directory listing over in whatever order the filesystem felt like. Numeric
 * collation, so `IMG_9` comes before `IMG_10` rather than after it.
 *
 * A multi-select or a drag-and-drop keeps the order it arrived in: there the
 * user's own selection order is the only intent there is, and re-sorting it
 * would silently overrule a hand-built sequence.
 */
export function orderForIntake(files: readonly File[]): File[] {
  const list = [...files];
  if (folderLabel(list) === null) return list;
  return list.sort((left, right) => {
    const leftPath =
      (left as { webkitRelativePath?: string }).webkitRelativePath ?? left.name;
    const rightPath =
      (right as { webkitRelativePath?: string }).webkitRelativePath ?? right.name;
    return COLLATOR.compare(leftPath, rightPath);
  });
}

/**
 * The files inside a **dropped folder**, in the order step 1 promises.
 *
 * `dataTransfer.files` is flat and a dropped directory simply is not in it —
 * the browser hands over one entry the file list cannot represent, and the
 * whole folder silently becomes nothing (or, worse, one refused row named after
 * the folder). Since the panel says "uma pasta inteira mantém a ordem dos
 * nomes" right above the drop target, the drop has to honour it the same way
 * the folder button does.
 *
 * `webkitGetAsEntry` is the only API that exposes the tree, and it is read
 * **synchronously** here on purpose: a `DataTransfer` is neutered the moment
 * the drop handler returns, so the entries are collected first and walked
 * afterwards. Each recovered file is given the `webkitRelativePath` the folder
 * picker would have set, which is what makes {@link folderLabel} name the card
 * and {@link orderForIntake} sort it.
 *
 * A browser without the API answers `dataTransfer.files`, which is exactly
 * today's behaviour: loose files still work, a folder still cannot.
 */
export function filesFromDrop(transfer: DataTransfer): Promise<File[]> {
  const entries: FileSystemEntry[] = [];
  const items = transfer.items;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry === null || entry === undefined) return loose(transfer);
    entries.push(entry);
  }
  if (entries.length === 0) return loose(transfer);
  return walkEntries(entries);
}

function loose(transfer: DataTransfer): Promise<File[]> {
  return Promise.resolve(Array.from(transfer.files));
}

async function walkEntries(entries: readonly FileSystemEntry[]): Promise<File[]> {
  const collected: File[] = [];
  for (const entry of entries) await walkEntry(entry, collected, false);
  return collected;
}

/**
 * `nested` is what tells a folder's contents from files dropped loose beside
 * it, and it is load-bearing rather than tidy: {@link folderLabel} reads a
 * relative path as "this came from a folder", and {@link orderForIntake} sorts
 * the whole pile by name the moment one exists. Stamping a top-level file with
 * its own name as a path would therefore rename the card after a file and
 * re-sort a hand-picked drop alphabetically — the exact thing loose files are
 * promised not to suffer.
 */
async function walkEntry(
  entry: FileSystemEntry,
  into: File[],
  nested: boolean,
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    if (file === null) return;
    if (nested) {
      // `fullPath` is "/pasta/IMG_1.jpg"; the picker's own relative path has
      // no leading slash, and the rest of the module reads the picker's shape.
      Object.defineProperty(file, "webkitRelativePath", {
        value: entry.fullPath.replace(/^\/+/, ""),
        configurable: true,
      });
    }
    into.push(file);
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // `readEntries` answers a *batch*, not the directory: Chrome caps it at 100
  // and a folder of scans passes that easily. Read until it answers nothing.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) return;
    for (const child of batch) await walkEntry(child, into, true);
  }
}

/** The rows, drawn before a single byte has been decoded. */
export function chosenFrom(files: readonly File[], seed: number): ChosenFile[] {
  return files.map((file, index) => ({
    key: `f${seed}-${index}`,
    name: file.name,
    size: file.size,
    kind: fileKind(file),
    state: "waiting" as const,
    pageIds: [],
    error: null,
  }));
}

/** The mono summary's byte total. */
export function totalBytes(files: readonly ChosenFile[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

/** What the runner reports back. Implemented by the flow, never by a lib. */
export interface IntakeSink {
  /** Room left in the document. Asked before every single page. */
  capacity: () => number;
  /** Commit one page. Answers its new id, or null if the store refused it. */
  add: (capture: Capture) => string | null;
  onStart: (key: string) => void;
  /** Called once per file, whatever happened to it. */
  onSettled: (
    key: string,
    pageIds: readonly string[],
    error: PageErrorCode | null,
  ) => void;
  /** The document filled up before the pile ran out. */
  onCapacityHit: () => void;
  /** The user cleared the list or left mid-import. */
  cancelled: () => boolean;
}

/**
 * A file whose type the app does not claim to read, handed to the decoder
 * anyway.
 *
 * `captureFromFile` refuses an unknown MIME type up front — the right call on a
 * phone, where the only sources are the camera and the gallery and a surprising
 * type means something went wrong. On a desktop the file chooser is the whole
 * filesystem and the *browser* is the authority on what it can decode: Safari
 * reads HEIC, Chrome on Linux does not, and neither of them tells us in advance.
 * Re-typing the file to `""` takes it down `captureFromFile`'s own
 * "some pickers report no MIME type" branch, which decodes first and refuses
 * only if the decode actually failed — a per-file, named refusal instead of a
 * blanket one.
 */
function bestEffort(file: File): File {
  if (file.type === "" || isAcceptedImageType(file)) return file;
  return new File([file], file.name);
}

/**
 * The two decoders, behind one interface so the runner's own rules are
 * testable without a DOM.
 *
 * The rules are the part worth testing — order, the cap, one bad file not
 * costing the others, a cancel landing mid-decode — and every one of them is
 * invisible from outside a browser as long as the decode is wired in
 * literally. The seam is the same shape `scan-store.ts` uses for its byte work
 * and for the same reason; production always passes
 * {@link BROWSER_DECODERS}.
 */
export interface IntakeDecoders {
  /** One image file → one page. */
  image: (file: File) => Promise<Capture>;
  /** One PDF → many pages. Answers true if it stopped on a full document. */
  pdf: (file: File, sink: PdfPageSink) => Promise<boolean>;
}

/**
 * The real decoders, bound to wherever the host serves this library's assets.
 *
 * A factory rather than a constant because both decoders need that base: the
 * image path runs corner detection, the PDF path loads the pdf.js runtime, and
 * neither can be resolved until a host has told us where its copy lives.
 */
export function browserDecoders(assets: AssetUrls): IntakeDecoders {
  return {
    image: (file) => captureFromFile(bestEffort(file), assets, "desktop"),
    pdf: (file, sink) => importPdf(file, sink, assets),
  };
}

/**
 * Turn the pile into pages, in order, stopping when the document is full.
 *
 * Never throws: a file that cannot be read is reported through
 * {@link IntakeSink.onSettled} and the next one is opened. One bad photo in a
 * folder of twenty must not cost the other nineteen.
 */
export async function runIntake(
  items: readonly { key: string; file: File }[],
  sink: IntakeSink,
  assets: AssetUrls,
  decoders: IntakeDecoders = browserDecoders(assets),
): Promise<void> {
  for (const item of items) {
    if (sink.cancelled()) return;
    if (sink.capacity() <= 0) {
      sink.onCapacityHit();
      return;
    }
    sink.onStart(item.key);
    const pageIds: string[] = [];
    let error: PageErrorCode | null = null;
    // Whether *this* file left something behind. Asked of the decoder rather
    // than inferred from `pageIds`: a PDF that filled the document on its last
    // page still delivered pages, and an empty PDF delivered none without the
    // document being full — inferring it from the count gets both backwards.
    let filled = false;
    try {
      if (isPdfFile(item.file)) {
        const stopped = await decoders.pdf(item.file, {
          capacity: sink.capacity,
          cancelled: sink.cancelled,
          onPage: (capture) => {
            const id = sink.add(capture);
            if (id === null) filled = true;
            else pageIds.push(id);
          },
        });
        filled = filled || stopped;
      } else {
        const capture = await decoders.image(item.file);
        // The decode is the long part of this loop, and "limpar" can land
        // inside it. Without this the page is committed to a store the user
        // just emptied and shows up with no row of its own.
        if (sink.cancelled()) return;
        const id = sink.add(capture);
        if (id === null) filled = true;
        else pageIds.push(id);
      }
    } catch (thrown) {
      error = thrown instanceof ImagePrepError ? thrown.code : "generic";
    }
    if (sink.cancelled()) return;
    sink.onSettled(item.key, pageIds, error);
    if (error === null && filled) sink.onCapacityHit();
  }
}
