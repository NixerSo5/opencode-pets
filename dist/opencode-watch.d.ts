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
import { type ServiceEndpoint } from "./opencode-client.js";
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
    onEvent?: (event: {
        type: string;
        sessionID?: string;
        payload: unknown;
    }) => void;
    /** High-level state changes worth showing on the pet. */
    onStatus?: (update: {
        sessionID: string;
        status: "running" | "idle";
        kind: "started" | "succeeded" | "failed" | "interrupted" | "enqueued" | "waiting";
        tool?: string;
    }) => void;
    onConnected?: (endpoint: ServiceEndpoint) => void;
    onDisconnected?: (reason: string) => void;
}
export declare class OpenCodeWatch {
    private readonly sessions;
    private readonly callbacks;
    private controller;
    private stopped;
    private retryTimer;
    constructor(callbacks: WatchCallbacks);
    /** Sessions seen by this watcher, newest activity first. */
    list(): SessionState[];
    get(sessionID: string): SessionState | undefined;
    /** Remember a session created outside the event stream (e.g. summon). */
    track(session: {
        id: string;
        title?: string;
        directory?: string;
    }): void;
    stop(): void;
    /** Connect, and keep reconnecting until stop() is called. */
    start(): void;
    private scheduleReconnect;
    private connect;
    private consume;
    private dispatch;
    private applyEvent;
}
