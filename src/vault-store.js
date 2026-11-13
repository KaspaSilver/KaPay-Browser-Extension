// Where the sealed vault is kept: KaPay's own IndexedDB, not chrome.storage.local (audit
// 2026-11-13). Content scripts run in web pages' processes, and the browser may not close
// storage.local to them (background.js lockStorageToExtension logs whether it did). IndexedDB
// belongs to the extension's origin, which a web page's process is never given.
//
// A vault kept in storage.local by an earlier version moves here the first time it is read: it is
// written here, read back and compared, and only then removed from storage.local. Where IndexedDB
// can't be opened at all, storage.local keeps being used, as before.

import { getLocal, setLocal, removeLocal } from "./browser.js";

export const LEGACY_VAULT_KEY = "kachat.vault.v1";
const DB_NAME = "kapay-vault";
const STORE = "vault";
const RECORD = "v1";

let opening = null;
function database() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB is not available")); return; }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
      request.onsuccess = () => {
        const db = request.result;
        // another window upgrading the database: this connection steps aside and is opened again
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error("IndexedDB could not be opened"));
      request.onblocked = () => reject(new Error("IndexedDB is blocked by another window"));
    }).catch((error) => { opening = null; throw error; });
  }
  return opening;
}

async function run(mode, act) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result;
    const request = act(tx.objectStore(STORE));
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || request.error || new Error("IndexedDB request failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB request was aborted"));
  });
}

const idbGet = () => run("readonly", (store) => store.get(RECORD));
const idbPut = (value) => run("readwrite", (store) => store.put(value, RECORD));
const idbDelete = () => run("readwrite", (store) => store.delete(RECORD));

/** Can IndexedDB be used here? Asked once per page. */
let usable = null;
async function idbUsable() {
  if (usable == null) usable = await database().then(() => true, () => false);
  return usable;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The sealed vault, or null when there is none. */
export async function readVault() {
  if (!(await idbUsable())) return (await getLocal(LEGACY_VAULT_KEY)) || null;
  const stored = await idbGet();
  if (stored) {
    // a copy an earlier move couldn't remove: the one here is the vault, the old copy goes
    if (await getLocal(LEGACY_VAULT_KEY)) await removeLocal([LEGACY_VAULT_KEY]).catch(() => {});
    return stored;
  }
  const legacy = (await getLocal(LEGACY_VAULT_KEY)) || null;
  if (!legacy) return null;
  // moved here, and the storage.local copy removed only once this one reads back the same
  await idbPut(legacy);
  if (same(await idbGet(), legacy)) await removeLocal([LEGACY_VAULT_KEY]).catch(() => {});
  return legacy;
}

/** Stores the sealed vault. */
export async function writeVault(sealed) {
  if (!(await idbUsable())) { await setLocal(LEGACY_VAULT_KEY, sealed); return; }
  await idbPut(sealed);
  if (await getLocal(LEGACY_VAULT_KEY)) await removeLocal([LEGACY_VAULT_KEY]).catch(() => {});
}

/** Removes the vault from wherever it is kept. */
export async function removeVault() {
  if (await idbUsable()) await idbDelete();
  await removeLocal([LEGACY_VAULT_KEY]);
}
