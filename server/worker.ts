/**
 * Cloudflare Workers entry. Static files come from the ASSETS binding
 * (headers from public/_headers); only /api/* reaches this code
 * (see run_worker_first in wrangler.jsonc).
 */

import { createApp } from "./app.ts";
import type { Env } from "./config.ts";

interface CfEnv {
  ASSETS: { fetch(req: Request): Promise<Response> };
  /** Optional: Workers Rate Limiting binding (see wrangler.jsonc). */
  GUEST_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  [key: string]: unknown;
}

function stringEnv(env: CfEnv): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

const app = createApp({
  getEnv: (c) => stringEnv(c.env as CfEnv),
  platformLimit: async (c, key) => {
    const limiter = (c.env as CfEnv).GUEST_LIMITER;
    if (!limiter) return true;
    return (await limiter.limit({ key })).success;
  },
});

export default {
  fetch(req: Request, env: CfEnv, ctx: unknown): Response | Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/api/")) return app.fetch(req, env, ctx as never);
    return env.ASSETS.fetch(req);
  },
};
