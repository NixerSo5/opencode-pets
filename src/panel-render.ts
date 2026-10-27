/**
 * panel-render.ts
 *
 * HTML for the standalone chat panel window. The panel is its own BrowserWindow
 * anchored next to the pet (Ant Design Popconfirm model), so the pet window
 * never resizes or moves when the chat opens.
 */

import { escapeHtmlText, highlightCodeText, renderMarkdownText } from "./desktop-render.js";

export interface PanelPageOptions {
  /** Display name used as the placeholder header until the session title arrives. */
  readonly petName?: string;
}

export function createPanelPageHtml(options: PanelPageOptions = {}): string {
  const petNameDisplay = escapeHtmlText(options.petName?.length ? options.petName : "Pet");
  const avatarChar = escapeHtmlText(options.petName?.length ? options.petName.trim().slice(0, 1).toUpperCase() : "?");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<title>OpenPets chat</title>
<style>
  html, body { width: 100%; height: 100%; margin: 0; background: transparent; overflow: hidden; }
  body { font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
  .openpets-chat-panel { position: absolute; inset: 0; display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden; background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(240, 245, 255, 0.96) 55%, rgba(237, 233, 254, 0.95) 100%); color: #0f172a; border: 1px solid rgba(226, 232, 240, 0.95); border-radius: 20px; box-shadow: 0 24px 48px -12px rgba(15, 23, 42, 0.18), 0 4px 12px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 1); color-scheme: light; }
  .chat-header { height: 64px; padding: 0 20px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid rgba(226, 232, 240, 0.9); border-top-left-radius: 19px; border-top-right-radius: 19px; background: rgba(248, 250, 252, 0.8); flex-shrink: 0; user-select: none; -webkit-app-region: drag; }
  .chat-header-left { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .chat-avatar { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; color: #fff; flex-shrink: 0; background: linear-gradient(135deg, #3b82f6, #8b5cf6); }
  .chat-title { font-size: 18px; font-weight: 780; color: #0f172a; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .chat-close-btn { width: 26px; height: 26px; border-radius: 50%; border: none; background: transparent; color: #64748b; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 140ms ease; font-size: 13px; font-weight: 700; -webkit-app-region: no-drag; }
  .chat-close-btn:hover { background: rgba(148, 163, 184, 0.16); color: #0f172a; }
  .chat-transcript { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 13px; scrollbar-width: thin; scrollbar-color: rgba(148, 163, 184, 0.35) transparent; overscroll-behavior: contain; }
  .chat-transcript::-webkit-scrollbar { width: 5px; }
  .chat-transcript::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.3); border-radius: 99px; }
  .chat-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 8px; color: #94a3b8; text-align: center; }
  .chat-empty-icon { font-size: 34px; }
  .chat-empty-title { font-size: 15px; font-weight: 700; color: #64748b; }
  .chat-empty-subtitle { font-size: 12px; line-height: 18px; max-width: 260px; }
  .chat-msg { display: flex; flex-direction: column; gap: 4px; animation: msg-appear 180ms ease; }
  .chat-msg.is-user { align-items: flex-end; }
  .chat-msg.is-assistant { align-items: flex-start; }
  .chat-msg-bubble { max-width: 88%; padding: 10px 14px; border-radius: 14px; font-size: 13px; line-height: 19px; white-space: pre-wrap; overflow-wrap: break-word; word-break: break-word; user-select: text; }
  .chat-msg.is-user .chat-msg-bubble { background: linear-gradient(135deg, #3b82f6, #6366f1); color: #fff; border-bottom-right-radius: 4px; }
  .chat-msg.is-assistant .chat-msg-bubble { background: #fff; color: #1e293b; border: 1px solid rgba(226, 232, 240, 0.9); border-bottom-left-radius: 4px; }
  .chat-msg-bubble p { margin: 0 0 8px; }
  .chat-msg-bubble p:last-child { margin-bottom: 0; }
  .chat-msg-bubble pre { margin: 8px 0; padding: 10px; border-radius: 8px; background: #0f172a; color: #e2e8f0; overflow-x: auto; font-size: 11.5px; line-height: 16px; }
  .chat-msg-bubble code { font-family: "Cascadia Code", Consolas, monospace; font-size: 11.5px; }
  .chat-msg-bubble :not(pre) > code { padding: 1px 5px; border-radius: 5px; background: rgba(148, 163, 184, 0.18); }
  .chat-msg-bubble ul, .chat-msg-bubble ol { margin: 6px 0; padding-left: 20px; }
  .chat-msg-bubble h1, .chat-msg-bubble h2, .chat-msg-bubble h3 { margin: 8px 0 6px; font-size: 14px; }
  .chat-copy-btn { align-self: flex-end; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: 6px; background: transparent; color: #94a3b8; cursor: pointer; opacity: 0.65; transition: all 120ms ease; }
  .chat-copy-btn:hover { opacity: 1; background: rgba(148, 163, 184, 0.16); color: #475569; }
  .chat-copy-btn[data-copied="true"] { color: #10b981; opacity: 1; }
  .chat-ask { flex: 0 0 auto; margin: 0 14px 10px; padding: 12px 14px; border-radius: 14px; background: linear-gradient(135deg, rgba(238, 242, 255, 0.98), rgba(245, 243, 255, 0.98)); border: 1px solid rgba(199, 210, 254, 0.9); box-shadow: 0 6px 16px -8px rgba(30, 64, 175, 0.25); max-height: 40vh; overflow-y: auto; scrollbar-width: thin; }
  .chat-ask[hidden] { display: none; }
  .chat-ask-title { font: 700 12px/16px "Segoe UI", ui-sans-serif, system-ui, sans-serif; color: #3730a3; margin-bottom: 6px; }
  .chat-ask-question { font: 600 12px/17px "Segoe UI", ui-sans-serif, system-ui, sans-serif; color: #1e293b; margin: 8px 0 6px; white-space: pre-wrap; }
  .chat-ask-hint { font: 400 11px/15px "Segoe UI", ui-sans-serif, system-ui, sans-serif; color: #64748b; margin-bottom: 6px; }
  .chat-ask-option { display: block; width: 100%; text-align: left; margin: 4px 0; padding: 7px 10px; border-radius: 10px; border: 1px solid rgba(165, 180, 252, 0.85); background: #ffffff; color: #1e293b; font: 600 12px/16px "Segoe UI", ui-sans-serif, system-ui, sans-serif; cursor: pointer; transition: background 120ms ease, border-color 120ms ease, transform 120ms ease; }
  .chat-ask-option:hover { background: #eef2ff; border-color: #818cf8; }
  .chat-ask-option[data-picked="true"] { background: #e0e7ff; border-color: #6366f1; box-shadow: inset 0 0 0 1px #6366f1; }
  .chat-ask-option-desc { display: block; margin-top: 2px; font-weight: 400; font-size: 11px; line-height: 15px; color: #64748b; }
  .chat-ask-custom { margin-top: 2px; }
  .chat-ask-custom-input { width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 10px; border: 1px solid rgba(199, 210, 254, 0.95); background: #fff; color: #1e293b; font: 500 12px/16px "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
  .chat-ask-custom-input:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15); }
  .chat-ask-footer { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .chat-ask-submit { flex: 1 1 auto; padding: 8px 14px; border: none; border-radius: 10px; background: linear-gradient(135deg, #6366f1, #4f46e5); color: #fff; font: 700 12px/16px "Segoe UI", ui-sans-serif, system-ui, sans-serif; cursor: pointer; }
  .chat-ask-submit:hover { filter: brightness(1.06); }
  .chat-composer { flex: 0 0 auto; display: flex; align-items: flex-end; gap: 8px; padding: 12px 14px; border-top: 1px solid rgba(226, 232, 240, 0.9); background: rgba(248, 250, 252, 0.75); }
  .chat-textarea { flex: 1 1 auto; box-sizing: border-box; min-height: 36px; max-height: 120px; padding: 8px 12px; border-radius: 12px; border: 1px solid rgba(203, 213, 225, 0.95); background: #fff; color: #0f172a; font: 400 13px/19px "Segoe UI", ui-sans-serif, system-ui, sans-serif; resize: none; }
  .chat-textarea:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.13); }
  .chat-stop-btn, .chat-send-btn { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border: none; border-radius: 12px; color: #fff; cursor: pointer; }
  .chat-stop-btn { background: linear-gradient(135deg, #ef4444, #dc2626); }
  .chat-stop-btn[hidden] { display: none; }
  .chat-send-btn { background: linear-gradient(135deg, #3b82f6, #4f46e5); }
  .chat-send-btn:hover { filter: brightness(1.06); }
  .chat-send-btn:disabled { background: rgba(203, 213, 225, 0.45); color: #94a3b8; cursor: not-allowed; }
  .chat-model-line { flex: 0 0 auto; padding: 8px 20px 12px; font-size: 12px; line-height: 17px; color: #64748b; background: rgba(248, 250, 252, 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: none; }
  @keyframes msg-appear { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
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
      <div class="chat-empty-subtitle">这里是「${petNameDisplay}」的对话窗口。</div>
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
<script>
  ${escapeHtmlText.toString()}
  ${highlightCodeText.toString()}
  ${renderMarkdownText.toString()}
  const escapeHtml = escapeHtmlText;
  const renderMarkdown = renderMarkdownText;

  const copyIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const checkIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

  function copyCardText(button, text) {
    const value = typeof text === "string" ? text : "";
    if (value.length === 0 || typeof window.openpetsPanel?.copyText !== "function") return;
    Promise.resolve(window.openpetsPanel.copyText(value)).then((result) => {
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
      event.stopPropagation();
      copyCardText(button, getText());
    });
    return button;
  }

  const chatTranscript = document.getElementById("chatTranscript");
  const chatEmpty = document.getElementById("chatEmpty");
  const chatText = document.getElementById("chatText");
  const chatSendBtn = document.getElementById("chatSend");
  const chatStopBtn = document.getElementById("chatStop");
  const chatModelLine = document.getElementById("chatModelLine");
  const chatAsk = document.getElementById("chatAsk");

  const renderedMessageIds = new Set();

  function addChatMessage(role, text, id) {
    if (id !== undefined) {
      if (renderedMessageIds.has(id)) return;
      renderedMessageIds.add(id);
    }
    chatEmpty.style.display = "none";
    if (role === "assistant") chatAsk.hidden = true;
    const wrap = document.createElement("div");
    wrap.className = "chat-msg is-" + role;
    const bubbleEl = document.createElement("div");
    bubbleEl.className = "chat-msg-bubble";
    if (role === "assistant") bubbleEl.innerHTML = renderMarkdown(text);
    else bubbleEl.textContent = text;
    wrap.appendChild(bubbleEl);
    wrap.appendChild(createCopyButton("chat-copy-btn chat-msg-copy", () => text));
    chatTranscript.appendChild(wrap);
    chatTranscript.scrollTop = chatTranscript.scrollHeight;
  }

  let loadingHistory = false;
  async function loadChatHistory() {
    if (loadingHistory || !window.openpetsPanel?.chatHistory) return;
    loadingHistory = true;
    try {
      const result = await window.openpetsPanel.chatHistory();
      const messages = (result && result.messages) || [];
      renderedMessageIds.clear();
      chatTranscript.innerHTML = "";
      chatTranscript.appendChild(chatEmpty);
      if (messages.length === 0) chatEmpty.style.display = "";
      const title = result && typeof result.sessionTitle === "string" ? result.sessionTitle.trim() : "";
      if (title.length > 0) {
        const titleEl = document.getElementById("chatTitle");
        if (titleEl) titleEl.textContent = title;
      }
      for (const entry of messages) {
        if (typeof entry?.text !== "string" || entry.text.trim().length === 0) continue;
        if (entry.role === "user" || entry.role === "assistant") addChatMessage(entry.role, entry.text, entry.id);
      }
    } catch { /* history is best-effort; sending still works */ } finally {
      loadingHistory = false;
    }
  }

  async function refreshModelLine() {
    if (!chatModelLine || typeof window.openpetsPanel?.chatModel !== "function") return;
    try {
      const result = await window.openpetsPanel.chatModel();
      const label = result && typeof result.label === "string" ? result.label : "未知";
      chatModelLine.textContent = "当前模型：" + label;
    } catch {
      chatModelLine.textContent = "当前模型：读取失败";
    }
  }

  function setBusy(busy) {
    chatStopBtn.hidden = !busy;
    chatStopBtn.disabled = false;
  }

  let sending = false;
  const sendQueue = [];

  async function sendCurrentText(explicit) {
    const text = (typeof explicit === "string" ? explicit : chatText.value).trim();
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
        if (!window.openpetsPanel || typeof window.openpetsPanel.chatSend !== "function") {
          throw new Error("preload 未暴露 chatSend");
        }
        const result = await window.openpetsPanel.chatSend(text);
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

  chatStopBtn.addEventListener("click", () => {
    chatStopBtn.disabled = true;
    if (!window.openpetsPanel || typeof window.openpetsPanel.chatStop !== "function") {
      addChatMessage("assistant", "停止失败：preload 未暴露 chatStop");
      chatStopBtn.disabled = false;
      return;
    }
    Promise.resolve(window.openpetsPanel.chatStop()).then((result) => {
      if (result && result.ok) addChatMessage("assistant", "已停止思考");
      else addChatMessage("assistant", "停止失败：" + ((result && result.error) || "未知错误"));
    }).catch((error) => {
      addChatMessage("assistant", "停止失败：" + (error && error.message ? error.message : error));
    }).finally(() => {
      sendQueue.length = 0;
      setBusy(false);
      chatSendBtn.disabled = false;
      sending = false;
    });
  });

  chatSendBtn.addEventListener("click", () => { void sendCurrentText(); });
  chatText.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendCurrentText();
    }
  });

  document.getElementById("chatClose").addEventListener("click", () => {
    if (window.openpetsPanel?.closePanel) window.openpetsPanel.closePanel();
  });

  let askCounter = 0;
  function renderAsk(ask) {
    if (!chatAsk || !ask || !Array.isArray(ask.questions) || ask.questions.length === 0) return;
    chatAsk.hidden = false;
    chatAsk.innerHTML = "";
    const title = document.createElement("div");
    title.className = "chat-ask-title";
    title.textContent = "AI 需要你确认";
    chatAsk.appendChild(title);
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
          chosen[questionIndex] = typeof option.value === "string" && option.value.length > 0 ? option.value : option.label;
          for (const sibling of chatAsk.querySelectorAll(".chat-ask-option[data-picked]")) sibling.removeAttribute("data-picked");
          button.setAttribute("data-picked", "true");
        });
        chatAsk.appendChild(button);
      }
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
        const value = customInput.value.trim();
        if (value.length > 0) {
          chosen[questionIndex] = value;
          for (const sibling of chatAsk.querySelectorAll(".chat-ask-option[data-picked]")) sibling.removeAttribute("data-picked");
        } else {
          chosen[questionIndex] = null;
        }
      });
      customInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); submit.click(); }
      });
      customRow.appendChild(customInput);
      chatAsk.appendChild(customRow);
    });
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "chat-ask-submit";
    submit.textContent = "提交答案";
    submit.addEventListener("click", () => {
      if (chosen.filter((value) => value !== null).length === 0) return;
      const answers = ask.questions.map((question, questionIndex) =>
        typeof question?.question === "string" ? (chosen[questionIndex] ?? "") : "",
      );
      chatAsk.hidden = true;
      chatAsk.innerHTML = "";
      if (typeof ask.formID === "string" && ask.formID.length > 0 && typeof window.openpetsPanel?.askReply === "function") {
        void window.openpetsPanel.askReply({ formID: ask.formID, answers });
        return;
      }
      const lines = [];
      ask.questions.forEach((question, questionIndex) => {
        if (!question || typeof question.question !== "string") return;
        lines.push((lines.length + 1) + ". " + question.question + "：" + (chosen[questionIndex] ?? "(未回答)"));
      });
      const newline = String.fromCharCode(10);
      void sendCurrentText("回答你的问题：" + newline + lines.join(newline));
    });
    const footer = document.createElement("div");
    footer.className = "chat-ask-footer";
    footer.appendChild(submit);
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
    chatTranscript.scrollTop = chatTranscript.scrollHeight;
  }

  window.openpetsPanel?.onAsk((ask) => { renderAsk(ask); });

  window.openpetsPanel?.onPanelState((payload) => {
    if (!payload) return;
    if (typeof payload.sessionTitle === "string" && payload.sessionTitle.trim().length > 0) {
      const titleEl = document.getElementById("chatTitle");
      if (titleEl) titleEl.textContent = payload.sessionTitle.trim();
    }
    if (payload.chatExpanded === true) {
      void loadChatHistory();
      void refreshModelLine();
      // The window is shown with focus, but the document only receives focus
      // once it is visible; put the caret in the composer so typing works
      // immediately without an extra click.
      window.focus();
      chatText.focus();
    }
  });

  window.__openpetsSend = (text) => sendCurrentText(text);
  void loadChatHistory();
  void refreshModelLine();
  chatText.focus();
</script>
</body>
</html>`;
}
