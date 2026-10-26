/**
 * opencode-client.ts
 *
 * Minimal HTTP client for a local OpenCode core server, used by the desktop
 * pet ("path A": external observer over the public /api surface).
 *
 * Discovery: the CLI writes its background service registration to
 *   ~/.local/state/opencode/service.json   (POSIX-style home dir on all OSes)
 * which carries { url, pid, password }. Auth is HTTP Basic with the fixed
 * username "opencode" and that password.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServiceEndpoint {
  readonly url: string;
  readonly pid: number;
  readonly password: string;
}

export interface SessionInfo {
  readonly id: string;
  readonly title?: string;
  readonly projectID?: string;
  readonly location?: { readonly directory?: string; readonly workspaceID?: string };
  readonly time?: { readonly created?: number; readonly updated?: number; readonly idle?: number };
  readonly outcome?: "succeeded" | "failed" | "interrupted";
}

/** Registration files to probe, most specific first. */
function registrationPaths(): string[] {
  const state = process.env.OPENCODE_STATE_DIR ?? join(homedir(), ".local", "state", "opencode");
  return [join(state, "service.json")];
}

/** Read the background service registration, or undefined when absent/invalid. */
export async function discoverService(): Promise<ServiceEndpoint | undefined> {
  for (const path of registrationPaths()) {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    const parsed = JSON.parse(raw) as { url?: unknown; pid?: unknown; password?: unknown };
    if (typeof parsed.url !== "string" || typeof parsed.pid !== "number" || typeof parsed.password !== "string") continue;
    return { url: parsed.url.replace(/\/$/, ""), pid: parsed.pid, password: parsed.password };
  }
  return undefined;
}

function authHeader(endpoint: ServiceEndpoint): string {
  return `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`;
}

/** Request helper: JSON in, JSON out, Basic auth applied. */
async function request<T>(endpoint: ServiceEndpoint, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${endpoint.url}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(endpoint),
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
    signal: init?.signal ?? AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenCode ${path} failed: ${response.status} ${text.slice(0, 300)}`);
  return (text.length === 0 ? undefined : JSON.parse(text)) as T;
}

/** Cheap liveness probe (throws when the server is gone). */
export async function serverInfo(endpoint: ServiceEndpoint): Promise<{ version: string; pid: number }> {
  return request<{ version: string; pid: number }>(endpoint, "/api/info");
}

/** Create a session bound to `directory` (the right-clicked folder). */
export async function createSession(endpoint: ServiceEndpoint, directory: string, title?: string): Promise<SessionInfo> {
  const body = await request<{ data: SessionInfo }>(endpoint, "/api/session", {
    method: "POST",
    body: JSON.stringify({ location: { directory }, ...(title === undefined ? {} : { title }) }),
  });
  return body.data;
}

export async function getSession(endpoint: ServiceEndpoint, sessionID: string): Promise<SessionInfo> {
  const body = await request<{ data: SessionInfo }>(endpoint, `/api/session/${encodeURIComponent(sessionID)}`);
  return body.data;
}

/** Map of sessionID -> active state (e.g. `{ type: "running" }`). */
export async function activeSessions(endpoint: ServiceEndpoint): Promise<Record<string, { type: string }>> {
  const body = await request<{ data: Record<string, { type: string }> }>(endpoint, "/api/session/active");
  return body.data ?? {};
}

/** Admit one user prompt; the agent loop starts unless `resume` is false. */
export async function sendPrompt(endpoint: ServiceEndpoint, sessionID: string, prompt: string): Promise<void> {
  await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: prompt }),
  });
}

/** Stop the running agent loop for a session (used when the pet is dismissed). */
export async function interruptSession(endpoint: ServiceEndpoint, sessionID: string): Promise<void> {
  await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/interrupt`, { method: "POST", body: "{}" }).catch(() => undefined);
}

export interface TimelineEntry {
  readonly id: string;
  readonly role: "user" | "assistant" | string;
  readonly text: string;
  readonly time?: number;
}

type RawMessage = {
  id: string;
  type?: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  parts?: Array<{ type: string; text?: string }>;
  time?: { created?: number };
};

/**
 * Flatten the projected message timeline into simple role/text rows.
 *
 * The v2 projection puts visible text under `content` (not `parts`) and labels
 * the row with `type` (`user` | `assistant` | `idle`) rather than `role`.
 * Reasoning blocks are dropped: the pet only needs the answer.
 *
 * The projection returns newest first; the chat panel renders oldest first,
 * so the flattened rows are reversed here once.
 */
export async function readTimeline(endpoint: ServiceEndpoint, sessionID: string): Promise<TimelineEntry[]> {
  const body = await request<{ data: RawMessage[] }>(endpoint, `/api/session/${encodeURIComponent(sessionID)}/message`);
  const rows = (body.data ?? []).flatMap((message) => {
    const blocks = message.content ?? message.parts ?? [];
    const text = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
    if (text.length === 0) return [];
    const role = message.type ?? message.role ?? "assistant";
    if (role !== "user" && role !== "assistant") return [];
    return [{ id: message.id, role, text, time: message.time?.created }];
  });
  return rows.reverse();
}
