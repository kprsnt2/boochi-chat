import type { ChatRecord } from "../lib/store.ts";
import { Ghost } from "./Ghost.tsx";

interface Props {
  appName: string;
  chats: ChatRecord[];
  activeId: string | null;
  tempActive: boolean;
  tempTitle: string | null;
  role: "owner" | "guest";
  email: string | null;
  agentEmoji: (agentId: string) => string;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onSettings: () => void;
  onSignIn: () => void;
  onClose?: () => void;
}

function group(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 31) return "This month";
  return "Older";
}

export function Sidebar(p: Props) {
  let last = "";
  return (
    <aside className="sidebar">
      <div className="side-top">
        <div className="brand small">
          <span className="brand-mark">
            <Ghost size={16} />
          </span>
          <b>{p.appName}</b>
        </div>
        {p.onClose && (
          <button className="icon-btn" aria-label="Close menu" onClick={p.onClose}>
            ✕
          </button>
        )}
      </div>
      <button className="btn primary block" onClick={p.onNew}>
        + New chat
      </button>

      <nav className="chat-list" aria-label="Chats">
        {p.tempActive && (
          <div className="chat-item active temp">
            <span className="chat-emoji">
              <Ghost size={14} />
            </span>
            <span className="chat-title">{p.tempTitle || "Temp chat"}</span>
            <span className="muted small">not saved</span>
          </div>
        )}
        {p.chats.length === 0 && !p.tempActive && <p className="muted small pad">No saved chats yet.</p>}
        {p.chats.map((c) => {
          const g = group(c.updatedAt);
          const header = g !== last ? <p className="group-label">{(last = g)}</p> : null;
          return (
            <div key={c.id}>
              {header}
              <div className={`chat-item ${c.id === p.activeId ? "active" : ""}`}>
                <button className="chat-open" onClick={() => p.onSelect(c.id)} title={c.title}>
                  <span className="chat-emoji">{p.agentEmoji(c.agentId)}</span>
                  <span className="chat-title">{c.title}</span>
                </button>
                <button
                  className="chat-del"
                  aria-label={`Delete ${c.title}`}
                  onClick={() => {
                    if (confirm(`Delete “${c.title}” from this device?`)) p.onDelete(c.id);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </nav>

      <div className="side-foot">
        {p.role === "owner" ? (
          <p className="who" title={p.email ?? ""}>
            <span className="dot ok" /> {p.email}
          </p>
        ) : (
          <button className="btn block" onClick={p.onSignIn}>
            Sign in for private models
          </button>
        )}
        <button className="btn ghost block" onClick={p.onSettings}>
          ⚙ Settings & privacy
        </button>
      </div>
    </aside>
  );
}
