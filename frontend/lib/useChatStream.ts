"use client";

import { useCallback, useRef, useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatEntityType = 'document' | 'ci' | 'contract' | 'license' | 'vulnerability';

export interface ChatCitation {
  entityType: ChatEntityType;
  entityId: string;
  documentId?: string;
  documentTitle: string;
  versionNumber?: number;
  page?: number;
  section?: string;
  snippet: string;
}

export type ChatStreamEvent =
  | { kind: "session";   sessionId: string }
  | { kind: "citations"; citations: ChatCitation[] }
  | { kind: "token";     token: string }
  | { kind: "done";      modelUsed: string; latencyMs: number; tokensUsed?: number }
  | { kind: "error";     message: string };

interface AskOptions {
  question: string;
  sessionId?: string;
  topK?: number;
  entityTypes?: ChatEntityType[];
  onEvent: (e: ChatStreamEvent) => void;
}

interface UseChatStreamResult {
  ask: (opts: AskOptions) => Promise<void>;
  isStreaming: boolean;
  error: string | null;
  reset: () => void;
}

// ─── SSE parser helpers ───────────────────────────────────────────────────────

interface SseFrame {
  event: string;
  data: string;
}

function parseSseChunk(chunk: string): SseFrame[] {
  const frames: SseFrame[] = [];
  // Blocks are separated by double newlines
  const blocks = chunk.split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data = line.slice(5).trim();
      }
    }
    if (data) {
      frames.push({ event, data });
    }
  }
  return frames;
}

function parsePayload(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useChatStream(): UseChatStreamResult {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const abortRef                      = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
    setError(null);
  }, []);

  const ask = useCallback(async (opts: AskOptions): Promise<void> => {
    const { question, sessionId, topK, entityTypes, onEvent } = opts;

    // Abort any in-flight stream
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setError(null);

    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

    try {
      const body: Record<string, unknown> = { question };
      if (sessionId) body.sessionId = sessionId;
      if (topK !== undefined) body.topK = topK;
      if (entityTypes && entityTypes.length > 0) body.entityTypes = entityTypes;

      const res = await fetch(`${apiBase}/api/chat/ask/stream`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 503) {
        const ev: ChatStreamEvent = {
          kind: "error",
          message: "RAG_DISABLED",
        };
        onEvent(ev);
        setError("RAG_DISABLED");
        setIsStreaming(false);
        return;
      }

      if (!res.ok) {
        const ev: ChatStreamEvent = {
          kind: "error",
          message: `HTTP ${res.status}`,
        };
        onEvent(ev);
        setError(`HTTP ${res.status}`);
        setIsStreaming(false);
        return;
      }

      if (!res.body) {
        const ev: ChatStreamEvent = { kind: "error", message: "No response body" };
        onEvent(ev);
        setError("No response body");
        setIsStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE blocks (terminated by double newline)
        const lastDoubleNewline = buffer.lastIndexOf("\n\n");
        if (lastDoubleNewline === -1) continue;

        const toProcess = buffer.slice(0, lastDoubleNewline + 2);
        buffer = buffer.slice(lastDoubleNewline + 2);

        const frames = parseSseChunk(toProcess);
        for (const frame of frames) {
          const payload = parsePayload(frame.data);
          if (payload === null) continue;

          switch (frame.event) {
            case "session": {
              const p = payload as { sessionId?: unknown };
              if (typeof p.sessionId === "string") {
                onEvent({ kind: "session", sessionId: p.sessionId });
              }
              break;
            }
            case "citations": {
              if (Array.isArray(payload)) {
                const citations: ChatCitation[] = (payload as unknown[]).map((item) => {
                  const c = item as Record<string, unknown>;
                  const entityType = (typeof c.entityType === "string" &&
                    ['document','ci','contract','license','vulnerability'].includes(c.entityType))
                    ? (c.entityType as ChatEntityType) : 'document';
                  return {
                    entityType,
                    entityId:      typeof c.entityId      === "string" ? c.entityId      : "",
                    documentId:    typeof c.documentId    === "string" ? c.documentId    : undefined,
                    documentTitle: typeof c.documentTitle === "string" ? c.documentTitle : "",
                    versionNumber: typeof c.versionNumber === "number" ? c.versionNumber : undefined,
                    page:          typeof c.page          === "number" ? c.page          : undefined,
                    section:       typeof c.section       === "string" ? c.section       : undefined,
                    snippet:       typeof c.snippet       === "string" ? c.snippet       : "",
                  };
                });
                onEvent({ kind: "citations", citations });
              }
              break;
            }
            case "token": {
              const p = payload as { t?: unknown };
              if (typeof p.t === "string") {
                onEvent({ kind: "token", token: p.t });
              }
              break;
            }
            case "done": {
              const p = payload as {
                modelUsed?: unknown;
                latencyMs?: unknown;
                tokensUsed?: unknown;
              };
              onEvent({
                kind:       "done",
                modelUsed:  typeof p.modelUsed  === "string" ? p.modelUsed  : "unknown",
                latencyMs:  typeof p.latencyMs  === "number" ? p.latencyMs  : 0,
                tokensUsed: typeof p.tokensUsed === "number" ? p.tokensUsed : undefined,
              });
              break;
            }
            case "error": {
              const p = payload as { message?: unknown };
              const msg = typeof p.message === "string" ? p.message : "Unknown error";
              onEvent({ kind: "error", message: msg });
              setError(msg);
              break;
            }
            default:
              break;
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Intentional abort — not an error
        return;
      }
      const msg = err instanceof Error ? err.message : "Stream error";
      onEvent({ kind: "error", message: msg });
      setError(msg);
    } finally {
      setIsStreaming(false);
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, []);

  return { ask, isStreaming, error, reset };
}
