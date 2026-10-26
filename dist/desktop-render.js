/**
 * desktop-render.ts
 *
 * Pet-only transparent page for the Electron desktop pet window — mirrors the
 * original pet HTML document structure (sprite CSS + state rules), without any
 * web-demo chrome.
 */
import { getConfiguredSpriteStates, } from "./reaction-animation-mapping.js";
import { createSpriteStateCss, defaultPetLayout } from "./browser-render.js";
/**
 * Escapes HTML-significant characters. Defined at module scope (not inside the
 * page template) so `renderMarkdownText` can be injected with toString().
 */
function escapeHtmlText(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
/**
 * Minimal Markdown renderer for assistant replies. Lives outside the page
 * template on purpose: its regex literals contain backslashes and backticks
 * that a template string would mangle. Injected with toString().
 */
function renderMarkdownText(source) {
    const escape = escapeHtmlText;
    const fences = [];
    const tick = String.fromCharCode(96);
    const fenceRe = new RegExp(tick + tick + tick + "([^\\n" + tick + "]*)\\n([\\s\\S]*?)" + tick + tick + tick, "g");
    const codeRe = new RegExp(tick + "([^" + tick + "\\n]+)" + tick, "g");
    let text = String(source ?? "").replace(/\r\n?/g, "\n");
    text = text.replace(fenceRe, (_m, _lang, code) => {
        fences.push('<pre class="md-pre"><code>' + escape(code.replace(/\n$/, "")) + "</code></pre>");
        return "%%OPENPETS_FENCE" + (fences.length - 1) + "%%";
    });
    const inline = (value) => value
        .replace(codeRe, (_m, code) => '<code class="md-code">' + escape(code) + "</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, href) => '<a href="' + escape(href) + '" target="_blank" rel="noreferrer">' + label + "</a>");
    const lines = escape(text).split("\n");
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
        if (para.length === 0)
            return;
        out.push("<p>" + inline(para.join("<br>")) + "</p>");
        para = [];
    };
    const closeList = () => {
        if (list === null)
            return;
        out.push("</" + list + ">");
        list = null;
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        const fence = line.match(/^%%OPENPETS_FENCE(\d+)%%$/);
        if (fence) {
            flushPara();
            closeList();
            out.push(fences[Number(fence[1])]);
            continue;
        }
        if (line.trim() === "") {
            flushPara();
            closeList();
            continue;
        }
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
            flushPara();
            closeList();
            const level = heading[1].length + 2;
            out.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
            continue;
        }
        const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
        const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (bullet || numbered) {
            flushPara();
            const wanted = bullet ? "ul" : "ol";
            if (list !== wanted) {
                closeList();
                out.push("<" + wanted + ">");
                list = wanted;
            }
            out.push("<li>" + inline((bullet || numbered)[1]) + "</li>");
            continue;
        }
        closeList();
        para.push(line);
    }
    flushPara();
    closeList();
    return out.join("");
}
/** Full HTML document for the transparent pet window. */
export function createPetPageHtml(options = {}) {
    const scale = options.scale ?? 0.75;
    const waitingMs = options.waitingAnimationDurationMs ?? 1010;
    const spritesheetUrl = options.spritesheetUrl ?? "";
    const layout = { ...defaultPetLayout, rows: options.atlasRows ?? defaultPetLayout.rows };
    const petNameDisplay = escapeHtml(options.petName?.length ? options.petName : "Pet");
    const avatarChar = escapeHtml(options.petName?.length ? options.petName.trim().slice(0, 1).toUpperCase() : "?");
    const stateRows = getConfiguredSpriteStates(waitingMs);
    const scaledLayout = {
        frameWidth: layout.frameWidth * scale,
        frameHeight: layout.frameHeight * scale,
        columns: layout.columns,
        rows: layout.rows,
    };
    const shellWidth = Math.ceil(scaledLayout.frameWidth);
    const shellHeight = Math.ceil(scaledLayout.frameHeight);
    return `<!doctype html>
<html lang="en" data-reaction-state="idle">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<title>OpenPets pet</title>
<style>
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; user-select: none; }
  .stage { position: relative; width: 100%; height: 100%; }
  /* Speech bubble — ported from the original pet-window-styles.ts transient
     bubble: light gradient card above the pet with a bottom tail, optional
     status badge header, and a bubble-in entrance animation. */
  .bubble { position: absolute; left: 50%; bottom: ${shellHeight + 16}px; z-index: 4; box-sizing: border-box; display: inline-flex; flex-direction: column; width: fit-content; min-width: 92px; max-width: min(220px, calc(100vw - 18px)); max-height: 128px; padding: 10px 12px; background: linear-gradient(135deg, rgba(239, 246, 255, 0.97), rgba(237, 233, 254, 0.96)); color: #172033; font: 760 11px/14px "Segoe UI", ui-sans-serif, system-ui, sans-serif; text-align: left; border: 1px solid rgba(255, 255, 255, 0.78); border-radius: 14px; box-shadow: 0 12px 24px rgba(15, 23, 42, 0.16), 0 2px 5px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.82); white-space: normal; overflow-wrap: break-word; word-break: normal; overflow: visible; pointer-events: auto; -webkit-app-region: no-drag; opacity: 0; visibility: hidden; backdrop-filter: none; transform: translateX(-50%); transform-origin: 64% 100%; }
  .bubble.show { opacity: 1; visibility: visible; animation: bubble-in 180ms cubic-bezier(0.2, 0, 0, 1); }
  .bubble::after { content: ""; position: absolute; left: 64%; bottom: -7px; width: 12px; height: 12px; background: inherit; border-right: 1px solid rgba(255, 255, 255, 0.56); border-bottom: 1px solid rgba(255, 255, 255, 0.56); border-bottom-right-radius: 3px; transform: translateX(-50%) rotate(45deg); box-shadow: 3px 3px 7px rgba(15, 23, 42, 0.08); }
  html[data-chat-expanded="true"] .bubble { display: none; }
  .bubble-header { display: inline-flex; align-items: center; min-width: 0; gap: 7px; color: currentColor; font: 780 11px/14px "Segoe UI", ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.01em; }
  .bubble-status-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 18px; width: 18px; min-width: 18px; height: 18px; border-radius: 999px; background: #3b82f6; color: #fff; font: 900 12px/18px "Segoe UI", ui-sans-serif, system-ui, sans-serif; text-align: center; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(59, 130, 246, 0.3); }
  .bubble-status-icon svg { display: block; width: 14px; height: 14px; color: currentColor; }
  .bubble-status-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bubble-divider { height: 1px; width: 100%; margin: 8px 0; background: rgba(30, 58, 138, 0.12); }
  .bubble-body { min-width: 0; width: 100%; color: #172033; font: 720 10.5px/13.5px "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
  .bubble-text { display: -webkit-box; min-width: 0; overflow: hidden; -webkit-line-clamp: 4; -webkit-box-orient: vertical; text-wrap: normal; overflow-wrap: break-word; }
  .bubble.is-status-only { max-width: min(156px, calc(100vw - 18px)); padding: 8px 11px; border-radius: 999px; }
  .bubble.is-status-only .bubble-header { display: grid; grid-template-columns: 18px minmax(0, auto); align-items: center; justify-content: center; }
  .bubble.is-message-only { border-radius: 14px 14px 3px 14px; }
  .bubble.is-long-message { max-width: min(220px, calc(100vw - 18px)); max-height: 138px; }
  .bubble.is-very-long-message { max-width: min(220px, calc(100vw - 18px)); max-height: 156px; }
  .bubble.is-very-long-message .bubble-text { -webkit-line-clamp: 8; font-size: 9.5px; line-height: 12.5px; }
  .bubble.is-busy .bubble-status-icon { background: #3b82f6; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(59, 130, 246, 0.34); }
  .bubble.is-waiting .bubble-status-icon { background: #f59e0b; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(245, 158, 11, 0.34); }
  .bubble.is-success .bubble-status-icon { background: #10b981; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(16, 185, 129, 0.34); }
  .bubble.is-error .bubble-status-icon { background: #ef4444; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(239, 68, 68, 0.34); }
  .bubble.is-info .bubble-status-icon { background: #38bdf8; box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.28), 0 2px 7px rgba(56, 189, 248, 0.34); }
  .bubble.is-busy .bubble-status-icon::before { content: ""; position: absolute; inset: 0; width: 18px; height: 18px; background: radial-gradient(circle at 50% 50%, #fff 0 4px, transparent 4.5px); animation: status-pulse 820ms ease-in-out infinite; }
  .bubble.is-waiting .bubble-status-icon::before { content: ""; position: absolute; left: 3px; top: 3px; box-sizing: border-box; width: 12px; height: 12px; border: 2px solid rgba(255, 255, 255, 0.96); border-top-color: rgba(255, 255, 255, 0.28); border-radius: 999px; }
  @keyframes bubble-in { from { opacity: 0; transform: translateX(-50%) translateY(4px) scale(0.96); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
  @keyframes status-pulse { 0%, 100% { opacity: 0.52; } 50% { opacity: 1; } }
  /* --- Chat panel (ported from pet-window-styles.ts In-Pet Attached Chat Panel) --- */
  .openpets-chat-panel { position: absolute; bottom: ${shellHeight + 18}px; left: 50%; transform: translateX(-50%); transform-origin: 50% 100%; width: 390px; height: 500px; max-height: calc(100vh - ${shellHeight + 26}px); z-index: 100; box-sizing: border-box; display: none; flex-direction: column; overflow: hidden; background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(240, 245, 255, 0.96) 55%, rgba(237, 233, 254, 0.95) 100%); color: #0f172a; border: 1px solid rgba(226, 232, 240, 0.95); border-radius: 20px; box-shadow: 0 24px 48px -12px rgba(15, 23, 42, 0.18), 0 4px 12px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 1); overflow: visible; font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif; pointer-events: auto; -webkit-app-region: no-drag; opacity: 0; color-scheme: light; }
  html[data-chat-expanded="true"] .openpets-chat-panel { display: flex; opacity: 1; animation: chat-panel-enter 220ms cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  /* Collapsing: keep the panel painted while it plays out, so the window can
     shrink only after the fade finishes (avoids the one-frame squeeze). */
  .openpets-chat-panel.is-closing { display: flex; animation: chat-panel-exit 150ms ease-in forwards; }
  .openpets-chat-panel::after { content: ""; position: absolute; left: 50%; bottom: -6px; width: 12px; height: 12px; background: #ede9fe; border-right: 1px solid rgba(226, 232, 240, 0.95); border-bottom: 1px solid rgba(226, 232, 240, 0.95); border-bottom-right-radius: 3px; transform: translateX(-50%) rotate(45deg); box-shadow: 3px 3px 6px rgba(15, 23, 42, 0.08); z-index: 1; }
  .chat-header { height: 46px; padding: 0 14px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(226, 232, 240, 0.9); border-top-left-radius: 19px; border-top-right-radius: 19px; background: rgba(248, 250, 252, 0.8); flex-shrink: 0; user-select: none; }
  .chat-header-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .chat-avatar { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; color: #fff; flex-shrink: 0; background: linear-gradient(135deg, #3b82f6, #8b5cf6); }
  .chat-title { font-size: 13px; font-weight: 780; color: #0f172a; letter-spacing: -0.01em; white-space: nowrap; }
  .chat-close-btn { width: 26px; height: 26px; border-radius: 50%; border: none; background: transparent; color: #64748b; display: flex; align-items: center; justify-content: center; cursor: pointer; pointer-events: auto; -webkit-app-region: no-drag; transition: all 140ms ease; font-size: 13px; font-weight: 700; }
  .chat-close-btn:hover { background: rgba(148, 163, 184, 0.16); color: #0f172a; }
  .chat-transcript { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; scrollbar-width: thin; scrollbar-color: rgba(148, 163, 184, 0.35) transparent; overscroll-behavior: contain; }
  .chat-transcript::-webkit-scrollbar { width: 5px; }
  .chat-transcript::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.3); border-radius: 99px; }
  .chat-empty { margin: auto 0; text-align: center; padding: 20px 10px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .chat-empty-icon { font-size: 28px; line-height: 1; margin-bottom: 2px; }
  .chat-empty-title { font-size: 13px; font-weight: 780; color: #0f172a; }
  .chat-empty-subtitle { font-size: 11px; color: #64748b; max-width: 240px; line-height: 1.4; }
  .chat-msg { display: flex; flex-direction: column; max-width: 88%; animation: msg-appear 160ms cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  .chat-msg.is-user { align-self: flex-end; }
  .chat-msg.is-assistant { align-self: flex-start; max-width: 92%; }
  .chat-msg-bubble { padding: 8px 12px; font-size: 12px; line-height: 16.5px; word-break: break-word; white-space: pre-wrap; }
  .chat-msg.is-user .chat-msg-bubble { background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; border-radius: 14px 14px 2px 14px; box-shadow: 0 2px 6px rgba(37, 99, 235, 0.22); }
  .chat-msg.is-assistant .chat-msg-bubble { background: #ffffff; border: 1px solid rgba(226, 232, 240, 0.95); color: #1e293b; border-radius: 14px 14px 14px 2px; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04); }
  .chat-msg-bubble > :first-child { margin-top: 0; }
  .chat-msg-bubble > :last-child { margin-bottom: 0; }
  .chat-msg-bubble p { margin: 0 0 7px; }
  .chat-msg-bubble h3, .chat-msg-bubble h4, .chat-msg-bubble h5 { margin: 10px 0 5px; font-size: 12.5px; line-height: 1.35; font-weight: 760; }
  .chat-msg-bubble ul, .chat-msg-bubble ol { margin: 0 0 7px; padding-left: 18px; }
  .chat-msg-bubble li { margin: 2px 0; }
  .chat-msg-bubble li > p { margin: 0; }
  .chat-msg-bubble a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
  .chat-msg-bubble .md-code { padding: 1px 4px; border-radius: 4px; background: rgba(148, 163, 184, 0.18); font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; }
  .chat-msg-bubble .md-pre { margin: 0 0 7px; padding: 8px 10px; border-radius: 8px; background: #0f172a; color: #e2e8f0; overflow-x: auto; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; line-height: 1.5; }
  .chat-msg-bubble .md-pre code { font: inherit; white-space: pre; }
  .chat-composer { padding: 10px 14px 8px; border-top: 1px solid rgba(226, 232, 240, 0.9); background: rgba(248, 250, 252, 0.85); display: flex; align-items: flex-end; gap: 8px; flex: 0 0 auto; }
  .chat-textarea { flex: 1 1 auto; min-width: 0; min-height: 46px; max-height: 132px; padding: 11px 13px; box-sizing: border-box; border: 1px solid rgba(203, 213, 225, 0.9); border-radius: 12px; background: #ffffff; color: #0f172a; font-family: inherit; font-size: 13.5px; line-height: 20px; resize: none; outline: none; pointer-events: auto; -webkit-app-region: no-drag; box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.03); transition: border-color 140ms ease, box-shadow 140ms ease; }
  .chat-textarea:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2), inset 0 1px 2px rgba(15, 23, 42, 0.03); }
  .chat-textarea::placeholder { color: #94a3b8; }
  .chat-send-btn { width: 40px; height: 40px; border-radius: 11px; border: none; display: flex; align-items: center; justify-content: center; flex-shrink: 0; cursor: pointer; pointer-events: auto; -webkit-app-region: no-drag; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; box-shadow: 0 2px 5px rgba(37, 99, 235, 0.28); transition: all 140ms ease; }
  .chat-stop-btn { width: 40px; height: 40px; border-radius: 11px; border: none; display: flex; align-items: center; justify-content: center; flex-shrink: 0; cursor: pointer; pointer-events: auto; -webkit-app-region: no-drag; background: linear-gradient(135deg, #f43f5e 0%, #e11d48 100%); color: #ffffff; box-shadow: 0 2px 5px rgba(225, 29, 72, 0.28); transition: all 140ms ease; }
  .chat-stop-btn:hover { background: linear-gradient(135deg, #e11d48 0%, #be123c 100%); box-shadow: 0 3px 8px rgba(225, 29, 72, 0.35); transform: scale(1.02); }
  .chat-stop-btn:disabled { background: rgba(203, 213, 225, 0.45); color: #94a3b8; box-shadow: none; cursor: not-allowed; transform: none; }
  .chat-stop-btn svg { width: 13px; height: 13px; }
  .chat-stop-btn[hidden] { display: none; }
  .chat-send-btn:hover { background: linear-gradient(135deg, #1d4ed8 0%, #1e40af 100%); box-shadow: 0 3px 8px rgba(37, 99, 235, 0.35); transform: scale(1.02); }
  .chat-send-btn:disabled { background: rgba(203, 213, 225, 0.45); color: #94a3b8; box-shadow: none; cursor: not-allowed; transform: none; }
  .chat-send-btn svg { width: 15px; height: 15px; }
  .chat-model-line { flex: 0 0 auto; padding: 8px 14px 12px; font-size: 11px; line-height: 15px; color: #64748b; border-bottom-left-radius: 19px; border-bottom-right-radius: 19px; background: rgba(248, 250, 252, 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none; }
  @keyframes chat-panel-enter { from { opacity: 0; transform: translateX(-50%) translateY(8px) scale(0.97); } to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } }
  @keyframes chat-panel-exit { from { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); } to { opacity: 0; transform: translateX(-50%) translateY(6px) scale(0.97); } }
  @keyframes msg-appear { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  .pet-shell {
    position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%);
    width: ${shellWidth}px; height: ${shellHeight}px;
    cursor: default; touch-action: none;
  }
  .sprite {
    position: absolute; left: 0; top: 0;
    width: ${scaledLayout.frameWidth}px; height: ${scaledLayout.frameHeight}px;
    background-image: url("${spritesheetUrl}");
    background-size: ${Math.ceil(layout.frameWidth * scale * layout.columns)}px ${Math.ceil(layout.frameHeight * scale * layout.rows)}px;
    background-repeat: no-repeat;
    --sprite-row-y: 0px; --sprite-offset-x: 0px; --sprite-end-offset-x: 0px;
    --sprite-frames: 6; --sprite-duration: 5500ms; --sprite-iterations: infinite;
    background-position: var(--sprite-offset-x) var(--sprite-row-y);
    animation: var(--sprite-animation, pet-frames var(--sprite-duration) steps(var(--sprite-frames)) var(--sprite-iterations));
    will-change: background-position;
  }
  @keyframes pet-frames {
    from { background-position: var(--sprite-offset-x) var(--sprite-row-y); }
    to { background-position: var(--sprite-end-offset-x) var(--sprite-row-y); }
  }
  ${createSpriteStateCss(".sprite", stateRows, scaledLayout)}
</style>
</head>
<body>
  <div class="stage">
    <div class="openpets-chat-panel" id="chatPanel">
      <div class="chat-header">
        <div class="chat-header-left">
          <span class="chat-avatar">${avatarChar}</span>
          <span class="chat-title">${petNameDisplay}</span>
        </div>
        <button type="button" class="chat-close-btn" id="chatClose" title="关闭" aria-label="关闭对话">✕</button>
      </div>
      <div class="chat-transcript" id="chatTranscript">
        <div class="chat-empty" id="chatEmpty">
          <div class="chat-empty-icon">💬</div>
          <div class="chat-empty-title">嗨，有什么可以帮你？</div>
          <div class="chat-empty-subtitle">这里是「${petNameDisplay}」的对话窗口。现在还是演示回复，之后接入 OpenCode 会话。</div>
        </div>
      </div>
      <div class="chat-composer">
        <textarea class="chat-textarea" id="chatText" rows="1" maxlength="2000" placeholder="输入消息…（Enter 发送）"></textarea>
        <button type="button" class="chat-stop-btn" id="chatStop" title="停止思考" aria-label="停止思考" hidden>
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>
        </button>
        <button type="button" class="chat-send-btn" id="chatSend" title="发送" aria-label="发送">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M12 19V5m0 0l-6 6m6-6l6 6"/></svg>
        </button>
      </div>
      <div class="chat-model-line" id="chatModelLine">当前模型：未绑定</div>
    </div>
    <div class="bubble" id="bubble"></div>
    <div class="pet-shell" id="petShell"><div class="sprite" role="img" aria-label="pet"></div></div>
  </div>
  <script>
    ${escapeHtmlText.toString()}
    ${renderMarkdownText.toString()}
    const escapeHtml = escapeHtmlText;
    const renderMarkdown = renderMarkdownText;
    const statusIcons = {
      check: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 6L9 17l-5-5"/></svg>',
      alert: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg>',
      wavingHand: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" fill-rule="evenodd" d="M4.771 1.197A.625.625 0 1 0 4.266.053a3.5 3.5 0 0 0-1.494 1.258a.625.625 0 0 0 1.04.694c.247-.37.582-.642.96-.808m8.563.739a.625.625 0 0 0-1.01.738c.244.332.399.736.427 1.18A.625.625 0 0 0 14 3.771a3.5 3.5 0 0 0-.665-1.836M2.685 7.304a.488.488 0 0 0-.904.367l.687 1.835c.229.61.566 1.173.996 1.663l.346.393a.625.625 0 1 1-.939.825l-.345-.393a6.6 6.6 0 0 1-1.228-2.05L.61 8.11a1.738 1.738 0 0 1 3.075-1.574l1.006-3.755a1.75 1.75 0 0 1 2.635-1.022a1.751 1.751 0 0 1 3.272 1.206l-.149.554a1.75 1.75 0 0 1 1.741 2.204L10.482 12.1a2.63 2.63 0 0 1-1.223 1.594l-.385.222a.625.625 0 1 1-.625-1.082l.385-.223c.316-.182.547-.483.64-.835l1.71-6.377a.5.5 0 0 0-.968-.26l-.758 2.828a.625.625 0 0 1-1.207-.323l.758-2.828l.582-2.175a.5.5 0 0 0-.967-.259l-.35 1.305L7.2 6.949a.625.625 0 0 1-1.207-.323l.874-3.263a.5.5 0 0 0-.968-.259L4.59 7.997c.567.267 1.289.753 1.732 1.522a.625.625 0 1 1-1.082.624c-.383-.66-1.163-1.043-1.53-1.15l-.033-.008a.62.62 0 0 1-.419-.372z" clip-rule="evenodd"/></svg>',
    };
    const badge = document.getElementById("bubble");
    function getStatusBadge(reaction) {
      if (reaction === "waving") return { className: "is-info", iconSvg: statusIcons.wavingHand, label: "Hi" };
      if (reaction === "success" || reaction === "celebrating") return { className: "is-success", iconSvg: statusIcons.check, label: "Done" };
      if (reaction === "error") return { className: "is-error", iconSvg: statusIcons.alert, label: "Oops" };
      if (reaction === "waiting") return { className: "is-waiting", label: "Waiting" };
      if (reaction === "thinking") return { className: "is-busy", label: "Thinking" };
      if (reaction === "working" || reaction === "running") return { className: "is-busy", label: "Working" };
      if (reaction === "editing") return { className: "is-busy", label: "Editing" };
      if (reaction === "testing") return { className: "is-busy", label: "Testing" };
      return null;
    }
    function lengthClass(text) {
      return text.length > 95 ? " is-very-long-message" : text.length > 56 ? " is-long-message" : "";
    }
    function renderBubble(payload) {
      const text = payload.message ?? "";
      const status = payload.reaction ? getStatusBadge(payload.reaction) : null;
      if (!text && !status) {
        badge.classList.remove("show");
        clearTimeout(badge._hideTimer);
        return;
      }
      let className = "bubble";
      if (!text) {
        className += " is-status-only" + (status ? " " + status.className : "");
      } else if (!status) {
        className += " is-message-only" + lengthClass(text);
      } else {
        className += " is-message " + status.className + lengthClass(text);
      }
      const header = status
        ? '<div class="bubble-header"><span class="bubble-status-icon" aria-hidden="true">' + (status.iconSvg ?? "") + '</span><span class="bubble-status-label">' + escapeHtml(status.label) + "</span></div>"
        : "";
      const divider = status && text ? '<div class="bubble-divider" aria-hidden="true"></div>' : "";
      const body = text ? '<div class="bubble-body"><span class="bubble-text">' + escapeHtml(text) + "</span></div>" : "";
      badge.className = className;
      badge.innerHTML = header + divider + body;
      badge.classList.add("show");
      clearTimeout(badge._hideTimer);
      badge._hideTimer = setTimeout(() => badge.classList.remove("show"), 3200);
    }
    badge.addEventListener("click", () => {
      clearTimeout(badge._hideTimer);
      badge.classList.remove("show");
    });
    window.openpetsDemo?.onPetState((payload) => {
      if (!payload) return;
      if (payload.state) document.documentElement.setAttribute("data-reaction-state", payload.state);
      if (payload.message !== undefined || payload.reaction) renderBubble(payload);
    });

    // --- Chat panel open/close + drag-vs-click ---
    const html = document.documentElement;
    const chatPanel = document.getElementById("chatPanel");
    const chatTranscript = document.getElementById("chatTranscript");
    const chatEmpty = document.getElementById("chatEmpty");
    const chatText = document.getElementById("chatText");
    const chatSendBtn = document.getElementById("chatSend");
    const shell = document.getElementById("petShell");

    // Closing is deferred by one animation frame plus the exit duration: the
    // window shrink is driven by the main process, so if it happens in the same
    // frame the panel visibly squeezes before disappearing.
    const CLOSE_ANIM_MS = 150;
    let closeTimer = null;
    function setChatExpanded(expanded) {
      console.log("[renderer] setChatExpanded", expanded);
      if (closeTimer !== null) { clearTimeout(closeTimer); closeTimer = null; }
      if (expanded) {
        chatPanel.classList.remove("is-closing");
        html.setAttribute("data-chat-expanded", "true");
        return;
      }
      if (!isChatExpanded()) { chatPanel.classList.remove("is-closing"); return; }
      // Keep the expanded attribute until the exit animation finishes, so the
      // panel stays laid out at full height for the fade.
      chatPanel.classList.add("is-closing");
      closeTimer = setTimeout(() => {
        closeTimer = null;
        chatPanel.classList.remove("is-closing");
        html.removeAttribute("data-chat-expanded");
      }, CLOSE_ANIM_MS);
    }
    function isChatExpanded() { return html.getAttribute("data-chat-expanded") === "true"; }

    // Rendered rows keyed by message id, so a history refresh (on panel open)
    // and the reply appended by sendCurrentText never duplicate each other.
    const renderedMessageIds = new Set();

    function addChatMessage(role, text, id) {
      if (id !== undefined) {
        if (renderedMessageIds.has(id)) return;
        renderedMessageIds.add(id);
      }
      chatEmpty.style.display = "none";
      const wrap = document.createElement("div");
      wrap.className = "chat-msg is-" + role;
      const bubbleEl = document.createElement("div");
      bubbleEl.className = "chat-msg-bubble";
      // Assistant replies are Markdown from the model; the user's own echo is
      // plain text so their formatting is never reinterpreted.
      if (role === "assistant") bubbleEl.innerHTML = renderMarkdown(text);
      else bubbleEl.textContent = text;
      wrap.appendChild(bubbleEl);
      chatTranscript.appendChild(wrap);
      chatTranscript.scrollTop = chatTranscript.scrollHeight;
    }

    let loadingHistory = false;
    async function loadChatHistory() {
      if (loadingHistory || !window.openpetsDemo?.chatHistory) return;
      loadingHistory = true;
      try {
        const result = await window.openpetsDemo.chatHistory();
        for (const entry of (result && result.messages) || []) {
          if (entry && (entry.role === "user" || entry.role === "assistant")) addChatMessage(entry.role, entry.text, entry.id);
        }
      } catch { /* history is best-effort; sending still works */ } finally {
        loadingHistory = false;
      }
    }

    const chatModelLine = document.getElementById("chatModelLine");
    async function refreshModelLine() {
      if (!chatModelLine || typeof window.openpetsDemo?.chatModel !== "function") return;
      try {
        const result = await window.openpetsDemo.chatModel();
        const label = result && typeof result.label === "string" ? result.label : "未知";
        chatModelLine.textContent = "当前模型：" + label;
      } catch {
        chatModelLine.textContent = "当前模型：读取失败";
      }
    }

    const chatStopBtn = document.getElementById("chatStop");
    function setBusy(busy) {
      chatStopBtn.hidden = !busy;
      chatStopBtn.disabled = false;
    }
    chatStopBtn.addEventListener("click", () => {
      console.log("[renderer] stop clicked");
      chatStopBtn.disabled = true;
      if (!window.openpetsDemo || typeof window.openpetsDemo.chatStop !== "function") {
        addChatMessage("assistant", "停止失败：preload 未暴露 chatStop");
        chatStopBtn.disabled = false;
        return;
      }
      Promise.resolve(window.openpetsDemo.chatStop()).then((result) => {
        if (result && result.ok) addChatMessage("assistant", "已停止思考");
        else addChatMessage("assistant", "停止失败：" + ((result && result.error) || "未知错误"));
      }).catch((error) => {
        addChatMessage("assistant", "停止失败：" + (error && error.message ? error.message : error));
      }).finally(() => {
        // Drop anything still queued: the user asked to stop.
        sendQueue.length = 0;
        setBusy(false);
        chatSendBtn.disabled = false;
        sending = false;
      });
    });

    // While a turn is running the user may keep typing. Messages are queued and
    // run one after another instead of being dropped, so the CLI never sees two
    // concurrent turns on the same session.
    let sending = false;
    const sendQueue = [];
    async function sendCurrentText(explicit) {
      const text = (typeof explicit === "string" ? explicit : chatText.value).trim();
      console.log("[renderer] sendCurrentText", JSON.stringify(text), "sending=", sending, "queued=", sendQueue.length);
      if (!text) return;
      if (typeof explicit !== "string") chatText.value = "";
      addChatMessage("user", text);
      sendQueue.push(text);
      void drainSendQueue();
    }
    async function drainSendQueue() {
      if (sending) return;
      sending = true;
      chatSendBtn.disabled = true;
      setBusy(true);
      try {
        while (sendQueue.length > 0) {
          const text = sendQueue.shift();
          if (!window.openpetsDemo || typeof window.openpetsDemo.chatSend !== "function") {
            throw new Error("preload 未暴露 chatSend（窗口可能未加载 preload）");
          }
          const result = await window.openpetsDemo.chatSend(text);
          if (result && result.ok && result.reply) addChatMessage("assistant", result.reply);
          else if (result && result.error) addChatMessage("assistant", result.error);
        }
      } catch (error) {
        addChatMessage("assistant", "发送失败：" + (error && error.message ? error.message : error));
        sendQueue.length = 0;
      } finally {
        sending = false;
        chatSendBtn.disabled = false;
        setBusy(false);
        chatText.focus();
      }
    }
    chatSendBtn.addEventListener("click", () => {
      console.log("[renderer] send button clicked");
      void sendCurrentText();
    });
    chatText.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendCurrentText();
      }
    });
    document.getElementById("chatClose").addEventListener("click", () => setChatExpanded(false));
    window.openpetsDemo?.onPanelState((payload) => {
      if (!payload || typeof payload.chatExpanded !== "boolean") return;
      setChatExpanded(payload.chatExpanded);
      if (payload.chatExpanded) {
        void loadChatHistory();
        void refreshModelLine();
      }
    });
    if (isChatExpanded()) {
      void loadChatHistory();
      void refreshModelLine();
    }
    // Exposed for manual smoke tests from DevTools: __openpetsSend("hello").
    window.__openpetsSend = (text) => sendCurrentText(text);

    // Pointer logic: a short, still press on the pet toggles the chat; moving
    // the pointer past a small threshold turns it into a window drag and
    // suppresses the click (original manual-pet-drag behavior).
    const dragThresholdPx = 6;
    let press = null;
    let suppressClickUntil = 0;
    shell.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      press = { x: event.screenX, y: event.screenY, lastX: event.screenX, lastY: event.screenY, time: Date.now(), dragged: false };
      try { shell.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
    });
    shell.addEventListener("pointermove", (event) => {
      if (!press) return;
      if (Date.now() < suppressClickUntil) return;
      const totalDx = event.screenX - press.x;
      const totalDy = event.screenY - press.y;
      if (!press.dragged && Math.hypot(totalDx, totalDy) > dragThresholdPx) press.dragged = true;
      if (press.dragged) {
        const dx = event.screenX - press.lastX;
        const dy = event.screenY - press.lastY;
        if (dx !== 0 || dy !== 0) {
          window.openpetsDemo.dragMove(dx, dy);
          press.lastX = event.screenX;
          press.lastY = event.screenY;
        }
      }
    });
    function endPress(event) {
      if (!press) return;
      const wasClick = !press.dragged && Date.now() - press.time < 600;
      press = null;
      if (wasClick && Date.now() >= suppressClickUntil) {
        suppressClickUntil = Date.now() + 150;
        window.openpetsDemo.chatToggle();
      }
    }
    shell.addEventListener("pointerup", endPress);
    // Pointer capture on a transparent window can swallow the pointerup that
    // should land on the shell, so listen on the document as a fallback.
    document.addEventListener("pointerup", endPress);
    document.addEventListener("pointercancel", endPress);
  </script>
</body>
</html>`;
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
