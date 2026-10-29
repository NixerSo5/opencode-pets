/**
 * node-runtime.ts
 *
 * Self-contained Node.js runtime installer for the pet:
 *  - downloads the official nodejs.org Windows zip (latest LTS, exact arch)
 *  - extracts it into userData/runtime/node (no admin rights touched)
 *  - npm ships inside that zip, so after this `npm --version` works via PATH
 *
 * Never touches an existing system Node installation. The pet prepends the
 * runtime dir to its own PATH only, so OpenCode installs there too.
 */

import yauzl from "yauzl";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const nodeDistIndexUrl = "https://nodejs.org/dist/index.json";
/** Used when the index cannot be fetched; this version exists on nodejs.org. */
const fallbackNodeVersion = "v22.18.0";

/**
 * Download sources for the Node runtime, tried in order. nodejs.org first
 * (official), then the npmmirror CDN (plain mirror, no proxy needed), and
 * finally the first one again with the user's own proxy env if they set one.
 * No proxy is hardcoded anywhere.
 */
const nodeSources = [
  { index: "https://nodejs.org/dist/index.json", base: "https://nodejs.org/dist/" },
  { index: "https://npmmirror.com/mirrors/node/index.json", base: "https://npmmirror.com/mirrors/node/" },
] as const;

const maxZipBytes = 60 * 1024 * 1024;
/** A node zip unpacks to ~150MB across ~12k files (npm tree included). */
const maxExtractedBytes = 4 * 1024 * 1024 * 1024;
const maxExtractedFiles = 200_000;
/** Per-entry cap: nothing inside a node dist exceeds this. */
const maxZipEntryBytes = 128 * 1024 * 1024;

export interface NodeRuntimeResult {
  readonly ok: boolean;
  /** Directory containing node.exe / npm.cmd; caller prepends it to PATH. */
  readonly nodeDir?: string;
  readonly error?: string;
}

export type Progress = (message: string) => void;

/**
 * Download the latest LTS Node Windows zip for this machine's arch, extract it
 * under userData/runtime/node, and return that directory.
 */
export async function installNodeRuntime(userDataPath: string, onProgress: Progress = () => {}): Promise<NodeRuntimeResult> {
  try {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const { version, base } = await resolveDistribution(onProgress);
    onProgress(`下载 Node 运行时 ${version}（${arch}）…`);
    const buffer = await (async () => {
      try {
        return await downloadZip(version, arch, base, onProgress);
      } catch (firstError) {
        const fallbackSource = nodeSources.find((source) => source.base !== base);
        if (fallbackSource === undefined) throw firstError;
        onProgress(`第一个下载源不可用，改用镜像源（${fallbackSource.base}）…`);
        return await downloadZip(version, arch, fallbackSource.base, onProgress);
      }
    })();
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      return { ok: false, error: `下载的 Node 不是有效 ZIP: ${base}${version}/` };
    }

    const staging = join(userDataPath, "runtime", ".node-staging");
    const nodeDir = join(userDataPath, "runtime", "node");
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      onProgress("解压 Node 运行时…");
      await extractZip(buffer, staging);
      const root = await locateNodeRoot(staging);
      if (root === undefined) return { ok: false, error: "Node ZIP 里没有找到 node.exe" };
      await rm(nodeDir, { recursive: true, force: true });
      await renameProm(root, nodeDir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    onProgress(`Node 已就绪: ${nodeDir}`);
    return { ok: true, nodeDir };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Pick the first source whose index answers; fall back to a known-good LTS. */
async function resolveDistribution(onProgress: Progress): Promise<{ version: string; base: string }> {
  for (const source of nodeSources) {
    try {
      const version = await resolveLatestLts(source.index);
      return { version, base: source.base };
    } catch (error) {
      onProgress(`版本目录读取失败（${source.index}）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { version: fallbackNodeVersion, base: nodeSources[0].base };
}

async function resolveLatestLts(indexUrl: string): Promise<string> {
  const raw = await fetchJson(indexUrl);
  const index = JSON.parse(raw) as Array<{ version?: unknown; lts?: unknown }>;
  if (!Array.isArray(index)) throw new Error("Node dist index 格式不对");
  for (const entry of index) {
    if (entry.lts !== false && typeof entry.version === "string" && entry.version.startsWith("v")) {
      return entry.version;
    }
  }
  throw new Error("Node dist index 里没有 LTS 版本");
}

async function fetchJson(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);
  return response.text();
}

/**
 * Download attempts, in order: each source via direct fetch, then (only when
 * the user set proxy env) the same URL through curl with that proxy; if a
 * source is fully unreachable we move on to the next before giving up.
 * No proxy is ever hardcoded; the mirror needs neither proxy nor config.
 */
async function downloadZip(version: string, arch: string, base: string, onProgress: Progress): Promise<Buffer> {
  const zipUrl = `${base}${version}/node-${version}-win-${arch}.zip`;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  const failures: string[] = [];
  try {
    return await fetchZipDirect(zipUrl);
  } catch (error) {
    failures.push(`直连: ${summarize(error)}`);
  }
  if (proxy !== undefined) {
    onProgress("直连失败，改用系统代理重新下载…");
    try {
      return await fetchZipViaCurl(zipUrl, proxy);
    } catch (error) {
      failures.push(`代理(curl): ${summarize(error)}`);
    }
  }
  throw new Error(`Node 运行时下载失败（${zipUrl}）— ${failures.join("；")}`);
}

function summarize(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchZipDirect(zipUrl: string): Promise<Buffer> {
  const response = await fetch(zipUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}（${zipUrl}）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length <= maxZipBytes) return buffer;
  throw new Error("Node ZIP 超过 60MB 上限");
}

async function fetchZipViaCurl(zipUrl: string, proxy: string): Promise<Buffer> {
  const staged = join(process.env.TEMP ?? ".", "openpets-node-download.zip");
  const result = await new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn("curl.exe", ["-L", "--fail", "--max-time", "600", "--proxy", proxy, "-o", staged, zipUrl], {
      shell: true,
      windowsHide: true,
    });
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (e) => resolve({ code: -1, output: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, output: output.slice(-400) }));
  });
  if (result.code !== 0) {
    throw new Error(`curl 退出 ${result.code}: ${result.output}`);
  }
  const buffer = await readFile(staged);
  await rm(staged, { force: true });
  if (buffer.length > maxZipBytes) throw new Error("Node ZIP 超过 60MB 上限");
  return buffer;
}

/** Generic yauzl extraction, guarded by the capacity limits above. */
async function extractZip(buffer: Buffer, destination: string): Promise<void> {
  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, autoClose: true }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
  return await new Promise((resolve, reject) => {
    let extractedBytes = 0;
    let extractedFiles = 0;
    zipfile.on("error", reject);
    zipfile.on("end", () => resolve());
    zipfile.on("entry", (entry: yauzl.Entry) => {
      const name = entry.fileName;
      const skip = name.endsWith("/") || name.includes("\\") || name.split("/").some((part) => part === ".." || part.length === 0);
      if (skip) {
        zipfile.readEntry();
        return;
      }
      const uncompressed = (entry as unknown as { uncompressedSize?: number }).uncompressedSize ?? 0;
      extractedBytes += uncompressed;
      extractedFiles += 1;
      if (extractedBytes > maxExtractedBytes || extractedFiles > maxExtractedFiles || uncompressed > maxZipEntryBytes) {
        reject(new Error("解压大小或文件数超出安全上限"));
        zipfile.close();
        return;
      }
      zipfile.openReadStream(entry, (streamError, stream) => {
        if (streamError || !stream) {
          zipfile.readEntry();
          return;
        }
        const outPath = join(destination, name);
        stream.on("error", reject);
        stream.on("end", () => zipfile.readEntry());
        void (async () => {
          await mkdir(join(outPath, ".."), { recursive: true });
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
          await writeFile(outPath, Buffer.concat(chunks));
        })().catch((error) => {
          try { zipfile.close(); } catch { /* already closing */ }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    });
    zipfile.readEntry();
  });
}

/** The zip may nest one level; find the dir that actually contains node.exe. */
async function locateNodeRoot(staging: string): Promise<string | undefined> {
  if (await hasNodeExe(staging)) return staging;
  const entries = await readdir(staging, { withFileTypes: true });
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const nested = join(staging, dirent.name);
    if (await hasNodeExe(nested)) return nested;
  }
  return undefined;
}

async function hasNodeExe(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "node.exe"))).isFile();
  } catch {
    return false;
  }
}

/** rename() is used (not copy): same volume, instant, keeps permissions. */
function renameProm(from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    import("node:fs/promises").then((fs) => fs.rename(from, to).then(resolve, reject));
  });
}
