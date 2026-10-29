/**
 * catalog-install.ts
 *
 * Marketplace pet installation: download the ZIP (magic-byte validated, size
 * capped), extract it safely (no traversal / non-file entries / oversized
 * content) into a staging dir, validate pet.json + spritesheet, then promote
 * it into userData/pets/{id}/. Mirrors the original shared ZIP safety rules.
 */

import yauzl from "yauzl";
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isAbsolute } from "node:path";

import { parsePetManifest, petsRoot, listInstalledPets } from "./pet-store.js";

const maxZipBytes = 50 * 1024 * 1024;
const maxExtractedBytes = 200 * 1024 * 1024;
const maxExtractedFiles = 500;
const maxZipEntryBytes = 100 * 1024 * 1024;

export interface CatalogInstallResult {
  readonly ok: boolean;
  readonly message: string;
  readonly id?: string;
}

const allowedZipHosts = ["zip.openpets.dev", "openpets.dev"];

function assertZipUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("宠物包下载地址必须是 https");
  if (!allowedZipHosts.includes(parsed.hostname)) throw new Error(`不允许的下载主机: ${parsed.hostname}`);
}

async function downloadZip(entry: { readonly zip: string }): Promise<Buffer> {
  assertZipUrl(entry.zip);
  const response = await fetch(entry.zip, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxZipBytes) throw new Error("宠物包 ZIP 超过 50MB 上限");
  if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw new Error("下载内容不是有效的 ZIP 文件");
  return buffer;
}

function safeEntryName(name: string): string | undefined {
  if (name.endsWith("/")) return undefined;
  if (isAbsolute(name) || name.includes("\\")) return undefined;
  const parts = name.split("/");
  if (parts.some((part) => part === ".." || part.length === 0)) return undefined;
  return parts.join("/");
}

async function extractZipTo(buffer: Buffer, destination: string): Promise<void> {
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
      const safeName = safeEntryName(entry.fileName);
      if (!safeName) {
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
        const outPath = join(destination, safeName);
        stream.on("error", reject);
        stream.on("end", () => zipfile.readEntry());
        void (async () => {
          const { mkdir, writeFile } = await import("node:fs/promises");
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

/** Install a marketplace pet by id; fetches the entry, downloads, extracts, validates, promotes. */
export async function installCatalogPet(userDataPath: string, petId: string): Promise<CatalogInstallResult> {
  try {
    const { getCatalogAllPets, getCatalogPage } = await import("./catalog-client.js");
    const all = await getCatalogAllPets();
    let entry = all.find((candidate) => candidate.id === petId);
    if (!entry) return { ok: false, message: `商城里没有 ${petId}` };
    // Search-index entries are slim records without `zip`; the full entry
    // (with download URLs) lives on the catalog page it points to.
    if (!entry.zip) {
      const pageIndex = typeof entry.catalogPage === "number" ? entry.catalogPage : 0;
      const page = await getCatalogPage(pageIndex);
      entry = page.pets.find((candidate) => candidate.id === petId) ?? entry;
    }
    if (!entry.zip) return { ok: false, message: `${entry.displayName} 没有可下载的 ZIP` };
    // Wardrobe packages ship the full outfit set; the plain `zip` keeps base
    // compatibility. Prefer the wardrobe ZIP whenever the entry carries one.
    const zipSources: { label: string; url: string }[] = entry.wardrobeZip !== undefined
      ? [
        { label: "wardrobe", url: entry.wardrobeZip },
        { label: "base", url: entry.zip },
      ]
      : [{ label: "base", url: entry.zip }];
    if (zipSources.some((source) => source.url.length > 2048)) return { ok: false, message: "下载地址非法" };

    let buffer: Buffer | undefined;
    for (const source of zipSources) {
      try {
        buffer = await downloadZip({ zip: source.url });
        console.log(`[catalog-install] pet=${petId} downloaded ${source.label} zip`);
        break;
      } catch (error) {
        console.log(`[catalog-install] ${source.label} zip failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (buffer === undefined) {
      const reason = zipSources.length > 1 ? `${zipSources[0].label} 与 ${zipSources[1].label} 包都下载失败` : "下载失败";
      return { ok: false, message: reason };
    }
    const staging = join(petsRoot(userDataPath), `.staging-${petId}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      await extractZipTo(buffer, staging);
      // The package root may or may not nest the package files one level deep;
      // locate pet.json from the staging root downward (one extra level).
      const root = await locatePackageRoot(staging);
      const manifestRaw = JSON.parse(await readFile(join(root, "pet.json"), "utf8")) as unknown;
      const parsed = parsePetManifest(manifestRaw);
      if ("error" in parsed) return { ok: false, message: parsed.error };
      const spritesheetRelative = typeof (manifestRaw as Record<string, unknown>).spritesheetPath === "string" ? (manifestRaw as { spritesheetPath: string }).spritesheetPath : "";
      const spritesheetStat = await stat(join(root, spritesheetRelative));
      if (!spritesheetStat.isFile()) return { ok: false, message: `精灵图缺失: ${spritesheetRelative}` };
      const destination = join(petsRoot(userDataPath), parsed.entry.id);
      try {
        await rm(destination, { recursive: true, force: true });
        await cp(root, destination, { recursive: true });
      } catch (promoteError) {
        const reason = promoteError instanceof Error ? promoteError.message : String(promoteError);
        return { ok: false, message: `写入 ${destination} 失败: ${reason}` };
      }
      if (!(await stat(join(destination, "pet.json")).catch(() => undefined))?.isFile()) {
        await rm(destination, { recursive: true, force: true });
        return { ok: false, message: `安装后未找到 pet.json（目标目录: ${destination}）` };
      }
      const installed = await listInstalledPets(userDataPath).catch(() => []);
      const found = installed.find((entry) => entry.id === parsed.entry.id);
      if (found === undefined) {
        await rm(destination, { recursive: true, force: true });
        return { ok: false, message: "安装后的目录没有通过宠物校验（pet.json/精灵图）" };
      }
      const outfits = found.wardrobe?.outfits.length ?? 0;
      const suffix = outfits > 0 ? `（含 ${outfits} 套皮肤）` : "";
      return { ok: true, message: `已安装 ${found.displayName}${suffix}`, id: found.id };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function locatePackageRoot(staging: string): Promise<string> {
  const entries = await readdir(staging, { withFileTypes: true });
  if (entries.some((dirent) => dirent.isFile() && dirent.name === "pet.json")) return staging;
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const nested = join(staging, dirent.name);
    const nestedEntries = await readdir(nested, { withFileTypes: true });
    if (nestedEntries.some((candidate) => candidate.isFile() && candidate.name === "pet.json")) return nested;
  }
  throw new Error("ZIP 中没有找到 pet.json");
}
