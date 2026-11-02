export interface UpdateInfo {
    /** Running version ("1.3.2"). */
    readonly current: string;
    /** Server-side latest version ("1.4.0"), tag prefix stripped. */
    readonly latest: string;
    /** Human-visible release page. */
    readonly releaseUrl: string;
    /** Direct asset download URL for this install mode. */
    readonly assetUrl: string;
    readonly assetName: string;
    readonly assetSize: number;
}
export interface DownloadResult {
    readonly ok: boolean;
    readonly installerPath?: string;
    readonly error?: string;
}
export type DownloadProgress = (received: number, total: number) => void;
/** Packaged install (NSIS) vs portable exe, detected from the environment. */
export declare function isPortableInstall(): boolean;
export declare function parseSemver(value: string): [number, number, number] | undefined;
export declare function isNewerVersion(candidate: string, current: string): boolean;
/** Query the GitHub API; undefined (no error detail) when nothing newer. */
export declare function checkForUpdate(current: string): Promise<UpdateInfo | undefined>;
/**
 * Stream the asset into a temp file. `installerPath` only exists afterwards:
 * partial files are removed so a retried download never installs half a file.
 */
export declare function downloadUpdate(info: UpdateInfo, onProgress?: DownloadProgress): Promise<DownloadResult>;
/**
 * Hand the update over: the helper waits for this instance to quit. NSIS runs
 * the silent installer; portable swaps the exe in place and relaunches.
 */
export declare function installUpdate(info: UpdateInfo, installerPath: string): Promise<void>;
