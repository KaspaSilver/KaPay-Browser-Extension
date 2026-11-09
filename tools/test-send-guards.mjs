// What a send checks before it's built (src/send-guards.js): the reviewed source against the key the
// vault gives now, the Max pin against what the review shows, Cold Storage's no-change recipient
// output against the storage-mass budget, and which unfinished .kas transfers are tried again (KaPay
// iOS 2da5f4b). Run: node tools/test-send-guards.mjs
import assert from "node:assert/strict";
import {
  SOURCE_CHANGED, SOURCE_CHANGED_MESSAGE, sourceChangedError, selectionKey, maxPinCurrent, coldRecipientMassError,
  revealsToRetry, commitIsLive, REVEAL_RETRY_MAX_AGE_MS, REVEAL_RETRY_SETTLE_MS,
} from "../src/send-guards.js";
import { planSendOutputs, SMALL_SEND_MASS_MESSAGE } from "../shared/ui/kspt.js";

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
// A .kas transfer whose reveal never went out, retried for an hour (KaPay iOS 2da5f4b KNSRevealRecovery)
const NOW = 2_000_000_000_000;
const filed = (over = {}) => ({ assetId: "asset", source: { accountId: "A" }, createdAt: NOW - 600_000, updatedAt: NOW - 600_000, commitTxId: "CC", commitAmountSompi: "200000000", ...over });
const retried = (records, inFlow = new Set()) => revealsToRetry(records, { accountId: "A", inFlow, now: NOW }).map((r) => r.assetId);
check("a commit left without a reveal is retried for this account, within the hour", () => {
  assert.equal(REVEAL_RETRY_MAX_AGE_MS, 3_600_000);
  assert.deepEqual(retried([filed()]), ["asset"]);
  assert.deepEqual(retried([filed({ source: null })]), ["asset"]);
  assert.deepEqual(retried([filed({ source: { accountId: "B" } })]), []);
});
check("past the hour it's left to Finish Transfer", () => {
  assert.deepEqual(retried([filed({ createdAt: NOW - REVEAL_RETRY_MAX_AGE_MS })]), ["asset"]);
  assert.deepEqual(retried([filed({ createdAt: NOW - REVEAL_RETRY_MAX_AGE_MS - 1 })]), []);
  assert.deepEqual(retried([filed({ createdAt: undefined, updatedAt: undefined })]), []);
});
check("a transfer running here, or just touched by another window, does its own reveal", () => {
  assert.deepEqual(retried([filed()], new Set(["asset"])), []);
  assert.deepEqual(retried([filed({ updatedAt: NOW - REVEAL_RETRY_SETTLE_MS + 1 })]), []);
  assert.deepEqual(retried([filed({ updatedAt: NOW - REVEAL_RETRY_SETTLE_MS })]), ["asset"]);
});
check("a commit is live only while the node lists its output", () => {
  const entry = (transactionId, amount) => ({ outpoint: { transactionId, index: 0 }, amount });
  assert.equal(commitIsLive(filed(), [entry("cc", 200_000_000n)]), true);
  assert.equal(commitIsLive(filed(), [entry("dd", 200_000_000n)]), false);
  assert.equal(commitIsLive(filed(), []), false);
  assert.equal(commitIsLive(filed(), undefined), false);
  // its answer was lost, so no txid was recorded: the amount says which it is
  assert.equal(commitIsLive(filed({ commitTxId: null }), [entry("dd", 200_000_000n)]), true);
  assert.equal(commitIsLive(filed({ commitTxId: null }), [entry("dd", 5n)]), false);
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
