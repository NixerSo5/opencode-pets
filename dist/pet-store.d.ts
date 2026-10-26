/**
 * pet-store.ts
 *
 * Installed-pet storage for the standalone app: scans userData/pets/{id}/
 * packages (pet.json + spritesheet), validates them per the extracted pet
 * contract, supports importing a local folder, and persists the default pet
 * choice in state.json.
 */
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
}
export interface ManagedPetState {
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
/** Resolve the pet to render: the stored default or the built-in fallback. */
export declare function resolveDefaultPet(userDataPath: string): Promise<PetStoreEntry>;
