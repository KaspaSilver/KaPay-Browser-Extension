// The account a window shows and the records an account keeps outside the vault
// (src/account-scope.js): a switch in another window refuses account actions and is followed, a
// delete finds every key on both networks, Change Chatting Address merges the bell and contacts.
// Also the read-back a created account's save relies on (onboarding.js savingAccount). No DOM, no
// network. Run from the repo root:
//
//   node tools/test-account-scope.mjs

import assert from "node:assert/strict";
import {
  setShownAccount, shownAccount, shownActiveAccount, followsSwitch, SWITCHED_ELSEWHERE,
  accountDataKeys, withoutAccount, mergeBellEntries, mergeContacts, datedAfterDeletion,
} from "../src/account-scope.js";
import { createAccountBackupStatus } from "../shared/ui/account-backup-status.js";

// --- the shown account --------------------------------------------------------------------------

assert.deepEqual(shownAccount(), { id: null, address: null });
const view = (activeAccountId) => ({ activeAccountId, accounts: [{ id: "A", name: "One" }, { id: "B", name: "Two" }] });

// nothing shown: refused
assert.throws(() => shownActiveAccount(view("A")), { message: SWITCHED_ELSEWHERE });

setShownAccount({ id: "A", address: "kaspa:qa" });
assert.deepEqual(shownAccount(), { id: "A", address: "kaspa:qa" });
assert.equal(shownActiveAccount(view("A")).id, "A");
// another window made B active: the action on A is refused, never applied to B
assert.throws(() => shownActiveAccount(view("B")), { message: SWITCHED_ELSEWHERE });
// an id passed in (the backup steps keep the one they were opened for)
assert.equal(shownActiveAccount(view("B"), "B").id, "B");
assert.throws(() => shownActiveAccount(view("B"), "A"));
// an active id no longer in the vault
assert.throws(() => shownActiveAccount({ activeAccountId: "Z", accounts: [{ id: "A" }] }));
assert.throws(() => shownActiveAccount(null));
setShownAccount(null);
assert.deepEqual(shownAccount(), { id: null, address: null });

// following: only a window showing an account, only to a different one
assert.equal(followsSwitch("A", "B"), true);
assert.equal(followsSwitch("A", "A"), false);
assert.equal(followsSwitch(null, "B"), false);   // sign-in screen, unlock, its own switch
assert.equal(followsSwitch("A", undefined), false); // Reset Wallet removed the key: the lock path handles it

// --- a deleted account's records ---------------------------------------------------------------

const variants = (address) => {
  const payload = address.split(":")[1];
  return [`kaspa:${payload}`, `kaspatest:${payload}`];
};
const { local, page } = accountDataKeys({
  accountId: "acc1",
  chatting: "kaspatest:qchat",
  addresses: ["kaspatest:qchat", "kaspatest:qspend0", "kaspa:qspend1"],
  variants,
});
for (const base of ["spending", "addresses", "cold", "portfolios", "portfolioFees", "pendingDiscovery"]) {
  assert.ok(local.includes(`kachat.${base}.acc1`), base);
  assert.ok(local.includes(`kachat.${base}.acc1.testnet`), `${base} testnet`);
}
for (const address of ["kaspa:qchat", "kaspatest:qchat", "kaspa:qspend0", "kaspatest:qspend0", "kaspa:qspend1", "kaspatest:qspend1"]) {
  assert.ok(local.includes(`kachat.utxoLabels.${address}`), address);
}
assert.equal(new Set(local).size, local.length);
for (const each of ["kaspa:qchat", "kaspatest:qchat"]) {
  for (const prefix of ["kachat-swap-history-v1:", "kachat-swap-disclaimer-agreed-v1:", "kachat-names-notifier-v1:", "kachat-held-payments-v1:", "kachat_market_addresses."]) {
    assert.ok(page.includes(prefix + each), prefix + each);
  }
}
assert.ok(page.includes("kachat_owned_names_mainnet_kaspa:qchat"));
assert.ok(page.includes("kachat_owned_names_testnet_kaspatest:qchat"));
// mixed case is lowercased where the writer lowercases
assert.ok(accountDataKeys({ chatting: "kaspa:QChat", variants: (a) => [a] }).page.includes("kachat-swap-history-v1:kaspa:qchat"));
// no chatting address known: the per-account keys still go, nothing per address is guessed
const bare = accountDataKeys({ accountId: "acc2" });
assert.equal(bare.page.length, 0);
assert.ok(bare.local.includes("kachat.pendingDiscovery.acc2.testnet"));

assert.deepEqual(withoutAccount({ acc1: 1, acc2: 2 }, "acc1"), { acc2: 2 });
assert.deepEqual(withoutAccount(null, "acc1"), {});

// --- Change Chatting Address: the bell and contacts carried ------------------------------------

const merged = mergeBellEntries(
  [{ id: "x", timestamp: 5 }, { id: "y", timestamp: 1 }],
  [{ id: "x", timestamp: 9 }, { id: "z", timestamp: 3 }],
);
assert.deepEqual(merged.map((e) => e.id), ["x", "z", "y"]);
assert.equal(merged[0].timestamp, 9);
assert.equal(mergeBellEntries([], Array.from({ length: 150 }, (_, i) => ({ id: `r${i}`, timestamp: i })), 100).length, 100);
assert.deepEqual(mergeBellEntries(null, undefined), []);

assert.deepEqual(
  mergeContacts([{ address: "a", name: "New" }], [{ address: "a", name: "Old" }, { address: "b" }]),
  [{ address: "a", name: "New" }, { address: "b" }],
);
assert.deepEqual(mergeContacts(null, [{ address: "b" }]), [{ address: "b" }]);

// --- a created account's owed backup is read back before it's saved -----------------------------

const memory = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); } };
};
const ok = createAccountBackupStatus({ storage: memory() });
ok.markPending("kaspa:qnew");
assert.equal(ok.isPending("kaspa:qnew"), true);

// storage full: the write is swallowed, the read-back says it didn't stick (savingAccount refuses)
const full = createAccountBackupStatus({ storage: { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } } });
full.markPending("kaspa:qnew");
assert.equal(full.isPending("kaspa:qnew"), false);

// carry (Change Chatting Address): owed moves to the new address, on both networks
const carried = createAccountBackupStatus({ storage: memory(), variants });
carried.markPending("kaspa:qold");
carried.carry("kaspa:qold", "kaspa:qnew");
assert.equal(carried.isPending("kaspa:qold"), false);
assert.equal(carried.isPending("kaspatest:qold"), false);
assert.equal(carried.isPending("kaspa:qnew"), true);
assert.equal(carried.isPending("kaspatest:qnew"), true);

// Labels on a spending address another account still lists (the same words saved twice) stay.
const shared = accountDataKeys({ accountId: "acc2", chatting: "kaspa:qa", addresses: ["kaspa:qshared", "kaspa:qmine"], variants: (a) => [a], keep: ["kaspa:QShared"] });
assert.ok(!shared.local.includes("kachat.utxoLabels.kaspa:qshared"));
assert.ok(shared.local.includes("kachat.utxoLabels.kaspa:qmine"));

// An imported contact that was deleted here is dated after the deletion (KaPay iOS 1652437): past the
// deletion's second, and never before now.
assert.equal(datedAfterDeletion(1_700_000_000_500, 1_000), 1_700_000_001_000);
assert.equal(datedAfterDeletion(1_700_000_000_000, 1_000), 1_700_000_001_000);
assert.equal(datedAfterDeletion(1_000, 1_700_000_000_123), 1_700_000_000_123);
assert.equal(datedAfterDeletion(undefined, 42), 42);

console.log("account scope: ok");
