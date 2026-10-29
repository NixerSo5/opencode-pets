/**
 * pet-store.ts
 *
 * Installed-pet storage for the standalone app: scans userData/pets/{id}/
 * packages (pet.json + spritesheet), validates them per the extracted pet
 * contract, supports importing a local folder, and persists the default pet
 * choice in state.json.
 */
import { type Wardrobe, type WardrobePreferences, type WardrobeRule } from "./pet-wardrobe-core.js";
export declare const builtInPetEntry: {
    readonly id: "builtin";
    readonly displayName: "Hoodie Cat";
    readonly description: "Bundled default pet, always available.";
    readonly spriteVersionNumber: 2;
};
export interface PetStoreEntry {
    readonly id: string;
    readonly displayName: string;
    readonly description?: string;
    /** 1 = legacy 8×9 atlas, 2 = 8×11 atlas (0-8 rows carry the reaction states in both). */
    readonly spriteVersionNumber: 1 | 2;
    readonly spritesheetPath: string;
    readonly builtIn: boolean;
    /** Present when the package declares (and ships) usable outfits. */
    readonly wardrobe?: Wardrobe;
}
export interface PetWardrobePreference {
    /** Fixed outfit id, `default`, or unset (auto). */
    readonly outfit?: string;
    /** The user's edited schedule; replacing the creator schedule when set. */
    readonly schedule?: WardrobeRule[];
}
export interface WardrobePreferencesMap {
    readonly petWardrobePreferences?: {
        readonly [petId: string]: PetWardrobePreference;
    };
}
export interface ManagedPetState extends WardrobePreferencesMap {
    readonly defaultPetId: string;
}
export declare function petsRoot(userDataPath: string): string;
/** Validate a pet.json-shaped record; returns a normalized entry or an error. */
export declare function parsePetManifest(raw: unknown): {
    entry: Omit<PetStoreEntry, "spritesheetPath" | "builtIn">;
} | {
    error: string;
};
export declare function listInstalledPets(userDataPath: string): Promise<PetStoreEntry[]>;
export interface ImportFolderResult {
    readonly ok: boolean;
    readonly message: string;
    readonly id?: string;
}
/** Import a pet package folder into userData/pets/{id}/. */
export declare function importPetFolder(userDataPath: string, sourceDir: string): Promise<ImportFolderResult>;
export declare function readManagedState(userDataPath: string): ManagedPetState;
export declare function writeManagedState(userDataPath: string, state: ManagedPetState): Promise<void>;
/**
 * Apply one pet's wardrobe preference patch and persist it. `outfit: null`
 * removes the fixed choice (auto); `schedule: null` removes the user schedule
 * (creator rules apply again). Changes are merged into existing prefs.
 */
export declare function updatePetWardrobePreference(userDataPath: string, petId: string, patch: {
    outfit?: string | null;
    schedule?: WardrobeRule[] | null;
}): Promise<ManagedPetState>;
export declare function wardrobePreferenceFor(state: ManagedPetState, petId: string): WardrobePreferences | undefined;
/** Resolve the pet to render: the stored default or the built-in fallback. */
export declare function resolveDefaultPet(userDataPath: string): Promise<PetStoreEntry>;
