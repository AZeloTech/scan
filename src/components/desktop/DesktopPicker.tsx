"use client";

import * as React from "react";

export interface DesktopPickerHandle {
  pickFiles: () => void;
  pickFolder: () => void;
}

/**
 * The two file inputs, mounted once for the whole flow.
 *
 * They live at the top of the tree rather than inside step 1 because step 2's
 * rail offers "Adicionar arquivos" too, and an input that unmounts with its
 * step would take the OS dialog with it. Two of them rather than one, because
 * `webkitdirectory` is a property of the element and not of the click: a single
 * input cannot be a file picker and a folder picker on alternate presses.
 *
 * The value is reset after every change so that picking the same file twice in
 * a row still fires — an input that already holds `exame.jpg` is silent when
 * `exame.jpg` is chosen again, which reads to the user as the app ignoring
 * them.
 */
export const DesktopPicker = React.forwardRef<
  DesktopPickerHandle,
  {
    onFiles: (files: FileList | null) => void;
    /**
     * The file types the dialog offers. Passed in rather than taken from
     * `DESKTOP_ACCEPT` because it depends on the host's `intake` — a picker
     * that lists PDFs the flow will refuse is worse than one that never did.
     */
    accept: string;
    label: string;
  }
>(function DesktopPicker({ onFiles, accept, label }, ref) {
  const filesRef = React.useRef<HTMLInputElement | null>(null);
  const folderRef = React.useRef<HTMLInputElement | null>(null);

  React.useImperativeHandle(ref, () => ({
    pickFiles: () => filesRef.current?.click(),
    pickFolder: () => folderRef.current?.click(),
  }));

  /**
   * `webkitdirectory` set on the element rather than written in the JSX.
   *
   * React 18's `InputHTMLAttributes` has no such property — the attribute
   * predates the standard and never got one — so writing it as a prop is a type
   * error and casting it away would hide the next real one. Setting it here is
   * the same DOM in the end, and the `directory` twin is the standardised name
   * some browsers already answer to.
   */
  React.useEffect(() => {
    const input = folderRef.current;
    if (input === null) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  const handle = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onFiles(event.target.files);
      event.target.value = "";
    },
    [onFiles],
  );

  return (
    <>
      <input
        ref={filesRef}
        type="file"
        multiple
        accept={accept}
        aria-label={label}
        onChange={handle}
        className="scan-sr-only"
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        aria-label={label}
        onChange={handle}
        className="scan-sr-only"
      />
    </>
  );
});
