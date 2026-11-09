// Send from Cold Storage - iOS ColdSendFlowView in steps (KaPay iOS 05db583, f0f394d), built from
// the step screens (send-steps.js) and the Send Kaspa pieces (send-pieces.js), as Send Kaspa is:
//   To      "Who are you sending to?": the recipient card (an address or a name on any service,
//           resolved as you type - recipientLookup, f0f394d - with "Other domains"; the Paste,
//           Scan QR and Contacts pills, 8118f09).
//   Amount  the app's own keypad: the "To" / "From Cold Storage" chips, KAS or your currency, Max,
//           and the address's Available under it.
//   Review  the amount, To / From / Total; only the fee (its Edit opens the fee editor) and Coin
//           Control change. Ends in Build Unsigned Transaction - a tap, not a swipe: building
//           moves nothing.
//   Sign with KasSigner  the animated KSPT QR (2.5 s a frame) on its own white card; Scan Signed
//           Transaction opens the scanner, and closing it without a scan returns to the QR.
//   Signed  "Signed by KasSigner", the summary, and swipe up to send (59593af): the BlockDAG, then
//           Sent, or Failed with Try Again - still signed, so it goes out again with no new signing -
//           or "Not confirmed" with only Done when the network never answered (KaPay 953b255).
// Compound UTXOs (the recipient locked to the address itself, the largest KasSigner can sign at
// once, Max) opens on the review. A build that fails, or a scan that isn't a signed transaction,
// shows Something Went Wrong with Try Again back on the review.
//
// No private key is ever involved: the transaction is built unsigned (shared/ui/kspt.js, the same
// engine the desktop app and iOS use), signed on the device, and checked against what was sent for
// signing before it is broadcast.
//
// Fee math (iOS): the reference mass is 1 input / two 34-byte outputs (2036), or the coin-control
// set's own mass; the base rate is the live quote (fetched once) or the 100 sompi/gram floor; the
// default fee is mass x rate; Fast / Priority add 1x / 4x the default on top, a custom fee adds
// what it is above the default (below it adds nothing). The fee shown is the automatic-selection
// preview's exact fee when there is one; the build gets that preview's UTXO set and the same rate,
// so the fee shown and the fee paid are the same number.

import QRCode from "qrcode";
import * as wallet from "./wallet.js";
import { app, esc, toast, settings, unitText } from "./ui.js";
import { otherDomainsHtml, bindOtherDomains, splitTypedName } from "./names.js";
import { scanQr } from "./camera.js";
import { showCoinControl, heldCoinReason } from "./send.js";
import { loadOwnAddresses } from "./own-addresses.js";
import { SF } from "./cold-common.js";
import { KAS_UNIT } from "./net.js";
import { sompiFromUserText } from "./amounts.js";
import { coldRecipientMassError } from "./send-guards.js";
import { logWarn } from "./log.js";
import { SEND_OUTCOME_UNKNOWN } from "../shared/engine/transactions.js";
import {
  recipientCardHtml, recipientStatusHtml, recipientLookup, bindAddressBookButton, amountState, feeControlsHtml, trimmedKas,
} from "./send-pieces.js";
import {
  createStepFlow, showStep, showSwipeUp, showFeeEditor, SWIPE_UP_LABELS, stepQuestionHtml, stepChipsHtml, bindKeypad,
  applyKeypadKey, keypadAmountEntryHtml, paintKeypadAmountEntry, reviewAmountHtml, reviewRowHtml, reviewAddressHtml,
  reviewCardHtml,
} from "./send-steps.js";
import {
  KSPT_MAX_INPUTS, MIN_RELAY_FEE_PER_GRAM, REFERENCE_MASS_FOR_FEE_EDITOR, calculateMass, calculateFee,
  fetchQuotedFeeRateSompiPerGram, previewAutomaticSelection, estimateMaxAmount, compoundInputs,
  buildUnsignedTransaction, unsignedToKsptBytes, chunkQrFrames, QrFrameAccumulator, looksLikeKspt,
  decodeKspt, broadcastSigned,
} from "../shared/ui/kspt.js";

const TIERS = [["normal", "Normal", 1n], ["fast", "Fast", 2n], ["priority", "Priority", 5n]];
// The order the screens slide by: a later one comes in from the right, an earlier from the left.
const ORDER = ["to", "amount", "review", "fee", "qr", "signed", "failed"];

/**
 * @param {object} opts
 * @param {string} opts.fromAddress
 * @param {bigint} opts.availableSompi
 * @param {boolean} [opts.compound]
 * @param {Function} opts.onClose   Cancel
 * @param {Function} opts.onDone    Done once it was sent (refresh the address)
 */
export function showColdSend(opts) {
  const from = opts.fromAddress;
  const compound = Boolean(opts.compound);
  const s = {
    toInput: compound ? from : "",
    recipient: compound ? { address: from, domain: null, tld: null } : null, // { address, domain, tld }
    recipientError: "",
    resolving: false,
    resolutions: [],
    othersOpen: false,
    amountText: "",
    maxMode: false,
    estimatingMax: false,
    tier: "normal",
    customExtra: null,      // bigint sompi above the default, or null
    liveRate: null,         // bigint sompi/gram
    preview: null,          // { utxoKeys, feeSompi }
    manualKeys: null,       // coin control / compound's fixed set
    compoundHasMore: false,
    price: null,
    currency: "usd",
    building: false,
    // What was built, signed and sent - the QR and signed screens show these, not the form.
    unsigned: null,
    frames: [],
    frameIndex: 0,
    playing: true,
    builtAmount: null,
    builtRecipient: null,   // { address, name }
    decoded: null,
    broadcasting: false,
    sent: false,
    broadcastError: "",
    error: "",              // Something Went Wrong
  };
  // The amount (KAS or your currency) - iOS KaspaFiatAmountState.
  const amountField = amountState();
  let engine = null;
  const getEngine = async () => (engine ||= await wallet.ksptEngine());
  let closed = false;

  // --- derived ----------------------------------------------------------------------------
  const amountSompi = () => {
    const exact = sompiFromUserText(s.amountText);
    return exact != null && exact > 0n ? exact : null;
  };
  const effectiveAddress = () => s.recipient?.address || s.toInput.trim();
  const hasValidRecipient = () => Boolean(s.recipient) && !s.resolving;
  const canBuild = () => hasValidRecipient() && amountSompi() != null;
  const exceedsBalance = () => {
    const amount = amountSompi();
    return amount != null && amount > BigInt(opts.availableSompi ?? 0n);
  };
  const referenceMass = () => (s.manualKeys?.length ? calculateMass(s.manualKeys.length, [34, 34], 0) : REFERENCE_MASS_FOR_FEE_EDITOR);
  const baseRate = () => s.liveRate ?? MIN_RELAY_FEE_PER_GRAM;
  const defaultFee = () => calculateFee(referenceMass(), baseRate());
  const extraFee = () => (s.customExtra != null ? s.customExtra : defaultFee() * ((TIERS.find((t) => t[0] === s.tier)?.[2] || 1n) - 1n));
  const effectiveFee = () => (!s.manualKeys && s.preview ? s.preview.feeSompi : defaultFee() + extraFee());
  const feeRateOverride = () => {
    if (s.tier === "normal" && s.customExtra == null) return baseRate();
    const mass = referenceMass();
    return (defaultFee() + extraFee() + mass - 1n) / mass;
  };
  const price = () => s.price?.price || 0;
  const kasText = (sompi) => `${trimmedKas(sompi)} ${KAS_UNIT}`;
  const screenTitle = compound ? "Compound UTXOs" : "Send from Cold Storage";

  // --- the steps ----------------------------------------------------------------------------
  let handle = null; // the step on screen: { el, refresh } (the signed screen adds `swipe`)
  const flow = createStepFlow(ORDER, (id, direction) => {
    handle = null;
    if (id !== "qr") stopTimer();
    if (id === "to") drawTo(direction);
    else if (id === "amount") drawAmount(direction);
    else if (id === "review") drawReview(direction);
    else if (id === "fee") drawFee(direction);
    else if (id === "qr") drawQr(direction);
    else if (id === "signed") drawSigned(direction);
    else if (id === "failed") drawFailed(direction);
  });
  const go = (id) => { if (!closed) flow.go(id); };
  const here = () => !closed && Boolean(handle?.el?.isConnected);
  /** Redraws what changed on the step showing (a lookup, a fee, the price arriving). */
  const paint = () => {
    if (!here()) return;
    const id = flow.current;
    if (id === "to") paintRecipient();
    else if (id === "amount") paintAmount();
    else if (id === "review") paintReview();
  };
  const close = (then) => {
    closed = true;
    stopTimer();
    clearTimeout(previewTimer);
    lookup.cancel();
    then?.();
  };
  const cancel = () => close(opts.onClose);

  // --- preview / max ------------------------------------------------------------------------
  let previewTimer = null;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    s.preview = null;
    const amount = amountSompi();
    if (s.manualKeys || amount == null) return;
    const rate = feeRateOverride();
    previewTimer = setTimeout(async () => {
      const preview = await previewAutomaticSelection({ engine: await getEngine(), fromAddress: from, amountSompi: amount, feeRateSompiPerGram: rate }).catch(() => null);
      if (closed || amountSompi() !== amount || feeRateOverride() !== rate || s.manualKeys) return;
      s.preview = preview;
      paint();
    }, 400);
  };

  const setMax = async () => {
    if (!hasValidRecipient() || s.estimatingMax) return;
    s.estimatingMax = true;
    paint();
    try {
      const max = await estimateMaxAmount({ engine: await getEngine(), fromAddress: from, feeRateOverride: feeRateOverride(), manualUtxoKeys: s.manualKeys });
      s.amountText = trimmedKas(max);
      amountField.setKas(s.amountText, price());
      s.maxMode = true;
    } catch { /* the amount stays as it was */ }
    s.estimatingMax = false;
    schedulePreview();
    paint();
  };

  // A fee change after Max keeps Max true to the new fee (the amount is the balance less the fee).
  const feeChanged = () => {
    schedulePreview();
    if (s.maxMode) setMax(); else paint();
  };

  // --- the recipient (iOS handleInputChange / resolveKNSDomain, f0f394d) -----------------
  const lookup = recipientLookup({
    read: () => s.toInput,
    resolve: (text) => wallet.resolveRecipient(text),
    onChange: (found) => {
      s.recipient = found.recipient;
      s.recipientError = found.error;
      s.resolutions = found.resolutions;
      s.resolving = found.resolving;
      // Nothing for the ending typed, but another service has the name: show it straight away.
      s.othersOpen = Boolean(found.error) && found.resolutions.some((r) => r.address);
      paint();
    },
  });
  const recipientStatus = () => ({
    resolving: s.resolving,
    error: s.recipientError,
    resolvedAddress: s.recipient?.domain ? s.recipient.address : null,
    resolvedName: s.recipient?.domain || null,
    valid: Boolean(s.recipient && !s.recipient.domain),
  });
  const otherDomains = () => (s.resolutions.length
    ? otherDomainsHtml({ resolutions: s.resolutions, selectedTld: s.recipient?.tld || splitTypedName(s.toInput).tld, open: s.othersOpen })
    : "");
  /** A recipient from Paste, Scan QR or Contacts: into the field, looked up at once. */
  const setRecipientText = (text) => {
    s.toInput = text;
    const input = handle?.el?.querySelector("#recipient");
    if (input) input.value = text;
    lookup.now();
  };

  // --- Step 1, To ----------------------------------------------------------------------------
  const drawTo = (direction) => {
    const step = showStep({
      screen: "cold-send-to",
      title: screenTitle,
      question: "Who are you sending to?",
      bodyHtml: recipientCardHtml({ input: s.toInput, status: recipientStatus(), extraHtml: otherDomains() }),
      onCancel: cancel,
      canContinue: hasValidRecipient,
      onContinue: () => go("amount"),
      direction,
    });
    handle = step;
    const input = step.body.querySelector("#recipient");
    input.oninput = () => {
      s.toInput = input.value;
      lookup.schedule();
    };
    input.onkeydown = (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      if (hasValidRecipient()) go("amount");
    };
    step.body.querySelector("#paste").onclick = async () => {
      try {
        setRecipientText((await navigator.clipboard.readText()).trim());
      } catch {
        toast("Clipboard unavailable - paste with ⌘V instead.");
      }
    };
    step.body.querySelector("#scan").onclick = async () => {
      const code = await scanQr({ title: "Scan QR Code", hint: "Point camera at a QR code" });
      if (!code || !here()) return;
      // a payment URI's address, without its ?amount=... query
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
      onToggle: () => { s.othersOpen = !s.othersOpen; paintRecipient(); },
      onPick: (tld) => {
        const pick = s.resolutions.find((r) => r.tld === tld && r.address);
        if (!pick) return;
        s.recipient = { address: pick.address, domain: pick.display, tld: pick.tld };
        s.recipientError = "";
        s.othersOpen = false;
        paintRecipient();
      },
    });
  };
  const paintRecipient = () => {
    const status = handle.el.querySelector("#recipient-status");
    if (!status) return;
    status.innerHTML = unitText(recipientStatusHtml({ input: s.toInput, status: recipientStatus(), extraHtml: otherDomains() }));
    bindRecipientExtras();
    handle.refresh();
  };

  // --- Step 2, the amount on the keypad (iOS KaspaKeypadAmountEntry) ------------------------
  const chipsHtml = () => stepChipsHtml([
    { label: "To", value: s.recipient?.domain || effectiveAddress(), isAddress: !s.recipient?.domain },
    { label: "From", value: "Cold Storage" },
  ]);
  const fiatText = (kas) => (price() ? wallet.formatFiat(wallet.kasToSompi(kas.toFixed(8)), s.price) : "");
  const amountEntryOptions = () => ({
    typed: amountField.display,
    unit: amountField.fiat ? s.currency.toUpperCase() : KAS_UNIT,
    conversion: amountField.conversion(price(), fiatText),
    switchText: amountField.fiat ? KAS_UNIT : s.currency.toUpperCase(),
    canSwitch: price() > 0,
    showsMax: true,
    maxEnabled: hasValidRecipient(),
    estimatingMax: s.estimatingMax,
    footnote: exceedsBalance()
      ? "This is more than the address you're sending from holds."
      : `Available: ${kasText(opts.availableSompi ?? 0n)}`,
    footnoteError: exceedsBalance(),
  });
  const canReview = () => canBuild() && !exceedsBalance() && !s.estimatingMax;
  const drawAmount = (direction) => {
    const step = showStep({
      screen: "cold-send-amount",
      title: screenTitle,
      className: "ss-keypad-step ss-amount-step",
      bodyHtml: `<div id="amount-chips">${chipsHtml()}</div>${keypadAmountEntryHtml(amountEntryOptions())}`,
      onBack: () => go("to"),
      onCancel: cancel,
      continueTitle: "Review",
      canContinue: canReview,
      onContinue: () => go("review"),
      direction,
    });
    handle = step;
    bindKeypad(step.body, (key) => {
      const next = applyKeypadKey(key, amountField.display, amountField.fiat ? 2 : 8);
      if (next === amountField.display) return false;
      // A key press stops treating the amount as Max (iOS onKeyTyped).
      s.maxMode = false;
      s.amountText = amountField.onInput(next, price());
      schedulePreview();
      paintAmount();
      return true;
    });
    bindAmountActions();
  };
  const bindAmountActions = () => {
    const unitSwitch = handle.el.querySelector("#unit-switch");
    if (unitSwitch) unitSwitch.onclick = () => { amountField.toggle(price()); paintAmount(); };
    const max = handle.el.querySelector("#max");
    if (max) max.onclick = setMax;
  };
  const paintAmount = () => {
    handle.el.querySelector("#amount-chips").innerHTML = unitText(chipsHtml());
    paintKeypadAmountEntry(handle.el, amountEntryOptions());
    bindAmountActions();
    handle.refresh();
  };

  // --- Step 3, the review: Build Unsigned Transaction -------------------------------------------
  const compoundNoteHtml = () => (compound ? `<p class="cold-step-note">${s.compoundHasMore
    ? `This address has more than ${KSPT_MAX_INPUTS} UTXOs. KasSigner can sign at most ${KSPT_MAX_INPUTS} inputs per transaction, so this merges the largest ${KSPT_MAX_INPUTS} into one. Run Compound again afterward to keep combining the rest.`
    : "Merges all of this address's UTXOs into a single one, so future sends need fewer inputs."}</p>` : "");
  const toRowHtml = (recipient) => (compound
    ? esc("This address (consolidating)")
    : reviewAddressHtml({ name: recipient?.name || null, address: recipient?.address || "" }));
  const fromRowHtml = () => reviewAddressHtml({ name: "Cold Storage", address: from });
  const reviewHtml = () => {
    const amount = amountSompi();
    const fee = effectiveFee();
    const total = amount != null ? `<strong>${esc(`~${kasText(amount + fee)}`)}</strong>` : '<span class="muted">—</span>';
    return `
      ${reviewAmountHtml({ eyebrow: compound ? "Consolidating" : "You're sending", amountText: amount != null ? kasText(amount) : null })}
      ${reviewCardHtml([
        reviewRowHtml("To", toRowHtml({ name: s.recipient?.domain, address: effectiveAddress() })),
        reviewRowHtml("From", fromRowHtml()),
        reviewRowHtml("Total", total),
      ])}
      ${compoundNoteHtml()}
      ${feeControlsHtml({
        tier: s.tier,
        custom: s.customExtra != null,
        feeText: `~${kasText(fee)}`,
        // Compound manages its own input set (the largest KasSigner can sign at once).
        showsCoinControl: !compound,
        coinSummary: s.manualKeys ? `${s.manualKeys.length} UTXO${s.manualKeys.length === 1 ? "" : "s"} selected` : "Automatic",
        editPill: true,
      })}`;
  };
  const drawReview = (direction) => {
    const step = showStep({
      screen: "cold-send-review",
      title: compound ? "Compound UTXOs" : "Review",
      className: "cold-review-step",
      bodyHtml: `<div class="ss-review-stack" id="cold-review">${reviewHtml()}</div>`,
      onBack: compound ? null : () => go("amount"),
      onCancel: cancel,
      // A tap, not a swipe: this only builds the transaction for KasSigner to sign.
      continueTitle: () => (s.building ? "Building..." : "Build Unsigned Transaction"),
      canContinue: () => canBuild() && !s.building && !s.estimatingMax,
      onContinue: build,
      direction,
    });
    handle = step;
    bindReview();
  };
  const paintReview = () => {
    const host = handle.el.querySelector("#cold-review");
    if (!host) return;
    host.innerHTML = unitText(reviewHtml());
    bindReview();
    handle.refresh();
  };
  const bindReview = () => {
    const body = handle.el;
    for (const button of body.querySelectorAll("[data-tier]")) {
      button.onclick = () => {
        if (s.building) return;
        s.tier = button.dataset.tier;
        s.customExtra = null;
        feeChanged();
      };
    }
    const edit = body.querySelector("#fee-edit");
    if (edit) edit.onclick = () => { if (!s.building) go("fee"); };
    const coins = body.querySelector("#coins");
    if (coins) coins.onclick = openCoinControl;
  };
  const openCoinControl = async () => {
    if (s.building) return;
    let list;
    try {
      // the coins the last broadcast spent too, greyed out (KaPay iOS 1652437)
      list = await wallet.utxos(from, { withHeld: true });
    } catch (error) {
      toast(error.message || "Could not read this address's UTXOs.");
      return;
    }
    const labels = await wallet.utxoLabels(from).catch(() => ({}));
    if (!here() || flow.current !== "review") return;
    const live = new Set(list.filter((c) => !c.held).map((c) => c.key));
    handle = null;
    showCoinControl({
      coins: list,
      unavailable: heldCoinReason,
      selected: s.manualKeys ? new Set(s.manualKeys.filter((k) => live.has(k))) : null,
      labels,
      onCancel: () => go("review"),
      onDone: (selection) => {
        s.manualKeys = selection ? [...selection] : null;
        go("review");
        feeChanged();
      },
    });
  };

  // --- the fee editor (iOS feeStep): the typed total, never under the network's minimum -------
  const drawFee = (direction) => {
    handle = showFeeEditor({
      screen: "cold-send-fee",
      feeSompi: effectiveFee(),
      minimumSompi: defaultFee(),
      direction,
      onCancel: () => go("review"),
      onConfirm: (typed) => {
        const base = defaultFee();
        // Below the default adds nothing (iOS commitCustomFee).
        s.customExtra = typed > base ? typed - base : 0n;
        go("review");
        feeChanged();
      },
    });
  };

  // --- build ------------------------------------------------------------------------------------
  const build = async () => {
    const amount = amountSompi();
    if (!canBuild() || s.building) return;
    s.building = true;
    handle?.refresh();
    const toAddress = effectiveAddress();
    try {
      const unsigned = await buildUnsignedTransaction({
        engine: await getEngine(),
        fromAddress: from,
        toAddress,
        amountSompi: amount,
        feeRateOverride: feeRateOverride(),
        manualUtxoKeys: s.manualKeys ?? s.preview?.utxoKeys ?? null,
      });
      if (closed) return;
      // no change output: the recipient's alone must fit the storage-mass budget, or the node would
      // refuse what KasSigner signs (KaPay iOS 0799cec) - refused before the QR is shown
      const massError = coldRecipientMassError(unsigned);
      if (massError) throw massError;
      s.building = false;
      // Left the review while it built: nothing to show it on.
      if (flow.current !== "review") return;
      s.unsigned = unsigned;
      s.frames = chunkQrFrames(unsignedToKsptBytes(unsigned));
      s.frameIndex = 0;
      s.playing = true;
      // what the recipient output carries: a Max Send may be trimmed by up to 2000 sompi of leeway
      // for the fee, so the QR, Signed and Sent screens show the built amount, not the typed one
      s.builtAmount = BigInt(unsigned.finalAmountSompi ?? amount);
      s.builtRecipient = { address: toAddress, name: compound ? null : (s.recipient?.domain || null) };
      s.decoded = null;
      go("qr");
    } catch (error) {
      if (closed) return;
      s.building = false;
      fail(error);
    }
  };

  const fail = (error) => {
    s.error = String(error?.message || error || "");
    go("failed");
  };

  /** To, From, the fee and the total, as built (iOS summaryCard). */
  const summaryCardHtml = () => {
    const fee = BigInt(s.unsigned?.feeSompi ?? 0n);
    return reviewCardHtml([
      reviewRowHtml("To", toRowHtml(s.builtRecipient)),
      reviewRowHtml("From", fromRowHtml()),
      reviewRowHtml("Network Fee", esc(kasText(fee))),
      ...(s.builtAmount != null ? [reviewRowHtml("Total", `<strong>${esc(kasText(s.builtAmount + fee))}</strong>`)] : []),
    ]);
  };

  // --- Step 4, Sign with KasSigner: the animated QR ------------------------------------------------
  const drawQr = (direction) => {
    const many = s.frames.length > 1;
    const folded = s.unsigned.foldedChangeSompi > 0n;
    const step = showStep({
      screen: "cold-send-qr",
      title: "Sign with KasSigner",
      className: "cold-qr-step",
      bodyHtml: `
        ${stepQuestionHtml("Scan this on your KasSigner")}
        <div class="cold-qr-panel">
          <div class="cold-sign-frame"><canvas id="kspt-qr" width="560" height="560" aria-label="Unsigned transaction QR"></canvas></div>
          ${many ? `
            <div class="cold-frame-dots">${s.frames.map((_, i) => `<span data-dot="${i}" class="${i === s.frameIndex ? "on" : ""}"></span>`).join("")}</div>
            <div class="cold-frame-controls">
              <button type="button" class="icon plain" id="frame-prev" aria-label="Previous frame">${SF.backwardFrame}</button>
              <button type="button" class="icon plain" id="frame-play" aria-label="${s.playing ? "Pause" : "Play"}">${s.playing ? SF.pauseFill : SF.playFill}</button>
              <button type="button" class="icon plain" id="frame-next" aria-label="Next frame">${SF.forwardFrame}</button>
            </div>
            <div class="cold-frame-counter" id="frame-counter">Frame ${s.frameIndex + 1} / ${s.frames.length}</div>` : ""}
        </div>
        <p class="cold-step-note">KasSigner shows what it is signing. Check it matches, sign, then scan the signed transaction it shows.</p>
        ${folded ? `
          <p class="cold-fee-warning" role="note">This fee includes ${esc(kasText(s.unsigned.foldedChangeSompi))} of change that is too small for the network to accept as its own output, so it goes to the network instead of back to this address.</p>` : ""}
        ${summaryCardHtml()}`,
      onBack: () => go("review"),
      onCancel: cancel,
      continueTitle: "Scan Signed Transaction",
      onContinue: scanSigned,
      direction,
    });
    handle = step;
    if (many) {
      step.body.querySelector("#frame-prev").onclick = () => { s.frameIndex = (s.frameIndex - 1 + s.frames.length) % s.frames.length; drawFrame(); };
      step.body.querySelector("#frame-next").onclick = () => { s.frameIndex = (s.frameIndex + 1) % s.frames.length; drawFrame(); };
      step.body.querySelector("#frame-play").onclick = (event) => {
        s.playing = !s.playing;
        const button = event.currentTarget;
        button.innerHTML = s.playing ? SF.pauseFill : SF.playFill;
        button.setAttribute("aria-label", s.playing ? "Pause" : "Play");
      };
    }
    drawFrame();
    startTimer();
  };

  let timer = null;
  const stopTimer = () => { clearInterval(timer); timer = null; };
  const startTimer = () => {
    stopTimer();
    if (s.frames.length <= 1) return;
    timer = setInterval(() => {
      if (closed || flow.current !== "qr" || app.dataset.screen !== "cold-send-qr") { stopTimer(); return; }
      // held while paused, and while the scanner is up over it
      if (!s.playing || document.querySelector(".scanner")) return;
      s.frameIndex = (s.frameIndex + 1) % s.frames.length;
      drawFrame();
    }, 2500);
  };
  const drawFrame = async () => {
    const canvas = app.querySelector("#kspt-qr");
    const frame = s.frames[s.frameIndex];
    if (!canvas || !frame) return;
    try {
      await QRCode.toCanvas(canvas, [{ data: frame, mode: "byte" }], {
        errorCorrectionLevel: "M", margin: 1, width: 560, color: { dark: "#000000", light: "#ffffff" },
      });
    } catch (error) {
      logWarn("[KaPay] KSPT QR failed:", error);
    }
    canvas.style.width = "";
    canvas.style.height = "";
    for (const dot of app.querySelectorAll("[data-dot]")) dot.classList.toggle("on", Number(dot.dataset.dot) === s.frameIndex);
    const counter = app.querySelector("#frame-counter");
    if (counter) counter.textContent = `Frame ${s.frameIndex + 1} / ${s.frames.length}`;
  };

  // The scanner opens over the QR; closed without a scan, the QR is still there (iOS
  // isScanningSignedResponse: back on .showingQR).
  const scanSigned = async () => {
    const accumulator = new QrFrameAccumulator(looksLikeKspt);
    const bytes = await scanQr({
      title: "Scan Signed Transaction",
      hint: "Point camera at the KasSigner screen",
      onBinaryFrame: (frame) => {
        const complete = accumulator.addFrame(frame);
        const progress = accumulator.progress;
        return { complete, progress: progress ? { ...progress, indices: [...accumulator.receivedFrameIndices] } : null };
      },
    });
    if (closed || !bytes || flow.current !== "qr") return;
    let decoded;
    try {
      decoded = decodeKspt(bytes);
      // The unsigned QR scanned back is not "Signed by KasSigner".
      if (!decoded.signed) throw new Error("Scanned transaction is not signed");
    } catch (error) {
      fail(error);
      return;
    }
    s.decoded = decoded;
    s.broadcasting = false;
    s.sent = false;
    s.broadcastError = "";
    go("signed");
  };

  // --- Step 5, signed: swipe up to send (iOS signedStep) ----------------------------------------------
  const signedHtml = () => `
    <div class="cold-signed-badge">${SF.checkSealFill}<span>Signed by KasSigner</span></div>
    ${reviewAmountHtml({ eyebrow: compound ? "Consolidating" : "You're sending", amountText: s.builtAmount != null ? kasText(s.builtAmount) : "—" })}
    ${summaryCardHtml()}
    <p class="cold-step-note">Nothing can change now: this is the transaction KasSigner signed.</p>`;
  const builtRecipientText = () => (compound ? null : (s.builtRecipient?.name || s.builtRecipient?.address || null));
  const drawSigned = (direction) => {
    const swipe = showSwipeUp({
      screen: "cold-send-signed",
      title: screenTitle,
      onBack: () => go("qr"),
      onCancel: cancel,
      barTitle: compound ? "Swipe up to Consolidate" : "Swipe up to Send",
      labels: compound ? SWIPE_UP_LABELS.consolidate : SWIPE_UP_LABELS.send,
      bodyHtml: signedHtml(),
      enabled: Boolean(s.decoded) && !s.sent,
      direction,
      getPreview: () => ({ amountSompi: s.builtAmount, recipient: builtRecipientText() }),
      getFailureMessage: () => s.broadcastError,
      onAction: broadcast,
      onDone: () => close(opts.onDone),
    });
    handle = { el: swipe.body, swipe, refresh() {} };
  };

  /** The swipe let go (iOS broadcast): the signed transaction goes out, checked against what was
   *  sent for signing first. A failure leaves it signed: Try Again sends the same one again. One
   *  the network never confirmed keeps SEND_OUTCOME_UNKNOWN's message word for word, which the
   *  swipe-up screen shows as "Not confirmed" with only Done (KaPay 953b255). */
  const broadcast = async () => {
    const swipe = handle?.swipe;
    if (!s.decoded || !s.unsigned || s.broadcasting || s.sent) return;
    s.broadcasting = true;
    s.broadcastError = "";
    swipe?.setBusy(true);
    // every node-pool submit holds its coins, Cold Storage's too (KaPay iOS 1652437): out of the
    // next Cold Storage build for two minutes, not after "Not confirmed" (KaPay iOS 2da5f4b)
    const spends = (s.unsigned.inputs || []).map((input) => `${input.prevTxId}:${input.prevIndex}`);
    try {
      const txid = String(await broadcastSigned({ engine: await getEngine(), unsigned: s.unsigned, decoded: s.decoded }) || "");
      await wallet.holdSubmittedCoins(spends, from);
      if (closed) return;
      s.broadcasting = false;
      s.sent = true;
      swipe?.setSent({
        txid,
        amountSompi: compound ? null : s.builtAmount,
        recipient: builtRecipientText(),
        explorerUrl: txid ? wallet.explorerTxUrl(txid) : null,
      });
      swipe?.setBusy(false);
      swipe?.setEnabled(false);
    } catch (error) {
      if (error?.code === SEND_OUTCOME_UNKNOWN) wallet.releaseNotConfirmedCoins();
      if (closed) return;
      logWarn("[KaPay] cold broadcast failed:", error);
      s.broadcasting = false;
      s.broadcastError = String(error?.message || error || "");
      swipe?.setBusy(false);
    }
  };

  // --- Something Went Wrong (iOS failedView): Try Again back on the review as it was -------------------
  const drawFailed = (direction) => {
    handle = showStep({
      screen: "cold-send-failed",
      title: screenTitle,
      className: "cold-failed-step",
      bodyHtml: `
        <div class="cold-failed">
          ${SF.xCircleBig}
          <div class="cold-failed-title">Something Went Wrong</div>
          <p class="muted center-text">${esc(s.error)}</p>
        </div>`,
      onCancel: cancel,
      continueTitle: "Try Again",
      onContinue: () => {
        s.error = "";
        go("review");
        // the compound's inputs never loaded: read them again
        if (compound && !s.manualKeys) loadCompound(); else schedulePreview();
      },
      direction,
    });
  };

  // --- start --------------------------------------------------------------------------------
  const loadCompound = async () => {
    try {
      const { utxoKeys, hasMore } = await compoundInputs({ engine: await getEngine(), fromAddress: from });
      if (closed) return;
      s.manualKeys = utxoKeys;
      s.compoundHasMore = hasMore;
      await setMax();
    } catch (error) {
      if (!closed && flow.current === "review") fail(error);
    }
  };

  // iOS: Compound opens on the review (its recipient and amount are set).
  flow.go(compound ? "review" : "to");
  settings().then((st) => {
    s.currency = st.currency || "usd";
    return wallet.price(s.currency);
  }).then((p) => { s.price = p; paint(); }).catch(() => {});
  // the recipient card marks one of your own addresses (iOS 56f004f)
  if (!compound) loadOwnAddresses().then((changed) => { if (changed) paint(); }).catch(() => {});
  (async () => {
    // Fetched once and used everywhere the fee is worked out (the review, the build).
    s.liveRate = await fetchQuotedFeeRateSompiPerGram();
    if (closed) return;
    if (compound) await loadCompound();
    else { schedulePreview(); paint(); }
  })();
}
