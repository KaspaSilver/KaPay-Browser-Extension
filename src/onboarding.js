// Everything before the home screen - iOS OnboardingView and the screens it pushes:
//
//   the accounts screen   KaChat wordmark, Saved Accounts (tap to sign in, pencil to rename or
//                         remove), Create New Account, Import Existing Account, App Settings.
//                         Log Out in Settings lands here, as on iOS.
//   create                one tap (KaPay iOS 99ab88a), or Advanced: CreateWalletView ->
//                         PassphraseOptionView's entry
//   import                ImportSourceWalletView -> ImportWalletView -> PassphraseOptionView
//   unlock / reset        the browser's stand-in for Face ID: the wallet password
//
// The first account also sets the wallet password (the vault); later accounts are added to the
// unlocked vault.

import * as vault from "./vault.js";
import * as wallet from "./wallet.js";
import { ext, getLocal, setLocal, removeLocal } from "./browser.js";
import {
  app, esc, render, $, toast, noteActivity, resetActivityPing, ICONS, navHeader, showSheet, passwordGate,
} from "./ui.js";
import { isBip39Word, bip39Matches } from "../shared/ui/bip39-english.js";
import { removeConnectionsFor } from "./approve.js";
import { backupStatus } from "./account-backup.js";
import { showDeleteAccountSheet } from "./delete-account.js";
import { nextDefaultAccountName } from "../shared/ui/account-backup-status.js";
import { forgetWallet as forgetAddressBook } from "./address-book.js";
import { forgetAccount as forgetBell } from "./bell.js";
import { forgetKachatSigner } from "./kachat-names.js";
import { reencodeAddress } from "./net.js";
import { accountDataKeys, withoutAccount } from "./account-scope.js";

let goHome = () => {};
let goSettings = () => {};
/** popup.js hands over the screens that live outside onboarding. */
export function setHandlers({ home, settings }) {
  goHome = home;
  goSettings = settings;
}

// iOS keeps you signed out after Log Out until you pick an account again, across launches.
export const LOGGED_OUT_KEY = "kachat.loggedOut";
const LAST_USED_KEY = "kachat.accountLastUsed";

export async function isLoggedOut() { return Boolean(await getLocal(LOGGED_OUT_KEY)); }
export async function setLoggedOut(value) {
  if (value) await setLocal(LOGGED_OUT_KEY, true);
  else await removeLocal([LOGGED_OUT_KEY]);
}
async function markUsed(accountId) {
  const map = (await getLocal(LAST_USED_KEY)) || {};
  map[accountId] = Date.now();
  await setLocal(LAST_USED_KEY, map);
}

/** After unlocking: the account screen when signed out, otherwise home. */
export async function enterApp() {
  if (await isLoggedOut()) return showWelcome();
  return goHome();
}

// iOS lists the full address truncated in the middle.
function middleTruncate(address) {
  const text = String(address || "");
  return text.length > 34 ? `${text.slice(0, 20)}…${text.slice(-10)}` : text;
}

function shortAddr(address) {
  const text = String(address || "");
  return text.length > 20 ? `${text.slice(0, 10)}...${text.slice(-6)}` : text;
}

// --- welcome / create / import -----------------------------------------------------------

// The KaPay wordmark with the app mark beside it - iOS OnboardingView.titleSection. KaPay's name
// says what it is, so the welcome has no tagline under it (KaPay iOS 089a03f / 5bab351); unlocking
// keeps its instruction.
function wordmarkHtml(tagline = "") {
  return `
    <div class="hero">
      <div class="wordmark"><h1>KaPay</h1><img src="icons/kapay-logo.png" alt="KaPay logo" /></div>
      ${tagline ? `<p class="tagline">${esc(tagline)}</p>` : ""}
    </div>`;
}

export async function showWelcome() {
  // The same version Settings > About shows (the manifest's).
  const appVersion = ext?.runtime?.getManifest?.().version || "";
  // Saved accounts are listed only while the vault is open - names never sit unencrypted.
  let saved = [];
  if ((await vault.hasVault()) && (await vault.isUnlocked())) {
    const view = await vault.readAccounts().catch(() => null);
    const used = (await getLocal(LAST_USED_KEY)) || {};
    if (view) {
      saved = await Promise.all(view.accounts.map(async (account) => ({
        ...account,
        address: (await wallet.cachedAddresses(account.id))?.main || null,
        lastUsed: used[account.id] || account.createdAt || 0,
      })));
      saved.sort((a, b) => b.lastUsed - a.lastUsed);
    }
  }
  render(`
    <section class="onboard">
      <button class="icon onboard-gear" id="app-settings" aria-label="App Settings" title="App Settings">${ICONS.gearshape}</button>
      ${wordmarkHtml()}
      ${saved.length ? `
        <div class="saved">
          <div class="saved-header">Saved Accounts</div>
          <div class="saved-list">
            ${saved.map((account) => `
              <div class="saved-row">
                <button class="saved-main" data-sign-in="${esc(account.id)}">
                  <span class="saved-icon">${ICONS.personCheck}</span>
                  <span class="saved-text"><span class="saved-name">${esc(account.name)}</span><span class="saved-address" title="${esc(account.address || "")}">${esc(account.address ? middleTruncate(account.address) : "Address not derived yet")}</span></span>
                </button>
                <button class="icon plain saved-edit" data-edit="${esc(account.id)}" aria-label="Edit ${esc(account.name)}">${ICONS.pencilCircle}</button>
              </div>`).join("")}
          </div>
        </div>` : ""}
      <div class="buttons">
        <button id="create">${ICONS.plusCircle}<span>Create New Account</span></button>
        <button id="import" class="secondary">${ICONS.download}<span>Import Existing Account</span></button>
        <button id="advanced" class="ghost advanced-create">Advanced: Create with a Passphrase</button>
      </div>
      ${appVersion ? `<p class="onboard-version">Version ${esc(appVersion)}</p>` : ""}
    </section>`, "accounts");
  $("#app-settings").onclick = () => goSettings({ appSettings: true, onBack: showWelcome });
  $("#create").onclick = createAccount;
  $("#advanced").onclick = createWithPassphrase;
  $("#import").onclick = () => { importDraft = null; showImportSource(); };
  for (const button of app.querySelectorAll("[data-sign-in]")) {
    button.onclick = () => runAccountAction(async () => {
      try {
        await vault.switchAccount(button.dataset.signIn);
        await markUsed(button.dataset.signIn);
        await setLoggedOut(false);
        noteActivity();
        goHome();
      } catch (error) {
        toast(error.message || "Unable to sign in to this account.");
      }
    });
  }
  for (const button of app.querySelectorAll("[data-edit]")) {
    const account = saved.find((a) => a.id === button.dataset.edit);
    button.onclick = () => showSheet({
      title: account.name,
      subtitle: shortAddr(account.address),
      rows: [
        { label: "Rename", subtitle: "Gives this account a name of your own.", icon: ICONS.pencil, onClick: () => showRenameAccount(account) },
        { label: "Delete", subtitle: "Removes this account and its local data from this browser.", icon: ICONS.trash, danger: true, onClick: () => confirmRemoveAccount(account) },
      ],
    });
  }
}

function showRenameAccount(account) {
  render(`
    ${navHeader({ title: "Rename Account" })}
    <section class="screen">
      <form id="form" class="stack">
        <p class="muted">Enter a new name for this saved account.</p>
        <input id="name" value="${esc(account.name)}" placeholder="Account name" maxlength="40" autocomplete="off" autofocus />
        <button type="submit" id="save">Save</button>
      </form>
    </section>`, "rename-account");
  $("#back").onclick = showWelcome;
  $("#name").select();
  $("#form").onsubmit = async (event) => {
    event.preventDefault();
    const name = $("#name").value.trim();
    if (name && name !== account.name) {
      await vault.renameAccount(account.id, name);
      toast("Account renamed.");
    }
    showWelcome();
  };
}

// Creating, signing in or removing: one at a time, since each one replaces the account in the active
// slot (KaPay iOS 0799cec). The accounts screen's buttons are off while one runs.
let accountActionRunning = false;
async function runAccountAction(action) {
  if (accountActionRunning) return;
  accountActionRunning = true;
  for (const button of app.querySelectorAll(".onboard button")) button.disabled = true;
  try {
    await action();
  } finally {
    accountActionRunning = false;
    if (app.dataset.screen === "accounts") for (const button of app.querySelectorAll(".onboard button")) button.disabled = false;
  }
}

/** An account's chatting address: the one cached for it on this network, else worked out from its
 *  words in the vault - an account never opened on this network has none cached, and its delete
 *  still needs it (the not-backed-up warning, and what's kept under it). Null when neither works. */
async function chattingAddressOf(accountId) {
  const cached = (await wallet.cachedAddresses(accountId).catch(() => null))?.main;
  if (cached) return cached;
  try {
    const account = await vault.accountSecretsById(accountId);
    return await wallet.previewMainAddress(account.mnemonic, account.passphrase, account.family, account.identityIndex || 0);
  } catch {
    return null;
  }
}

/** The sign-in screen's Delete (iOS 99ab88a DeleteAccountSheet): the warning first, and an account
 *  that still owes its backup says so. Signed out, there are no words open to show. */
async function confirmRemoveAccount(account) {
  const address = account.address || await chattingAddressOf(account.id);
  if (app.dataset.screen !== "accounts") return;
  showDeleteAccountSheet({
    confirmSubtitle: `Deletes ${account.name}${address ? ` (${shortAddr(address)})` : ""} and its local data from this browser.`,
    notBackedUp: backupStatus.isPending(address),
    onConfirm: () => passwordGate({
      title: "Delete Account",
      message: "Enter your wallet password to delete this account.",
      verify: (password) => vault.verifyPassword(password),
      onBack: showWelcome,
      onUnlocked: () => runAccountAction(async () => {
        try {
          await deleteAccount(account.id, address);
          toast("Account removed.");
        } catch (error) {
          toast(error.message);
        }
        showWelcome();
      }),
    }),
  });
}

const bothNetworks = (address) => [reencodeAddress(address, "kaspa"), reencodeAddress(address, "kaspatest")];

/**
 * Removes an account and everything kept for it in this browser (iOS removeSavedAccount), on both
 * networks: address caches, spending state, Cold Storage and portfolios, an owed address discovery,
 * when it was last used, its UTXO labels, swaps, .kachat caches and news, its website connections,
 * its contacts and the bell's notifications (KaPay iOS 99ab88a), and what it owed a backup
 * (account-scope.js lists the keys). The last account takes the vault with it. Any key held for
 * signing goes first (KaPay iOS 0799cec). Without `mainAddress` the chatting address is worked out
 * from the vault before the account leaves it.
 */
export async function deleteAccount(accountId, mainAddress) {
  forgetKachatSigner();
  const view = await vault.readAccounts();
  if (view.accounts.length <= 1) {
    // nothing is left to seal, so the vault goes too, with every kachat.* record and the pages' storage
    await vault.resetWallet();
    await setLoggedOut(false);
  } else {
    const chatting = mainAddress || await chattingAddressOf(accountId);
    // every address it used, from both networks' caches, before they go
    const caches = await Promise.all([getLocal(`kachat.addresses.${accountId}`), getLocal(`kachat.addresses.${accountId}.testnet`)]).catch(() => []);
    const addresses = caches.flatMap((cache) => [cache?.main, ...Object.values(cache?.spending || {})]).filter(Boolean);
    const others = view.accounts.filter((a) => a.id !== accountId).map((a) => a.id);
    const otherCaches = await Promise.all(others.flatMap((id) => [getLocal(`kachat.addresses.${id}`), getLocal(`kachat.addresses.${id}.testnet`)])).catch(() => []);
    const keep = otherCaches.flatMap((cache) => [cache?.main, ...Object.values(cache?.spending || {})]).filter(Boolean);
    await vault.removeAccount(accountId);
    const { local, page } = accountDataKeys({ accountId, chatting, addresses, variants: bothNetworks, keep });
    await removeLocal(local);
    for (const key of page) { try { localStorage.removeItem(key); } catch { /* nothing kept */ } }
    await setLocal(LAST_USED_KEY, withoutAccount(await getLocal(LAST_USED_KEY), accountId));
    if (chatting) {
      await forgetAddressBook(chatting);
      forgetBell(chatting);
      backupStatus.forget(chatting);
    }
  }
  await removeConnectionsFor(accountId);
  await wallet.disconnect();
}

/** A typed-in recovery phrase runs the full Discover Addresses sweep - both chains - in the
 *  background once the wallet is open (iOS da2c8e2, owner: yes), so what this phrase received on
 *  another device shows up without a manual scan. Creating or switching accounts doesn't scan.
 *  The sweep is owed until it completes (audit EXT-031): a popup closed mid-sweep runs it again
 *  the next time the wallet opens. */
async function discoverAfterRestore(account, accountId) {
  if (!account?.imported || !accountId) return;
  try { await wallet.markDiscoveryPending(accountId); } catch { return; }
  wallet.runPendingDiscovery(accountId);
}

/** Nobody has seen a created account's words yet, so it owes the backup steps, marked before its
 *  keys are saved (KaPay iOS 0799cec): a popup closed in between can't leave an account that owes
 *  nothing. Whoever imported one has the words, so its six months of Backup Hygiene start once it's
 *  saved (iOS 4f5dfd2). Returns the save's result.
 *
 *  A created account whose owed backup can't be noted isn't saved at all: no address to note it
 *  under, or storage that doesn't keep it (full or blocked) - it would otherwise owe nothing, with
 *  no banner ever asking for the words nobody has seen. */
async function savingAccount(account, save) {
  const address = await wallet.previewMainAddress(account.mnemonic, account.passphrase, account.family, account.identityIndex || 0);
  if (!account.imported) {
    if (!address) throw new Error("Couldn't set up this account's backup reminder, so it wasn't created. Try again.");
    backupStatus.markPending(address);
    if (!backupStatus.isPending(address)) {
      throw new Error("This browser's storage for KaPay is full, so the account wasn't created: it couldn't remember that its 12 or 24 words still need backing up. Free up some space and try again.");
    }
  }
  let view;
  try {
    view = await save();
  } catch (error) {
    if (address && !account.imported) backupStatus.forget(address);
    throw error;
  }
  if (address && account.imported) backupStatus.markConfirmed(address);
  return view;
}

/**
 * The last step of create and import. The first account also chooses the wallet password;
 * after that, accounts go straight into the unlocked vault.
 */
async function finishAccount(account, onBack, buttonLabel) {
  if (await vault.hasVault()) {
    if (!(await vault.isUnlocked())) return showUnlock();
    try {
      const view = await savingAccount(account, () => vault.addAccount(account));
      await markUsed(view.activeAccountId);
      await setLoggedOut(false);
      importDraft = null;
      noteActivity();
      goHome();
      discoverAfterRestore(account, view.activeAccountId);
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  showSetPassword(account, onBack, buttonLabel);
}

// --- create account: one tap, or Advanced with a passphrase (KaPay iOS 99ab88a) -------------
//
// Create New Account makes the account at once: 24 words, no passphrase, the next free name (My
// Account, My Account 2 and on). "Advanced: Create with a Passphrase" (iOS CreateWalletView) is the
// only other way: also 24 words, straight to the passphrase entry. Creating never shows the words:
// the account is owed the backup steps (account-backup.js), and every tab says so until they're
// done. The first account also chooses the wallet password, the one step iOS doesn't have: a
// browser has no Face ID or iOS keychain, so the words are sealed with a password (vault.js).

/** The names saved accounts already have, for the next free default name. */
async function takenAccountNames() {
  if (!(await vault.hasVault()) || !(await vault.isUnlocked())) return [];
  return ((await vault.readAccounts().catch(() => null))?.accounts || []).map((a) => a.name);
}

function createAccount() {
  return runAccountAction(async () => {
    const button = $("#create");
    if (button) button.innerHTML = '<span class="spinner"></span><span>Create New Account</span>';
    try {
      const phrase = await wallet.newRecoveryPhrase(24);
      const name = nextDefaultAccountName(await takenAccountNames());
      await finishAccount({ mnemonic: phrase, passphrase: "", family: "kaspaStandard", name }, showWelcome, "Create Account");
    } catch (error) {
      // iOS "Couldn't Create Account"
      toast(error.message || "Couldn't create the account.");
    }
    if (button?.isConnected) button.innerHTML = `${ICONS.plusCircle}<span>Create New Account</span>`;
  });
}

/** Advanced: a new 24-word phrase, then the passphrase entry; Back there is the accounts screen. */
async function createWithPassphrase() {
  if (accountActionRunning) return;
  let phrase;
  try {
    phrase = await wallet.newRecoveryPhrase(24);
  } catch (error) {
    toast(error.message || "Couldn't create the account.");
    return;
  }
  const flow = { mode: "create", phrase, family: "kaspaStandard", onBack: showWelcome, onProceed: null };
  flow.onProceed = async (passphrase) => finishAccount(
    { mnemonic: phrase, passphrase, family: "kaspaStandard", name: nextDefaultAccountName(await takenAccountNames()) },
    () => showPassphraseEntry(flow),
    "Create Account",
  );
  showPassphraseEntry(flow);
}

/** A name for the wallet, local to this device (iOS AccountNameForm): Import Account's second step. */
function showAccountName({ title, draft, onBack, onNext }) {
  render(`
    ${navHeader()}
    <section class="screen">
      <h1 class="large-title">${esc(title)}</h1>
      <div class="field-group">
        <h2 class="step-title">Create a name for your wallet</h2>
        <p class="muted small">This name is only stored on this device, to tell your wallets apart. No one else will ever see it.</p>
      </div>
      <form id="name-form" class="field-group">
        <input id="name" value="${esc(draft.name)}" placeholder="Enter account name" maxlength="40" autocomplete="off" autofocus />
      </form>
      <button id="next" ${draft.name.trim() ? "" : "disabled"}>Next</button>
    </section>`, "import");
  $("#back").onclick = onBack;
  const name = $("#name");
  const next = () => { if (draft.name.trim()) onNext(); };
  name.oninput = () => { draft.name = name.value; $("#next").disabled = !draft.name.trim(); };
  $("#name-form").onsubmit = (event) => { event.preventDefault(); next(); };
  $("#next").onclick = next;
  name.focus();
}

// The chosen length's mark, white on the filled button (iOS checkmark.circle.fill).
const CHOSEN_MARK = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fff"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="var(--kaspa)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** A 12 / 24 words button (iOS SeedLengthButton): the chosen one filled, the other outlined. */
function lengthChoice(count, chosenCount) {
  const chosen = chosenCount === count;
  return `<button type="button" class="length-choice ${chosen ? "chosen" : ""}" role="radio" aria-checked="${chosen}" data-words="${count}">
    ${chosen ? CHOSEN_MARK : ICONS.circle}<span>${count} words</span>
  </button>`;
}

// --- passphrase: iOS PassphraseOptionView ------------------------------------------------

function showPassphraseQuestion(flow) {
  const title = flow.mode === "create"
    ? "Do you want to add a passphrase to your account?"
    : "Did you create these words with a passphrase?";
  render(`
    ${navHeader({ title: "Passphrase" })}
    <section class="screen question">
      <div class="question-body">
        <div class="question-icon">${ICONS.lockShield}</div>
        <h2 class="question-title">${esc(title)}</h2>
        ${flow.mode === "import" ? '<p class="muted center-text">If you are not sure, the answer is almost certainly no. A passphrase is something you would have typed in on purpose.</p>' : ""}
      </div>
      <div class="stack">
        <button id="yes" class="big">Yes</button>
        <button id="no" class="big soft">No</button>
        <button id="what" class="ghost">What is a passphrase?</button>
      </div>
    </section>`, "passphrase");
  $("#back").onclick = flow.onBack;
  $("#yes").onclick = () => showPassphraseEntry(flow);
  $("#no").onclick = () => flow.onProceed("");
  $("#what").onclick = () => showPassphraseExplainer(flow, () => showPassphraseQuestion(flow));
}

/**
 * The passphrase field, with the chatting address it produces and that address's balance updating
 * underneath (KaPay iOS 99ab88a PassphraseAddressPreview): the only direct evidence that a
 * passphrase opens a different account, and how someone importing tells they typed the right one.
 * On import it checks the first 50 chatting addresses, picks the first with funds and lists any
 * others to choose from (iOS 4f5dfd2); the import lands on the chosen one. Creating opens here
 * (Advanced: Create with a Passphrase), so its Back is the accounts screen.
 */
function showPassphraseEntry(flow) {
  const create = flow.mode === "create";
  render(`
    ${navHeader({ title: "Passphrase" })}
    <section class="screen passphrase-entry">
      <h2>${create ? "Choose your passphrase" : "Enter your passphrase"}</h2>
      <p class="muted">${create
        ? "Write it down somewhere safe. Without it this account cannot be recovered, even with your 12 or 24 words."
        : "It has to be exactly what you used before, including capital letters and spaces."}</p>
      <div class="secure-field">
        <input id="pp" type="password" placeholder="Passphrase" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
        <button class="icon" id="eye" type="button" aria-label="Show passphrase">${ICONS.eye}</button>
      </div>
      ${create ? '<input id="pp2" type="password" placeholder="Re-enter passphrase" autocomplete="off" autocapitalize="off" spellcheck="false" />' : ""}
      <div class="preview">
        <div class="muted small">Your chatting address</div>
        <div class="preview-address" id="preview">Checking...</div>
        <div class="preview-balance"><span class="muted small">Balance</span><span id="preview-balance"><span class="spinner small-spin"></span></span></div>
        <div class="small" id="preview-hint" hidden></div>
        <div id="preview-found"></div>
        <div class="muted small" id="preview-note">This is the account your 12 or 24 words open on their own.</div>
      </div>
      <p class="error" id="error"></p>
      <button id="continue" class="big" disabled>${create ? "Continue" : "Import"}</button>
      <button id="what" class="ghost">What is a passphrase?</button>
    </section>`, "passphrase");
  // iOS clears what was typed when you go back; reading the explainer keeps it.
  $("#back").onclick = () => { flow.typed = null; (create ? flow.onBack : () => showPassphraseQuestion(flow))(); };
  const pp = $("#pp");
  const pp2 = $("#pp2");
  if (flow.typed) { pp.value = flow.typed.pp; if (pp2) pp2.value = flow.typed.pp2; }
  $("#what").onclick = () => {
    flow.typed = { pp: pp.value, pp2: pp2?.value || "" };
    showPassphraseExplainer(flow, () => showPassphraseEntry(flow));
  };
  // The import's search for the address holding funds: Import waits for it, or it would import onto
  // #0 while the funds sit on another address. Held from the first keystroke, not only once the
  // lookup starts (KaPay iOS 0799cec).
  let searching = false;
  const paintContinue = () => {
    const button = $("#continue");
    if (!button) return;
    const waiting = !create && searching && Boolean(pp.value);
    button.disabled = !pp.value || waiting;
    button.innerHTML = waiting ? '<span class="spinner"></span><span>Finding your address...</span>' : (create ? "Continue" : "Import");
  };
  const setSearching = (on) => { searching = on; paintContinue(); };
  let revealed = false;
  $("#eye").onclick = () => {
    revealed = !revealed;
    for (const field of [pp, pp2]) if (field) field.type = revealed ? "text" : "password";
    $("#eye").innerHTML = revealed ? ICONS.eyeSlash : ICONS.eye;
    $("#eye").setAttribute("aria-label", revealed ? "Hide passphrase" : "Show passphrase");
  };
  const showBalance = (balanceSompi) => {
    const holds = balanceSompi > 0n;
    $("#preview-balance").innerHTML = `<span class="strong small ${holds ? "good-text" : ""}">${esc(wallet.formatKas(balanceSompi, 8))} KAS</span>`;
    if (create) return;
    const hint = $("#preview-hint");
    hint.hidden = false;
    hint.className = `small ${holds ? "good-text" : "warn-text"}`;
    hint.textContent = holds
      ? "This address holds funds, so this looks like the right account."
      : "No funds on this address. If you expected funds here, check your passphrase.";
  };
  const showFound = (found) => {
    const list = $("#preview-found");
    if (!found || found.length < 2) { list.innerHTML = ""; return; }
    list.innerHTML = `
      <p class="muted small found-lead">We picked the first address with funds. Tap another if that's not the one you chat from.</p>
      ${found.map((entry) => `
        <button type="button" class="found-row" data-found="${entry.index}">
          <span class="found-mark">${flow.chattingIndex === entry.index ? ICONS.circleCheck : ICONS.circle}</span>
          <span class="found-text"><span class="small strong">Address #${entry.index}</span><span class="mono tiny muted">${esc(`${entry.address.slice(0, 14)}...${entry.address.slice(-6)}`)}</span></span>
          <span class="small strong ${entry.balanceSompi > 0n ? "good-text" : "muted"}">${esc(wallet.formatKas(entry.balanceSompi, 8))} KAS</span>
        </button>`).join("")}`;
    for (const row of list.querySelectorAll("[data-found]")) {
      row.onclick = () => select(found, found.find((entry) => entry.index === Number(row.dataset.found)));
    }
  };
  const select = (found, entry) => {
    flow.chattingIndex = entry.index;
    $("#preview").textContent = entry.address;
    showBalance(entry.balanceSompi);
    showFound(found);
  };
  // Address #0 for the passphrase as typed, on a short debounce (the derivation is PBKDF2), then a
  // further pause, so only the passphrase someone stopped typing is looked up.
  let previewTimer = null;
  let previewSeq = 0;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    const typed = pp.value;
    flow.chattingIndex = 0;
    $("#preview-note").textContent = typed
      ? "A different passphrase gives a different address, and a different account."
      : "This is the account your 12 or 24 words open on their own.";
    $("#preview-balance").innerHTML = '<span class="spinner small-spin"></span>';
    $("#preview-hint").hidden = true;
    $("#preview-found").innerHTML = "";
    if (!create) setSearching(true);
    const seq = ++previewSeq;
    previewTimer = setTimeout(async () => {
      const address = await wallet.previewMainAddress(flow.phrase, typed, flow.family);
      if (seq !== previewSeq || !$("#preview")) return;
      $("#preview").textContent = address || "Checking...";
      const failed = () => { setSearching(false); $("#preview-balance").innerHTML = '<span class="muted small">Couldn\'t check</span>'; };
      if (!address) return failed();
      await new Promise((resolve) => setTimeout(resolve, 450));
      if (seq !== previewSeq) return;
      if (!create) {
        const found = await wallet.findChattingAddresses(flow.phrase, typed, flow.family);
        if (seq !== previewSeq || !$("#preview")) return;
        const first = found?.find((entry) => entry.balanceSompi > 0n) || found?.[0];
        if (!first) return failed();
        select(found, first);
        setSearching(false);
        return;
      }
      let balances = null;
      try { balances = await wallet.balancesFor([address]); } catch { balances = null; }
      if (seq !== previewSeq || !$("#preview")) return;
      if (balances) showBalance(balances[address] ?? 0n); else failed();
    }, 250);
  };
  pp.oninput = () => { schedulePreview(); paintContinue(); };
  schedulePreview();
  paintContinue();
  $("#continue").onclick = () => {
    if (!create && searching) return;
    const error = $("#error");
    error.textContent = "";
    if (!pp.value) { error.textContent = "Enter a passphrase, or go back and choose No."; return; }
    if (create && pp.value !== pp2.value) { error.textContent = "The passphrases do not match. Please re-enter them."; return; }
    flow.typed = null;
    // nothing changes the account once it is being made (KaPay iOS 0799cec)
    const fields = [pp, pp2, $("#eye"), $("#what"), $("#continue")].filter(Boolean);
    for (const field of fields) field.disabled = true;
    Promise.resolve(flow.onProceed(pp.value)).finally(() => {
      if (!pp.isConnected) return;
      for (const field of fields) field.disabled = false;
      paintContinue();
    });
  };
}

/** Back returns to the screen it was opened from: the question, or the entry screen, which links it
 *  too (KaPay iOS 0799cec). */
function showPassphraseExplainer(flow, onBack) {
  const sections = [
    ["The short version", "A passphrase is an extra word or sentence you add on top of your 12 or 24 words. It is optional, and most people do not use one."],
    ["It does not lock your account", "This is the part people get wrong. A passphrase does not put a password on your account. It opens a completely different account. Your 12 or 24 words with no passphrase open one account. The same words with the word \"apple\" opens another one. With \"banana\", another one again. Every passphrase is its own separate account, with its own address and its own balance."],
    ["Why anyone bothers", "If someone finds your written 12 or 24 words, they get the account those words open on their own. They do not get the one behind your passphrase, because they do not know there is one, and they could not guess it anyway."],
    ["The catch", "There is no reset and no recovery. If you forget your passphrase, the account it opened is gone for good. Your 12 or 24 words alone will not bring it back, and nobody can help you. Treat it exactly like the words themselves: written down, somewhere safe, before you rely on it."],
    ["One more thing to know", "If you type the wrong passphrase, nothing will tell you. You will simply land in a different account, and it will look empty. That is not a bug and your money is not lost - it just means you are in the wrong account."],
    ["So do you need one?", flow.mode === "create"
      ? "If you are not sure, you do not need one: go back to the start and tap Create New Account, which makes an account without a passphrase. It is still protected by your 12 or 24 words, and you can always create another account with a passphrase later."
      : "If you never set one up, choose No. A passphrase is something you would have typed in on purpose, so if this is the first you are hearing of it, you do not have one."],
  ];
  render(`
    ${navHeader({ title: "What is a passphrase?" })}
    <section class="screen explainer">
      ${sections.map(([title, body]) => `<div><h3>${esc(title)}</h3><p class="muted">${esc(body)}</p></div>`).join("")}
    </section>`, "passphrase");
  $("#back").onclick = onBack;
}

// --- import account: iOS ImportSourceWalletView -> ImportWalletView -> PassphraseOptionView ---

// Where the phrase came from decides the chatting address's derivation path. Same list, order,
// names and paths as iOS; KaChat (standard) is the default.
const SOURCE_ICONS = {
  bubbles: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h8A2.5 2.5 0 0 1 16 5.5v5a2.5 2.5 0 0 1-2.5 2.5H8l-3.5 3V13A2.5 2.5 0 0 1 3 10.5z" fill="currentColor"/><path d="M18 8h.5A2.5 2.5 0 0 1 21 10.5v5a2.5 2.5 0 0 1-1.5 2.3V21l-3.2-2.5H11A2.5 2.5 0 0 1 8.6 16" fill="currentColor" opacity=".75"/></svg>',
  puzzle: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3a2 2 0 0 1 2 2v1h4a1 1 0 0 1 1 1v4h1a2 2 0 1 1 0 4h-1v4a1 1 0 0 1-1 1h-4v-1a2 2 0 1 0-4 0v1H3v-6h1a2 2 0 1 0 0-4H3V7a1 1 0 0 1 1-1h3V5a2 2 0 0 1 2-2z" fill="currentColor"/></svg>',
  phone: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10.5 18.5h3" stroke-linecap="round"/></svg>',
  shield: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3z" fill="currentColor"/></svg>',
  desktop: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 16.5V21"/></svg>',
  terminal: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3.5" width="20" height="17" rx="3" fill="currentColor"/><path d="M6.5 9l3 3-3 3M11.5 15.5h5" fill="none" stroke="var(--bg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  grid: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="2" fill="currentColor"/><rect x="13" y="3" width="8" height="8" rx="2" fill="currentColor"/><rect x="3" y="13" width="8" height="8" rx="2" fill="currentColor"/><rect x="13" y="13" width="8" height="8" rx="2" fill="currentColor"/></svg>',
  key: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5" fill="currentColor"/><circle cx="7.5" cy="15.5" r="1.8" fill="var(--bg)"/><path d="M11 12L20.5 2.5M16 7l3 3M18.3 4.7l2.2 2.2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  drive: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 4h13l3 9v5a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-5z" fill="currentColor"/><path d="M2.5 13h19" stroke="var(--bg)" stroke-width="1.5"/><circle cx="17.5" cy="16.5" r="1.2" fill="var(--bg)"/></svg>',
};
const IMPORT_SOURCES = [
  { id: "kachat", name: "KaChat", icon: "bubbles", family: "kaspaStandard", isDefault: true },
  { id: "kasware", name: "KasWare Wallet", icon: "puzzle", family: "kaspaStandard" },
  { id: "kaspium", name: "Kaspium Wallet", icon: "phone", family: "kaspaStandard" },
  { id: "kastle", name: "Kastle Wallet", icon: "shield", family: "kaspaStandard" },
  { id: "kdx", name: "KDX Wallet", icon: "desktop", family: "kaspaLegacy972" },
  { id: "cli", name: "Core Golang Cli Wallet", icon: "terminal", family: "kaspaStandard" },
  { id: "okx", name: "OKX Wallet", icon: "grid", family: "kaspaStandard" },
  { id: "onekey", name: "OneKey Wallet", icon: "key", family: "oneKey" },
  { id: "ledger", name: "Ledger Wallet", icon: "drive", family: "kaspaStandard" },
];
const FAMILY_PATHS = {
  kaspaStandard: "m/44'/111111'/0'",
  kaspaLegacy972: "m/44'/972/0'",
  oneKey: "m/44'/111111'/0' (OneKey)",
};

let importDraft = null;

/** Lock, log out, delete or an account switch (popup.js): the words typed into Import go. */
export function clearImportDraft() {
  if (importDraft?.words) importDraft.words.fill("");
  importDraft = null;
}

function freshImportDraft() {
  // As with Create Account, nothing is preset: no name and no word count until one is chosen
  // (pasting a phrase picks the count for you).
  return { sourceId: "kachat", family: "kaspaStandard", name: "", wordCount: null, words: Array(24).fill(""), active: 0 };
}

function showImportSource() {
  if (!importDraft) importDraft = freshImportDraft();
  const d = importDraft;
  render(`
    ${navHeader({ title: "Import Account" })}
    <section class="screen import-source">
      <div class="source-head">
        <span class="source-head-icon">${ICONS.wallet}</span>
        <h2>Where are your 12 or 24 words from?</h2>
        <p class="muted">Different wallets store your Kaspa on different address paths. Pick where these words come from so KaPay finds your funds and domains.</p>
      </div>
      <div class="source-list" role="radiogroup" aria-label="Wallet">
        ${IMPORT_SOURCES.map((source) => `
          <button class="source-row" role="radio" data-source="${source.id}" aria-checked="${d.sourceId === source.id}">
            <span class="source-radio">${d.sourceId === source.id ? ICONS.circleCheck : ICONS.circle}</span>
            <span class="source-icon">${SOURCE_ICONS[source.icon]}</span>
            <span class="source-text">
              <span class="source-name">${esc(source.name)}${source.isDefault ? '<span class="source-default">Default</span>' : ""}</span>
              <span class="source-path">${esc(FAMILY_PATHS[source.family])}</span>
            </span>
          </button>`).join("")}
      </div>
      <button id="continue" class="with-icon">${ICONS.arrowRightCircle}<span>Continue</span></button>
    </section>`, "import");
  $("#back").onclick = () => { importDraft = null; showWelcome(); };
  for (const row of app.querySelectorAll("[data-source]")) {
    row.onclick = () => {
      const source = IMPORT_SOURCES.find((s) => s.id === row.dataset.source);
      d.sourceId = source.id;
      d.family = source.family;
      const scroll = app.querySelector(".source-list")?.scrollTop || 0;
      showImportSource();
      const list = app.querySelector(".source-list");
      if (list) list.scrollTop = scroll;
    };
  }
  $("#continue").onclick = showImportName;
}

/** Import Account, step 2 (iOS dd0aab1 ImportNameStep): the same name screen as Create Account. */
function showImportName() {
  showAccountName({ title: "Import Account", draft: importDraft, onBack: showImportSource, onNext: showImportLength });
}

/** Import Account, step 3 (iOS ImportLengthStep): how many words the phrase being imported has. */
function showImportLength() {
  const d = importDraft;
  render(`
    ${navHeader()}
    <section class="screen">
      <h1 class="large-title">Import Account</h1>
      <div class="field-group" role="radiogroup" aria-label="Choose 12 or 24 words">
        <h2 class="step-title">Choose 12 or 24 words</h2>
        <p class="muted small">How many words are you importing?</p>
        ${lengthChoice(12, d.wordCount)}
        ${lengthChoice(24, d.wordCount)}
      </div>
      <button id="next" ${d.wordCount ? "" : "disabled"}>Next</button>
    </section>`, "import");
  $("#back").onclick = showImportName;
  for (const option of app.querySelectorAll("[data-words]")) {
    option.onclick = () => { d.wordCount = Number(option.dataset.words); d.active = Math.min(d.active, d.wordCount - 1); showImportLength(); };
  }
  $("#next").onclick = () => { if (d.wordCount) showImportWords(); };
}

// The seed words go into a numbered grid, one word per slot, with the BIP39 suggestions bar -
// iOS SeedPhraseKeyboardView. A letter that no BIP39 word continues with is refused (the iOS
// keyboard greys those keys out), an exact unique word moves on by itself, and Space or Enter
// takes the top suggestion.
function importWordsValid(d) {
  if (!d.wordCount) return 0;
  return d.words.slice(0, d.wordCount).filter((w) => isBip39Word(w)).length;
}
function canImport(d) {
  return Boolean(d.wordCount) && importWordsValid(d) === d.wordCount && Boolean(d.name.trim());
}

/** iOS ImportWalletView.pasteFromClipboard, same rules and messages; a refusal never repeats what
 *  was pasted. */
function parsePastedPhrase(text) {
  const tokens = String(text || "").toLowerCase().split(/[\s,]+/)
    .map((t) => t.replace(/[.)]+$/, ""))
    .filter((t) => t && !/^\d+$/.test(t));
  if (!tokens.length) throw new Error("Nothing to paste.");
  if (tokens.length !== 12 && tokens.length !== 24) throw new Error(`You need 12 or 24 words - the clipboard holds ${tokens.length}.`);
  // never repeats what was pasted (KaPay iOS 0799cec)
  const unknown = tokens.filter((t) => !isBip39Word(t));
  if (unknown.length === 1) throw new Error("One of the pasted words isn't a valid word. Check your copy and try again.");
  if (unknown.length) throw new Error(`${unknown.length} of the pasted words aren't valid words. Check your copy and try again.`);
  return tokens;
}

function showImportWords() {
  const d = importDraft || (importDraft = freshImportDraft());
  const count = d.wordCount;
  const valid = importWordsValid(d);
  render(`
    ${navHeader({ title: "Import Account" })}
    <section class="screen import-words">
      <div class="words-head">
        <span>Enter your 12 or 24 words</span>
        <button class="mini-button" id="paste" type="button">${ICONS.clipboard}<span>Paste</span></button>
        <span class="words-count ${count && valid === count ? "good" : ""}" id="count">${count ? `${valid}/${count}` : ""}</span>
      </div>
      ${count ? `
        <div class="word-grid">
          ${Array.from({ length: count }, (_, i) => `
            <label class="word-slot ${d.words[i] && !isBip39Word(d.words[i]) ? "invalid" : ""}">
              <span class="n">${i + 1}</span>
              <input data-i="${i}" value="${esc(d.words[i])}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Word ${i + 1}" />
            </label>`).join("")}
        </div>
        <div class="suggest" id="suggest" aria-label="Suggestions"></div>`
        : '<p class="muted small">Choose 12 or 24 words, or paste them.</p>'}
      <p class="error" id="error"></p>
      <button id="continue" class="with-icon" ${canImport(d) ? "" : "disabled"}>${ICONS.arrowRightCircle}<span>Continue</span></button>
    </section>`, "import");
  $("#back").onclick = showImportLength;

  const refresh = () => {
    const n = importWordsValid(d);
    const counter = $("#count");
    if (counter && d.wordCount) {
      counter.textContent = `${n}/${d.wordCount}`;
      counter.classList.toggle("good", n === d.wordCount);
    }
    $("#continue").disabled = !canImport(d);
  };

  const applyPaste = (text) => {
    // The clipboard is cleared as soon as it's read, whether or not the words are accepted: secret
    // words don't belong there either way (KaPay iOS 0799cec).
    navigator.clipboard.writeText("").catch(() => {});
    try {
      const tokens = parsePastedPhrase(text);
      d.wordCount = tokens.length;
      d.words = [...tokens, ...Array(24 - tokens.length).fill("")];
      d.active = tokens.length - 1;
      showImportWords();
    } catch (error) {
      $("#error").textContent = error.message;
    }
  };
  $("#paste").onclick = async () => {
    $("#error").textContent = "";
    try {
      applyPaste(await navigator.clipboard.readText());
    } catch {
      $("#error").textContent = "Clipboard unavailable - click a word box and paste with ⌘V / Ctrl+V.";
    }
  };

  if (!count) return;
  const inputs = [...app.querySelectorAll(".word-slot input")];
  const suggest = $("#suggest");
  function focusSlot(i) {
    const input = app.querySelectorAll(".word-slot input")[i];
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
  const showSuggestions = (i) => {
    const prefix = d.words[i] || "";
    const matches = prefix && !isBip39Word(prefix) ? bip39Matches(prefix, 30) : prefix ? bip39Matches(prefix, 30).filter((w) => w !== prefix) : [];
    suggest.innerHTML = matches.map((w) => `<button type="button" class="chip-word" data-word="${esc(w)}"><b>${esc(prefix)}</b>${esc(w.slice(prefix.length))}</button>`).join("");
    for (const chip of suggest.querySelectorAll("[data-word]")) {
      chip.onmousedown = (event) => event.preventDefault(); // keep the slot focused
      chip.onclick = () => commit(i, chip.dataset.word);
    }
  };
  const commit = (i, word) => {
    d.words[i] = word;
    inputs[i].value = word;
    inputs[i].closest(".word-slot").classList.remove("invalid");
    refresh();
    if (i < d.wordCount - 1) focusSlot(i + 1);
    else showSuggestions(i);
  };
  inputs.forEach((input, i) => {
    input.onfocus = () => {
      d.active = i;
      for (const slot of app.querySelectorAll(".word-slot")) slot.classList.remove("active");
      input.closest(".word-slot").classList.add("active");
      input.closest(".word-slot").classList.remove("invalid");
      showSuggestions(i);
    };
    input.onblur = () => {
      input.closest(".word-slot").classList.remove("active");
      input.closest(".word-slot").classList.toggle("invalid", Boolean(d.words[i]) && !isBip39Word(d.words[i]));
    };
    input.onpaste = (event) => {
      const text = event.clipboardData?.getData("text") || "";
      if (/\s/.test(text.trim())) { event.preventDefault(); applyPaste(text); }
    };
    input.oninput = () => {
      const typed = input.value.toLowerCase().replace(/[^a-z]/g, "");
      // No BIP39 word continues this way: refuse the letter, as the iOS keyboard does.
      if (typed && !bip39Matches(typed, 1).length) {
        input.value = d.words[i];
        return;
      }
      input.value = typed;
      d.words[i] = typed;
      refresh();
      const matches = bip39Matches(typed, 2);
      if (matches.length === 1 && matches[0] === typed) return commit(i, typed);
      showSuggestions(i);
    };
    input.onkeydown = (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        const typed = d.words[i];
        if (isBip39Word(typed)) return commit(i, typed);
        const first = typed ? bip39Matches(typed, 1)[0] : null;
        if (first) commit(i, first);
        else if (event.key === "Enter" && canImport(d)) $("#continue").click();
      } else if (event.key === "Backspace" && !input.value && i > 0) {
        event.preventDefault();
        focusSlot(i - 1);
      }
    };
  });

  $("#continue").onclick = async () => {
    if (!canImport(d)) return;
    const button = $("#continue");
    button.disabled = true;
    $("#error").textContent = "";
    let phrase;
    try {
      phrase = await wallet.validateRecoveryPhrase(d.words.slice(0, d.wordCount).join(" "));
    } catch {
      $("#error").textContent = "These words are invalid. Double-check the words - the last word encodes a checksum, so one wrong word fails validation.";
      button.disabled = false;
      return;
    }
    const flow = { mode: "import", phrase, family: d.family, chattingIndex: 0, onBack: showImportWords, onProceed: null };
    flow.onProceed = (passphrase) => finishAccount(
      // the address the passphrase step found or was told (KaPay iOS 4f5dfd2); No is address #0
      { mnemonic: phrase, passphrase, family: d.family, name: d.name.trim(), imported: true, identityIndex: passphrase ? flow.chattingIndex : 0 },
      () => showPassphraseQuestion(flow),
      "Import Account",
    );
    showPassphraseQuestion(flow);
  };
  if (document.activeElement === document.body) focusSlot(Math.min(d.active, count - 1));
}

function showSetPassword(account, onBack, buttonLabel = "Create Account") {
  render(`
    ${navHeader({ title: "Wallet Password" })}
    <section class="screen">
      <h2>Set a wallet password</h2>
      <p class="muted">This password unlocks KaPay in this browser and keeps your 12 or 24 words encrypted on this computer. It can't recover your account - only your 12 or 24 words can.</p>
      <input id="pw" type="password" autocomplete="new-password" placeholder="Password (at least ${vault.MIN_PASSWORD_LENGTH} characters)" aria-label="Password" autofocus />
      <input id="pw2" type="password" autocomplete="new-password" placeholder="Re-enter password" aria-label="Re-enter password" />
      <p class="error" id="error"></p>
      <div class="spacer"></div>
      <button id="finish" class="big">${esc(buttonLabel)}</button>
    </section>`, "password");
  $("#back").onclick = onBack;
  $("#finish").onclick = async () => {
    const pw = $("#pw").value;
    const error = $("#error");
    error.textContent = "";
    if (pw.length < vault.MIN_PASSWORD_LENGTH) { error.textContent = `Use at least ${vault.MIN_PASSWORD_LENGTH} characters.`; return; }
    if (pw !== $("#pw2").value) { error.textContent = "The passwords don't match."; return; }
    const button = $("#finish");
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Encrypting…';
    try {
      const view = await savingAccount(account, () => vault.createVault(pw, account));
      await markUsed(view.activeAccountId);
      await setLoggedOut(false);
      importDraft = null;
      noteActivity();
      goHome();
      discoverAfterRestore(account, view.activeAccountId);
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      button.textContent = buttonLabel;
    }
  };
}

// --- unlock / reset ----------------------------------------------------------------------

export function showUnlock() {
  render(`
    <section class="onboard">
      ${wordmarkHtml("Enter your password to unlock")}
      <form id="form">
        <input id="pw" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" autofocus />
        <p class="error" id="error"></p>
        <div class="buttons"><button id="unlock" type="submit">Unlock</button></div>
        <button class="ghost" type="button" id="forgot">Forgot password?</button>
      </form>
    </section>`, "unlock");
  $("#form").onsubmit = async (event) => {
    event.preventDefault();
    const button = $("#unlock");
    button.disabled = true;
    button.innerHTML = '<span class="spinner"></span> Unlocking…';
    $("#error").textContent = "";
    try {
      await vault.unlock($("#pw").value);
      resetActivityPing();
      noteActivity();
      enterApp();
    } catch (error) {
      $("#error").textContent = error.message;
      button.disabled = false;
      button.textContent = "Unlock";
      $("#pw").select();
    }
  };
  $("#forgot").onclick = showReset;
}

function showReset() {
  render(`
    <header class="topbar"><button class="icon" id="back" aria-label="Back">${ICONS.back}</button><div class="title">Reset wallet</div></header>
    <section class="screen">
      <p>Without the password, the only way back in is your 12 or 24 words.</p>
      <p class="muted">Resetting removes KaPay's data from this browser. Your Kaspa stays on the network - import your 12 or 24 words afterwards to get it back. If you don't have them, resetting loses access for good.</p>
      <label class="field">Type RESET to confirm
        <input id="confirm" autocomplete="off" autocapitalize="characters" />
      </label>
      <div class="spacer"></div>
      <button class="danger" id="reset" disabled>Reset wallet</button>
    </section>`);
  $("#back").onclick = showUnlock;
  $("#confirm").oninput = (e) => { $("#reset").disabled = e.target.value.trim() !== "RESET"; };
  $("#reset").onclick = async () => {
    await vault.resetWallet();
    await setLoggedOut(false);
    await removeConnectionsFor(null);
    await wallet.disconnect();
    showWelcome();
  };
}

