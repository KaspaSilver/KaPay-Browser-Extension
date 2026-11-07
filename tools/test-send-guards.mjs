// What a send checks before it's built and how Consolidate's run reads back (src/send-guards.js):
// the reviewed source against the key the vault gives now, the Max pin against what the review
// shows, every Consolidate source accounted for, and Cold Storage's no-change recipient output
// against the storage-mass budget. Run: node tools/test-send-guards.mjs
import assert from "node:assert/strict";
import {
  SOURCE_CHANGED, SOURCE_CHANGED_MESSAGE, sourceChangedError, selectionKey, maxPinCurrent, sameCoinSet,
  consolidateOutcome, CONSOLIDATE_CHANGED_MESSAGE, coldRecipientMassError,
} from "../src/send-guards.js";
import { planSendOutputs, SMALL_SEND_MASS_MESSAGE } from "../shared/ui/kspt.js";
import { MAX_AMOUNT_CHANGED, SEND_OUTCOME_UNKNOWN, SEND_OUTCOME_UNKNOWN_MESSAGE, sendOutcomeUnknownError } from "../shared/engine/transactions.js";

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

const A = "kaspa:qpaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "kaspa:qpbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

check("the reviewed address and the derived key's address agree: no error", () => {
  assert.equal(sourceChangedError({ address: A }, { address: A, accountId: "1" }), null);
  assert.equal(sourceChangedError({ address: A.toUpperCase() }, { address: A, accountId: "1" }), null);
  assert.equal(sourceChangedError({ address: ` ${A} `, accountId: "1" }, { address: A, accountId: "1" }), null);
});
check("nothing reviewed (an older caller): no check", () => {
  assert.equal(sourceChangedError(null, { address: A }), null);
  assert.equal(sourceChangedError({ address: null, accountId: null }, { address: A, accountId: "1" }), null);
});
check("another account's key (switched in another window) is refused", () => {
  const error = sourceChangedError({ address: A }, { address: B, accountId: "2" });
  assert.equal(error.code, SOURCE_CHANGED);
  assert.equal(error.message, SOURCE_CHANGED_MESSAGE);
  assert.equal(sourceChangedError({ address: A, accountId: "1" }, { address: A, accountId: "2" }).code, SOURCE_CHANGED);
  assert.equal(sourceChangedError({ accountId: "1" }, { address: A, accountId: "2" }).code, SOURCE_CHANGED);
});

check("coin picks compare in any order; Automatic is the empty key", () => {
  assert.equal(selectionKey(null), "");
  assert.equal(selectionKey(new Set(["b:1", "a:0"])), selectionKey(["a:0", "b:1"]));
});
check("a Max pin holds only for the address, fee and coin pick it was worked out for", () => {
  const pin = { outpoints: ["a:0", "b:1"], amountSompi: 99_000n, sourceAddress: A, totalFeeSompi: 1_000n, selectionKey: "" };
  assert.equal(maxPinCurrent(pin, { sourceAddress: A, totalFeeSompi: 1_000n, selection: null }), true);
  assert.equal(maxPinCurrent(pin, { sourceAddress: B, totalFeeSompi: 1_000n, selection: null }), false);
  assert.equal(maxPinCurrent(pin, { sourceAddress: A, totalFeeSompi: 2_000n, selection: null }), false);
  assert.equal(maxPinCurrent(pin, { sourceAddress: A, totalFeeSompi: 1_000n, selection: ["a:0"] }), false);
  assert.equal(maxPinCurrent(null, { sourceAddress: A, totalFeeSompi: 1_000n, selection: null }), false);
  assert.equal(maxPinCurrent({ ...pin, outpoints: null }, { sourceAddress: A, totalFeeSompi: 1_000n, selection: null }), false);
});
check("the same coins in any order are the same set; one more or less is not", () => {
  assert.equal(sameCoinSet(["a:0", "b:1"], ["b:1", "a:0"]), true);
  assert.equal(sameCoinSet(["a:0"], ["a:0", "b:1"]), false);
  assert.equal(sameCoinSet(["a:0", "b:1"], ["a:0", "c:2"]), false);
  assert.equal(sameCoinSet([], []), true);
});

check("Consolidate: every source lands in exactly one list", () => {
  const changed = Object.assign(new Error("x"), { code: MAX_AMOUNT_CHANGED });
  const outcome = consolidateOutcome([
    { label: "Address #1", txids: ["t1"] },
    { label: "Address #2", error: sendOutcomeUnknownError("t2") },
    { label: "Address #3", error: changed },
    { label: "Address #4", error: new Error("Balance too low after network fees.") },
    { label: "Address #5", txids: ["t5a", "t5b"] },
  ]);
  assert.deepEqual(outcome.txids, ["t1", "t5a", "t5b"]);
  assert.deepEqual(outcome.sent, ["Address #1", "Address #5"]);
  assert.deepEqual(outcome.unconfirmed, [{ label: "Address #2", message: SEND_OUTCOME_UNKNOWN_MESSAGE, txid: "t2" }]);
  assert.deepEqual(outcome.changed, [{ label: "Address #3", message: CONSOLIDATE_CHANGED_MESSAGE }]);
  assert.deepEqual(outcome.failed, [{ label: "Address #4", message: "Balance too low after network fees." }]);
});
check("Consolidate: a Not confirmed source is never dropped once another succeeds", () => {
  const outcome = consolidateOutcome([
    { label: "Address #1", txids: ["t1"] },
    { label: "Address #2", error: Object.assign(new Error("?"), { code: SEND_OUTCOME_UNKNOWN }) },
  ]);
  assert.equal(outcome.txids.length, 1);
  assert.equal(outcome.unconfirmed.length, 1);
  assert.equal(outcome.unconfirmed[0].txid, null);
});

// Cold Storage's no-change path (KaPay iOS 0799cec KaChatTransactionBuilder: the recipient's output
// alone must fit the storage-mass budget)
const P2PK = { version: 0, scriptHex: `20${"ab".repeat(32)}ac` };
const unsignedFrom = (selection) => {
  const planned = planSendOutputs(selection, P2PK, P2PK);
  return { inputs: selection.utxos.map((u) => ({ amountSompi: u.amountSompi })), outputs: planned.outputs.map((o) => ({ valueSompi: o.valueSompi })), finalAmountSompi: selection.finalAmount, foldedChangeSompi: planned.foldedChangeSompi };
};
check("cold: 0.03 KAS from one 0.1 KAS coin - kspt folds the change, and the recipient alone is refused before the QR", () => {
  const unsigned = unsignedFrom({ utxos: [{ amountSompi: 10_000_000n }], finalAmount: 3_000_000n, feeSompi: 200_000n, changeSompi: 6_800_000n });
  assert.equal(unsigned.outputs.length, 1);
  assert.ok(unsigned.foldedChangeSompi > 0n);
  assert.equal(coldRecipientMassError(unsigned)?.message, SMALL_SEND_MASS_MESSAGE);
});
check("cold: a folded change whose recipient output fits goes ahead", () => {
  // 1 KAS from a 1.00001 KAS coin: a sliver of change folded, the recipient's output near the input
  const unsigned = unsignedFrom({ utxos: [{ amountSompi: 100_001_000n }], finalAmount: 100_000_000n, feeSompi: 300n, changeSompi: 700n });
  assert.equal(unsigned.outputs.length, 1);
  assert.equal(coldRecipientMassError(unsigned), null);
});
check("cold: a send that keeps its change, a Max and a compound are never refused here", () => {
  const withChange = unsignedFrom({ utxos: [{ amountSompi: 500_000_000n }], finalAmount: 100_000_000n, feeSompi: 300_000n, changeSompi: 399_700_000n });
  assert.equal(withChange.outputs.length, 2);
  assert.equal(coldRecipientMassError(withChange), null);
  const amounts = Array.from({ length: 32 }, (_, i) => BigInt(1_000_000 * (i + 1)));
  const total = amounts.reduce((sum, a) => sum + a, 0n);
  const compound = unsignedFrom({ utxos: amounts.map((amountSompi) => ({ amountSompi })), finalAmount: total - 3_000_000n, feeSompi: 3_000_000n, changeSompi: 0n });
  assert.equal(coldRecipientMassError(compound), null);
  assert.equal(coldRecipientMassError(null), null);
});

console.log(`\n${passed} passed`);
