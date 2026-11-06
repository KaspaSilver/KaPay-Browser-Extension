// The pieces every Send Kaspa screen is built from, so they look and behave the same - a port of
// iOS Views/Shared/SendKaspaComponents.swift (4d0324f, afaad34): the recipient on top (paste, scan
// a QR, names resolve), then the big amount (KAS or your currency, Max), the balance pills, the
// fee card (network fee, speed, coin control). Used by Send Kaspa (send.js), KasSigner's send
// (cold-send.js) and the .kachat sheets (kachat-live.js). Change these rather than one screen. The step
// screens themselves (the keypad, the swipe-up review, the fee editor) are send-steps.js.

import { openAddressBookPicker, entryFor, entryName } from "./address-book.js";
import { groupedAmountText } from "./grouped-amount.js";
import { ownAddressLabel } from "./own-addresses.js";
import { esc, ICONS } from "./ui.js";
import { KAS_UNIT } from "./net.js";
// the recipient pills and the Edit capsule are styled with the step screens
import "./send-steps.css";

const SCAN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M7 12h10"/></svg>';
const SWAP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M21 16l-4 4-4-4"/></svg>';
const MERGE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v6a6 6 0 0 0 6 6M18 3v6a6 6 0 0 1-6 6v6M9 18l3 3 3-3"/></svg>';
const PERSON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4.2"/><path d="M3.5 21a8.5 8.5 0 0 1 17 0z"/></svg>';
// person.text.rectangle - KaChat's contact card, wherever contacts appear (iOS 8118f09).
export const CONTACT_CARD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="2.6"/><circle cx="8.6" cy="10.4" r="2.2"/><path d="M5.2 16.1c.7-1.5 1.9-2.3 3.4-2.3s2.7.8 3.4 2.3M14.6 10h4M14.6 13.6h3"/></svg>';
export const CHEVRON_DOWN = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg>';

/** "1.5", "0.0001": exact, trailing zeros dropped. */
export function trimmedKas(sompi) {
  const v = BigInt(sompi ?? 0n);
  const whole = v / 100_000_000n;
  const frac = v % 100_000_000n;
  return frac === 0n ? String(whole) : `${whole}.${String(frac).padStart(8, "0").replace(/0+$/, "")}`;
}

// --- Recipient (SendRecipientCard + AddressResolutionCard) ---------------------------------

/**
 * Who the Kaspa goes to: an address or a name, with Paste, Scan QR and Contacts as labelled pills
 * under the field - always all three, sized to fit one row (iOS 8118f09) -, the address it stands
 * for, and a line saying what the input resolved to. The screen runs the lookup
 * (recipientLookup below).
 *   lockedAddress: Compound UTXOs - the recipient is fixed
 *   status: { resolving, error, resolvedAddress, resolvedName, valid }
 *   extraHtml: below the status (the "Other domains" picker)
 * Everything under the field is in #recipient-status, so a lookup can redraw it
 * (recipientStatusHtml) without taking the cursor out of the field.
 */
export function recipientCardHtml({ input = "", lockedAddress = null, status = {}, extraHtml = "" }) {
  if (lockedAddress) {
    return `
      <div class="sk-card">
        <div class="sk-label">To</div>
        <div class="sk-locked">${MERGE}<span class="mono tiny ellipsis">${esc(lockedAddress)}</span></div>
        <div class="muted tiny">Consolidating This Address</div>
      </div>`;
  }
  return `
    <div class="sk-card">
      <div class="sk-label">To</div>
      <input id="recipient" class="sk-recipient sk-recipient-field mono" value="${esc(input)}" placeholder="kaspa:qr... or domain" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <div class="sk-input-pills">
        <button type="button" class="sk-input-pill" id="paste">${ICONS.clipboard}<span>Paste</span></button>
        <button type="button" class="sk-input-pill" id="scan">${SCAN}<span>Scan QR</span></button>
        <button type="button" class="sk-input-pill" id="address-book">${CONTACT_CARD}<span>Contacts</span></button>
      </div>
      <div class="sk-recipient-status" id="recipient-status">${recipientStatusHtml({ input, status, extraHtml })}</div>
    </div>`;
}

/** Under the recipient field: the address it stands for, its saved name, and the lookup's line. */
export function recipientStatusHtml({ input = "", status = {}, extraHtml = "" }) {
  const trimmed = input.trim();
  const shownAddress = status.resolvedAddress || (status.valid ? trimmed : null);
  let line = "";
  if (trimmed) {
    if (status.resolving) line = '<div class="sk-status muted"><span class="spinner small-spin"></span><span>Looking up domain...</span></div>';
    else if (status.error) line = `<div class="sk-status bad">${ICONS.xCircle}<span>${esc(status.error)}</span></div>`;
    else if (status.resolvedAddress) {
      line = `<div class="sk-status good">${ICONS.checkFill}<span>Resolved: ${esc(status.resolvedName || "")}</span></div>
        <div class="mono tiny muted ellipsis">${esc(status.resolvedAddress)}</div>`;
    } else {
      line = status.valid
        ? `<div class="sk-status good">${ICONS.checkFill}<span>Valid address</span></div>`
        : `<div class="sk-status bad">${ICONS.xCircle}<span>${esc(status.invalidReason || "Invalid address format")}</span></div>`;
    }
  }
  const saved = shownAddress ? entryFor(shownAddress) : null;
  return `
    ${shownAddress ? addressResolutionHtml({ address: shownAddress, name: status.resolvedName || null }) : ""}
    ${saved ? `<div class="sk-status accent ab-saved">${CONTACT_CARD}<span>${esc(entryName(saved))}</span></div>` : ""}
    ${shownAddress && ownAddressLabel(shownAddress) ? `<div class="sk-status accent">${esc(`Your own address: ${ownAddressLabel(shownAddress)}`)}</div>` : ""}
    ${line}
    ${extraHtml}`;
}

/** iOS AddressResolutionCard: the person avatar, the name (or "No domain") over the address. */
export function addressResolutionHtml({ address, name = null }) {
  return `
    <div class="sk-resolution">
      <span class="sk-avatar">${PERSON}</span>
      <span class="tx-meta">
        <span class="small strong ${name ? "" : "muted"}">${esc(name || "No domain")}</span>
        <span class="mono tiny muted ellipsis">${esc(address)}</span>
      </span>
    </div>`;
}

/**
 * The lookup behind a To field (iOS resolveKNSDomain, f0f394d): every change shows the spinner
 * at once and waits `delay` ms; then what the field holds is resolved. An answer is used only
 * while the field still holds the text it was asked about, and the newest lookup always takes
 * the spinner down - so a name typed quickly can never leave "Looking up domain..." up for good.
 *   read()          the field's text now
 *   resolve(text)   the answer ({ address, domain, tld, resolutions }), or throws the message
 *                   to show (with `resolutions` when another service has the name)
 *   onChange(state) { resolving, recipient, error, resolutions } changed: redraw
 * Returns { state, schedule() (after typing), now() (paste, scan, a pick), cancel() }.
 */
export function recipientLookup({ read, resolve, onChange, delay = 350 }) {
  const state = { resolving: false, recipient: null, error: "", resolutions: [] };
  let seq = 0;
  let timer = null;
  const text = () => String(read() ?? "").trim();
  const now = async () => {
    clearTimeout(timer);
    timer = null;
    const mine = ++seq;
    const asked = text();
    state.recipient = null;
    state.error = "";
    state.resolutions = [];
    state.resolving = Boolean(asked);
    onChange(state);
    if (!asked) return;
    let answer = null;
    let failure = null;
    try { answer = await resolve(asked); } catch (error) { failure = error; }
    if (mine !== seq) return; // a newer lookup owns the card (and its spinner)
    if (text() === asked) {
      if (answer) {
        state.recipient = answer;
        state.resolutions = answer.resolutions || [];
      } else {
        state.error = String(failure?.message || failure || "Invalid address format");
        state.resolutions = failure?.resolutions || [];
      }
    }
    // The field moved on and its own lookup is still waiting: that one clears the spinner.
    state.resolving = Boolean(timer);
    onChange(state);
  };
  return {
    state,
    now,
    schedule() {
      clearTimeout(timer);
      if (!text()) { now(); return; }
      state.recipient = null;
      state.resolving = true;
      timer = setTimeout(now, delay);
      onChange(state);
    },
    cancel() { clearTimeout(timer); timer = null; seq += 1; state.resolving = false; },
  };
}

// --- Amount (KaspaAmountEntry + KaspaFiatAmountState) --------------------------------------

// The amount field's KAS / currency state lives in amount-state.js (no screen code, tested in node).
export { amountState } from "./amount-state.js";

/**
 * The big centred amount and its unit, with the KAS / currency switch (showing the converted
 * value) and Max under it.
 *   { display, unit, conversion, currencyCode, canSwitch, maxEnabled, estimatingMax, readOnly }
 */
export function amountEntryHtml({ display = "", unit = KAS_UNIT, conversion = null, currencyCode = "", canSwitch = false, maxEnabled = true, estimatingMax = false, readOnly = false, fiat = false }) {
  const size = display.length <= 7 ? 46 : display.length <= 10 ? 36 : 28;
  return `
    <div class="sk-amount">
      <label class="sk-amount-row" style="--size:${size}px">
        <input id="amount" class="sk-amount-input" inputmode="decimal" placeholder="0" value="${esc(display)}" autocomplete="off" aria-label="Amount" ${readOnly ? "readonly" : ""} style="width:${Math.max(1, (groupedAmountText(display) || "0").length) + 0.1}ch" />
        <span class="sk-amount-unit">${esc(unit)}</span>
      </label>
      <div class="sk-amount-actions">
        ${canSwitch ? `<button class="sk-chip" id="unit-switch" aria-label="Switch between Kaspa and your currency">${SWAP}<span>${esc(conversion || (fiat ? KAS_UNIT : currencyCode))}</span></button>` : ""}
        ${readOnly ? "" : `<button class="sk-chip accent strong" id="max" ${maxEnabled && !estimatingMax ? "" : "disabled"}>${estimatingMax ? '<span class="spinner small-spin"></span>' : "Max"}</button>`}
      </div>
    </div>`;
}

/** Grows the amount field with its text and re-sizes the font, without a repaint while typing. */
export function fitAmountInput(input) {
  // sized to what it shows - with its thousands commas (grouped-amount.js), not the plain value
  const text = groupedAmountText(input.value || "") || "0";
  input.style.width = `${Math.max(1, text.length) + 0.1}ch`;
  const size = text.length <= 7 ? 46 : text.length <= 10 ? 36 : 28;
  input.closest(".sk-amount-row")?.style.setProperty("--size", `${size}px`);
}

// --- Pills (SendInfoPill) ------------------------------------------------------------------

/** A small one-line pill; with `id` it is a button (the Send From picker). */
export function pillHtml(content, { id = null, disabled = false } = {}) {
  return id
    ? `<button class="sk-pill" id="${id}" ${disabled ? "disabled" : ""}>${content}</button>`
    : `<span class="sk-pill">${content}</span>`;
}

// --- Fee and coin control (SendFeeControls) ------------------------------------------------

export const FEE_TIERS = [
  { id: "normal", label: "Normal", multiplier: 1 },
  { id: "fast", label: "Fast", multiplier: 2 },
  { id: "priority", label: "Priority", multiplier: 5 },
];

/**
 * Network fee (tap to set a custom one), the fee speed, and coin control - one card.
 *   { tier, custom, editing, customText, estimating, feeText, showsCoinControl, coinSummary, editPill }
 * `editPill` (a send's review, iOS onEditFee): the fee shows with an Edit capsule (#fee-edit)
 * that opens the fee editor (send-steps.js showFeeEditor) instead of being typed here.
 */
export function feeControlsHtml({ tier = "normal", custom = false, editing = false, customText = "", estimating = false, feeText = null, showsCoinControl = true, coinSummary = "Automatic", editPill = false }) {
  let fee;
  if (editPill) {
    fee = `<span class="sk-fee-value">${estimating ? '<span class="spinner small-spin"></span>' : `<span class="${feeText ? "" : "muted"}">${esc(feeText || "—")}</span>`}<button type="button" class="sk-fee-edit-pill" id="fee-edit" ${feeText ? "" : "disabled"}>${ICONS.pencilSmall}<span>Edit</span></button></span>`;
  } else if (editing) {
    fee = `<span class="fee-edit"><input id="custom-fee" inputmode="decimal" value="${esc(customText)}" placeholder="0.00" /><button class="icon plain accent" id="fee-ok" aria-label="Use this fee">${ICONS.checkCircle}</button></span>`;
  } else if (estimating) {
    fee = '<span class="spinner small-spin"></span>';
  } else if (feeText) {
    fee = `<button class="link-button underline" id="fee">${esc(feeText)} ${ICONS.pencilSmall}</button>`;
  } else {
    fee = '<span class="muted">—</span>';
  }
  return `
    <div class="sk-card">
      <div class="sk-fee-row"><span>Network Fee</span>${fee}</div>
      <div class="segmented wide" role="radiogroup" aria-label="Fee">
        ${FEE_TIERS.map((t) => `<button type="button" role="radio" data-tier="${t.id}" aria-checked="${!custom && tier === t.id}">${t.label}</button>`).join("")}
      </div>
      <div class="muted tiny">${editPill
        ? "If the network is busy, Fast or Priority pays a higher fee to help this confirm sooner. Edit sets a fee of your own."
        : "If the network is busy, Fast or Priority pays a higher fee to help this confirm sooner. Tap the fee amount to set a custom fee."}</div>
      ${showsCoinControl ? `
        <div class="sk-divider"></div>
        <button class="sk-coin-row" id="coins"><span>Coin Control</span><span class="muted">${esc(coinSummary)} ${ICONS.chevron}</span></button>` : ""}
    </div>`;
}

/** "Automatic" or "3 UTXOs selected". */
export function coinSummary(selected) {
  if (!selected) return "Automatic";
  return `${selected.size} UTXO${selected.size === 1 ? "" : "s"} selected`;
}

/** The recipient card's Contacts pill: pick a saved address (iOS 00767a4, 8118f09). It is always
 *  there; with no contacts yet the picker says so. */
export function bindAddressBookButton(root, onPick) {
  const button = root.querySelector("#address-book");
  if (button) button.onclick = () => openAddressBookPicker((entry) => onPick(entry.address));
}
