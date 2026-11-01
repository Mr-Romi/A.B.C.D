# Chat Handoff (v1.2.0)

A Chrome extension that auto-saves your AI chats on your own computer with full Markdown (`#` headings, bullets, links, tables, and ` ``` ` code blocks), can ask the AI for a handoff summary, and fills that context into the next AI's message box when you hit a usage limit.

## Supported AI Platforms

| Platform | Read & Auto-Save | Fill & Continue |
| :--- | :---: | :---: |
| **ChatGPT** (`chatgpt.com`, `chat.openai.com`) | Yes | Yes |
| **Claude** (`claude.ai`) | Yes | Yes |
| **Gemini** (`gemini.google.com`) | Yes | Yes |
| **DeepSeek** (`chat.deepseek.com`) | Yes | Yes |
| **Grok** (`grok.com`) | Planned | Yes |
| **Microsoft Copilot** (`copilot.microsoft.com`) | Planned | Yes |

## Install / Update (1 minute)

1. Unzip this folder and replace the files in your permanent `chat-handoff` folder.
2. Open `chrome://extensions` and click the **Reload** (circular arrow) icon on **Chat Handoff**.
3. Press **F5** on any open ChatGPT, Claude, Gemini, or DeepSeek tabs so the new `content.js` loads.

## What was added & fixed in v1.2.0

- **Added DeepSeek Reader (`content.js`):** Full read, auto-save, and summary generation support for `chat.deepseek.com`.
- **Fixed `mergeMessages()` Scroll-Up Duplication (`shared.js`):** Prevents older or partial message slices from being duplicated at the end of the conversation when scrolling up in virtualized chats.
- **Preserves Hyperlinks & Tables (`content.js`):** Converts `<a>` tags into Markdown links `[text](url)`, `<blockquote>` into quote blocks, and HTML tables into formatted GitHub-flavored Markdown tables.
- **Delete Saved Chats (`popup.html`, `popup.js`):** Added a "Delete this chat" button in the popup to easily prune individual conversations.
- **Fixed Blob URL Revocation Race (`popup.js`):** Defers `URL.revokeObjectURL` to ensure Chromium's asynchronous download pipeline completes reliably.
- **Extension Icons Added (`icons/`):** Added official 16px, 48px, and 128px icon assets registered across `manifest.json`.
