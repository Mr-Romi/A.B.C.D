# Chat Handoff (v1.2.1)

A Chrome extension that auto-saves your AI chats on your own computer as Markdown (`#` headings, bullets, links, tables, and ``` code blocks), can ask the AI for a handoff summary, and fills that context into the next AI's message box when you hit a usage limit.

## Supported AI platforms

| Platform | Read & auto-save | Fill & continue |
| :--- | :---: | :---: |
| **ChatGPT** (`chatgpt.com`, `chat.openai.com`) | Yes | Yes |
| **Claude** (`claude.ai`) | Yes | Yes |
| **Gemini** (`gemini.google.com`) | Yes | Yes |
| **DeepSeek** (`chat.deepseek.com`) | Experimental (selectors not verified on the live site) | Yes |
| **Grok** (`grok.com`) | Planned | Yes |
| **Microsoft Copilot** (`copilot.microsoft.com`) | Planned | Yes |

## Install / update

1. Copy these files over the files in your permanent `chat-handoff` folder. **Keep your existing `icons/` folder**: `manifest.json` points to `icons/icon16.png`, `icon48.png` and `icon128.png`, and Chrome refuses to load the extension if they are missing.
2. Open `chrome://extensions` and click the **Reload** (circular arrow) icon on **Chat Handoff**.
3. Press **F5** on any open ChatGPT, Claude, Gemini or DeepSeek tabs so the new `content.js` loads.

## What changed in v1.2.1

- **Trimmed dead code:** removed an unused helper, three test-only `module.exports` blocks, redundant branches in the Markdown reader, and defensive "does this button exist?" checks in `popup.js`. Also removed an unused CSS variable and stray ids from `popup.html`.
- **Security:** saved links are limited to http(s)/mailto (no `javascript:` links in your notes); note frontmatter is properly escaped; Templater tags, `dataviewjs` / `js-engine` code blocks and Dataview inline JS are defused before a note is written to your vault; the content script only accepts messages from this extension; the unneeded `clipboardWrite` permission was removed; the handoff prompt tells the next AI to treat the pasted context as background information, not as instructions.
- **Efficiency:** old chats are only pruned when a brand-new chat is first saved (not on every save); nested-message detection no longer compares every message with every other message; the Obsidian folder database connection is now closed after use.

## Privacy

Everything stays in your browser (`chrome.storage.local`) and, if you choose, in your Obsidian vault folder. The extension makes no network requests of its own. Your saved chats are stored unencrypted, so if you paste passwords or API keys into AI chats they will be in the saved transcript too. Use the trash button in the popup to delete a chat.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Tells Chrome what the extension is and where it runs |
| `shared.js` | Settings, the summary prompt, text cleanup, and the handoff/Obsidian builders |
| `content.js` | Runs on the AI site: reads the chat as Markdown, auto-saves, fills the box |
| `popup.html` / `popup.js` | The window that opens from the icon |
| `vault.js` | Writes notes into your Obsidian vault |
| `options.html` / `options.js` | Settings page for choosing the vault folder |
