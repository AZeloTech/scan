import assert from "node:assert/strict";
import test from "node:test";

import {
  chosenFrom,
  DESKTOP_ACCEPT,
  fileKind,
  folderLabel,
  orderForIntake,
  runIntake,
  totalBytes,
  type IntakeDecoders,
  type IntakeSink,
} from "./desktop-intake.ts";
import type { Capture } from "./capture-intake.ts";
import { ImagePrepError } from "./image-error.ts";
import { assetUrls } from "@/lib/runtime-config";

/** Any well-formed base works here: these tests never fetch. */
const TEST_ASSETS = assetUrls("/scan-assets");

/**
 * What the desktop's front door decides before a single byte is decoded: what
 * order the pile is in, what each file is called, and how much of it there is.
 *
 * All of it is pure — the decoding itself is the same `captureFromFile` the
 * phone uses and is tested where it lives — so it is testable at the level it
 * is written at, which is the only level where "a folder keeps the order of the
 * names" is a checkable claim rather than a screenshot.
 */

/** A `File` with the folder path the directory picker would have set. */
function inFolder(path: string, size = 1024): File {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const file = new File([new Uint8Array(size)], name, { type: "image/jpeg" });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

function loose(name: string, type = "image/jpeg", size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

test("the badge is the extension the user sees in their own file manager", () => {
  assert.equal(fileKind(loose("exame.jpg")), "JPG");
  // Not "JPEG": the two spellings are the same format and two badges for one
  // thing reads as two kinds of file.
  assert.equal(fileKind(loose("exame.jpeg")), "JPG");
  assert.equal(fileKind(loose("receita.PNG", "image/png")), "PNG");
  assert.equal(fileKind(loose("laudo.pdf", "application/pdf")), "PDF");
  // Several browsers report no MIME type at all for HEIC; the name still does.
  assert.equal(fileKind(loose("IMG_0021.HEIC", "")), "HEIC");
});

test("a file with no extension falls back to what the browser called it", () => {
  assert.equal(fileKind(loose("scan-000", "image/png")), "PNG");
  assert.equal(fileKind(loose("scan-000", "")), "?");
});

test("a folder pick is sorted by name, numerically", () => {
  const picked = [
    inFolder("consulta-agosto/IMG_10.jpg"),
    inFolder("consulta-agosto/IMG_2.jpg"),
    inFolder("consulta-agosto/IMG_1.jpg"),
  ];
  // The promise step 1 makes out loud. Numeric, so page 9 comes before page 10
  // rather than after it — which plain string order gets wrong every time.
  assert.deepEqual(
    orderForIntake(picked).map((file) => file.name),
    ["IMG_1.jpg", "IMG_2.jpg", "IMG_10.jpg"],
  );
});

test("loose files keep the order they arrived in", () => {
  const picked = [loose("z.jpg"), loose("a.jpg"), loose("m.jpg")];
  // A multi-select or a drop carries the user's own sequence, and re-sorting it
  // would silently overrule a hand-built order.
  assert.deepEqual(
    orderForIntake(picked).map((file) => file.name),
    ["z.jpg", "a.jpg", "m.jpg"],
  );
});

test("the card's header is the folder's own name, or nothing", () => {
  assert.equal(folderLabel([inFolder("consulta-agosto/IMG_1.jpg")]), "consulta-agosto");
  assert.equal(folderLabel([loose("IMG_1.jpg")]), null);
  // A nested pick still names the folder the user chose, not the leaf.
  assert.equal(
    folderLabel([inFolder("exames/2026/agosto/IMG_1.jpg")]),
    "exames",
  );
});

test("the rows exist before any byte is decoded, and are keyed uniquely", () => {
  const first = chosenFrom([loose("a.jpg"), loose("a.jpg")], 1);
  const second = chosenFrom([loose("a.jpg")], 2);
  assert.deepEqual(
    first.map((row) => row.state),
    ["waiting", "waiting"],
  );
  // Two files can share a name — and a second drop lands beside the first, so
  // the key has to survive both.
  const keys = new Set([...first, ...second].map((row) => row.key));
  assert.equal(keys.size, 3);
});

test("the summary counts the files the user picked, not the pages", () => {
  const rows = chosenFrom([loose("a.jpg", "image/jpeg", 2048), loose("b.pdf", "application/pdf", 4096)], 1);
  assert.equal(totalBytes(rows), 6144);
});

/**
 * The runner's own four rules, with both decoders faked.
 *
 * Everything below is about *order and bookkeeping*, never about pixels: the
 * decode is the same `captureFromFile` the phone uses and is tested where it
 * lives. What is only checkable here is that one file waits for the last, that
 * a full document says so exactly once, that a refusal costs one row and not
 * the batch, and that a "limpar" landing **inside** a decode does not leave a
 * page in the store with no row to belong to.
 */

function capture(): Capture {
  return {
    canonical: new Blob([new Uint8Array(8)], { type: "image/jpeg" }),
    corners: null,
    gate: null,
    path: "desktop",
  };
}

interface Recorder {
  sink: IntakeSink;
  /** Every call, in the order it happened — the sequencing claim. */
  log: string[];
  added: number;
  capacityHits: number;
  settled: { key: string; pages: number; error: string | null }[];
}

function recorder(room: number, cancelAfter?: () => boolean): Recorder {
  const state: Recorder = {
    log: [],
    added: 0,
    capacityHits: 0,
    settled: [],
    sink: {
      capacity: () => room - state.added,
      add: () => {
        if (room - state.added <= 0) return null;
        state.added += 1;
        state.log.push(`add:${state.added}`);
        return `p${state.added}`;
      },
      onStart: (key) => state.log.push(`start:${key}`),
      onSettled: (key, pageIds, error) => {
        state.log.push(`settled:${key}`);
        state.settled.push({ key, pages: pageIds.length, error });
      },
      onCapacityHit: () => {
        state.capacityHits += 1;
      },
      cancelled: () => cancelAfter?.() ?? false,
    },
  };
  return state;
}

function decoders(over: Partial<IntakeDecoders> = {}): IntakeDecoders {
  return {
    image: async () => capture(),
    pdf: async () => false,
    ...over,
  };
}

test("files are opened strictly one after the other", async () => {
  const state = recorder(10);
  let open = 0;
  await runIntake(
    [
      { key: "a", file: loose("a.jpg") },
      { key: "b", file: loose("b.jpg") },
    ],
    state.sink,
    TEST_ASSETS,
    decoders({
      image: async () => {
        // The memory budget is one full-resolution image at a time; a second
        // decode starting before the first finished is the whole bug.
        open += 1;
        assert.equal(open, 1);
        await Promise.resolve();
        open -= 1;
        return capture();
      },
    }),
  );
  assert.deepEqual(state.log, [
    "start:a",
    "add:1",
    "settled:a",
    "start:b",
    "add:2",
    "settled:b",
  ]);
});

test("a PDF truncated on its last page still reports the cap", async () => {
  // The trap this exists for: the file delivered pages, so counting them says
  // "nothing was left behind" — and the pages past the cap vanish in silence.
  const state = recorder(2);
  await runIntake(
    [{ key: "a", file: loose("laudo.pdf", "application/pdf") }],
    state.sink,
    TEST_ASSETS,
    decoders({
      pdf: async (_file, sink) => {
        sink.onPage(capture());
        sink.onPage(capture());
        return true;
      },
    }),
  );
  assert.equal(state.settled[0].pages, 2);
  assert.equal(state.capacityHits, 1);
});

test("a PDF with no pages at all is not a full document", async () => {
  const state = recorder(10);
  await runIntake(
    [{ key: "a", file: loose("vazio.pdf", "application/pdf") }],
    state.sink,
    TEST_ASSETS,
    decoders({ pdf: async () => false }),
  );
  assert.deepEqual(state.settled, [{ key: "a", pages: 0, error: null }]);
  // There is room for ten more pages; claiming the document is full would send
  // the user looking for pages that were never in the file.
  assert.equal(state.capacityHits, 0);
});

test("one refused file costs one row, never the batch", async () => {
  const state = recorder(10);
  await runIntake(
    [
      { key: "a", file: loose("a.jpg") },
      { key: "b", file: loose("b.heic", "") },
      { key: "c", file: loose("c.jpg") },
    ],
    state.sink,
    TEST_ASSETS,
    decoders({
      image: async (file) => {
        if (file.name === "b.heic") throw new ImagePrepError("unsupported");
        return capture();
      },
    }),
  );
  assert.deepEqual(
    state.settled.map((row) => `${row.key}:${row.error ?? "ok"}`),
    ["a:ok", "b:unsupported", "c:ok"],
  );
  assert.equal(state.added, 2);
  // A refusal is not the document filling up.
  assert.equal(state.capacityHits, 0);
});

test("a clear landing mid-decode leaves no page behind", async () => {
  let cleared = false;
  const state = recorder(10, () => cleared);
  await runIntake(
    [
      { key: "a", file: loose("a.jpg") },
      { key: "b", file: loose("b.jpg") },
    ],
    state.sink,
    TEST_ASSETS,
    decoders({
      image: async () => {
        // "limpar" pressed while this very file is being read: the row it
        // would belong to is already gone from the list.
        cleared = true;
        return capture();
      },
    }),
  );
  assert.equal(state.added, 0);
  assert.deepEqual(state.log, ["start:a"]);
});

test("the picker offers exactly the formats step 1 promises", () => {
  for (const needed of ["image/jpeg", "image/png", "application/pdf", ".heic"]) {
    assert.ok(
      DESKTOP_ACCEPT.includes(needed),
      `the accept attribute must name ${needed}`,
    );
  }
});
