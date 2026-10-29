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
  readonly categories: readonly { readonly id: string; readonly label: string; readonly count: number }[];
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

const catalogV3Url = "https://openpets.dev/pets/catalog.v3.json";

interface CatalogIndex {
  readonly pageUrls: readonly string[];
  readonly searchUrl?: string;
  readonly total: number;
  readonly filters: CatalogFilters;
}

export const emptyCatalogFilters: CatalogFilters = { categories: [] };

let indexCache: Promise<CatalogIndex> | undefined;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json() as unknown;
}

async function getCatalogIndex(): Promise<CatalogIndex> {
  indexCache ??= (async () => {
    const raw = await fetchJson(catalogV3Url) as Record<string, unknown>;
    const pageUrls = Array.isArray(raw.pages) ? (raw.pages as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
    if (pageUrls.length === 0) throw new Error("catalog index has no pages");
    const filtersRaw = (typeof raw.filters === "object" && raw.filters !== null ? raw.filters : {}) as Record<string, unknown>;
    const categories = Array.isArray(filtersRaw.categories)
      ? (filtersRaw.categories as Array<Record<string, unknown>>)
        .filter((entry) => typeof entry.id === "string" && typeof entry.label === "string")
        .map((entry) => ({ id: entry.id as string, label: entry.label as string, count: typeof entry.count === "number" ? entry.count : 0 }))
      : [];
    return {
      pageUrls,
      searchUrl: typeof raw.search === "string" ? raw.search : undefined,
      total: typeof raw.total === "number" ? raw.total : 0,
      filters: { categories, originalsCount: typeof filtersRaw.originalsCount === "number" ? filtersRaw.originalsCount : undefined, featuredCount: typeof filtersRaw.featuredCount === "number" ? filtersRaw.featuredCount : undefined },
    };
  })();
  indexCache.catch(() => {
    // A failed index load must not poison future retries.
    indexCache = undefined;
  });
  return indexCache;
}

function parseCatalogEntry(raw: unknown): CatalogPetEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const displayName = typeof record.displayName === "string" ? record.displayName : "";
  if (!id || !displayName) return undefined;
  return {
    id,
    displayName,
    description: typeof record.description === "string" ? record.description : undefined,
    thumbnail: typeof record.thumbnail === "string" ? record.thumbnail : undefined,
    spritesheet: typeof record.spritesheet === "string" ? record.spritesheet : undefined,
    zip: typeof record.zip === "string" ? record.zip : undefined,
    category: typeof record.category === "string" ? record.category : undefined,
    subcategory: typeof record.subcategory === "string" ? record.subcategory : undefined,
    featured: record.featured === true,
    original: record.original === true,
    spriteVersionNumber: record.spriteVersionNumber === 2 ? 2 : record.spriteVersionNumber === 1 ? 1 : undefined,
    catalogPage: typeof record.catalogPage === "number" ? record.catalogPage : undefined,
    wardrobeZip: typeof record.wardrobeZip === "string" ? record.wardrobeZip : undefined,
    minOpenPetsVersion: typeof record.minOpenPetsVersion === "string" ? record.minOpenPetsVersion : undefined,
  };
}

/** One marketplace page (100 pets, unfiltered). Out-of-range pages throw. */
export async function getCatalogPage(page: number): Promise<CatalogPageResult> {
  const index = await getCatalogIndex();
  if (!Number.isInteger(page) || page < 0 || page >= index.pageUrls.length) throw new Error("Catalog page is out of range.");
  const raw = await fetchJson(index.pageUrls[page]) as Record<string, unknown>;
  const pets = Array.isArray(raw.pets)
    ? (raw.pets as unknown[]).map(parseCatalogEntry).filter((entry): entry is CatalogPetEntry => entry !== undefined)
    : [];
  return {
    page: typeof raw.page === "number" ? raw.page : page,
    pageCount: index.pageUrls.length,
    total: index.total,
    pets,
    filters: index.filters,
  };
}

/** The whole marketplace as one flat list, following the paged search index. */
export async function getCatalogAllPets(): Promise<readonly CatalogPetEntry[]> {
  const index = await getCatalogIndex();
  if (!index.searchUrl) throw new Error("catalog index has no search list");
  const searchIndex = await fetchJson(index.searchUrl) as Record<string, unknown>;
  const pageUrls = Array.isArray(searchIndex.pages) ? (searchIndex.pages as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
  if (pageUrls.length === 0) throw new Error("search index has no pages");
  const all: CatalogPetEntry[] = [];
  for (const url of pageUrls) {
    const page = await fetchJson(url) as Record<string, unknown>;
    const pets = Array.isArray(page.pets) ? page.pets as unknown[] : [];
    for (const candidate of pets) {
      const entry = parseCatalogEntry(candidate);
      if (entry) all.push(entry);
    }
  }
  return all;
}

export { getCatalogIndex };
