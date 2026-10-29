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
export function escapeHtmlText(value) {
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
export function highlightCodeText(escaped) {
    const stash = [];
    const keep = (html) => {
        stash.push(html);
        return "\u0000HK" + (stash.length - 1) + "\u0000";
    };
    // Strings first: single quotes, double quotes and template literals. The input
    // is HTML-escaped, so quotes appear as &quot; and &#39;.
    let out = escaped.replace(/(&quot;(?:[^&]|&(?!quot;))*&quot;|&#39;(?:[^&]|&(?!#39;))*&#39;)/g, (m) => keep('<span class="tok-str">' + m + "</span>"));
    // Comments: line comments for // and #, plus block comments.
    out = out.replace(/((?:\/\/|#)[^\n]*|\/\*[\s\S]*?\*\/)/g, (m) => keep('<span class="tok-comment">' + m + "</span>"));
    // Keywords.
    const keywords = new RegExp("\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|void|delete|yield|static|public|private|protected|interface|type|enum|namespace|implements|readonly|as|def|elif|lambda|pass|raise|with|None|True|False|null|undefined|true|false)\\b", "g");
    out = out.replace(keywords, (m) => '<span class="tok-kw">' + m + "</span>");
    // Numbers.
    out = out.replace(/\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g, (m) => '<span class="tok-num">' + m + "</span>");
    // Restore stashed spans.
    return out.replace(/\u0000HK(\d+)\u0000/g, (_m, index) => stash[Number(index)] ?? "");
}
/**
 * Minimal Markdown renderer for assistant replies. Lives outside the page
 * template on purpose: its regex literals contain backslashes and backticks
 * that a template string would mangle. Injected with toString().
 */
export function renderMarkdownText(source) {
    const escape = escapeHtmlText;
    const fences = [];
    const tick = String.fromCharCode(96);
    const fenceRe = new RegExp(tick + tick + tick + "([^\\n" + tick + "]*)\\n([\\s\\S]*?)" + tick + tick + tick, "g");
    const codeRe = new RegExp(tick + "([^" + tick + "\\n]+)" + tick, "g");
    let text = String(source ?? "").replace(/\r\n?/g, "\n");
    text = text.replace(fenceRe, (_m, _lang, code) => {
        fences.push('<pre class="md-pre"><code>' + highlightCodeText(escape(code.replace(/\n$/, ""))) + "</code></pre>");
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
        // Markdown tables: a row of `| a | b |` followed by a `|---|` separator.
        if (line.includes("|") && line.trimStart().startsWith("|")) {
            const isSeparator = (value) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(value);
            if (isSeparator(line) && out.length > 0 && out[out.length - 1].startsWith("<table")) {
                continue;
            }
            const splitRow = (value) => {
                const trimmed = value.trim().replace(/^\|/, "").replace(/\|$/, "");
                return trimmed.split("|").map((cell) => cell.trim());
            };
            const nextLine = lines[lines.indexOf(raw) + 1];
            const startsTable = nextLine !== undefined && isSeparator(nextLine);
            if (startsTable) {
                flushPara();
                closeList();
                const headers = splitRow(line);
                out.push("<table class=\"md-table\"><thead><tr>" + headers.map((cell) => "<th>" + inline(cell) + "</th>").join("") + "</tr></thead><tbody>");
                continue;
            }
            if (out.length > 0 && out[out.length - 1].startsWith("<table")) {
                const cells = splitRow(line);
                out[out.length - 1] += "<tr>" + cells.map((cell) => "<td>" + inline(cell) + "</td>").join("") + "</tr>";
                continue;
            }
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
  /* Speech bubble — light gradient card above the pet with a bottom tail,
     optional status badge header, and a bubble-in entrance animation. The
     carrier window reserves a strip above the sprite for it (see
     BUBBLE_STRIP_HEIGHT in electron-main.ts), and the max-height keeps long
     messages inside that strip so the top edge is never clipped. */
  .bubble { position: absolute; right: 8px; bottom: ${shellHeight + 16}px; z-index: 4; box-sizing: border-box; display: inline-flex; flex-direction: column; width: fit-content; min-width: 92px; max-width: min(220px, calc(100vw - 18px)); max-height: calc(100vh - ${shellHeight + 24}px); padding: 10px 12px; background: linear-gradient(135deg, rgba(239, 246, 255, 0.97), rgba(237, 233, 254, 0.96)); color: #172033; font: 760 11px/14px "Segoe UI", ui-sans-serif, system-ui, sans-serif; text-align: left; border: 1px solid rgba(255, 255, 255, 0.78); border-radius: 14px; box-shadow: 0 12px 24px rgba(15, 23, 42, 0.16), 0 2px 5px rgba(15, 23, 42, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.82); white-space: normal; overflow-wrap: break-word; word-break: normal; overflow: visible; pointer-events: auto; -webkit-app-region: no-drag; opacity: 0; visibility: hidden; backdrop-filter: none; transform-origin: 100% 100%; }
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
  .bubble.is-long-message { max-width: min(220px, calc(100vw - 18px)); max-height: calc(100vh - ${shellHeight + 24}px); }
  .bubble.is-very-long-message { max-width: min(220px, calc(100vw - 18px)); max-height: calc(100vh - ${shellHeight + 24}px); }
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

    const shell = document.getElementById("petShell");

    // Pointer logic: a short, still press anywhere in the window toggles the
    // chat; moving the pointer past a small threshold turns it into a window
    // drag and suppresses the click (original manual-pet-drag behavior).
    //
    // The listeners live on the document rather than on the pet shell: the
    // carrier window reserves a strip above the sprite for the bubble, and
    // clicks in that transparent strip (or on any transparent pixel of the
    // sprite) would otherwise never reach the shell, so tapping the pet
    // appeared dead. Drag is still only armed when the press starts on the
    // sprite, otherwise a click near the bubble could drag the pet.
    const dragThresholdPx = 6;
    let press = null;
    let suppressClickUntil = 0;
    document.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (Date.now() < suppressClickUntil) return;
      // Clicks on the bubble dismiss it and must not toggle the panel.
      if (badge.contains(event.target)) return;
      const onSprite = shell.contains(event.target);
      press = {
        x: event.screenX,
        y: event.screenY,
        lastX: event.screenX,
        lastY: event.screenY,
        time: Date.now(),
        dragged: false,
        canDrag: onSprite,
      };
      if (onSprite) {
        try { shell.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
      }
    });
    document.addEventListener("pointermove", (event) => {
      if (!press) return;
      if (!press.canDrag) return;
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
      const wasDrag = press.dragged;
      const wasClick = !wasDrag && Date.now() - press.time < 600;
      press = null;
      if (wasDrag) {
        // Tell main the drag is over so it stops showing the run pose and can
        // resume the idle walk-about ticker.
        window.openpetsDemo.dragEnd?.();
        return;
      }
      if (wasClick && Date.now() >= suppressClickUntil) {
        suppressClickUntil = Date.now() + 150;
        window.openpetsDemo.chatToggle();
      }
    }
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
