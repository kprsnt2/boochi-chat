import { useEffect, useState } from "react";
import type { PublicConfig } from "../../shared/types.ts";
import { checkModels, type ModelCheck } from "../lib/api.ts";
import { storageEstimate, uid, type CustomAgent } from "../lib/store.ts";
import { Ghost } from "./Ghost.tsx";

interface Props {
  config: PublicConfig;
  customAgents: CustomAgent[];
  onSaveAgents: (a: CustomAgent[]) => void;
  onSignOut: (wipe: boolean) => void;
  onWipeAll: () => void;
  onClose: () => void;
}

export function Settings({ config, customAgents, onSaveAgents, onSignOut, onWipeAll, onClose }: Props) {
  const owner = config.role === "owner";
  const [usage, setUsage] = useState<{ usedMB: number; quotaMB: number } | null>(null);
  const [checks, setChecks] = useState<ModelCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomAgent | null>(null);

  useEffect(() => {
    void storageEstimate().then(setUsage);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const runCheck = async () => {
    setChecking(true);
    setCheckErr(null);
    try {
      setChecks((await checkModels()).results);
    } catch (e) {
      setCheckErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const tiers = [...config.paid, ...config.free];

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings & privacy</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <section>
          <h3>How your data is handled</h3>
          <ul className="facts">
            <li>
              <b>Chats live only in this browser</b> (IndexedDB), separately per account. The server keeps nothing:
              no database, no logs, no analytics.
            </li>
            <li>
              <b>🔒 Private</b> — only paid API keys whose terms exclude training. If they all fail, the request fails;
              it never falls back to a free model.
            </li>
            <li>
              <b>⏳ Temp</b> — the chat is never written to disk and vanishes on reload or close.
            </li>
            <li>
              <b>
                <Ghost size={13} /> Boochi
              </b>{" "}
              — Private + Temp together: paid private model, nothing saved anywhere.
            </li>
            <li>
              <b>Private off / guests</b> — free models first (they may use prompts for training), paid as backup for
              owners.
            </li>
          </ul>
        </section>

        <section>
          <h3>Account</h3>
          {owner ? (
            <>
              <p>
                Signed in as <b>{config.email}</b>
              </p>
              <div className="row wrap">
                <button className="btn" onClick={() => onSignOut(false)}>
                  Sign out
                </button>
                <button
                  className="btn danger"
                  onClick={() => {
                    if (confirm("Sign out AND delete this account's chats from this device?")) onSignOut(true);
                  }}
                >
                  Sign out & wipe this device
                </button>
              </div>
            </>
          ) : (
            <p className="muted">Guest · free models only. Sign in from the sidebar for private models.</p>
          )}
        </section>

        <section>
          <h3>Models</h3>
          <div className="tier-list">
            {tiers.map((t) => (
              <div key={t.id} className="tier-row">
                <span className={`badge ${t.tier === "paid" ? "badge-private" : "badge-free"}`}>{t.tier}</span>
                <span className="tier-label">{t.label}</span>
                <span className="muted small">{t.vision ? "vision" : "text"}</span>
                <span className={`small ${t.configured ? "ok-text" : "muted"}`}>{t.configured ? "key set" : "no key"}</span>
              </div>
            ))}
          </div>
          {owner && (
            <>
              <button className="btn" disabled={checking} onClick={() => void runCheck()}>
                {checking ? "Checking…" : "Check model IDs with providers"}
              </button>
              <p className="muted small">Lists each provider's models; no prompt is sent.</p>
              {checkErr && <p className="error-text">{checkErr}</p>}
              {checks && (
                <div className="tier-list">
                  {checks.map((c) => (
                    <div key={c.id} className="tier-row col">
                      <span>
                        {c.status === "ok" ? "✅" : c.status === "no-key" ? "➖" : "⚠️"} {c.label} <span className="muted small">({c.tier})</span>
                      </span>
                      {c.status === "missing" && (
                        <span className="small">
                          Not found. {c.suggestions?.length ? `Close matches: ${c.suggestions.join(", ")}` : "Update PAID_MODELS / FREE_MODELS."}
                        </span>
                      )}
                      {c.status === "error" && <span className="small error-text">{c.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        {owner && (
          <section>
            <h3>Custom agents</h3>
            <p className="muted small">Your own system prompts, stored only in this browser.</p>
            {customAgents.map((a) => (
              <div key={a.id} className="tier-row">
                <span>{a.emoji}</span>
                <span className="tier-label">{a.name}</span>
                <button className="act" onClick={() => setEditing(a)}>
                  Edit
                </button>
                <button
                  className="act"
                  onClick={() => {
                    if (confirm(`Delete agent “${a.name}”?`)) onSaveAgents(customAgents.filter((x) => x.id !== a.id));
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
            {editing ? (
              <div className="agent-form">
                <div className="row">
                  <input
                    className="emoji-input"
                    value={editing.emoji}
                    maxLength={4}
                    onChange={(e) => setEditing({ ...editing, emoji: e.target.value })}
                    aria-label="Emoji"
                  />
                  <input
                    value={editing.name}
                    placeholder="Agent name"
                    maxLength={40}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                </div>
                <textarea
                  rows={7}
                  value={editing.prompt}
                  maxLength={12000}
                  placeholder="You are … Describe the role, method, rules and output format."
                  onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
                />
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={!editing.name.trim() || !editing.prompt.trim()}
                    onClick={() => {
                      const exists = customAgents.some((a) => a.id === editing.id);
                      onSaveAgents(exists ? customAgents.map((a) => (a.id === editing.id ? editing : a)) : [...customAgents, editing]);
                      setEditing(null);
                    }}
                  >
                    Save agent
                  </button>
                  <button className="btn ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn" onClick={() => setEditing({ id: `custom-${uid()}`, name: "", emoji: "🤖", prompt: "" })}>
                + New agent
              </button>
            )}
          </section>
        )}

        <section>
          <h3>This device</h3>
          {usage && (
            <p className="muted small">
              Using {usage.usedMB.toFixed(1)} MB of {(usage.quotaMB / 1024).toFixed(1)} GB available.
            </p>
          )}
          <button
            className="btn danger"
            onClick={() => {
              if (confirm("Delete ALL Boochi Chat chats, agents and settings from this browser (every account and guest)? This cannot be undone.")) onWipeAll();
            }}
          >
            Delete everything on this device
          </button>
        </section>
      </div>
    </div>
  );
}
