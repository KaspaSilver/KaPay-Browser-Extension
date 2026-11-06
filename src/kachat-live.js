// The live .kachat screens, TESTNET ONLY (testnet-10 and a verified registry manifest) - a port of
// iOS KachatNamesLiveViews.swift: the hub's search, registrations in flight, Marketplace / My
// Names / Activity, the name detail with its actions, every transaction sheet and Your Domains >
// .kachat. On mainnet none of this is reached: market.js keeps its "Coming soon" mockups.
//
// Every spending or destructive action is the Send Kaspa flow's steps (KaPay 05db583,
// send-steps.js): an entry step when it takes one (an amount or a price on the keypad, a new owner
// on the recipient card, how long), then a review that shows its cost first (built against live
// UTXOs, nothing sent) with the fee - Normal / Fast / Priority, or Edit for a fee of your own - and
// swipe up to confirm (the swipe is the confirmation, iOS e67074c); then the wallet password (the
// browser's stand-in for iOS's device lock, DeviceAuth) before anything is signed. The swipe-up
// screen follows the transaction: the BlockDAG while it goes out, then its progress, or Failed with
// Try Again (KaPay 5bab351) - or "Not confirmed" with only Done when the network never answered,
// since Try Again could pay twice (KaPay 953b255: errorText keeps that message word for word).
//
// Left out on purpose: iOS's Message button on a name's owner (the wallet has no chats).

import { app, esc, render, $, toast, ICONS, navHeader, unitText, showSheet } from "./ui.js";
import { KAS_UNIT } from "./net.js";
import { looksLikeName, resolveEverywhere, primaryResolution, notFoundMessage, otherDomainsHtml, bindOtherDomains, splitTypedName } from "./names.js";
import { sompiFromUserText } from "./amounts.js";
import * as vault from "./vault.js";
import * as wallet from "./wallet.js";
import { kachatNames, kachatProfiles, kachatRegistry, kachatLaunched, prepareSigner, prepareOfferSigners } from "./kachat-names.js";
import { SYMBOLS, openPanel, kachatWordmark, showTileSheet } from "./kachat-ui.js";
import { Operation, Stage, isOpen, needsDriving, KachatNamesActions, FeeTier, FeeChoice, TxStage } from "../shared/engine/kachat-names/actions.js";
import { FEE_TIERS, feeControlsHtml, recipientCardHtml, recipientStatusHtml, recipientLookup, bindAddressBookButton } from "./send-pieces.js";
import {
  createStepFlow, showStep, showSwipeUp, showFeeEditor, SWIPE_UP_LABELS, keypadAmountEntryHtml, paintKeypadAmountEntry,
  bindKeypad, applyKeypadKey, reviewCardHtml, reviewRowHtml,
} from "./send-steps.js";
import { paramsExpiresSoonMs, paramsRegisterCost } from "../shared/engine/kachat-names/manifest.js";
import { KachatNamesRegistry } from "../shared/engine/kachat-names/registry.js";
import { Status, Profile, SocialKind, SocialPlatform, SocialSource } from "../shared/engine/kachat-names/registry-state.js";
import { normalize, unhex32, p2pkScript, bytesEqual, yearMs, tier } from "../shared/engine/kachat-names/codec.js";
import { isRegistryUpgrading, registryUpgradingMessage } from "../shared/engine/kachat-names/service.js";
import { scanQr } from "./camera.js";
import * as dock from "./dock.js";
import "./kachat-steps.css";

// --- Amounts (iOS KaspaUnit.amount / signed / parseSompi) ----------------------------------

const SOMPI = 100_000_000n;

/** "35", "0.2", "1.99831": exact, trailing zeros dropped. */
function plain(sompi) {
  const v = BigInt(sompi ?? 0n);
  const whole = v / SOMPI;
  const frac = v % SOMPI;
  if (frac === 0n) return String(whole);
  return `${whole}.${String(frac).padStart(8, "0").replace(/0+$/, "")}`;
}

/** "35 TKAS". */
export function amount(sompi) { return `${plain(sompi)} ${KAS_UNIT}`; }

/** "+1.99 TKAS" / "-36.002 TKAS". */
function signed(delta) {
  const v = BigInt(delta);
  return v >= 0n ? `+${amount(v)}` : `-${amount(-v)}`;
}

/** "12.5" or "12,5" -> sompi; null for anything else - the one exact parser (amounts.js). */
const parseSompi = (text) => sompiFromUserText(text);

const positive = (v) => (v != null && v > 0n ? v : null);

// --- Shared pieces (iOS KachatLive) --------------------------------------------------------

/** What the password prompt says before any .kachat transaction is signed. */
const AUTH_REASON = "Confirm this .kachat transaction";
/** testnet-10 runs at 10 blocks per second */
const DAA_PER_SECOND = 10n;

const dateOf = (ms) => new Date(Number(ms));
/** "Oct 12, 2027" - with the time when it is within two days (testnet's 10-minute periods). */
const day = (ms) => {
  const near = Math.abs(Number(ms) - Date.now()) < 2 * 86_400_000;
  return dateOf(ms).toLocaleString(undefined, near
    ? { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" });
};

/** "2 hours ago", "yesterday" (iOS .relative(presentation: .named)). */
function relative(ms) {
  const seconds = (Number(ms) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(Math.round(seconds), "second");
}

const registry = () => kachatRegistry();
/** The registry parameters, once the manifest is verified. */
const params = () => registry()?.manifest?.params ?? null;

// --- The period clock (registry v3, iOS 49c0baa): a year on mainnet, 10 minutes on testnet ---

const periodMs = () => params()?.periodMs ?? yearMs;
/** Whether a period is a year (mainnet), not a short test clock. */
const yearlyPeriods = () => periodMs() === yearMs;
/** A length of time: "10 min", "1h 30m", "10 days". */
function duration(ms) {
  const minutes = Math.round(Number(ms) / 60000);
  if (minutes >= 1440) { const d = Math.round(minutes / 1440); return `${d} day${d === 1 ? "" : "s"}`; }
  if (minutes >= 60) { const h = Math.floor(minutes / 60), m = minutes % 60; return m ? `${h}h ${m}m` : `${h}h`; }
  return `${minutes} min`;
}
/** Time left until a moment, for a live countdown (iOS KachatLive.countdown, cb3c27d): "2d 5h"
 *  while days remain, else "1:04:09" or "4:09"; "0:00" once it passed. */
function countdownText(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  if (!Number.isFinite(total)) return "";
  if (total >= 86_400) {
    const days = Math.floor(total / 86_400);
    const hours = Math.floor((total % 86_400) / 3_600);
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`;
}

// Live countdowns (iOS TimelineView, every second): each [data-countdown] shows the time left until
// its unix-ms moment. One timer while any is on screen. One with data-countdown-reload reloads the
// hub once when it reaches zero, so a released name moves from Expired to Available (iOS cb3c27d).
let countdownTimer = null;
const countdownReloaded = new Set();

function countdownHtml(atMs, { reloadKey = null } = {}) {
  if (countdownTimer == null) countdownTimer = setInterval(tickCountdowns, 1_000);
  const at = Number(atMs);
  return `<span class="kl-countdown" data-countdown="${at}"${reloadKey ? ` data-countdown-reload="${esc(reloadKey)}"` : ""}>${esc(countdownText(at - Date.now()))}</span>`;
}

function tickCountdowns() {
  const shown = [...document.querySelectorAll("[data-countdown]")];
  if (!shown.length) { clearInterval(countdownTimer); countdownTimer = null; return; }
  const now = Date.now();
  let released = false;
  for (const el of shown) {
    const left = Number(el.dataset.countdown) - now;
    const text = countdownText(left);
    if (el.textContent !== text) el.textContent = text;
    const key = el.dataset.countdownReload;
    if (key && left <= 0 && !countdownReloaded.has(key)) { countdownReloaded.add(key); released = true; }
  }
  if (released && hub.isLive) hub.reload();
}

/** `count` periods: "1 year" / "2 years", or on a short clock "10 min" / "20 min". */
function periods(count) {
  const n = BigInt(count);
  if (yearlyPeriods()) return n === 1n ? "1 year" : `${n} years`;
  return duration(n * periodMs());
}
/** What registering `name` costs for its first period (registry v4). */
function namePrice(name) {
  // Registry v4: fixed prices baked into the pinned templates (the manifest's register table) -
  // what registering costs for the first period (iOS c8f1086 KachatLive.price).
  const prices = params()?.registerPrices;
  return prices?.length === 5 ? prices[tier(new TextEncoder().encode(name).length)] : null;
}
/** What one more period of `name` costs: extend, renew, and registering past the first period
 *  (the manifest's renew table; iOS c8f1086 KachatLive.renewPrice). */
function renewPrice(name) {
  const prices = params()?.renewPrices;
  return prices?.length === 5 ? prices[tier(new TextEncoder().encode(name).length)] : null;
}
/** "Price per year", or on a short clock "Price per 10 min". */
const pricePerPeriodTitle = () => (yearlyPeriods() ? "Price per year" : `Price per ${periods(1)}`);
const graceMs = () => registry()?.graceMs ?? 0n;
const statusOf = (info) => info.status(graceMs());
const shortAddress = (a) => KachatNamesRegistry.shortAddress(a);
const addressOf = (key) => KachatNamesRegistry.addressOf(key);

/** The network prefix plus both ends of an address on one line: kaspatest:qr4x7k...a9z2pq
 *  (iOS KachatNamesRegistry.compactAddress) - where the full address doesn't fit. */
function compactAddress(address) {
  const colon = address.indexOf(":");
  if (colon < 0) return address;
  const body = address.slice(colon + 1);
  return body.length > 14 ? `${address.slice(0, colon + 1)}${body.slice(0, 6)}...${body.slice(-6)}` : address;
}

/** An event party: an address (indexer) or an x-only key in hex (walker), as a short address. */
function party(s) {
  if (!s) return null;
  if (s.startsWith("kaspa")) return shortAddress(s);
  try {
    const a = addressOf(unhex32(s));
    if (a) return shortAddress(a);
  } catch { /* not a key */ }
  return s;
}

let myKey = null; // the bound signer's x-only key, set when the runtime is fetched
let lastActions = null; // the actions of the last runtime fetched (offer states)
const runtimeActions = () => lastActions;
/** A key of this wallet: the chatting address or any revealed spending address (iOS d1026de,
 *  IOS-085). Set as Primary still asks for the chatting key itself (`isChattingKey`). */
const isMine = (key) => {
  if (!key) return false;
  try { if (lastActions?.isOwnKey(key)) return true; } catch { /* not known yet */ }
  return isChattingKey(key);
};
const isChattingKey = (key) => Boolean(myKey && key && bytesEqual(myKey, key));

/** The registry events that hand a name to a (new) owner. */
const OWNERSHIP_OPS = new Set(["register", "import", "transfer", "sale", "offer_accepted", "offer_accept"]);

/** MAINNET.md C6 (iOS 0312a3f KachatLiveNameDetail.currentOffers, KaChat-Desktop currentOffers): an
 *  offer is bound to a seller key, so one made to this owner before the name last left them - and
 *  came back - could be accepted again. Only offers made since the current owner got the name are
 *  shown for them; others to other sellers (declined, on their way back to the buyer) stay. */
function currentOffers(offers, owner, history) {
  let since = null;
  for (const e of history ?? []) {
    if (!OWNERSHIP_OPS.has(e?.op) || e.at == null) continue;
    const at = BigInt(e.at);
    if (since == null || at > since) since = at;
  }
  if (since == null) return offers;
  return (offers ?? []).filter((o) => {
    if (!owner || !bytesEqual(o.seller, owner) || o.createdAt == null) return true;
    return BigInt(o.createdAt) >= since;
  });
}

const EVENT_ICONS = {
  register: SYMBOLS.atPlus, transfer: SYMBOLS.arrows, list: SYMBOLS.tag, delist: SYMBOLS.tagSlash,
  sale: SYMBOLS.cart, offer_accepted: SYMBOLS.cart, renew: SYMBOLS.renew, extend: SYMBOLS.calendarPlus, release: SYMBOLS.release, reclaim: SYMBOLS.reclaim,
  // a name carried over from the previous registry (registry v5, iOS dd836cb)
  import: SYMBOLS.arrowDownDoc,
};
const EVENT_TITLES = {
  register: "Registered", transfer: "Transferred", list: "Listed", delist: "Delisted", sale: "Sold",
  offer_accepted: "Offer accepted", offer_accept: "Offer accepted", renew: "Renewed", extend: "Extended", release: "Released",
  reclaim: "Reclaimed", import: "Moved to the new registry", offer: "Offer made", offer_withdraw: "Offer withdrawn", offer_refund: "Offer refunded", offer_decline: "Offer declined",
};

/** Why a typed name is not a name. */
function invalidReason(name) {
  const bytes = new TextEncoder().encode(name);
  if (!bytes.length || bytes.length > 32) return "A name is 1 to 32 characters.";
  if (!/^[a-z0-9-]+$/.test(name)) return "Use a-z, 0-9 and hyphens only.";
  if (name.startsWith("-") || name.endsWith("-")) return "A name can't start or end with a hyphen.";
  return null;
}

const errorText = (error) => String(error?.message || error || "Something went wrong.");

function statusPill(status) {
  // past grace a name is free to claim: "Available" (iOS eea52b2)
  const title = status === Status.active ? "Active" : status === Status.grace ? "Expired" : "Available";
  return `<span class="kl-pill kl-${status}">${title}</span>`;
}

export const testnetBadge = () => '<span class="kl-testnet">Testnet</span>';

const sectionHeader = (title, detail = null) => `
  <div class="km-header"><div class="km-title">${esc(title)}</div>${detail ? `<div class="muted tiny">${esc(detail)}</div>` : ""}</div>`;

/** iOS KachatLiveEmpty: the text, or a spinner while loading (text null). */
const emptyCard = (text) => `<div class="km-card km-empty-card ${text ? "muted small" : ""}">${text ? esc(text) : '<span class="spinner"></span>'}</div>`;

/** One name in a list: the name, a line about it, and its price or status (iOS KachatLiveNameRow). */
function nameRowHtml(info, { showPrice = true, showRenewal = false, attr = "" } = {}) {
  const status = statusOf(info);
  const owner = isMine(info.owner) ? "Yours" : (addressOf(info.owner) ? shortAddress(addressOf(info.owner)) : "");
  const p = params();
  // My Names: say when an active name's renewal window is open (registry v2).
  const trailing = showRenewal && status === Status.active && p && info.renewOpen(p)
    ? '<span class="kl-pill kl-grace">Renewal open</span>'
    : showPrice && info.isListed && status === Status.active
    ? `<span class="strong small">${esc(amount(info.price))}</span>`
    : status !== Status.active ? statusPill(status) : "";
  return `
    <button class="km-row" data-name="${esc(info.name)}" ${attr}>
      <span class="kl-at">${SYMBOLS.at}</span>
      <span class="tx-meta"><span class="strong small ellipsis">${esc(info.display)}</span><span class="muted tiny ellipsis">${esc(owner)} · until ${esc(day(info.expiresAt))}</span></span>
      ${trailing}
      <span class="km-chevron">${ICONS.chevron}</span>
    </button>`;
}

/** iOS KachatEventRow. */
function eventRowHtml(event, showName = false) {
  const to = event.op !== "offer" ? party(event.to) : null;
  const trailing = event.price != null
    ? `<span class="small">${esc(amount(event.price))}</span>`
    : event.years != null ? `<span class="muted small">+${esc(String(event.years))}</span>` : "";
  return `
    <div class="km-row">
      <span class="accent km-icon">${EVENT_ICONS[event.op] || SYMBOLS.hand}</span>
      <span class="tx-meta">
        <span class="strong small ellipsis">${esc(EVENT_TITLES[event.op] || "Activity")}${showName && event.name ? ` ${esc(event.name)}.kachat` : ""}</span>
        <span class="muted tiny ellipsis">${to ? `→ ${esc(to)} ` : ""}${event.at != null ? esc(relative(event.at)) : ""}</span>
      </span>
      ${trailing}
    </div>`;
}

// --- Password confirmation (iOS DeviceAuth) ------------------------------------------------

/** Asks for the wallet password; resolves true once it is right, false when cancelled. */
export function confirmPassword(reason = AUTH_REASON) {
  return new Promise((resolve) => {
    document.querySelector(".kl-auth")?.remove();
    const backdrop = document.createElement("div");
    backdrop.className = "alert-backdrop kl-auth";
    backdrop.innerHTML = `
      <form class="alert" role="alertdialog" aria-modal="true" aria-label="${esc(reason)}">
        <div class="alert-body">
          <div class="alert-title">${esc(reason)}</div>
          <div class="alert-message">Enter your wallet password.</div>
          <input class="alert-field" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" />
          <div class="error kl-auth-error"></div>
        </div>
        <div class="alert-buttons two">
          <button type="button" class="alert-button" data-cancel>Cancel</button>
          <button type="submit" class="alert-button strong">Confirm</button>
        </div>
      </form>`;
    const done = (ok) => { backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(ok); };
    const onKey = (event) => { if (event.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop || event.target.closest("[data-cancel]")) done(false); });
    const input = backdrop.querySelector(".alert-field");
    backdrop.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      if (await vault.verifyPassword(input.value)) return done(true);
      backdrop.querySelector(".kl-auth-error").textContent = "Wrong password.";
      input.select();
    };
    document.body.appendChild(backdrop);
    input.focus();
  });
}

/** An iOS alert with a destructive confirm button; resolves true on confirm. */
export function confirmAlert({ title, message, confirmLabel, cancelLabel = "Cancel", destructive = true }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "alert-backdrop";
    backdrop.innerHTML = `
      <div class="alert" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="alert-body">
          <div class="alert-title">${esc(title)}</div>
          ${message ? `<div class="alert-message">${unitText(esc(message))}</div>` : ""}
        </div>
        <div class="alert-buttons two">
          <button type="button" class="alert-button" data-cancel>${esc(cancelLabel)}</button>
          <button type="button" class="alert-button strong ${destructive ? "danger-text" : ""}" data-ok>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const done = (ok) => { backdrop.remove(); document.removeEventListener("keydown", onKey); resolve(ok); };
    const onKey = (event) => { if (event.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop || event.target.closest("[data-cancel]")) done(false);
      else if (event.target.closest("[data-ok]")) done(true);
    });
    document.body.appendChild(backdrop);
    backdrop.querySelector("[data-ok]").focus();
  });
}

// --- A finished transaction (iOS KachatTxDone / KachatTxDoneSheet) --------------------------

/** What the receipt says under its title for each stage (iOS KachatTxDoneSheet.stageText). */
function txStageText(stage) {
  switch (stage) {
    case TxStage.accepted: return "It's in a block. Updating KaPay...";
    case TxStage.shown: return "Done. It shows in KaPay now.";
    case TxStage.dropped: return "The network hasn't taken it. Nothing was spent if it never lands - try again with a faster fee.";
    default: return "Waiting for the network to put it in a block. Usually a few seconds; longer when it's busy.";
  }
}

const CIRCLE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/></svg>';

/** One step of the receipt: done (a green check), active (a spinner) or still to come (a circle). */
function txStepHtml(text, { done = false, active = false } = {}) {
  const icon = done ? `<span class="kl-green">${ICONS.checkFill}</span>` : active ? '<span class="spinner small-spin"></span>' : `<span class="muted">${CIRCLE}</span>`;
  return `<div class="kl-receipt-step ${done || active ? "on" : ""}"><span class="kl-receipt-step-icon">${icon}</span><span>${esc(text)}</span></div>`;
}

/**
 * The receipt every name transaction (and profile save) ends on (iOS KachatTxDoneSheet, e426432),
 * in the Send receipt's style: its progress followed on a node (actions.follow) - a spinner until
 * it lands, then a check; steps Sent to the network / In a block / Updated in KaPay;
 * dropped says so and suggests a faster fee - and the transaction id (click to copy) with View in
 * Explorer. Closing it early is fine: the change still lands. `accepted`: already known to be in a
 * block (a registration the driver saw land). A transaction `perform` didn't send (a profile save)
 * is followed here. `onClose` runs when it goes away.
 */
export function showTxDone({ txId, title = "Transaction sent", onClose = () => {}, accepted = false, note = null }) {
  document.querySelector(".kl-done-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "sheet-backdrop kl-done-backdrop";
  let actions = runtimeActions();
  const stage = () => actions?.txStage?.(txId) ?? (accepted ? TxStage.shown : TxStage.sent);
  const body = () => {
    const st = stage();
    const inBlock = st === TxStage.accepted || st === TxStage.shown;
    const icon = st === TxStage.shown ? `<span class="kl-green kl-done-icon">${SYMBOLS.sent}</span>`
      : st === TxStage.dropped ? `<span class="kl-orange kl-done-icon">${SYMBOLS.warning}</span>`
        : '<span class="kl-done-icon"><span class="spinner"></span></span>';
    return `
      <div class="sheet kl-done" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="sheet-grabber"></div>
        ${icon}
        <div class="kl-done-title">${esc(title)}</div>
        <p class="muted small center-text">${esc(txStageText(st))}</p>
        ${note ? `<div class="kl-locked-note accent">${SYMBOLS.lock || ""}<span class="small">${esc(note)}</span></div>` : ""}
        <div class="kl-receipt-steps">
          ${txStepHtml("Sent to the network", { done: true })}
          ${txStepHtml("In a block", { done: inBlock, active: !inBlock && st !== TxStage.dropped })}
          ${txStepHtml("Updated in KaPay", { done: st === TxStage.shown, active: st === TxStage.accepted })}
        </div>
        <button class="kl-txid" id="kl-copy-tx" title="Copy">
          <span class="mono tiny ellipsis">${esc(txId)}</span><span class="kl-copy-icon">${ICONS.copy || ""}</span>
        </button>
        <a class="km-prominent kl-full kl-explorer" href="${esc(wallet.explorerTxUrl(txId))}" target="_blank" rel="noopener noreferrer">View in Explorer</a>
        <button class="bar-text strong" data-done>Done</button>
      </div>`;
  };
  const paintBody = () => {
    backdrop.innerHTML = body();
    backdrop.querySelector("#kl-copy-tx").onclick = async () => {
      try { await navigator.clipboard.writeText(txId); toast("Transaction ID copied"); } catch { /* clipboard refused */ }
    };
  };
  let unsubscribe = null;
  let last = null;
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    try { unsubscribe?.(); } catch { /* gone */ }
    onClose();
  };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop || event.target.closest("[data-done]")) close(); });
  paintBody();
  last = stage();
  document.body.appendChild(backdrop);
  // Follow it: names where the registry runs, profile saves on every network.
  (async () => {
    actions = (await runtime().catch(() => null))?.actions ?? (await kachatProfiles().catch(() => null))?.actions ?? null;
    if (!actions || !backdrop.isConnected) return;
    unsubscribe = actions.subscribe?.(() => {
      const st = stage();
      if (st !== last && backdrop.isConnected) { last = st; paintBody(); }
    }) ?? null;
    if (!accepted && actions.txStage?.(txId) == null) {
      try { actions.follow?.(txId, null); } catch { /* shows as sent */ }
    }
    if (stage() !== last) { last = stage(); paintBody(); }
  })();
}

// --- The runtime ---------------------------------------------------------------------------

/** The runtime with the signer bound (keeps `myKey` current). */
async function runtime() {
  const rt = await kachatNames();
  myKey = rt?.actions.myKey ?? null;
  lastActions = rt?.actions ?? null;
  return rt;
}

// --- Hub model (iOS KachatHubModel) --------------------------------------------------------

/**
 * The hub's state, kept while you go into a name and back (iOS @StateObject). market.js renders
 * it; `hub.onChange` is the screen's repaint.
 */
export const hub = {
  /** null until the manifest is checked; false when it fails (the hub then stays a mockup) */
  ready: null,
  setupError: null,
  /** the bundled manifest is for the previous registry (v1): a calm "Setting up" */
  upgrading: false,
  search: { kind: "idle" },
  listings: [],
  /** names expired past grace: back on the market, Available to anyone (iOS eea52b2) */
  lapsed: [],
  /** expired and still in grace: the Expired tab, each counting down to its release (iOS cb3c27d) */
  grace: [],
  activity: [],
  loadError: null,
  loaded: false,
  pending: [],
  virtualDaa: null,
  onChange: null,
  _started: false,
  _lookupToken: 0,

  get isLive() { return this.ready === true; },

  changed() { this.onChange?.(); },

  async start() {
    let rt;
    try {
      rt = await runtime();
      await rt.registry.prepare({ forceSourceCheck: true });
      this.ready = true;
      this.setupError = null;
      this.upgrading = false;
    } catch (error) {
      this.ready = false;
      this.upgrading = isRegistryUpgrading(error);
      this.setupError = errorText(error);
      this.changed();
      return;
    }
    if (!this._started) {
      this._started = true;
      rt.actions.subscribe(({ pending, virtualDaa }) => {
        this.pending = pending;
        this.virtualDaa = virtualDaa;
        this.changed();
      });
      rt.registry.onChange(() => { if (this.isLive) this.reload(); });
    }
    rt.actions.resume();
    watchRegistrations();
    this.pending = rt.actions.pending;
    this.virtualDaa = rt.actions.virtualDaa;
    this.changed();
    await rt.registry.refresh();
    await this.reload();
  },

  async refresh() {
    if (!this.isLive) return;
    await registry().refresh();
    await this.reload();
  },

  async reload() {
    if (!this.isLive) return;
    const reg = registry();
    try {
      this.listings = await reg.listings();
      this.lapsed = await reg.lapsed();
      this.grace = await reg.inGrace().catch(() => []);
      // Your own names and the offers you made live in Profile > Your Domains (iOS 0765ce0).
      this.activity = await reg.activity();
      this.loadError = null;
    } catch (error) {
      this.loadError = errorText(error);
    }
    this.loaded = true;
    this.changed();
  },

  /** The typed name's availability, after iOS's 350 ms pause. */
  lookup(text) {
    const token = ++this._lookupToken;
    const typed = normalize(text);
    if (!typed) { this.search = { kind: "idle" }; this.changed(); return; }
    if (invalidReason(typed)) { this.search = { kind: "invalid", name: typed }; this.changed(); return; }
    this.search = { kind: "checking", name: typed };
    this.changed();
    setTimeout(async () => {
      if (token !== this._lookupToken) return;
      try {
        // an expired name (past grace) searches as free to claim (iOS eea52b2 claimLookup)
        const found = await registry().claimLookup(typed);
        if (token !== this._lookupToken) return;
        this.search = found.kind === "registered"
          ? { kind: "registered", name: typed, info: found.info }
          : { kind: "free", name: typed, gap: found.gap };
      } catch (error) {
        if (token !== this._lookupToken) return;
        this.search = { kind: "failed", name: typed, message: errorText(error) };
      }
      this.changed();
    }, 350);
  },

};

// --- Hub: search result (iOS KachatLiveSearchResult) ---------------------------------------

/** The search result card for `typed` (already lowercased), or "". */
export function searchResultHtml(typed) {
  const name = normalize(typed);
  if (!name) return "";
  const s = hub.search;
  const title = (text) => `<span class="strong ellipsis">${esc(text)}</span>`;
  let body;
  if (s.kind === "registered" && s.name === name) {
    const n = s.info;
    const status = statusOf(n);
    let line;
    if (status === Status.active) {
      line = `<span class="muted tiny">${isMine(n.owner) ? "Yours" : n.isListed ? `Taken · for sale at ${esc(amount(n.price))}` : "Taken"}</span>`;
    } else if (status === Status.grace) {
      line = '<span class="tiny kl-orange">Expired - the owner can still renew it</span>';
    } else {
      line = ""; // never reached: a name past grace searches as free to claim (claimLookup)
    }
    return `
      <button class="km-card km-search-result kl-result-button" data-name="${esc(n.name)}">
        <span class="tx-meta">${title(n.display)}${line}</span>
        <span class="km-chevron">${ICONS.chevron}</span>
      </button>`;
  }
  if (s.kind === "free" && s.name === name) {
    // no price here: a name's first year and later years cost differently (the claim's "For how
    // long?" shows each, KaPay 05db583)
    body = `
      <span class="tx-meta">${title(`${name}.kachat`)}<span class="tiny kl-green">Available</span></span>
      <button class="km-prominent small-button" id="claim" ${s.gap ? "" : "disabled"}>Claim</button>`;
  } else if (s.kind === "invalid" && s.name === name) {
    body = `<span class="tx-meta">${title(`${name}.kachat`)}<span class="muted tiny">${esc(invalidReason(name) || "Not a valid name.")}</span></span>`;
  } else if (s.kind === "failed" && s.name === name) {
    body = `<span class="tx-meta">${title(`${name}.kachat`)}<span class="muted tiny">${esc(s.message)}</span></span>`;
  } else {
    body = `<span class="tx-meta">${title(`${name}.kachat`)}</span><span class="spinner small-spin"></span>`;
  }
  return `<div class="km-card km-search-result">${body}</div>`;
}

/** Wires the search result inside `container`. */
export function bindSearchResult(container, nav) {
  container.querySelector("#claim")?.addEventListener("click", () => {
    const s = hub.search;
    if (s.kind === "free" && s.gap) openClaimSheet({ name: s.name, gap: s.gap });
  });
  container.querySelector(".kl-result-button")?.addEventListener("click", () => {
    if (hub.search.kind === "registered") nav.openName(hub.search.info);
  });
}

// --- Hub: registrations in flight (iOS KachatRegistrationCard) -----------------------------

const STAGE_TEXT = {
  [Stage.committing]: "Sending the hidden commit...",
  [Stage.registering]: "Registering...",
  [Stage.registered]: "Registered. It's yours.",
  [Stage.taken]: "Someone registered this name first. Cancel the commit to get its 0.2 KAS back.",
  [Stage.failed]: "The registration stopped.",
  [Stage.cancelling]: "Cancelling the commit...",
  [Stage.cancelled]: "Cancelled.",
};

const cardErrors = new Map(); // registration id -> error from a cancel here
const cardWorking = new Set();

function registrationCardHtml(r) {
  const tCommit = registry()?.manifest?.params.tCommit ?? 600n;
  {
    const icon = needsDriving(r)
      ? '<span class="spinner small-spin"></span>'
      : r.stage === Stage.registered ? `<span class="kl-green">${SYMBOLS.seal}</span>` : `<span class="kl-orange">${SYMBOLS.alertCircle}</span>`;
    let stage = STAGE_TEXT[r.stage] || "";
    if (r.stage === Stage.waiting) {
      stage = r.commitDaa == null
        ? "Waiting for the commit to confirm..."
        : "The commit has to age for about a minute before the name can be registered. Keep KaPay open - it registers by itself, and picks up where it left off if you leave.";
    }
    let progress = "";
    const virtualDaa = runtimeActions()?.virtualDaa ?? hub.virtualDaa;
    if (r.stage === Stage.waiting && r.commitDaa != null && virtualDaa != null) {
      const target = Number(BigInt(tCommit) + 20n);
      const commitDaa = BigInt(r.commitDaa);
      const done = Number(virtualDaa > commitDaa ? virtualDaa - commitDaa : 0n);
      const left = Math.max(0, Math.floor((target - done) / Number(DAA_PER_SECOND)));
      progress = `<progress max="${target}" value="${Math.min(done, target)}"></progress><div class="muted tiny">About ${left} s to go</div>`;
    }
    const message = cardErrors.get(r.id) || (r.stage === Stage.failed ? r.lastError : null);
    // what the driver is doing or waiting on: a busy network, freeing an expired name (iOS b219bb0)
    const note = !message && needsDriving(r) && r.lastError ? r.lastError : null;
    const working = cardWorking.has(r.id);
    let buttons = "";
    if (r.stage === Stage.registered || r.stage === Stage.cancelled) {
      buttons = `<div class="kl-buttons">
        ${finishedTx(r) ? `<button class="km-prominent small-button" data-reg-view="${esc(r.id)}">View Transaction</button>` : ""}
        <button class="km-bordered small-button" data-reg-done="${esc(r.id)}">Done</button>
      </div>`;
    }
    else if (r.stage === Stage.taken) buttons = `<button class="km-bordered small-button danger-text" data-reg-cancel="${esc(r.id)}" ${working ? "disabled" : ""}>Cancel Commit</button>`;
    else if (r.stage === Stage.failed) {
      buttons = `<div class="kl-buttons">
        <button class="km-prominent small-button" data-reg-retry="${esc(r.id)}">Try Again</button>
        <button class="km-bordered small-button danger-text" data-reg-cancel="${esc(r.id)}" ${working ? "disabled" : ""}>Cancel Commit</button>
      </div>`;
    }
    return `
      <div class="km-card kl-reg">
        <div class="kl-reg-head"><span class="km-title">${esc(r.name)}.kachat</span>${icon}</div>
        <div class="muted small">${unitText(esc(stage))}</div>
        ${progress}
        ${message ? `<div class="error-text tiny">${esc(message)}</div>` : note ? `<div class="muted tiny">${esc(note)}</div>` : ""}
        ${buttons}
      </div>`;
  }
}

/** The finished registration (or cancelled commit) as the done sheet shows it, or null. */
function finishedTx(r) {
  if (r.stage === Stage.registered && r.registerTxId) {
    // say plainly what stays locked with the name (iOS b3b62f5): the registry's bond + deposit
    const p = params();
    const note = p ? `${amount(p.bond + p.gapValue)} is locked with this name. It comes back to you when you release it.` : null;
    return { txId: r.registerTxId, title: "Name registered", accepted: true, note };
  }
  if (r.stage === Stage.cancelled && r.cancelTxId) return { txId: r.cancelTxId, title: "Commit cancelled" };
  return null;
}

// The stage each registration was last seen in: the done sheet pops up the moment one lands.
const seenStages = new Map();
function notifyFinished(pending) {
  for (const r of pending) {
    const before = seenStages.get(r.id);
    seenStages.set(r.id, r.stage);
    if (before && before !== r.stage) {
      const done = finishedTx(r);
      if (done) showTxDone(done);
    }
  }
}

// A claim's progress as a half sheet (iOS b219bb0 KachatRegistrationProgressSheet +
// KachatRegistrationPresenter): it opens when a claim starts, and comes up once by itself when the
// wallet opens with a claim still in progress (actions.autoPresentedRegistration, set by resume()) -
// claiming needs the wallet open, the commit ages about a minute before the name registers. Closing
// it (Close, Escape, the backdrop) leaves the claim running: the .kachat screen's claims button
// lists every open claim (`claimsButtonHtml`, `openClaimsList`). It closes by itself once its
// registration is dismissed (Done) or its commit was cancelled. Claims can run side by side.

const progressSheet = { el: null, id: null };
const claimsList = { handle: null };
let watchedActions = null;
const KEEP_OPEN_NOTE = "Keep KaPay open: the name is registered about a minute after the hidden commit confirms. If you close it, it picks up where it left off next time.";

/** Follows this wallet's claims for as long as the wallet is open (popup.js starts it once
 *  connected, the hub when it opens): the progress sheet, the claims list, the claims button's
 *  count and the done sheet follow them. */
export async function watchRegistrations() {
  const rt = await runtime().catch(() => null);
  if (!rt || watchedActions === rt.actions) { renderRegistrationProgress(); return; }
  watchedActions = rt.actions;
  for (const r of rt.actions.pending) if (!seenStages.has(r.id)) seenStages.set(r.id, r.stage);
  rt.actions.subscribe(({ pending }) => {
    if (watchedActions !== rt.actions) return;
    notifyFinished(pending);
    renderRegistrationProgress();
    renderClaimsList();
    hub.changed();
  });
  renderRegistrationProgress();
}

function openRegistrations() { return runtimeActions()?.openRegistrations ?? (runtimeActions()?.pending ?? []).filter(isOpen); }

function closeProgress() {
  progressSheet.el?.remove();
  document.removeEventListener("keydown", onProgressKey);
  progressSheet.el = null;
  progressSheet.id = null;
}
function onProgressKey(event) {
  if (event.key === "Escape" && progressSheet.el) { closeProgress(); runtimeActions()?.clearAutoPresented?.(); }
}

/** Opens the progress sheet of claim `id` (one that just started, or the one the wallet brings up
 *  by itself), replacing another one's. */
export function openRegistrationProgress(id) {
  const r = openRegistrations().find((q) => q.id === id);
  if (!r) return;
  if (progressSheet.el && progressSheet.id !== id) closeProgress();
  if (!progressSheet.el) {
    const backdrop = document.createElement("div");
    // Not a .sheet-backdrop: the action sheets replace those, and this one stays up over them.
    backdrop.className = "kl-progress-backdrop";
    backdrop.innerHTML = `<div class="sheet kl-progress" role="dialog" aria-modal="true" aria-label="${esc(`Claiming ${r.name}.kachat`)}"></div>`;
    // closing it leaves the claim running (iOS b219bb0)
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop || event.target.closest("[data-progress-close]")) { closeProgress(); runtimeActions()?.clearAutoPresented?.(); }
    });
    document.addEventListener("keydown", onProgressKey);
    document.body.appendChild(backdrop);
    progressSheet.el = backdrop;
    progressSheet.id = id;
  }
  paintProgress(r);
}

/** Repaints the progress sheet and closes it once its claim is over; with none up, opens the one
 *  the wallet brings up by itself (once per launch). */
function renderRegistrationProgress() {
  if (progressSheet.el) {
    const r = openRegistrations().find((q) => q.id === progressSheet.id);
    if (!r || !progressSheet.el.isConnected) closeProgress();
    else paintProgress(r);
    return;
  }
  const actions = runtimeActions();
  const auto = actions?.autoPresentedRegistration;
  if (!auto) return;
  if (openRegistrations().some((q) => q.id === auto)) openRegistrationProgress(auto);
  else actions.clearAutoPresented?.();
}

function paintProgress(r) {
  const sheet = progressSheet.el.querySelector(".kl-progress");
  sheet.innerHTML = `
    <div class="sheet-grabber"></div>
    <div class="sheet-title center-text">${esc(`Claiming ${r.name}.kachat`)}</div>
    ${registrationCardHtml(r)}
    ${needsDriving(r) ? `<p class="muted tiny center-text">${esc(KEEP_OPEN_NOTE)}</p>` : ""}
    <button class="bar-text strong" data-progress-close>Close</button>`;
  bindRegistrationCards(sheet);
}

/** The .kachat screen's claims button (iOS b219bb0 KachatClaimsButton): the names being claimed
 *  right now (and finished ones not yet dismissed), with a count. Hidden when there are none. */
export function claimsButtonHtml() {
  const open = openRegistrations();
  if (!open.length) return "";
  return `<button class="icon plain accent kl-claims-button" id="claims" aria-label="Names being claimed" title="Names being claimed">${SYMBOLS.hourglass}<span class="kl-claims-count">${open.length}</span></button>`;
}

/** Every open claim with its progress: the list behind the claims button (iOS b219bb0
 *  KachatClaimsListSheet). It closes by itself once the last one is dismissed. */
export function openClaimsList() {
  if (claimsList.handle?.isOpen() || !openRegistrations().length) return;
  claimsList.handle = openPanel({ title: "Claiming", trailing: "Done", full: true, stack: true, body: '<div data-claims class="kl-claims"></div>' });
  renderClaimsList();
}

function renderClaimsList() {
  const handle = claimsList.handle;
  if (!handle?.isOpen()) return;
  const open = openRegistrations();
  if (!open.length) { handle.close(); claimsList.handle = null; return; }
  const host = handle.panel.querySelector("[data-claims]");
  host.innerHTML = `${open.map((r) => registrationCardHtml(r)).join("")}<p class="muted tiny center-text">${esc(KEEP_OPEN_NOTE)}</p>`;
  bindRegistrationCards(host);
}

function bindRegistrationCards(container) {
  const find = (id) => openRegistrations().find((r) => r.id === id) || hub.pending.find((r) => r.id === id);
  for (const b of container.querySelectorAll("[data-reg-view]")) b.onclick = () => { const r = find(b.dataset.regView); const done = r && finishedTx(r); if (done) showTxDone(done); };
  for (const b of container.querySelectorAll("[data-reg-done]")) b.onclick = async () => (await runtime()).actions.dismiss(b.dataset.regDone);
  for (const b of container.querySelectorAll("[data-reg-retry]")) b.onclick = async () => (await runtime()).actions.retry(b.dataset.regRetry);
  for (const b of container.querySelectorAll("[data-reg-cancel]")) {
    b.onclick = async () => {
      const id = b.dataset.regCancel;
      const ok = await confirmAlert({
        title: "Cancel the commit?",
        message: "The registration stops and the commit's 0.2 KAS comes back to you, less the network fee.",
        confirmLabel: "Cancel Commit", cancelLabel: "Keep",
      });
      if (!ok || !(await confirmPassword())) return;
      cardWorking.add(id);
      cardErrors.delete(id);
      renderRegistrationProgress();
      renderClaimsList();
      try { await (await runtime()).actions.cancel(find(id) || id); } catch (error) { cardErrors.set(id, errorText(error)); }
      cardWorking.delete(id);
      renderRegistrationProgress();
      renderClaimsList();
    };
  }
}

// --- Hub: pages (iOS KachatLiveMarketPage / AvailablePage / ActivityPage, 0765ce0 / eea52b2) -

/** A square tile for one name (iOS KachatNameTile, 27a4f39 / c488d1d): centered - the full name
 *  (it wraps and the tile grows, never truncated), ".kachat" under it, then the footer (the price
 *  asked, and any button). `nameHtml` is trusted markup. */
export function nameTileHtml(nameHtml, footerHtml = "") {
  return `
    <span class="kl-tile-name">${nameHtml}</span>
    <span class="kl-tile-suffix">.kachat</span>
    ${footerHtml ? `<span class="kl-tile-footer">${footerHtml}</span>` : ""}`;
}

/** Two tiles per row (iOS KachatNameGrid). */
export const nameGridHtml = (tilesHtml) => `<div class="kl-tile-grid">${tilesHtml}</div>`;

const loadErrorHtml = () => (hub.loadError ? `<p class="error-text small kl-pad">${esc(hub.loadError)}</p>` : "");

/** The selected tab's live page: Marketplace (names for sale), Available or Activity. Your own
 *  names and the offers you made live in Profile > Your Domains (iOS 0765ce0). */
export function livePageHtml(page) {
  if (page === "available") {
    // Names that expired and stayed unrenewed through grace - back on the market at the normal
    // price (iOS eea52b2). A tile opens the name; its Claim button keeps its own click and starts
    // the claim (the driver frees the old record and registers it in one go).
    return `
      ${sectionHeader("Available")}
      ${hub.lapsed.length
        ? nameGridHtml(hub.lapsed.map((n) => {
          const price = namePrice(n.name);
          return `
            <div class="km-card kl-tile kl-tile-split">
              <button class="kl-tile-open" data-name="${esc(n.name)}" aria-label="${esc(n.display)}"></button>
              ${nameTileHtml(esc(n.name), `
                ${price != null ? `<span class="kl-tile-price">${esc(amount(price))}</span>` : ""}
                <button class="km-prominent small-button kl-tile-button" data-claim-expired="${esc(n.name)}">Claim</button>`)}
            </div>`;
        }).join(""))
        : emptyCard(hub.loaded ? "No expired names right now." : null)}
      ${loadErrorHtml()}`;
  }
  if (page === "expired") {
    // Names that expired and are still in their grace period - only their owner can renew them -
    // soonest release first, each counting down to its release to Available, with its claim price.
    // When one reaches zero the hub reloads and it moves to Available (iOS cb3c27d).
    const grace = graceMs();
    return `
      ${sectionHeader("Expired")}
      ${hub.grace.length
        ? nameGridHtml(hub.grace.map((n) => {
          const releaseAt = n.expiresAt + grace;
          const price = namePrice(n.name);
          return `
            <button class="km-card kl-tile" data-name="${esc(n.name)}" aria-label="${esc(n.display)}">
              ${nameTileHtml(esc(n.name), `
                <span class="kl-tile-release"><span class="muted tiny">Released in</span>${countdownHtml(releaseAt, { reloadKey: `${n.name}:${releaseAt}` })}</span>
                ${price != null ? `<span class="muted tiny kl-tile-expiry">${esc(amount(price))}</span>` : ""}`)}
            </button>`;
        }).join(""))
        : emptyCard(hub.loaded ? "No names are in their grace period right now." : null)}
      ${loadErrorHtml()}`;
  }
  if (page === "activity") {
    return `
      ${sectionHeader("Recent activity", "Every claim, renewal, listing, sale, offer, transfer and reclaim across the registry.")}
      ${hub.activity.length
        ? `<div class="km-card km-list">${hub.activity.slice(0, 100).map((e) => eventRowHtml(e, true)).join("")}</div>`
        : emptyCard(hub.loaded ? "Nothing yet." : null)}
      ${loadErrorHtml()}`;
  }
  // For sale: the asking price and, under it, when the name expires - "Expires soon" when less
  // than expiresSoonMs is left, so a buyer sees what they get before opening it (iOS ad184c3).
  const p = params();
  const soonMs = p ? paramsExpiresSoonMs(p) : 30n * 86_400_000n;
  const now = BigInt(Date.now());
  return `
    ${sectionHeader("For sale")}
    ${hub.listings.length
      ? nameGridHtml(hub.listings.map((n) => `
          <button class="km-card kl-tile" data-name="${esc(n.name)}" aria-label="${esc(n.display)}">
            ${nameTileHtml(esc(n.name), `
              <span class="kl-tile-price">${esc(amount(n.price))}</span>
              <span class="muted tiny kl-tile-expiry">Expires ${esc(day(n.expiresAt))}</span>
              ${n.expiresAt - soonMs < now ? '<span class="kl-tile-soon">Expires soon</span>' : ""}`)}
          </button>`).join(""))
      : emptyCard(hub.loaded ? "No names are listed right now." : null)}
    ${loadErrorHtml()}`;
}

/** Claim on an expired name (an Available tile, or the name's own page): the claim sheet on the gap
 *  its reclaim reopens (registry.claimGap); the driver frees the old record first (iOS eea52b2). */
async function claimExpired(info) {
  let gap = null;
  try { gap = await registry().claimGap(info); } catch { gap = null; }
  if (gap) openClaimSheet({ name: info.name, gap });
  else toast("Couldn't find where to register this name. Try again in a moment.");
}

export function bindLivePage(container, nav) {
  for (const row of container.querySelectorAll("[data-name]")) {
    row.onclick = () => {
      const name = row.dataset.name;
      const info = [...hub.listings, ...hub.lapsed, ...hub.grace].find((n) => n.name === name);
      if (info) nav.openName(info);
    };
  }
  for (const b of container.querySelectorAll("[data-claim-expired]")) {
    b.onclick = (event) => {
      event.stopPropagation();
      const info = hub.lapsed.find((n) => n.name === b.dataset.claimExpired);
      if (info) claimExpired(info);
    };
  }
}

// --- Offers (iOS KachatOfferAction / KachatOfferRow) ---------------------------------------


/** An offer's state, shared by its tile and its sheet (iOS 7f50e84 KachatOfferState): the owner
 *  can accept it (not expired, not made to an earlier owner, and the name still active - an
 *  expired name would reach the buyer only to be claimed again; iOS 71128c4); an expired one goes
 *  back to its buyer on its own; one made to an earlier owner is declined and pulled back. */
function offerState(offer, { isBuyer, isOwner, declined = false, nameInfo = null }) {
  const actions = runtimeActions();
  const daa = hub.virtualDaa ?? actions?.virtualDaa;
  const refundable = daa != null && offer.refundable(daa);
  const returning = Boolean(actions?.returningOffers?.has(offer.id));
  const withdrawing = Boolean(actions?.withdrawingOffers?.has(offer.id));
  const nameActive = Boolean(nameInfo && statusOf(nameInfo) === Status.active);
  const acceptable = isOwner && !refundable && !declined && nameActive;
  let statusText = null;
  if (declined || withdrawing) statusText = isBuyer ? "Declined - the name changed hands, returning to you" : "Declined - made to an earlier owner";
  else if (refundable) statusText = returning || isOwner ? (isBuyer ? "Expired - returning to you" : "Expired - returning to the buyer") : "Expired - refundable now";
  return {
    offer, nameInfo, isBuyer, isOwner, acceptable, refundable, returning,
    canRefund: refundable && !returning,
    dim: refundable || declined || withdrawing,
    statusText,
    timeLeft: statusText ? null : offerTimeLeft(offer),
    buyerAddress: addressOf(offer.buyer),
  };
}

/** "2d 4h" until the offer becomes refundable (10 DAA per second), or null. */
function offerTimeLeft(offer) {
  const daa = hub.virtualDaa ?? runtimeActions()?.virtualDaa;
  if (daa == null || offer.refundable(daa)) return null;
  const seconds = Number(offer.refundAfter - daa) / Number(DAA_PER_SECOND);
  const m = Math.max(1, Math.round(seconds / 60));
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

// The offers on screen, by id: a tile opens its sheet with the state it was drawn with.
const offerTiles = new Map();

/** An offer as a square tile, two per row (iOS 7f50e84 KachatOfferTile): the amount, who made it
 *  or "Your offer", the name (in My Offers), and the time left or its expired / declined state. */
function offerTileHtml(offer, opts) {
  const st = offerState(offer, opts);
  offerTiles.set(offer.id, st);
  const who = st.isBuyer ? "Your offer" : (st.buyerAddress ? shortAddress(st.buyerAddress) : "");
  return `
    <button class="km-card kl-tile kl-offer-tile ${st.dim ? "kl-dim" : ""}" data-offer-tile="${esc(offer.id)}">
      <span class="accent">${SYMBOLS.hand}</span>
      <span class="kl-tile-price">${esc(amount(offer.amount))}</span>
      <span class="muted tiny ellipsis kl-offer-who">${esc(who)}</span>
      ${opts.showName && offer.name ? `<span class="tiny strong ellipsis">${esc(offer.name)}.kachat</span>` : ""}
      ${st.statusText ? `<span class="tiny kl-orange">${esc(st.statusText)}</span>` : st.timeLeft ? `<span class="muted tiny">Expires in ${esc(st.timeLeft)}</span>` : ""}
    </button>`;
}

const offerGridHtml = (offers, optsFor) => nameGridHtml(offers.map((o) => offerTileHtml(o, optsFor(o))).join(""));

/** A tap on a tile opens its sheet. */
function bindOfferRows(container) {
  for (const tile of container.querySelectorAll("[data-offer-tile]")) {
    tile.onclick = () => { const st = offerTiles.get(tile.dataset.offerTile); if (st) openOfferDetail(st); };
  }
}

/** The offer as a half sheet (iOS 7f50e84 KachatOfferDetailSheet): the amount, who made it (tap to
 *  copy), the time left, and what this wallet can do - Accept / Decline for the name's owner,
 *  Withdraw (and Refund once expired) for the buyer, Refund for anyone once expired. */
function openOfferDetail(st) {
  const { offer } = st;
  const name = offer.name || st.nameInfo?.name || null;
  const rows = [];
  if (st.acceptable) {
    rows.push({ label: "Accept", subtitle: "The name goes to the buyer and the offer comes to you.", icon: SYMBOLS.seal, onClick: () => openOfferAction("accept", offer, st.nameInfo) });
    rows.push({ label: "Decline", subtitle: "Sends the offer back to the buyer.", icon: SYMBOLS.release, danger: true, onClick: () => openOfferAction("decline", offer) });
  } else if (st.isBuyer) {
    rows.push({ label: "Withdraw", subtitle: "Takes the offer back.", icon: SYMBOLS.release, onClick: () => openOfferAction("withdraw", offer) });
    if (st.canRefund) rows.push({ label: "Refund", subtitle: "Returns the offer to you now that it passed its refund time.", icon: SYMBOLS.renew, onClick: () => openOfferAction("refund", offer) });
  } else if (st.canRefund) {
    rows.push({ label: "Refund", subtitle: "Sends the expired offer back to its buyer.", icon: SYMBOLS.renew, onClick: () => openOfferAction("refund", offer) });
  }
  const note = rows.length ? "" : st.isOwner ? "This offer can't be accepted any more." : "Only the name's owner can accept or decline this offer.";
  const from = st.isBuyer
    ? '<span class="strong">You</span>'
    : st.buyerAddress ? `<button class="kl-owner-copy" data-copy-buyer title="Copies the address"><span class="mono tiny">${esc(shortAddress(st.buyerAddress))}</span><span data-copy-icon>${ICONS.copy}</span></button>` : "";
  const sheet = showSheet({
    title: "Offer",
    cancelSubtitle: "Close",
    headerHtml: `
      <div class="kl-offer-head">
        <span class="accent">${SYMBOLS.hand}</span>
        <div class="kl-offer-amount">${esc(amount(offer.amount))}</div>
        ${name ? `<div class="muted small">${esc(name)}.kachat</div>` : ""}
      </div>
      <div class="kl-offer-facts">
        <div class="form-row between"><span>From</span>${from}</div>
        ${st.timeLeft ? `<div class="form-row between"><span>Expires in</span><span class="muted">${esc(st.timeLeft)}</span></div>` : ""}
        ${st.statusText ? `<div class="form-row tiny kl-orange">${esc(st.statusText)}</div>` : ""}
      </div>
      ${note ? `<p class="muted small center-text">${esc(note)}</p>` : ""}`,
    rows,
  });
  const copy = document.querySelector(".sheet [data-copy-buyer]");
  if (copy) {
    copy.onclick = async (event) => {
      event.stopPropagation();
      try { await navigator.clipboard.writeText(st.buyerAddress); } catch { return; }
      const icon = copy.querySelector("[data-copy-icon]");
      if (icon) icon.innerHTML = ICONS.checkmark || "✓";
    };
  }
  return sheet;
}

function openOfferAction(kind, offer, name = null) {
  const offerRow = { title: "Offer", value: amount(offer.amount) };
  if (kind === "withdraw") {
    return openTxSheet({ title: "Withdraw Offer", doneTitle: "Offer withdrawn", rows: [offerRow], operation: () => Operation.withdraw(offer) });
  }
  if (kind === "refund") {
    return openTxSheet({ title: "Refund Offer", doneTitle: "Offer refunded", rows: [offerRow], operation: () => Operation.refund(offer) });
  }
  if (kind === "decline") {
    const buyerAddress = addressOf(offer.buyer);
    return openTxSheet({
      title: "Decline Offer", doneTitle: "Offer declined",
      footer: "The offer goes back to the buyer. Its network fee comes out of the offer, so declining costs you nothing.",
      rows: [offerRow, { title: "Buyer", value: buyerAddress ? shortAddress(buyerAddress) : "" }],
      operation: () => Operation.decline(offer),
    });
  }
  const buyer = addressOf(offer.buyer);
  return openTxSheet({
    title: "Accept Offer", doneTitle: "Offer accepted",
    warning: "The name goes to the buyer and the offer's amount comes to you, in one transaction. This can't be undone.",
    rows: [{ title: "Name", value: name.display }, offerRow, { title: "Buyer", value: buyer ? shortAddress(buyer) : "" }],
    operation: () => Operation.accept(offer, name),
  });
}

// --- The steps' screen (KaPay 05db583) -------------------------------------------------------
//
// A name transaction is the Send Kaspa flow's steps (send-steps.js), and like Send Kaspa they take
// the whole popup: the screen it started from is set aside as it is - its nodes, its scroll, its
// dataset - and put back on Cancel or Done, so a name, the market or Your Domains come back where
// they were. Screens repaint only while they are on screen (their `here()`), so nothing draws
// over the steps meanwhile; once back, the screen catches up (`restoreHooks`, hub.changed()).

/** Every step screen's name starts with this (not "kachat-": those screens have a fixed height). */
const FLOW_SCREEN = "names-tx";
/** Run once a screen is back from the steps: a name detail reloads what changed meanwhile. */
const restoreHooks = new Set();

/** Sets the popup's screen aside; the function returned puts it back - only while the steps still
 *  hold the popup (anything drawn over them meanwhile, the lock screen, stays). */
function takeOverScreen() {
  const nodes = [...app.childNodes];
  const dataset = { ...app.dataset };
  const scrolls = [app, ...app.querySelectorAll("*")].filter((el) => el.scrollTop > 0).map((el) => [el, el.scrollTop]);
  let restored = false;
  return () => {
    if (restored) return false;
    if (!String(app.dataset.screen || "").startsWith(FLOW_SCREEN)) return false;
    restored = true;
    // the render hooks see the screen come back (the dock follows it)
    render("", dataset.screen || "");
    app.replaceChildren(...nodes);
    for (const key of Object.keys(app.dataset)) if (!(key in dataset)) delete app.dataset[key];
    Object.assign(app.dataset, dataset);
    for (const [el, top] of scrolls) el.scrollTop = top;
    for (const hook of [...restoreHooks]) { try { hook(); } catch { /* a screen catches up on its own */ } }
    hub.changed();
    return true;
  };
}

/** The words the swipe-up screen uses for any other name transaction (iOS SwipeUpLabels.transaction):
 *  `done` is its finished title. */
function transactionSwipeLabels(done) {
  return {
    release: "Release to Confirm", working: "Sending", workingDetail: "Broadcasting to the Kaspa BlockDAG...",
    done, recipientWord: "for", failedFallback: "The transaction didn't go out.",
  };
}

/** What the swipe-up screen shows under the transaction (iOS KachatTxStageSteps): where it is -
 *  sent, in a block, shown in KaPay - and, when the network didn't take it, what to do. */
function txStageStepsHtml(stage) {
  const inBlock = stage === TxStage.accepted || stage === TxStage.shown;
  return `
    <div class="kl-receipt-steps">
      ${txStepHtml("Sent to the network", { done: true })}
      ${txStepHtml("In a block", { done: inBlock, active: !inBlock && stage !== TxStage.dropped })}
      ${txStepHtml("Updated in KaPay", { done: stage === TxStage.shown, active: stage === TxStage.accepted })}
    </div>
    ${stage === TxStage.dropped ? `<p class="muted small center-text kl-stage-text">${esc(txStageText(stage))}</p>` : ""}`;
}

/** A busy network (iOS KachatBusyNetworkNotice): Normal may wait. */
const busyNoticeHtml = () => `
  <div class="kl-busy-notice" role="status">
    <span class="kl-orange">${SYMBOLS.warning}</span>
    <span class="kl-busy-copy"><strong>The network is busy</strong><span class="muted tiny">At Normal this may wait a while. Fast or Priority pays a little more to get into a block sooner.</span></span>
  </div>`;

/** A review line whose value is plain text; a long one (an address) wraps anywhere. */
const textRow = (title, value, bold = false) =>
  reviewRowHtml(title, `<span class="kl-review-text ${bold ? "strong" : ""} ${String(value).length > 24 ? "kl-long" : ""}">${esc(value)}</span>`);

// --- The transaction sheet (iOS KachatTxSheet) ---------------------------------------------

/** What the transaction does to the wallet: its outputs to the wallet minus its inputs from it. */
function balanceChange(plan, me) {
  const mine = p2pkScript(me);
  const received = plan.unsignedTx.outputs.filter((o) => bytesEqual(o.script, mine)).reduce((a, o) => a + o.value, 0n);
  const spent = plan.entries.filter((e) => bytesEqual(e.script, mine)).reduce((a, e) => a + e.amount, 0n);
  return received - spent;
}

// A short value stays on one line; a long one (an address) wraps anywhere.
const labeledRow = (title, value, bold = false) =>
  `<div class="form-row between"><span class="${bold ? "strong" : ""}">${esc(title)}</span><span class="kl-value ${String(value).length > 24 ? "kl-long" : ""} ${bold ? "strong" : ""}">${esc(value)}</span></div>`;

/** When the wallet's KAS is in more small coins than a name transaction can take, the swipe first
 *  sends a self-send combining them (the engine's `combinesCoins`): said on the review, as on iOS
 *  and Desktop (EXT-022). */
function combineNoteHtml(text = "Your KAS is in many small coins. When you swipe, KaPay first combines them into one (a separate transaction with its own small fee), then sends this.") {
  return `<div class="kl-busy-notice kl-combine-note" role="note">
    <span class="accent">${SYMBOLS.arrows}</span>
    <span class="kl-busy-copy"><span class="muted tiny">${esc(text)}</span></span>
  </div>`;
}

/**
 * Every action's sheet, in the Send Kaspa flow's steps (iOS KachatTxSheet, KaPay 05db583): an entry
 * step when the action takes one (`entry`: an offer's amount or a price on the keypad, a new owner
 * on the recipient card, Renew's "How long?"), then the review - what it does (a card), the network
 * fee with Normal / Fast / Priority or Edit for a fee of your own (the fee editor; a notice when the
 * network is busy, which then starts it on Fast unless you chose), the balance after, the warning of
 * a destructive action in red - and swipe up to confirm: the swipe is the confirmation (iOS
 * e67074c), then the password, then the transaction, sent at the fee shown (built against live
 * UTXOs, nothing sent before) and followed into a block on the swipe-up's own screen, or Failed
 * with Try Again.
 *   title: a string, or a function (Extend's title follows its years)
 *   rows: [{ title, value }] or a function returning them (recomputed with the inputs)
 *   operation(): the Operation for the current inputs, or null
 *   entry: { question, html(), className, canContinue(), bind(step, { changed, next }) } - a step
 *          of its own before the review; `changed()` rebuilds the plan, `next()` goes on
 *   inputsHtml() / bindInputs(body, changed): inputs on the review itself (Extend's years)
 *   swipeUp: { bar, labels, recipient, showsAmount = true }; none: "Swipe up to Confirm"
 */
function openTxSheet({
  title, doneTitle = "Transaction sent", warning = null, footer = null, rows = [], operation, entry = null,
  inputsHtml = "", bindInputs = null, swipeUp = null, onDone = () => {}, onFinished = null,
}) {
  const state = {
    plan: null, planError: null, building: false, sending: false, txId: null, sendError: null, token: 0, balance: null,
    // the swipe first combines many small coins (EXT-022)
    combinesCoins: false,
    // the fee rate the plan was built at: the send uses exactly this (iOS 7e2b6cd, IOS-061)
    planFeerate: null,
    // the fee: a speed, or a typed total (sompi, the fee editor's); `touched` once you chose - a
    // busy network no longer moves it for you
    fee: { tier: FeeTier.normal, custom: null, touched: false },
    busy: false,
    /** a spending address paying (an owner action on its name): its balance */
    payerBalance: null,
  };
  const swipe = swipeUp
    ? { showsAmount: true, ...swipeUp, labels: swipeUp.labels || transactionSwipeLabels(doneTitle) }
    : { bar: "Swipe up to Confirm", labels: transactionSwipeLabels(doneTitle), recipient: null, showsAmount: false };
  const restore = takeOverScreen();
  let closed = false;
  let unsubscribe = null;
  let handle = null; // the step on screen: { el, step?, swipe? }
  const titleNow = () => (typeof title === "function" ? title() : title);
  const rowsNow = () => (typeof rows === "function" ? rows() : rows);
  const footerNow = () => (typeof footer === "function" ? footer() : footer);
  const inputsNow = () => (typeof inputsHtml === "function" ? inputsHtml() : inputsHtml);
  const feeChoice = () => (state.fee.custom != null ? FeeChoice.customTotal(state.fee.custom) : FeeChoice.tier(state.fee.tier));
  const here = () => Boolean(!closed && handle?.el?.isConnected);

  /** Who pays: a spending address holding the name (or the marketplace's), else the chatting address. */
  const payerNow = () => {
    let payer = null;
    try { const op = operation(); payer = op ? runtimeActions()?.payerFor(op) : null; } catch { payer = null; }
    const key = payer?.kind === "spending" ? KachatNamesRegistry.keyOf(payer.address) : null;
    return key ? { ...payer, key } : null;
  };
  /** What leaves the wallet: everything the transaction spends from the paying address less what
   *  comes back to it. */
  const spentSompi = () => {
    if (!state.plan) return null;
    const key = payerNow()?.key ?? myKey;
    if (!key) return null;
    const change = balanceChange(state.plan, key);
    return change < 0n ? -change : 0n;
  };

  const reviewHtml = () => {
    const p = state.plan;
    const list = rowsNow().map((r) => textRow(r.title, r.value));
    if (p && p.priceFee > 0n) list.push(textRow("Price (to miners)", amount(p.priceFee)));
    const foot = state.planError ? `<p class="error-text small kl-review-note">${esc(state.planError)}</p>`
      : footerNow() ? `<p class="muted small kl-review-note">${esc(footerNow())}</p>` : "";
    // paid by a spending address (an owner action on its name, iOS eb9b027): which one, and its
    // balance after; else the chatting address's balance after (iOS 8ecc38c)
    const payer = payerNow();
    let pills = "";
    if (p && payer) {
      const change = balanceChange(p, payer.key);
      pills = `<div class="sk-pills"><span class="sk-pill">${esc(`From: ${payer.label || `Address #${payer.index}`}`)}</span><span class="sk-pill">${esc(balancePill(change, state.payerBalance))}</span></div>`;
    } else if (p && myKey) {
      pills = `<div class="sk-pills"><span class="sk-pill">${esc(balancePill(balanceChange(p, myKey), state.balance))}</span></div>`;
    }
    const inputs = entry ? "" : inputsNow();
    return `
      ${list.length ? reviewCardHtml(list) : ""}
      ${inputs ? `<div class="kl-review-inputs">${inputs}</div>` : ""}
      ${state.busy && !state.txId ? busyNoticeHtml() : ""}
      ${feeControlsHtml({
        tier: state.fee.tier, custom: state.fee.custom != null, estimating: state.building,
        feeText: p ? amount(p.networkFee) : null, showsCoinControl: false, editPill: true,
      })}
      ${pills}
      ${warning ? `<div class="kl-warning-card" role="note">${SYMBOLS.warning}<span>${esc(warning)}</span></div>` : ""}
      ${foot}
      ${state.combinesCoins && p && !state.txId ? combineNoteHtml() : ""}
      ${state.sendError ? `<p class="error-text small kl-review-note">${esc(state.sendError)}</p>` : ""}`;
  };

  // What the paying address holds once this is sent; its change alone while that can't be read.
  const balancePill = (change, balance) => (balance != null
    ? `Balance after: ${amount(balance + change > 0n ? balance + change : 0n)}`
    : `Balance change: ${signed(change)}`);

  const canSwipe = () => Boolean(state.plan) && !state.building && !state.txId && !state.sending;

  /** Redraws what changed on the step showing (a plan, a fee, a balance arriving). */
  const paint = () => {
    if (!here()) return;
    if (handle.step) { handle.step.refresh(); return; }
    if (!handle.swipe) return;
    handle.swipe.setBody(reviewHtml());
    bindReview();
    handle.swipe.setEnabled(canSwipe());
    const heading = handle.el.closest(".sk-swipe-host")?.querySelector(".ss-title");
    if (heading) heading.textContent = titleNow();
  };

  /** A speed replaces a typed fee. */
  const chooseTier = (tier) => {
    if (state.sending || state.txId || !Object.values(FeeTier).includes(tier)) return;
    state.fee = { tier, custom: null, touched: true };
    rebuild();
  };

  /** Rebuilds the plan for the operation and the fee now, 300 ms after the last change. */
  const rebuild = () => {
    const token = ++state.token;
    state.plan = null;
    state.planFeerate = null;
    state.planError = null;
    state.combinesCoins = false;
    let op = null;
    try { op = operation(); } catch (error) { state.planError = errorText(error); }
    state.building = Boolean(op);
    paint();
    if (!op) return;
    const fee = feeChoice();
    // a spending address paying: its balance, for the pill
    const payer = payerNow();
    if (payer && state.payerBalance == null) addressBalanceSompi(payer.address).then((b) => { state.payerBalance = b; paint(); });
    setTimeout(async () => {
      if (token !== state.token || closed) return;
      try {
        await prepareSigner(op);
        // built at the fee shown, as it will be sent (iOS e426432)
        const built = await (await runtime()).actions.planWithRate(op, { fee });
        if (token !== state.token) return;
        state.plan = built.plan;
        state.planFeerate = built.feerate;
        state.combinesCoins = Boolean(built.combinesCoins);
      } catch (error) {
        if (token !== state.token) return;
        state.planError = errorText(error);
      }
      state.building = false;
      paint();
    }, 300);
  };

  const exit = () => {
    if (closed) return;
    closed = true;
    try { unsubscribe?.(); } catch { /* gone */ }
    restore();
  };

  // --- the steps ---------------------------------------------------------------------------
  const flow = createStepFlow(["entry", "review", "fee"], (id, direction) => {
    if (closed) return;
    handle = null;
    if (id === "entry") drawEntry(direction);
    else if (id === "review") drawReview(direction);
    else if (id === "fee") drawFee(direction);
  });

  const drawEntry = (direction) => {
    const step = showStep({
      screen: `${FLOW_SCREEN}-entry`,
      title: titleNow(),
      question: entry.question,
      bodyHtml: entry.html(),
      className: `kl-entry-step ${entry.className || ""}`,
      onCancel: exit,
      continueTitle: "Review",
      canContinue: () => Boolean(entry.canContinue?.() ?? true),
      onContinue: () => flow.go("review"),
      direction,
    });
    handle = { el: step.el, step };
    entry.bind?.(step, { changed: rebuild, next: () => { if (entry.canContinue?.() ?? true) flow.go("review"); } });
  };

  const drawReview = (direction) => {
    const screen = showSwipeUp({
      screen: FLOW_SCREEN,
      title: titleNow(),
      onBack: entry ? () => flow.go("entry") : null,
      onCancel: exit,
      barTitle: swipe.bar,
      labels: swipe.labels,
      bodyHtml: reviewHtml(),
      enabled: canSwipe(),
      direction,
      getPreview: () => ({ amountSompi: swipe.showsAmount ? spentSompi() : null, recipient: swipe.recipient ?? null }),
      getFailureMessage: () => state.sendError,
      onAction: () => { confirm(); },
      onDone: () => {
        const id = state.txId;
        exit();
        try { onFinished?.(id); } catch { /* optional */ }
      },
    });
    handle = { el: screen.body, swipe: screen };
    bindReview();
  };

  const bindReview = () => {
    const body = handle?.el;
    if (!body) return;
    for (const b of body.querySelectorAll("[data-tier]")) b.onclick = () => chooseTier(b.dataset.tier);
    const edit = body.querySelector("#fee-edit");
    // the fee's Edit (iOS openFeeEditor): the plan's fee on the keypad
    if (edit) edit.onclick = () => { if (state.plan && !state.sending && !state.txId) flow.go("fee"); };
    if (!entry) bindInputs?.(body, rebuild);
  };

  const drawFee = (direction) => {
    const step = showFeeEditor({
      screen: `${FLOW_SCREEN}-fee`,
      feeSompi: state.plan?.networkFee ?? null,
      direction,
      onCancel: () => flow.go("review"),
      onConfirm: (sompi) => {
        if (!state.sending && !state.txId) {
          state.fee = { tier: state.fee.tier, custom: sompi, touched: true };
          rebuild();
        }
        flow.go("review");
      },
    });
    handle = { el: step.el, step };
  };

  // --- sending -------------------------------------------------------------------------------
  async function confirm() {
    const screen = handle?.swipe;
    if (!screen) return;
    // The swipe-up screen is already sending: busy at once, through the password (iOS authorize).
    // The swipe is the confirmation: no second prompt, even for the destructive ones - their
    // warning is the red card (iOS e67074c).
    state.sendError = null;
    screen.setBusy(true);
    if (!state.plan || state.building || state.sending || state.txId) {
      state.sendError = "Still working out the cost. Try again in a moment.";
      screen.setBusy(false);
      return;
    }
    const plan = state.plan;
    // the password turned down: nothing was sent, the review comes back as it was
    if (!(await confirmPassword())) { if (!closed) screen.returnToForm(); return; }
    if (closed) return;
    let op = null;
    try { op = operation(); } catch { op = null; }
    if (!op || state.plan !== plan) {
      state.sendError = "The cost changed. Check it and swipe again.";
      screen.setBusy(false);
      paint();
      return;
    }
    const fee = feeChoice();
    state.sending = true;
    paint();
    try {
      await prepareSigner(op);
      // never pays more than the price shown (iOS 4f5d95e), at the fee shown (iOS e426432)
      const maxPrice = typeof plan.priceFee === "bigint" ? plan.priceFee : null;
      // ...at exactly the rate it was built at, never a bigger network fee (iOS 7e2b6cd, IOS-061)
      const maxNetworkFee = typeof plan.networkFee === "bigint" ? plan.networkFee : null;
      const actions = (await runtime()).actions;
      const id = await actions.perform(op, { maxPrice, fee, exactFeerate: state.planFeerate ?? null, maxNetworkFee });
      state.txId = id;
      state.sending = false;
      try { onDone(id); } catch { /* the screen still shows it */ }
      // The swipe-up screen shows the transaction and its progress until Done (iOS 5bab351).
      const sent = { txid: id, amountSompi: swipe.showsAmount ? spentSompi() : null, recipient: swipe.recipient ?? null, explorerUrl: wallet.explorerTxUrl(id) };
      const stage = () => actions.txStage?.(id) ?? TxStage.sent;
      let last = stage();
      screen.setSent(sent, txStageStepsHtml(last));
      screen.setBusy(false);
      unsubscribe = actions.subscribe?.(() => {
        const st = stage();
        if (st !== last && !closed) { last = st; screen.setSent(sent, txStageStepsHtml(st)); }
      }) ?? null;
      if (actions.txStage?.(id) == null) { try { actions.follow?.(id, null); } catch { /* shows as sent */ } }
      paint();
      return;
    } catch (error) {
      state.sendError = errorText(error);
      state.sending = false;
      // the price or the fee moved: the plan is built again, so Try Again shows the new cost to
      // confirm (iOS priceChanged / feeChanged)
      if (error?.code === "priceChanged" || error?.code === "feeChanged") {
        const shown = state.sendError;
        rebuild();
        state.sendError = shown;
      }
    }
    screen.setBusy(false);
    paint();
  }

  flow.go(entry ? "entry" : "review");
  rebuild();
  chattingBalance().then((balance) => { state.balance = balance; paint(); });
  // A busy network starts on Fast unless you already chose (iOS e426432).
  runtime().then((rt) => rt.actions.refreshFeeEstimate?.()).then((estimate) => {
    if (closed || state.txId) return;
    state.busy = Boolean(estimate?.isBusy);
    if (state.busy && !state.fee.touched && state.fee.custom == null && state.fee.tier === FeeTier.normal) {
      state.fee.tier = FeeTier.fast;
      rebuild();
    } else {
      paint();
    }
  }).catch(() => { /* the fee card still prices Normal */ });
}

/** The chatting address's balance (sompi), read from a node; null when it can't be read. */
async function chattingBalance() {
  try {
    const rt = await kachatProfiles();
    const utxos = await rt.engine.getUtxosWithCovenants([rt.actions.myAddress]);
    return utxos.reduce((sum, u) => sum + u.amount, 0n);
  } catch {
    return null;
  }
}

/** A segmented control (iOS .pickerStyle(.segmented)). */
const segmented = (name, options, selected) => `
  <div class="segmented wide" role="radiogroup" data-seg="${name}">
    ${options.map(([value, label]) => `<button type="button" role="radio" data-value="${esc(String(value))}" aria-checked="${String(value) === String(selected)}">${esc(label)}</button>`).join("")}
  </div>`;

function bindSegmented(panel, name, onPick) {
  const group = panel.querySelector(`[data-seg="${name}"]`);
  if (!group) return;
  for (const b of group.querySelectorAll("[data-value]")) {
    b.onclick = () => {
      for (const other of group.querySelectorAll("[data-value]")) other.setAttribute("aria-checked", String(other === b));
      onPick(b.dataset.value);
    };
  }
}

/** "1 year" / "2 years", or on a short clock (testnet) "10 min" / "20 min". */
const yearsText = (y) => periods(y);
const maxYears = () => Number(registry()?.manifest?.params.maxYears ?? 2n);

/** An entry step's amount on the keypad (iOS KaspaKeypadAmountEntry, no Max, KAS only): the big
 *  number, a footnote under it ("Listed at 10 KAS"), the keys. */
const keypadEntryOptions = (typed, footnote = "") => ({ typed, unit: KAS_UNIT, canSwitch: false, showsMax: false, footnote });

/** Wires an entry step's keypad: `get()` / `set(text)` hold the typed amount; `onChange()` after a
 *  key that changed it. */
function bindKeypadEntry(step, { get, set, footnote = "", onChange }) {
  bindKeypad(step.body, (key) => {
    const current = get();
    const next = applyKeypadKey(key, current, 8);
    if (next === current) return false;
    set(next);
    paintKeypadAmountEntry(step.body, keypadEntryOptions(next, footnote));
    onChange?.();
    step.refresh();
    return true;
  });
}

// --- Claim (iOS KachatClaimSheet) ----------------------------------------------------------

/**
 * Claiming a name (iOS KachatClaimSheet, KaPay 05db583 / 5bab351), like a send: "For how long?" - a
 * button per length with its price, a tap goes on - then a costs-only review (the price, the bond
 * and the deposit, the commit, the fees, the total) with the fee and swipe up to claim: the BlockDAG
 * while the commit goes out, then Claim Started with the registration's own progress, or Failed with
 * Try Again. Closing it leaves the claim running (the claims button lists it).
 *
 * The fee is a speed only: iOS also takes a typed fee there, as a rate both transactions pay
 * (customFeerate), which the shared engine's quote and startRegistration don't take - so the review
 * has no Edit, as on KaChat-Desktop.
 */
function openClaimSheet(target) {
  // the fee speed of both the commit now and the registration later (iOS e426432); `touched` once
  // you chose - a busy network then no longer moves it to Fast
  // notOpen: registry v5 before its migration deadline - why claiming waits, and until when (iOS dd836cb)
  const state = {
    years: 1n, quote: null, quoteError: null, notOpen: null, starting: false, startError: null, token: 0,
    feeTier: FeeTier.normal, quoteTier: null, feeTouched: false, busy: false, progressId: null,
  };
  const count = Math.max(1, maxYears());
  const restore = takeOverScreen();
  let closed = false;
  let unsubscribe = null;
  let handle = null; // { el, swipe? }
  const here = () => Boolean(!closed && handle?.el?.isConnected);

  /** What registering for `y` periods costs (the first period at the registration price, any
   *  further one at the renewal price), from the manifest. */
  const priceFor = (y) => {
    const p = params();
    if (!p) return null;
    try { return paramsRegisterCost(p, new TextEncoder().encode(target.name).length, BigInt(y)); } catch { return null; }
  };

  const reviewHtml = () => {
    const q = state.quote;
    const rows = [textRow("Name", `${target.name}.kachat`), textRow("Length", yearsText(state.years))];
    let cost;
    if (q) {
      cost = reviewCardHtml([
        textRow("Price (to miners)", amount(q.price)),
        textRow("Bond (returned on release)", amount(q.bond)),
        textRow("Registry deposit (returned on release)", amount(q.gapDeposit)),
        textRow("Commit (returned at registration)", amount(q.commit)),
        textRow("Network fees", amount(q.networkFee)),
        textRow("Total", amount(q.total), true),
      ]);
    } else if (state.quoteError) {
      cost = `<div class="sk-card"><span class="error-text small">${esc(state.quoteError)}</span></div>`;
    } else {
      cost = reviewCardHtml([reviewRowHtml("Total", state.notOpen ? '<span class="muted">-</span>' : '<span class="spinner small-spin"></span>')]);
    }
    const feeText = q && state.quoteTier === state.feeTier ? esc(amount(q.networkFee))
      : state.quoteError || state.notOpen ? '<span class="muted">—</span>' : '<span class="spinner small-spin"></span>';
    return `
      ${state.notOpen ? `
        <div class="sk-card">
          <div class="kl-notopen-row"><span class="kl-orange">${SYMBOLS.clock}</span><span class="small">${esc(state.notOpen)}</span></div>
          <div class="muted tiny">Every name from the old registry comes over with the same owner and expiry first.</div>
        </div>` : ""}
      ${reviewCardHtml(rows)}
      ${cost}
      ${q ? `<div class="kl-locked-note accent">${SYMBOLS.lock}<span class="small">${esc(`${amount(q.bond + q.gapDeposit)} stays locked with your name while you hold it (bond + registry deposit). You get it back when you release the name.`)}</span></div>` : ""}
      ${state.busy ? busyNoticeHtml() : ""}
      <div class="sk-card">
        <div class="sk-fee-row"><span>Network Fee</span><span class="sk-fee-value">${feeText}</span></div>
        <div class="segmented wide" role="radiogroup" aria-label="Fee">
          ${FEE_TIERS.map((t) => `<button type="button" role="radio" data-tier="${t.id}" aria-checked="${state.feeTier === t.id}">${t.label}</button>`).join("")}
        </div>
        <div class="muted tiny">Claiming sends two transactions: the commit now, the registration about a minute later. Both pay this fee rate.</div>
      </div>
      ${q ? `<div class="sk-pills"><span class="sk-pill">Available: ${esc(amount(q.spendable))}</span></div>` : ""}
      ${q?.combinesCoins && q.affordable ? combineNoteHtml("Your KAS is in many small coins. KaPay combines them into one before registering, for a tiny extra network fee.") : ""}
      ${q && !q.affordable ? `<p class="error-text small kl-review-note">${esc("Not enough KAS on your chatting address for this name.")}</p>` : ""}
      ${state.startError ? `<p class="error-text small kl-review-note">${esc(state.startError)}</p>` : ""}`;
  };

  const canSwipe = () => Boolean(state.quote?.affordable) && state.quoteTier === state.feeTier && !state.starting && !state.progressId;

  const paint = () => {
    if (!here() || !handle.swipe) return;
    handle.swipe.setBody(reviewHtml());
    for (const b of handle.el.querySelectorAll("[data-tier]")) {
      b.onclick = () => {
        if (state.starting || state.progressId) return;
        state.feeTouched = true;
        if (b.dataset.tier !== state.feeTier) { state.feeTier = b.dataset.tier; requote(); }
      };
    }
    handle.swipe.setEnabled(canSwipe());
  };

  const requote = async () => {
    const token = ++state.token;
    state.quote = null;
    state.quoteError = null;
    state.notOpen = null;
    state.quoteTier = null;
    const tier = state.feeTier;
    const years = state.years;
    paint();
    try {
      const q = await (await runtime()).actions.quote({ name: target.name, years, gap: target.gap, feeTier: tier });
      if (token === state.token) { state.quote = q; state.quoteTier = tier; }
    } catch (error) {
      if (token === state.token) {
        // the migration deadline: a notice, not an error (notPublicYet gone with the countdown, iOS 48d194d)
        if (error?.code === "registrationNotOpen") state.notOpen = errorText(error);
        else state.quoteError = errorText(error);
      }
    }
    if (token === state.token) paint();
  };

  const exit = () => {
    if (closed) return;
    closed = true;
    try { unsubscribe?.(); } catch { /* gone */ }
    restore();
  };

  /** Under Claim Started (iOS KachatClaimOutcome): the registration's own card, and why KaPay should
   *  stay open until the name registers. */
  const showOutcome = () => {
    if (!here() || !state.progressId) return;
    const r = (runtimeActions()?.pending ?? []).find((x) => x.id === state.progressId);
    handle.swipe.setSucceeded(r ? `
      <div class="kl-claim-outcome">
        ${registrationCardHtml(r)}
        ${needsDriving(r) ? `<p class="muted tiny center-text">${esc(KEEP_OPEN_NOTE)}</p>` : ""}
      </div>` : "");
    // the card's View, Done, Try Again and Cancel Commit
    const outcome = handle.el.closest(".sk-swipe-host")?.querySelector(".sk-swipe-outcome");
    if (outcome) bindRegistrationCards(outcome);
  };

  async function start() {
    const screen = handle?.swipe;
    if (!screen) return;
    // The swipe let go: busy at once (its screen is already sending), then the password, then the
    // commit (iOS 5bab351 authorizeAndStart).
    state.starting = true;
    state.startError = null;
    screen.setBusy(true);
    const fail = (message) => {
      state.startError = message;
      state.starting = false;
      screen.setBusy(false);
      paint();
    };
    const priceChanged = "The price changed. Check it and swipe again.";
    // the price shown is the most the registration will ever pay (iOS 4f5d95e, IOS-054), at the
    // speed it was quoted at
    const q = state.quote;
    const tier = state.quoteTier;
    if (!q?.affordable) { fail(q ? "Not enough KAS on your chatting address for this name." : priceChanged); return; }
    if (BigInt(q.years) !== state.years || tier !== state.feeTier) { fail(priceChanged); return; }
    if (!(await confirmPassword())) {
      // nothing was sent: back to the review as it was
      state.starting = false;
      if (!closed) { screen.returnToForm(); paint(); }
      return;
    }
    if (closed) return;
    if (state.quote !== q) { fail(priceChanged); return; }
    let commitTxId;
    try {
      commitTxId = await (await runtime()).actions.startRegistration({ name: target.name, years: BigInt(q.years), maxPrice: q.price, feeTier: tier });
    } catch (error) {
      fail(errorText(error));
      return;
    }
    state.starting = false;
    watchRegistrations();
    const actions = runtimeActions();
    const pending = actions?.pending ?? [];
    const started = pending.find((x) => x.commitTxId === commitTxId) ?? [...pending].reverse().find((x) => x.name === target.name && isOpen(x));
    // no registration to follow (it finished at once): nothing left to show
    if (!started) { screen.setSucceeded(""); screen.setBusy(false); exit(); return; }
    // The screen shows its progress; closing it leaves the claim running (iOS b219bb0).
    state.progressId = started.id;
    showOutcome();
    screen.setBusy(false);
    unsubscribe = actions?.subscribe?.(() => showOutcome()) ?? null;
  }

  const flow = createStepFlow(["years", "review"], (id, direction) => {
    if (closed) return;
    handle = null;
    if (id === "years") drawYears(direction);
    else drawReview(direction);
  });

  /** "For how long?": one button per length with its price; a tap picks it and goes on. Only
   *  Cancel at the bottom. */
  const drawYears = (direction) => {
    const step = showStep({
      screen: `${FLOW_SCREEN}-claim`,
      title: "Claim Name",
      question: "For how long?",
      className: "kl-claim-years-step",
      bodyHtml: `
        <p class="kl-claim-years-name">${esc(`${target.name}.kachat`)}</p>
        <div class="kl-claim-lengths">
          ${Array.from({ length: count }, (_, i) => {
            const y = i + 1;
            const price = priceFor(y);
            return `<button type="button" class="kl-claim-length" data-claim-years="${y}">
              <span class="kl-claim-length-label">${esc(yearsText(y))}</span>
              ${price != null ? `<span class="kl-claim-length-price">${esc(amount(price))}</span>` : ""}
              <span class="kl-claim-length-chevron">${ICONS.chevron}</span>
            </button>`;
          }).join("")}
        </div>
        <p class="muted small kl-claim-years-note">The price goes to the miners - KaChat takes nothing.</p>`,
      onCancel: exit,
      canContinue: false,
      direction,
    });
    handle = { el: step.el };
    for (const b of step.body.querySelectorAll("[data-claim-years]")) {
      b.onclick = () => {
        const y = BigInt(b.dataset.claimYears);
        if (y !== state.years) { state.years = y; requote(); }
        flow.go("review");
      };
    }
  };

  const drawReview = (direction) => {
    const screen = showSwipeUp({
      screen: FLOW_SCREEN,
      title: "Claim Name",
      onBack: () => { if (!state.starting && !state.progressId) flow.go("years"); },
      onCancel: exit,
      barTitle: "Swipe up to Claim",
      labels: SWIPE_UP_LABELS.claim,
      bodyHtml: reviewHtml(),
      enabled: canSwipe(),
      direction,
      getPreview: () => ({ amountSompi: state.quote?.total ?? null, recipient: `${target.name}.kachat` }),
      getFailureMessage: () => state.startError,
      onAction: () => { start(); },
      onDone: exit,
    });
    handle = { el: screen.body, swipe: screen };
    paint();
  };

  flow.go("years");
  requote();
  // A busy network starts on Fast unless you already chose (iOS e426432).
  runtime().then((rt) => rt.actions.refreshFeeEstimate?.()).then((estimate) => {
    if (closed) return;
    state.busy = Boolean(estimate?.isBusy);
    if (state.busy && !state.feeTouched && state.feeTier === FeeTier.normal) { state.feeTier = FeeTier.fast; requote(); } else paint();
  }).catch(() => { /* priced at Normal */ });
}

// --- Sheets with inputs --------------------------------------------------------------------

function openBuySheet(info) {
  // 30 days on mainnet's yearly clock, the renewal window on testnet's 10-minute one (IOS-060)
  const p = params();
  const soonMs = p ? paramsExpiresSoonMs(p) : 30n * 86_400_000n;
  const soon = info.expiresAt - soonMs < BigInt(Date.now());
  openTxSheet({
    title: "Buy Name", doneTitle: "Name bought",
    footer: soon ? `Less than ${duration(soonMs)} is left before this name expires. You'd have to renew it soon.` : "The payment reaches the seller and the name reaches you in the same transaction - both happen, or neither does.",
    rows: [{ title: "Name", value: info.display }, { title: "Price (to the seller)", value: amount(info.price) }, { title: "Expires", value: day(info.expiresAt) }],
    operation: () => Operation.buy(info),
    // Swipe up to Buy (iOS 5bab351): the BlockDAG while it goes out, then Name Bought and its progress
    swipeUp: { bar: "Swipe up to Buy", labels: SWIPE_UP_LABELS.buy, recipient: info.display },
  });
}

/** Make an Offer (iOS KachatLiveOfferSheet, KaPay 05db583): "How much do you offer?" - when it
 *  becomes refundable, and the amount on the keypad - then the review and swipe up to offer. Made
 *  to the name's current owner (v3), up to 7 days. */
function openOfferSheet(name, info) {
  const state = { typed: "", days: 3, virtualDaa: null };
  const offerAmount = () => positive(parseSompi(state.typed));
  const wantedAfter = () => state.virtualDaa + BigInt(state.days) * 86_400n * DAA_PER_SECOND;
  /** `days` from now, but never past the name's expiry (MAINNET.md C1, iOS 0312a3f, EXT-020):
   *  with yearly names that rarely matters, near the end of a period it does. */
  const refundAfter = () => {
    if (state.virtualDaa == null) return null;
    const msLeft = BigInt(info.expiresAt) - BigInt(Date.now()) - 600_000n; // 10 minutes of margin
    if (msLeft <= 0n) return null;
    const atExpiry = state.virtualDaa + (msLeft * DAA_PER_SECOND) / 1000n;
    const wanted = wantedAfter();
    return wanted < atExpiry ? wanted : atExpiry;
  };
  const cappedByExpiry = () => {
    const after = refundAfter();
    return after != null && after < wantedAfter();
  };
  const cappedDay = () => day(BigInt(info.expiresAt) - 600_000n);
  const cappedText = () => (cappedByExpiry() ? `This name expires sooner, so your offer is refundable from ${cappedDay()}.` : "");
  const footnote = info.isListed ? `Listed at ${amount(info.price)}` : "";
  const belowListing = () => Boolean(info.isListed && offerAmount() != null && info.price < offerAmount());
  const operation = () => (offerAmount() != null && refundAfter() != null ? Operation.offer(info, offerAmount(), refundAfter()) : null);
  let entryStep = null;
  const paintCapped = () => {
    const el = entryStep?.body.querySelector("[data-offer-capped]");
    if (!el) return;
    el.textContent = cappedText();
    el.hidden = !el.textContent;
  };
  openTxSheet({
    title: "Make an Offer", doneTitle: "Offer sent",
    footer: () => (belowListing()
      ? "This name is listed for less than your offer. Consider buying it instead."
      : "Your KAS stays locked on chain until the owner accepts or declines, you withdraw the offer, or it expires - then anyone can send it back to you."),
    rows: () => [
      { title: "Name", value: `${name}.kachat` },
      ...(info.isListed ? [{ title: "Listed at", value: amount(info.price) }] : []),
      { title: "Expires", value: day(info.expiresAt) },
      ...(offerAmount() != null ? [{ title: "Offer", value: amount(offerAmount()) }] : []),
      ...(refundAfter() != null ? [{ title: "Refundable after", value: cappedByExpiry() ? cappedDay() : state.days === 1 ? "1 day" : `${state.days} days` }] : []),
    ],
    operation,
    entry: {
      question: "How much do you offer?",
      className: "ss-keypad-step ss-amount-step kl-offer-entry",
      html: () => `
        <div class="kl-entry-picker">
          <span class="kl-entry-label">Refundable after</span>
          ${segmented("days", [[1, "1 Day"], [3, "3 Days"], [7, "7 Days"]], state.days)}
          <p class="kl-entry-caption" data-offer-capped ${cappedText() ? "" : "hidden"}>${esc(cappedText())}</p>
        </div>
        ${keypadAmountEntryHtml(keypadEntryOptions(state.typed, footnote))}`,
      canContinue: () => operation() != null,
      bind(step, { changed }) {
        entryStep = step;
        bindSegmented(step.body, "days", (value) => { state.days = Number(value); paintCapped(); changed(); step.refresh(); });
        bindKeypadEntry(step, { get: () => state.typed, set: (v) => { state.typed = v; }, footnote, onChange: changed });
      },
    },
    swipeUp: { bar: "Swipe up to Offer", labels: transactionSwipeLabels("Offer sent"), recipient: `${name}.kachat` },
  });
  runtime().then((rt) => rt.engine.currentVirtualDaaScore()).then((daa) => {
    state.virtualDaa = daa;
    paintCapped();
    entryStep?.refresh();
  }).catch(() => { /* the offer stays unbuildable */ });
}

/** checkmark.circle.fill / circle, for Renew's radio rows. */
const RADIO_ON = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.6" fill="currentColor"/><path d="m8 12.3 2.7 2.7 5.3-5.6" fill="none" stroke="var(--kaspa)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const RADIO_OFF = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/></svg>';

/** Renew (iOS KachatRenewSheet, KaPay 05db583): "How long?" first - the periods as full-width radio
 *  rows with what each costs, nothing picked until one is clicked - then the review with the fee and
 *  swipe up to renew; its Back leads to "How long?" again. Each period costs the renewal price
 *  (registry v4). */
function openRenewSheet(info) {
  const perYear = renewPrice(info.name) ?? 0n;
  const count = Math.max(1, maxYears());
  const state = { years: null };
  const choicesHtml = () => Array.from({ length: count }, (_, i) => {
    const y = i + 1;
    const on = state.years === y;
    return `<button type="button" class="kl-renew-choice ${on ? "on" : ""}" role="radio" aria-checked="${on}" data-renew-years="${y}">
      ${on ? RADIO_ON : RADIO_OFF}
      <span class="kl-renew-choice-label">${esc(yearsText(y))}</span>
      <span class="kl-renew-choice-price">${esc(amount(perYear * BigInt(y)))}</span>
    </button>`;
  }).join("");
  openTxSheet({
    title: "Renew", doneTitle: "Renewed",
    footer: "A renewal starts the next period at the current expiry, not from today, so a name that expired a while ago gets less time. The price goes to the miners.",
    rows: () => [
      { title: "Name", value: info.display },
      { title: pricePerPeriodTitle(), value: amount(perYear) },
      ...(state.years ? [{ title: "New period", value: `${day(info.expiresAt)} – ${day(info.expiresAt + BigInt(state.years) * periodMs())}` }] : []),
    ],
    operation: () => (state.years ? Operation.renew(info, BigInt(state.years)) : null),
    entry: {
      question: "How long?",
      html: () => `
        <p class="muted small kl-renew-sub">A renewal starts the next period at the current expiry, not from today.</p>
        <div class="kl-renew-choices" role="radiogroup" aria-label="How long?" data-renew-choices>${choicesHtml()}</div>`,
      canContinue: () => state.years != null,
      bind(step, { changed }) {
        const host = step.body.querySelector("[data-renew-choices]");
        host.onclick = (event) => {
          const pick = event.target.closest("[data-renew-years]");
          if (!pick) return;
          state.years = Number(pick.dataset.renewYears);
          host.innerHTML = unitText(choicesHtml());
          host.querySelector(`[data-renew-years="${state.years}"]`)?.focus({ preventScroll: true });
          changed();
          step.refresh();
        };
      },
    },
    swipeUp: { bar: "Swipe up to Renew", labels: transactionSwipeLabels("Renewed"), recipient: info.display },
  });
}

/** Whether extending by `years` fills the period to exactly maxYears. */
function fillsPeriod(info, years, p) {
  if (info.periodStart == null) return false;
  return info.expiresAt + BigInt(years) * p.periodMs === info.periodStart + BigInt(p.maxYears) * p.periodMs;
}

/** Registry v2 extend (iOS KachatExtendSheet): years added to the current paid period
 *  (periodStart kept), up to 2 years past its start - in practice a 1-year name extended to 2.
 *  The review, swipe up to extend (KaPay 05db583). */
function openExtendSheet(info) {
  const p = params();
  const available = p ? (info.extendableYears(p) > 1n ? info.extendableYears(p) : 1n) : 1n;
  const perYear = renewPrice(info.name) ?? 0n;
  const state = { years: 1n };
  const title = () => (p && fillsPeriod(info, state.years, p) ? (yearlyPeriods() ? `Extend to ${p.maxYears} years` : `Extend to ${periods(p.maxYears)}`) : "Extend");
  openTxSheet({
    title, doneTitle: "Extended",
    footer: yearlyPeriods()
      ? "Extending adds years to the current paid period, which holds at most 2 years. The price goes to the miners."
      : `Extending adds time to the current paid period, which holds at most ${periods(maxYears())}. The price goes to the miners.`,
    rows: () => [
      { title: "Name", value: info.display },
      { title: pricePerPeriodTitle(), value: amount(perYear) },
      { title: "Expires", value: day(info.expiresAt) },
      { title: "New expiry", value: day(info.expiresAt + state.years * periodMs()) },
    ],
    operation: () => Operation.extend(info, state.years < available ? state.years : available),
    inputsHtml: () => (available > 1n
      ? `<div class="sk-card">${segmented("years", Array.from({ length: Number(available) }, (_, i) => [i + 1, yearsText(i + 1)]), state.years)}</div>`
      : ""),
    bindInputs(body, changed) {
      if (available <= 1n) return;
      bindSegmented(body, "years", (value) => { state.years = BigInt(value); changed(); });
    },
    swipeUp: { bar: "Swipe up to Extend", labels: transactionSwipeLabels("Extended"), recipient: info.display },
  });
}

/** List for Sale / Change Price (iOS KachatListSheet, KaPay 05db583): the price on the keypad, then
 *  the review and swipe up to list. */
function openListSheet(info) {
  const state = { typed: "" };
  const price = () => positive(parseSompi(state.typed));
  const footnote = info.isListed ? `Listed at ${amount(info.price)}` : "";
  const done = info.isListed ? "Price changed" : "Listed for sale";
  openTxSheet({
    title: info.isListed ? "Change Price" : "List for Sale", doneTitle: done,
    footer: "Anyone can buy it at this price: the payment reaches you and the name reaches them in one transaction. Delist any time.",
    rows: () => [
      { title: "Name", value: info.display },
      ...(info.isListed ? [{ title: "Listed at", value: amount(info.price) }] : []),
      ...(price() != null ? [{ title: info.isListed ? "New price" : "Price", value: amount(price()) }] : []),
    ],
    operation: () => (price() != null ? Operation.list(info, price()) : null),
    entry: {
      question: info.isListed ? "What's the new price?" : "What's your price?",
      className: "ss-keypad-step ss-amount-step",
      html: () => keypadAmountEntryHtml(keypadEntryOptions(state.typed, footnote)),
      canContinue: () => price() != null,
      bind(step, { changed }) {
        bindKeypadEntry(step, { get: () => state.typed, set: (v) => { state.typed = v; }, footnote, onChange: changed });
      },
    },
    swipeUp: {
      bar: info.isListed ? "Swipe up to Change Price" : "Swipe up to List",
      labels: transactionSwipeLabels(done), recipient: info.display, showsAmount: false,
    },
  });
}

/** Transfer (iOS KachatTransferSheet, KaPay 05db583): "Who gets the name?" on the Send screens'
 *  recipient card - an address or a domain on any service, .kachat first (iOS 6ac48a7), the
 *  resolved address shown with Other domains under it; Paste, Scan QR (a ?query is dropped) and
 *  Contacts under the field, and the saved name when the address is in your contacts (iOS bfe7ef9,
 *  8118f09) - then the review and swipe up to transfer. Only a Schnorr address can own a name. */
function openTransferSheet(info) {
  const state = { input: "", recipient: null, error: "", resolving: false, resolutions: [], othersOpen: false };
  let entryStep = null;

  /** A resolved address must be a Schnorr P2PK one - only those can own a name. */
  const ownerOf = (address) => {
    const a = String(address || "").toLowerCase();
    const key = a ? KachatNamesRegistry.keyOf(a) : null;
    if (!key) return null;
    try { KachatNamesActions.validateKey(key, ""); } catch { return null; }
    return { address: a, key };
  };
  const fail = (message, resolutions = []) => { const error = new Error(message); error.resolutions = resolutions; return error; };
  const resolve = async (text) => {
    const t = String(text || "").trim().toLowerCase();
    if (t.startsWith("kaspatest:") || t.startsWith("kaspa:")) {
      const key = KachatNamesRegistry.keyOf(t);
      if (!key) throw fail("Not a Schnorr address on this network.");
      try { KachatNamesActions.validateKey(key, ""); } catch { throw fail("That address's key is not valid."); }
      return { address: t, key, domain: null, tld: null, resolutions: [] };
    }
    // Any domain, .kachat first, like every address field (iOS 6ac48a7).
    if (!looksLikeName(t)) throw fail("Enter an address or a domain.");
    let results;
    try { results = await resolveEverywhere(t); } catch { throw fail("Couldn't look that name up."); }
    // one shared message; what the name is elsewhere opens by itself (iOS 5a5122d)
    const primary = primaryResolution(results, t);
    if (!primary) throw fail(notFoundMessage(t, results), results);
    const owner = ownerOf(primary.address);
    if (!owner) throw fail("That name's address can't own a .kachat name.", results);
    return { ...owner, domain: primary.display, tld: primary.tld, resolutions: results };
  };
  const lookup = recipientLookup({
    read: () => state.input,
    resolve,
    onChange: (found) => {
      state.recipient = found.recipient;
      state.error = found.error;
      state.resolutions = found.resolutions;
      state.resolving = found.resolving;
      // nothing for the ending typed, but another service has the name: shown straight away
      state.othersOpen = Boolean(found.error) && found.resolutions.some((r) => r.address);
      paintRecipient();
      changedPlan();
    },
  });
  let changedPlan = () => {};
  const recipientStatus = () => ({
    resolving: state.resolving,
    error: state.error,
    resolvedAddress: state.recipient?.domain ? state.recipient.address : null,
    resolvedName: state.recipient?.domain || null,
    valid: Boolean(state.recipient && !state.recipient.domain),
  });
  const otherDomains = () => (state.resolutions.length
    ? otherDomainsHtml({ resolutions: state.resolutions, selectedTld: state.recipient?.tld || splitTypedName(state.input).tld, open: state.othersOpen })
    : "");
  const bindExtras = () => {
    if (!entryStep?.el.isConnected) return;
    bindOtherDomains(entryStep.el, {
      onToggle: () => { state.othersOpen = !state.othersOpen; paintRecipient(); },
      onPick: (tld) => {
        const pick = state.resolutions.find((r) => r.tld === tld && r.address);
        if (!pick) return;
        const owner = ownerOf(pick.address);
        if (owner) {
          state.recipient = { ...owner, domain: pick.display, tld: pick.tld, resolutions: state.resolutions };
          state.error = "";
        } else {
          state.recipient = null;
          state.error = "That name's address can't own a .kachat name.";
        }
        state.othersOpen = false;
        paintRecipient();
        changedPlan();
      },
    });
  };
  const paintRecipient = () => {
    const status = entryStep?.el.isConnected ? entryStep.el.querySelector("#recipient-status") : null;
    if (!status) return;
    status.innerHTML = unitText(recipientStatusHtml({ input: state.input, status: recipientStatus(), extraHtml: otherDomains() }));
    bindExtras();
    entryStep.refresh();
  };
  /** A new owner from Paste, Scan QR or Contacts: into the field, looked up at once. */
  const setText = (text) => {
    state.input = String(text || "").trim();
    const field = entryStep?.el.querySelector("#recipient");
    if (field) field.value = state.input;
    lookup.now();
  };
  const canContinue = () => Boolean(state.recipient) && !state.resolving;

  openTxSheet({
    title: "Transfer", doneTitle: "Name transferred",
    warning: "A transfer can't be undone. The new owner gets the name with its current expiry; your profile stays with your address.",
    rows: () => [
      { title: "Name", value: info.display },
      ...(state.recipient ? [{ title: "To", value: state.recipient.domain ? `${state.recipient.domain} · ${compactAddress(state.recipient.address)}` : state.recipient.address }] : []),
    ],
    operation: () => (state.recipient && !state.resolving ? Operation.transfer(info, state.recipient.key) : null),
    entry: {
      question: "Who gets the name?",
      html: () => `
        ${recipientCardHtml({ input: state.input, status: recipientStatus(), extraHtml: otherDomains() })}
        <p class="muted tiny kl-entry-caption">An address or a domain - .kachat names are looked up first, and it's resolved to the address shown.</p>`,
      canContinue,
      bind(step, { changed, next }) {
        entryStep = step;
        changedPlan = changed;
        const field = step.body.querySelector("#recipient");
        field.oninput = () => { state.input = field.value; lookup.schedule(); };
        field.onkeydown = (event) => {
          if (event.key !== "Enter" || event.isComposing || !canContinue()) return;
          event.preventDefault();
          next();
        };
        step.body.querySelector("#paste").onclick = async () => {
          try { setText((await navigator.clipboard.readText()).split("?")[0]); } catch { toast("Clipboard unavailable - paste with ⌘V instead."); }
        };
        step.body.querySelector("#scan").onclick = async () => {
          const code = await scanQr({ title: "Scan QR Code", hint: "Point camera at a Kaspa address QR code" });
          if (code && entryStep?.el.isConnected) setText(String(code).trim().split("?")[0]);
        };
        bindAddressBookButton(step.body, (address) => setText(address));
        bindExtras();
        // the cursor in the field on arrival (iOS focusOnAppear), after what's already there
        field.focus();
        try { field.setSelectionRange(field.value.length, field.value.length); } catch { /* fine */ }
      },
    },
    swipeUp: { bar: "Swipe up to Transfer", labels: transactionSwipeLabels("Name transferred"), recipient: info.display, showsAmount: false },
  });
}

// --- Name detail (iOS KachatLiveNameDetail) ------------------------------------------------

/**
 * A registered name, live: who owns it, its status and expiry, its price, and what the person
 * can do with it - buy or make an offer; or, for their own names, renew, list, transfer, release
 * and make it their primary name. Offers and history below.
 */
export async function showLiveNameDetail({ info: initial, onBack, screen = "kachat-name" }) {
  const rt = await runtime().catch(() => null);
  // Which of this wallet's addresses holds the name (iOS 881ada6): the chatting address, a spending
  // address or a KasSigner address - null for someone else's.
  const state = {
    info: initial, ownerLabel: null, offers: [], history: [], gone: false, heldBy: rt?.actions.ownAddress(initial.owner) ?? null,
    /** the free gap the name sits in once it's gone (released or reclaimed; iOS f420343), or the
     *  one claiming an expired name reopens (registry.claimGap, iOS eea52b2): Claim uses it */
    freeGap: null,
  };
  // "kachat:name" when opened from the marketplace (it stays in the .kachat tab), else a Profile-tab screen
  const here = () => app.dataset.screen === screen && app.dataset.kachatName === state.info.name;
  /** Held by the chatting address: the identity, so Set as Primary applies. */
  // Set as Primary applies only to the chatting address's names (iOS d1026de)
  const isChatting = () => state.heldBy?.kind === "chatting" || (!state.heldBy && isChattingKey(state.info.owner));
  /** Held by an address this wallet can sign for: every owner action. */
  const canActAsOwner = () => isChatting() || state.heldBy?.kind === "spending";
  /** Held by any of this wallet's addresses - never offered Buy / Make an Offer. */
  const ownedByWallet = () => Boolean(state.heldBy) || isChatting();
  /** Free to claim: released or reclaimed, or expired past grace - claiming frees the old record
   *  first (iOS eea52b2). */
  const isFree = () => state.gone || statusOf(state.info) === Status.lapsed;

  /** The name's art and what it is now: free to claim once it's gone (released or reclaimed - the
   *  old record is history; iOS f420343 / b799091), else the live record. */
  const nameCard = () => {
    const info = state.info;
    if (isFree()) {
      const price = namePrice(info.name);
      const priceLine = price == null ? "" : `Available · ${amount(price)} ${yearlyPeriods() ? "a year" : `per ${periods(1)}`}`;
      return `
        <div class="km-card km-name-card kl-name-card">
          <div class="km-name-banner">${esc(info.display)}</div>
          <div class="km-price-row">
            <span class="muted small">Free to claim</span>
            <span class="kl-pill kl-active">Available</span>
          </div>
          ${priceLine ? `<div class="muted tiny">${esc(priceLine)}</div>` : ""}
        </div>`;
    }
    const status = statusOf(info);
    // A listing only stands while the name is active: an expired or lapsed name's old asking price
    // is never shown - it can't be bought, only renewed or reclaimed (iOS ba1a734).
    const forSale = info.isListed && status === Status.active;
    let note = "";
    if (status === Status.grace) {
      note = ownedByWallet()
        ? '<p class="small kl-orange">Expired - renew to keep it. Until the grace period ends nobody else can take it.</p>'
        : '<p class="small kl-orange">Expired. It no longer resolves; the owner can still renew it.</p>';
    }
    return `
      <div class="km-card km-name-card kl-name-card">
        <div class="km-name-banner">${esc(info.display)}</div>
        <div class="km-price-row">
          <div class="tx-meta"><span class="muted tiny">${forSale ? "Price" : "Not for sale"}</span>${forSale ? `<span class="km-price">${esc(amount(info.price))}</span>` : ""}</div>
          <div class="kl-expiry">${statusPill(status)}<span class="muted tiny">Expires ${esc(day(info.expiresAt))}</span></div>
        </div>
        ${info.periodStart != null ? `<div class="muted tiny kl-paid">${SYMBOLS.calendar}<span>Paid from ${esc(day(info.periodStart))} to ${esc(day(info.expiresAt))}</span></div>` : ""}
        ${status === Status.grace ? `<div class="tiny kl-orange kl-grace-line">${SYMBOLS.hourglass}<span class="kl-grace-copy"><span>Grace period ends ${esc(day(info.expiresAt + graceMs()))}</span><span>Released in ${countdownHtml(info.expiresAt + graceMs())}</span></span></div>` : ""}
        ${note}
      </div>`;
  };

  const action = (id, label, icon, { prominent = false, disabled = false } = {}) =>
    `<button class="${prominent ? "km-prominent" : "km-bordered"} with-icon" id="${id}" ${disabled ? "disabled" : ""}>${icon}<span>${esc(label)}</span></button>`;

  const actionButtons = () => {
    const info = state.info;
    const status = statusOf(info);
    if (canActAsOwner()) {
      // Expired (in grace) and renewable: the one thing that matters now stays on the page; every
      // owner action lives in the Manage Name sheet of tiles (iOS f61b978). A name past grace shows
      // as free to claim (iOS eea52b2).
      const p = params();
      const first = status !== Status.active && p && info.renewOpen(p) ? action("kl-renew", "Renew", SYMBOLS.renew, { prominent: true }) : "";
      return `
        ${first ? `<div class="kl-one">${first}</div>` : ""}
        <div class="kl-one">${action("kl-manage", "Manage Name", SYMBOLS.sliders, { prominent: status === Status.active })}</div>`;
    }
    // Read-only on a KasSigner address: acting on it is the device's job (the Owner card says which).
    if (state.heldBy?.kind === "kasSigner") return "";
    const buy = info.isListed && status === Status.active;
    return `<div class="${buy ? "km-actions" : "kl-one"}">${buy ? action("kl-buy", "Buy Now", SYMBOLS.cart, { prominent: true }) : ""}${status === Status.active ? action("kl-offer", "Make an Offer", SYMBOLS.hand) : ""}</div>`;
  };

  /** The owner's actions as tiles (iOS manageItems): Extend while the paid period holds less than
   *  2 years, Renew once its window is open (otherwise the sheet says when it opens), list or
   *  change the price, delist, transfer, Set as Primary (the chatting address only), release. */
  const openManage = () => {
    const info = state.info;
    const status = statusOf(info);
    const p = params();
    const tiles = [];
    if (p) {
      const extendable = info.extendableYears(p);
      if (extendable > 0n) {
        const fills = fillsPeriod(info, extendable, p);
        tiles.push({
          title: !fills ? "Extend" : yearlyPeriods() ? `Extend to ${p.maxYears} years` : `Extend to ${periods(p.maxYears)}`,
          subtitle: yearlyPeriods() ? "Pays for more years now, up to the 2-year limit." : `Pays for more time now, up to the ${periods(p.maxYears)} limit.`,
          icon: SYMBOLS.calendarPlus, onClick: () => openExtendSheet(info),
        });
      }
      if (info.renewOpen(p)) tiles.push({ title: "Renew", subtitle: "Starts a new paid period from the expiry date.", icon: SYMBOLS.renew, onClick: () => openRenewSheet(info) });
    }
    if (info.isListed) {
      tiles.push({ title: "Change Price", subtitle: "Changes the asking price.", icon: SYMBOLS.tag, disabled: status !== Status.active, onClick: () => openListSheet(info) });
      tiles.push({ title: "Delist", subtitle: "Takes the name off the market.", icon: SYMBOLS.tagSlash, onClick: delist });
    } else {
      tiles.push({ title: "List for Sale", subtitle: "Puts the name up for sale at your price.", icon: SYMBOLS.tag, disabled: status !== Status.active, onClick: () => openListSheet(info) });
    }
    tiles.push({ title: "Transfer", subtitle: "Sends the name to another address.", icon: SYMBOLS.arrows, onClick: () => openTransferSheet(info) });
    if (isChatting()) tiles.push({ title: "Set as Primary", subtitle: "Shows you by this name across KaChat.", icon: SYMBOLS.primary, disabled: status !== Status.active, onClick: setPrimary });
    tiles.push({ title: "Release Name", subtitle: "Gives the name up and returns its deposit.", icon: SYMBOLS.trash, tint: "danger", onClick: release });
    const note = p && !info.renewOpen(p) ? `Renewal opens on ${day(info.renewOpens(p))}` : "";
    showTileSheet({ title: info.display, note, tiles });
  };

  const ownerCard = () => {
    const info = state.info;
    const address = addressOf(info.owner);
    const held = state.heldBy;
    const who = isChatting() ? "You"
      : held?.kind === "spending" ? `Your spending address #${held.index}`
      : held?.kind === "kasSigner" ? `Your KasSigner address (${held.account} #${held.index})`
      : state.ownerLabel ? `${state.ownerLabel}.kachat` : "";
    return `
      ${sectionHeader("Owner")}
      <div class="km-card km-seller">
        <span class="kl-owner-icon">${SYMBOLS.personFill}</span>
        <span class="tx-meta">
          ${who ? `<span class="strong small">${esc(who)}</span>` : ""}
          ${address ? `<button class="kl-owner-copy" id="kl-owner-copy" title="Copies the address" aria-label="${esc(address)}"><span class="mono tiny">${esc(compactAddress(address))}</span><span id="kl-owner-copy-icon">${ICONS.copy}</span></button>` : ""}
        </span>
      </div>`;
  };

  const offersSection = () => {
    const owner = canActAsOwner();
    const indexer = registry()?.source?.kind === "indexer";
    return `
      ${sectionHeader("Offers", owner ? "Tap an offer to accept or decline it. Expired offers go back to their buyers." : null)}
      ${state.offers.length
        ? offerGridHtml(state.offers, (o) => ({ isBuyer: isMine(o.buyer), isOwner: owner && indexer, declined: o.isDeclined(state.info.owner), nameInfo: state.info }))
        : '<div class="km-card km-empty-card muted small">No open offers.</div>'}
      ${registry()?.source?.kind === "chain" ? '<p class="muted small kl-pad">Offers from others appear once a names indexer is connected.</p>' : ""}`;
  };

  const historySection = () => `
    ${sectionHeader("History")}
    ${state.history.length
      ? `<div class="km-card km-list">${state.history.slice(0, 50).map((e) => eventRowHtml(e)).join("")}</div>`
      : '<div class="km-card km-empty-card muted small">No history yet.</div>'}`;

  const paint = () => {
    const scroll = app.querySelector(".km")?.scrollTop || 0;
    render(`
      ${navHeader({ title: state.info.display })}
      <section class="km kl-detail">
        ${nameCard()}
        ${isFree()
          ? `${state.freeGap ? `<div class="kl-one">${action("kl-claim-free", "Claim", SYMBOLS.atPlus, { prominent: true })}</div>` : ""}
             <p class="muted small kl-pad">${esc(state.gone
              ? "This name was released or reclaimed. It's free to claim again."
              : "This name expired and wasn't renewed, so anyone can claim it at the normal price. The old owner's bond goes back to them.")}</p>`
          : `${actionButtons()}
             ${ownerCard()}
             ${offersSection()}`}
        ${historySection()}
      </section>`, screen);
    if (screen.startsWith("kachat:")) dock.remember(() => showLiveNameDetail({ info: state.info, onBack, screen }));
    app.dataset.kachatName = state.info.name;
    const scroller = app.querySelector(".km");
    if (scroller) scroller.scrollTop = scroll;
    $("#back").onclick = () => { unsubscribe(); onBack(); };
    const info = state.info;
    const on = (id, fn) => { const el = $(`#${id}`); if (el) el.onclick = fn; };
    on("kl-buy", () => openBuySheet(info));
    // an expired name can be reclaimed by anyone soon: no offers on it (iOS 71128c4)
    on("kl-offer", () => { if (statusOf(info) === Status.active) openOfferSheet(info.name, info); });
    on("kl-renew", () => openRenewSheet(info));
    on("kl-manage", openManage);
    on("kl-owner-copy", async () => {
      try { await navigator.clipboard.writeText(addressOf(info.owner)); } catch { return; }
      const icon = $("#kl-owner-copy-icon");
      if (icon) { icon.innerHTML = ICONS.checkmark || "✓"; setTimeout(() => { if (icon.isConnected) icon.innerHTML = ICONS.copy; }, 1500); }
    });
    // free (released or reclaimed, or expired past grace): claim it on the gap it sits in, or the one
    // its reclaim reopens - the driver frees the old record first (iOS f420343 / eea52b2)
    on("kl-claim-free", () => { if (isFree() && state.freeGap) openClaimSheet({ name: info.name, gap: state.freeGap }); });
    bindOfferRows(app);
  };

  const delist = () => {
    const info = state.info;
    openTxSheet({
      title: "Delist", doneTitle: "Delisted",
      rows: [{ title: "Name", value: info.display }, { title: "Listed at", value: amount(info.price) }],
      operation: () => Operation.list(info, 0n),
    });
  };
  const release = () => {
    const info = state.info;
    openTxSheet({
      title: "Release Name", doneTitle: "Name released",
      warning: "Releasing gives the name up for good: it becomes free for anyone to register, and the time you paid for is lost. You get the bond and the registry deposit back.",
      rows: [{ title: "Name", value: info.display }],
      operation: () => Operation.release(info),
    });
  };
  // Setting a primary name rewrites the profile record: confirmed on the save sheet with its fee
  // (iOS 7e238e5).
  const setPrimary = () => openProfileSaveSheet({
    title: "Set as Primary", confirmTitle: "Set as Primary", doneTitle: "Primary name set",
    async makeProfile() {
      const rt = await runtime();
      const address = rt.actions.myAddress;
      let profile = null;
      if (address) {
        profile = (await rt.registry.ownProfile(address))?.profile ?? null;
        if (!profile) profile = (await rt.registry.identity(address).catch(() => null))?.profile ?? null;
      }
      profile = profile ?? new Profile();
      profile.primaryName = state.info.name;
      return profile;
    },
  });

  const reload = async () => {
    const reg = registry();
    try {
      const found = await reg.lookup(state.info.name);
      if (found.kind === "registered") {
        state.info = found.info;
        state.gone = false;
        // past grace: free to claim, in the gap claiming it reopens (iOS eea52b2)
        if (statusOf(found.info) === Status.lapsed) {
          try { state.freeGap = await reg.claimGap(found.info); } catch { state.freeGap = null; }
        } else {
          state.freeGap = null;
        }
      } else {
        state.gone = true;
        state.freeGap = found.gap ?? null;
      }
    } catch { /* keep what we have */ }
    const owner = addressOf(state.info.owner);
    state.heldBy = (await runtime().catch(() => null))?.actions.ownAddress(state.info.owner) ?? null;
    if (!ownedByWallet() && owner) {
      try { state.ownerLabel = (await reg.identity(owner))?.label ?? null; } catch { /* no label */ }
    }
    state.history = await reg.history(state.info.name).catch(() => []);
    // only offers made since the owner got the name (MAINNET.md C6, iOS 0312a3f, EXT-020)
    state.offers = currentOffers(await reg.offersFor(state.info.name).catch(() => []), state.info.owner, state.history);
    if (state.offers.length) {
      const actions = (await runtime()).actions;
      await actions.refreshVirtualDaa().catch(() => {});
      // Expired offers don't stay on the name: the owner's app (and the buyer's) send them back;
      // your offers made to an earlier owner are pulled back (iOS ba07975).
      await prepareOfferSigners(state.offers);
      await actions.returnExpiredOffers(canActAsOwner() ? state.offers : state.offers.filter((o) => isMine(o.buyer))).catch(() => {});
      await actions.withdrawDeclinedOffers(state.offers).catch(() => {});
    }
    if (here()) paint();
  };

  const stopRegistry = registry()?.onChange(() => { if (here()) reload(); }) ?? (() => {});
  // back from a name transaction's steps (they take the popup, KaPay 05db583): what it changed shows
  const onRestored = () => { if (here()) reload(); };
  restoreHooks.add(onRestored);
  const unsubscribe = () => { stopRegistry(); restoreHooks.delete(onRestored); };
  paint();
  reload();
}

// --- Fund an address (iOS eb9b027 KachatAddressFundSheet, 2b45d6e) -------------------------

/** Any address's balance in sompi, read from a node, or null when it can't be read. */
export async function addressBalanceSompi(address) {
  try { return (await wallet.balancesFor([address]))[address] ?? 0n; } catch { return null; }
}

/**
 * Fund: the headline, the address's QR code, the address and a copy button - the zero-balance
 * funding card's look. Closes by itself once the address holds `dismissAtSompi` (any KAS by
 * default), checked every few seconds. `onClose()` runs however it closed.
 */
export function openAddressFundSheet({ address, title, dismissAtSompi = 1n, onClose = null }) {
  if (!address) return null;
  let timer = null;
  const handle = openPanel({
    title: "", trailing: "Done", stack: true,
    body: `
      <div class="kl-fund">
        <div class="strong center-text">${esc(title)}</div>
        <canvas class="kl-fund-qr" width="360" height="360"></canvas>
        <button class="mono tiny kl-fund-address" data-fund-copy title="Copy address">${esc(address)}</button>
        <button class="km-bordered" data-fund-copy>Copy Address</button>
      </div>`,
    onClose: () => { clearTimeout(timer); try { onClose?.(); } catch { /* fine */ } },
  });
  import("qrcode").then(({ default: QRCode }) => QRCode.toCanvas(handle.panel.querySelector(".kl-fund-qr"), address, { width: 360, margin: 1 })).catch(() => {});
  for (const b of handle.panel.querySelectorAll("[data-fund-copy]")) {
    b.onclick = async () => { try { await navigator.clipboard.writeText(address); toast("Address copied to clipboard."); } catch { /* blocked */ } };
  }
  const poll = async () => {
    if (!handle.isOpen()) return;
    const balance = await addressBalanceSompi(address);
    if (balance != null && balance >= BigInt(dismissAtSompi)) { handle.close(); return; }
    timer = setTimeout(poll, 4000);
  };
  timer = setTimeout(poll, 4000);
  return handle;
}

// --- Saving the profile record (iOS KachatProfileSaveSheet) --------------------------------

const PRIVACY_SEEN_KEY = "kachat_profile_privacy_seen";

/** "X · x.com/name", or "None". */
function sourceText(link, kind) {
  const s = link ? SocialSource.fromLink(link, kind) : null;
  return s ? `${SocialPlatform.displayName(s.platform)} · ${SocialPlatform.prefix(s.platform)}${s.displayHandle}` : "None";
}

/**
 * The confirmation every profile save shows - Edit KaChat Profile and Set as Primary: what will
 * be saved, the network fee (quoted by building the record as the save does, nothing sent) and
 * the chatting address's balance before and after; then the password, then the done sheet.
 *   makeProfile(): the record to save, built when the sheet opens
 *   onSaved(): after the done sheet closes
 */
export function openProfileSaveSheet({ title, confirmTitle, doneTitle, makeProfile, onSaved = () => {} }) {
  const state = { profile: null, fee: null, quoteError: null, balance: null, sending: false, sendError: null, done: false };
  let handle = null;
  let privacySeen = false;
  try { privacySeen = localStorage.getItem(PRIVACY_SEEN_KEY) === "1"; } catch { /* first time */ }

  const bodyHtml = () => {
    const p = state.profile;
    const profileRows = p ? `
      <div class="form-section">
        <div class="form-header">Your Profile</div>
        <div class="form-card">
          ${labeledRow("Avatar", sourceText(p.avatar, SocialKind.avatar))}
          ${labeledRow("Banner", sourceText(p.banner, SocialKind.banner))}
          ${labeledRow("Bio", sourceText(p.bio, SocialKind.bio))}
          ${labeledRow("Linktree", p.linktree ? p.linktree.replace("https://", "") : "None")}
          ${labeledRow("Primary name", kachatLaunched ? (p.primaryName ? `${p.primaryName}.kachat` : "None") : "Coming soon")}
        </div>
      </div>` : "";
    let cost = "";
    if (state.fee != null) {
      cost = labeledRow("Network fee", amount(state.fee));
      if (state.balance != null) {
        cost += labeledRow("Chatting address balance", amount(state.balance))
          + labeledRow("Balance after", amount(state.balance > state.fee ? state.balance - state.fee : 0n), true);
      }
    } else if (!state.quoteError) {
      cost = '<div class="form-row between"><span>Network fee</span><span class="spinner small-spin"></span></div>';
    }
    const foot = state.quoteError
      ? `<span class="error-text">${esc(state.quoteError)}</span>${state.shortOfFunds ? `<button class="bar-text accent strong with-icon kl-fund-button" data-fund>${ICONS.qr}<span>Fund</span></button>` : ""}`
      : privacySeen
        ? "Saved on chain from your chatting address to itself."
        : "Profiles are public and on chain: anyone can read them, and earlier versions stay readable after you change them.";
    return `
      ${profileRows}
      <div class="form-section">
        ${cost ? `<div class="form-card">${cost}</div>` : ""}
        <div class="form-footer">${foot}</div>
      </div>
      <div class="form-section">
        <div class="form-card">
          <button class="form-row km-form-button" id="kl-save-profile" ${state.fee == null || !state.profile || state.sending || state.done ? "disabled" : ""}>
            ${state.sending ? '<span class="spinner small-spin"></span>' : esc(confirmTitle)}
          </button>
        </div>
        ${state.sendError ? `<div class="form-footer"><span class="error-text">${esc(state.sendError)}</span>${state.shortOfFunds ? `<button class="bar-text accent strong with-icon kl-fund-button" data-fund>${ICONS.qr}<span>Fund</span></button>` : ""}</div>` : ""}
      </div>`;
  };

  const paint = () => {
    if (!handle?.isOpen()) return;
    const host = handle.panel.querySelector("[data-save]");
    host.innerHTML = unitText(bodyHtml());
    host.querySelector("#kl-save-profile")?.addEventListener("click", save);
    for (const b of host.querySelectorAll("[data-fund]")) b.onclick = () => showFunding();
  };

  // Not enough on the chatting address to pay the fee (iOS 2b45d6e, IOS-084): its QR code pops up
  // by itself once per sheet - after that the Fund button under the message opens it - and it
  // closes by itself as soon as any KAS arrives; the fee is worked out again either way.
  const NOT_ENOUGH = "You don't have enough funds. Please send at least 1 KAS to your chatting address.";
  let funding = null;
  let fundingShownOnce = false;
  // read from the error alone: an unreachable node is not "no funds"
  const shortOfFunds = (error) => error?.code === "noFunds" || /insufficient|no spendable|not enough/i.test(String(error?.message ?? error ?? ""));
  const noteShortOfFunds = () => {
    state.shortOfFunds = true;
    if (!fundingShownOnce) { fundingShownOnce = true; showFunding(); }
  };
  const showFunding = async () => {
    if (funding || !handle?.isOpen()) return;
    const address = (await kachatProfiles().catch(() => null))?.actions.myAddress;
    if (!address) return;
    funding = openAddressFundSheet({
      address, title: NOT_ENOUGH,
      onClose: () => {
        funding = null;
        if (!handle?.isOpen()) return;
        state.quoteError = null;
        state.sendError = null;
        state.fee = null;
        paint();
        quote();
      },
    });
  };
  const quote = async () => {
    try {
      state.fee = await (await kachatProfiles()).actions.profileFee(state.profile);
      state.shortOfFunds = false;
    } catch (error) {
      if (shortOfFunds(error)) { state.quoteError = NOT_ENOUGH; noteShortOfFunds(); } else state.quoteError = errorText(error);
    }
    paint();
  };

  async function save() {
    if (!state.profile || state.fee == null || state.sending) return;
    if (!(await confirmPassword())) return;
    state.sending = true;
    state.sendError = null;
    paint();
    try {
      const tx = await (await kachatProfiles()).actions.saveProfile(state.profile);
      try { localStorage.setItem(PRIVACY_SEEN_KEY, "1"); } catch { /* shown again next time */ }
      state.done = true;
      showTxDone({ txId: tx, title: doneTitle, onClose: () => { handle.close(); onSaved(); } });
    } catch (error) {
      if (shortOfFunds(error)) { state.sendError = NOT_ENOUGH; noteShortOfFunds(); } else state.sendError = errorText(error);
    }
    state.sending = false;
    paint();
  }

  handle = openPanel({ title, leading: "Cancel", full: true, stack: true, body: "<div data-save></div>", onClose: () => funding?.close() });
  paint();
  (async () => {
    try {
      state.profile = await makeProfile();
      paint();
    } catch (error) {
      state.quoteError = errorText(error);
      paint();
      return;
    }
    await quote();
  })();
  chattingBalance().then((balance) => { state.balance = balance; paint(); });
  return handle;
}

// --- Your Domains > .kachat (iOS KachatLiveDomainsTab) -------------------------------------

/** key -> the timer that fires when the next of a shown set of names lapses (iOS dropLapsed). */
const lapseTimers = new Map();

/** Calls `fn` once the next of `names` lapses (expiry plus grace, half a second late), replacing
 *  the timer `key` had. Nothing is scheduled when none is left to lapse. */
export function scheduleLapse(key, names, fn) {
  clearTimeout(lapseTimers.get(key));
  lapseTimers.delete(key);
  if (!names?.length) return;
  const now = BigInt(Date.now());
  const grace = graceMs();
  let next = null;
  for (const n of names) {
    const at = BigInt(n.expiresAt) + grace;
    if (at > now && (next == null || at < next)) next = at;
  }
  if (next == null) return;
  // setTimeout's ceiling is ~24.8 days: a longer wait fires early and simply schedules again
  const wait = Math.min(Number(next - now) + 500, 2_000_000_000);
  lapseTimers.set(key, setTimeout(() => { lapseTimers.delete(key); fn(); }, wait));
}

/** One address's own .kachat names - the .kachat tab of the chatting address, a spending address
 *  and a KasSigner address (iOS KachatAddressLiveNamesList, 881ada6): the same cards and detail
 *  screen as Your Domains. `{ html, bind(container, nav) }`; empty on mainnet. */
export function addressNamesTab({ address, repaint }) {
  return liveDomainsTab({ address, repaint, forAddress: true });
}

/** The tab's body for `address`: `{ html, bind(container, nav) }`, loading on its own. */
export function liveDomainsTab({ address, repaint, forAddress = false }) {
  const cache = liveDomainsTab.cache || (liveDomainsTab.cache = new Map());
  const entry = cache.get(address) || { names: [], offers: [], loaded: false, loading: false, revision: -1 };
  cache.set(address, entry);
  const reg = registry();
  // Not launched here (mainnet): no registry, so nothing to load - the empty state.
  if (!reg) entry.loaded = true;
  // Loads when the registry changed since the last load (iOS .task(id: registry.revision)).
  if (reg && !entry.loading && entry.revision !== reg.revision) {
    entry.loading = true;
    (async () => {
      const key = KachatNamesRegistry.keyOf(String(address).toLowerCase());
      let own = null;
      if (key) {
        try {
          await runtime().catch(() => null);
          if (reg.refreshedAt == null) await reg.refresh();
          // A name past grace is no longer theirs - it's Available to anyone in the marketplace (and
          // the bell says so); expired names in grace stay, to be renewed. Your Domains and each
          // address's tab alike (iOS e26562e / aa36d2a / eea52b2).
          // Your Domains holds the names and offers on every address of this wallet - the
          // chatting address and every used spending address, one claimed with Buy From too, on
          // any browser restored from the seed (iOS d1026de, IOS-085); an address's own tab, its own
          own = null;
          if (!forAddress) {
            const actions = (await runtime().catch(() => null))?.actions;
            if (actions) own = await actions.ownNamesAndOffers({ heldOnly: true });
          }
          entry.names = own ? own.names : await reg.heldNames(key);
          entry.upgrading = false;
        } catch (error) { entry.upgrading = isRegistryUpgrading(error); }
        if (!forAddress) {
          // The offers this wallet made, under its names (iOS 0765ce0, from the former My Names tab);
          // expired ones, and ones made to an earlier owner, come back on their own (ba07975).
          try {
            entry.offers = own ? own.offers : await reg.myOffers(key);
            if (entry.offers.length) {
              const actions = (await runtime()).actions;
              await actions.refreshVirtualDaa().catch(() => null);
              await prepareOfferSigners(entry.offers);
              await actions.returnExpiredOffers(entry.offers).catch(() => null);
              await actions.withdrawDeclinedOffers(entry.offers).catch(() => null);
            }
          } catch { /* a failed read keeps the offers shown (KaPay f4f5c0f) */ }
          // A lapse is just the clock running out - no registry change announces it - so the list
          // reloads when the next name lapses (iOS aa36d2a dropLapsed).
        }
        scheduleLapse(`tab:${address}`, entry.names, () => { entry.revision = -1; repaint(); });
      }
      entry.revision = reg.revision;
      entry.loaded = true;
      entry.loading = false;
      repaint();
    })();
  }
  // When it runs out, bottom right (iOS 72b7dc7): "Expires <date>" - with the time once less than
  // two days are left - or "Grace ends <date>" for a name expired and in its grace period.
  const cardFootnote = (n) => {
    const grace = statusOf(n) === Status.grace;
    const at = Number(grace ? n.expiresAt + graceMs() : n.expiresAt);
    const soon = at - Date.now() < 2 * 86_400_000;
    const when = new Date(at).toLocaleString(undefined, soon
      ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", year: "numeric" });
    return grace ? `Grace ends ${when}` : `Expires ${when}`;
  };
  const badge = (n) => {
    const status = statusOf(n);
    if (status === Status.active) return n.isListed ? "Listed" : null;
    return status === Status.grace ? "Expired" : "Available";
  };
  const upgrading = Boolean(registry()?.registryUpgrading || kachatRegistry() && entry.upgrading);
  const html = upgrading
    ? `<div class="kachat-coming">
        <span class="accent">${SYMBOLS.hammer}</span>
        <h3>Setting up</h3>
        <p class="muted small">${esc(registryUpgradingMessage)}</p>
      </div>`
    : !entry.loaded && !entry.names.length
    ? '<div class="center-text"><span class="spinner"></span></div>'
    : !entry.names.length
      ? (forAddress
        ? `<div class="kachat-address-empty">
            ${kachatWordmark(40)}
            <div class="strong">No .kachat names on this address</div>
            <p class="muted small">Names this address owns show here.</p>
          </div>`
        : `<div class="kachat-coming">
            <span class="accent">${ICONS.atCircle}</span>
            <h3>No .kachat names yet</h3>
          </div>`)
      : entry.names.map((n) => `
          <button class="domain-button" data-kachat-name="${esc(n.name)}" aria-label="${esc(n.display)}">
            <div class="domain-card"><span class="domain-name">${esc(n.display)}</span>${badge(n) ? `<span class="domain-badge">${esc(badge(n))}</span>` : ""}<span class="domain-foot">${esc(cardFootnote(n))}</span></div>
          </button>`).join("");
  const offers = !forAddress && !upgrading && entry.offers.length ? `
    <div class="kl-domains-offers">
      ${sectionHeader("My Offers", "Offers you made. Withdraw one any time; once it expires it comes back to you on its own.")}
      ${offerGridHtml(entry.offers, () => ({ isBuyer: true, isOwner: false, showName: true }))}
    </div>` : "";
  return {
    html: html + offers,
    /** Inscribe sits pinned under the list once it has loaded, unless the registry is setting up. */
    showsInscribe: entry.loaded && !upgrading,
    bind(container, nav) {
      for (const b of container.querySelectorAll("[data-kachat-name]")) {
        b.onclick = () => {
          const info = entry.names.find((n) => n.name === b.dataset.kachatName);
          if (info) nav.openName(info);
        };
      }
      if (offers) bindOfferRows(container);
    },
  };
}
