// Request Payment (iOS c6851d6 / 86dfd2d / 6dee531 / 338d9f5 / 3f5f79c, CreatePaymentRequestView;
// in steps since KaPay 05db583): a payment request link - to a brand-new address or one of yours,
// an exact amount and what it's for. The step screens of a send the other way round
// (send-steps.js):
//   "Where do you want to be paid?"  Fresh Address, or Choose an Address with your addresses
//                                    listed right on the step
//   "How much?"                      the app's own keypad (KAS or your currency)
//   Review                           the amount, Paid to, the memo; Copy Payment Request is the
//                                    bottom button, Share under the memo
// Copy (or share) it and send it anywhere; in KaChat it opens Send Kaspa filled in, and shows it
// was made by your chatting address (signed with its key, shared engine payment-request.js).
//
// A fresh address is shown before it's needed and reserved only when the request is copied or
// shared, so opening the screen and cancelling uses none up; copying and sharing again reuse it.

import { esc, toast, ICONS, settings, unitText } from "./ui.js";
import * as wallet from "./wallet.js";
import * as vault from "./vault.js";
import { returnToTab } from "./dock.js";
import { sompiFromUserText } from "./amounts.js";
import { KAS_UNIT } from "./net.js";
import { amountState, addressResolutionHtml, trimmedKas } from "./send-pieces.js";
import {
  createStepFlow, showStep, stepNoteHtml, choicePillsHtml, mountOwnAddressList, bindKeypad, applyKeypadKey,
  keypadAmountEntryHtml, paintKeypadAmountEntry, reviewAmountHtml,
} from "./send-steps.js";
import {
  PAYMENT_REQUEST_MEMO_LIMIT, makePaymentRequest, signPaymentRequest, paymentRequestUniversalLink, clampMemoText, memoCharacters,
} from "../shared/engine/payment-request.js";

const short = (a) => `${a.slice(0, 14)}...${a.slice(-6)}`;
const ORDER = ["destination", "amount", "review"];
const ACCOUNT_SWITCHED = "You switched accounts. Start the request again.";
const FRESH_MOVED = "That fresh address was just used. Check the new Paid to address and copy again.";

/** @param {{ onClose?: Function }} [opts] onClose: Cancel / after copying, back where it was opened
 *  (the tab under the "+" by default). */
export function showRequestPayment(opts = {}) {
  const onClose = opts.onClose || (() => returnToTab());
  const state = {
    destination: "fresh", // "fresh" | "chosen"
    nextFresh: null,      // shown before it's reserved
    fresh: null,          // reserved once, then reused
    chosen: null,         // { address, label }
    chatting: null,
    accountId: null,      // the account the screen opened on: the request is that account's
    amountText: "",
    memo: "",
    copied: false,
    working: false,
    error: "",
    price: null,
    currency: "usd",
  };
  // KAS or your currency, as a send's amount (iOS KaspaFiatAmountState)
  const amountField = amountState();
  let handle = null;

  const address = () => (state.destination === "fresh" ? (state.fresh || state.nextFresh)?.address : state.chosen?.address) || null;
  const amountSompi = () => { const v = sompiFromUserText(state.amountText); return v != null && v > 0n ? v : null; };
  const canMake = () => amountSompi() != null && Boolean(address());
  const price = () => state.price?.price || 0;
  const here = () => Boolean(handle?.el?.isConnected);

  const flow = createStepFlow(ORDER, (id, direction) => {
    handle = null;
    if (id === "destination") drawDestination(direction);
    else if (id === "amount") drawAmount(direction);
    else drawReview(direction);
  });

  // --- Where do you want to be paid? ----------------------------------------------------------
  const drawDestination = (direction) => {
    handle = showStep({
      screen: "request-where",
      title: "Request Payment",
      question: "Where do you want to be paid?",
      bodyHtml: '<div class="ss-review-stack" id="req-where"></div><div id="req-list"></div>',
      onCancel: onClose,
      canContinue: () => Boolean(address()),
      onContinue: () => flow.go("amount"),
      direction,
    });
    paintDestination();
    if (state.destination === "chosen") showList();
  };
  const paintDestination = () => {
    if (!here() || flow.current !== "destination") return;
    const host = handle.el.querySelector("#req-where");
    const fresh = (state.fresh || state.nextFresh)?.address;
    host.innerHTML = unitText(`
      ${choicePillsHtml([
        { id: "req-fresh", title: "Fresh Address", on: state.destination === "fresh" },
        { id: "req-choose", title: "Choose an Address", on: state.destination === "chosen" },
      ])}
      ${state.destination === "fresh"
        ? (fresh ? `${addressResolutionHtml({ address: fresh })}${stepNoteHtml("A brand-new address of yours that has never been used or handed out.")}`
          : '<div class="ss-list-loading"><span class="spinner"></span></div>')
        : stepNoteHtml("Pick which of your addresses gets paid.")}`);
    host.querySelector("#req-fresh").onclick = () => {
      if (state.destination === "fresh") return;
      state.destination = "fresh";
      state.copied = false;
      hideList();
      paintDestination();
    };
    host.querySelector("#req-choose").onclick = () => {
      if (state.destination === "chosen") return;
      state.destination = "chosen";
      state.copied = false;
      paintDestination();
      showList();
    };
    handle.refresh();
  };
  // the list right here, no sheet: tap the address that gets paid
  let list = null;
  const showList = () => {
    const el = handle.el.querySelector("#req-list");
    el.hidden = false;
    list = mountOwnAddressList(el, {
      selectedAddress: state.chosen?.address || null,
      onPick: (picked) => {
        state.chosen = { address: picked.address, label: picked.kind === "chatting" ? "Chatting Address" : picked.label };
        state.copied = false;
        list?.setSelected(picked.address);
        handle.refresh();
      },
    });
  };
  const hideList = () => {
    const el = handle?.el?.querySelector("#req-list");
    if (el) { el.hidden = true; el.innerHTML = ""; }
    list = null;
  };

  // --- How much? ----------------------------------------------------------------------------
  const fiatText = (kas) => (price() ? wallet.formatFiat(sompiFromUserText(kas.toFixed(8)) ?? 0n, state.price) : "");
  const entryOptions = () => ({
    typed: amountField.display,
    unit: amountField.fiat ? state.currency.toUpperCase() : KAS_UNIT,
    conversion: amountField.conversion(price(), fiatText),
    switchText: amountField.fiat ? KAS_UNIT : state.currency.toUpperCase(),
    canSwitch: price() > 0,
    showsMax: false,
  });
  const drawAmount = (direction) => {
    const to = address();
    handle = showStep({
      screen: "request-amount",
      title: "Request Payment",
      question: "How much?",
      className: "ss-keypad-step",
      bodyHtml: `
        ${to ? `<div class="ss-chips start"><span class="ss-chip"><span class="ss-chip-label">Paid to</span><span class="ss-chip-value mono">${esc(short(to))}</span></span></div>` : ""}
        ${keypadAmountEntryHtml(entryOptions())}`,
      onBack: () => flow.go("destination"),
      onCancel: onClose,
      continueTitle: "Review",
      canContinue: () => amountSompi() != null,
      onContinue: () => flow.go("review"),
      direction,
    });
    bindKeypad(handle.el, (key) => {
      const next = applyKeypadKey(key, amountField.display, amountField.fiat ? 2 : 8);
      if (next === amountField.display) return false;
      state.amountText = amountField.onInput(next, price());
      state.copied = false;
      paintAmount();
      return true;
    });
    bindSwitch();
  };
  const bindSwitch = () => {
    const unitSwitch = handle.el.querySelector("#unit-switch");
    if (unitSwitch) unitSwitch.onclick = () => { amountField.toggle(price()); paintAmount(); };
  };
  const paintAmount = () => {
    if (!here() || flow.current !== "amount") return;
    paintKeypadAmountEntry(handle.el, entryOptions());
    bindSwitch();
    handle.refresh();
  };

  // --- Review -------------------------------------------------------------------------------
  const memoNote = () => (address() === state.chatting
    ? "The payment lands in your chat with whoever pays, with the memo."
    : "The memo shows to whoever pays, but doesn't travel with the payment.");
  const drawReview = (direction) => {
    const sompi = amountSompi();
    handle = showStep({
      screen: "request-review",
      title: "Review",
      bodyHtml: `
        ${reviewAmountHtml({ eyebrow: "You're requesting", amountText: `${trimmedKas(sompi ?? 0n)} ${KAS_UNIT}`, fiatText: sompi != null && price() ? wallet.formatFiat(sompi, state.price) : "" })}
        <div class="ss-review-stack">
          <div class="ss-label">Paid to</div>
          <div id="req-paid-to">${addressResolutionHtml({ address: address() || "" })}</div>
        </div>
        <div class="req-memo-card">
          <textarea id="req-memo" class="req-memo" rows="2" placeholder="What it's for (optional)">${esc(state.memo)}</textarea>
          <div class="muted tiny req-count">${memoCharacters(state.memo).length}/${PAYMENT_REQUEST_MEMO_LIMIT}</div>
        </div>
        ${stepNoteHtml(memoNote())}
        <p class="error-text small center-text" id="req-error" ${state.error ? "" : "hidden"}>${esc(state.error)}</p>
        ${navigator.share ? `<button type="button" class="req-share" id="req-share">${ICONS.share}<span>Share</span></button>` : ""}
        <p class="muted tiny center-text">Anyone who opens it in KaPay or KaChat gets Send Kaspa with this filled in, and sees it was made by your chatting address (signed with its key).</p>`,
      onBack: () => flow.go("amount"),
      onCancel: onClose,
      continueTitle: () => (state.copied && !state.working ? "Copied" : "Copy Payment Request"),
      canContinue: () => canMake() && !state.working,
      onContinue: copy,
      direction,
    });
    const memo = handle.el.querySelector("#req-memo");
    memo.oninput = () => {
      const clamped = clampMemoText(memo.value);
      if (clamped !== memo.value) memo.value = clamped;
      state.memo = clamped;
      state.copied = false;
      handle.el.querySelector(".req-count").textContent = `${memoCharacters(clamped).length}/${PAYMENT_REQUEST_MEMO_LIMIT}`;
      refreshReview();
    };
    const share = handle.el.querySelector("#req-share");
    if (share) share.onclick = shareLink;
    refreshReview();
  };
  const refreshReview = () => {
    if (!here() || flow.current !== "review") return;
    // "Paid to" is the address the link pays: the reserved one once Copy has reserved it
    const paidTo = handle.el.querySelector("#req-paid-to");
    if (paidTo) paidTo.innerHTML = unitText(addressResolutionHtml({ address: address() || "" }));
    handle.refresh();
    const share = handle.el.querySelector("#req-share");
    if (share) share.disabled = !canMake() || state.working;
    const error = handle.el.querySelector("#req-error");
    if (error) { error.textContent = state.error; error.hidden = !state.error; }
  };

  /** The request to hand out, signed by your chatting address. A fresh address is reserved here,
   *  the first time it's needed. The chatting address and its key come from one read of the vault,
   *  now: the address cached when the screen opened next to whichever key is active at copy time
   *  made a signature receivers reject (or a link signed for "null"). */
  const makeRequest = async () => {
    const sompi = amountSompi();
    if (sompi == null) return null;
    let signer = null;
    try { signer = await wallet.chattingSigner(); } catch { signer = null; }
    // another window switched accounts: this screen's addresses are the other account's
    if (signer && state.accountId && signer.accountId !== state.accountId) { state.error = ACCOUNT_SWITCHED; return null; }
    if (signer) state.chatting = signer.address;
    let to;
    if (state.destination === "fresh") {
      if (!state.fresh) {
        const shown = state.nextFresh?.address || null;
        let reserved;
        try { reserved = await wallet.reserveFreshSpendingAddress(); } catch { state.error = "Couldn't make a new address. Please try again."; return null; }
        if (state.accountId && reserved.accountId && reserved.accountId !== state.accountId) { state.error = ACCOUNT_SWITCHED; return null; }
        state.fresh = reserved;
        // never hand out an address that wasn't on screen: "Paid to" shows the reserved one, and
        // the next Copy uses it
        if (shown && shown !== reserved.address) { state.error = FRESH_MOVED; return null; }
      }
      to = state.fresh.address;
    } else {
      if (!state.chosen) return null;
      to = state.chosen.address;
    }
    const unsigned = makePaymentRequest({ address: to, amountSompi: sompi, memo: state.memo, toChattingAddress: to === state.chatting });
    // the chatting address unknown: the link goes unsigned rather than signed for nobody
    if (!signer) return unsigned;
    return signPaymentRequest(unsigned, signer.address, signer.privateKeyHex) || unsigned;
  };

  const copy = async () => {
    state.working = true;
    state.error = "";
    refreshReview();
    const request = await makeRequest();
    state.working = false;
    if (request) {
      try { await navigator.clipboard.writeText(paymentRequestUniversalLink(request)); state.copied = true; } catch { toast("Clipboard unavailable."); }
    }
    refreshReview();
  };
  const shareLink = async () => {
    state.working = true;
    state.error = "";
    refreshReview();
    const request = await makeRequest();
    state.working = false;
    refreshReview();
    if (!request) return;
    try { await navigator.share({ url: paymentRequestUniversalLink(request) }); } catch { /* closed */ }
  };

  flow.go("destination");
  (async () => {
    try {
      state.accountId = (await vault.readAccounts()).activeAccountId || null;
      state.chatting = (await wallet.cachedAddresses(state.accountId))?.main || null;
      state.nextFresh = await wallet.nextFreshSpendingAddress();
    } catch { /* shown as loading */ }
    paintDestination();
  })();
  (async () => {
    state.currency = (await settings()).currency || "usd";
    state.price = await wallet.price(state.currency).catch(() => null);
    paintAmount();
  })();
}
