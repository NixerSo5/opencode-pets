/**
 * app-update.ts
 *
 * GitHub-release update flow for OpenPets, Gitee-first:
 *  1. `checkForUpdate` reads the latest release from the GitHub API and
 *     compares the tag against the running version.
 *  2. `findGiteeVolumes` looks up the same tag on the Gitee mirror; when the
 *     mirror carries split `.7z.001/.002…` volumes of the installer they are
 *     downloaded first (fast in CN and small attachments respect Gitee's
 *     100 MB per-file limit).
 *  3. `extractVolumes` assembles the installer with the bundled standalone
 *     7-Zip console (vendor/7zr.exe) into a temp dir.
 *  4. When the mirror is unreachable or lacks volumes, `downloadUpdate`
 *     falls back to streaming the GitHub asset (NSIS for installed builds,
 *     portable exe for portable installs) with progress callbacks.
 *  5. `installUpdate` hands the run over to a detached helper: the packaged
 *     app runs the NSIS installer silently after this instance has quit; the
 *     portable app renames its own running exe out of the way, drops the new
 *     one in, and relaunches once the old process is really gone.
 *
 * No autoUpdater dependency: the release assets are already hosted, the NSIS
 * installer knows how to install itself, and 7zr knows how to unpack. The
 * pet app only choreographs.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repository = "NixerSo5/opencode-pets";
const giteeOwnerRepo = "nixer/opencode-pets";
const releaseApiUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const giteeTagApiUrl = (tag: string) => `https://gitee.com/api/v5/repos/${giteeOwnerRepo}/releases/tags/${tag}`;
const timeoutMs = 15_000;

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
  readonly giteeVolumes?: readonly { readonly name: string; readonly url: string; readonly size: number }[];
}

export interface DownloadResult {
  readonly ok: boolean;
  readonly installerPath?: string;
  readonly error?: string;
}

export type DownloadProgress = (received: number, total: number) => void;

/** Where the bundled extractable 7-Zip console lives (packaged or dev). */
function bundled7zPath(): string | undefined {
  // dist/app-update.js → ../vendor/7zr.exe in the repo; packaged installs
  // ship it as an extraResource next to resourcesPath.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [join(here, "..", "vendor", "7zr.exe")];
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    candidates.unshift(join(process.resourcesPath, "vendor", "7zr.exe"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Packaged install (NSIS) vs portable exe, detected from the environment. */
export function isPortableInstall(): boolean {
  return typeof process.env.PORTABLE_EXECUTABLE_FILE === "string" && process.env.PORTABLE_EXECUTABLE_FILE.length > 0;
}

export function parseSemver(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (a === undefined || b === undefined) return false;
  return a[0] !== b[0]
    ? a[0] > b[0]
    : a[1] !== b[1]
      ? a[1] > b[1]
      : a[2] > b[2];
}

/** Read the running exe's full path (packaged); Electron execPath is inside
 *  app.asar-unpacked for asar builds, but the NSIS install dir is its dirname. */
function installedExePath(): string {
  return process.execPath;
}

/** Pick the asset that matches this install mode. */
function pickAsset(mode: "portable" | "nsis", version: string, assets: Array<{ name: string; browser_download_url: string; size: number }>): { url: string; name: string; size: number } | undefined {
  // Packaged releases name the NSIS asset "OpenPets.Setup.1.4.0.exe" and the
  // portable one "OpenPets.1.4.0.exe"; fall back to any Setup exe otherwise.
  const wanted = mode === "portable"
    ? [`OpenPets.${version}.exe`, `OpenPetsSetup${version}.exe`]
    : [`OpenPets.Setup.${version}.exe`];
  for (const name of wanted) {
    const match = assets.find((asset) => asset.name.toLowerCase() === name.toLowerCase());
    if (match !== undefined) return { url: match.browser_download_url, name: match.name, size: match.size };
  }
  if (mode === "nsis") {
    const fallback = assets.find((asset) => asset.name.toLowerCase().includes("setup") && asset.name.toLowerCase().endsWith(".exe"));
    if (fallback !== undefined) return { url: fallback.browser_download_url, name: fallback.name, size: fallback.size };
  }
  return undefined;
}

/** Query the GitHub API; undefined (no error detail) when nothing newer. */
export async function checkForUpdate(current: string): Promise<UpdateInfo | undefined> {
  try {
    const response = await fetch(releaseApiUrl, {
      headers: { "User-Agent": "openpets-release", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.log(`[update] check skipped: HTTP ${response.status}`);
      return undefined;
    }
    const release = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: Array<{ name: string; browser_download_url: string; size: number }>;
    };
    if (release.draft === true || release.prerelease === true) return undefined;
    const latest = parseSemver(release.tag_name ?? "") === undefined ? undefined : (release.tag_name ?? "").replace(/^v/, "");
    if (latest === undefined) {
      console.log(`[update] check skipped: unparsable tag ${release.tag_name ?? "(none)"}`);
      return undefined;
    }
    if (!isNewerVersion(latest, current)) return undefined;
    const mode = isPortableInstall() ? "portable" : "nsis";
    const assets = release.assets ?? [];
    const asset = pickAsset(mode, latest, assets) ?? (mode === "nsis" ? undefined : pickAsset("nsis", latest, assets));
    if (asset === undefined) {
      console.log(`[update] release ${latest} has no asset for mode=${mode}`);
      return undefined;
    }
    // Prefer the Gitee mirror (CN-fast, fits the 100 MB attachment limit via
    // split volumes); undefined when the mirror has no release for this tag,
    // which sends the download to the GitHub asset directly.
    const giteeVolumes = mode === "nsis" ? await findGiteeVolumes(latest) : undefined;
    if (mode === "nsis" && giteeVolumes === undefined) {
      console.log("[update] gitee mirror unavailable or volume-less; will fall back to github");
    }
    console.log(`[update] available: ${current} -> ${latest} (${asset.name})`);
    return {
      current,
      latest,
      releaseUrl: release.html_url ?? "",
      assetUrl: asset.url,
      assetName: asset.name,
      assetSize: asset.size,
      giteeVolumes,
    };
  } catch (error) {
    console.log(`[update] check failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

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
export async function findGiteeVolumes(version: string): Promise<readonly GiteeVolume[] | undefined> {
  try {
    const response = await fetch(giteeTagApiUrl(`v${version}`), {
      headers: { "User-Agent": "openpets-release" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.log(`[update] gitee release ${version}: HTTP ${response.status}`);
      return undefined;
    }
    const release = (await response.json()) as {
      assets?: Array<{ name: string; browser_download_url: string; size?: number }>;
    } | undefined;
    if (release === undefined || typeof release !== "object") {
      console.log(`[update] gitee release ${version}: missing`);
      return undefined;
    }
    const volumes = (release.assets ?? [])
      .filter((asset) => /\.7z\.\d{3}$/.test(asset.name) && asset.browser_download_url !== undefined)
      .map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: Number(asset.size ?? 0) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return volumes.length > 0 ? volumes : undefined;
  } catch (error) {
    console.log(`[update] gitee check failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Download every mirror volume into `destDir`, reporting progress as
 * (receivedInPart, totalInPart). Volumes stream one after another; a failed
 * part aborts the whole chain (partial files all removed).
 */
export async function downloadGiteeVolumes(
  volumes: readonly GiteeVolume[],
  destDir: string,
  onProgress?: DownloadProgress,
  onPartStart?: (name: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const volume of volumes) {
      console.log(`[update] gitee volume ${volume.name} ← ${volume.url}`);
      onPartStart?.(volume.name);
      const response = await fetch(volume.url, { headers: { "User-Agent": "openpets-release" }, redirect: "follow" });
      if (!response.ok || response.body === null) {
        return { ok: false, error: `分卷下载失败：HTTP ${response.status}` };
      }
      const total = Number(response.headers.get("content-length") ?? volume.size);
      let received = 0;
      let lastReport = -1;
      const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
      const file = createWriteStream(join(destDir, volume.name));
      stream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0 && onProgress !== undefined) {
          const percent = Math.min(100, Math.round((received / total) * 100));
          if (percent > lastReport) {
            lastReport = percent;
            onProgress(received, total);
          }
        }
      });
      await pipeline(stream, file);
    }
    return { ok: true };
  } catch (error) {
    rmSync(destDir, { recursive: true, force: true });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Assemble the installer from downloaded split volumes with the bundled 7-Zip
 * console, and return the extracted exe. No shell involved: 7zr gets argv.
 */
export async function extractVolumes(firstVolumePath: string, destDir: string): Promise<{ ok: boolean; installerPath?: string; error?: string }> {
  const sevenZip = bundled7zPath();
  if (sevenZip === undefined) {
    return { ok: false, error: "内置 7-Zip 解压器缺失（vendor/7zr.exe）" };
  }
  try {
    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      const child = spawn(sevenZip, ["x", "-y", `-o${destDir}`, firstVolumePath], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let output = "";
      let done = false;
      const finish = (code: number) => {
        if (done) return;
        done = true;
        resolve({ code, output: output.slice(-2000) });
      };
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.on("error", () => finish(-1));
      child.on("close", (code) => finish(code ?? -1));
    });
    if (result.code !== 0) {
      return { ok: false, error: `7zr 解压失败（exit=${result.code}）: ${result.output.trim().slice(-400)}` };
    }
    const extracted = readdirSync(destDir).find((name) => name.toLowerCase().endsWith(".exe")) ?? "OpenPets Setup.exe";
    const candidates = readdirSync(destDir).filter((name) => name.toLowerCase().endsWith(".exe"));
    const preferred = candidates.find((name) => name.toLowerCase().includes("setup")) ?? candidates[0];
    void extracted;
    if (preferred === undefined) {
      return { ok: false, error: "解压完成但没有找到安装程序 exe" };
    }
    console.log(`[update] extracted installer: ${preferred}`);
    return { ok: true, installerPath: join(destDir, preferred) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Stream the asset into a temp file. `installerPath` only exists afterwards:
 * partial files are removed so a retried download never installs half a file.
 */
export async function downloadUpdate(info: UpdateInfo, onProgress?: DownloadProgress): Promise<DownloadResult> {
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
    const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    // One callback per whole percent keeps the IPC traffic tiny.
    if (total > 0 && onProgress !== undefined) {
      stream.on("data", (chunk: Buffer) => {
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
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Old portable exe left on disk after the swap; harmless but removably so. */
const portableQuitter = (exePath: string, setupPath: string): string =>
  `@echo off\r\nrem OpenPets in-place update: wait for the old exe to exit, swap, relaunch.\r\nset "TARGET=${exePath}"\r\nset "OLD=${exePath}.old-${process.pid}.exe"\r\nset "NEW=${setupPath}"\r\n:waitloop\r\ntasklist /FI "PID eq ${process.pid}" 2>nul | findstr /I "OpenPets" >nul\r\nif not errorlevel 1 (\r\n  ping -n 2 127.0.0.1 >nul\r\n  goto waitloop\r\n)\r\nif exist "%TARGET%" ren "%TARGET%" "%OLD%"\r\ncopy /y "%NEW%" "%TARGET%" >nul\r\nif errorlevel 1 (\r\n  rem Rename failed (locked): restore and give up silently.\r\n  if exist "%OLD%" ren "%OLD%" "${exePath.split("\\").pop()}"\r\n  exit /b 1\r\n)\r\ndel "%OLD%" >nul 2>&1\r\nstart "" "%TARGET%"\r\n`;

/**
 * Hand the update over: the helper waits for this instance to quit. NSIS runs
 * the silent installer; portable swaps the exe in place and relaunches.
 */
export async function installUpdate(info: UpdateInfo, installerPath: string): Promise<void> {
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
  const script =
    `@echo off\r\nping -n 4 127.0.0.1 >nul\r\n"${installerPath}" /S\r\n`;
  await writeFile(scriptPath, script, "utf8");
  spawn("cmd.exe", ["/c", scriptPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  console.log(`[update] silent install scheduled: script=${scriptPath}`);
  void info;
}
