/* ======================================================================
 * popup.js
 * ----------------------------------------------------------------------
 * The behaviour of the popup window (popup.html).
 *
 * Two kinds of buttons:
 *   - "Current tab" buttons (Save snapshot / AI summary) talk to content.js
 *     running on the AI page you are looking at.
 *   - "Saved & Handoff" buttons (Fill / Copy / Obsidian / Delete) work on the
 *     chat selected in the dropdown. They read from chrome.storage.local, so
 *     they work on ANY tab, including a brand-new AI's chat page.
 *
 * shared.js (helpers) and vault.js (Obsidian writing) are loaded first.
 * ====================================================================== */

// Shortcut: $("saveBtn") instead of document.getElementById("saveBtn")
function $(id) { return document.getElementById(id); }

let activeTabId = null;  // the browser tab you were looking at when you opened the popup
let pageInfo = null;     // what content.js told us about that tab: { ok, site, supported }


/* ------------------------------ STATUS LINE ------------------------------ */

// Shows a message at the bottom of the popup. kind = "ok", "error" or "" (neutral).
function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = kind || "";
}


/* --------------------------- TALKING TO THE PAGE --------------------------- */

// Sends a message to content.js in the active tab and returns its reply.
// If content.js isn't there (wrong site, or tab opened before installing the
// extension), we return { ok: false } instead of crashing.
async function sendToTab(message) {
  try {
    return await chrome.tabs.sendMessage(activeTabId, message);
  } catch (err) {
    return { ok: false, error: "NO_CONTENT_SCRIPT" };
  }
}


/* ----------------------------- SAVED CHAT LIST ----------------------------- */

// Reads all saved chats from storage, newest first.
async function loadSavedChats() {
  const all = await chrome.storage.local.get(null); // null = everything
  return Object.values(all)
    .filter(function (v) { return v && typeof v.id === "string" && v.id.startsWith("chat:"); })
    .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
}

// Fills the dropdown. If `selectId` is given, that chat is pre-selected.
async function refreshChatList(selectId) {
  const select = $("chatSelect");
  const chats = await loadSavedChats();
  select.replaceChildren(); // empty the dropdown

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
    option.textContent =
      chat.site + ": " + (chat.title || "Untitled").slice(0, 32) +
      " (" + (chat.messages || []).length + " msgs" + summaryMark + ")";
    select.appendChild(option);
  }

  if (selectId) select.value = selectId;
  updateButtons();
}

// Returns the chat currently selected in the dropdown (or undefined).
async function getSelectedChat() {
  const id = $("chatSelect").value;
  if (!id) return undefined;
  return (await chrome.storage.local.get(id))[id];
}


/* ------------------------------ BUTTON STATES ------------------------------ */

// Turns buttons on/off depending on what is possible right now.
function updateButtons() {
  const canReadPage = !!(pageInfo && pageInfo.ok && pageInfo.supported);
  const canFillPage = !!(pageInfo && pageInfo.ok);
  const hasSavedChat = !!$("chatSelect").value;

  $("saveBtn").disabled = !canReadPage;
  $("summarizeBtn").disabled = !canReadPage;
  $("fillBtn").disabled = !(canFillPage && hasSavedChat);
  $("fillBtnLabel").textContent = canFillPage && pageInfo.site
    ? "Fill into " + pageInfo.site
    : "Fill into this tab's chat box";
  $("copyBtn").disabled = !hasSavedChat;
  $("vaultBtn").disabled = !hasSavedChat;
  $("deleteBtn").disabled = !hasSavedChat; // the faded look comes from CSS (:disabled)
}


/* --------------------------------- STARTUP --------------------------------- */

async function init() {
  // Find the tab the user is looking at.
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tabs[0] && tabs[0].id;

  // Ask content.js on that tab who it is.
  pageInfo = await sendToTab({ action: "ping" });

  let selectId = null;

  if (!pageInfo.ok) {
    $("siteLine").textContent = "Not an AI chat page (reload tab if open)";
    $("statusDot").className = "status-dot";
    $("tabRadioHandoff").checked = true; // nothing to do here, so show the saved chats
  } else if (!pageInfo.supported) {
    $("siteLine").textContent = pageInfo.site + ": you can fill here (reading unsupported)";
    $("statusDot").className = "status-dot active";
    $("tabRadioHandoff").checked = true;
  } else {
    $("siteLine").textContent = pageInfo.site + " detected. Auto-saving enabled.";
    $("statusDot").className = "status-dot active";
    // Save right now, so the dropdown shows the latest version of this chat.
    const reply = await sendToTab({ action: "save" });
    if (reply.ok && reply.chat) selectId = reply.chat.id;
  }

  await refreshChatList(selectId);
}


/* ---------------------------------- BUTTONS ---------------------------------- */

// "Save snapshot": read the page and store it.
$("saveBtn").onclick = async function () {
  const reply = await sendToTab({ action: "save" });
  if (reply.ok && reply.chat) {
    setStatus("Saved " + reply.chat.messages.length + " messages to local storage.", "ok");
    await refreshChatList(reply.chat.id);
  } else {
    setStatus("Nothing to save yet (no messages found on this page).", "error");
  }
};

// "AI summary": ask the AI for a summary and store its answer.
// This can take up to a minute. If you close the popup meanwhile, the summary
// is still saved - just reopen the popup afterwards.
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

// "Attach to selected chat": you paste a summary by hand (copied from the AI's
// reply) and we store it as the summary of the chat chosen in the dropdown.
// This works on every site, even if automatic summary capture fails.
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

// "Fill": put the handoff text into the message box of the tab you're on
// (open the new AI's chat first). It does NOT press send, so you can read it first.
$("fillBtn").onclick = async function () {
  const chat = await getSelectedChat();
  if (!chat) return;
  const reply = await sendToTab({ action: "fill", text: buildHandoffPrompt(chat) });
  if (reply.ok) setStatus("Filled! Check the message box, then press send.", "ok");
  else setStatus("Failed: " + (reply.error || "Could not fill"), "error");
};

// "Copy Text": backup option - copy the handoff and paste it yourself.
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

// "Obsidian": write a .md file into your vault. If no vault is set up (or
// Chrome refuses), we download the file instead so nothing is lost.
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

// Opens the settings page where you pick the vault folder. (The folder picker
// can't run inside the popup because the popup closes when the picker opens.)
const openOptions = function () { chrome.runtime.openOptionsPage(); };
$("folderBtn").onclick = openOptions;
$("headerSettingsBtn").onclick = openOptions;

// Trash button: delete the selected saved chat (after asking).
$("deleteBtn").onclick = async function () {
  const id = $("chatSelect").value;
  if (!id) return;
  const chat = (await chrome.storage.local.get(id))[id];
  const title = (chat && chat.title) || "this chat";
  if (!confirm("Are you sure you want to delete \"" + title.slice(0, 30) + "\"?")) return;
  await chrome.storage.local.remove(id);
  setStatus("Deleted chat: " + title.slice(0, 30), "ok");
  await refreshChatList();
};

// Fallback used above: makes the browser download a text file.
function downloadFile(fileName, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  // Give the browser a moment to start the download before freeing the blob.
  setTimeout(function () { URL.revokeObjectURL(link.href); }, 1500);
}

// When the user picks a different saved chat, refresh which buttons are usable.
$("chatSelect").onchange = updateButtons;

// Go!
init();
