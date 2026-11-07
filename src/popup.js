// KaPay popup (and the same page opened as a full tab with ?view=tab): boot and the home
// screen, which is KaPay iOS's Wallet tab (ProfileView). Sign-in, create and import live in
// onboarding.js; Send and Manage in send.js / manage.js; Your Domains in domains.js; Settings (a
// dock tab) in settings.js.

import { ext, isExtension, tellBackground } from "./browser.js";
import * as vault from "./vault.js";
import * as wallet from "./wallet.js";
import {
  app, isTab, esc, render, $, toast, copyText, settings, noteActivity, ICONS, showQr, showQrPending, showSheet, closeDialogs,
} from "./ui.js";
import { showSend } from "./send.js";
import { showRequestPayment } from "./request-payment.js";
import { loadOwnAddresses } from "./own-addresses.js";
import { showManageAddress, showManageAddresses, openSpendingAddress } from "./manage.js";
import { cachedOwnedNames, ownedNames, otherNamesCount } from "./names.js";
import { showWelcome, showUnlock, enterApp, setHandlers, setLoggedOut, deleteAccount, clearImportDraft, isLoggedOut, LOGGED_OUT_KEY } from "./onboarding.js";
import { showDomains } from "./domains.js";
import { showKachatMarket } from "./market.js";
import { watchRegistrations, scheduleLapse, showLiveNameDetail } from "./kachat-live.js";
import * as bell from "./bell.js";
import * as addressBook from "./address-book.js";
import { installGroupedAmountInputs } from "./grouped-amount.js";
import { cachedOwnedCount } from "./kachat-owned-cache.js";

// Amount fields show thousands commas as you type ("12,345.5"), the value underneath plain (iOS 40c5258).
installGroupedAmountInputs();
import { startKachatNamesNotifier } from "./kachat-notifier.js";
import { kachatLive, kachatNames, forgetKachatSigner } from "./kachat-names.js";
import { KachatNamesRegistry } from "../shared/engine/kachat-names/registry.js";
import { faucetCardHtml, startFaucetClaim, noteFaucetBalance, faucetPending } from "./faucet.js";
import { showSettings } from "./settings.js";
import { setBackupContext, backupBannerHtml, bindBackupBanner, hygieneCardHtml, bindHygieneCard, clearBackupFlow } from "./account-backup.js";
import { showApproval, followOwedConnections } from "./approve.js";
import { confirmSpend, cancelSpendPrompt } from "./spend-auth.js";
import { setShownAccount, shownAccount, followsSwitch } from "./account-scope.js";

// The password before every KAS you send (KaChat-Desktop Build 228): the prompt every send asks.
wallet.setSpendAuthorizer(confirmSpend);
import * as dock from "./dock.js";
import { NETWORK, NETWORK_MIRROR_KEY, IS_TESTNET, syncNetworkMirror } from "./net.js";

import { showColdStorage, coldWatchAddresses } from "./cold.js";
import { showPortfolio } from "./portfolio.js";
import { showCameraPermissionPage } from "./camera.js";
import { logWarn } from "./log.js";

const params = new URLSearchParams(location.search);
const isApproval = params.get("view") === "approve";

// --- boot --------------------------------------------------------------------------------

async function boot() {
  if (!isExtension) {
    render('<section class="screen center"><p class="center-text">Open this page from the KaPay extension.</p></section>');
    return;
  }
  await syncNetworkMirror();
  // Start the 12 MB WASM download/compile now, while the first screen is up.
  wallet.kaspa().catch(() => {});
  wallet.useExplorer((await settings()).explorer);
  // A website's request (background.js opened this window for it).
  if (isApproval) return showApproval(params.get("id") || "");
  // The one-time camera permission page the scanner opens from the popup.
  if (params.get("view") === "camera") return showCameraPermissionPage(app);
  if (!(await vault.hasVault())) return showWelcome();
  if (!(await vault.isUnlocked())) return showUnlock();
  noteActivity();
  return enterApp();
}

// The Wallet tab's screens keep the dock; sheets and full-screen flows (send, keys, QR) don't.
dock.showsDock("home", "manage-chat", "manage-list", "manage-spending", "domains", "domain-detail",
  "licenses", "kachat-name", "identity-picker", "identity-detail");
dock.registerTab("profile", () => showHome());
dock.registerTab("cold", () => showColdStorage());
dock.registerTab("portfolio", () => showPortfolio());
// the .kachat marketplace, its own tab right of Wallet
dock.registerTab("kachat", () => showKachatMarket());
// Settings as a dock tab (iOS 040f91a SettingsView(isDockTab: true)): no Back, Log Out last.
dock.registerTab("settings", () => showSettings({ isDockTab: true, onLogOut: confirmLogOut, onDelete: deleteCurrentAccount }));
// A contact's Send KAS: Send Kaspa from the chatting address, to the saved address.
addressBook.setAddressBookSend((address, onClose) => {
  const main = homeState?.addresses?.main;
  if (main) showSend({ source: { kind: "main" }, fromAddress: main, recipient: address, onClose });
});

setHandlers({
  home: () => showHome(),
  settings: (opts) => showSettings(opts),
});

// The wallet can lock under an open popup (auto-lock alarm, or the lock button in another
// window): the unlock key disappears from storage.session, and the popup follows. So does every
// wallet window (never an approval window, which answers for the account it was opened for) when
// another one switches accounts - signs in to another, adds one, deletes the one shown - or logs
// out: the popup and the full tab never show different accounts, and nothing done in one acts on
// an account the other has left (vault.js publishes the active account's id for this).
ext?.storage?.onChanged?.addListener((changes, area) => {
  // The network was switched in another KaPay window: this one follows (net.js).
  if (area === "local" && changes[NETWORK_MIRROR_KEY] && changes[NETWORK_MIRROR_KEY].newValue !== NETWORK) {
    location.reload();
    return;
  }
  if (isApproval) return;
  if (area === "session" && changes["kachat.unlockKey"] && !changes["kachat.unlockKey"].newValue) {
    leaveAccount().then(async () => {
      wallet.disconnect();
      // Reset Wallet in another window takes the vault too: the welcome screen, not the unlock one
      if (await vault.hasVault()) showUnlock(); else showWelcome();
    });
    return;
  }
  if (area !== "local") return;
  const active = changes[vault.ACTIVE_ACCOUNT_KEY];
  if (active && followsSwitch(shownAccount().id, active.newValue)) {
    followAccountSwitch();
    return;
  }
  if (changes[LOGGED_OUT_KEY]?.newValue && shownAccount().id) leaveAccount().then(() => showWelcome());
  // signed in from another window while this one sits on the accounts screen: it follows in too
  else if (LOGGED_OUT_KEY in changes && !changes[LOGGED_OUT_KEY].newValue && app.dataset.screen === "accounts") {
    // a moment later, so this window's own sign-in (which fires this too) has already moved on
    setTimeout(() => {
      if (app.dataset.screen !== "accounts" || shownAccount().id) return;
      vault.isUnlocked().then((open) => { if (open && app.dataset.screen === "accounts") enterApp(); }).catch(() => {});
    }, 600);
  }
});

// Bumped whenever this window leaves the account it showed: a screen still loading for that
// account draws nothing.
let accountEpoch = 0;

/**
 * Everything this window had open for the account it showed goes - lock, log out, delete, or a
 * switch made in another window: the Wallet tab's state and the toolbar's balance, the backup steps
 * with the words they hold, the words typed into Import, a Confirm Send prompt (answered
 * "cancelled", nothing sent), sheets and alerts over the screen, and the dock's places (it opens on
 * Wallet again). The caller draws the next screen.
 */
async function leaveAccount() {
  accountEpoch += 1;
  homeState = null;
  setShownAccount(null);
  setBackupContext({ accountId: null, address: null, hasFunds: false });
  clearBackupFlow();
  clearImportDraft();
  cancelSpendPrompt();
  closeDialogs();
  dock.enableDock(false);
  dock.resetStatus();
  bell.useAccount(null);
  addressBook.useWallet(null);
  forgetKachatSigner();
  // what a cancelled prompt's own code does next runs now, so none of it draws over the next screen
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Another window made a different account active: this one shows that account's Wallet tab (or
 *  the sign-in screen, when signed out). */
async function followAccountSwitch() {
  await leaveAccount();
  if (!(await vault.isUnlocked())) return showUnlock();
  return enterApp();
}

// --- home: KaPay iOS's Wallet tab -----------------------------------------------------------
//
// Section for section as ProfileView lays it out since KaPay iOS 953b255, KaChat's Wallet tab: the
// toolbar (connection dot, the whole hot wallet's balance in the middle, the bell, then expand and
// lock), the backup banner while it's owed and the pinned "Wallet" title; then the total balance
// split into chatting and spending (WalletBalanceCard), Send, Receive and Request, Backup Hygiene
// when it's due, the Manage Addresses and Chatting Address squares, Your Domains and Contacts. No
// profile card, share button or floating arrows: a profile belongs to KaChat and KaPost. About and
// the account's name are in Settings. Help is left out: its only guide is the .kachat names guide.
// Swap (ChangeNOW, KaChat-Desktop Build 217) has no place in KaPay iOS; it stays here, a fourth
// button beside Request, so it is still reachable.
//
// Your Domains counts .kachat, .kas, .k and .kaspa names together.

let homeState = null;

function connectionDot(state) {
  const cls = state === "ok" ? "ok" : state === "bad" ? "bad" : "busy";
  const label = state === "ok" ? "Connected" : state === "bad" ? "Not connected" : "Connecting";
  return `<button class="dot-button" id="dot" aria-label="${label}" title="${label}"><span class="dot ${cls}"></span></button>`;
}

async function showHome() {
  const epoch = accountEpoch;
  dock.enableDock(true);
  dock.resetTab("profile");
  const accounts = await vault.readAccounts().catch(() => null);
  if (epoch !== accountEpoch) return;
  if (!accounts) return showUnlock();
  const account = accounts.accounts.find((a) => a.id === accounts.activeAccountId) || accounts.accounts[0];
  const currency = (await settings()).currency || "usd";
  const cached = await wallet.cachedAddresses(account.id);
  const spending = await wallet.spendingState(account.id);
  const loggedOut = await isLoggedOut();
  // locked, logged out or switched while this was read: the next screen is already drawn
  if (epoch !== accountEpoch) return;
  // logged out in another window while this one was following its switch (a delete there)
  if (loggedOut) { dock.enableDock(false); return showWelcome(); }
  // The bell keeps a feed per account (its chatting address) and network.
  bell.useAccount(cached?.main || null);
  // One list of contacts per wallet (iOS 00767a4).
  addressBook.useWallet(cached?.main || null);
  homeState = {
    account,
    currency,
    addresses: cached,
    spending,
    balances: null,
    kns: cached?.main ? wallet.cachedKns(cached.main) : null,
    otherNames: cached?.main ? cachedOwnedNames(cached.main) : null,
    // the saved .kachat list's count at once; the registry read corrects it (iOS f4f5c0f)
    kachatCount: kachatLive && cached?.main ? cachedOwnedCount(cached.main) ?? 0 : 0,
    price: wallet.cachedPrice(currency),
    connection: "busy",
    error: "",
  };
  noteBackupContext(homeState);
  paintHome();
  refreshHome();
  followOwedConnections().catch(() => {});
}

// --- Expired .kachat names (iOS 6ac48a7): a dismissible banner while any is in its grace period ---

const GRACE_DISMISSED_KEY = "kachat_grace_banner_dismissed";
const graceDismissed = () => { try { return localStorage.getItem(GRACE_DISMISSED_KEY) || ""; } catch { return ""; } };

function graceBannerHtml(s) {
  const grace = s.graceNames || [];
  if (!kachatLive || !grace.length || graceDismissed() === s.graceKey) return "";
  const one = grace.length === 1;
  const ends = one ? new Date(grace[0].endsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  return `
    <div class="grace-banner" id="grace-banner" role="button" tabindex="0">
      <span class="grace-icon">${ICONS.warning}</span>
      <span class="grace-text">
        <span class="strong small">${one ? "One of your .kachat domains expired" : `${grace.length} of your .kachat domains expired`}</span>
        <span class="muted tiny">${esc(one ? `Renew ${grace[0].info.name}.kachat before its grace period ends on ${ends} to keep it.` : "Renew them before their grace periods end to keep them.")}</span>
      </span>
      <button class="icon plain" id="grace-dismiss" aria-label="Dismiss">${ICONS.xCircle}</button>
    </div>`;
}

function bindGraceBanner(s) {
  const banner = $("#grace-banner");
  if (!banner) return;
  // one name opens it; several open Your Domains' .kachat list
  banner.onclick = () => {
    const grace = s.graceNames || [];
    if (grace.length === 1) showLiveNameDetail({ info: grace[0].info, onBack: showHome });
    else if (s.addresses?.main) showDomains({ address: s.addresses.main, onBack: showHome, service: "kachat" });
  };
  $("#grace-dismiss").onclick = (event) => {
    event.stopPropagation();
    try { localStorage.setItem(GRACE_DISMISSED_KEY, s.graceKey || ""); } catch { /* shows again next time */ }
    banner.remove();
  };
}

function paintHome() {
  const s = homeState;
  if (!s) return;
  const main = s.addresses?.main || null;
  const kns = s.kns || {};
  // Every name the account owns: .kachat (iOS 10e4a1a - 0 where the registry isn't launched), KNS,
  // .k and .kaspa.
  const domainCount = kns.known ? (s.kachatCount || 0) + kns.domainCount + otherNamesCount(s.otherNames) : null;
  // Both parts or a dash: a total missing one of them would read as the whole balance (iOS
  // HotWalletBalance). The total counts hidden addresses too, Cold Storage not.
  const totalSompi = s.balances?.total ?? null;
  const chattingSompi = s.balances?.main ?? null;
  const spendingSompi = s.balances ? s.balances.total - s.balances.main : null;
  // what the total is worth in your currency; testnet coins aren't worth anything
  const fiat = totalSompi != null && !IS_TESTNET ? wallet.formatFiat(totalSompi, s.price) : "";

  render(`
    <div class="profile">
      <header class="toolbar">
        ${connectionDot(s.connection)}
        <button class="toolbar-balance" id="balance" aria-label="Copy balance">
          <img src="icons/kaspa-logo.png" alt="" />
          <span>${totalSompi != null ? esc(wallet.formatKas(totalSompi, 8)) : "--"} KAS</span>
        </button>
        <div class="toolbar-right">
          ${bell.bellButtonHtml()}
          ${isTab ? "" : `<button class="icon" id="expand" aria-label="Open in a tab" title="Open in a tab">${ICONS.expand}</button>`}
          <button class="icon" id="lock" aria-label="Lock" title="Lock">${ICONS.lock}</button>
        </div>
      </header>
      ${backupBannerHtml()}
      <div class="profile-title"><h1>Wallet</h1></div>
      <section class="profile-body">
        ${graceBannerHtml(s)}
        <div class="wallet-balance-card">
          <div class="wallet-balance-head">
            <span class="muted">Total Balance</span>
            <button class="wallet-balance-total" id="total-balance" aria-label="Copy balance">${totalSompi != null ? `${esc(wallet.formatKas(totalSompi, 8))} KAS` : "--"}</button>
            ${fiat ? `<span class="muted">${esc(fiat)}</span>` : ""}
          </div>
          <div class="wallet-balance-parts">
            <div><span class="muted tiny">Chatting</span><span class="strong small mono-digits">${chattingSompi != null ? `${esc(wallet.formatKas(chattingSompi, 8))} KAS` : "--"}</span></div>
            <div><span class="muted tiny">Spending</span><span class="strong small mono-digits">${spendingSompi != null ? `${esc(wallet.formatKas(spendingSompi, 8))} KAS` : "--"}</span></div>
          </div>
        </div>
        <div class="wallet-actions">
          ${actionButton("send", "Send", ACTION.send)}
          ${actionButton("receive", "Receive", ACTION.receive)}
          ${actionButton("request", "Request", ACTION.request)}
          ${actionButton("swap", "Swap", ACTION.swap)}
        </div>
        ${hygieneCardHtml()}
        ${IS_TESTNET && main ? faucetCardHtml(main) : ""}
        <!-- Which address a send comes from is picked on the send screen (From), so this tab
             doesn't split Main from Spending or have a "primary". -->
        <div class="address-squares">
          <button class="address-square" id="manage-addresses"><span class="address-square-icon">${SQUARE.list}</span><span>Manage Addresses</span></button>
          <button class="address-square" id="chatting-qr" ${main ? "" : "disabled"}><span class="address-square-icon">${SQUARE.qr}</span><span>Chatting Address</span></button>
        </div>
        <button class="glass nav-row" id="domains">
          <span class="nav-row-label">${ICONS.at}<span>Your Domains</span></span>
          <span class="nav-row-value">${domainCount != null ? esc(String(domainCount)) : ""}</span>${ICONS.chevron}
        </button>
        <button class="glass nav-row" id="address-book">
          <span class="nav-row-label">${addressBook.CONTACTS_ICON}<span>Contacts</span></span>${ICONS.chevron}
        </button>
      </section>
    </div>`, "home");

  $("#dot").onclick = () => toast(s.connection === "ok" ? `Connected to ${wallet.connectedNodeUrl().replace(/^wss:\/\//, "")}` : s.connection === "bad" ? "Can't reach a Kaspa node - retrying" : "Connecting to the Kaspa network…");
  const copyBalance = () => { if (totalSompi != null) copyText(wallet.formatKas(totalSompi, 8), "Balance"); };
  $("#balance").onclick = copyBalance;
  $("#total-balance").onclick = copyBalance;
  $("#lock").onclick = lockWallet;
  $("#bell").onclick = openBell;
  bindGraceBanner(s);
  bindBackupBanner(showHome);
  bindHygieneCard(showHome);
  const expand = $("#expand");
  if (expand) expand.onclick = async () => { await ext.tabs.create({ url: ext.runtime.getURL("popup.html?view=tab") }); window.close(); };

  // Receive hands out a never-used address (iOS ReceiveKaspaQRView over freshReceiveAddress):
  // "Preparing a fresh address" while it is worked out, then the white QR page with the
  // address's balance in the bar. Each comes back to the Wallet tab.
  const back = () => dock.returnToTab();
  $("#send").onclick = () => { if (main) showSend({ source: { kind: "main" }, fromAddress: main, navTitle: "Send Kaspa", onClose: back }); };
  $("#receive").onclick = () => openReceive(back);
  $("#request").onclick = () => showRequestPayment();
  // ChangeNOW Swap (KaChat-Desktop Build 217)
  $("#swap").onclick = () => import("./swaps.js").then((m) => m.showSwap());
  if (main) $("#chatting-qr").onclick = () => openChattingQr(s, paintHome);
  $("#manage-addresses").onclick = () => showManageAddresses({
    onBack: showHome,
    onChangeIdentity: s.account.imported ? () => { homeState = null; showHome(); } : null,
  });
  $("#address-book").onclick = () => addressBook.showAddressBook({ onBack: showHome });
  $("#domains").onclick = () => { if (main) showDomains({ address: main, onBack: showHome, atCards: true }); };
  // Claim Testnet Kaspa (testnet only): the faucet opens in a tab; a wallet open in its own tab
  // watches the chatting balance for a minute, the popup checks it next time it opens.
  const faucet = $("#faucet");
  if (faucet) faucet.onclick = async () => {
    await startFaucetClaim(main, s.balances?.main ?? 0n);
    paintHomeIfShowing(s);
    for (let i = 0; i < 12 && isTab; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (homeState !== s) return;
      await refreshHome();
      if (!faucetPending(main)) return;
    }
  };
}

/** One of Send, Receive and Request (iOS walletActionButton): a filled accent circle, its name under. */
function actionButton(id, title, icon) {
  return `<button class="wallet-action" id="${id}"><span class="wallet-action-circle">${icon}</span><span>${esc(title)}</span></button>`;
}
const stroke = (body, size = 24) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
// arrow.up / arrow.down / doc.text, and Swap's arrows
const ACTION = {
  send: stroke('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  receive: stroke('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  request: stroke('<path d="M14 3.5H7.4A1.9 1.9 0 0 0 5.5 5.4v13.2a1.9 1.9 0 0 0 1.9 1.9h9.2a1.9 1.9 0 0 0 1.9-1.9V8Z"/><path d="M14 3.5V8h4.5M9 13h6M9 16.5h4"/>', 22),
  swap: stroke('<path d="M4 8h15M15 4l4 4-4 4"/><path d="M20 16H5M9 12l-4 4 4 4"/>', 22),
};
// list.bullet.rectangle / qrcode
const SQUARE = {
  list: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="M10 9h7.5M10 12h7.5M10 15h7.5"/><circle cx="6.5" cy="9" r=".6" fill="currentColor"/><circle cx="6.5" cy="12" r=".6" fill="currentColor"/><circle cx="6.5" cy="15" r=".6" fill="currentColor"/></svg>',
  qr: ICONS.qrBig,
};

/** Settings' last row (iOS 040f91a): a half sheet with the consequence beside the action. */
function confirmLogOut() {
  showSheet({
    title: "Log Out",
    rows: [{
      label: "Log Out",
      subtitle: "Signs out of this account. Wallet data stays in this browser.",
      icon: ICONS.logout,
      danger: true,
      onClick: logOut,
    }],
  });
}

/** Delete Account, once the password confirmed it (KaPay iOS 99ab88a deleteCurrentAccount): the
 *  account and everything kept for it go, and the sign-in screen comes up. */
async function deleteCurrentAccount(accountId, main) {
  await leaveAccount();
  try {
    await deleteAccount(accountId, main);
    toast("Account deleted.");
  } catch (error) {
    toast(error.message);
  }
  // Signed out: the next account is picked on the sign-in screen, as after Log Out.
  if (await vault.hasVault()) await setLoggedOut(true);
  showWelcome();
}

// iOS Log Out: back to the accounts screen, where you pick an account (or add one). The vault
// stays unlocked; the lock button is what asks for the password again.
async function logOut() {
  // left before the flag is written: this window doesn't follow its own log out (the listener above)
  await leaveAccount();
  await setLoggedOut(true);
  await wallet.disconnect();
  showWelcome();
}

async function lockWallet() {
  await leaveAccount();
  await vault.lock();
  tellBackground({ type: "lock" });
  await wallet.disconnect();
  showUnlock();
}

// Receive hands out a never-used address (iOS ReceiveKaspaQRView over freshReceiveAddress):
// "Preparing a fresh address" while it is worked out, then the white QR page with the
// address's balance in the bar.
async function openReceive(onBack) {
  showQrPending({ onBack });
  let address;
  try { address = await wallet.freshReceiveAddress(); } catch { address = null; }
  if (app.dataset.screen !== "qr") return;
  if (!address) return showQrPending({ failed: true, onBack });
  let balanceSompi = null;
  try { balanceSompi = (await wallet.balancesFor([address]))[address] ?? null; } catch { /* unknown - nothing shown */ }
  if (app.dataset.screen !== "qr") return;
  showQr({
    address,
    balanceSompi,
    note: "A fresh address, never used before. Kaspa sent here lands in this account and shows in your spending total. This address should be used for everything not related to chatting or domains.",
    onBack,
  });
}

// The chatting address's QR (Fund Chatting Address), shown from the recovery phrase, not only
// the cache (audit EXT-006).
async function openChattingQr(s, onBack) {
  const main = s?.addresses?.main;
  if (!main) return;
  showQr({
    address: (await wallet.identityFor(s.account.id).catch(() => null))?.address || main,
    balanceSompi: s.balances?.main ?? null,
    note: "This address should be for chatting and domains only. 1 Kaspa is enough for about 500 interactions in the app. Domains cost from 35 to 4,000 Kaspa, depending on the name.",
    onBack,
  });
}

// --- The bell (iOS GlobalNotificationListView): received Kaspa and .kachat news -------------

/** Repaints just the bell's dot when the feed changes. */
bell.onBellChange(() => {
  // the Wallet tab's red dot follows the bell from any tab (iOS 28d9d68)
  dock.setBadge("profile", bell.unreadCount() > 0);
  const button = app.querySelector("#bell");
  if (!button) return;
  button.outerHTML = bell.bellButtonHtml();
  app.querySelector("#bell").onclick = openBell;
});

function openBell() {
  bell.showBell({
    // a receipt opens the history of the address it reached (iOS 95e2cba): the chatting address,
    // a spending address, or Cold Storage for a KasSigner one; an older row without one, Portfolio
    openWallet: (address) => {
      const s = homeState;
      const main = s?.addresses?.main;
      if (!address) { dock.selectTab("portfolio"); return; }
      if (main && address === main.toLowerCase()) {
        showManageAddress({ address: main, onBack: showHome, onChangeIdentity: s.account.imported ? () => { homeState = null; showHome(); } : null });
      } else if (Object.values(s?.addresses?.spending || {}).some((a) => a.toLowerCase() === address)) {
        openSpendingAddress(address, showHome);
      } else {
        dock.selectTab("cold");
      }
    },
    // a .kachat row opens the name; one that's free again opens the marketplace to claim it
    openName: async (name) => {
      try {
        const rt = await kachatNames();
        const found = rt ? await rt.registry.lookup(name) : null;
        if (found?.kind === "registered") return showLiveNameDetail({ info: found.info, onBack: showHome });
      } catch { /* the marketplace then */ }
      dock.selectTab("kachat");
    },
  });
}

/** Every address of the account, labelled the way the bell describes it (iOS describe(address)).
 *  Only into this account's feed: the window may have moved to another account meanwhile. */
async function bellReceipts(s) {
  const list = [{ address: s.addresses.main, label: "Chatting address", chatting: true }];
  for (const address of Object.values(s.addresses.spending || {})) list.push({ address, label: "Spending address" });
  try {
    for (const c of await coldWatchAddresses()) list.push({ address: c.address, label: `Cold storage (${c.account})` });
  } catch { /* no KasSigner accounts */ }
  if (homeState !== s) return;
  bell.checkReceipts(list, { account: s.addresses.main });
}

// The home state a refresh is running for: one at a time for an account. A refresh still running
// for an account the window has left (lock, log out, a switch) stops at its next step - nothing of
// it reaches the toolbar, the bell or the backup status - and doesn't hold up the next account's.
let refreshingFor = null;
async function refreshHome() {
  const s = homeState;
  if (!s || refreshingFor === s) return;
  refreshingFor = s;
  const stale = () => homeState !== s;
  try {
    // Addresses first: derived from the phrase (a moment of CPU on first unlock), then cached.
    // both chains' last slot (a quantum-safe one at QUANTUM_INDEX_BASE + qMaxIndex, iOS bba1b1e)
    const lastQuantum = s.spending.qMaxIndex >= 0 ? wallet.QUANTUM_INDEX_BASE + s.spending.qMaxIndex : null;
    if (!s.addresses || s.addresses.accountId !== s.account.id || !s.addresses.spending?.[s.spending.maxIndex]
      || (lastQuantum != null && !s.addresses.spending?.[lastQuantum])) {
      const derived = await wallet.deriveAddresses();
      // derived for the active account, which another window may have changed meanwhile
      if (stale() || derived.accountId !== s.account.id) return;
      s.addresses = derived;
      bell.useAccount(s.addresses.main);
      addressBook.useWallet(s.addresses.main);
      s.kns = wallet.cachedKns(s.addresses.main);
      s.otherNames = cachedOwnedNames(s.addresses.main);
      if (kachatLive && !s.kachatCount) s.kachatCount = cachedOwnedCount(s.addresses.main) ?? 0;
      // the backup banner, Complete Your Backup and the delete warning at once, offline too - not
      // only once the balances load
      noteBackupContext(s);
      paintHomeIfShowing(s);
    }
    wallet.kns(s.addresses.main).then((info) => { s.kns = info; paintHomeIfShowing(s); }).catch(() => {});
    // .k / .kaspa names change rarely; the 30 s balance refresh asks for them every 5 minutes.
    if (!s.otherNamesAt || Date.now() - s.otherNamesAt > 5 * 60_000) {
      s.otherNamesAt = Date.now();
      ownedNames(s.addresses.main).then((owned) => { s.otherNames = owned; paintHomeIfShowing(s); }).catch(() => {});
    }
    try {
      await wallet.connection();
      if (stale()) return;
      s.connection = "ok";
      dock.setStatus({ connection: "ok", nodeUrl: wallet.connectedNodeUrl() });
      paintHomeIfShowing(s);
      // Testnet: the .kachat label for the hero, and registrations in flight resume (iOS resumes
      // them when the app becomes active).
      if (kachatLive) {
        const main = s.addresses.main;
        kachatNames()
          .then(async (rt) => {
            if (stale()) return;
            // The .kachat names for the Your Domains count: the set its .kachat tab lists - active
            // names and expired ones in grace, never lapsed ones (iOS aa36d2a heldNames).
            const key = KachatNamesRegistry.keyOf(main.toLowerCase());
            const countHeld = async () => {
              const held = await rt.registry.heldNames(key).catch(() => null);
              if (!held || s.addresses?.main !== main) return;
              // the ones expired and in grace: the Profile banner (iOS 6ac48a7)
              const graceMs = rt.registry.graceMs;
              const grace = held.filter((n) => n.status(graceMs) === "grace").map((n) => ({ info: n, endsAt: Number(n.expiresAt + graceMs) }));
              const graceKey = grace.map((g) => `${g.info.name}:${g.info.expiresAt}`).join(",");
              if (s.graceKey !== graceKey) { s.graceKey = graceKey; s.graceNames = grace; paintHomeIfShowing(s); }
              if (s.kachatCount !== held.length) { s.kachatCount = held.length; paintHomeIfShowing(s); }
              // a name that lapses while the wallet is open comes off the count right then
              scheduleLapse("count", held, countHeld);
            };
            if (rt && key) await countHeld();
            // an open registration brings its progress sheet back up (iOS 61fb0fc)
            watchRegistrations();
            // the bell's .kachat news: offers, sales, renewal and expiry (iOS 86471dd)
            startKachatNamesNotifier();
          })
          .catch(() => {});
      }
      if (!IS_TESTNET) wallet.price(s.currency).then((entry) => { if (entry && entry.price !== s.price?.price) { s.price = entry; paintHomeIfShowing(s); } }).catch(() => {});
      // the account total counts hidden addresses too, so nothing disappears from it (iOS 245a5d2)
      const balances = await wallet.balances(s.addresses, []);
      if (stale()) return;
      s.balances = balances;
      // The bell: Kaspa that arrived in any of this account's addresses since the last look.
      bellReceipts(s);
      // a restored phrase's address discovery, if it never completed (audit EXT-031)
      wallet.runPendingDiscovery(s.account.id);
      // "Your own address" on every To field, KasSigner's send included (iOS 56f004f)
      loadOwnAddresses();
      // A faucet visit's payment landed: Claim Testnet Kaspa locks for 24 hours.
      if (IS_TESTNET) noteFaucetBalance(s.addresses.main, s.balances.main);
      // Every tab's toolbar shows the whole hot wallet: the chatting address and every spending
      // address, hidden ones too (KaPay iOS 953b255 HotWalletBalance).
      dock.setStatus({ balanceText: wallet.formatKas(s.balances.total, 8) });
      noteBackupContext(s);
    } catch (error) {
      if (stale()) return;
      s.connection = "bad";
      dock.setStatus({ connection: "bad" });
      logWarn("[KaPay] network:", error);
    }
  } catch (error) {
    if (stale()) return;
    s.error = error.message;
    toast(error.message);
  } finally {
    if (refreshingFor === s) refreshingFor = null;
    paintHomeIfShowing(s);
  }
}

/** The backup banner follows the signed-in account; it turns red once the account holds funds,
 *  spending addresses included (iOS AccountBackupBanner.hasFunds). The same account is the one this
 *  window shows: Settings' account pages act on it (account-scope.js). */
function noteBackupContext(s) {
  const address = s.addresses?.main || null;
  setShownAccount({ id: s.account.id, address });
  setBackupContext({ accountId: s.account.id, address, hasFunds: Boolean(s.balances && s.balances.total > 0n) });
}

function paintHomeIfShowing(state) {
  // Only repaint when the home screen for this state is what's on screen.
  if (homeState === state && app.dataset.screen === "home") {
    const scroller = app.querySelector(".profile-body");
    const scrollTop = scroller?.scrollTop || 0;
    paintHome();
    const next = app.querySelector(".profile-body");
    if (next) next.scrollTop = scrollTop;
  }
}

// Balances stay current while the popup is open.
setInterval(() => { if (homeState && app.dataset.screen === "home") refreshHome(); }, 30_000);

// --- QR ----------------------------------------------------------------------------------

boot();
