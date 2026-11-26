# Providers and models

## How keys map to modes

Every provider has two independent keys:

| Env variable | Used by | Meant for |
|---|---|---|
| `<ID>_API_KEY_PAID` | **Paid chain**: 🔒 Private mode and Boochi | Accounts whose terms exclude training on your data |
| `<ID>_API_KEY` | **Free chain**: guests, and owners with Private off | Free tiers, which may train on prompts |

A paid tier never reads a free key, and a free tier never reads a paid key.
Only put a provider in the paid chain when its paid terms exclude training.

## Built-in providers

| id | Default endpoint | Example models (Nov 2026) |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | `gpt-5.4-mini`, `gpt-5.4-nano` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.5-flash-lite`, `gemini-flash-latest` |
| `groq` | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` |
| `cerebras` | `https://api.cerebras.ai/v1` | `gpt-oss-120b` |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai/gpt-oss-120b:free` (`:free` models) |
| `github` | `https://models.github.ai/inference` | `openai/gpt-4.1-mini` (key = GitHub token with `models` scope) |
| `nvidia` | `https://integrate.api.nvidia.com/v1` | `openai/gpt-oss-120b` |
| `mistral` | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| `deepseek` | `https://api.deepseek.com` | `deepseek-flash` (V4.1 Flash), `deepseek-v4-pro` |
| `together` | `https://api.together.xyz/v1` | any Together model id |

Model IDs change often. **Settings → Check model IDs** lists each provider's models and flags any
that are missing. This check sends no prompts.

## Choosing models: `PAID_MODELS` / `FREE_MODELS`

Write a comma-separated list of `provider:model`, in priority order:

```env
PAID_MODELS=gemini:gemini-3.5-flash-lite,openai:gpt-5.4-mini,gemini:gemini-flash-latest
FREE_MODELS=openai:gpt-5.4-mini,groq:openai/gpt-oss-120b,deepseek:deepseek-flash
```

- Models without a key are skipped, so you can list many.
- Add `;vision` or `;text` to override image-support detection, e.g. `myllm:qwen3-vl;vision`.
- Gemini models read PDFs natively, including scans. Other models get the text extracted from the PDF in your browser.

## Switching an endpoint

Point any built-in provider at a proxy, gateway or regional endpoint:

```env
OPENAI_BASE_URL=https://my-gateway.example/v1
OPENAI_BASE_URL_PAID=https://my-private-gateway.example/v1   # paid chain only (optional)
OPENAI_LABEL=OpenAI (EU)                                     # display name (optional)
```

## Adding your own provider (no code)

Pick an id: lowercase letters, digits or `_`, up to 32 characters. Then set:

```env
MYLLM_BASE_URL=https://api.my-llm.com/v1     # required (or MYLLM_BASE_URL_PAID)
MYLLM_API_KEY=...                            # free chain key
MYLLM_API_KEY_PAID=...                       # paid chain key (optional)
MYLLM_LABEL=My LLM                           # optional
MYLLM_KIND=openai                            # "openai" (default) or "gemini" wire format
FREE_MODELS=myllm:my-model,openai:gpt-5.4-mini
```

This works with anything that speaks the OpenAI `/chat/completions` streaming API, including
Ollama (`http://host:11434/v1`), LM Studio, vLLM, LiteLLM, Azure gateways, Fireworks, xAI and others.
For a self-hosted model you trust, you can use it as a **paid/private** tier by setting `MYLLM_API_KEY_PAID`.

## Limits

- No output-token cap and no temperature are ever sent.
- `AUTO_CONTINUE_MAX` (default 8) bounds automatic continuations when a provider hits its own hard ceiling.
- `MAX_REQUEST_MB` (default 30) caps a single request, including attachments.
