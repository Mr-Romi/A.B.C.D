/* ======================================================================
 * shared.js
 * ----------------------------------------------------------------------
 * This file is loaded in TWO places:
 *   1. On the AI website pages (together with content.js)
 *   2. In the popup window (popup.html) and the settings page
 *
 * It holds:
 *   - SETTINGS you can change (limits, folder name, summary prompt)
 *   - HELPER FUNCTIONS that turn a saved chat into
 *       (a) the text you paste into the next AI  -> buildHandoffPrompt()
 *       (b) an Obsidian note                      -> buildObsidianNote()
 *
 * A "chat" object (what we store in chrome.storage.local) looks like:
 *   {
 *     id:        "chat:chatgpt:/c/abc123",   // unique key
 *     site:      "ChatGPT",                  // friendly site name
 *     title:     "My chat title",
 *     url:       "https://chatgpt.com/c/abc123",
 *     updatedAt: 1730000000000,              // time of last auto-save
 *     messages:  [ { role: "user"|"assistant", text: "..." }, ... ],
 *     summary:   "# Context: ...",           // AI-written summary (optional)
 *     summaryAt: 1730000000000               // when the summary was made
 *   }
 * ====================================================================== */


/* ------------------------- SETTINGS (edit me) ------------------------- */

// Max number of characters of raw transcript to put in a handoff when NO
// summary exists. About 4 characters = 1 token, so 24000 is roughly 6000 tokens.
const MAX_HANDOFF_CHARS = 24000;

// When a summary DOES exist, we also add the most recent messages word for
// word, so the new AI sees exactly where you stopped. This is how much.
const RECENT_TAIL_CHARS = 6000;

// Folder (inside your Obsidian vault) where notes are saved.
const VAULT_SUBFOLDER = "AI Chat Handoffs";

// How many chats we keep in storage. Oldest ones are deleted beyond this.
const MAX_SAVED_CHATS = 40;

// A secret tag placed at the start of our summary request. We use it to find
// (and hide) the summary request + the AI's reply from the saved transcript,
// so your transcript only contains your real conversation.
const SUMMARY_MARKER = "[HANDOFF SUMMARY REQUEST]";

// The message we type into the chat when you press "Generate summary".
// You can edit the wording or the structure freely.
const SUMMARY_PROMPT = [
  SUMMARY_MARKER,
  "Please write a handoff summary of this entire conversation so I can continue it in another AI assistant.",
  "Reply with ONLY the summary (no greeting, no extra commentary), in Markdown, under 800 words, using exactly this structure:",
  "",
  "# Context: <short topic title>",
  "**Goal:** what I'm trying to achieve, in 1-2 sentences.",
  "**Current state:** where things stand now - what works and what doesn't.",
  "**Key decisions:** bullet list, each with the reason it was made.",
  "**Code / artifacts:** file or function names with their status. Include actual code ONLY for parts still being changed.",
  "**Constraints and preferences:** tools, languages, style or limits I stated.",
  "**Open questions:** what still needs an answer.",
  "**Next step:** the single most useful thing to do next.",
  "**Related topics:** 3-6 short topic names, each written as an Obsidian link like [[Topic Name]].",
].join("\n");


/* --------------------------- SMALL HELPERS --------------------------- */

// Builds the storage key for a chat. Same site + same page address = same key,
// so re-saving the same chat updates it instead of making duplicates.
function chatKey(siteId, pathname) {
  return "chat:" + siteId + ":" + pathname;
}

// Turns one message into readable text, e.g. "**User:** hello".
function formatMessage(message) {
  const who = message.role === "user" ? "User" : "Assistant";
  return "**" + who + ":** " + message.text;
}

// Removes our summary request and the AI's answer to it from a message list.
// (We saved them for the summary field, so we don't want them in the transcript.)
function removeSummaryExchange(messages) {
  const cleaned = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && m.text.includes(SUMMARY_MARKER)) {
      // Skip this user message AND the assistant reply right after it.
      if (messages[i + 1] && messages[i + 1].role === "assistant") i++;
      continue;
    }
    cleaned.push(m);
  }
  return cleaned;
}

// Takes messages from the END of the chat (the newest ones) until we reach the
// character limit. Returns the text and whether older messages were left out.
function takeTail(messages, maxChars) {
  const parts = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    let block = formatMessage(messages[i]);
    // If ONE message alone is longer than the limit, keep only its end part.
    if (block.length > maxChars) block = "..." + block.slice(-maxChars);
    if (total + block.length > maxChars && parts.length > 0) break;
    parts.unshift(block); // add to the FRONT so the order stays correct
    total += block.length + 2;
  }
  return { text: parts.join("\n\n"), trimmed: parts.length < messages.length };
}

// Obsidian links look like [[Topic]] or [[Topic|shown name]]. Another AI
// doesn't need the brackets, so we turn them into plain words.
function stripObsidianLinks(text) {
  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (_match, target, alias) {
    return alias || target;
  });
}

// Makes a safe file name (Windows/Mac/Obsidian don't allow some characters).
function makeFileName(chat) {
  const date = new Date(chat.updatedAt || Date.now()).toISOString().slice(0, 10); // 2026-11-01
  const safeTitle = (chat.title || "Untitled chat")
    .replace(/[\\/:*?"<>|#^\[\]]/g, "-") // remove forbidden characters
    .replace(/\s+/g, " ")                 // squash extra spaces
    .trim()
    .slice(0, 80);
  return date + " - " + safeTitle + ".md";
}


/* ---------------------- (a) THE HANDOFF PROMPT ---------------------- */
// This is the text you paste (or auto-fill) into the NEXT AI.
// If a summary exists:  summary + your latest messages word-for-word.
// If not:               the (trimmed) raw transcript.
function buildHandoffPrompt(chat) {
  const messages = chat.messages || [];
  const hasSummary = chat.summary && chat.summary.trim().length > 0;
  let body;

  if (hasSummary) {
    const tail = takeTail(messages, RECENT_TAIL_CHARS);
    body =
      "## Summary of the conversation so far\n\n" +
      stripObsidianLinks(chat.summary.trim()) +
      "\n\n## Most recent messages (word for word)\n\n" +
      tail.text;
  } else {
    const tail = takeTail(messages, MAX_HANDOFF_CHARS);
    body =
      (tail.trimmed ? "(Older messages were left out because the chat was very long.)\n\n" : "") +
      "## Conversation transcript\n\n" +
      tail.text;
  }

  return (
    "I'm continuing a conversation that started in another AI assistant (" + (chat.site || "unknown") + ") " +
    "and I had to stop because I hit its usage limit. " +
    "Please read the context below and continue from where it left off. " +
    "Keep the same goals, decisions and constraints, and do not re-open decisions that were already settled.\n\n" +
    "---\n\n" +
    body +
    "\n\n---\n\n" +
    "Reply with one short line confirming what you understood, then continue with the \"Next step\" " +
    "(or ask me what to do next if none is listed)."
  );
}


/* ---------------------- (b) THE OBSIDIAN NOTE ---------------------- */
// The note has "frontmatter" (the block between the --- lines, which Obsidian
// reads as properties), then the summary, then the full transcript.
function buildObsidianNote(chat) {
  const date = new Date(chat.updatedAt || Date.now()).toISOString().slice(0, 10);
  const summaryText = chat.summary && chat.summary.trim()
    ? chat.summary.trim()
    : "_No summary generated yet. Press \"Generate summary\" in the extension while the chat still has room._";
  const transcript = (chat.messages || []).map(formatMessage).join("\n\n");

  return (
    "---\n" +
    "source: " + (chat.site || "unknown") + "\n" +
    "date: " + date + "\n" +
    "chat_url: \"" + (chat.url || "") + "\"\n" +
    "tags: [ai-handoff]\n" +
    "---\n\n" +
    "# " + (chat.title || "Untitled chat") + "\n\n" +
    "## Summary\n\n" +
    summaryText + "\n\n" +
    "## Full transcript\n\n" +
    transcript + "\n"
  );
}


/* ---------------------- CLEANING MESSAGE TEXT ---------------------- */
// The websites hide extra text inside their messages (screen-reader labels
// such as "You said" or "Claude responded:", and repeated lines). When we read
// the page we pick that text up too, so we tidy it here.

// Some sites put the same text twice in one message ("hi\n\nhi").
// If the first half equals the second half, keep only one copy.
function collapseDoubledText(text) {
  const parts = text.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.length >= 2 && parts.length % 2 === 0) {
    const half = parts.length / 2;
    const first = parts.slice(0, half).join("\n\n");
    const second = parts.slice(half).join("\n\n");
    if (first === second) return first;
  }
  return text;
}

// Removes a long line that is an exact repeat of the line just before it.
// (Short lines are kept, because code often has repeated lines like "}".)
function dropRepeatedLines(text) {
  const out = [];
  let last = "";
  for (const line of text.split("\n")) {
    const norm = line.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, " ").trim();
    if (norm === "") { out.push(line); continue; }          // keep blank lines
    if (norm.length > 20 && norm === last) continue;        // skip exact repeat
    out.push(line);
    last = norm;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// Tidies one message. role is "user" or "assistant".
function cleanMessageText(role, text) {
  let t = String(text || "").replace(/\r/g, "").trim();

  if (role === "user") {
    // Gemini adds a hidden "You said" label AND repeats your text. We only
    // strip the label when we can confirm the doubling, so a message that
    // genuinely starts with "You said" is never damaged.
    const stripped = t.replace(/^You said:?\s+/i, "");
    const collapsed = collapseDoubledText(stripped);
    if (collapsed !== stripped) t = collapsed;
  } else {
    t = t.replace(/^Claude responded:\s*/i, ""); // hidden label on Claude replies
  }

  t = dropRepeatedLines(t);
  t = t.replace(/\n\s*(just now|\d+\s+(second|minute|hour|day)s?\s+ago)\s*$/i, ""); // "just now" / "1 minute ago" footer
  return t.trim();
}


/* ------------------ KEEPING OLDER MESSAGES SAFE ------------------ */
// Some chat pages only keep the most recent messages on screen. If we simply
// saved what is on screen, older messages we saved earlier would be lost.
// This combines what we saved before ("existing") with what is on screen
// now ("fresh"): it finds where the on-screen messages line up with the saved
// ones, keeps the older saved part, and adds the new part.
function mergeMessages(existing, fresh) {
  if (!existing || existing.length === 0 || fresh.length === 0) return fresh;

  for (let start = 0; start < existing.length; start++) {
    const overlap = Math.min(existing.length - start, fresh.length);
    let matches = true;
    for (let k = 0; k < overlap; k++) {
      const a = existing[start + k];
      const b = fresh[k];
      // The LAST overlapping message may still have been growing while it was
      // saved (the AI was typing), so we accept one being the start of the other.
      const isLast = k === overlap - 1;
      const sameText = a.text === b.text ||
        (isLast && (a.text.startsWith(b.text) || b.text.startsWith(a.text)));
      if (a.role !== b.role || !sameText) { matches = false; break; }
    }
    if (matches) return existing.slice(0, start).concat(fresh);
  }
  return fresh; // no overlap found: trust what is on screen
}
