/**
 * session-record.ts
 *
 * Persists which OpenCode session belongs to which directory
 * (`userData/sessions.json`), so closing the app does not orphan the
 * conversation: the next pet for the same directory reattaches to the
 * recorded session and the panel history follows along. One directory maps
 * to its latest session; records pointing at sessions the server no longer
 * knows are silently replaced on the next attach.
 *
 * The file also remembers which record was touched last (`active`), so a
 * plain launch — which has no directory context — can restore the
 * conversation the user was last working in, whatever folder it lived on.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
function recordPath(userDataPath) {
    return join(userDataPath, "sessions.json");
}
/** Windows paths are case-insensitive; normalize slashes and case for keys. */
export function sessionRecordKey(directory) {
    return directory.replace(/\//g, "\\").toLowerCase();
}
async function readStore(userDataPath) {
    try {
        const raw = JSON.parse(await readFile(recordPath(userDataPath), "utf8"));
        if (typeof raw !== "object" || raw === null)
            return { sessions: {} };
        const store = raw;
        const inner = typeof store.sessions === "object" && store.sessions !== null ? store.sessions : {};
        const sessions = {};
        for (const [key, value] of Object.entries(inner)) {
            if (typeof value !== "object" || value === null)
                continue;
            const blob = value;
            const sessionID = typeof blob.sessionID === "string" && blob.sessionID.length > 0 ? blob.sessionID : undefined;
            if (sessionID === undefined)
                continue;
            const title = typeof blob.title === "string" ? blob.title : "";
            const directory = typeof blob.directory === "string" && blob.directory.length > 0 ? blob.directory : key;
            const updatedAt = typeof blob.updatedAt === "number" ? blob.updatedAt : undefined;
            sessions[key] = { sessionID, title, directory, updatedAt };
        }
        const active = typeof store.active === "string" && store.active in sessions ? store.active : undefined;
        return { sessions, active };
    }
    catch {
        return { sessions: {} };
    }
}
function toRecord(stored) {
    return { sessionID: stored.sessionID, title: stored.title };
}
export async function readSessionRecords(userDataPath) {
    const store = await readStore(userDataPath);
    const out = {};
    for (const [key, stored] of Object.entries(store.sessions))
        out[key] = toRecord(stored);
    return out;
}
/**
 * The record bound most recently, with its real-case directory. Plain
 * launch uses this to restore the last conversation instead of guessing.
 */
export async function readActiveRecord(userDataPath) {
    const store = await readStore(userDataPath);
    if (store.active === undefined)
        return undefined;
    const stored = store.sessions[store.active];
    if (stored === undefined)
        return undefined;
    return { directory: stored.directory ?? store.active, record: toRecord(stored) };
}
export async function saveSessionRecord(userDataPath, directory, record) {
    try {
        const store = await readStore(userDataPath);
        const key = sessionRecordKey(directory);
        store.sessions[key] = { ...record, directory, updatedAt: Date.now() };
        await mkdir(userDataPath, { recursive: true });
        await writeFile(recordPath(userDataPath), JSON.stringify({ sessions: store.sessions, active: key }, null, 2), "utf8");
    }
    catch (error) {
        console.log(`[session-record] save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
