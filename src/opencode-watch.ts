/**
 * opencode-watch.ts
 *
 * Long-lived SSE subscription to a local OpenCode server's /api/event stream.
 * Turns session lifecycle events into callbacks the pet can render, and keeps
 * an in-memory registry of sessions seen so far.
 *
 * Reconnects on drop and re-reads the service registration first, because a
 * restarted server may come back on a different port with a new password.
 */

import { discoverService, type ServiceEndpoint } from "./opencode-client.js";

export interface SessionState {
  readonly id: string;
  title?: string;
  directory?: string;
  status: "running" | "idle";
  outcome?: "succeeded" | "failed" | "interrupted";
  lastActivity: number;
}

export interface WatchCallbacks {
  /** Fired for every decoded event, before the reaction mapping. */
  onEvent?: (event: { type: string; sessionID?: string; payload: unknown }) => void;
  /** High-level state changes worth showing on the pet. */
  onStatus?: (update: { sessionID: string; status: "running" | "idle"; kind: "started" | "succeeded" | "failed" | "interrupted" | "enqueued" | "waiting"; tool?: string }) => void;
  onConnected?: (endpoint: ServiceEndpoint) => void;
  onDisconnected?: (reason: string) => void;
}

const RECONNECT_DELAY_MS = 3_000;

function parseDataLine(line: string): unknown {
  const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
  if (payload.length === 0) return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export class OpenCodeWatch {
  private readonly sessions = new Map<string, SessionState>();
  private readonly callbacks: WatchCallbacks;
  private controller: AbortController | undefined;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(callbacks: WatchCallbacks) {
    this.callbacks = callbacks;
  }

  /** Sessions seen by this watcher, newest activity first. */
  list(): SessionState[] {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }

  get(sessionID: string): SessionState | undefined {
    return this.sessions.get(sessionID);
  }

  /** Remember a session created outside the event stream (e.g. summon). */
  track(session: { id: string; title?: string; directory?: string }): void {
    this.sessions.set(session.id, { id: session.id, title: session.title, directory: session.directory, status: "idle", lastActivity: Date.now() });
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.controller?.abort();
    this.controller = undefined;
  }

  /** Connect, and keep reconnecting until stop() is called. */
  start(): void {
    this.stopped = false;
    void this.connect();
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.callbacks.onDisconnected?.(reason);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, RECONNECT_DELAY_MS);
    this.retryTimer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const endpoint = await discoverService();
    if (endpoint === undefined) {
      this.scheduleReconnect("no service registration");
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    let response: Response;
    try {
      response = await fetch(`${endpoint.url}/api/event`, {
        headers: { Authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`, Accept: "text/event-stream" },
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted) this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!response.ok || response.body === null) {
      this.scheduleReconnect(`event stream rejected: ${response.status}`);
      return;
    }
    this.callbacks.onConnected?.(endpoint);
    try {
      await this.consume(response.body);
    } catch (error) {
      if (!controller.signal.aborted) this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!this.stopped) this.scheduleReconnect("stream ended");
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const decoded = parseDataLine(line);
        if (decoded !== undefined) this.dispatch(decoded);
      }
    }
  }

  private dispatch(raw: unknown): void {
    const event = asRecord(raw);
    if (event === undefined) return;
    const type = typeof event.type === "string" ? event.type : "";
    const payload = asRecord(event.data) ?? asRecord(event.payload) ?? event;
    const sessionID = typeof event.sessionID === "string" ? event.sessionID : typeof payload.sessionID === "string" ? payload.sessionID : undefined;
    this.callbacks.onEvent?.({ type, sessionID, payload: raw });
    if (sessionID === undefined) return;
    this.applyEvent(sessionID, type, payload);
  }

  private applyEvent(sessionID: string, type: string, payload: Record<string, unknown>): void {
    const now = Date.now();
    const state = this.sessions.get(sessionID) ?? { id: sessionID, status: "idle" as const, lastActivity: now };
    const next: SessionState = { ...state, lastActivity: now };

    if (type === "session.inbox.enqueued") {
      this.sessions.set(sessionID, next);
      this.callbacks.onStatus?.({ sessionID, status: "running", kind: "enqueued" });
      return;
    }

    if (type === "session.execution.started") {
      next.status = "running";
      delete next.outcome;
      this.sessions.set(sessionID, next);
      this.callbacks.onStatus?.({ sessionID, status: "running", kind: "started" });
      return;
    }

    if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
      const kind = type.slice("session.execution.".length) as "succeeded" | "failed" | "interrupted";
      next.status = "idle";
      next.outcome = kind;
      this.sessions.set(sessionID, next);
      this.callbacks.onStatus?.({ sessionID, status: "idle", kind });
      return;
    }

    if (type === "session.tool.called" || type === "session.tool.success" || type === "session.tool.failed") {
      const tool = typeof payload.tool === "string" ? payload.tool : typeof payload.name === "string" ? payload.name : undefined;
      this.sessions.set(sessionID, next);
      this.callbacks.onStatus?.({ sessionID, status: next.status, kind: "started", tool });
      return;
    }

    // A permission request blocks the run until the user answers it. Surface it
    // as its own signal so the pet can hold a waiting pose instead of looking
    // busy while nothing is actually progressing.
    if (type === "permission.asked") {
      const tool = typeof payload.tool === "string" ? payload.tool : typeof payload.permission === "string" ? payload.permission : undefined;
      this.sessions.set(sessionID, next);
      this.callbacks.onStatus?.({ sessionID, status: "running", kind: "waiting", tool });
    }
  }
}
