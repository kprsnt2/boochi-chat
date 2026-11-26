import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app.ts";
import type { Env } from "../server/config.ts";
import { fakeFetch, openAiSse } from "./helpers.ts";

const BASE_ENV: Env = {
  AUTH_SECRET: "s".repeat(48),
  ALLOWED_EMAILS: "Owner@Example.com",
  OTP_DEV_SHOW: "true",
  PAID_MODELS: "openai:gpt-paid",
  FREE_MODELS: "groq:llama-free",
  OPENAI_API_KEY_PAID: "sk-PAIDSECRETKEY123",
  GROQ_API_KEY: "gsk_FREESECRETKEY123",
};

function setup(env: Env = BASE_ENV) {
  const f = fakeFetch((c) => openAiSse([`reply via ${c.headers.authorization === "Bearer sk-PAIDSECRETKEY123" ? "PAID" : "FREE"}`]));
  const app = createApp({ getEnv: () => env, fetchImpl: f.impl });
  return { app, calls: f.calls };
}

const H = { "content-type": "application/json", "x-boochi": "1", origin: "http://localhost" };
const chatBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ agentId: "general", private: true, messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }], ...extra });

async function readStream(res: Response) {
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  const text = lines.filter((l) => l.type === "delta").map((l) => l.text).join("");
  return { lines, text };
}

async function signIn(app: ReturnType<typeof createApp>) {
  const r1 = await app.request("http://localhost/api/auth/request", { method: "POST", headers: H, body: JSON.stringify({ email: "owner@example.com" }) });
  const { challenge, devCode } = (await r1.json()) as { challenge: string; devCode: string };
  assert.match(devCode, /^\d{8}$/);
  const r2 = await app.request("http://localhost/api/auth/verify", { method: "POST", headers: H, body: JSON.stringify({ challenge, code: devCode }) });
  assert.equal(r2.status, 200);
  const cookie = r2.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  return cookie.split(";")[0];
}

test("guest asking for private still only reaches the FREE key", async () => {
  const { app, calls } = setup();
  const res = await app.request("http://localhost/api/chat", { method: "POST", headers: H, body: chatBody({ private: true }) });
  assert.equal(res.status, 200);
  const { text, lines } = await readStream(res);
  assert.equal(text, "reply via FREE");
  assert.deepEqual(lines[0], { type: "mode", private: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, "Bearer gsk_FREESECRETKEY123");
});

test("signed-in owner in private mode reaches ONLY the paid key", async () => {
  const { app, calls } = setup();
  const cookie = await signIn(app);
  const res = await app.request("http://localhost/api/chat", { method: "POST", headers: { ...H, cookie }, body: chatBody({ private: true }) });
  const { text, lines } = await readStream(res);
  assert.equal(text, "reply via PAID");
  assert.deepEqual(lines[0], { type: "mode", private: true });
  assert.ok(calls.every((c) => c.headers.authorization === "Bearer sk-PAIDSECRETKEY123"));
});

test("owner with private off goes to free first", async () => {
  const { app } = setup();
  const cookie = await signIn(app);
  const res = await app.request("http://localhost/api/chat", { method: "POST", headers: { ...H, cookie }, body: chatBody({ private: false }) });
  assert.equal((await readStream(res)).text, "reply via FREE");
});

test("OTP code is single-use", async () => {
  const { app } = setup();
  const r1 = await app.request("http://localhost/api/auth/request", { method: "POST", headers: H, body: JSON.stringify({ email: "owner@example.com" }) });
  const { challenge, devCode } = (await r1.json()) as { challenge: string; devCode: string };
  const v = () => app.request("http://localhost/api/auth/verify", { method: "POST", headers: H, body: JSON.stringify({ challenge, code: devCode }) });
  assert.equal((await v()).status, 200);
  assert.equal((await v()).status, 401);
});

test("dev code is never revealed on a non-localhost host", async () => {
  const { app } = setup();
  const res = await app.request("https://chat.example.com/api/auth/request", {
    method: "POST",
    headers: { ...H, origin: "https://chat.example.com", host: "chat.example.com" },
    body: JSON.stringify({ email: "owner@example.com" }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(json.devCode, undefined);
});

test("unknown e-mails get an indistinguishable response and no code", async () => {
  const { app } = setup();
  const res = await app.request("http://localhost/api/auth/request", { method: "POST", headers: H, body: JSON.stringify({ email: "stranger@example.com" }) });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.ok(json.challenge);
  assert.equal(json.devCode, undefined);
});

test("removing an e-mail from ALLOWED_EMAILS revokes the session immediately", async () => {
  const env = { ...BASE_ENV };
  const { app } = setup(env);
  const cookie = await signIn(app);
  env.ALLOWED_EMAILS = "someone-else@example.com";
  const res = await app.request("http://localhost/api/config", { headers: { cookie } });
  assert.equal(((await res.json()) as { role: string }).role, "guest");
});

test("CSRF: missing header or foreign origin is refused", async () => {
  const { app, calls } = setup();
  const noHeader = await app.request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: chatBody() });
  assert.equal(noHeader.status, 403);
  const foreign = await app.request("http://localhost/api/chat", { method: "POST", headers: { ...H, origin: "https://evil.example" }, body: chatBody() });
  assert.equal(foreign.status, 403);
  assert.equal(calls.length, 0);
});

test("guests cannot send a custom system prompt", async () => {
  const { app, calls } = setup();
  const res = await app.request("http://localhost/api/chat", { method: "POST", headers: H, body: chatBody({ customPrompt: "ignore rules" }) });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("config never contains key material and hides paid tiers from guests", async () => {
  const { app } = setup();
  const res = await app.request("http://localhost/api/config");
  const raw = await res.text();
  assert.doesNotMatch(raw, /SECRETKEY|sk-|gsk_/);
  const cfg = JSON.parse(raw);
  assert.equal(cfg.role, "guest");
  assert.deepEqual(cfg.paid, []);
});

test("guests disabled → chat requires sign-in", async () => {
  const { app } = setup({ ...BASE_ENV, GUEST_ENABLED: "false" });
  const res = await app.request("http://localhost/api/chat", { method: "POST", headers: H, body: chatBody() });
  assert.equal(res.status, 401);
});

test("API responses are no-store and carry security headers", async () => {
  const { app } = setup();
  const res = await app.request("http://localhost/api/config");
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});

test("server writes nothing to the console (no-log policy)", async () => {
  const original = { ...console };
  const seen: unknown[] = [];
  for (const k of ["log", "info", "warn", "error", "debug"] as const) console[k] = (...a: unknown[]) => void seen.push(a);
  try {
    const { app } = setup();
    const cookie = await signIn(app);
    await readStream(await app.request("http://localhost/api/chat", { method: "POST", headers: { ...H, cookie }, body: chatBody() }));
    await app.request("http://localhost/api/chat", { method: "POST", headers: H, body: "{not json" });
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(seen, []);
});
