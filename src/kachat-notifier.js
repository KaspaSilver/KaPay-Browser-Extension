// The bell's .kachat news (iOS 86471dd KachatNamesNotifier; KaChat-Desktop ui/kachat-names-notifier.js):
// turns registry changes into bell rows - an offer on one of your names, a name sold or reclaimed,
// its renewal window opening, its expiry and the end of its grace (no longer yours: Available to
// anyone, iOS eea52b2), and what became of your own offers (accepted, declined, expired, returned).
//
// It compares what the registry says now with what it saw on the last check (kept per wallet), after
// registry refreshes and each time the wallet opens. The first check of a wallet only records where
// things stand. Offers you withdrew or refunded yourself (actions.selfClosedOffers) aren't news.
// Testnet only until names launch on mainnet (`kachatNames()` is null there).
//
// A name held by one of the wallet's spending addresses gets no indexer pushes (they reach only
// the chatting address), and the extension has no notifications permission (owner, 2026-10-16:
// bell only), so its reminders are bell rows: renewal open and expired as for every name, and
// also "a day before grace ends" - iOS's local last-call reminder (XP-024, reminders.js times).

import { kachatNames } from "./kachat-names.js";
import { KAS_UNIT } from "./net.js";
import { Status } from "../shared/engine/kachat-names/registry-state.js";
import { bytesEqual } from "../shared/engine/kachat-names/codec.js";
import { dayString } from "../shared/engine/kachat-names/actions.js";
import { amount } from "./kachat-live.js";
import { record } from "./bell.js";
import { logWarn } from "./log.js";

const SNAPSHOT_PREFIX = "kachat-names-notifier-v1:";
/** A check runs at most this often (refreshes and opening the wallet both ask). */
const MIN_INTERVAL_MS = 20_000;

let checking = false;
let lastCheckAt = 0;
let trailingTimer = null;
let watchedRegistry = null;

function readSnapshot(walletAddress) {
  try {
    const text = localStorage.getItem(SNAPSHOT_PREFIX + walletAddress);
    if (!text) return null;
    const j = JSON.parse(text);
    if (!j || typeof j !== "object" || typeof j.names !== "object") return null;
    return {
      names: j.names || {},
      offersOnMine: new Set(Array.isArray(j.offersOnMine) ? j.offersOnMine.map(String) : []),
      myOffers: j.myOffers && typeof j.myOffers === "object" ? j.myOffers : {},
    };
  } catch {
    return null;
  }
}

function writeSnapshot(walletAddress, snapshot) {
  try {
    localStorage.setItem(SNAPSHOT_PREFIX + walletAddress, JSON.stringify({
      names: snapshot.names,
      offersOnMine: [...snapshot.offersOnMine],
      myOffers: snapshot.myOffers,
    }));
  } catch { /* storage full: the next check compares against the older snapshot */ }
}

/** One check: what changed for this wallet's names and offers since the last one. Never throws;
 *  a registry that can't be read leaves the snapshot as it was. */
export async function checkKachatNamesNews() {
  if (checking) return;
  const rt = await kachatNames().catch(() => null);
  if (!rt) return;
  const { registry, actions } = rt;
  const me = actions.myKey;
  const walletAddress = actions.myAddress;
  const params = registry.manifest?.params;
  if (!me || !walletAddress || !params) return;
  checking = true;
  lastCheckAt = Date.now();
  try {
    const graceMs = registry.graceMs;
    let owned;
    let myOpenOffers;
    // every address of this wallet, not only the chatting one: a name claimed with Buy From gets
    // its notices too - renewal open, expired, no longer yours - here in the bell, since the
    // indexer's pushes reach only the chatting address (iOS d1026de, IOS-085 / XP-024)
    try {
      ({ names: owned, offers: myOpenOffers } = await actions.ownNamesAndOffers({ heldOnly: false }));
    } catch {
      return;
    }
    const now = BigInt(Date.now());
    const offersOnMine = [];
    for (const n of owned) {
      if (n.status(graceMs, now) !== Status.active) continue;
      let open = [];
      try { open = await registry.offersFor(n.name); } catch { open = []; }
      for (const o of open) if (actions.isOwnKey(o.seller)) offersOnMine.push(o);
    }
    // a different wallet signed in meanwhile: this answer isn't its (asked again after every
    // wait below, and the bell itself drops a row for any account but the one it shows)
    const stillMine = () => actions.myAddress === walletAddress;
    if (!stillMine()) return;

    const old = readSnapshot(walletAddress);
    const quiet = old == null; // the first check only records where things stand
    const next = { names: {}, offersOnMine: new Set(), myOffers: {} };
    const stamp = Date.now();
    const post = (id, name, title, body) => {
      if (!quiet && stillMine()) record({ id: `kachat-${id}`, source: "kachat", title, body, timestamp: stamp, targetId: name, account: walletAddress });
    };

    // Your names: renewal open, expired (grace), past grace (no longer yours) - once per paid period.
    for (const n of owned) {
      const display = `${n.name}.kachat`;
      const expiresAt = String(n.expiresAt);
      const prev = old?.names?.[n.name];
      const s = prev && prev.expiresAt === expiresAt
        ? { ...prev }
        : { expiresAt, renewNoted: false, graceNoted: false, lastCallNoted: false, lapsedNoted: false };
      switch (n.status(graceMs, now)) {
        case Status.active:
          if (!s.renewNoted && n.renewOpen(params, now)) {
            post(`renew-${n.name}-${expiresAt}`, n.name, `Renew ${display}`,
              `Renewal is open: renew it before ${dayString(Number(n.expiresAt))} to keep it.`);
            s.renewNoted = true;
          }
          break;
        case Status.grace:
          s.renewNoted = true;
          // a day before grace ends (at most half the grace in), for a name on a spending address
          if (!s.lastCallNoted && !bytesEqual(n.owner, me)) {
            const grace = BigInt(graceMs);
            const lastCallBefore = grace / 2n < 86_400_000n ? grace / 2n : 86_400_000n;
            if (now >= BigInt(n.expiresAt) + grace - lastCallBefore) {
              post(`lastcall-${n.name}-${expiresAt}`, n.name, `${display} has expired`,
                `Renew it before ${dayString(Number(n.expiresAt) + Number(graceMs))} or anyone can claim it.`);
              s.lastCallNoted = true;
              s.graceNoted = true; // the last call says it; no second "expired" row
            }
          }
          if (!s.graceNoted) {
            post(`grace-${n.name}-${expiresAt}`, n.name, `${display} has expired`,
              `Renew it before ${dayString(Number(n.expiresAt) + Number(graceMs))} or anyone can claim it.`);
            s.graceNoted = true;
          }
          break;
        default:
          s.renewNoted = true;
          s.graceNoted = true;
          if (!s.lapsedNoted) {
            post(`lapsed-${n.name}-${expiresAt}`, n.name, `${display} is no longer yours`,
              "It expired and wasn't renewed, so it's now available to anyone in the marketplace. Your bond comes back to you when someone claims it.");
            s.lapsedNoted = true;
          }
      }
      next.names[n.name] = s;
    }

    // Names that left this wallet: sold, bought through an offer, or freed (reclaimed - claiming an
    // expired name frees it first). A transfer or release is your own doing and needs no notice.
    for (const name of Object.keys(old?.names || {})) {
      if (next.names[name]) continue;
      let history = [];
      try { history = await registry.history(name); } catch { history = []; }
      const last = history.find((e) => ["sale", "offer_accepted", "offer_accept", "transfer", "release", "reclaim"].includes(e.op));
      if (!last) continue;
      const display = `${name}.kachat`;
      if (last.op === "sale") {
        post(`sold-${last.txId}`, name, `${display} sold`, last.price != null ? `${amount(last.price)} was paid to you.` : "Your listing was bought.");
      } else if (last.op === "offer_accepted" || last.op === "offer_accept") {
        post(`sold-${last.txId}`, name, `${display} sold`, "You accepted an offer for it.");
      } else if (last.op === "reclaim") {
        post(`reclaimed-${last.txId}`, name, `${display} was freed`, "It expired and was cleared from the registry. Your bond is back with you.");
      }
    }

    // Offers on your names.
    for (const o of offersOnMine) {
      next.offersOnMine.add(o.id);
      if (old?.offersOnMine?.has(o.id) || !o.name) continue;
      post(`offer-${o.id}`, o.name, `New offer on ${o.name}.kachat`, `${amount(o.amount)} offered for it.`);
    }

    // Your offers: accepted, or back with you.
    for (const o of myOpenOffers) next.myOffers[o.id] = o.name || "";
    for (const [id, name] of Object.entries(old?.myOffers || {})) {
      if (next.myOffers[id] != null || !name) continue;
      if (actions.selfClosedOffers?.has(id)) continue;
      const display = `${name}.kachat`;
      if (owned.some((n) => n.name === name)) {
        post(`myoffer-${id}`, name, "Offer accepted", `${display} is yours now.`);
        continue;
      }
      let history = [];
      try { history = await registry.history(name); } catch { history = []; }
      const op = history.find((e) => ["offer_decline", "offer_refund", "offer_withdraw"].includes(e.op))?.op;
      if (op === "offer_decline") {
        post(`myoffer-${id}`, name, `Offer on ${display} declined`, `The owner declined it. The ${KAS_UNIT} is back with you.`);
      } else if (op === "offer_refund") {
        post(`myoffer-${id}`, name, `Offer on ${display} expired`, `Nobody accepted it in time. The ${KAS_UNIT} is back with you.`);
      } else {
        post(`myoffer-${id}`, name, `Offer on ${display} returned`, `It can no longer be accepted. The ${KAS_UNIT} is back with you.`);
      }
    }

    // switched away part way: no snapshot, so the next check of this wallet posts what this one
    // couldn't (the bell keeps each row once)
    if (!stillMine()) return;
    writeSnapshot(walletAddress, next);
  } catch (error) {
    logWarn("[KaPay] .kachat news check failed:", error);
  } finally {
    checking = false;
  }
}

/** A check now, or once the minimum interval has passed (one trailing check at most). */
function scheduleCheck() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCheckAt);
  if (wait <= 0) { checkKachatNamesNews(); return; }
  if (trailingTimer) return;
  trailingTimer = setTimeout(() => { trailingTimer = null; checkKachatNamesNews(); }, wait);
}

/** Starts the notifier (safe to call more than once): a check after every registry change, and now
 *  (a stale registry is refreshed first). Nothing on mainnet. */
export async function startKachatNamesNotifier() {
  const rt = await kachatNames().catch(() => null);
  if (!rt) return;
  if (watchedRegistry !== rt.registry) {
    watchedRegistry = rt.registry;
    try { rt.registry.onChange(() => scheduleCheck()); } catch { /* fine */ }
  }
  rt.registry.refreshIfStale().then(() => scheduleCheck(), () => {});
}
