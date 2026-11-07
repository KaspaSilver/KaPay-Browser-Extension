// Swap coins with an extra ID (src/swap-extra-id.js): which coins have one, the payout's tag as typed,
// the create body ChangeNOW gets (`extraId`) and the check that its answer kept it.
// Run: node tools/test-swap-extra-id.mjs
import assert from "node:assert/strict";
import { extraIdName, checkPayoutExtraId, withPayoutExtraId, payoutExtraIdKept } from "../src/swap-extra-id.js";
import { CURATED_COINS, KAS, createChangeNowClient } from "../shared/ui/swap-quote.js";

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`ok - ${name}`); }

const coin = (ticker, network) => CURATED_COINS.find((c) => c.ticker === ticker && c.network === network);
const XRP = coin("xrp", "xrp");
const USDC_ALGO = coin("usdc", "algo");

await check("XRP and USDC on Algorand carry an extra ID; KAS and the rest don't", () => {
  assert.equal(extraIdName(XRP), "Destination Tag");
  assert.equal(extraIdName(USDC_ALGO), "Memo");
  assert.equal(extraIdName(KAS), null);
  assert.equal(extraIdName(null), null);
  const withOne = CURATED_COINS.filter((c) => extraIdName(c)).map((c) => `${c.ticker}:${c.network}`);
  assert.deepEqual(withOne, ["xrp:xrp", "usdc:algo"]);
});
await check("a destination tag is a 32-bit whole number; empty is allowed", () => {
  assert.deepEqual(checkPayoutExtraId(XRP, ""), { value: "", error: "" });
  assert.deepEqual(checkPayoutExtraId(XRP, " 12345 "), { value: "12345", error: "" });
  assert.deepEqual(checkPayoutExtraId(XRP, "4294967295"), { value: "4294967295", error: "" });
  assert.ok(checkPayoutExtraId(XRP, "4294967296").error);
  assert.ok(checkPayoutExtraId(XRP, "12a").error);
  assert.ok(checkPayoutExtraId(XRP, "-1").error);
  assert.deepEqual(checkPayoutExtraId(USDC_ALGO, " note 1 "), { value: "note 1", error: "" });
  // a coin without one never sends what was typed for another
  assert.deepEqual(checkPayoutExtraId(coin("btc", "btc"), "123"), { value: "", error: "" });
});
await check("only the create body gets `extraId`", () => {
  const create = { method: "POST", headers: { a: 1 }, body: JSON.stringify({ fromCurrency: "kas", address: "r123", flow: "standard" }) };
  assert.deepEqual(JSON.parse(withPayoutExtraId(create, "42").body), { fromCurrency: "kas", address: "r123", flow: "standard", extraId: "42" });
  assert.deepEqual(withPayoutExtraId(create, "42").headers, { a: 1 });
  assert.equal(withPayoutExtraId(create, ""), create);
  const get = { method: "GET" };
  assert.equal(withPayoutExtraId(get, "42"), get);
  const other = { method: "POST", body: JSON.stringify({ id: "x" }) };
  assert.equal(withPayoutExtraId(other, "42"), other);
});
await check("the shared client's create, through the wrapper, sends extraId to ChangeNOW", async () => {
  let sent = null;
  const fetchImpl = async (url, init) => { sent = { url, init }; return { ok: true, status: 200, text: async () => JSON.stringify({ id: "e1", payinAddress: "kaspa:q", payoutExtraId: "42" }) }; };
  const client = createChangeNowClient({ fetchImpl: (url, init) => fetchImpl(url, withPayoutExtraId(init, "42")) });
  const response = await client.create(KAS, XRP, "100", "rXRPaddress");
  assert.equal(JSON.parse(sent.init.body).extraId, "42");
  assert.equal(JSON.parse(sent.init.body).address, "rXRPaddress");
  assert.equal(payoutExtraIdKept("42", response), true);
});
await check("an answer without the tag that was sent is caught", () => {
  assert.equal(payoutExtraIdKept("42", { payoutExtraId: null }), false);
  assert.equal(payoutExtraIdKept("42", {}), false);
  assert.equal(payoutExtraIdKept("42", { payoutExtraId: "43" }), false);
  assert.equal(payoutExtraIdKept("", {}), true);
});

console.log(`\n${passed} passed`);
