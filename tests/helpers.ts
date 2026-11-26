/** Test helpers: a scriptable fake provider fetch. */

export interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type Script = (call: Call, n: number) => Response | Promise<Response>;

export function fakeFetch(script: Script) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const call = { url, headers, body };
    calls.push(call);
    return script(call, calls.length - 1);
  }) as typeof fetch;
  return { impl, calls };
}

/** OpenAI-style SSE stream. */
export function openAiSse(chunks: string[], finish: string | null = "stop", opts: { breakAfter?: number } = {}): Response {
  const enc = new TextEncoder();
  const lines = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
  if (finish) lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
  if (!opts.breakAfter) lines.push("data: [DONE]\n\n");
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (opts.breakAfter !== undefined && i >= opts.breakAfter) {
        c.error(new Error("connection reset"));
        return;
      }
      if (i < lines.length) c.enqueue(enc.encode(lines[i++]));
      else c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function geminiSse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });

export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}
