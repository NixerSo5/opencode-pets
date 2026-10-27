# OpenPets Desktop（独立桌宠）

一个独立的 Electron 桌面宠物应用，把 **OpenPets** 的精灵动画与对话面板带进本地 OpenCode 工作流：右键召唤、绑定会话、在宠物里收发消息、由 agent 状态驱动表情动画。

[English](./README.en.md) | 中文

---

## 致谢与来源

本项目的精灵图布局、动画映射规则、气泡与对话面板视觉、管理端和商城接口，全部移植自 **OpenPets** 桌面端。

感谢 OpenPets 的作者与贡献者开源了这套完整、精致、考虑周全的实现。没有它，这个项目不会存在。原版仍在积极开发；如果你需要完整的 OpenPets 体验，请优先使用原项目。

本项目是**独立衍生作品**，与原版仓库没有隶属关系。原版授权条款以原仓库为准，使用或分发前请自行确认。

---

## 与 OpenPets 的区别

| 维度 | OpenPets | 本项目 |
| --- | --- | --- |
| 形态 | 完整桌面端产品（控制中心 + 桌宠 + 商城） | 单一 Electron 单体，聚焦桌宠与对话 |
| 运行依赖 | 自带运行时与完整控制中心 | 独立 exe，依赖本机 OpenCode 服务 |
| Agent 接入 | 自有 agent 生态 | 只接本机 OpenCode（HTTP API + SSE） |
| 交互 | 面板内对话 | 点宠物开合面板；右键召唤新建会话；question 卡片内联作答 |
| 发送链路 | 不适用 | POST /api/session/{id}/prompt（不覆盖模型）+ SSE 事件驱动 |
| 提问处理 | 不适用 | SSE form.created 渲染选项与手填卡片；form.reply 同回合继续 |
| 复制 | 不适用 | 对话文本可选中；每条消息与提问卡片右下角有复制按钮 |
| 打包 | 不适用 | electron-builder：NSIS 安装包 + portable |

---

## 当前状态

可用。主链路已在本机真机跑通。

### 已完成

- 透明置顶桌宠窗口，点按开合对话面板，拖拽移动
- 右键菜单召唤（桌面背景与文件夹空白处），记录当前目录并新建会话
- 接入本机 OpenCode：服务发现、会话绑定、历史拉取、模型读取与切换
- 消息发送走 HTTP prompt，回合进度走 SSE 事件；失败回落 CLI
- agent 状态驱动精灵动画（waking / working / running / waiting / success / error / idle）
- question 卡片：预置选项 + 手填，多问题一次提交，同回合续跑
- Markdown 渲染与代码块语法高亮，排队发送，停止
- 对话文本可选中复制；每条卡片右下角复制按钮（走主进程 clipboard）
- electron-builder 打包：OpenPets Setup 1.0.0.exe（NSIS）与 OpenPets 1.0.0.exe（portable）

### 待办

- 物理抛掷（惯性、边界回弹）
- 开机自启动与静默启动快捷方式
- 从 Explorer 右键召唤偶发无效；召唤落点坐标
- 面板快速开合在特定环境下的稳定性复核
- 未配置代码签名证书

---

## 快速开始

前置：本机已运行 OpenCode，且存在 `%USERPROFILE%\.local\state\opencode\service.json`（含 url 与 password）。

```powershell
npm install
npx tsc -p tsconfig.json
npx electron .
```

打包：

```powershell
npx electron-builder --win "--config.electronDist=node_modules/electron/dist"
```

产物在 `release/`。

---

## 代码结构

```
src/
  electron-main.ts              主进程：窗口、托盘、IPC、右键菜单、HTTP 回合
  desktop-render.ts             宠物页：精灵动画、气泡、对话面板、Markdown、复制按钮
  browser-render.ts             精灵 CSS 生成
  reaction-animation-mapping.ts reaction 到 spriteState 映射
  reaction-messages.ts          反应文案池
  opencode-client.ts            OpenCode 服务发现、prompt、历史、模型
  opencode-watch.ts             SSE 订阅与事件分发
  management-render.ts          管理页
  catalog-client.ts             商城数据
  catalog-install.ts            ZIP 安全下载与解压
  pet-store.ts                  本机宠物存储
pet-preload.cjs                 宠物窗口 preload
management-preload.cjs          管理窗口 preload
```

---

## 开发笔记

移植与踩坑记录见 [PORT-STATUS.md](./PORT-STATUS.md)，包含 OpenPets 各组件的来源对照、SSE 事件契约，以及若干非显然的坑（模板字符串注入、模型 id 大小写、SSE 事件名等）。

---

## 许可

本仓库代码与 OpenPets 原项目的关系见上方「致谢与来源」。分发前请确认上游许可条款，并保留原项目署名。
