import type { ScanStore } from "@/lib/scan-store";

/**
 * Start the PDF with step 3's defaults — what "Gerar PDF" on step 2 does.
 *
 * Step 3 used to stand between the page list and the file, and the one thing
 * it settled before the build was the document's name: the marking grid opens
 * on a default ("exame") and writes it into the store. With the build started
 * from step 2 that write happens here, so a file made without ever showing the
 * form is named exactly as the untouched form would have named it — and the
 * form, when a failed build brings it back, shows the name the build used.
 *
 * A name somebody already chose is kept, and a host that named the file gets
 * no marking: there is nothing for one to change. Everything else — a second
 * tap while a build runs, a page that is not ready — is the store's own guard.
 */
export function startPdfBuild(
  store: ScanStore,
  defaults: { documentName: string; hostFileName: string | null },
): Promise<void> {
  const session = store.getSnapshot().session;
  if (defaults.hostFileName === null && session !== null && session.documentName === null) {
    store.setDocumentName(defaults.documentName);
  }
  return store.buildPdf();
}
