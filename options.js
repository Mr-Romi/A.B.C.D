/* ======================================================================
 * options.js
 * ----------------------------------------------------------------------
 * Behaviour of the settings page (options.html).
 * Lets you pick your Obsidian vault folder and remembers it.
 * vault.js (loaded first) provides saveVaultHandle() and loadVaultHandle().
 * ====================================================================== */

const resultEl = document.getElementById("result");

// On page load: show which folder is currently saved (if any).
async function showCurrentFolder() {
  try {
    const handle = await loadVaultHandle();
    resultEl.textContent = handle
      ? "Current vault folder: " + handle.name
      : "No folder chosen yet.";
  } catch (err) {
    resultEl.textContent = "Couldn't read the saved folder: " + err.message;
  }
}

// When you click the button: open Chrome's folder picker.
document.getElementById("pickBtn").onclick = async function () {
  // Some browsers don't offer the folder picker at all (for example Brave
  // turns it off by default, and Firefox never had it). In that case we
  // explain the fallback instead of showing a confusing error.
  if (typeof window.showDirectoryPicker !== "function") {
    resultEl.textContent =
      "This browser doesn't allow choosing a folder. That's okay: 'Save note to Obsidian vault' " +
      "will download the .md file instead. Tip: set your browser's download location to a folder " +
      "inside your Obsidian vault and the notes will land there.";
    return;
  }

  try {
    // mode "readwrite" = we need to create files, not just read.
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await saveVaultHandle(handle); // remember it for next time
    resultEl.textContent = "Saved! Vault folder: " + handle.name;
  } catch (err) {
    // AbortError just means you closed the picker without choosing.
    resultEl.textContent = err.name === "AbortError"
      ? "No folder selected."
      : "Couldn't set the folder: " + err.message;
  }
};

showCurrentFolder();
