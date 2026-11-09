// The account a wallet window shows, and the account data kept outside the vault, by key.
//
// The popup and the full tab can be open at once, and the vault has one active account for both.
// Each window remembers the account it drew its screens for (popup.js sets it); an action on "this
// account" - Delete Account, View 12 or 24 Words, Back Up Account - acts on that one, and only while
// it is still the active account: a switch made in another window refuses it rather than deleting,
// showing or marking a different account than the one on screen. (Every window also follows a
// switch made elsewhere, popup.js; this is the check for the moment in between.)
//
// No imports and no DOM, for tools/test-account-scope.mjs.

let shown = { id: null, address: null };

/** popup.js: the account the Wallet tab was drawn for (null when none is: signed out, locked). */
export function setShownAccount(next) {
  shown = { id: next?.id || null, address: next?.address || null };
}

/** `{ id, address }` of the account this window shows; both null when none. */
export const shownAccount = () => ({ ...shown });

export const SWITCHED_ELSEWHERE = "You switched accounts in another KaPay window. Check the Wallet tab and try again.";

/**
 * The shown account from a fresh `vault.readAccounts()` view, or an Error when it can't be acted on:
 * no account shown, or another window made a different account active since.
 */
export function shownActiveAccount(view, shownId = shown.id) {
  const active = view?.accounts?.find((a) => a.id === view.activeAccountId) || null;
  if (!shownId || !active || active.id !== shownId) throw new Error(SWITCHED_ELSEWHERE);
  return active;
}

/** Whether a window showing `shownId` follows the vault's active account becoming `activeId`.
 *  A window showing no account (the sign-in screen, unlock) has nothing to follow. */
export function followsSwitch(shownId, activeId) {
  return Boolean(shownId) && Boolean(activeId) && shownId !== activeId;
}

// --- what an account keeps outside the vault ----------------------------------------------------

const lower = (address) => String(address || "").trim().toLowerCase();

/**
 * Every record a deleted account leaves (KaPay iOS 99ab88a removeSavedAccount), on both networks:
 *   local   chrome.storage.local keys
 *   page    localStorage keys
 * `addresses`: its chatting and spending addresses as kept (any network); `variants(address)`: that
 * address on both networks. The contacts, the bell and the backup status have their own forget.
 */
export function accountDataKeys({ accountId, chatting = null, addresses = [], variants = (a) => [a], keep = [] }) {
  const both = (address) => [...new Set([address, ...(variants(address) || [])].filter(Boolean))];
  const local = [];
  if (accountId) {
    for (const base of ["spending", "addresses", "balances", "cold", "coldBalances", "portfolios", "portfolioFees", "pendingDiscovery"]) {
      local.push(`kachat.${base}.${accountId}`, `kachat.${base}.${accountId}.testnet`);
    }
  }
  // UTXO labels are kept per address as written (wallet.js utxoLabelsKey): both spellings
  // ...except an address another account still lists: the same 12 or 24 words saved twice (another
  // chatting index or family) share their spending addresses, and those labels are still theirs
  const kept = new Set(keep.filter(Boolean).flatMap((address) => both(address).map(lower)));
  for (const address of new Set([chatting, ...addresses].filter(Boolean))) {
    if (kept.has(lower(address))) continue;
    for (const each of both(address)) local.push(`kachat.utxoLabels.${each}`, `kachat.utxoLabels.${lower(each)}`);
  }
  const page = [];
  for (const each of chatting ? both(chatting) : []) {
    const key = lower(each);
    page.push(
      `kachat-swap-history-v1:${key}`,           // swaps.js, per chatting address
      `kachat-swap-disclaimer-agreed-v1:${key}`,
      `kachat-names-notifier-v1:${each}`,        // kachat-notifier.js, the wallet address as given
      `kachat-names-notifier-v1:${key}`,
      `kachat-held-payments-v1:${key}`,          // shared/engine/sync.js
      `kachat_market_addresses.${key}`,          // shared/engine/kachat-names/actions.js
    );
  }
  // kachat-owned-cache.js: per network by name, the address lowercased
  for (const each of chatting ? both(chatting) : []) {
    const network = lower(each).startsWith("kaspatest:") ? "testnet" : "mainnet";
    page.push(`kachat_owned_names_${network}_${lower(each)}`);
  }
  return { local: [...new Set(local)], page: [...new Set(page)] };
}

/** The account-last-used map (onboarding.js) without `accountId`. */
export function withoutAccount(map, accountId) {
  const next = { ...(map && typeof map === "object" ? map : {}) };
  delete next[accountId];
  return next;
}

/** A bell feed carried to another chatting address: both feeds, each row once (the newest copy),
 *  newest first, capped as the bell caps it. */
export function mergeBellEntries(into, from, max = 100) {
  const seen = new Set();
  const out = [];
  for (const entry of [...(Array.isArray(from) ? from : []), ...(Array.isArray(into) ? into : [])]) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)).slice(0, max);
}

/** A contacts list carried to another chatting address: the new address's entries stay, the old
 *  one's are added where the new list hasn't the address. */
export function mergeContacts(into, from) {
  const list = Array.isArray(into) ? [...into] : [];
  const have = new Set(list.map((e) => e?.address));
  for (const entry of Array.isArray(from) ? from : []) if (entry?.address && !have.has(entry.address)) list.push(entry);
  return list;
}

/** The date an imported contact that was deleted here gets (iOS AddressBookManager.importExport,
 *  KaPay iOS 1652437): bringing it back is a new edit, so it's dated after the deletion - past the
 *  deletion's second, since the files keep whole seconds - and never before now. With the file's
 *  older date, a merge would let the deletion win again. All in ms. */
export function datedAfterDeletion(deletedAt, now = Date.now()) {
  const afterDeletion = (Math.floor(Number(deletedAt) / 1000) + 1) * 1000;
  return Number.isFinite(afterDeletion) ? Math.max(now, afterDeletion) : now;
}
