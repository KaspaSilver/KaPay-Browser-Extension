// The encrypted vault: every account's recovery phrase, sealed with the wallet password.
//
// This is the part the desktop web app does not have - it keeps seeds as readable JSON in
// localStorage and its password only gates the screen. Here nothing secret is ever written to
// disk in the clear:
//
//   password --PBKDF2-SHA256 (600,000 rounds, random 16-byte salt)--> AES-256-GCM key
//   { accounts, activeAccountId }  --AES-GCM (random 12-byte IV)-->  ciphertext in KaPay's IndexedDB (vault-store.js)
//
// Unlocking derives the key once and keeps it (as raw bytes) in storage.session - memory only,
// wiped when the browser closes or the auto-lock fires (background.js), and never readable by
// web pages or content scripts. The phrase itself is decrypted on demand from the vault with
// that key, so storage.session never holds a phrase.
//
// All crypto is WebCrypto (crypto.subtle), available in every extension page and worker.

import { getLocal, setLocal, removeLocal, getSession, setSession, removeSession, clearSession, localArea } from "./browser.js";
import { readVault, writeVault, removeVault, LEGACY_VAULT_KEY } from "./vault-store.js";

const VAULT_KEY = LEGACY_VAULT_KEY;
const SESSION_KEY = "kachat.unlockKey";
const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(String(text || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKeyBytes(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

function importAesKey(rawBytes) {
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function seal(payload, keyBytes, kdf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(keyBytes);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));
  return {
    version: 1,
    kdf,
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(new Uint8Array(ciphertext)),
  };
}

async function open(vault, keyBytes) {
  const key = await importAesKey(keyBytes);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(vault.cipher.iv) },
    key,
    fromBase64(vault.data),
  );
  return JSON.parse(decoder.decode(plaintext));
}

function newKdf() {
  return { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: toBase64(crypto.getRandomValues(new Uint8Array(16))) };
}

function newAccountId() {
  return toBase64(crypto.getRandomValues(new Uint8Array(9))).replace(/[+/=]/g, "");
}

/** Is there a vault at all (a wallet was set up in this browser)? */
export async function hasVault() {
  return Boolean(await readVault());
}

/** Is the vault unlocked right now (a key is held in session storage)? */
export async function isUnlocked() {
  return Boolean(await getSession(SESSION_KEY));
}

// The unlock key is kept with the salt of the vault it opens: `{ key, salt }`. Changing the password
// writes the vault (new salt) and then the session key - two steps another open wallet window can
// fall between. A write in that moment would seal the vault with the old key under the new salt,
// which neither password opens. So the key is used only on the vault it was made for; between the
// two steps a read or write is refused, never applied. (A plain string is a key kept by an earlier
// build: no salt to check.)
function storedKey(stored) {
  return typeof stored === "string" ? { key: stored, salt: null } : stored;
}
function sessionRecord(keyBytes, kdf) {
  return { key: toBase64(keyBytes), salt: kdf.salt };
}

/** The unlock key for `vault`. Throws when the wallet is locked, or when the vault was re-sealed
 *  under a new password since this key was made (a password change in another window). */
async function sessionKeyBytes(vault) {
  const stored = storedKey(await getSession(SESSION_KEY));
  if (!stored?.key) throw new Error("The wallet is locked.");
  if (stored.salt && vault?.kdf?.salt && stored.salt !== vault.kdf.salt) {
    throw new Error("The wallet password was just changed in another window. Try again.");
  }
  return fromBase64(stored.key);
}

/**
 * First-time setup: seals `account` (phrase, optional BIP39 passphrase, derivation family) with
 * a new password and leaves the wallet unlocked.
 */
export async function createVault(password, account) {
  if (String(password || "").length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const stored = { ...normalizeAccount(account), id: newAccountId(), createdAt: Date.now() };
  // Inside the vault lock, checked again there: two windows making the first account at once
  // can't both find no vault and the second overwrite the first one's.
  return withVaultLock(async () => {
    if (await hasVault()) throw new Error("A wallet already exists in this browser.");
    const kdf = newKdf();
    const keyBytes = await deriveKeyBytes(password, fromBase64(kdf.salt), kdf.iterations);
    const payload = { accounts: [stored], activeAccountId: stored.id };
    await writeVault(await seal(payload, keyBytes, kdf));
    await publishAccountIds(payload);
    await setSession(SESSION_KEY, sessionRecord(keyBytes, kdf));
    return publicView(payload);
  });
}

/** Unlocks with the password. Throws "Wrong password." when it does not open the vault. Inside the
 *  vault lock (audit EXT-030): an unlock racing a password change can't store a key for the vault
 *  it read before the change - it reads the vault the change left, or finishes before it. */
export async function unlock(password) {
  return withVaultLock(async () => {
    const vault = await readVault();
    if (!vault) throw new Error("No wallet has been set up yet.");
    const keyBytes = await deriveKeyBytes(password, fromBase64(vault.kdf.salt), vault.kdf.iterations);
    let payload;
    try {
      payload = await open(vault, keyBytes);
    } catch {
      // AES-GCM authentication failure: the key (so the password) is wrong.
      throw new Error("Wrong password.");
    }
    await setSession(SESSION_KEY, sessionRecord(keyBytes, vault.kdf));
    await publishAccountIds(payload);
    return publicView(await migratePassphrases(payload));
  });
}

export async function lock() {
  // the unlock key only: the background's site-tab registry stays (audit EXT-009)
  await removeSession(SESSION_KEY);
}

/** The decrypted vault. Callers that only need names and ids should use `readAccounts`. */
async function readPayload() {
  const vault = await readVault();
  if (!vault) throw new Error("No wallet has been set up yet.");
  return migratePassphrases(await open(vault, await sessionKeyBytes(vault)));
}

// BIP39 derives the seed from the NFKD form of the passphrase, as iOS does; the Kaspa WASM uses the
// bytes it is given. A passphrase with accented or other non-ASCII letters (typed in NFC) therefore
// opened a different, empty wallet here than on iPhone (audit EXT-010). Every passphrase is now
// kept in NFKD form: an account stored before is switched once to the standard (iPhone) addresses
// - the owner's call - and the addresses cached for it are dropped so they are derived again.
const nfkd = (text) => String(text || "").normalize("NFKD");

async function migratePassphrases(payload) {
  const changed = payload.accounts.filter((a) => a.passphrase && a.passphrase !== nfkd(a.passphrase));
  if (!changed.length) return payload;
  for (const account of changed) account.passphrase = nfkd(account.passphrase);
  await writePayload(payload);
  // The old chatting addresses (from the address cache, before it is dropped): what is kept under
  // them - the backup-owed banner, contacts, the bell - follows the account to its new address
  // (approve.js followOwedConnections -> account-data.js carryAccountData, audit 2026-11-13).
  const carry = (await getLocal(DATA_TO_CARRY_KEY).catch(() => null)) || {};
  for (const account of changed) {
    const caches = await Promise.all([getLocal(`kachat.addresses.${account.id}`), getLocal(`kachat.addresses.${account.id}.testnet`)]).catch(() => []);
    const from = caches.map((c) => c?.main).filter(Boolean);
    if (from.length) carry[account.id] = [...new Set([...(carry[account.id] || []), ...from])];
  }
  if (Object.keys(carry).length) await setLocal(DATA_TO_CARRY_KEY, carry).catch(() => {});
  await removeLocal(changed.flatMap((a) => [`kachat.addresses.${a.id}`, `kachat.addresses.${a.id}.testnet`])).catch(() => {});
  // Their websites still hold the old chatting address: noted here (this file can't derive an
  // address), and the wallet window moves those connections to the new one (popup.js).
  const owed = new Set([...((await getLocal(CONNECTIONS_TO_FOLLOW_KEY).catch(() => null)) || []), ...changed.map((a) => a.id)]);
  await setLocal(CONNECTIONS_TO_FOLLOW_KEY, [...owed]).catch(() => {});
  return payload;
}

/** Accounts whose chatting address the passphrase migration changed, whose website connections
 *  still have to follow it (approve.js followAccount). */
export const CONNECTIONS_TO_FOLLOW_KEY = "kachat.connectionsToFollow";
/** accountId -> the chatting addresses (either network) an account had before the passphrase
 *  migration moved it: its data still to be carried to the new one. */
export const DATA_TO_CARRY_KEY = "kachat.dataToCarry";

// Vault changes take turns across every open window - popup, tab, approval window - through one
// Web Lock (audit EXT-027): an account change reads, edits and writes the vault inside it, and a
// password change re-seals and stores the new key inside it, so a write can never start before a
// password change and land after it (that put the old-password seal back and quietly undid the
// change). Web Locks are not reentrant: only the public entry points take it.
const VAULT_LOCK = "kachat-vault";
function withVaultLock(fn) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(VAULT_LOCK, fn) : fn();
}

async function writePayload(payload) {
  const vault = await readVault();
  const sealed = await seal(payload, await sessionKeyBytes(vault), vault.kdf);
  // still the vault this seal is for - never write an old-password seal over a re-sealed vault
  if ((await readVault())?.kdf?.salt !== vault.kdf.salt) {
    throw new Error("The wallet password was just changed in another window. Try again.");
  }
  await writeVault(sealed);
  await publishAccountIds(payload);
}

/** The ids of the accounts in the vault, readable without the password: the background worker
 *  answers websites only for connections whose account still exists (audit EXT-002). */
export const ACCOUNT_IDS_KEY = "kachat.accountIds";
/** The active account's id, the same way: every open wallet window follows a switch made in
 *  another one (popup.js), so none keeps showing an account that is no longer the active one. */
export const ACTIVE_ACCOUNT_KEY = "kachat.activeAccountId";
async function publishAccountIds(payload) {
  await setLocal(ACCOUNT_IDS_KEY, payload.accounts.map((a) => a.id));
  await setLocal(ACTIVE_ACCOUNT_KEY, payload.activeAccountId || null);
}

function normalizeAccount(account) {
  const mnemonic = String(account?.mnemonic || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!mnemonic) throw new Error("Your 12 or 24 words are required.");
  return {
    name: String(account?.name || "").trim() || "Account 1",
    mnemonic,
    // NFKD, as BIP39 and iOS derive the seed from (audit EXT-010)
    passphrase: nfkd(account?.passphrase),
    family: account?.family || "kaspaStandard",
    identityIndex: Math.max(0, Math.floor(Number(account?.identityIndex) || 0)),
    // Imported accounts can pick a different chatting address (iOS ChattingAddressPickerView).
    imported: Boolean(account?.imported),
  };
}

/** Names and ids only - never a phrase. What the UI lists. */
function publicView(payload) {
  return {
    activeAccountId: payload.activeAccountId,
    accounts: payload.accounts.map(({ id, name, family, identityIndex, createdAt, passphrase, imported }) => ({
      id, name, family, identityIndex, createdAt, hasPassphrase: Boolean(passphrase), imported: Boolean(imported),
    })),
  };
}

export async function readAccounts() {
  return publicView(await readPayload());
}

/** The active account including its secrets, for deriving keys. Keep the result short-lived. */
export async function activeAccountSecrets() {
  const payload = await readPayload();
  const account = payload.accounts.find((a) => a.id === payload.activeAccountId) || payload.accounts[0];
  if (!account) throw new Error("No account in this wallet.");
  return account;
}

/** One account including its secrets, by id - website approvals act on the connected account. */
export async function accountSecretsById(id) {
  const payload = await readPayload();
  const account = payload.accounts.find((a) => a.id === id);
  if (!account) throw new Error("That account is no longer in the wallet.");
  return account;
}

export async function renameAccount(id, name) {
  return withVaultLock(async () => {
    const clean = String(name || "").trim();
    if (!clean) return readAccounts();
    const payload = await readPayload();
    const account = payload.accounts.find((a) => a.id === id);
    if (account) account.name = clean.slice(0, 40);
    await writePayload(payload);
    return publicView(payload);
  });
}

/**
 * Adds another account (created or imported) to the unlocked vault and makes it the active one.
 * Refuses a phrase that is already in the vault with the same passphrase and address family.
 */
export async function addAccount(account) {
  return withVaultLock(async () => {
    const payload = await readPayload();
    const next = normalizeAccount(account);
    const duplicate = payload.accounts.find((a) =>
      a.mnemonic === next.mnemonic && (a.passphrase || "") === next.passphrase
      && (a.family || "kaspaStandard") === next.family && (a.identityIndex || 0) === next.identityIndex);
    if (duplicate) throw new Error(`This account is already in the wallet as "${duplicate.name}".`);
    const stored = { ...next, id: newAccountId(), createdAt: Date.now() };
    payload.accounts.push(stored);
    payload.activeAccountId = stored.id;
    await writePayload(payload);
    return publicView(payload);
  });
}

/** Moves an account's chatting (identity) address to another index of its family. */
export async function setIdentityIndex(id, index) {
  return withVaultLock(async () => {
    const payload = await readPayload();
    const account = payload.accounts.find((a) => a.id === id);
    if (!account) throw new Error("That account is no longer in the wallet.");
    const next = Math.max(0, Math.floor(Number(index) || 0));
    // never the chatting address of another account from the same words: the two would share
    // their data, and deleting one would wipe the other's (audit 2026-11-13)
    const twin = payload.accounts.find((a) => a.id !== id
      && a.mnemonic === account.mnemonic && (a.passphrase || "") === (account.passphrase || "")
      && (a.family || "kaspaStandard") === (account.family || "kaspaStandard") && (a.identityIndex || 0) === next);
    if (twin) throw new Error(`This address is already the chatting address of "${twin.name}".`);
    account.identityIndex = next;
    await writePayload(payload);
    return publicView(payload);
  });
}

export async function switchAccount(id) {
  return withVaultLock(async () => {
    const payload = await readPayload();
    if (!payload.accounts.some((a) => a.id === id)) throw new Error("That account is no longer in the wallet.");
    payload.activeAccountId = id;
    await writePayload(payload);
    return publicView(payload);
  });
}

/**
 * Removes one account from this browser. The last account can't be removed this way - that is
 * Reset Wallet. Returns the new public view (the next account becomes active).
 */
export async function removeAccount(id) {
  return withVaultLock(async () => {
    const payload = await readPayload();
    if (payload.accounts.length <= 1) throw new Error("This is the only account. Use Reset Wallet to remove everything.");
    payload.accounts = payload.accounts.filter((a) => a.id !== id);
    if (payload.activeAccountId === id) payload.activeAccountId = payload.accounts[0].id;
    await writePayload(payload);
    return publicView(payload);
  });
}

/** An account's recovery phrase (and passphrase), after the password is checked again. */
export async function revealSecrets(id, password) {
  if (!(await verifyPassword(password))) throw new Error("Wrong password.");
  const payload = await readPayload();
  const account = payload.accounts.find((a) => a.id === id);
  if (!account) throw new Error("That account is no longer in the wallet.");
  return { mnemonic: account.mnemonic, passphrase: account.passphrase || "" };
}

/** Re-seals the vault under a new password (new salt), keeping the wallet unlocked. */
export async function changePassword(currentPassword, nextPassword) {
  if (String(nextPassword || "").length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!(await verifyPassword(currentPassword))) throw new Error("The current password is wrong.");
  await withVaultLock(async () => {
    const payload = await readPayload();
    const kdf = newKdf();
    const keyBytes = await deriveKeyBytes(nextPassword, fromBase64(kdf.salt), kdf.iterations);
    await writeVault(await seal(payload, keyBytes, kdf));
    await setSession(SESSION_KEY, sessionRecord(keyBytes, kdf));
  });
}

/**
 * Wipes the wallet from this browser: the vault and the unlock key. The only way back is the
 * recovery phrase, which is why the UI makes this a deliberate, typed confirmation.
 */
/** Removes everything KaPay keeps in this browser (audit EXT-002): the vault and every
 *  kachat.* record on both networks - connections, address caches, spending state, Cold Storage,
 *  portfolios, settings - and the pages' own storage. */
export async function resetWallet() {
  await clearSession();
  const all = (await localArea?.get?.(null)) || {};
  const keys = Object.keys(all).filter((k) => k === VAULT_KEY || k.startsWith("kachat"));
  await removeVault();
  await removeLocal([VAULT_KEY, ...keys]);
  try { localStorage.clear(); } catch { /* nothing kept there */ }
}

/** Confirms a password against the vault without changing the unlock state. */
export async function verifyPassword(password) {
  const vault = await readVault();
  if (!vault) return false;
  try {
    const keyBytes = await deriveKeyBytes(password, fromBase64(vault.kdf.salt), vault.kdf.iterations);
    await open(vault, keyBytes);
    return true;
  } catch {
    return false;
  }
}
