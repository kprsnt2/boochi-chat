# Contributing

```bash
npm install
npm run dev        # Vite + the same Hono API, http://localhost:5173
npm run mock       # optional fake provider on :9799 (see README)
npm test && npm run typecheck && npm run build
```

## Layout

```
shared/      types.ts (wire contract) · agents.ts (agent prompts, used by both sides)
server/      app.ts (routes, auth, CSRF) · router.ts (privacy policy, fallback, auto-continue)
             providers.ts (OpenAI-compatible + Gemini streaming) · config.ts (env, providers, chains)
             auth.ts (OTP, sessions, rate limits) · security.ts (headers)
             worker.ts (Cloudflare entry) · node.ts (Node / Cloud Run entry)
src/         React UI · lib/ (IndexedDB store, attachments, history budget, markdown, print, clipboard)
tests/       node:test suites (run with plain Node 22.18+)
```

## Adding an agent
Append an object to `AGENTS` in `shared/agents.ts`. Set `alwaysPrivate: true` for sensitive topics,
and `printable: "worksheet"` to get the student / answer-key print buttons.

## Rules
- **Privacy is a feature, not an option.** Never add `console.*` calls, analytics or third-party scripts to the server.
  Never weaken the paid/free key separation. The tests enforce this.
- No output-token limits.
- Keep the server runtime-agnostic: use only Web APIs (fetch, WebCrypto, streams).
- Every bug fix should come with a test that fails without the fix.
