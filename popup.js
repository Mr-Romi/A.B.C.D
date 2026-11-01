/* ======================================================================
 * popup.js
 * ----------------------------------------------------------------------
 * The behaviour of the popup window (popup.html).
 *
 * Two kinds of buttons:
 *   - "Current chat" buttons (Save / Generate summary) talk to content.js
 *     running on the AI page you are looking at.
 *   - "Saved chat" buttons (Fill / Copy / Obsidian) work on whichever chat
 *     is selected in the dropdown. These read from chrome.storage.local,
 *     so they work on ANY tab, including a brand-new AI's chat page.
 *
 * shared.js (helpers) and vault.js (Obsidian writing) are loaded first.
 * ====================================================================== */

function $(id) { return document.getElementById(id); }

let activeTabId = null;
let pageInfo = null;


/* ------------------------------ STATUS LINE ------------------------------ */

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind || "";
}


/* --------------------------- TALKING TO THE PAGE --------------------------- */

async function sendToTab(message) {
  try {
    return await chrome.tabs.sendMessage(activeTabId, message);
  } catch (err) {
    return { ok: false, error: "NO_CONTENT_SCRIPT" };
  }
}


/* ----------------------------- SAVED CHAT LIST ----------------------------- */

async function loadSavedChats() {
  const all = await chrome.storage.local.get(null);
  return Object.values(all)
    .filter(function (v) { return v && typeof v.id === "string" && v.id.startsWith("chat:"); })
    .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
}

async function refreshChatList(selectId) {
  const select = $("chatSelect");
  const chats = await loadSavedChats();
  select.innerHTML = "";

  if (chats.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No saved chats yet";
    option.value = "";
    select.appendChild(option);
  }

  for (const chat of chats) {
    const option = document.createElement("option");
    option.value = chat.id;
    const summaryMark = chat.summary ? " | has summary" : "";
    const msgCount = (chat.messages || []).length;
    option.textContent =
      chat.site + ": " + (chat.title || "Untitled").slice(0, 34) +
      " (" + msgCount + " msgs" + summaryMark + ")";
    select.appendChild(option);
  }

  if (selectId) select.value = selectId;
  updateButtons();
}

async function getSelectedChat() {
  const id = $("chatSelect").value;
  if (!id) return undefined;
  return (await chrome.storage.local.get(id))[id];
}


/* ------------------------------ BUTTON STATES ------------------------------ */

function updateButtons() {
  const canReadPage = !!(pageInfo && pageInfo.ok && pageInfo.supported);
  const canFillPage = !!(pageInfo && pageInfo.ok);
  const hasSavedChat = !!$("chatSelect").value;

  $("saveBtn").disabled = !canReadPage;
  $("summarizeBtn").disabled = !canReadPage;
  $("fillBtn").disabled = !(canFillPage && hasSavedChat);
  $("copyBtn").disabled = !hasSavedChat;
  $("vaultBtn").disabled = !hasSavedChat;
}


/* --------------------------------- STARTUP --------------------------------- */

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs[0] && tabs[0].id;

  pageInfo = await sendToTab({ action: "ping" });

  let selectId = null;

  if (!pageInfo.ok) {
    $("siteLine").textContent = "Not an AI chat page. (If it is one, reload the tab once.)";
  } else if (!pageInfo.supported) {
    $("siteLine").textContent = pageInfo.site + ": you can fill the box here, but reading chats isn't supported yet.";
  } else {
    $("siteLine").textContent = pageInfo.site + " detected. This chat is auto-saved.";
    const reply = await sendToTab({ action: "save" });
    if (reply.ok && reply.chat) selectId = reply.chat.id;
  }

  await refreshChatList(selectId);
}


/* ---------------------------------- BUTTONS ---------------------------------- */

$("saveBtn").onclick = async function () {
  const reply = await sendToTab({ action: "save" });
  if (reply.ok && reply.chat) {
    setStatus("Saved " + reply.chat.messages.length + " messages.", "ok");
    await refreshChatList(reply.chat.id);
  } else {
    setStatus("Nothing to save yet (no messages found on this page).", "error");
  }
};

$("summarizeBtn").onclick = async function () {
  $("summarizeBtn").disabled = true;
  setStatus("Asking the AI for a summary... keep this popup open (can take up to a minute).");
  const reply = await sendToTab({ action: "summarize" });
  if (reply.ok) {
    setStatus("Summary saved.", "ok");
    await refreshChatList(reply.chat.id);
  } else {
    setStatus("Failed: " + reply.error, "error");
  }
  $("summarizeBtn").disabled = false;
};

// "Attach to selected chat": cleans the pasted summary with cleanMessageText()
// and removes any duplicate copy of it from chat.messages right away.
$("attachSummaryBtn").onclick = async function () {
  const chat = await getSelectedChat();
  if (!chat) {
    setStatus("Pick a saved chat in the dropdown first.", "error");
    return;
  }
  const rawText = $("summaryBox").value.trim();
  if (!rawText) {
    setStatus("Paste the summary text into the box first.", "error");
    return;
  }
  const cleaned = cleanMessageText("assistant", rawText);
  chat.summary = cleaned;
  chat.summaryAt = Date.now();
  chat.messages = removeSummaryExchange(chat.messages || [], cleaned);
  await chrome.storage.local.set({ [chat.id]: chat });
  $("summaryBox").value = "";
  setStatus("Summary attached and cleaned. Ready to save to Obsidian or hand off.", "ok");
  await refreshChatList(chat.id);
};

$("fillBtn").onclick = async function () {
  const chat = await getSelectedChat();
  if (!chat) return;
  const reply = await sendToTab({ action: "fill", text: buildHandoffPrompt(chat) });
  if (reply.ok) setStatus("Filled! Check the message box, then press send.", "ok");
  else setStatus("Failed: " + reply.error, "error");
};

$("copyBtn").onclick = async function () {
  const chat = await getSelectedChat();
  if (!chat) return;
  try {
    await navigator.clipboard.writeText(buildHandoffPrompt(chat));
    setStatus("Copied. Paste it into the other AI.", "ok");
  } catch (err) {
    setStatus("Couldn't copy: " + err.message, "error");
  }
};

$("vaultBtn").onclick = async function () {
  const chat = await getSelectedChat();
  if (!chat) return;

  const fileName = makeFileName(chat);
  const noteText = buildObsidianNote(chat);
  const noSummaryWarning = !chat.summary
    ? " (Note: this chat has no summary yet — run 'Generate summary' first if you want one.)"
    : "";

  try {
    const path = await writeNoteToVault(fileName, noteText);
    setStatus("Saved to Obsidian: " + path + noSummaryWarning, "ok");
  } catch (err) {
    downloadFile(fileName, noteText);
    if (err.message === "NO_VAULT") {
      setStatus("Downloaded .md file" + noSummaryWarning + ". (Set a vault folder if you want direct saves.)", "ok");
    } else if (err.message === "NO_PERMISSION") {
      setStatus("Chrome didn't get permission for the vault folder, so the note was downloaded instead." + noSummaryWarning, "error");
    } else {
      setStatus("Couldn't write to the vault (" + err.message + "). Downloaded the note instead." + noSummaryWarning, "error");
    }
  }
};

$("folderBtn").onclick = function () { chrome.runtime.openOptionsPage(); };

function downloadFile(fileName, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

$("chatSelect").onchange = updateButtons;

init();
