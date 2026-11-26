/**
 * Browser-only storage (IndexedDB). Nothing here is ever uploaded.
 *
 * Each identity gets its own database: one per signed-in e-mail (named by a
 * hash, not the address) and one for guests. A guest using the same browser
 * cannot see the owner's chats.
 *
 * Temp / Boochi chats never touch this file — they live only in React state
 * and disappear on reload or close.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Attempt, ServedBy } from "../../shared/types.ts";

export interface StoredAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  blob: Blob;
  kind: "image" | "pdf" | "text";
  /** Extracted text for PDFs / documents / spreadsheets / text files. */
  text?: string;
  note?: string;
}

export interface ChatRecord {
  id: string;
  title: string;
  agentId: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id: string;
  chatId: string;
  role: "user" | "assistant";
  text: string;
  attachments?: StoredAttachment[];
  createdAt: number;
  servedBy?: ServedBy;
  attempts?: Attempt[];
  notices?: string[];
  error?: string;
  /** Whether the server routed this reply privately (paid tiers only). */
  private?: boolean;
  /** The reply stopped before it was finished (stopped, or every model failed mid-answer). */
  incomplete?: boolean;
  continued?: number;
}

export interface CustomAgent {
  id: string; // "custom-…"
  name: string;
  emoji: string;
  prompt: string;
}

interface Schema extends DBSchema {
  chats: { key: string; value: ChatRecord; indexes: { "by-updated": number } };
  messages: { key: string; value: MessageRecord; indexes: { "by-chat": [string, number] } };
  kv: { key: string; value: unknown };
}

let current: { ns: string; db: Promise<IDBPDatabase<Schema>> } | null = null;

export async function namespaceFor(email: string | null): Promise<string> {
  if (!email) return "guest";
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`boochi|${email}`));
  return Array.from(new Uint8Array(d).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function useNamespace(ns: string) {
  if (current?.ns === ns) return;
  current = {
    ns,
    db: openDB<Schema>(`boochi-${ns}`, 1, {
      upgrade(db) {
        db.createObjectStore("chats", { keyPath: "id" }).createIndex("by-updated", "updatedAt");
        db.createObjectStore("messages", { keyPath: "id" }).createIndex("by-chat", ["chatId", "createdAt"]);
        db.createObjectStore("kv");
      },
    }),
  };
}

function db() {
  if (!current) throw new Error("Storage namespace not selected.");
  return current.db;
}

export const uid = () => {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Date.now().toString(36) + Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 12);
};

export async function listChats(): Promise<ChatRecord[]> {
  return (await (await db()).getAllFromIndex("chats", "by-updated")).reverse();
}

export async function putChat(chat: ChatRecord) {
  await (await db()).put("chats", chat);
}

export async function getMessages(chatId: string): Promise<MessageRecord[]> {
  return (await db()).getAllFromIndex(
    "messages",
    "by-chat",
    IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]),
  );
}

export async function putMessage(m: MessageRecord) {
  const d = await db();
  const tx = d.transaction(["messages", "chats"], "readwrite");
  await tx.objectStore("messages").put(m);
  const chat = await tx.objectStore("chats").get(m.chatId);
  if (chat) await tx.objectStore("chats").put({ ...chat, updatedAt: Date.now() });
  await tx.done;
}

export async function deleteMessage(id: string) {
  await (await db()).delete("messages", id);
}

export async function deleteChat(chatId: string) {
  const d = await db();
  const tx = d.transaction(["messages", "chats"], "readwrite");
  const keys = await tx
    .objectStore("messages")
    .index("by-chat")
    .getAllKeys(IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]));
  for (const k of keys) await tx.objectStore("messages").delete(k);
  await tx.objectStore("chats").delete(chatId);
  await tx.done;
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get("kv", key)) as T | undefined;
}

export async function setKv(key: string, value: unknown) {
  await (await db()).put("kv", value, key);
}

/** Delete this identity's database entirely. */
export async function wipeCurrent() {
  if (!current) return;
  const name = `boochi-${current.ns}`;
  (await current.db).close();
  current = null;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/** Delete every Boochi Chat database on this device (all identities + guest). */
export async function wipeEverything() {
  if (current) (await current.db).close();
  current = null;
  const dbs = (await indexedDB.databases?.()) ?? [];
  await Promise.all(
    dbs
      .filter((d) => d.name?.startsWith("boochi-"))
      .map(
        (d) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(d.name!);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          }),
      ),
  );
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* blocked storage */
  }
}

export async function storageEstimate(): Promise<{ usedMB: number; quotaMB: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usedMB: (e.usage ?? 0) / 1048576, quotaMB: (e.quota ?? 0) / 1048576 };
}
