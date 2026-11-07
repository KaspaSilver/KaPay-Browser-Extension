// What a send checks before anything is built (Cold Storage: before its QR is shown), and how a run
// of sends reads back. No DOM and no wallet here, so tools/test-send-guards.mjs runs it in node.

import { MAX_AMOUNT_CHANGED, SEND_OUTCOME_UNKNOWN, SEND_OUTCOME_UNKNOWN_MESSAGE } from "../shared/engine/transactions.js";
import { fitsStorageMass, SMALL_SEND_MASS_MESSAGE } from "../shared/ui/kspt.js";

export const SOURCE_CHANGED = "SOURCE_CHANGED";
export const SOURCE_CHANGED_MESSAGE = "The account changed after you reviewed this. Nothing was sent. Check the From address and try again.";

const lower = (value) => String(value || "").trim().toLowerCase();

/**
 * The error a send throws when the key it would sign with is not the reviewed source's: another
 * KaPay window switched accounts (or changed the chatting address) between the review and the
 * swipe, so account B would pay while A's address is on screen. `reviewed` is { address,
 * accountId }, either may be missing; `derived` is what the vault gives now. Null when they match.
 */
export function sourceChangedError(reviewed, derived) {
  const address = lower(reviewed?.address);
  const accountId = reviewed?.accountId ? String(reviewed.accountId) : "";
  const differs = (address && address !== lower(derived?.address)) || (accountId && accountId !== String(derived?.accountId || ""));
  if (!differs) return null;
  const error = new Error(SOURCE_CHANGED_MESSAGE);
  error.code = SOURCE_CHANGED;
  return error;
}

/** Coin Control's picks as one comparable key ("" for Automatic). */
export function selectionKey(selected) {
  return [...(selected || [])].map(String).sort().join(",");
}

/**
 * Whether a Max pin (the coins and amount Max was worked out from) still belongs to what the review
 * shows: the same From address, fee and coin pick. A pin from before any of those changed must
 * never be sent - the slide is refused and Max worked out again (KaChat-Desktop sendKaspaPinnedMax).
 */
export function maxPinCurrent(pin, { sourceAddress, totalFeeSompi, selection }) {
  if (!pin || !Array.isArray(pin.outpoints) || pin.amountSompi == null) return false;
  return lower(pin.sourceAddress) === lower(sourceAddress)
    && pin.totalFeeSompi === totalFeeSompi
    && pin.selectionKey === selectionKey(selection);
}

/** Two lists of "txid:index" coin keys hold exactly the same coins. */
export function sameCoinSet(a, b) {
  const left = new Set((a || []).map(String));
  const right = (b || []).map(String);
  return left.size === right.length && right.every((key) => left.has(key));
}

/** Consolidate's words for MAX_AMOUNT_CHANGED: it has a Confirm button, not a slide. */
export const CONSOLIDATE_CHANGED_MESSAGE = "The available amount changed. Check the new amount and confirm again.";

/**
 * Consolidate to Primary's run, source by source: `results` is [{ label, txids } | { label, error }].
 * Every source is accounted for - a "Not confirmed" one may still land, so it is never counted as
 * failed or offered again as if nothing went out. -> { txids, sent, unconfirmed, changed, failed }
 */
export function consolidateOutcome(results) {
  const out = { txids: [], sent: [], unconfirmed: [], changed: [], failed: [] };
  for (const result of results || []) {
    const label = String(result?.label || "");
    const error = result?.error;
    if (!error) {
      out.txids.push(...(result?.txids || []));
      out.sent.push(label);
    } else if (error.code === SEND_OUTCOME_UNKNOWN) {
      out.unconfirmed.push({ label, message: SEND_OUTCOME_UNKNOWN_MESSAGE, txid: error.txid || null });
    } else if (error.code === MAX_AMOUNT_CHANGED) {
      out.changed.push({ label, message: CONSOLIDATE_CHANGED_MESSAGE });
    } else {
      out.failed.push({ label, message: String(error.message || error || "Send failed.") });
    }
  }
  return out;
}

/**
 * Cold Storage's no-change path (KaPay iOS 0799cec, KaChatTransactionBuilder
 * fitsStorageMass(inputAmounts:outputAmounts:[amount])): an unsigned transaction built with no change
 * output - its change folded into the fee, or none left - must fit the storage-mass budget with the
 * recipient's output alone. A small send carved from a bigger coin breaks it without any change
 * (0.03 KAS from one 0.1 KAS coin), and the node would refuse it after KasSigner had signed what the
 * QR showed. shared/ui/kspt.js planSendOutputs doesn't check this, so the built transaction is
 * checked here before its QR is shown. iOS adds another coin first, which lowers that mass; the
 * build (kspt.js) can't be asked to, so the send is refused with kspt's own words, which suggest a
 * larger amount or a compound. -> an Error to show, or null.
 */
export function coldRecipientMassError(unsigned) {
  const outputs = unsigned?.outputs || [];
  if (outputs.length !== 1) return null;
  const inputAmounts = (unsigned.inputs || []).map((input) => BigInt(input.amountSompi));
  const amount = BigInt(unsigned.finalAmountSompi ?? outputs[0].valueSompi);
  return fitsStorageMass(inputAmounts, [amount]) ? null : new Error(SMALL_SEND_MASS_MESSAGE);
}
