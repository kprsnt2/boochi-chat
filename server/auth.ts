/**
 * Email one-time-code login — stateless, so it works on Cloudflare Workers and
 * Cloud Run without a database.
 *
 *  1. POST /api/auth/request {email}
 *     If the email is in ALLOWED_EMAILS, an 8-digit code is e-mailed (Resend).
 *     The browser gets a signed, 10-minute challenge either way, so the
 *     response never reveals whether an address is allowed.
 *  2. POST /api/auth/verify {challenge, code}
 *     The challenge carries HMAC(secret, nonce|code). A matching code yields
 *     an HttpOnly, Secure, SameSite=Strict session cookie.
 *
 * Every owner request re-checks ALLOWED_EMAILS, so removing an address revokes
 * access immediately. Rotating AUTH_SECRET or bumping SESSION_VERSION signs
 * everyone out. Only WebCrypto is used (portable across runtimes).
 */

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keyCache.set(secret, k);
  }
  return k;
}

async function hmac(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return b64url(new Uint8Array(sig));
}

/** Compact signed token: base64url(json).base64url(hmac). */
export async function signToken(secret: string, payload: Record<string, unknown>): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifyToken<T extends Record<string, unknown>>(
  secret: string,
  token: string | undefined | null,
): Promise<T | null> {
  if (!token || token.length > 4096) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = b64urlDecode(token.slice(dot + 1));
  } catch {
    return null;
  }
  // crypto.subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(body));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as T & { x?: number };
    if (typeof payload.x !== "number" || payload.x < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

/** Uniform 8-digit code from a CSPRNG (rejection sampling, no modulo bias). */
export function generateCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 100_000_000) * 100_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 100_000_000).padStart(8, "0");
  }
}

export const OTP_TTL_MS = 10 * 60 * 1000;

export async function createChallenge(secret: string, email: string, code: string) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const h = await hmac(secret, `otp|${nonce}|${email}|${code}`);
  return signToken(secret, { t: "otp", e: email, n: nonce, h, x: Date.now() + OTP_TTL_MS });
}

/** Returns the email on success. */
export async function checkChallenge(secret: string, challenge: string, code: string): Promise<{ email: string; nonce: string } | null> {
  const p = await verifyToken<{ t: string; e: string; n: string; h: string }>(secret, challenge);
  if (!p || p.t !== "otp") return null;
  const cleaned = String(code ?? "").replace(/\D/g, "");
  if (cleaned.length !== 8) return null;
  const expect = await hmac(secret, `otp|${p.n}|${p.e}|${cleaned}`);
  // Both strings are fixed-length base64url HMACs; compare without early exit.
  if (expect.length !== p.h.length) return null;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ p.h.charCodeAt(i);
  return diff === 0 ? { email: p.e, nonce: p.n } : null;
}

export async function createSession(secret: string, email: string, days: number, version: string) {
  return signToken(secret, { t: "s", e: email, v: version, x: Date.now() + days * 86_400_000 });
}

export async function readSession(secret: string, token: string | undefined, version: string) {
  const p = await verifyToken<{ t: string; e: string; v: string }>(secret, token);
  if (!p || p.t !== "s" || p.v !== version) return null;
  return { email: p.e };
}

/* ------------------------------------------------------------------------ */
/* e-mail delivery (Resend HTTP API — works on every runtime)               */
/* ------------------------------------------------------------------------ */

export async function sendCodeEmail(opts: {
  resendKey: string;
  from: string;
  to: string;
  code: string;
  appName: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const pretty = `${opts.code.slice(0, 4)} ${opts.code.slice(4)}`;
  const res = await (opts.fetchImpl ?? fetch)("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${opts.resendKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: opts.from,
      to: [opts.to],
      subject: `Your ${opts.appName} code: ${pretty}`,
      text:
        `Your sign-in code is ${pretty}\n\n` +
        `It expires in 10 minutes. If you did not try to sign in, ignore this e-mail — ` +
        `nobody can sign in without this code.`,
      // Opt out of open/click tracking on our side.
      headers: { "X-Entity-Ref-ID": crypto.randomUUID() },
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  return Boolean(res?.ok);
}

/* ------------------------------------------------------------------------ */
/* best-effort in-memory rate limiting                                      */
/* ------------------------------------------------------------------------ */

/**
 * Sliding-window counter per key. Memory is per instance/isolate, so this is
 * a speed bump, not a wall: add a Cloudflare rate-limiting rule (see README)
 * for a hard global limit. Keys are hashed so no raw IP or e-mail sits in memory.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private limit: number;
  private windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  take(key: string, now = Date.now()): boolean {
    if (this.limit <= 0) return true;
    const from = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > from);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.sweep(now);
    return true;
  }
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => t > now - this.windowMs)) this.hits.delete(k);
  }
}

export async function hashKey(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return b64url(new Uint8Array(d)).slice(0, 22);
}

/** Nonces already redeemed on this instance (best effort single-use). */
export class UsedNonces {
  private m = new Map<string, number>();
  use(nonce: string, now = Date.now()): boolean {
    for (const [k, exp] of this.m) if (exp < now) this.m.delete(k);
    if (this.m.has(nonce)) return false;
    this.m.set(nonce, now + OTP_TTL_MS);
    return true;
  }
}
