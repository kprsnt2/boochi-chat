import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decidePaste, LONG_PASTE_CHARS } from "../src/lib/clipboard.ts";
import { buildWire } from "../src/lib/history.ts";
import { blanksToHtml, splitAnswerKey } from "../src/lib/print.ts";
import type { MessageRecord, StoredAttachment } from "../src/lib/store.ts";
import { SECURITY_HEADERS } from "../server/security.ts";

/* ---------------------------------- paste --------------------------------- */

test("paste: text + image from Excel/Word keeps the TEXT (old bug dropped it)", () => {
  assert.deepEqual(decidePaste({ text: "A\tB\n1\t2", fileCount: 1, inComposer: true }), { kind: "text" });
});

test("paste: a screenshot alone is attached", () => {
  assert.deepEqual(decidePaste({ text: "", fileCount: 1, inComposer: false }), { kind: "files" });
});

test("paste: very long text becomes a full attachment, never truncated", () => {
  assert.deepEqual(decidePaste({ text: "x".repeat(LONG_PASTE_CHARS), fileCount: 0, inComposer: true }), { kind: "text-attachment" });
});

test("paste outside the composer is inserted into it", () => {
  assert.deepEqual(decidePaste({ text: "hi", fileCount: 0, inComposer: false }), { kind: "insert-text" });
});

/* --------------------------------- history -------------------------------- */

const att = (name: string, kind: StoredAttachment["kind"], size: number, text?: string): StoredAttachment => ({
  id: name,
  name,
  kind,
  size,
  text,
  mimeType: kind === "image" ? "image/jpeg" : kind === "pdf" ? "application/pdf" : "text/plain",
  blob: new Blob([new Uint8Array(size)]),
});

const msg = (role: "user" | "assistant", text: string, attachments?: StoredAttachment[], extra: Partial<MessageRecord> = {}): MessageRecord => ({
  id: Math.random().toString(36),
  chatId: "c",
  role,
  text,
  attachments,
  createdAt: 0,
  ...extra,
});

const encode = async () => "BASE64";

test("history: whole conversation is sent (no 16-turn cap)", async () => {
  const h: MessageRecord[] = [];
  for (let i = 0; i < 60; i++) h.push(msg("user", `q${i}`), msg("assistant", `a${i}`));
  h.push(msg("user", "last"));
  const wire = await buildWire(h, { binaryBudget: 1e9, encode });
  assert.equal(wire.length, 121);
});

test("history: old images become notes, the newest image is kept, PDF text always kept", async () => {
  const h = [
    msg("user", "old", [att("old.jpg", "image", 1000)]),
    msg("assistant", "ok"),
    msg("user", "report", [att("r.pdf", "pdf", 5000, "Hb 11.2")]),
    msg("assistant", "ok"),
    msg("user", "new", [att("new.jpg", "image", 3000)]),
  ];
  const wire = await buildWire(h, { binaryBudget: 4500, encode });
  const flat = JSON.stringify(wire);
  assert.match(flat, /Earlier image \\"old.jpg\\" omitted/);
  assert.ok(wire[4].parts.some((p) => p.type === "image"));
  const pdf = wire[2].parts.find((p) => p.type === "pdf");
  assert.equal(pdf && pdf.type === "pdf" && pdf.text, "Hb 11.2");
});

test("history: failed empty assistant turns are skipped", async () => {
  const wire = await buildWire([msg("user", "a"), msg("assistant", "", undefined, { error: "x" }), msg("user", "b")], { binaryBudget: 1e6, encode });
  assert.deepEqual(wire.map((m) => m.role), ["user", "user"]);
});

/* -------------------------------- worksheet ------------------------------- */

const SHEET = `# Multiplication
*Grade 4 · 3 questions*

## Section A: Fill in the blanks (2 marks)
1. 3 × 4 = ________
2. 7 × ________ = 14

## Section B: Word problems (2 marks)
3. Explain how you find 6 × 8.

## Answer Key
1. 12
2. 2
3. 48`;

test("worksheet: answer key is split off for the student copy", () => {
  const { sheet, key } = splitAnswerKey(SHEET);
  assert.doesNotMatch(sheet, /Answer Key|^1\. 12$/m);
  assert.match(key ?? "", /^## Answer Key/);
  assert.match(key ?? "", /3\. 48/);
});

test("worksheet: blanks become printable lines; unicode survives", () => {
  assert.equal(blanksToHtml("3 × 4 = ________"), '3 × 4 = <span class="blank"></span>');
  assert.match(blanksToHtml("π ≈ ___ · సంఖ్య"), /π ≈ <span class="blank"><\/span> · సంఖ్య/);
});

/* -------------------------------- security -------------------------------- */

test("public/_headers mirrors the server security headers", () => {
  const file = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.ok(file.includes(`${k}: ${v}`), k);
});
