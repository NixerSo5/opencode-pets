export interface UpdateInfo {
    /** Running version ("1.3.2"). */
    readonly current: string;
    /** Server-side latest version ("1.4.0"), tag prefix stripped. */
    readonly latest: string;
    /** Human-visible release page. */
    readonly releaseUrl: string;
    /** Direct asset download URL for this install mode (GitHub fallback). */
    readonly assetUrl: string;
    readonly assetName: string;
    readonly assetSize: number;
    /** Gitee mirror attachment list for the same tag, in part order. */
    readonly giteeVolumes?: readonly {
        readonly name: string;
        readonly url: string;
        readonly size: number;
    }[];
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
export interface GiteeVolume {
    readonly name: string;
    readonly url: string;
    readonly size: number;
}
/**
 * Read the mirror release for `version` and list its `.7z.NNN` split volumes
 * in part order. Public read needs no token; undefined on any miss so the
 * caller falls back to GitHub without retries.
 */
export declare function findGiteeVolumes(version: string): Promise<readonly GiteeVolume[] | undefined>;
/**
 * Download every mirror volume into `destDir`, reporting progress as
 * (receivedInPart, totalInPart). Volumes stream one after another; a failed
 * part aborts the whole chain (partial files all removed).
 */
export declare function downloadGiteeVolumes(volumes: readonly GiteeVolume[], destDir: string, onProgress?: DownloadProgress, onPartStart?: (name: string) => void): Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * Assemble the installer from downloaded split volumes with the bundled 7-Zip
 * console, and return the extracted exe. No shell involved: 7zr gets argv.
 */
export declare function extractVolumes(firstVolumePath: string, destDir: string): Promise<{
    ok: boolean;
    installerPath?: string;
    error?: string;
}>;
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
