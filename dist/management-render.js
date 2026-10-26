/**
 * management-render.ts
 *
 * The Pets management tab (管理端 → 宠物), ported from the Control Center
 * renderer with the other tabs removed: two sub-tabs — 本机 (installed grid)
 * and 商城 (marketplace grid with category filters, search, pagination, and
 * one-click install).
 */
import { pathToFileURL } from "node:url";
import { builtInPetEntry } from "./pet-store.js";
export function buildPetListItems(installed, defaultPetId, builtInSpritesheetUrl) {
    const items = [
        {
            id: builtInPetEntry.id,
            displayName: builtInPetEntry.displayName,
            description: builtInPetEntry.description,
            spriteVersionNumber: builtInPetEntry.spriteVersionNumber,
            spritesheetFileUrl: builtInSpritesheetUrl,
            builtIn: true,
            isDefault: defaultPetId === builtInPetEntry.id,
        },
    ];
    for (const entry of installed) {
        items.push({
            id: entry.id,
            displayName: entry.displayName,
            description: entry.description,
            spriteVersionNumber: entry.spriteVersionNumber,
            spritesheetFileUrl: pathToFileURL(entry.spritesheetPath).toString(),
            builtIn: false,
            isDefault: entry.id === defaultPetId,
        });
    }
    return items;
}
/** Full management-page HTML: 本机 tab + 商城 tab. */
export function createManagementHtml(options) {
    const localCards = options.items
        .map((item) => {
        const preview = item.spritesheetFileUrl
            ? `<div class="thumb sprite" style="background-image:url('${item.spritesheetFileUrl}');background-position:0 0;background-size:${Math.round(192 * THUMB_FACTOR * 8)}px auto"></div>`
            : `<div class="thumb missing">无预览</div>`;
        const actions = item.isDefault
            ? `<span class="pill current">当前默认</span>`
            : `<button type="button" data-select="${item.id}">设为默认</button>`;
        return `<article class="card">
        ${preview}
        <h3>${escapeHtml(item.displayName)}</h3>
        <p>${item.description ? escapeHtml(item.description) : "本机宠物包"}</p>
        <div class="actions">${actions}</div>
      </article>`;
    })
        .join("\n");
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${options.title ?? "宠物"}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b1220; color: #e2e8f0; font-family: "Segoe UI", system-ui, sans-serif; }
  header { padding: 16px 22px 0; display: flex; align-items: baseline; gap: 14px; }
  h1 { font-size: 17px; margin: 0; }
  header span { color: #64748b; font-size: 12px; }
  nav.tabs { display: flex; gap: 6px; padding: 12px 22px 0; }
  nav.tabs button { padding: 7px 16px; border-radius: 9px 9px 0 0; border: 1px solid transparent; border-bottom: none; background: transparent; color: #94a3b8; font-size: 13px; cursor: pointer; }
  nav.tabs button.active { background: rgba(148, 163, 184, 0.1); border-color: rgba(148, 163, 184, 0.18); color: #e2e8f0; }
  section.hidden { display: none; }
  .localwrap, .shopwrap { margin: 0; }
  .filterrow { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 12px 22px 4px; }
  .filterrow input { padding: 7px 12px; border-radius: 9px; border: 1px solid rgba(148, 163, 184, 0.25); background: rgba(15, 23, 42, 0.7); color: #e2e8f0; font-size: 13px; width: 220px; }
  .chip { padding: 5px 12px; border-radius: 999px; border: 1px solid rgba(148, 163, 184, 0.25); background: transparent; color: #94a3b8; font-size: 12px; cursor: pointer; }
  .chip.active { background: rgba(37, 99, 235, 0.18); border-color: rgba(37, 99, 235, 0.5); color: #93c5fd; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 14px; padding: 14px 22px 20px; }
  .card { background: rgba(148, 163, 184, 0.07); border: 1px solid rgba(148, 163, 184, 0.14); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 6px; }
  .thumb { width: 112px; height: 122px; border-radius: 10px; background: rgba(15, 23, 42, 0.6) center/112px auto no-repeat; margin-bottom: 6px; }
  .thumb.sprite { background-position: 0 0; }
  .thumb.missing { display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 13px; }
  h3 { margin: 0; font-size: 14px; font-weight: 600; }
  p { margin: 0; color: #94a3b8; font-size: 12px; line-height: 1.45; flex: 1; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .actions { margin-top: 8px; display: flex; gap: 6px; }
  button { padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(37, 99, 235, 0.5); background: rgba(37, 99, 235, 0.14); color: #93c5fd; font-size: 12px; cursor: pointer; }
  button:hover { background: rgba(37, 99, 235, 0.28); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary { border-color: rgba(148, 163, 184, 0.3); background: rgba(148, 163, 184, 0.1); color: #e2e8f0; }
  .pill { display: inline-block; padding: 5px 11px; border-radius: 999px; background: rgba(16, 185, 129, 0.15); color: #6ee7b7; font-size: 12px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(148, 163, 184, 0.12); color: #94a3b8; font-size: 10px; }
  .pager { display: flex; align-items: center; gap: 12px; padding: 4px 22px 18px; }
  .pager span { color: #64748b; font-size: 12px; }
  footer { padding: 6px 22px 18px; display: flex; gap: 10px; }
  .importbtn { padding: 8px 14px; border-radius: 9px; border: 1px solid rgba(148, 163, 184, 0.3); background: rgba(148, 163, 184, 0.1); color: #e2e8f0; font-size: 13px; cursor: pointer; }
  .importbtn:hover { background: rgba(148, 163, 184, 0.18); }
  #status { color: #94a3b8; font-size: 12px; align-self: center; min-height: 15px; }
  #shopStatus { color: #94a3b8; font-size: 12px; }
</style>
</head>
<body>
  <header><h1>宠物</h1><span>本机宠物包 &amp; 官方商城</span></header>
  <nav class="tabs">
    <button type="button" id="tab-local" class="active">本机</button>
    <button type="button" id="tab-shop">商城</button>
  </nav>

  <section id="local" class="localwrap">
    <div class="grid" id="grid">
      ${localCards}
    </div>
    <footer>
      <button type="button" class="importbtn" id="import">从文件夹导入宠物包…</button>
      <span id="status"></span>
    </footer>
  </section>

  <section id="shop" class="shopwrap hidden">
    <div class="filterrow">
      <input type="search" id="search" placeholder="搜索宠物…" />
      <div id="chips"></div>
      <span id="shopStatus"></span>
    </div>
    <div class="grid" id="shopGrid"></div>
    <div class="pager">
      <button type="button" class="secondary" id="prev">上一页</button>
      <span id="pagerLabel"></span>
      <button type="button" class="secondary" id="next">下一页</button>
    </div>
  </section>

<script>
  const TABS = { local: document.getElementById("local"), shop: document.getElementById("shop") };
  const tabLocal = document.getElementById("tab-local");
  const tabShop = document.getElementById("tab-shop");
  const status = document.getElementById("status");
  const shopStatus = document.getElementById("shopStatus");
  function showStatus(text) {
    status.textContent = text;
    shopStatus.textContent = text;
  }
  const shopGrid = document.getElementById("shopGrid");
  const chips = document.getElementById("chips");
  const searchInput = document.getElementById("search");
  const pagerLabel = document.getElementById("pagerLabel");
  const prevButton = document.getElementById("prev");
  const nextButton = document.getElementById("next");
  tabLocal.addEventListener("click", () => switchTab("local"));
  tabShop.addEventListener("click", () => switchTab("shop"));

  let page = 0;
  let pageCount = 1;
  let total = 0;
  let category = "all";
  let shopLoaded = false;
  let loading = false;

  function switchTab(tab) {
    tabLocal.classList.toggle("active", tab === "local");
    tabShop.classList.toggle("active", tab === "shop");
    TABS.local.classList.toggle("hidden", tab !== "local");
    TABS.shop.classList.toggle("hidden", tab !== "shop");
    showStatus("");
    if (tab === "shop" && !shopLoaded) void loadShop();
  }

  function chipFilter(entry) {
    if (category === "all") return true;
    if (category === "original") return entry.original === true;
    if (category === "featured") return entry.featured === true;
    if (category === "western" || category === "asian") return entry.category === category;
    return true;
  }

  async function loadShop() {
    if (loading) return;
    loading = true;
    showStatus("加载商城…");
    try {
      const query = searchInput.value.trim();
      let pets;
      if (query) {
        const search = await window.petsManager.catalogSearch();
        pagerLabel.textContent = "搜索结果 · 全商城";
        prevButton.disabled = true;
        nextButton.disabled = true;
        pets = search.pets ?? [];
      } else {
        const result = await window.petsManager.catalogPage(page);
        pageCount = result.pageCount;
        total = result.total;
        filters = result.filters;
        renderChips(result.filters);
        prevButton.disabled = page <= 0;
        nextButton.disabled = page >= pageCount - 1;
        pagerLabel.textContent = "第 " + (page + 1) + " / " + pageCount + " 页 · 共 " + total + " 只";
        pets = result.pets ?? [];
      }
      if (filters) renderChips(filters);
      renderShop(pets);
      shopLoaded = true;
      showStatus("");
    } catch (error) {
      showStatus("商城加载失败：" + (error && error.message ? error.message : error));
    } finally {
      loading = false;
    }
  }

  let filters = null;

  function renderChips(filters) {
    const defs = [
      { id: "all", label: "全部" },
      { id: "original", label: "原创" + (filters.originalsCount ? " · " + filters.originalsCount : "") },
      { id: "featured", label: "精选" + (filters.featuredCount ? " · " + filters.featuredCount : "") },
      ...filters.categories.map((c) => ({ id: c.id, label: c.label + " · " + c.count })),
    ];
    chips.innerHTML = defs.map((def) => '<button type="button" class="chip' + (def.id === category ? " active" : "") + '" data-filter="' + def.id + '">' + def.label + "</button>").join("");
  }

  chips.addEventListener("click", (event) => {
    const chip = event.target.closest("button[data-filter]");
    if (!chip) return;
    category = chip.getAttribute("data-filter");
    chips.querySelectorAll(".chip").forEach((el) => el.classList.toggle("active", el === chip));
    page = 0;
    void loadShop();
  });

  let searchDebounce;
  function applySearchLocal() {
    // Non-empty search hits the full catalog search list over IPC; empty
    // restores paged browsing.
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { void loadShop(); }, 250);
  }

  searchInput.addEventListener("input", applySearchLocal);

  function renderShop(pets) {
    const query = searchInput.value.trim().toLowerCase();
    const visible = pets.filter(chipFilter).filter((entry) => !query || (entry.displayName || "").toLowerCase().includes(query) || (entry.description || "").toLowerCase().includes(query) || entry.id.includes(query));
    shopGrid.innerHTML = visible.map((entry) => {
      const preview = entry.thumbnail
        ? '<div class="thumb" style="background-image:url(\\'' + entry.thumbnail + '\\');background-size:112px auto"></div>'
        : '<div class="thumb missing">无预览</div>';
      const tags = [
        entry.original ? '<span class="tag">原创</span>' : "",
        entry.featured ? '<span class="tag">精选</span>' : "",
        entry.category === "western" ? '<span class="tag">Western</span>' : "",
        entry.category === "asian" ? '<span class="tag">Asian</span>' : "",
      ].filter(Boolean).join(" ");
      const actions = entry.installed
        ? (entry.isDefault ? '<span class="pill current">当前默认</span>' : '<button type="button" data-select="' + entry.id + '">设为默认</button>')
        : '<button type="button" data-install="' + entry.id + '">安装</button>';
      return '<article class="card">' + preview +
        "<h3>" + escapeHtml(entry.displayName) + "</h3>" +
        "<p>" + (entry.description ? escapeHtml(entry.description) : "") + "</p>" +
        '<div class="actions">' + (tags ? '<span style="display:flex;gap:4px">' + tags + "</span>" : "") + actions + "</div>" +
        "</article>";
    }).join("\\n") || '<p style="padding:4px 2px;color:#64748b">该筛选条件下本页没有宠物。</p>';
  }

  shopGrid.addEventListener("click", async (event) => {
    const installButton = event.target.closest("button[data-install]");
    if (installButton) {
      installButton.disabled = true;
      installButton.textContent = "安装中…";
      const result = await window.petsManager.catalogInstall(installButton.getAttribute("data-install"));
      showStatus(result.ok ? result.message : "安装失败：" + result.message);
      if (result.ok) await loadShop();
      return;
    }
    const selectButton = event.target.closest("button[data-select]");
    if (selectButton) {
      const result = await window.petsManager.select(selectButton.getAttribute("data-select"));
      showStatus(result.ok ? "已切换桌面宠物" : "切换失败：" + result.message);
      if (result.ok) await loadShop();
    }
  });

  prevButton.addEventListener("click", () => { if (page > 0) { page -= 1; void loadShop(); } });
  nextButton.addEventListener("click", () => { if (page < pageCount - 1) { page += 1; void loadShop(); } });

  document.getElementById("grid").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-select]");
    if (!button) return;
    const result = await window.petsManager.select(button.getAttribute("data-select"));
    showStatus(result.ok ? "已切换桌面宠物" : "切换失败：" + result.message);
    if (result.ok) setTimeout(() => window.location.reload(), 600);
  });
  document.getElementById("import").addEventListener("click", async () => {
    showStatus("选择宠物包文件夹（含 pet.json 与精灵图）…");
    const result = await window.petsManager.importFolder();
    showStatus(result.message);
    if (result.ok) setTimeout(() => window.location.reload(), 600);
  });

  function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }
</script>
</body>
</html>`;
}
const THUMB_FACTOR = 112 / 192;
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
