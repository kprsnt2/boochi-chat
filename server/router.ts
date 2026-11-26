/**
 * Routing policy — the privacy guarantees live here, on the server, so the
 * browser cannot talk its way around them.
 *
 *   identity  Private  chain
 *   --------  -------  -----------------------------------------------
 *   owner     ON       paid tiers ONLY. Hard block: never falls to free.
 *   owner     OFF      free tiers first, then paid tiers as backup.
 *   guest     (n/a)    free tiers ONLY. Paid keys are unreachable.
 *
 * Sensitive agents (alwaysPrivate) force Private ON for owners.
 * "Temp" mode is a browser concern (nothing is written to disk); the server
 * is stateless and log-free in every mode. Private + Temp = Boochi 👻.
 */

import { CONTINUE_PROMPT, type Attempt, type Role, type ServedBy, type StreamEvent, type WireMessage } from "../shared/types.ts";
import { apiKeyFor, freeTiers, paidTiers, type Env, type Tier } from "./config.ts";
import { ProviderError, streamCompletion, type Finish } from "./providers.ts";

export interface PlanInput {
  role: Role;
  privateRequested: boolean;
  agentAlwaysPrivate: boolean;
  pinned?: string | null;
}

export type Plan =
  | { ok: true; chain: Tier[]; private: boolean; notices: string[] }
  | { ok: false; status: number; error: string };

export function planChain(env: Env, input: PlanInput): Plan {
  const configured = (t: Tier) => Boolean(apiKeyFor(env, t));
  const paid = paidTiers(env).filter(configured);
  const free = freeTiers(env).filter(configured);
  const notices: string[] = [];

  let isPrivate: boolean;
  let chain: Tier[];

  if (input.role === "guest") {
    isPrivate = false;
    chain = free;
    if (!chain.length) {
      return { ok: false, status: 503, error: "No free models are configured on this server." };
    }
  } else {
    isPrivate = input.privateRequested || input.agentAlwaysPrivate;
    if (isPrivate && !input.privateRequested) {
      notices.push("This agent handles sensitive topics, so it always uses Private (paid, no-training) models.");
    }
    chain = isPrivate ? paid : [...free, ...paid];
    if (!chain.length) {
      return {
        ok: false,
        status: 503,
        error: isPrivate
          ? "Private mode needs at least one paid key (e.g. GEMINI_API_KEY_PAID). Nothing was sent."
          : "No model keys are configured on this server.",
      };
    }
  }

  if (input.pinned) {
    const pin = chain.find((t) => t.id === input.pinned);
    if (!pin) {
      // Most important case: a free model pinned while Private is on.
      return {
        ok: false,
        status: 403,
        error: isPrivate
          ? "That model is not private. Pick a paid model or turn Private off. Nothing was sent."
          : "That model is not available to you.",
      };
    }
    chain = [pin, ...chain.filter((t) => t !== pin)];
  }

  return { ok: true, chain, private: isPrivate, notices };
}

/** Put tiers that can read this request's attachments first (stable). */
export function orderForContent(chain: Tier[], messages: WireMessage[]): Tier[] {
  const parts = messages.flatMap((m) => m.parts);
  const needsVision = parts.some((p) => p.type === "image");
  const needsPdf = parts.some((p) => p.type === "pdf" && !p.text?.trim() && p.data);
  if (!needsVision && !needsPdf) return chain;
  const score = (t: Tier) => (needsVision && !t.vision ? 1 : 0) + (needsPdf && !t.pdfNative ? 1 : 0);
  return chain
    .map((t, i) => ({ t, i, s: score(t) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.t);
}

export { CONTINUE_PROMPT };

export interface RunInput {
  env: Env;
  chain: Tier[];
  system: string;
  messages: WireMessage[];
  signal: AbortSignal;
  autoContinueMax: number;
  fetchImpl?: typeof fetch;
}

/**
 * Walk the chain. A tier that fails before producing text is skipped.
 * If a tier stops early (token ceiling or a dropped stream), the next
 * request continues from the partial answer — the same tier for a ceiling,
 * the next tier for an error — so the user always gets one complete reply.
 */
export async function* runChat(input: RunInput): AsyncGenerator<StreamEvent> {
  const chain = orderForContent(input.chain, input.messages);
  const attempts: Attempt[] = [];
  let output = "";
  let continued = 0;
  let servedBy: ServedBy | null = null;
  let ti = 0;

  while (ti < chain.length) {
    const tier = chain[ti];
    const started = Date.now();
    const isContinuation = output.length > 0;
    const messages: WireMessage[] = isContinuation
      ? [
          ...input.messages,
          { role: "assistant", parts: [{ type: "text", text: output }] },
          { role: "user", parts: [{ type: "text", text: CONTINUE_PROMPT }] },
        ]
      : input.messages;

    let finish: Finish = "length";
    let gotText = false;
    try {
      for await (const ev of streamCompletion({
        env: input.env,
        tier,
        system: input.system,
        messages,
        signal: input.signal,
        fetchImpl: input.fetchImpl,
      })) {
        if (ev.type === "text") {
          if (!gotText) {
            gotText = true;
            if (!servedBy || servedBy.model !== tier.model || servedBy.provider !== tier.provider.id) {
              servedBy = { provider: tier.provider.id, model: tier.model, label: tier.label, tier: tier.kind };
              yield { type: "start", servedBy };
            }
          }
          output += ev.text;
          yield { type: "delta", text: ev.text };
        } else {
          finish = ev.finish;
        }
      }
      attempts.push({
        provider: tier.provider.id,
        model: tier.model,
        tier: tier.kind,
        ok: true,
        ms: Date.now() - started,
        continuation: isContinuation || undefined,
      });

      if (finish === "length" && continued < input.autoContinueMax) {
        continued++;
        continue; // same tier picks up where it stopped
      }
      if (finish === "length") {
        yield {
          type: "notice",
          text: `The answer is very long and was still going after ${continued} automatic continuations. Press Continue to keep going.`,
        };
      }
      yield { type: "done", servedBy: servedBy!, attempts, continued, incomplete: finish === "length" };
      return;
    } catch (err) {
      if (input.signal.aborted) {
        attempts.push({ provider: tier.provider.id, model: tier.model, tier: tier.kind, ok: false, ms: Date.now() - started, error: "Cancelled." });
        yield { type: "error", message: "Stopped.", attempts };
        return;
      }
      const message = err instanceof ProviderError || err instanceof Error ? err.message : "Unknown error.";
      attempts.push({
        provider: tier.provider.id,
        model: tier.model,
        tier: tier.kind,
        ok: false,
        ms: Date.now() - started,
        error: message,
        continuation: isContinuation || undefined,
      });
      if (gotText) {
        // Mid-stream failure: hand the partial answer to the next tier.
        yield { type: "notice", text: `${tier.label} dropped mid-answer; continuing with the next model.` };
        continued++;
      }
      ti++;
    }
  }

  if (output && servedBy) {
    yield {
      type: "notice",
      text: "Every model failed before the answer finished. What you see is partial — press Continue to retry.",
    };
    yield { type: "done", servedBy, attempts, continued, incomplete: true };
    return;
  }
  const last = attempts[attempts.length - 1]?.error ?? "unknown error";
  yield { type: "error", message: `All ${attempts.length} model(s) failed. Last error: ${last}`, attempts };
}
