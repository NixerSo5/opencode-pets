/**
 * opencode-ensure.ts
 *
 * Makes the pet work out of the box:
 *  1. If the OpenCode background service is already running, use it.
 *  2. If `opencode` is not installed, install it (npm -g @opencode/cli).
 *  3. If it is installed but not serving, run `opencode service start`.
 *
 * Every step is idempotent and safe: we never touch a running service
 * (no stop/kill); the promise only ever probes, installs, and starts.
 */
import { type ServiceEndpoint } from "./opencode-client.js";
export type EnsureStage = "probe" | "install" | "start" | "wait";
export interface EnsureProgress {
    readonly stage: EnsureStage;
    readonly message: string;
}
export interface EnsureResult {
    readonly ok: boolean;
    readonly endpoint?: ServiceEndpoint;
    /** True when code was missing and we had to run the npm install. */
    readonly installedHere?: boolean;
    /** True when the background service was not running and we started it. */
    readonly startedHere?: boolean;
    readonly error?: string;
}
export interface EnsureOptions {
    readonly onProgress?: (progress: EnsureProgress) => void;
    /** Injectable command runner (test hook); defaults to spawning a real shell. */
    readonly run?: RunCommand;
    /** Test hook: cap the wait-for-service loop instead of the 2-minute default. */
    readonly pollMaxMs?: number;
    /** App data dir; enables the bundled Node runtime install when npm is missing. */
    readonly userDataPath?: string;
}
export type RunCommand = (command: string, timeoutMs: number) => Promise<{
    readonly code: number;
    readonly output: string;
}>;
/** Quick liveness probe for a discovered endpoint. */
export declare function probeService(endpoint: ServiceEndpoint, timeoutMs?: number): Promise<boolean>;
/**
 * Ensure OpenCode is installed and the background service is running.
 * Never kills a running service; only probes, installs, and starts.
 */
export declare function ensureOpenCodeService(options?: EnsureOptions): Promise<EnsureResult>;
