/* ======================================================================
 * vault.js
 * ----------------------------------------------------------------------
 * Used by the popup and the settings page (NOT by the website pages).
 * It handles saving notes straight into your Obsidian vault folder.
 *
 * How it works:
 *   - On the settings page you pick your vault folder once.
 *   - Chrome gives us a "handle" to that folder. We remember the handle in
 *     IndexedDB (a small browser database), because the handle can't be
 *     stored in chrome.storage.
 *   - Later, we use the handle to create/overwrite .md files in the folder.
 *
 * Chrome may ask "Allow this extension to edit files?" again after you
 * restart the browser. That's a Chrome security rule - just click Allow.
 *
 * shared.js is loaded before this file (it provides VAULT_SUBFOLDER).
 * ====================================================================== */

const VAULT_DB_NAME = "chat-handoff-vault";
const VAULT_STORE = "handles";
const VAULT_KEY = "vault-folder";

// Opens (or creates) the tiny database.
function openVaultDb() {
  return new Promise(function (resolve, reject) {
    const request = indexedDB.open(VAULT_DB_NAME, 1);
    request.onupgradeneeded = function () { request.result.createObjectStore(VAULT_STORE); };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

// Remembers the folder the user picked.
async function saveVaultHandle(handle) {
  const db = await openVaultDb();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(VAULT_STORE, "readwrite");
    tx.objectStore(VAULT_STORE).put(handle, VAULT_KEY);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

// Loads the remembered folder (or undefined if you haven't picked one yet).
async function loadVaultHandle() {
  const db = await openVaultDb();
  return new Promise(function (resolve, reject) {
    const request = db.transaction(VAULT_STORE, "readonly").objectStore(VAULT_STORE).get(VAULT_KEY);
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

// Makes sure we are allowed to write to the folder. If not, asks the user.
// (Asking only works right after a click, which is the case in our popup.)
async function ensureVaultPermission(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

// Writes one note file into  <vault>/<VAULT_SUBFOLDER>/<fileName>.
// Throws Error("NO_VAULT") if no folder was chosen yet, and
// Error("NO_PERMISSION") if the user said no. Returns a readable path.
async function writeNoteToVault(fileName, content) {
  const vault = await loadVaultHandle();
  if (!vault) throw new Error("NO_VAULT");
  if (!(await ensureVaultPermission(vault))) throw new Error("NO_PERMISSION");

  // Create the sub-folder if it doesn't exist, then create/overwrite the file.
  const folder = await vault.getDirectoryHandle(VAULT_SUBFOLDER, { create: true });
  const file = await folder.getFileHandle(fileName, { create: true });
  const writer = await file.createWritable();
  await writer.write(content);
  await writer.close();

  return vault.name + "/" + VAULT_SUBFOLDER + "/" + fileName;
}
