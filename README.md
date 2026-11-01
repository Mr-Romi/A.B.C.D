# Chat Handoff

A Chrome extension that auto-saves your AI chats on your own computer, can ask the AI for a handoff summary, and fills that context into the next AI's message box when you hit a usage limit.

## Install (2 minutes)

1. Unzip this folder somewhere permanent (Chrome reads it from there, so don't delete it).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `chat-handoff` folder.
4. Reload any ChatGPT / Claude / Gemini tabs that were already open.
5. (Optional) Click the extension icon -> **Choose Obsidian vault folder...** and pick your vault.

## Daily use

- **Automatic:** On ChatGPT, Claude and Gemini the transcript is saved 3 seconds after each change. You do nothing.
- **Before the limit:** click the icon -> **Generate summary**. Do this while you still have messages left.
- **After the limit:** open the new AI's chat, click the icon, pick the saved chat, press **Fill into THIS tab's message box**, read it, then send.
- **Obsidian:** **Save note to Obsidian vault** writes a `.md` note with the summary and full transcript.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Tells Chrome what the extension is and where it runs |
| `shared.js` | Settings, the summary prompt, and the text builders |
| `content.js` | Runs on the AI site: reads chat, auto-saves, fills the box |
| `popup.html` / `popup.js` | The window that opens from the icon |
| `vault.js` | Writes notes into your Obsidian vault |
| `options.html` / `options.js` | Settings page for choosing the vault folder |

## If something breaks

- **"Nothing to save yet"** on a site: that site changed its page. Open `content.js`, find that site's adapter, and ask Claude to update the selectors (send it the error, or right-click a message -> Inspect and paste the HTML).
- **Auto-fill does nothing:** use **Copy handoff text** and paste manually, and report which site it was.
- **Debug messages:** on the AI page press F12 -> Console and look for `[Chat Handoff]`.
