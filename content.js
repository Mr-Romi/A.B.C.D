/* ======================================================================
 * content.js
 * ----------------------------------------------------------------------
 * This script runs INSIDE the AI website (ChatGPT, Claude, Gemini, ...).
 * It is the only part that can see the page, so it does four jobs:
 *
 *   1. READ the messages on the page as clean Markdown (the "adapters" below)
 *   2. AUTO-SAVE them whenever the chat changes (so you are covered even
 *                                                if you hit the limit)
 *   3. GENERATE A SUMMARY by typing a request into the chat and saving the
 *      AI's answer
 *   4. FILL the input box with a handoff prompt (for when you open a new chat)
 *
 * The popup (popup.js) talks to this script by sending it messages.
 *
 * shared.js is loaded before this file, so the settings and helper functions
 * from there (SUMMARY_PROMPT, chatKey, cleanMessageText, ...) are available.
 * ====================================================================== */


/* ======================================================================
 * SECTION 1: SMALL UTILITIES & HTML-TO-MARKDOWN READER
 * ====================================================================== */

// Pause for some milliseconds:  await sleep(500);
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Returns a version of `fn` that waits until things have been quiet for `ms`
// milliseconds before running.
function debounce(fn, ms) {
  let timer = null;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// True if an element is actually visible on screen.
function isVisible(el) {
  return !!(el && (el.offsetWidth > 0 || el.offsetHeight > 0));
}

// Goes through a list of CSS selectors and returns the first VISIBLE element.
function findVisible(selectors) {
  for (const selector of selectors) {
    const matches = document.querySelectorAll(selector);
    for (const el of matches) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

// SECURITY: decides whether a link from the page may be saved. Only http(s) and
// mailto links survive (as absolute URLs). javascript:, data:, file: and the
// like are dropped, so a hostile AI reply can't plant a clickable script link
// in your saved notes. Returns "" when the link should be reduced to plain text.
function safeHref(rawHref) {
  if (!rawHref || rawHref.startsWith("#")) return "";
  try {
    const url = new URL(rawHref, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return "";
    // Parentheses and spaces would break the Markdown link syntax.
    return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
  } catch (e) {
    return "";
  }
}

// Converts a DOM element into clean Markdown so headings (#), bold (**),
// bullet lists (-), and fenced code blocks (```) survive in your notes
// and handoff prompts instead of turning into flat plain text.
function extractMarkdown(rootEl) {
  if (!rootEl) return "";

  // Clone the element so we can remove hidden buttons/headers without
  // touching the live page.
  const clone = rootEl.cloneNode(true);

  // Remove UI chrome, copy buttons, thinking/tool accordions, SVGs, and screen-reader-only labels.
  const junkSelectors = [
    "button", "svg", "style", "script", "noscript",
    ".sr-only", ".visually-hidden", "[aria-hidden='true']",
    "[data-testid*='copy']", "[data-testid*='action']",
    "details", // collapsible thinking/tool steps in Claude
    "follow-up-questions", ".follow-up-questions", "[class*='follow-up']"
  ];
  clone.querySelectorAll(junkSelectors.join(", ")).forEach(function (el) { el.remove(); });

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || "";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const tag = node.tagName.toLowerCase();

    // Fenced code blocks: <pre><code>...</code></pre>
    if (tag === "pre") {
      const codeEl = node.querySelector("code") || node;
      let lang = "";
      const cls = (codeEl.className || "") + " " + (node.className || "");
      const langMatch = cls.match(/language-([a-zA-Z0-9_+-]+)/);
      if (langMatch) lang = langMatch[1];
      const rawCode = (codeEl.textContent || "").replace(/\n+$/, "");
      return "\n\n```" + lang + "\n" + rawCode + "\n```\n\n";
    }

    // Markdown tables: <table>...</table>
    if (tag === "table") {
      const rows = Array.from(node.querySelectorAll("tr"));
      if (rows.length === 0) return "";
      const tableLines = [];
      rows.forEach(function (tr, rowIdx) {
        const cells = Array.from(tr.querySelectorAll("th, td"));
        if (cells.length === 0) return;
        const rowText = "| " + cells.map(function (c) {
          let cellInner = "";
          for (const child of c.childNodes) cellInner += walk(child);
          return cellInner.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
        }).join(" | ") + " |";
        tableLines.push(rowText);
        if (rowIdx === 0) {
          const sep = "| " + cells.map(function () { return "---"; }).join(" | ") + " |";
          tableLines.push(sep);
        }
      });
      return "\n\n" + tableLines.join("\n") + "\n\n";
    }

    // Inline code: <code>...</code>
    if (tag === "code") {
      const txt = (node.textContent || "").trim();
      return txt ? "`" + txt + "`" : "";
    }

    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";

    // Recurse on children
    let inner = "";
    for (const child of node.childNodes) {
      inner += walk(child);
    }

    // Links: <a href="...">text</a>
    if (tag === "a") {
      const href = safeHref(node.getAttribute("href"));
      const txt = inner.trim();
      if (!href) return txt;
      return "[" + (txt || href) + "](" + href + ")";
    }

    // Blockquotes: <blockquote>...</blockquote>
    if (tag === "blockquote") {
      const lines = inner.trim().split("\n").map(function (l) { return "> " + l; }).join("\n");
      return "\n\n" + lines + "\n\n";
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      return "\n\n" + "#".repeat(level) + " " + inner.trim() + "\n\n";
    }

    // Bold & Italic
    if (tag === "strong" || tag === "b") {
      const t = inner.trim();
      return t ? "**" + t + "**" : "";
    }
    if (tag === "em" || tag === "i") {
      const t = inner.trim();
      return t ? "*" + t + "*" : "";
    }

    // Lists
    if (tag === "li") {
      const parentTag = node.parentElement ? node.parentElement.tagName.toLowerCase() : "ul";
      if (parentTag === "ol") {
        const siblings = Array.from(node.parentElement.children).filter(function (c) {
          return c.tagName && c.tagName.toLowerCase() === "li";
        });
        const idx = siblings.indexOf(node) + 1;
        return "\n" + idx + ". " + inner.trim();
      }
      return "\n- " + inner.trim();
    }
    if (tag === "ul" || tag === "ol") {
      return "\n" + inner + "\n\n";
    }

    // Paragraphs and block containers
    if (tag === "p" || tag === "section" || tag === "article") {
      return "\n\n" + inner.trim() + "\n\n";
    }

    // Everything else (div, span, table parts, ...): keep only the text inside.
    return inner;
  }

  const md = walk(clone)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Fallback to innerText if walk produced nothing
  return md || (rootEl.innerText || "").trim();
}


/* ======================================================================
 * SECTION 2: ADAPTERS - one small "recipe" per website
 * ====================================================================== */

const ADAPTERS = [

  /* ------------------------------ ChatGPT ------------------------------ */
  {
    id: "chatgpt",
    name: "ChatGPT",
    hosts: ["chatgpt.com", "chat.openai.com"],
    supported: true,

    getMessages: function () {
      const messages = [];
      document.querySelectorAll("[data-message-author-role]").forEach(function (el) {
        const role = el.getAttribute("data-message-author-role");
        if (role !== "user" && role !== "assistant") return;
        const text = extractMarkdown(el);
        if (text) messages.push({ role: role, text: text });
      });
      return messages;
    },

    inputSelectors: ["#prompt-textarea", "div[contenteditable='true']", "textarea"],
    sendButtonSelectors: ["button[data-testid='send-button']", "button[aria-label='Send prompt']"],
    stopButtonSelectors: ["button[data-testid='stop-button']", "button[aria-label='Stop streaming']"],
  },

  /* ------------------------------ Claude ------------------------------- */
  {
    id: "claude",
    name: "Claude",
    hosts: ["claude.ai"],
    supported: true,

    getMessages: function () {
      const messages = [];
      // IMPORTANT: Do NOT include div[data-is-streaming] in the combined
      // selector! On Claude, div[data-is-streaming] is an outer turn wrapper
      // that contains thinking steps, tool banners, and action bar icons.
      // Instead, we match specific user and assistant message containers in DOM order.
      const userSel = [
        "[data-testid='user-message']",
        ".font-user-message",
        "[data-testid='human-turn']",
        ".group.relative.inline-flex" // fallback for attachment/long user bubbles
      ].join(", ");

      const assistantSel = [
        ".font-claude-response",
        ".font-claude-message",
        "[data-testid='assistant-message']"
      ].join(", ");

      const both = userSel + ", " + assistantSel;

      document.querySelectorAll(both).forEach(function (el) {
        // Skip if this node sits inside ANOTHER matched node (prevents duplicates
        // when a wrapper and its inner container both match).
        if (el.parentElement && el.parentElement.closest(both)) return;
        const isUser = el.matches(userSel);
        const text = extractMarkdown(el);
        if (text) messages.push({ role: isUser ? "user" : "assistant", text: text });
      });
      return messages;
    },

    inputSelectors: [
      "div[contenteditable='true'].ProseMirror",
      "fieldset div[contenteditable='true']",
      "div[contenteditable='true']"
    ],
    sendButtonSelectors: [
      "button[aria-label='Send message']",
      "button[aria-label='Send Message']",
      "button[data-testid='send-button']"
    ],
    stopButtonSelectors: [
      "button[aria-label='Stop response']",
      "button[aria-label='Stop Response']",
      "button[data-testid='stop-button']"
    ],
  },

  /* ------------------------------ Gemini ------------------------------- */
  {
    id: "gemini",
    name: "Gemini",
    hosts: ["gemini.google.com"],
    supported: true,

    getMessages: function () {
      const messages = [];
      document.querySelectorAll("user-query, model-response").forEach(function (el) {
        const isUser = el.tagName.toLowerCase() === "user-query";
        // On Gemini, .user-query-container wraps BOTH a hidden <h5>You said ...</h5>
        // summary and the real .query-text! Always prefer .query-text first.
        const inner = isUser
          ? (el.querySelector(".query-text") || el.querySelector(".user-query-container") || el)
          : (el.querySelector(".markdown") || el.querySelector("message-content") || el.querySelector(".model-response-text") || el);
        const text = extractMarkdown(inner);
        if (text) messages.push({ role: isUser ? "user" : "assistant", text: text });
      });
      return messages;
    },

    inputSelectors: [
      "rich-textarea .ql-editor",
      "div.ql-editor[contenteditable='true']",
      "div[contenteditable='true']",
      "textarea"
    ],
    sendButtonSelectors: [
      "button.send-button",
      "button[aria-label='Send message']",
      "button[aria-label='Send prompt']"
    ],
    stopButtonSelectors: [
      "button.stop",
      "button[aria-label='Stop response']",
      "button[aria-label='Stop generating']"
    ],
  },

  /* ----------------------------- DeepSeek ------------------------------ */
  {
    id: "deepseek",
    name: "DeepSeek",
    hosts: ["chat.deepseek.com"],
    supported: true,

    getMessages: function () {
      const messages = [];
      const messageSel = "[data-role='user'], [data-role='assistant'], .chat-message, div[class*='chat-message']";
      const nodes = document.querySelectorAll(messageSel);

      if (nodes.length > 0) {
        nodes.forEach(function (el) {
          if (el.parentElement && el.parentElement.closest(messageSel)) return;
          const isUser = el.matches("[data-role='user'], [class*='user']") ||
                         !!el.querySelector("[data-role='user'], [class*='user']");
          const markdownEl = el.querySelector(".ds-markdown, message-content, .markdown") || el;
          const text = extractMarkdown(markdownEl);
          if (text) messages.push({ role: isUser ? "user" : "assistant", text: text });
        });
      } else {
        document.querySelectorAll(".ds-markdown").forEach(function (el) {
          const text = extractMarkdown(el);
          if (text) messages.push({ role: "assistant", text: text });
        });
      }
      return messages;
    },

    inputSelectors: ["#chat-input", "textarea.ds-input", "textarea", "div[contenteditable='true']"],
    sendButtonSelectors: [
      "div[role='button'][aria-label*='Send']",
      "button[aria-label*='Send']",
      "button[type='submit']",
      "div[class*='send-btn']"
    ],
    stopButtonSelectors: [
      "div[role='button'][aria-label*='Stop']",
      "button[aria-label*='Stop']",
      "div[class*='stop-btn']"
    ],
  },
];

// Sites where we can only FILL the input box (read support not written yet).
function limitedAdapter(id, name, host) {
  return {
    id: id,
    name: name,
    hosts: [host],
    supported: false,
    getMessages: function () { return []; },
    inputSelectors: ["textarea", "div[contenteditable='true']"],
    sendButtonSelectors: ["button[type='submit']", "button[aria-label*='Send']"],
    stopButtonSelectors: [],
  };
}
ADAPTERS.push(limitedAdapter("grok", "Grok", "grok.com"));
ADAPTERS.push(limitedAdapter("copilot", "Copilot", "copilot.microsoft.com"));

// Pick the adapter that matches the website we are currently on.
function pickAdapter() {
  const host = location.hostname;
  for (const adapter of ADAPTERS) {
    if (adapter.hosts.some(function (h) { return host === h || host.endsWith("." + h); })) {
      return adapter;
    }
  }
  return null;
}

const ADAPTER = pickAdapter();


/* ======================================================================
 * SECTION 3: SAVING THE CHAT (runs automatically & safely locked)
 * ====================================================================== */

function guessTitle(messages) {
  let title = (document.title || "")
    .replace(/\s*[-|–—]\s*(ChatGPT|Claude|Gemini|Google Gemini)\s*$/i, "")
    .trim();
  const isGeneric = !title || /^(ChatGPT|Claude|Gemini|Google Gemini|New chat)$/i.test(title);
  if (isGeneric) {
    const firstUser = messages.find(function (m) { return m.role === "user"; });
    const firstAny = firstUser || messages[0];
    title = firstAny ? firstAny.text.replace(/\s+/g, " ").slice(0, 60) : "Untitled chat";
  }
  return title;
}

async function pruneOldChats() {
  const all = await chrome.storage.local.get(null);
  const chats = Object.values(all).filter(function (v) {
    return v && typeof v.id === "string" && v.id.startsWith("chat:");
  });
  if (chats.length <= MAX_SAVED_CHATS) return;
  chats.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  const toDelete = chats.slice(MAX_SAVED_CHATS).map(function (c) { return c.id; });
  await chrome.storage.local.remove(toDelete);
}

let pageObserver = null;
let warnedAboutOldCopy = false;
let isSummarizing = false; // prevents auto-save from racing with generateSummary()
let lastActiveKey = null;  // remembers if this tab started on a generic URL like /new or /app

function extensionIsAlive() {
  try {
    return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id &&
              chrome.storage && chrome.storage.local);
  } catch (e) {
    return false;
  }
}

// Reads the page and stores the chat.
// Optional `newSummaryText` lets `summarize` save the summary atomically
// without racing against the MutationObserver auto-save.
async function saveCurrentChat(newSummaryText) {
  try {
    if (!ADAPTER || !ADAPTER.supported) return null;

    if (!extensionIsAlive()) {
      if (pageObserver) pageObserver.disconnect();
      if (!warnedAboutOldCopy) {
        warnedAboutOldCopy = true;
        console.info("[A.B.C.D] This tab is running an old copy of the extension. Reload the page (F5) to fix it.");
      }
      return null;
    }

    const key = chatKey(ADAPTER.id, location.pathname);
    let existing = (await chrome.storage.local.get(key))[key];

    // If the tab just moved from a generic URL (e.g. /app or /new) to a real
    // conversation URL (e.g. /app/abc123), migrate the temporary chat record!
    if (!existing && lastActiveKey && lastActiveKey !== key && isGenericPath(lastActiveKey.split(":").slice(2).join(":"))) {
      const prev = (await chrome.storage.local.get(lastActiveKey))[lastActiveKey];
      if (prev) {
        existing = prev;
        await chrome.storage.local.remove(lastActiveKey);
      }
    }
    lastActiveKey = key;
    const isNewChat = !existing; // only a NEW chat record can push us over the storage limit

    const summaryText = newSummaryText
      ? cleanMessageText("assistant", newSummaryText)
      : (existing && existing.summary ? cleanMessageText("assistant", existing.summary) : "");

    // Read the page, tidy each message, and strip out any summary request/reply.
    const rawOnScreen = ADAPTER.getMessages()
      .map(function (m) { return { role: m.role, text: cleanMessageText(m.role, m.text) }; })
      .filter(function (m) { return m.text; });

    const transcriptNow = removeSummaryExchange(rawOnScreen, summaryText);

    // Combine with previously saved messages (also stripped of any summary copies).
    const existingCleaned = existing ? removeSummaryExchange(existing.messages || [], summaryText) : [];
    const messages = mergeMessages(existingCleaned, transcriptNow);

    // If there are no transcript messages AND no summary to save, nothing to store yet.
    if (messages.length === 0 && !summaryText) return existing || null;

    // If nothing changed since the last save, skip writing to storage.
    if (
      existing &&
      !newSummaryText &&
      existing.summary === summaryText &&
      JSON.stringify(existing.messages) === JSON.stringify(messages)
    ) {
      return existing;
    }

    const chat = Object.assign({}, existing, {
      id: key,
      site: ADAPTER.name,
      title: guessTitle(messages),
      url: location.href,
      updatedAt: Date.now(),
      messages: messages,
    });

    if (summaryText) {
      chat.summary = summaryText;
      if (newSummaryText) chat.summaryAt = Date.now();
    }

    await chrome.storage.local.set({ [key]: chat });
    if (isNewChat) await pruneOldChats();
    return chat;
  } catch (err) {
    const msg = String((err && err.message) || err);
    // If the extension was just updated/reloaded in chrome://extensions, this
    // tab's old script is cut off. Disconnect the watcher quietly and do NOT
    // pass the Error object to console.warn (which Chrome flags as an extension error).
    if (msg.includes("Extension context invalidated") || !extensionIsAlive()) {
      if (pageObserver) pageObserver.disconnect();
      if (!warnedAboutOldCopy) {
        warnedAboutOldCopy = true;
        console.info("[A.B.C.D] Extension was updated. Press F5 on this tab to use the new version.");
      }
      return null;
    }
    console.info("[A.B.C.D] could not save: " + msg);
    return null;
  }
}

// AUTO-SAVE: watch the page for changes and save 3 seconds after things calm down.
if (ADAPTER && ADAPTER.supported) {
  const autoSave = debounce(function () {
    if (!isSummarizing) saveCurrentChat();
  }, 3000);
  pageObserver = new MutationObserver(autoSave);
  pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(function () {
    if (!isSummarizing) saveCurrentChat();
  }, 4000);
}


/* ======================================================================
 * SECTION 4: TYPING INTO THE CHAT BOX AND SENDING
 * ====================================================================== */

function setInputText(input, text) {
  input.focus();

  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value.length > 0;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(input);
  selection.removeAllRanges();
  selection.addRange(range);

  let worked = false;
  try { worked = document.execCommand("insertText", false, text); } catch (e) { /* ignore */ }

  const currentText = (input.innerText || input.textContent || "").trim();
  if (!worked || currentText.length === 0) {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }

  return (input.innerText || input.textContent || "").trim().length > 0;
}

async function pressSend(input) {
  await sleep(600);
  const button = findVisible(ADAPTER.sendButtonSelectors);
  if (button && !button.disabled) {
    button.click();
    return;
  }
  const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  input.dispatchEvent(new KeyboardEvent("keydown", enter));
  input.dispatchEvent(new KeyboardEvent("keyup", enter));
}


/* ======================================================================
 * SECTION 5: GENERATE A SUMMARY
 * ====================================================================== */

async function generateSummary() {
  if (!ADAPTER || !ADAPTER.supported) throw new Error("This site isn't supported for summaries yet.");

  const input = findVisible(ADAPTER.inputSelectors);
  if (!input) throw new Error("Couldn't find the message box on this page.");

  // Snapshot the messages BEFORE sending so we can detect the new assistant reply
  // even if the site doesn't match the user's summary-request bubble!
  const beforeMessages = ADAPTER.getMessages();
  const countBefore = beforeMessages.length;
  const lastAssistantBefore = beforeMessages
    .slice()
    .reverse()
    .find(function (m) { return m.role === "assistant"; });
  const prevAssistantText = lastAssistantBefore ? lastAssistantBefore.text : "";

  if (!setInputText(input, SUMMARY_PROMPT)) throw new Error("Couldn't type into the message box.");
  await pressSend(input);

  const startedAt = Date.now();
  let lastText = "";
  let lastChangeAt = Date.now();

  while (Date.now() - startedAt < 180000) {
    await sleep(1000);

    const messages = ADAPTER.getMessages();
    const last = messages[messages.length - 1];

    // The AI's new answer has started as soon as the last message on screen is
    // an assistant message whose text is NEW (different from prevAssistantText)
    // and we have at least countBefore + 1 messages.
    const answerStarted =
      messages.length >= countBefore + 1 &&
      last &&
      last.role === "assistant" &&
      last.text.trim() !== "" &&
      last.text !== prevAssistantText;

    if (!answerStarted) continue;

    // Note: use findVisible (not findAny) so a hidden stop button in the DOM
    // doesn't trick us into thinking the AI is still writing forever.
    const stillWriting = !!findVisible(ADAPTER.stopButtonSelectors);

    if (last.text !== lastText || stillWriting) {
      lastText = last.text;
      lastChangeAt = Date.now();
      continue;
    }

    // Text unchanged for 3 seconds and no visible stop button: complete!
    if (Date.now() - lastChangeAt >= 3000) {
      return cleanMessageText("assistant", last.text);
    }
  }
  throw new Error(
    "Couldn't capture the AI's reply (it took too long, or this site's layout changed and the reply " +
    "couldn't be detected). Copy the reply yourself and use 'Paste a summary manually' in the popup."
  );
}


/* ======================================================================
 * SECTION 6: TALKING TO THE POPUP
 * ====================================================================== */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  // SECURITY: only accept messages sent by this extension's own popup.
  if (sender.id !== chrome.runtime.id) return false;

  (async function () {
    try {
      if (!ADAPTER) {
        sendResponse({ ok: false, error: "Unsupported site" });
        return;
      }

      if (message.action === "ping") {
        sendResponse({ ok: true, site: ADAPTER.name, supported: ADAPTER.supported });

      } else if (message.action === "save") {
        const chat = await saveCurrentChat();
        sendResponse({ ok: true, chat: chat });

      } else if (message.action === "summarize") {
        isSummarizing = true;
        try {
          // Save the transcript before sending the summary request so earlier
          // messages are safely stored first.
          await saveCurrentChat();
          const summaryText = await generateSummary();
          const chat = await saveCurrentChat(summaryText);
          if (!chat) throw new Error("Nothing to attach the summary to.");
          sendResponse({ ok: true, chat: chat });
        } finally {
          isSummarizing = false;
        }

      } else if (message.action === "fill") {
        const input = findVisible(ADAPTER.inputSelectors);
        if (!input) throw new Error("Couldn't find the message box on this page.");
        const worked = setInputText(input, message.text);
        if (!worked) throw new Error("The site blocked the auto-fill. Use 'Copy handoff' and paste it instead.");
        sendResponse({ ok: true });

      } else {
        sendResponse({ ok: false, error: "Unknown action: " + message.action });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();

  return true;
});
