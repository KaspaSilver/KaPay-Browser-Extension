// What an account keeps under its chatting address outside the vault - the backup status, the
// contacts and the bell - moved along when that address changes (Change Chatting Address, manage.js):
// the same seed, so the same account, and nothing it had should be lost or left behind.

import { backupStatus } from "./account-backup.js";
import { carryWallet } from "./address-book.js";
import { carryAccount } from "./bell.js";

/** The account's chatting address went from `oldAddress` to `newAddress`: what it owes a backup and
 *  its six months, its contacts and its bell feed follow, on both networks. Never throws. */
export async function carryAccountData(oldAddress, newAddress) {
  if (!oldAddress || !newAddress || oldAddress === newAddress) return;
  try { backupStatus.carry(oldAddress, newAddress); } catch { /* the banner may show again */ }
  try { carryAccount(oldAddress, newAddress); } catch { /* the feed starts over */ }
  try { await carryWallet(oldAddress, newAddress); } catch { /* the old list stays under the old address */ }
}
