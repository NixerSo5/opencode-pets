/**
 * mirror-shop.mjs
 *
 * Mirrors a curated slice of the OpenPets marketplace (openpets.dev/pets) into
 * Gitee repos so the desktop app stops depending on the upstream host.
 *
 * Layout it produces
 *   catalog repo   pets/catalog.v3.json, pets/catalog.v3/page-NNN.json,
 *                  pets/catalog.v3/search.json, search-page-NNN.json,
 *                  pets/<slug>/thumb.webp
 *   shard repos    pets/<slug>/<archive>.zip
 *
 * Usage
 *   node scripts/mirror-shop.mjs build  <repoDir> [--selection featured] [--raw <base>]
 *   node scripts/mirror-shop.mjs zips   <shardRoot> [--budget 380]
 *   node scripts/mirror-shop.mjs rewrite <repoDir> --shards <shardRoot> [--shardRaw <tpl>]
 *
 * `--selection` is one of `featured` (default), `original`, `all`.
 * `--raw` is the Gitee raw base the catalog's URLs should point at.
 * `--shardRaw` uses `{n}` for the shard number.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const UPSTREAM_INDEX = "https://openpets.dev/pets/catalog.v3.json";
const PAGE_SIZE = 100;
const CONCURRENCY = 12;

const mode = process.argv[2];
const args = process.argv.slice(3);
const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

async function getJson(url) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 4) throw new Error(`${url}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }
  throw new Error("unreachable");
}

async function exists(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function writeText(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function download(url, path) {
  if (await exists(path)) return 0;
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  return buffer.length;
}

async function pool(items, limit, worker) {
  let cursor = 0;
  let done = 0;
  const total = items.length;
  const run = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
      done += 1;
      if (done % 40 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  if (total > 0) process.stdout.write("\n");
}

/** `/pets/<slug>/<file>` -> slug. */
function slugOf(url) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const anth = parts.indexOf("pets");
  return parts[anth >= 0 ? anth + 1 : 0];
}

function fileNameOf(url) {
  return new URL(url).pathname.split("/").filter(Boolean).pop();
}

async function loadUpstream() {
  const index = await getJson(UPSTREAM_INDEX);
  const pets = [];
  for (const url of index.pages) {
    const page = await getJson(url);
    for (const pet of page.pets ?? []) pets.push(pet);
  }
  const seen = new Set();
  return pets.filter((pet) => {
    if (typeof pet.id !== "string" || seen.has(pet.id)) return false;
    seen.add(pet.id);
    return true;
  });
}

function select(pets, selection) {
  if (selection === "all") return pets;
  if (selection === "original") return pets.filter((pet) => pet.original === true);
  return pets.filter((pet) => pet.featured === true);
}

function countBy(list, key) {
  const counts = new Map();
  for (const item of list) {
    const value = item[key];
    if (typeof value !== "string" || value.length === 0) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

const categoryLabels = { western: "Western", asian: "Asian" };

async function build(repoDir) {
  const selection = flag("selection", "featured");
  const rawBase = flag("raw", "https://gitee.com/nixer/pets-shop-copy/raw/master").replace(/\/$/, "");
  const all = await loadUpstream();
  const pets = select(all, selection);
  console.log(`[build] selection=${selection}: ${pets.length}/${all.length} pets -> ${repoDir}`);

  // Thumbnails first: the catalog entries below point at these copies.
  const thumbs = pets.filter((pet) => typeof pet.thumbnail === "string");
  console.log(`[build] thumbnails: ${thumbs.length}`);
  await pool(thumbs, CONCURRENCY, async (pet) => {
    await download(pet.thumbnail, join(repoDir, "pets", slugOf(pet.thumbnail), "thumb.webp"));
  });

  const categoryCounts = countBy(pets, "category");
  const pages = [];
  for (let start = 0; start < pets.length; start += PAGE_SIZE) pages.push(pets.slice(start, start + PAGE_SIZE));

  const entryForPage = (pet, pageIndex) => {
    const slug = typeof pet.thumbnail === "string" ? slugOf(pet.thumbnail) : pet.id;
    const entry = {
      id: pet.id,
      displayName: pet.displayName,
      ...(pet.description ? { description: pet.description } : {}),
      ...(typeof pet.thumbnail === "string" ? { thumbnail: `${rawBase}/pets/${slug}/thumb.webp` } : {}),
      // `zip` stays on the upstream host until the `rewrite` stage repoints it
      // at a shard repo; `spritesheet` is dropped because the app never reads
      // it (the ZIP already ships one).
      ...(typeof pet.zip === "string" ? { zip: pet.zip } : {}),
      ...(pet.category ? { category: pet.category } : {}),
      ...(pet.subcategory ? { subcategory: pet.subcategory } : {}),
      ...(pet.featured === true ? { featured: true } : {}),
      ...(pet.original === true ? { original: true } : {}),
      ...(pet.spriteVersionNumber === 1 || pet.spriteVersionNumber === 2 ? { spriteVersionNumber: pet.spriteVersionNumber } : {}),
      ...(typeof pet.wardrobeZip === "string" ? { wardrobeZip: pet.wardrobeZip } : {}),
      ...(typeof pet.minOpenPetsVersion === "string" ? { minOpenPetsVersion: pet.minOpenPetsVersion } : {}),
      catalogPage: pageIndex,
    };
    return entry;
  };

  const pageDocs = pages.map((slice, pageIndex) => ({
    version: 3,
    page: pageIndex,
    pageSize: PAGE_SIZE,
    pets: slice.map((pet) => entryForPage(pet, pageIndex)),
  }));

  const searchEntries = pageDocs.flatMap((doc) => doc.pets.map((entry) => {
    const { zip, wardrobeZip, ...slim } = entry;
    return slim;
  }));
  const searchPages = [];
  for (let start = 0; start < searchEntries.length; start += PAGE_SIZE) searchPages.push(searchEntries.slice(start, start + PAGE_SIZE));

  const generatedAt = new Date().toISOString();
  const index = {
    version: 3,
    generatedAt,
    total: pets.length,
    pageSize: PAGE_SIZE,
    search: `${rawBase}/pets/catalog.v3/search.json`,
    filters: {
      categories: [...categoryCounts.entries()].map(([id, count]) => ({ id, label: categoryLabels[id] ?? id, count })),
      originalsCount: pets.filter((pet) => pet.original === true).length,
      featuredCount: pets.filter((pet) => pet.featured === true).length,
    },
    pages: pageDocs.map((_, pageIndex) => `${rawBase}/pets/catalog.v3/page-${String(pageIndex).padStart(3, "0")}.json`),
  };

  await writeText(join(repoDir, "pets", "catalog.v3.json"), JSON.stringify(index, null, 2) + "\n");
  for (let pageIndex = 0; pageIndex < pageDocs.length; pageIndex += 1) {
    const name = `page-${String(pageIndex).padStart(3, "0")}.json`;
    await writeText(join(repoDir, "pets", "catalog.v3", name), JSON.stringify(pageDocs[pageIndex], null, 2) + "\n");
  }
  await writeText(join(repoDir, "pets", "catalog.v3", "search.json"), JSON.stringify({
    version: 3,
    pages: searchPages.map((_, pageIndex) => `${rawBase}/pets/catalog.v3/search-page-${String(pageIndex).padStart(3, "0")}.json`),
  }, null, 2) + "\n");
  for (let pageIndex = 0; pageIndex < searchPages.length; pageIndex += 1) {
    const name = `search-page-${String(pageIndex).padStart(3, "0")}.json`;
    await writeText(join(repoDir, "pets", "catalog.v3", name), JSON.stringify({
      version: 3,
      page: pageIndex,
      pageSize: PAGE_SIZE,
      pets: searchPages[pageIndex],
    }, null, 2) + "\n");
  }

  await writeText(join(repoDir, "README.md"), [
    "# OpenPets shop mirror",
    "",
    `Curated mirror of the OpenPets marketplace (\`${selection}\` pets) so the`,
    "desktop app does not have to reach openpets.dev.",
    "",
    "- `pets/catalog.v3.json` - v3 index",
    "- `pets/catalog.v3/page-NNN.json` - 100 pets per page",
    "- `pets/catalog.v3/search.json` + `search-page-NNN.json` - search index",
    "- `pets/<slug>/thumb.webp` - preview thumbnail",
    "",
    `Raw base: ${rawBase}`,
    "",
    "Generated by `scripts/mirror-shop.mjs` in the OpenPets desktop repo.",
    "",
  ].join("\n"));

  console.log(`[build] ${pets.length} pets, ${pageDocs.length} pages, ${searchPages.length} search pages`);
  console.log(`[build] done`);
}

async function zips(shardRoot) {
  const selection = flag("selection", "featured");
  const budget = Number(flag("budget", "380")) * 1024 * 1024;
  const all = await loadUpstream();
  const pets = select(all, selection);
  const archives = [];
  for (const pet of pets) {
    for (const key of ["zip", "wardrobeZip"]) {
      const url = pet[key];
      if (typeof url !== "string") continue;
      archives.push({ slug: slugOf(url), name: fileNameOf(url), url });
    }
  }
  console.log(`[zips] ${archives.length} archives, budget ${Math.round(budget / 1024 / 1024)} MiB/shard`);

  const usage = new Map();
  const files = {};
  let bytes = 0;
  await pool(archives, CONCURRENCY, async (archive) => {
    // Pick the first shard that still has room; size is only known after the
    // download, so the archive is fetched once into a staging path first.
    const staging = join(shardRoot, ".staging", archive.slug, archive.name);
    const size = await download(archive.url, staging);
    const actual = size > 0 ? size : (await stat(staging)).size;
    let shard = 0;
    while ((usage.get(shard) ?? 0) + actual > budget) shard += 1;
    usage.set(shard, (usage.get(shard) ?? 0) + actual);
    const dest = join(shardRoot, `shard-${shard}`, "pets", archive.slug, archive.name);
    await mkdir(dirname(dest), { recursive: true });
    const { rename } = await import("node:fs/promises");
    await rename(staging, dest).catch(async () => {
      // Already moved by a previous run: fall back to copying.
      const { copyFile } = await import("node:fs/promises");
      await copyFile(staging, dest);
      await rm(staging, { force: true });
    });
    files[`${archive.slug}/${archive.name}`] = shard;
    bytes += actual;
  });
  await rm(join(shardRoot, ".staging"), { recursive: true, force: true });

  const shardCount = Math.max(0, ...[...usage.keys()].map((key) => key + 1));
  await writeText(join(shardRoot, "map.json"), JSON.stringify({
    selection,
    shards: shardCount,
    budget,
    totalBytes: bytes,
    perShard: [...usage.entries()].sort((a, b) => a[0] - b[0]).map(([shard, used]) => ({ shard, used })),
    files,
  }, null, 2) + "\n");
  console.log(`[zips] done: ${(bytes / 1024 / 1024).toFixed(1)} MiB across ${shardCount} shards`);
}

async function rewrite(repoDir) {
  const shardRoot = flag("shards", "");
  if (!shardRoot) throw new Error("rewrite needs --shards <dir>");
  const shardRaw = flag("shardRaw", "https://gitee.com/nixer/pets-shop-copy-{n}/raw/master").replace(/\/$/, "");
  const map = JSON.parse(await readFile(join(shardRoot, "map.json"), "utf8"));
  const files = map.files ?? {};
  const rewriteUrl = (url) => {
    const shard = files[`${slugOf(url)}/${fileNameOf(url)}`];
    if (shard === undefined) return url;
    return `${shardRaw.replace("{n}", String(shard))}/pets/${slugOf(url)}/${fileNameOf(url)}`;
  };
  const patch = (doc) => {
    for (const pet of doc.pets ?? []) {
      if (typeof pet.zip === "string") pet.zip = rewriteUrl(pet.zip);
      if (typeof pet.wardrobeZip === "string") pet.wardrobeZip = rewriteUrl(pet.wardrobeZip);
    }
    return doc;
  };

  const index = JSON.parse(await readFile(join(repoDir, "pets", "catalog.v3.json"), "utf8"));
  for (const pageUrl of index.pages) {
    const name = fileNameOf(pageUrl);
    const path = join(repoDir, "pets", "catalog.v3", name);
    await writeText(path, JSON.stringify(patch(JSON.parse(await readFile(path, "utf8"))), null, 2) + "\n");
  }
  console.log(`[rewrite] shardRaw=${shardRaw}, ${Object.keys(files).length} archives mapped`);
  console.log("[rewrite] done");
}

if (mode === "build") {
  await build(positional[0]);
} else if (mode === "zips") {
  await zips(positional[0]);
} else if (mode === "rewrite") {
  await rewrite(positional[0]);
} else {
  console.error("usage: node scripts/mirror-shop.mjs <build|zips|rewrite> <dir> [--flags]");
  process.exit(2);
}
