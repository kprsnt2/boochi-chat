/**
 * Turn picked/pasted/dropped files into attachments — entirely in the browser.
 * Images are downscaled, PDFs/DOCX/XLSX/CSV are converted to text locally.
 */

import { uid, type StoredAttachment } from "./store.ts";

export const MAX_FILES_PER_MESSAGE = 30;
export const MAX_FILE_MB = 40;
const MAX_TEXT_CHARS = 400_000;
const MAX_EDGE = 2000; // keeps prescriptions/lab reports legible
const JPEG_QUALITY = 0.86;
const OK_IMAGE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|log|ts|tsx|js|jsx|mjs|py|rb|go|rs|java|kt|c|h|cpp|cs|php|sql|html|htm|css|scss|xml|yml|yaml|toml|ini|env\.example|sh|ps1|bat|r|ipynb|tex|srt|vtt)$/i;

export interface Processed {
  attachment: StoredAttachment;
  notice?: string;
}

export async function processFile(file: File): Promise<Processed> {
  const name = file.name || "file";
  const lower = name.toLowerCase();
  if (file.type.startsWith("image/")) return processImage(file);
  if (file.type === "application/pdf" || lower.endsWith(".pdf")) return processPdf(file);
  if (lower.endsWith(".docx")) return processDocx(file);
  if (lower.endsWith(".xlsx")) return processXlsx(file);
  if (file.type === "text/csv" || /\.(csv|tsv)$/.test(lower)) return processCsv(file);
  if (file.type.startsWith("text/") || TEXT_EXT.test(lower)) return processText(file);
  throw new Error("Unsupported type. Use images, PDF, DOCX, XLSX, CSV or text files.");
}

function base(file: File | Blob, name: string, mimeType: string, kind: StoredAttachment["kind"]): StoredAttachment {
  return { id: uid(), name, mimeType, size: file.size, blob: file, kind };
}

function clip(text: string): { text: string; clipped: boolean } {
  return text.length > MAX_TEXT_CHARS
    ? { text: `${text.slice(0, MAX_TEXT_CHARS)}\n[… truncated: file is longer than ${MAX_TEXT_CHARS.toLocaleString()} characters]`, clipped: true }
    : { text, clipped: false };
}

/* --------------------------------- images -------------------------------- */

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((ok, bad) => {
        img.onload = () => ok();
        img.onerror = () => bad(new Error("This image could not be decoded."));
        img.src = url;
      });
      return await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function processImage(file: File): Promise<Processed> {
  const bmp = await decode(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const needsWork = scale < 1 || !OK_IMAGE.has(file.type) || file.size > 1.5 * 1048576;
  if (!needsWork) {
    bmp.close();
    return { attachment: base(file, file.name || "image.png", file.type, "image") };
  }
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise<Blob>((ok, bad) =>
    canvas.toBlob((b) => (b ? ok(b) : bad(new Error("Image encoding failed."))), "image/jpeg", JPEG_QUALITY),
  );
  const name = (file.name || "image").replace(/\.[^.]+$/, "") + ".jpg";
  return {
    attachment: base(blob, name, "image/jpeg", "image"),
    notice: `${name}: resized ${(file.size / 1048576).toFixed(1)} MB → ${(blob.size / 1024).toFixed(0)} KB`,
  };
}

/* ---------------------------------- PDF ---------------------------------- */

async function processPdf(file: File): Promise<Processed> {
  const att = base(file, file.name, "application/pdf", "pdf");
  try {
    const pdfjs = await import("pdfjs-dist");
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const doc = await task.promise;
    const deadline = Date.now() + 45_000;
    const pages: string[] = [];
    const limit = Math.min(doc.numPages, 300);
    for (let i = 1; i <= limit; i++) {
      if (Date.now() > deadline) {
        pages.push(`[Text extraction stopped at page ${i} of ${doc.numPages} (time limit).]`);
        break;
      }
      const content = await (await doc.getPage(i)).getTextContent();
      const text = content.items
        .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : ""))
        .join(" ")
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (text) pages.push(`[Page ${i}]\n${text}`);
    }
    await task.destroy();
    const joined = pages.join("\n\n");
    if (joined.replace(/\[Page \d+\]/g, "").trim().length > 40) {
      att.text = clip(joined).text;
      return { attachment: att };
    }
    att.note = "Scanned PDF (no text layer): only Gemini models can read it.";
    return { attachment: att, notice: `${file.name}: looks scanned — Gemini will OCR it.` };
  } catch {
    att.note = "Could not read the text layer; only Gemini models can read it.";
    return { attachment: att };
  }
}

/* ------------------------------- DOCX / XLSX ----------------------------- */

const xmlText = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&");

async function processDocx(file: File): Promise<Processed> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("Not a valid .docx file.");
  const text = xmlText(
    xml
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tc>/g, " | ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const att = base(file, file.name, file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text");
  att.text = clip(text).text;
  return { attachment: att };
}

async function processXlsx(file: File): Promise<Processed> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const parser = new DOMParser();
  const shared: string[] = [];
  const ss = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (ss) {
    for (const si of Array.from(parser.parseFromString(ss, "application/xml").getElementsByTagName("si"))) {
      shared.push(Array.from(si.getElementsByTagName("t"), (t) => t.textContent ?? "").join(""));
    }
  }
  const wb = await zip.file("xl/workbook.xml")?.async("string");
  const sheetNames = wb
    ? Array.from(parser.parseFromString(wb, "application/xml").getElementsByTagName("sheet"), (s) => s.getAttribute("name") ?? "Sheet")
    : [];
  const sheetFiles = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));

  const colIndex = (ref: string) => {
    const letters = ref.replace(/\d+/g, "");
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };

  const out: string[] = [];
  for (let s = 0; s < sheetFiles.length; s++) {
    const doc = parser.parseFromString(await zip.file(sheetFiles[s])!.async("string"), "application/xml");
    const rows = Array.from(doc.getElementsByTagName("row"));
    out.push(`## Sheet: ${sheetNames[s] ?? `Sheet${s + 1}`} (${rows.length} rows)`);
    for (const row of rows) {
      const cells: string[] = [];
      for (const c of Array.from(row.getElementsByTagName("c"))) {
        const idx = colIndex(c.getAttribute("r") ?? "A");
        const t = c.getAttribute("t");
        const v = c.getElementsByTagName("v")[0]?.textContent ?? c.getElementsByTagName("t")[0]?.textContent ?? "";
        cells[idx] = t === "s" ? (shared[Number(v)] ?? "") : v;
      }
      out.push(Array.from(cells, (x) => csvCell(x ?? "")).join(","));
    }
    out.push("");
  }
  const att = base(file, file.name, file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text");
  const { text, clipped } = clip(`Spreadsheet: ${file.name}\n${out.join("\n")}`);
  att.text = text;
  return { attachment: att, notice: clipped ? `${file.name}: very large; truncated.` : undefined };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/* ---------------------------------- CSV ---------------------------------- */

async function processCsv(file: File): Promise<Processed> {
  const raw = await file.text();
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0] ?? "";
  const delim = [",", ";", "\t", "|"].reduce((a, d) => (header.split(d).length > header.split(a).length ? d : a), ",");
  const cols = header.split(delim).map((c) => c.replace(/^"|"$/g, "").trim());
  const { text, clipped } = clip(raw);
  const att = base(file, file.name, file.type || "text/csv", "text");
  att.text = `CSV file: ${file.name}\nRows: ${lines.length - 1} · Columns (${cols.length}): ${cols.join(", ")}\n\n${text}`;
  return {
    attachment: att,
    notice: `${file.name}: ${lines.length - 1} rows × ${cols.length} columns${clipped ? " (truncated)" : ""}`,
  };
}

/* ---------------------------------- text --------------------------------- */

async function processText(file: File): Promise<Processed> {
  const { text, clipped } = clip(await file.text());
  const att = base(file, file.name, file.type || "text/plain", "text");
  att.text = text;
  return { attachment: att, notice: clipped ? `${file.name}: truncated to fit.` : undefined };
}

/** A long paste becomes an attachment so the composer stays fast and nothing is cut. */
export function textAttachment(text: string, name = "Pasted text.txt"): StoredAttachment {
  const blob = new Blob([text], { type: "text/plain" });
  return { id: uid(), name, mimeType: "text/plain", size: blob.size, blob, kind: "text", text };
}
