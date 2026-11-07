// The coins a send spends, around the engine (shared/engine/transactions.js, which isn't edited
// here): the ones a send just spent are held out of the next send, Max and fee for a while, an
// address with more coins than one transaction can spend gets a Max (and a Compound) of its largest
// coins, and a node's rejection is reported as one even when another node timed out first
// (KaPay iOS 0799cec). A send rebuilt at the swipe that would pay more than the Review showed
// sends nothing, and only a node's verdict on the transaction counts as a rejection (KaPay iOS
// 1652437). No DOM and no wallet here, so tools/test-send-coins.mjs runs it in node.

import { isRpcConnectionError } from "../shared/engine/rpc.js";
import { MAX_SEND_INPUT_LIMIT, SEND_OUTCOME_UNKNOWN, outpointKeysFrom } from "../shared/engine/transactions.js";
import { utxoAmountSompi } from "../shared/engine/amounts.js";

// --- Coins a send just spent (iOS WalletService.recordSpend / unreservedUtxos) ------------------
//
// The node goes on listing a spent coin until its spend is in a block, so the next send, Max or fee
// would pick it again and be refused. Its key ("txid:index") is held for SPENT_COIN_HOLD_MS (iOS
// spentOutpointHold = 120), also after "Not confirmed", which may still land. Holds are
// { key: { until, address } } records; nothing here mutates one.
export const SPENT_COIN_HOLD_MS = 120_000;
// iOS has no words of its own for this (its send just finds "No spendable UTXOs").
export const HELD_COINS_MESSAGE = "Your last send is still settling. Try again in a moment.";

/** The holds still running at `now`. */
export function liveHolds(holds, now = Date.now()) {
  const live = {};
  for (const [key, hold] of Object.entries(holds || {})) {
    if (Number(hold?.until) > now) live[key] = { until: Number(hold.until), address: String(hold.address || "") };
  }
  return live;
}

/** Two sets of holds as one (another window's, this one's): the later expiry wins. */
export function mergeHolds(a, b, now = Date.now()) {
  const merged = liveHolds(a, now);
  for (const [key, hold] of Object.entries(liveHolds(b, now))) {
    if (!merged[key] || merged[key].until < hold.until) merged[key] = hold;
  }
  return merged;
}

/** `holds` plus `keys` (a send's inputs, from `address`) held until `now` + SPENT_COIN_HOLD_MS. */
export function holdSpentCoins(holds, keys, address, now = Date.now()) {
  const next = liveHolds(holds, now);
  const until = now + SPENT_COIN_HOLD_MS;
  for (const key of outpointKeysFrom(keys)) next[key] = { until, address: String(address || "") };
  return next;
}

/** The held keys, for the engine's setReservedOutpoints. */
export function heldKeys(holds, now = Date.now()) {
  return Object.keys(liveHolds(holds, now));
}

/** How many coins are held at `address`. */
export function heldCountAt(holds, address, now = Date.now()) {
  const lowered = String(address || "").toLowerCase();
  return Object.values(liveHolds(holds, now)).filter((hold) => hold.address.toLowerCase() === lowered).length;
}

/** The earliest expiry still to come, or null: when the engine's list next needs refreshing. */
export function nextHoldExpiry(holds, now = Date.now()) {
  const times = Object.values(liveHolds(holds, now)).map((hold) => hold.until);
  return times.length ? Math.min(...times) : null;
}

const keyOf = (coin) => (typeof coin?.key === "string" ? coin.key : `${coin?.outpoint?.transactionId}:${coin?.outpoint?.index}`);

/** `coins` (node entries with an `outpoint`, or wallet.utxos rows with a `key`) less the held ones. */
export function withoutHeldCoins(coins, holds, now = Date.now()) {
  const held = liveHolds(holds, now);
  if (!Object.keys(held).length) return Array.isArray(coins) ? coins : [];
  return (coins || []).filter((coin) => !held[keyOf(coin)]);
}

/** The engine's words for "every coin is reserved" are about scheduled KaPosts, which the extension
 *  doesn't have: there it means every coin is held by the last send. Since KaChat-Desktop Build 268
 *  the engine also leaves just-spent coins out itself and then says it found none: with coins of
 *  this address held (`holding`), that means the same. */
export function heldCoinsError(error, { holding = false } = {}) {
  const message = String(error?.message || "");
  const held = /reserved by a scheduled post/i.test(message) || (holding && /^No UTXOs/i.test(message));
  if (!held) return error;
  const settling = new Error(HELD_COINS_MESSAGE);
  settling.code = error?.code;
  return settling;
}

// --- One transaction's worth (iOS WalletService.oneTransactionChunk) ----------------------------
//
// The engine's Max refuses past MAX_SEND_INPUT_LIMIT (80) coins ("Too many coins...") and its
// sweep compounds every coin smallest first in several transactions. iOS gives such an address a
// Max of its largest 80 coins, and a Compound of those 80 in one transaction, one chunk at a time.

const amountOf = (coin) => (typeof coin?.amount === "bigint" ? coin.amount : (utxoAmountSompi(coin) ?? 0n));

/**
 * The largest `limit` coins when there are more than one transaction can spend; null when every
 * coin fits. Equal amounts are ordered by key, so the Max worked out on screen and the send that
 * follows (each from its own fetch) pick the same coins.
 */
export function oneTransactionChunk(coins, limit = MAX_SEND_INPUT_LIMIT) {
  const list = Array.isArray(coins) ? coins : [];
  if (list.length <= limit) return null;
  return [...list].sort((a, b) => {
    const x = amountOf(a);
    const y = amountOf(b);
    if (x !== y) return x > y ? -1 : 1;
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  }).slice(0, limit);
}

/** The keys a Max (or Compound) spends: the coin-control pick, else the largest chunk, else null
 *  (every coin, the engine's own choice). */
export function maxCoinKeys(coins, selectedOutpoints = null) {
  if (Array.isArray(selectedOutpoints) && selectedOutpoints.length) return selectedOutpoints;
  const chunk = oneTransactionChunk(coins);
  return chunk ? chunk.map(keyOf) : null;
}

// --- What a send built -----------------------------------------------------------------------------
//
// sendMaxKaspa returns its `outpoints` and sendKaspa its pending transactions (each carries its
// inputs), but a send that ends "Not confirmed" returns nothing, and sendKaspa's "total minus fee"
// path returns no transactions. So the engine is handed a Kaspa module that notes the inputs of
// the last transaction it builds - the one it signs and submits - before anything is submitted.

/** "txid:index" of every input of one SDK transaction (any node-pool submit: a .kachat name's,
 *  a profile record's); none when they can't be read. */
export function transactionInputKeys(transaction) {
  const keys = [];
  try {
    for (const input of transaction?.inputs || []) {
      const outpoint = input?.previousOutpoint;
      if (outpoint?.transactionId != null && outpoint?.index != null) keys.push(`${outpoint.transactionId}:${outpoint.index}`);
    }
  } catch { /* an input that can't be read: the rest still count */ }
  return keys;
}

/** "txid:index" of every input of the generator's pending transactions. */
export function pendingInputKeys(transactions) {
  const keys = [];
  for (const pending of transactions || []) {
    let transaction = null;
    try { transaction = pending?.transaction; } catch { transaction = null; }
    keys.push(...transactionInputKeys(transaction));
  }
  return keys;
}

// --- The fee the Review showed (iOS WalletService.checkFeeAgainstReview, KaPay iOS 1652437) --------
//
// A send is built again at the swipe from that moment's coins. If they changed since the Review
// (another send spent one, a coin arrived) the generator can pick other coins and pay more, change
// too small to keep included. Its summary says what the whole send pays before anything is signed,
// so a fee past the Review's by more than REVIEW_FEE_MARGIN_SOMPI throws SEND_FEE_CHANGED there and
// nothing is sent; the Review then shows that fee, and the next swipe pays it. (Max and Compound are
// pinned already.)
//
// iOS works the Review's fee out with the real recipient and change address. The engine's estimate
// prices the recipient's own output since KaChat-Desktop Build 272 (wallet.estimateFee passes it),
// but its change still goes to the source, so a primary's change to a fresh quantum-safe P2SH slot
// (35-byte script against Schnorr's 34) costs the real send 1,100 sompi more. The margin covers that
// with room for rounding; a real difference - another coin the tip needs, say - is far bigger (an
// input is about 0.0011 KAS). This is why the engine's own check (sendKaspa's expectedFeeSompi, a
// 1,000-sompi margin) isn't used here: it would refuse every such primary send.
export const REVIEW_FEE_MARGIN_SOMPI = 5_000n;
export const SEND_FEE_CHANGED = "sendFeeChanged";

/** Sompi as KAS with no trailing zeros ("0.0002", "1"), as iOS's "%.8f" trimmed. */
export function trimmedKasText(sompi) {
  const value = BigInt(sompi);
  const whole = value / 100_000_000n;
  const fraction = String(value % 100_000_000n).padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** The error a send stops with when it would pay `feeSompi`, more than the Review showed. */
export function sendFeeChangedError(feeSompi, unit = "KAS") {
  const error = new Error(`The network fee is now ${trimmedKasText(feeSompi)} ${unit}, more than the Review showed. Nothing was sent: check the new fee and swipe again.`);
  error.code = SEND_FEE_CHANGED;
  error.feeSompi = BigInt(feeSompi);
  return error;
}

/** Throws SEND_FEE_CHANGED when a generator `summary` pays more than `expectedFeeSompi` (plus the
 *  margin). A summary without a readable fee, or no expected fee, checks nothing (as iOS, whose
 *  check needs every input's amount). */
export function checkFeeAgainstReview(summary, expectedFeeSompi, unit = "KAS") {
  if (expectedFeeSompi == null) return;
  let fee;
  try { fee = BigInt(summary?.fees); } catch { return; }
  if (fee > BigInt(expectedFeeSompi) + REVIEW_FEE_MARGIN_SOMPI) throw sendFeeChangedError(fee, unit);
}

/** `kaspa` with createTransaction / createTransactions noting the inputs they build. -> { kaspa, keys }
 *  `expectedFeeSompi`: the fee the Review showed; a generator build that would pay more throws
 *  SEND_FEE_CHANGED before anything is signed (checkFeeAgainstReview). */
export function recordBuiltInputs(kaspa, { expectedFeeSompi = null, unit = "KAS" } = {}) {
  let keys = [];
  const recording = Object.create(kaspa, {
    createTransaction: {
      value: (entries, ...rest) => {
        const tx = kaspa.createTransaction(entries, ...rest);
        keys = outpointKeysFrom(entries);
        return tx;
      },
    },
    createTransactions: {
      value: async (settings) => {
        const result = await kaspa.createTransactions(settings);
        keys = pendingInputKeys(result?.transactions);
        checkFeeAgainstReview(result?.summary, expectedFeeSompi, unit);
        return result;
      },
    },
  });
  return { kaspa: recording, keys: () => [...keys] };
}

// --- A node's rejection is its verdict (iOS NodePoolService wasRejected) ----------------------------
//
// The engine's submitConfirmingAcceptance ends in SEND_OUTCOME_UNKNOWN ("Not confirmed") whenever
// any submit lost its answer, even when a node then rejected the transaction. The node wrapper a
// send hands the engine notes how each "... broadcast" call ended: only an error a node sent back
// about the transaction counts as a rejection (iOS markRejected, set from the response alone), so a
// reconnect that fails, a dropped socket or a timeout never does - any of those may hide a send that
// went out, and calling it rejected would invite paying twice. It is judged inside the function the
// wrapper runs on a node, never around the wrapper, whose own reconnect can fail. Each broadcast call
// starts afresh, as each iOS submit has its own flag: the orphan-allowed resubmit that loses its
// answer may still land, whatever the first submit heard.

/** The Kaspa module words a node's answer "RPC Server (remote error) -> Rejected transaction ...".
 *  Only a verdict on the transaction itself counts (iOS NodePoolService.isVerdict, KaPay iOS
 *  1652437): "already" in a mempool or accepted, its inputs spent by it, a missing outpoint or an
 *  orphan is what a node also says when another node - the one whose answer was lost - already took
 *  and relayed this very transaction, so the lost answer stands. Same list as KaPlay and KaPost. */
// "spent" as a word, never inside "unspent"
const NOT_A_VERDICT = /already|orphan|double spend|\bspent\b|missing outpoint|mempool|memory pool/i;
export const isNodeRejection = (error) => {
  const message = String(error?.message || error || "");
  return /remote error|rejected/i.test(message) && !NOT_A_VERDICT.test(message);
};

// Since KaChat-Desktop Build 268 the engine itself calls any submit error that isn't one of its
// connection patterns (shared/engine/rpc.js) a rejection, and a dropped socket the module words
// "WebSocket disconnected" or "RPC: channel receive error" isn't one of them: after a timeout it
// turned a send that may have gone out into a plain failure, inviting a second payment. Inside the
// node call such an error is handed to the engine as the lost connection it is, so the engine looks
// for the transaction and ends "Not confirmed" if it can't tell. (Belongs in the engine's patterns;
// until then, here.)
const SOCKET_FAILURE = /websocket|disconnect|socket|channel (receive|send)|rpc client/i;
/** The node as the engine's submit sees it: the same client, its submit's socket failures worded
 *  as a lost connection (the engine reads them before any wrapper around it can). */
function submittingAsLost(node) {
  if (!node || typeof node.submitTransaction !== "function") return node;
  return new Proxy(node, {
    get(target, key) {
      if (key === "submitTransaction") {
        return async (...args) => {
          try { return await target.submitTransaction(...args); } catch (error) { throw asConnectionLoss(error); }
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export function asConnectionLoss(error, isConnectionError = isRpcConnectionError) {
  const message = String(error?.message || error || "");
  if (isConnectionError(error) || isNodeRejection(error) || !SOCKET_FAILURE.test(message)) return error;
  const lost = new Error(`Connection lost: ${message}`);
  lost.cause = error;
  return lost;
}

/** -> { withRpc, verdict(error), wentOut() }: `withRpc` for the engine, `verdict` for what it threw,
 *  `wentOut` whether a node took one of its broadcasts (a .kas transfer's commit, before its reveal
 *  failed: those coins are spent). */
export function rejectionAwareRpc(withRpc, isRejection = isNodeRejection) {
  let rejection = null;
  let went = false;
  const watched = (fn, options) => {
    if (!/broadcast$/i.test(String(options?.label || ""))) return withRpc(fn, options);
    rejection = null;
    return withRpc(async (node) => {
      try {
        const result = await fn(submittingAsLost(node));
        rejection = null;
        went = true;
        return result;
      } catch (error) {
        if (error?.code !== SEND_OUTCOME_UNKNOWN && isRejection(error)) rejection = error;
        throw error;
      }
    }, options);
  };
  return {
    withRpc: watched,
    // an error that already names transactions that went out (a chained send part way) stands
    verdict: (error) => (error?.code === SEND_OUTCOME_UNKNOWN && rejection && !error?.submittedTxids?.length ? rejection : error),
    wentOut: () => went,
  };
}

/**
 * One engine send, watched: `start({ kaspa, withRpc })` runs it with the recording module and the
 * rejection-aware wrapper. The coins it spent go to `onSpent(keys)` once it is out, or when it ends
 * "Not confirmed" (it may still land), or when it fails after one of its broadcasts went out (a .kas
 * transfer's reveal after its commit); a rejection or any other failure spends nothing. What's thrown
 * is the verdict, with the engine's scheduled-post words for held coins rewritten. The holding is
 * bookkeeping: if it fails, the send still reads as it went. `expectedFeeSompi`: the fee the Review
 * showed (recordBuiltInputs).
 */
export async function watchedSend({ kaspa, withRpc, start, onSpent = async () => {}, holding = () => false, isRejection = isNodeRejection, expectedFeeSompi = null, unit = "KAS" }) {
  const built = recordBuiltInputs(kaspa, { expectedFeeSompi, unit });
  const guard = rejectionAwareRpc(withRpc, isRejection);
  const spent = async (keys) => { try { await onSpent(keys); } catch { /* the send's outcome stands */ } };
  let result;
  try {
    result = await start({ kaspa: built.kaspa, withRpc: guard.withRpc });
  } catch (error) {
    const verdict = heldCoinsError(guard.verdict(error), { holding: holding() });
    if (verdict?.code === SEND_OUTCOME_UNKNOWN || guard.wentOut()) await spent(built.keys());
    throw verdict;
  }
  await spent([...new Set([...built.keys(), ...outpointKeysFrom(result?.outpoints)])]);
  return result;
}
