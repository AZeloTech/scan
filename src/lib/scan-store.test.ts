import assert from "node:assert/strict";
import test from "node:test";

import type { AppliedDeskew, DewarpStageReason } from "./dewarp-stage.ts";
import { honestySubject, type PageTransform } from "./honesty.ts";
import { ImagePrepError } from "./image.ts";
import {
  RenderAbandonedError,
  renderWithFallback,
  RenderStageError,
  type PageFinish,
  type RenderStage,
  type RenderRequest,
  type RenderedPage,
} from "./page-processing.ts";
import { pdfFileName } from "./naming.ts";
import { startPdfBuild } from "./generate.ts";
import type { GateReading } from "./capture-gate.ts";
import type { NormalizedQuad } from "./quad.ts";
import {
  createScanStore,
  curlFallbackReason,
  dewarpConsentRequired,
  dewarpOutcome,
  effectiveFinish,
  straightenOutcome,
  straightenOutcomeCode,
  isRendered,
  pageGate,
  type QualityEvent,
  type ScanPage,
  type ScanPdfPage,
  type ScanPdfResult,
  type ScanPipeline,
  type ScanStore,
} from "./scan-store.ts";

/**
 * The store's job is bookkeeping, not pixels: which bytes a render was made
 * from, which result is still allowed to land, and whether the file the user
 * downloads is the document they reviewed. All three are testable with a fake
 * codec — and only with one, because the real answers ("exactly one canonical
 * encode", "the stale render did not commit") are invisible from the outside
 * once a canvas is involved.
 */

// ── a fake codec ─────────────────────────────────────────────────────────────

/** Blob identity is the whole assertion, so every fake blob carries a name. */
const NAMES = new Map<Blob, string>();

function tagged(name: string): Blob {
  const blob = new Blob([name]);
  NAMES.set(blob, name);
  return blob;
}

function nameOf(blob: Blob | null): string {
  if (blob === null) return "<none>";
  return NAMES.get(blob) ?? "<untagged>";
}

interface PendingRender {
  request: RenderRequest;
  resolve: (page: RenderedPage) => void;
  reject: (error: unknown) => void;
}

class FakeCodec {
  readonly counts = { canonical: 0, final: 0, thumb: 0 };
  /** Every render the store asked for, in order. */
  readonly requests: RenderRequest[] = [];
  readonly assembled: ScanPdfPage[][] = [];
  /** Every `/Title` the store asked for, in order. */
  readonly titles: (string | null)[] = [];
  /** When true, renders wait for {@link flush} instead of resolving. */
  manual = false;
  /** Renders whose canonical matches this name reject. */
  failFor: string | null = null;
  /** Simulates the illumination pass giving up: the finish degrades. */
  degradeFinish = false;
  /**
   * Simulates the curved geometry declining, with the engine's own word for it.
   * Null means a page that asked for it gets it.
   */
  dewarpFallback: DewarpStageReason | null = null;
  /**
   * What the text deskew plans on a page that asks (undefined: this fake
   * pipeline has no deskew step at all). Stands in for `planStraighten`: a
   * request that already carries a known deskew gets that one back, never a
   * fresh plan — the pipeline's own rule (`dewarpMemoFor`).
   */
  deskew: AppliedDeskew | null | undefined = undefined;
  /** How many times the fake planned a deskew afresh. */
  deskewPlans = 0;
  /**
   * A fresh plan of "no rotation" found the print level and the page flat
   * (`RenderedPage.alreadyStraight`) — reported, like the real stage, only by
   * the run that measured it and only when the engine then declined.
   */
  alreadyStraight = false;
  /** How many times the engine was actually asked. */
  engineRuns = 0;
  assembleFails = false;
  /** Set to gate `assemble` on an external promise. */
  assembleGate: Promise<void> | null = null;

  private pending: PendingRender[] = [];

  /** The one encode of the frame — what a capture screen would have done. */
  encodeCanonical(name: string): Blob {
    this.counts.canonical += 1;
    return tagged(name);
  }

  private produce(request: RenderRequest): RenderedPage {
    const finish = this.degradeFinish ? "original" : request.finish;
    const source = nameOf(request.canonical);
    const ask = request.dewarp ?? null;
    const asked = ask !== null;
    // The engine is not asked when the request carries a map or a final
    // decline. (A carried map is still answered with `dewarpFallback`, as
    // this fake always has: it stands for the resample failing.)
    const known = ask?.replay ?? null;
    const declined = ask?.declined ?? null;
    if (asked && known === null && declined === null) this.engineRuns += 1;
    const fallback = declined ?? this.dewarpFallback;
    let deskew: AppliedDeskew | null | undefined;
    let measured = false;
    // Planned on every answer but a cancel — on an accepted page too, where
    // it is the record of a tilt the engine levelled.
    if (asked && fallback !== "cancelled") {
      if (ask.deskew !== undefined) deskew = ask.deskew;
      else if (this.deskew !== undefined) {
        this.deskewPlans += 1;
        deskew = this.deskew;
        measured = true;
      }
    }
    const alreadyStraight =
      measured && deskew === null && fallback !== "cancelled" && this.alreadyStraight;
    const dewarped = asked && fallback === null;
    const geometry = request.corners === null ? "flat" : dewarped ? "curved" : "warped";
    const stamp = `${source}/${finish}/${request.rotation}/${geometry}`;
    this.counts.final += 1;
    this.counts.thumb += 1;
    return {
      final: tagged(`final(${stamp})`),
      thumb: tagged(`thumb(${stamp})`),
      width: 1240,
      height: 1754,
      warpedWidth: 1240,
      warpedHeight: 1754,
      finish,
      warped: request.corners !== null,
      dewarped,
      ...(asked && fallback !== null ? { dewarpFallbackReason: fallback } : {}),
      ...(deskew === undefined ? {} : { deskew }),
      ...(alreadyStraight ? { alreadyStraight: true as const } : {}),
      // A stand-in accepted map — only its identity matters to the store,
      // which treats it as opaque (`page-processing.test.ts`'s own `ACCEPTED`
      // fixture does the same). Present whenever the request asked and the
      // engine did not decline, exactly like the real pipeline's contract.
      ...(dewarped ? { dewarpReplay: { stamp } as never } : {}),
      rotation: request.rotation,
    };
  }

  /**
   * Rejects the oldest waiting pixel pass — how a replaced render unwinds.
   *
   * The rejection goes in where the real geometry stage throws, *below*
   * {@link renderWithFallback} (see {@link FakeCodec.pipeline}), so what the
   * store receives is whatever the real ladder decides to hand on. That is the
   * whole point: a `RenderAbandonedError` only stays recognisable to the store
   * because the ladder rethrows it unwrapped instead of labelling it a failed
   * page.
   */
  abandon(error: unknown): void {
    const job = this.pending.shift();
    assert.ok(job !== undefined, "a render was waiting");
    job.reject(error);
  }

  /** Answers the oldest waiting render. */
  flush(): void {
    const job = this.pending.shift();
    assert.ok(job !== undefined, "a render was waiting");
    job.resolve(this.produce(job.request));
  }

  get waiting(): number {
    return this.pending.length;
  }

  /** One pixel pass: what the real ladder calls, and the only thing faked. */
  private attempt(request: RenderRequest): Promise<RenderedPage> {
    if (this.failFor !== null && nameOf(request.canonical) === this.failFor) {
      return Promise.reject(new Error("render refused"));
    }
    if (!this.manual) return Promise.resolve(this.produce(request));
    return new Promise<RenderedPage>((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
    });
  }

  pipeline(): ScanPipeline {
    return {
      // The real ladder, not a stand-in for it: the store is entitled to see
      // exactly the errors production hands it, and which of them survive
      // `renderWithFallback` unwrapped is a decision this suite has to cover.
      render: (request) => {
        this.requests.push(request);
        return renderWithFallback(request, () => this.attempt(request));
      },
      assemble: async (pages, options): Promise<ScanPdfResult> => {
        if (this.assembleGate !== null) await this.assembleGate;
        if (this.assembleFails) throw new Error("pdf-lib refused");
        this.assembled.push([...pages]);
        this.titles.push(options.title);
        return {
          ok: true,
          blob: tagged("pdf"),
          pageCount: pages.length,
          bytes: 1024,
          rung: 0,
          // The writer embeds each page's final as it is: its own pixels.
          embedded: pages.map((page) => ({ width: 1240, height: 1754, bytes: page.jpeg.size })),
          quality: 0.92,
        };
      },
    };
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const QUAD: NormalizedQuad = {
  topLeft: { x: 0.05, y: 0.05 },
  topRight: { x: 0.95, y: 0.06 },
  bottomRight: { x: 0.94, y: 0.95 },
  bottomLeft: { x: 0.06, y: 0.94 },
};

function reading(reason: GateReading["reason"]): GateReading {
  return {
    sharpness: 0.42,
    textHeightPx: 24,
    score: 10.08,
    pass: reason === "ok",
    reason,
  };
}

/** Lets the store's promise chain run to a standstill. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * The store under test, one instance per {@link begin}.
 *
 * Held here rather than threaded through every helper because the suite's
 * subject is the store's *bookkeeping*, not its wiring — but it is a real
 * instance with a real lifetime: {@link begin} disposes the previous one first,
 * which is also the only way the one-store-at-a-time guard lets a second test
 * run at all.
 */
let current: ScanStore | null = null;

function store(): ScanStore {
  assert.ok(current !== null, "a store was created by begin()");
  return current;
}

function pages(): readonly ScanPage[] {
  return store().getSnapshot().session?.pages ?? [];
}

function onlyPage(): ScanPage {
  const page = pages()[0];
  assert.ok(page !== undefined, "one page in the session");
  return page;
}

function begin(codec: FakeCodec): void {
  // Disposal before creation, exactly as the provider's cleanup runs before its
  // next effect: two live stores are a throw, not a warning.
  current?.dispose();
  current = createScanStore({ pipeline: codec.pipeline() });
  current.start();
}

// ── lineage ──────────────────────────────────────────────────────────────────

test("every edit re-renders from the one canonical, never from the last output", async () => {
  const codec = new FakeCodec();
  begin(codec);
  const canonical = codec.encodeCanonical("frame-1");

  store().addCapture({
    canonical,
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  const pageId = onlyPage().id;

  store().setPageFinish(pageId, "bw");
  await settle();
  store().rotatePage(pageId, "cw");
  await settle();
  // A re-crop moves the corners; it does NOT produce new source bytes.
  store().replaceCapture(pageId, {
    canonical,
    corners: { ...QUAD, topLeft: { x: 0.02, y: 0.02 } },
    gate: reading("ok"),
    path: "adjust",
  });
  await settle();

  assert.equal(codec.counts.canonical, 1, "the frame is encoded exactly once");
  assert.equal(codec.counts.final, 4, "one render per edit, no more");
  assert.equal(codec.requests.length, 4);
  for (const request of codec.requests) {
    assert.equal(
      request.canonical,
      canonical,
      "every render read the same source bytes",
    );
  }

  const page = onlyPage();
  assert.equal(page.canonical, canonical, "the canonical is never rewritten");
  assert.equal(page.rotation, 90);
  assert.equal(page.finish, "bw");
  assert.ok(isRendered(page));
  // The thumbnail is a leaf: nothing was ever rendered or built from one.
  const thumbs = new Set(
    codec.requests.map((request) => nameOf(request.canonical)),
  );
  assert.equal(thumbs.size, 1);
  assert.ok(!nameOf(page.thumb).startsWith("final("));
});

test("undoing a turn costs one render, not one per quarter", async () => {
  const codec = new FakeCodec();
  begin(codec);
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  const pageId = onlyPage().id;
  const afterCapture = codec.counts.final;

  // Three quarter-turns away from where the girar sheet opened.
  store().rotatePage(pageId, "cw");
  await settle();
  store().rotatePage(pageId, "cw");
  await settle();
  store().rotatePage(pageId, "cw");
  await settle();
  assert.equal(onlyPage().rotation, 270);

  store().setPageRotation(pageId, 0);
  await settle();

  const page = onlyPage();
  assert.equal(page.rotation, 0);
  assert.equal(page.rendered?.rotation, 0, "the pixels came back upright too");
  assert.equal(
    codec.counts.final - afterCapture,
    4,
    "three turns and one undo — the undo did not walk back a quarter at a time",
  );

  // A turn the page is already wearing is not a turn: re-rendering it would
  // spend a full pass proving nothing changed.
  store().setPageRotation(pageId, 0);
  await settle();
  assert.equal(codec.counts.final - afterCapture, 4);
});

// ── revisions and staleness ──────────────────────────────────────────────────

test("a render from an older revision never lands", async () => {
  const codec = new FakeCodec();
  begin(codec);
  codec.manual = true;
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  const pageId = onlyPage().id;
  assert.equal(codec.waiting, 1);

  store().rotatePage(pageId, "cw");
  await settle();

  // The revision-1 render finally answers — with pixels for a page that has
  // since been turned.
  codec.flush();
  await settle();
  assert.equal(onlyPage().final, null, "the superseded result was dropped");
  assert.equal(onlyPage().status, "processing");

  codec.flush();
  await settle();
  const page = onlyPage();
  assert.ok(isRendered(page));
  assert.equal(page.rendered?.rotation, 90);
});

test("rapid edits leave one render running and one waiting, and the last one wins", async () => {
  const codec = new FakeCodec();
  begin(codec);
  codec.manual = true;
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  const pageId = onlyPage().id;

  store().setPageFinish(pageId, "bw");
  store().setPageFinish(pageId, "original");
  store().setPageFinish(pageId, "bw");
  await settle();

  assert.equal(codec.requests.length, 1, "the three taps did not queue three passes");
  codec.flush();
  await settle();
  assert.equal(codec.requests.length, 2, "exactly one catch-up render");
  assert.equal(codec.requests[1]?.finish, "bw", "it rendered the pill they settled on");
  codec.flush();
  await settle();
  assert.equal(effectiveFinish(onlyPage()), "bw");
});

test("a gate reading survives a turn and dies with the bytes it measured", async () => {
  const codec = new FakeCodec();
  begin(codec);
  const canonical = codec.encodeCanonical("frame-1");
  store().addCapture({
    canonical,
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  const pageId = onlyPage().id;

  store().rotatePage(pageId, "cw");
  await settle();
  assert.equal(pageGate(onlyPage())?.reason, "ok", "a turn does not unmeasure a page");

  const staleRevision = onlyPage().revision;
  store().replaceCapture(pageId, {
    canonical: codec.encodeCanonical("frame-2"),
    corners: QUAD,
    gate: null,
    path: "retake",
  });
  await settle();
  assert.equal(pageGate(onlyPage()), null, "the retake left the page unmeasured");

  store().setGate(pageId, staleRevision, reading("ok"));
  assert.equal(pageGate(onlyPage()), null, "a reading from the old bytes is refused");

  store().setGate(pageId, onlyPage().revision, reading("blurry"));
  assert.equal(pageGate(onlyPage())?.reason, "blurry");
});

// ── the export transaction ───────────────────────────────────────────────────

async function twentyPages(codec: FakeCodec): Promise<readonly string[]> {
  begin(codec);
  for (let index = 0; index < 20; index += 1) {
    store().addCapture({
      canonical: codec.encodeCanonical(`frame-${index + 1}`),
      corners: QUAD,
      gate: reading("ok"),
      path: "shutter",
    });
  }
  await settle();
  return pages().map((page) => page.id);
}

test("a whole document is embedded in order, as the very bytes that were reviewed", async () => {
  const codec = new FakeCodec();
  await twentyPages(codec);

  await store().buildPdf();
  const build = store().getSnapshot().build;
  assert.equal(build.phase, "done");
  assert.equal(build.pageCount, 20);

  const embedded = codec.assembled[0];
  assert.ok(embedded !== undefined);
  assert.equal(embedded.length, 20);
  embedded.forEach((input, index) => {
    const page = pages()[index];
    assert.equal(input.jpeg, page?.final, `page ${index + 1} embeds its own final`);
  });
});

for (const failing of [1, 10, 20]) {
  test(`a page that cannot be rendered (page ${failing}) blocks the whole file`, async () => {
    const codec = new FakeCodec();
    codec.failFor = `frame-${failing}`;
    const ids = await twentyPages(codec);

    assert.equal(pages()[failing - 1]?.status, "failed");
    await store().buildPdf();
    const build = store().getSnapshot().build;
    assert.equal(build.phase, "failed");
    assert.equal(build.error, "pages_failed");
    assert.equal(build.blob, null);
    assert.equal(codec.assembled.length, 0, "nothing was ever assembled");
    assert.equal(pages().length, 20, "the pages are exactly as they were");

    // Fixing it and trying again works — the failure was not terminal.
    codec.failFor = null;
    store().retryPage(ids[failing - 1] ?? "");
    await settle();
    store().resetBuild();
    await store().buildPdf();
    assert.equal(store().getSnapshot().build.phase, "done");
    assert.equal(store().getSnapshot().build.pageCount, 20);
  });
}

test("a writer that gives up leaves no download and no damage", async () => {
  const codec = new FakeCodec();
  await twentyPages(codec);
  codec.assembleFails = true;

  await store().buildPdf();
  const build = store().getSnapshot().build;
  assert.equal(build.phase, "failed");
  assert.equal(build.error, "build_failed");
  assert.equal(build.blob, null);
  assert.equal(pages().length, 20);

  codec.assembleFails = false;
  store().resetBuild();
  await store().buildPdf();
  assert.equal(store().getSnapshot().build.phase, "done");
});

test("editing a page while the file is being written aborts the build", async () => {
  const codec = new FakeCodec();
  const ids = await twentyPages(codec);
  let release = (): void => {};
  codec.assembleGate = new Promise<void>((resolve) => {
    release = () => resolve();
  });

  const building = store().buildPdf();
  await settle();
  store().rotatePage(ids[3] ?? "", "cw");
  release();
  await building;
  await settle();

  const build = store().getSnapshot().build;
  assert.equal(build.phase, "failed");
  assert.equal(build.error, "pages_changed");
  assert.equal(build.blob, null);
  // The edit landed *during* serialization: the writer ran to completion and
  // produced a file, and the checkpoint after that last await is the only thing
  // between it and the download. Without it the user would get a PDF of the
  // page they had just replaced.
  assert.equal(codec.assembled.length, 1, "the PDF was written");
  assert.equal(build.fileName, null, "and never published");
});

// ── effective transforms ─────────────────────────────────────────────────────

test("a correction that did not happen is never claimed", async () => {
  const codec = new FakeCodec();
  codec.degradeFinish = true;
  begin(codec);
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();

  const page = onlyPage();
  assert.equal(page.finish, "clean", "what the user asked for is still on record");
  assert.equal(effectiveFinish(page), "original", "what they got is what is shown");

  await store().buildPdf();
  const embedded = codec.assembled[0]?.[0];
  assert.ok(embedded !== undefined);
  assert.equal(embedded.transform.finish, "original");

  const subject = honestySubject([embedded.transform]);
  assert.ok(
    subject.includes("none"),
    `the document describes what it got: ${subject}`,
  );
  assert.ok(!subject.includes("brighten"));
});

const SUBJECT_TRANSFORMS: PageTransform[] = [
  { finish: "clean", rotation: 0, dewarped: false },
  { finish: "clean", rotation: 0, dewarped: false },
  { finish: "clean", rotation: 90, dewarped: false },
  { finish: "bw", rotation: 0, dewarped: false },
];

test("the subject line collapses runs and keeps every turn", () => {
  assert.equal(
    honestySubject(SUBJECT_TRANSFORMS),
    "Photographed copy. Transforms: 1-2 brighten; 3 brighten, rotated 90deg; 4 black-and-white.",
  );
});

test("the subject line carries no date, in any locale", () => {
  // It used to say which day the file was made, in two date orders, because a
  // bare 08/16 against 16/08 is ambiguous. The fix is not a better date format:
  // it is that a health document being forwarded onwards should not carry a
  // timestamp of the moment its owner photographed it at all.
  for (const subject of [honestySubject([]), honestySubject(SUBJECT_TRANSFORMS)]) {
    assert.ok(!/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(subject), subject);
    assert.ok(!/20\d\d/.test(subject), subject);
  }
});

test("the diagnostics hear every render's sizes and every page the PDF embeds", async () => {
  const codec = new FakeCodec();
  const heard: QualityEvent[] = [];
  current?.dispose();
  current = createScanStore({ pipeline: codec.pipeline(), onQuality: (event) => heard.push(event) });
  current.start();
  const canonical = codec.encodeCanonical("frame-1");
  store().addCapture({ canonical, corners: QUAD, gate: reading("ok"), path: "shutter" });
  await settle();
  const pageId = onlyPage().id;
  store().rotatePage(pageId, "cw");
  await settle();
  // Every edit is a fresh render from the canonical, reported with its sizes.
  const renders = heard.filter((event) => event.kind === "render");
  assert.equal(renders.length, 2);
  for (const event of renders) {
    assert.equal(event.page, 1);
    assert.deepEqual(event.warped, { width: 1240, height: 1754 });
    assert.equal(event.final.width, 1240);
    assert.equal(event.final.quality, 0.92);
    assert.ok(event.final.bytes > 0);
  }
  for (const request of codec.requests) assert.equal(request.canonical, canonical, "rendered from the canonical");

  await store().buildPdf();
  await settle();
  const embeds = heard.filter((event) => event.kind === "embed");
  assert.deepEqual(
    embeds.map((event) => (event.kind === "embed" ? [event.page, event.pages, event.width, event.height, event.rung, event.resampled] : null)),
    [[1, 1, 1240, 1754, 0, false]],
  );
});

test("a throwing quality listener cannot break a render", async () => {
  const codec = new FakeCodec();
  current?.dispose();
  current = createScanStore({
    pipeline: codec.pipeline(),
    onQuality: () => {
      throw new Error("host bug");
    },
  });
  current.start();
  store().addCapture({ canonical: codec.encodeCanonical("frame-1"), corners: QUAD, gate: reading("ok"), path: "shutter" });
  await settle();
  assert.equal(onlyPage().status, "ready");
});

// ── the curved-page correction ───────────────────────────────────────────────
//
// The whole feature is a requested-vs-effective pair: a page asks for the
// curved geometry and either gets it or does not, and the app must never let
// the two be confused — not on screen, and above all not in the file.

async function onePage(codec: FakeCodec): Promise<string> {
  begin(codec);
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  return onlyPage().id;
}

test("asking for the correction re-renders the page from its canonical", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);
  const before = onlyPage().revision;

  store().setPageDewarp(pageId, true);
  await settle();

  const page = onlyPage();
  assert.equal(page.dewarpRequested, true);
  assert.equal(page.revision, before + 1, "a new geometry is a new revision");
  assert.equal(codec.requests.length, 2, "exactly one extra render");
  assert.equal(
    codec.requests[1]?.canonical,
    page.canonical,
    "and it read the same source bytes as every other edit",
  );
  assert.equal(codec.requests[1]?.dewarp?.sourceId, pageId);
  assert.equal(codec.requests[1]?.dewarp?.generation, page.revision);
  assert.equal(page.rendered?.dewarped, true);
  assert.equal(dewarpOutcome(page), null);

  // Asking for what is already true is not an edit.
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(codec.requests.length, 2);
});

test("a turn keeps the request and re-runs the correction", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();

  store().rotatePage(pageId, "cw");
  await settle();

  const page = onlyPage();
  assert.equal(page.dewarpRequested, true, "the choice survives a turn");
  assert.equal(page.rendered?.rotation, 90);
  assert.equal(page.rendered?.dewarped, true);
  // The accepted cost of having no grid cache: an edit re-runs the inference.
  assert.equal(codec.requests[2]?.dewarp?.generation, page.revision);
});

test("a correction that fell back keeps the page and hands the switch back", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "semantic-regression";
  const pageId = await onePage(codec);

  store().setPageDewarp(pageId, true);
  await settle();

  const page = onlyPage();
  assert.equal(page.status, "ready", "a fallback never costs the page");
  assert.ok(isRendered(page));
  assert.equal(page.rendered?.warped, true, "the crop the user chose survived");
  assert.equal(page.rendered?.dewarped, false, "and it says what it is");
  assert.equal(page.rendered?.dewarpFallbackReason, "semantic-regression");
  // The toggle reflects the page, not the wish — the outcome record is what
  // the page view reads its sentence from.
  assert.equal(page.dewarpRequested, false, "the switch reflects the outcome");
  assert.equal(dewarpOutcome(page), "declined", "and the view says which one");
});

test("a verdict that is final for these pixels is not re-run on a re-toggle", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "guard-jacobian";
  const pageId = await onePage(codec);

  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(dewarpOutcome(onlyPage()), "page");
  assert.equal(codec.requests.length, 2);

  // The answer is deterministic for these pixels; asking again would spend
  // twelve seconds to hear it repeated.
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(codec.requests.length, 2, "no render was spent on a known answer");
  assert.equal(onlyPage().dewarpRequested, false);

  // An edit makes new pixels, and new pixels reopen the question.
  store().rotatePage(pageId, "cw");
  await settle();
  assert.equal(dewarpOutcome(onlyPage()), null, "the verdict expired with the edit");
});

// ── the on/off toggle and its replay cache ───────────────────────────────────
//
// Curvatura is a true switch, and the switch is handed back on a fallback:
// off gives back the flat render, and on again re-applies from the
// map the first run already produced — no fresh twelve-second inference for
// pixels the store has already seen accepted.

test("switching the correction off after it lands, then on again, reuses the accepted map", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);

  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(onlyPage().rendered?.dewarped, true);

  store().setPageDewarp(pageId, false);
  await settle();
  const flat = onlyPage();
  assert.equal(flat.rendered?.dewarped, false, "off gives back the flat render");
  assert.equal(
    flat.rendered?.dewarpFallbackReason,
    undefined,
    "a deliberate off is not a failure",
  );
  assert.equal(dewarpOutcome(flat), null, "nothing to report — the user just turned it off");

  store().setPageDewarp(pageId, true);
  await settle();
  const again = onlyPage();
  assert.equal(again.rendered?.dewarped, true, "on again re-applies the correction");
  assert.deepEqual(
    codec.requests.at(-1)?.dewarp?.replay,
    { stamp: "frame-1/clean/0/curved" },
    "the map the first run produced is handed back rather than asked for fresh",
  );
});

test("a retake invalidates the stored map — new pixels ask fresh", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);

  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(onlyPage().rendered?.dewarped, true);

  store().replaceCapture(pageId, {
    canonical: codec.encodeCanonical("frame-2"),
    corners: QUAD,
    gate: reading("ok"),
    path: "retake",
  });
  await settle();

  assert.equal(onlyPage().rendered?.dewarped, true, "the new photo still gets the correction");
  assert.equal(
    codec.requests.at(-1)?.dewarp?.replay,
    undefined,
    "different pixels — the old map must not be resampled onto them",
  );
});

test("the one engine's download is small enough to need no consent", () => {
  // The consent sheet existed to disclose the ~19 MB ONNX
  // model. The wasm engine that replaced it is ~130 KB gzipped, and gating
  // that behind the same paragraph would be theatre rather than disclosure.
  assert.equal(dewarpConsentRequired("classical"), false);
});

test("the classical engine's own fallback reasons land in the deterministic 'page' bucket", async () => {
  // These four are new rungs the classical producer adds,
  // not a replacement for any existing guard — they bucket exactly like
  // guard-jacobian above, same family, same sentence.
  for (const reason of [
    "classical-non-convergent",
    "classical-insufficient-features",
    "classical-degenerate-bounds",
    "classical-aspect-outlier",
  ] as const) {
    const codec = new FakeCodec();
    codec.dewarpFallback = reason;
    const pageId = await onePage(codec);
    store().setPageDewarp(pageId, true);
    await settle();
    assert.equal(dewarpOutcome(onlyPage()), "page", reason);
  }
});

test("a retryable failure may be asked again", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "timeout";
  const pageId = await onePage(codec);

  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(dewarpOutcome(onlyPage()), "transient");
  assert.equal(onlyPage().dewarpRequested, false);

  // This one is worth a second attempt — the failure was the moment's, not
  // the page's — and this time the engine manages it.
  codec.dewarpFallback = null;
  store().setPageDewarp(pageId, true);
  await settle();
  const page = onlyPage();
  assert.equal(page.rendered?.dewarped, true);
  assert.equal(dewarpOutcome(page), null);
});

test("a cancelled correction clears the request without a second render", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "cancelled";
  const pageId = await onePage(codec);

  store().setPageDewarp(pageId, true);
  await settle();

  const page = onlyPage();
  assert.equal(page.dewarpRequested, false, "stopping means the page is not asking");
  assert.equal(page.rendered?.dewarped, false);
  assert.equal(dewarpOutcome(page), null, "a cancel is not an outcome to report");
  assert.equal(codec.requests.length, 2, "and it cost no extra pass to get here");
});

test("an edit while the correction runs stops it instead of letting it finish", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);
  codec.manual = true;
  store().setPageDewarp(pageId, true);
  await settle();

  const running = codec.requests[1]?.dewarp;
  assert.ok(running !== undefined && running !== null);
  assert.equal(running.signal?.aborted, false, "the correction is running");

  // A turn invalidates the pixels the inference is working towards.
  store().rotatePage(pageId, "cw");
  assert.equal(running.signal?.aborted, true, "the run was told to stop");
  assert.equal(
    running.signal?.reason,
    "superseded",
    "and told that finishing flat would be work for nobody",
  );

  // Unwinding costs the page nothing: the render that replaced it answers.
  codec.abandon(new RenderAbandonedError());
  await settle();
  assert.equal(onlyPage().status, "processing");
  assert.equal(onlyPage().error, null);
  codec.flush();
  await settle();
  const page = onlyPage();
  assert.equal(page.status, "ready");
  assert.equal(page.rendered?.rotation, 90);
});

test("a pass that reports itself abandoned never marks the page broken", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);
  codec.manual = true;
  store().setPageDewarp(pageId, true);
  await settle();
  const revision = onlyPage().revision;

  // Nothing replaced this render, so the revision check cannot save the page:
  // the only thing between the user and a page marked broken is the error
  // reaching the store as itself, all the way through the ladder.
  codec.abandon(new RenderAbandonedError());
  await settle();

  assert.equal(onlyPage().revision, revision, "no edit stood in for the guard");
  assert.equal(onlyPage().status, "processing");
  assert.equal(onlyPage().error, null, "an abandoned pass is nobody's failure");
});

test("turning the correction off, deleting the page: same stop, same reason", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);
  codec.manual = true;

  store().setPageDewarp(pageId, true);
  await settle();
  const first = codec.requests[1]?.dewarp;
  assert.ok(first !== undefined && first !== null);
  store().setPageDewarp(pageId, false);
  assert.equal(first.signal?.reason, "superseded");
  codec.abandon(new RenderAbandonedError());
  await settle();
  codec.flush();
  await settle();
  assert.equal(onlyPage().dewarpRequested, false);

  store().setPageDewarp(pageId, true);
  await settle();
  const second = codec.requests.at(-1)?.dewarp;
  assert.ok(second !== undefined && second !== null);
  store().removePage(pageId);
  assert.equal(second.signal?.reason, "superseded", "a deleted page stops too");
  codec.abandon(new RenderAbandonedError());
  await settle();
  assert.equal(pages().length, 0);
});

test("Cancelar stops the run but lets the page settle on what it has", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);
  codec.manual = true;
  store().setPageDewarp(pageId, true);
  await settle();

  const running = codec.requests[1]?.dewarp;
  assert.ok(running !== undefined && running !== null);
  store().cancelDewarp(pageId);
  // Not "superseded": nothing has replaced this render, so it finishes flat at
  // this revision rather than leaving the page with nothing to show.
  assert.equal(running.signal?.reason, "cancelled");
  assert.equal(onlyPage().revision, 2, "and no new revision was created");

  codec.dewarpFallback = "cancelled";
  codec.flush();
  await settle();
  const page = onlyPage();
  assert.equal(page.status, "ready");
  assert.equal(page.dewarpRequested, false);
  assert.equal(codec.requests.length, 2, "one pass, not two");
});

test("the file records the correction it made, never the one it was asked for", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();

  await store().buildPdf();
  const embedded = codec.assembled[0]?.[0];
  assert.ok(embedded !== undefined);
  assert.equal(embedded.transform.dewarped, true);
  const subject = honestySubject([embedded.transform]);
  assert.ok(
    subject.includes("brighten, dewarped"),
    `the document describes what it got: ${subject}`,
  );

  // The same page, with the engine declining. The switch is handed back and
  // the line must lose the claim entirely.
  codec.dewarpFallback = "guard-jacobian";
  store().rotatePage(pageId, "cw");
  await settle();
  store().resetBuild();
  await store().buildPdf();
  const second = codec.assembled[1]?.[0];
  assert.ok(second !== undefined);
  assert.equal(onlyPage().dewarpRequested, false);
  assert.equal(second.transform.dewarped, false);
  assert.ok(!honestySubject([second.transform]).includes("dewarped"));
});

test("the subject line is the same whatever language the app is in", () => {
  const corrected: PageTransform[] = [
    { finish: "clean", rotation: 0, dewarped: true },
    { finish: "clean", rotation: 90, dewarped: true },
  ];

  // One string, in one language, for every reader.
  //
  // The line used to be translated and to carry the date the file was made.
  // Both are gone on purpose: a PDF that says "Cópia fotografada" and
  // "16/08/2026" tells whoever opens it which locale the person was using and
  // when, written into a health document that will be forwarded on. The
  // provenance worth recording is what was done to the pixels, and nothing
  // about the person who did it.
  const subject = honestySubject(corrected);
  assert.equal(
    subject,
    "Photographed copy. Transforms: 1 brighten, dewarped; 2 brighten, dewarped, rotated 90deg.",
  );
  assert.ok(!/\d{2}\/\d{2}\/\d{4}/.test(subject), "no date may appear in the subject");
  assert.ok(!subject.includes("Cópia"), "the subject does not follow the reader's language");
});

// ── the fallback ladder's failure domains ────────────────────────────────────
//
// A render pass can fail in five places and only two of them may quietly change
// what the user gets. The rest must fail the page: an un-cropped export of a
// medical document shows whatever else was on the desk, and "the encoder
// hiccuped" is not the user's consent to that.

const LADDER_REQUEST: RenderRequest = {
  canonical: tagged("frame-1"),
  corners: QUAD,
  rotation: 0,
  finish: "clean",
};

interface Attempted {
  finish: PageFinish;
  identity: boolean;
}

function renderedFor(finish: PageFinish, identity: boolean): RenderedPage {
  return {
    final: tagged(`final(${finish}/${identity ? "flat" : "warped"})`),
    thumb: null,
    width: 1240,
    height: 1754,
    warpedWidth: 1240,
    warpedHeight: 1754,
    finish,
    warped: !identity,
    dewarped: false,
    rotation: 0,
  };
}

/**
 * A pixel pass that fails at a named stage on the given attempts (1-based) and
 * otherwise succeeds, recording exactly what the ladder asked it for.
 */
function pass(failures: Partial<Record<number, RenderStage>>): {
  attempts: Attempted[];
  run: (finish: PageFinish, identity: boolean) => Promise<RenderedPage>;
} {
  const attempts: Attempted[] = [];
  return {
    attempts,
    run: (finish, identity) => {
      attempts.push({ finish, identity });
      const stage = failures[attempts.length];
      if (stage !== undefined) {
        return Promise.reject(
          new RenderStageError(stage, new ImagePrepError("prep")),
        );
      }
      return Promise.resolve(renderedFor(finish, identity));
    },
  };
}

test("a finish failure costs the enhancement and nothing else", async () => {
  const { attempts, run } = pass({ 1: "finish" });
  const rendered = await renderWithFallback(LADDER_REQUEST, run);

  assert.deepEqual(attempts, [
    { finish: "clean", identity: false },
    { finish: "original", identity: false },
  ]);
  assert.equal(rendered.finish, "original", "and says so");
  assert.equal(rendered.warped, true, "the crop the user chose survived");
});

test("a warp failure costs the crop, says so, and keeps the finish", async () => {
  const { attempts, run } = pass({ 1: "warp" });
  const rendered = await renderWithFallback(LADDER_REQUEST, run);

  assert.deepEqual(attempts, [
    { finish: "clean", identity: false },
    { finish: "clean", identity: true },
  ]);
  assert.equal(rendered.warped, false, "the screens can offer 'ajustar cantos'");
  assert.equal(rendered.finish, "clean");
});

test("a warp failure and then a finish failure spend one concession each", async () => {
  const { attempts, run } = pass({ 1: "warp", 2: "finish" });
  const rendered = await renderWithFallback(LADDER_REQUEST, run);

  assert.deepEqual(attempts, [
    { finish: "clean", identity: false },
    { finish: "clean", identity: true },
    { finish: "original", identity: true },
  ]);
  assert.equal(rendered.warped, false);
  assert.equal(rendered.finish, "original");
});

for (const stage of ["encode", "decode", "rotate"] as const) {
  test(`a failure in the ${stage} stage fails the page, never its content`, async () => {
    const { attempts, run } = pass({ 1: stage });
    await assert.rejects(
      renderWithFallback(LADDER_REQUEST, run),
      (error: unknown) => error instanceof ImagePrepError,
    );
    assert.deepEqual(
      attempts,
      [{ finish: "clean", identity: false }],
      "no second pass — the crop and the finish were never in question",
    );
  });
}

test("a superseded pass comes back as itself, never as a failed page", async () => {
  const attempts: Attempted[] = [];
  await assert.rejects(
    renderWithFallback(LADDER_REQUEST, (finish, identity) => {
      attempts.push({ finish, identity });
      return Promise.reject(new RenderAbandonedError());
    }),
    // Unwrapped, because the store recognises it by type: turned into an
    // `ImagePrepError` here it would be reported to the user as a broken page.
    (error: unknown) => error instanceof RenderAbandonedError,
  );
  assert.deepEqual(
    attempts,
    [{ finish: "clean", identity: false }],
    "and nothing was retried — no stage failed",
  );
});

test("a finish failure followed by an encode failure does not discard the crop", async () => {
  const { attempts, run } = pass({ 1: "finish", 2: "encode" });
  await assert.rejects(
    renderWithFallback(LADDER_REQUEST, run),
    (error: unknown) => error instanceof ImagePrepError,
  );
  assert.deepEqual(attempts, [
    { finish: "clean", identity: false },
    { finish: "original", identity: false },
  ]);
});

test("a page whose render fails is failed, and blocks the file", async () => {
  const codec = new FakeCodec();
  codec.failFor = "frame-1";
  begin(codec);
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();

  const page = onlyPage();
  assert.equal(page.status, "failed");
  assert.equal(page.final, null, "nothing was published for it");
  await store().buildPdf();
  assert.equal(store().getSnapshot().build.error, "pages_failed");
  assert.equal(codec.assembled.length, 0);
});

// ── the file's name ──────────────────────────────────────────────────────────

test("the finished file is stamped with the moment the scan began", async () => {
  const codec = new FakeCodec();
  begin(codec);
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  store().setDocumentName("exame");

  const session = store().getSnapshot().session;
  assert.ok(session !== null);
  const expected = pdfFileName("exame", new Date(session.createdAt));

  await store().buildPdf();
  await settle();

  const build = store().getSnapshot().build;
  assert.equal(build.phase, "done");
  // Not `new Date()`: the user files this next to the photos they took at the
  // clinic, and step 3 already showed them this exact string.
  assert.equal(build.fileName, expected);
  assert.match(build.fileName ?? "", /^\d{8}-\d{4}_exame\.pdf$/);
});

test("the PDF's title is the file name, never the typed text", async () => {
  const codec = new FakeCodec();
  begin(codec);
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  // Free text, exactly as somebody might type it behind "outro".
  store().setDocumentName("Exame de sangue, anotação");

  await store().buildPdf();
  await settle();

  const fileName = store().getSnapshot().build.fileName ?? "";
  assert.match(fileName, /^\d{8}-\d{4}_exame-de-sangue-anotacao\.pdf$/);
  assert.deepEqual(codec.titles, [fileName.replace(/\.pdf$/, "")]);
});

test("a host's file name is used verbatim, and the typed name is ignored", async () => {
  const codec = new FakeCodec();
  current?.dispose();
  current = createScanStore({ pipeline: codec.pipeline(), fileName: "Envio 12.PDF" });
  current.start();
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  store().setDocumentName("texto digitado");

  await store().buildPdf();
  await settle();

  assert.equal(store().getSnapshot().build.fileName, "Envio 12.PDF");
  assert.deepEqual(codec.titles, ["Envio 12"]);
});

test("an unnamed document is still named, in the reader's language", async () => {
  const codec = new FakeCodec();
  begin(codec);
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();

  await store().buildPdf();
  await settle();

  assert.match(
    store().getSnapshot().build.fileName ?? "",
    /^\d{8}-\d{4}_documento\.pdf$/,
  );
});

// ── reordering ───────────────────────────────────────────────────────────────

/** Three pages, in order, so a move has somewhere to move to and from. */
async function threePages(codec: FakeCodec): Promise<readonly string[]> {
  begin(codec);
  for (const name of ["frame-1", "frame-2", "frame-3"]) {
    store().addCapture({
      canonical: codec.encodeCanonical(name),
      corners: QUAD,
      gate: reading("ok"),
      path: "desktop",
    });
    await settle();
  }
  return pages().map((page) => page.id);
}

function order(): string[] {
  return [...pages()]
    .sort((left, right) => left.order - right.order)
    .map((page) => nameOf(page.canonical));
}

test("movePageTo puts a page where the hand dropped it, in one move", async () => {
  const codec = new FakeCodec();
  const ids = await threePages(codec);
  assert.deepEqual(order(), ["frame-1", "frame-2", "frame-3"]);

  // The whole reason this exists beside `movePage`: a desktop drag from the
  // end of the rail to the front is one drop, not two swaps.
  store().movePageTo(ids[2], 0);
  assert.deepEqual(order(), ["frame-3", "frame-1", "frame-2"]);
});

test("the order the store keeps is contiguous and canonical after a move", async () => {
  const codec = new FakeCodec();
  const ids = await threePages(codec);
  store().movePageTo(ids[0], 2);

  // `order` is what the PDF is assembled by, so it must renumber rather than
  // leave the gaps a splice would.
  assert.deepEqual(
    pages().map((page) => page.order),
    [0, 1, 2],
  );
  assert.deepEqual(order(), ["frame-2", "frame-3", "frame-1"]);
});

test("a drop past the end of the list is a drop at the end", async () => {
  const codec = new FakeCodec();
  const ids = await threePages(codec);
  // Clamped rather than refused: the pointer left the rail below the last row,
  // and "nothing happened" is not what that gesture meant.
  store().movePageTo(ids[0], 99);
  assert.deepEqual(order(), ["frame-2", "frame-3", "frame-1"]);

  store().movePageTo(ids[0], -4);
  assert.deepEqual(order(), ["frame-1", "frame-2", "frame-3"]);
});

test("moving a page onto itself, or one that is gone, changes nothing", async () => {
  const codec = new FakeCodec();
  const ids = await threePages(codec);
  const before = order();

  store().movePageTo(ids[1], 1);
  assert.deepEqual(order(), before);

  store().movePageTo("a-page-that-was-deleted", 0);
  assert.deepEqual(order(), before);
});

// ── lifetime ─────────────────────────────────────────────────────────────────
//
// The store used to be a module singleton, which meant an unmount left the next
// mount holding the previous scan's pages. These are the tests that say it
// cannot any more — the privacy claim is a lifetime claim before it is a
// storage one.

test("two stores do not share a scan", async () => {
  const first = new FakeCodec();
  begin(first);
  store().addCapture({
    canonical: first.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  assert.equal(pages().length, 1);

  const second = new FakeCodec();
  begin(second);
  assert.equal(pages().length, 0, "the new store starts from nothing");
  assert.equal(second.counts.final, 0, "and inherited no work in flight");
});

test("a disposed store is inert, not broken", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);
  const dead = store();
  const before = codec.requests.length;

  dead.dispose();
  assert.equal(dead.disposed, true);

  // Every operation still answers; none of them does anything. An unmount races
  // whatever the screens were in the middle of, and throwing at them would turn
  // an ordinary teardown into an error the host has to catch.
  dead.addCapture({
    canonical: codec.encodeCanonical("frame-2"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  dead.rotatePage(pageId, "cw");
  dead.setPageFinish(pageId, "bw");
  dead.removePage(pageId);
  dead.resetBuild();
  await dead.buildPdf();
  await settle();

  assert.equal(dead.getSnapshot().session, null, "the pages were let go");
  assert.equal(dead.getSnapshot().build.phase, "idle");
  assert.equal(codec.requests.length, before, "and no pixel work was started");
  assert.equal(codec.assembled.length, 0);

  // Disposing twice is an ordinary thing for a cleanup to do.
  dead.dispose();
  current = null;
});

test("disposing drops the subscribers rather than notifying a dead store", async () => {
  const codec = new FakeCodec();
  begin(codec);
  let heard = 0;
  const unsubscribe = store().subscribe(() => {
    heard += 1;
  });
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();
  assert.ok(heard > 0, "a live store talks to its subscribers");

  const seen = heard;
  store().dispose();
  // One last notification — the state went empty and a screen still mounted has
  // to hear that — and then silence.
  assert.ok(heard > seen, "the emptying was announced");
  const announced = heard;
  store().start();
  store().clear();
  assert.equal(heard, announced, "nothing after that");

  // The unsubscribe a screen's cleanup calls still works on a dead store.
  unsubscribe();
  current = null;
});

test("a second store while one is alive is refused in development", () => {
  const codec = new FakeCodec();
  begin(codec);
  // 0.x supports one mounted <ScanFlow>: the render worker lane and the dewarp
  // engine's session latches are device-wide, and two flows would fight over
  // them in a way nobody could reproduce from the symptoms.
  assert.throws(
    () => createScanStore({ pipeline: codec.pipeline() }),
    /one mounted <ScanFlow> at a time/,
  );

  // …and the slot is given back, so the next mount is fine.
  store().dispose();
  const next = createScanStore({ pipeline: codec.pipeline() });
  next.dispose();
  current = null;
});

test("the store holds encoded bytes, never a decoded page", async () => {
  // The memory invariant, asserted rather than trusted: twenty decoded
  // 3000 px pages would be ~700 MB, which is the tab dying on a phone.
  const codec = new FakeCodec();
  await twentyPages(codec);
  for (const page of pages()) {
    for (const held of [page.canonical, page.final, page.thumb]) {
      assert.ok(
        held === null || held instanceof Blob,
        "every artifact a page keeps is encoded bytes",
      );
    }
  }
});

// ── "Gerar PDF" from step 2 ─────────────────────────────────────────────────

test("step 2's Gerar PDF names an unnamed document the way step 3 would have", async () => {
  const codec = new FakeCodec();
  await onePage(codec);
  assert.equal(store().getSnapshot().session?.documentName, null);

  await startPdfBuild(store(), { documentName: "exame", hostFileName: null });
  await settle();

  const snapshot = store().getSnapshot();
  assert.equal(snapshot.session?.documentName, "exame");
  assert.equal(snapshot.build.phase, "done");
  assert.match(snapshot.build.fileName ?? "", /^\d{8}-\d{4}_exame\.pdf$/);
});

test("step 2's Gerar PDF keeps a name somebody already chose", async () => {
  const codec = new FakeCodec();
  await onePage(codec);
  store().setDocumentName("receita");

  await startPdfBuild(store(), { documentName: "exame", hostFileName: null });
  await settle();

  const snapshot = store().getSnapshot();
  assert.equal(snapshot.session?.documentName, "receita");
  assert.match(snapshot.build.fileName ?? "", /_receita\.pdf$/);
});

test("step 2's Gerar PDF writes no marking when the host named the file", async () => {
  const codec = new FakeCodec();
  current?.dispose();
  current = createScanStore({ pipeline: codec.pipeline(), fileName: "pedido-123.pdf" });
  current.start();
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });
  await settle();

  await startPdfBuild(store(), { documentName: "exame", hostFileName: "pedido-123.pdf" });
  await settle();

  const snapshot = store().getSnapshot();
  assert.equal(snapshot.session?.documentName, null);
  assert.equal(snapshot.build.phase, "done");
  assert.equal(snapshot.build.fileName, "pedido-123.pdf");
});

test("step 2's Gerar PDF on a page still being prepared fails the build, with a reason", async () => {
  const codec = new FakeCodec();
  codec.manual = true;
  begin(codec);
  store().addCapture({
    canonical: codec.encodeCanonical("frame-1"),
    corners: QUAD,
    gate: reading("ok"),
    path: "shutter",
  });

  await startPdfBuild(store(), { documentName: "exame", hostFileName: null });

  const build = store().getSnapshot().build;
  assert.equal(build.phase, "failed");
  assert.equal(build.error, "pages_processing");
  assert.equal(codec.assembled.length, 0);
});

// ── the text deskew under the tap ────────────────────────────────────────────
//
// The rotation is the page's own answer, independent of the engine: kept on
// the switch whatever the engine says about the curl, the same rotation on
// every edit that leaves pixels and outline alone, and thrown away the moment
// the outline changes.

/** A stand-in rotation: only its identity and its angle matter to the store. */
function deskewOf(deg: number, curl = false): AppliedDeskew {
  return {
    plan: { deg, curl: { evidence: curl } } as never,
    corners: QUAD,
  };
}

test("a page whose tilt was straightened keeps the switch on, whatever the engine said about the curl", async () => {
  for (const reason of ["curl-absent", "semantic-regression", "guard-boundary", "timeout"] as const) {
    const codec = new FakeCodec();
    codec.dewarpFallback = reason;
    codec.deskew = deskewOf(3.5);
    const pageId = await onePage(codec);
    store().setPageDewarp(pageId, true);
    await settle();
    const page = onlyPage();
    assert.equal(page.dewarpRequested, true, `${reason}: the page did get a correction`);
    assert.equal(page.rendered?.deskewDeg, 3.5, reason);
    assert.equal(page.rendered?.dewarped, false, reason);
    // "Mantivemos a original" would deny the rotation; the curl's own outcome
    // is kept for the page view to say.
    assert.equal(dewarpOutcome(page), null, reason);
    assert.equal(curlFallbackReason(page), reason, reason);
  }
});

test("a transient engine failure keeps the rotation, and the next edit gets the same one without re-planning", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "timeout";
  const straightened = deskewOf(4, true);
  codec.deskew = straightened;
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(codec.deskewPlans, 1);
  assert.equal(onlyPage().dewarpRequested, true, "the switch did not go off under a rotated page");

  // An unrelated edit: the rotation must not silently disappear.
  store().setPageFinish(pageId, "original");
  await settle();
  const request = codec.requests.at(-1);
  assert.equal(request?.dewarp?.deskew, straightened, "the planned rotation is handed back");
  assert.equal(request?.dewarp?.declined, undefined, "a transient failure is asked again");
  assert.equal(codec.deskewPlans, 1, "and never re-planned");
  assert.equal(onlyPage().rendered?.deskewDeg, 4);
  assert.equal(codec.engineRuns, 2, "the engine got its retry");
});

test("a final answer with a rotation is kept whole: the next edit neither re-plans nor re-asks the engine", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "curl-absent";
  codec.deskew = deskewOf(-2);
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();
  store().rotatePage(pageId, "cw");
  await settle();
  const request = codec.requests.at(-1);
  assert.equal(request?.dewarp?.declined, "curl-absent");
  assert.equal(codec.engineRuns, 1);
  assert.equal(codec.deskewPlans, 1);
  assert.equal(onlyPage().rendered?.deskewDeg, -2);
});

test("a corner edit throws the rotation away: new corners, new plan", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "curl-absent";
  codec.deskew = deskewOf(3);
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();

  // Same canonical Blob, new corners — exactly what the corner editor does.
  const page = onlyPage();
  store().replaceCapture(pageId, {
    canonical: page.canonical,
    corners: { ...QUAD, topLeft: { x: 0.08, y: 0.04 } },
    gate: reading("ok"),
    path: "adjust",
  });
  await settle();
  const request = codec.requests.at(-1);
  assert.equal(request?.dewarp?.deskew, undefined, "the old outline's rotation is not reused");
  assert.equal(request?.dewarp?.declined, undefined, "nor its verdict");
  assert.equal(codec.deskewPlans, 2);
});

test("a corner edit also retires an accepted map computed on the old corners", async () => {
  const codec = new FakeCodec();
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(onlyPage().rendered?.dewarped, true);
  const page = onlyPage();
  store().replaceCapture(pageId, {
    canonical: page.canonical,
    corners: { ...QUAD, bottomRight: { x: 0.9, y: 0.93 } },
    gate: reading("ok"),
    path: "adjust",
  });
  await settle();
  assert.equal(codec.requests.at(-1)?.dewarp?.replay, undefined, "the map was for other corners");
});

test("switching off restores the confirmed outline with no rotation; on again reuses the rotation", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "curl-absent";
  const straightened = deskewOf(5);
  codec.deskew = straightened;
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();

  store().setPageDewarp(pageId, false);
  await settle();
  const off = onlyPage();
  assert.equal(codec.requests.at(-1)?.dewarp, null, "no tap, no deskew");
  assert.equal(off.rendered?.deskewDeg, undefined);

  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(codec.requests.at(-1)?.dewarp?.deskew, straightened);
  assert.equal(codec.deskewPlans, 1);
  assert.equal(onlyPage().rendered?.deskewDeg, 5);
});

test("a cancel takes the whole tap back: no rotation, switch off", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "cancelled";
  codec.deskew = deskewOf(3);
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();
  const page = onlyPage();
  assert.equal(page.dewarpRequested, false);
  assert.equal(page.rendered?.deskewDeg, undefined);
});

test("a planned 'no rotation' is remembered too, so a retry asks only the engine", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "worker-failed";
  codec.deskew = null;
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();
  // No rotation and a transient failure: the switch is handed back, as before.
  assert.equal(onlyPage().dewarpRequested, false);
  codec.dewarpFallback = null;
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(codec.requests.at(-1)?.dewarp?.deskew, null, "no rotation, known — not re-planned");
  assert.equal(codec.deskewPlans, 1);
  assert.equal(onlyPage().rendered?.dewarped, true);
});

// ── what the tap says it did, and a tap over a final answer ──────────────────
//
// One sentence per outcome of the tap: what it corrected (the tilt, the curl,
// both, the tilt with the curl left as it was), or why it corrected nothing —
// "already level and flat" only when that was measured, a limit of the
// correction otherwise. And a tap over an answer that is final for these
// pixels is answered, not ignored.

test("the tap's outcome names what was corrected, and the support code names what was not", async () => {
  const cases: {
    fallback: DewarpStageReason | null;
    deskew: AppliedDeskew | null | undefined;
    straight?: boolean;
    outcome: string | null;
    code: string | null;
    switchOn: boolean;
  }[] = [
    { fallback: null, deskew: null, outcome: "curl", code: null, switchOn: true },
    // The engine changed a page measured level and flat: no curl to claim.
    { fallback: null, deskew: null, straight: true, outcome: null, code: null, switchOn: true },
    { fallback: null, deskew: deskewOf(3, true), outcome: "both", code: null, switchOn: true },
    { fallback: "curl-absent", deskew: deskewOf(3), outcome: "tilt", code: null, switchOn: true },
    { fallback: "guard-boundary", deskew: deskewOf(3, true), outcome: "tilt-only", code: "#017", switchOn: true },
    { fallback: "timeout", deskew: deskewOf(3, true), outcome: "tilt-only", code: "#042", switchOn: true },
    { fallback: "semantic-regression", deskew: null, straight: true, outcome: "nothing", code: "#001", switchOn: false },
    { fallback: "semantic-insufficient-evidence", deskew: null, straight: true, outcome: "nothing", code: "#002", switchOn: false },
    { fallback: "guard-boundary", deskew: null, straight: true, outcome: "nothing", code: "#017", switchOn: false },
    { fallback: "semantic-regression", deskew: null, outcome: "declined", code: "#001", switchOn: false },
    { fallback: "semantic-insufficient-evidence", deskew: null, outcome: "unverified", code: "#002", switchOn: false },
    { fallback: "guard-boundary", deskew: null, outcome: "page", code: "#017", switchOn: false },
    // The page needed nothing, but the run failed: the retry is still the
    // useful thing to say.
    { fallback: "timeout", deskew: null, straight: true, outcome: "transient", code: "#042", switchOn: false },
    // No deskew step at all (an older pipeline): the engine's word alone.
    { fallback: "semantic-regression", deskew: undefined, outcome: "declined", code: "#001", switchOn: false },
  ];
  for (const c of cases) {
    const label = `${c.fallback} / ${c.deskew === undefined ? "no step" : c.deskew === null ? "level" : "tilted"}${c.straight ? " / flat" : ""}`;
    const codec = new FakeCodec();
    codec.dewarpFallback = c.fallback;
    codec.deskew = c.deskew;
    codec.alreadyStraight = c.straight === true;
    const pageId = await onePage(codec);
    store().setPageDewarp(pageId, true);
    await settle();
    const page = onlyPage();
    assert.equal(page.id, pageId);
    assert.equal(straightenOutcome(page), c.outcome, label);
    assert.equal(straightenOutcomeCode(page), c.code, label);
    assert.equal(page.dewarpRequested, c.switchOn, `${label}: the switch reflects the page`);
  }
});

test("nothing to say before a tap, after the switch is turned off, or after an edit", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "curl-absent";
  codec.deskew = deskewOf(2);
  const pageId = await onePage(codec);
  assert.equal(straightenOutcome(onlyPage()), null, "never asked");
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(straightenOutcome(onlyPage()), "tilt");
  store().setPageDewarp(pageId, false);
  await settle();
  assert.equal(straightenOutcome(onlyPage()), null, "turned off");
  store().setPageDewarp(pageId, true);
  await settle();
  store().setPageFinish(pageId, "original");
  assert.equal(straightenOutcome(onlyPage()), null, "an edit in flight");
  await settle();
  assert.equal(straightenOutcome(onlyPage()), "tilt", "and the re-render says it again");
});

test("a curl corrected under a tilt stays 'both' after the switch goes off and on again", async () => {
  const codec = new FakeCodec();
  codec.deskew = deskewOf(4, true);
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(straightenOutcome(onlyPage()), "both");
  store().setPageDewarp(pageId, false);
  await settle();
  store().setPageDewarp(pageId, true);
  await settle();
  const request = codec.requests.at(-1)?.dewarp;
  assert.ok(request?.replay, "the stored map is resampled");
  assert.equal(request?.deskew, codec.deskew, "and carries the tilt it levelled");
  assert.equal(codec.deskewPlans, 1, "never re-planned");
  assert.equal(straightenOutcome(onlyPage()), "both");
  assert.equal(onlyPage().rendered?.deskewDeg, 4);
});

test("'already level and flat' is kept from the run that measured it through a retry that did not", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "worker-failed";
  codec.deskew = null;
  codec.alreadyStraight = true;
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(straightenOutcome(onlyPage()), "transient");

  // The retry reuses the stored "no rotation" rather than measuring again.
  codec.dewarpFallback = "semantic-regression";
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(codec.deskewPlans, 1);
  assert.equal(codec.requests.at(-1)?.dewarp?.deskew, null);
  assert.equal(straightenOutcome(onlyPage()), "nothing");
  assert.equal(straightenOutcomeCode(onlyPage()), "#001");
});

test("'already level and flat' is not carried onto new corners", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "worker-failed";
  codec.deskew = null;
  codec.alreadyStraight = true;
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();
  // New corners: planned again, and this time nothing says the page is flat.
  codec.alreadyStraight = false;
  codec.dewarpFallback = "semantic-regression";
  const page = onlyPage();
  store().replaceCapture(pageId, {
    canonical: page.canonical,
    corners: { ...QUAD, topLeft: { x: 0.08, y: 0.04 } },
    gate: reading("ok"),
    path: "adjust",
  });
  store().setPageDewarp(pageId, true);
  await settle();
  assert.equal(codec.deskewPlans, 2);
  assert.equal(straightenOutcome(onlyPage()), "declined");
});

test("a tap over a final verdict is answered — with no render — and every tap counts", async () => {
  for (const [fallback, straight, outcome] of [
    ["semantic-regression", false, "declined"],
    ["semantic-regression", true, "nothing"],
    ["guard-boundary", false, "page"],
    ["semantic-insufficient-evidence", false, "unverified"],
  ] as const) {
    const codec = new FakeCodec();
    codec.dewarpFallback = fallback;
    codec.deskew = null;
    codec.alreadyStraight = straight;
    const pageId = await onePage(codec);
    store().setPageDewarp(pageId, true);
    await settle();
    assert.equal(straightenOutcome(onlyPage()), outcome);
    assert.equal(store().getSnapshot().dewarpRetap, null, "nothing to answer yet");
    const renders = codec.requests.length;

    store().setPageDewarp(pageId, true);
    await settle();
    assert.equal(codec.requests.length, renders, `${outcome}: no render spent on a known answer`);
    const first = store().getSnapshot().dewarpRetap;
    assert.deepEqual(
      first,
      { pageId, revision: onlyPage().revision, seq: 1 },
      `${outcome}: but the tap is recorded for the page view to answer`,
    );
    assert.equal(straightenOutcome(onlyPage()), outcome, "and the verdict is still on screen");

    store().setPageDewarp(pageId, true);
    assert.equal(store().getSnapshot().dewarpRetap?.seq, 2, "a second tap is a second answer");
  }
});

test("a re-tap answer belongs to its pixels: an edit retires it, and a retryable outcome runs instead", async () => {
  const codec = new FakeCodec();
  codec.dewarpFallback = "semantic-regression";
  const pageId = await onePage(codec);
  store().setPageDewarp(pageId, true);
  await settle();
  store().setPageDewarp(pageId, true);
  const retap = store().getSnapshot().dewarpRetap;
  assert.equal(retap?.revision, onlyPage().revision);

  store().rotatePage(pageId, "cw");
  await settle();
  assert.notEqual(
    store().getSnapshot().dewarpRetap?.revision,
    onlyPage().revision,
    "the recorded tap is about pixels that are gone",
  );

  // A retryable failure is not refused: the tap runs, and nothing is recorded.
  const other = new FakeCodec();
  other.dewarpFallback = "timeout";
  const otherId = await onePage(other);
  store().setPageDewarp(otherId, true);
  await settle();
  const renders = other.requests.length;
  store().setPageDewarp(otherId, true);
  await settle();
  assert.equal(other.requests.length, renders + 1, "the retry ran");
  assert.equal(store().getSnapshot().dewarpRetap, null);
});
