// Send Kaspa - iOS WithdrawKaspaView, in steps (KaPay 05db583) ending on the swipe-up send screen
// (59593af), built from the step screens (send-steps.js) and the Send Kaspa pieces (send-pieces.js):
//   To      "Who are you sending to?": the recipient card - a kaspa: address, or a name on any
//           service (.kachat, .kas, .k, .kaspa) resolved as you type, with "Other domains"; Paste,
//           Scan QR and Contacts pills (8118f09). A kachat.app/pay link fills in the request.
//   From    "Where are you sending from?": the Chatting Address, or Choose an Address with your
//           addresses listed on the step. Skipped when the From is fixed (an address's own Send).
//   Amount  the app's own keypad: "To" / "From" chips, KAS or your currency, Max, and the From
//           address's Available under it. A request's amount is fixed: the request, no keypad.
//   Review  swipe up to send: the amount, To, From and Total; only the fee (its Edit opens the fee
//           editor) and coin control can change, and a Max amount is worked out again when they
//           do. The password ("Confirm Send", wallet.js) is asked as the send starts, under the
//           BlockDAG; then Sent with the transaction, or Failed with the error and Try Again, or
//           "Not confirmed" with only Done when the network never answered (KaPay 953b255).
// A pre-filled recipient (Donate, a contact) or a payment request link opens on From (on the
// amount when From is fixed). Compound UTXOs - the recipient locked to the address itself, the
// amount Max - opens on the review.

import * as wallet from "./wallet.js";
import * as vault from "./vault.js";
import { app, esc, render, $, toast, settings, ICONS, formatKas8, unitText } from "./ui.js";
import { otherDomainsHtml, bindOtherDomains, splitTypedName } from "./names.js";
import { scanQr } from "./camera.js";
import { loadOwnAddresses } from "./own-addresses.js";
import { KAS_UNIT } from "./net.js";
import { parsePaymentRequestLink, paymentRequestAmountText } from "../shared/engine/payment-request.js";
import { SEND_OUTCOME_UNKNOWN, SEND_OUTCOME_UNKNOWN_MESSAGE, MAX_AMOUNT_CHANGED, MAX_AMOUNT_CHANGED_MESSAGE } from "../shared/engine/transactions.js";
import { maxPinCurrent, selectionKey } from "./send-guards.js";
import { oneTransactionChunk } from "./send-coins.js";
import { entryFor, entryName } from "./address-book.js";
import {
  FEE_TIERS, recipientCardHtml, recipientStatusHtml, recipientLookup, bindAddressBookButton, amountState, feeControlsHtml,
  coinSummary, trimmedKas,
} from "./send-pieces.js";
import {
  createStepFlow, showStep, showSwipeUp, showFeeEditor, SWIPE_UP_LABELS, stepNoteHtml, stepChipsHtml, choicePillsHtml,
  bindKeypad, applyKeypadKey, keypadAmountEntryHtml, paintKeypadAmountEntry, reviewAmountHtml, reviewRowHtml,
  reviewAddressHtml, reviewCardHtml, mountOwnAddressList,
} from "./send-steps.js";

const ORDER = ["to", "from", "amount", "review", "fee"];
/** The From address's coins couldn't be read (iOS, KaPay iOS 0799cec). */
const COINS_UNREAD = "Couldn't load the coins at this address";
const short = (a) => `${a.slice(0, 14)}...${a.slice(-6)}`;

/**
 * @param {object} opts
 * @param {{kind:"main"}|{kind:"spending",index:number}} opts.source
 * @param {string} opts.fromAddress
 * @param {string} [opts.title]      a line under the question (Donate says who it is for)
 * @param {string} [opts.navTitle]   the steps' title: iOS "Send Kaspa"
 * @param {string} [opts.feeFooter]  (no longer shown: the review's fee card words it as iOS does)
 * @param {boolean} [opts.compound]
 * @param {string} [opts.recipient]  prefill (Donate, a contact), or a payment request link
 * @param {boolean} [opts.lockedSource] opened from one address's own page: that address only, no
 *                                    From step (iOS 7a8102b)
 * @param {Function} opts.onClose    cancel / done
 * @param {Function} [opts.onSent]   after a successful send, before Done
 */
export function showSend(opts) {
  const state = {
    recipientInput: opts.compound ? opts.fromAddress : (opts.recipient || ""),
    recipient: opts.compound ? { address: opts.fromAddress, domain: null } : null,
    recipientError: "",
    resolving: false,
    resolutions: [],        // every name service's answer for a typed name ("Other domains")
    othersOpen: false,
    amountText: "",
    maxMode: false,
    fillingMax: false,
    maxPin: null,           // what Max was worked out from (coins, amount, fee): what the slide sends
    coins: null,            // all spendable coins at the source
    coinsUnread: false,     // they couldn't be read: said so, never Available 0 (KaPay iOS 0799cec)
    selected: null,         // Set of coin keys, or null for Automatic
    tier: "normal",
    base: null,             // { policyKas, sdkBaseKas } for the current amount/coins
    customFeeKas: null,     // number when the user set their own
    estimating: false,
    feeError: "",           // the fee couldn't be worked out: no swipe (iOS feeError, KaPay iOS 0799cec)
    price: null,
    sending: false,
    error: "",
    currency: "usd",
    sourceLabel: null,
    chatting: opts.source?.kind === "spending" ? null : opts.fromAddress,
    choosingFrom: opts.source?.kind === "spending",
    request: null,          // a kachat.app/pay link pasted, scanned or typed (EXT-023)
  };
  // Opened with a payment request link: its address is fixed, so there is no To step.
  let requestFromLink = false;
  // The amount field (KAS or your currency) - iOS KaspaFiatAmountState.
  const amountField = amountState();

  // --- derived --------------------------------------------------------------------------
  const spendableSompi = () => {
    if (!state.coins) return null;
    const list = state.selected ? state.coins.filter((c) => state.selected.has(c.key)) : state.coins;
    return list.reduce((sum, c) => sum + c.amount, 0n);
  };
  /** The coins a Max (or Compound) spends: the coin-control pick, else past 80 coins the largest 80
   *  (one transaction's worth, KaPay iOS 0799cec oneTransactionChunk; wallet.js picks the same ones
   *  for the send), else every coin. */
  const maxCoins = () => {
    if (!state.coins) return null;
    if (state.selected) return state.coins.filter((c) => state.selected.has(c.key));
    return oneTransactionChunk(state.coins) || state.coins;
  };
  const inputCount = () => Math.max(1, maxCoins()?.length || 0);
  /** Coins the last send spent are held at the From address (KaPay iOS 0799cec). */
  const coinsHeld = () => wallet.heldCoinCount(opts.fromAddress) > 0;
  const tierMultiplier = () => FEE_TIERS.find((t) => t.id === state.tier)?.multiplier || 1;
  const totalFeeKas = () => {
    if (state.customFeeKas != null) return state.customFeeKas;
    return state.base ? state.base.policyKas * tierMultiplier() : null;
  };
  const kasNumberToSompi = (kas) => wallet.kasToSompi(kas.toFixed(8));
  const totalFeeSompi = () => { const fee = totalFeeKas(); return fee == null ? null : kasNumberToSompi(fee); };
  /** The fee the review shows: a Max's own (the engine raises a fee under the network floor). */
  const shownFeeSompi = () => (state.maxMode && state.maxPin && !opts.compound ? state.maxPin.feeSompi : totalFeeSompi());
  /** The Normal fee for these coins: the network minimum the fee editor holds to. */
  const normalFeeSompi = () => (state.base ? kasNumberToSompi(state.base.policyKas) : null);
  const amountSompi = () => wallet.kasToSompi(state.amountText);
  const selectedOutpoints = () => (state.selected ? [...state.selected] : null);
  const price = () => state.price?.price || 0;
  /** The amount is more than the From address holds. */
  const exceedsBalance = () => {
    const amount = amountSompi();
    const available = spendableSompi();
    return amount != null && available != null && amount > available;
  };
  const canReview = () => {
    const amount = amountSompi();
    return Boolean(state.recipient) && !state.resolving && amount != null && amount > 0n && !exceedsBalance() && !state.fillingMax;
  };
  // The swipe waits for a settled amount and fee (iOS canSend, KaPay iOS 0799cec): a Max or fee
  // still being worked out, or a fee that couldn't be, would send something other than the review
  // shows. Fast and Priority are the Normal fee times their multiplier here, with no estimate of
  // their own to wait for.
  const canSend = () => {
    if (state.sending || !state.recipient || state.resolving || state.fillingMax) return false;
    if (state.estimating || !state.base || state.feeError) return false;
    const amount = amountSompi();
    const fee = totalFeeKas();
    const available = spendableSompi();
    if (amount == null || amount <= 0n || fee == null || available == null) return false;
    if (state.maxMode || opts.compound) return true;
    return amount + kasNumberToSompi(fee) <= available;
  };
  const isChattingSource = () => opts.source?.kind !== "spending";
  const sourceTitle = () => (isChattingSource() ? "Chatting Address" : (state.sourceLabel || `Address #${opts.source.index}`));
  /** The recipient's name: the domain it resolved from, else its Contacts name. */
  const recipientName = () => {
    if (!state.recipient) return null;
    if (state.recipient.domain) return state.recipient.domain;
    const saved = entryFor(state.recipient.address);
    return saved && String(saved.name || "").trim() ? entryName(saved) : null;
  };
  const screenTitle = () => (opts.compound ? "Compound UTXOs" : state.request ? "Payment Request" : (opts.navTitle || "Send Kaspa"));

  // --- the steps (iOS Step, initialStep, backStep(from:)) --------------------------------
  const afterRecipient = () => (opts.lockedSource ? "amount" : "from");
  /** Where Back goes from a step; null for the first one. */
  const backFrom = (id) => {
    if (id === "from") return requestFromLink ? null : "to";
    if (id === "amount") {
      if (!opts.lockedSource) return "from";
      return opts.compound || requestFromLink ? null : "to";
    }
    if (id === "review") return opts.compound ? null : "amount";
    return null;
  };
  let handle = null;  // the step on screen: { el, refresh } (a swipe-up review adds `swipe`)
  const flow = createStepFlow(ORDER, (id, direction) => {
    handle = null;
    if (id === "to") drawTo(direction);
    else if (id === "from") drawFrom(direction);
    else if (id === "amount") drawAmount(direction);
    else if (id === "review") drawReview(direction);
    else if (id === "fee") drawFee(direction);
  });
  const go = (id) => {
    // Back to To from a pasted request: the recipient starts over (iOS go(to: .recipient)).
    if (id === "to" && state.request && !requestFromLink) clearRequest();
    flow.go(id);
  };
  const here = () => Boolean(handle?.el?.isConnected);
  /** Redraws what changed on the step showing (a lookup, a fee, a balance arriving). */
  const paint = () => {
    if (!here()) return;
    const id = flow.current;
    if (id === "to") paintRecipient();
    else if (id === "from") paintFromChoice();
    else if (id === "amount") paintAmount();
    else if (id === "review") paintReview();
  };
  const titleLine = () => (opts.title ? stepNoteHtml(opts.title) : "");

  // --- loading ----------------------------------------------------------------------------
  const load = async () => {
    const address = opts.fromAddress;
    wallet.utxoLabels(address).then((labels) => { state.labels = labels; }).catch(() => {});
    state.coinsUnread = false;
    try {
      const coins = await wallet.utxos(address);
      if (address !== opts.fromAddress) return; // another address was picked meanwhile
      state.coins = coins;
    } catch (error) {
      if (address !== opts.fromAddress) return;
      console.warn("[KaPay] coins unreadable:", error);
      state.coinsUnread = true;
    }
    const currency = (await settings()).currency || "usd";
    state.currency = currency;
    wallet.price(currency).then((p) => { state.price = p; paint(); }).catch(() => {});
    if (opts.source?.kind === "spending" && !state.sourceLabel) {
      vault.readAccounts()
        .then((view) => wallet.spendingState(view.activeAccountId))
        .then((st) => { state.sourceLabel = wallet.labelFor(st, opts.source.index); paint(); })
        .catch(() => {});
    }
    if (opts.compound || state.maxMode) await fillMax(); else await estimate();
    paint();
  };
  const loadChatting = async () => {
    if (state.chatting) return state.chatting;
    try { state.chatting = (await wallet.cachedAddresses((await vault.readAccounts()).activeAccountId))?.main || null; } catch { /* stays unknown */ }
    return state.chatting;
  };

  let estimateTimer = null;
  // Only the newest estimate answers: an older one landing late would put its amount's fee on
  // this one (and Max's own fee is never overwritten by one).
  let estimateSeq = 0;
  const scheduleEstimate = () => {
    clearTimeout(estimateTimer);
    const mine = ++estimateSeq;
    // being worked out from the key on, through the 400 ms wait (iOS isEstimatingFee)
    if (!state.maxMode && !opts.compound) state.estimating = true;
    estimateTimer = setTimeout(() => { if (mine === estimateSeq) estimate().then(paint); }, 400);
  };
  const estimate = async () => {
    if (state.maxMode || opts.compound) return;
    const mine = ++estimateSeq;
    state.estimating = true;
    try {
      const available = spendableSompi();
      let amount = amountSompi();
      if (amount == null || amount <= 0n) amount = 20_000_000n;
      // Never estimate more than the balance: that throws "insufficient" instead of a fee.
      if (available != null && amount >= available) amount = available > 100_000n ? available - 100_000n : 1n;
      const result = await wallet.estimateFee({
        address: opts.fromAddress,
        amountKas: wallet.sompiToKasText(amount),
        selectedOutpoints: selectedOutpoints(),
      });
      if (mine !== estimateSeq) return;
      if (!(result?.policyKas > 0)) throw new Error("No spendable UTXOs");
      state.base = result;
      state.feeError = "";
    } catch (error) {
      if (mine !== estimateSeq) return;
      // no made-up fee: the review says why and the swipe stays off (iOS feeError, KaPay iOS 0799cec)
      state.base = null;
      state.feeError = friendlySendError(error);
    } finally {
      if (mine === estimateSeq) state.estimating = false;
    }
  };

  // Max: the fee for spending EVERY coin Max uses, at the live rate, then amount = spendable -
  // fee exactly, so the send is one output and nothing is left for a dust change output. Worked
  // out again whenever the fee, its speed or the coins change (iOS setMaxAmount). A send's Max is
  // the engine's own plan (the coins at the address now), kept as the pin the slide sends: coins
  // that change before the swipe refuse the send instead of paying a different amount
  // (KaChat-Desktop sendKaspaPinnedMax). Compound keeps every coin and has no pin.
  let maxSeq = 0;
  const fillMax = async () => {
    // what Max can spend: past 80 coins, the largest 80
    const coins = maxCoins();
    if (coins == null) return;
    const available = coins.reduce((sum, c) => sum + c.amount, 0n);
    // a typed amount's estimate still waiting or on its way no longer applies
    clearTimeout(estimateTimer);
    estimateSeq += 1;
    // only the newest Max answers: a fee tapped twice must not leave the first one's pin
    const mine = ++maxSeq;
    state.maxPin = null;
    state.estimating = true;
    state.fillingMax = true;
    paint();
    try {
      const base = await wallet.maxFee(inputCount(), { sourceIndex: opts.source?.kind === "spending" ? opts.source.index : null });
      if (mine !== maxSeq) return;
      state.base = base;
      state.feeError = "";
    } catch (error) {
      if (mine !== maxSeq) return;
      // the amount stays as it was and the swipe stays off (iOS setMaxAmount, KaPay iOS 0799cec)
      state.base = null;
      state.feeError = friendlySendError(error);
      state.estimating = false;
      state.fillingMax = false;
      return;
    }
    const fee = kasNumberToSompi(totalFeeKas());
    let amount = available - fee;
    if (!opts.compound && available > fee) {
      const selection = selectedOutpoints();
      try {
        const plan = await wallet.estimateMax({
          address: opts.fromAddress, destination: state.recipient?.address || null,
          selectedOutpoints: selection, totalFeeKas: wallet.sompiToKasText(fee),
        });
        if (mine !== maxSeq) return;
        state.maxPin = { ...plan, sourceAddress: opts.fromAddress, totalFeeSompi: fee, selectionKey: selectionKey(selection) };
        amount = plan.amountSompi;
      } catch (error) {
        if (mine !== maxSeq) return;
        state.estimating = false;
        state.fillingMax = false;
        state.error = friendlySendError(error);
        setAmountKas("");
        state.maxMode = false;
        return;
      }
    }
    state.estimating = false;
    state.fillingMax = false;
    if (amount <= 0n) {
      state.error = available === 0n && coinsHeld() ? wallet.HELD_COINS_MESSAGE : "Balance too low after network fees.";
      setAmountKas("");
      state.maxMode = false;
      return;
    }
    setAmountKas(wallet.sompiToKasText(amount));
    state.maxMode = true;
    state.error = "";
  };
  const setAmountKas = (kasText) => {
    state.amountText = kasText;
    amountField.setKas(kasText, price());
  };

  // --- the recipient (iOS handleInputChange / resolveKNSDomain, f0f394d) -----------------
  const lookup = recipientLookup({
    read: () => state.recipientInput,
    resolve: (text) => wallet.resolveRecipient(text),
    onChange: (found) => {
      state.recipient = found.recipient;
      state.recipientError = found.error;
      state.resolutions = found.resolutions;
      state.resolving = found.resolving;
      // Nothing for the ending typed, but another service has the name: show it straight away.
      state.othersOpen = Boolean(found.error) && found.resolutions.some((r) => r.address);
      paint();
    },
  });
  const recipientStatus = () => ({
    resolving: state.resolving,
    error: state.recipientError,
    resolvedAddress: state.recipient?.domain ? state.recipient.address : null,
    resolvedName: state.recipient?.domain || null,
    valid: Boolean(state.recipient && !state.recipient.domain),
  });
  const otherDomains = () => (state.resolutions.length
    ? otherDomainsHtml({ resolutions: state.resolutions, selectedTld: state.recipient?.tld || splitTypedName(state.recipientInput).tld, open: state.othersOpen })
    : "");
  /** A new recipient from Paste, Scan QR or Contacts: into the field, looked up at once. */
  const setRecipientText = (text) => {
    state.request = null;
    state.recipientInput = text;
    const input = handle?.el?.querySelector("#recipient");
    if (input) input.value = text;
    lookup.now();
  };

  // --- payment requests (EXT-023, iOS PaymentRequest.found(in:) -> apply, Desktop
  // applyPaymentRequestToSendKaspa): a kachat.app/pay link fills in the address and the exact
  // amount. A chat-payment request is sent as a plain transfer here (the extension has no chats):
  // its memo is shown to you only.
  /** `text` as a payment request link: applied, and true; else false. */
  const applyRequestLink = (text) => {
    const request = parsePaymentRequestLink(text);
    if (!request || opts.compound) return false;
    state.request = request;
    state.recipientInput = request.address;
    const input = handle?.el?.querySelector("#recipient");
    if (input) input.value = request.address;
    // the exact amount is what's sent: the field goes back to KAS for it
    amountField.fiat = false;
    setAmountKas(paymentRequestAmountText(request));
    state.maxMode = false;
    state.error = "";
    lookup.now();
    scheduleEstimate();
    return true;
  };
  const clearRequest = () => {
    state.request = null;
    state.recipientInput = "";
    amountField.reset();
    state.amountText = "";
    state.maxMode = false;
    lookup.now();
  };
  const requestHtml = () => {
    const r = state.request;
    if (!r) return "";
    const saved = r.creator ? entryFor(r.creator) : null;
    const maker = r.creator
      ? `<div class="sk-status good">${ICONS.checkFill}<span>Requested by ${esc(saved ? entryName(saved) : short(r.creator))}</span></div>
         ${r.creator.toLowerCase() !== r.address.toLowerCase() ? '<div class="muted tiny">Signed by their chatting address. The payment goes to the address above.</div>' : ""}`
      : `<div class="sk-status bad">${ICONS.warning || ICONS.xCircle}<span>Not signed: who made this request can't be confirmed.</span></div>`;
    return `
      <div class="sk-card pay-request">
        <div class="sk-label">Requested</div>
        <div class="strong">${esc(`${paymentRequestAmountText(r)} ${KAS_UNIT}`)}</div>
        ${r.memo ? `<div class="small">${esc(r.memo)}</div>` : ""}
        ${r.toChattingAddress ? '<div class="muted tiny">Sent as a plain payment: the memo is for you only.</div>' : ""}
        ${maker}
      </div>`;
  };

  // --- Step 1, To --------------------------------------------------------------------------
  const drawTo = (direction) => {
    const step = showStep({
      screen: "send-to",
      title: screenTitle(),
      question: "Who are you sending to?",
      bodyHtml: `
        ${titleLine()}
        ${recipientCardHtml({ input: state.recipientInput, status: recipientStatus(), extraHtml: otherDomains() })}
        <div id="send-request">${requestHtml()}</div>`,
      onCancel: () => opts.onClose?.(),
      canContinue: () => Boolean(state.recipient) && !state.resolving,
      onContinue: () => go(afterRecipient()),
      direction,
    });
    handle = step;
    const input = step.body.querySelector("#recipient");
    input.oninput = () => {
      if (applyRequestLink(input.value)) return;
      state.recipientInput = input.value;
      // another recipient typed over a request's address: the request no longer applies
      if (state.request && input.value.trim().toLowerCase() !== state.request.address) state.request = null;
      lookup.schedule();
    };
    input.onkeydown = (event) => {
      if (event.key !== "Enter" || event.isComposing || !state.recipient || state.resolving) return;
      event.preventDefault();
      go(afterRecipient());
    };
    step.body.querySelector("#paste").onclick = async () => {
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (applyRequestLink(text)) return;
        setRecipientText(text);
      } catch {
        toast("Clipboard unavailable - paste with ⌘V instead.");
      }
    };
    step.body.querySelector("#scan").onclick = async () => {
      const code = await scanQr({ title: "Scan QR Code", hint: "Point camera at a Kaspa address QR code" });
      if (!code || !here()) return;
      // a KaChat payment request first; else a payment URI's address, without its ?amount=... query
      if (applyRequestLink(String(code))) return;
      setRecipientText(String(code).trim().split("?")[0]);
    };
    bindAddressBookButton(step.body, (address) => setRecipientText(address));
    bindRecipientExtras();
    // The cursor in the field on arrival (iOS focusOnAppear), after what's already there.
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* fine */ }
  };
  const bindRecipientExtras = () => {
    bindOtherDomains(handle.el, {
      onToggle: () => { state.othersOpen = !state.othersOpen; paintRecipient(); },
      onPick: (tld) => {
        const pick = state.resolutions.find((r) => r.tld === tld && r.address);
        if (!pick) return;
        state.recipient = { address: pick.address, domain: pick.display, tld: pick.tld, resolutions: state.resolutions };
        state.recipientError = "";
        state.othersOpen = false;
        paintRecipient();
      },
    });
  };
  const paintRecipient = () => {
    const status = handle.el.querySelector("#recipient-status");
    if (!status) return;
    status.innerHTML = unitText(recipientStatusHtml({ input: state.recipientInput, status: recipientStatus(), extraHtml: otherDomains() }));
    const request = handle.el.querySelector("#send-request");
    if (request) request.innerHTML = unitText(requestHtml());
    bindRecipientExtras();
    handle.refresh();
  };

  // --- Step 2, From: the Chatting Address, or your addresses listed right on the step --------
  let fromList = null;
  const drawFrom = (direction) => {
    const back = backFrom("from");
    const step = showStep({
      screen: "send-from",
      title: screenTitle(),
      question: "Where are you sending from?",
      className: "ss-from-step",
      bodyHtml: `${titleLine()}<div class="ss-review-stack" id="from-choice"></div><div id="from-list"></div>`,
      onBack: back ? () => go(back) : null,
      onCancel: () => opts.onClose?.(),
      canContinue: () => !(state.choosingFrom && isChattingSource()),
      onContinue: () => go("amount"),
      direction,
    });
    handle = step;
    fromList = null;
    paintFromChoice();
    if (state.choosingFrom) showAddressList();
  };
  const paintFromChoice = () => {
    const host = handle.el.querySelector("#from-choice");
    if (!host) return;
    const available = spendableSompi();
    host.innerHTML = unitText(`
      ${choicePillsHtml([
        { id: "from-chatting", title: "Chatting Address", on: !state.choosingFrom },
        { id: "from-choose", title: "Choose an Address", on: state.choosingFrom },
      ])}
      ${state.choosingFrom ? stepNoteHtml("Pick which of your addresses the Kaspa leaves from.") : `
        <div class="sk-card sk-from">
          <div class="sk-from-row">
            <span class="tx-meta"><span class="strong small">Chatting Address</span><span class="mono tiny muted">${esc(state.chatting ? short(state.chatting) : "")}</span></span>
            ${available != null && isChattingSource() ? `<span class="small strong">${esc(`${trimmedKas(available)} ${KAS_UNIT}`)}</span>`
              : state.coinsUnread && isChattingSource() ? `<span class="small muted">${esc(COINS_UNREAD)}</span>` : '<span class="spinner small-spin"></span>'}
          </div>
        </div>`}`);
    host.querySelector("#from-chatting").onclick = () => {
      state.choosingFrom = false;
      hideAddressList();
      switchToChatting();
      paintFromChoice();
    };
    host.querySelector("#from-choose").onclick = () => {
      if (state.choosingFrom) return;
      state.choosingFrom = true;
      paintFromChoice();
      showAddressList();
    };
    handle.refresh();
  };
  const showAddressList = () => {
    const list = handle.el.querySelector("#from-list");
    if (!list) return;
    list.hidden = false;
    fromList = mountOwnAddressList(list, {
      selectedAddress: isChattingSource() ? null : opts.fromAddress,
      onPick: (picked) => {
        if (picked.kind === "spending") {
          switchSource(picked);
          fromList?.setSelected(picked.address);
        } else {
          // the chatting address picked from the list: back on its own pill
          state.choosingFrom = false;
          hideAddressList();
          switchToChatting(picked.address);
        }
        paintFromChoice();
      },
    });
  };
  const hideAddressList = () => {
    const list = handle?.el?.querySelector("#from-list");
    if (list) { list.hidden = true; list.innerHTML = ""; }
    fromList = null;
  };
  /** Fee estimate, Max and coin control follow the new address (coin control resets). */
  const resetForSource = () => {
    // a Max still being worked out for the previous From counts for nothing
    maxSeq += 1;
    // the last address's fee estimate, waiting or on its way, is not this one's
    clearTimeout(estimateTimer);
    estimateSeq += 1;
    state.coins = null;
    state.selected = null;
    state.customFeeKas = null;
    state.maxMode = false;
    state.maxPin = null;
    state.base = null;
    state.feeError = "";
    state.error = "";
    paint();
    load();
  };
  const switchSource = (row) => {
    if (opts.source?.kind === "spending" && row.index === opts.source.index) return;
    opts.source = { kind: "spending", index: row.index };
    opts.fromAddress = row.address;
    state.sourceLabel = row.label;
    resetForSource();
  };
  const switchToChatting = async (known = null) => {
    if (isChattingSource()) return;
    const address = known || (await loadChatting());
    if (!address) return;
    state.chatting = address;
    opts.source = { kind: "main" };
    opts.fromAddress = address;
    state.sourceLabel = null;
    resetForSource();
  };

  // --- Step 3, the amount on the keypad (iOS KaspaKeypadAmountEntry) ----------------------
  const chipsHtml = () => {
    const name = recipientName();
    return stepChipsHtml([
      { label: "To", value: name || state.recipient?.address || state.recipientInput, isAddress: !name },
      { label: "From", value: sourceTitle() },
    ]);
  };
  /** Under the typed amount: what's wrong with it, else what's available. */
  const amountFootnote = () => {
    if (state.coinsUnread) return COINS_UNREAD;
    if (state.error) return state.error;
    if (exceedsBalance()) return coinsHeld() ? wallet.HELD_COINS_MESSAGE : "This is more than the address you're sending from holds.";
    const available = spendableSompi();
    return available != null ? `Available: ${trimmedKas(available)} ${KAS_UNIT}` : "";
  };
  const fiatText = (kas) => (price() ? wallet.formatFiat(kasNumberToSompi(kas), state.price) : "");
  const amountEntryOptions = () => ({
    typed: amountField.display,
    unit: amountField.fiat ? state.currency.toUpperCase() : KAS_UNIT,
    conversion: amountField.conversion(price(), fiatText),
    switchText: amountField.fiat ? KAS_UNIT : state.currency.toUpperCase(),
    canSwitch: price() > 0,
    showsMax: true,
    maxEnabled: Boolean(state.recipient) && state.coins != null,
    estimatingMax: state.fillingMax,
    footnote: amountFootnote(),
    footnoteError: state.coinsUnread || Boolean(state.error) || exceedsBalance(),
  });
  const requestAmountHtml = () => `
    ${reviewAmountHtml({ eyebrow: "You're sending", amountText: `${trimmedKas(amountSompi() ?? 0n)} ${KAS_UNIT}`, fiatText: reviewFiat() })}
    ${requestHtml()}
    ${exceedsBalance() ? '<p class="ss-footnote error">This is more than the address you\'re sending from holds.</p>' : ""}`;
  const drawAmount = (direction) => {
    const back = backFrom("amount");
    const step = showStep({
      screen: "send-amount",
      title: screenTitle(),
      // A request's amount is fixed: no keypad, the request itself instead.
      className: state.request ? "ss-amount-step" : "ss-keypad-step ss-amount-step",
      bodyHtml: `<div id="amount-chips">${chipsHtml()}</div>
        ${state.request ? `<div class="ss-review-stack" id="amount-request">${requestAmountHtml()}</div>` : keypadAmountEntryHtml(amountEntryOptions())}`,
      onBack: back ? () => go(back) : null,
      onCancel: () => opts.onClose?.(),
      continueTitle: "Review",
      canContinue: canReview,
      onContinue: () => go("review"),
      direction,
    });
    handle = step;
    if (!state.request) {
      bindKeypad(step.body, (key) => {
        if (state.request || state.sending) return false;
        const next = applyKeypadKey(key, amountField.display, amountField.fiat ? 2 : 8);
        if (next === amountField.display) return false;
        // A key press stops treating the amount as Max (iOS onKeyTyped).
        state.maxMode = false;
        state.error = "";
        state.amountText = amountField.onInput(next, price());
        scheduleEstimate();
        paintAmount();
        return true;
      });
    }
    bindAmountActions();
  };
  const bindAmountActions = () => {
    const unitSwitch = handle.el.querySelector("#unit-switch");
    if (unitSwitch) unitSwitch.onclick = () => { amountField.toggle(price()); paintAmount(); };
    const max = handle.el.querySelector("#max");
    if (max) max.onclick = async () => { await fillMax(); paint(); };
  };
  const paintAmount = () => {
    const el = handle.el;
    el.querySelector("#amount-chips").innerHTML = unitText(chipsHtml());
    const request = el.querySelector("#amount-request");
    if (request) request.innerHTML = unitText(requestAmountHtml());
    else paintKeypadAmountEntry(el, amountEntryOptions());
    bindAmountActions();
    handle.refresh();
  };

  // --- Step 4, the review: the swipe-up screen ----------------------------------------------
  const feeText = () => {
    const fee = shownFeeSompi();
    return fee == null ? null : `${trimmedKas(fee)} ${KAS_UNIT}`;
  };
  const reviewFiat = () => {
    const sompi = amountSompi();
    return sompi != null && state.price?.price ? wallet.formatFiat(sompi, state.price) : "";
  };
  const reviewHtml = () => {
    const sompi = amountSompi();
    const fee = shownFeeSompi();
    let total = '<span class="muted">—</span>';
    if (sompi != null && sompi > 0n && fee != null && !state.estimating) total = `<strong>${esc(`${trimmedKas(sompi + fee)} ${KAS_UNIT}`)}</strong>`;
    else if (state.estimating) total = '<span class="spinner small-spin"></span>';
    const amountText = sompi != null && sompi > 0n ? `${trimmedKas(sompi)} ${KAS_UNIT}` : (state.estimating || state.coins == null ? null : "—");
    return `
      ${reviewAmountHtml({ eyebrow: opts.compound ? "Consolidating" : "You're sending", amountText, fiatText: reviewFiat() })}
      ${reviewCardHtml([
        reviewRowHtml("To", opts.compound ? "This address (consolidating)" : reviewAddressHtml({ name: recipientName(), address: state.recipient?.address || "" })),
        reviewRowHtml("From", reviewAddressHtml({ name: sourceTitle(), address: opts.fromAddress })),
        reviewRowHtml("Total", total),
      ])}
      ${requestHtml()}
      ${feeControlsHtml({
        tier: state.tier,
        custom: state.customFeeKas != null,
        estimating: state.estimating,
        feeText: feeText(),
        showsCoinControl: !opts.compound,
        coinSummary: coinSummary(state.selected),
        editPill: true,
      })}
      ${state.coinsUnread || state.error || state.feeError ? `<p class="error-text small center-text">${esc(state.coinsUnread ? COINS_UNREAD : (state.error || state.feeError))}</p>` : ""}`;
  };
  const drawReview = (direction) => {
    const back = backFrom("review");
    const swipe = showSwipeUp({
      screen: "send-review",
      title: opts.compound ? "Compound UTXOs" : "Review",
      onBack: back ? () => go(back) : null,
      onCancel: () => opts.onClose?.(),
      barTitle: opts.compound ? "Swipe up to Consolidate" : "Swipe up to Send",
      labels: opts.compound ? SWIPE_UP_LABELS.consolidate : SWIPE_UP_LABELS.send,
      bodyHtml: reviewHtml(),
      enabled: canSend(),
      direction,
      getPreview: () => ({ amountSompi: amountSompi(), recipient: opts.compound ? null : (state.recipient?.domain || state.recipient?.address || null) }),
      getFailureMessage: () => state.error,
      onAction: doSend,
      onDone: () => opts.onClose?.(),
    });
    handle = { el: swipe.body, swipe, refresh() {} };
    bindReview();
  };
  const paintReview = ({ force = false } = {}) => {
    const swipe = handle?.swipe;
    if (!swipe || (swipe.sending && !force)) return;
    swipe.setBody(reviewHtml());
    bindReview();
    swipe.setEnabled(canSend());
  };
  const bindReview = () => {
    const body = handle.el;
    for (const button of body.querySelectorAll("[data-tier]")) {
      button.onclick = async () => {
        state.tier = button.dataset.tier;
        state.customFeeKas = null;
        if (state.maxMode || opts.compound) await fillMax();
        paint();
      };
    }
    const edit = body.querySelector("#fee-edit");
    if (edit) edit.onclick = () => { if (totalFeeSompi() != null) go("fee"); };
    const coins = body.querySelector("#coins");
    if (coins) coins.onclick = () => {
      showCoinControl({
        coins: state.coins || [],
        selected: state.selected,
        labels: state.labels,
        onCancel: () => flow.go("review"),
        onDone: (selection) => {
          state.selected = selection;
          flow.go("review");
          // coins picked anew: a Max amount is worked out again, else the fee
          (state.maxMode ? fillMax() : estimate()).then(paint);
          paint();
        },
      });
    };
  };

  // --- the fee editor (iOS feeStep): the typed total, never under the Normal fee -------------
  const drawFee = (direction) => {
    handle = showFeeEditor({
      screen: "send-fee",
      feeSompi: totalFeeSompi(),
      minimumSompi: normalFeeSompi(),
      direction,
      onCancel: () => go("review"),
      onConfirm: async (sompi) => {
        state.customFeeKas = Number(sompi) / 1e8;
        go("review");
        if (state.maxMode || opts.compound) { await fillMax(); paint(); }
      },
    });
  };

  // --- sending ---------------------------------------------------------------------------
  const doSend = async () => {
    const swipe = handle?.swipe;
    if (!canSend()) {
      // the swipe-up screen shows this as Failed, with Try Again
      state.error = state.error || state.feeError || (totalFeeKas() == null || state.estimating || state.fillingMax ? "Still working out the network fee. Try again in a moment." : "Not enough Kaspa for this amount plus the network fee.");
      return;
    }
    state.sending = true;
    state.error = "";
    swipe?.setBusy(true);
    const fee = totalFeeKas();
    // the From address on the review: a key of any other address (another window switched
    // accounts meanwhile) is refused before anything is built
    const fromAddress = opts.fromAddress;
    try {
      let result;
      if (opts.compound) {
        // past 80 coins, the largest 80 the amount was worked out from, in one transaction
        const chunk = state.coins ? oneTransactionChunk(state.coins) : null;
        result = await wallet.compound(opts.source, fee.toFixed(8), { fromAddress, outpoints: chunk ? chunk.map((c) => c.key) : null });
      } else if (state.maxMode) {
        const pin = state.maxPin;
        if (!maxPinCurrent(pin, { sourceAddress: fromAddress, totalFeeSompi: totalFeeSompi(), selection: selectedOutpoints() }) || pin.amountSompi !== amountSompi()) {
          // worked out for another fee, coin pick or address: never sent as it stands
          const changed = new Error(MAX_AMOUNT_CHANGED_MESSAGE);
          changed.code = MAX_AMOUNT_CHANGED;
          throw changed;
        }
        result = await wallet.send({
          source: opts.source, destination: state.recipient.address, max: true,
          totalFeeKas: fee.toFixed(8), selectedOutpoints: selectedOutpoints(),
          maxAmountSompi: pin.amountSompi, maxOutpoints: pin.outpoints, fromAddress,
        });
      } else {
        const tip = Math.max(0, fee - (state.base?.sdkBaseKas || 0));
        result = await wallet.send({
          source: opts.source, destination: state.recipient.address,
          amountKas: state.amountText, tipKas: tip.toFixed(8), selectedOutpoints: selectedOutpoints(), fromAddress,
        });
      }
      const txid = (result?.txids || [])[result?.txids?.length - 1] || "";
      // the payment is out: whatever the caller does next can't turn it into "Failed"
      try { opts.onSent?.(); } catch (error) { console.warn("[KaPay] after a send:", error); }
      swipe?.setSent({
        txid,
        amountSompi: result?.amountSompi ?? result?.result?.summary?.amountSompi ?? amountSompi(),
        recipient: opts.compound ? null : (state.recipient.domain || state.recipient.address),
        explorerUrl: txid ? wallet.explorerTxUrl(txid) : null,
      });
      swipe?.setBusy(false);
    } catch (error) {
      state.sending = false;
      // the password prompt was cancelled: nothing was sent, the review comes back as it was
      if (error?.code === wallet.SEND_CANCELLED) { swipe?.returnToForm(); return; }
      if (error?.code === MAX_AMOUNT_CHANGED && opts.compound) { compoundChanged(swipe); return; }
      if (error?.code === MAX_AMOUNT_CHANGED) { maxChanged(error, swipe); return; }
      console.warn("[KaPay] send failed:", error);
      state.error = friendlySendError(error);
      swipe?.setBusy(false);
      // Try Again shows the review with the error under the fee.
      if (handle?.swipe === swipe) paintReview({ force: true });
    }
  };

  /** Nothing was sent: one of the coins a Compound was reviewed with is gone. The coins are read
   *  again and the review shows what's there now. */
  const compoundChanged = (swipe) => {
    state.error = MAX_AMOUNT_CHANGED_MESSAGE;
    const address = opts.fromAddress;
    wallet.utxos(address).then((coins) => { if (address === opts.fromAddress) { state.coins = coins; paint(); } }).catch(() => {});
    swipe?.returnToForm();
    if (handle?.swipe === swipe) paintReview({ force: true });
  };

  /** Nothing was sent: Max no longer matched the coins or the fee. The review comes back with the
   *  new amount (the engine's, when it says) and the person slides again. */
  const maxChanged = (error, swipe) => {
    const selection = selectedOutpoints();
    if (Array.isArray(error.outpoints) && error.amountSompi != null && error.amountSompi > 0n) {
      state.maxPin = {
        outpoints: error.outpoints, amountSompi: error.amountSompi, feeSompi: error.feeSompi,
        sourceAddress: opts.fromAddress, totalFeeSompi: totalFeeSompi(), selectionKey: selectionKey(selection),
      };
      setAmountKas(wallet.sompiToKasText(error.amountSompi));
      state.error = MAX_AMOUNT_CHANGED_MESSAGE;
      // the coins behind Available and Coin Control too (the pin above stays the engine's)
      const address = opts.fromAddress;
      wallet.utxos(address).then((coins) => { if (address === opts.fromAddress) { state.coins = coins; paint(); } }).catch(() => {});
    } else {
      // checked here before anything was asked: Max is worked out again for what's on screen now
      fillMax().then(() => { if (state.maxMode) state.error = MAX_AMOUNT_CHANGED_MESSAGE; paint(); });
    }
    swipe?.returnToForm();
    if (handle?.swipe === swipe) paintReview({ force: true });
  };

  // --- start -----------------------------------------------------------------------------
  if (!opts.compound && state.recipientInput) {
    if (applyRequestLink(state.recipientInput)) requestFromLink = true;
    else lookup.now();
  }
  // iOS initialStep: Compound on the review; a request or a pre-filled recipient after To.
  flow.go(opts.compound ? "review" : (state.request || state.recipientInput ? afterRecipient() : "to"));
  load();
  loadChatting().then(() => paint());
  // the recipient card marks one of your own addresses (iOS 56f004f)
  loadOwnAddresses().then((changed) => { if (changed) paint(); });
}

function friendlySendError(error) {
  // word for word: the swipe-up screen knows it by its message and shows "Not confirmed" with only
  // Done, since it may have gone through (KaPay 953b255)
  if (error?.code === SEND_OUTCOME_UNKNOWN) return SEND_OUTCOME_UNKNOWN_MESSAGE;
  const message = String(error?.message || error || "");
  if (/storage mass/i.test(message)) return "This amount can't be sent from these coins without leaving a tiny change output the network rejects. Try a slightly different amount, or Compound UTXOs first.";
  if (/insufficient/i.test(message)) return "Not enough Kaspa for this amount plus the network fee.";
  if (/not connected|timed out|timeout/i.test(message)) return "Couldn't reach the Kaspa network. Try again in a moment.";
  return message || "Send failed.";
}

// --- Coin Control: iOS CoinControlView --------------------------------------------------------

export function showCoinControl({ coins, selected, labels = {}, onCancel, onDone }) {
  const picked = new Set(selected || []);
  let menuOpen = false;
  const paint = () => {
    const total = coins.filter((c) => picked.has(c.key)).reduce((sum, c) => sum + c.amount, 0n);
    render(`
      <header class="navbar form-bar">
        <button class="bar-text" id="cancel">Cancel</button>
        <div class="nav-title">Coin Control</div>
        <button class="icon plain nav-menu accent" id="menu" aria-label="More">${ICONS.ellipsis}</button>
      </header>
      ${menuOpen ? `
        <div class="menu-sheet" role="menu">
          <button class="menu-item" id="select-all"><span>Select All</span></button>
          <button class="menu-item" id="clear"><span>Automatic (Clear Selection)</span></button>
        </div>` : ""}
      <section class="form">
        <div class="form-section">
          <div class="form-card">
            ${coins.length ? coins.map((coin) => `
              <button class="form-row coin" data-key="${esc(coin.key)}" role="checkbox" aria-checked="${picked.has(coin.key)}">
                <span class="${picked.has(coin.key) ? "accent" : "muted"}">${picked.has(coin.key) ? ICONS.circleCheck : ICONS.circle}</span>
                <span class="coin-meta">
                  ${labels[coin.key] ? `<span class="accent tiny strong">${esc(labels[coin.key])}</span>` : ""}
                  <span class="coin-amount">${esc(formatKas8(coin.amount))} KAS</span>
                  <span class="mono tiny muted">${esc(coin.transactionId.slice(0, 10))}...:${coin.index}</span>
                </span>
              </button>`).join("") : '<div class="form-row muted">No UTXOs found at this address.</div>'}
          </div>
          ${picked.size ? `<div class="form-footer">Selected: ${esc(formatKas8(total))} KAS (${picked.size} UTXO${picked.size === 1 ? "" : "s"})</div>` : ""}
        </div>
      </section>
      <div class="ios-bottom-bar"><button class="ios-capsule" id="confirm">${picked.size ? "Confirm Selection" : "Use Automatic Selection"}</button></div>`, "coins");
    $("#cancel").onclick = onCancel;
    $("#menu").onclick = () => { menuOpen = !menuOpen; paint(); };
    const selectAll = $("#select-all");
    if (selectAll) selectAll.onclick = () => { for (const c of coins) picked.add(c.key); menuOpen = false; paint(); };
    const clear = $("#clear");
    if (clear) clear.onclick = () => { picked.clear(); menuOpen = false; paint(); };
    $("#confirm").onclick = () => onDone(picked.size ? new Set(picked) : null);
    for (const row of app.querySelectorAll(".coin")) {
      row.onclick = () => {
        const key = row.dataset.key;
        if (picked.has(key)) picked.delete(key); else picked.add(key);
        paint();
      };
    }
  };
  paint();
}
