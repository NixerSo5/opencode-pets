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
    readonly location?: {
        readonly directory?: string;
        readonly workspaceID?: string;
    };
    readonly time?: {
        readonly created?: number;
        readonly updated?: number;
        readonly idle?: number;
    };
    readonly outcome?: "succeeded" | "failed" | "interrupted";
    /** Absent when the server has not pinned a model on this session. */
    readonly model?: SessionModel;
}
/** Read the background service registration, or undefined when absent/invalid. */
export declare function discoverService(): Promise<ServiceEndpoint | undefined>;
/** Cheap liveness probe (throws when the server is gone). */
export declare function serverInfo(endpoint: ServiceEndpoint): Promise<{
    version: string;
    pid: number;
}>;
/**
 * Create a session bound to `directory` (the right-clicked folder).
 *
 * No model is sent: OpenCode picks it with its own resolution order (session
 * override → agent config → the last model used in this project → the account
 * default). The pet is only an observer, so it must never override that.
 */
export declare function createSession(endpoint: ServiceEndpoint, directory: string, title?: string): Promise<SessionInfo>;
export declare function getSession(endpoint: ServiceEndpoint, sessionID: string): Promise<SessionInfo>;
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
export declare function getSessionAfterModelSwitch(endpoint: ServiceEndpoint, sessionID: string, expected: {
    readonly providerID: string;
    readonly id: string;
}): Promise<SessionInfo>;
/** All sessions known to the server, newest first (as the server returns them). */
export declare function listSessions(endpoint: ServiceEndpoint): Promise<SessionInfo[]>;
export interface ModelOption {
    readonly providerID: string;
    readonly id: string;
    readonly name: string;
}
/** Every model the server exposes (used to build the right-click picker). */
export declare function listModels(endpoint: ServiceEndpoint): Promise<ModelOption[]>;
/**
 * Switch an existing session's model. This is an explicit user action from the
 * pet's right-click menu, not an implicit override during session creation.
 *
 * The model field is not part of `PATCH /api/session/{id}` (session.update);
 * it has its own endpoint, `POST /api/session/{id}/model`, which publishes
 * `SessionEvent.ModelSelected` and answers 204.
 */
export declare function setSessionModel(endpoint: ServiceEndpoint, sessionID: string, model: {
    providerID: string;
    id: string;
}): Promise<void>;
/** Map of sessionID -> active state (e.g. `{ type: "running" }`). */
export declare function activeSessions(endpoint: ServiceEndpoint): Promise<Record<string, {
    type: string;
}>>;
/** Admit one user prompt; the agent loop starts unless `resume` is false. */
export declare function sendPrompt(endpoint: ServiceEndpoint, sessionID: string, prompt: string): Promise<void>;
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
/** Kill the in-flight `opencode run`, if any. Resolves true when one was killed. */
export declare function abortRunPrompt(): boolean;
export declare function runPrompt(sessionID: string, prompt: string, directory?: string, model?: {
    providerID: string;
    id: string;
}): Promise<RunPromptResult>;
/** Stop the running agent loop for a session (used when the pet is dismissed). */
export declare function interruptSession(endpoint: ServiceEndpoint, sessionID: string): Promise<void>;
export interface TimelineEntry {
    readonly id: string;
    readonly role: "user" | "assistant" | string;
    readonly text: string;
    readonly time?: number;
    /** Present when the server reported a failure for this turn (e.g. 503). */
    readonly error?: string;
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
export declare function readTimeline(endpoint: ServiceEndpoint, sessionID: string): Promise<TimelineEntry[]>;
