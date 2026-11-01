/* ======================================================================
 * content.js
 * ----------------------------------------------------------------------
 * This script runs INSIDE the AI website (ChatGPT, Claude, Gemini, ...).
 * It is the only part that can see the page, so it does four jobs:
 *
 *   1. READ the messages on the page            (the "adapters" below)
 *   2. AUTO-SAVE them whenever the chat changes (so you are covered even
 *                                                if you hit the limit)
 *   3. GENERATE A SUMMARY by typing a request into the chat and saving the
 *      AI's answer
 *   4. FILL the input box with a handoff prompt (for when you open a new chat)
 *
 * The popup (popup.js) talks to this script by sending it messages.
 *
 * IMPORTANT - HOW THIS CAN BREAK:
 * AI websites change their HTML without warning. All the "selectors" (the
 * strings like '[data-message-author-role]' that point at parts of the page)
 * are gathered in the ADAPTERS section. If a site stops working, ONLY that
 * site's adapter needs fixing. Copy the error to Claude and ask for a fix.
 *
 * shared.js is loaded before this file, so the settings and helper functions
 * from there (SUMMARY_PROMPT, chatKey, ...) are available here.
 * ====================================================================== */


/* ======================================================================
 * SECTION 1: SMALL UTILITIES
 * ====================================================================== */

// Pause for some milliseconds:  await sleep(500);
function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Returns a version of `fn` that waits until things have been quiet for `ms`
// milliseconds before running. Used so we don't save 100 times per second
// while the AI is typing its answer.
function debounce(fn, ms) {
  let timer = null;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// True if an element is actually visible on screen (pages often contain
// hidden duplicate input boxes that we must ignore).
function isVisible(el) {
  return !!(el && (el.offsetWidth > 0 || el.offsetHeight > 0));
}

// Goes through a list of CSS selectors and returns the first VISIBLE element
// that matches one of them (or null if nothing matches).
function findVisible(selectors) {
  for (const selector of selectors) {
    const matches = document.querySelectorAll(selector);
    for (const el of matches) {
      if (isVisible(el)) return el;
    }
  }
  return null;
}

// Same idea but doesn't care whether the element is visible.
function findAny(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}


/* ======================================================================
 * SECTION 2: ADAPTERS - one small "recipe" per website
 * ----------------------------------------------------------------------
 * Each adapter says:
 *   id / name / hosts      who it is and which web addresses it covers
 *   getMessages()          how to read the chat from the page
 *   inputSelectors         where the message box is
 *   sendButtonSelectors    where the send button is
 *   stopButtonSelectors    the "stop generating" button (exists only while
 *                          the AI is still writing - we use it to know when
 *                          the AI has finished)
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
      // ChatGPT marks every message with data-message-author-role="user"
      // or "assistant". This is one of the most stable selectors around.
      document.querySelectorAll("[data-message-author-role]").forEach(function (el) {
        const role = el.getAttribute("data-message-author-role");
        if (role !== "user" && role !== "assistant") return; // ignore system/tool
        const text = el.innerText.trim();
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
      // Your messages have data-testid="user-message".
      // Claude's replies have the class "font-claude-response".
      // One query that matches both returns them in page order.
      // We list several possible markers for Claude's replies, because the
      // site renames them from time to time. The first one is the usual one;
      // the others are backups.
      // userSel = markers for YOUR messages. The second marker is a backup
      // for long or unusual messages (e.g. ones with attachments).
      const userSel = "[data-testid='user-message'], .font-user-message";
      const both =
        userSel + ", .font-claude-response, .font-claude-message, " +
        "[data-testid='assistant-message'], div[data-is-streaming]";
      document.querySelectorAll(both).forEach(function (el) {
        // If this element CONTAINS another matched element, skip it and let
        // the inner one count. This avoids saving the same text twice, and
        // avoids picking up button labels from outer wrapper elements.
        if (el.querySelector(both)) return;
        const isUser = el.matches(userSel);
        const text = el.innerText.trim();
        if (text) messages.push({ role: isUser ? "user" : "assistant", text: text });
      });
      return messages;
    },

    inputSelectors: ["div[contenteditable='true'].ProseMirror", "div[contenteditable='true']"],
    sendButtonSelectors: ["button[aria-label='Send message']", "button[aria-label='Send Message']"],
    stopButtonSelectors: ["button[aria-label='Stop response']", "button[aria-label='Stop Response']"],
  },

  /* ------------------------------ Gemini ------------------------------- */
  {
    id: "gemini",
    name: "Gemini",
    hosts: ["gemini.google.com"],
    supported: true,

    getMessages: function () {
      const messages = [];
      // Gemini uses custom HTML tags: <user-query> and <model-response>.
      document.querySelectorAll("user-query, model-response").forEach(function (el) {
        const isUser = el.tagName.toLowerCase() === "user-query";
        // Try to grab just the text part, so labels like "You said" are skipped.
        const inner = isUser
          ? el.querySelector(".query-text")
          : el.querySelector(".markdown, message-content");
        const text = ((inner || el).innerText || "").trim();
        if (text) messages.push({ role: isUser ? "user" : "assistant", text: text });
      });
      return messages;
    },

    inputSelectors: ["rich-textarea .ql-editor", "div.ql-editor[contenteditable='true']", "div[contenteditable='true']", "textarea"],
    sendButtonSelectors: ["button.send-button", "button[aria-label='Send message']"],
    stopButtonSelectors: ["button.stop", "button[aria-label='Stop response']"],
  },
];

// Sites where we can only FILL the input box (read support not written yet).
// This is enough to paste a handoff INTO Grok, DeepSeek or Copilot.
// To add full support later, copy one adapter above and change the selectors.
function limitedAdapter(id, name, host) {
  return {
    id: id,
    name: name,
    hosts: [host],
    supported: false,                       // can't read chats here (yet)
    getMessages: function () { return []; },
    inputSelectors: ["textarea", "div[contenteditable='true']"],
    sendButtonSelectors: ["button[type='submit']", "button[aria-label*='Send']"],
    stopButtonSelectors: [],
  };
}
ADAPTERS.push(limitedAdapter("grok", "Grok", "grok.com"));
ADAPTERS.push(limitedAdapter("deepseek", "DeepSeek", "chat.deepseek.com"));
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
 * SECTION 3: SAVING THE CHAT (runs automatically)
 * ====================================================================== */

// Makes a nice title: uses the browser tab title if it's useful, otherwise
// the first words of your first message.
function guessTitle(messages) {
  let title = (document.title || "")
    .replace(/\s*[-|–—]\s*(ChatGPT|Claude|Gemini|Google Gemini)\s*$/i, "")
    .trim();
  const isGeneric = !title || /^(ChatGPT|Claude|Gemini|Google Gemini)$/i.test(title);
  if (isGeneric) {
    const firstUser = messages.find(function (m) { return m.role === "user"; });
    title = firstUser ? firstUser.text.replace(/\s+/g, " ").slice(0, 60) : "Untitled chat";
  }
  return title;
}

// Deletes the oldest saved chats if we have more than MAX_SAVED_CHATS.
async function pruneOldChats() {
  const all = await chrome.storage.local.get(null); // null = "give me everything"
  const chats = Object.values(all).filter(function (v) {
    return v && typeof v.id === "string" && v.id.startsWith("chat:");
  });
  if (chats.length <= MAX_SAVED_CHATS) return;
  chats.sort(function (a, b) { return b.updatedAt - a.updatedAt; }); // newest first
  const toDelete = chats.slice(MAX_SAVED_CHATS).map(function (c) { return c.id; });
  await chrome.storage.local.remove(toDelete);
}

// When you reload/update the extension, tabs that were already open keep an
// OLD copy of this script. Chrome cuts that old copy off from the extension
// (chrome.storage becomes undefined). We detect that here so the old copy can
// stop quietly instead of throwing errors on every page change.
let pageObserver = null;   // the page watcher; it is created further below
let warnedAboutOldCopy = false;

function extensionIsAlive() {
  return !!(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id &&
            chrome.storage && chrome.storage.local);
}

// Reads the page and stores the chat. Returns the saved chat (or null if the
// page has no messages yet). Safe to call as often as you like.
async function saveCurrentChat() {
  try {
    if (!ADAPTER || !ADAPTER.supported) return null;

    // Old copy left over from before an extension reload? Stop and explain once.
    if (!extensionIsAlive()) {
      if (pageObserver) pageObserver.disconnect();
      if (!warnedAboutOldCopy) {
        warnedAboutOldCopy = true;
        console.info("[Chat Handoff] This tab is running an old copy of the extension. Reload the page (F5) to fix it.");
      }
      return null;
    }

    // Read the page, tidy each message (remove hidden labels and repeated
    // text), then hide our own summary request/answer from the transcript.
    const onScreen = removeSummaryExchange(
      ADAPTER.getMessages()
        .map(function (m) { return { role: m.role, text: cleanMessageText(m.role, m.text) }; })
        .filter(function (m) { return m.text; })
    );
    if (onScreen.length === 0) return null; // empty/new chat: nothing to save

    const key = chatKey(ADAPTER.id, location.pathname);
    const existing = (await chrome.storage.local.get(key))[key];

    // The AI's summary reply is stored in its own "summary" field, so we keep
    // it OUT of the transcript (otherwise it would appear twice in the handoff).
    // This also cleans copies of it saved by older versions.
    const summaryText = existing && existing.summary ? existing.summary.trim() : "";
    function withoutSummary(list) {
      if (!summaryText) return list;
      return list.filter(function (m) { return !(m.role === "assistant" && m.text.trim() === summaryText); });
    }
    const transcriptNow = withoutSummary(onScreen);
    if (transcriptNow.length === 0) return existing || null; // only the summary is on screen

    // Combine with what we saved before, so that if the page only shows the
    // most recent messages, the older saved ones are kept.
    const messages = mergeMessages(existing && withoutSummary(existing.messages || []), transcriptNow);

    // If nothing changed since the last save, don't write again.
    if (existing && JSON.stringify(existing.messages) === JSON.stringify(messages)) {
      return existing;
    }

    // "...existing" keeps old fields (like the summary) that we aren't changing.
    const chat = Object.assign({}, existing, {
      id: key,
      site: ADAPTER.name,
      title: guessTitle(messages),
      url: location.href,
      updatedAt: Date.now(),
      messages: messages,
    });

    await chrome.storage.local.set({ [key]: chat });
    await pruneOldChats();
    return chat;
  } catch (err) {
    // Happens e.g. right after you reload the extension (old page copy is orphaned).
    console.warn("[Chat Handoff] could not save:", err);
    return null;
  }
}

// AUTO-SAVE: watch the page for changes and save 3 seconds after things calm down.
if (ADAPTER && ADAPTER.supported) {
  const autoSave = debounce(saveCurrentChat, 3000);
  pageObserver = new MutationObserver(autoSave); // fires whenever the page changes
  pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  setTimeout(saveCurrentChat, 4000); // also save once shortly after the page loads
}


/* ======================================================================
 * SECTION 4: TYPING INTO THE CHAT BOX AND SENDING
 * ====================================================================== */

// Puts `text` into the message box. Returns true if it worked.
// Modern chat boxes are "rich editors", so simply setting .value does not work
// there - the site wouldn't notice the change. We use tricks that make the
// editor think YOU typed or pasted the text.
function setInputText(input, text) {
  input.focus();

  // Case 1: an old-style <textarea> / <input>.
  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    // Websites built with React ignore plain "input.value = ...". Calling the
    // browser's own "value setter" and then firing an "input" event works.
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value.length > 0;
  }

  // Case 2: a rich editor (contenteditable). First select everything inside
  // it, so our text REPLACES whatever is there.
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(input);
  selection.removeAllRanges();
  selection.addRange(range);

  // Method A: execCommand("insertText") behaves like real typing.
  let worked = false;
  try { worked = document.execCommand("insertText", false, text); } catch (e) { /* ignore */ }

  // Method B (backup): pretend we pasted the text.
  const currentText = (input.innerText || input.textContent || "").trim();
  if (!worked || currentText.length === 0) {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }

  return (input.innerText || input.textContent || "").trim().length > 0;
}

// Clicks the send button; if we can't find it, presses Enter in the box instead.
async function pressSend(input) {
  await sleep(600); // give the site a moment to enable the send button
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
 * ----------------------------------------------------------------------
 * Steps: type the summary request -> send it -> wait until the AI finishes
 * answering -> save its answer as the chat's "summary".
 * NOTE: this uses one message from your limit, so do it BEFORE you run out.
 * ====================================================================== */

async function generateSummary() {
  if (!ADAPTER || !ADAPTER.supported) throw new Error("This site isn't supported for summaries yet.");

  const input = findVisible(ADAPTER.inputSelectors);
  if (!input) throw new Error("Couldn't find the message box on this page.");

  // Remember how many messages exist now, so we can tell when the new answer appears.
  const countBefore = ADAPTER.getMessages().length;

  if (!setInputText(input, SUMMARY_PROMPT)) throw new Error("Couldn't type into the message box.");
  await pressSend(input);

  // Wait (up to 3 minutes) for the answer to appear AND finish.
  const startedAt = Date.now();
  let lastText = "";
  let lastChangeAt = Date.now();

  while (Date.now() - startedAt < 180000) {
    await sleep(1000);

    const messages = ADAPTER.getMessages();
    const last = messages[messages.length - 1];

    // Our request + the AI's answer = 2 new messages. Not there yet? Keep waiting.
    const answerStarted = messages.length >= countBefore + 2 && last && last.role === "assistant";
    if (!answerStarted) continue;

    // A visible "stop" button means the AI is still writing.
    const stillWriting = !!findAny(ADAPTER.stopButtonSelectors);

    // If the text is still changing, remember the time and keep waiting.
    if (last.text !== lastText || stillWriting) {
      lastText = last.text;
      lastChangeAt = Date.now();
      continue;
    }

    // Text unchanged for 3 seconds and no stop button: the answer is complete.
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
 * ----------------------------------------------------------------------
 * The popup sends messages like { action: "save" }. We do the job and
 * reply with { ok: true, ... } or { ok: false, error: "..." }.
 * ====================================================================== */

chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
  // We wrap everything in an async function so we can use "await".
  (async function () {
    try {
      if (!ADAPTER) {
        sendResponse({ ok: false, error: "Unsupported site" });
        return;
      }

      // "ping": the popup asks "who are you and what can you do?"
      if (message.action === "ping") {
        sendResponse({ ok: true, site: ADAPTER.name, supported: ADAPTER.supported });

      // "save": read the page now and store it
      } else if (message.action === "save") {
        const chat = await saveCurrentChat();
        sendResponse({ ok: true, chat: chat });

      // "summarize": ask the AI for a summary and store the answer
      } else if (message.action === "summarize") {
        const summaryText = await generateSummary();
        // Make sure the chat exists in storage, then attach the summary to it.
        const chat = await saveCurrentChat();
        if (!chat) throw new Error("Nothing to attach the summary to.");
        chat.summary = summaryText;
        chat.summaryAt = Date.now();
        await chrome.storage.local.set({ [chat.id]: chat });
        sendResponse({ ok: true, chat: chat });

      // "fill": put handoff text into this page's message box (does NOT send it)
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

  // Returning true tells Chrome "I will answer later (asynchronously)".
  return true;
});
