// The Kaspa name services - a port of iOS NameServices.swift (NameServiceTLD, NameServicesClient):
//
//   .kachat  KaChat's own names (Kaspa covenants). Live on testnet only, read through the shared
//            registry (kachat-names.js: a names indexer, or the chain itself); mainnet waits for an
//            audit and keeps it not live (iOS 25cc2c9).
//   .kas     KNS (api.knsdomains.org) - the engine's KNS client.
//   .k       dotk (api.dotk.name/v1). GET /addresses/{kaspa address} lists an owner's names;
//            GET /names/{name} resolves one.
//   .kaspa   Kaspa Names (kaspaname.com/v1). GET /addresses/{x-only key}/names lists an owner's
//            names (the 64-hex key inside a P2PK address, not the kaspa: string);
//            GET /resolve/{name} resolves one to its payout address.
//
// Read-only: KaChat never registers .k or .kaspa names - "Get a domain" opens their sites.
// A typed name is resolved on every live service at once; the answer is the ending typed, else
// the first in .kachat, .kas, .k, .kaspa that resolves, and the rest are offered as "Other domains".

import { normalizeDomainLabel, resolveDomain } from "../shared/engine/kns.js";
import { getEndpoint } from "../shared/engine/endpoints.js";
import { dotkCanonical, kaspaNamesCanonical } from "./names-normalize.js";
import { esc, ICONS } from "./ui.js";
import { IS_TESTNET, MAINNET_KNS, TESTNET_KNS } from "./net.js";
import { kachatRegistry, kachatService, kachatLaunched } from "./kachat-names.js";
import { resolveHeldChecked } from "./kachat-resolve.js";
import { normalize as kachatNormalize, isValid as kachatIsValid } from "../shared/engine/kachat-names/codec.js";
import { KachatNamesRegistry } from "../shared/engine/kachat-names/registry.js";
import { logInfo } from "./log.js";

// The KNS API for the running network (testnet reads /tn10, iOS knsBaseURL).
function knsBase() {
  const configured = String(getEndpoint("knsApi") || "").replace(/\/+$/, "");
  if (IS_TESTNET && (!configured || configured === MAINNET_KNS)) return TESTNET_KNS;
  return configured || MAINNET_KNS;
}

// Declaration order is the tab order: KaChat's own names first.
export const NAME_SERVICES = [
  // live on both networks since mainnet v1 (iOS ef6b21e)
  { tld: "kachat", suffix: ".kachat", serviceName: "KaChat Names", site: null, siteName: null, api: null, live: kachatLaunched },
  { tld: "kas", suffix: ".kas", serviceName: "KNS", site: "https://app.knsdomains.org", siteName: "knsdomains.org", api: null, live: true },
  // Testnet-10: dotk has its own API; Kaspa Names publishes no testnet deployment (iOS
  // NameServiceTLD.apiBaseURL).
  { tld: "k", suffix: ".k", serviceName: "dotk", site: "https://dotk.name", siteName: "dotk.name", api: IS_TESTNET ? "https://api-tn10.dotk.name/v1" : "https://api.dotk.name/v1", live: true },
  { tld: "kaspa", suffix: ".kaspa", serviceName: "Kaspa Names", site: "https://kaspaname.com", siteName: "kaspaname.com", api: IS_TESTNET ? null : "https://kaspaname.com/v1", live: true },
];

export const service = (tld) => NAME_SERVICES.find((s) => s.tld === tld);

/** The tab Your Domains opens on: .kachat - its UI is on everywhere, live or not (iOS 7227d69). */
export const DEFAULT_TAB = "kachat";

const RESOLUTION_ORDER = ["kachat", "kas", "k", "kaspa"];

/** { label, tld } - the ending typed, if any. Longest endings first: "bob.kaspa" is not "bob.kas"+"pa". */
export function splitTypedName(input) {
  const trimmed = String(input ?? "").trim();
  const lowered = trimmed.toLowerCase();
  for (const tld of ["kachat", "kaspa", "kas", "k"]) {
    const suffix = `.${tld}`;
    if (lowered.endsWith(suffix)) return { label: trimmed.slice(0, -suffix.length), tld };
  }
  return { label: trimmed, tld: null };
}

/** Could this be a name on any service (and is not an address)? */
export function looksLikeName(input) {
  const trimmed = String(input ?? "").trim().toLowerCase();
  if (trimmed.startsWith("kaspa:") || trimmed.startsWith("kaspatest:")) return false;
  const { label } = splitTypedName(trimmed);
  return Boolean(label) && /^[\p{L}\p{N}\p{M}_-]+$/u.test(label);
}

const TIMEOUT_MS = 15_000;

/** { status: "found", body } | { status: "missing" } (404) | { status: "failed" }. */
async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller.signal });
    if (response.status === 404) return { status: "missing" };
    if (!response.ok) return { status: "failed" };
    return { status: "found", body: await response.json() };
  } catch (error) {
    logInfo("name lookup failed:", new URL(url).host, error?.message || error);
    return { status: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

// --- forward resolution: typed name -> address --------------------------------------------

async function resolveKas(label) {
  const canonical = normalizeDomainLabel(label);
  if (!canonical) return null;
  const display = `${canonical}.kas`;
  try {
    const resolution = await resolveDomain(display, { baseUrl: knsBase() });
    return { tld: "kas", display, address: resolution?.ownerAddress || null, failed: false };
  } catch {
    return { tld: "kas", display, address: null, failed: true };
  }
}

async function resolveDotk(label) {
  const canonical = dotkCanonical(label);
  if (!canonical) return null;
  const display = `${canonical}.k`;
  const outcome = await getJson(`${service("k").api}/names/${encodeURIComponent(canonical)}`);
  return { tld: "k", display, address: outcome.status === "found" ? outcome.body?.address || null : null, failed: outcome.status === "failed" };
}

async function resolveKaspaNames(label) {
  if (!service("kaspa").api) return null;
  const canonical = kaspaNamesCanonical(label);
  if (!canonical) return null;
  const display = `${canonical}.kaspa`;
  // The resolve answer's address is the name's payout record - where payments to it go.
  const outcome = await getJson(`${service("kaspa").api}/resolve/${encodeURIComponent(canonical)}`);
  return { tld: "kaspa", display, address: outcome.status === "found" ? outcome.body?.address || null : null, failed: outcome.status === "failed" };
}

/** .kachat: the owner of a name that is active or in its grace period - a name in grace keeps
 *  resolving to its owner (iOS f7c371a); one past grace does not. Same rules as the registry:
 *  a-z, 0-9, hyphen. Always listed first; where the registry isn't live yet (mainnet before its
 *  launch) it is listed as "Coming soon" and resolves nothing (iOS 6ac48a7).
 *  Every typed name may be paid, so an indexer's answer counts only once the chain holds the
 *  record it describes (KaPay 953b255 confirmOnChain); when it doesn't, or the indexer answered
 *  for another name, the lookup failed. The address and the check come from one answer
 *  (kachat-resolve.js): the engine's `resolveHeldOnChain` reads the indexer twice. */
async function resolveKachat(label) {
  const canonical = kachatNormalize(label);
  if (!kachatIsValid(canonical)) return null;
  const display = `${canonical}.kachat`;
  const registry = kachatRegistry();
  if (!registry) return { tld: "kachat", display, address: null, failed: false, notLive: true };
  try {
    const address = await resolveHeldChecked(registry, canonical, kachatService());
    return { tld: "kachat", display, address: address || null, failed: false };
  } catch (error) {
    logInfo(".kachat lookup failed:", error?.message || error);
    return { tld: "kachat", display, address: null, failed: true };
  }
}

/**
 * What `input` points to on every live service, in priority order:
 * [{ tld, display, address|null, failed }]. A service whose rules reject the label is left out;
 * .kachat is skipped where it is not live (mainnet).
 */
export async function resolveEverywhere(input) {
  const { label } = splitTypedName(input);
  if (!label) return [];
  const results = (await Promise.all([resolveKachat(label), resolveKas(label), resolveDotk(label), resolveKaspaNames(label)])).filter(Boolean);
  return RESOLUTION_ORDER.map((tld) => results.find((r) => r.tld === tld)).filter(Boolean);
}

/** The answer a typed name gets: the service named by its ending, else .kachat - and only .kachat
 *  (iOS 5a5122d). A bare name never falls through to another service on its own (on mainnet
 *  "testing" became testing.kas while .kachat isn't live there): what it is on .kas, .k or .kaspa
 *  waits under "Other domains" for you to pick. */
export function primaryResolution(results, typed) {
  const wanted = splitTypedName(typed).tld || "kachat";
  return results.find((r) => r.tld === wanted && r.address) || null;
}

/** The one not-found message every address field shows (iOS 5a5122d): "No .kas domain found" for
 *  a typed ending, else the .kachat one - "No .kachat domain found", or ".kachat names aren't live
 *  on this network yet" where its registry isn't. */
export function notFoundMessage(typed, results = []) {
  const wanted = splitTypedName(typed).tld || "kachat";
  const kachatNotLive = !service("kachat").live || (results || []).some((r) => r.tld === "kachat" && r.notLive);
  if (wanted === "kachat" && kachatNotLive) return ".kachat names aren't live on this network yet";
  // the service couldn't be asked: that says nothing about whether the name exists (KaPay iOS 2da5f4b)
  if ((results || []).some((r) => r.tld === wanted && r.failed)) return `Couldn't look up ${service(wanted).suffix} right now. Try again in a moment.`;
  return `No ${service(wanted).suffix} domain found`;
}

// --- names an address owns on .k and .kaspa -------------------------------------------------

/**
 * The 32-byte x-only key (hex) a P2PK (Schnorr) kaspa: address carries, or null for any other
 * kind. Bech32 body decoded by hand: the WASM Address.payload getter returns text, not bytes.
 */
export function xOnlyKeyFromAddress(address) {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const body = String(address || "").trim().toLowerCase().replace(/^kaspa(test)?:/, "");
  if (body.length <= 8) return null;
  let acc = 0;
  let bits = 0;
  const bytes = [];
  for (const ch of body.slice(0, -8)) { // the last 8 characters are the checksum
    const value = CHARSET.indexOf(ch);
    if (value < 0) return null;
    acc = ((acc << 5) | value) & 0xffff;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
  }
  if (bytes[0] !== 0x00 || bytes.length !== 33) return null;
  return bytes.slice(1).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ownedDotk(address) {
  const outcome = await getJson(`${service("k").api}/addresses/${encodeURIComponent(address)}`);
  if (outcome.status === "missing") return [];
  if (outcome.status !== "found") return null;
  return (outcome.body?.names || [])
    .map((name) => String(name).toLowerCase())
    .sort()
    .map((name) => ({ name, display: `${name}.k`, tld: "k", provisional: false }));
}

async function ownedKaspaNames(address) {
  if (!service("kaspa").api) return [];
  const key = xOnlyKeyFromAddress(address);
  if (!key) return [];
  const outcome = await getJson(`${service("kaspa").api}/addresses/${key}/names`);
  if (outcome.status === "missing") return [];
  if (outcome.status !== "found") return null;
  return (outcome.body?.names || [])
    // A losing lineage is a registration that was outranked: not this owner's name.
    .filter((entry) => entry?.isWinner !== false)
    .map((entry) => {
      const name = String(entry.name || "").toLowerCase();
      return { name, display: entry.display || `${name}.kaspa`, tld: "kaspa", provisional: entry.settled === false || entry.status === "pending" };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const ownedCache = new Map(); // address -> { k: [...]|null, kaspa: [...]|null }

/** What was last fetched for `address` (no network), or null. */
export function cachedOwnedNames(address) {
  return ownedCache.get(String(address || "").toLowerCase()) || null;
}

/**
 * Every name `address` owns on .k and .kaspa: { k, kaspa }, each a list - or null when that
 * service could not be reached (the tab says so instead of claiming there are none). A failed
 * lookup keeps the names last fetched.
 */
export async function ownedNames(address) {
  const key = String(address || "").trim().toLowerCase();
  const previous = ownedCache.get(key) || {};
  const [k, kaspa] = await Promise.all([ownedDotk(key), ownedKaspaNames(key)]);
  const next = { k: k ?? previous.k ?? null, kaspa: kaspa ?? previous.kaspa ?? null, failed: { k: k == null, kaspa: kaspa == null } };
  ownedCache.set(key, next);
  return next;
}

/** How many names the address owns on .k and .kaspa (the Your Domains count adds .kas). */
export function otherNamesCount(owned) {
  return (owned?.k?.length || 0) + (owned?.kaspa?.length || 0);
}

// --- "Other domains" under an address field ---------------------------------------------------
//
// iOS AddContactView.otherDomainsDropdown, used by every field that takes a name here (Send
// Kaspa, Send Domain): what the same name points to on the other services, each selectable.

export function otherDomainsHtml({ resolutions, selectedTld, open }) {
  const others = (resolutions || []).filter((r) => r.tld !== selectedTld);
  if (!others.length) return "";
  return `
    <div class="other-domains">
      <button type="button" class="other-domains-toggle" id="other-domains" aria-expanded="${open}">
        <span>Other domains</span><span class="other-domains-chevron ${open ? "open" : ""}">${ICONS.chevron}</span>
      </button>
      ${open ? `<div class="other-domains-list">${others.map((r) => `
        <button type="button" class="other-domain" data-pick-tld="${r.tld}" ${r.address ? "" : "disabled"}>
          <span class="tx-meta">
            <span class="${r.address ? "strong" : "muted"}">${esc(r.display)}</span>
            <span class="mono tiny muted ellipsis">${esc(r.address || (r.notLive ? "Coming soon" : r.failed ? "Couldn't check" : "Not registered"))}</span>
          </span>
          ${r.address ? `<span class="accent">${ICONS.arrowRightCircleOutline}</span>` : ""}
        </button>`).join("")}</div>` : ""}
    </div>`;
}

/** Wires the dropdown: the toggle, and picking another service's answer. */
export function bindOtherDomains(root, { onToggle, onPick }) {
  const toggle = root.querySelector("#other-domains");
  if (toggle) toggle.onclick = onToggle;
  for (const button of root.querySelectorAll("[data-pick-tld]")) button.onclick = () => onPick(button.dataset.pickTld);
}

// --- account discovery (iOS NameServicesClient.ownedNames(of:) / ownsAnyName) ----------------

/** Names `address` owns on .k and .kaspa, without touching the Your Domains cache; failures count as none. */
export async function ownedNamesOf(address) {
  const key = String(address || "").trim().toLowerCase();
  if (!key) return [];
  const [k, kaspa] = await Promise.all([ownedDotk(key), ownedKaspaNames(key)]);
  return [...(k || []), ...(kaspa || [])];
}

/** What `address` holds on .k and .kaspa, per service: a list, or null when that service couldn't
 *  be reached (iOS fe52376 ownedNamesByService) - leaves Your Domains' own lists alone. */
export async function ownedNamesByService(address) {
  const key = String(address || "").trim().toLowerCase();
  if (!key) return { k: [], kaspa: [] };
  const [k, kaspa] = await Promise.all([ownedDotk(key).catch(() => null), ownedKaspaNames(key).catch(() => null)]);
  return { k, kaspa };
}

/** ownedNamesOf for many addresses, six at a time (the services rate-limit bursts). */
export async function ownedNamesOfMany(addresses, concurrency = 6) {
  const result = {};
  for (let i = 0; i < addresses.length; i += concurrency) {
    const slice = addresses.slice(i, i + concurrency);
    const names = await Promise.all(slice.map((address) => ownedNamesOf(address)));
    slice.forEach((address, j) => { if (names[j].length) result[address] = names[j]; });
  }
  return result;
}

/**
 * Does `address` own a name on any service KaChat reads (.kas, .k, .kaspa; .kachat on testnet)? Account discovery
 * asks this so an address whose only trace is a name is still found.
 */
export async function ownsAnyName(address, kasOwns) {
  const [kas, others] = await Promise.all([kasOwns(address).catch(() => false), ownedNamesOf(address)]);
  if (kas || others.length > 0) return true;
  return ownsKachatName(address);
}

/** .kachat where it is live (testnet): a name the address still holds - active or expired in
 *  grace, never lapsed (iOS 25cc2c9, aa36d2a). */
async function ownsKachatName(address) {
  const registry = kachatRegistry();
  const key = registry ? KachatNamesRegistry.keyOf(String(address || "").toLowerCase()) : null;
  if (!key) return false;
  try {
    await registry.refreshIfStale();
    return (await registry.heldNames(key)).length > 0;
  } catch {
    return false;
  }
}
