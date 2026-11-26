# Boochi Chat 👻

**A privacy-first, self-hosted, multi-agent AI chat that you deploy yourself.**
Chats live only in your browser. The server is a stateless, log-free router to the
AI providers *you* choose. Sign-in uses an e-mail code. Guests get free models.

> **Boochi mode** = Private + Temp: a paid no-training model, and nothing saved anywhere.
> It shows a little ghost. 👻

[![CI](https://github.com/kprsnt2/boochi-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/kprsnt2/boochi-chat/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

## Why

- **Your data stays yours.** There is no database, no analytics and no logs. History lives in IndexedDB in your browser.
- **The privacy rules are enforced server-side.** Private mode can *only* reach keys that end in `_PAID`,
  and it never silently falls back to a free provider that may train on your prompts.
- **Answers are never cut off.** No output-token limit is sent. If a provider stops at its own ceiling,
  the answer is continued and stitched together automatically.
- **It's bring-your-own-model.** There are 10 built-in providers plus *any* OpenAI-compatible endpoint, added with
  just two env variables. Switching providers needs no code change and no rebuild.
- **15 work agents:** Worksheet (printable, with answer key), DataAnalyst, Doctor, Writer, Career, TechFix and more.
  Owners can add custom agents.

## Modes

| Who | 🔒 Private | ⏳ Temp | Models used | Saved? |
|---|---|---|---|---|
| Owner (signed in) | **ON (default)** | off | Paid keys only. If they fail, the request fails | This browser only |
| Owner | ON | **ON** | Paid only. This is **Boochi mode 👻** | Nowhere |
| Owner | off | any | Free models first, paid as backup | Depends on Temp |
| Guest | n/a | any | Free keys only | Depends on Temp |

Sensitive agents (Doctor, Psycho, Finance) always use Private for owners.
Every reply shows which model answered (🔒 paid or 🌐 free) and the full route it took.

## Quick start (local)

```bash
git clone https://github.com/kprsnt2/boochi-chat.git
cd boochi-chat
npm install
cp .env.example .env     # set AUTH_SECRET, ALLOWED_EMAILS, OTP_DEV_SHOW=true and at least one key
npm run dev              # http://localhost:5173
```

**No keys yet?** Run `npm run mock` in a second terminal, then set
`OPENAI_BASE_URL=http://127.0.0.1:9799/v1`, `OPENAI_API_KEY=x` and `OPENAI_API_KEY_PAID=PAID` in `.env`.

## Deploy

| Host | Command | Notes |
|---|---|---|
| **Cloudflare Workers** (recommended) | `npm run cf:deploy` | Free tier, no cold starts, logs off, 100 MB uploads |
| **Google Cloud Run** | `gcloud run deploy --source .` | Uses the `Dockerfile` |
| Docker / any VM | `docker build -t boochi . && docker run -p 8080:8080 --env-file .env boochi` | |

The step-by-step guide is in **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Models and providers

Default chains (latest low-cost models, Nov 2026):

- **Paid / Private:** `gemini-3.5-flash-lite` → `gpt-5.4-mini` → `gemini-flash-latest`
- **Free:** `gpt-5.4-mini` → `gemini-3.5-flash-lite` → Groq, Cerebras, OpenRouter (`gpt-oss-120b`) → GitHub Models → NVIDIA → Mistral → DeepSeek (`deepseek-flash`)

Tiers without a key are skipped. To change the order or models, set `PAID_MODELS` / `FREE_MODELS`.
To change an endpoint, set `<PROVIDER>_BASE_URL`. To add your own provider, set `<ID>_BASE_URL` and `<ID>_API_KEY`.
Full reference: **[docs/PROVIDERS.md](docs/PROVIDERS.md)**.
In the app, **Settings → Check model IDs** verifies every model against its provider without sending a prompt.

## Security and privacy

See **[SECURITY.md](SECURITY.md)** for the threat model. In short:
- E-mail one-time codes (8 digits, 10 minutes, single use), sent only to `ALLOWED_EMAILS`.
- Sessions are HttpOnly, Secure, SameSite=Strict cookies.
- CSRF protection, a strict CSP, no third-party scripts, and remote images in replies are blocked.
- Per-account local storage, with one-click wipe.

## Fixes over the original demo

| Problem | Fix |
|---|---|
| Worksheets cut off, missing the answer key | No token caps, plus automatic continuation |
| Worksheet PDF deleted π, √, Hindi, Telugu… | Browser print engine. Student sheet and answer-key copy |
| Pasting from Excel/Word lost the text | Text takes priority over the clipboard image. Long pastes become attachments |
| Copy failed or copied partial answers | Complete answers. Rich + plain copy, with a fallback for http |
| OpenAI tier always failed | No `temperature` sent (gpt-5 models reject it) |
| Private chats could leak to training providers | Hard block |

## Development

```bash
npm test           # 51 tests: privacy routing, key separation, auth, CSRF, no token caps, paste, worksheets…
npm run typecheck
npm run build      # dist/ (SPA) + dist-server/node.mjs
```

The project layout and how to add an agent are covered in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
