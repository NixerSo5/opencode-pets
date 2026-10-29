/**
 * catalog-client.ts
 *
 * Marketplace (商城) client for the Pets tab, mirroring the original
 * catalog v3 contract: index → filtered pages (pageSize 100) → flat search
 * list, with category / original / featured filters.
 */
export interface CatalogPetEntry {
    readonly id: string;
    readonly displayName: string;
    readonly description?: string;
    readonly thumbnail?: string;
    readonly spritesheet?: string;
    readonly zip?: string;
    readonly category?: string;
    readonly subcategory?: string;
    readonly featured?: boolean;
    readonly original?: boolean;
    readonly spriteVersionNumber?: 1 | 2;
    /** Search-index-only field: which full catalog page holds the complete entry. */
    readonly catalogPage?: number;
    /** Full package (pet.json + outfits/); preferred over `zip` when present. */
    readonly wardrobeZip?: string;
    /** Package needs an app at least this new (e.g. "4.1.0"). */
    readonly minOpenPetsVersion?: string;
}
export interface CatalogFilters {
    readonly categories: readonly {
        readonly id: string;
        readonly label: string;
        readonly count: number;
    }[];
    readonly originalsCount?: number;
    readonly featuredCount?: number;
}
export interface CatalogPageResult {
    readonly page: number;
    readonly pageCount: number;
    readonly total: number;
    readonly pets: readonly CatalogPetEntry[];
    readonly filters: CatalogFilters;
}
interface CatalogIndex {
    readonly pageUrls: readonly string[];
    readonly searchUrl?: string;
    readonly total: number;
    readonly filters: CatalogFilters;
}
export declare const emptyCatalogFilters: CatalogFilters;
declare function getCatalogIndex(): Promise<CatalogIndex>;
/** One marketplace page (100 pets, unfiltered). Out-of-range pages throw. */
export declare function getCatalogPage(page: number): Promise<CatalogPageResult>;
/** The whole marketplace as one flat list, following the paged search index. */
export declare function getCatalogAllPets(): Promise<readonly CatalogPetEntry[]>;
export { getCatalogIndex };
