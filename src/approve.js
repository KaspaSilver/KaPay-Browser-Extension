// The approval window for website requests (popup.html?view=approve&id=...). background.js opens
// it for anything a site can't do on its own - connect, send Kaspa, sign a message - and waits
// for this page's answer. Closing the window rejects.
//
// Before it connects, signs or sends, the window claims the request from the worker, so nothing
// happens for a request the site was already told failed; the approve buttons arm only after the
// screen has been visible a moment; and a send the network never confirmed ends on "Not confirmed"
// with only Close (audit 2026-11-07).
//
// Every screen leads with the site's origin as the browser reported it, so a look-alike page name
// or title can't stand in for it. The page's own words (a message to sign) are shown as plain
// text, never markup.

import { netKey, reencodeAddress } from "./net.js";
import * as vault from "./vault.js";
import * as wallet from "./wallet.js";
import { ext, getLocal, setLocal, removeLocal } from "./browser.js";
import { esc, render, $, toast, noteActivity, resetActivityPing, ICONS } from "./ui.js";
import { SEND_OUTCOME_UNKNOWN } from "../shared/engine/transactions.js";
import { approvalTotals, armDelayLeft } from "./site-rules.js";
import { SEND_FEE_CHANGED } from "./send-coins.js";
import { carryAccountData } from "./account-data.js";

// Per network: a site connected on mainnet knows the kaspa: address, on testnet the kaspatest: one.
export const CONNECTIONS_KEY = netKey("kachat.connections");

export async function connections() {
  return (await getLocal(CONNECTIONS_KEY)) || {};
}

export async function removeConnection(origin) {
  const all = await connections();
  delete all[origin];
  await setLocal(CONNECTIONS_KEY, all);
}

// Both networks' connection maps, with the address prefix each one hands out.
const NETWORK_CONNECTIONS = [["kachat.connections", "kaspa"], ["kachat.connections.testnet", "kaspatest"]];

/** Drops every site connected to an account (the account was removed) - on BOTH networks, so the
 *  other network can't keep serving a removed account (audit EXT-002). null drops them all. */
export async function removeConnectionsFor(accountId) {
  for (const [key] of NETWORK_CONNECTIONS) {
    const all = (await getLocal(key)) || {};
    for (const [origin, entry] of Object.entries(all)) if (!accountId || entry.accountId === accountId) delete all[origin];
    await setLocal(key, all);
  }
}

/**
 * Sites follow the account, not a frozen address (audit EXT-001): after Change Chatting Address
 * every connection of `accountId` (both networks) gets the account's current chatting address and
 * public key, and content.js tells each site with accountsChanged.
 */
/** Accounts whose chatting address the passphrase migration changed (EXT-010, vault.js
 *  CONNECTIONS_TO_FOLLOW_KEY): their website connections move to the new address. Run on every
 *  wallet home and after an approval window's unlock; kept until it succeeds. */
export async function followOwedConnections() {
  await carryOwedData();
  const owed = await getLocal(vault.CONNECTIONS_TO_FOLLOW_KEY).catch(() => null);
  if (!Array.isArray(owed) || !owed.length) return;
  const ids = new Set(((await vault.readAccounts().catch(() => null))?.accounts || []).map((a) => a.id));
  if (!ids.size) return;
  const left = [];
  for (const id of owed) {
    if (!ids.has(id)) continue;
    try { await followAccount(id); } catch { left.push(id); }
  }
  if (left.length) await setLocal(vault.CONNECTIONS_TO_FOLLOW_KEY, left).catch(() => {});
  else await removeLocal([vault.CONNECTIONS_TO_FOLLOW_KEY]).catch(() => {});
}

/** The passphrase migration moved these accounts to new chatting addresses: what was kept under the
 *  old ones (backup owed, contacts, the bell) is carried to the new ones, on each network. */
async function carryOwedData() {
  const owed = await getLocal(vault.DATA_TO_CARRY_KEY).catch(() => null);
  if (!owed || typeof owed !== "object" || !Object.keys(owed).length) return;
  const ids = new Set(((await vault.readAccounts().catch(() => null))?.accounts || []).map((a) => a.id));
  if (!ids.size) return;
  const left = {};
  for (const [id, olds] of Object.entries(owed)) {
    if (!ids.has(id)) continue;
    try {
      const { address } = await wallet.identityFor(id);
      for (const old of olds || []) {
        const hrp = String(old).startsWith("kaspatest:") ? "kaspatest" : "kaspa";
        await carryAccountData(old, reencodeAddress(address, hrp) || address);
      }
    } catch {
      left[id] = olds;
    }
  }
  if (Object.keys(left).length) await setLocal(vault.DATA_TO_CARRY_KEY, left).catch(() => {});
  else await removeLocal([vault.DATA_TO_CARRY_KEY]).catch(() => {});
}

export async function followAccount(accountId, identity = null) {
  const current = identity || await wallet.identityFor(accountId);
  for (const [key, hrp] of NETWORK_CONNECTIONS) {
    const all = (await getLocal(key)) || {};
    let changed = false;
    for (const entry of Object.values(all)) {
      if (entry.accountId !== accountId) continue;
      const address = reencodeAddress(current.address, hrp) || current.address;
      if (entry.address !== address || entry.publicKey !== current.publicKey) {
        entry.address = address;
        entry.publicKey = current.publicKey;
        changed = true;
      }
    }
    if (changed) await setLocal(key, all);
  }
  return current;
}

function siteHeader(origin) {
  let host = origin;
  try { host = new URL(origin).host; } catch { /* keep the origin */ }
  const insecure = origin.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return `
    <div class="approve-site">
      <div class="site-badge">${esc(host.replace(/^www\./, "").charAt(0).toUpperCase() || "?")}</div>
      <div class="site-host">${esc(host)}</div>
      <div class="muted tiny mono">${esc(origin)}</div>
      ${insecure ? '<div class="status bad">This site is not using a secure (https) connection.</div>' : ""}
    </div>`;
}

// Log Out leaves the vault unlocked, so for websites it counts as locked (audit 2026-11-07). The
// key is onboarding.js's LOGGED_OUT_KEY, read here directly: onboarding.js imports this file.
const LOGGED_OUT_KEY = "kachat.loggedOut";

/** A screen with a title, a line of text and only Close. */
function showNotice(request, title, text, extra = "") {
  render(`
    <section class="screen approve">
      ${siteHeader(request.origin)}
      <h2 class="center-text">${esc(title)}</h2>
      <p class="muted center-text">${esc(text)}</p>
      ${extra}
      <div class="spacer"></div>
      <button id="close">Close</button>
    </section>`, "approve");
  $("#close").onclick = () => window.close();
}

/** Logged out: the site waits until you sign in to KaPay (audit 2026-11-07). */
function showSignedOut(request, reject) {
  render(`
    <section class="screen approve">
      ${siteHeader(request.origin)}
      <h2 class="center-text">Sign in to KaPay first</h2>
      <p class="muted center-text">You're logged out of KaPay. Open KaPay, choose your account, then try again on the site.</p>
      <div class="spacer"></div>
      <button id="open">Open KaPay</button>
      <button id="cancel" class="soft">Cancel</button>
    </section>`, "approve");
  $("#open").onclick = async () => { await ext.tabs.create({ url: ext.runtime.getURL("popup.html?view=tab") }); reject(); };
  $("#cancel").onclick = reject;
}

export async function showApproval(id) {
  const request = await ext.runtime.sendMessage({ type: "approval-get", id }).catch(() => null);
  if (!request) {
    render(`
      <section class="screen approve center">
        <p class="center-text">This request has expired or was already answered.</p>
        <button id="close">Close</button>
      </section>`, "approve");
    $("#close").onclick = () => window.close();
    return;
  }

  let answered = false;
  // An approved payment on its way: closing the window now must not tell the site "rejected" - the
  // browser asks "Leave site?" first, and the worker answers "may have been sent" (audit EXT-012).
  let sending = false;
  const markSending = (on) => {
    sending = on;
    ext.runtime.sendMessage({ type: "approval-sending", id, sending: on }).catch(() => {});
  };
  const respond = (result) => {
    answered = true;
    ext.runtime.sendMessage({ type: "approval-result", id, result }).catch(() => {});
    setTimeout(() => window.close(), 150);
  };
  const reject = () => {
    answered = true;
    ext.runtime.sendMessage({ type: "approval-result", id, error: true }).catch(() => {});
    setTimeout(() => window.close(), 150);
  };
  window.addEventListener("beforeunload", (event) => {
    if (answered) return;
    if (sending) { event.preventDefault(); event.returnValue = ""; return; }
    ext.runtime.sendMessage({ type: "approval-result", id, error: true }).catch(() => {});
  });

  // Which screen is up: a decision screen's late work (a fee arriving, its buttons arming) never
  // paints over the screen that replaced it.
  let screenToken = 0;
  const leaveScreen = () => { screenToken += 1; };
  const screen = () => { const token = screenToken; return () => token === screenToken; };

  // Connect / Sign / Approve arm once the screen has been visible and focused APPROVE_ARM_MS
  // (audit 2026-11-07): a window that pops up under a click the site timed can't take it as a yes.
  // They disarm whenever this window loses focus and arm again APPROVE_ARM_MS after it comes back
  // (audit 2026-11-13): a site's own window laid over this one can't turn a click into a yes.
  const inView = () => document.visibilityState === "visible" && document.hasFocus();
  let visibleSince = inView() ? Date.now() : null;
  const armChecks = new Set();
  const viewChanged = () => {
    if (!inView()) visibleSince = null;
    else if (visibleSince == null) visibleSince = Date.now();
    for (const check of [...armChecks]) check();
  };
  document.addEventListener("visibilitychange", viewChanged);
  window.addEventListener("focus", viewChanged);
  window.addEventListener("blur", viewChanged);
  const armWhenSeen = (onArmed, onDisarmed = () => {}) => {
    const shownAt = Date.now();
    const onScreen = screen();
    let armed = false;
    let timer = null;
    const check = () => {
      clearTimeout(timer);
      if (!onScreen()) { armChecks.delete(check); return; }
      const left = armDelayLeft({ visibleSince, shownAt, now: Date.now() });
      if (left === 0) {
        if (!armed) { armed = true; onArmed(); }
        return;
      }
      if (armed) { armed = false; onDisarmed(); }
      // hidden or unfocused: looked at again now and then as well as on focus
      timer = setTimeout(check, left ?? 250);
    };
    armChecks.add(check);
    check();
  };

  const showExpired = () => {
    answered = true;
    leaveScreen();
    showNotice(request, "This request expired", "Nothing was sent or signed. Go back to the site and try again.");
  };

  // Keeps the background worker (which holds the site's pending call) awake while you decide, and
  // notices when it no longer has the request (it restarted).
  setInterval(async () => {
    const answer = await ext.runtime.sendMessage({ type: "approval-ping", id }).catch(() => null);
    if (answer?.alive === false && !answered && !sending) showExpired();
  }, 20_000);

  const proceed = () => {
    if (request.kind === "connect") return showConnect(request, ctx);
    if (request.kind === "sendKaspa") return showSendApproval(request, ctx);
    if (request.kind === "signMessage") return showSignApproval(request, ctx);
    return reject();
  };

  /** Before connecting, signing or sending: the worker must still hold the request, with KaPay
   *  unlocked and signed in (audit 2026-11-07). False: another screen has taken over. */
  const claim = async () => {
    const answer = await ext.runtime.sendMessage({ type: "approval-claim", id }).catch(() => null);
    if (answer?.ok) return true;
    leaveScreen();
    if (answer?.reason === "signedOut") showSignedOut(request, reject);
    else if (answer?.reason === "disconnected") {
      answered = true;
      ext.runtime.sendMessage({ type: "approval-result", id, error: true }).catch(() => {});
      showNotice(request, "This site is no longer connected", "Nothing was sent or signed. Connect the site again to continue.");
    }
    else if (answer?.reason === "locked") showApprovalUnlock(request, proceed, reject);
    else showExpired();
    return false;
  };

  /** The network never confirmed an approved payment (SEND_OUTCOME_UNKNOWN): it may still land.
   *  The site hears "may have been sent" (4002, with the txid when known) and this window says
   *  "Not confirmed" with only Close - no Reject, no second Approve that could pay twice. */
  const notConfirmed = (error) => {
    answered = true;
    leaveScreen();
    ext.runtime.sendMessage({ type: "approval-result", id, outcomeUnknown: true, txid: error?.txid || "" }).catch(() => {});
    const txid = /^[0-9a-f]{64}$/i.test(String(error?.txid || "")) ? String(error.txid) : "";
    showNotice(request, "Not confirmed", String(error?.message || error),
      txid ? `<div class="glass list"><div class="list-row stack-tight"><span class="muted small">Transaction</span><span class="mono tiny break">${esc(txid)}</span></div></div>` : "");
  };

  const ctx = { respond, reject, markSending, claim, notConfirmed, armWhenSeen, screen };

  if (!(await vault.hasVault())) {
    render(`
      <section class="screen approve">
        ${siteHeader(request.origin)}
        <h2 class="center-text">Set up KaPay first</h2>
        <p class="muted center-text">This site wants to connect, but there is no wallet in this browser yet. Create or import an account in KaPay, then try again on the site.</p>
        <div class="spacer"></div>
        <button id="setup">Open KaPay</button>
        <button id="cancel" class="soft">Cancel</button>
      </section>`, "approve");
    $("#setup").onclick = async () => { await ext.tabs.create({ url: ext.runtime.getURL("popup.html?view=tab") }); reject(); };
    $("#cancel").onclick = reject;
    return;
  }
  if (await getLocal(LOGGED_OUT_KEY)) return showSignedOut(request, reject);
  if (!(await vault.isUnlocked())) return showApprovalUnlock(request, proceed, reject);
  // a site opening this window isn't you using KaPay: auto-lock is pushed back only by your own
  // clicks and keys here (audit 2026-11-13)
  proceed();
}

function showApprovalUnlock(request, onUnlocked, reject) {
  render(`
    <section class="screen approve">
      ${siteHeader(request.origin)}
      <p class="muted center-text">Unlock KaPay to continue.</p>
      <form id="form" class="stack">
        <input id="pw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" autofocus />
        <p class="error" id="error"></p>
        <button id="unlock" type="submit">Unlock</button>
        <button id="cancel" type="button" class="soft">Cancel</button>
      </form>
    </section>`, "approve");
  $("#cancel").onclick = reject;
  $("#form").onsubmit = async (event) => {
    event.preventDefault();
    const button = $("#unlock");
    button.disabled = true;
    try {
      await vault.unlock($("#pw").value);
      // an unlock here may have run the passphrase migration (EXT-010): its connections follow
      // before this request reads one
      await followOwedConnections();
      resetActivityPing();
      noteActivity();
      onUnlocked();
    } catch (error) {
      $("#error").textContent = error.message;
      button.disabled = false;
      $("#pw").select();
    }
  };
}

// --- connect ----------------------------------------------------------------------------------

async function showConnect(request, ctx) {
  const view = await vault.readAccounts();
  const rows = await Promise.all(view.accounts.map(async (account) => ({
    ...account,
    address: (await wallet.cachedAddresses(account.id))?.main || null,
  })));
  const onScreen = ctx.screen();
  let chosen = view.activeAccountId;
  let armed = false;
  let busy = false;
  const paint = () => {
    if (!onScreen()) return;
    render(`
      <section class="screen approve">
        ${siteHeader(request.origin)}
        <h2 class="center-text">Connect to this site?</h2>
        <p class="muted small center-text">It will see this account's chatting address and balance, and it can ask you to send Kaspa or sign messages. Nothing is sent or signed without your approval here.</p>
        <div class="glass list" role="radiogroup" aria-label="Account">
          ${rows.map((row) => `
            <button class="list-row" role="radio" data-account="${esc(row.id)}" aria-checked="${row.id === chosen}">
              <span class="source-radio">${row.id === chosen ? ICONS.circleCheck : ICONS.circle}</span>
              <span class="tx-meta"><span>${esc(row.name)}</span><span class="mono tiny muted">${esc(row.address ? wallet.shortAddress(row.address) : "")}</span></span>
            </button>`).join("")}
        </div>
        <p class="error" id="error"></p>
        <div class="spacer"></div>
        <div class="approve-buttons">
          <button id="cancel" class="soft">Cancel</button>
          <button id="ok" ${armed && !busy ? "" : "disabled"}>${busy ? '<span class="spinner"></span>' : "Connect"}</button>
        </div>
      </section>`, "approve");
    for (const row of document.querySelectorAll("[data-account]")) row.onclick = () => { chosen = row.dataset.account; paint(); };
    $("#cancel").onclick = ctx.reject;
    $("#ok").onclick = async () => {
      if (!armed || busy) return;
      busy = true;
      paint();
      // still waiting in the worker, KaPay unlocked and signed in (audit 2026-11-07)
      if (!(await ctx.claim())) return;
      try {
        const account = rows.find((r) => r.id === chosen);
        const identity = await wallet.identityFor(chosen);
        const all = await connections();
        all[request.origin] = { accountId: chosen, accountName: account?.name || "", address: identity.address, publicKey: identity.publicKey, connectedAt: Date.now() };
        await setLocal(CONNECTIONS_KEY, all);
        ctx.respond([identity.address]);
      } catch (error) {
        busy = false;
        paint();
        const shown = $("#error");
        if (shown) shown.textContent = error.message;
      }
    };
  };
  paint();
  ctx.armWhenSeen(() => { armed = true; paint(); }, () => { armed = false; paint(); });
}

async function connectionFor(request, reject) {
  const connection = (await connections())[request.origin];
  if (!connection) { toast("This site is no longer connected."); reject(); return null; }
  const view = await vault.readAccounts();
  if (!view.accounts.some((a) => a.id === connection.accountId)) { toast("The connected account was removed."); reject(); return null; }
  // The address and key the request will really use: the account's chatting address now. A
  // connection still on an older one is brought up to date first (audit EXT-001).
  const identity = await followAccount(connection.accountId);
  return {
    ...connection,
    address: identity.address,
    publicKey: identity.publicKey,
    accountName: view.accounts.find((a) => a.id === connection.accountId)?.name || connection.accountName,
  };
}

// --- send Kaspa -------------------------------------------------------------------------------

async function showSendApproval(request, ctx) {
  const connection = await connectionFor(request, ctx.reject);
  if (!connection) return;
  const onScreen = ctx.screen();
  const [to, sompiText, priorityFeeText] = request.params;
  const amount = BigInt(sompiText);
  // the site's own extra fee, shown on its own row (audit 2026-11-07; capped by background.js)
  const siteFee = BigInt(priorityFeeText || "0");
  // feeRise: the whole fee (network + site) a send said it would pay, more than this window showed
  // (SEND_FEE_CHANGED): shown from then on, and the next Approve pays exactly that
  const state = { fee: null, feeRise: null, available: null, validTo: null, sending: false, error: "", armed: false };
  const shownNetworkFee = () => {
    if (state.feeRise != null) return state.feeRise - siteFee;
    return state.fee != null ? wallet.kasToSompi(state.fee.toFixed(8)) : null;
  };

  const paint = () => {
    if (!onScreen()) return;
    const networkFee = shownNetworkFee();
    const { total } = approvalTotals({ amount, networkFeeSompi: networkFee, siteFeeSompi: siteFee });
    const short = state.available != null && total != null && total > state.available;
    render(`
      <section class="screen approve">
        ${siteHeader(request.origin)}
        <h2 class="center-text">Send Kaspa</h2>
        <div class="approve-amount">${esc(wallet.formatKas(amount, 8))} <span>KAS</span></div>
        <p class="center-text strong">Total ${total != null ? `${esc(wallet.formatKas(total, 8))} KAS` : "—"}</p>
        <div class="glass list">
          <div class="list-row stack-tight"><span class="muted small">To</span><span class="mono small break">${esc(to)}</span></div>
          ${state.validTo === false ? '<div class="list-row error-text">This is not a valid Kaspa address.</div>' : ""}
          <div class="list-row stack-tight"><span class="muted small">From</span><span>${esc(connection.accountName)}</span><span class="mono tiny muted break">${esc(connection.address)}</span></div>
          <div class="list-row"><span>Network Fee</span><span>${networkFee != null ? `${esc(wallet.formatKas(networkFee, 8))} KAS` : '<span class="spinner small-spin"></span>'}</span></div>
          ${siteFee > 0n ? `<div class="list-row"><span>Extra fee set by this site</span><span class="strong">${esc(wallet.formatKas(siteFee, 8))} KAS</span></div>` : ""}
          <div class="list-row"><span class="strong">Total</span><span class="strong">${total != null ? `${esc(wallet.formatKas(total, 8))} KAS` : "—"}</span></div>
          ${state.available != null ? `<div class="list-row"><span class="muted small">Available</span><span class="muted small">${esc(wallet.formatKas(state.available, 8))} KAS</span></div>` : ""}
        </div>
        ${short ? '<p class="error">Not enough Kaspa for this amount plus the fees.</p>' : ""}
        ${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}
        <div class="spacer"></div>
        <div class="approve-buttons">
          <button id="cancel" class="soft" ${state.sending ? "disabled" : ""}>Reject</button>
          <button id="ok" ${state.sending || !state.armed || state.validTo !== true || networkFee == null || short ? "disabled" : ""}>${state.sending ? '<span class="spinner"></span>' : "Approve"}</button>
        </div>
      </section>`, "approve");
    $("#cancel").onclick = ctx.reject;
    $("#ok").onclick = async () => {
      if (!state.armed || state.sending) return;
      state.sending = true;
      state.error = "";
      paint();
      // still waiting in the worker, KaPay unlocked and signed in (audit 2026-11-07)
      if (!(await ctx.claim())) return;
      try {
        const tip = Math.max(0, state.fee - state.sdkBase) + Number(siteFee) / 1e8;
        const result = await wallet.send({
          source: { kind: "main", accountId: connection.accountId },
          // the From this window showed: a different key (the chatting address changed in another
          // window) is refused before anything is built (SOURCE_CHANGED)
          fromAddress: connection.address,
          fromAccountId: connection.accountId,
          destination: to,
          amountKas: wallet.sompiToKasText(amount),
          tipKas: tip.toFixed(8),
          // the fee this window shows (network + the site's extra): a send rebuilt from other
          // coins that would pay more stops before anything is signed, as the Send screen's does
          expectedFeeSompi: networkFee + siteFee,
          // the password prompt shows what leaves the wallet, the site's own extra fee named
          totalText: total != null ? `${wallet.formatKas(total, 8)} KAS` : null,
          extraFeeText: siteFee > 0n ? `${wallet.formatKas(siteFee, 8)} KAS` : null,
          // asked again after the password, which can sit open while the worker restarts
          beforeBuild: () => ctx.claim(),
          // "may have been sent" (EXT-012) only once the password let it go: closing the window at
          // the password prompt is a plain rejection
          onAuthorized: () => ctx.markSending(true),
        });
        const txid = (result?.txids || [])[result?.txids?.length - 1] || "";
        if (!txid) throw new Error("The node did not return a transaction id.");
        ctx.respond(txid);
      } catch (error) {
        // no answer from the network: it may be on chain, so never Approve or Reject again
        if (error?.code === SEND_OUTCOME_UNKNOWN) return ctx.notConfirmed(error);
        // the request was gone after the password: the claim already shows why, nothing was sent
        if (error?.code === wallet.SEND_ABORTED) return;
        state.sending = false;
        ctx.markSending(false);
        // nothing was sent: built from today's coins it would pay more than shown. The new fee is
        // shown with why, and Approve pays exactly that.
        if (error?.code === SEND_FEE_CHANGED) {
          state.feeRise = error.feeSompi;
          state.error = String(error.message);
          paint();
          return;
        }
        // the password prompt was cancelled: nothing was sent; Approve or Reject again
        state.error = error?.code === wallet.SEND_CANCELLED ? "" : String(error?.message || error);
        paint();
      }
    };
  };
  paint();
  ctx.armWhenSeen(() => { state.armed = true; paint(); }, () => { state.armed = false; paint(); });
  state.validTo = await wallet.isValidAddress(to);
  paint();
  try {
    state.available = (await wallet.balancesFor([connection.address]))[connection.address] ?? 0n;
  } catch { /* shown as unknown */ }
  // No made-up fee when the estimate fails (KaPay iOS 0799cec): Approve stays off and says why.
  try {
    const estimate = await wallet.estimateFee({ address: connection.address, destination: to, amountKas: wallet.sompiToKasText(amount) });
    if (estimate?.policyKas == null) throw new Error("no estimate");
    state.fee = estimate.policyKas;
    state.sdkBase = estimate?.sdkBaseKas ?? 0.00002;
  } catch {
    state.fee = null;
    state.error = "Couldn't work out the network fee. Close this window and try again from the site.";
  }
  paint();
}

// --- sign message -----------------------------------------------------------------------------

async function showSignApproval(request, ctx) {
  const connection = await connectionFor(request, ctx.reject);
  if (!connection) return;
  const [message] = request.params;
  render(`
    <section class="screen approve">
      ${siteHeader(request.origin)}
      <h2 class="center-text">Sign Message</h2>
      <div class="glass list">
        <div class="list-row stack-tight"><span class="muted small">Account</span><span>${esc(connection.accountName)}</span><span class="mono tiny muted break">${esc(connection.address)}</span></div>
      </div>
      <div class="sign-message" tabindex="0" aria-label="Message"></div>
      <p class="muted small">Only sign messages you understand. Signing proves you own this address; it does not send Kaspa.</p>
      <p class="error" id="error"></p>
      <div class="approve-buttons">
        <button id="cancel" class="soft">Reject</button>
        <button id="ok" disabled>Sign</button>
      </div>
    </section>`, "approve");
  // set after render: the testnet KAS -> TKAS relabel never changes the text you sign
  $(".sign-message").textContent = message;
  let armed = false;
  let busy = false;
  $("#cancel").onclick = ctx.reject;
  $("#ok").onclick = async () => {
    const button = $("#ok");
    if (!armed || busy) return;
    busy = true;
    button.disabled = true;
    // still waiting in the worker, KaPay unlocked and signed in (audit 2026-11-07)
    if (!(await ctx.claim())) return;
    try {
      ctx.respond(await wallet.signMessage(connection.accountId, message));
    } catch (error) {
      $("#error").textContent = String(error?.message || error);
      busy = false;
      button.disabled = !armed;
    }
  };
  const setArmed = (on) => {
    armed = on;
    const button = $("#ok");
    if (button && !busy) button.disabled = !on;
  };
  ctx.armWhenSeen(() => setArmed(true), () => setArmed(false));
}
