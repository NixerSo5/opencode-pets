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
/**
 * Delete a session and its child sessions (`operationId: session.remove`).
 *
 * `DELETE /api/session/{id}` answers 204, or 404 with SessionNotFoundError when
 * the id is unknown. Declared in /openapi.json even though probing a made-up id
 * looks like a missing route.
 */
export declare function deleteSession(endpoint: ServiceEndpoint, sessionID: string): Promise<void>;
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
 * Pending interaction the agent is blocked on.
 *
 * `permission` is a tool asking "may I run this?" (once / always / reject).
 * `form` is the `question` tool: a structured set of fields with options, which
 * is what the chat panel renders as clickable buttons.
 */
export interface PermissionRequest {
    readonly id: string;
    readonly sessionID: string;
    readonly tool?: string;
    readonly title?: string;
    readonly description?: string;
}
export interface FormOption {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
}
export interface FormField {
    readonly key: string;
    readonly type: string;
    readonly label?: string;
    readonly description?: string;
    readonly required?: boolean;
    readonly options?: readonly FormOption[];
}
export interface FormRequest {
    readonly id: string;
    readonly sessionID: string;
    readonly title?: string;
    readonly fields: readonly FormField[];
}
/** Permissions the session is currently blocked on (empty when none). */
export declare function listPermissions(endpoint: ServiceEndpoint, sessionID: string): Promise<PermissionRequest[]>;
/** Form (`question` tool) requests the session is currently blocked on. */
export declare function listForms(endpoint: ServiceEndpoint, sessionID: string): Promise<FormRequest[]>;
/** Answer a permission prompt. `decision` is once / always / reject. */
export declare function replyPermission(endpoint: ServiceEndpoint, sessionID: string, requestID: string, decision: "once" | "always" | "reject"): Promise<void>;
/**
 * Answer a form (`question` tool) with one value per field key.
 *
 * This is how the OpenCode web dock replies: the whole form in one call, and
 * the agent stays parked on it until the answer arrives. Form field keys are
 * `q0`, `q1`, … in question order.
 */
export declare function replyForm(endpoint: ServiceEndpoint, sessionID: string, formID: string, answer: Record<string, string>): Promise<void>;
/**
 * Decode an SSE `form.created` event into the panel's ask shape.
 *
 * Event payload (verified against a local 2.1.4 server):
 * `{ type: "form.created", data: { form: { id, sessionID, title, metadata.kind,
 * fields: [{ key, title, description, type, options: [{ value, label, description }] }] } } }`.
 */
export declare function parseFormCreated(raw: unknown): (AskEvent & {
    formID: string;
    sessionID: string;
    fieldKeys: readonly string[];
}) | undefined;
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
/** Kill every in-flight `opencode run`. Resolves true when at least one was killed. */
export declare function abortRunPrompt(): boolean;
/** A `question` tool call surfaced from the CLI JSON stream, or resolved from an SSE `form.created` event. */
export interface AskEvent {
    readonly callID?: string;
    /**
     * Set only when the ask came from the HTTP event stream: the agent is
     * genuinely parked on this form until `replyForm` answers it, so the panel
     * submits through the form endpoint instead of appending a follow-up prompt.
     */
    readonly formID?: string;
    readonly questions: Array<{
        readonly header?: string;
        readonly question: string;
        readonly multiple?: boolean;
        readonly options: Array<{
            readonly label: string;
            readonly description?: string;
            readonly value?: string;
        }>;
    }>;
}
export declare function runPrompt(sessionID: string, prompt: string, directory?: string, model?: {
    providerID: string;
    id: string;
}, onAsk?: (ask: AskEvent) => void): Promise<RunPromptResult>;
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
/**
 * Final outcome of a turn started at or after `sinceMs`, or `undefined` while
 * it is still running.
 *
 * The projected timeline marks a finished assistant message with
 * `time.completed` (verified live); a turn the user stopped never completes, so
 * an interrupt surfaces through the SSE watcher instead of this poll.
 */
export declare function turnResultAfter(endpoint: ServiceEndpoint, sessionID: string, sinceMs: number): Promise<RunPromptResult | undefined>;
