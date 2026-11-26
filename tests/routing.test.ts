import { test } from "node:test";
import assert from "node:assert/strict";
import { orderForContent, planChain, runChat } from "../server/router.ts";
import { freeTiers, paidTiers, type Env } from "../server/config.ts";
import { CONTINUE_PROMPT, type StreamEvent, type WireMessage } from "../shared/types.ts";
import { collect, fakeFetch, geminiSse, jsonError, openAiSse } from "./helpers.ts";

const ENV: Env = {
  PAID_MODELS: "gemini:gem-paid,openai:gpt-paid",
  FREE_MODELS: "groq:llama-free,gemini:gem-free",
  GEMINI_API_KEY_PAID: "paid-gemini-key",
  OPENAI_API_KEY_PAID: "paid-openai-key",
  GROQ_API_KEY: "free-groq-key",
  GEMINI_API_KEY: "free-gemini-key",
};

const ids = (p: ReturnType<typeof planChain>) => (p.ok ? p.chain.map((t) => t.id) : p.error);

test("owner + private: paid tiers only, never a free tier", () => {
  const p = planChain(ENV, { role: "owner", privateRequested: true, agentAlwaysPrivate: false });
  assert.deepEqual(ids(p), ["paid:gemini:gem-paid", "paid:openai:gpt-paid"]);
  assert.ok(p.ok && p.private);
});

test("owner + private off: free first, paid as backup", () => {
  const p = planChain(ENV, { role: "owner", privateRequested: false, agentAlwaysPrivate: false });
  assert.deepEqual(ids(p), ["free:groq:llama-free", "free:gemini:gem-free", "paid:gemini:gem-paid", "paid:openai:gpt-paid"]);
  assert.ok(p.ok && !p.private);
});

test("guest: free only, even when asking for private", () => {
  const p = planChain(ENV, { role: "guest", privateRequested: true, agentAlwaysPrivate: true });
  assert.deepEqual(ids(p), ["free:groq:llama-free", "free:gemini:gem-free"]);
  assert.ok(p.ok && !p.private);
});

test("guest cannot pin a paid model", () => {
  const p = planChain(ENV, { role: "guest", privateRequested: false, agentAlwaysPrivate: false, pinned: "paid:gemini:gem-paid" });
  assert.equal(p.ok, false);
});

test("sensitive agent forces private for owners", () => {
  const p = planChain(ENV, { role: "owner", privateRequested: false, agentAlwaysPrivate: true });
  assert.ok(p.ok && p.private);
  assert.deepEqual(ids(p), ["paid:gemini:gem-paid", "paid:openai:gpt-paid"]);
});

test("pinning a free model while private is rejected (nothing sent)", () => {
  const p = planChain(ENV, { role: "owner", privateRequested: true, agentAlwaysPrivate: false, pinned: "free:groq:llama-free" });
  assert.equal(p.ok, false);
  assert.ok(!p.ok && p.status === 403);
});

test("pinned model goes first, rest kept as fallback", () => {
  const p = planChain(ENV, { role: "owner", privateRequested: true, agentAlwaysPrivate: false, pinned: "paid:openai:gpt-paid" });
  assert.deepEqual(ids(p), ["paid:openai:gpt-paid", "paid:gemini:gem-paid"]);
});

test("a paid tier is unusable without a *_PAID key (no cross-use of free keys)", () => {
  const env: Env = { ...ENV, GEMINI_API_KEY_PAID: "", OPENAI_API_KEY_PAID: "" };
  const p = planChain(env, { role: "owner", privateRequested: true, agentAlwaysPrivate: false });
  assert.equal(p.ok, false);
  assert.match(!p.ok ? p.error : "", /paid key/);
});

test("image requests put vision tiers first", () => {
  const env: Env = { FREE_MODELS: "groq:llama-3.3-70b-versatile,groq:meta-llama/llama-4-scout-17b-16e-instruct" };
  const chain = freeTiers(env);
  const msgs: WireMessage[] = [{ role: "user", parts: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }];
  assert.deepEqual(
    orderForContent(chain, msgs).map((t) => t.model),
    ["meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.3-70b-versatile"],
  );
});

const USER: WireMessage[] = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];

async function run(env: Env, fetchImpl: typeof fetch, chainKind: "paid" | "free" = "free") {
  const chain = chainKind === "paid" ? paidTiers(env) : freeTiers(env);
  return collect<StreamEvent>(
    runChat({ env, chain, system: "sys", messages: USER, signal: new AbortController().signal, autoContinueMax: 3, fetchImpl }),
  );
}

const text = (evs: StreamEvent[]) => evs.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");

test("no output-token limit and no temperature are ever sent", async () => {
  const f = fakeFetch((c) =>
    c.url.includes("generativelanguage") || c.url.includes(":streamGenerateContent")
      ? geminiSse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }])
      : openAiSse(["ok"]),
  );
  await run(ENV, f.impl, "free");
  await run(ENV, f.impl, "paid");
  for (const c of f.calls) {
    const s = JSON.stringify(c.body);
    assert.doesNotMatch(s, /max_tokens|max_completion_tokens|maxOutputTokens|temperature/, c.url);
  }
});

test("free chain uses free keys; paid chain uses *_PAID keys", async () => {
  const f = fakeFetch(() => openAiSse(["x"]));
  await run({ FREE_MODELS: "groq:a", PAID_MODELS: "groq:b", GROQ_API_KEY: "FREE", GROQ_API_KEY_PAID: "PAID" }, f.impl, "free");
  await run({ FREE_MODELS: "groq:a", PAID_MODELS: "groq:b", GROQ_API_KEY: "FREE", GROQ_API_KEY_PAID: "PAID" }, f.impl, "paid");
  assert.equal(f.calls[0].headers.authorization, "Bearer FREE");
  assert.equal(f.calls[1].headers.authorization, "Bearer PAID");
});

test("falls back to the next tier when one fails before answering", async () => {
  const f = fakeFetch((_c, n) => (n === 0 ? jsonError(429, "rate limited") : geminiSse([{ candidates: [{ content: { parts: [{ text: "from gemini" }] }, finishReason: "STOP" }] }])));
  const evs = await run(ENV, f.impl);
  assert.equal(text(evs), "from gemini");
  const done = evs.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
  assert.equal(done.attempts.length, 2);
  assert.equal(done.attempts[0].ok, false);
  assert.match(done.attempts[0].error ?? "", /429/);
  assert.equal(done.incomplete, false);
});

test("a cut-off answer is continued automatically and stitched together", async () => {
  const f = fakeFetch((_c, n) => (n === 0 ? openAiSse(["Part one, "], "length") : openAiSse(["part two."], "stop")));
  const evs = await run({ FREE_MODELS: "groq:m", GROQ_API_KEY: "k" }, f.impl);
  assert.equal(text(evs), "Part one, part two.");
  const second = f.calls[1].body.messages as { role: string; content: string }[];
  assert.equal(second.at(-2)?.role, "assistant");
  assert.equal(second.at(-2)?.content, "Part one, ");
  assert.equal(second.at(-1)?.content, CONTINUE_PROMPT);
  const done = evs.find((e) => e.type === "done") as Extract<StreamEvent, { type: "done" }>;
  assert.equal(done.continued, 1);
});

test("a stream that drops mid-answer is finished by the next tier", async () => {
  const f = fakeFetch((_c, n) =>
    n === 0 ? openAiSse(["Hello ", "wor"], null, { breakAfter: 2 }) : geminiSse([{ candidates: [{ content: { parts: [{ text: "ld!" }] }, finishReason: "STOP" }] }]),
  );
  const evs = await run(ENV, f.impl);
  assert.equal(text(evs), "Hello world!");
  assert.ok(evs.some((e) => e.type === "notice"));
});

test("gemini thought parts are hidden; MAX_TOKENS triggers continuation", async () => {
  const f = fakeFetch((_c, n) =>
    n === 0
      ? geminiSse([{ candidates: [{ content: { parts: [{ text: "secret thinking", thought: true }, { text: "Answer A" }] }, finishReason: "MAX_TOKENS" }] }])
      : geminiSse([{ candidates: [{ content: { parts: [{ text: " and B" }] }, finishReason: "STOP" }] }]),
  );
  const evs = await run({ FREE_MODELS: "gemini:g", GEMINI_API_KEY: "k" }, f.impl);
  assert.equal(text(evs), "Answer A and B");
});

test("everything failing yields one clear error", async () => {
  const f = fakeFetch(() => jsonError(500, "boom"));
  const evs = await run(ENV, f.impl);
  const err = evs.find((e) => e.type === "error") as Extract<StreamEvent, { type: "error" }>;
  assert.ok(err);
  assert.equal(err.attempts.length, 2);
});
