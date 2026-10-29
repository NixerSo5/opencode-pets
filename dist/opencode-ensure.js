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
import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { discoverService } from "./opencode-client.js";
import { installNodeRuntime } from "./node-runtime.js";
const probeTimeoutMs = 3_000;
const installTimeoutMs = 15 * 60_000;
const startTimeoutMs = 60_000;
const waitServiceMs = 2 * 60_000;
const waitPollIntervalMs = 2_000;
/** The v2 CLI npm package (cross-platform, ships per-OS binaries as optional deps). */
const npmInstallCommand = "npm install -g @opencode/cli";
/** Quick liveness probe for a discovered endpoint. */
export async function probeService(endpoint, timeoutMs = probeTimeoutMs) {
    try {
        const response = await fetch(`${endpoint.url}/api/info`, {
            headers: { Authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}` },
            signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok;
    }
    catch {
        return false;
    }
}
/** Run a command through the OS shell; output is bounded so logs stay small. */
function spawnRun(command, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(command, { shell: true, windowsHide: true });
        let output = "";
        let settled = false;
        const finish = (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, output: output.slice(-4000) });
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch { /* already gone */ }
            finish(-1);
        }, timeoutMs);
        void child.stdout;
        child.stdout?.on("data", (chunk) => {
            output += chunk.toString();
            if (output.length > 4000)
                output = output.slice(-2000);
        });
        child.stderr?.on("data", (chunk) => {
            output += chunk.toString();
            if (output.length > 4000)
                output = output.slice(-2000);
        });
        child.on("error", () => finish(-1));
        child.on("close", (code) => finish(code ?? -1));
    });
}
/** True when `opencode --version` exits 0. */
async function isOpencodeInstalled(run) {
    const result = await run("opencode --version", 15_000);
    return result.code === 0;
}
/** True when `npm --version` exits 0 (Node.js present). */
async function isNpmAvailable(run) {
    const result = await run("npm --version", 15_000);
    return result.code === 0;
}
/**
 * Ensure OpenCode is installed and the background service is running.
 * Never kills a running service; only probes, installs, and starts.
 */
export async function ensureOpenCodeService(options = {}) {
    const onProgress = options.onProgress;
    const run = options.run ?? spawnRun;
    onProgress?.({ stage: "probe", message: "探测本机 OpenCode 服务…" });
    const existing = await discoverService();
    if (existing !== undefined && (await probeService(existing))) {
        return { ok: true, endpoint: existing };
    }
    // A stale service.json (dead pid) falls through to start; we never stop it.
    let installedHere = false;
    if (!(await isOpencodeInstalled(run))) {
        if (!(await isNpmAvailable(run))) {
            if (options.userDataPath === undefined) {
                return {
                    ok: false,
                    error: "本机没有 OpenCode，也没有可用的 npm。请先安装 Node.js LTS（https://nodejs.org），" +
                        "或在终端执行 npm install -g @opencode/cli 后重启宠物。",
                };
            }
            // No opencode and no npm: install a bundled Node runtime (npm ships
            // inside it) into userData, with no admin rights and no PATH pollution.
            const runtime = await installNodeRuntime(options.userDataPath, (message) => {
                onProgress?.({ stage: "install", message });
            });
            if (!runtime.ok) {
                return { ok: false, error: `Node 运行时安装失败: ${runtime.error ?? "未知错误"}` };
            }
            // Make node/npm usable for every spawned child, starting with the
            // `npm --version` re-check below.
            const nodeDir = runtime.nodeDir ?? "";
            process.env.PATH = `${nodeDir}${delimiter}${process.env.PATH ?? ""}`;
            // Pin npm's global prefix to the bundled runtime so the `opencode`
            // shim lands inside the dir we just put on PATH (Windows npm would
            // otherwise default to %APPDATA%\npm, which may not be on PATH).
            if (nodeDir)
                process.env.npm_config_prefix = nodeDir;
            if (!(await isNpmAvailable(run))) {
                return { ok: false, error: `内置 Node 运行时装好了，但 npm 仍不可用（${runtime.nodeDir}）` };
            }
        }
        onProgress?.({ stage: "install", message: `本机没有 OpenCode，执行「${npmInstallCommand}」…` });
        const install = await run(npmInstallCommand, installTimeoutMs);
        if (install.code !== 0) {
            return { ok: false, error: `OpenCode 安装失败（npm exit=${install.code}）: ${tail(install.output)}` };
        }
        installedHere = true;
        // Verify the install actually landed; PATH already includes the npm global
        // dir, so a fresh shell finds the shim without any restart.
        const version = await run("opencode --version", 15_000);
        if (version.code !== 0) {
            return { ok: false, installedHere, error: `OpenCode 已安装但 opencode 命令不可用（exit=${version.code}）: ${tail(version.output)}` };
        }
        onProgress?.({ stage: "install", message: `OpenCode 安装完成（${version.output.trim() || "版本未知"}）` });
    }
    onProgress?.({ stage: "start", message: "启动 OpenCode 后台服务…" });
    const started = await run("opencode service start", startTimeoutMs);
    if (started.code !== 0) {
        return { ok: false, installedHere, error: `opencode service start 失败（exit=${started.code}）: ${tail(started.output)}` };
    }
    onProgress?.({ stage: "wait", message: "等待 OpenCode 服务就绪…" });
    const deadline = Date.now() + (options.pollMaxMs ?? waitServiceMs);
    while (Date.now() < deadline) {
        const endpoint = await discoverService();
        if (endpoint !== undefined && (await probeService(endpoint))) {
            return { ok: true, endpoint, installedHere, startedHere: true };
        }
        await new Promise((resolve) => setTimeout(resolve, waitPollIntervalMs));
    }
    return { ok: false, installedHere, error: "OpenCode 服务启动超时（service.json 无响应）" };
}
function tail(output) {
    const trimmed = output.trim();
    return trimmed.length === 0 ? "(无输出)" : trimmed.slice(-400);
}
