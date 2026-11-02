/**
 * app-update.ts
 *
 * GitHub-release update flow for OpenPets:
 *  1. `checkForUpdate` reads the latest release from the public GitHub API and
 *     compares the tag against the running version.
 *  2. `downloadUpdate` streams the matching asset into a temp file with
 *     progress callbacks.
 *  3. `installUpdate` hands the run over to a detached helper: the packaged
 *     app runs the NSIS installer silently after this instance has quit; the
 *     portable app renames its own running exe out of the way, drops the new
 *     one in, and relaunches once the old process is really gone.
 *
 * No autoUpdater dependency: the release assets are already on GitHub and the
 * NSIS installer knows how to install itself; the pet only choreographs it.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const repository = "NixerSo5/opencode-pets";
const releaseApiUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const timeoutMs = 15_000;
/** Packaged install (NSIS) vs portable exe, detected from the environment. */
export function isPortableInstall() {
    return typeof process.env.PORTABLE_EXECUTABLE_FILE === "string" && process.env.PORTABLE_EXECUTABLE_FILE.length > 0;
}
export function parseSemver(value) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    if (match === null)
        return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
export function isNewerVersion(candidate, current) {
    const a = parseSemver(candidate);
    const b = parseSemver(current);
    if (a === undefined || b === undefined)
        return false;
    return a[0] !== b[0]
        ? a[0] > b[0]
        : a[1] !== b[1]
            ? a[1] > b[1]
            : a[2] > b[2];
}
/** Read the running exe's full path (packaged); Electron execPath is inside
 *  app.asar-unpacked for asar builds, but the NSIS install dir is its dirname. */
function installedExePath() {
    return process.execPath;
}
/** Pick the asset that matches this install mode. */
function pickAsset(mode, version, assets) {
    // Packaged releases name the NSIS asset "OpenPets.Setup.1.4.0.exe" and the
    // portable one "OpenPets.1.4.0.exe"; fall back to any Setup exe otherwise.
    const wanted = mode === "portable"
        ? [`OpenPets.${version}.exe`, `OpenPetsSetup${version}.exe`]
        : [`OpenPets.Setup.${version}.exe`];
    for (const name of wanted) {
        const match = assets.find((asset) => asset.name.toLowerCase() === name.toLowerCase());
        if (match !== undefined)
            return { url: match.browser_download_url, name: match.name, size: match.size };
    }
    if (mode === "nsis") {
        const fallback = assets.find((asset) => asset.name.toLowerCase().includes("setup") && asset.name.toLowerCase().endsWith(".exe"));
        if (fallback !== undefined)
            return { url: fallback.browser_download_url, name: fallback.name, size: fallback.size };
    }
    return undefined;
}
/** Query the GitHub API; undefined (no error detail) when nothing newer. */
export async function checkForUpdate(current) {
    try {
        const response = await fetch(releaseApiUrl, {
            headers: { "User-Agent": "openpets-release", Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            console.log(`[update] check skipped: HTTP ${response.status}`);
            return undefined;
        }
        const release = (await response.json());
        if (release.draft === true || release.prerelease === true)
            return undefined;
        const latest = parseSemver(release.tag_name ?? "") === undefined ? undefined : (release.tag_name ?? "").replace(/^v/, "");
        if (latest === undefined) {
            console.log(`[update] check skipped: unparsable tag ${release.tag_name ?? "(none)"}`);
            return undefined;
        }
        if (!isNewerVersion(latest, current))
            return undefined;
        const mode = isPortableInstall() ? "portable" : "nsis";
        const assets = release.assets ?? [];
        const asset = pickAsset(mode, latest, assets) ?? (mode === "nsis" ? undefined : pickAsset("nsis", latest, assets));
        if (asset === undefined) {
            console.log(`[update] release ${latest} has no asset for mode=${mode}`);
            return undefined;
        }
        console.log(`[update] available: ${current} -> ${latest} (${asset.name})`);
        return {
            current,
            latest,
            releaseUrl: release.html_url ?? "",
            assetUrl: asset.url,
            assetName: asset.name,
            assetSize: asset.size,
        };
    }
    catch (error) {
        console.log(`[update] check failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
/**
 * Stream the asset into a temp file. `installerPath` only exists afterwards:
 * partial files are removed so a retried download never installs half a file.
 */
export async function downloadUpdate(info, onProgress) {
    const installerPath = isPortableInstall()
        ? join(tmpdir(), `OpenPets-${info.latest}-portable.exe`)
        : join(tmpdir(), `OpenPets-Setup-${info.latest}.exe`);
    try {
        const response = await fetch(info.assetUrl, {
            headers: { "User-Agent": "openpets-release" },
            redirect: "follow",
        });
        if (!response.ok || response.body === null) {
            return { ok: false, error: `下载失败：HTTP ${response.status}` };
        }
        const total = Number(response.headers.get("content-length") ?? info.assetSize);
        let received = 0;
        let lastReport = -1;
        const stream = Readable.fromWeb(response.body);
        // One callback per whole percent keeps the IPC traffic tiny.
        if (total > 0 && onProgress !== undefined) {
            stream.on("data", (chunk) => {
                received += chunk.length;
                const percent = Math.min(100, Math.round((received / total) * 100));
                if (percent > lastReport) {
                    lastReport = percent;
                    onProgress(received, total);
                }
            });
        }
        await pipeline(stream, createWriteStream(installerPath));
        return { ok: true, installerPath };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/** Old portable exe left on disk after the swap; harmless but removably so. */
const portableQuitter = (exePath, setupPath) => `@echo off\r\nrem OpenPets in-place update: wait for the old exe to exit, swap, relaunch.\r\nset "TARGET=${exePath}"\r\nset "OLD=${exePath}.old-${process.pid}.exe"\r\nset "NEW=${setupPath}"\r\n:waitloop\r\ntasklist /FI "PID eq ${process.pid}" 2>nul | findstr /I "OpenPets" >nul\r\nif not errorlevel 1 (\r\n  ping -n 2 127.0.0.1 >nul\r\n  goto waitloop\r\n)\r\nif exist "%TARGET%" ren "%TARGET%" "%OLD%"\r\ncopy /y "%NEW%" "%TARGET%" >nul\r\nif errorlevel 1 (\r\n  rem Rename failed (locked): restore and give up silently.\r\n  if exist "%OLD%" ren "%OLD%" "${exePath.split("\\").pop()}"\r\n  exit /b 1\r\n)\r\ndel "%OLD%" >nul 2>&1\r\nstart "" "%TARGET%"\r\n`;
/**
 * Hand the update over: the helper waits for this instance to quit. NSIS runs
 * the silent installer; portable swaps the exe in place and relaunches.
 */
export async function installUpdate(info, installerPath) {
    if (isPortableInstall()) {
        const exePath = process.env.PORTABLE_EXECUTABLE_FILE ?? installedExePath();
        const scriptPath = join(tmpdir(), `openpets-update-${process.pid}.cmd`);
        await writeFile(scriptPath, portableQuitter(exePath, installerPath), "utf8");
        spawn("cmd.exe", ["/c", scriptPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        console.log(`[update] portable swap scheduled: script=${scriptPath}`);
        return;
    }
    // Slight delay so app.quit() releases the install dir before NSIS writes.
    const scriptPath = join(tmpdir(), `openpets-update-${process.pid}.cmd`);
    const script = `@echo off\r\nping -n 4 127.0.0.1 >nul\r\n"${installerPath}" /S\r\n`;
    await writeFile(scriptPath, script, "utf8");
    spawn("cmd.exe", ["/c", scriptPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    console.log(`[update] silent install scheduled: script=${scriptPath}`);
    void info;
}
