// Import finds the wallet type from the words (KaPay iOS 018e634 WalletManager.findImportAccounts):
// no "Where are your 12 or 24 words from?" list. After the words and the passphrase question, every
// wallet type's addresses are checked for funds, and each type's address #0 for transaction history
// (a chat identity or an emptied wallet holds no coins). What has either is listed, the type holding
// the most first and each type's addresses in index order, so the first is the likeliest account.
// The rules are KaChat-Desktop's (shared/ui/account-import.js, shared/engine/wallet.js, Build 277);
// this adds exact BigInt balances for the screen.

import { rankImportAccounts, importChoiceKey, visibleImportRows as sharedVisibleRows, importFundsHint } from "../shared/ui/account-import.js";
import { WALLET_SOURCE_FAMILIES, sourceFamilyDisplayName, sourceFamilyImportSearchDepth } from "../shared/engine/wallet.js";

/** The wallet types import checks, in iOS's order (ties go to the earlier one), with how many of
 *  each type's addresses it looks at: Standard 50, KDX / Kaspanet Web 20, Chainge 1, OneKey 20. */
export const IMPORT_WALLET_TYPES = WALLET_SOURCE_FAMILIES.map((family) => ({
  family, name: sourceFamilyDisplayName(family), depth: sourceFamilyImportSearchDepth(family),
}));

export const walletTypeName = sourceFamilyDisplayName;
export { importFundsHint };

/** Which wallet type and address an import opens when nothing is found or the search is skipped. */
export const DEFAULT_IMPORT_CHOICE = Object.freeze({ family: "kaspaStandard", index: 0 });

export const candidateId = importChoiceKey;
export const sameChoice = (a, b) => Boolean(a && b) && importChoiceKey(a) === importChoiceKey(b);

/**
 * `candidates`: [{ family, index, address }] for every type's searched addresses. `balances`:
 * address -> BigInt sompi. `withHistory`: the addresses with at least one transaction. -> the ones
 * with funds or history, as [{ family, index, address, balanceSompi, hasHistory }], likeliest first.
 * Empty when nothing has any activity.
 */
export function rankImportCandidates(candidates, balances, withHistory = new Set()) {
  const exact = (address) => BigInt(balances?.[address] ?? 0n);
  const numbers = new Map((candidates || []).map((c) => [c.address, Number(exact(c.address))]));
  return rankImportAccounts(candidates || [], numbers, withHistory, WALLET_SOURCE_FAMILIES)
    .map(({ family, index, address, hasHistory }) => ({ family, index, address, balanceSompi: exact(address), hasHistory }));
}

/** The rows the address box lists: what was found, then (See Every Wallet Type) each type's #0
 *  that isn't already there. */
export function visibleImportRows(found, everyType, showsEveryType) {
  return sharedVisibleRows(found || [], everyType || [], showsEveryType);
}
