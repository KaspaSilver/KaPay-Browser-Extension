// What a send checks before it's built and how Consolidate's run reads back (src/send-guards.js):
// the reviewed source against the key the vault gives now, the Max pin against what the review
// shows, and every Consolidate source accounted for. Run: node tools/test-send-guards.mjs
import assert from "node:assert/strict";
import {
  SOURCE_CHANGED, SOURCE_CHANGED_MESSAGE, sourceChangedError, selectionKey, maxPinCurrent, sameCoinSet,
  consolidateOutcome, CONSOLIDATE_CHANGED_MESSAGE,
} from "../src/send-guards.js";
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

console.log(`\n${passed} passed`);
