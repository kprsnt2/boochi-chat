/**
 * Build the wire conversation from local messages.
 *
 * No turn cap: the whole conversation is sent. Only *binary* attachments are
 * budgeted — newest first — so a long chat full of photos cannot exceed the
 * request size. Older binaries are replaced by a short note; their extracted
 * text (PDF/DOCX/CSV) is always kept.
 */

import type { ContentPart, WireMessage } from "../../shared/types.ts";
import type { MessageRecord, StoredAttachment } from "./store.ts";

const b64Cache = new WeakMap<Blob, Promise<string>>();

export function blobToBase64(blob: Blob): Promise<string> {
  let p = b64Cache.get(blob);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result);
        resolve(s.slice(s.indexOf(",") + 1));
      };
      r.onerror = () => reject(r.error ?? new Error("Could not read file."));
      r.readAsDataURL(blob);
    });
    b64Cache.set(blob, p);
  }
  return p;
}

export interface BuildOptions {
  /** Max bytes of base64 binary payload. */
  binaryBudget: number;
  /** Binaries older than this many user turns (with attachments) become notes. */
  binaryTurns?: number;
  encode?: (blob: Blob) => Promise<string>;
}

const fileBlock = (a: StoredAttachment) => `\n--- Attached file: ${a.name} ---\n${a.text ?? ""}\n--- end of ${a.name} ---\n`;

export async function buildWire(history: MessageRecord[], opts: BuildOptions): Promise<WireMessage[]> {
  const encode = opts.encode ?? blobToBase64;
  const maxTurns = opts.binaryTurns ?? 3;
  let budget = opts.binaryBudget;
  let turnsWithBinary = 0;

  // Walk newest → oldest so the budget favours what the user just sent.
  const out: WireMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant") {
      if (m.error && !m.text) continue; // failed turns carry nothing useful
      if (m.text) out.push({ role: "assistant", parts: [{ type: "text", text: m.text }] });
      continue;
    }

    const parts: ContentPart[] = [];
    const atts = m.attachments ?? [];
    const hasBinary = atts.some((a) => a.kind === "image" || a.kind === "pdf");
    if (hasBinary) turnsWithBinary++;
    const allowBinary = turnsWithBinary <= maxTurns;

    for (const a of atts) {
      if (a.kind === "text") {
        parts.push({ type: "text", text: fileBlock(a) });
        continue;
      }
      const cost = Math.ceil((a.size * 4) / 3);
      const fits = allowBinary && cost <= budget;
      if (a.kind === "image") {
        if (fits) {
          budget -= cost;
          parts.push({ type: "image", mimeType: a.mimeType, data: await encode(a.blob), name: a.name });
        } else {
          parts.push({ type: "text", text: `[Earlier image "${a.name}" omitted to keep the request small.]` });
        }
      } else {
        // PDF: always keep the text; send the bytes only when they fit (for native PDF readers).
        const sendBytes = fits && (!a.text || cost <= budget / 2);
        if (sendBytes) budget -= cost;
        parts.push({ type: "pdf", name: a.name, text: a.text, data: sendBytes ? await encode(a.blob) : undefined });
      }
    }
    if (m.text) parts.push({ type: "text", text: m.text });
    if (parts.length) out.push({ role: "user", parts });
  }
  return out.reverse();
}

/** Rough size of a wire payload in bytes. */
export function wireSize(messages: WireMessage[]): number {
  let n = 0;
  for (const m of messages)
    for (const p of m.parts) {
      if (p.type === "text") n += p.text.length;
      else if (p.type === "image") n += p.data.length;
      else n += (p.data?.length ?? 0) + (p.text?.length ?? 0);
    }
  return n;
}
