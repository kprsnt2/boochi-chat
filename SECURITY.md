# Security and privacy model

## What is stored, and where

| Data | Where | Who can see it |
|---|---|---|
| Chats, attachments, custom agents | Your browser (IndexedDB), one database per account plus one for guests | You, on that device |
| Temp / Boochi chats | Browser memory only | Gone on reload or close |
| Session | HttpOnly, Secure, SameSite=Strict cookie (signed, no server state) | Your browser only |
| Prompts | Streamed through the server to the chosen provider, never stored | The provider that answers |

The server has **no database, no analytics and no request logging**.
API responses are sent with `Cache-Control: no-store`. A test fails if server code writes to the console.

## What providers see
Your prompts are sent to whichever provider answers.
- **Private mode** restricts this to `*_API_KEY_PAID` accounts. If those fail, the request fails;
  it never falls back to a free tier.
- **Free tiers** (guests, and owners with Private off) may use prompts for training.

## Authentication
- Login codes are 8 digits, generated with a CSPRNG, expire after 10 minutes, and can be used once on each instance.
  The challenge is an HMAC-signed token, so no server storage is needed.
- Codes are only sent to `ALLOWED_EMAILS`. The response looks identical for other addresses, so it can't be used to discover who is allowed.
- `ALLOWED_EMAILS` is re-checked on every request. Bumping `SESSION_VERSION` or rotating `AUTH_SECRET` signs everyone out.
- OTP requests and guest chats are rate-limited per IP (in memory, per instance).
  **Add a platform rate-limiting rule for a hard global limit** (see [docs/DEPLOY.md](docs/DEPLOY.md)).

## Web hardening
- The CSP is `default-src 'self'`: no third-party scripts, fonts or analytics, and `frame-ancestors 'none'`.
  HSTS, `nosniff`, `Referrer-Policy: no-referrer` and COOP/CORP are also set.
- CSRF: state-changing calls require a same-origin `Origin` header and a custom `X-Boochi` header.
- Model output is sanitised with DOMPurify. Remote images are removed, so a reply can't leak your IP through a tracking pixel.
  Links open with `noopener noreferrer`.
- Guests can't send custom system prompts, can't see or reach paid tiers, and can't pin paid models.

## Known limits
- Anyone with access to your unlocked device and browser profile can read local history.
  Use Temp/Boochi for sensitive chats, or **Settings → Sign out & wipe**.
- In-memory rate limits are per instance. The platform rule is what makes them global.

## Reporting a vulnerability
Please open a private [security advisory](https://github.com/kprsnt2/boochi-chat/security/advisories/new)
instead of a public issue.
