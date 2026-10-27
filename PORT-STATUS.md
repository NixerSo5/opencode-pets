# pet-animation-standalone — 移植与工作状态

> 独立的桌面宠物应用（Electron），从 OpenPets 桌面端 (`C:\Users\nixer\Desktop\ifsOdb\pet\openpets`) 提取/移植而来。
> 本文档记录：移植了什么、当前工作状态、如何运行。**更新日期：2026-10-27，对应提交 `2f93f54`**。

## 1. 项目性质

- 不依赖 OpenPets 运行时，是独立的 Electron 单体应用（透明置顶桌宠 + 管理端 + 商城 + 对话面板）。
- 核心精灵图/动画规则、文案池、商城接口、对话框样式均忠实地从 OpenPets 源码移植（来源见 §3 各条目）。
- **已接入本机 OpenCode**：召唤、绑定 session、通过 CLI 收发消息、SSE 事件驱动动画。

## 2. 运行方式

```powershell
# 工作目录必须是项目根
cd C:\Users\nixer\Desktop\pet-animation-standalone

# 编译 TS -> dist/
npx tsc -p tsconfig.json

# 运行（注意：shell 必须为 false，见 §4 第 6 条）
$env:ELECTRON_ENABLE_LOGGING=1; npx electron .
```

- 重启：`Get-Process electron | Where MainWindowTitle -eq "OpenPets pet" | Stop-Process -Force` 后再启动。
- 误杀红线：**绝不 Stop-Process opencode 进程**（桌宠窗口标题固定为 `OpenPets pet`，只杀这个）。

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
3. **页面内联脚本被 CSP 拦截**：`default-src 'none'` 无 `script-src` 时内联 `<script>` 全部静默失效 → 必须加 `script-src 'unsafe-inline'`。
4. **状态提示藏在隐藏 tab**：安装成功/失败信息一度只写在「本机」区块里 → 双状态条（本机/商城同步显示）。
5. **卡片缩略图 `background-position: center` 被继承** → 精灵图类强制 `0 0`，保证恰好显示第一格静止帧。
6. **`opencode run` 等 stdin EOF 才启动**：`spawn` 若给打开 stdin 管道会永久挂起 → 必须 `stdio: ["ignore", "pipe", "pipe"]`。
7. **模板字符串是运行错误的头号根因**：`` `...` `` 会吃掉 `\r` `\n` `\"` `\\` 和反引号，导致注入页面的函数变成非法 JS（`Uncaught SyntaxError: Invalid regular expression: missing /`）。凡是含正则/反斜杠的渲染函数，必须**模块顶层定义**，再用 `.toString()` 注入页面。注释里也不能出现反引号。
8. **`ModelSelected` 是异步投影**：`POST /api/session/:id/model` 返回 204 后，`GET /api/session/:id` 短时间内仍返回旧 model → 切模型后需轮询确认（`getSessionAfterModelSwitch`，8×120ms）。
9. **model id 大小写敏感**：`deepSeekWeb` 会报 `provider.no-route`，必须与 catalog 完全一致（`deepseekWeb`）。
10. **队列第二条消息被吞**：`activeRun` 单槽位在第二次 spawn 时被覆盖，第一条 child 关闭时被误判为「已取消」→ 改为 `Set<ChildProcess>`，`close` 里用 `activeRuns.delete(child)` 判定。

## 5. 工作状态（截至 `2a13f94`）

### 已完成并提交

| 提交 | 内容 |
|---|---|
| `4768111` | 初始提交：独立桌宠移植 |
| `dff2b55` | 接入本地 OpenCode：SSE 观察者、事件→反应映射 |
| `6106504` | 模型切换（`/model` 端点）+ CLI 发送链路 |
| `3ece637` | 面板 UI 打磨、Markdown 注入修复、失焦隐藏、排队发送、`activeRuns` Set |
| `2a13f94` | 关闭瞬时化、代码块语法高亮 |
| `a9d72c1` | 方案 A：HTTP prompt + SSE form.reply 实现真正的 question 交互；electron-builder 打包配置；右键菜单与 `pet-launch.cmd` |
| `2f93f54` | 对话文本可选中；每条消息与提问卡片右下角复制按钮（`openpets:pet-copy-text` 走主进程 clipboard） |

### 详细清单

**OpenCode 接入**
- 服务发现：读 `%USERPROFILE%\.local\state\opencode\service.json`（url/pid/password），Basic auth 用户名 `opencode`。
- 会话绑定：单实例锁；启动无 summon 时自动 `connectDefault()` 绑 Desktop 会话；`second-instance` 转发 summon。
- 发送：`runPrompt()` spawn CLI（`opencode run -s <id> --format json --auto`），解析 JSON 取 `type==="text"` 的 `part.text` 拼接。
- CLI 路径回退：`%ProgramFiles%\nodejs\node_modules\@opencode\cli\bin\opencode.exe` → `%APPDATA%\npm\...` → 裸名 `opencode`。
- Stop：`abortRunPrompt()` kill 全部 in-flight child（`activeRuns` 集合）。
- 事件→反应：`inbox.enqueued`→waving、`execution.started`→working、`tool.*`→running、`permission.asked`→waiting、`succeeded`→success、`failed`→error、`interrupted`→idle；只对当前 session 生效。

**对话面板**
- 固定 `height: 500px` + `overflow: hidden`，只有 `.chat-transcript` 滚动；header/composer/model 行固定。
- 输入框 `min-height: 46px` / `max-height: 132px` / 字号 13.5px。
- 助手消息 `innerHTML = renderMarkdown(...)`；用户消息 `textContent`（不被当作 Markdown）。
- Markdown 支持：围栏代码块、行内代码、粗体、斜体、链接、标题（h3–h5）、无序/有序列表、段落换行。
- 代码块语法高亮：`highlightCodeText()` 先 stash 字符串/注释，再染关键字/数字，最后还原。配色 `.tok-kw #c792ea` / `.tok-str #c3e88d` / `.tok-comment #7f8c98 斜体` / `.tok-num #f78c6c`。
- 关闭面板为**瞬时硬切**（无退场动画，避免「挤一下」的闪烁）。
- 对话文本可选中复制；每条消息与提问卡片右下角有复制按钮。`pet window` 是 `file://` 非安全上下文，`navigator.clipboard` 不可用，复制走 `openpets:pet-copy-text` IPC 到主进程 `clipboard.writeText`。
- 窗口失焦自动收起面板。
- 中途发送：`sendQueue` + `drainSendQueue()` 串行执行；Stop 清空队列。
- 模型行显示当前 model；右键切换后有打勾标记。

**宠物本体**
- 透明置顶窗口 320×300，scale 0.75；内置 Hoodie Cat + 商城宠物安装切换。
- 表情轮询已移除；只在显式事件播放反应。
- 欢迎语 on load（挥手 + Hello + Hi 徽章），播完回 idle。

**管理端**
- 本机列表（含立绘预览）/ 商城（筛选/搜索/分页/安装）。

### 尚未完成（按优先级）

1. **物理抛掷** — 拖拽松手后按速度抛出、惯性衰减、屏幕边界回弹（原版参考 `pet-motion-engine.ts`、`pet-throw-core.ts`）。
2. **桌面静默启动快捷方式** — `.bat` / 开机自启动。
3. **Markdown 语法高亮的观感打磨** — 当前配色接近常见深色主题，但尚未与 CLI 实际渲染逐色对齐。
4. **宠物右键菜单体验打磨** — 菜单项顺序、图标、脏数据（`deepSeekWeb`）导致打勾匹配不上的问题。
5. **Explorer 右键召唤偶发无效、召唤坐标落点** — 待修。
6. **面板快速开合稳定性** — 疑似并发 CDP 抢焦点，需干净环境复核。
7. **代码签名** — 未配置证书。

## 6. 代码结构速览

```
src/
  electron-main.ts              主进程（窗口、托盘、IPC、右键菜单、模型切换、面板展开契约）
  desktop-render.ts             宠物页（精灵动画 + 气泡 + 对话面板 + Markdown + 高亮 + 拖拽/点击）
  browser-render.ts             sprite CSS 生成核心（createSpriteStateCss）
  reaction-animation-mapping.ts reaction → spriteState 映射
  reaction-messages.ts          12 类 reaction 文案池
  opencode-client.ts            OpenCode 服务发现、runPrompt、abortRunPrompt、activeRuns
  management-render.ts          管理页（本机/商城）
  catalog-client.ts             商城 v3（index/分页/搜索聚合）
  catalog-install.ts            ZIP 下载 + 安全解压 + 安装
  pet-store.ts                  本机宠物存储/校验/导入
pet-preload.cjs                 宠物窗口 preload
management-preload.cjs          管理窗口 preload
assets/assets/                  默认精灵图 + 托盘图标
```

运行时数据：`C:\Users\nixer\AppData\Roaming\pet-animation-standalone\`（`pets\`、`state.json`、`rendered-pets\`）。

## 7. 关键 IPC / HTTP 一览

| 通道 | 方向 | 用途 |
|---|---|---|
| `openpets:pet-state` | main→pet | `{state, reaction?, message?}`：表情 + 气泡 |
| `openpets:pet-panel-state` | main→pet | `{chatExpanded}` |
| `openpets:pet-chat-toggle` | pet→main | 单击宠物开/关对话 |
| `openpets:pet-chat-send` | pet→main（invoke） | 发送消息 → `runPrompt()` 走 CLI |
| `openpets:pet-chat-stop` | pet→main（invoke） | 停止思考 → `abortRunPrompt()` |
| `openpets:pet-chat-history` | pet→main（invoke） | 拉取当前 session 历史消息 |
| `openpets:pet-chat-model` | pet→main（invoke） | 读取当前 session 的 model |
| `openpets:pet-drag-move` | pet→main | 手动拖动窗口（增量） |
| `openpets:pet-message` | pet→main | 演示页 say() |
| `pets:select/catalog-page/catalog-search/catalog-install/import-folder` | mgmt→main | 管理端 |

**OpenCode HTTP API**（Basic auth：`opencode:<password>`）

| 端点 | 用途 |
|---|---|
| `GET /api/session/{id}` | 读会话（外层 `{data:{...}}`，model 在 `.data.model`） |
| `GET /api/session/{id}/message` | 拉历史消息 |
| `POST /api/session/{id}/model` | 切换模型，payload `{model:{providerID,id}}`，返回 204 |
| `GET /event`（SSE） | 订阅会话事件驱动动画 |

## 8. 文档维护提示

- 每次功能提交后更新 §5 的「工作状态」表和 §5 的详细清单。
- 遇到新坑写进 §4，越具体越好（错误原文 + 根因 + 修法）。
- 不要把本文件当成唯一事实来源：以 `git log` 与源码为准。
