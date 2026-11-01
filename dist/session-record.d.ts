export interface SessionRecord {
    readonly sessionID: string;
    readonly title: string;
}
/** The reminder record plus the real-case directory it belongs to. */
export interface ActiveRecord {
    readonly directory: string;
    readonly record: SessionRecord;
}
/** Windows paths are case-insensitive; normalize slashes and case for keys. */
export declare function sessionRecordKey(directory: string): string;
export declare function readSessionRecords(userDataPath: string): Promise<Record<string, SessionRecord>>;
/**
 * The record bound most recently, with its real-case directory. Plain
 * launch uses this to restore the last conversation instead of guessing.
 */
export declare function readActiveRecord(userDataPath: string): Promise<ActiveRecord | undefined>;
export declare function saveSessionRecord(userDataPath: string, directory: string, record: SessionRecord): Promise<void>;
