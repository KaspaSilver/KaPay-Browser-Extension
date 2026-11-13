// The website broker's rules (src/site-rules.js, audit 2026-11-07): what the site hears from an
// approval, when the window may act, the site's priority-fee cap, the send approval's sums, the
// rejection cooldown, the approve buttons' arming, and which sites hear which events.
// Run: node tools/test-site-rules.mjs
import assert from "node:assert/strict";
import {
  rejected, maybeSent, approvalAnswer, claimDecision, sitePriorityFee, MAX_SITE_PRIORITY_FEE_SOMPI,
  approvalTotals, cooldownLeft, REJECT_COOLDOWN_MS, armDelayLeft, APPROVE_ARM_MS,
  connectionChangeEvents, networkSwitchEvents, openStateEvents,
} from "../src/site-rules.js";

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

const TXID = "ab".repeat(32);

check("a send with no answer from the network is 'may have been sent' with its txid, never a rejection", () => {
  const answer = approvalAnswer({ sending: true }, { outcomeUnknown: true, txid: TXID.toUpperCase() });
  assert.equal(answer.error.code, 4002);
  assert.equal(answer.error.txid, TXID);
  assert.equal(approvalAnswer({ sending: false }, { outcomeUnknown: true }).error.code, 4002);
  assert.equal(approvalAnswer({}, { outcomeUnknown: true, txid: "not-a-txid" }).error.txid, undefined);
});
check("a rejection is 4001, or 4002 while a payment was past the password (EXT-012)", () => {
  assert.deepEqual(approvalAnswer({ sending: false }, { error: true }), rejected());
  assert.deepEqual(approvalAnswer({ sending: true }, { error: true }), maybeSent());
  assert.deepEqual(approvalAnswer({}, { result: "sig" }), { result: "sig" });
});
check("the window may act only on a request the worker still holds, unlocked and signed in", () => {
  assert.deepEqual(claimDecision({ entry: null, unlocked: true, loggedOut: false }), { ok: false, reason: "expired" });
  assert.deepEqual(claimDecision({ entry: { done: true }, unlocked: true, loggedOut: false }), { ok: false, reason: "expired" });
  assert.deepEqual(claimDecision({ entry: {}, unlocked: true, loggedOut: true }), { ok: false, reason: "signedOut" });
  assert.deepEqual(claimDecision({ entry: {}, unlocked: false, loggedOut: false }), { ok: false, reason: "locked" });
  assert.deepEqual(claimDecision({ entry: {}, unlocked: true, loggedOut: false }), { ok: true });
  // a site removed in Settings while its window was open: no sign or send for it (audit 2026-11-13)
  assert.deepEqual(claimDecision({ entry: { kind: "sendKaspa" }, unlocked: true, loggedOut: false, connected: false }), { ok: false, reason: "disconnected" });
  assert.deepEqual(claimDecision({ entry: { kind: "signMessage" }, unlocked: true, loggedOut: false, connected: false }), { ok: false, reason: "disconnected" });
  // ...but Connect is how a site gets connected
  assert.deepEqual(claimDecision({ entry: { kind: "connect" }, unlocked: true, loggedOut: false, connected: false }), { ok: true });
});
check("a site's priority fee is whole sompi, at most 1 KAS", () => {
  assert.deepEqual(sitePriorityFee(undefined), { sompi: "0" });
  assert.deepEqual(sitePriorityFee("0005000"), { sompi: "5000" });
  assert.deepEqual(sitePriorityFee(String(MAX_SITE_PRIORITY_FEE_SOMPI)), { sompi: "100000000" });
  assert.match(sitePriorityFee("100000001").error, /limited to 100000000 sompi/);
  assert.match(sitePriorityFee("999999999999999").error, /limited/);
  assert.match(sitePriorityFee("1.5").error, /whole number/);
  assert.match(sitePriorityFee("-1").error, /whole number/);
  assert.match(sitePriorityFee("12345678901234567890").error, /whole number/);
});
check("the total is the amount plus the network fee plus the site's fee", () => {
  assert.deepEqual(approvalTotals({ amount: 100n, networkFeeSompi: null, siteFeeSompi: 5n }), { fees: null, total: null });
  assert.deepEqual(approvalTotals({ amount: 100n, networkFeeSompi: 20n, siteFeeSompi: 5n }), { fees: 25n, total: 125n });
  assert.deepEqual(approvalTotals({ amount: 100n, networkFeeSompi: 20n }), { fees: 20n, total: 120n });
});
check("a rejected site waits out the cooldown", () => {
  assert.equal(cooldownLeft(undefined, 1000), 0);
  assert.equal(cooldownLeft(1000, 1000), REJECT_COOLDOWN_MS);
  assert.equal(cooldownLeft(1000, 1000 + REJECT_COOLDOWN_MS), 0);
  assert.equal(cooldownLeft(1000, 1000 + REJECT_COOLDOWN_MS + 1), 0);
});
check("approve buttons arm after the screen has been visible long enough", () => {
  assert.equal(armDelayLeft({ visibleSince: null, shownAt: 0, now: 10_000 }), null);
  assert.equal(armDelayLeft({ visibleSince: 0, shownAt: 1000, now: 1000 }), APPROVE_ARM_MS);
  assert.equal(armDelayLeft({ visibleSince: 0, shownAt: 1000, now: 1000 + APPROVE_ARM_MS }), 0);
  // shown while hidden: the clock starts when it becomes visible
  assert.equal(armDelayLeft({ visibleSince: 3000, shownAt: 1000, now: 3200 }), APPROVE_ARM_MS - 200);
});
check("connection changes carry an address only while KaPay is open", () => {
  const before = { "https://a.example": { address: "kaspa:a1" }, "https://b.example": { address: "kaspa:b" } };
  const after = { "https://a.example": { address: "kaspa:a2" }, "https://c.example": { address: "kaspa:c" } };
  assert.deepEqual(connectionChangeEvents(before, after, true), [
    ["https://a.example", "accountsChanged", ["kaspa:a2"]],
    ["https://b.example", "accountsChanged", []],
    ["https://b.example", "disconnect", null],
    ["https://c.example", "accountsChanged", ["kaspa:c"]],
  ]);
  assert.deepEqual(connectionChangeEvents(before, after, false), [
    ["https://b.example", "accountsChanged", []],
    ["https://b.example", "disconnect", null],
  ]);
});
check("a network switch tells the network's own sites, and the others only that they lost their account", () => {
  const mainnet = { "https://both.example": { address: "kaspa:x" }, "https://main.example": { address: "kaspa:m" } };
  const testnet = { "https://both.example": { address: "kaspatest:x" }, "https://test.example": { address: "kaspatest:t" } };
  assert.deepEqual(networkSwitchEvents({ nowTestnet: true, mainnet, testnet, open: true }), [
    ["https://both.example", "networkChanged", "testnet-10"],
    ["https://both.example", "accountsChanged", ["kaspatest:x"]],
    ["https://test.example", "networkChanged", "testnet-10"],
    ["https://test.example", "accountsChanged", ["kaspatest:t"]],
    ["https://main.example", "accountsChanged", []],
  ]);
  const locked = networkSwitchEvents({ nowTestnet: false, mainnet, testnet, open: false });
  assert.ok(locked.every(([, event, payload]) => event !== "accountsChanged" || payload.length === 0));
  assert.ok(!locked.some(([origin, event]) => origin === "https://test.example" && event === "networkChanged"));
  assert.deepEqual(networkSwitchEvents({ nowTestnet: false, mainnet: undefined, testnet: undefined, open: true }), []);
});
check("lock, unlock, Log Out and sign-in tell the sites their account or []", () => {
  const all = { "https://a.example": { address: "kaspa:a" }, "https://broken.example": {} };
  assert.deepEqual(openStateEvents(all, true), [["https://a.example", "accountsChanged", ["kaspa:a"]]]);
  assert.deepEqual(openStateEvents(all, false), [["https://a.example", "accountsChanged", []]]);
});

console.log(`\n${passed} checks passed`);
