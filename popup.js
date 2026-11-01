/* ======================================================================
 * popup.js
 * ----------------------------------------------------------------------
 * The behaviour of the popup window (popup.html).
 *
 * Fully backward-compatible with all existing extension contracts.
 * shared.js (helpers) and vault.js (Obsidian writing) are loaded first.
 * ====================================================================== */

function $(id) { return document.getElementById(id); }

let activeTabId = null;
let pageInfo = null;


/* ------------------------------ STATUS LINE ------------------------------ */

function setStatus(text, kind) {
  const el = $("status");
  if (!el) return;
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
  if (!select) return;
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
    const summaryMark = chat.summary ? " • [Summary]" : "";
    const msgCount = (chat.messages || []).length;
    option.textContent =
      chat.site + ": " + (chat.title || "Untitled").slice(0, 32) +
      " (" + msgCount + " msgs" + summaryMark + ")";
    select.appendChild(option);
  }

  if (selectId) select.value = selectId;
  updateButtons();
}

async function getSelectedChat() {
  const select = $("chatSelect");
  if (!select) return undefined;
  const id = select.value;
  if (!id) return undefined;
  return (await chrome.storage.local.get(id))[id];
}


/* ------------------------------ BUTTON STATES ------------------------------ */

function updateButtons() {
  const canReadPage = !!(pageInfo && pageInfo.ok && pageInfo.supported);
  const canFillPage = !!(pageInfo && pageInfo.ok);
  const hasSavedChat = !!($("chatSelect") && $("chatSelect").value);

  if ($("saveBtn")) $("saveBtn").disabled = !canReadPage;
  if ($("summarizeBtn")) $("summarizeBtn").disabled = !canReadPage;
  if ($("fillBtn")) {
    $("fillBtn").disabled = !(canFillPage && hasSavedChat);
    const fillLabel = $("fillBtnLabel");
    if (fillLabel) {
      if (pageInfo && pageInfo.ok && pageInfo.site) {
        fillLabel.textContent = "Fill into " + pageInfo.site;
      } else {
        fillLabel.textContent = "Fill into this tab's chat box";
      }
    }
  }
  if ($("copyBtn")) $("copyBtn").disabled = !hasSavedChat;
  if ($("vaultBtn")) $("vaultBtn").disabled = !hasSavedChat;
  if ($("deleteBtn")) {
    $("deleteBtn").disabled = !hasSavedChat;
    $("deleteBtn").style.opacity = hasSavedChat ? "1" : "0.4";
  }
}


/* --------------------------------- STARTUP --------------------------------- */

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs[0] && tabs[0].id;

  pageInfo = await sendToTab({ action: "ping" });

  let selectId = null;
  const statusDot = $("statusDot");

  if (!pageInfo.ok) {
    $("siteLine").textContent = "Not an AI chat page (reload tab if open)";
    if (statusDot) statusDot.className = "status-dot";
    // Switch to Handoff tab if opened on a non-chat tab
    const radioHandoff = $("tabRadioHandoff");
    if (radioHandoff) radioHandoff.checked = true;
  } else if (!pageInfo.supported) {
    $("siteLine").textContent = pageInfo.site + ": you can fill here (reading unsupported)";
    if (statusDot) statusDot.className = "status-dot active";
    const radioHandoff = $("tabRadioHandoff");
    if (radioHandoff) radioHandoff.checked = true;
  } else {
    $("siteLine").textContent = pageInfo.site + " detected. Auto-saving enabled.";
    if (statusDot) statusDot.className = "status-dot active";
    const reply = await sendToTab({ action: "save" });
    if (reply.ok && reply.chat) selectId = reply.chat.id;
  }

  await refreshChatList(selectId);
}


/* ---------------------------------- BUTTONS ---------------------------------- */

if ($("saveBtn")) {
  $("saveBtn").onclick = async function () {
    const reply = await sendToTab({ action: "save" });
    if (reply.ok && reply.chat) {
      setStatus("Saved " + reply.chat.messages.length + " messages to local storage.", "ok");
      await refreshChatList(reply.chat.id);
    } else {
      setStatus("Nothing to save yet (no messages found on this page).", "error");
    }
  };
}

if ($("summarizeBtn")) {
  $("summarizeBtn").onclick = async function () {
    $("summarizeBtn").disabled = true;
    setStatus("Asking AI for a summary... keep popup open (may take up to a minute).");
    const reply = await sendToTab({ action: "summarize" });
    if (reply.ok) {
      setStatus("Summary generated and saved.", "ok");
      await refreshChatList(reply.chat.id);
    } else {
      setStatus("Failed: " + (reply.error || "Unknown error"), "error");
    }
    $("summarizeBtn").disabled = false;
  };
}

if ($("attachSummaryBtn")) {
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
    setStatus("Summary attached and cleaned. Ready to hand off or save to Obsidian.", "ok");
    await refreshChatList(chat.id);
  };
}

if ($("fillBtn")) {
  $("fillBtn").onclick = async function () {
    const chat = await getSelectedChat();
    if (!chat) return;
    const reply = await sendToTab({ action: "fill", text: buildHandoffPrompt(chat) });
    if (reply.ok) setStatus("Filled! Check the message box, then press send.", "ok");
    else setStatus("Failed: " + (reply.error || "Could not fill"), "error");
  };
}

if ($("copyBtn")) {
  $("copyBtn").onclick = async function () {
    const chat = await getSelectedChat();
    if (!chat) return;
    try {
      await navigator.clipboard.writeText(buildHandoffPrompt(chat));
      setStatus("Copied handoff text to clipboard.", "ok");
    } catch (err) {
      setStatus("Couldn't copy: " + err.message, "error");
    }
  };
}

if ($("vaultBtn")) {
  $("vaultBtn").onclick = async function () {
    const chat = await getSelectedChat();
    if (!chat) return;

    const fileName = makeFileName(chat);
    const noteText = buildObsidianNote(chat);
    const noSummaryWarning = !chat.summary
      ? " (Note: this chat has no summary yet — run 'Generate summary' if desired.)"
      : "";

    try {
      const path = await writeNoteToVault(fileName, noteText);
      setStatus("Saved to Obsidian: " + path + noSummaryWarning, "ok");
    } catch (err) {
      downloadFile(fileName, noteText);
      if (err.message === "NO_VAULT") {
        setStatus("Downloaded .md file" + noSummaryWarning + ". (Set a vault folder if you want direct saves.)", "ok");
      } else if (err.message === "NO_PERMISSION") {
        setStatus("Chrome didn't get folder permission, so the note was downloaded instead." + noSummaryWarning, "error");
      } else {
        setStatus("Couldn't write to the vault (" + err.message + "). Downloaded note instead." + noSummaryWarning, "error");
      }
    }
  };
}

const openOptions = function () { chrome.runtime.openOptionsPage(); };
if ($("folderBtn")) $("folderBtn").onclick = openOptions;
if ($("headerSettingsBtn")) $("headerSettingsBtn").onclick = openOptions;
if ($("settingsLink")) $("settingsLink").onclick = openOptions;

if ($("deleteBtn")) {
  $("deleteBtn").onclick = async function () {
    const select = $("chatSelect");
    if (!select) return;
    const id = select.value;
    if (!id) return;
    const chat = (await chrome.storage.local.get(id))[id];
    const title = (chat && chat.title) || "this chat";
    if (!confirm("Are you sure you want to delete \"" + title.slice(0, 30) + "\"?")) {
      return;
    }
    await chrome.storage.local.remove(id);
    setStatus("Deleted chat: " + title.slice(0, 30), "ok");
    await refreshChatList();
  };
}

function downloadFile(fileName, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  setTimeout(function () {
    URL.revokeObjectURL(link.href);
  }, 1500);
}

if ($("chatSelect")) {
  $("chatSelect").onchange = updateButtons;
}

init();



