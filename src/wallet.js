// The wallet as the popup sees it: Kaspa WASM, the account's addresses, the node connection,
// balances and the KAS price. Built on the desktop app's engine (shared/engine, copied from KaChat-Desktop), so an address
// derived here is byte-for-byte the one KaChat on iOS, Android and desktop derives from the same
// recovery phrase:
//   main address      m/44'/111111'/0'/0/{identityIndex}  (or the account's legacy family)
//   spending address  m/44'/111111'/1'/0/{index}
// The main address is what KaChat calls the chatting address - your identity, where KNS domains
// live. Spending addresses are the fresh-address chain KaChat receives payments on.

import { loadKaspaModule } from "../shared/engine/wasm-loader.js";
import {
  generateMnemonicPhrase,
  importMnemonicWithFamily,
  deriveSpendingWallet,
  deriveSpendingAddressRange,
  deriveIdentityAddressRange,
} from "../shared/engine/wallet.js";
import { IMPORT_ADDRESS_SEARCH_DEPTH, foundChattingAddresses } from "../shared/ui/account-import.js";
import {
  QUANTUM_INDEX_BASE, QUANTUM_SCAN_FLOOR, KIP22_SIGNATURE_SCRIPT_SIZE, isQuantumIndex, chainLocalIndex, spendingIndexTitle,
  spendingStateFromRecord, spendingRecordFromState, revealedSpendingIndices, nextFreshQuantumIndex, spendingChangeIndex,
  QUANTUM_SCAN_LIMIT, FRESH_QUANTUM_PROBE_LIMIT, QUANTUM_CHANGE_UNAVAILABLE,
} from "../shared/engine/quantum.js";
import { createRpc, probeRpc, disconnectRpc, getNodeRegistrySnapshot, forgetEndpoint, markBadNode, knownPublicNodes } from "../shared/engine/rpc.js";
import { getEndpoint } from "../shared/engine/endpoints.js";
import { getBalance, sendKaspa, sendMaxKaspa, estimateSendFeeDetail, estimateOnchainFeeDetail, estimateMaxSend, submitConfirmingAcceptance, SEND_OUTCOME_UNKNOWN, setReservedOutpoints, sanitizeUtxoEntries } from "../shared/engine/transactions.js";
import { checkedUtxoAnswer } from "../shared/engine/amounts.js";
import { calculateMass, calculateFee, fetchQuotedFeeRateSompiPerGram } from "../shared/ui/kspt.js";
import { looksLikeName, resolveEverywhere, primaryResolution, notFoundMessage, ownsAnyName, ownedNamesOfMany } from "./names.js";
import { fetchKasPrice, peekKasPrice } from "../shared/engine/prices.js";
import { getAddressInfo, fetchAddressInfo, peekAddressInfo, clearKnsCache } from "../shared/engine/kns.js";
import { transactionBelongsInHistory } from "../shared/engine/sync.js";
import {
  transferDomain as knsTransferDomain, setKnsPrimaryDomain, setKnsPendingStorage, listPendingKnsTransfers,
  resumeKnsTransfer, clearPendingKnsTransfer,
} from "../shared/engine/kns-write.js";
import { getLocal, setLocal, removeLocal, getSession, setSession } from "./browser.js";
import { IS_TESTNET, NETWORK as ACTIVE_NETWORK, NETWORK_ID, ADDRESS_PREFIX, netKey, MAINNET_REST, TESTNET_REST, MAINNET_KNS, TESTNET_KNS, isValidKaspaAddress, networkOfAddress } from "./net.js";
import { activeAccountSecrets, accountSecretsById, ACCOUNT_IDS_KEY } from "./vault.js";
import { sompiFromUserText } from "./amounts.js";
import { sourceChangedError, SOURCE_CHANGED } from "./send-guards.js";
import {
  HELD_COINS_MESSAGE, liveHolds, mergeHolds, holdSpentCoins, heldKeys, heldCountAt, nextHoldExpiry, withoutHeldCoins,
  heldCoinsError, maxCoinKeys, watchedSend,
} from "./send-coins.js";

let kaspaPromise = null;

// A .kas transfer is a commit then a reveal; its recovery record (audit EXT-005) lives in the
// extension's own storage, so a popup closed between the two can still finish it.
setKnsPendingStorage({
  getItem: (key) => getLocal(key),
  setItem: (key, value) => setLocal(key, value),
  removeItem: (key) => removeLocal(key),
});
let rpc = null;
let rpcPromise = null;

/** Kaspa WASM, loaded once per page. ~12 MB; the browser caches the compiled module. */
export function kaspa() {
  if (!kaspaPromise) kaspaPromise = loadKaspaModule().catch((error) => { kaspaPromise = null; throw error; });
  return kaspaPromise;
}

/** A new 12- or 24-word phrase, from the Kaspa SDK's own BIP39 generator. */
export async function newRecoveryPhrase(wordCount = 24) {
  return generateMnemonicPhrase(await kaspa(), wordCount === 12 ? 12 : 24);
}

/**
 * The main address a phrase + passphrase open, for the passphrase screen's live preview (iOS
 * `previewChattingAddress`). Nothing is stored. Null when it cannot be derived.
 */
export async function previewMainAddress(phrase, passphrase = "", family = "kaspaStandard", index = 0) {
  try {
    // NFKD, as the account will be stored and as iOS derives it (audit EXT-010)
    const derived = await importMnemonicWithFamily(await kaspa(), phrase, String(passphrase || "").normalize("NFKD"), { family, index });
    return derived.address;
  } catch {
    return null;
  }
}

/**
 * Checks a phrase the user typed (word list and checksum) without keeping anything. Returns the
 * normalized phrase, or throws with a message the import screen can show.
 */
export async function validateRecoveryPhrase(phrase) {
  const clean = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  const words = clean ? clean.split(" ") : [];
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new Error("You need 12 or 24 words.");
  }
  const k = await kaspa();
  // The SDK checks every word against the BIP39 list and the checksum.
  let valid = false;
  try {
    valid = typeof k.Mnemonic.validate === "function" ? Boolean(k.Mnemonic.validate(clean)) : Boolean(new k.Mnemonic(clean));
  } catch {
    valid = false;
  }
  // KaPay iOS ImportWalletView's wording
  if (!valid) throw new Error("These words are invalid. Double-check the words - the last word encodes a checksum, so one wrong word fails validation.");
  return clean;
}

// --- Addresses ---------------------------------------------------------------------------

// Per network (iOS keeps spending state and the address cache apart): the same key derives
// kaspatest: addresses on testnet.
function spendingStateKey(accountId) { return netKey(`kachat.spending.${accountId}`); }
function addressCacheKey(accountId) { return netKey(`kachat.addresses.${accountId}`); }

/**
 * The account's spending-address bookkeeping - the desktop app's (engine/quantum.js
 * spendingStateFromRecord): `activeIndex` is the primary (a public index on either chain),
 * `maxIndex` the legacy chain's highest revealed index, `qMaxIndex` the quantum-safe chain's
 * (-1 before its first slot; public index QUANTUM_INDEX_BASE + n is its slot n, iOS bba1b1e),
 * `hidden` and `labels` keyed by public index, `qSpent` the quantum addresses that have spent.
 */
export async function spendingState(accountId) {
  const raw = (await getLocal(spendingStateKey(accountId))) || {};
  // Which index the Receive QR is handing out (iOS receiveAddressIndex) - separate from the
  // primary, which is where payments are SENT from.
  const receiveIndex = Number.isInteger(raw.receiveIndex) && raw.receiveIndex >= 0 ? raw.receiveIndex : null;
  return { ...spendingStateFromRecord(raw), receiveIndex };
}

// The password before every KAS you send (KaChat-Desktop Build 228, the owner's rule): asked here,
// before anything is built or a node is touched, so no screen can skip it. The page registers the
// prompt (spend-auth.js); with none registered nothing is sent. Cancelling is "nothing sent"
// (`SEND_CANCELLED`): callers just stop, no error shown.
export const SEND_CANCELLED = "SEND_CANCELLED";
// The caller's own check after the password said no (an approval window whose request the
// background no longer holds): nothing was built or sent, and the caller already says why.
export const SEND_ABORTED = "SEND_ABORTED";
let spendAuthorizer = null;
export function setSpendAuthorizer(fn) { spendAuthorizer = typeof fn === "function" ? fn : null; }
async function confirmSpend(details) {
  if (!spendAuthorizer) throw new Error("Open KaPay to confirm this send with your password.");
  if (await spendAuthorizer(details)) return;
  const error = new Error("Nothing was sent.");
  error.code = SEND_CANCELLED;
  throw error;
}
const sompiText = (sompi) => (sompi == null ? "" : `${formatKas(sompi, 8)} ${IS_TESTNET ? "TKAS" : "KAS"}`);

/** Used, as far as anyone can tell: on-chain history (REST), or - when that server's history has
 *  gaps (testnet's REST answered "0 transactions" for an address holding 50 TKAS) - a balance now.
 *  true / false, or null when neither can be read. */
async function addressUsedOrFunded(address) {
  const used = await addressUsed(address);
  if (used === true) return true;
  let funded = null;
  try { funded = ((await balancesFor([address]))[address] ?? 0n) > 0n; } catch { funded = null; }
  if (funded) return true;
  return used;
}

// Writes go to the account a send, sweep or probe started on, even if another one is active when it
// answers (iOS IOS-107/109) - and an account removed meanwhile gets nothing (no orphaned records).
async function accountStillExists(accountId) {
  const ids = await getLocal(ACCOUNT_IDS_KEY);
  return !Array.isArray(ids) || ids.includes(accountId);
}

export async function saveSpendingState(accountId, patch) {
  if (!(await accountStillExists(accountId))) return spendingState(accountId);
  const previous = (await getLocal(spendingStateKey(accountId))) || {};
  const next = { ...(await spendingState(accountId)), ...patch };
  // a revealed index widens its own chain's bound only: a quantum one never the legacy chain
  for (const index of [next.receiveIndex, next.activeIndex]) {
    if (!Number.isInteger(index)) continue;
    if (isQuantumIndex(index)) next.qMaxIndex = Math.max(next.qMaxIndex, chainLocalIndex(index));
    else next.maxIndex = Math.max(next.maxIndex, index);
  }
  const record = { ...spendingRecordFromState(next, previous), receiveIndex: Number.isInteger(next.receiveIndex) ? next.receiveIndex : null };
  await setLocal(spendingStateKey(accountId), record);
  return { ...spendingStateFromRecord(record), receiveIndex: record.receiveIndex };
}

/** The patch that reveals `index` on its own chain. */
function boundPatchFor(index, state) {
  return isQuantumIndex(index) ? { qMaxIndex: Math.max(state.qMaxIndex, chainLocalIndex(index)) } : { maxIndex: Math.max(state.maxIndex, index) };
}

/**
 * The next fresh quantum-safe slot, checked on chain first (iOS da2c8e2 verifiedFreshQuantumIndex,
 * IOS-101): this browser's end of the chain can sit below slots used elsewhere (another device, a
 * restore that hasn't looked far enough). While the REST server says the slot has history it is
 * skipped - the end raised past it, the slot listed like any revealed one - up to 20 times; a check that can't be answered takes the
 * slot as is, so an unreachable server never blocks a send. -> `{ index, address }`
 */
async function verifiedFreshQuantumSlot(account) {
  let state = await spendingState(account.id);
  let index = nextFreshQuantumIndex(state.qMaxIndex);
  let address = (await spendingAddressRange(index, 1, account))[index];
  for (let i = 0; i < FRESH_QUANTUM_PROBE_LIMIT && address; i += 1) {
    if ((await addressUsedOrFunded(address)) !== true) break;
    state = await saveSpendingState(account.id, { qMaxIndex: chainLocalIndex(index) });
    index = nextFreshQuantumIndex(state.qMaxIndex);
    address = (await spendingAddressRange(index, 1, account))[index];
  }
  return { index, address };
}

/** A quantum-safe address that has spent: its key is on chain for good (the shield comes off). */
async function markQuantumSpent(accountId, address) {
  const lowered = String(address || "").toLowerCase();
  const state = await spendingState(accountId);
  if (!lowered || state.qSpent.includes(lowered)) return;
  await saveSpendingState(accountId, { qSpent: [...state.qSpent, lowered] });
}

/** Addresses already derived for an account (public data), so the popup paints instantly. */
export async function cachedAddresses(accountId) {
  return (await getLocal(addressCacheKey(accountId))) || null;
}

/**
 * Derives the active account's main address and its revealed spending addresses. Needs the
 * wallet unlocked (reads the phrase from the vault for the moment it takes).
 */
export async function deriveAddresses() {
  const account = await activeAccountSecrets();
  const k = await kaspa();
  const main = await importMnemonicWithFamily(k, account.mnemonic, account.passphrase, {
    family: account.family,
    index: account.identityIndex,
  });
  const state = await spendingState(account.id);
  // both chains: legacy 0...maxIndex, then the quantum-safe slots (iOS allSpendingAddresses)
  const spending = await spendingAddressesAt(revealedSpendingIndices(state), account);
  const result = { accountId: account.id, main: main.address, spending, derivedAt: Date.now() };
  await setLocal(addressCacheKey(account.id), result);
  return result;
}

// --- Network -----------------------------------------------------------------------------

/**
 * A connected node, reusing the open one while it still answers. The engine picks the node the
 * same way the desktop app does: the user's own node if one is set, otherwise the Kaspa public
 * node resolver.
 */
// Every connection step goes to the console (right-click the popup > Inspect > Console), which
// is where to look when the dot stays yellow.
const logConnection = (...parts) => console.info("[KaPay]", ...parts);
const LAST_NODE_KEY = netKey("kachat.lastNode");

export async function connection(log = logConnection) {
  if (rpc && await probeRpc(rpc)) return rpc;
  if (!rpcPromise) {
    rpcPromise = (async () => {
      if (rpc) { await disconnectRpc(rpc); rpc = null; }
      const k = await kaspa();
      // Fast path: the node that answered last time, straight away. The public resolver scan
      // behind createRpc can spend 15-20 seconds on one unresponsive seed server before it
      // moves on, which every popup open would otherwise wait out. A user-set node is left to
      // createRpc, which connects to it strictly.
      if (!getEndpoint("trustedNode")) {
        // Kept in extension storage too: it is written straight to disk, where the engine's
        // localStorage registry can be lost when the browser is closed abruptly.
        const lastGood = (await getLocal(LAST_NODE_KEY)) || getNodeRegistrySnapshot().lastGoodEndpoint;
        if (lastGood) {
          try {
            rpc = await connectDirect(k, lastGood);
            log("Reconnected to the last node:", lastGood);
            return rpc;
          } catch (error) {
            log(`Last node ${lastGood} did not answer (${error?.message || error}); scanning for another.`);
          }
        }
      }
      rpc = getEndpoint("trustedNode") ? await createRpc(k, log) : await raceForNode(k, log);
      if (!getEndpoint("trustedNode") && rpc?.url) await setLocal(LAST_NODE_KEY, rpc.url);
      return rpc;
    })().finally(() => { rpcPromise = null; });
  }
  return rpcPromise;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * No remembered node: the public resolver scan, and - if it has not answered within three
 * seconds - the known public nodes tried directly alongside it. First to connect wins; a late
 * second connection is closed. The resolver alone can sit 20 seconds on one dead seed server.
 */
async function raceForNode(k, log) {
  let settled = false;
  const viaResolver = createRpc(k, log);
  const viaKnownNodes = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    // shuffled, without a node that answered the impossible this session (DSK-046)
    const nodes = knownPublicNodes();
    for (const url of nodes) {
      if (settled) break;
      try {
        const client = await connectDirect(k, url);
        log("Connected directly to a known public node:", url);
        return client;
      } catch { /* next */ }
    }
    throw new Error("No known public node answered.");
  })();
  const attempts = [viaResolver, viaKnownNodes];
  let winner;
  try {
    winner = await Promise.any(attempts);
  } catch {
    throw new Error("Can't reach a Kaspa node right now.");
  }
  settled = true;
  for (const attempt of attempts) attempt.then((client) => { if (client && client !== winner) disconnectRpc(client); }, () => {});
  return winner;
}

/** One node, once, fast: connect, confirm it is synced, or give up within a few seconds. */
async function connectDirect(k, url, timeoutMs = 5000) {
  const client = new k.RpcClient({ url, encoding: k.Encoding?.Borsh, networkId: NETWORK_ID });
  try {
    await withTimeout(
      client.connect({ blockAsyncConnect: true, strategy: k.ConnectStrategy?.Fallback ?? 1, timeoutDuration: timeoutMs }),
      timeoutMs + 1000,
      "Connecting",
    );
    const info = await withTimeout(client.getServerInfo(), 5000, "Node check");
    if (info?.isSynced === false) throw new Error("node is not synced");
    // A node of the other network answers too; only the running network's will do.
    const net = String(info?.networkId ?? "").toLowerCase();
    if (net && (IS_TESTNET ? !net.includes("testnet") : net.includes("testnet"))) throw new Error(`node is on ${info.networkId}`);
    return client;
  } catch (error) {
    try { await client.disconnect(); } catch { /* already closed */ }
    throw error;
  }
}

export function connectedNodeUrl() {
  return rpc?.url || "";
}

export async function disconnect() {
  const current = rpc;
  rpc = null;
  await disconnectRpc(current);
}

/**
 * Balances for the main address and every visible spending address, in sompi (BigInt), plus
 * the total. One node round trip per address, all in parallel.
 */
export async function balances(addresses, hiddenIndexes = []) {
  const k = await kaspa();
  const hidden = new Set(hiddenIndexes);
  const spendingEntries = Object.entries(addresses.spending || {}).filter(([index]) => !hidden.has(Number(index)));
  // through withRpc: a node answering an above-supply coin is dropped and another asked (EXT-024)
  const [main, ...spending] = await withRpc((node) => Promise.all([
    getBalance(k, node, addresses.main),
    ...spendingEntries.map(([, address]) => getBalance(k, node, address)),
  ]));
  const bySpendingIndex = {};
  spendingEntries.forEach(([index], i) => { bySpendingIndex[index] = spending[i].totalSompi; });
  const total = spending.reduce((sum, b) => sum + b.totalSompi, main.totalSompi);
  return { main: main.totalSompi, spending: bySpendingIndex, total };
}

// --- KNS ---------------------------------------------------------------------------------

function knsOptions() {
  const configured = String(getEndpoint("knsApi") || "").replace(/\/+$/, "");
  if (IS_TESTNET && (!configured || configured === MAINNET_KNS)) return { baseUrl: TESTNET_KNS };
  return { baseUrl: configured || MAINNET_KNS };
}

/** The KNS API for the running network (Connection Settings > Domains shows it). */
export function knsApiUrl() { return knsOptions().baseUrl; }
/** The Kaspa REST API for the running network. */
export function restApiUrl() { return restBase(); }

/** What is cached for an address right now (no network): { domainName, profile, domainCount }. */
export function cachedKns(address) {
  return knsView(peekAddressInfo(address));
}

/**
 * The address's .kas name and domain count, refreshed. Only the NAME: like iOS (KNSService
 * .loadsDomainProfiles = false), KaChat no longer loads .kas profiles - avatar, banner and bio
 * will come from .kachat names.
 */
export async function kns(address, { force = false } = {}) {
  const options = knsOptions();
  const info = force ? await fetchAddressInfo(address, options) : await getAddressInfo(address, options);
  return knsView(info);
}

function knsView(info) {
  const domains = Array.isArray(info?.allDomains) ? info.allDomains : [];
  return {
    domainName: info?.primaryDomain || null,
    domainCount: domains.length,
    known: Boolean(info),
  };
}

// --- Price -------------------------------------------------------------------------------

export function cachedPrice(currency = "usd") {
  return peekKasPrice(currency);
}

export async function price(currency = "usd") {
  try {
    return await fetchKasPrice({ currency });
  } catch {
    return peekKasPrice(currency);
  }
}

// --- Formatting --------------------------------------------------------------------------

const SOMPI_PER_KAS = 100_000_000n;

/** "1,234.5678 KAS"-style text from sompi, trimmed to `decimals` places (floor, never rounds up). */
export function formatKas(sompi, decimals = 4) {
  const value = BigInt(sompi || 0n);
  const whole = value / SOMPI_PER_KAS;
  const fraction = (value % SOMPI_PER_KAS).toString().padStart(8, "0").slice(0, decimals).replace(/0+$/, "");
  const wholeText = whole.toLocaleString("en-US");
  return fraction ? `${wholeText}.${fraction}` : wholeText;
}

export function formatFiat(sompi, priceEntry) {
  if (!priceEntry?.price) return "";
  const kasValue = Number(BigInt(sompi || 0n)) / 1e8;
  const currency = String(priceEntry.currency || "usd").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(kasValue * priceEntry.price);
  } catch {
    return `${(kasValue * priceEntry.price).toFixed(2)} ${currency}`;
  }
}

export function shortAddress(address) {
  const text = String(address || "");
  if (text.length <= 22) return text;
  return `${text.slice(0, 12)}…${text.slice(-6)}`;
}


// =========================================================================================
// Phase 2: sending and address management
// =========================================================================================
//
// A "source" names which of the account's addresses a transaction spends from:
//   { kind: "main" }                  the chatting (identity) address
//   { kind: "spending", index: n }    spending address #n
// Keys are derived from the vault for the moment they are needed and handed to the engine as
// hex; nothing about them is kept afterwards.

const NETWORK = NETWORK_ID;
export { SOURCE_CHANGED };

/**
 * The source's key, from the vault. `reviewed` ({ address, accountId }, either optional) is what
 * the screen showed: the active account is whatever the vault says NOW, and another KaPay window
 * can switch it (or change the chatting address) between the review and the swipe - so a key
 * whose address isn't the reviewed one is refused before anything is built (SOURCE_CHANGED).
 */
async function sourceWallet(source, reviewed = null) {
  // `accountId` pins a specific account (a website's connected account); otherwise the active one.
  const account = source?.accountId ? await accountSecretsById(source.accountId) : await activeAccountSecrets();
  const k = await kaspa();
  let from;
  if (source?.kind === "spending") {
    const derived = deriveSpendingWallet(k, account.mnemonic, source.index, account.passphrase);
    // a quantum-safe address (KIP-22) spends with its redeem script pushed after each signature
    from = { accountId: account.id, address: derived.address, privateKeyHex: derived.privateKeyHex, redeemScript: derived.redeemScript || null, quantum: Boolean(derived.quantum) };
  } else {
    const derived = await importMnemonicWithFamily(k, account.mnemonic, account.passphrase, {
      family: account.family,
      index: account.identityIndex,
    });
    from = { accountId: account.id, address: derived.address, privateKeyHex: derived.privateKeyHex };
  }
  const changed = sourceChangedError(reviewed, from);
  if (changed) throw changed;
  return from;
}

/** The node call wrapper the engine expects: one reconnect-and-retry on a dropped socket. */
async function withRpc(fn) {
  try {
    return await fn(await connection());
  } catch (error) {
    if (error?.badNode) {
      // Up but answering the impossible (DSK-046, KaChat-Desktop e6b0b71): out of the races, the
      // remembered nodes and the last-node fast path, then once more on another node. A node the
      // user set is theirs - its answer is refused, never swapped.
      if (getEndpoint("trustedNode")) throw error;
      const endpoint = rpc?.url || "";
      logConnection(`${error.message} from ${endpoint || "the node"}; switching nodes...`);
      if (endpoint) {
        forgetEndpoint(endpoint);
        markBadNode(endpoint);
        if ((await getLocal(LAST_NODE_KEY)) === endpoint) await removeLocal(LAST_NODE_KEY);
      }
      await disconnect();
      return fn(await connection());
    }
    if (!/not connected|closed|timed out|timeout|network/i.test(String(error?.message || error))) throw error;
    await disconnect();
    return fn(await connection());
  }
}

// --- Coins a send just spent (KaPay iOS 0799cec recordSpend / unreservedUtxos) ------------------
//
// The node lists a spent coin until its spend is in a block, so a send's inputs stay out of the next
// send, Max and fee for two minutes (send-coins.js), also after "Not confirmed". They're kept in
// storage.session too: the popup closes when it loses focus, and a send started again from it (or
// from the full tab) a moment later must still leave them out. The engine applies its reserved list
// (setReservedOutpoints) to every build and estimate; it gets the live holds before each send,
// estimate and Max, and again as the earliest one runs out. There's no UTXO cache here to drop: every
// list is fetched fresh.
const SPENT_COINS_KEY = netKey("kachat.spentCoins");
let spentCoins = {};
let holdTimer = null;
function pushHolds() {
  const now = Date.now();
  spentCoins = liveHolds(spentCoins, now);
  setReservedOutpoints(heldKeys(spentCoins, now));
  clearTimeout(holdTimer);
  const next = nextHoldExpiry(spentCoins, now);
  holdTimer = next == null ? null : setTimeout(pushHolds, next - now + 50);
}
/** This page's holds and every other KaPay window's, pushed to the engine. */
async function currentHolds() {
  let stored = null;
  try { stored = await getSession(SPENT_COINS_KEY); } catch { stored = null; }
  spentCoins = mergeHolds(spentCoins, stored);
  pushHolds();
  return spentCoins;
}
/** Holds a send's inputs. The engine has them at once, before a send queued behind this one builds;
 *  storage follows. */
async function holdCoins(keys, address) {
  if (!keys?.length) return;
  spentCoins = holdSpentCoins(spentCoins, keys, address);
  pushHolds();
  try {
    spentCoins = mergeHolds(spentCoins, await getSession(SPENT_COINS_KEY));
    pushHolds();
    await setSession(SPENT_COINS_KEY, spentCoins);
  } catch (error) {
    console.warn("[KaPay] couldn't keep a send's coins for other windows:", error);
  }
}
/** How many of `address`'s coins the last send holds (as last read). */
export function heldCoinCount(address) { return heldCountAt(spentCoins, address); }
export { HELD_COINS_MESSAGE };

/** The address's coins as node entries, less the held ones. */
async function spendableEntries(address) {
  const response = await withRpc(async (node) => checkedUtxoAnswer(await node.getUtxosByAddresses([address])));
  return withoutHeldCoins(sanitizeUtxoEntries(response?.entries), await currentHolds());
}
/** The coins a Max or Compound spends (KaPay iOS 0799cec oneTransactionChunk): the coin-control
 *  pick, else the largest 80 when there are more than one transaction can spend, else null (every
 *  coin). The Max estimate and the send each work it out, from their own fetch, the same way. */
async function maxPickAt(address, selectedOutpoints = null) {
  if (Array.isArray(selectedOutpoints) && selectedOutpoints.length) return selectedOutpoints;
  return maxCoinKeys(await spendableEntries(address));
}

/** Spendable coins at an address, sorted largest first; coins the last send spent are left out. */
export async function utxos(address) {
  const response = await withRpc(async (node) => checkedUtxoAnswer(await node.getUtxosByAddresses([address])));
  const holds = await currentHolds();
  return withoutHeldCoins(response?.entries || [], holds)
    .map((entry) => ({
      entry,
      key: `${entry?.outpoint?.transactionId}:${entry?.outpoint?.index}`,
      transactionId: String(entry?.outpoint?.transactionId || ""),
      index: Number(entry?.outpoint?.index ?? 0),
      amount: BigInt(entry?.amount ?? 0),
      daaScore: BigInt(entry?.blockDaaScore ?? 0),
      isCoinbase: Boolean(entry?.isCoinbase),
    }))
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
}

/** A KAS amount (typed or computed) in sompi, or null - the one exact parser (amounts.js). */
export function kasToSompi(kasText) {
  return sompiFromUserText(kasText);
}

export function sompiToKasText(sompi) {
  return formatKas(sompi, 8).replace(/,/g, "");
}

/** Is this a valid mainnet Kaspa address? (checksum included, via the SDK) */
export async function isValidAddress(text) {
  const clean = String(text || "").trim();
  if (!clean.startsWith(ADDRESS_PREFIX) || !/^[a-z]+:[a-z0-9]{50,}$/.test(clean)) return false;
  try {
    const k = await kaspa();
    return typeof k.Address?.validate === "function" ? Boolean(k.Address.validate(clean)) : Boolean(new k.Address(clean));
  } catch {
    return false;
  }
}

/**
 * Why a valid address can't be used here: it is the other network's (iOS
 * KaspaAddress.otherNetworkReason, ce20e87 / audit IOS-003). Paying a kaspatest: address on
 * mainnet would send real KAS to that key's mainnet script. null for an address of the running
 * network, or one that isn't valid at all.
 */
export function otherNetworkReason(address) {
  const clean = String(address || "").trim().toLowerCase().split("?")[0];
  if (!isValidKaspaAddress(clean)) return null;
  const network = networkOfAddress(clean);
  if (!network || network === ACTIVE_NETWORK) return null;
  return network === "testnet" ? "This is a Testnet address. KaPay is on Mainnet." : "This is a Mainnet address. KaPay is on Testnet.";
}

/**
 * What the recipient field means: a kaspa: address, or a name on any service (iOS
 * NameServicesClient) - the ending typed, else the first of .kachat, .kas, .k, .kaspa that
 * resolves. Returns { address, domain, tld, resolutions } - `resolutions` is every service's
 * answer, for the "Other domains" picker - or throws with the message to show (a not-found error
 * carries `resolutions` too: another service may have the name).
 */
export async function resolveRecipient(input) {
  const text = String(input || "").trim();
  if (!text) throw new Error("Enter a Kaspa address (kaspa:...)");
  if (/^kaspa(test)?:/i.test(text)) {
    const address = text.split("?")[0].toLowerCase();
    if (!(await isValidAddress(address))) throw new Error(otherNetworkReason(address) || "Invalid address format");
    return { address, domain: null, tld: null, resolutions: [] };
  }
  if (looksLikeName(text)) {
    const resolutions = await resolveEverywhere(text);
    const primary = primaryResolution(resolutions, text);
    if (!primary) {
      const error = new Error(notFoundMessage(text, resolutions));
      error.resolutions = resolutions;
      throw error;
    }
    return { address: primary.address, domain: primary.display, tld: primary.tld, resolutions };
  }
  throw new Error("Invalid address format");
}

/**
 * Fee for sending `amountKas` from `address`: { policyKas, sdkBaseKas } as numbers. The policy fee
 * (mass x 100 sompi/gram, as on iOS) is what is shown and paid; the SDK adds its own base fee
 * automatically, so the send passes the difference as a priority tip.
 */
export async function estimateFee({ address, amountKas = "0.2", selectedOutpoints = null }) {
  // the send leaves out coins just spent, so the estimate does too (KaPay iOS 0799cec)
  await currentHolds();
  const detail = await estimateSendFeeDetail({
    kaspa: await kaspa(),
    rpc: await connection(),
    withRpc,
    sourceAddress: address,
    amountKas: String(amountKas),
    payloadBytes: 0,
    selectedOutpoints,
  });
  // nothing left to estimate with because the last send holds it: say so, not "no coins"
  if (!detail && heldCoinCount(address)) throw new Error(HELD_COINS_MESSAGE);
  if (!detail) return null;
  return { policyKas: Number(detail.policyFeeKas), sdkBaseKas: Number(detail.sdkFeeKas) };
}

/** Fee for spending `inputCount` coins into one output (Max, compound), at the live quoted rate.
 *  `sourceIndex`: a quantum-safe source's inputs carry their redeem script (101-byte signature
 *  scripts, iOS kip22SignatureScriptSize); outputs are priced as the bigger P2SH script (35 bytes,
 *  iOS 40e8c50), which a quantum-safe address is. */
export async function maxFee(inputCount, { sourceIndex = null } = {}) {
  const rate = await fetchQuotedFeeRateSompiPerGram();
  const sigScriptLen = isQuantumIndex(sourceIndex) ? KIP22_SIGNATURE_SCRIPT_SIZE : 66;
  const mass = calculateMass(Math.max(1, inputCount), [35, 35], 0, 1, sigScriptLen);
  return { policyKas: Number(calculateFee(mass, rate)) / 1e8, sdkBaseKas: Number(mass) / 1e8 };
}

/**
 * Max worked out exactly as the send will (engine estimateMaxSend): the coins at `address` now
 * (or the picked ones), one output to `destination`, `totalFeeKas` raised to the network floor.
 * Its `outpoints` and `amountSompi` are the pin a Max send is given, so what's sent is what was
 * shown. Coins the last send spent are left out, and past 80 coins it's the largest 80 (one
 * transaction's worth, KaPay iOS 0799cec): the send picks the same ones.
 * -> { outpoints, totalSompi, feeSompi, amountSompi, inputCount, availableSompi }
 */
export async function estimateMax({ address, destination = null, selectedOutpoints = null, totalFeeKas = null }) {
  await currentHolds();
  try {
    return await estimateMaxSend({
      kaspa: await kaspa(), rpc: await connection(), withRpc,
      sourceAddress: address, destinationAddress: destination || address,
      selectedOutpoints: await maxPickAt(address, selectedOutpoints),
      totalFeeSompi: totalFeeKas != null ? kasToSompi(String(totalFeeKas)) : null,
    });
  } catch (error) {
    throw heldCoinsError(error);
  }
}

/** One engine send from `address` (send-coins.js watchedSend, KaPay iOS 0799cec): the coins it spent
 *  are held once it's out or "Not confirmed", and a node's rejection is reported as one even when
 *  another node timed out first. `start({ kaspa, withRpc })` calls the engine with those two. */
async function spendFrom(address, start) {
  await currentHolds();
  return watchedSend({ kaspa: await kaspa(), withRpc, start, onSpent: (keys) => holdCoins(keys, address) });
}

/**
 * Sends Kaspa. `max` spends every coin (or the selected ones) into ONE output of total minus
 * `totalFeeKas`, which is the only shape KIP-9 accepts near a full balance. A normal send pays
 * `tipKas` on top of the SDK's base fee. Sending from the PRIMARY spending address sends change
 * to a fresh address and moves the primary there once the node accepts it (iOS/desktop parity).
 * `fromAddress` / `fromAccountId`: the source the review showed - a different key is refused
 * (SOURCE_CHANGED) before anything is built. A Max pins `maxAmountSompi` (the amount shown) and
 * `maxOutpoints` (the coins it was worked out from, estimateMax): coins or a fee that changed
 * meanwhile throw MAX_AMOUNT_CHANGED with the new amount, and nothing is sent.
 */
export async function send({ source, destination, amountKas = null, tipKas = "0", totalFeeKas = null, selectedOutpoints = null, max = false, maxAmountSompi = null, maxOutpoints = null, fromAddress = null, fromAccountId = null, totalText = null, extraFeeText = null, beforeBuild = null, onAuthorized = null }) {
  await confirmSpend({ amountText: max ? sompiText(maxAmountSompi) : sompiText(kasToSompi(String(amountKas ?? ""))), recipient: destination, max, totalText, extraFeeText });
  // the caller's last word, after the password (which can sit open for a while) and before anything
  // is built: false stops here (audit 2026-11-07)
  if (beforeBuild && !(await beforeBuild())) {
    const error = new Error("Nothing was sent.");
    error.code = SEND_ABORTED;
    throw error;
  }
  // past the password: from here on the send may reach the network (the approval window says so)
  onAuthorized?.();
  // derived after the password, which can sit open while another window switches accounts
  const from = await sourceWallet(source, { address: fromAddress, accountId: fromAccountId });
  const node = await connection();
  const log = (...parts) => console.info("[KaPay]", ...parts);
  if (max) {
    // the coins estimateMax worked out from, picked again the same way: past 80 coins the largest 80
    const pick = await maxPickAt(from.address, selectedOutpoints);
    return afterSend(spendFrom(from.address, (engine) => sendMaxKaspa({
      ...engine, rpc: node, privateKey: from.privateKeyHex, sourceAddress: from.address,
      destinationAddress: destination,
      totalFeeSompi: totalFeeKas != null ? kasToSompi(String(totalFeeKas)) : null,
      selectedOutpoints: pick, redeemScript: from.redeemScript, log,
      expectedAmountSompi: maxAmountSompi, expectedOutpoints: maxOutpoints,
    })), async () => { if (from.quantum) await markQuantumSpent(from.accountId, from.address); });
  }
  // Where a spending address's change goes (iOS sendFromSpendingAddress, bba1b1e; engine
  // spendingChangeIndex): a quantum-safe source - its spend reveals its key - and the primary send
  // their change to a brand-new quantum-safe slot, and the primary moves there once the node has
  // the transaction; any other address keeps its change. A send to itself consolidates in place.
  let fresh = null;
  let wasPrimary = false;
  if (source?.kind === "spending") {
    const state = await spendingState(from.accountId);
    wasPrimary = source.index === state.activeIndex;
    const index = spendingChangeIndex({
      purpose: "withdraw", sourceIndex: source.index, primaryIndex: state.activeIndex, qMaxIndex: state.qMaxIndex,
      selfSend: String(destination).toLowerCase() === String(from.address).toLowerCase(),
    });
    if (index != null) {
      const account = await accountSecretsById(from.accountId);
      // a fresh quantum slot, checked on chain first (iOS da2c8e2)
      try { fresh = await verifiedFreshQuantumSlot(account); } catch { fresh = null; }
      if (!fresh?.address) fresh = null;
      // a quantum source's change never goes back to the key its spend reveals (IOS-104)
      if (!fresh && from.quantum) throw new Error(QUANTUM_CHANGE_UNAVAILABLE);
    }
  }
  if (fresh) {
    // The change slot is recorded before anything is submitted (its chain's end and the address
    // cache, as reserveFreshSpendingAddress does): a popup closed mid-send, or a chained send that
    // fails partway, would otherwise leave change on a slot nothing lists, and the balance looks
    // gone. Only the primary waits for the node to take it.
    await saveSpendingState(from.accountId, boundPatchFor(fresh.index, await spendingState(from.accountId)));
    await cacheSpendingAddress(from.accountId, fresh.index, fresh.address);
  }
  return afterSend(spendFrom(from.address, (engine) => sendKaspa({
    ...engine, rpc: node, privateKey: from.privateKeyHex, sourceAddress: from.address,
    destinationAddress: destination, amountKas: String(amountKas), feeKas: String(tipKas || "0"),
    selectedOutpoints, changeAddress: fresh?.address || null, redeemScript: from.redeemScript, log,
  })), async () => {
    if (from.quantum) await markQuantumSpent(from.accountId, from.address);
    if (fresh && wasPrimary) await saveSpendingState(from.accountId, { activeIndex: fresh.index });
  });
}

/** What a send records once it's out: also after "Not confirmed", since that one may still land
 *  (KaPay iOS 953b255 noteSpend) - a quantum key it revealed, the primary moving to its change.
 *  Bookkeeping never changes how the send went: a storage failure after the node took it, shown
 *  as Failed with Try Again, would pay twice. It is logged and the result stands. */
async function afterSend(sending, record) {
  let result;
  try {
    result = await sending;
  } catch (error) {
    if (error?.code === SEND_OUTCOME_UNKNOWN) await recordQuietly(record);
    throw error;
  }
  await recordQuietly(record);
  return result;
}
async function recordQuietly(record) {
  try { await record(); } catch (error) { console.warn("[KaPay] couldn't record a send (it went out as reported):", error); }
}

/** Merges the source's coins into one (a self-send with no change) in ONE transaction: every coin,
 *  or past 80 the largest 80 (KaPay iOS 0799cec: Compound uses one transaction's worth, one chunk at
 *  a time). `outpoints`: the coins the screen worked the amount out from (send.js); else picked
 *  here the same way. `totalFeeKas` is paid as shown, raised only to the network floor. A Max send to
 *  the source itself, which a quantum-safe source signs with its redeem script like any other send.
 *  `fromAddress` / `fromAccountId`: the source the screen showed (a different key is refused,
 *  SOURCE_CHANGED). */
export async function compound(source, totalFeeKas = null, { fromAddress = null, fromAccountId = null, outpoints = null } = {}) {
  const from = await sourceWallet(source, { address: fromAddress, accountId: fromAccountId });
  const chunked = Array.isArray(outpoints) && outpoints.length > 0;
  await confirmSpend({ title: "Confirm Compound", amountText: chunked ? `Your ${outpoints.length} largest coins into one` : "Every coin into one", recipient: from.address });
  // picked after the password, like every send's coins
  const pick = await maxPickAt(from.address, outpoints);
  // consolidating spends too: the key is on chain now (the shield comes off)
  return afterSend(spendFrom(from.address, async (engine) => sendMaxKaspa({
    ...engine, rpc: await connection(),
    privateKey: from.privateKeyHex, sourceAddress: from.address, destinationAddress: from.address,
    totalFeeSompi: totalFeeKas != null ? kasToSompi(String(totalFeeKas)) : null,
    selectedOutpoints: pick, redeemScript: from.redeemScript,
    // the 80 coins the review showed, exactly: one spent meanwhile throws MAX_AMOUNT_CHANGED rather
    // than compounding fewer at the fee worked out for all of them
    expectedOutpoints: chunked ? outpoints : null,
    log: (...parts) => console.info("[KaPay]", ...parts),
  })), async () => { if (from.quantum) await markQuantumSpent(from.accountId, from.address); });
}

/** The source's private key as hex - for the reveal screen, behind the password. `fromAddress`:
 *  the address the screen is for; another account's key is never handed out under it. */
export async function privateKeyHex(source, { fromAddress = null } = {}) {
  return (await sourceWallet(source, { address: fromAddress })).privateKeyHex;
}

/** The source's public key (compressed, hex). */
export async function publicKeyHex(source, { fromAddress = null } = {}) {
  const from = await sourceWallet(source, { address: fromAddress });
  const k = await kaspa();
  return String(new k.PrivateKey(from.privateKeyHex).toPublicKey().toString());
}

// --- History ------------------------------------------------------------------------------

function restBase() {
  const configured = String(getEndpoint("kaspaApi") || "").replace(/\/+$/, "");
  // Testnet reads api-tn10 (iOS a67a1c2) - also while the shared endpoint defaults still say mainnet.
  if (IS_TESTNET && (!configured || configured === MAINNET_REST)) return TESTNET_REST;
  return configured || MAINNET_REST;
}

/**
 * Up to 200 transactions touching `address`, newest first - iOS fetchFullTransactionsResult
 * (one page of 200, retried at 0 / 0.6 / 2 / 5 s on HTTP 429 or 5xx only). Returns
 * { txs, complete }: complete is false when the page could not be fetched.
 * Each tx: { txid, time (ms), direction: "out" | "in" | null, amountSompi, feeSompi }.
 */
/** The address's last `limit` transactions as the REST API sends them (inputs with their
 *  previous-outpoint address, outputs, block_time, transaction_id), or null when they can't be
 *  read - for the bell's received-Kaspa check (iOS AddressActivityNotifier catch-up). */
export async function recentTransactions(address, limit = 10) {
  const url = `${restBase()}/addresses/${encodeURIComponent(address)}/full-transactions?limit=${limit}&offset=0&resolve_previous_outpoints=light`;
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const txs = await response.json().catch(() => null);
    return Array.isArray(txs) ? txs : null;
  } catch {
    return null;
  }
}

export async function history(address) {
  const url = `${restBase()}/addresses/${encodeURIComponent(address)}/full-transactions?limit=200&offset=0&resolve_previous_outpoints=light`;
  for (const delay of [0, 600, 2000, 5000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    } catch {
      continue;
    }
    if (response.ok) {
      const txs = await response.json().catch(() => null);
      if (!Array.isArray(txs)) return { txs: [], complete: false };
      // a block reward the chain never accepted paid nothing: not history (iOS d194a38)
      return { txs: txs.filter(transactionBelongsInHistory).map((tx) => describeTransaction(tx, address)), complete: true };
    }
    if (response.status !== 429 && response.status < 500) break;
  }
  return { txs: [], complete: false };
}

// iOS KaspaFullTransactionResponse.direction(for:) and feeText(): outgoing when this address
// paid in and some output goes elsewhere (amount = the smallest such output); incoming when it
// only receives (amount = everything paid to it); otherwise no direction ("Transaction").
function describeTransaction(tx, address) {
  const inputs = tx.inputs || [];
  const outputs = tx.outputs || [];
  const isSender = inputs.some((input) => input.previous_outpoint_address === address);
  const toOthers = outputs.filter((o) => o.script_public_key_address && o.script_public_key_address !== address).map((o) => BigInt(o.amount || 0));
  const toUs = outputs.filter((o) => o.script_public_key_address === address).reduce((sum, o) => sum + BigInt(o.amount || 0), 0n);
  let direction = null;
  let amountSompi = null;
  if (isSender && toOthers.length) {
    direction = "out";
    amountSompi = toOthers.reduce((min, v) => (v < min ? v : min));
  } else if (!isSender && toUs > 0n) {
    direction = "in";
    amountSompi = toUs;
  }
  let feeSompi = null;
  if (inputs.length && inputs.every((input) => input.previous_outpoint_amount != null)) {
    const totalIn = inputs.reduce((sum, input) => sum + BigInt(input.previous_outpoint_amount), 0n);
    const totalOut = outputs.reduce((sum, o) => sum + BigInt(o.amount || 0), 0n);
    if (totalIn >= totalOut) feeSompi = totalIn - totalOut;
  }
  return { txid: tx.transaction_id, time: Number(tx.block_time || 0), direction, amountSompi, feeSompi };
}

// --- UTXO labels (iOS setSpendingUtxoLabel: per address, keyed "txid:index") -----------------

function utxoLabelsKey(address) { return `kachat.utxoLabels.${address}`; }

export async function utxoLabels(address) {
  return (await getLocal(utxoLabelsKey(address))) || {};
}

export async function setUtxoLabel(address, outpointKey, label) {
  const labels = await utxoLabels(address);
  const clean = String(label || "").trim();
  if (clean) labels[outpointKey] = clean; else delete labels[outpointKey];
  await setLocal(utxoLabelsKey(address), labels);
  return labels;
}

/**
 * Which addresses have ever been touched on chain, in bulk: POST /addresses/active, 250 per
 * request, 4 at a time (iOS AddressActivityService). { address: boolean }, or null when the
 * REST server can't answer it (callers fall back to sweeping balances).
 */
export async function addressesActive(addresses) {
  const batches = [];
  for (let i = 0; i < addresses.length; i += 250) batches.push(addresses.slice(i, i + 250));
  const out = {};
  for (let i = 0; i < batches.length; i += 4) {
    const results = await Promise.all(batches.slice(i, i + 4).map(async (batch) => {
      const response = await fetch(`${restBase()}/addresses/active`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ addresses: batch }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }).map((p) => p.catch(() => null)));
    if (results.some((r) => !Array.isArray(r))) return null;
    for (const list of results) for (const entry of list) out[entry.address] = Boolean(entry.active);
  }
  return out;
}

const USED_KEY = netKey("kachat.usedAddresses");

/**
 * Has this address ever appeared on chain? iOS spendingAddressUsedState: the REST
 * transactions-count. A "used" answer is remembered for good; null means the probe failed.
 */
const sessionUnused = new Set();

/** What is known without asking: true (used, remembered for good), false (unused this session), or null. */
export async function knownUsedState(address) {
  if (new Set((await getLocal(USED_KEY)) || []).has(address)) return true;
  return sessionUnused.has(address) ? false : null;
}

/** Every address remembered as used (for good). */
export async function knownUsedAddresses() {
  return (await getLocal(USED_KEY)) || [];
}

export async function addressUsed(address) {
  const used = new Set((await getLocal(USED_KEY)) || []);
  if (used.has(address)) return true;
  try {
    const response = await fetch(`${restBase()}/addresses/${encodeURIComponent(address)}/transactions-count`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const json = await response.json();
    const isUsed = Number(json?.total ?? 0) > 0;
    if (isUsed) { used.add(address); await setLocal(USED_KEY, [...used]); } else sessionUnused.add(address);
    return isUsed;
  } catch {
    return null;
  }
}

// --- Spending addresses -------------------------------------------------------------------

async function cacheSpendingAddress(accountId, index, address) {
  if (!(await accountStillExists(accountId))) return;
  const cached = (await cachedAddresses(accountId)) || { accountId, main: null, spending: {} };
  cached.spending = { ...(cached.spending || {}), [index]: address };
  await setLocal(addressCacheKey(accountId), cached);
}

/** Addresses for a run of spending indexes, deriving the seed only once for the whole run (a run
 *  from QUANTUM_INDEX_BASE up is the quantum-safe chain, engine deriveSpendingAddressRange). */
export async function spendingAddressRange(start, count, account = null) {
  const secrets = account || (await activeAccountSecrets());
  const k = await kaspa();
  const result = {};
  for (const { index, address } of deriveSpendingAddressRange(k, secrets.mnemonic, secrets.passphrase, { start, count })) result[index] = address;
  return result;
}

/** Addresses for any public indexes, both chains (each chain's run derived once). */
async function spendingAddressesAt(indexes, account = null) {
  const secrets = account || (await activeAccountSecrets());
  const legacy = indexes.filter((i) => !isQuantumIndex(i));
  const quantum = indexes.filter((i) => isQuantumIndex(i));
  const out = {};
  if (legacy.length) Object.assign(out, await spendingAddressRange(Math.min(...legacy), Math.max(...legacy) - Math.min(...legacy) + 1, secrets));
  if (quantum.length) Object.assign(out, await spendingAddressRange(Math.min(...quantum), Math.max(...quantum) - Math.min(...quantum) + 1, secrets));
  const wanted = new Set(indexes);
  for (const key of Object.keys(out)) if (!wanted.has(Number(key))) delete out[key];
  return out;
}

/** Every revealed spending address of the active account, with balances (one node call). */
export async function spendingList() {
  const account = await activeAccountSecrets();
  const state = await spendingState(account.id);
  const cached = (await cachedAddresses(account.id))?.spending || {};
  const indexes = revealedSpendingIndices(state);
  const missing = indexes.filter((index) => !cached[index]);
  let addresses = { ...cached };
  if (missing.length) {
    addresses = { ...addresses, ...(await spendingAddressesAt(missing, account)) };
    const all = (await cachedAddresses(account.id)) || { accountId: account.id, main: null };
    await setLocal(addressCacheKey(account.id), { ...all, accountId: account.id, spending: addresses });
  }
  const balancesByAddress = await balancesFor(indexes.map((i) => addresses[i]));
  return {
    accountId: account.id,
    state,
    rows: indexes.map((index) => ({
      index,
      address: addresses[index],
      label: labelFor(state, index),
      customLabel: customLabel(state, index),
      hidden: state.hidden.includes(index),
      primary: index === state.activeIndex,
      balanceSompi: balancesByAddress[addresses[index]] ?? 0n,
      // quantum-safe (KIP-22): the shield, off once the address has spent (its key is public)
      quantum: isQuantumIndex(index),
      spent: isQuantumIndex(index) && state.qSpent.includes(String(addresses[index] || "").toLowerCase()),
    })),
  };
}

// Whether a quantum-safe address has ever SPENT - the one event that puts its key on chain
// (receiving reveals nothing; iOS ChatService.quantumAddressSpentState). true is remembered for
// good; false = no spend in its whole history (reused for a minute, so repaints don't flood the
// REST server); null = the history can't be read now.
const quantumUnspentSeenAt = new Map();
export async function quantumSpentState(address, accountId = null) {
  // marks go to the account whose row was probed (IOS-109), not whichever is active when it answers
  const account = accountId ? { id: accountId } : await activeAccountSecrets();
  const lowered = String(address || "").toLowerCase();
  if (!lowered) return null;
  if ((await spendingState(account.id)).qSpent.includes(lowered)) return true;
  if (Date.now() - (quantumUnspentSeenAt.get(lowered) || 0) < 60_000) return false;
  // the whole history, page by page, until a spend is found (iOS da2c8e2 / IOS-105): an unreadable
  // page, or a history deeper than 10,000, answers unknown - never "not spent"
  const PAGE = 500;
  try {
    for (let offset = 0; offset < 10_000; offset += PAGE) {
      const url = `${restBase()}/addresses/${encodeURIComponent(address)}/full-transactions?limit=${PAGE}&offset=${offset}&resolve_previous_outpoints=light`;
      const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return null;
      const txs = await response.json();
      if (!Array.isArray(txs)) return null;
      if (txs.some((tx) => (tx?.inputs || []).some((input) => String(input?.previous_outpoint_address || "").toLowerCase() === lowered))) {
        await markQuantumSpent(account.id, address);
        return true;
      }
      if (txs.length < PAGE) {
        quantumUnspentSeenAt.set(lowered, Date.now());
        return false;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** The address's own label, or "" - iOS SpendingAddressEntry.label. */
export function customLabel(state, index) {
  return String(state.labels?.[index] ?? state.labels?.[String(index)] ?? "").trim();
}

/** iOS displayLabel: the label you gave it, else "Address #<n>" - numbered on its own chain, so a
 *  quantum-safe slot is "Address #0" again and the shield tells them apart (iOS e001786). */
export function labelFor(state, index) {
  return customLabel(state, index) || spendingIndexTitle(index);
}

/** Balances for many addresses in one node call: { address: sompi }. */
export async function balancesFor(addresses) {
  const list = addresses.filter(Boolean);
  if (!list.length) return {};
  const out = {};
  for (const address of list) out[address] = 0n;
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const response = await withRpc(async (node) => checkedUtxoAnswer(await node.getUtxosByAddresses(chunk)));
    for (const entry of response?.entries || []) {
      const owner = String(entry?.address?.toString?.() ?? entry?.address ?? "");
      if (owner in out) out[owner] += BigInt(entry?.amount ?? 0);
    }
  }
  return out;
}

async function activeState() {
  const account = await activeAccountSecrets();
  return { account, state: await spendingState(account.id) };
}

/** Address Visibility's Hide All (iOS 245a5d2): every spending address hidden - the list starts
 *  over with only the chatting address. */
export async function hideAllSpending() {
  const { account, state } = await activeState();
  return saveSpendingState(account.id, { hidden: revealedSpendingIndices(state) });
}

export async function setSpendingHidden(index, hidden, accountId = null) {
  const { account, state } = accountId ? { account: { id: accountId }, state: await spendingState(accountId) } : await activeState();
  // every address toggles both ways, funded ones too (iOS 245a5d2); totals count hidden ones
  const set = new Set(state.hidden);
  if (hidden) set.add(index); else set.delete(index);
  return saveSpendingState(account.id, { hidden: [...set] });
}

export async function setSpendingLabel(index, label) {
  const { account, state } = await activeState();
  const labels = { ...state.labels };
  const clean = String(label || "").trim();
  if (clean) labels[index] = clean; else delete labels[index];
  return saveSpendingState(account.id, { labels });
}

export async function setPrimarySpending(index) {
  const { account, state } = await activeState();
  const hidden = state.hidden.filter((i) => i !== index);
  return saveSpendingState(account.id, { activeIndex: index, ...boundPatchFor(index, state), hidden });
}

/**
 * iOS "Generate New Spending Address" (ManageAddressesView.generateNew): a hidden address that
 * is not the primary, holds nothing and was never used is recycled, lowest index first - one
 * whose used-state is unknown gets one transactions-count probe, all probes sharing a 2 s
 * budget; when the budget runs out (or a probe fails) the chain extends by one instead.
 */
/** The next never-revealed spending address (the slot after the last one) - shown, not reserved
 *  (iOS spendingAddress(at: maxSpendingAddressIndex + 1)). */
export async function nextFreshSpendingAddress() {
  const { account } = await activeState();
  // new addresses are quantum-safe (KIP-22, iOS bba1b1e), checked on chain first (iOS da2c8e2)
  return verifiedFreshQuantumSlot(account);
}

/** Reserves the next never-revealed spending address for one use (a payment request): the
 *  chain moves past it, so nothing hands it out again (iOS reserveFreshSpendingAddresses). */
export async function reserveFreshSpendingAddress() {
  const { account } = await activeState();
  const { index, address } = await verifiedFreshQuantumSlot(account);
  await saveSpendingState(account.id, boundPatchFor(index, await spendingState(account.id)));
  await cacheSpendingAddress(account.id, index, address);
  return { index, address, accountId: account.id };
}

// New addresses are on the quantum-safe chain (iOS bba1b1e lowestUnusedQuantumAddress): a hidden
// quantum slot that is confirmed unused is recycled, else the chain extends by one. Legacy
// addresses are never handed out again, and stay spendable.
export async function generateSpendingAddress(forAccount = null) {
  const { account, state } = forAccount ? { account: forAccount, state: await spendingState(forAccount.id) } : await activeState();
  const cached = (await cachedAddresses(account.id))?.spending || {};
  const candidates = [...state.hidden].sort((a, b) => a - b)
    .filter((i) => isQuantumIndex(i) && i !== state.activeIndex && chainLocalIndex(i) <= state.qMaxIndex);
  if (candidates.length) {
    const addresses = { ...(await spendingAddressesAt(candidates, account)), ...cached };
    const balances = await balancesFor(candidates.map((i) => addresses[i]));
    const deadline = Date.now() + 2000;
    for (const index of candidates) {
      const address = addresses[index];
      if ((balances[address] ?? 0n) > 0n) continue;
      let used = await knownUsedState(address);
      if (used == null) {
        if (Date.now() >= deadline) break;
        used = await Promise.race([addressUsed(address), new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())))]);
        if (used == null) break;
      }
      if (used === false) {
        await saveSpendingState(account.id, { hidden: state.hidden.filter((i) => i !== index) });
        return index;
      }
    }
  }
  const { index, address } = await verifiedFreshQuantumSlot(account);
  const now = await spendingState(account.id);
  await saveSpendingState(account.id, { ...boundPatchFor(index, now), hidden: now.hidden.filter((i) => i !== index) });
  await cacheSpendingAddress(account.id, index, address);
  return index;
}

// ChangeNOW Swap's payout (KaChat-Desktop Build 217, iOS 28ecee0): the next LEGACY slot, never a
// quantum-safe one - one past the legacy chain.
/** The next legacy slot, shown before the swap is real (not reserved). -> { index, address } */
export async function nextSwapPayoutAddress() {
  const { account, state } = await activeState();
  const index = state.maxIndex + 1;
  return { index, address: (await spendingAddressRange(index, 1, account))[index] };
}
/** Reserves the next legacy slot for a swap that was just created. -> { index, address } */
export async function reserveSwapPayoutAddress() {
  const { account, state } = await activeState();
  const index = state.maxIndex + 1;
  const address = (await spendingAddressRange(index, 1, account))[index];
  await saveSpendingState(account.id, { maxIndex: index });
  await cacheSpendingAddress(account.id, index, address);
  return { index, address };
}
/** A legacy address of yours for a swap payout, by index. */
export async function swapPayoutAddressAt(index) {
  const { account } = await activeState();
  return (await spendingAddressRange(index, 1, account))[index];
}

/** Extends `index`'s own chain to it (Address Visibility past the end): the ones between are hidden.
 *  A quantum-safe index extends the quantum chain, never the legacy one. */
export async function revealSpendingAddress(index) {
  const { account, state } = await activeState();
  const quantum = isQuantumIndex(index);
  const end = quantum ? QUANTUM_INDEX_BASE + state.qMaxIndex : state.maxIndex;
  if (index <= end) return setSpendingHidden(index, false);
  const hidden = new Set(state.hidden);
  for (let i = end + 1; i < index; i += 1) hidden.add(i);
  hidden.delete(index);
  const range = await spendingAddressRange(end + 1, index - end, account);
  const cached = (await cachedAddresses(account.id)) || { accountId: account.id, main: null, spending: {} };
  await setLocal(addressCacheKey(account.id), { ...cached, spending: { ...(cached.spending || {}), ...range } });
  return saveSpendingState(account.id, { ...boundPatchFor(index, state), hidden: [...hidden] });
}

/**
 * The Receive QR address (iOS freshReceiveAddress): the one handed out last time while it is
 * still unused, else the primary while THAT is unused, else a generated one. Never changes the
 * primary. A failed probe keeps the current answer rather than rotating on a guess.
 */
export async function freshReceiveAddress() {
  const { account, state } = await activeState();
  // Derived from the recovery phrase every time (audit EXT-006): a cached address that doesn't
  // match is replaced, never shown.
  // every derivation and write is this account's, even if another becomes active meanwhile (IOS-109)
  const addressAt = async (index) => {
    const cached = (await cachedAddresses(account.id))?.spending?.[index];
    const derived = (await spendingAddressRange(index, 1, account))[index];
    if (cached && cached !== derived) await cacheSpendingAddress(account.id, index, derived);
    // the address Receive shows is on the list again (iOS 245a5d2: un-hidden when handed out)
    if ((await spendingState(account.id)).hidden.includes(index)) await setSpendingHidden(index, false, account.id);
    return derived;
  };
  // an answer that comes back after an account switch is dropped (iOS fb2323e): never show one
  // account's address under another
  const stillActive = async () => (await activeAccountSecrets()).id === account.id;
  if (Number.isInteger(state.receiveIndex)) {
    const address = await addressAt(state.receiveIndex);
    if ((await addressUsedOrFunded(address)) !== true) return (await stillActive()) ? address : null;
  }
  const primary = await addressAt(state.activeIndex);
  if ((await addressUsedOrFunded(primary)) !== true) {
    await saveSpendingState(account.id, { receiveIndex: state.activeIndex });
    return (await stillActive()) ? primary : null;
  }
  const index = await generateSpendingAddress(account);
  await saveSpendingState(account.id, { receiveIndex: index });
  const address = await addressAt(index);
  return (await stillActive()) ? address : null;
}

// A restored recovery phrase discovers its addresses by itself (iOS da2c8e2). The sweep runs in the
// page that is open, and the toolbar popup can close at any moment, taking it along (audit EXT-031):
// so the import leaves a per-account, per-network mark, every open of the wallet runs the sweep
// while the mark is there, and only a sweep that completed clears it.
const pendingDiscoveryKey = (accountId) => netKey(`kachat.pendingDiscovery.${accountId}`);
let pendingDiscoveryRunning = false;
export async function markDiscoveryPending(accountId) {
  if (accountId) await setLocal(pendingDiscoveryKey(accountId), Date.now());
}
/** Runs the restore sweep for `accountId` when one is still owed (the active account only). */
export async function runPendingDiscovery(accountId) {
  if (!accountId || pendingDiscoveryRunning || !(await getLocal(pendingDiscoveryKey(accountId)))) return;
  pendingDiscoveryRunning = true;
  try {
    if ((await activeAccountSecrets()).id !== accountId) return;
    await discoverSpendingAddresses();
    await removeLocal(pendingDiscoveryKey(accountId));
  } catch (error) {
    console.warn("[KaPay] restore discovery (tried again next time):", error);
  } finally {
    pendingDiscoveryRunning = false;
  }
}

/**
 * iOS "Discover Addresses" (WalletManager.discoverSpendingAddresses). A match is an address
 * holding Kaspa or a KNS domain.
 *   fast path   indexes 0..999: one bulk /addresses/active pass says which were ever touched;
 *               UTXOs for the touched ones in one sweep; KNS for touched, unfunded ones below
 *               #200.
 *   fallback    (the REST server can't answer /addresses/active) balances 100 at a time up to
 *               #5000, stopping past #1000 after 60 misses in a row; KNS below #200.
 * Matches are un-hidden; when the highest is past the revealed range, the range grows to it and
 * the empty indexes in between are hidden. onProgress({ checkingIndex, foundCount }).
 */
export async function discoverSpendingAddresses(onProgress = () => {}) {
  const { account, state } = await activeState();
  // the master key is derived once per run (both chains)
  const DEEP_FLOOR = 1000;
  const MAX_INDEX = 5000;
  const BATCH = 100;
  const KNS_DEPTH = 200;
  const GAP = 60;
  const found = new Set();
  const addresses = {};
  // Any name service (iOS 7a5b157): .kas through KNS, .k and .kaspa through their own APIs.
  const knsOwns = (address) => ownsAnyName(address, async (a) => ((await getAddressInfo(a, knsOptions()))?.allDomains || []).length > 0);

  onProgress({ checkingIndex: 0, foundCount: 0 });
  Object.assign(addresses, await spendingAddressRange(0, DEEP_FLOOR, account));
  const floorList = Array.from({ length: DEEP_FLOOR }, (_, i) => addresses[i]);
  const active = await addressesActive(floorList);
  if (active) {
    const touched = Array.from({ length: DEEP_FLOOR }, (_, i) => i).filter((i) => active[addresses[i]]);
    onProgress({ checkingIndex: DEEP_FLOOR - 1, foundCount: 0 });
    const balances = await balancesFor(touched.map((i) => addresses[i]));
    const knsChecks = [];
    for (const index of touched) {
      if ((balances[addresses[index]] ?? 0n) > 0n) found.add(index);
      else if (index < KNS_DEPTH) knsChecks.push(index);
    }
    for (let i = 0; i < knsChecks.length; i += 6) {
      const slice = knsChecks.slice(i, i + 6);
      const owns = await Promise.all(slice.map((index) => knsOwns(addresses[index])));
      slice.forEach((index, j) => { if (owns[j]) found.add(index); });
      onProgress({ checkingIndex: slice[slice.length - 1], foundCount: found.size });
    }
  } else {
    let misses = 0;
    for (let start = 0; start < MAX_INDEX; start += BATCH) {
      if (start >= DEEP_FLOOR) Object.assign(addresses, await spendingAddressRange(start, BATCH, account));
      const indexes = Array.from({ length: BATCH }, (_, i) => start + i);
      const balances = await balancesFor(indexes.map((i) => addresses[i]));
      for (const index of indexes) {
        let hit = (balances[addresses[index]] ?? 0n) > 0n;
        if (!hit && index < KNS_DEPTH) hit = await knsOwns(addresses[index]);
        if (hit) { found.add(index); misses = 0; } else misses += 1;
      }
      onProgress({ checkingIndex: start + BATCH - 1, foundCount: found.size });
      if (start + BATCH >= DEEP_FLOOR && misses >= GAP) break;
    }
  }

  // The quantum-safe chain (KIP-22, iOS discoverQuantumAddresses, da2c8e2 / IOS-101): windows of
  // QUANTUM_SCAN_FLOOR slots while a window shows any activity, up to 10,000. Funded slots are shown
  // again, and the chain's end goes past every slot that EVER saw activity - not only funded ones -
  // so an already-used (maybe key-revealed) slot is never handed out as fresh. Without the bulk
  // activity answer only the first window's balances can be read. Coins only (no domain goes to P2SH).
  const quantumFound = new Set();
  const quantumAddresses = {};
  let quantumUsedHighest = -1;
  for (let start = 0; start < QUANTUM_SCAN_LIMIT; start += QUANTUM_SCAN_FLOOR) {
    const window = await spendingAddressRange(QUANTUM_INDEX_BASE + start, QUANTUM_SCAN_FLOOR, account);
    Object.assign(quantumAddresses, window);
    const list = Object.keys(window).map(Number).sort((a, b) => a - b);
    if (!list.length) break;
    const active = await addressesActive(list.map((i) => window[i]));
    const touched = active ? list.filter((i) => active[window[i]]) : list;
    if (active && touched.length) quantumUsedHighest = Math.max(quantumUsedHighest, chainLocalIndex(touched[touched.length - 1]));
    if (touched.length) {
      const balances = await balancesFor(touched.map((i) => window[i]));
      for (const index of touched) if ((balances[window[index]] ?? 0n) > 0n) quantumFound.add(index);
    }
    onProgress({ checkingIndex: QUANTUM_INDEX_BASE + start + QUANTUM_SCAN_FLOOR - 1, foundCount: found.size + quantumFound.size });
    if (!active || !touched.length) break;
  }

  const highest = Math.max(state.maxIndex, ...found);
  const quantumHighest = Math.max(state.qMaxIndex, quantumUsedHighest, ...[...quantumFound].map(chainLocalIndex));
  const hidden = new Set(state.hidden);
  for (let index = state.maxIndex + 1; index <= highest; index += 1) if (!found.has(index)) hidden.add(index);
  for (let n = state.qMaxIndex + 1; n <= quantumHighest; n += 1) if (!quantumFound.has(QUANTUM_INDEX_BASE + n)) hidden.add(QUANTUM_INDEX_BASE + n);
  for (const index of [...found, ...quantumFound]) hidden.delete(index);
  // the account it started for, even if another is active now; nothing for a removed one (IOS-107)
  if (!(await accountStillExists(account.id))) return 0;
  await saveSpendingState(account.id, { maxIndex: highest, qMaxIndex: quantumHighest, hidden: [...hidden] });
  const cached = (await cachedAddresses(account.id)) || { accountId: account.id, main: null, spending: {} };
  const spending = { ...(cached.spending || {}) };
  for (let index = 0; index <= highest; index += 1) if (addresses[index]) spending[index] = addresses[index];
  for (let n = 0; n <= quantumHighest; n += 1) if (quantumAddresses[QUANTUM_INDEX_BASE + n]) spending[QUANTUM_INDEX_BASE + n] = quantumAddresses[QUANTUM_INDEX_BASE + n];
  await setLocal(addressCacheKey(account.id), { ...cached, spending });
  return found.size + quantumFound.size;
}

// --- Explorer -----------------------------------------------------------------------------

// The block explorer "view transaction" links open in - Settings > Connection > Kaspa Explorer,
// the same two choices as iOS (KaspaExplorer), explorer.kaspa.org by default.
export const EXPLORERS = Object.freeze({
  kaspaOrg: { name: "explorer.kaspa.org", tx: "https://explorer.kaspa.org/txs/", address: "https://explorer.kaspa.org/addresses/" },
  kaspaStream: { name: "kaspa.stream", tx: "https://kaspa.stream/transactions/", address: "https://kaspa.stream/addresses/" },
});
// kaspa.stream is the default (iOS e69fe13); a choice made in Settings is kept
let explorerId = "kaspaStream";
export function useExplorer(id) { explorerId = EXPLORERS[id] ? id : "kaspaStream"; }
export function currentExplorer() { return explorerId; }
// On testnet every link goes to tn10.kaspa.stream, whichever explorer is picked (iOS 421a832).
export function explorerTxUrl(txid) { return IS_TESTNET ? `https://tn10.kaspa.stream/transactions/${txid}` : `${EXPLORERS[explorerId].tx}${txid}`; }
export function explorerAddressUrl(address) { return IS_TESTNET ? `https://tn10.kaspa.stream/addresses/${encodeURIComponent(address)}` : `${EXPLORERS[explorerId].address}${address}`; }

// --- KNS domains ------------------------------------------------------------------------------
//
// Your Domains (iOS KNSDomainsListView): the chatting address's verified domains, newest first,
// and which one is primary. Set as Primary is a signed message to the KNS API (no transaction);
// Send is the on-chain commit/reveal transfer inscription. No inscribing new domains and no
// profile editing here - profiles are moving to .kachat names.

/** { domains:[{fullName, inscriptionId, status, createdAt}], primaryDomain } - cached, or fetched. */
export function cachedDomains(address) {
  const info = peekAddressInfo(address);
  return info ? { domains: info.allDomains || [], primaryDomain: info.primaryDomain || null } : null;
}

export async function domains(address, { force = false } = {}) {
  const info = force ? await fetchAddressInfo(address, knsOptions()) : await getAddressInfo(address, knsOptions());
  return { domains: info?.allDomains || [], primaryDomain: info?.primaryDomain || null };
}

// The engine's KNS write path expects its wallet object; this is the same shape for one source.
async function knsEngine(source, reviewed = null) {
  const from = await sourceWallet(source, reviewed);
  const k = await kaspa();
  const engine = {
    accountId: from.accountId,
    kaspa: k,
    rpc: await connection(),
    address: from.address,
    privateKey: new k.PrivateKey(from.privateKeyHex),
    privateKeyHex: from.privateKeyHex,
    async connect() { engine.rpc = await connection(); return engine.rpc; },
    withRpc: (fn) => withRpc(fn),
  };
  return engine;
}

/** Makes `domainId` the chatting address's primary name. Throws with the API's reason. */
export async function setPrimaryDomain(domainId) {
  const engine = await knsEngine({ kind: "main" });
  await setKnsPrimaryDomain({ engine, domainId, baseUrl: knsApiUrl() });
  clearKnsCache(engine.address);
}

/**
 * Transfers a domain from the chatting address: commit, then reveal, then waits (up to 90 s)
 * for the KNS API to show the new owner. onStatus gets the engine's stage names.
 */
export async function transferDomain({ domain, assetId, toAddress, priorityFeeSompi, source = { kind: "main" }, fromAddress = null, onStatus = () => {} }) {
  await confirmSpend({ title: "Confirm Transfer", amountText: String(domain?.fullName || domain?.name || domain || "Domain"), recipient: toAddress });
  // `fromAddress`: the owner the screen showed - another account's key is refused (SOURCE_CHANGED)
  const engine = await knsEngine(source, { address: fromAddress });
  // From the PRIMARY spending address the change goes to a fresh quantum-safe slot, checked on chain,
  // and the primary moves there once it is accepted (iOS KNSDomainTransferService, engine
  // spendingChangeIndex "kns"). Every write is the signing key's account's.
  let fresh = null;
  if (source?.kind === "spending") {
    const state = await spendingState(engine.accountId);
    if (source.index === state.activeIndex) {
      const slot = await verifiedFreshQuantumSlot(await accountSecretsById(engine.accountId));
      if (slot?.address) {
        fresh = { accountId: engine.accountId, index: slot.index, address: slot.address };
        // recorded before the commit goes out, like a send's change slot: a closed popup mid-transfer
        // still finds the change
        await saveSpendingState(fresh.accountId, boundPatchFor(fresh.index, await spendingState(fresh.accountId)));
        await cacheSpendingAddress(fresh.accountId, fresh.index, fresh.address);
      }
    }
  }
  const result = await knsTransferDomain({
    engine, domain, assetId, toAddress,
    signer: { privateKey: engine.privateKey, address: engine.address },
    // Who signs, so Finish transfer can rebuild the commit's key after a closed popup.
    source: { kind: source?.kind || "main", index: source?.index ?? null, accountId: engine.accountId },
    changeAddress: fresh?.address || null,
    revealPriorityFeeSompi: priorityFeeSompi,
    onStatus,
    log: (...parts) => console.info("[KaPay]", ...parts),
  });
  if (fresh) {
    // the primary moves to the change slot once it's accepted; a slip here never fails the transfer
    await recordQuietly(() => saveSpendingState(fresh.accountId, { activeIndex: fresh.index }));
  }
  return result;
}

/** Unfinished .kas transfers (commit sent, reveal not yet) of the active account on this network. */
export async function pendingDomainTransfers() {
  const account = await activeAccountSecrets();
  return (await listPendingKnsTransfers()).filter((r) => !r.source?.accountId || r.source.accountId === account.id);
}

/** Finishes an unfinished transfer: reveals its commit with the key that sent it.
 *  -> { status: "revealed" | "already-transferred" | "no-commit", ... } */
export async function finishDomainTransfer(record, onStatus = () => {}) {
  await confirmSpend({ title: "Finish Transfer", amountText: String(record?.domainName || record?.name || "Domain transfer"), recipient: record?.toAddress || "" });
  const source = record.source?.kind === "spending" ? { kind: "spending", index: record.source.index } : { kind: "main" };
  const engine = await knsEngine(source);
  return resumeKnsTransfer({
    engine, assetId: record.assetId,
    signer: { privateKey: engine.privateKey, address: engine.address },
    onStatus,
    log: (...parts) => console.info("[KaPay]", ...parts),
  });
}

/** Forgets an unfinished transfer whose commit was never found on chain. */
export function discardDomainTransfer(assetId) {
  return clearPendingKnsTransfer(assetId);
}

// --- Chatting address picker (iOS ChattingAddressPickerView) ---------------------------------

/**
 * For an import's passphrase step, before there's an account (KaPay iOS 4f5dfd2
 * WalletManager.findChattingAddresses): address #0 plus every other address among the first
 * IMPORT_ADDRESS_SEARCH_DEPTH of the identity chain holding funds, in index order, each with its
 * balance (`sompi` a Number for the rules, `balanceSompi` the exact BigInt). Null when the words
 * are invalid or the balances couldn't be checked.
 */
export async function findChattingAddresses(phrase, passphrase = "", family = "kaspaStandard") {
  try {
    const derived = await deriveIdentityAddressRange(await kaspa(), phrase, String(passphrase || "").normalize("NFKD"), { family, start: 0, count: IMPORT_ADDRESS_SEARCH_DEPTH });
    if (!derived.length) return null;
    const balancesByAddress = await balancesFor(derived.map((d) => d.address));
    const found = foundChattingAddresses(derived, new Map(Object.entries(balancesByAddress).map(([address, sompi]) => [address, Number(sompi)])));
    return found.map((entry) => ({ ...entry, balanceSompi: balancesByAddress[entry.address] ?? 0n }));
  } catch {
    return null;
  }
}

/**
 * Identity addresses `start..start+count-1` of the active account's family, each with its
 * balance and KNS domains. Listed when they hold something, are index 0, or are current.
 */
export async function scanIdentityAddresses(start = 0, count = 50) {
  const account = await activeAccountSecrets();
  const k = await kaspa();
  const rows = [];
  for (let index = start; index < start + count; index += 1) {
    const derived = await importMnemonicWithFamily(k, account.mnemonic, account.passphrase, { family: account.family, index });
    rows.push({ index, address: derived.address });
  }
  const balancesByAddress = await balancesFor(rows.map((r) => r.address));
  // KNS a few at a time: the API rate-limits bursts.
  const queue = [...rows];
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      try {
        const info = await getAddressInfo(row.address, knsOptions());
        row.domains = info?.allDomains || [];
        row.primaryDomain = info?.primaryDomain || null;
      } catch {
        row.domains = [];
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  // .k and .kaspa too: an identity can live at an address whose only trace is a name there.
  const otherNames = await ownedNamesOfMany(rows.map((r) => r.address));
  for (const row of rows) {
    row.balanceSompi = balancesByAddress[row.address] ?? 0n;
    row.otherNames = otherNames[row.address] || [];
  }
  return { rows, currentIndex: account.identityIndex || 0 };
}

// --- Website connect --------------------------------------------------------------------------

/** The chatting address and public key a website sees for an account. */
export async function identityFor(accountId) {
  const from = await sourceWallet({ kind: "main", accountId });
  const k = await kaspa();
  return { address: from.address, publicKey: String(new k.PrivateKey(from.privateKeyHex).toPublicKey().toString()) };
}

/**
 * Signs `message` with the account's chatting key, the Kaspa wallet standard (Schnorr over
 * blake2b("PersonalMessageSigningHash", message)) - what KasWare's signMessage produces.
 */
export async function signMessage(accountId, message) {
  const from = await sourceWallet({ kind: "main", accountId });
  const k = await kaspa();
  return String(k.signMessage({ message: String(message), privateKey: from.privateKeyHex }));
}

// --- Cold Storage (watch-only kpub accounts) and the KSPT signing engine ----------------------

/** A KasSigner kpub, checked by deriving its first address; null when it isn't one. */
export async function validateKpub(kpub) {
  const trimmed = String(kpub || "").trim();
  if (!trimmed) return null;
  try {
    const k = await kaspa();
    k.PublicKeyGenerator.fromXPub(trimmed).receiveAddressAsStrings(NETWORK_ID, 0, 1);
    return trimmed;
  } catch {
    return null;
  }
}

/** Receive-chain addresses start..end-1 of a kpub (iOS: kpub -> 0 -> i; change chain unused). */
export async function kpubAddresses(kpub, start, end) {
  const k = await kaspa();
  // The same kpub gives kaspatest: addresses on testnet (iOS: only the prefix changes).
  return k.PublicKeyGenerator.fromXPub(String(kpub).trim()).receiveAddressAsStrings(NETWORK_ID, start, end);
}

/**
 * The engine shape ui/kspt.js (the KSPT codec, unsigned build, max, compound, broadcast) was
 * written against on desktop: { kaspa, connect, withRpc, balanceForAddress }.
 */
export async function ksptEngine() {
  const k = await kaspa();
  return {
    kaspa: k,
    connect: () => connection(),
    withRpc: (fn) => withRpc(fn),
    balanceForAddress: async (address) => withRpc((node) => getBalance(k, node, address)),
  };
}

/** Bulk "was this ever used" for the cold account screen and its visibility list. */
export { knownUsedState as usedStateKnown };
export { QUANTUM_INDEX_BASE, isQuantumIndex };

// --- .kachat names (testnet) --------------------------------------------------------------

/** A node UTXO entry as the plain object engine/kachat-names reads, with its covenant id (hex or
 *  null) - KaChat-Desktop's KaspaEngine plainUtxo. */
function plainUtxo(e) {
  const inner = e?.entry ?? e?.utxoEntry ?? null;
  const pick = (k) => e?.[k] ?? inner?.[k];
  const outpoint = pick("outpoint") || {};
  const spk = pick("scriptPublicKey");
  let script = "";
  let scriptVersion = 0;
  if (spk && typeof spk === "object") {
    script = String(spk.script ?? spk.scriptPublicKey ?? "");
    scriptVersion = Number(spk.version ?? 0);
  } else if (typeof spk === "string") {
    // the SDK's string form is the 2-byte version (4 hex digits) followed by the script
    scriptVersion = parseInt(spk.slice(0, 4), 16) || 0;
    script = spk.slice(4);
  }
  const cov = inner?.covenantId ?? e?.covenantId ?? null;
  const covenantId = cov == null ? null : String(typeof cov === "string" ? cov : cov.toString()).toLowerCase();
  return {
    outpoint: { transactionId: String(outpoint.transactionId ?? "").toLowerCase(), index: Number(outpoint.index ?? 0) },
    amount: BigInt(pick("amount") ?? 0),
    scriptPublicKey: script.toLowerCase(),
    scriptVersion,
    blockDaaScore: BigInt(pick("blockDaaScore") ?? 0),
    isCoinbase: Boolean(pick("isCoinbase")),
    covenantId: covenantId || null,
  };
}

/**
 * The node side of the engine object engine/kachat-names was written against on desktop
 * (KaspaEngine.currentDagPoint, getUtxosWithCovenants, utxosForRegistry, submitRpcTransaction).
 * No key: the signer is bound separately (chattingSigner).
 */
export function namesNodeMethods() {
  const methods = {
    log: (...parts) => console.info("[KaPay]", ...parts),
    connect: () => connection(),
    withRpc: (fn) => withRpc(fn),
    async currentDagPoint() {
      return withRpc(async (node) => {
        const dag = await node.getBlockDagInfo();
        let networkId = String(dag?.network ?? dag?.networkId ?? "");
        if (!networkId) networkId = String((await node.getServerInfo())?.networkId ?? "");
        const point = { networkId, virtualDaaScore: BigInt(dag?.virtualDaaScore ?? 0), pastMedianTime: BigInt(dag?.pastMedianTime ?? 0) };
        return point;
      });
    },
    async currentVirtualDaaScore() {
      try { return (await methods.currentDagPoint()).virtualDaaScore; } catch { return null; }
    },
    async getUtxosWithCovenants(addresses) {
      const list = [...new Set((addresses || []).map(String).filter(Boolean))];
      const out = [];
      for (let start = 0; start < list.length; start += 50) {
        // a node answering amounts above the Kaspa supply is refused (iOS 283cd28, IOS-020)
        const response = await withRpc(async (node) => checkedUtxoAnswer(await node.getUtxosByAddresses(list.slice(start, start + 50))));
        for (const e of response?.entries || []) out.push(plainUtxo(e));
      }
      return out;
    },
    utxosForRegistry: (addresses) => methods.getUtxosWithCovenants(addresses),
    /** The node's own fee estimate (GetFeeEstimate; iOS e426432): `{ priority: { feerate,
     *  seconds }, normal: { feerate, seconds } }` - the priority bucket and the first normal one.
     *  Throws when no node answers; the .kachat actions then fall back to the REST API. */
    async getFeeEstimate() {
      const response = await withRpc(async (node) => {
        if (typeof node?.getFeeEstimate !== "function") throw new Error("This node client has no GetFeeEstimate.");
        return node.getFeeEstimate({});
      });
      const estimate = response?.estimate ?? response;
      const bucket = (b) => {
        const feerate = Number(b?.feerate);
        const seconds = Number(b?.estimatedSeconds ?? b?.estimated_seconds ?? 0);
        return Number.isFinite(feerate) && feerate > 0 ? { feerate, seconds: Number.isFinite(seconds) ? seconds : 0 } : null;
      };
      const priority = bucket(estimate?.priorityBucket ?? estimate?.priority_bucket);
      if (!priority) throw new Error("The node sent no fee estimate.");
      const normalList = estimate?.normalBuckets ?? estimate?.normal_buckets;
      const normal = (Array.isArray(normalList) ? bucket(normalList[0]) : null) ?? priority;
      return { priority, normal };
    },
    /** The mempool entry of `txId`, or null when no node holds it (or none answers). */
    async getMempoolEntry(txId) {
      const id = String(txId || "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(id)) return null;
      try {
        const response = await withRpc(async (node) => {
          if (typeof node?.getMempoolEntry !== "function") return null;
          return node.getMempoolEntry({ transactionId: id, includeOrphanPool: true, filterTransactionPool: false });
        });
        return response?.mempoolEntry || response?.entry || null;
      } catch {
        return null;
      }
    },
    /** Submits an SDK transaction; a submit whose answer was lost but whose transaction the
     *  network has counts as sent (iOS 9139e88, IOS-014): `expectedTxId` (the core's own id) is
     *  looked up before it fails. */
    async submitRpcTransaction(transaction, { expectedTxId = null } = {}) {
      let localId = expectedTxId ? String(expectedTxId) : null;
      if (!localId) {
        try { localId = transaction?.id ? String(transaction.id) : null; } catch { localId = null; }
      }
      return submitConfirmingAcceptance({
        withRpc,
        submit: (node, { allowOrphan = false } = {}) => node.submitTransaction({ transaction, allowOrphan }),
        txid: localId,
        label: "Transaction submit",
        log: (...parts) => console.info("[KaPay]", ...parts),
      });
    },
    /** The fee (BigInt sompi) of a 0.2 KAS self-transfer from the bound address carrying
     *  `payloadBytes` of payload (optionally only from `selectedOutpoints`); null when unknown.
     *  Quotes a .kachat profile record before it is saved (iOS profileFee). Called on the engine
     *  object, so `this` holds the bound signer's kaspa and address. */
    async estimatePayloadFeeSompi(payloadBytes = 0, selectedOutpoints = null) {
      if (!this.kaspa || !this.address) return null;
      const detail = await estimateOnchainFeeDetail({
        kaspa: this.kaspa, rpc: await connection(), withRpc, sourceAddress: this.address,
        amountKas: "0.2", payloadBytes, selectedOutpoints,
      });
      return detail ? detail.feeSompi : null;
    },
  };
  return methods;
}

/** The active account's chatting address and its key - what .kachat names are owned and signed by
 *  (and payment requests). Both from the same read of the vault, with that account's id. */
export async function chattingSigner() {
  const from = await sourceWallet({ kind: "main" });
  return { accountId: from.accountId, address: from.address, privateKeyHex: from.privateKeyHex, kaspa: await kaspa() };
}
