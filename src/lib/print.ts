/**
 * Print / Save as PDF through the browser's own print engine.
 *
 * The old jsPDF exporter used Latin-1 fonts and silently deleted every other
 * character (π, √, ✓, ½ survived only by luck; Hindi/Telugu text vanished).
 * Printing real HTML supports every script and keeps text selectable.
 *
 * Worksheets get: Name/Date/Score header, ruled answer space, MCQ options
 * kept together, and the Answer Key either removed (student copy) or moved to
 * its own page (teacher copy).
 */

import { renderMarkdown } from "./markdown.ts";

export type PrintMode = "student" | "teacher" | "document";

const ANSWER_KEY = /^#{1,4}\s*(answer\s*key|answers|solutions|marking\s*scheme)\b.*$/im;

export function splitAnswerKey(md: string): { sheet: string; key: string | null } {
  const m = ANSWER_KEY.exec(md);
  if (!m) return { sheet: md.trim(), key: null };
  return { sheet: md.slice(0, m.index).replace(/\n-{3,}\s*$/, "").trim(), key: md.slice(m.index).trim() };
}

/** Turn runs of underscores into printable answer blanks. */
export function blanksToHtml(html: string): string {
  return html.replace(/_{3,}|(?:\\_){3,}/g, '<span class="blank"></span>');
}

function decorateQuestions(root: HTMLElement) {
  // Give open questions (no blank, no options) ruled lines to write on.
  for (const li of Array.from(root.querySelectorAll<HTMLLIElement>(".sheet > ol > li"))) {
    const text = li.textContent ?? "";
    const hasBlank = li.querySelector(".blank");
    // Options arrive as "<br>a) …" (or a nested list), so test the markup, not textContent.
    const hasOptions = /(<br>|<li>|^|\s|>)\s*\(?[a-dA-D][).]\s/.test(li.innerHTML);
    if (!hasBlank && !hasOptions) {
      const lines = document.createElement("div");
      lines.className = /explain|why|describe|write|show|solve|how/i.test(text) ? "lines lines-3" : "lines";
      li.appendChild(lines);
    }
  }
}

export function buildPrintHtml(md: string, mode: PrintMode, title: string): string {
  if (mode === "document") {
    return `<article class="print-doc">${renderMarkdown(md)}</article>`;
  }
  const { sheet, key } = splitAnswerKey(md);
  const header =
    `<div class="ws-header"><span>Name: <i></i></span><span>Date: <i></i></span>` +
    `<span>Score: <i class="short"></i></span></div>`;
  const sheetHtml = blanksToHtml(renderMarkdown(sheet));
  // Put the student header right after the title (first h1) if there is one.
  const withHeader = /<h1[\s>]/.test(sheetHtml)
    ? sheetHtml.replace(/<\/h1>/, `</h1>${header}`)
    : `<h1>${title.replace(/[<>&]/g, "")}</h1>${header}${sheetHtml}`;
  let html = `<article class="print-doc worksheet"><section class="sheet">${withHeader}</section>`;
  if (mode === "teacher" && key) {
    html += `<section class="answer-key">${renderMarkdown(key)}</section>`;
  }
  return `${html}</article>`;
}

export function printMarkdown(md: string, mode: PrintMode, title: string) {
  document.getElementById("print-root")?.remove();
  const root = document.createElement("div");
  root.id = "print-root";
  root.innerHTML = buildPrintHtml(md, mode, title);
  root.querySelectorAll(".sheet").forEach((s) => decorateQuestions(s as HTMLElement));
  root.querySelectorAll(".code-copy").forEach((b) => b.remove());
  document.body.appendChild(root);
  const prevTitle = document.title;
  // The browser uses document.title as the default PDF file name.
  document.title = `${title}${mode === "student" ? " (student)" : mode === "teacher" ? " (with answers)" : ""}`;
  document.documentElement.classList.add("printing");
  const cleanup = () => {
    document.documentElement.classList.remove("printing");
    document.title = prevTitle;
    root.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // Let layout settle (fonts) before opening the dialog.
  requestAnimationFrame(() => setTimeout(() => window.print(), 50));
}
