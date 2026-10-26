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
};
const petIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const directoryName = "pets";
export function petsRoot(userDataPath) {
    return join(userDataPath, directoryName);
}
/** Validate a pet.json-shaped record; returns a normalized entry or an error. */
export function parsePetManifest(raw) {
    if (typeof raw !== "object" || raw === null)
        return { error: "pet.json 不是对象" };
    const manifest = raw;
    const id = typeof manifest.id === "string" ? manifest.id.trim() : "";
    if (!petIdPattern.test(id) || id === "builtin")
        return { error: `pet.json 的 id 非法: "${id}"（必须是小写字母数字-_，且不能叫 builtin）` };
    const displayName = typeof manifest.displayName === "string" && manifest.displayName.trim() ? manifest.displayName.trim() : id;
    const description = typeof manifest.description === "string" && manifest.description.trim() ? manifest.description.trim() : undefined;
    const versionRaw = typeof manifest.spritesheetPath === "string" ? manifest.spritesheetPath.trim() : "";
    if (!versionRaw)
        return { error: "pet.json 缺少 spritesheetPath" };
    const version = manifest.spriteVersionNumber === 2 ? 2 : 1;
    return { entry: { id, displayName, description, spriteVersionNumber: version } };
}
export async function listInstalledPets(userDataPath) {
    const root = petsRoot(userDataPath);
    if (!existsSync(root))
        return [];
    const ids = (await readdir(root, { withFileTypes: true })).filter((dirent) => dirent.isDirectory()).map((dirent) => dirent.name);
    const entries = [];
    for (const id of ids) {
        if (!petIdPattern.test(id) || id === "builtin")
            continue;
        const petDir = join(root, id);
        try {
            const manifestRaw = JSON.parse(await readFile(join(petDir, "pet.json"), "utf8"));
            const parsed = parsePetManifest(manifestRaw);
            if ("error" in parsed)
                continue;
            const spritesheetPath = join(petDir, typeof manifestRaw.spritesheetPath === "string" ? manifestRaw.spritesheetPath : "spritesheet.webp");
            if (!existsSync(spritesheetPath))
                continue;
            entries.push({ ...parsed.entry, spritesheetPath, builtIn: false });
        }
        catch {
            // A malformed pet package is skipped, matching the host's "skip broken pet" behavior.
        }
    }
    return entries;
}
/** Import a pet package folder into userData/pets/{id}/. */
export async function importPetFolder(userDataPath, sourceDir) {
    try {
        const manifestRaw = JSON.parse(await readFile(join(sourceDir, "pet.json"), "utf8"));
        const parsed = parsePetManifest(manifestRaw);
        if ("error" in parsed)
            return { ok: false, message: parsed.error };
        const spritesheetRelative = typeof manifestRaw.spritesheetPath === "string" ? manifestRaw.spritesheetPath : "";
        if (!spritesheetRelative)
            return { ok: false, message: "pet.json 缺少 spritesheetPath" };
        const spritesheetSource = join(sourceDir, spritesheetRelative);
        const spritesheetStat = await stat(spritesheetSource);
        if (!spritesheetStat.isFile())
            return { ok: false, message: `spritesheet 不存在: ${spritesheetRelative}` };
        const destination = join(petsRoot(userDataPath), parsed.entry.id);
        await cp(sourceDir, destination, { recursive: true });
        return { ok: true, message: `已导入 ${parsed.entry.displayName}`, id: parsed.entry.id };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
export function readManagedState(userDataPath) {
    try {
        const raw = JSON.parse(readFileSync(join(userDataPath, "state.json"), "utf8"));
        return { defaultPetId: typeof raw.defaultPetId === "string" ? raw.defaultPetId : builtInPetEntry.id };
    }
    catch {
        return { defaultPetId: builtInPetEntry.id };
    }
}
export async function writeManagedState(userDataPath, state) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(userDataPath, { recursive: true });
    await writeFile(join(userDataPath, "state.json"), JSON.stringify(state, null, 2), "utf8");
}
/** Resolve the pet to render: the stored default or the built-in fallback. */
export async function resolveDefaultPet(userDataPath) {
    const state = readManagedState(userDataPath);
    if (state.defaultPetId === builtInPetEntry.id)
        return { ...builtInPetEntry, spritesheetPath: "", builtIn: true };
    const installed = await listInstalledPets(userDataPath);
    const found = installed.find((entry) => entry.id === state.defaultPetId);
    if (found)
        return found;
    return { ...builtInPetEntry, spritesheetPath: "", builtIn: true };
}
