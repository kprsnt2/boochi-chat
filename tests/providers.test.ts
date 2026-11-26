import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { baseUrlFor, freeTiers, paidTiers, type Env } from "../server/config.ts";
import { runChat } from "../server/router.ts";
import type { WireMessage } from "../shared/types.ts";
import { collect, fakeFetch, openAiSse } from "./helpers.ts";

const USER: WireMessage[] = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];
const run = (env: Env, kind: "free" | "paid", f: typeof fetch) =>
  collect(
    runChat({
      env,
      chain: kind === "paid" ? paidTiers(env) : freeTiers(env),
      system: "s",
      messages: USER,
      signal: new AbortController().signal,
      autoContinueMax: 0,
      fetchImpl: f,
    }),
  );

test("custom provider is defined purely by env (URL + key)", async () => {
  const env: Env = { FREE_MODELS: "myllm:local-model", MYLLM_BASE_URL: "http://gateway.internal/v1/", MYLLM_API_KEY: "k1", MYLLM_LABEL: "My LLM" };
  const [tier] = freeTiers(env);
  assert.equal(tier.label, "My LLM · local-model");
  const f = fakeFetch(() => openAiSse(["ok"]));
  await run(env, "free", f.impl);
  assert.equal(f.calls[0].url, "http://gateway.internal/v1/chat/completions");
  assert.equal(f.calls[0].headers.authorization, "Bearer k1");
});

test("unknown provider without a URL is ignored", () => {
  assert.deepEqual(freeTiers({ FREE_MODELS: "nope:model" }), []);
});

test("paid chain can use its own endpoint via <ID>_BASE_URL_PAID", async () => {
  const env: Env = {
    PAID_MODELS: "openai:m",
    FREE_MODELS: "openai:m",
    OPENAI_API_KEY: "free",
    OPENAI_API_KEY_PAID: "paid",
    OPENAI_BASE_URL: "https://free.example/v1",
    OPENAI_BASE_URL_PAID: "https://paid.example/v1",
  };
  const f = fakeFetch(() => openAiSse(["ok"]));
  await run(env, "paid", f.impl);
  await run(env, "free", f.impl);
  assert.equal(f.calls[0].url, "https://paid.example/v1/chat/completions");
  assert.equal(f.calls[1].url, "https://free.example/v1/chat/completions");
});

test("built-in providers can be re-pointed; DeepSeek default endpoint", () => {
  const ds = freeTiers({ FREE_MODELS: "deepseek:deepseek-flash" })[0];
  assert.equal(baseUrlFor({}, ds.provider), "https://api.deepseek.com");
  assert.equal(baseUrlFor({ DEEPSEEK_BASE_URL: "https://proxy/v1" }, ds.provider), "https://proxy/v1");
});

test("default chains use the requested low-cost models", () => {
  const free = freeTiers({}).map((t) => `${t.provider.id}:${t.model}`);
  const paid = paidTiers({}).map((t) => `${t.provider.id}:${t.model}`);
  assert.equal(free[0], "openai:gpt-5.4-mini");
  assert.ok(free.includes("deepseek:deepseek-flash"));
  assert.ok(paid.includes("openai:gpt-5.4-mini"));
  assert.ok(paid.some((m) => m.startsWith("gemini:")));
});

test("no e-mail address is hard-coded in shipped code or config", () => {
  const roots = ["server", "shared", "src", "public", "index.html", "wrangler.jsonc", "Dockerfile"];
  const files: string[] = [];
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
    else files.push(p);
  };
  for (const r of roots) walk(r);
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
  const hits = files.filter((f) => email.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});
