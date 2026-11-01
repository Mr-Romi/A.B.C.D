# Chat Handoff (v1.1.0)

A Chrome extension that auto-saves your AI chats on your own computer with full Markdown (`#` headings, bullets, and ` ``` ` code blocks), can ask the AI for a handoff summary, and fills that context into the next AI's message box when you hit a usage limit.

## Install / Update (1 minute)

1. Unzip this folder and replace the files in your permanent `chat-handoff` folder.
2. Open `chrome://extensions` and click the **Reload** (circular arrow) icon on **Chat Handoff**.
3. Press **F5** on any open ChatGPT, Claude, or Gemini tabs so the new `content.js` loads.

## What was fixed in v1.1.0

- **Fixed Claude `div[data-is-streaming]` trap (`content.js`):** Removed `div[data-is-streaming]` from the selector list so outer turn containers, tool banners (`Edited 2 files...`), and `Paused: Your free usage...` footers are no longer swept into assistant replies.
- **Fixed `generateSummary()` timeout (`content.js`):** No longer requires `messages.length >= countBefore + 2` (which timed out whenever a user bubble was missed) and uses `findVisible()` instead of `findAny()` for the stop button so hidden stop buttons don't stall summary capture.
- **Fixed Private-Use Icon Characters & Repeated Lines (`shared.js`):** Strips Unicode Private Use Area icons (`\uE000–\uF8FF` like `     `) first, so `dropRepeatedLines()` and timestamp cleanup work reliably.
- **Preserves Real Markdown (`content.js`):** Added `extractMarkdown()` to convert headings, bold/italic text, lists, and `<pre><code>` blocks into proper Markdown with ` ``` ` code fences while stripping `<details>` thinking steps and copy buttons.
- **Fixed Summary Race Condition & Duplicate Summaries (`content.js`, `shared.js`, `popup.js`):** Pauses `autoSave` while `generateSummary()` runs, saves the summary atomically, cleans manually pasted summaries, and filters out any summary reply from the transcript even on older saved chats.
- **Fixed `mergeMessages()` & URL Migration (`shared.js`, `content.js`):** Prevents short repeated messages (like `"hi"`) from truncating earlier chat history, and migrates chats when a tab URL transitions from `/new` or `/app` to a permanent chat ID.
