import { useEffect, useRef, useState } from "react";
import { decidePaste } from "../lib/clipboard.ts";
import type { StoredAttachment } from "../lib/store.ts";

interface Props {
  value: string;
  onChange: (v: string) => void;
  attachments: StoredAttachment[];
  processing: number;
  onFiles: (files: File[]) => void;
  onLongText: (text: string) => void;
  onRemove: (id: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  placeholder: string;
  hint?: string;
}

export function Composer(p: Props) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const depth = useRef(0);
  const touch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

  // Auto-grow.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, touch ? 180 : 320)}px`;
  }, [p.value, touch]);

  // Paste anywhere on the page. Text always wins over the image that office apps add.
  const latest = useRef(p);
  latest.current = p;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const target = e.target as HTMLElement | null;
      const inComposer = target === ta.current;
      // Leave other inputs (login, settings) alone.
      if (!inComposer && target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const text = dt.getData("text/plain");
      const files = Array.from(dt.files ?? []);
      const action = decidePaste({ text, fileCount: files.length, inComposer });
      const cur = latest.current;
      switch (action.kind) {
        case "text":
          return; // native paste into the textarea: complete, nothing dropped
        case "insert-text":
          e.preventDefault();
          cur.onChange(cur.value ? `${cur.value}\n${text}` : text);
          ta.current?.focus();
          return;
        case "text-attachment":
          e.preventDefault();
          cur.onLongText(text);
          return;
        case "files":
          e.preventDefault();
          cur.onFiles(files);
          return;
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const canSend = (p.value.trim().length > 0 || p.attachments.length > 0) && p.processing === 0;

  return (
    <div
      className={`composer ${drag ? "dragging" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        setDrag(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        depth.current--;
        if (depth.current <= 0) setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setDrag(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) p.onFiles(files);
        else {
          const t = e.dataTransfer.getData("text/plain");
          if (t) p.onChange(p.value ? `${p.value}\n${t}` : t);
        }
      }}
    >
      {drag && <div className="drop-hint">Drop files to attach</div>}

      {p.attachments.length > 0 && (
        <div className="chips">
          {p.attachments.map((a) => (
            <AttachmentChip key={a.id} a={a} onRemove={() => p.onRemove(a.id)} />
          ))}
        </div>
      )}

      <div className="input-box">
        <textarea
          ref={ta}
          rows={1}
          value={p.value}
          placeholder={p.placeholder}
          enterKeyHint={touch ? "enter" : "send"}
          onChange={(e) => p.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend && !p.busy) p.onSend();
            }
          }}
        />
        <div className="input-row">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              p.onFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <input
            ref={camRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              p.onFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button type="button" className="icon-btn" title="Attach files" aria-label="Attach files" onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
              <path d="M21 11.5 12.6 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {touch && (
            <button type="button" className="icon-btn" title="Take photo" aria-label="Take photo" onClick={() => camRef.current?.click()}>
              <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">
                <path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                <circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </button>
          )}
          {p.processing > 0 && <span className="muted small pulse">reading {p.processing} file(s)…</span>}
          <span className="spacer" />
          {p.busy ? (
            <button type="button" className="btn stop" onClick={p.onStop}>
              Stop
            </button>
          ) : (
            <button type="button" className="btn primary send" disabled={!canSend} onClick={p.onSend}>
              Send
            </button>
          )}
        </div>
      </div>
      <p className="composer-hint">
        {p.hint ? <span className="clamp">{p.hint} · </span> : null}
        {touch ? "Paste or attach images, PDFs, docs" : "Enter to send · Shift+Enter for new line · paste screenshots or long text anywhere"}
      </p>
    </div>
  );
}

function AttachmentChip({ a, onRemove }: { a: StoredAttachment; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (a.kind !== "image") return;
    const u = URL.createObjectURL(a.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [a]);
  return (
    <div className="chip" title={a.note ?? a.name}>
      {url ? <img src={url} alt="" /> : <span className="chip-icon">{a.kind === "pdf" ? "PDF" : "TXT"}</span>}
      <span className="chip-name">
        {a.name}
        <small>
          {a.text && a.kind === "text" && a.name.startsWith("Pasted") ? `${a.text.length.toLocaleString()} chars` : `${Math.max(1, Math.round(a.size / 1024))} KB`}
          {a.note ? " · ⚠" : ""}
        </small>
      </span>
      <button type="button" className="chip-x" aria-label={`Remove ${a.name}`} onClick={onRemove}>
        ×
      </button>
    </div>
  );
}
