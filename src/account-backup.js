// Backing up an account's 12 or 24 words and passphrase, in plain steps (KaPay iOS 99ab88a
// AccountBackupView): why, getting ready, the words six at a time, a check of four of them, the
// passphrase and its check if there is one, then where to keep them. And Backup Hygiene (iOS
// BackupHygieneView, 4f5dfd2), six months after a backup or an import: five random words in random
// order, then the passphrase.
//
// An account created here is owed the steps (iOS AccountBackupStatus): until they are finished,
// every tab shows the banner just above its title (orange, red once the account holds funds), and
// Settings > Back Up Account leads with Complete Your Backup. The rules and their storage are
// KaChat-Desktop's (shared/ui/account-backup-status.js); only addresses and times are kept there,
// never a word.
//
// The words come out of the vault behind the wallet password (the browser's stand-in for iOS's
// biometric gate), live in `flow` while a flow is open and nowhere else, and every step redraws
// the screen from nothing, so a word leaves the page with its step. Nothing here logs or stores a
// word. The steps never offer a copy: Settings > Back Up Account > View 12 or 24 Words does.
//
// iOS says "phone"; a browser can't know what it runs on, so these say "device", as KaChat-Desktop.

import * as vault from "./vault.js";
import { app, esc, render, $, ICONS, passwordGate } from "./ui.js";
import { reencodeAddress } from "./net.js";
import {
  createAccountBackupStatus, backupStepsFor, wordPageCount, wordPageRange, backupCheckPositions,
  randomWordPositions, wrongWordPositions, normalizedWord, passphraseMatches, HYGIENE_WORDS_TO_CHECK,
} from "../shared/ui/account-backup-status.js";
import { isBip39Word, bip39Matches } from "../shared/ui/bip39-english.js";
import "./account-backup.css";

// The pages' own storage: popup and full tab share it, and Reset Wallet clears it with the rest.
const storage = {
  getItem(key) { try { return localStorage.getItem(key); } catch { return null; } },
  setItem(key, value) { try { localStorage.setItem(key, value); } catch { /* owed again or not on the next write */ } },
};

/** Kept for an account's address on both networks, so a switch to testnet doesn't lose or bring
 *  back the banner. */
export const backupStatus = createAccountBackupStatus({
  storage,
  variants: (address) => [reencodeAddress(address, "kaspa"), reencodeAddress(address, "kaspatest")],
});

// The signed-in account's chatting address and whether it holds funds (spending addresses
// included, iOS AccountBackupBanner.hasFunds), as the Wallet tab last read them.
const context = { address: null, hasFunds: false };
export function setBackupContext(patch) { Object.assign(context, patch); }
export const backupPending = () => backupStatus.isPending(context.address);
export const hygieneDue = () => backupStatus.isHygieneDue(context.address);

const svg = (body, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
// Drawn after the SF Symbols iOS uses on the same lines.
const ICON = {
  key: svg('<circle cx="12" cy="7.25" r="4.5"/><circle cx="12" cy="5.6" r="1"/><path d="M12 11.75v9l1.9-1.6-1.9-1.6 1.9-1.6-1.9-1.6"/>'),
  noDevice: svg('<rect x="7" y="3" width="10" height="18" rx="2.2"/><path d="M4 4l16 16"/>'),
  noPerson: svg('<circle cx="10" cy="8" r="3.4"/><path d="M4 20c.7-3.6 3-5.4 6-5.4s5.3 1.8 6 5.4"/><path d="m16.5 6.5 4 4M20.5 6.5l-4 4"/>'),
  question: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.85.85c0 1.7-2.45 2.2-2.45 3.85"/><path d="M12 17v.5"/>', 18),
  paper: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 17h7"/>'),
  noCloud: svg('<path d="M7 18h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18Z"/><path d="M4 4l16 16"/>'),
  hand: svg('<path d="M7 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M10 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M13 10.5V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M16 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 0 1 3 0"/>'),
  split: svg('<rect x="3" y="5" width="7.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="7.5" height="14" rx="1.5"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'),
  // exclamationmark.shield.fill / checkmark.shield.fill
  shieldAlert: '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l8 3v6c0 5-3.4 9.1-8 10.5-4.6-1.4-8-5.5-8-10.5v-6z" fill="currentColor"/><path d="M12 7.5v6" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.25" fill="var(--bg)"/></svg>',
  shieldCheck: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l8 3v6c0 5-3.4 9.1-8 10.5-4.6-1.4-8-5.5-8-10.5v-6z" fill="currentColor"/><path d="m8.4 12.2 2.5 2.5 4.7-4.9" fill="none" stroke="var(--bg)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// --- the banner and the Backup Hygiene card -------------------------------------------------

/** iOS AccountBackupBanner: just above a tab's title while the backup is owed. */
export function backupBannerHtml() {
  if (!backupPending()) return "";
  const funds = context.hasFunds;
  return `
    <button class="backup-banner ${funds ? "funded" : ""}" id="backup-banner">
      <span class="backup-banner-icon">${ICON.shieldAlert}</span>
      <span class="backup-banner-text">
        <span class="backup-banner-title">Backup Your Account To Prevent Loss Of Funds</span>
        <span class="backup-banner-detail">${funds ? "You now have funds that aren't backed up." : "If you lose this device, your 12 or 24 words are the only way back."}</span>
      </span>
      ${ICONS.chevron}
    </button>`;
}

/** `onClose`: where the steps go back to, finished or not. */
export function bindBackupBanner(onClose) {
  const banner = app.querySelector("#backup-banner");
  if (banner) banner.onclick = () => openAccountBackup({ onClose });
}

/** iOS BackupHygieneCard: the Wallet tab, under Send, Receive and Request, once it's due. */
export function hygieneCardHtml() {
  if (!hygieneDue()) return "";
  return `
    <button class="hygiene-card" id="backup-hygiene">
      <span class="hygiene-card-icon">${ICON.shieldCheck}</span>
      <span class="hygiene-card-title">Backup Hygiene</span>
      ${ICONS.chevron}
    </button>`;
}

export function bindHygieneCard(onClose) {
  const card = app.querySelector("#backup-hygiene");
  if (card) card.onclick = () => openBackupHygiene({ onClose });
}

// --- the screens' frame -----------------------------------------------------------------------

/** The open flow, or null. It alone holds the words. */
let flow = null;

function close() {
  const closing = flow;
  flow = null;
  closing?.onClose?.();
}

/** The words behind the password, then `then(seed)`; null when the vault can't give them. */
function unlockSeed({ title, onBack, then }) {
  passwordGate({
    title,
    message: "Enter your wallet password to see your 12 or 24 words.",
    verify: (password) => vault.verifyPassword(password),
    onBack,
    onUnlocked: async (password) => {
      let seed = null;
      try {
        const view = await vault.readAccounts();
        const secrets = await vault.revealSecrets(view.activeAccountId, password);
        const words = String(secrets.mnemonic || "").split(" ").filter(Boolean);
        // the vault keeps every passphrase NFKD (audit EXT-010)
        if (words.length) seed = { words, passphrase: secrets.passphrase || "", passphraseForm: "nfkd" };
      } catch { seed = null; }
      then(seed);
    },
  });
}

/** One step: Back (when there is one), the title, Close; the body scrolls, the buttons stay at the
 *  bottom. iOS .interactiveDismissDisabled(): only Close leaves. */
function present(title, { back = null, body = "", foot = "", progress = null }) {
  render(`
    <header class="navbar backup-bar">
      ${back ? `<button class="nav-back" id="back" aria-label="Back">${ICONS.back}<span>Back</span></button>` : ""}
      <div class="nav-title">${esc(title)}</div>
      <button class="backup-close" id="backup-close">Close</button>
    </header>
    <section class="screen backup-screen">
      <div class="backup-scroll">
        ${progress ? `<div class="backup-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${progress.of}" aria-valuenow="${progress.at}"><span style="width:${(progress.at / progress.of) * 100}%"></span></div>` : ""}
        ${body}
      </div>
      <div class="backup-foot">${foot}</div>
    </section>`, "backup");
  $("#backup-close").onclick = close;
  if (back) $("#back").onclick = back;
}

const headingHtml = (title, detail) => `<h2 class="backup-heading">${esc(title)}</h2>${detail ? `<p class="backup-detail">${esc(detail)}</p>` : ""}`;

const pointHtml = (icon, title, detail) => `
  <div class="backup-point">
    <span class="backup-point-icon">${icon}</span>
    <span class="backup-point-copy"><span class="backup-point-title">${esc(title)}</span><span class="backup-detail">${esc(detail)}</span></span>
  </div>`;

const unavailableHtml = '<p class="backup-detail">This account\'s 12 or 24 words aren\'t available on this device.</p>';

// A word or passphrase field: no autofill, no autocorrect, spellcheck off so a browser's cloud
// spellchecker never sees it, and the password managers told to keep away.
const QUIET_FIELD = 'autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true"';

function passphraseFieldHtml() {
  return `
    <div class="secure-field">
      <input id="pp" type="password" placeholder="Passphrase" aria-label="Passphrase" ${QUIET_FIELD} />
      <button class="icon" id="eye" type="button" aria-label="Show passphrase">${ICONS.eye}</button>
    </div>`;
}

function bindPassphraseField(onInput) {
  const input = $("#pp");
  const eye = $("#eye");
  eye.onclick = () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.innerHTML = show ? ICONS.eyeSlash : ICONS.eye;
    eye.setAttribute("aria-label", show ? "Hide passphrase" : "Show passphrase");
  };
  input.oninput = () => onInput(input.value);
  input.focus();
  return input;
}

// --- the backup steps ---------------------------------------------------------------------------

/** The steps, behind the password. `onClose` runs when they close, finished or not. */
export function openAccountBackup({ onClose }) {
  flow = null;
  const address = context.address;
  unlockSeed({ title: "Back Up Account", onBack: onClose, then: (seed) => startBackup(seed, { onClose, address }) });
}

function startBackup(seed, { onClose, address }) {
  flow = {
    onClose,
    address,
    seed,
    step: "why",
    wordPage: 0,
    checklist: { pen: false, nobody: false, noPhotos: false },
    checkPositions: [],
    answers: {},
    wrong: [],
    passphraseAnswer: "",
    passphraseWrong: false,
  };
  if (!seed) { present("Back Up Account", { body: unavailableHtml }); return; }
  renderBackupStep();
}

const hasPassphrase = () => Boolean(flow?.seed?.passphrase);

function goTo(step) {
  flow.step = step;
  renderBackupStep();
}

function startWordCheck() {
  flow.checkPositions = backupCheckPositions(flow.seed.words.length);
  flow.answers = {};
  flow.wrong = [];
  goTo("wordCheck");
}

function backupGoBack() {
  switch (flow.step) {
    case "prepare": goTo("why"); break;
    case "explainer": goTo("why"); break;
    case "words":
      if (flow.wordPage > 0) { flow.wordPage -= 1; renderBackupStep(); } else goTo("prepare");
      break;
    case "wordCheck":
      flow.wordPage = wordPageCount(flow.seed.words.length) - 1;
      goTo("words");
      break;
    // Back to a check already passed keeps its words and answers: going back is for looking
    // again, not for being tested on new words (KaPay iOS 0799cec).
    case "passphrase": goTo("wordCheck"); break;
    case "passphraseCheck": goTo("passphrase"); break;
    case "tips":
      if (hasPassphrase()) { flow.passphraseAnswer = ""; goTo("passphraseCheck"); } else goTo("wordCheck");
      break;
    default: break;
  }
}

function renderBackupStep() {
  const steps = backupStepsFor(hasPassphrase());
  const frame = {
    back: flow.step === "why" ? null : backupGoBack,
    progress: flow.step === "explainer" ? null : { at: steps.indexOf(flow.step) + 1, of: steps.length },
  };
  ({ why: renderWhy, explainer: renderExplainer, prepare: renderPrepare, words: renderWords, wordCheck: renderWordCheck, passphrase: renderPassphrase, passphraseCheck: renderPassphraseCheck, tips: renderTips })[flow.step](frame);
}

function renderWhy(frame) {
  present("Back Up Account", {
    ...frame,
    body: `
      ${headingHtml("Protect your funds")}
      ${pointHtml(ICON.key, "Your 12 or 24 words are your account", "These secret words are created just for you. They are the master key to your funds.")}
      ${pointHtml(ICON.noDevice, "Your device can't be your only copy", "If you lose, break or replace this device, these words are the only way back to your account.")}
      ${pointHtml(ICON.noPerson, "Nobody can reset them", "There is no password reset. KaPay never sees your words, so we can't recover them for you.")}
      <button class="ghost with-icon backup-link" id="explain">${ICON.question}<span>What are my 12 or 24 words?</span></button>`,
    foot: '<button id="next" class="big">Start Backup</button>',
  });
  $("#explain").onclick = () => goTo("explainer");
  $("#next").onclick = () => goTo("prepare");
}

// iOS SeedPhraseExplainerPage: moved here from the Create Account steps, without "12 or 24 words?".
function renderExplainer(frame) {
  const section = (title, body) => `<div class="explainer-section"><h3>${esc(title)}</h3><p class="muted">${esc(body)}</p></div>`;
  present("What are my 12 or 24 words?", {
    ...frame,
    body: `
      <div class="backup-explainer">
        ${section("The short version", "Your 12 or 24 words are ordinary words that work as the master key to your account. Your wallet, its addresses and your .kachat names all come from them.")}
        ${section("Anyone with it can take everything", "Anyone who has these words can take everything in your account. If you lose them and lose this device, nobody can get your account back, not even KaPay.")}
        ${section("How to keep it safe", "Write the words on paper, in order, and keep them somewhere safe and private. Never type them into a website, send them in a chat, or keep them in a screenshot or cloud notes.")}
      </div>`,
  });
}

function renderPrepare(frame) {
  const items = [["pen", "I have a pen and paper"], ["nobody", "Nobody can see my screen"], ["noPhotos", "I won't take a photo or screenshot"]];
  const ready = () => Object.values(flow.checklist).every(Boolean);
  present("Back Up Account", {
    ...frame,
    body: `
      ${headingHtml("Get ready", "Your secret words are next. Before you see them:")}
      ${items.map(([key, title]) => `
        <button class="checkline" data-check="${key}" role="checkbox" aria-checked="${flow.checklist[key]}">
          ${flow.checklist[key] ? ICONS.checkSquare : ICONS.square}<span>${esc(title)}</span>
        </button>`).join("")}`,
    foot: `<button id="next" class="big" ${ready() ? "" : "disabled"}>Show My 12 or 24 Words</button>`,
  });
  for (const box of app.querySelectorAll("[data-check]")) {
    box.onclick = () => { flow.checklist[box.dataset.check] = !flow.checklist[box.dataset.check]; renderBackupStep(); };
  }
  $("#next").onclick = () => { if (ready()) { flow.wordPage = 0; goTo("words"); } };
}

function renderWords(frame) {
  const { words } = flow.seed;
  const [start, end] = wordPageRange(flow.wordPage, words.length);
  const last = flow.wordPage + 1 >= wordPageCount(words.length);
  const rows = [];
  for (let position = start; position < end; position += 1) {
    rows.push(`<div class="backup-word"><span class="backup-word-number">${position + 1}.</span><span class="backup-word-text">${esc(words[position])}</span></div>`);
  }
  present("Back Up Account", {
    ...frame,
    body: `
      ${headingHtml("Write down these words", "Write them on paper in this exact order, with their numbers.")}
      <p class="backup-range">Words ${start + 1} to ${end} of ${words.length}</p>
      <div class="backup-words">${rows.join("")}</div>`,
    foot: `<button id="next" class="big">${last ? "I Wrote Them Down" : "Next Words"}</button>`,
  });
  $("#next").onclick = () => {
    if (last) { startWordCheck(); return; }
    flow.wordPage += 1;
    renderBackupStep();
  };
}

function renderWordCheck(frame) {
  const positions = flow.checkPositions;
  const filled = () => positions.every((position) => normalizedWord(flow.answers[position]));
  present("Back Up Account", {
    ...frame,
    body: `
      ${headingHtml("Check your paper", "Tap each box and type that word from what you wrote down, to be sure your copy is right.")}
      ${positions.map((position) => `
        <label class="backup-field">
          <span>Word ${position + 1}</span>
          <input class="backup-word-box ${flow.wrong.includes(position) ? "is-wrong" : ""}" data-position="${position}" value="${esc(flow.answers[position] || "")}" placeholder="Type word ${position + 1} here" aria-label="Word ${position + 1}" ${QUIET_FIELD} />
        </label>`).join("")}
      ${flow.wrong.length ? `
        <p class="backup-error">That doesn't match. Check your paper, or go back to see the words again.</p>
        <button class="ghost backup-link" id="see-again">See My Words Again</button>` : ""}`,
    foot: `<button id="next" class="big" ${filled() ? "" : "disabled"}>Check My Words</button>`,
  });
  const button = $("#next");
  const inputs = [...app.querySelectorAll("[data-position]")];
  for (const input of inputs) {
    input.oninput = () => {
      flow.answers[Number(input.dataset.position)] = input.value;
      input.classList.remove("is-wrong");
      button.disabled = !filled();
    };
    input.onkeydown = (event) => { if (event.key === "Enter" && !button.disabled) button.click(); };
  }
  const seeAgain = $("#see-again");
  if (seeAgain) seeAgain.onclick = () => { flow.wordPage = 0; goTo("words"); };
  button.onclick = () => {
    if (!filled()) return;
    flow.wrong = wrongWordPositions(flow.seed.words, positions, flow.answers);
    if (flow.wrong.length) { renderBackupStep(); return; }
    goTo(hasPassphrase() ? "passphrase" : "tips");
  };
  (inputs.find((input) => input.classList.contains("is-wrong")) || inputs[0])?.focus();
}

function renderPassphrase(frame) {
  present("Back Up Account", {
    ...frame,
    body: `
      ${headingHtml("Write down your passphrase", "This account also needs its passphrase. Your 12 or 24 words alone won't bring it back. Write it exactly, including capital letters and spaces.")}
      <div class="backup-passphrase">${esc(flow.seed.passphrase)}</div>`,
    foot: '<button id="next" class="big">I Wrote It Down</button>',
  });
  $("#next").onclick = () => { flow.passphraseAnswer = ""; flow.passphraseWrong = false; goTo("passphraseCheck"); };
}

function renderPassphraseCheck(frame) {
  present("Back Up Account", {
    ...frame,
    body: `
      ${headingHtml("Check your passphrase", "Enter it from what you wrote down. It has to match exactly.")}
      ${passphraseFieldHtml()}
      <p class="backup-error" id="pp-error" hidden>That doesn't match. Check your paper, or go back to see it again.</p>`,
    foot: '<button id="next" class="big" disabled>Check My Passphrase</button>',
  });
  const button = $("#next");
  const input = bindPassphraseField((value) => {
    flow.passphraseAnswer = value;
    $("#pp-error").hidden = true;
    button.disabled = !value;
  });
  const check = () => {
    if (!passphraseMatches(flow.passphraseAnswer, flow.seed.passphrase, flow.seed.passphraseForm)) { $("#pp-error").hidden = false; return; }
    flow.passphraseAnswer = "";
    goTo("tips");
  };
  button.onclick = check;
  input.onkeydown = (event) => { if (event.key === "Enter" && !button.disabled) check(); };
}

function renderTips(frame) {
  present("Back Up Account", {
    ...frame,
    body: `
      ${headingHtml("Keep it safe", "Your copy is right. Now keep it that way.")}
      ${pointHtml(ICON.paper, "Keep it on paper", "Store it somewhere safe and private, away from fire and water.")}
      ${pointHtml(ICON.noCloud, "Never keep it online", "No photos, screenshots, cloud storage, notes apps, email or chats.")}
      ${pointHtml(ICON.hand, "Never share it", "Nobody needs your words. KaPay and real support will never ask for them. Anyone who asks is trying to take your funds.")}
      ${hasPassphrase() ? pointHtml(ICON.split, "Keep your passphrase apart", "Store it away from your 12 or 24 words. You need both, and losing either one loses the account.") : ""}
      ${pointHtml(ICON.gear, "You can see it again", "Your 12 or 24 words stay available in Settings > Back Up Account.")}`,
    foot: '<button id="next" class="big">Finish Backup</button>',
  });
  $("#next").onclick = () => { confirmBackup(); close(); };
}

/** Nothing is owed any more, and the six months start. */
function confirmBackup() {
  if (flow?.address) backupStatus.markConfirmed(flow.address);
}

// --- Backup Hygiene ---------------------------------------------------------------------------

/** Checks the written backup still works. Can't Complete This goes through the backup steps again.
 *  Either one starts the six months over; closing leaves the card up. */
export function openBackupHygiene({ onClose }) {
  flow = null;
  const address = context.address;
  unlockSeed({
    title: "Backup Hygiene",
    onBack: onClose,
    then: (seed) => {
      flow = { onClose, address, seed, asked: [], answers: [], active: 0, wrong: false, passphraseAnswer: "" };
      if (!seed) { present("Backup Hygiene", { body: unavailableHtml }); return; }
      flow.asked = randomWordPositions(seed.words.length, HYGIENE_WORDS_TO_CHECK);
      flow.answers = flow.asked.map(() => "");
      renderHygieneCheck();
    },
  });
}

function redoBackupFromHygiene() {
  const { seed, onClose, address } = flow;
  startBackup(seed, { onClose, address });
}

const CANT_COMPLETE = '<button class="ghost backup-cant" id="cant">Can\'t Complete This</button>';

// The words go into numbered boxes with the BIP39 suggestions bar, as Import's (iOS
// SeedPhraseKeyboardView): a letter no word continues with is refused, Space or Enter takes the top
// suggestion.
function renderHygieneCheck() {
  const { asked, answers } = flow;
  const allFilled = () => answers.every((word) => isBip39Word(word));
  present("Backup Hygiene", {
    body: `
      <p class="backup-lead">Let's ensure your account is backed up in case you lose access to your device.</p>
      <p class="backup-detail">Enter these ${asked.length} of your 12 or 24 words. Each box shows the word's number.</p>
      <div class="word-grid backup-hygiene-grid">
        ${asked.map((position, slot) => `
          <label class="word-slot">
            <span class="n">${position + 1}</span>
            <input data-slot="${slot}" value="${esc(answers[slot])}" aria-label="Word ${position + 1}" ${QUIET_FIELD} />
          </label>`).join("")}
      </div>
      <div class="suggest" id="suggest" aria-label="Suggestions"></div>
      <p class="backup-error" id="hygiene-error" ${flow.wrong ? "" : "hidden"}>Some of those words don't match. Check your paper and try again.</p>`,
    foot: `<button id="next" class="big" ${allFilled() ? "" : "disabled"}>Check My Words</button>${CANT_COMPLETE}`,
  });
  const button = $("#next");
  const inputs = [...app.querySelectorAll("[data-slot]")];
  const suggest = $("#suggest");
  const refresh = () => {
    inputs.forEach((input, slot) => {
      const cell = input.closest(".word-slot");
      cell.classList.toggle("active", slot === flow.active);
      cell.classList.toggle("invalid", Boolean(answers[slot]) && !isBip39Word(answers[slot]) && slot !== flow.active);
    });
    const current = normalizedWord(answers[flow.active]);
    const matches = current ? bip39Matches(current, 30).filter((w) => w !== current || !isBip39Word(current)) : [];
    suggest.innerHTML = matches.map((w) => `<button type="button" class="chip-word" data-word="${esc(w)}"><b>${esc(w.slice(0, current.length))}</b>${esc(w.slice(current.length))}</button>`).join("");
    button.disabled = !allFilled();
  };
  const commit = (word) => {
    answers[flow.active] = word;
    inputs[flow.active].value = word;
    flow.wrong = false;
    $("#hygiene-error").hidden = true;
    if (flow.active + 1 < inputs.length) flow.active += 1;
    inputs[flow.active].focus();
    refresh();
  };
  inputs.forEach((input, slot) => {
    input.onfocus = () => { flow.active = slot; refresh(); };
    input.oninput = () => {
      const typed = normalizedWord(input.value).replace(/[^a-z]/g, "");
      // no BIP39 word continues this way: the letter is refused, as on the iOS keyboard
      if (typed && !bip39Matches(typed, 1).length) { input.value = answers[slot]; return; }
      input.value = typed;
      answers[slot] = typed;
      flow.active = slot;
      flow.wrong = false;
      $("#hygiene-error").hidden = true;
      refresh();
    };
    input.onkeydown = (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        const current = normalizedWord(input.value);
        if (isBip39Word(current)) commit(current);
        else if (current && bip39Matches(current, 1).length) commit(bip39Matches(current, 1)[0]);
        else if (event.key === "Enter" && !button.disabled) button.click();
      }
    };
  });
  // a chip takes the click without taking the focus from the box
  suggest.onmousedown = (event) => {
    const chip = event.target.closest("[data-word]");
    if (!chip) return;
    event.preventDefault();
    commit(chip.dataset.word);
  };
  button.onclick = () => {
    if (!allFilled()) return;
    const correct = asked.every((position, slot) => flow.seed.words[position] === normalizedWord(answers[slot]));
    if (!correct) { flow.wrong = true; $("#hygiene-error").hidden = false; return; }
    flow.wrong = false;
    if (flow.seed.passphrase) renderHygienePassphrase(); else finishHygiene();
  };
  $("#cant").onclick = redoBackupFromHygiene;
  inputs[flow.active]?.focus();
  refresh();
}

function renderHygienePassphrase() {
  flow.passphraseAnswer = "";
  present("Backup Hygiene", {
    body: `
      <p class="backup-lead">Now enter your passphrase</p>
      <p class="backup-detail">Your 12 or 24 words alone won't bring this account back. Enter the passphrase from what you wrote down, exactly, including capital letters and spaces.</p>
      ${passphraseFieldHtml()}
      <p class="backup-error" id="pp-error" hidden>That doesn't match. Check your paper and try again.</p>`,
    foot: `<button id="next" class="big" disabled>Check My Passphrase</button>${CANT_COMPLETE}`,
  });
  const button = $("#next");
  const input = bindPassphraseField((value) => {
    flow.passphraseAnswer = value;
    $("#pp-error").hidden = true;
    button.disabled = !value;
  });
  const check = () => {
    if (!passphraseMatches(flow.passphraseAnswer, flow.seed.passphrase, flow.seed.passphraseForm)) { $("#pp-error").hidden = false; return; }
    finishHygiene();
  };
  button.onclick = check;
  input.onkeydown = (event) => { if (event.key === "Enter" && !button.disabled) check(); };
  $("#cant").onclick = redoBackupFromHygiene;
}

function finishHygiene() {
  confirmBackup();
  // past the check nothing here needs the words any more
  flow.seed = null;
  flow.asked = [];
  flow.answers = [];
  flow.passphraseAnswer = "";
  present("Backup Hygiene", {
    body: `
      <div class="backup-passed">
        <span class="backup-passed-icon">${ICON.shieldCheck}</span>
        <h2 class="backup-heading">Your backup is good</h2>
        <p class="backup-detail">We'll check again in 6 months.</p>
      </div>`,
    foot: '<button id="next" class="big">Done</button>',
  });
  $("#next").onclick = close;
}
