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
}
/** Read the background service registration, or undefined when absent/invalid. */
export declare function discoverService(): Promise<ServiceEndpoint | undefined>;
/** Cheap liveness probe (throws when the server is gone). */
export declare function serverInfo(endpoint: ServiceEndpoint): Promise<{
    version: string;
    pid: number;
}>;
/** Create a session bound to `directory` (the right-clicked folder). */
export declare function createSession(endpoint: ServiceEndpoint, directory: string, title?: string): Promise<SessionInfo>;
export declare function getSession(endpoint: ServiceEndpoint, sessionID: string): Promise<SessionInfo>;
/** Map of sessionID -> active state (e.g. `{ type: "running" }`). */
export declare function activeSessions(endpoint: ServiceEndpoint): Promise<Record<string, {
    type: string;
}>>;
/** Admit one user prompt; the agent loop starts unless `resume` is false. */
export declare function sendPrompt(endpoint: ServiceEndpoint, sessionID: string, prompt: string): Promise<void>;
/** Stop the running agent loop for a session (used when the pet is dismissed). */
export declare function interruptSession(endpoint: ServiceEndpoint, sessionID: string): Promise<void>;
export interface TimelineEntry {
    readonly id: string;
    readonly role: "user" | "assistant" | string;
    readonly text: string;
    readonly time?: number;
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
