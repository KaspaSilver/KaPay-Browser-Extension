// Import finds the wallet type from the words (src/import-search.js, KaPay iOS 018e634
// WalletManager.findImportAccounts): what has funds or history, the type holding the most first, each
// type's addresses in index order, ties to the standard wallet; See Every Wallet Type adds each
// type's #0. Run: node tools/test-import-search.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  IMPORT_WALLET_TYPES, walletTypeName, rankImportCandidates, visibleImportRows, candidateId, sameChoice, DEFAULT_IMPORT_CHOICE,
} from "../src/import-search.js";

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

const row = (family, index) => ({ family, index, address: `kaspa:${family}-${index}` });
const candidates = [
  ...Array.from({ length: 50 }, (_, i) => row("kaspaStandard", i)),
  ...Array.from({ length: 20 }, (_, i) => row("kaspaLegacy972", i)),
  ...Array.from({ length: 20 }, (_, i) => row("oneKey", i)),
];

check("the types iOS checks that the engine can open, at iOS's depths (Chainge waits for the engine)", () => {
  assert.deepEqual(IMPORT_WALLET_TYPES.map((t) => [t.family, t.depth]), [["kaspaStandard", 50], ["kaspaLegacy972", 20], ["oneKey", 20]]);
  assert.equal(walletTypeName("kaspaLegacy972"), "KDX / Kaspanet Web");
  assert.equal(walletTypeName("oneKey"), "OneKey");
  assert.equal(walletTypeName("kaspaStandard"), "Standard Kaspa Wallet");
  const engine = readFileSync(new URL("../shared/engine/wallet.js", import.meta.url), "utf8");
  for (const { family } of IMPORT_WALLET_TYPES) assert.ok(engine.includes(`"${family}"`), family);
});
check("nothing with funds or history: empty (Import opens Standard #0)", () => {
  assert.deepEqual(rankImportCandidates(candidates, {}, new Set()), []);
  assert.deepEqual(DEFAULT_IMPORT_CHOICE, { family: "kaspaStandard", index: 0 });
});
check("the type holding the most comes first; each type in index order", () => {
  const ranked = rankImportCandidates(candidates, {
    "kaspa:kaspaStandard-7": 5n, "kaspa:kaspaStandard-2": 1n,
    "kaspa:kaspaLegacy972-3": 100n,
  });
  assert.deepEqual(ranked.map(candidateId), ["kaspaLegacy972-3", "kaspaStandard-2", "kaspaStandard-7"]);
  assert.equal(ranked[0].balanceSompi, 100n);
});
check("history alone counts (a chat identity, an emptied wallet), after funded types", () => {
  const ranked = rankImportCandidates(candidates, { "kaspa:oneKey-4": 9n }, new Set(["kaspa:kaspaStandard-0"]));
  assert.deepEqual(ranked.map(candidateId), ["oneKey-4", "kaspaStandard-0"]);
  assert.equal(ranked[1].hasHistory, true);
  assert.equal(ranked[1].balanceSompi, 0n);
});
check("a tie goes to the earlier type, so the standard wallet wins when nothing tells them apart", () => {
  const ranked = rankImportCandidates(candidates, {}, new Set(["kaspa:oneKey-0", "kaspa:kaspaLegacy972-0", "kaspa:kaspaStandard-0"]));
  assert.deepEqual(ranked.map(candidateId), ["kaspaStandard-0", "kaspaLegacy972-0", "oneKey-0"]);
});
check("See Every Wallet Type: what was found, then each type's #0 not already listed", () => {
  const found = rankImportCandidates(candidates, { "kaspa:kaspaStandard-0": 1n, "kaspa:kaspaStandard-3": 1n });
  const every = IMPORT_WALLET_TYPES.map((t) => ({ ...row(t.family, 0), balanceSompi: 0n, hasHistory: false }));
  assert.deepEqual(visibleImportRows(found, every, false).map(candidateId), ["kaspaStandard-0", "kaspaStandard-3"]);
  assert.deepEqual(visibleImportRows(found, every, true).map(candidateId), ["kaspaStandard-0", "kaspaStandard-3", "kaspaLegacy972-0", "oneKey-0"]);
});
check("a choice is its type and its index", () => {
  assert.ok(sameChoice({ family: "oneKey", index: 2 }, row("oneKey", 2)));
  assert.ok(!sameChoice({ family: "oneKey", index: 2 }, row("kaspaStandard", 2)));
  assert.ok(!sameChoice(null, row("oneKey", 2)));
});
check("the import screens: no wallet list, and the import opens the choice with or without a passphrase", () => {
  const onboarding = readFileSync(new URL("../src/onboarding.js", import.meta.url), "utf8");
  assert.ok(!onboarding.includes("<h2>Where are your 12 or 24 words from?"));
  assert.ok(!onboarding.includes("showImportSource"));
  assert.match(onboarding, /family: flow\.choice\.family, name: d\.name\.trim\(\), imported: true, identityIndex: flow\.choice\.index/);
  assert.match(onboarding, /flow\.mode === "import" \? showImportFound\(flow\)/);
});

console.log(`\n${passed} passed`);
