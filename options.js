/* ======================================================================
 * options.js
 * ----------------------------------------------------------------------
 * Behaviour of the settings page (options.html).
 * Lets you pick your Obsidian vault folder and remembers it.
 * vault.js (loaded first) provides saveVaultHandle() and loadVaultHandle().
 * ====================================================================== */

const resultEl = document.getElementById("result");

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

document.getElementById("pickBtn").onclick = async function () {
  if (typeof window.showDirectoryPicker !== "function") {
    resultEl.textContent =
      "This browser doesn't allow choosing a folder. That's okay: 'Save note to Obsidian vault' " +
      "will download the .md file instead. Tip: set your browser's download location to a folder " +
      "inside your Obsidian vault and the notes will land there.";
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await saveVaultHandle(handle);
    resultEl.textContent = "Saved! Vault folder: " + handle.name;
  } catch (err) {
    resultEl.textContent = err.name === "AbortError"
      ? "No folder selected."
      : "Couldn't set the folder: " + err.message;
  }
};

showCurrentFolder();
