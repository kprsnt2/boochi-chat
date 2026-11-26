# Deploying Boochi Chat

You need:
1. **`AUTH_SECRET`**: 32+ random characters.
   Generate one with `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`
2. **`ALLOWED_EMAILS`**: the owner addresses, comma-separated. These are the only people who can use paid keys.
3. **E-mail delivery for login codes**: a free [Resend](https://resend.com) account.
   - Verify a domain you own in Resend.
   - Set `RESEND_API_KEY`.
   - Set `MAIL_FROM` to something like `Boochi Chat <login@YOUR-DOMAIN>`.
4. **At least one model key**: see [PROVIDERS.md](PROVIDERS.md).

Treat everything except `APP_NAME`, `GUEST_*` and the model lists as a **secret**.

---

## Option A: Cloudflare Workers (recommended)

This option gives you a free tier, no cold starts, and 100 MB request bodies.
Logs are disabled in `wrangler.jsonc`. You also get a built-in WAF and rate limiting.

```bash
npm install
npx wrangler login
npx wrangler secret put AUTH_SECRET
npx wrangler secret put ALLOWED_EMAILS
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM
npx wrangler secret put GEMINI_API_KEY_PAID     # repeat for each key you use
npx wrangler secret put OPENAI_API_KEY
npm run cf:deploy
```

After deploying:
- **Custom domain:** go to Workers → your worker → Settings → Domains & Routes.
- **Hard rate limit (recommended):** go to Security → WAF → Rate limiting rules, and add a rule for
  `/api/chat` and `/api/auth/*`. For example, 20 requests per minute per IP.
  Alternatively, uncomment `ratelimits` in `wrangler.jsonc`. The built-in limiter only works per instance.
- **Keep the no-log setup:** leave Logpush and Tail Workers off.
  Workers Logs is already disabled in `wrangler.jsonc`.

To test locally against the Workers runtime, run `npm run cf:dev`. Secrets go in `.dev.vars`.

## Option B: Google Cloud Run

```bash
# one-time: store secrets
printf '%s' "your-secret" | gcloud secrets create AUTH_SECRET --data-file=-
printf '%s' "you@your-domain" | gcloud secrets create ALLOWED_EMAILS --data-file=-
# …RESEND_API_KEY, MAIL_FROM, GEMINI_API_KEY_PAID, OPENAI_API_KEY, …

gcloud run deploy boochi-chat --source . --region asia-south1 --allow-unauthenticated \
  --set-secrets AUTH_SECRET=AUTH_SECRET:latest,ALLOWED_EMAILS=ALLOWED_EMAILS:latest,RESEND_API_KEY=RESEND_API_KEY:latest,MAIL_FROM=MAIL_FROM:latest,GEMINI_API_KEY_PAID=GEMINI_API_KEY_PAID:latest \
  --set-env-vars APP_NAME="Boochi Chat"
```

**About logs:** Cloud Run sends *request* logs (URL, IP and user agent, never bodies) to Cloud Logging.
For a no-log setup, add an exclusion:
Logging → Log Router → `_Default` sink → Exclusions → `resource.type="cloud_run_revision"`.

## Option C: Docker on any host

```bash
docker build -t boochi-chat .
docker run -p 8080:8080 --env-file .env boochi-chat
```

Put it behind HTTPS (Caddy, Nginx or Cloudflare Tunnel). The session cookie is `Secure` on HTTPS,
and the app trusts `X-Forwarded-Proto` / `X-Forwarded-Host` from your proxy.

## Option D: Vercel / other Node hosts
Run `npm run build`, then `node dist-server/node.mjs`. This works on any Node 22+ host.
Note that Vercel limits request bodies to 4.5 MB, which caps attachment sizes.

---

## After deploying

1. Open the site, enter your owner e-mail, and type in the code from your inbox.
2. Go to **Settings → Check model IDs**. Fix any ⚠️ models by setting `PAID_MODELS` / `FREE_MODELS`.
3. Send a message with 🔒 Private on. The reply badge should say 🔒 and name a paid model.

## Updating

Run `git pull`, then `npm run cf:deploy` (or redeploy on Cloud Run).
Model and provider changes need **no rebuild**. Just change the env variables.

## Signing everyone out
Change `SESSION_VERSION`, or rotate `AUTH_SECRET`.
Removing an address from `ALLOWED_EMAILS` revokes that person immediately.
