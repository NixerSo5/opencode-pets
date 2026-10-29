/**
 * pet-store.ts
 *
 * Installed-pet storage for the standalone app: scans userData/pets/{id}/
 * packages (pet.json + spritesheet), validates them per the extracted pet
 * contract, supports importing a local folder, and persists the default pet
 * choice in state.json.
 */
import { cp, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWardrobe } from "./pet-wardrobe-core.js";
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
/**
 * Validate the manifest and keep only outfits whose files exist on disk. A
 * package declaring outfits it does not still ships would otherwise render a
 * blank pet, so those outfits are dropped from the entry (the base atlas and
 * the pet itself stay valid).
 */
function wardrobesAtPath(petDir, manifest) {
    const wardrobe = parseWardrobe(manifest.wardrobe);
    if (wardrobe === undefined)
        return undefined;
    const present = wardrobe.outfits.filter((outfit) => existsSync(join(petDir, outfit.spritesheetPath)));
    if (present.length === 0)
        return undefined;
    return wardrobe.outfits.length === present.length ? wardrobe : { ...wardrobe, outfits: present };
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
/**
 * Build the entry for one installed pet directory. `spritesheetRelative`
 * defaults to the manifest's own value; wardrobe outfit files are filtered to
 * the ones that actually exist.
 */
function entryForPetDir(petDir, id) {
    try {
        const manifestRaw = JSON.parse(readFileSync(join(petDir, "pet.json"), "utf8"));
        const parsed = parsePetManifest(manifestRaw);
        if ("error" in parsed)
            return undefined;
        const manifest = manifestRaw;
        const relative = typeof manifest.spritesheetPath === "string" ? manifest.spritesheetPath : "spritesheet.webp";
        const spritesheetPath = join(petDir, relative);
        if (!existsSync(spritesheetPath))
            return undefined;
        const wardrobe = wardrobesAtPath(petDir, manifest);
        return { ...parsed.entry, spritesheetPath, builtIn: false, ...(wardrobe ? { wardrobe } : {}) };
    }
    catch {
        // A malformed pet package is skipped, matching the host's "skip broken pet" behavior.
        return undefined;
    }
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
        const entry = entryForPetDir(join(root, id), id);
        if (entry !== undefined)
            entries.push(entry);
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
        // `cp(src, dest)` nests `src` inside an existing `dest`; clear it first so
        // the package always lands directly in pets/<id>/ (pet.json at the top).
        await rm(destination, { recursive: true, force: true });
        await cp(sourceDir, destination, { recursive: true });
        // Re-validate at the destination: the scanner only reads one level, so a
        // nested copy would silently look like "nothing was imported".
        if (!existsSync(join(destination, "pet.json"))) {
            await rm(destination, { recursive: true, force: true });
            return { ok: false, message: `导入后未找到 pet.json（目标目录: ${destination}）` };
        }
        const installed = entryForPetDir(destination, parsed.entry.id);
        const outfits = installed?.wardrobe?.outfits.length ?? 0;
        const suffix = outfits > 0 ? `（含 ${outfits} 套皮肤）` : "";
        return { ok: true, message: `已导入 ${parsed.entry.displayName}${suffix}`, id: parsed.entry.id };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
export function readManagedState(userDataPath) {
    try {
        const raw = JSON.parse(readFileSync(join(userDataPath, "state.json"), "utf8"));
        const prefsRecord = typeof raw.petWardrobePreferences === "object" && raw.petWardrobePreferences !== null
            ? raw.petWardrobePreferences
            : undefined;
        const petWardrobePreferences = prefsRecord === undefined
            ? undefined
            : normalizeWardrobePreferences(prefsRecord);
        return {
            defaultPetId: typeof raw.defaultPetId === "string" ? raw.defaultPetId : builtInPetEntry.id,
            ...(petWardrobePreferences !== undefined ? { petWardrobePreferences } : {}),
        };
    }
    catch {
        return { defaultPetId: builtInPetEntry.id };
    }
}
/** Drop malformed preference blobs; ids unknown to a pet are ignored later at resolve time. */
function normalizeWardrobePreferences(record) {
    const out = {};
    for (const [petId, value] of Object.entries(record)) {
        if (!petIdPattern.test(petId))
            continue;
        const blob = typeof value === "object" && value !== null ? value : undefined;
        if (blob === undefined)
            continue;
        const outfit = typeof blob.outfit === "string" && blob.outfit.length > 0 ? blob.outfit : undefined;
        const schedule = Array.isArray(blob.schedule) && blob.schedule.length > 0 ? blob.schedule : undefined;
        if (outfit === undefined && schedule === undefined)
            continue;
        out[petId] = {
            ...(outfit !== undefined ? { outfit } : {}),
            ...(schedule !== undefined ? { schedule } : {}),
        };
    }
    return out;
}
export async function writeManagedState(userDataPath, state) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(userDataPath, { recursive: true });
    await writeFile(join(userDataPath, "state.json"), JSON.stringify(state, null, 2), "utf8");
}
/**
 * Apply one pet's wardrobe preference patch and persist it. `outfit: null`
 * removes the fixed choice (auto); `schedule: null` removes the user schedule
 * (creator rules apply again). Changes are merged into existing prefs.
 */
export async function updatePetWardrobePreference(userDataPath, petId, patch) {
    const state = readManagedState(userDataPath);
    const prefs = { ...(state.petWardrobePreferences ?? {}) };
    const current = { ...prefs[petId] };
    if (patch.outfit !== undefined) {
        if (patch.outfit === null || patch.outfit.length === 0)
            delete current.outfit;
        else
            current.outfit = patch.outfit;
    }
    if (patch.schedule !== undefined) {
        if (patch.schedule === null || patch.schedule.length === 0)
            delete current.schedule;
        else
            current.schedule = patch.schedule;
    }
    if (current.outfit === undefined && current.schedule === undefined)
        delete prefs[petId];
    else
        prefs[petId] = current;
    const next = {
        defaultPetId: state.defaultPetId,
        ...(Object.keys(prefs).length > 0 ? { petWardrobePreferences: prefs } : {}),
    };
    await writeManagedState(userDataPath, next);
    return next;
}
export function wardrobePreferenceFor(state, petId) {
    const pref = state.petWardrobePreferences?.[petId];
    if (pref === undefined)
        return undefined;
    return { ...(pref.outfit !== undefined ? { outfit: pref.outfit } : {}), ...(pref.schedule !== undefined ? { schedule: pref.schedule } : {}) };
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
