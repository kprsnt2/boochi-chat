import { useState } from "react";
import { requestCode, verifyCode } from "../lib/api.ts";
import { Ghost } from "./Ghost.tsx";

interface Props {
  appName: string;
  emailLoginEnabled: boolean;
  guestEnabled: boolean;
  onSignedIn: () => void;
  onGuest: () => void;
  onCancel?: () => void;
}

export function Login({ appName, emailLoginEnabled, guestEnabled, onSignedIn, onGuest, onCancel }: Props) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await requestCode(email);
      setChallenge(r.challenge);
      setDevCode(r.devCode ?? null);
      setStep("code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await verifyCode(challenge, code);
      onSignedIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="brand">
          <span className="brand-mark">
            <Ghost size={22} />
          </span>
          <div>
            <h1>{appName}</h1>
            <p className="muted">Private by default. Your chats stay in this browser.</p>
          </div>
        </div>

        {emailLoginEnabled ? (
          step === "email" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void send();
              }}
            >
              <label htmlFor="email">Sign in with a one-time code</label>
              <input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
                required
              />
              <button className="btn primary block" disabled={busy || !email}>
                {busy ? "Sending…" : "Email me a code"}
              </button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void verify();
              }}
            >
              <label htmlFor="code">
                Enter the 8-digit code sent to <b>{email}</b>
              </label>
              <p className="muted small">
                Codes are only sent to approved addresses. Didn’t get one? Check spam, or continue as a guest.
              </p>
              {devCode && (
                <p className="dev-code">
                  Local dev code: <code>{devCode}</code>
                </p>
              )}
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="1234 5678"
                value={code}
                maxLength={9}
                onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
                autoFocus
              />
              <button className="btn primary block" disabled={busy || code.replace(/\D/g, "").length !== 8}>
                {busy ? "Checking…" : "Sign in"}
              </button>
              <button type="button" className="btn ghost block" onClick={() => setStep("email")}>
                Use a different e-mail
              </button>
            </form>
          )
        ) : (
          <p className="muted small">E-mail sign-in is not configured on this server.</p>
        )}

        {error && <p className="error-text">{error}</p>}

        {guestEnabled && (
          <>
            <div className="divider">
              <span>or</span>
            </div>
            <button className="btn block" onClick={onGuest}>
              Continue as guest <span className="muted">· free models</span>
            </button>
            <p className="muted small center">
              Guests use free models. Free providers may use prompts to improve their models — avoid sharing anything
              sensitive.
            </p>
          </>
        )}
        {onCancel && (
          <button className="btn ghost block" onClick={onCancel}>
            Back
          </button>
        )}
      </div>
    </main>
  );
}
