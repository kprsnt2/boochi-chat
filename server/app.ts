/**
 * The API. Runtime-agnostic (Cloudflare Workers + Node/Cloud Run).
 *
 * NO-LOG POLICY: this file never calls console.*, never stores a request,
 * and returns `Cache-Control: no-store` on every API response. Chats are
 * streamed straight from the provider to the browser and forgotten.
 */

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AGENT_BY_ID, MAX_CUSTOM_PROMPT_CHARS, systemPromptFor } from "../shared/agents.ts";
import type { ChatRequest, ContentPart, PublicConfig, Role, WireMessage } from "../shared/types.ts";
import {
  RateLimiter,
  UsedNonces,
  checkChallenge,
  createChallenge,
  createSession,
  generateCode,
  hashKey,
  normalizeEmail,
  readSession,
  sendCodeEmail,
} from "./auth.ts";
import { apiKeyFor, freeTiers, paidTiers, settings, toPublicTier, type Env, type Settings } from "./config.ts";
import { listModels } from "./providers.ts";
import { planChain, runChat } from "./router.ts";
import { SECURITY_HEADERS } from "./security.ts";

export interface AppOptions {
  /** Read env for this request (Workers bindings or process.env). */
  getEnv: (c: Context) => Env;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Optional platform rate limiter (Cloudflare Rate Limiting binding). */
  platformLimit?: (c: Context, key: string) => Promise<boolean>;
}

type Identity = { role: "owner"; email: string } | { role: "guest" } | null;

const MIN_SECRET = 32;

export function createApp(opts: AppOptions) {
  const app = new Hono();
  const fetchImpl = opts.fetchImpl;

  // Per-instance, best-effort limits. Keys are hashed.
  const otpPerIp = new RateLimiter(6, 15 * 60_000);
  const otpPerEmail = new RateLimiter(3, 15 * 60_000);
  const verifyPerIp = new RateLimiter(12, 15 * 60_000);
  const usedNonces = new UsedNonces();
  let guestMinute: RateLimiter | null = null;
  let guestDay: RateLimiter | null = null;

  const envOf = (c: Context) => opts.getEnv(c);

  /* ------------------------------ helpers ------------------------------- */

  const isHttps = (c: Context) =>
    new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";
  const cookieName = (c: Context) => (isHttps(c) ? "__Host-boochi" : "boochi");

  const clientIp = (c: Context) =>
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  async function identify(c: Context, s: Settings): Promise<Identity> {
    if (s.authSecret.length >= MIN_SECRET) {
      const token = getCookie(c, cookieName(c));
      const session = await readSession(s.authSecret, token, s.sessionVersion);
      if (session && s.allowedEmails.has(session.email)) return { role: "owner", email: session.email };
    }
    return s.guestEnabled ? { role: "guest" } : null;
  }

  const err = (c: Context, status: number, error: string) =>
    c.json({ ok: false, error }, status as 400);

  /* ----------------------------- middleware ----------------------------- */

  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
    if (new URL(c.req.url).pathname.startsWith("/api/")) {
      c.res.headers.set("Cache-Control", "no-store, max-age=0");
      c.res.headers.set("Pragma", "no-cache");
    }
  });

  // CSRF: state-changing calls must be same-origin AND carry our custom header
  // (which a cross-site form cannot set without a CORS preflight we never allow).
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (c.req.header("x-boochi") !== "1") return err(c, 403, "Forbidden.");
      const origin = c.req.header("origin");
      if (origin) {
        const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
        let originHost = "";
        try {
          originHost = new URL(origin).host;
        } catch {
          /* invalid */
        }
        if (originHost !== host) return err(c, 403, "Cross-origin request blocked.");
      }
    }
    await next();
  });

  /* ------------------------------- config ------------------------------- */

  app.get("/api/config", async (c) => {
    const env = envOf(c);
    const s = settings(env);
    const who = await identify(c, s);
    const role: Role | null = who?.role ?? null;
    const cfg: PublicConfig = {
      appName: s.appName,
      role,
      email: who?.role === "owner" ? who.email : null,
      guestEnabled: s.guestEnabled,
      emailLoginEnabled:
        s.authSecret.length >= MIN_SECRET && s.allowedEmails.size > 0 && ((Boolean(s.resendKey) && Boolean(s.mailFrom)) || s.otpDevShow),
      // Guests never even learn which paid models exist.
      paid: role === "owner" ? paidTiers(env).map((t) => toPublicTier(env, t)) : [],
      free: role ? freeTiers(env).map((t) => toPublicTier(env, t)) : [],
      limits: { maxRequestMB: s.maxRequestMB },
    };
    return c.json(cfg);
  });

  /* -------------------------------- auth -------------------------------- */

  app.post("/api/auth/request", async (c) => {
    const env = envOf(c);
    const s = settings(env);
    if (s.authSecret.length < MIN_SECRET) return err(c, 503, "Login is not configured (AUTH_SECRET).");
    const body = await readJson(c, 4096);
    const email = normalizeEmail(body?.email);
    if (!email) return err(c, 400, "Enter a valid e-mail address.");

    const ipKey = await hashKey(`ip|${clientIp(c)}`);
    if (!otpPerIp.take(ipKey) || !otpPerEmail.take(await hashKey(`em|${email}`))) {
      return err(c, 429, "Too many codes requested. Wait a few minutes and try again.");
    }
    if (opts.platformLimit && !(await opts.platformLimit(c, `otp:${ipKey}`))) {
      return err(c, 429, "Too many requests. Try again later.");
    }

    const code = generateCode();
    const challenge = await createChallenge(s.authSecret, email, code);
    const host = new URL(c.req.url).hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    let devCode: string | undefined;

    if (s.allowedEmails.has(email)) {
      if (s.otpDevShow && isLocal) {
        devCode = code; // local development only; never on a real host
      } else if (s.resendKey && s.mailFrom) {
        const sent = await sendCodeEmail({ resendKey: s.resendKey, from: s.mailFrom, to: email, code, appName: s.appName, fetchImpl });
        if (!sent) return err(c, 502, "Could not send the e-mail. Try again shortly.");
      } else {
        return err(c, 503, "E-mail delivery is not configured (RESEND_API_KEY and MAIL_FROM).");
      }
    }
    // Same response shape whether or not the address is allowed.
    return c.json({ ok: true, challenge, ...(devCode ? { devCode } : {}) });
  });

  app.post("/api/auth/verify", async (c) => {
    const env = envOf(c);
    const s = settings(env);
    if (s.authSecret.length < MIN_SECRET) return err(c, 503, "Login is not configured.");
    if (!verifyPerIp.take(await hashKey(`v|${clientIp(c)}`))) {
      return err(c, 429, "Too many attempts. Wait a few minutes.");
    }
    const body = await readJson(c, 8192);
    const result = await checkChallenge(s.authSecret, String(body?.challenge ?? ""), String(body?.code ?? ""));
    if (!result || !s.allowedEmails.has(result.email)) return err(c, 401, "That code is wrong or has expired.");
    if (!usedNonces.use(result.nonce)) return err(c, 401, "That code was already used. Request a new one.");

    const token = await createSession(s.authSecret, result.email, s.sessionDays, s.sessionVersion);
    setCookie(c, cookieName(c), token, {
      httpOnly: true,
      secure: isHttps(c),
      sameSite: "Strict",
      path: "/",
      maxAge: s.sessionDays * 86_400,
    });
    return c.json({ ok: true, email: result.email });
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, "boochi", { path: "/" });
    deleteCookie(c, "__Host-boochi", { path: "/", secure: true });
    return c.json({ ok: true });
  });

  /* -------------------------------- chat -------------------------------- */

  app.post("/api/chat", async (c) => {
    const env = envOf(c);
    const s = settings(env);
    const who = await identify(c, s);
    if (!who) return err(c, 401, "Sign in to use this app.");

    if (who.role === "guest") {
      const key = await hashKey(`g|${clientIp(c)}`);
      if (!guestMinute || !guestDay) {
        guestMinute = new RateLimiter(s.guestPerMinute, 60_000);
        guestDay = new RateLimiter(s.guestPerDay, 86_400_000);
      }
      if (!guestMinute.take(key) || !guestDay.take(key)) {
        return err(c, 429, "Guest limit reached. Wait a bit, or sign in.");
      }
      if (opts.platformLimit && !(await opts.platformLimit(c, `guest:${key}`))) {
        return err(c, 429, "Guest limit reached. Try again later.");
      }
    }

    const maxBytes = s.maxRequestMB * 1024 * 1024;
    const body = await readJson(c, maxBytes);
    if (body === TOO_LARGE) return err(c, 413, `Request is over ${s.maxRequestMB} MB. Remove some attachments.`);
    const parsed = validateChat(body, who.role);
    if (typeof parsed === "string") return err(c, 400, parsed);

    const agent = AGENT_BY_ID[parsed.agentId];
    const system = parsed.customPrompt
      ? systemPromptFor({ systemPrompt: parsed.customPrompt })
      : systemPromptFor(agent ?? AGENT_BY_ID.general);

    const plan = planChain(env, {
      role: who.role,
      privateRequested: parsed.private,
      agentAlwaysPrivate: Boolean(agent?.alwaysPrivate),
      pinned: parsed.model,
    });
    if (!plan.ok) return err(c, plan.status, plan.error);

    const ctl = new AbortController();
    c.req.raw.signal?.addEventListener?.("abort", () => ctl.abort(), { once: true });

    const gen = runChat({
      env,
      chain: plan.chain,
      system,
      messages: parsed.messages,
      signal: ctl.signal,
      autoContinueMax: s.autoContinueMax,
      fetchImpl,
    });
    const encoder = new TextEncoder();
    const head = [
      { type: "mode", private: plan.private },
      ...plan.notices.map((text) => ({ type: "notice", text })),
    ];

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = head.shift();
        if (next) {
          controller.enqueue(encoder.encode(`${JSON.stringify(next)}\n`));
          return;
        }
        try {
          const { value, done } = await gen.next();
          if (done) controller.close();
          else controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        } catch {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", message: "Server error.", attempts: [] })}\n`));
          controller.close();
        }
      },
      cancel() {
        ctl.abort();
        void gen.return(undefined);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });

  /* --------------------------- diagnostics ------------------------------ */

  app.get("/api/models/check", async (c) => {
    const env = envOf(c);
    const s = settings(env);
    const who = await identify(c, s);
    if (who?.role !== "owner") return err(c, 403, "Owners only.");
    const tiers = [...paidTiers(env), ...freeTiers(env)];
    const cache = new Map<string, Promise<string[]>>();
    const results = await Promise.all(
      tiers.map(async (t) => {
        if (!apiKeyFor(env, t)) return { id: t.id, label: t.label, tier: t.kind, status: "no-key" as const };
        const cacheKey = `${t.kind}:${t.provider.id}`;
        if (!cache.has(cacheKey)) cache.set(cacheKey, listModels(env, t, fetchImpl));
        try {
          const ids = await cache.get(cacheKey)!;
          if (ids.includes(t.model)) return { id: t.id, label: t.label, tier: t.kind, status: "ok" as const };
          const needle = t.model.toLowerCase().split(/[/:]/).pop()!.slice(0, 10);
          const suggestions = ids.filter((m) => m.toLowerCase().includes(needle)).slice(0, 6);
          return { id: t.id, label: t.label, tier: t.kind, status: "missing" as const, suggestions };
        } catch (e) {
          return { id: t.id, label: t.label, tier: t.kind, status: "error" as const, error: (e as Error).message };
        }
      }),
    );
    return c.json({ ok: true, results });
  });

  app.notFound((c) => err(c, 404, "Not found."));
  // Generic message only: stack traces and request data never leave the server.
  app.onError((_e, c) => err(c, 500, "Server error."));

  return app;
}

/* ------------------------------------------------------------------------ */
/* request parsing / validation                                             */
/* ------------------------------------------------------------------------ */

const TOO_LARGE = Symbol("too-large");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(c: Context, maxBytes: number): Promise<any> {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > maxBytes) return TOO_LARGE;
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return null;
  }
  if (text.length > maxBytes) return TOO_LARGE;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const MAX_MESSAGES = 400;
const MAX_PARTS = 80;
const B64 = /^[A-Za-z0-9+/=\s]*$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);

export function validateChat(body: unknown, role: Role): ChatRequest | string {
  if (!body || typeof body !== "object") return "Malformed request.";
  const b = body as Record<string, unknown>;
  const agentId = typeof b.agentId === "string" ? b.agentId : "";
  const customPrompt = typeof b.customPrompt === "string" ? b.customPrompt.trim() : "";

  if (customPrompt) {
    if (role !== "owner") return "Custom agents are available to signed-in owners only.";
    if (customPrompt.length > MAX_CUSTOM_PROMPT_CHARS) return "Custom agent prompt is too long.";
  } else if (!AGENT_BY_ID[agentId]) {
    return "Unknown agent.";
  }

  if (!Array.isArray(b.messages) || !b.messages.length) return "No messages.";
  if (b.messages.length > MAX_MESSAGES) return "Conversation is too long; start a new chat.";

  const messages: WireMessage[] = [];
  let partCount = 0;
  for (const m of b.messages as unknown[]) {
    const mm = m as Record<string, unknown>;
    if (mm?.role !== "user" && mm?.role !== "assistant") return "Bad message role.";
    if (!Array.isArray(mm.parts)) return "Bad message parts.";
    const parts: ContentPart[] = [];
    for (const p of mm.parts as unknown[]) {
      if (++partCount > MAX_PARTS * 10) return "Too many attachments.";
      const pp = p as Record<string, unknown>;
      if (pp?.type === "text" && typeof pp.text === "string") {
        parts.push({ type: "text", text: pp.text });
      } else if (pp?.type === "image" && mm.role === "user") {
        if (typeof pp.mimeType !== "string" || !IMAGE_TYPES.has(pp.mimeType)) return "Unsupported image type.";
        if (typeof pp.data !== "string" || !B64.test(pp.data.slice(0, 2048))) return "Bad image data.";
        parts.push({ type: "image", mimeType: pp.mimeType, data: pp.data, name: str(pp.name, 200) });
      } else if (pp?.type === "pdf" && mm.role === "user") {
        const data = typeof pp.data === "string" ? pp.data : undefined;
        if (data && !B64.test(data.slice(0, 2048))) return "Bad PDF data.";
        parts.push({
          type: "pdf",
          name: str(pp.name, 200) ?? "document.pdf",
          data,
          text: typeof pp.text === "string" ? pp.text : undefined,
        });
      } else {
        return "Bad message part.";
      }
    }
    messages.push({ role: mm.role, parts });
  }
  if (messages[messages.length - 1].role !== "user") return "The last message must be from the user.";

  return {
    agentId: AGENT_BY_ID[agentId] ? agentId : "general",
    private: role === "owner" && b.private !== false, // default ON for owners
    model: typeof b.model === "string" && b.model ? b.model.slice(0, 300) : null,
    messages,
    customPrompt: customPrompt || null,
  };
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}
