# pet-animation-standalone — 移植与工作状态

> 独立的桌面宠物应用（Electron），从 OpenPets 桌面端 (`C:\Users\nixer\Desktop\ifsOdb\pet\openpets`) 提取/移植而来。
> 本文档记录：移植了什么、当前工作状态、如何运行。更新日期：2026-10-26。

## 1. 项目性质

- 不依赖 OpenPets 运行时，是独立的 Electron 单体应用（透明置顶桌宠 + 管理端 + 商城 + 对话面板）。
- 核心精灵图/动画规则、文案池、商城接口、对话框样式均忠实地从 OpenPets 源码移植（来源见 §3 各条目）。
- 后续计划中未做的：接入 OpenCode session 事件、物理抛掷、electron-builder 打包单 exe。

## 2. 运行方式

```powershell
# 工作目录必须是项目根
cd C:\Users\nixer\Desktop\pet-animation-standalone

# 构建（tsc → dist/）
npm run build

# 用借用的 Electron 42 运行（npm 原生下载 electron 二进制会超时，因此借用 openpets 仓库 pnpm 缓存里的 exe）
& "C:\Users\nixer\Desktop\ifsOdb\pet\openpets\node_modules\.pnpm\electron@42.0.0\node_modules\electron\dist\electron.exe" .
```

- 退出：托盘 → 退出；或 `Get-Process electron | Where MainWindowTitle -eq "OpenPets pet" | Stop-Process`
- 误杀红线：**绝不 Stop-Process opencode 进程**（原版 OpenPets 桌宠进程标题/路径不同，注意区分）

## 3. 从 OpenPets 移植的内容

### 精灵图与动画（核心层）
| 内容 | 来源 | 移植位置 |
|---|---|---|
| V2 atlas 8×11 layout（192×208 帧），V1 8×9 兼容 | `reaction-animation-mapping.ts` | `src/reaction-animation-mapping.ts`（内联） |
| reaction → spriteState 映射（"endColumn === frames" 结尾判定） | `codex-pets-core.ts` | `src/browser-render.ts` + `reaction-animation-mapping.ts` |
| sprite CSS 步进动画生成（无 transform scale，几何烘焙，整数像素） | pet-window 样式 | `src/browser-render.ts`（`createSpriteStateCss`） |
| 12 类 reaction 文案池（idle/thinking/working/…/celebrating） | `reaction-messages.ts` | `src/reaction-messages.ts`（照搬） |

### 气泡（宠物头上的对话气泡）
| 内容 | 来源 | 移植位置 |
|---|---|---|
| 气泡视觉：渐变卡+白描边+底部小尾巴+`bubble-in` 动画+多行截断 | `pet-window-styles.ts` | `src/desktop-render.ts` |
| 状态徽章：Hi(👋)/Done(✓)/Oops(⚠)/waiting/busy 脉冲、分隔线、is-status-only/is-message-only | `pet-window-render.ts`（createBubbleMarkup/getStatusBadge） | `src/desktop-render.ts` 内联脚本 |
| 启动欢迎语：挥手 + "Hello" + "Hi" 徽章，页面每次加载（启动/切换宠物后）都重新出现 | 原版 greeting 行为 | `src/electron-main.ts`（`sayWelcome`） |

### 对话面板（点宠物弹出的聊天窗口）
| 内容 | 来源 | 移植位置 |
|---|---|---|
| 窗口展开契约：320×300 → 420×640（`expandedPetWindowSize`），宠物锚点不动 | `default-pet-chat-geometry.ts` | `src/electron-main.ts`（`setChatExpanded`） |
| 面板视觉：白渐变卡/20px 圆角/尾巴/`chat-panel-enter` 头顶栏(头像+名字+✕)/transcript/composer | `pet-window-styles.ts`（In-Pet Attached Chat Panel） | `src/desktop-render.ts` |
| 用户右蓝/助手左白气泡、`msg-appear`、空状态页 | 同上 | `src/desktop-render.ts` |
| 单击宠物开/关对话；点击 vs 拖拽判别（>6px 走手动窗拖、<600ms 稳定按下算点击） | manual-pet-drag 原理 | `src/desktop-render.ts` 内联脚本 + `pet-preload.cjs` + `electron-main.ts`（`openpets:pet-drag-move` IPC） |

说明：对话回复目前是**桩回复**（echo + 提示），OpenCode session 尚未接入。

### 管理端（托盘「打开宠物管理」）
| 内容 | 来源 | 移植位置 |
|---|---|---|
| 本机宠物卡片（静态单帧立绘）+ 设为默认 | Control Center Pets 标签 | `src/management-render.ts` |
| 商城：catalog v3（14 页×100，1312 只），筛选 chips（全部/原创/精选/Western/Asian 带数）、跨全量搜索、分页 | catalog v3 契约（docs/catalog.md） | `src/catalog-client.ts` + `management-render.ts` |
| 一键安装：ZIP 下载（PK 魔数+50MB 上限+zip 主机白名单）→ yauzl 安全解压（防穿越/条目数/大小上限）→ pet.json+精灵图校验 → 提升到 userData/pets/{id} | 原版安装管线/zip-safety | `src/catalog-install.ts` |

### 桥接/杂项
- 本机宠物存储：`userData/pets/{id}` 扫描 + `pet.json` 校验 + `state.json` 默认宠物持久化（`src/pet-store.ts`，规则对齐原版包校验）。
- 托盘：打开宠物管理 / 切换下一个表情（手动）/ 退出。
- 双 CJS preload（`pet-preload.cjs` / `management-preload.cjs`），与原版相同的安全形态（contextIsolation + 无 nodeIntegration）。

## 4. 移植期间发现并修复的坑（重要经验）
1. **商城 search.json 是分页索引**（250/页），不是平铺列表 → `getCatalogAllPets` 聚合所有 `search-page-NNN.json`。
2. **搜索索引条目是瘦身版**（无 `zip`/`thumbnail`，只有 `catalogPage` 指回目录页）→ 安装时跳到所在目录页取完整条目。
3. **页面内联脚本被 CSP 拦截**：`default-src 'none'` 无 `script-src` 时内联 `<script>` 全部静默失效（原版靠主进程重写整页文档，所以它的 CSP 没有 script-src；我们是 IPC 推送架构，必须加 `script-src 'unsafe-inline'`）。
4. **状态提示藏在隐藏 tab**：安装成功/失败信息一度只写在「本机」区块里 → 双状态条（本机/商城同步显示）。
5. **卡片缩略图 `background-position: center` 被继承** →精灵图类强制 `0 0`，保证恰好显示第一格静止帧。

## 5. 工作状态（截至本次提交）

### 已上线稳定
- 桌宠窗口（透明/置顶/右下 320×300，scale 0.75）、内置 Hoodie Cat + 商城宠物安装切换
- 管理端：本机列表（含立绘预览）/商城（筛选/搜索/分页/安装）
- 气泡 + 状态徽章 + 欢迎语（点击气泡可提前关闭）
- 对话面板：单点击开/关闭、拖拽判别、窗口展开回收、stub 回复
- **表情轮询已结束**：不再每 5s 自动换表情；只在显式事件播放反应（欢迎语 on load、托盘「切换下一个表情」、未来的 OpenCode session 事件）。欢迎语为循环姿势，播完后主进程自己回 idle。

### 已知未做（下一步候选，优先级从上到下）
1. **接入 OpenCode session**：把对话面板的 stub 回复换成真实会话（渲染端收发链路已就绪，只差主进程后端）；同时把 session 状态（thinking/working/success/error）映射到宠物 reaction 和气泡。
2. **electron-builder 打包单 exe**：消除对借用 electron.exe 的依赖（当前 exe 在 openpets 仓库的 pnpm 缓存里，若该仓库被清除 app 会跑不起来）。
3. **物理**：拖拽抛掷/重力回落（原版 `pet-motion-engine.ts`、`pet-throw-core.ts`）。
4. 桌面静默启动快捷方式（`.bat`/开机自启动）。

## 6. 代码结构速览

```
src/
  electron-main.ts        主进程（窗口、托盘、IPC、欢迎语/手动反应、窗口展开契约）
  desktop-render.ts       宠物页（精灵动画 + 气泡 + 对话面板 + 拖拽/点击）
  browser-render.ts       sprite CSS 生成核心（createSpriteStateCss）
  reaction-animation-mapping.ts
  reaction-messages.ts
  management-render.ts    管理页（本机/商城）
  catalog-client.ts       商城 v3（index/分页/搜索聚合）
  catalog-install.ts      ZIP 下载+安全解压+安装
  pet-store.ts            本机宠物存储/校验/导入
pet-preload.cjs           宠物窗口 preload（onPetState/onPanelState/chatToggle/chatSend/dragMove/say）
management-preload.cjs    管理窗口 preload（select/importFolder/catalogPage/catalogSearch/catalogInstall）
assets/assets/            默认精灵图 + 托盘图标
```

运行时数据：`C:\Users\nixer\AppData\Roaming\pet-animation-standalone\`（`pets\`、`state.json`、`rendered-pets\`）。

## 7. 关键 IPC 一览

| 通道 | 方向 | 用途 |
|---|---|---|
| `openpets:pet-state` | main→pet | `{state, reaction?, message?}`：表情 + 气泡 |
| `openpets:pet-panel-state` | main→pet | `{chatExpanded}` |
| `openpets:pet-chat-toggle` | pet→main | 单击宠物开/关对话 |
| `openpets:pet-chat-send` | pet→main（invoke） | 发送消息 → 桩回复 |
| `openpets:pet-drag-move` | pet→main | 手动拖动窗口（增量） |
| `openpets:pet-message` | pet→main | 演示页 say() |
| `pets:select/catalog-page/catalog-search/catalog-install/import-folder` | mgmt→main | 管理端 |
