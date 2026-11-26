/**
 * Provider adapters. Two wire formats cover every provider:
 *   - OpenAI-compatible chat completions (OpenAI, Groq, NVIDIA, OpenRouter, …)
 *   - Google Gemini streamGenerateContent
 *
 * NO OUTPUT TOKEN LIMIT is sent: no max_tokens / max_completion_tokens /
 * maxOutputTokens, so each model may use its full output window. If a
 * provider still stops at its own ceiling we report finish="length" and the
 * router asks it to continue.
 *
 * No temperature is sent either: reasoning models (gpt-5 family) reject any
 * non-default value, which silently knocked OpenAI out of the old chain.
 *
 * PRIVACY: nothing here logs. Error text returned to the browser is a short,
 * provider-supplied message, never the request body.
 */

import type { ContentPart, WireMessage } from "../shared/types.ts";
import { apiKeyFor, baseUrlFor, type Env, type Tier } from "./config.ts";

export type Finish = "stop" | "length" | "other";

export type ProviderEvent = { type: "text"; text: string } | { type: "finish"; finish: Finish };

export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface StreamOptions {
  env: Env;
  tier: Tier;
  system: string;
  messages: WireMessage[];
  signal: AbortSignal;
  /** Max wait for response headers. */
  connectTimeoutMs?: number;
  /** Max silence between streamed chunks. Reasoning models think silently, so keep this generous. */
  idleTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/* ------------------------------------------------------------------------ */
/* message shaping                                                          */
/* ------------------------------------------------------------------------ */

/** Providers dislike consecutive same-role turns and a leading assistant turn. */
export function normalizeTurns(messages: WireMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of messages) {
    const parts = m.parts.filter((p) => !(p.type === "text" && !p.text.trim()));
    if (!parts.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.parts = [...last.parts, { type: "text", text: "\n\n" }, ...parts];
    } else {
      out.push({ role: m.role, parts: [...parts] });
    }
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/** Text a model sees for a part it cannot read natively. */
function degradePart(p: ContentPart, tier: Tier): string | null {
  if (p.type === "image") {
    return `[An image${p.name ? ` "${p.name}"` : ""} was attached, but ${tier.label} cannot see images.]`;
  }
  if (p.type === "pdf") {
    if (p.text?.trim()) {
      return `\n--- Attached PDF: ${p.name} ---\n${p.text}\n--- end of ${p.name} ---\n`;
    }
    return `[A PDF "${p.name}" was attached but it has no text layer (probably a scan), and ${tier.label} cannot read PDFs directly.]`;
  }
  return null;
}

function openAiMessages(tier: Tier, system: string, messages: WireMessage[]) {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
      });
      continue;
    }
    const content: unknown[] = [];
    for (const p of m.parts) {
      if (p.type === "text") content.push({ type: "text", text: p.text });
      else if (p.type === "image" && tier.vision) {
        content.push({ type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } });
      } else {
        const t = degradePart(p, tier);
        if (t) content.push({ type: "text", text: t });
      }
    }
    const allText = content.every((c) => (c as { type: string }).type === "text");
    out.push({
      role: "user",
      content: allText ? content.map((c) => (c as { text: string }).text).join("\n") : content,
    });
  }
  return out;
}

function geminiBody(tier: Tier, system: string, messages: WireMessage[]) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: m.parts.flatMap((p): unknown[] => {
        if (p.type === "text") return [{ text: p.text }];
        if (p.type === "image") return [{ inlineData: { mimeType: p.mimeType, data: p.data } }];
        if (p.type === "pdf" && p.data) return [{ inlineData: { mimeType: "application/pdf", data: p.data } }];
        const t = degradePart(p, tier);
        return t ? [{ text: t }] : [];
      }),
    })),
    // Deliberately no maxOutputTokens: the model's full output window applies.
    generationConfig: {},
  };
}

/* ------------------------------------------------------------------------ */
/* SSE reader                                                               */
/* ------------------------------------------------------------------------ */

/** Yield the payload of every `data:` line of a server-sent-event stream. */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal.aborted) throw new ProviderError("Cancelled.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderError(`No data for ${Math.round(idleTimeoutMs / 1000)}s (stalled).`)),
          idleTimeoutMs,
        );
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
    buf += decoder.decode();
    const tail = buf.replace(/\r$/, "");
    if (tail.startsWith("data:")) yield tail.slice(5).trimStart();
  } finally {
    reader.cancel().catch(() => {});
  }
}

/* ------------------------------------------------------------------------ */
/* streaming entry point                                                    */
/* ------------------------------------------------------------------------ */

export async function* streamCompletion(opts: StreamOptions): AsyncGenerator<ProviderEvent> {
  const { env, tier, signal } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const key = apiKeyFor(env, tier);
  if (!key) throw new ProviderError("No API key configured for this tier.");

  const messages = normalizeTurns(opts.messages);
  if (!messages.length) throw new ProviderError("Nothing to send.");

  const base = baseUrlFor(env, tier.provider, tier.kind);
  let url: string;
  let headers: Record<string, string>;
  let body: unknown;

  if (tier.provider.kind === "gemini") {
    url = `${base}/models/${encodeURIComponent(tier.model)}:streamGenerateContent?alt=sse`;
    headers = { "content-type": "application/json", "x-goog-api-key": key };
    body = geminiBody(tier, opts.system, messages);
  } else {
    url = `${base}/chat/completions`;
    headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
    body = { model: tier.model, stream: true, messages: openAiMessages(tier, opts.system, messages) };
    if (tier.provider.id === "openai") (body as Record<string, unknown>).store = false;
  }

  // Connect timeout covers only the wait for response headers.
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const connectTimer = setTimeout(() => ctl.abort(), opts.connectTimeoutMs ?? 45_000);

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
      // Never let an intermediary cache a prompt.
      cache: "no-store",
    });
  } catch (err) {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) throw new ProviderError("Cancelled.");
    if (ctl.signal.aborted) throw new ProviderError("Timed out waiting for the provider.");
    throw new ProviderError(err instanceof Error ? err.message.slice(0, 200) : "Network error.");
  } finally {
    clearTimeout(connectTimer);
  }

  try {
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      throw new ProviderError(summarizeError(res.status, raw), res.status);
    }

    let finish: Finish | null = null;
    let produced = false;
    for await (const data of sseData(res.body, opts.idleTimeoutMs ?? 150_000, ctl.signal)) {
      if (data === "[DONE]") break;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) {
        const e = json.error as { message?: string } | string;
        throw new ProviderError(
          `Stream error: ${(typeof e === "string" ? e : (e.message ?? "unknown")).slice(0, 200)}`,
        );
      }
      if (tier.provider.kind === "gemini") {
        const cand = (json.candidates as Array<Record<string, unknown>> | undefined)?.[0];
        const parts = (cand?.content as { parts?: Array<{ text?: string; thought?: boolean }> })?.parts ?? [];
        for (const p of parts) {
          if (p.text && !p.thought) {
            produced = true;
            yield { type: "text", text: p.text };
          }
        }
        const fr = cand?.finishReason as string | undefined;
        if (fr) finish = fr === "STOP" ? "stop" : fr === "MAX_TOKENS" ? "length" : "other";
        const blocked = (json.promptFeedback as { blockReason?: string } | undefined)?.blockReason;
        if (blocked) throw new ProviderError(`Blocked by provider safety filter (${blocked}).`);
      } else {
        const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
        const delta = choice?.delta as { content?: string | null } | undefined;
        if (delta?.content) {
          produced = true;
          yield { type: "text", text: delta.content };
        }
        const fr = choice?.finish_reason as string | null | undefined;
        if (fr) finish = fr === "stop" ? "stop" : fr === "length" ? "length" : "other";
      }
    }

    if (!produced) {
      throw new ProviderError(
        finish === "other" ? "The provider refused or filtered this request." : "Empty response.",
      );
    }
    // A stream that ends without any finish reason was cut by the network.
    yield { type: "finish", finish: finish ?? "length" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** One short readable line from a provider error body. */
export function summarizeError(status: number, body: string): string {
  let msg = body;
  try {
    const j = JSON.parse(body) as unknown;
    const first = Array.isArray(j) ? j[0] : j;
    const e = (first as { error?: { message?: string } | string; message?: string }) ?? {};
    msg = typeof e.error === "string" ? e.error : (e.error?.message ?? e.message ?? body);
  } catch {
    /* not JSON */
  }
  msg = String(msg).replace(/\s+/g, " ").trim();
  // Defensive: never echo anything that looks like a credential.
  msg = msg.replace(/(sk-|gsk_|nvapi-|AIza)[A-Za-z0-9_-]{6,}/g, "[redacted]");
  return `HTTP ${status}${msg ? `: ${msg.slice(0, 220)}` : ""}`;
}

/* ------------------------------------------------------------------------ */
/* model check (owner-only diagnostics)                                     */
/* ------------------------------------------------------------------------ */

/** List the provider's model IDs (no prompt is sent). */
export async function listModels(env: Env, tier: Tier, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const key = apiKeyFor(env, tier);
  if (!key) throw new ProviderError("No key.");
  const base = baseUrlFor(env, tier.provider, tier.kind);
  const ctl = AbortSignal.timeout(15_000);
  if (tier.provider.kind === "gemini") {
    const ids: string[] = [];
    let pageToken = "";
    for (let i = 0; i < 5; i++) {
      const res = await fetchImpl(`${base}/models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`, {
        headers: { "x-goog-api-key": key },
        signal: ctl,
      });
      if (!res.ok) throw new ProviderError(summarizeError(res.status, await res.text()), res.status);
      const j = (await res.json()) as { models?: { name: string }[]; nextPageToken?: string };
      ids.push(...(j.models ?? []).map((m) => m.name.replace(/^models\//, "")));
      if (!j.nextPageToken) break;
      pageToken = encodeURIComponent(j.nextPageToken);
    }
    return ids;
  }
  const res = await fetchImpl(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: ctl });
  if (!res.ok) throw new ProviderError(summarizeError(res.status, await res.text()), res.status);
  const j = (await res.json()) as { data?: { id: string }[] };
  return (j.data ?? []).map((m) => m.id);
}
