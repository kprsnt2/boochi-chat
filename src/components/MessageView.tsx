import { memo, useEffect, useMemo, useState } from "react";
import { copyToClipboard } from "../lib/clipboard.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { printMarkdown, splitAnswerKey } from "../lib/print.ts";
import type { MessageRecord, StoredAttachment } from "../lib/store.ts";
import { Ghost } from "./Ghost.tsx";

export interface AgentLook {
  name: string;
  emoji: string;
  accent: [string, string];
  printable?: "worksheet" | "document";
}

interface Props {
  msg: MessageRecord;
  agent: AgentLook;
  chatTitle: string;
  streaming: boolean;
  isLast: boolean;
  busy: boolean;
  boochi: boolean;
  onRegenerate?: () => void;
  onContinue?: () => void;
}

export function Avatar({ agent, size = 30 }: { agent: Pick<AgentLook, "emoji" | "accent">; size?: number }) {
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.52,
        background: `linear-gradient(135deg, ${agent.accent[0]}, ${agent.accent[1]})`,
      }}
      aria-hidden="true"
    >
      {agent.emoji}
    </span>
  );
}

export const MessageView = memo(function MessageView(p: Props) {
  const { msg } = p;
  const [copied, setCopied] = useState<string | null>(null);
  const [trace, setTrace] = useState(false);
  const html = useMemo(() => (msg.role === "assistant" && msg.text ? renderMarkdown(msg.text) : ""), [msg.role, msg.text]);

  const flash = (label: string) => {
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  if (msg.role === "user") {
    return (
      <div className="msg user">
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="msg-atts">
            {msg.attachments.map((a) => (
              <UserAttachment key={a.id} a={a} />
            ))}
          </div>
        )}
        {msg.text && <div className="bubble">{msg.text}</div>}
        {msg.text && (
          <div className="msg-actions right">
            <button
              className="act"
              onClick={async () => {
                if (await copyToClipboard(msg.text)) flash("u");
              }}
            >
              {copied === "u" ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>
    );
  }

  const isWorksheet = p.agent.printable === "worksheet";
  const hasKey = isWorksheet && splitAnswerKey(msg.text).key !== null;

  return (
    <div className="msg assistant">
      <Avatar agent={p.agent} />
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-name">{p.agent.name}</span>
          {msg.servedBy && (
            <span className={`badge ${msg.servedBy.tier === "paid" ? "badge-private" : "badge-free"}`} title={msg.servedBy.model}>
              {msg.servedBy.tier === "paid" ? "🔒" : "🌐"} {msg.servedBy.label}
            </span>
          )}
          {p.boochi && (
            <span className="badge badge-boochi" title="Boochi: private model, nothing saved">
              <Ghost size={12} /> Boochi
            </span>
          )}
          {msg.continued ? <span className="badge">auto-continued ×{msg.continued}</span> : null}
        </div>

        {msg.notices?.map((n, i) => (
          <div key={i} className="notice">
            {n}
          </div>
        ))}

        {msg.text && (
          <div
            className="md"
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={async (e) => {
              const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action=copy-code]");
              if (!btn) return;
              const code = btn.closest(".code")?.querySelector("code")?.textContent ?? "";
              if (await copyToClipboard(code)) {
                btn.textContent = "Copied";
                setTimeout(() => (btn.textContent = "Copy"), 1400);
              }
            }}
          />
        )}
        {p.streaming && <span className="cursor" aria-label="Writing" />}
        {msg.error && <div className="error-box">{msg.error}</div>}

        {!p.streaming && (msg.text || msg.error) && (
          <div className="msg-actions">
            {msg.text && (
              <button
                className="act"
                title="Copy (keeps formatting when pasted into Docs/Word)"
                onClick={async () => {
                  const rich = html.replace(/<button[^>]*>[\s\S]*?<\/button>/g, "");
                  if (await copyToClipboard(msg.text, rich)) flash("all");
                }}
              >
                {copied === "all" ? "Copied" : "Copy"}
              </button>
            )}
            {msg.text && (
              <button
                className="act"
                title="Copy the raw Markdown"
                onClick={async () => {
                  if (await copyToClipboard(msg.text)) flash("md");
                }}
              >
                {copied === "md" ? "Copied" : "Copy MD"}
              </button>
            )}
            {msg.text && isWorksheet && (
              <>
                <button className="act strong" onClick={() => printMarkdown(msg.text, "student", p.chatTitle)}>
                  🖨 Student sheet
                </button>
                {hasKey && (
                  <button className="act" onClick={() => printMarkdown(msg.text, "teacher", p.chatTitle)}>
                    🖨 With answer key
                  </button>
                )}
              </>
            )}
            {msg.text && !isWorksheet && (
              <button className="act" onClick={() => printMarkdown(msg.text, "document", p.chatTitle)}>
                🖨 Print / PDF
              </button>
            )}
            {p.isLast && msg.incomplete && p.onContinue && !p.busy && (
              <button className="act strong" onClick={p.onContinue}>
                ⏩ Continue
              </button>
            )}
            {p.isLast && p.onRegenerate && !p.busy && (
              <button className="act" onClick={p.onRegenerate}>
                ↻ Retry
              </button>
            )}
            {msg.attempts && msg.attempts.length > 0 && (
              <button className="act" onClick={() => setTrace((t) => !t)}>
                {trace ? "Hide route" : `Route (${msg.attempts.length})`}
              </button>
            )}
          </div>
        )}

        {trace && msg.attempts && (
          <div className="trace">
            <p className="muted small">
              {msg.private ? "🔒 Private routing: paid, no-training keys only." : "Free models first, paid as backup."}
            </p>
            {msg.attempts.map((a, i) => (
              <div key={i} className="trace-row">
                <span className={`dot ${a.ok ? "ok" : "bad"}`} />
                <span>
                  <b>{a.tier}</b> · {a.provider} · {a.model}
                  {a.continuation ? " · continuation" : ""} <span className="muted">{(a.ms / 1000).toFixed(1)}s</span>
                  {a.error && <span className="trace-err">{a.error}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

function UserAttachment({ a }: { a: StoredAttachment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (a.kind !== "image") return;
    const u = URL.createObjectURL(a.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [a]);
  return url ? (
    <img className="att-img" src={url} alt={a.name} />
  ) : (
    <span className="att-file" title={a.note}>
      {a.kind === "pdf" ? "📄" : "📃"} {a.name}
    </span>
  );
}
