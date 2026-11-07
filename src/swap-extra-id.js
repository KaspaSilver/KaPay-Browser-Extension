// Swap coins whose addresses carry an extra ID (XRP's destination tag, Algorand's memo). Without it
// a deposit into ChangeNOW's shared address can't be credited, and a payout to an exchange account
// can't reach it. ChangeNOW's /v2/exchange/currencies marks them (hasExternalId for a deposit,
// isExtraIdSupported for a payout); of the curated coins (shared/ui/swap-quote.js) these two are the
// only ones, checked against the live list on 2026-11-07. No DOM here, so tools/test-swap-extra-id.mjs
// runs it in node.

const EXTRA_ID_NAMES = Object.freeze({
  "xrp:xrp": "Destination Tag",
  "usdc:algo": "Memo",
});
const XRP_TAG_MAX = 4294967295; // a destination tag is a 32-bit unsigned number

/** What the coin calls its extra ID ("Destination Tag", "Memo"), or null when it has none. */
export function extraIdName(coin) {
  return coin ? EXTRA_ID_NAMES[`${coin.ticker}:${coin.network}`] || null : null;
}

/** The payout's extra ID as typed, checked -> { value, error }. Empty is allowed: a personal wallet
 *  needs none, an exchange account does (the field says so). Nothing for a coin without one. */
export function checkPayoutExtraId(coin, text) {
  const name = extraIdName(coin);
  const value = String(text ?? "").trim();
  if (!name || !value) return { value: "", error: "" };
  if (coin.ticker === "xrp" && (!/^\d{1,10}$/.test(value) || Number(value) > XRP_TAG_MAX)) {
    return { value: "", error: `A ${name} is a whole number from 0 to ${XRP_TAG_MAX}.` };
  }
  return { value, error: "" };
}

/**
 * A request's fetch options with the payout's extra ID in the create body. The shared client's
 * create has no field for it; ChangeNOW's request field is `extraId` (it answers it back as
 * `payoutExtraId`). Only a POST whose JSON body names a payout `address` changes - quotes and
 * status reads pass through as they are.
 */
export function withPayoutExtraId(init, extraId) {
  const value = String(extraId ?? "").trim();
  if (!value || String(init?.method || "GET").toUpperCase() !== "POST" || typeof init?.body !== "string") return init;
  let body;
  try { body = JSON.parse(init.body); } catch { return init; }
  if (!body || typeof body !== "object" || !body.address) return init;
  return { ...init, body: JSON.stringify({ ...body, extraId: value }) };
}

/** Whether ChangeNOW's answer kept the extra ID that was sent (an empty one needs nothing). */
export function payoutExtraIdKept(sent, response) {
  const value = String(sent ?? "").trim();
  if (!value) return true;
  return String(response?.payoutExtraId ?? "").trim() === value;
}
