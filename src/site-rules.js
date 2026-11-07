// The website broker's rules with no browser in them, shared by background.js (the worker) and
// approve.js (the approval window), and checked by tools/test-site-rules.mjs (audit 2026-11-07).

// --- answers to the site ----------------------------------------------------------------------

export const rejected = () => ({ error: { code: 4001, message: "The request was rejected in KaPay." } });
// The approval window went away while it was sending an approved payment, or the network never
// confirmed it: it may have reached the network, so this is never "rejected" (audit EXT-012) - the
// site must check before asking again. `txid`, when known, lets it look the payment up.
export function maybeSent(txid = "") {
  const id = String(txid || "").trim().toLowerCase();
  return { error: { code: 4002, message: "The payment may have been sent. Check your wallet before trying again.", ...(/^[0-9a-f]{64}$/.test(id) ? { txid: id } : {}) } };
}

/**
 * What the site hears for an approval window's "approval-result". `entry.sending`: the window
 * had a payment past the password when it answered. `message.outcomeUnknown`: the send got no
 * answer from the network (SEND_OUTCOME_UNKNOWN) - "may have been sent", never a rejection.
 */
export function approvalAnswer(entry, message) {
  if (message?.outcomeUnknown) return maybeSent(message.txid);
  if (message?.error) return entry?.sending ? maybeSent() : rejected();
  return { result: message?.result };
}

/**
 * Whether the approval window may act (connect, sign, send) on request `entry` now: the worker
 * still holds it (a restarted worker has already told the site "KaPay is unavailable"), it isn't
 * answered, and KaPay is unlocked and signed in.
 */
export function claimDecision({ entry, unlocked, loggedOut }) {
  if (!entry || entry.done) return { ok: false, reason: "expired" };
  if (loggedOut) return { ok: false, reason: "signedOut" };
  if (!unlocked) return { ok: false, reason: "locked" };
  return { ok: true };
}

// --- what a site may ask ----------------------------------------------------------------------

// A site's priorityFee for sendKaspa tops out at 1 KAS: hundreds of times a busy network's fee,
// and a bound on what a page can add on top of the amount it shows (audit 2026-11-07).
export const MAX_SITE_PRIORITY_FEE_SOMPI = 100_000_000n;

/** A site's priorityFee (sompi, as text): `{ sompi }` normalised, or `{ error }` for the site. */
export function sitePriorityFee(value) {
  const text = String(value ?? "0").trim();
  if (!/^\d{1,19}$/.test(text)) return { error: "sendKaspa: priorityFee is a whole number of sompi." };
  const sompi = BigInt(text);
  if (sompi > MAX_SITE_PRIORITY_FEE_SOMPI) return { error: `sendKaspa: priorityFee is limited to ${MAX_SITE_PRIORITY_FEE_SOMPI} sompi (1 KAS).` };
  return { sompi: sompi.toString() };
}

/** The send approval's sums, in sompi (BigInt): the network's fee and the site's extra fee are
 *  shown apart, and the total is everything leaving the wallet. null until the fee is known. */
export function approvalTotals({ amount, networkFeeSompi, siteFeeSompi = 0n }) {
  if (networkFeeSompi == null) return { fees: null, total: null };
  const fees = BigInt(networkFeeSompi) + BigInt(siteFeeSompi || 0n);
  return { fees, total: BigInt(amount) + fees };
}

// After a site's request is rejected it waits this long before it can open another approval
// window, so a page can't keep popping them up under the user's clicks (audit 2026-11-07).
export const REJECT_COOLDOWN_MS = 5_000;

/** Milliseconds `origin` still has to wait, given when its last request was rejected. */
export function cooldownLeft(rejectedAt, now) {
  return rejectedAt == null ? 0 : Math.max(0, rejectedAt + REJECT_COOLDOWN_MS - now);
}

// The approval window's Connect / Sign / Approve wait until the screen has been visible this long
// (audit 2026-11-07): a window that opens under a click the site timed can't take it as a yes.
export const APPROVE_ARM_MS = 500;

/** Milliseconds until a screen shown at `shownAt` arms; null while the window is hidden. */
export function armDelayLeft({ visibleSince, shownAt, now, ms = APPROVE_ARM_MS }) {
  if (visibleSince == null) return null;
  return Math.max(0, Math.max(visibleSince, shownAt) + ms - now);
}

// --- telling sites what changed ---------------------------------------------------------------
// Each event is [origin, event, payload]. `open`: KaPay is unlocked and signed in - the same test
// getAccounts uses, so an event never hands out an address getAccounts would hold back.

/** One network's connections changed (connect, disconnect, the account's address moved). */
export function connectionChangeEvents(before = {}, after = {}, open = true) {
  const events = [];
  for (const origin of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const was = before?.[origin]?.address || null;
    const now = after?.[origin]?.address || null;
    if (was === now) continue;
    // while locked or signed out the new address waits for the unlock (openStateEvents)
    if (now) { if (open) events.push([origin, "accountsChanged", [now]]); }
    else events.push([origin, "accountsChanged", []], [origin, "disconnect", null]);
  }
  return events;
}

/**
 * The wallet switched networks. Sites connected on the network now in use hear networkChanged and
 * their account; a site connected only on the other network hears just accountsChanged([]) - it
 * has no account here now - and nothing about which network it is (audit 2026-11-07).
 */
export function networkSwitchEvents({ nowTestnet, mainnet = {}, testnet = {}, open }) {
  const current = (nowTestnet ? testnet : mainnet) || {};
  const other = (nowTestnet ? mainnet : testnet) || {};
  const events = [];
  for (const [origin, entry] of Object.entries(current)) {
    events.push([origin, "networkChanged", nowTestnet ? "testnet-10" : "mainnet"]);
    events.push([origin, "accountsChanged", open && entry?.address ? [entry.address] : []]);
  }
  for (const origin of Object.keys(other)) if (!(origin in current)) events.push([origin, "accountsChanged", []]);
  return events;
}

/** KaPay locked / unlocked, or was logged out / signed in: the current network's sites hear
 *  their account, or [] while it is closed. */
export function openStateEvents(connections = {}, open) {
  return Object.entries(connections || {})
    .filter(([, entry]) => entry?.address)
    .map(([origin, entry]) => [origin, "accountsChanged", open ? [entry.address] : []]);
}
