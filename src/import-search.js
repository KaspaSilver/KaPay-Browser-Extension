// Import finds the wallet type from the words (KaPay iOS 018e634 WalletManager.findImportAccounts):
// no "Where are your 12 or 24 words from?" list. After the words and the passphrase question, every
// wallet type's addresses are checked for funds, and each type's address #0 for transaction history
// (a chat identity or an emptied wallet holds no coins). What has either is listed, the type holding
// the most first and each type's addresses in index order, so the first is the likeliest account.
//
// iOS also checks Chainge (m/44'/111111'/0'/0', one address). The shared engine has no Chainge
// family yet (shared/engine/wallet.js WALLET_SOURCE_FAMILIES, where an unknown family derives as
// Standard), so an account found there couldn't be opened on its own addresses: it is left out until
// KaChat-Desktop's engine has it.

/** The wallet types import checks, in iOS's order (ties go to the earlier one), with how many of
 *  each type's addresses it looks at (iOS importSearchDepth). Standard covers KaChat, KasWare,
 *  Kaspium, Kastle, Core Golang CLI, OKX and Ledger, which all use the same addresses. */
export const IMPORT_WALLET_TYPES = [
  { family: "kaspaStandard", name: "Standard Kaspa Wallet", depth: 50 },
  { family: "kaspaLegacy972", name: "KDX / Kaspanet Web", depth: 20 },
  { family: "oneKey", name: "OneKey", depth: 20 },
];

/** How import names a wallet type. */
export function walletTypeName(family) {
  return IMPORT_WALLET_TYPES.find((type) => type.family === family)?.name || IMPORT_WALLET_TYPES[0].name;
}

/** Which wallet type and address an import opens when nothing is found or the search is skipped. */
export const DEFAULT_IMPORT_CHOICE = Object.freeze({ family: "kaspaStandard", index: 0 });

export const candidateId = (candidate) => `${candidate.family}-${candidate.index}`;
export const sameChoice = (a, b) => Boolean(a && b) && a.family === b.family && Number(a.index) === Number(b.index);

/**
 * `candidates`: [{ family, index, address }] for every type's searched addresses. `balances`:
 * address -> BigInt sompi. `withHistory`: the addresses with at least one transaction. -> the ones
 * with funds or history, as [{ family, index, address, balanceSompi, hasHistory }], likeliest first.
 * Empty when nothing has any activity.
 */
export function rankImportCandidates(candidates, balances, withHistory = new Set()) {
  const order = IMPORT_WALLET_TYPES.map((type) => type.family);
  const totals = new Map();
  const active = [];
  for (const candidate of candidates || []) {
    const balanceSompi = BigInt(balances?.[candidate.address] ?? 0n);
    const hasHistory = withHistory.has(candidate.address);
    if (balanceSompi <= 0n && !hasHistory) continue;
    totals.set(candidate.family, (totals.get(candidate.family) || 0n) + balanceSompi);
    active.push({ family: candidate.family, index: candidate.index, address: candidate.address, balanceSompi, hasHistory });
  }
  return active.sort((a, b) => {
    if (a.family === b.family) return a.index - b.index;
    const left = totals.get(a.family) || 0n;
    const right = totals.get(b.family) || 0n;
    if (left !== right) return left > right ? -1 : 1;
    // the standard wallet wins when nothing tells them apart
    return order.indexOf(a.family) - order.indexOf(b.family);
  });
}

/** The rows the address box lists: what was found, then (See Every Wallet Type) each type's #0
 *  that isn't already there. */
export function visibleImportRows(found, everyType, showsEveryType) {
  if (!showsEveryType) return found || [];
  const ids = new Set((found || []).map(candidateId));
  return [...(found || []), ...(everyType || []).filter((row) => !ids.has(candidateId(row)))];
}
