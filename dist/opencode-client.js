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
/** Registration files to probe, most specific first. */
function registrationPaths() {
    const state = process.env.OPENCODE_STATE_DIR ?? join(homedir(), ".local", "state", "opencode");
    return [join(state, "service.json")];
}
/** Read the background service registration, or undefined when absent/invalid. */
export async function discoverService() {
    for (const path of registrationPaths()) {
        const raw = await readFile(path, "utf8").catch(() => undefined);
        if (raw === undefined)
            continue;
        const parsed = JSON.parse(raw);
        if (typeof parsed.url !== "string" || typeof parsed.pid !== "number" || typeof parsed.password !== "string")
            continue;
        return { url: parsed.url.replace(/\/$/, ""), pid: parsed.pid, password: parsed.password };
    }
    return undefined;
}
function authHeader(endpoint) {
    return `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}`;
}
/** Request helper: JSON in, JSON out, Basic auth applied. */
async function request(endpoint, path, init) {
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
    if (!response.ok)
        throw new Error(`OpenCode ${path} failed: ${response.status} ${text.slice(0, 300)}`);
    return (text.length === 0 ? undefined : JSON.parse(text));
}
/** Cheap liveness probe (throws when the server is gone). */
export async function serverInfo(endpoint) {
    return request(endpoint, "/api/info");
}
/**
 * Create a session bound to `directory` (the right-clicked folder).
 *
 * No model is sent: OpenCode picks it with its own resolution order (session
 * override → agent config → the last model used in this project → the account
 * default). The pet is only an observer, so it must never override that.
 */
export async function createSession(endpoint, directory, title) {
    const body = await request(endpoint, "/api/session", {
        method: "POST",
        body: JSON.stringify({ location: { directory }, ...(title === undefined ? {} : { title }) }),
    });
    return body.data;
}
export async function getSession(endpoint, sessionID) {
    const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}`);
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
export async function getSessionAfterModelSwitch(endpoint, sessionID, expected) {
    const attempts = 8;
    let session = await getSession(endpoint, sessionID);
    for (let attempt = 1; attempt < attempts; attempt += 1) {
        const current = session.model;
        if (current !== undefined && current.providerID === expected.providerID && current.id === expected.id)
            return session;
        await new Promise((resolve) => setTimeout(resolve, 120));
        session = await getSession(endpoint, sessionID);
    }
    return session;
}
/** All sessions known to the server, newest first (as the server returns them). */
export async function listSessions(endpoint) {
    const body = await request(endpoint, "/api/session");
    return body.data ?? [];
}
/** Every model the server exposes (used to build the right-click picker). */
export async function listModels(endpoint) {
    const body = await request(endpoint, "/api/model");
    const rows = [];
    for (const model of body.data ?? []) {
        const providerID = typeof model.providerID === "string" ? model.providerID : "";
        const id = typeof model.id === "string" ? model.id : typeof model.modelID === "string" ? model.modelID : "";
        if (providerID.length === 0 || id.length === 0)
            continue;
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
export async function setSessionModel(endpoint, sessionID, model) {
    await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/model`, {
        method: "POST",
        body: JSON.stringify({ model: { providerID: model.providerID, id: model.id } }),
    });
}
/** Map of sessionID -> active state (e.g. `{ type: "running" }`). */
export async function activeSessions(endpoint) {
    const body = await request(endpoint, "/api/session/active");
    return body.data ?? {};
}
/** Admit one user prompt; the agent loop starts unless `resume` is false. */
export async function sendPrompt(endpoint, sessionID, prompt) {
    await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text: prompt }),
    });
}
let cachedCliPath;
/**
 * Locate the opencode executable without assuming it is on PATH.
 *
 * Prefer the real `opencode.exe` (what the npm shim at
 * `C:\\Program Files\\nodejs\\opencode.cmd` forwards to). Spawning the shim
 * requires `shell: true`, which re-splits the path on its space and breaks.
 */
function resolveCliPath() {
    if (cachedCliPath !== undefined)
        return cachedCliPath;
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
/** The CLI child currently serving a turn; Stop kills it. */
let activeRun;
/** Kill the in-flight `opencode run`, if any. Resolves true when one was killed. */
export function abortRunPrompt() {
    const child = activeRun;
    if (child === undefined)
        return false;
    activeRun = undefined;
    child.kill();
    return true;
}
export async function runPrompt(sessionID, prompt, directory, model) {
    const cli = resolveCliPath();
    const args = ["run", "-s", sessionID, "--format", "json", "--auto"];
    // Forward the session's own model so the CLI does not fall back to the
    // directory default. The id must match the catalog entry exactly (case
    // included) or the run fails with `Model unavailable: provider/id`. Only
    // forward it when the session actually has one, so sessions with
    // `model: null` keep OpenCode's native resolution.
    if (model !== undefined)
        args.push("--model", `${model.providerID}/${model.id}`);
    args.push(prompt);
    console.log(`[opencode-run] spawn cli=${cli} cwd=${String(directory)} args=${args.length}`);
    return await new Promise((resolve) => {
        let child;
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
        }
        catch (error) {
            resolve({ ok: false, error: `启动 opencode 失败：${error instanceof Error ? error.message : String(error)}` });
            return;
        }
        activeRun = child;
        const texts = [];
        let stderr = "";
        let buffer = "";
        const drain = (chunk) => {
            buffer += chunk;
            let index = buffer.indexOf("\n");
            while (index !== -1) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                if (line.startsWith("{")) {
                    try {
                        const event = JSON.parse(line);
                        if (event.type === "text" && typeof event.part?.text === "string" && event.part.text.length > 0)
                            texts.push(event.part.text);
                        if (event.type === "error" && event.error !== undefined)
                            stderr += `\n${JSON.stringify(event.error).slice(0, 400)}`;
                    }
                    catch {
                        // Partial or non-JSON line: ignore.
                    }
                }
                index = buffer.indexOf("\n");
            }
        };
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => drain(chunk));
        child.stderr?.on("data", (chunk) => {
            stderr += chunk;
            for (const line of chunk.split(/\r?\n/)) {
                if (line.trim().length > 0)
                    console.log(`[opencode-run] ${line}`);
            }
        });
        child.on("error", (error) => {
            if (activeRun === child)
                activeRun = undefined;
            resolve({ ok: false, error: `启动 opencode 失败：${error.message}` });
        });
        child.on("close", (code) => {
            const wasActive = activeRun === child;
            if (wasActive)
                activeRun = undefined;
            if (buffer.trim().startsWith("{"))
                drain("\n");
            const reply = texts.join("").trim();
            if (reply.length > 0)
                resolve({ ok: true, reply });
            else if (!wasActive)
                resolve({ ok: false, error: "已停止思考" });
            else if (code === 0)
                resolve({ ok: false, error: "OpenCode 没有返回文本" });
            else
                resolve({ ok: false, error: `opencode run 退出码 ${String(code)}${stderr.trim().length > 0 ? `：${stderr.trim().slice(0, 400)}` : ""}` });
        });
    });
}
/** Stop the running agent loop for a session (used when the pet is dismissed). */
export async function interruptSession(endpoint, sessionID) {
    await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/interrupt`, { method: "POST", body: "{}" }).catch(() => undefined);
}
function describeError(message) {
    const detail = (typeof message.error?.message === "string" ? message.error.message : "") ||
        (typeof message.retry?.error?.message === "string" ? message.retry.error.message : "");
    if (detail.length > 0)
        return detail;
    if (message.error !== undefined || message.retry?.error !== undefined)
        return "OpenCode 返回了未知错误";
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
export async function readTimeline(endpoint, sessionID) {
    const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/message`);
    const rows = (body.data ?? []).flatMap((message) => {
        const role = message.type ?? message.role ?? "assistant";
        const error = describeError(message);
        // A failed turn (e.g. provider 503) has no visible text, so surface it as
        // its own row instead of dropping it: the panel can then explain the
        // failure instead of appearing to hang.
        if (role === "idle") {
            if (error === undefined)
                return [];
            return [{ id: message.id, role: "error", text: error, time: message.time?.created, error }];
        }
        const blocks = message.content ?? message.parts ?? [];
        const fromBlocks = blocks
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n")
            .trim();
        // User prompts live on the message itself; assistant answers live in content.
        const text = fromBlocks.length > 0
            ? fromBlocks
            : typeof message.text === "string" ? message.text.trim() : "";
        if (role !== "user" && role !== "assistant")
            return [];
        if (text.length === 0) {
            if (error === undefined)
                return [];
            return [{ id: message.id, role, text: "", time: message.time?.created, error }];
        }
        return [{ id: message.id, role, text, time: message.time?.created, ...(error === undefined ? {} : { error }) }];
    });
    return rows.reverse();
}
