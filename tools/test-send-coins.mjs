// The coins a send spends, around the engine (src/send-coins.js, KaPay iOS 0799cec): a send's inputs
// held out of the next send, Max and fee for 120 s (not after "Not confirmed", KaPay iOS 2da5f4b), Max
// and Compound past 80 coins on the largest 80 in one transaction, and a node's rejection reported as one even after
// another node timed out. The engine parts run the real engine (shared/engine/transactions.js) and
// the real Kaspa SDK offline, against a pretend node. KaPay iOS 1652437: only a verdict is a rejection, and a
// send rebuilt at the swipe that would pay more than the Review showed sends nothing.
// Run: node tools/test-send-coins.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SPENT_COIN_HOLD_MS, HELD_COINS_MESSAGE, liveHolds, mergeHolds, holdSpentCoins, heldKeys, heldCountAt, nextHoldExpiry,
  withoutHeldCoins, heldCoinsError, oneTransactionChunk, maxCoinKeys, pendingInputKeys, recordBuiltInputs, rejectionAwareRpc,
  watchedSend, isNodeRejection, transactionInputKeys, checkFeeAgainstReview, sendFeeChangedError, trimmedKasText,
  REVIEW_FEE_MARGIN_SOMPI, SEND_FEE_CHANGED, CHAINED_CHANGE, pricingChangeAtFreshSlot,
} from "../src/send-coins.js";
import {
  SEND_OUTCOME_UNKNOWN, MAX_SEND_INPUT_LIMIT, MAX_AMOUNT_CHANGED, setReservedOutpoints, estimateMaxSend, sendMaxKaspa, sendKaspa,
  submitConfirmingAcceptance, planMaxSend, sanitizeUtxoEntries, clearJustSpentOutpoints, estimateOnchainFeeDetail, noteSpentOutpoints,
  excludeJustSpentUtxos,
} from "../shared/engine/transactions.js";
import { isRpcConnectionError } from "../shared/engine/rpc.js";
import { quantumRedeemScript, quantumScriptPublicKey, quantumAddressForRedeem } from "../shared/engine/quantum.js";
import { hex } from "../shared/engine/kachat-names/codec.js";

let passed = 0;
// each check starts with nothing held: the engine keeps its own just-spent list too (Build 268)
async function check(name, fn) { clearJustSpentOutpoints(); await fn(); passed += 1; console.log(`ok - ${name}`); }

const A = "kaspa:qpaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "kaspa:qpbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T0 = 1_000_000;
const txid = (n) => n.toString(16).padStart(64, "0");

// --- holds ---------------------------------------------------------------------------------------

await check("a send's coins are held for 120 s, at their address", () => {
  assert.equal(SPENT_COIN_HOLD_MS, 120_000);
  const holds = holdSpentCoins({}, ["a:0", "b:1"], A, T0);
  assert.deepEqual(heldKeys(holds, T0), ["a:0", "b:1"]);
  assert.deepEqual(heldKeys(holds, T0 + 119_999), ["a:0", "b:1"]);
  assert.deepEqual(heldKeys(holds, T0 + 120_000), []);
  assert.equal(heldCountAt(holds, A.toUpperCase(), T0), 2);
  assert.equal(heldCountAt(holds, B, T0), 0);
  assert.equal(nextHoldExpiry(holds, T0), T0 + 120_000);
  assert.equal(nextHoldExpiry(holds, T0 + 120_000), null);
});
await check("holding more never mutates the old holds and drops expired ones", () => {
  const first = holdSpentCoins({}, ["a:0"], A, T0);
  const second = holdSpentCoins(first, [{ outpoint: { transactionId: "b", index: 1 } }, "junk"], B, T0 + 130_000);
  assert.deepEqual(Object.keys(first), ["a:0"]);
  assert.deepEqual(Object.keys(second), ["b:1"]);
  assert.deepEqual(liveHolds({ x: { until: "nope" }, y: null }, T0), {});
});
await check("another window's holds merge in; the later expiry wins", () => {
  const mine = holdSpentCoins({}, ["a:0"], A, T0);
  const theirs = holdSpentCoins({}, ["a:0", "c:2"], A, T0 + 10_000);
  const merged = mergeHolds(mine, theirs, T0 + 10_000);
  assert.deepEqual(Object.keys(merged).sort(), ["a:0", "c:2"]);
  assert.equal(merged["a:0"].until, T0 + 130_000);
  assert.deepEqual(mergeHolds(mine, undefined, T0), mine);
});
await check("held coins leave node entries and wallet.utxos rows alike", () => {
  const holds = holdSpentCoins({}, ["a:0"], A, T0);
  const entries = [{ outpoint: { transactionId: "a", index: 0 } }, { outpoint: { transactionId: "a", index: 1 } }];
  assert.deepEqual(withoutHeldCoins(entries, holds, T0), [entries[1]]);
  assert.deepEqual(withoutHeldCoins([{ key: "a:0" }, { key: "b:0" }], holds, T0), [{ key: "b:0" }]);
  assert.equal(withoutHeldCoins(entries, holds, T0 + 120_000).length, 2);
  assert.deepEqual(withoutHeldCoins(null, {}, T0), []);
});
await check("the engine's scheduled-post words become the held-coin message; anything else stands", () => {
  for (const message of ["Every coin is reserved by a scheduled post.", "Every coin is reserved by a scheduled post. Wait for it to go out, or cancel it in KaPost > Scheduled."]) {
    assert.equal(heldCoinsError(new Error(message)).message, HELD_COINS_MESSAGE);
  }
  assert.equal(HELD_COINS_MESSAGE, "Your last send is still settling. Try again in a moment.");
  const other = new Error("Insufficient funds");
  assert.equal(heldCoinsError(other), other);
  assert.equal(heldCoinsError(null), null);
});

// --- one transaction's worth ---------------------------------------------------------------------

const entry = (n, amount, extra = {}) => ({ outpoint: { transactionId: txid(n), index: 0 }, amount: BigInt(amount), ...extra });

await check("80 coins or fewer: no chunk (every coin)", () => {
  assert.equal(MAX_SEND_INPUT_LIMIT, 80);
  assert.equal(oneTransactionChunk(Array.from({ length: 80 }, (_, i) => entry(i + 1, 1000 + i))), null);
  assert.equal(oneTransactionChunk([]), null);
  assert.equal(maxCoinKeys([entry(1, 5)]), null);
});
await check("past 80 coins: the largest 80, whatever order the node lists them in", () => {
  const coins = Array.from({ length: 100 }, (_, i) => entry(i + 1, 1_000_000 * (i + 1)));
  const chunk = oneTransactionChunk(coins);
  assert.equal(chunk.length, 80);
  assert.equal(chunk[0].amount, 100_000_000n);
  assert.equal(chunk[79].amount, 21_000_000n);
  const shuffled = [...coins].reverse();
  assert.deepEqual(maxCoinKeys(shuffled), maxCoinKeys(coins));
});
await check("equal amounts at the edge are picked by key, so the estimate and the send agree", () => {
  const coins = Array.from({ length: 90 }, (_, i) => entry(i + 1, 5000));
  const a = maxCoinKeys(coins);
  const b = maxCoinKeys([...coins].reverse());
  assert.deepEqual(a, b);
  assert.equal(a.length, 80);
});
await check("wallet.utxos rows (BigInt amounts, keys) chunk the same way", () => {
  const rows = Array.from({ length: 85 }, (_, i) => ({ key: `${txid(i + 1)}:0`, amount: BigInt(i + 1) }));
  const chunk = oneTransactionChunk(rows);
  assert.equal(chunk.length, 80);
  assert.equal(chunk.at(-1).amount, 6n);
  const entries = rows.map((r, i) => entry(i + 1, r.amount));
  assert.deepEqual(maxCoinKeys(entries), chunk.map((r) => r.key));
});
await check("a coin-control pick is the Max set as it stands", () => {
  const coins = Array.from({ length: 100 }, (_, i) => entry(i + 1, 1000 + i));
  assert.deepEqual(maxCoinKeys(coins, ["x:1"]), ["x:1"]);
  assert.equal(maxCoinKeys(coins, []).length, 80);
});

// --- A node's rejection after a lost answer (the real submitConfirmingAcceptance) -----------------

const realSetTimeout = globalThis.setTimeout;
// The engine's waits (orphan, lost-answer lookups, resend checks) at no delay; the REST lookup finds nothing.
globalThis.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const timedOut = () => new Error("RPC request timed out");
const rejected = () => new Error("transaction rejected: fee is below the minimum");
/** src/wallet.js withRpc's shape: a connection error reconnects and tries once more. */
const reconnectingWithRpc = (node) => async (fn) => {
  try { return await fn(node); } catch (error) {
    if (!/not connected|closed|timed out|timeout|network/i.test(String(error?.message || error))) throw error;
    return fn(node);
  }
};
const scripted = (answers) => {
  const node = {
    calls: 0,
    getMempoolEntry: async () => null,
    submitTransaction: async () => { const next = answers[Math.min(node.calls++, answers.length - 1)]; if (next instanceof Error) throw next; return next; },
  };
  return node;
};
const submitVia = (withRpc) => submitConfirmingAcceptance({
  withRpc, txid: "f".repeat(64), submit: (rpc, options) => rpc.submitTransaction(options), lostAnswerWaitMs: 0, orphanWaitMs: 0, recheckMs: 0,
});

await check("the engine itself now reports a rejection after a timeout as the rejection (KaChat-Desktop Build 268)", async () => {
  const node = scripted([timedOut(), rejected()]);
  await assert.rejects(submitVia(reconnectingWithRpc(node)), (error) => error.code !== SEND_OUTCOME_UNKNOWN && /fee is below the minimum/.test(error.message));
});
await check("with the send's wrapper, that rejection is the verdict", async () => {
  const node = scripted([timedOut(), rejected()]);
  const guard = rejectionAwareRpc(reconnectingWithRpc(node));
  const error = await submitVia(guard.withRpc).catch((e) => e);
  // the engine already says so; the wrapper keeps saying so whichever way the engine answers
  const verdict = guard.verdict(error);
  assert.match(verdict.message, /fee is below the minimum/);
  assert.notEqual(verdict.code, SEND_OUTCOME_UNKNOWN);
});
await check("only timeouts: still 'Not confirmed'", async () => {
  const node = scripted([timedOut()]);
  const guard = rejectionAwareRpc(reconnectingWithRpc(node));
  const error = await submitVia(guard.withRpc).catch((e) => e);
  assert.equal(guard.verdict(error).code, SEND_OUTCOME_UNKNOWN);
});
await check("a reconnect that fails after a lost answer is not a rejection: still 'Not confirmed'", async () => {
  const node = scripted([timedOut()]);
  // src/wallet.js withRpc: the timeout makes it reconnect, and connection() itself throws
  const failingReconnect = async (fn) => {
    try { return await fn(node); } catch { throw new Error("Can't reach a Kaspa node right now."); }
  };
  const guard = rejectionAwareRpc(failingReconnect);
  const error = await submitVia(guard.withRpc).catch((e) => e);
  assert.equal(guard.verdict(error).code, SEND_OUTCOME_UNKNOWN);
});
await check("a dropped socket on the retry is not a rejection either", async () => {
  const node = scripted([timedOut(), new Error("WebSocket disconnected")]);
  const guard = rejectionAwareRpc(reconnectingWithRpc(node));
  const error = await submitVia(guard.withRpc).catch((e) => e);
  assert.equal(guard.verdict(error).code, SEND_OUTCOME_UNKNOWN);
});
await check("an unknown outcome that already names sent transactions stands", async () => {
  const guard = rejectionAwareRpc(async (fn) => fn({}));
  await guard.withRpc(async () => { throw rejected(); }, { label: "Transaction broadcast" }).catch(() => {});
  const unknown = Object.assign(new Error("x"), { code: SEND_OUTCOME_UNKNOWN, submittedTxids: ["a".repeat(64)] });
  assert.equal(guard.verdict(unknown), unknown);
});
await check("an orphan resubmit that loses its answer may still land: the earlier rejection doesn't count", async () => {
  const orphan = () => new Error("transaction is an orphan where orphan is disallowed");
  // orphan, orphan again, then the orphan-allowed submit times out on both tries
  const node = scripted([orphan(), orphan(), timedOut(), timedOut()]);
  const guard = rejectionAwareRpc(reconnectingWithRpc(node));
  const error = await submitVia(guard.withRpc).catch((e) => e);
  assert.equal(guard.verdict(error).code, SEND_OUTCOME_UNKNOWN);
});
await check("a call that isn't a broadcast (a lookup, a UTXO fetch) is never a verdict", async () => {
  const guard = rejectionAwareRpc(async () => { throw new Error("bad answer"); });
  await assert.rejects(guard.withRpc(async () => {}, { label: "Max send UTXO fetch" }));
  const unknown = Object.assign(new Error("x"), { code: SEND_OUTCOME_UNKNOWN });
  assert.equal(guard.verdict(unknown), unknown);
  assert.equal(isRpcConnectionError(timedOut()), true);
});

// --- The real engine and SDK against a pretend node --------------------------------------------------

const kaspa = await import("../shared/kaspa/kaspa.js");
await kaspa.default({ module_or_path: readFileSync(new URL("../shared/kaspa/kaspa_bg.wasm", import.meta.url)) });
// The SDK's own submit only takes a live RpcClient: the pretend node gets the signed transaction instead.
kaspa.PendingTransaction.prototype.submit = function submit(rpc) { return rpc.submitTransaction({ transaction: this.transaction, allowOrphan: false }); };

const KEY = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";
const privateKey = new kaspa.PrivateKey(KEY);
const SOURCE = privateKey.toAddress("mainnet").toString();
const sourceScript = kaspa.payToAddressScript(SOURCE);
const DEST = new kaspa.PrivateKey("c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9").toAddress("mainnet").toString();
const coin = (n, sompi, script = sourceScript, address = SOURCE) => ({
  address, outpoint: { transactionId: txid(n), index: 0 }, amount: BigInt(sompi), scriptPublicKey: script, blockDaaScore: 10n, isCoinbase: false,
});
/** A node holding `coins`; a submit is answered by `answer(tx)` (default: accepted under its id). */
function pretendNode(coins, answer = null) {
  const node = {
    coins: [...coins],
    submitted: [],
    accepted: new Set(),
    getUtxosByAddresses: async () => ({ entries: node.coins }),
    submitTransaction: async ({ transaction }) => {
      node.submitted.push(transaction);
      const answered = answer ? answer(transaction) : { transactionId: String(transaction.id) };
      node.accepted.add(String(transaction.id));
      return answered;
    },
    // only what it took is in its mempool
    getMempoolEntry: async ({ transactionId }) => (node.accepted.has(transactionId) ? { mempoolEntry: {} } : null),
  };
  return node;
}
const inputKeysOf = (tx) => [...tx.inputs].map((i) => `${i.previousOutpoint.transactionId}:${i.previousOutpoint.index}`);
const engineWithRpc = (node) => async (fn) => fn(node);

await check("the recording module notes the generator's inputs: the ones sendKaspa returns", async () => {
  const node = pretendNode([coin(1, 1e8), coin(2, 2e8), coin(3, 3e8)]);
  let spent = null;
  const result = await watchedSend({
    kaspa, withRpc: engineWithRpc(node), onSpent: (keys) => { spent = keys; },
    start: (engine) => sendKaspa({ ...engine, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: DEST, amountKas: "1.5" }),
  });
  assert.deepEqual(pendingInputKeys(result.result.transactions), inputKeysOf(node.submitted[0]));
  assert.deepEqual([...spent].sort(), inputKeysOf(node.submitted[0]).sort());
  assert.ok(spent.length >= 1 && spent.length < 3);
});
await check("sendKaspa's total-minus-fee path returns no transactions: the built inputs are still held", async () => {
  const node = pretendNode([coin(4, 1e8)]);
  let spent = null;
  // a self-send of the whole balance: one output of (total - fee)
  const result = await watchedSend({
    kaspa, withRpc: engineWithRpc(node), onSpent: (keys) => { spent = keys; },
    start: (engine) => sendKaspa({ ...engine, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE, amountKas: "1" }),
  });
  assert.equal(result.result.summary.reduced, true);
  assert.deepEqual(spent, [`${txid(4)}:0`]);
});

await check("held coins stay out of the next Max; when every coin is held, the held-coin message", async () => {
  const node = pretendNode([coin(5, 1e8), coin(6, 2e8)]);
  let holds = {};
  const send = () => watchedSend({
    kaspa, withRpc: engineWithRpc(node), onSpent: (keys) => { holds = holdSpentCoins(holds, keys, SOURCE); setReservedOutpoints(heldKeys(holds)); },
    holding: () => Object.keys(holds).length > 0,
    start: (engine) => sendMaxKaspa({ ...engine, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE }),
  });
  const first = await send();
  assert.deepEqual([...first.outpoints].sort(), [`${txid(5)}:0`, `${txid(6)}:0`]);
  assert.deepEqual(Object.keys(holds).sort(), [...first.outpoints].sort());
  // the node still lists them (the spend isn't in a block yet), plus a new coin
  node.coins.push(coin(7, 5e7));
  const estimate = await estimateMaxSend({ kaspa, rpc: node, sourceAddress: SOURCE });
  assert.deepEqual(estimate.outpoints, [`${txid(7)}:0`]);
  assert.equal(estimate.availableSompi, 50_000_000n);
  node.coins.pop();
  await assert.rejects(send(), (error) => error.message === HELD_COINS_MESSAGE);
  setReservedOutpoints([]);
});

await check("a 'Not confirmed' send holds none of its coins, and neither does a rejected one (KaPay iOS 2da5f4b)", async () => {
  const lost = pretendNode([coin(8, 1e8), coin(9, 2e8)], () => { throw timedOut(); });
  let spent = null;
  const unknown = await watchedSend({
    kaspa, withRpc: reconnectingWithRpc(lost), onSpent: (keys) => { spent = keys; },
    start: (engine) => sendKaspa({ ...engine, rpc: lost, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE, amountKas: "0.5", exactAmount: true }),
  }).catch((e) => e);
  assert.equal(unknown.code, SEND_OUTCOME_UNKNOWN);
  assert.deepEqual(spent, []);

  let tries = 0;
  const refusing = pretendNode([coin(10, 1e8), coin(11, 2e8)], () => { tries += 1; throw tries === 1 ? timedOut() : rejected(); });
  spent = null;
  const verdict = await watchedSend({
    kaspa, withRpc: reconnectingWithRpc(refusing), onSpent: (keys) => { spent = keys; },
    start: (engine) => sendMaxKaspa({ ...engine, rpc: refusing, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE }),
  }).catch((e) => e);
  assert.match(verdict.message, /fee is below the minimum/);
  assert.equal(spent, null);
});
await check("after 'Not confirmed' a resend finds the same coins, and other holds stay (KaPay iOS 2da5f4b, the engine since Build 274)", async () => {
  const lost = pretendNode([coin(40, 1e8), coin(41, 2e8)], () => { throw timedOut(); });
  noteSpentOutpoints([`${txid(42)}:0`]);
  const unknown = await watchedSend({
    kaspa, withRpc: reconnectingWithRpc(lost),
    start: (engine) => sendKaspa({ ...engine, rpc: lost, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE, amountKas: "0.5", exactAmount: true }),
  }).catch((e) => e);
  assert.equal(unknown.code, SEND_OUTCOME_UNKNOWN);
  const estimate = await estimateMaxSend({ kaspa, rpc: lost, sourceAddress: SOURCE });
  assert.deepEqual([...estimate.outpoints].sort(), [`${txid(40)}:0`, `${txid(41)}:0`]);
  const listed = [coin(42, 5e7), coin(43, 5e7)];
  assert.deepEqual(excludeJustSpentUtxos(listed), [listed[1]]);
});
await check("a chained send that ends 'Not confirmed' holds only what its earlier transactions spent", async () => {
  const earlier = "e".repeat(64);
  const pendings = [
    { id: earlier, transaction: { inputs: [{ previousOutpoint: { transactionId: "aa", index: 0 } }] } },
    { id: "f".repeat(64), transaction: { inputs: [{ previousOutpoint: { transactionId: "bb", index: 1 } }] } },
  ];
  const fake = Object.create(kaspa, { createTransactions: { value: async () => ({ transactions: pendings, summary: {} }) } });
  let spent = null;
  const error = await watchedSend({
    kaspa: fake, withRpc: engineWithRpc({}), onSpent: (keys) => { spent = keys; },
    start: async (engine) => {
      await engine.kaspa.createTransactions({});
      throw Object.assign(new Error("x"), { code: SEND_OUTCOME_UNKNOWN, submittedTxids: [earlier] });
    },
  }).catch((e) => e);
  assert.equal(error.code, SEND_OUTCOME_UNKNOWN);
  assert.deepEqual(spent, ["aa:0"]);
});

await check("bookkeeping that fails never changes how the send went", async () => {
  const node = pretendNode([coin(12, 1e8)]);
  const result = await watchedSend({
    kaspa, withRpc: engineWithRpc(node), onSpent: () => { throw new Error("storage full"); },
    start: (engine) => sendMaxKaspa({ ...engine, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE }),
  });
  assert.equal(result.txids.length, 1);
});

// --- Max and Compound past 80 coins -------------------------------------------------------------------

const many = Array.from({ length: 100 }, (_, i) => coin(100 + i, 10_000_000 * (i + 1)));

await check("the engine refuses a Max of 100 coins; the largest 80 are one transaction", async () => {
  assert.throws(() => planMaxSend({ kaspa, entries: sanitizeUtxoEntries(many), destinationAddress: SOURCE }), /Too many coins/);
  const node = pretendNode(many);
  const pick = maxCoinKeys(sanitizeUtxoEntries(node.coins));
  const estimate = await estimateMaxSend({ kaspa, rpc: node, sourceAddress: SOURCE, destinationAddress: SOURCE, selectedOutpoints: pick });
  assert.equal(estimate.inputCount, 80);
  assert.deepEqual([...estimate.outpoints].sort(), [...pick].sort());
  const largest80 = many.slice(20).reduce((sum, c) => sum + c.amount, 0n);
  assert.equal(estimate.totalSompi, largest80);
  // the send picks the same coins from its own fetch, so the Max pin holds
  const sent = await sendMaxKaspa({
    kaspa, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE,
    selectedOutpoints: maxCoinKeys(sanitizeUtxoEntries([...node.coins].reverse())),
    expectedAmountSompi: estimate.amountSompi, expectedOutpoints: estimate.outpoints,
  });
  assert.equal(sent.amountSompi, estimate.amountSompi);
  assert.equal([...node.submitted[0].inputs].length, 80);
  assert.equal([...node.submitted[0].outputs].length, 1);
});
await check("a bigger coin arriving before the slide changes the chunk: Max asks again, nothing sent", async () => {
  const node = pretendNode(many);
  const estimate = await estimateMaxSend({ kaspa, rpc: node, sourceAddress: SOURCE, selectedOutpoints: maxCoinKeys(sanitizeUtxoEntries(node.coins)) });
  node.coins.push(coin(999, 5_000_000_000));
  await assert.rejects(sendMaxKaspa({
    kaspa, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE,
    selectedOutpoints: maxCoinKeys(sanitizeUtxoEntries(node.coins)),
    expectedAmountSompi: estimate.amountSompi, expectedOutpoints: estimate.outpoints,
  }), (error) => error.code === MAX_AMOUNT_CHANGED && error.outpoints.includes(`${txid(999)}:0`));
  assert.equal(node.submitted.length, 0);
});
await check("Compound of 100 coins: the largest 80 to itself in one transaction, at the fee the review showed", async () => {
  const node = pretendNode(many);
  const shownFee = 9_500_000n; // above the network floor for 80 inputs (about 0.09 KAS)
  const result = await sendMaxKaspa({
    kaspa, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE,
    totalFeeSompi: shownFee, selectedOutpoints: maxCoinKeys(sanitizeUtxoEntries(node.coins)),
  });
  assert.equal(result.txids.length, 1);
  assert.equal(result.feeSompi, shownFee);
  const tx = node.submitted[0];
  assert.equal([...tx.inputs].length, 80);
  const outputs = [...tx.outputs];
  assert.equal(outputs.length, 1);
  assert.equal(BigInt(outputs[0].value), many.slice(20).reduce((sum, c) => sum + c.amount, 0n) - shownFee);
});
await check("Compound of a quantum-safe (KIP-22) address's largest 80 signs with its redeem script and fits", async () => {
  const redeem = quantumRedeemScript(String(privateKey.toPublicKey().toXOnlyPublicKey().toString()));
  const address = quantumAddressForRedeem(redeem);
  const script = { version: 0, script: hex(quantumScriptPublicKey(redeem)) };
  const coins = Array.from({ length: 90 }, (_, i) => coin(300 + i, 10_000_000 * (i + 1), script, address));
  const node = pretendNode(coins);
  const result = await sendMaxKaspa({
    kaspa, rpc: node, privateKey: KEY, sourceAddress: address, destinationAddress: address, redeemScript: redeem,
    selectedOutpoints: maxCoinKeys(sanitizeUtxoEntries(node.coins)),
  });
  assert.equal(result.txids.length, 1);
  assert.equal([...node.submitted[0].inputs].length, 80);
});

await check("recordBuiltInputs leaves the rest of the module as it is", () => {
  const built = recordBuiltInputs(kaspa);
  assert.equal(built.kaspa.PrivateKey, kaspa.PrivateKey);
  assert.equal(typeof built.kaspa.calculateTransactionFee, "function");
  built.kaspa.createTransaction([coin(1, 1e8)], [{ address: SOURCE, amount: 5e7 }], 0n);
  assert.deepEqual(built.keys(), [`${txid(1)}:0`]);
});

// --- KaPay iOS 1652437 ---------------------------------------------------------------------------------

await check("only a node's verdict is a rejection: 'already', 'spent', orphan or mempool answers aren't", () => {
  assert.equal(isNodeRejection(new Error("RPC Server (remote error) -> Rejected transaction ab: fee is below the minimum")), true);
  assert.equal(isNodeRejection(rejected()), true);
  for (const words of [
    "RPC Server (remote error) -> Rejected transaction ab: already in the mempool",
    "Rejected transaction ab: transaction is already accepted",
    "Rejected transaction ab: double spend in the mempool",
    "rejected: output ab:0 already spent",
    "Rejected transaction ab: missing outpoint",
    "Rejected transaction ab: is an orphan",
    "rejected by the memory pool",
  ]) assert.equal(isNodeRejection(new Error(words)), false, words);
  assert.equal(isNodeRejection(timedOut()), false);
});
await check("an 'already in the mempool' answer after a lost one is never the wrapper's verdict", async () => {
  const guard = rejectionAwareRpc(async (fn) => fn({}));
  await guard.withRpc(async () => { throw new Error("Rejected transaction ab: already in the mempool"); }, { label: "Transaction broadcast" }).catch(() => {});
  const unknown = Object.assign(new Error("x"), { code: SEND_OUTCOME_UNKNOWN });
  assert.equal(guard.verdict(unknown), unknown);
});
await check("one transaction's inputs, as any node-pool submit spends them", () => {
  assert.deepEqual(transactionInputKeys({ inputs: [{ previousOutpoint: { transactionId: "aa", index: 0 } }, { previousOutpoint: { transactionId: "bb", index: 2 } }, {}] }), ["aa:0", "bb:2"]);
  assert.deepEqual(transactionInputKeys(null), []);
  assert.deepEqual(transactionInputKeys({ get inputs() { throw new Error("freed"); } }), []);
});
await check("the fee-changed words are iOS's, the fee in KAS with no trailing zeros", () => {
  assert.equal(trimmedKasText(20_000n), "0.0002");
  assert.equal(trimmedKasText(100_000_000n), "1");
  assert.equal(trimmedKasText(123_456_789n), "1.23456789");
  const error = sendFeeChangedError(31_000n, "TKAS");
  assert.equal(error.code, SEND_FEE_CHANGED);
  assert.equal(error.message, "The network fee is now 0.00031 TKAS, more than the Review showed. Nothing was sent: check the new fee and swipe again.");
});
await check("within 1,000 sompi of the Review a send still goes (iOS's margin, KaPay iOS 2da5f4b); past it, it stops; no Review fee checks nothing", () => {
  assert.equal(REVIEW_FEE_MARGIN_SOMPI, 1_000n);
  checkFeeAgainstReview({ fees: 21_000n }, 20_000n);
  assert.throws(() => checkFeeAgainstReview({ fees: 21_001n }, 20_000n), (e) => e.code === SEND_FEE_CHANGED && e.feeSompi === 21_001n);
  // one more coin for the tip: an input's worth, refused, and the Review then pays what it said
  assert.throws(() => checkFeeAgainstReview({ fees: 7_952_200n }, 7_840_400n), (e) => e.feeSompi === 7_952_200n);
  checkFeeAgainstReview({ fees: 7_952_200n }, 7_952_200n);
  checkFeeAgainstReview({ fees: 99_999_999n }, null);
  checkFeeAgainstReview({}, 20_000n);
  checkFeeAgainstReview({ fees: "not a number" }, 20_000n);
});

/** What the Review showed for `amountKas` from the node's coins now: the generator's fee (the
 *  extension shows the policy fee and tips the difference, so the send pays the same total). */
const reviewFee = async (node, amountKas) => (await estimateOnchainFeeDetail({ kaspa, rpc: node, sourceAddress: SOURCE, amountKas })).feeSompi;
const sendAt = (node, amountKas, expectedFeeSompi) => watchedSend({
  kaspa, withRpc: engineWithRpc(node), expectedFeeSompi,
  start: (engine) => sendKaspa({ ...engine, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: DEST, amountKas }),
});

await check("a send built from the Review's coins pays what the Review showed and goes out", async () => {
  const node = pretendNode([coin(20, 1e8), coin(21, 3e8)]);
  const fee = await reviewFee(node, "1.5");
  const result = await sendAt(node, "1.5", fee);
  assert.equal(result.txids.length, 1);
  assert.equal(node.submitted.length, 1);
});
await check("coins that changed after the Review make the send pay more: nothing is sent (KaPay iOS 1652437)", async () => {
  const node = pretendNode([coin(23, 1e8), coin(24, 3e8)]);
  const fee = await reviewFee(node, "1.5");
  // two small coins arrived: the generator (smallest first) now spends them too, and pays for them
  node.coins.unshift(coin(25, 2e7), coin(26, 3e7));
  const error = await sendAt(node, "1.5", fee).catch((e) => e);
  assert.equal(error.code, SEND_FEE_CHANGED);
  assert.ok(error.feeSompi > fee + REVIEW_FEE_MARGIN_SOMPI);
  assert.equal(node.submitted.length, 0);
  // a quantum-safe (KIP-22) build is checked on its own passes too: never under the expected fee
  const redeem = quantumRedeemScript(String(privateKey.toPublicKey().toXOnlyPublicKey().toString()));
  const qAddress = quantumAddressForRedeem(redeem);
  const qScript = { version: 0, script: hex(quantumScriptPublicKey(redeem)) };
  const qNode = pretendNode([coin(27, 1e8, qScript, qAddress), coin(28, 3e8, qScript, qAddress)]);
  const qError = await watchedSend({
    kaspa, withRpc: engineWithRpc(qNode), expectedFeeSompi: 1n,
    start: (engine) => sendKaspa({ ...engine, rpc: qNode, privateKey: KEY, sourceAddress: qAddress, destinationAddress: DEST, amountKas: "1.5", redeemScript: redeem }),
  }).catch((e) => e);
  assert.equal(qError.code, SEND_FEE_CHANGED);
  assert.equal(qNode.submitted.length, 0);
});
await check("change on a fresh quantum-safe slot is priced at its real script: 1,100 sompi more, and the send pays that (KaPay iOS 2da5f4b)", async () => {
  const node = pretendNode([coin(50, 1e8), coin(51, 3e8)]);
  const asSource = await estimateOnchainFeeDetail({ kaspa, rpc: node, sourceAddress: SOURCE, destinationAddress: DEST, amountKas: "1.5" });
  const atSlot = await estimateOnchainFeeDetail({ kaspa: pricingChangeAtFreshSlot(kaspa), rpc: node, sourceAddress: SOURCE, destinationAddress: DEST, amountKas: "1.5" });
  assert.equal(atSlot.feeSompi - asSource.feeSompi, 1_100n);
  // the real send's change is the same shape: its fee is exactly what the Review now shows
  const change = quantumAddressForRedeem(quantumRedeemScript("11".repeat(32)));
  const sent = await watchedSend({
    kaspa, withRpc: engineWithRpc(node), expectedFeeSompi: atSlot.feeSompi,
    start: (engine) => sendKaspa({ ...engine, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: DEST, amountKas: "1.5", changeAddress: change }),
  });
  assert.equal(BigInt(sent.result.summary.fees), atSlot.feeSompi);
  // priced at the source's script, the same send is past iOS's 1,000-sompi margin
  assert.ok(BigInt(sent.result.summary.fees) > asSource.feeSompi);
});
await check("a failure after one of its broadcasts went out still holds what it spent (a .kas reveal after its commit)", async () => {
  const node = pretendNode([coin(30, 1e8), coin(31, 2e8)]);
  let spent = null;
  const error = await watchedSend({
    kaspa, withRpc: engineWithRpc(node), onSpent: (keys) => { spent = keys; },
    start: async (engine) => {
      await sendKaspa({ ...engine, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: DEST, amountKas: "0.5", exactAmount: true });
      await engine.withRpc(async () => { throw new Error("transaction rejected: bad reveal script"); }, { label: "KNS reveal broadcast" });
    },
  }).catch((e) => e);
  assert.match(error.message, /bad reveal script/);
  assert.deepEqual([...spent].sort(), inputKeysOf(node.submitted[0]).sort());
});

await check("a send that must chain stops before signing when its change is a quantum-safe slot, and goes out keeping its change", async () => {
  const redeem = quantumRedeemScript("11".repeat(32));
  const freshSlot = quantumAddressForRedeem(redeem);
  const coins = Array.from({ length: 120 }, (_, i) => coin(500 + i, 100_000_000));
  const node = pretendNode(coins);
  const sendWith = (changeAddress) => watchedSend({
    kaspa, withRpc: engineWithRpc(node), singleTransaction: Boolean(changeAddress),
    start: (engine) => sendKaspa({ ...engine, rpc: node, privateKey: KEY, sourceAddress: SOURCE, destinationAddress: SOURCE, amountKas: "100", changeAddress }),
  });
  await assert.rejects(sendWith(freshSlot), (error) => error.code === CHAINED_CHANGE);
  assert.equal(node.submitted.length, 0);
  const sent = await sendWith(null);
  assert.ok(sent.txids.length > 1);
  assert.equal(node.submitted.length, sent.txids.length);
});

globalThis.setTimeout = realSetTimeout;
console.log(`\n${passed} passed`);
process.exit(0);
