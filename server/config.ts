/**
 * Server configuration, read from environment variables on every request
 * (Cloudflare bindings or process.env). Nothing here is ever sent to the
 * browser except through toPublicTier(), which never includes a key.
 *
 * KEY CONVENTION
 *   <PROVIDER>_API_KEY_PAID  -> used ONLY by "paid" tiers (Private mode)
 *   <PROVIDER>_API_KEY       -> used ONLY by "free" tiers (guests / Private off)
 *   e.g. GEMINI_API_KEY_PAID=...  GEMINI_API_KEY=...  GROQ_API_KEY=...
 *
 * A paid tier can never pick up a free key and vice versa, so a private chat
 * cannot reach a provider account whose terms allow training.
 */

import type { TierInfo, TierKind } from "../shared/types.ts";

export type Env = Record<string, string | undefined>;

export type ProviderKind = "openai" | "gemini";

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Default base URL (…/v1 for OpenAI-compatible). Overridable with <ID>_BASE_URL. */
  baseUrl?: string;
  /** True for providers defined purely through env variables. */
  custom?: boolean;
}

/** Built-in providers. Any of them can be re-pointed with <ID>_BASE_URL. */
export const PROVIDERS: Record<string, ProviderDef> = {
  gemini: { id: "gemini", label: "Gemini", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  openai: { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1" },
  groq: { id: "groq", label: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  cerebras: { id: "cerebras", label: "Cerebras", kind: "openai", baseUrl: "https://api.cerebras.ai/v1" },
  openrouter: { id: "openrouter", label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  nvidia: { id: "nvidia", label: "NVIDIA", kind: "openai", baseUrl: "https://integrate.api.nvidia.com/v1" },
  mistral: { id: "mistral", label: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1" },
  deepseek: { id: "deepseek", label: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com" },
  together: { id: "together", label: "Together", kind: "openai", baseUrl: "https://api.together.xyz/v1" },
  github: { id: "github", label: "GitHub Models", kind: "openai", baseUrl: "https://models.github.ai/inference" },
};

/**
 * Default chains — latest low-cost models (checked Nov 2026). Override without a
 * rebuild via PAID_MODELS / FREE_MODELS ("provider:model" in priority order).
 * Tiers whose key is missing are skipped silently, so listing many is harmless.
 * Use Settings → "Check model IDs" to verify them against each provider.
 */
export const DEFAULT_PAID_MODELS = "gemini:gemini-3.5-flash-lite,openai:gpt-5.4-mini,gemini:gemini-flash-latest";
export const DEFAULT_FREE_MODELS = [
  "openai:gpt-5.4-mini",
  "gemini:gemini-3.5-flash-lite",
  "groq:openai/gpt-oss-120b",
  "cerebras:gpt-oss-120b",
  "openrouter:openai/gpt-oss-120b:free",
  "github:openai/gpt-4.1-mini",
  "nvidia:openai/gpt-oss-120b",
  "mistral:mistral-small-latest",
  "deepseek:deepseek-flash",
].join(",");

export interface Tier {
  id: string; // "kind:provider:model"
  kind: TierKind;
  provider: ProviderDef;
  model: string;
  label: string;
  vision: boolean;
  pdfNative: boolean;
}

/** Best-effort capability guess from the model name. Override with ";vision" / ";text" suffix. */
export function guessVision(provider: ProviderDef, model: string): boolean {
  if (provider.kind === "gemini") return true;
  if (provider.custom) return false;
  return /vision|-vl|vl-|gpt-4o|gpt-4\.1|gpt-5|o3|o4|llama-4|scout|maverick|pixtral|gemma-3|gemma-4|qwen.*vl|claude|grok-4|mistral-medium|mistral-small|deepseek-flash/i.test(
    model,
  );
}

const ENV_ID = /^[a-z][a-z0-9_]{0,31}$/;
const envPrefix = (id: string) => id.toUpperCase();

/**
 * Resolve a provider id. Built-ins come from PROVIDERS; anything else is a
 * CUSTOM provider defined entirely by env, e.g. for id "myllm":
 *   MYLLM_BASE_URL=https://my-gateway/v1   (required; or MYLLM_BASE_URL_PAID)
 *   MYLLM_API_KEY / MYLLM_API_KEY_PAID      (keys, as usual)
 *   MYLLM_KIND=openai|gemini                (optional, default openai)
 *   MYLLM_LABEL=My LLM                      (optional)
 */
export function resolveProvider(id: string, env: Env): ProviderDef | null {
  const pid = id.trim().toLowerCase();
  if (!ENV_ID.test(pid)) return null;
  const builtin = PROVIDERS[pid];
  const label = env[`${envPrefix(pid)}_LABEL`]?.trim();
  if (builtin) return label ? { ...builtin, label } : builtin;
  const base = env[`${envPrefix(pid)}_BASE_URL`]?.trim() || env[`${envPrefix(pid)}_BASE_URL_PAID`]?.trim();
  if (!base) return null;
  const kind: ProviderKind = env[`${envPrefix(pid)}_KIND`]?.trim().toLowerCase() === "gemini" ? "gemini" : "openai";
  return { id: pid, label: label || pid, kind, baseUrl: base, custom: true };
}

function prettyLabel(provider: ProviderDef, model: string): string {
  const short = model.split("/").pop()!.replace(/:free$/, "");
  return `${provider.label} · ${short}`;
}

export function parseTiers(spec: string, kind: TierKind, env: Env = {}): Tier[] {
  const out: Tier[] = [];
  const seen = new Set<string>();
  for (const raw of spec.split(",")) {
    let item = raw.trim();
    if (!item) continue;
    let visionOverride: boolean | undefined;
    const flag = item.match(/;(vision|text)$/i);
    if (flag) {
      visionOverride = flag[1].toLowerCase() === "vision";
      item = item.slice(0, -flag[0].length);
    }
    const idx = item.indexOf(":");
    if (idx <= 0) continue;
    const provider = resolveProvider(item.slice(0, idx), env);
    const model = item.slice(idx + 1).trim();
    if (!provider || !model) continue;
    const id = `${kind}:${provider.id}:${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind,
      provider,
      model,
      label: prettyLabel(provider, model),
      vision: visionOverride ?? guessVision(provider, model),
      pdfNative: provider.kind === "gemini",
    });
  }
  return out;
}

export function keyEnvName(providerId: string, kind: TierKind): string {
  return `${envPrefix(providerId)}_API_KEY${kind === "paid" ? "_PAID" : ""}`;
}

export function apiKeyFor(env: Env, tier: Pick<Tier, "provider" | "kind">): string | undefined {
  const v = env[keyEnvName(tier.provider.id, tier.kind)]?.trim();
  return v ? v : undefined;
}

/**
 * Base URL for a tier. Paid tiers may use their own endpoint:
 *   <ID>_BASE_URL_PAID (paid chain only) → <ID>_BASE_URL → built-in default.
 */
export function baseUrlFor(env: Env, provider: ProviderDef, kind: TierKind = "free"): string {
  const p = envPrefix(provider.id);
  const url =
    (kind === "paid" ? env[`${p}_BASE_URL_PAID`]?.trim() : "") || env[`${p}_BASE_URL`]?.trim() || provider.baseUrl || "";
  return url.replace(/\/+$/, "");
}

export function paidTiers(env: Env): Tier[] {
  return parseTiers(env.PAID_MODELS || DEFAULT_PAID_MODELS, "paid", env);
}

export function freeTiers(env: Env): Tier[] {
  return parseTiers(env.FREE_MODELS || DEFAULT_FREE_MODELS, "free", env);
}

export function toPublicTier(env: Env, t: Tier): TierInfo {
  return {
    id: t.id,
    provider: t.provider.id,
    model: t.model,
    label: t.label,
    tier: t.kind,
    configured: Boolean(apiKeyFor(env, t)),
    vision: t.vision,
    pdfNative: t.pdfNative,
  };
}

/* ------------------------------ app settings ------------------------------ */

const truthy = (v: string | undefined, dflt: boolean) =>
  v === undefined || v.trim() === "" ? dflt : /^(1|true|yes|on)$/i.test(v.trim());

const int = (v: string | undefined, dflt: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

export function settings(env: Env) {
  return {
    appName: (env.APP_NAME?.trim() || "Boochi Chat").slice(0, 40),
    authSecret: env.AUTH_SECRET?.trim() ?? "",
    allowedEmails: new Set(
      (env.ALLOWED_EMAILS ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
    guestEnabled: truthy(env.GUEST_ENABLED, true),
    sessionDays: Math.max(1, int(env.SESSION_DAYS, 7)),
    sessionVersion: env.SESSION_VERSION?.trim() || "1",
    resendKey: env.RESEND_API_KEY?.trim() ?? "",
    /** Sender for OTP e-mails — from env only, never hard-coded. */
    mailFrom: env.MAIL_FROM?.trim() ?? "",
    /** Local development only: show the OTP in the UI when the host is localhost. */
    otpDevShow: truthy(env.OTP_DEV_SHOW, false),
    guestPerMinute: int(env.GUEST_RPM, 8),
    guestPerDay: int(env.GUEST_RPD, 150),
    /** Upper bound on automatic "continue" round-trips for answers cut off by a provider. */
    autoContinueMax: Math.min(20, int(env.AUTO_CONTINUE_MAX, 8)),
    maxRequestMB: Math.min(95, Math.max(1, int(env.MAX_REQUEST_MB, 30))),
  };
}

export type Settings = ReturnType<typeof settings>;
