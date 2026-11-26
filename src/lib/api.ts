import type { ChatRequest, PublicConfig, StreamEvent } from "../../shared/types.ts";

const JSON_HEADERS = { "content-type": "application/json", "x-boochi": "1" };

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function json<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Request failed (${res.status}).`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

const opts = (init: RequestInit = {}): RequestInit => ({
  credentials: "same-origin",
  cache: "no-store",
  referrerPolicy: "no-referrer",
  ...init,
});

export const getConfig = () => fetch("/api/config", opts()).then((r) => json<PublicConfig>(r));

export const requestCode = (email: string) =>
  fetch("/api/auth/request", opts({ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email }) })).then(
    (r) => json<{ ok: true; challenge: string; devCode?: string }>(r),
  );

export const verifyCode = (challenge: string, code: string) =>
  fetch(
    "/api/auth/verify",
    opts({ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ challenge, code }) }),
  ).then((r) => json<{ ok: true; email: string }>(r));

export const logout = () =>
  fetch("/api/auth/logout", opts({ method: "POST", headers: JSON_HEADERS, body: "{}" })).then((r) => json(r));

export interface ModelCheck {
  id: string;
  label: string;
  tier: "paid" | "free";
  status: "ok" | "missing" | "error" | "no-key";
  suggestions?: string[];
  error?: string;
}
export const checkModels = () =>
  fetch("/api/models/check", opts()).then((r) => json<{ ok: true; results: ModelCheck[] }>(r));

/** POST /api/chat and feed each NDJSON event to `onEvent`. */
export async function streamChat(
  body: ChatRequest,
  signal: AbortSignal,
  onEvent: (ev: StreamEvent) => void,
): Promise<void> {
  const res = await fetch("/api/chat", opts({ method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body), signal }));
  if (!res.ok || !res.body) {
    await json(res); // throws ApiError with the server's message
    throw new ApiError("No response body.", res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line) as StreamEvent);
        } catch {
          /* ignore a malformed line */
        }
      }
    }
  }
  const tail = (buf + decoder.decode()).trim();
  if (tail) {
    try {
      onEvent(JSON.parse(tail) as StreamEvent);
    } catch {
      /* ignore */
    }
  }
}
