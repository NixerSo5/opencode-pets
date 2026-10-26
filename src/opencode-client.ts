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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServiceEndpoint {
  readonly url: string;
  readonly pid: number;
  readonly password: string;
}

export interface SessionModel {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

export interface SessionInfo {
  readonly id: string;
  readonly title?: string;
  readonly projectID?: string;
  readonly location?: { readonly directory?: string; readonly workspaceID?: string };
  readonly time?: { readonly created?: number; readonly updated?: number; readonly idle?: number };
  readonly outcome?: "succeeded" | "failed" | "interrupted";
  /** Absent when the server has not pinned a model on this session. */
  readonly model?: SessionModel;
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

/**
 * Create a session bound to `directory` (the right-clicked folder).
 *
 * No model is sent: OpenCode picks it with its own resolution order (session
 * override → agent config → the last model used in this project → the account
 * default). The pet is only an observer, so it must never override that.
 */
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

/**
 * Read a session, waiting for a just-issued model switch to become visible.
 *
 * `POST /api/session/{id}/model` publishes `SessionEvent.ModelSelected`, whose
 * projection writes the session row asynchronously. A read issued right after
 * the 204 can therefore still see the previous model, so poll briefly (about
 * one second total) until the row matches what we asked for. Any other model
 * is accepted as-is once the budget runs out: the caller only needs a display
 * value, never a hard failure.
 */
export async function getSessionAfterModelSwitch(
  endpoint: ServiceEndpoint,
  sessionID: string,
  expected: { readonly providerID: string; readonly id: string },
): Promise<SessionInfo> {
  const attempts = 8;
  let session = await getSession(endpoint, sessionID);
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    const current = session.model;
    if (current !== undefined && current.providerID === expected.providerID && current.id === expected.id) return session;
    await new Promise((resolve) => setTimeout(resolve, 120));
    session = await getSession(endpoint, sessionID);
  }
  return session;
}

/** All sessions known to the server, newest first (as the server returns them). */
export async function listSessions(endpoint: ServiceEndpoint): Promise<SessionInfo[]> {
  const body = await request<{ data: SessionInfo[] }>(endpoint, "/api/session");
  return body.data ?? [];
}

export interface ModelOption {
  readonly providerID: string;
  readonly id: string;
  readonly name: string;
}

/** Every model the server exposes (used to build the right-click picker). */
export async function listModels(endpoint: ServiceEndpoint): Promise<ModelOption[]> {
  const body = await request<{ data: Array<{ id?: string; modelID?: string; providerID?: string; name?: string }> }>(endpoint, "/api/model");
  const rows: ModelOption[] = [];
  for (const model of body.data ?? []) {
    const providerID = typeof model.providerID === "string" ? model.providerID : "";
    const id = typeof model.id === "string" ? model.id : typeof model.modelID === "string" ? model.modelID : "";
    if (providerID.length === 0 || id.length === 0) continue;
    rows.push({ providerID, id, name: typeof model.name === "string" && model.name.length > 0 ? model.name : id });
  }
  return rows;
}

/**
 * Switch an existing session's model. This is an explicit user action from the
 * pet's right-click menu, not an implicit override during session creation.
 *
 * The model field is not part of `PATCH /api/session/{id}` (session.update);
 * it has its own endpoint, `POST /api/session/{id}/model`, which publishes
 * `SessionEvent.ModelSelected` and answers 204.
 */
export async function setSessionModel(endpoint: ServiceEndpoint, sessionID: string, model: { providerID: string; id: string }): Promise<void> {
  await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/model`, {
    method: "POST",
    body: JSON.stringify({ model: { providerID: model.providerID, id: model.id } }),
  });
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

/**
 * Run one turn through the real CLI (`opencode run`), which is what the user
 * does interactively. The v2 HTTP `prompt` endpoint only steers an already
 * running agent, so it never executes anything on an idle session.
 *
 * `--format json` emits one JSON object per line; assistant output arrives as
 * `{ type: "text", part: { text } }`.
 */
export interface RunPromptResult {
  readonly ok: boolean;
  readonly reply?: string;
  readonly error?: string;
}

let cachedCliPath: string | undefined;

/**
 * Locate the opencode executable without assuming it is on PATH.
 *
 * Prefer the real `opencode.exe` (what the npm shim at
 * `C:\\Program Files\\nodejs\\opencode.cmd` forwards to). Spawning the shim
 * requires `shell: true`, which re-splits the path on its space and breaks.
 */
function resolveCliPath(): string {
  if (cachedCliPath !== undefined) return cachedCliPath;
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = [
    join(programFiles, "nodejs", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
    join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedCliPath = candidate;
      return candidate;
    }
  }
  // Last resort: bare name, relies on PATH plus shell resolution.
  cachedCliPath = "opencode";
  return cachedCliPath;
}

/**
 * Every CLI child currently serving a turn. This used to be a single slot, but
 * the panel can queue several prompts; a second spawn would overwrite the first
 * child, and the first one's `close` handler would then mistake itself for a
 * cancelled run and drop the reply it had already collected.
 */
const activeRuns = new Set<import("node:child_process").ChildProcess>();

/** Kill every in-flight `opencode run`. Resolves true when at least one was killed. */
export function abortRunPrompt(): boolean {
  if (activeRuns.size === 0) return false;
  for (const child of activeRuns) child.kill();
  activeRuns.clear();
  return true;
}

export async function runPrompt(
  sessionID: string,
  prompt: string,
  directory?: string,
  model?: { providerID: string; id: string },
): Promise<RunPromptResult> {
  const cli = resolveCliPath();
  const args = ["run", "-s", sessionID, "--format", "json", "--auto"];
  // Forward the session's own model so the CLI does not fall back to the
  // directory default. The id must match the catalog entry exactly (case
  // included) or the run fails with `Model unavailable: provider/id`. Only
  // forward it when the session actually has one, so sessions with
  // `model: null` keep OpenCode's native resolution.
  if (model !== undefined) args.push("--model", `${model.providerID}/${model.id}`);
  args.push(prompt);
  console.log(`[opencode-run] spawn cli=${cli} cwd=${String(directory)} args=${args.length}`);
  return await new Promise<RunPromptResult>((resolve) => {
    let child: import("node:child_process").ChildProcess;
    try {
      child = spawn(cli, args, {
        cwd: directory,
        windowsHide: true,
        // An open stdin pipe makes `opencode run` wait for EOF forever: it
        // assumes an interactive caller is going to feed it more input. Give
        // it a closed stdin so it starts the turn immediately.
        stdio: ["ignore", "pipe", "pipe"],
        // Only a bare fallback name needs the shell; an absolute .exe path must
        // be passed verbatim so spaces in `Program Files` survive.
        shell: !cli.includes("\\") && !cli.includes("/"),
        env: { ...process.env, NO_COLOR: "1" },
      });
    } catch (error) {
      resolve({ ok: false, error: `启动 opencode 失败：${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    activeRuns.add(child);
    const texts: string[] = [];
    let stderr = "";
    let buffer = "";
    const drain = (chunk: string): void => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith("{")) {
          try {
            const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string }; error?: unknown };
            if (event.type === "text" && typeof event.part?.text === "string" && event.part.text.length > 0) texts.push(event.part.text);
            if (event.type === "error" && event.error !== undefined) stderr += `\n${JSON.stringify(event.error).slice(0, 400)}`;
          } catch {
            // Partial or non-JSON line: ignore.
          }
        }
        index = buffer.indexOf("\n");
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => drain(chunk));
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) console.log(`[opencode-run] ${line}`);
      }
    });
    child.on("error", (error) => {
      activeRuns.delete(child);
      resolve({ ok: false, error: `启动 opencode 失败：${error.message}` });
    });
    child.on("close", (code) => {
      // `wasActive` is false only when Stop killed this exact child, not when a
      // later turn registered another one.
      const wasActive = activeRuns.delete(child);
      if (buffer.trim().startsWith("{")) drain("\n");
      const reply = texts.join("").trim();
      if (reply.length > 0) resolve({ ok: true, reply });
      else if (!wasActive) resolve({ ok: false, error: "已停止思考" });
      else if (code === 0) resolve({ ok: false, error: "OpenCode 没有返回文本" });
      else resolve({ ok: false, error: `opencode run 退出码 ${String(code)}${stderr.trim().length > 0 ? `：${stderr.trim().slice(0, 400)}` : ""}` });
    });
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
  /** Present when the server reported a failure for this turn (e.g. 503). */
  readonly error?: string;
}

type RawMessage = {
  id: string;
  type?: string;
  role?: string;
  /** User prompts in the v2 projection carry their text here, not in `content`. */
  text?: string;
  content?: Array<{ type: string; text?: string }>;
  parts?: Array<{ type: string; text?: string }>;
  time?: { created?: number };
  outcome?: string;
  error?: { message?: string };
  /** Auto-retry state: the error lives under `retry.error`, not `error`. */
  retry?: { attempt?: number; error?: { message?: string; status?: number } };
};

function describeError(message: RawMessage): string | undefined {
  const detail =
    (typeof message.error?.message === "string" ? message.error.message : "") ||
    (typeof message.retry?.error?.message === "string" ? message.retry.error.message : "");
  if (detail.length > 0) return detail;
  if (message.error !== undefined || message.retry?.error !== undefined) return "OpenCode 返回了未知错误";
  return undefined;
}

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
    const role = message.type ?? message.role ?? "assistant";
    const error = describeError(message);
    // A failed turn (e.g. provider 503) has no visible text, so surface it as
    // its own row instead of dropping it: the panel can then explain the
    // failure instead of appearing to hang.
    if (role === "idle") {
      if (error === undefined) return [];
      return [{ id: message.id, role: "error", text: error, time: message.time?.created, error }];
    }
    const blocks = message.content ?? message.parts ?? [];
    const fromBlocks = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
    // User prompts live on the message itself; assistant answers live in content.
    const text = fromBlocks.length > 0
      ? fromBlocks
      : typeof message.text === "string" ? message.text.trim() : "";
    if (role !== "user" && role !== "assistant") return [];
    if (text.length === 0) {
      if (error === undefined) return [];
      return [{ id: message.id, role, text: "", time: message.time?.created, error }];
    }
    return [{ id: message.id, role, text, time: message.time?.created, ...(error === undefined ? {} : { error }) }];
  });
  return rows.reverse();
}
