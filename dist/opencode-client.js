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
/**
 * Delete a session and its child sessions (`operationId: session.remove`).
 *
 * `DELETE /api/session/{id}` answers 204, or 404 with SessionNotFoundError when
 * the id is unknown. Declared in /openapi.json even though probing a made-up id
 * looks like a missing route.
 */
export async function deleteSession(endpoint, sessionID) {
    await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}`, { method: "DELETE" });
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
/** Permissions the session is currently blocked on (empty when none). */
export async function listPermissions(endpoint, sessionID) {
    const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/permission`);
    return (body.data ?? []).map((row) => ({
        id: typeof row.id === "string" ? row.id : "",
        sessionID: typeof row.sessionID === "string" ? row.sessionID : sessionID,
        tool: typeof row.tool === "string" ? row.tool : undefined,
        title: typeof row.title === "string" ? row.title : undefined,
        description: typeof row.description === "string" ? row.description : undefined,
    })).filter((row) => row.id.length > 0);
}
/** Form (`question` tool) requests the session is currently blocked on. */
export async function listForms(endpoint, sessionID) {
    const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/form`);
    const rows = [];
    for (const row of body.data ?? []) {
        if (typeof row.id !== "string" || row.id.length === 0)
            continue;
        const rawFields = Array.isArray(row.fields) ? row.fields : [];
        const fields = [];
        for (const raw of rawFields) {
            if (typeof raw !== "object" || raw === null)
                continue;
            const field = raw;
            if (typeof field.key !== "string")
                continue;
            const options = Array.isArray(field.options)
                ? field.options.flatMap((option) => {
                    if (typeof option !== "object" || option === null)
                        return [];
                    const entry = option;
                    if (typeof entry.value !== "string")
                        return [];
                    return [{ value: entry.value, label: typeof entry.label === "string" ? entry.label : entry.value, description: typeof entry.description === "string" ? entry.description : undefined }];
                })
                : undefined;
            fields.push({
                key: field.key,
                type: typeof field.type === "string" ? field.type : "string",
                label: typeof field.label === "string" ? field.label : undefined,
                description: typeof field.description === "string" ? field.description : undefined,
                required: field.required === true,
                options,
            });
        }
        rows.push({
            id: row.id,
            sessionID: typeof row.sessionID === "string" ? row.sessionID : sessionID,
            title: typeof row.title === "string" ? row.title : undefined,
            fields,
        });
    }
    return rows;
}
/** Answer a permission prompt. `decision` is once / always / reject. */
export async function replyPermission(endpoint, sessionID, requestID, decision) {
    await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, {
        method: "POST",
        body: JSON.stringify({ decision }),
    });
}
/**
 * Answer a form (`question` tool) with one value per field key.
 *
 * This is how the OpenCode web dock replies: the whole form in one call, and
 * the agent stays parked on it until the answer arrives. Form field keys are
 * `q0`, `q1`, … in question order.
 */
export async function replyForm(endpoint, sessionID, formID, answer) {
    await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, {
        method: "POST",
        body: JSON.stringify({ answer }),
    });
}
/**
 * Decode an SSE `form.created` event into the panel's ask shape.
 *
 * Event payload (verified against a local 2.1.4 server):
 * `{ type: "form.created", data: { form: { id, sessionID, title, metadata.kind,
 * fields: [{ key, title, description, type, options: [{ value, label, description }] }] } } }`.
 */
export function parseFormCreated(raw) {
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const event = raw;
    const data = typeof event.data === "object" && event.data !== null ? event.data : undefined;
    const form = typeof data?.form === "object" && data.form !== null ? data.form : undefined;
    if (form === undefined)
        return undefined;
    const formID = typeof form.id === "string" ? form.id : "";
    const sessionID = typeof form.sessionID === "string" ? form.sessionID : "";
    if (formID.length === 0 || sessionID.length === 0)
        return undefined;
    const rawFields = Array.isArray(form.fields) ? form.fields : [];
    const questions = [];
    for (const rawField of rawFields) {
        if (typeof rawField !== "object" || rawField === null)
            continue;
        const field = rawField;
        const question = typeof field.description === "string" ? field.description : typeof field.label === "string" ? field.label : "";
        if (question.length === 0)
            continue;
        const options = [];
        for (const rawOption of Array.isArray(field.options) ? field.options : []) {
            if (typeof rawOption !== "object" || rawOption === null)
                continue;
            const entry = rawOption;
            if (typeof entry.value !== "string")
                continue;
            options.push({
                label: typeof entry.label === "string" && entry.label.length > 0 ? entry.label : entry.value,
                value: entry.value,
                description: typeof entry.description === "string" ? entry.description : undefined,
            });
        }
        questions.push({
            header: typeof field.title === "string" && field.title.length > 0 ? field.title : undefined,
            question,
            multiple: field.type === "multiselect",
            options,
        });
    }
    if (questions.length === 0)
        return undefined;
    const fieldKeys = rawFields
        .map((field) => (typeof field === "object" && field !== null ? field : undefined))
        .map((field) => (field !== undefined && typeof field.key === "string" ? field.key : undefined))
        .filter((key) => key !== undefined);
    return { formID, sessionID, fieldKeys, questions };
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
/**
 * Every CLI child currently serving a turn. This used to be a single slot, but
 * the panel can queue several prompts; a second spawn would overwrite the first
 * child, and the first one's `close` handler would then mistake itself for a
 * cancelled run and drop the reply it had already collected.
 */
const activeRuns = new Set();
/** Kill every in-flight `opencode run`. Resolves true when at least one was killed. */
export function abortRunPrompt() {
    if (activeRuns.size === 0)
        return false;
    for (const child of activeRuns)
        child.kill();
    activeRuns.clear();
    return true;
}
/**
 * Detect the CLI event that carries a `question` tool call.
 *
 * `opencode run --format json` emits one object per line. A tool call arrives
 * with `type: "tool"` (older builds use `tool_use` / `tool.call`) and the tool
 * name lives on `part.tool`; the arguments — including the `questions` array —
 * are under `part.state.input` once the call is pending.
 */
function isQuestionEvent(event) {
    const type = event.type ?? "";
    if (type !== "tool" && type !== "tool_use" && type !== "tool.call")
        return false;
    const part = event.part ?? {};
    const tool = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : "";
    return tool === "question" || tool === "ask";
}
/** Pull the `questions` array out of a question tool event, tolerating shapes. */
function readAskEvent(event) {
    const part = event.part ?? {};
    const state = typeof part.state === "object" && part.state !== null ? part.state : undefined;
    const rawInput = state?.input ?? part.input ?? part.args;
    const input = typeof rawInput === "object" && rawInput !== null ? rawInput : {};
    const rawQuestions = Array.isArray(input.questions) ? input.questions : Array.isArray(input.question) ? input.question : [];
    const questions = [];
    for (const raw of rawQuestions) {
        if (typeof raw !== "object" || raw === null)
            continue;
        const row = raw;
        const questionText = typeof row.question === "string" ? row.question : "";
        if (questionText.length === 0)
            continue;
        const rawOptions = Array.isArray(row.options) ? row.options : [];
        const options = [];
        for (const option of rawOptions) {
            if (typeof option !== "object" || option === null)
                continue;
            const entry = option;
            const label = typeof entry.label === "string" ? entry.label : typeof entry.value === "string" ? entry.value : "";
            if (label.length === 0)
                continue;
            options.push({ label, description: typeof entry.description === "string" ? entry.description : undefined });
        }
        questions.push({
            header: typeof row.header === "string" ? row.header : undefined,
            question: questionText,
            multiple: row.multiple === true,
            options,
        });
    }
    return { callID: typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : undefined, questions };
}
export async function runPrompt(sessionID, prompt, directory, model, onAsk) {
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
        activeRuns.add(child);
        const texts = [];
        // The CLI prints every tool event twice (the live stream plus a final
        // reconcile pass re-emits the same part), so dedupe ask cards by call id;
        // otherwise each question renders twice in the panel.
        const askCallIDs = new Set();
        // Set once a question surfaces. A non-interactive CLI run instantly
        // cancels its question tool and the model then free-wheels through
        // "reasonable assumptions" on its own; everything it says after the
        // question is that noise, so it must not reach the panel or the reply.
        let askPending = false;
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
                        if (event.type === "text" && typeof event.part?.text === "string" && event.part.text.length > 0 && !askPending)
                            texts.push(event.part.text);
                        if (event.type === "error" && event.error !== undefined)
                            stderr += `\n${JSON.stringify(event.error).slice(0, 400)}`;
                        // A `question` tool call is the interactive ask the panel renders as
                        // buttons. Log any non-text event so the real field names are visible
                        // instead of guessed at.
                        if (event.type !== "text" && event.type !== "step_start" && event.type !== "step_finish") {
                            console.log(`[opencode-run][event] ${line.slice(0, 2000)}`);
                        }
                        if (onAsk !== undefined && isQuestionEvent(event)) {
                            const ask = readAskEvent(event);
                            // The CLI re-emits every tool event on its final reconcile pass,
                            // so the same question arrives twice; dedupe by call id or the
                            // panel stacks two cards.
                            if (ask.callID !== undefined) {
                                if (askCallIDs.has(ask.callID))
                                    continue;
                                askCallIDs.add(ask.callID);
                            }
                            askPending = true;
                            if (ask.questions.length > 0)
                                onAsk(ask);
                        }
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
            activeRuns.delete(child);
            resolve({ ok: false, error: `启动 opencode 失败：${error.message}` });
        });
        child.on("close", (code) => {
            // `wasActive` is false only when Stop killed this exact child, not when a
            // later turn registered another one.
            const wasActive = activeRuns.delete(child);
            if (buffer.trim().startsWith("{"))
                drain("\n");
            const reply = texts.join("").trim();
            // The turn hit a question: the reply (if any) was the model's own
            // cancelled-question noise and the caller parks on the card until the
            // user submits. Report success with no text instead of an error bubble.
            if (askPending)
                resolve({ ok: true, reply: "" });
            else if (reply.length > 0)
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
 * Condense a tool call's input into one readable line (the CLI prints the
 * command / path it is about to touch, not the whole JSON blob).
 */
export function toolSummary(name, input) {
    if (input === undefined)
        return "";
    const pick = (key) => {
        const value = input[key];
        return typeof value === "string" ? value.trim() : "";
    };
    const preferred = pick("command") || pick("filePath") || pick("path") || pick("pattern") || pick("query") || pick("url");
    if (preferred.length > 0)
        return preferred;
    // `edit`/`write` carry the target under `filePath`; `read` under `path`.
    const keys = Object.keys(input);
    if (keys.length === 0)
        return "";
    const first = input[keys[0]];
    if (typeof first === "string")
        return first.trim();
    const json = JSON.stringify(input);
    return json.length > 160 ? json.slice(0, 160) + "…" : json;
}
/**
 * Flatten the projected message timeline into renderable rows.
 *
 * The v2 projection puts visible text under `content` (not `parts`) and labels
 * the row with `type` (`user` | `assistant` | `idle`) rather than `role`.
 *
 * Every content block becomes its own row so the panel can mirror the CLI:
 * `text` blocks render as chat bubbles, `tool` blocks render as process rows
 * (name + status + a one-line argument summary). Reasoning blocks stay
 * dropped — they are private scratch work, not progress.
 *
 * The projection returns newest first; the chat panel renders oldest first,
 * so the flattened rows are reversed here once.
 */
export async function readTimeline(endpoint, sessionID) {
    const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/message`);
    const rows = [];
    for (const message of body.data ?? []) {
        const role = message.type ?? message.role ?? "assistant";
        const error = describeError(message);
        // A failed turn (e.g. provider 503) has no visible text, so surface it as
        // its own row instead of dropping it: the panel can then explain the
        // failure instead of appearing to hang.
        if (role === "idle") {
            if (error !== undefined)
                rows.push({ id: message.id, role: "error", text: error, time: message.time?.created, error, kind: "error" });
            continue;
        }
        if (role !== "user" && role !== "assistant")
            continue;
        const blocks = message.content ?? message.parts ?? [];
        if (blocks.length === 0) {
            // User prompts live on the message itself, not in content.
            const text = typeof message.text === "string" ? message.text.trim() : "";
            if (text.length > 0)
                rows.push({ id: message.id, role, text, time: message.time?.created, kind: "chat" });
            else if (error !== undefined)
                rows.push({ id: message.id, role, text: "", time: message.time?.created, error, kind: "error" });
            continue;
        }
        blocks.forEach((block, index) => {
            const rowID = `${message.id}:${index}`;
            if (block.type === "tool") {
                const name = typeof block.name === "string" && block.name.length > 0 ? block.name : "tool";
                // Match the live feed: a tool row always renders as "running" (●).
                // The projection only carries the final state, and showing → here
                // would make a reopened panel look different from the live one.
                rows.push({
                    id: rowID,
                    role: "assistant",
                    text: toolSummary(name, block.state?.input),
                    time: message.time?.created,
                    kind: "tool",
                    tool: name,
                    status: "running",
                });
                return;
            }
            if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
                rows.push({ id: rowID, role, text: block.text.trim(), time: message.time?.created, kind: "chat" });
            }
        });
        if (error !== undefined) {
            rows.push({ id: `${message.id}:error`, role, text: "", time: message.time?.created, error, kind: "error" });
        }
    }
    return rows.reverse();
}
/**
 * Final outcome of a turn started at or after `sinceMs`, or `undefined` while
 * it is still running.
 *
 * The projected timeline marks a finished assistant message with
 * `time.completed` (verified live); a turn the user stopped never completes, so
 * an interrupt surfaces through the SSE watcher instead of this poll.
 */
export async function turnResultAfter(endpoint, sessionID, sinceMs) {
    const body = await request(endpoint, `/api/session/${encodeURIComponent(sessionID)}/message`);
    const rows = body.data ?? [];
    let error;
    let reply;
    let sawNewTurn = false;
    // Newest first: stop scanning as soon as rows predate the turn.
    for (const message of rows) {
        const created = message.time?.created;
        if (typeof created !== "number" || created < sinceMs)
            break;
        if (message.type === "assistant") {
            if (error === undefined)
                error = describeError(message);
            if (reply === undefined && typeof message.time?.completed === "number") {
                const blocks = message.content ?? message.parts ?? [];
                reply = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("").trim();
            }
            sawNewTurn = true;
        }
        else if (message.type === "idle" && error === undefined) {
            error = describeError(message);
            if (error !== undefined)
                sawNewTurn = true;
        }
    }
    if (!sawNewTurn)
        return undefined;
    if (error !== undefined)
        return { ok: false, error: `OpenCode 报错：${error}` };
    if (reply !== undefined && reply.length > 0)
        return { ok: true, reply };
    // Turn messages exist but none has completed yet: still running.
    return undefined;
}
