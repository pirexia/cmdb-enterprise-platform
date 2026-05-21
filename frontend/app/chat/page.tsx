"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  Sparkles,
  Send,
  Plus,
  Trash2,
  MessageSquare,
  RefreshCw,
  AlertTriangle,
  FileText,
  Server,
  FileSignature,
  Key,
  ShieldAlert,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiFetch } from "@/lib/apiFetch";
import { useChatStream } from "@/lib/useChatStream";
import type { ChatCitation, ChatEntityType, ChatStreamEvent } from "@/lib/useChatStream";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: ChatCitation[] | null;
  modelUsed: string | null;
  createdAt: string;
  /** true while we are still streaming into this bubble */
  pending?: boolean;
  /** true if the message errored */
  errored?: boolean;
}

// ─── Citation chip ────────────────────────────────────────────────────────────

/**
 * Resolves a citation to its destination URL. Documents go to their dedicated
 * detail page; other entity types deep-link to their listing with ?focus=<id>
 * so the listing can auto-open the corresponding modal (v2.N6). For
 * vulnerabilities the backend's entityId is a synthetic UUID v5 that the
 * frontend can't reverse, so we pass the human-readable CVE-ID (carried in
 * documentTitle) as ?cve= — the listing matches rows by that.
 */
function citationHref(c: ChatCitation): string {
  switch (c.entityType) {
    case 'document':      return `/documents/${c.entityId}`;
    case 'ci':            return `/inventory?focus=${c.entityId}`;
    case 'contract':      return `/contracts?focus=${c.entityId}`;
    case 'license':       return `/licenses?focus=${c.entityId}`;
    case 'vulnerability': return `/vulnerabilities?cve=${encodeURIComponent(c.documentTitle)}`;
  }
}

function CitationChip({
  index,
  citation,
}: {
  index: number;
  citation: ChatCitation;
}) {
  const label = `[${index + 1}] ${citation.documentTitle}${
    citation.versionNumber ? ` (v${citation.versionNumber})` : ""
  }${citation.section ? ` — ${citation.section}` : ""}${
    citation.page ? `, p.${citation.page}` : ""
  }`;

  const tooltip = citation.snippet || label;

  return (
    <Link
      href={citationHref(citation)}
      title={tooltip}
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 hover:bg-[var(--accent)]/10 hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors max-w-[260px] truncate"
    >
      <span className="font-mono font-semibold text-[var(--accent)]">[{index + 1}]</span>
      <span className="truncate">{citation.documentTitle}</span>
      {citation.versionNumber !== undefined && citation.versionNumber > 0 && (
        <span className="flex-shrink-0 text-slate-400">v{citation.versionNumber}</span>
      )}
      {citation.section && (
        <span className="flex-shrink-0 text-slate-400 hidden sm:inline">— {citation.section}</span>
      )}
      {citation.page && (
        <span className="flex-shrink-0 text-slate-400">p.{citation.page}</span>
      )}
    </Link>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function MessageBubble({ msg, t }: { msg: ChatMessage; t: (key: string) => string }) {
  const isUser = msg.role === "user";

  return (
    <div
      className={`flex flex-col gap-1.5 ${isUser ? "items-end" : "items-start"}`}
    >
      {/* Role label */}
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1">
        {isUser ? t("chat.user") : t("chat.assistant")}
      </span>

      {/* Bubble */}
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 text-sm leading-relaxed shadow-sm ${
          isUser
            ? "bg-[var(--accent)] text-white"
            : msg.errored
            ? "border border-red-200 bg-red-50 text-red-700"
            : "border border-slate-200 bg-white text-slate-800"
        }`}
      >
        {msg.pending && !msg.content ? (
          <span className="flex items-center gap-2 text-slate-400">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            <span className="text-xs italic">…</span>
          </span>
        ) : (
          <div className="whitespace-pre-wrap break-words">{msg.content}</div>
        )}
      </div>

      {/* Citations */}
      {!isUser && msg.citations && msg.citations.length > 0 && (
        <div className="max-w-[85%] px-1">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {t("chat.citations")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {msg.citations.map((c, i) => (
              <CitationChip key={`${c.entityType}-${c.entityId}-${i}`} index={i} citation={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const { t } = useLanguage();
  const { ask, isStreaming } = useChatStream();

  // Session list
  const [sessions, setSessions]           = useState<ChatSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  // Active session
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages]           = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  // Input
  const [question, setQuestion]           = useState("");

  // Source filter chips (E4a)
  const ENTITY_TYPES: { key: ChatEntityType; i18n: string; icon: typeof FileText }[] = [
    { key: 'document',      i18n: 'chat.filter.documents',       icon: FileText      },
    { key: 'ci',            i18n: 'chat.filter.cis',             icon: Server        },
    { key: 'contract',      i18n: 'chat.filter.contracts',       icon: FileSignature },
    { key: 'license',       i18n: 'chat.filter.licenses',        icon: Key           },
    { key: 'vulnerability', i18n: 'chat.filter.vulnerabilities', icon: ShieldAlert   },
  ];

  const [selectedEntityTypes, setSelectedEntityTypes] = useState<ChatEntityType[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = sessionStorage.getItem('chat.filter.entityTypes');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const allowed: ChatEntityType[] = ['document', 'ci', 'contract', 'license', 'vulnerability'];
      return parsed.filter((x): x is ChatEntityType => typeof x === 'string' && (allowed as string[]).includes(x));
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem('chat.filter.entityTypes', JSON.stringify(selectedEntityTypes));
    } catch {
      /* sessionStorage may be unavailable; ignore */
    }
  }, [selectedEntityTypes]);

  const toggleEntityType = (k: ChatEntityType) =>
    setSelectedEntityTypes((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  // Status / error banners
  const [ragDisabled, setRagDisabled]     = useState(false);
  const [banner, setBanner]               = useState<string | null>(null);

  // Auto-scroll ref
  const threadEndRef = useRef<HTMLDivElement>(null);

  // ── Scroll to bottom whenever messages change ──
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Load session list ──
  const fetchSessions = useCallback(async () => {
    try {
      const res = await apiFetch("/api/chat/sessions");
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = (await res.json()) as ChatSession[];
      setSessions(data);
      return data;
    } catch {
      return [] as ChatSession[];
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  // ── Load messages for a session ──
  const fetchMessages = useCallback(async (sessionId: string) => {
    setMessagesLoading(true);
    try {
      const res = await apiFetch(`/api/chat/sessions/${sessionId}/messages`);
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const data = (await res.json()) as ChatMessage[];
      setMessages(data);
    } catch {
      setMessages([]);
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  // ── On mount: load sessions, auto-select most recent ──
  useEffect(() => {
    fetchSessions().then((data) => {
      if (data.length > 0 && !selectedSessionId) {
        const mostRecent = data.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )[0];
        setSelectedSessionId(mostRecent.id);
        fetchMessages(mostRecent.id);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── When selectedSessionId changes, load its messages ──
  const handleSelectSession = useCallback(
    (sessionId: string) => {
      if (sessionId === selectedSessionId) return;
      setSelectedSessionId(sessionId);
      setMessages([]);
      fetchMessages(sessionId);
    },
    [selectedSessionId, fetchMessages]
  );

  // ── New session ──
  const handleNewSession = useCallback(() => {
    setSelectedSessionId(null);
    setMessages([]);
    setQuestion("");
    setBanner(null);
    setRagDisabled(false);
  }, []);

  // ── Delete session ──
  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!confirm(t("chat.confirmDelete"))) return;
      try {
        const res = await apiFetch(`/api/chat/sessions/${sessionId}`, {
          method: "DELETE",
        });
        if (!res.ok && res.status !== 404) throw new Error(`Status ${res.status}`);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (selectedSessionId === sessionId) {
          setSelectedSessionId(null);
          setMessages([]);
        }
      } catch {
        setBanner(t("chat.error.generic"));
      }
    },
    [selectedSessionId, t]
  );

  // ── Send question ──
  const handleSend = useCallback(async () => {
    const trimmed = question.trim();
    if (!trimmed) {
      setBanner(t("chat.error.empty"));
      return;
    }
    if (isStreaming) return;
    setBanner(null);
    setRagDisabled(false);
    setQuestion("");

    // Optimistic user bubble
    const userBubble: ChatMessage = {
      id:        `opt-user-${Date.now()}`,
      role:      "user",
      content:   trimmed,
      citations: null,
      modelUsed: null,
      createdAt: new Date().toISOString(),
    };

    // Placeholder assistant bubble
    const assistantBubble: ChatMessage = {
      id:        `opt-asst-${Date.now()}`,
      role:      "assistant",
      content:   "",
      citations: null,
      modelUsed: null,
      createdAt: new Date().toISOString(),
      pending:   true,
    };

    setMessages((prev) => [...prev, userBubble, assistantBubble]);
    const assistantId = assistantBubble.id;

    let resolvedSessionId = selectedSessionId ?? undefined;

    await ask({
      question: trimmed,
      sessionId: resolvedSessionId,
      entityTypes: selectedEntityTypes.length > 0 ? selectedEntityTypes : undefined,
      onEvent: (ev: ChatStreamEvent) => {
        switch (ev.kind) {
          case "session": {
            resolvedSessionId = ev.sessionId;
            setSelectedSessionId(ev.sessionId);
            // Refresh session list to include new session
            fetchSessions();
            break;
          }
          case "citations": {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, citations: ev.citations } : m
              )
            );
            break;
          }
          case "token": {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: m.content + ev.token, pending: true }
                  : m
              )
            );
            break;
          }
          case "done": {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, pending: false, modelUsed: ev.modelUsed }
                  : m
              )
            );
            break;
          }
          case "error": {
            if (ev.message === "RAG_DISABLED") {
              setRagDisabled(true);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: t("chat.disabled"),
                        pending: false,
                        errored: true,
                      }
                    : m
                )
              );
            } else {
              setBanner(t("chat.error.generic"));
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: t("chat.error.generic"),
                        pending: false,
                        errored: true,
                      }
                    : m
                )
              );
            }
            break;
          }
        }
      },
    });
  }, [question, isStreaming, selectedSessionId, ask, t, fetchSessions]);

  // ── Keyboard handler for textarea ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // ── Sort sessions newest first ──
  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
        <div className="flex items-center gap-3">
          <Sparkles className="h-5 w-5 text-[var(--accent)]" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t("chat.title")}</h1>
          </div>
        </div>
      </header>

      {/* RAG disabled banner */}
      {ragDisabled && (
        <div className="mx-6 mt-4 flex items-center gap-3 rounded-none border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>{t("chat.disabled")}</span>
          <button
            onClick={() => setRagDisabled(false)}
            className="ml-auto text-amber-600 hover:text-amber-800"
          >
            ✕
          </button>
        </div>
      )}

      {/* Error banner */}
      {banner && (
        <div className="mx-6 mt-4 flex items-center gap-3 rounded-none border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>{banner}</span>
          <button
            onClick={() => setBanner(null)}
            className="ml-auto text-red-500 hover:text-red-700"
          >
            ✕
          </button>
        </div>
      )}

      {/* Body: two-column layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left panel: session list ── */}
        <aside className="flex w-[280px] flex-shrink-0 flex-col border-r border-slate-200 bg-white">
          {/* New session button */}
          <div className="border-b border-slate-200 px-3 py-3">
            <button
              onClick={handleNewSession}
              className="flex w-full items-center gap-2 rounded-none border border-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
            >
              <Plus className="h-4 w-4" />
              {t("chat.newSession")}
            </button>
          </div>

          {/* Session list */}
          <div className="flex-1 overflow-y-auto">
            {sessionsLoading ? (
              <div className="flex items-center justify-center py-10 text-slate-400">
                <RefreshCw className="h-4 w-4 animate-spin" />
              </div>
            ) : sortedSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-slate-400">
                <MessageSquare className="h-8 w-8" />
                <p className="text-sm">{t("chat.noSessions")}</p>
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {sortedSessions.map((session) => (
                  <li key={session.id} className="group relative">
                    <button
                      onClick={() => handleSelectSession(session.id)}
                      className={`flex w-full flex-col items-start px-4 py-3 text-left transition-colors hover:bg-slate-50 ${
                        selectedSessionId === session.id
                          ? "border-l-2 border-[var(--accent)] bg-[var(--accent)]/5"
                          : "border-l-2 border-transparent"
                      }`}
                    >
                      <span
                        className={`line-clamp-2 text-sm font-medium ${
                          selectedSessionId === session.id
                            ? "text-[var(--accent)]"
                            : "text-slate-700"
                        }`}
                      >
                        {session.title}
                      </span>
                      <span className="mt-0.5 text-xs text-slate-400">
                        {new Date(session.updatedAt).toLocaleDateString(undefined, {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    </button>

                    {/* Delete button on hover */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteSession(session.id);
                      }}
                      aria-label={t("chat.deleteSession")}
                      title={t("chat.deleteSession")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* ── Right panel: thread + input ── */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Thread */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {messagesLoading ? (
              <div className="flex items-center justify-center py-20 text-slate-400">
                <RefreshCw className="h-5 w-5 animate-spin" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
                <Sparkles className="h-10 w-10 opacity-40" />
                <p className="text-sm">{t("chat.noSessions")}</p>
              </div>
            ) : (
              <div className="mx-auto max-w-3xl space-y-6">
                {messages.map((msg) => (
                  <MessageBubble key={msg.id} msg={msg} t={t} />
                ))}
                <div ref={threadEndRef} />
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="border-t border-slate-200 bg-white px-6 py-4">
            <div className="mx-auto max-w-3xl">
              {/* Source filter chips (E4a) */}
              <div className="mb-3 flex items-center gap-2 flex-wrap text-xs">
                <span className="font-medium text-slate-500">{t("chat.filter.label")}</span>
                {ENTITY_TYPES.map(({ key, i18n, icon: Icon }) => {
                  const active = selectedEntityTypes.includes(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleEntityType(key)}
                      aria-pressed={active}
                      className={
                        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 border transition-colors " +
                        (active
                          ? "bg-[var(--accent)] text-white border-[var(--accent)] hover:opacity-90"
                          : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50")
                      }
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{t(i18n)}</span>
                    </button>
                  );
                })}
                {selectedEntityTypes.length === 0 ? (
                  <span className="text-slate-400 italic">{t("chat.filter.all")}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSelectedEntityTypes([])}
                    className="ml-2 text-[var(--accent)] hover:underline"
                  >
                    {t("chat.filter.clear")}
                  </button>
                )}
              </div>

              {/* Streaming status */}
              {isStreaming && (
                <p className="mb-2 flex items-center gap-2 text-xs text-slate-500">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
                  {t("chat.thinking")}
                </p>
              )}

              <div className="flex items-end gap-3">
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={t("chat.placeholder")}
                  disabled={isStreaming}
                  rows={3}
                  className="flex-1 resize-none rounded-none border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20 disabled:opacity-50"
                />
                <button
                  onClick={handleSend}
                  disabled={isStreaming || !question.trim()}
                  className="flex items-center gap-2 rounded-none bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed self-stretch"
                >
                  {isStreaming ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {t("chat.sendButton")}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
