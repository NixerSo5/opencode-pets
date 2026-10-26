/**
 * catalog-client.ts
 *
 * Marketplace (商城) client for the Pets tab, mirroring the original
 * catalog v3 contract: index → filtered pages (pageSize 100) → flat search
 * list, with category / original / featured filters.
 */
const catalogV3Url = "https://openpets.dev/pets/catalog.v3.json";
export const emptyCatalogFilters = { categories: [] };
let indexCache;
async function fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok)
        throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
}
async function getCatalogIndex() {
    indexCache ??= (async () => {
        const raw = await fetchJson(catalogV3Url);
        const pageUrls = Array.isArray(raw.pages) ? raw.pages.filter((entry) => typeof entry === "string") : [];
        if (pageUrls.length === 0)
            throw new Error("catalog index has no pages");
        const filtersRaw = (typeof raw.filters === "object" && raw.filters !== null ? raw.filters : {});
        const categories = Array.isArray(filtersRaw.categories)
            ? filtersRaw.categories
                .filter((entry) => typeof entry.id === "string" && typeof entry.label === "string")
                .map((entry) => ({ id: entry.id, label: entry.label, count: typeof entry.count === "number" ? entry.count : 0 }))
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
function parseCatalogEntry(raw) {
    if (typeof raw !== "object" || raw === null)
        return undefined;
    const record = raw;
    const id = typeof record.id === "string" ? record.id : "";
    const displayName = typeof record.displayName === "string" ? record.displayName : "";
    if (!id || !displayName)
        return undefined;
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
    };
}
/** One marketplace page (100 pets, unfiltered). Out-of-range pages throw. */
export async function getCatalogPage(page) {
    const index = await getCatalogIndex();
    if (!Number.isInteger(page) || page < 0 || page >= index.pageUrls.length)
        throw new Error("Catalog page is out of range.");
    const raw = await fetchJson(index.pageUrls[page]);
    const pets = Array.isArray(raw.pets)
        ? raw.pets.map(parseCatalogEntry).filter((entry) => entry !== undefined)
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
export async function getCatalogAllPets() {
    const index = await getCatalogIndex();
    if (!index.searchUrl)
        throw new Error("catalog index has no search list");
    const searchIndex = await fetchJson(index.searchUrl);
    const pageUrls = Array.isArray(searchIndex.pages) ? searchIndex.pages.filter((entry) => typeof entry === "string") : [];
    if (pageUrls.length === 0)
        throw new Error("search index has no pages");
    const all = [];
    for (const url of pageUrls) {
        const page = await fetchJson(url);
        const pets = Array.isArray(page.pets) ? page.pets : [];
        for (const candidate of pets) {
            const entry = parseCatalogEntry(candidate);
            if (entry)
                all.push(entry);
        }
    }
    return all;
}
export { getCatalogIndex };
