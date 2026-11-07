// The Profile bell (iOS GlobalNotificationCenter + GlobalNotificationListView, 86471dd / 4500ebc).
// It holds two things only:
//   - Kaspa arriving in one of this wallet's own addresses - the chatting address, a spending
//     address, a KasSigner (cold storage) address (iOS AddressActivityNotifier);
//   - news about your .kachat names: offers, sales, renewal and expiry, what became of your own
//     offers (kachat-notifier.js, iOS KachatNamesNotifier) - testnet, where names are live.
// Nothing else: no chats, no KaPosts. Rows are kept per account and network, deduped by id,
// capped at 100; opening the list marks everything seen (the red dot goes away).
//
// A browser wallet only runs while it is open, so receipts are found the way iOS's catch-up finds
// them: each address's balance is compared with the last one seen, and a rise is attributed to the
// transactions that paid it since then - leaving out any whose inputs come from this wallet's own
// addresses (change, consolidations, sends between your own addresses). When the rise can't be
// attributed it still shows, as "Balance increased by". The chatting address counts plain
// transfers only (iOS 56b75c8): a transaction with a payload - a chat payment, a handshake - is
// the chat's own news, and its balance gets no "increased by" row (it moves with every chat). The first look at an address only records
// where it stands, so importing a wallet never fills the bell with old payments.

import { esc } from "./ui.js";
import { SYMBOLS, openPanel } from "./kachat-ui.js";
import { NETWORK, KAS_UNIT, reencodeAddress } from "./net.js";
import * as wallet from "./wallet.js";
import { mergeBellEntries } from "./account-scope.js";
import { logWarn } from "./log.js";

const MAX_ENTRIES = 100;
const MAX_HANDLED = 500;
/** A receipt check runs at most this often (the home screen refreshes every 30 s). */
const RECEIPT_INTERVAL_MS = 25_000;

let scope = ""; // `${network}:${chatting address}`
let entries = [];
let lastSeenAt = 0;
const listeners = new Set();

const entriesKey = () => `kachat_bell_entries:${scope}`;
const seenKey = () => `kachat_bell_seen:${scope}`;
const baselineKey = () => `kachat_bell_balances:${scope}`;
const handledKey = () => `kachat_bell_handled:${scope}`;

function read(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full: kept in memory */ }
}

const scopeFor = (main) => (main ? `${NETWORK}:${String(main).toLowerCase()}` : "");

/** Loads the feed of the account whose chatting address is `main` (call on every account change). */
export function useAccount(main) {
  const next = scopeFor(main);
  if (next === scope) return;
  scope = next;
  const stored = scope ? read(entriesKey(), []) : [];
  // Wallet and .kachat rows only, whatever an older build kept.
  entries = Array.isArray(stored) ? stored.filter((e) => e && (e.source === "wallet" || e.source === "kachat")) : [];
  lastSeenAt = scope ? Number(read(seenKey(), 0)) || 0 : 0;
  changed();
}

/** A deleted account's notifications go with it (KaPay iOS 99ab88a), on both networks. */
export function forgetAccount(main) {
  for (const [network, hrp] of [["mainnet", "kaspa"], ["testnet", "kaspatest"]]) {
    const address = reencodeAddress(main, hrp);
    if (!address) continue;
    const key = `${network}:${address.toLowerCase()}`;
    for (const name of BELL_KEYS) {
      try { localStorage.removeItem(`${name}:${key}`); } catch { /* nothing kept */ }
    }
    if (key === scope) useAccount(null);
  }
}

const BELL_KEYS = ["kachat_bell_entries", "kachat_bell_seen", "kachat_bell_balances", "kachat_bell_handled"];

/** Change Chatting Address: the account's feed moves to its new chatting address, on both networks
 *  (account-data.js carryAccountData). A feed the new address already had is merged with it. */
export function carryAccount(fromMain, toMain) {
  for (const [network, hrp] of [["mainnet", "kaspa"], ["testnet", "kaspatest"]]) {
    const from = reencodeAddress(fromMain, hrp);
    const to = reencodeAddress(toMain, hrp);
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    const fromKey = `${network}:${from.toLowerCase()}`;
    const toKey = `${network}:${to.toLowerCase()}`;
    const [entriesName, seenName, balancesName, handledName] = BELL_KEYS;
    const at = (name, key, fallback) => read(`${name}:${key}`, fallback);
    write(`${entriesName}:${toKey}`, mergeBellEntries(at(entriesName, toKey, []), at(entriesName, fromKey, []), MAX_ENTRIES));
    write(`${seenName}:${toKey}`, Math.max(Number(at(seenName, toKey, 0)) || 0, Number(at(seenName, fromKey, 0)) || 0));
    // the spending addresses' last balances stay; the new chatting address gets its first look
    write(`${balancesName}:${toKey}`, { ...at(balancesName, fromKey, {}), ...at(balancesName, toKey, {}) });
    write(`${handledName}:${toKey}`, [...new Set([...at(handledName, fromKey, []), ...at(handledName, toKey, [])])].slice(-MAX_HANDLED));
    for (const name of BELL_KEYS) {
      try { localStorage.removeItem(`${name}:${fromKey}`); } catch { /* nothing kept */ }
    }
    // the next useAccount loads the carried feed
    if (scope === fromKey || scope === toKey) useAccount(null);
  }
}

export function onBellChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function changed() { for (const fn of listeners) { try { fn(); } catch { /* a listener's own problem */ } } }

export const unreadCount = () => entries.filter((e) => e.timestamp > lastSeenAt).length;

/** Adds a row once (by id). `source`: "wallet" or "kachat"; `targetId`: the name for .kachat rows.
 *  `account`: the chatting address the row is about - dropped when the bell has moved to another
 *  account meanwhile (a check that started before an account switch). */
export function record({ id, source, title, body = "", timestamp = Date.now(), targetId = null, account = null }) {
  if (!scope || !id || (source !== "wallet" && source !== "kachat")) return;
  if (account && scopeFor(account) !== scope) return;
  if (entries.some((e) => e.id === id)) return;
  entries.unshift({ id, source, title, body, timestamp, targetId });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
  write(entriesKey(), entries);
  changed();
}

function markAllSeen() {
  lastSeenAt = Date.now();
  write(seenKey(), lastSeenAt);
  changed();
}

function clearAll() {
  entries = [];
  write(entriesKey(), entries);
  changed();
}

// --- The bell button and its sheet ---------------------------------------------------------

const BELL = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const RECEIVED = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7v10M7.5 12.5L12 17l4.5-4.5"/></svg>';

/** The toolbar's bell: a plain red dot (no count) while anything is unread, as on iOS. */
export function bellButtonHtml() {
  return `<button class="icon bell-button" id="bell" aria-label="Notifications" title="Notifications">${BELL}${unreadCount() > 0 ? '<span class="bell-dot"></span>' : ""}</button>`;
}

/** "5 minutes ago" (iOS .relative(presentation: .named)). */
function relative(ms) {
  const seconds = Math.round((ms - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const steps = [[60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.35, "week"], [12, "month"], [Infinity, "year"]];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) return rtf.format(Math.round(value), unit);
    value /= size;
  }
  return "";
}

/**
 * The bell's sheet: newest first, each row tagged with its source, Clear All. Opening it marks
 * everything seen. A tapped row opens its subject: a receipt the history of the address it reached
 * (iOS 95e2cba), a .kachat row the name.
 *   openWallet(address|null), openName(name)
 */
export function showBell({ openWallet, openName }) {
  let handle = null;
  const rowHtml = (e) => `
    <button class="bell-row" data-entry="${esc(e.id)}">
      <span class="bell-row-icon accent">${e.source === "kachat" ? SYMBOLS.at : RECEIVED}</span>
      <span class="bell-row-text">
        <span class="strong small">${esc(e.title)}</span>
        ${e.body ? `<span class="muted tiny bell-row-body">${esc(e.body)}</span>` : ""}
        <span class="muted tiny">${e.source === "kachat" ? ".kachat" : "Wallet"} · ${esc(relative(e.timestamp))}</span>
      </span>
    </button>`;
  const bodyHtml = () => (entries.length
    ? `<div class="bell-list">${entries.map(rowHtml).join("")}</div>`
    : `<div class="bell-empty">
        <span class="muted">${BELL}</span>
        <div class="strong">No notifications yet</div>
        <p class="muted small">Kaspa arriving in your wallets and news about your .kachat names show up here.</p>
      </div>`);
  const paint = () => {
    if (!handle?.isOpen()) return;
    const host = handle.panel.querySelector("[data-bell]");
    host.innerHTML = bodyHtml();
    const clear = handle.panel.querySelector("#bell-clear");
    if (clear) clear.disabled = !entries.length;
    for (const row of host.querySelectorAll("[data-entry]")) {
      row.onclick = () => {
        const entry = entries.find((e) => e.id === row.dataset.entry);
        if (!entry) return;
        handle.close();
        if (entry.source === "kachat" && entry.targetId) openName(entry.targetId);
        // a receipt opens the history of the address it reached; rows saved before that, Portfolio
        else if (entry.source === "wallet") openWallet(entry.targetId || null);
      };
    }
  };
  handle = openPanel({
    title: "Notifications", leading: "Done", full: true,
    body: `<div class="bell-actions"><button class="bar-text strong" id="bell-clear">Clear All</button></div><div data-bell></div>`,
    onClose: () => off(),
  });
  handle.panel.querySelector("#bell-clear").onclick = () => clearAll();
  const off = onBellChange(paint);
  markAllSeen();
  paint();
}

// --- Received Kaspa (iOS AddressActivityNotifier) -------------------------------------------

let receiptsRunning = false;
let receiptsAt = 0;

const formatKas = (sompi) => {
  const whole = sompi / 100_000_000n;
  const frac = (sompi % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const shortAddress = (a) => (a.length > 20 ? `${a.slice(0, 14)}...${a.slice(-6)}` : a);

/**
 * Checks the wallet's own addresses for Kaspa that arrived since the last look and records a row
 * per paying transaction. `addresses`: `[{ address, label, chatting? }]` - every address of
 * this account (the chatting address, all spending addresses, KasSigner addresses); all of them
 * count as "yours" for the self-send check. `chatting`: plain transfers only. `account`: their
 * chatting address (the feed they belong to). Never throws.
 */
export async function checkReceipts(addresses, { force = false, account = null } = {}) {
  if (!scope || receiptsRunning || !addresses?.length) return;
  // `account`: the chatting address these addresses belong to - never another account's baseline
  if (account && scopeFor(account) !== scope) return;
  if (!force && Date.now() - receiptsAt < RECEIPT_INTERVAL_MS) return;
  receiptsRunning = true;
  receiptsAt = Date.now();
  const myScope = scope;
  try {
    const list = [...new Set(addresses.map((a) => String(a.address).toLowerCase()).filter(Boolean))];
    // the first label an address gets wins: chatting, then spending, then cold storage
    const labels = new Map();
    const chattingSet = new Set();
    for (const a of addresses) {
      const key = String(a.address).toLowerCase();
      if (!labels.has(key)) labels.set(key, a.label);
      if (a.chatting) chattingSet.add(key);
    }
    const own = new Set(list);
    let now;
    try { now = await wallet.balancesFor(list); } catch { return; }
    if (scope !== myScope) return;
    const baseline = read(baselineKey(), {});
    const handled = new Set(read(handledKey(), []));
    const next = { ...baseline };
    const stamp = Date.now();
    for (const address of list) {
      const balance = BigInt(now[address] ?? 0n);
      const before = baseline[address];
      next[address] = { sompi: balance.toString(), at: stamp };
      // first look at this address: only record where it stands
      if (!before) continue;
      const prev = BigInt(before.sompi || "0");
      if (balance <= prev) continue;
      const delta = balance - prev;
      const label = labels.get(address) || "Your address";
      const chatting = chattingSet.has(address);
      const txs = await wallet.recentTransactions(address, 10);
      if (scope !== myScope) return;
      let attributed = false;
      if (txs) {
        // only what paid this address since the last look (block times are in ms)
        const since = Number(before.at || 0) - 120_000;
        for (const tx of txs) {
          const txId = tx.transaction_id;
          const toAddress = (tx.outputs || [])
            .filter((o) => String(o.script_public_key_address || "").toLowerCase() === address)
            .reduce((sum, o) => sum + BigInt(o.amount || 0), 0n);
          if (!txId || toAddress <= 0n) continue;
          if (handled.has(txId)) { attributed = true; continue; }
          if (Number(tx.block_time || 0) < since) continue;
          attributed = true;
          // the chatting address: a chat payment or a handshake (a payload) is the chat's news
          if (chatting && String(tx.payload || "") !== "") { handled.add(txId); continue; }
          handled.add(txId);
          const inputs = (tx.inputs || []).map((i) => String(i.previous_outpoint_address || "").toLowerCase()).filter(Boolean);
          const selfSend = inputs.length > 0 && inputs.some((a) => own.has(a));
          if (selfSend) continue;
          record({
            id: `wallet-${txId}-${address.slice(-12)}`, source: "wallet",
            title: `Received ${formatKas(toAddress)} ${KAS_UNIT}`,
            body: `${label} ${shortAddress(address)}`,
            timestamp: Number(tx.block_time) || stamp,
            // the address it reached: the row opens its history (iOS 95e2cba)
            targetId: address,
          });
        }
      }
      if (!attributed && !chatting) {
        // the rise isn't in the recent transactions (deep history, an indexer behind): say so anyway
        record({
          id: `wallet-bal-${address.slice(-12)}-${stamp}`, source: "wallet",
          title: `Balance increased by ${formatKas(delta)} ${KAS_UNIT}`,
          body: `${label} ${shortAddress(address)}`,
          timestamp: stamp,
          targetId: address,
        });
      }
    }
    write(baselineKey(), next);
    write(handledKey(), [...handled].slice(-MAX_HANDLED));
  } catch (error) {
    logWarn("[KaPay] bell receipts:", error);
  } finally {
    receiptsRunning = false;
  }
}
