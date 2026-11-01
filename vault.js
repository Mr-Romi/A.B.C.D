/* ======================================================================
 * vault.js
 * ----------------------------------------------------------------------
 * Used by the popup and the settings page (NOT by the website pages).
 * It handles saving notes straight into your Obsidian vault folder.
 * ====================================================================== */

const VAULT_DB_NAME = "chat-handoff-vault";
const VAULT_STORE = "handles";
const VAULT_KEY = "vault-folder";

function openVaultDb() {
  return new Promise(function (resolve, reject) {
    const request = indexedDB.open(VAULT_DB_NAME, 1);
    request.onupgradeneeded = function () { request.result.createObjectStore(VAULT_STORE); };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

async function saveVaultHandle(handle) {
  const db = await openVaultDb();
  return new Promise(function (resolve, reject) {
    const tx = db.transaction(VAULT_STORE, "readwrite");
    tx.objectStore(VAULT_STORE).put(handle, VAULT_KEY);
    tx.oncomplete = function () { db.close(); resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

async function loadVaultHandle() {
  const db = await openVaultDb();
  return new Promise(function (resolve, reject) {
    const request = db.transaction(VAULT_STORE, "readonly").objectStore(VAULT_STORE).get(VAULT_KEY);
    request.onsuccess = function () { db.close(); resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

async function ensureVaultPermission(handle) {
  const options = { mode: "readwrite" };
  try {
    if ((await handle.queryPermission(options)) === "granted") return true;
    return (await handle.requestPermission(options)) === "granted";
  } catch (_e) {
    return false;
  }
}

async function writeNoteToVault(fileName, content) {
  const vault = await loadVaultHandle();
  if (!vault) throw new Error("NO_VAULT");
  if (!(await ensureVaultPermission(vault))) throw new Error("NO_PERMISSION");

  const folder = await vault.getDirectoryHandle(VAULT_SUBFOLDER, { create: true });
  const file = await folder.getFileHandle(fileName, { create: true });
  const writer = await file.createWritable();
  await writer.write(content);
  await writer.close();

  return vault.name + "/" + VAULT_SUBFOLDER + "/" + fileName;
}
