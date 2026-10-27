# OpenPets Desktop (standalone pet)

A standalone Electron desktop pet that brings **OpenPets** sprite animation and chat panel into a local OpenCode workflow: summon from the context menu, bind a session, chat with the agent inside the pet, and drive animations from agent state.

English | [中文](./README.md)

---

## Credits and provenance

The sprite atlas layout, animation mapping rules, bubble and chat-panel visuals, and the management/catalog plumbing are all ported from the **OpenPets** desktop app.

Thanks to the OpenPets authors and contributors for open-sourcing such a complete and carefully considered implementation. This project would not exist without it. The original is still actively developed; if you want the full OpenPets experience, please use the upstream project.

This is an **independent derivative work** and is not affiliated with the upstream repository. Licensing of upstream code is governed by that repository; verify before use or redistribution.

---

## How this differs from OpenPets

| Aspect | OpenPets | This project |
| --- | --- | --- |
| Scope | Full desktop product (control center + pet + catalog) | Single Electron app focused on pet and chat |
| Runtime | Bundles its own runtime and control center | Standalone exe, depends on a local OpenCode service |
| Agent | Its own agent ecosystem | Local OpenCode only (HTTP API + SSE) |
| Interaction | In-panel chat | Click pet to toggle panel; context-menu summon creates a session; inline question cards |
| Sending | Not applicable | POST /api/session/{id}/prompt (never overrides the model) + SSE-driven progress |
| Questions | Not applicable | SSE form.created renders option and free-text cards; form.reply resumes the same turn |
| Copying | Not applicable | Transcript is selectable; every message and question card has a copy button |
| Packaging | Not applicable | electron-builder: NSIS installer + portable |

---

## Current status

Usable. The main path is verified on a real machine.

### Done

- Transparent always-on-top pet window; click to toggle chat; drag to move
- Context-menu summon on desktop and folder backgrounds, remembers the folder and creates a session
- OpenCode integration: service discovery, session binding, history, model read and switch
- Messages sent via HTTP prompt; turn progress via SSE; falls back to the CLI on failure
- Agent state drives sprite animation (waking / working / running / waiting / success / error / idle)
- Question cards: preset options plus free text, multiple questions submitted at once, same turn resumes
- Markdown rendering with code-block highlighting, queued sending, stop
- Selectable transcript; per-card copy button in the bottom-right (via main-process clipboard)
- electron-builder output: OpenPets Setup 1.1.0.exe (NSIS) and OpenPets 1.1.0.exe (portable)

### Todo

- Physics throw (inertia, edge bounce)
- Launch at login and silent startup shortcut
- Explorer context-menu summon occasionally does nothing; summon position
- Re-check panel open/close stability in some environments
- No code-signing certificate configured

---

## Quick start

Prerequisite: OpenCode is running locally and `%USERPROFILE%\.local\state\opencode\service.json` exists (with url and password).

```powershell
npm install
npx tsc -p tsconfig.json
npx electron .
```

Package:

```powershell
npx electron-builder --win "--config.electronDist=node_modules/electron/dist"
```

Artifacts land in `release/`.

---

## Layout

```
src/
  electron-main.ts              Main process: windows, tray, IPC, context menu, HTTP turns
  desktop-render.ts             Pet page: sprite animation, bubble, chat panel, markdown, copy buttons
  browser-render.ts             Sprite CSS generation
  reaction-animation-mapping.ts reaction to spriteState mapping
  reaction-messages.ts          Reaction message pool
  opencode-client.ts            OpenCode discovery, prompt, history, model
  opencode-watch.ts             SSE subscription and dispatch
  management-render.ts          Management page
  catalog-client.ts             Catalog data
  catalog-install.ts            Safe ZIP download and extraction
  pet-store.ts                  Local pet storage
pet-preload.cjs                 Pet window preload
management-preload.cjs          Management window preload
```

---

## Notes

Porting notes and gotchas live in [PORT-STATUS.md](./PORT-STATUS.md): component provenance from OpenPets, the SSE event contract, and several non-obvious pitfalls (template-string injection, model id casing, SSE event names).

---

## License

See "Credits and provenance" above for the relationship to upstream OpenPets. Check the upstream license terms before distributing, and keep the original attribution.
