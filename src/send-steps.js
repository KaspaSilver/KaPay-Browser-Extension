// Step-by-step sends (KaPay iOS 05db583, 59593af; KaChat-Desktop ui/send-steps.js and
// send-kaspa-components.js createSwipeUpScreen): every screen that moves Kaspa asks one thing at a
// time - To, From, the amount on the app's own keypad - then the swipe-up Review, where only the
// fee (its Edit opens the fee editor) and coin control can change. The pieces iOS shares in
// SendKaspaComponents.swift (SendStepScreen / Header / Question / Chip, SendContinueButton,
// KaspaKeypad, KeypadAmountText, OwnAddressList, SendFeeEditorScreen, SwipeUpToSendScrollView)
// live here, so Send Kaspa, Request Payment, Cold Storage and .kachat look and behave the same.
// Change these rather than one screen. Styles: send-steps.css.
//
// API - each screen is a full render() of the popup, so a flow keeps its state in its own closure
// and draws the step it is on:
//
//   createStepFlow(order, show)          -> { go(id), current }
//       `order` lists the step ids in the order they slide; go(id) calls show(id, direction) with
//       "forward" / "back" (null for the first), which the screens below take as `direction`.
//   showStep({ screen, title, question, bodyHtml, className, onBack, onCancel, continueTitle,
//              canContinue, onContinue, direction })   -> { el, body, refresh() }
//       A step (iOS SendStepScreen): with `onBack` the header has Back and Cancel; without it (a
//       first step) only the title, and Cancel sits beside Continue at the bottom. `canContinue`
//       and `continueTitle` may be functions, read again on refresh().
//   stepQuestionHtml(text), stepNoteHtml(text), stepChipHtml({ label, value, isAddress }),
//   stepChipsHtml(chips), choicePillsHtml([{ id, title, on }])
//   keypadHtml(), bindKeypad(root, onKey)
//       The app's own keypad (1-9, the point, 0, delete; hold delete to clear). While it is on
//       screen and no text field has focus, the keyboard's digits, "." / "," and Backspace type
//       into it. onKey(key) returns false when the key changed nothing (the key shakes).
//   keypadAmountEntryHtml(opts), paintKeypadAmountEntry(root, opts)
//       The amount step (iOS KaspaKeypadAmountEntry): the big number (KeypadAmountText), the KAS /
//       currency switch (#unit-switch) and Max (#max), the footnote, then the keypad. opts:
//       { typed, unit, conversion, canSwitch, showsMax, maxEnabled, estimatingMax, footnote,
//       footnoteError }. Pure rules: keypad.js (applyKeypadKey, keypadKeyForKeyboard, ...).
//   reviewAmountHtml({ eyebrow, amountText, fiatText }), reviewRowHtml(label, valueHtml),
//   reviewAddressHtml({ name, address }), reviewCardHtml(rowsHtml[])
//   mountOwnAddressList(el, { selectedAddress, onPick, excludeQuantum }) -> { setSelected(a) }
//       Your addresses right on the screen (iOS OwnAddressList): the Chatting Address, then the
//       spending addresses (visible ones, plus hidden ones holding Kaspa) with balance, Used /
//       Unused and a check on the selected one. onPick({ kind: "chatting", address }) or
//       onPick({ kind: "spending", index, address, label }).
//   showFeeEditor({ screen, feeSompi, minimumSompi, onConfirm, onCancel, direction })
//       iOS SendFeeEditorScreen: the whole fee typed on the keypad. Says the network's minimum
//       and warns above ten times it; onConfirm(sompi) gets the typed fee, raised to the minimum
//       when it is lower. Cancel and Confirm both belong back on the review.
//   showSwipeUp({ screen, title, onBack, onCancel, barTitle, labels, bodyHtml, enabled,
//                 direction, getPreview, getFailureMessage, onAction, onDone })
//       The review (iOS SwipeUpToSendScrollView): the header, the scrolling `body`, and the bar.
//       Drag the bar up about a third of the screen and let go (KaPay 953b255; it was half): the
//       screen moves up into a full-screen BlockDAG while it sends, then Sent with the transaction
//       (Done) or Failed with the error (Try Again brings the review back as it was). A send the
//       network never confirmed (SEND_OUTCOME_UNKNOWN's message) is "Not confirmed" with only
//       Done, since Try Again could pay twice (KaPay 953b255). Enter / Space on the bar sends
//       too. Returns { body, setBody(html), setEnabled(on), setBusy(on), setSent({ txid,
//       amountSompi, recipient, explorerUrl }, outcomeHtml), setSucceeded(html), returnToForm(), sending }.
//       The screen calls setBusy(true) once its send started (else it fails after a moment),
//       then setSent(...) when it went out, or setBusy(false) alone for a failure shown with
//       getFailureMessage(). returnToForm() drops back to the review with nothing shown (the
//       password prompt was cancelled). getPreview() -> { amountSompi, recipient }.
//   SWIPE_UP_LABELS: send / buy / claim / consolidate wording.

import * as wallet from "./wallet.js";
import * as vault from "./vault.js";
import { app, esc, render, unitText } from "./ui.js";
import { KAS_UNIT } from "./net.js";
import { sompiFromUserText } from "./amounts.js";
import { trimmedKas } from "./send-pieces.js";
import { applyKeypadKey, usesCommaDecimal, keypadKeyForKeyboard, keypadFontSize, keypadDisplayText } from "./keypad.js";
import { swipeUpThreshold, swipeUpEnding } from "./swipe-up.js";
import "./send-steps.css";

export { applyKeypadKey, keypadKeyForKeyboard, keypadFontSize, keypadDisplayText, usesCommaDecimal };

const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 5.5H20a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H8.6L2.5 12z"/><path d="m11.5 9.5 5 5M16.5 9.5l-5 5"/></svg>',
  swap: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M21 16l-4 4-4-4"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5.5 12.5 4.2 4.2 8.8-9.2"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>',
  open: '<svg class="sk-sent-open" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>',
  fail: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5M12 17.2v.1"/></svg>',
  markDone: '<svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="34" class="sk-swipe-mark-fill"/><path d="m22 37 9.5 9.5L51 27" class="sk-swipe-mark-ink"/></svg>',
  markFailed: '<svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="34" class="sk-swipe-mark-fill"/><path d="M25 25l22 22M47 25 25 47" class="sk-swipe-mark-ink"/></svg>',
  // questionmark.circle.fill, orange (KaPay 953b255)
  markUnknown: '<svg viewBox="0 0 72 72" aria-hidden="true"><circle cx="36" cy="36" r="34" class="sk-swipe-mark-fill"/><path d="M27 28.5a9.2 9.2 0 1 1 13.7 8c-3 1.8-4.7 3.4-4.7 6.8M36 52.5v.1" class="sk-swipe-mark-ink"/></svg>',
};

const short = (address) => {
  const a = String(address || "");
  return a.length > 24 ? `${a.slice(0, 14)}...${a.slice(-6)}` : a;
};

// --- The flow --------------------------------------------------------------------------------

/** Which way a step slides in, from `order`: "forward", "back", or null (the first one). */
export function stepDirection(order, from, to) {
  if (from == null || from === to) return null;
  return order.indexOf(to) > order.indexOf(from) ? "forward" : "back";
}

/** Tracks the step on screen; go(id) draws it with the side it comes in from. */
export function createStepFlow(order, show) {
  let current = null;
  return {
    go(id) {
      const direction = stepDirection(order, current, id);
      current = id;
      show(id, direction);
    },
    get current() { return current; },
  };
}

// --- A step (SendStepScreen, SendStepHeader, SendContinueButton) -------------------------------

const valueOf = (v) => (typeof v === "function" ? v() : v);

export function showStep({
  screen = "send-step", title = "", question = "", bodyHtml = "", className = "", onBack = null, onCancel,
  continueTitle = "Continue", canContinue = true, onContinue, direction = null,
}) {
  const first = !onBack;
  render(`
    <section class="ss-screen ss-step ${first ? "ss-first" : ""} ${className}" ${direction ? `data-enter="${direction}"` : ""}>
      <header class="ss-head">
        ${first ? "" : `<button type="button" class="ss-back" id="ss-back" aria-label="Back">${ICON.back}</button>`}
        <h2 class="ss-title">${esc(title)}</h2>
        ${first ? "" : '<button type="button" class="ss-cancel" id="ss-cancel">Cancel</button>'}
      </header>
      <div class="ss-body" id="ss-body">${question ? stepQuestionHtml(question) : ""}${bodyHtml}</div>
      <div class="ss-bar">
        ${first ? '<button type="button" class="ss-bar-cancel" id="ss-bar-cancel">Cancel</button>' : ""}
        <button type="button" class="ss-continue" id="ss-continue">${esc(valueOf(continueTitle))}</button>
      </div>
    </section>`, screen);
  const el = app.querySelector(".ss-screen");
  const body = el.querySelector("#ss-body");
  const button = el.querySelector("#ss-continue");
  el.querySelector("#ss-back")?.addEventListener("click", () => onBack?.());
  el.querySelector("#ss-cancel")?.addEventListener("click", () => onCancel?.());
  el.querySelector("#ss-bar-cancel")?.addEventListener("click", () => onCancel?.());
  button.addEventListener("click", () => { if (!button.disabled) onContinue?.(); });
  const refresh = () => {
    button.disabled = !valueOf(canContinue);
    button.textContent = unitText(String(valueOf(continueTitle) ?? ""));
  };
  refresh();
  return { el, body, refresh };
}

/** The question a step asks, big, at the top (iOS SendStepQuestion). */
export function stepQuestionHtml(text, { center = false } = {}) {
  return `<h3 class="ss-question${center ? " ss-center" : ""}">${esc(text)}</h3>`;
}

/** A footnote line under a question or a choice. */
export function stepNoteHtml(text) {
  return `<p class="ss-note">${esc(text)}</p>`;
}

/** "To alice.kachat", "From Chatting Address" (iOS SendStepChip); an address is cut in the middle. */
export function stepChipHtml({ label, value, isAddress = false }) {
  const shown = isAddress ? short(value) : String(value || "");
  return `<span class="ss-chip" title="${esc(value || "")}"><span class="ss-chip-label">${esc(label)}</span><span class="ss-chip-value${isAddress ? " mono" : ""}">${esc(shown)}</span></span>`;
}

export function stepChipsHtml(chips) {
  return `<div class="ss-chips">${chips.map(stepChipHtml).join("")}</div>`;
}

/** Two (or more) pills, one picked (iOS SelectablePill): "Chatting Address" / "Choose an Address". */
export function choicePillsHtml(pills) {
  return `<div class="sel-pills">${pills.map((p) => `<button type="button" class="sel-pill ${p.on ? "on" : ""}" id="${esc(p.id)}" aria-pressed="${Boolean(p.on)}">${esc(p.title)}</button>`).join("")}</div>`;
}

// --- Keypad (KaspaKeypad, KeypadAmountText) -----------------------------------------------------

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "decimal", "0", "delete"];

export function keypadHtml() {
  const point = usesCommaDecimal() ? "," : ".";
  const label = (key) => (key === "decimal" ? "Decimal point" : key === "delete" ? "Delete" : key);
  const face = (key) => (key === "decimal" ? point : key === "delete" ? ICON.delete : key);
  return `<div class="ss-keypad" role="group" aria-label="Keypad">${KEYS.map((key) =>
    `<button type="button" class="ss-key" data-key="${key}" aria-label="${esc(label(key))}">${face(key)}</button>`).join("")}</div>`;
}

/** Overlays that own the keyboard while they are up (a sheet, an alert, the password). */
const OVERLAYS = ".alert-backdrop, .sheet-backdrop, .panel-backdrop";

/**
 * Wires the keypad inside `root`: a press calls onKey(key) (hold delete to clear, as iOS), and the
 * keyboard types into it while it is on screen and no field or overlay has the keyboard. The
 * keyboard listener goes once the keypad has left the page. Returns an unbind function.
 */
export function bindKeypad(root, onKey) {
  const keypad = root?.querySelector(".ss-keypad");
  if (!keypad) return () => {};
  let holdTimer = null;
  let held = false;
  const press = (key, button) => {
    if (onKey(key) === false && button) {
      button.classList.remove("ss-key-refused");
      void button.offsetWidth;
      button.classList.add("ss-key-refused");
    }
  };
  keypad.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-key='delete']");
    if (!button) return;
    held = false;
    holdTimer = setTimeout(() => { holdTimer = null; held = true; press("clear", button); }, 500);
  });
  const stopHold = () => { if (holdTimer) clearTimeout(holdTimer); holdTimer = null; };
  keypad.addEventListener("pointerup", stopHold);
  keypad.addEventListener("pointercancel", stopHold);
  keypad.addEventListener("pointerleave", stopHold);
  keypad.addEventListener("click", (event) => {
    const button = event.target.closest("[data-key]");
    if (!button) return;
    const key = button.dataset.key;
    if (key === "delete" && held) { held = false; return; }
    press(key, button);
  });
  const onKeydown = (event) => {
    if (!keypad.isConnected) { unbind(); return; }
    if (!keypad.offsetParent || keypad.closest("[hidden]")) return;
    if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    if (document.querySelector(OVERLAYS)) return;
    const key = keypadKeyForKeyboard(event);
    if (!key) return;
    event.preventDefault();
    press(key, keypad.querySelector(`[data-key="${key === "clear" ? "delete" : key}"]`));
  };
  const unbind = () => document.removeEventListener("keydown", onKeydown);
  document.addEventListener("keydown", onKeydown);
  return unbind;
}

/** The big number a keypad types into (iOS KeypadAmountText): grouped, "0" while empty, its unit. */
export function keypadAmountHtml({ typed = "", unit = KAS_UNIT } = {}) {
  const display = keypadDisplayText(typed);
  const size = keypadFontSize(display);
  return `<div class="ss-amount${typed ? "" : " empty"}" role="status" aria-live="polite">
    <span class="ss-amount-number" style="font-size:${size}px">${esc(display)}</span>
    <span class="ss-amount-unit" style="font-size:${Math.round(size * 0.5)}px">${esc(unitText(unit))}</span>
  </div>`;
}

/** Repaints a mounted keypad amount (inside `root`). */
export function paintKeypadAmount(root, typed, unit = null) {
  const el = root?.querySelector(".ss-amount");
  if (!el) return;
  const display = keypadDisplayText(typed);
  const size = keypadFontSize(display);
  el.classList.toggle("empty", !typed);
  const number = el.querySelector(".ss-amount-number");
  const unitEl = el.querySelector(".ss-amount-unit");
  number.textContent = display;
  number.style.fontSize = `${size}px`;
  if (unit != null) unitEl.textContent = unitText(unit);
  unitEl.style.fontSize = `${Math.round(size * 0.5)}px`;
}

/**
 * An amount step's middle and bottom (iOS KaspaKeypadAmountEntry): the typed amount, the switch
 * (showing the other unit's value) and Max under it, the footnote (Available, or what's wrong),
 * then the keypad.
 */
export function keypadAmountEntryHtml(opts = {}) {
  return `
    <div class="ss-keypad-stage">
      ${keypadAmountHtml({ typed: opts.typed, unit: opts.unit })}
      <div class="sk-amount-actions ss-amount-actions">${amountActionsHtml(opts)}</div>
      <p class="ss-footnote ${opts.footnoteError ? "error" : ""}" id="ss-footnote">${esc(unitText(opts.footnote || "")) || "&nbsp;"}</p>
    </div>
    ${keypadHtml()}`;
}

function amountActionsHtml({ conversion = null, canSwitch = false, switchText = "", showsMax = true, maxEnabled = true, estimatingMax = false }) {
  return `
    ${canSwitch ? `<button type="button" class="sk-chip" id="unit-switch" aria-label="Switch between Kaspa and your currency">${ICON.swap}<span>${esc(unitText(conversion || switchText))}</span></button>` : ""}
    ${showsMax ? `<button type="button" class="sk-chip accent strong" id="max" ${maxEnabled && !estimatingMax ? "" : "disabled"}>${estimatingMax ? '<span class="spinner small-spin"></span>' : "Max"}</button>` : ""}`;
}

/** Repaints the amount entry in place (no re-render, so the keypad keeps its press). Returns the
 *  switch / Max buttons, which are drawn anew: bind them again. */
export function paintKeypadAmountEntry(root, opts = {}) {
  paintKeypadAmount(root, opts.typed, opts.unit);
  const actions = root.querySelector(".ss-amount-actions");
  if (actions) actions.innerHTML = amountActionsHtml(opts);
  const note = root.querySelector("#ss-footnote");
  if (note) {
    note.textContent = unitText(opts.footnote || "") || " ";
    note.classList.toggle("error", Boolean(opts.footnoteError));
  }
  return { unitSwitch: root.querySelector("#unit-switch"), max: root.querySelector("#max") };
}

// --- Review pieces ------------------------------------------------------------------------------

/** "You're sending" over the big amount and its value in your currency. */
export function reviewAmountHtml({ eyebrow = "You're sending", amountText = null, fiatText = "" } = {}) {
  return `
    <div class="ss-review-amount">
      <span class="ss-review-eyebrow">${esc(eyebrow)}</span>
      ${amountText == null ? '<span class="spinner"></span>' : `<strong class="ss-review-big">${esc(amountText)}</strong>`}
      ${fiatText ? `<span class="ss-review-fiat">${esc(fiatText)}</span>` : ""}
    </div>`;
}

/** One review line (iOS reviewRow): the label on the left, the value (trusted markup) on the right. */
export function reviewRowHtml(label, valueHtml) {
  return `<div class="ss-review-row"><span class="ss-review-label">${esc(label)}</span><span class="ss-review-value">${valueHtml}</span></div>`;
}

/** A review's address value: the name over the address, or the address alone. */
export function reviewAddressHtml({ name = null, address = "" } = {}) {
  return `${name ? `<strong>${esc(name)}</strong>` : ""}<span class="ss-review-address mono" title="${esc(address)}">${esc(short(address))}</span>`;
}

export function reviewCardHtml(rows) {
  return `<div class="sk-card ss-review-card">${rows.join("")}</div>`;
}

// --- Your addresses on the screen (OwnAddressList) ----------------------------------------------

function usedTagHtml(used) {
  if (used === true) return '<span class="ss-used used">Used</span>';
  if (used === false) return '<span class="ss-used unused">Unused</span>';
  return '<span class="ss-used checking">Checking</span>';
}

export function mountOwnAddressList(list, { selectedAddress = null, onPick, excludeQuantum = false } = {}) {
  if (!list) return { setSelected() {} };
  let rows = [];
  let selected = selectedAddress;
  const used = new Map();
  // A list mounted again (the step drawn once more) drops the answers of the one before.
  const generation = (Number(list.dataset.generation) || 0) + 1;
  list.dataset.generation = String(generation);
  const alive = () => list.isConnected && list.dataset.generation === String(generation);
  list.classList.add("ss-address-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Your addresses");
  list.innerHTML = '<div class="ss-list-loading"><span class="spinner"></span></div>';
  list.onclick = (event) => {
    const row = event.target.closest("[data-source-key]");
    const picked = row && rows.find((r) => r.key === row.dataset.sourceKey);
    if (picked) onPick?.(picked.source);
  };

  const rowHtml = (r) => {
    const current = selected != null && r.address === selected;
    const funded = BigInt(r.balanceSompi || 0n) > 0n;
    // a balance that couldn't be read is a dash, never 0 KAS (KaPay 953b255)
    const balance = r.balanceSompi == null ? "—" : unitText(`${trimmedKas(r.balanceSompi)} ${KAS_UNIT}`);
    return `
      <button type="button" class="ss-source-row${current ? " current" : ""}" role="option" aria-selected="${current}" data-source-key="${esc(r.key)}" data-source-address="${esc(r.address)}">
        <span class="ss-source-copy">
          <span class="ss-source-name"><span class="ellipsis">${esc(r.title)}</span><span data-used="${esc(r.key)}">${usedTagHtml(used.get(r.address))}</span></span>
          <span class="mono tiny muted">${esc(short(r.address))}</span>
        </span>
        <span class="ss-source-balance${funded ? "" : " muted"}">${esc(balance)}</span>
        <span class="ss-source-check" aria-hidden="true">${current ? ICON.check : ""}</span>
      </button>`;
  };

  (async () => {
    const view = await vault.readAccounts();
    const main = (await wallet.cachedAddresses(view.activeAccountId))?.main || null;
    const spendingList = await wallet.spendingList();
    // A failed read says nothing about the balance: left unknown, not shown as 0 (KaPay 953b255).
    const mainRead = main ? await wallet.balancesFor([main]).catch(() => null) : null;
    const mainBalance = mainRead?.[main] != null ? BigInt(mainRead[main]) : null;
    if (!alive()) return;
    const chatting = main ? [{ key: "chatting", title: "Chatting Address", address: main, balanceSompi: mainBalance, source: { kind: "chatting", address: main } }] : [];
    const spending = spendingList.rows
      .filter((r) => !r.hidden || r.balanceSompi > 0n)
      .filter((r) => !excludeQuantum || !r.quantum)
      .sort((a, b) => a.index - b.index)
      .map((r) => ({
        key: `spending-${r.index}`, title: r.label, address: r.address, balanceSompi: r.balanceSompi,
        source: { kind: "spending", index: r.index, address: r.address, label: r.label },
      }));
    rows = [...chatting, ...spending];
    // Used: a balance means used, else what is already known; the rest are looked up below.
    const toProbe = [];
    for (const r of rows) {
      if (BigInt(r.balanceSompi || 0n) > 0n) { used.set(r.address, true); continue; }
      const known = await wallet.knownUsedState(r.address).catch(() => null);
      if (known === true || known === false) used.set(r.address, known);
      else toProbe.push(r);
    }
    if (!alive()) return;
    list.innerHTML = `
      ${chatting.length ? `<p class="ss-list-section">Chatting Address</p>${chatting.map(rowHtml).join("")}` : ""}
      <p class="ss-list-section">Spending Addresses</p>
      ${spending.length ? spending.map(rowHtml).join("") : '<p class="muted small">No spending addresses yet.</p>'}`;
    // Eight at a time, like iOS (a burst gets rate-limited).
    let next = 0;
    const worker = async () => {
      while (next < toProbe.length && alive()) {
        const r = toProbe[next++];
        const answer = await wallet.addressUsed(r.address).catch(() => null);
        if (!alive()) return;
        if (answer === true || answer === false) {
          used.set(r.address, answer);
          const slot = list.querySelector(`[data-used="${CSS.escape(r.key)}"]`);
          if (slot) slot.innerHTML = usedTagHtml(answer);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, toProbe.length) }, worker));
  })().catch((error) => {
    if (alive()) list.innerHTML = `<p class="error-text small">${esc(error?.message || "Couldn't load your addresses.")}</p>`;
  });

  return {
    setSelected(address) {
      selected = address ?? null;
      for (const row of list.querySelectorAll("[data-source-key]")) {
        const on = selected != null && row.dataset.sourceAddress === selected;
        row.classList.toggle("current", on);
        row.setAttribute("aria-selected", String(on));
        row.querySelector(".ss-source-check").innerHTML = on ? ICON.check : "";
      }
    },
  };
}

// --- The fee editor (SendFeeEditorScreen) ---------------------------------------------------------

export function showFeeEditor({ screen = "send-fee", feeSompi = null, minimumSompi = null, onConfirm, onCancel, direction = "forward" }) {
  const minimum = minimumSompi != null ? BigInt(minimumSompi) : null;
  const reference = feeSompi != null ? BigInt(feeSompi) : null;
  let draft = reference != null ? trimmedKas(reference) : "";
  const draftSompi = () => {
    const sompi = sompiFromUserText(draft);
    return sompi != null && sompi > 0n ? sompi : null;
  };
  const step = showStep({
    screen,
    title: "Network Fee",
    className: "ss-keypad-step ss-fee-step",
    bodyHtml: `
      ${stepQuestionHtml("Set your network fee", { center: true })}
      <div class="ss-keypad-stage">
        ${keypadAmountHtml({ typed: draft })}
        <p class="ss-footnote" id="ss-footnote">&nbsp;</p>
      </div>
      ${keypadHtml()}`,
    onCancel,
    continueTitle: "Confirm",
    canContinue: () => draftSompi() != null,
    onContinue: () => {
      const typed = draftSompi();
      if (typed == null) return;
      // never under the network's minimum
      onConfirm?.(minimum != null && typed < minimum ? minimum : typed);
    },
    direction,
  });
  const note = step.body.querySelector("#ss-footnote");
  const paint = () => {
    paintKeypadAmount(step.body, draft);
    const typed = draftSompi();
    const base = minimum ?? reference;
    const high = typed != null && base != null && base > 0n && typed > base * 10n;
    const minimumText = minimum != null ? `The network needs at least ${trimmedKas(minimum)} ${KAS_UNIT}. A lower fee is raised to that.` : "";
    note.textContent = unitText((high ? ["This is much more than the network needs.", minimumText].filter(Boolean).join(" ") : minimumText) || " ");
    note.classList.toggle("warn", high);
    step.refresh();
  };
  bindKeypad(step.body, (key) => {
    const next = applyKeypadKey(key, draft);
    if (next === draft) return false;
    draft = next;
    paint();
    return true;
  });
  paint();
  return step;
}

// --- Swipe up to send (SwipeUpToSendScrollView, KaPay 59593af) ------------------------------------

/** The words a swipe-up screen uses (iOS SwipeUpLabels). No hint under the title any more: it
 *  already says Keep Swiping or Release (KaPay 953b255). */
export const SWIPE_UP_LABELS = {
  send: {
    release: "Release to Send", working: "Sending", workingDetail: "Broadcasting to the Kaspa BlockDAG...",
    done: "Sent", recipientWord: "to", failedFallback: "The send didn't go out.",
  },
  consolidate: {
    release: "Release to Consolidate", working: "Consolidating", workingDetail: "Broadcasting to the Kaspa BlockDAG...",
    done: "Sent", recipientWord: "to", failedFallback: "The send didn't go out.",
  },
  buy: {
    release: "Release to Buy", working: "Buying", workingDetail: "Sending the purchase to the Kaspa BlockDAG...",
    done: "Name Bought", recipientWord: "for", failedFallback: "The purchase didn't go out.",
  },
  claim: {
    release: "Release to Claim", working: "Claiming", workingDetail: "Committing to the Kaspa BlockDAG...",
    done: "Claim Started", recipientWord: "for", failedFallback: "The claim didn't start.",
  },
};
/** iOS settle: spring(response 0.45, damping 0.86). */
const SETTLE_MS = 450;

function middleTruncatedHtml(text, tail = 10) {
  const value = String(text || "");
  if (value.length <= tail * 2) return `<span class="sk-mid-tail">${esc(value)}</span>`;
  return `<span class="sk-mid-head">${esc(value.slice(0, -tail))}</span><span class="sk-mid-tail">${esc(value.slice(-tail))}</span>`;
}

export function showSwipeUp({
  screen = "send-review", title = "Review", onBack = null, onCancel, barTitle = "Swipe up to Send",
  labels = SWIPE_UP_LABELS.send, bodyHtml = "", enabled = false, direction = null,
  getPreview, getFailureMessage, onAction, onDone,
}) {
  render(`
    <section class="ss-screen sk-swipe-host" ${direction ? `data-enter="${direction}"` : ""}>
      <div class="sk-swipe-form">
        <header class="ss-head ${onBack ? "" : "ss-cancel-left"}">
          ${onBack ? `<button type="button" class="ss-back" id="ss-back" aria-label="Back">${ICON.back}</button>` : ""}
          <h2 class="ss-title">${esc(title)}</h2>
          <button type="button" class="ss-cancel" id="ss-cancel">Cancel</button>
        </header>
        <div class="sk-swipe-scroll" id="sk-swipe-scroll">${bodyHtml}</div>
        <div class="sk-swipe-barwrap">
          <button type="button" class="sk-swipe-bar" id="sk-swipe-bar">
            <span class="sk-swipe-bar-icon"></span>
            <span class="sk-swipe-bar-text"></span>
          </button>
        </div>
      </div>
      <div class="sk-swipe-progress" hidden>
        <div class="sk-swipe-dag"><canvas></canvas><span class="sk-swipe-mark"></span></div>
        <div class="sk-swipe-lines">
          <h3 class="sk-swipe-big"></h3>
          <p class="sk-swipe-amount" hidden></p>
          <p class="sk-swipe-to" hidden></p>
          <p class="sk-swipe-detail" hidden></p>
        </div>
        <div class="sk-swipe-failure" hidden>${ICON.fail}<span class="sk-swipe-failure-text"></span></div>
        <div class="sk-swipe-tx" hidden></div>
        <div class="sk-swipe-outcome" hidden></div>
        <div class="sk-swipe-spacer"></div>
        <button type="button" class="sk-swipe-final" hidden></button>
      </div>
    </section>`, screen);

  const host = app.querySelector(".sk-swipe-host");
  const form = host.querySelector(".sk-swipe-form");
  const scroll = host.querySelector("#sk-swipe-scroll");
  const progress = host.querySelector(".sk-swipe-progress");
  const bar = host.querySelector("#sk-swipe-bar");
  const barIcon = bar.querySelector(".sk-swipe-bar-icon");
  const barText = bar.querySelector(".sk-swipe-bar-text");
  const q = (sel) => progress.querySelector(sel);
  const els = {
    mark: q(".sk-swipe-mark"), big: q(".sk-swipe-big"), amount: q(".sk-swipe-amount"), to: q(".sk-swipe-to"),
    detail: q(".sk-swipe-detail"), failure: q(".sk-swipe-failure"), failureText: q(".sk-swipe-failure-text"),
    tx: q(".sk-swipe-tx"), outcome: q(".sk-swipe-outcome"), final: q(".sk-swipe-final"),
  };
  host.querySelector("#ss-back")?.addEventListener("click", () => { if (phase === "form") onBack?.(); });
  host.querySelector("#ss-cancel").addEventListener("click", () => { if (phase === "form") onCancel?.(); });

  let on = Boolean(enabled);
  let busy = false;
  // iOS state: how far the screen is pushed up, past the threshold (armed), form / sending, the DAG's
  // moment on screen, whether the send really started, and how it ended.
  let lift = 0;
  let armed = false;
  let phase = "form";
  let dagShown = false;
  let sendStarted = false;
  let confirmed = false;
  let failed = false;
  let sent = null;
  let succeeded = false;
  let outcomeHtml = "";
  let preview = {};
  let dragging = false;
  let pointerId = null;
  let startY = 0;
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); if (host.isConnected) fn(); }, ms); timers.add(t); };
  const clearTimers = () => { for (const t of timers) clearTimeout(t); timers.clear(); };
  const active = () => on && !busy;
  const height = () => host.clientHeight || 580;
  const threshold = () => swipeUpThreshold(height());
  const failureText = () => (failed && dagShown ? (String(getFailureMessage?.() || "").trim() || labels.failedFallback) : null);
  const dag = blockDagAnimation(q("canvas"));

  function paintBar() {
    barIcon.innerHTML = armed ? ICON.check : ICON.up;
    barText.textContent = armed ? labels.release : barTitle;
    bar.setAttribute("aria-label", barTitle);
    bar.setAttribute("aria-disabled", on ? "false" : "true");
    bar.classList.toggle("disabled", !on);
  }
  function place(animate) {
    host.classList.toggle("sk-swipe-animating", Boolean(animate));
    const h = height();
    form.style.transform = lift ? `translateY(${-lift}px)` : "";
    progress.style.transform = `translateY(${Math.max(0, h - lift)}px)`;
    host.classList.toggle("sk-swipe-sending", phase === "sending");
    const showing = () => lift > 0 || phase === "sending";
    if (showing()) { progress.hidden = false; dag.start(); }
    // Springing back: the sending screen slides down out of sight before it goes.
    else if (animate) later(SETTLE_MS, () => { if (!showing()) { progress.hidden = true; dag.stop(); } });
    else { progress.hidden = true; dag.stop(); }
  }
  function paintProgress() {
    const done = dagShown && Boolean(sent || succeeded);
    const failure = failureText();
    const sending = phase === "sending";
    // Sent, Not confirmed (it may have gone through: Done only) or Failed (KaPay 953b255).
    const ending = swipeUpEnding({ done, failure, doneTitle: labels.done });
    const unknown = ending.kind === "unknown";
    dag.setHighlight(sending && !failure);
    dag.setDimmed(Boolean(done || failure));
    els.mark.innerHTML = done ? ICON.markDone : unknown ? ICON.markUnknown : (failure ? ICON.markFailed : "");
    els.mark.className = `sk-swipe-mark${ending.kind ? ` ${ending.kind}` : ""}`;
    els.big.textContent = ending.title ?? (sending ? labels.working : (armed ? labels.release : "Keep Swiping"));
    const amount = sent?.amountSompi ?? preview.amountSompi;
    els.amount.hidden = amount == null;
    if (amount != null) els.amount.textContent = unitText(`${trimmedKas(amount)} ${KAS_UNIT}`);
    const to = String(sent?.recipient ?? preview.recipient ?? "").trim();
    els.to.hidden = !to;
    if (to) { els.to.title = to; els.to.innerHTML = `<span class="sk-sent-to-word">${esc(labels.recipientWord)}&nbsp;</span>${middleTruncatedHtml(to, 8)}`; }
    // Before that, the title above already says Keep Swiping or Release (KaPay 953b255).
    const showDetail = !(done || failure) && sending;
    els.detail.hidden = !showDetail;
    if (showDetail) els.detail.textContent = labels.workingDetail;
    els.failure.hidden = !failure;
    els.failure.classList.toggle("unknown", unknown);
    if (failure) els.failureText.textContent = failure;
    const id = done && sent ? String(sent.txid || "").trim() : "";
    els.tx.hidden = !id;
    if (id) {
      els.tx.innerHTML = sent.explorerUrl
        ? `<a class="sk-sent-txid" href="${esc(sent.explorerUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(id)}"><span class="sk-sent-txid-text">${middleTruncatedHtml(id, 12)}</span>${ICON.open}</a>
           <p class="sk-swipe-tx-hint">Click the transaction to open it in the explorer.</p>`
        : `<p class="sk-sent-txid plain" title="${esc(id)}"><span class="sk-sent-txid-text">${middleTruncatedHtml(id, 12)}</span></p>`;
    }
    const showOutcome = done && Boolean(outcomeHtml);
    els.outcome.hidden = !showOutcome;
    if (showOutcome && els.outcome.dataset.html !== outcomeHtml) { els.outcome.innerHTML = unitText(outcomeHtml); els.outcome.dataset.html = outcomeHtml; }
    els.final.hidden = !ending.final;
    els.final.textContent = ending.final === "done" ? "Done" : "Try Again";
    els.final.dataset.kind = ending.final || "retry";
  }
  function paint(animate = false) { paintBar(); place(animate); paintProgress(); }

  function startSending() {
    // a send tried before (cancelled at the password) leaves no timer behind to cut this one short
    clearTimers();
    armed = false;
    dagShown = false;
    sendStarted = busy;
    confirmed = false;
    failed = false;
    sent = null;
    succeeded = false;
    outcomeHtml = "";
    preview = getPreview?.() || preview;
    phase = "sending";
    lift = height() * 2;
    paint(true);
    try { onAction?.(); } catch { /* the screen reports its own errors */ }
    later(1800, () => { dagShown = true; paintProgress(); });
    // A send that never started (a check failed before it went busy) fails too.
    later(600, () => { if (!sendStarted && phase === "sending") showFailure(); });
  }
  function showFailure() {
    if (phase !== "sending" || confirmed || failed) return;
    failed = true;
    paintProgress();
  }
  function returnToForm() {
    if (phase !== "sending" || confirmed) return;
    lift = 0;
    place(true);
    // After the screen is back down, so the sending screen doesn't change on its way out.
    later(SETTLE_MS, () => { phase = "form"; failed = false; paint(false); });
  }
  function springBack() {
    armed = false;
    lift = 0;
    paint(true);
  }

  bar.addEventListener("pointerdown", (event) => {
    if (!active() || phase !== "form") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    startY = event.clientY;
    preview = getPreview?.() || {};
    try { bar.setPointerCapture(event.pointerId); } catch { /* fine */ }
    dag.restart();
  });
  bar.addEventListener("pointermove", (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    lift = Math.max(0, startY - event.clientY);
    armed = lift >= threshold();
    paint(false);
  });
  const end = (event, cancelled) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    if (!cancelled && armed && active() && phase === "form") startSending();
    else springBack();
  };
  bar.addEventListener("pointerup", (event) => end(event, false));
  bar.addEventListener("pointercancel", (event) => end(event, true));
  bar.addEventListener("lostpointercapture", (event) => end(event, true));
  bar.addEventListener("contextmenu", (event) => event.preventDefault());
  // Enter / Space (and a screen reader's activation) send at once: iOS accessibilityAction.
  bar.addEventListener("click", (event) => {
    if (event.detail !== 0 || !active() || phase !== "form") return;
    dag.restart();
    startSending();
  });
  els.final.addEventListener("click", () => {
    if (els.final.dataset.kind === "done") { try { onDone?.(); } catch { /* the screen tidies up on its own */ } }
    else returnToForm();
  });
  const onResize = () => {
    if (!host.isConnected) { window.removeEventListener("resize", onResize); dag.stop(); return; }
    if (phase === "sending") { lift = height() * 2; place(false); } else if (!dragging && lift) springBack();
  };
  window.addEventListener("resize", onResize);

  paint(false);
  return {
    body: scroll,
    /** Redraws the review's content (the caller binds it again). */
    setBody(html) { scroll.innerHTML = unitText(html); },
    setEnabled(next) { on = Boolean(next); paintBar(); },
    setBusy(next) {
      const was = busy;
      busy = Boolean(next);
      if (busy) { sendStarted = true; return; }
      // The screen says how it went as it stops being busy; give that a moment to land.
      if (was) later(300, () => { if (!confirmed) showFailure(); });
    },
    /** `outcome` (trusted markup) shows under the transaction. */
    setSent(next, outcome = "") {
      if (!next) return;
      sent = next;
      outcomeHtml = String(outcome || "");
      confirmed = true;
      paintProgress();
    },
    setSucceeded(html = "") {
      outcomeHtml = String(html || "");
      succeeded = true;
      confirmed = true;
      paintProgress();
    },
    /** Nothing was sent (the password was cancelled): back to the review as it was. */
    returnToForm() { clearTimers(); busy = false; sendStarted = true; returnToForm(); },
    get sending() { return phase === "sending"; },
  };
}

/** A stable pseudo-random number for (column, salt) - iOS BlockDAGAnimationView.hash, the same
 *  64-bit mix, so the picture is the one iOS draws. */
const dagHashCache = new Map();
const DAG_M64 = (1n << 64n) - 1n;
function blockDagHash(column, salt) {
  const key = `${column}:${salt}`;
  const cached = dagHashCache.get(key);
  if (cached !== undefined) return cached;
  if (dagHashCache.size > 6000) dagHashCache.clear();
  const a = BigInt.asIntN(64, BigInt(column) * 73856093n);
  const b = BigInt.asIntN(64, BigInt(salt) * 19349663n);
  let x = BigInt.asUintN(64, a ^ b);
  x ^= x >> 33n;
  x = (x * 0xff51afd7ed558ccdn) & DAG_M64;
  x ^= x >> 33n;
  const value = Number(x % 1000003n);
  dagHashCache.set(key, value);
  return value;
}
const dagCount = (column) => 1 + (blockDagHash(column, 1) % 3);
/** Block `row` of `column`'s centre height, as a fraction of the view. */
function dagY(column, row) {
  const n = dagCount(column);
  const jitter = ((blockDagHash(column, 10 + row) % 100) / 100) * 0.12 - 0.06;
  return (row + 1) / (n + 1) + jitter;
}
/** The parents of block `row` in `column`: rows of `column - 1` (several parents, not a chain). */
function dagParents(column, row) {
  const previous = dagCount(column - 1);
  const first = blockDagHash(column, 20 + row) % previous;
  const result = [first];
  if (previous > 1 && blockDagHash(column, 30 + row) % 2 === 0) result.push((first + 1) % previous);
  return result;
}

/**
 * Kaspa's BlockDAG drifting right to left on `canvas` (iOS BlockDAGAnimationView): columns 54px
 * apart at 60px/s, 18px blocks each pointing back at one or two blocks of the column before. With
 * the highlight on, the block entering on the right then is the transaction's: filled in the
 * accent with a pulsing glow, and the blocks after it point back at it in the same colour.
 */
function blockDagAnimation(canvas) {
  const SPACING = 54;
  const SPEED = 60;
  const BLOCK = 18;
  let start = performance.now();
  let highlightStart = null;
  let highlight = false;
  let frame = 0;
  let running = false;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
  function draw(now) {
    frame = 0;
    if (!running || !canvas.isConnected) { running = false; return; }
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const heightPx = canvas.clientHeight;
    if (width && heightPx) {
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(heightPx * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(heightPx * ratio);
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, heightPx);
      const style = getComputedStyle(canvas);
      const accent = style.getPropertyValue("--kaspa").trim() || "#70c7ba";
      const primary = style.color || "#fff";
      const elapsed = (now - start) / 1000;
      const offset = elapsed * SPEED;
      const firstVisible = Math.floor(offset / SPACING) - 1;
      const visibleColumns = Math.floor(width / SPACING) + 3;
      // The column just off the right edge when the send started is the transaction's.
      const highlightScroll = (((highlightStart ?? start) - start) / 1000) * SPEED;
      const txColumn = Math.floor((highlightScroll + width) / SPACING) + 1;
      const x = (column) => column * SPACING - offset;
      const point = (column, row) => [x(column), dagY(column, row) * heightPx];
      // Edges first, under the blocks.
      for (let column = firstVisible; column <= firstVisible + visibleColumns; column += 1) {
        for (let row = 0; row < dagCount(column); row += 1) {
          for (const parent of dagParents(column, row)) {
            const lit = highlight && column - 1 === txColumn && parent === 0;
            const [x1, y1] = point(column, row);
            const [x2, y2] = point(column - 1, parent);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = lit ? accent : primary;
            ctx.globalAlpha = lit ? 0.8 : 0.28;
            ctx.lineWidth = lit ? 2 : 1;
            ctx.stroke();
          }
        }
      }
      for (let column = firstVisible; column <= firstVisible + visibleColumns; column += 1) {
        for (let row = 0; row < dagCount(column); row += 1) {
          const [cx, cy] = point(column, row);
          const left = cx - BLOCK / 2;
          const top = cy - BLOCK / 2;
          if (highlight && column === txColumn && row === 0) {
            ctx.globalAlpha = 0.25 + 0.2 * Math.sin(elapsed * 4);
            ctx.fillStyle = accent;
            roundRect(ctx, left - 7, top - 7, BLOCK + 14, BLOCK + 14, 9);
            ctx.fill();
            ctx.globalAlpha = 1;
            roundRect(ctx, left, top, BLOCK, BLOCK, 5);
            ctx.fill();
          } else {
            ctx.fillStyle = primary;
            ctx.globalAlpha = 0.16;
            roundRect(ctx, left, top, BLOCK, BLOCK, 5);
            ctx.fill();
            ctx.strokeStyle = primary;
            ctx.globalAlpha = 0.45;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    frame = requestAnimationFrame(draw);
  }
  return {
    start() { if (running) return; running = true; frame = requestAnimationFrame(draw); },
    stop() { running = false; if (frame) cancelAnimationFrame(frame); frame = 0; },
    /** The view appearing again (iOS onAppear): the DAG starts over. */
    restart() { start = performance.now(); highlightStart = highlight ? start : null; },
    setHighlight(next) {
      if (Boolean(next) === highlight) return;
      highlight = Boolean(next);
      highlightStart = highlight ? performance.now() : null;
    },
    setDimmed(next) { canvas.classList.toggle("dimmed", Boolean(next)); },
  };
}
