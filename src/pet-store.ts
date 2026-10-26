/**
 * pet-store.ts
 *
 * Installed-pet storage for the standalone app: scans userData/pets/{id}/
 * packages (pet.json + spritesheet), validates them per the extracted pet
 * contract, supports importing a local folder, and persists the default pet
 * choice in state.json.
 */

import { cp, readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const builtInPetEntry = {
  id: "builtin",
  displayName: "Hoodie Cat",
  description: "Bundled default pet, always available.",
  spriteVersionNumber: 2,
} as const;

export interface PetStoreEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  /** 1 = legacy 8×9 atlas, 2 = 8×11 atlas (0-8 rows carry the reaction states in both). */
  readonly spriteVersionNumber: 1 | 2;
  readonly spritesheetPath: string;
  readonly builtIn: boolean;
}

export interface ManagedPetState {
  readonly defaultPetId: string;
}

const petIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const directoryName = "pets";

export function petsRoot(userDataPath: string): string {
  return join(userDataPath, directoryName);
}

/** Validate a pet.json-shaped record; returns a normalized entry or an error. */
export function parsePetManifest(raw: unknown): { entry: Omit<PetStoreEntry, "spritesheetPath" | "builtIn"> } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "pet.json 不是对象" };
  const manifest = raw as Record<string, unknown>;
  const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
  if (!petIdPattern.test(id) || id === "builtin") return { error: `pet.json 的 id 非法: "${id}"（必须是小写字母数字-_，且不能叫 builtin）` };
  const displayName = typeof manifest.displayName === "string" && manifest.displayName.trim() ? manifest.displayName.trim() : id;
  const description = typeof manifest.description === "string" && manifest.description.trim() ? manifest.description.trim() : undefined;
  const versionRaw = typeof manifest.spritesheetPath === "string" ? manifest.spritesheetPath.trim() : "";
  if (!versionRaw) return { error: "pet.json 缺少 spritesheetPath" };
  const version: 1 | 2 = manifest.spriteVersionNumber === 2 ? 2 : 1;
  return { entry: { id, displayName, description, spriteVersionNumber: version } };
}

export async function listInstalledPets(userDataPath: string): Promise<PetStoreEntry[]> {
  const root = petsRoot(userDataPath);
  if (!existsSync(root)) return [];
  const ids = (await readdir(root, { withFileTypes: true })).filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
  const entries: PetStoreEntry[] = [];
  for (const id of ids) {
    if (!petIdPattern.test(id) || id === "builtin") continue;
    const petDir = join(root, id);
    try {
      const manifestRaw = JSON.parse(await readFile(join(petDir, "pet.json"), "utf8")) as unknown;
      const parsed = parsePetManifest(manifestRaw);
      if ("error" in parsed) continue;
      const spritesheetPath = join(petDir, typeof (manifestRaw as Record<string, unknown>).spritesheetPath === "string" ? (manifestRaw as { spritesheetPath: string }).spritesheetPath : "spritesheet.webp");
      if (!existsSync(spritesheetPath)) continue;
      entries.push({ ...parsed.entry, spritesheetPath, builtIn: false });
    } catch {
      // A malformed pet package is skipped, matching the host's "skip broken pet" behavior.
    }
  }
  return entries;
}

export interface ImportFolderResult {
  readonly ok: boolean;
  readonly message: string;
  readonly id?: string;
}

/** Import a pet package folder into userData/pets/{id}/. */
export async function importPetFolder(userDataPath: string, sourceDir: string): Promise<ImportFolderResult> {
  try {
    const manifestRaw = JSON.parse(await readFile(join(sourceDir, "pet.json"), "utf8")) as unknown;
    const parsed = parsePetManifest(manifestRaw);
    if ("error" in parsed) return { ok: false, message: parsed.error };
    const spritesheetRelative = typeof (manifestRaw as Record<string, unknown>).spritesheetPath === "string" ? (manifestRaw as { spritesheetPath: string }).spritesheetPath : "";
    if (!spritesheetRelative) return { ok: false, message: "pet.json 缺少 spritesheetPath" };
    const spritesheetSource = join(sourceDir, spritesheetRelative);
    const spritesheetStat = await stat(spritesheetSource);
    if (!spritesheetStat.isFile()) return { ok: false, message: `spritesheet 不存在: ${spritesheetRelative}` };
    const destination = join(petsRoot(userDataPath), parsed.entry.id);
    await cp(sourceDir, destination, { recursive: true });
    return { ok: true, message: `已导入 ${parsed.entry.displayName}`, id: parsed.entry.id };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function readManagedState(userDataPath: string): ManagedPetState {
  try {
    const raw = JSON.parse(readFileSync(join(userDataPath, "state.json"), "utf8")) as Record<string, unknown>;
    return { defaultPetId: typeof raw.defaultPetId === "string" ? raw.defaultPetId : builtInPetEntry.id };
  } catch {
    return { defaultPetId: builtInPetEntry.id };
  }
}

export async function writeManagedState(userDataPath: string, state: ManagedPetState): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(userDataPath, { recursive: true });
  await writeFile(join(userDataPath, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

/** Resolve the pet to render: the stored default or the built-in fallback. */
export async function resolveDefaultPet(userDataPath: string): Promise<PetStoreEntry> {
  const state = readManagedState(userDataPath);
  if (state.defaultPetId === builtInPetEntry.id) return { ...builtInPetEntry, spritesheetPath: "", builtIn: true };
  const installed = await listInstalledPets(userDataPath);
  const found = installed.find((entry) => entry.id === state.defaultPetId);
  if (found) return found;
  return { ...builtInPetEntry, spritesheetPath: "", builtIn: true };
}
