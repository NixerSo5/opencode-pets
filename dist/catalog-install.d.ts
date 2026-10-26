/**
 * catalog-install.ts
 *
 * Marketplace pet installation: download the ZIP (magic-byte validated, size
 * capped), extract it safely (no traversal / non-file entries / oversized
 * content) into a staging dir, validate pet.json + spritesheet, then promote
 * it into userData/pets/{id}/. Mirrors the original shared ZIP safety rules.
 */
export interface CatalogInstallResult {
    readonly ok: boolean;
    readonly message: string;
    readonly id?: string;
}
/** Install a marketplace pet by id; fetches the entry, downloads, extracts, validates, promotes. */
export declare function installCatalogPet(userDataPath: string, petId: string): Promise<CatalogInstallResult>;
