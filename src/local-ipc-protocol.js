import { randomUUID } from "node:crypto";
import { extname, isAbsolute } from "node:path";
export const openPetsIpcProtocol = "openpets-ipc";
export const openPetsIpcVersion = 1;
export const maxIpcMessageBytes = 16 * 1024;
export const transientDisplayMs = 4_000;
export const maxMediaFileBytes = 10 * 1024 * 1024;
export const minMediaDurationMs = 1_000;
export const maxMediaDurationMs = 30_000;
export const defaultMediaDurationMs = 8_000;
export const allowedMediaExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
export const allowedReactions = [
    "idle",
    "thinking",
    "working",
    "editing",
    "running",
    "testing",
    "waiting",
    "waving",
    "success",
    "error",
    "celebrating",
];
export function createRequestId() {
    return randomUUID();
}
export function parseIpcRequest(raw, expectedToken) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new IpcProtocolError("invalid_request", "IPC request must be valid JSON.");
    }
    if (!isRecord(parsed))
        throw new IpcProtocolError("invalid_request", "IPC request must be an object.");
    if (typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 120)
        throw new IpcProtocolError("invalid_request", "IPC request id is invalid.");
    if (parsed.version !== openPetsIpcVersion)
        throw new IpcProtocolError("invalid_version", "Unsupported IPC protocol version.");
    if (parsed.token !== expectedToken)
        throw new IpcProtocolError("invalid_token", "Invalid IPC token.");
    if (parsed.method !== "hello" && parsed.method !== "status" && parsed.method !== "pets.list" && parsed.method !== "pets.install" && parsed.method !== "lease.acquire" && parsed.method !== "lease.heartbeat" && parsed.method !== "lease.release" && parsed.method !== "pet.react" && parsed.method !== "pet.say" && parsed.method !== "pet.showMedia" && parsed.method !== "pets.install-local" && parsed.method !== "session.attach" && parsed.method !== "pet.summon" && parsed.method !== "pet.dismiss" && parsed.method !== "bridge.register") {
        throw new IpcProtocolError("unknown_method", "Unknown IPC method.");
    }
    return {
        id: parsed.id,
        version: parsed.version,
        token: parsed.token,
        method: parsed.method,
        params: parsed.params,
    };
}
export function validateInstallPetId(value) {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || value === "builtin") {
        throw new IpcProtocolError("invalid_params", "Invalid pet id.");
    }
    return value;
}
export function validateReaction(value) {
    if (typeof value !== "string" || !allowedReactions.includes(value)) {
        throw new IpcProtocolError("invalid_params", "Invalid pet reaction.");
    }
    return value;
}
export function validateSayMessage(value) {
    if (typeof value !== "string")
        throw new IpcProtocolError("invalid_params", "Message must be a string.");
    const message = value.trim();
    if (message.length < 1)
        throw new IpcProtocolError("invalid_params", "Message cannot be empty.");
    if (message.length > 140)
        throw new IpcProtocolError("invalid_params", "Message is too long.");
    if (/[\r\n]/.test(message))
        throw new IpcProtocolError("invalid_params", "Message must be single-line.");
    if (/```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b/.test(message))
        throw new IpcProtocolError("invalid_params", "Message looks like code.");
    if (/https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\/.test(message))
        throw new IpcProtocolError("invalid_params", "Message contains a URL or path-like content.");
    if (/(api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY)/i.test(message))
        throw new IpcProtocolError("invalid_params", "Message looks secret-like.");
    return message;
}
export function validateOptionalLeaseId(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || value.length < 1 || value.length > 120 || /[\0\r\n]/.test(value)) {
        throw new IpcProtocolError("invalid_params", "Invalid lease id.");
    }
    return value;
}
export function validateRequestedPetId(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        throw new IpcProtocolError("invalid_params", "Requested pet id must be a string.");
    const trimmed = value.trim();
    if (trimmed.length < 1)
        return undefined;
    if (Buffer.byteLength(trimmed, "utf8") > 128 || /[\x00-\x1F\x7F/\\]/.test(trimmed)) {
        throw new IpcProtocolError("invalid_params", "Requested pet id is outside CLI bounds.");
    }
    return trimmed;
}
/**
 * Validate the optional sessionNonce from a lease.acquire request.
 * The nonce is a UUID generated once per MCP process (not per-call) and used
 * alongside clientPid to prevent OS PID-reuse session collisions.
 * Accepts any non-empty string ≤128 chars with no control characters.
 */
export function validateSessionNonce(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "string")
        return undefined; // tolerate missing/malformed — degrade gracefully
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 128 || /[\x00-\x1F\x7F]/.test(trimmed))
        return undefined;
    return trimmed;
}
/** Printable, single-token session id from an agent integration (e.g. an OpenCode session id). */
export function validateSessionId(value) {
    if (typeof value !== "string")
        throw new IpcProtocolError("invalid_params", "Session id must be a string.");
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 128)
        throw new IpcProtocolError("invalid_params", "Session id must be 1-128 characters.");
    if (!/^[\x21-\x7E]+$/.test(trimmed))
        throw new IpcProtocolError("invalid_params", "Session id contains unsupported characters.");
    return trimmed;
}
/**
 * Validate the plugin's chat bridge endpoint. Loopback-only plain http: the
 * desktop forwards pet chat messages to a per-process bridge the plugin
 * listens on, and nothing outside this machine may ever receive them.
 * The URL is normalized to 127.0.0.1 so a `localhost` literal cannot resolve
 * to ::1 first on Windows.
 */
export function validateChatEndpoint(value) {
    if (value === undefined || value === null)
        return undefined;
    if (!isRecord(value))
        throw new IpcProtocolError("invalid_params", "Chat endpoint must be an object.");
    const { url, token } = value;
    if (typeof url !== "string")
        throw new IpcProtocolError("invalid_params", "Chat endpoint url must be a string.");
    let parsed;
    try {
        parsed = new URL(url.trim());
    }
    catch {
        throw new IpcProtocolError("invalid_params", "Chat endpoint url is not a valid URL.");
    }
    if (parsed.protocol !== "http:")
        throw new IpcProtocolError("invalid_params", "Chat endpoint must be plain http on loopback.");
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]") {
        throw new IpcProtocolError("invalid_params", "Chat endpoint must be loopback-only.");
    }
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new IpcProtocolError("invalid_params", "Chat endpoint must include a valid port.");
    if (parsed.pathname !== "/" && parsed.pathname !== "")
        throw new IpcProtocolError("invalid_params", "Chat endpoint must not include a path.");
    if (typeof token !== "string" || token.length < 16 || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) {
        throw new IpcProtocolError("invalid_params", "Chat endpoint token is invalid.");
    }
    return { url: `http://127.0.0.1:${port}/`, token };
}
/** Positive integer process id from a client, or undefined when absent/invalid. */
export function validateClientPid(value) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
        return undefined;
    return value;
}
export function validateSessionAttachParams(params) {
    const record = isRecord(params) ? params : {};
    const sessionID = validateSessionId(record.sessionID);
    const clientPid = validateClientPid(record.clientPid);
    const sessionNonce = validateSessionNonce(record.sessionNonce);
    const requestedPetId = validateRequestedPetId(record.requestedPetId);
    const chatEndpoint = validateChatEndpoint(record.chatEndpoint);
    return { sessionID, clientPid, sessionNonce, requestedPetId, chatEndpoint };
}
/**
 * Validate a bridge.register request.
 *
 * The OpenCode plugin calls this once during setup so the desktop knows which
 * loopback bridge can create sessions on demand, before any session exists.
 */
export function validateBridgeRegisterParams(params) {
    const record = isRecord(params) ? params : {};
    const chatEndpoint = validateChatEndpoint(record.chatEndpoint);
    if (!chatEndpoint) {
        throw new IpcProtocolError("invalid_params", "Bridge registration requires a chat endpoint.");
    }
    return { chatEndpoint };
}
/**
 * Validate a pet.summon request.
 *
 * The cursor is optional: when omitted the desktop summons the assistant at
 * the current pointer position. A supplied cursor must be a finite screen
 * coordinate pair, since it is used directly as an absolute window origin.
 *
 * The directory is optional and comes from the Windows background shell verb
 * (`--directory <path>`). It becomes the working directory of the OpenCode
 * session the summoned pet is bound to, so it must be an absolute path.
 */
export function validateSummonPetParams(params) {
    const record = isRecord(params) ? params : {};
    const petId = validateRequestedPetId(record.petId);
    const cursor = validateCursorPoint(record.cursor);
    const directory = validateSummonDirectory(record.directory);
    return { petId, cursor, directory };
}
/** Upper bound for one shell-verb directory argument. */
const maxSummonDirectoryChars = 1_024;
function validateSummonDirectory(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "string") {
        throw new IpcProtocolError("invalid_params", "Directory must be a string.");
    }
    const directory = value.trim();
    if (directory.length < 1)
        return undefined;
    if (directory.length > maxSummonDirectoryChars) {
        throw new IpcProtocolError("invalid_params", "Directory path is too long.");
    }
    if (!isAbsolute(directory)) {
        throw new IpcProtocolError("invalid_params", "Directory must be an absolute path.");
    }
    return directory;
}
function validateCursorPoint(value) {
    if (value === undefined || value === null)
        return undefined;
    if (!isRecord(value))
        throw new IpcProtocolError("invalid_params", "Cursor must be an object.");
    const { x, y } = value;
    if (!isFiniteCoordinate(x) || !isFiniteCoordinate(y)) {
        throw new IpcProtocolError("invalid_params", "Cursor must contain finite x and y coordinates.");
    }
    return { x, y };
}
function isFiniteCoordinate(value) {
    return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}
export function okResponse(id, result) {
    return { id, ok: true, result };
}
export function errorResponse(id, error) {
    if (error instanceof IpcProtocolError) {
        return { id, ok: false, error: { code: error.code, message: error.message } };
    }
    return {
        id,
        ok: false,
        error: {
            code: "internal_error",
            message: error instanceof Error ? error.message : "IPC request failed.",
        },
    };
}
export class IpcProtocolError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export function isRecord(value) {
    return typeof value === "object" && value !== null;
}
export function validateInstallLocalPath(value) {
    if (typeof value !== "string") {
        throw new IpcProtocolError("invalid_params", "Path must be a string.");
    }
    const trimmed = value.trim();
    if (trimmed.length < 1) {
        throw new IpcProtocolError("invalid_params", "Path cannot be empty.");
    }
    if (Buffer.byteLength(trimmed, "utf8") > 2048) {
        throw new IpcProtocolError("invalid_params", "Path is too long.");
    }
    if (/[\x00-\x1F\x7F]/.test(trimmed)) {
        throw new IpcProtocolError("invalid_params", "Path contains invalid control characters.");
    }
    if (!isAbsolute(trimmed)) {
        throw new IpcProtocolError("invalid_params", "Path must be absolute.");
    }
    return trimmed;
}
export function validateMediaPath(value) {
    const path = validateInstallLocalPath(value);
    const extension = extname(path).toLowerCase();
    if (!allowedMediaExtensions.includes(extension)) {
        throw new IpcProtocolError("invalid_params", `Media path extension must be one of: ${allowedMediaExtensions.join(", ")}.`);
    }
    return path;
}
/**
 * Schemes that must never reach shell.openExternal from IPC input: local
 * content and script execution (file/javascript/data/...), plain http (no
 * downgrade from https), and Windows shell handlers with side effects.
 * Everything else — https plus custom registered app protocols (the point of
 * this field: hand the click back to the tool that sent the media) — is
 * allowed; an unregistered custom scheme is a no-op at the OS level.
 */
const blockedClickUrlProtocols = new Set(["http:", "file:", "javascript:", "data:", "vbscript:", "blob:", "about:", "chrome:", "ms-appx:", "ms-appx-web:", "shell:", "search-ms:", "search:", "res:"]);
export function validateMediaClickUrl(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string")
        throw new IpcProtocolError("invalid_params", "Click URL must be a string.");
    const trimmed = value.trim();
    if (trimmed.length < 1 || trimmed.length > 2048 || /[\x00-\x1F\x7F\s]/.test(trimmed)) {
        throw new IpcProtocolError("invalid_params", "Click URL is invalid.");
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        throw new IpcProtocolError("invalid_params", "Click URL must be an absolute URL.");
    }
    if (blockedClickUrlProtocols.has(parsed.protocol.toLowerCase())) {
        throw new IpcProtocolError("invalid_params", "Click URL scheme is not allowed.");
    }
    return trimmed;
}
export function validateMediaDurationMs(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < minMediaDurationMs || value > maxMediaDurationMs) {
        throw new IpcProtocolError("invalid_params", `Media duration must be a number between ${minMediaDurationMs} and ${maxMediaDurationMs} milliseconds.`);
    }
    return Math.round(value);
}
export function validateInstallLocalKind(value) {
    if (value !== "zip" && value !== "folder") {
        throw new IpcProtocolError("invalid_params", "Local install kind must be zip or folder.");
    }
    return value;
}
