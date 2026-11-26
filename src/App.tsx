import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AGENTS, AGENT_BY_ID, CATEGORY_LABELS, type Agent } from "../shared/agents.ts";
import { CONTINUE_PROMPT, type ChatRequest, type PublicConfig, type TierInfo } from "../shared/types.ts";
import { Composer } from "./components/Composer.tsx";
import { Ghost } from "./components/Ghost.tsx";
import { Login } from "./components/Login.tsx";
import { Avatar, MessageView, type AgentLook } from "./components/MessageView.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { ApiError, getConfig, logout, streamChat } from "./lib/api.ts";
import { MAX_FILES_PER_MESSAGE, MAX_FILE_MB, processFile, textAttachment } from "./lib/attachments.ts";
import { buildWire, wireSize } from "./lib/history.ts";
import {
  deleteChat,
  deleteMessage,
  getKv,
  getMessages,
  listChats,
  namespaceFor,
  putChat,
  putMessage,
  setKv,
  uid,
  useNamespace,
  wipeCurrent,
  wipeEverything,
  type ChatRecord,
  type CustomAgent,
  type MessageRecord,
  type StoredAttachment,
} from "./lib/store.ts";

interface Session {
  chat: ChatRecord;
  messages: MessageRecord[];
  temp: boolean;
}

type ResolvedAgent = AgentLook & { id: string; tagline: string; starters: string[]; alwaysPrivate?: boolean; attachmentHint?: string; customPrompt?: string };

const GUEST_FLAG = "boochi.guest";
const CUSTOM_ACCENT: [string, string] = ["#64748b", "#334155"];

export default function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [gate, setGate] = useState<"loading" | "login" | "app" | "error">("loading");
  const [bootErr, setBootErr] = useState("");
  const [chats, setChats] = useState<ChatRecord[]>([]);
  const [session, setSessionState] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [privateMode, setPrivateMode] = useState(true);
  const [tempMode, setTempMode] = useState(false);
  const [pinned, setPinned] = useState("");
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<StoredAttachment[]>([]);
  const [processing, setProcessing] = useState(0);
  const [toasts, setToasts] = useState<{ id: string; text: string }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const setSession = useCallback((next: Session | null | ((s: Session | null) => Session | null)) => {
    const value = typeof next === "function" ? next(sessionRef.current) : next;
    sessionRef.current = value;
    setSessionState(value);
  }, []);

  const toast = useCallback((text: string) => {
    const id = uid();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
  }, []);

  /* ------------------------------- boot -------------------------------- */

  const enter = useCallback(
    async (cfg: PublicConfig) => {
      useNamespace(await namespaceFor(cfg.role === "owner" ? cfg.email : null));
      setChats(await listChats());
      setCustomAgents(cfg.role === "owner" ? ((await getKv<CustomAgent[]>("customAgents")) ?? []) : []);
      setPrivateMode(cfg.role === "owner"); // privacy ON by default, every load
      setTempMode(false);
      setSession(null);
      setGate("app");
    },
    [setSession],
  );

  const boot = useCallback(async () => {
    try {
      const cfg = await getConfig();
      setConfig(cfg);
      document.title = cfg.appName;
      let guestChosen = false;
      try {
        guestChosen = localStorage.getItem(GUEST_FLAG) === "1";
      } catch {
        /* storage blocked */
      }
      if (cfg.role === null || (cfg.role === "guest" && !guestChosen)) setGate("login");
      else await enter(cfg);
    } catch (e) {
      setBootErr((e as Error).message || "Could not reach the server.");
      setGate("error");
    }
  }, [enter]);

  useEffect(() => {
    void boot();
  }, [boot]);

  /* ------------------------------ agents ------------------------------- */

  const resolveAgent = useCallback(
    (id: string): ResolvedAgent => {
      const a: Agent | undefined = AGENT_BY_ID[id];
      if (a) return { ...a };
      const c = customAgents.find((x) => x.id === id);
      if (c)
        return { id: c.id, name: c.name, emoji: c.emoji || "🤖", accent: CUSTOM_ACCENT, tagline: "Custom agent", starters: [], customPrompt: c.prompt };
      return { ...AGENT_BY_ID.general };
    },
    [customAgents],
  );

  const owner = config?.role === "owner";
  const agent = session ? resolveAgent(session.chat.agentId) : null;
  const effectivePrivate = owner && (privateMode || Boolean(agent?.alwaysPrivate));
  const boochi = effectivePrivate && tempMode;

  useEffect(() => {
    document.documentElement.dataset.boochi = boochi ? "1" : "";
  }, [boochi]);

  const modelOptions: TierInfo[] = useMemo(() => {
    if (!config) return [];
    const list = owner ? (effectivePrivate ? config.paid : [...config.free, ...config.paid]) : config.free;
    return list.filter((t) => t.configured);
  }, [config, owner, effectivePrivate]);

  useEffect(() => {
    if (pinned && !modelOptions.some((t) => t.id === pinned)) setPinned("");
  }, [modelOptions, pinned]);

  /* ------------------------------ chats -------------------------------- */

  const startChat = useCallback(
    (agentId: string, temp: boolean) => {
      abortRef.current?.abort();
      const now = Date.now();
      setSession({ chat: { id: uid(), title: "New chat", agentId, createdAt: now, updatedAt: now }, messages: [], temp });
      setDrawer(false);
    },
    [setSession],
  );

  const openChat = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      const chat = chats.find((c) => c.id === id);
      if (!chat) return;
      setSession({ chat, messages: await getMessages(id), temp: false });
      setTempMode(false);
      setDrawer(false);
      stick.current = true;
    },
    [chats, setSession],
  );

  const removeChat = useCallback(
    async (id: string) => {
      await deleteChat(id);
      setChats(await listChats());
      if (sessionRef.current?.chat.id === id) setSession(null);
    },
    [setSession],
  );

  const toggleTemp = () => {
    const next = !tempMode;
    const s = sessionRef.current;
    if (s?.temp && s.messages.length && !confirm("Leave this temp chat? It will disappear for good.")) return;
    setTempMode(next);
    if (s) startChat(s.chat.agentId, next);
    toast(next ? "Temp on: new chats are not saved anywhere." : "Temp off: chats are saved on this device.");
  };

  const togglePrivate = () => {
    if (!owner) return;
    if (agent?.alwaysPrivate && privateMode) {
      toast(`${agent.name} always uses private models.`);
    }
    setPrivateMode((p) => !p);
  };

  /* --------------------------- attachments ----------------------------- */

  const addFiles = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        if (f.size > MAX_FILE_MB * 1048576) {
          toast(`${f.name} is over ${MAX_FILE_MB} MB and was skipped.`);
          continue;
        }
        setProcessing((n) => n + 1);
        try {
          const { attachment, notice } = await processFile(f);
          setPending((p) => {
            if (p.length >= MAX_FILES_PER_MESSAGE) {
              toast(`Limit is ${MAX_FILES_PER_MESSAGE} files per message.`);
              return p;
            }
            return [...p, attachment];
          });
          if (notice) toast(notice);
        } catch (e) {
          toast(`${f.name}: ${(e as Error).message}`);
        } finally {
          setProcessing((n) => n - 1);
        }
      }
    },
    [toast],
  );

  /* ----------------------------- sending ------------------------------- */

  const patchMsg = useCallback(
    (id: string, fn: (m: MessageRecord) => MessageRecord) => {
      setSession((s) => (s ? { ...s, messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) } : s));
    },
    [setSession],
  );

  const persist = async (m: MessageRecord) => {
    const s = sessionRef.current;
    if (!s || s.temp) return;
    await putMessage(m);
  };

  const runAssistant = useCallback(
    async (mode: "new" | "continue") => {
      const s = sessionRef.current;
      if (!s || !config) return;
      const ag = resolveAgent(s.chat.agentId);
      const budget = Math.floor(config.limits.maxRequestMB * 1048576 * 0.85);

      let target: MessageRecord;
      let history: MessageRecord[];
      if (mode === "continue") {
        target = s.messages[s.messages.length - 1];
        if (!target || target.role !== "assistant") return;
        history = s.messages;
        patchMsg(target.id, (m) => ({ ...m, incomplete: false, error: undefined }));
      } else {
        history = s.messages;
        target = { id: uid(), chatId: s.chat.id, role: "assistant", text: "", createdAt: Date.now() };
        setSession((cur) => (cur ? { ...cur, messages: [...cur.messages, target] } : cur));
      }

      const wire = await buildWire(history, { binaryBudget: budget });
      if (mode === "continue") wire.push({ role: "user", parts: [{ type: "text", text: CONTINUE_PROMPT }] });
      if (wireSize(wire) > config.limits.maxRequestMB * 1048576) {
        patchMsg(target.id, (m) => ({ ...m, error: "This conversation's attachments are too large. Start a new chat or remove files." }));
        return;
      }

      const body: ChatRequest = {
        agentId: ag.customPrompt ? "general" : ag.id,
        private: effectivePrivateRef.current,
        model: pinnedRef.current || null,
        messages: wire,
        customPrompt: ag.customPrompt ?? null,
      };

      const ctl = new AbortController();
      abortRef.current = ctl;
      setBusyId(target.id);
      stick.current = true;

      let buf = "";
      let raf = 0;
      const flush = () => {
        raf = 0;
        if (!buf) return;
        const add = buf;
        buf = "";
        patchMsg(target.id, (m) => ({ ...m, text: m.text + add }));
      };

      try {
        await streamChat(body, ctl.signal, (ev) => {
          switch (ev.type) {
            case "mode":
              patchMsg(target.id, (m) => ({ ...m, private: ev.private }));
              break;
            case "start":
              patchMsg(target.id, (m) => ({ ...m, servedBy: ev.servedBy }));
              break;
            case "delta":
              buf += ev.text;
              if (!raf) raf = requestAnimationFrame(flush);
              break;
            case "notice":
              flush();
              patchMsg(target.id, (m) => ({ ...m, notices: [...(m.notices ?? []), ev.text] }));
              break;
            case "done":
              flush();
              patchMsg(target.id, (m) => ({
                ...m,
                servedBy: ev.servedBy,
                attempts: [...(mode === "continue" ? (m.attempts ?? []) : []), ...ev.attempts],
                continued: (m.continued ?? 0) + ev.continued + (mode === "continue" ? 1 : 0),
                incomplete: ev.incomplete,
              }));
              break;
            case "error":
              flush();
              patchMsg(target.id, (m) => ({
                ...m,
                error: ev.message === "Stopped." ? undefined : ev.message,
                attempts: ev.attempts,
                incomplete: Boolean(m.text) || undefined,
              }));
              break;
          }
        });
      } catch (e) {
        const aborted = ctl.signal.aborted;
        if (raf) cancelAnimationFrame(raf);
        flush();
        patchMsg(target.id, (m) =>
          aborted
            ? { ...m, incomplete: Boolean(m.text), notices: [...(m.notices ?? []), "Stopped."] }
            : { ...m, error: e instanceof ApiError ? e.message : "Network error — check your connection.", incomplete: Boolean(m.text) || undefined },
        );
        if (e instanceof ApiError && e.status === 401) void boot();
      } finally {
        if (raf) cancelAnimationFrame(raf);
        flush();
        setBusyId(null);
        if (abortRef.current === ctl) abortRef.current = null;
        const final = sessionRef.current?.messages.find((m) => m.id === target.id);
        if (final) await persist(final);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, resolveAgent, patchMsg, setSession, boot],
  );

  // Refs so the async sender always sees the latest toggles.
  const effectivePrivateRef = useRef(effectivePrivate);
  effectivePrivateRef.current = effectivePrivate;
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const send = useCallback(async () => {
    if (busyId || processing) return;
    const text = input.trim();
    if (!text && !pending.length) return;
    let s = sessionRef.current;
    if (!s) {
      startChat("general", tempMode);
      s = sessionRef.current!;
    }
    const user: MessageRecord = {
      id: uid(),
      chatId: s.chat.id,
      role: "user",
      text,
      attachments: pending,
      createdAt: Date.now(),
    };
    let chat = s.chat;
    if (chat.title === "New chat") {
      const t = text || pending[0]?.name || "New chat";
      chat = { ...chat, title: t.length > 60 ? `${t.slice(0, 60)}…` : t };
    }
    setInput("");
    setPending([]);
    setSession((cur) => (cur ? { ...cur, chat, messages: [...cur.messages, user] } : cur));
    if (!s.temp) {
      await putChat({ ...chat, updatedAt: Date.now() });
      await putMessage(user);
      setChats(await listChats());
    }
    await runAssistant("new");
  }, [busyId, processing, input, pending, tempMode, startChat, setSession, runAssistant]);

  const regenerate = useCallback(async () => {
    const s = sessionRef.current;
    const last = s?.messages[s.messages.length - 1];
    if (!s || !last || last.role !== "assistant" || busyId) return;
    setSession({ ...s, messages: s.messages.slice(0, -1) });
    if (!s.temp) await deleteMessage(last.id);
    await runAssistant("new");
  }, [busyId, setSession, runAssistant]);

  /* ------------------------------ scroll ------------------------------- */

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [session?.messages]);

  /* ------------------------------ render ------------------------------- */

  if (gate === "loading") return <div className="center-screen muted">Loading…</div>;
  if (gate === "error")
    return (
      <div className="center-screen">
        <p className="error-text">{bootErr}</p>
        <button className="btn" onClick={() => void boot()}>
          Retry
        </button>
      </div>
    );
  if (gate === "login" && config)
    return (
      <Login
        appName={config.appName}
        emailLoginEnabled={config.emailLoginEnabled}
        guestEnabled={config.guestEnabled}
        onSignedIn={() => location.reload()}
        onGuest={() => {
          try {
            localStorage.setItem(GUEST_FLAG, "1");
          } catch {
            /* ignore */
          }
          void enter(config);
        }}
        onCancel={config.role === "guest" && localStorageHasGuest() ? () => setGate("app") : undefined}
      />
    );
  if (!config) return null;

  const pinnedTier = modelOptions.find((t) => t.id === pinned);
  const messages = session?.messages ?? [];
  const sidebar = (onClose?: () => void) => (
    <Sidebar
      appName={config.appName}
      chats={chats}
      activeId={session && !session.temp ? session.chat.id : null}
      tempActive={Boolean(session?.temp)}
      tempTitle={session?.temp ? session.chat.title : null}
      role={owner ? "owner" : "guest"}
      email={config.email}
      agentEmoji={(id) => resolveAgent(id).emoji}
      onNew={() => {
        setSession(null);
        setDrawer(false);
      }}
      onSelect={(id) => void openChat(id)}
      onDelete={(id) => void removeChat(id)}
      onSettings={() => {
        setSettingsOpen(true);
        setDrawer(false);
      }}
      onSignIn={() => setGate("login")}
      onClose={onClose}
    />
  );

  return (
    <div className={`shell ${boochi ? "boochi" : ""}`}>
      <div className="side-desktop">{sidebar()}</div>
      {drawer && (
        <div className="drawer" onClick={() => setDrawer(false)}>
          <div onClick={(e) => e.stopPropagation()}>{sidebar(() => setDrawer(false))}</div>
        </div>
      )}

      <main className="main">
        <header className="topbar">
          <button className="icon-btn mobile-only" aria-label="Open menu" onClick={() => setDrawer(true)}>
            ☰
          </button>
          {agent ? (
            <div className="top-agent">
              <Avatar agent={agent} size={28} />
              <div className="top-agent-text">
                <b>{agent.name}</b>
                <span className="muted small desktop-only">{agent.tagline}</span>
              </div>
            </div>
          ) : (
            <b className="top-agent">{config.appName}</b>
          )}
          <span className="spacer" />

          <div className="model-pick">
            <button className="pill" onClick={() => setModelMenu((o) => !o)} title="Choose model">
              {pinnedTier ? pinnedTier.label : "Auto"}
              <span className="caret">▾</span>
            </button>
            {modelMenu && (
              <>
                <div className="menu-back" onClick={() => setModelMenu(false)} />
                <div className="menu">
                  <MenuItem
                    active={!pinned}
                    title="Auto"
                    sub={effectivePrivate ? "Best private model, with private fallbacks" : owner ? "Free models first, paid as backup" : "Free models with fallbacks"}
                    onClick={() => {
                      setPinned("");
                      setModelMenu(false);
                    }}
                  />
                  {modelOptions.map((t) => (
                    <MenuItem
                      key={t.id}
                      active={pinned === t.id}
                      title={`${t.tier === "paid" ? "🔒" : "🌐"} ${t.label}`}
                      sub={`${t.tier === "paid" ? "paid · no training" : "free · may train"}${t.vision ? " · images" : ""}${t.pdfNative ? " · PDFs" : ""}`}
                      onClick={() => {
                        setPinned(t.id);
                        setModelMenu(false);
                      }}
                    />
                  ))}
                  {modelOptions.length === 0 && <p className="muted small pad">No models configured for this mode.</p>}
                </div>
              </>
            )}
          </div>

          <button
            className={`toggle ${effectivePrivate ? "on private" : ""}`}
            onClick={togglePrivate}
            disabled={!owner}
            aria-pressed={effectivePrivate}
            title={owner ? "Private: paid, no-training models only" : "Sign in to use private models"}
          >
            {effectivePrivate ? "🔒" : "🔓"}
            <span className="desktop-only"> Private</span>
          </button>
          <button
            className={`toggle ${tempMode ? "on temp" : ""}`}
            onClick={toggleTemp}
            aria-pressed={tempMode}
            title="Temp: chat is never saved, vanishes on close"
          >
            ⏳<span className="desktop-only"> Temp</span>
          </button>
          {boochi && (
            <span className="boochi-badge" title="Boochi mode: private model + nothing saved">
              <Ghost size={18} className="float" />
              <span className="desktop-only">Boochi</span>
            </span>
          )}
        </header>

        <ModeStrip owner={owner} effectivePrivate={effectivePrivate} temp={tempMode} boochi={boochi} forced={Boolean(agent?.alwaysPrivate && !privateMode && owner)} sensitive={Boolean(agent?.alwaysPrivate && !owner)} />

        <div
          className="scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="thread">
            {!session && (
              <AgentGrid
                customAgents={owner ? customAgents : []}
                onPick={(id) => startChat(id, tempMode)}
              />
            )}
            {session && messages.length === 0 && agent && (
              <div className="intro">
                <Avatar agent={agent} size={56} />
                <h2>{agent.name}</h2>
                <p className="muted">{agent.tagline}</p>
                {agent.attachmentHint && <p className="hint">💡 {agent.attachmentHint}</p>}
                <div className="starters">
                  {agent.starters.map((s) => (
                    <button key={s} className="starter" onClick={() => setInput(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {agent &&
              messages.map((m, i) => (
                <MessageView
                  key={m.id}
                  msg={m}
                  agent={agent}
                  chatTitle={session?.chat.title ?? "chat"}
                  streaming={busyId === m.id}
                  isLast={i === messages.length - 1}
                  busy={Boolean(busyId)}
                  boochi={Boolean(session?.temp && m.private)}
                  onRegenerate={() => void regenerate()}
                  onContinue={() => void runAssistant("continue")}
                />
              ))}
          </div>
        </div>

        <div className="composer-wrap">
          {toasts.length > 0 && (
            <div className="toasts">
              {toasts.map((t) => (
                <div key={t.id} className="toast">
                  {t.text}
                </div>
              ))}
            </div>
          )}
          <Composer
            value={input}
            onChange={setInput}
            attachments={pending}
            processing={processing}
            onFiles={(f) => void addFiles(f)}
            onLongText={(t) => {
              setPending((p) => [...p, textAttachment(t, `Pasted text ${p.filter((a) => a.name.startsWith("Pasted")).length + 1}.txt`)]);
              toast(`Long paste (${t.length.toLocaleString()} characters) attached in full as a text file.`);
            }}
            onRemove={(id) => setPending((p) => p.filter((a) => a.id !== id))}
            onSend={() => void send()}
            onStop={() => abortRef.current?.abort()}
            busy={Boolean(busyId)}
            placeholder={boochi ? "Boochi mode — nothing is saved…" : agent ? `Message ${agent.name}…` : "Ask anything, or pick an agent above…"}
            hint={agent?.attachmentHint}
          />
        </div>
      </main>

      {settingsOpen && (
        <Settings
          config={config}
          customAgents={customAgents}
          onSaveAgents={(a) => {
            setCustomAgents(a);
            void setKv("customAgents", a);
          }}
          onSignOut={async (wipe) => {
            abortRef.current?.abort();
            await logout().catch(() => {});
            if (wipe) await wipeCurrent();
            try {
              localStorage.removeItem(GUEST_FLAG);
            } catch {
              /* ignore */
            }
            location.reload();
          }}
          onWipeAll={async () => {
            abortRef.current?.abort();
            await wipeEverything();
            location.reload();
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function localStorageHasGuest() {
  try {
    return localStorage.getItem(GUEST_FLAG) === "1";
  } catch {
    return false;
  }
}

function MenuItem({ title, sub, active, onClick }: { title: string; sub: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`menu-item ${active ? "active" : ""}`} onClick={onClick}>
      <span>
        {active ? "✓ " : ""}
        {title}
      </span>
      <small className="muted">{sub}</small>
    </button>
  );
}

function ModeStrip(p: { owner: boolean; effectivePrivate: boolean; temp: boolean; boochi: boolean; forced: boolean; sensitive: boolean }) {
  let text: ReactNode;
  let cls = "mode-strip";
  if (p.boochi) {
    cls += " boochi";
    text = (
      <>
        <Ghost size={14} /> <b>Boochi mode</b> — private paid model, nothing saved anywhere. Gone when you close the tab.
      </>
    );
  } else if (p.owner && p.effectivePrivate) {
    cls += " private";
    text = (
      <>
        🔒 <b>Private</b> — paid, no-training models only{p.forced ? " (always on for this agent)" : ""}. {p.temp ? "Not saved." : "Saved on this device only."}
      </>
    );
  } else if (p.owner) {
    cls += " free";
    text = <>🌐 Free models first (they may train on prompts), paid as backup. {p.temp ? "Not saved." : "Saved on this device only."}</>;
  } else {
    cls += p.sensitive ? " warn" : " free";
    text = p.sensitive ? (
      <>⚠ Guest mode uses free models that may train on prompts. Don’t share medical, financial or personal details here.</>
    ) : (
      <>Guest · free models (may train on prompts). {p.temp ? "Not saved." : "Saved on this device only."}</>
    );
  }
  return <div className={cls}>{text}</div>;
}

function AgentGrid({ customAgents, onPick }: { customAgents: CustomAgent[]; onPick: (id: string) => void }) {
  const groups = new Map<string, Agent[]>();
  for (const a of AGENTS) {
    const g = CATEGORY_LABELS[a.category];
    groups.set(g, [...(groups.get(g) ?? []), a]);
  }
  return (
    <div className="agent-grid-wrap">
      <h2>What are we working on?</h2>
      <p className="muted">Pick an agent, or just type below to use General.</p>
      {customAgents.length > 0 && (
        <>
          <p className="group-label">Your agents</p>
          <div className="agent-grid">
            {customAgents.map((a) => (
              <button key={a.id} className="agent-card" onClick={() => onPick(a.id)}>
                <Avatar agent={{ emoji: a.emoji || "🤖", accent: CUSTOM_ACCENT }} />
                <span>
                  <b>{a.name}</b>
                  <small className="muted">Custom agent</small>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {[...groups].map(([label, list]) => (
        <div key={label}>
          <p className="group-label">{label}</p>
          <div className="agent-grid">
            {list.map((a) => (
              <button key={a.id} className="agent-card" onClick={() => onPick(a.id)}>
                <Avatar agent={a} />
                <span>
                  <b>
                    {a.name}
                    {a.alwaysPrivate ? " 🔒" : ""}
                  </b>
                  <small className="muted">{a.tagline}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
