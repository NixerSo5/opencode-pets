/**
 * desktop-render.ts
 *
 * Pet-only transparent page for the Electron desktop pet window — mirrors the
 * original pet HTML document structure (sprite CSS + state rules), without any
 * web-demo chrome.
 */

import {
  getConfiguredSpriteStates,
  type UniversalSpriteState,
} from "./reaction-animation-mapping.js";
import { createSpriteStateCss, defaultPetLayout, type SpriteLayout } from "./browser-render.js";

/**
 * Escapes HTML-significant characters. Defined at module scope (not inside the
 * page template) so `renderMarkdownText` can be injected with toString().
 */
function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Lightweight, language-agnostic syntax highlighting for fenced code blocks.
 * `escaped` must already be HTML-escaped: this only inserts <span> tags around
 * tokens, never raw text. Kept at module scope because the regex literals below
 * contain backslashes that the page template string would eat.
 *
 * Strategy: string and comment spans are stashed behind placeholders before the
 * keyword/number passes run, so a keyword inside a string is not recoloured.
 */
function highlightCodeText(escaped: string): string {
  const stash: string[] = [];
  const keep = (html: string): string => {
    stash.push(html);
    return "\u0000HK" + (stash.length - 1) + "\u0000";
  };
  // Strings first: single quotes, double quotes and template literals. The input
  // is HTML-escaped, so quotes appear as &quot; and &#39;.
  let out = escaped.replace(
    /(&quot;(?:[^&]|&(?!quot;))*&quot;|&#39;(?:[^&]|&(?!#39;))*&#39;)/g,
    (m) => keep('<span class="tok-str">' + m + "</span>"),
  );
  // Comments: line comments for // and #, plus block comments.
  out = out.replace(
    /((?:\/\/|#)[^\n]*|\/\*[\s\S]*?\*\/)/g,
    (m) => keep('<span class="tok-comment">' + m + "</span>"),
  );
  // Keywords.
  const keywords = new RegExp(
    "\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|void|delete|yield|static|public|private|protected|interface|type|enum|namespace|implements|readonly|as|def|elif|lambda|pass|raise|with|None|True|False|null|undefined|true|false)\\b",
    "g",
  );
  out = out.replace(keywords, (m) => '<span class="tok-kw">' + m + "</span>");
  // Numbers.
  out = out.replace(/\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g, (m) => '<span class="tok-num">' + m + "</span>");
  // Restore stashed spans.
  return out.replace(/\u0000HK(\d+)\u0000/g, (_m, index: string) => stash[Number(index)] ?? "");
}

/**
 * Minimal Markdown renderer for assistant replies. Lives outside the page
 * template on purpose: its regex literals contain backslashes and backticks
 * that a template string would mangle. Injected with toString().
 */
function renderMarkdownText(source: string): string {
  const escape = escapeHtmlText;
  const fences: string[] = [];
  const tick = String.fromCharCode(96);
  const fenceRe = new RegExp(tick + tick + tick + "([^\\n" + tick + "]*)\\n([\\s\\S]*?)" + tick + tick + tick, "g");
  const codeRe = new RegExp(tick + "([^" + tick + "\\n]+)" + tick, "g");
  let text = String(source ?? "").replace(/\r\n?/g, "\n");
  text = text.replace(fenceRe, (_m: string, _lang: string, code: string) => {
    fences.push('<pre class="md-pre"><code>' + highlightCodeText(escape(code.replace(/\n$/, ""))) + "</code></pre>");
    return "%%OPENPETS_FENCE" + (fences.length - 1) + "%%";
  });
  const inline = (value: string): string =>
    value
      .replace(codeRe, (_m: string, code: string) => '<code class="md-code">' + escape(code) + "</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m: string, label: string, href: string) => '<a href="' + escape(href) + '" target="_blank" rel="noreferrer">' + label + "</a>");
  const lines = escape(text).split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length === 0) return;
    out.push("<p>" + inline(para.join("<br>")) + "</p>");
    para = [];
  };
  const closeList = () => {
    if (list === null) return;
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
      const wanted: "ul" | "ol" = bullet ? "ul" : "ol";
      if (list !== wanted) {
        closeList();
        out.push("<" + wanted + ">");
        list = wanted;
      }
      out.push("<li>" + inline((bullet || numbered)![1]) + "</li>");
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();
  return out.join("");
}

export interface PetPageOptions {
  readonly scale?: number;
  readonly waitingAnimationDurationMs?: 1010 | 2200;
  readonly spritesheetUrl?: string;
  /** 11 rows = V2 8×11 atlas (built-in Hoodie Cat); 9 rows = V1 8×9 atlas. Rows 0-8 carry the reaction states in both. */
  readonly atlasRows?: number;
  /** Display name shown in the chat panel header. */
  readonly petName?: string;
}

/** Full HTML document for the transparent pet window. */
export function createPetPageHtml(options: PetPageOptions = {}): string {
  const scale = options.scale ?? 0.75;
  const waitingMs = options.waitingAnimationDurationMs ?? 1010;
  const spritesheetUrl = options.spritesheetUrl ?? "";
  const layout: SpriteLayout = { ...defaultPetLayout, rows: options.atlasRows ?? defaultPetLayout.rows };
  const petNameDisplay = escapeHtml(options.petName?.length ? options.petName : "Pet");
  const avatarChar = escapeHtml(options.petName?.length ? options.petName.trim().slice(0, 1).toUpperCase() : "?");
  const stateRows = getConfiguredSpriteStates(waitingMs);
  const scaledLayout: SpriteLayout = {
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
  .bubble { position: absolute; right: 8px; bottom: ${shellHeight + 16}px; z-index: 4; box-sizing: border-box; display: inline-flex; flex-direction: column; width: fit-content; min-width: 92px; max-width: min(220px, calc(100vw - 18px)); max-height: 128px; padding: 10px 12px; background: linear-gradient(135deg, rgba(239, 246, 255, 0.97), rgba(237, 233, 254, 0.96)); color: #172033; font: 760 11px/14px "Segoe UI", ui-sans-serif, system-ui, sans-serif; text-align: left; border: 1px solid rgba(255, 255, 255, 0.78); border-radius: 14px; box-shadow: 0 12px 24px rgba(15, 23, 42, 0.16), 0 2px 5px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.82); white-space: normal; overflow-wrap: break-word; word-break: normal; overflow: visible; pointer-events: auto; -webkit-app-region: no-drag; opacity: 0; visibility: hidden; backdrop-filter: none; transform-origin: 100% 100%; }
  .bubble.show { opacity: 1; visibility: visible; animation: bubble-in 180ms cubic-bezier(0.2, 0, 0, 1); }
  .bubble::after { content: ""; position: absolute; right: 42px; bottom: -7px; width: 12px; height: 12px; background: inherit; border-right: 1px solid rgba(255, 255, 255, 0.56); border-bottom: 1px solid rgba(255, 255, 255, 0.56); border-bottom-right-radius: 3px; transform: rotate(45deg); box-shadow: 3px 3px 7px rgba(15, 23, 42, 0.08); }
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
  @keyframes bubble-in { from { opacity: 0; transform: translateY(4px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes status-pulse { 0%, 100% { opacity: 0.52; } 50% { opacity: 1; } }
  /* --- Chat panel (ported from pet-window-styles.ts In-Pet Attached Chat Panel) --- */
  .openpets-chat-panel { position: absolute; bottom: ${shellHeight + 18}px; right: 8px; transform-origin: 100% 100%; width: min(585px, calc(100vw - 20px)); height: min(750px, calc(100vh - ${shellHeight + 26}px)); z-index: 100; box-sizing: border-box; display: none; flex-direction: column; overflow: hidden; background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(240, 245, 255, 0.96) 55%, rgba(237, 233, 254, 0.95) 100%); color: #0f172a; border: 1px solid rgba(226, 232, 240, 0.95); border-radius: 20px; box-shadow: 0 24px 48px -12px rgba(15, 23, 42, 0.18), 0 4px 12px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 1); overflow: visible; font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif; pointer-events: auto; -webkit-app-region: no-drag; opacity: 0; color-scheme: light; }
  html[data-chat-expanded="true"] .openpets-chat-panel { display: flex; opacity: 1; animation: chat-panel-enter 220ms cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  .openpets-chat-panel::after { content: ""; position: absolute; right: 60px; bottom: -6px; width: 12px; height: 12px; background: #ede9fe; border-right: 1px solid rgba(226, 232, 240, 0.95); border-bottom: 1px solid rgba(226, 232, 240, 0.95); border-bottom-right-radius: 3px; transform: rotate(45deg); box-shadow: 3px 3px 6px rgba(15, 23, 42, 0.08); z-index: 1; }
  .chat-header { height: 64px; padding: 0 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(226, 232, 240, 0.9); border-top-left-radius: 19px; border-top-right-radius: 19px; background: rgba(248, 250, 252, 0.8); flex-shrink: 0; user-select: none; }
  .chat-header-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .chat-avatar { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; color: #fff; flex-shrink: 0; background: linear-gradient(135deg, #3b82f6, #8b5cf6); }
  .chat-title { font-size: 18px; font-weight: 780; color: #0f172a; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .chat-close-btn { width: 26px; height: 26px; border-radius: 50%; border: none; background: transparent; color: #64748b; display: flex; align-items: center; justify-content: center; cursor: pointer; pointer-events: auto; -webkit-app-region: no-drag; transition: all 140ms ease; font-size: 13px; font-weight: 700; }
  .chat-close-btn:hover { background: rgba(148, 163, 184, 0.16); color: #0f172a; }
  .chat-transcript { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 13px; scrollbar-width: thin; scrollbar-color: rgba(148, 163, 184, 0.35) transparent; overscroll-behavior: contain; }
  .chat-transcript::-webkit-scrollbar { width: 5px; }
  .chat-transcript::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.3); border-radius: 99px; }
  .chat-ask { flex: 0 0 auto; margin: 0 14px 10px; padding: 12px 14px; border-radius: 14px; background: linear-gradient(135deg, rgba(238, 242, 255, 0.98), rgba(245, 243, 255, 0.98)); border: 1px solid rgba(199, 210, 254, 0.9); box-shadow: 0 6px 16px -8px rgba(30, 64, 175, 0.25); max-height: 40vh; overflow-y: auto; scrollbar-width: thin; }
  .chat-ask[hidden] { display: none; }
  .chat-ask-title { font: 700 12px/16px "Segoe UI", ui-sans-serif, system-ui, sans-serif; color: #3730a3; margin-bottom: 6px; }
  .chat-ask-question { font: 600 12px/17px "Segoe UI", ui-sans-serif, system-ui, sans-serif; color: #1e293b; margin: 8px 0 6px; white-space: pre-wrap; }
  .chat-ask-hint { font: 400 11px/15px "Segoe UI", ui-sans-serif, system-ui, sans-serif; color: #64748b; margin-bottom: 6px; }
  .chat-ask-option { display: block; width: 100%; text-align: left; margin: 4px 0; padding: 7px 10px; border-radius: 10px; border: 1px solid rgba(165, 180, 252, 0.85); background: #ffffff; color: #1e293b; font: 600 12px/16px "Segoe UI", ui-sans-serif, system-ui, sans-serif; cursor: pointer; transition: background 120ms ease, border-color 120ms ease, transform 120ms ease; }
  .chat-ask-option:hover { background: #eef2ff; border-color: #818cf8; transform: translateX(1px); }
  .chat-ask-option[data-picked="true"] { background: #eef2ff; border-color: #4f46e5; }
  .chat-ask-option-desc { display: block; margin-top: 2px; font-weight: 400; font-size: 11px; line-height: 15px; color: #64748b; }
  .chat-ask-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 8px; }
  .chat-ask-submit { flex: 1 1 auto; margin: 0; padding: 8px 10px; border: none; border-radius: 10px; background: #6366f1; color: #ffffff; font: 600 12px/16px "Segoe UI", ui-sans-serif, system-ui, sans-serif; cursor: pointer; transition: background 120ms ease; }
  .chat-ask-submit:hover { background: #4f46e5; }
  .chat-copy-btn { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 1px solid rgba(148, 163, 184, 0.55); border-radius: 8px; background: rgba(255, 255, 255, 0.9); color: #475569; cursor: pointer; transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
  .chat-copy-btn:hover { background: #eef2ff; border-color: #818cf8; color: #4338ca; }
  .chat-copy-btn[data-copied="true"] { background: #dcfce7; border-color: #4ade80; color: #15803d; }
  .chat-copy-btn svg { display: block; }
  .chat-msg-copy { align-self: flex-end; margin-top: 4px; }
  .chat-msg.is-user .chat-msg-copy { align-self: flex-end; }
  .chat-ask-custom { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .chat-ask-custom-input { flex: 1 1 auto; min-width: 0; padding: 7px 10px; border-radius: 10px; border: 1px solid rgba(165, 180, 252, 0.85); background: #ffffff; color: #1e293b; font: 500 12px/16px "Segoe UI", ui-sans-serif, system-ui, sans-serif; outline: none; transition: border-color 120ms ease; }
  .chat-ask-custom-input:focus { border-color: #6366f1; }
  .chat-ask-custom-input::placeholder { color: #94a3b8; }
  .chat-empty { margin: auto 0; text-align: center; padding: 20px 10px; display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .chat-empty-icon { font-size: 28px; line-height: 1; margin-bottom: 2px; }
  .chat-empty-title { font-size: 13px; font-weight: 780; color: #0f172a; }
  .chat-empty-subtitle { font-size: 11px; color: #64748b; max-width: 240px; line-height: 1.4; }
  .chat-msg { display: flex; flex-direction: column; max-width: 88%; animation: msg-appear 160ms cubic-bezier(0.16, 1, 0.3, 1) forwards; }
  .chat-msg.is-user { align-self: flex-end; }
  .chat-msg.is-assistant { align-self: flex-start; max-width: 92%; }
  .chat-msg-bubble { padding: 11px 16px; font-size: 16px; line-height: 23px; word-break: break-word; white-space: pre-wrap; user-select: text; -webkit-user-select: text; cursor: text; }
  .chat-msg { position: relative; }
  .chat-msg.is-user .chat-msg-bubble { background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; border-radius: 14px 14px 2px 14px; box-shadow: 0 2px 6px rgba(37, 99, 235, 0.22); }
  .chat-msg.is-assistant .chat-msg-bubble { background: #ffffff; border: 1px solid rgba(226, 232, 240, 0.95); color: #1e293b; border-radius: 14px 14px 14px 2px; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.04); }
  .chat-msg-bubble > :first-child { margin-top: 0; }
  .chat-msg-bubble > :last-child { margin-bottom: 0; }
  .chat-msg-bubble p { margin: 0 0 7px; }
  .chat-msg-bubble h3, .chat-msg-bubble h4, .chat-msg-bubble h5 { margin: 12px 0 6px; font-size: 16.5px; line-height: 1.35; font-weight: 760; }
  .chat-msg-bubble ul, .chat-msg-bubble ol { margin: 0 0 7px; padding-left: 18px; }
  .chat-msg-bubble li { margin: 2px 0; }
  .chat-msg-bubble li > p { margin: 0; }
  .chat-msg-bubble a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
  .chat-msg-bubble .md-code { padding: 1px 5px; border-radius: 4px; background: rgba(148, 163, 184, 0.18); font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 15px; }
  .chat-msg-bubble .md-pre { margin: 0 0 9px; padding: 11px 14px; border-radius: 10px; background: #0f172a; color: #e2e8f0; overflow-x: auto; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 15px; line-height: 1.5; user-select: text; -webkit-user-select: text; }
  .chat-msg-bubble .md-pre code { font: inherit; white-space: pre; }
  .chat-msg-bubble .md-pre .tok-kw { color: #c792ea; }
  .chat-msg-bubble .md-pre .tok-str { color: #c3e88d; }
  .chat-msg-bubble .md-pre .tok-comment { color: #7f8c98; font-style: italic; }
  .chat-msg-bubble .md-pre .tok-num { color: #f78c6c; }
  .chat-composer { padding: 13px 20px 10px; border-top: 1px solid rgba(226, 232, 240, 0.9); background: rgba(248, 250, 252, 0.85); display: flex; align-items: flex-end; gap: 8px; flex: 0 0 auto; }
  .chat-textarea { flex: 1 1 auto; min-width: 0; min-height: 58px; max-height: 176px; padding: 14px 16px; box-sizing: border-box; border: 1px solid rgba(203, 213, 225, 0.9); border-radius: 14px; background: #ffffff; color: #0f172a; font-family: inherit; font-size: 17px; line-height: 25px; resize: none; outline: none; pointer-events: auto; -webkit-app-region: no-drag; box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.03); transition: border-color 140ms ease, box-shadow 140ms ease; }
  .chat-textarea:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2), inset 0 1px 2px rgba(15, 23, 42, 0.03); }
  .chat-textarea::placeholder { color: #94a3b8; }
  .chat-send-btn { width: 52px; height: 52px; border-radius: 13px; border: none; display: flex; align-items: center; justify-content: center; flex-shrink: 0; cursor: pointer; pointer-events: auto; -webkit-app-region: no-drag; background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); color: #ffffff; box-shadow: 0 2px 5px rgba(37, 99, 235, 0.28); transition: all 140ms ease; }
  .chat-stop-btn { width: 52px; height: 52px; border-radius: 13px; border: none; display: flex; align-items: center; justify-content: center; flex-shrink: 0; cursor: pointer; pointer-events: auto; -webkit-app-region: no-drag; background: linear-gradient(135deg, #f43f5e 0%, #e11d48 100%); color: #ffffff; box-shadow: 0 2px 5px rgba(225, 29, 72, 0.28); transition: all 140ms ease; }
  .chat-stop-btn:hover { background: linear-gradient(135deg, #e11d48 0%, #be123c 100%); box-shadow: 0 3px 8px rgba(225, 29, 72, 0.35); transform: scale(1.02); }
  .chat-stop-btn:disabled { background: rgba(203, 213, 225, 0.45); color: #94a3b8; box-shadow: none; cursor: not-allowed; transform: none; }
  .chat-stop-btn svg { width: 17px; height: 17px; }
  .chat-stop-btn[hidden] { display: none; }
  .chat-send-btn:hover { background: linear-gradient(135deg, #1d4ed8 0%, #1e40af 100%); box-shadow: 0 3px 8px rgba(37, 99, 235, 0.35); transform: scale(1.02); }
  .chat-send-btn:disabled { background: rgba(203, 213, 225, 0.45); color: #94a3b8; box-shadow: none; cursor: not-allowed; transform: none; }
  .chat-send-btn svg { width: 20px; height: 20px; }
  .chat-model-line { flex: 0 0 auto; padding: 10px 20px 14px; font-size: 13px; line-height: 18px; color: #64748b; border-bottom-left-radius: 19px; border-bottom-right-radius: 19px; background: rgba(248, 250, 252, 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none; }
  @keyframes chat-panel-enter { from { opacity: 0; transform: translateY(8px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes msg-appear { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  /* The pet is anchored to the window's bottom-right corner, not centred.
     Expanding the window grows it left/up, so the pet keeps its screen
     position while the panel gets its extra room. */
  .pet-shell {
    position: absolute; right: 8px; bottom: 8px;
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
          <span class="chat-title" id="chatTitle">${petNameDisplay}</span>
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
      <div class="chat-ask" id="chatAsk" hidden></div>
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
    ${highlightCodeText.toString()}
    ${renderMarkdownText.toString()}
    const escapeHtml = escapeHtmlText;
    const renderMarkdown = renderMarkdownText;
    const statusIcons = {
      check: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 6L9 17l-5-5"/></svg>',
      alert: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg>',
      wavingHand: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><path fill="currentColor" fill-rule="evenodd" d="M4.771 1.197A.625.625 0 1 0 4.266.053a3.5 3.5 0 0 0-1.494 1.258a.625.625 0 0 0 1.04.694c.247-.37.582-.642.96-.808m8.563.739a.625.625 0 0 0-1.01.738c.244.332.399.736.427 1.18A.625.625 0 0 0 14 3.771a3.5 3.5 0 0 0-.665-1.836M2.685 7.304a.488.488 0 0 0-.904.367l.687 1.835c.229.61.566 1.173.996 1.663l.346.393a.625.625 0 1 1-.939.825l-.345-.393a6.6 6.6 0 0 1-1.228-2.05L.61 8.11a1.738 1.738 0 0 1 3.075-1.574l1.006-3.755a1.75 1.75 0 0 1 2.635-1.022a1.751 1.751 0 0 1 3.272 1.206l-.149.554a1.75 1.75 0 0 1 1.741 2.204L10.482 12.1a2.63 2.63 0 0 1-1.223 1.594l-.385.222a.625.625 0 1 1-.625-1.082l.385-.223c.316-.182.547-.483.64-.835l1.71-6.377a.5.5 0 0 0-.968-.26l-.758 2.828a.625.625 0 0 1-1.207-.323l.758-2.828l.582-2.175a.5.5 0 0 0-.967-.259l-.35 1.305L7.2 6.949a.625.625 0 0 1-1.207-.323l.874-3.263a.5.5 0 0 0-.968-.259L4.59 7.997c.567.267 1.289.753 1.732 1.522a.625.625 0 1 1-1.082.624c-.383-.66-1.163-1.043-1.53-1.15l-.033-.008a.62.62 0 0 1-.419-.372z" clip-rule="evenodd"/></svg>',
    };
    // Clipboard icon for the per-card copy button. Renderers cannot use the
    // async clipboard API here (file:// is a non-secure context), so the click
    // goes through the preload bridge into the main process.
    const copyIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const checkIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
    // Copy the given text to the OS clipboard and flash a check on the button.
    // The button is passed in so the same helper serves message bubbles and
    // the ask card.
    function copyCardText(button, text) {
      const value = typeof text === "string" ? text : "";
      if (value.length === 0 || typeof window.openpetsDemo?.copyText !== "function") return;
      Promise.resolve(window.openpetsDemo.copyText(value)).then((result) => {
        if (!result || !result.ok) return;
        button.innerHTML = checkIconSvg;
        button.setAttribute("data-copied", "true");
        clearTimeout(button._resetTimer);
        button._resetTimer = setTimeout(() => {
          button.innerHTML = copyIconSvg;
          button.removeAttribute("data-copied");
        }, 1200);
      }).catch(() => undefined);
    }
    function createCopyButton(className, getText) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.title = "复制";
      button.setAttribute("aria-label", "复制这条内容");
      button.innerHTML = copyIconSvg;
      button.addEventListener("click", (event) => {
        // Never let the click bubble into the pet drag/click handler.
        event.stopPropagation();
        copyCardText(button, getText());
      });
      return button;
    }
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

    // Closing is instantaneous on purpose. Any intermediate state (fade, slide)
    // leaves the panel painted while the main process shrinks the window, which
    // reads as a flicker; a hard cut never shows that frame.
    function setChatExpanded(expanded) {
      console.log("[renderer] setChatExpanded", expanded);
      chatPanel.classList.remove("is-closing");
      if (expanded) html.setAttribute("data-chat-expanded", "true");
      else html.removeAttribute("data-chat-expanded");
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
      // A model reply means the pending question was answered or superseded,
      // so the ask card has no reason to stay pinned above the transcript.
      if (role === "assistant" && chatAsk) chatAsk.hidden = true;
      const wrap = document.createElement("div");
      wrap.className = "chat-msg is-" + role;
      const bubbleEl = document.createElement("div");
      bubbleEl.className = "chat-msg-bubble";
      // Assistant replies are Markdown from the model; the user's own echo is
      // plain text so their formatting is never reinterpreted.
      if (role === "assistant") bubbleEl.innerHTML = renderMarkdown(text);
      else bubbleEl.textContent = text;
      wrap.appendChild(bubbleEl);
      // Every card carries its own copy button in the bottom-right corner; the
      // copied text is the message body, not the rendered HTML.
      wrap.appendChild(createCopyButton("chat-copy-btn chat-msg-copy", () => text));
      chatTranscript.appendChild(wrap);
      chatTranscript.scrollTop = chatTranscript.scrollHeight;
    }

    let loadingHistory = false;
    async function loadChatHistory() {
      if (loadingHistory || !window.openpetsDemo?.chatHistory) return;
      loadingHistory = true;
      try {
        const result = await window.openpetsDemo.chatHistory();
        const messages = (result && result.messages) || [];
        // Rebuild instead of appending: every panel open ran this again and
        // stacked a second copy of the whole transcript on top of the live
        // rows (which carry no message ids and so can never dedupe).
        renderedMessageIds.clear();
        chatTranscript.innerHTML = "";
        if (messages.length === 0) chatEmpty.style.display = "";
        // The header shows which OpenCode session the pet is bound to, not the
        // pet's own name; fall back to the pet name when no session is bound.
        const title = result && typeof result.sessionTitle === "string" ? result.sessionTitle.trim() : "";
        if (title.length > 0) {
          const titleEl = document.getElementById("chatTitle");
          if (titleEl) titleEl.textContent = title;
        }
        for (const entry of messages) {
          // Interrupted turns can leave assistant messages with no text; those
          // would render as empty bubbles, so skip them.
          if (typeof entry?.text !== "string" || entry.text.trim().length === 0) continue;
          if (entry.role === "user" || entry.role === "assistant") addChatMessage(entry.role, entry.text, entry.id);
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
      // Session switches push the new title with the panel state, so the header
      // stays correct without waiting for a history round-trip.
      if (typeof payload.sessionTitle === "string" && payload.sessionTitle.trim().length > 0) {
        const titleEl = document.getElementById("chatTitle");
        if (titleEl) titleEl.textContent = payload.sessionTitle.trim();
      }
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
    // --- ask cards: the question tool call rendered as clickable options ---
    const chatAsk = document.getElementById("chatAsk");
    let askCounter = 0;
    // Render one AskEvent. Clicking an option sends its label as the next user
    // message, which is how the CLI resumes the paused turn.
    function renderAsk(ask) {
      if (!chatAsk || !ask || !Array.isArray(ask.questions) || ask.questions.length === 0) return;
      // A new ask replaces whatever was on screen. Only clearing while hidden
      // would append a second card under the old one whenever the panel was
      // already open (title + options appear doubled).
      chatAsk.hidden = false;
      chatAsk.innerHTML = "";
      const title = document.createElement("div");
      title.className = "chat-ask-title";
      title.textContent = "AI 需要你确认";
      chatAsk.appendChild(title);
      // OpenCode's own dock answers the whole form in one submit, however
      // many questions it carries. Mirror that: every question keeps a local
      // selection (option label or typed text), and one submit button at the
      // bottom turns all of them into the single follow-up prompt, in order,
      // so a multi-question call never fans out into several CLI turns.
      const chosen = new Array(ask.questions.length).fill(null);
      ask.questions.forEach((question, questionIndex) => {
        if (!question || typeof question.question !== "string") return;
        const header = document.createElement("div");
        header.className = "chat-ask-question";
        header.textContent =
          (ask.questions.length > 1 ? questionIndex + 1 + ". " : "") +
          (question.header ? question.header + "：" : "") +
          question.question;
        chatAsk.appendChild(header);
        if (question.multiple) {
          const hint = document.createElement("div");
          hint.className = "chat-ask-hint";
          hint.textContent = "可多选（逐项点击即可发送）";
          chatAsk.appendChild(hint);
        }
        for (const option of question.options || []) {
          if (!option || typeof option.label !== "string") continue;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "chat-ask-option";
          const label = document.createElement("span");
          label.textContent = option.label;
          button.appendChild(label);
          if (typeof option.description === "string" && option.description.length > 0) {
            const desc = document.createElement("span");
            desc.className = "chat-ask-option-desc";
            desc.textContent = option.description;
            button.appendChild(desc);
          }
          button.addEventListener("click", () => {
            // Highlight the pick instead of sending: the submit button sends
            // every answer of this card in one message. A form reply wants the
            // option's server-side value when it has one, so prefer that.
            chosen[questionIndex] = typeof option.value === "string" && option.value.length > 0 ? option.value : option.label;
            for (const sibling of chatAsk.querySelectorAll(".chat-ask-option[data-picked]")) sibling.removeAttribute("data-picked");
            button.setAttribute("data-picked", "true");
          });
          chatAsk.appendChild(button);
        }
        // OpenCode's question form always adds a free-form "type your own
        // answer" row (field custom), including questions with no preset
        // options; mirror it so open questions stay answerable here too.
        const customHint = document.createElement("div");
        customHint.className = "chat-ask-hint";
        customHint.textContent = (question.options || []).length === 0 ? "没有预置选项，直接输入你的答案：" : "也可以直接输入自己的答案：";
        customHint.style.marginTop = "8px";
        chatAsk.appendChild(customHint);
        const customRow = document.createElement("div");
        customRow.className = "chat-ask-custom";
        const customInput = document.createElement("input");
        customInput.type = "text";
        customInput.className = "chat-ask-custom-input";
        customInput.placeholder = "输入你的答案…";
        customInput.addEventListener("input", () => {
          // A typed answer beats a highlighted option for this question.
          const value = customInput.value.trim();
          if (value.length > 0) {
            chosen[questionIndex] = value;
            for (const sibling of chatAsk.querySelectorAll(".chat-ask-option[data-picked]")) sibling.removeAttribute("data-picked");
          } else {
            chosen[questionIndex] = null;
          }
        });
        customInput.addEventListener("keydown", (event) => {
          // Enter inside any input submits the whole card, like the web dock.
          if (event.key === "Enter") { event.preventDefault(); submit.click(); }
        });
        customRow.appendChild(customInput);
        chatAsk.appendChild(customRow);
      });
      // One submit for the whole card: answers collapse into a single ordered
      // follow-up prompt, matching how the web dock replies to the form once.
      const submit = document.createElement("button");
      submit.type = "button";
      submit.className = "chat-ask-submit";
      const answerCount = () => chosen.filter((value) => value !== null).length;
      const refreshSubmit = () => {
        submit.textContent = "提交答案";
      };
      refreshSubmit();
      submit.addEventListener("click", () => {
        if (answerCount() === 0) return;
        const answers = ask.questions.map((question, questionIndex) =>
          typeof question?.question === "string" ? (chosen[questionIndex] ?? "") : "",
        );
        if (chatAsk) { chatAsk.hidden = true; chatAsk.innerHTML = ""; }
        // Plan A: when the ask came from the SSE form event the agent is
        // genuinely parked on the form, so answer it directly — one reply
        // covers every field and the loop resumes where it stopped. Without a
        // form id this is the CLI fallback, which has to send a follow-up
        // prompt instead.
        if (typeof ask.formID === "string" && ask.formID.length > 0 && typeof window.openpetsDemo?.askReply === "function") {
          void window.openpetsDemo.askReply({ formID: ask.formID, answers });
          return;
        }
        const lines = [];
        ask.questions.forEach((question, questionIndex) => {
          if (!question || typeof question.question !== "string") return;
          lines.push(
            (lines.length + 1) + ". " + question.question + "：" + (chosen[questionIndex] ?? "(未回答)"),
          );
        });
        // The newline is built at runtime: injecting scripts unescapes
        // backslash sequences, and a real LF inside a string literal breaks
        // the whole page with a SyntaxError (the pet then stops responding).
        const newline = String.fromCharCode(10);
        void sendCurrentText("回答你的问题：" + newline + lines.join(newline));
      });
      const footer = document.createElement("div");
      footer.className = "chat-ask-footer";
      footer.appendChild(submit);
      // Same copy affordance as the message cards: the ask itself, rendered as
      // readable question/answer lines.
      footer.appendChild(createCopyButton("chat-copy-btn", () => {
        const lines = [];
        ask.questions.forEach((question, questionIndex) => {
          if (!question || typeof question.question !== "string") return;
          lines.push(
            (lines.length + 1) + ". " + (question.header ? question.header + "：" : "") + question.question +
              " -> " + (chosen[questionIndex] ?? "(未回答)"),
          );
        });
        return lines.join(String.fromCharCode(10));
      }));
      chatAsk.appendChild(footer);
      askCounter += 1;
      console.log("[renderer] ask rendered", askCounter, (ask.questions || []).length);
      chatTranscript.scrollTop = chatTranscript.scrollHeight;
    }
    window.openpetsDemo?.onAsk((ask) => {
      // The panel may be collapsed when the ask arrives; open it so the user sees
      // the options instead of a silently paused turn.
      if (!isChatExpanded()) window.openpetsDemo.chatToggle();
      renderAsk(ask);
    });

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

/** Types over the states the desktop pet cycles through. */
export type PetDemoState = UniversalSpriteState;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
