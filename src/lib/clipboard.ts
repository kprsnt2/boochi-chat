/**
 * Copy & paste that does not lose content.
 *
 * Old bug: the global paste handler called preventDefault() whenever the
 * clipboard held ANY file. Excel, Word, Google Sheets and many web pages put
 * a picture of the selection on the clipboard *alongside* the text, so the
 * text was thrown away and only an image was attached.
 *
 * New rule: text wins. Files are attached only when there is no text, and a
 * very long paste becomes a text attachment (nothing is truncated).
 */

export const LONG_PASTE_CHARS = 15_000;

export type PasteAction =
  | { kind: "text" } // let the browser paste normally
  | { kind: "insert-text" } // paste happened outside the textarea: insert it ourselves
  | { kind: "text-attachment" } // very long text → attachment
  | { kind: "files" } // only files on the clipboard
  | { kind: "none" };

export function decidePaste(input: { text: string; fileCount: number; inComposer: boolean }): PasteAction {
  const hasText = input.text.length > 0;
  if (hasText) {
    if (input.text.length >= LONG_PASTE_CHARS) return { kind: "text-attachment" };
    return input.inComposer ? { kind: "text" } : { kind: "insert-text" };
  }
  if (input.fileCount > 0) return { kind: "files" };
  return { kind: "none" };
}

/** Copy plain text (and optional rich HTML). Works on http:// and in older browsers too. */
export async function copyToClipboard(text: string, html?: string): Promise<boolean> {
  try {
    if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  // Legacy path: insecure context or permission denied.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}
