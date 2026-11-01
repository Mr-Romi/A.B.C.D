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
 *   - TEXT CLEANUP & MARKDOWN HELPERS so headings, bullets, and ```code```
 *     blocks survive cleanly without hidden screen-reader labels or icon fonts.
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
  const cleanPath = (pathname || "/").replace(/\/+$/, "") || "/";
  return "chat:" + siteId + ":" + cleanPath;
}

// True when the URL is still a generic "new chat" landing page before the site
// assigns a unique conversation ID in the URL.
function isGenericPath(pathname) {
  const p = (pathname || "/").replace(/\/+$/, "") || "/";
  return p === "/" || p === "/app" || p === "/new" || p === "/chat" || p === "/chats";
}

// Turns one message into readable text, e.g. "**User:** hello".
function formatMessage(message) {
  const who = message.role === "user" ? "User" : "Assistant";
  return "**" + who + ":** " + message.text;
}

// Checks whether a user message is our own summary request (even if the marker
// was slightly altered or truncated).
function isSummaryRequestText(text) {
  if (!text) return false;
  return (
    text.includes(SUMMARY_MARKER) ||
    text.includes("Please write a handoff summary of this entire conversation so I can continue it in another AI")
  );
}

// Checks whether an assistant reply looks like a generated handoff summary.
function isSummaryReplyText(text) {
  if (!text) return false;
  return (
    /(?:^|\n)#*\s*Context:\s+/i.test(text) &&
    /\*\*Goal:\*\*|Goal:/i.test(text) &&
    /\*\*Current state:\*\*|Current state:/i.test(text) &&
    /\*\*Key decisions:\*\*|Key decisions:/i.test(text)
  );
}

// Removes our summary request and the AI's answer to it from a message list.
// (We saved them for the summary field, so we don't want them in the transcript.)
function removeSummaryExchange(messages, knownSummaryText) {
  const normKnown = knownSummaryText ? cleanMessageText("assistant", knownSummaryText) : "";
  const cleaned = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && isSummaryRequestText(m.text)) {
      // Skip this user message AND the assistant reply right after it.
      if (messages[i + 1] && messages[i + 1].role === "assistant") i++;
      continue;
    }
    // Also skip any assistant message that matches the saved summary or has
    // the exact handoff summary template structure.
    if (m.role === "assistant") {
      if (normKnown && m.text.trim() === normKnown) continue;
      if (isSummaryReplyText(m.text)) continue;
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
  const rawSummary = chat.summary ? cleanMessageText("assistant", chat.summary) : "";
  const messages = removeSummaryExchange(chat.messages || [], rawSummary);
  const hasSummary = rawSummary.length > 0;
  let body;

  if (hasSummary) {
    const tail = takeTail(messages, RECENT_TAIL_CHARS);
    body =
      "## Summary of the conversation so far\n\n" +
      stripObsidianLinks(rawSummary) +
      (tail.text ? "\n\n## Most recent messages (word for word)\n\n" + tail.text : "");
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
  const cleanedSummary = chat.summary ? cleanMessageText("assistant", chat.summary) : "";
  const summaryText = cleanedSummary
    ? cleanedSummary
    : "_No summary generated yet. Press \"Generate summary\" in the extension while the chat still has room._";
  const cleanedMessages = removeSummaryExchange(chat.messages || [], cleanedSummary);
  const transcript = cleanedMessages.map(formatMessage).join("\n\n");

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
// such as "You said" or "Claude responded:", icon-font symbols, and repeated
// lines). When we read the page we pick that text up too, so we tidy it here.

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

// Removes a long line that is an exact repeat of the previous non-empty line,
// even if heading markers (#) or bold markers (**) differ on the first line.
function dropRepeatedLines(text) {
  const out = [];
  let lastNorm = "";
  let inCodeBlock = false;

  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      out.push(line);
      continue;
    }
    if (inCodeBlock) {
      out.push(line);
      continue;
    }
    const norm = line
      .replace(/^[#*>-]+\s*/, "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (norm === "") {
      out.push(line);
      continue;
    }
    if (norm.length > 15 && norm === lastNorm) continue; // skip exact repeat
    out.push(line);
    lastNorm = norm;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// Tidies one message. role is "user" or "assistant".
function cleanMessageText(role, text) {
  let t = String(text || "").replace(/\r/g, "");

  // 1. Strip Private Use Area (PUA) icon-font glyphs used by Claude/UI buttons
  //    (e.g. \uE000 - \uF8FF like         ).
  t = t.replace(/[\uE000-\uF8FF]/g, "");

  // 2. Strip leading screen-reader headings/labels:
  //    On Gemini, extractMarkdown turns the hidden <h5>You said ...</h5> into
  //    "##### You said <truncated preview>\n\n<real message>".
  if (role === "user") {
    let stripped = t.trim();
    // If line 1 is a markdown heading starting with "# You said..." followed by the real message, drop line 1.
    stripped = stripped.replace(/^#{1,6}\s*You said:?[^\n]*\n+/i, "").trim();
    // Or if it starts with plain "You said:" without a newline:
    stripped = stripped.replace(/^(#{1,6}\s*)?(You said|User):?\s+/i, "").trim();
    const collapsed = collapseDoubledText(stripped);
    t = collapsed !== stripped ? collapsed : stripped;
  } else {
    t = t.trim().replace(/^(#{1,6}\s*)?(Claude responded|Claude said|ChatGPT said|Gemini said):?\s*/i, "");
    // Fold standalone language labels ("Python\n\n```\n") into the code fence ("```python\n")
    t = t.replace(/(?:^|\n)([A-Za-z0-9_+#.-]{1,20})\n+```\n/g, function (_m, lang) {
      const cleanLang = lang.trim().toLowerCase();
      if (cleanLang === "code") return "\n```\n";
      return "\n```" + cleanLang + "\n";
    });
  }

  // 3. Remove standalone UI noise lines (timestamps, "Paused: Your free usage...", "Continue").
  const cleanLines = [];
  for (const line of t.split("\n")) {
    const trimmed = line.trim();
    if (/^(just now|\d+\s+(second|minute|hour|day)s?\s+ago)$/i.test(trimmed)) continue;
    if (/^Paused:\s+Your free usage returns/i.test(trimmed)) continue;
    if (/^(Retry|Copy|Edit|Continue|Good response|Bad response)$/i.test(trimmed)) continue;
    if (/^(Edited \d+ files?|Read a file|Ran a command)(,\s*(edited \d+ files?|read a file|ran a command|shared files))*$/i.test(trimmed)) continue;
    cleanLines.push(line);
  }
  t = cleanLines.join("\n");

  // 4. Drop repeated lines (e.g. thinking-step headers or doubled Context titles).
  t = dropRepeatedLines(t);

  // 5. Final trim of trailing timestamps if any remain at the end.
  t = t.replace(/\n\s*(just now|\d+\s+(second|minute|hour|day)s?\s+ago)\s*$/i, "");
  return t.trim();
}


/* ------------------ KEEPING OLDER MESSAGES SAFE ------------------ */
// Some chat pages only keep the most recent messages on screen. If we simply
// saved what is on screen, older messages we saved earlier would be lost.
// This combines what we saved before ("existing") with what is on screen
// now ("fresh"):
//   - If fresh already has all or more messages starting from the same root,
//     trust fresh.
//   - Otherwise, find where a SUFFIX of existing matches a PREFIX of fresh,
//     so we never slice off the tail of existing when an early message like "hi"
//     happens to repeat later.
function mergeMessages(existing, fresh) {
  if (!existing || existing.length === 0) return fresh;
  if (!fresh || fresh.length === 0) return existing;

  // Helper: check if two messages match (allowing the very last compared message
  // to have grown while streaming).
  function msgMatches(a, b, isLastItem) {
    if (a.role !== b.role) return false;
    if (a.text === b.text) return true;
    if (isLastItem && (a.text.startsWith(b.text) || b.text.startsWith(a.text))) return true;
    return false;
  }

  // Find a suffix of `existing` (starting at `start` and reaching the end of
  // `existing`, or where `fresh` completely covers `existing` from `start`)
  // that matches the prefix of `fresh`.
  for (let start = 0; start < existing.length; start++) {
    const remainingExisting = existing.length - start;
    // IMPORTANT: if fresh is shorter than remainingExisting, this `start` would
    // throw away the newer messages at the end of `existing`! Skip it unless
    // fresh reaches the end of existing.
    if (fresh.length < remainingExisting) continue;

    let matches = true;
    for (let k = 0; k < remainingExisting; k++) {
      const isLast = k === remainingExisting - 1;
      if (!msgMatches(existing[start + k], fresh[k], isLast)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return existing.slice(0, start).concat(fresh);
    }
  }

  // What if the user scrolled UP or the page only rendered a partial window?
  // If `fresh` is larger than `existing`, trust `fresh`; if `existing` is larger
  // and no suffix matched, append any genuinely new tail messages from `fresh`.
  if (fresh.length >= existing.length) return fresh;

  const lastExisting = existing[existing.length - 1];
  const idxInFresh = fresh.findIndex(function (m) {
    return m.role === lastExisting.role && (m.text === lastExisting.text || m.text.startsWith(lastExisting.text));
  });
  if (idxInFresh !== -1) {
    return existing.slice(0, existing.length - 1).concat(fresh.slice(idxInFresh));
  }

  return existing.concat(fresh);
}
