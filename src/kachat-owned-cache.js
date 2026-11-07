// Your Domains' .kachat names and offers, kept in this browser per wallet address and network
// (KaPay iOS f4f5c0f KachatOwnedNamesCache), so the list shows at once instead of waiting on the
// registry every time. They rarely change: the saved copy shows first - minus any name that lapsed
// since - while the registry read runs behind it, and only an answer replaces the copy (a new
// name, a sale, a transfer or a lapse lands then); a failed read leaves what is shown. The domain
// counts on the Wallet tab and on Your Domains start from the saved list too.
//
// The list itself is kachat-live.js's liveDomainsTab, which keeps its entries in
// `liveDomainsTab.cache` (domainsCacheKey(address) -> { names, offers, loaded, ... }; an address's
// own .kachat tab keeps a separate entry, so its list is never saved as the wallet's); this seeds
// an entry from the saved copy before its first load and saves the entry again whenever a load
// brings new names.

import { liveDomainsTab, domainsCacheKey } from "./kachat-live.js";
import { kachatRegistry } from "./kachat-names.js";
import { NameInfo, OfferInfo, Status } from "../shared/engine/kachat-names/registry-state.js";
import { NETWORK } from "./net.js";

const keyFor = (address) => `kachat_owned_names_${NETWORK === "testnet" ? "testnet" : "mainnet"}_${String(address).toLowerCase()}`;

// JSON with BigInt and bytes: { $b: "123" } and { $u: "hex" }; everything else as it is.
function encode(value) {
  if (typeof value === "bigint") return { $b: value.toString() };
  if (value instanceof Uint8Array) return { $u: Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v);
    return out;
  }
  return value;
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (typeof value.$b === "string") return BigInt(value.$b);
    if (typeof value.$u === "string") return Uint8Array.from(value.$u.match(/../g) || [], (h) => parseInt(h, 16));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

/** The saved { names: NameInfo[], offers: OfferInfo[], savedAt } of `address`, or null. */
export function loadOwnedNames(address) {
  if (!address) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(address)) || "null");
    if (!raw || !Array.isArray(raw.names)) return null;
    return {
      names: raw.names.map((n) => new NameInfo(decode(n))),
      offers: (Array.isArray(raw.offers) ? raw.offers : []).map((o) => new OfferInfo(decode(o))),
      savedAt: Number(raw.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

function saveOwnedNames(address, names, offers) {
  try {
    localStorage.setItem(keyFor(address), JSON.stringify({ names: encode(names), offers: encode(offers), savedAt: Date.now() }));
  } catch { /* storage full or blocked: the next visit waits on the registry, as before */ }
}

/** The saved names still held: a lapsed one isn't theirs any more (iOS `!= .lapsed`). */
function withoutLapsed(names) {
  const graceMs = kachatRegistry()?.graceMs;
  if (graceMs == null) return names;
  return names.filter((n) => n.status(graceMs) !== Status.lapsed);
}

/** The saved count of `address`'s names (lapsed ones left out), or null when none is saved. */
export function cachedOwnedCount(address) {
  const saved = loadOwnedNames(address);
  return saved ? withoutLapsed(saved.names).length : null;
}

/** The list's entry for `address` (`{ names, loaded, ... }`), or undefined before it is asked for. */
export function ownedDomainsEntry(address) { return liveDomainsTab.cache?.get(domainsCacheKey(address)); }

/** The names and offers one load started with, per address: a load that answers replaces the
 *  array (kachat-live.js), a failed one leaves it - so a new array is an answer to save. */
const seen = new Map();

/**
 * liveDomainsTab for Your Domains, starting from the saved copy: the same `{ html, bind, ... }`.
 * `repaint` is called as liveDomainsTab calls it; an answer is saved before it.
 */
export function ownedDomainsTab(address, repaint) {
  const cache = liveDomainsTab.cache || (liveDomainsTab.cache = new Map());
  const cacheKey = domainsCacheKey(address);
  if (kachatRegistry() && !cache.has(cacheKey)) {
    const saved = loadOwnedNames(address);
    if (saved) {
      // shown at once (iOS showCachedIfNeeded: loaded); revision -1, so the read still runs behind it
      cache.set(cacheKey, { names: withoutLapsed(saved.names), offers: saved.offers, loaded: true, loading: false, revision: -1 });
    }
  }
  const entry = cache.get(cacheKey);
  if (entry && !seen.has(address)) seen.set(address, { names: entry.names, offers: entry.offers });
  return liveDomainsTab({
    address,
    repaint: () => {
      const now = cache.get(cacheKey);
      const before = seen.get(address);
      if (now?.loaded && (!before || now.names !== before.names)) {
        saveOwnedNames(address, now.names, now.offers);
        seen.set(address, { names: now.names, offers: now.offers });
      }
      repaint();
    },
  });
}
