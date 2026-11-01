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
    option.textContent =
      chat.site + ": " + (chat.title || "Untitled").slice(0, 34) +
      " (" + chat.messages.length + " msgs" + summaryMark + ")";
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
  $("copyBtn").disabled = !hasSavedChat;
  $("vaultBtn").disabled = !hasSavedChat;
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
    $("siteLine").textContent = "Not an AI chat page. (If it is one, reload the tab once.)";
  } else if (!pageInfo.supported) {
    $("siteLine").textContent = pageInfo.site + ": you can fill the box here, but reading chats isn't supported yet.";
  } else {
    $("siteLine").textContent = pageInfo.site + " detected. This chat is auto-saved.";
    // Save right now, so the dropdown shows the latest version of this chat.
    const reply = await sendToTab({ action: "save" });
    if (reply.ok && reply.chat) selectId = reply.chat.id;
  }

  await refreshChatList(selectId);
}


/* ---------------------------------- BUTTONS ---------------------------------- */

// "Save transcript now": read the page and store it.
$("saveBtn").onclick = async function () {
  const reply = await sendToTab({ action: "save" });
  if (reply.ok && reply.chat) {
    setStatus("Saved " + reply.chat.messages.length + " messages.", "ok");
    await refreshChatList(reply.chat.id);
  } else {
    setStatus("Nothing to save yet (no messages found on this page).", "error");
  }
};

// "Generate summary": ask the AI for a summary and store its answer.
// This can take up to a minute. If you close the popup meanwhile, the summary
// is still saved - just reopen the popup afterwards.
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

// "Attach to selected chat": you paste a summary by hand (copied from the AI's
// reply) and we store it as the summary of the chat chosen in the dropdown.
// This works on every site, even if automatic summary capture fails.
$("attachSummaryBtn").onclick = async function () {
  const chat = await getSelectedChat();
  if (!chat) {
    setStatus("Pick a saved chat in the dropdown first.", "error");
    return;
  }
  const text = $("summaryBox").value.trim();
  if (!text) {
    setStatus("Paste the summary text into the box first.", "error");
    return;
  }
  chat.summary = text;
  chat.summaryAt = Date.now();
  await chrome.storage.local.set({ [chat.id]: chat });
  $("summaryBox").value = "";
  setStatus("Summary attached. Now you can save the note to Obsidian or fill it into another AI.", "ok");
  await refreshChatList(chat.id); // refresh the list so it shows "has summary"
};

// "Fill into THIS tab": put the handoff text into the message box of the tab
// you're on (open the new AI's chat first). It does NOT press send, so you
// can read it first.
$("fillBtn").onclick = async function () {
  const chat = await getSelectedChat();
  if (!chat) return;
  const reply = await sendToTab({ action: "fill", text: buildHandoffPrompt(chat) });
  if (reply.ok) setStatus("Filled! Check the message box, then press send.", "ok");
  else setStatus("Failed: " + reply.error, "error");
};

// "Copy handoff text": backup option - copy it and paste manually.
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

// "Save note to Obsidian vault": write a .md file into your vault.
// If no vault is set up (or Chrome refuses), we download the file instead so
// nothing is lost.
$("vaultBtn").onclick = async function () {
  const chat = await getSelectedChat();
  if (!chat) return;

  const fileName = makeFileName(chat);
  const noteText = buildObsidianNote(chat);

  try {
    const path = await writeNoteToVault(fileName, noteText);
    setStatus("Saved to Obsidian: " + path, "ok");
  } catch (err) {
    downloadFile(fileName, noteText);
    if (err.message === "NO_VAULT") {
      setStatus("No vault folder chosen yet, so the note was downloaded instead. Click 'Choose Obsidian vault folder...' to set it up.", "error");
    } else if (err.message === "NO_PERMISSION") {
      setStatus("Chrome didn't get permission for the vault folder, so the note was downloaded instead.", "error");
    } else {
      setStatus("Couldn't write to the vault (" + err.message + "). Downloaded the note instead.", "error");
    }
  }
};

// Opens the settings page where you pick the vault folder.
// (The folder picker can't be used inside the popup because the popup closes
// as soon as the picker opens - that's why it lives on a separate page.)
$("folderBtn").onclick = function () { chrome.runtime.openOptionsPage(); };

// Fallback used above: makes the browser download a text file.
function downloadFile(fileName, text) {
  const blob = new Blob([text], { type: "text/markdown" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

// When the user picks a different saved chat, refresh which buttons are usable.
$("chatSelect").onchange = updateButtons;

// Go!
init();
