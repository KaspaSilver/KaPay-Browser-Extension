// The one .kachat names runtime of the wallet (iOS KachatNamesService.shared /
// KachatNamesRegistry.shared / KachatNamesActions.shared, KaChat-Desktop ui/kachat-names-runtime.js):
// a single service, registry and actions instance, so the .kachat screens, name resolution, Your
// Domains and the profile hero all read the same registry and see the same registrations in flight.
//
// The .kachat UI is on for every network (iOS 7227d69: mainnet shows the same screens, empty,
// under "Coming soon"); the registry is live only where it is launched - testnet-10 for now. On
// mainnet the runtime answers null, so nothing reads or writes a registry there.
//
// The registry needs no key: it reads the chain walker (or a names indexer) and is shared by name
// lookups. Actions sign with the active account's chatting address - the signer is bound when a
// .kachat screen or the home screen asks for the runtime, and forgotten on lock or account switch.

import { getEndpoint } from "../shared/engine/endpoints.js";
import { KachatNamesService } from "../shared/engine/kachat-names/service.js";
import { KachatNamesRegistry } from "../shared/engine/kachat-names/registry.js";
import { KachatNamesActions } from "../shared/engine/kachat-names/actions.js";
import { unhex32 } from "../shared/engine/kachat-names/codec.js";
import { KachatSocialImageResolver } from "../shared/engine/kachat-names/social-image-resolver.js";
import { chattingSigner, namesNodeMethods, cachedAddresses, privateKeyHex, knownUsedAddresses, addressUsed } from "./wallet.js";
import { ext } from "./browser.js";
import { readAccounts } from "./vault.js";

const localStorageAdapter = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage full: the next refresh re-walks */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* nothing to drop */ } },
};

/** The .kachat UI and identity: every network (iOS KachatNamesService.isEnabled). */
export const kachatUi = true;
/** Whether this network has a live registry the wallet reads and transacts with (iOS isLaunched):
 *  both networks since mainnet v1 (registry 348bd2c8, iOS ef6b21e). */
export const kachatLaunched = KachatNamesService.isLaunched;
/** The registry is live here - the same as `kachatLaunched`. */
export const kachatLive = kachatLaunched;


// The engine object the service and actions hold: the node methods, plus the signer once bound.
// Made on first use (names.js -> here -> wallet.js -> names.js is an import cycle).
let engine = null;
let service = null;
let registry = null;
let actions = null;
let boundAddress = null;

// The wallet's other addresses for the actions (iOS 881ada6): a name on a spending address is
// acted on with that address's key, one on a KasSigner address is shown read-only. Filled when the
// signer is bound; spending keys are derived only for the action that needs one (prepareSigner).
const walletState = { spending: [], kasSigner: [], keys: new Map(), used: new Set() };
const walletHooks = {
  spendingAddresses: () => walletState.spending,
  spendingPrivateKey: (index) => walletState.keys.get(index) ?? null,
  kasSignerAddresses: () => walletState.kasSigner,
  // A wallet's names are on all its addresses (iOS d1026de, IOS-085): the .kachat lists look up
  // every spending address that was ever used. "Used" is for good, so the remembered answer
  // counts; an unknown one is probed once (and remembered when used).
  spendingMaxIndex: () => walletState.spending.reduce((max, e) => Math.max(max, e.index), -1),
  cachedSpendingAddressUsed: (address) => (walletState.used.has(address) ? true : null),
  spendingAddressUsed: async (address) => {
    const used = await addressUsed(address);
    if (used === true) walletState.used.add(address);
    return used;
  },
};

async function loadWalletAddresses() {
  try {
    const view = await readAccounts();
    const cached = await cachedAddresses(view?.activeAccountId);
    walletState.spending = Object.entries(cached?.spending || {}).map(([index, address]) => ({ index: Number(index), address }));
  } catch { walletState.spending = []; }
  try { walletState.used = new Set(await knownUsedAddresses()); } catch { walletState.used = new Set(); }
  try {
    const { coldWatchAddresses } = await import("./cold.js");
    walletState.kasSigner = await coldWatchAddresses();
  } catch { walletState.kasSigner = []; }
}

/** A spending address's key, ready for the engine's synchronous `spendingPrivateKey` hook. */
async function loadSpendingKey(index) {
  if (Number.isInteger(index) && !walletState.keys.has(index)) {
    walletState.keys.set(index, await privateKeyHex({ kind: "spending", index }));
  }
}

async function preloadClaimOwners() {
  for (const p of actions?.pending ?? []) {
    try {
      const own = actions.ownAddress(unhex32(String(p.owner)));
      if (own?.kind === "spending") await loadSpendingKey(own.index);
    } catch { /* not this wallet's: the driver leaves it */ }
  }
}

/** Makes ready the keys of this wallet's spending addresses that made `offers` (OfferInfo[]):
 *  withdrawing or returning one signs with the address it was made from, through the engine's
 *  synchronous key hook (iOS d1026de - an offer on any address of the wallet is the wallet's). */
export async function prepareOfferSigners(offers) {
  for (const o of offers ?? []) {
    try {
      const own = actions?.ownAddress(o.buyer);
      if (own?.kind === "spending") await loadSpendingKey(own.index);
    } catch { /* not this wallet's */ }
  }
}

/** Derives the spending key an action signs with when a spending address holds the name. */
export async function prepareSigner(op) {
  const payer = actions?.payerFor(op);
  if (payer?.kind === "spending" && !walletState.keys.has(payer.index)) {
    walletState.keys.set(payer.index, await privateKeyHex({ kind: "spending", index: payer.index }));
  }
}

// One service, registry and actions on every network. Where the registry isn't launched (mainnet)
// it is inert - `isEnabled` false: reads refuse before any request, refreshes do nothing - and only
// the profile side runs (iOS d36fc42): your own saved record, else GET /profiles/{address} on the
// chat indexer, and saving the kchat:1:profile: record.
function base() {
  if (!service) {
    engine = { ...namesNodeMethods(), kaspa: null, rpc: null, address: null, privateKey: null, privateKeyHex: null };
    service = new KachatNamesService(engine);
    registry = new KachatNamesRegistry({
      manifest: () => service.loadManifest(),
      isEnabled: () => KachatNamesService.isLaunched,
      getUtxosByAddresses: (addresses) => engine.utxosForRegistry(addresses),
      restBase: () => getEndpoint("kaspaApi"),
      indexerBase: () => getEndpoint("kachatNamesIndexer"),
      // the names indexer is only used while it is at most about a minute behind the network;
      // otherwise the registry walks the chain itself (iOS 7aa6c6d)
      virtualDaaScore: () => engine.currentVirtualDaaScore(),
      storage: localStorageAdapter,
      log: (...parts) => console.info("[KaPay]", ...parts),
    });
    actions = new KachatNamesActions({ engine, service, registry, storage: localStorageAdapter, wallet: walletHooks });
  }
  return { service, registry, actions, engine };
}

/** The shared registry (no key needed) where it is launched, else null. */
export function kachatRegistry() {
  return kachatLaunched ? base().registry : null;
}

/** The shared service (no key needed) where the registry is launched, else null: what
 *  `confirmOnChain` reads the chain with (kachat-resolve.js, KaPay 953b255). */
export function kachatService() {
  return kachatLaunched ? base().service : null;
}

/**
 * The runtime with the active account's chatting address bound as the signer:
 * `{ service, registry, actions, engine }`, or null where the registry isn't launched (mainnet).
 * The wallet must be unlocked.
 */
export async function kachatNames() {
  if (!kachatLaunched) return null;
  return bind();
}

/**
 * The same runtime on every network, for address profiles (iOS d36fc42): `actions.profileFee`,
 * `actions.saveProfile`, `registry.ownProfile`, `registry.identity` (profile-only on mainnet).
 */
export async function kachatProfiles() {
  return bind();
}

async function bind() {
  const runtime = base();
  const signer = await chattingSigner();
  const address = signer.address.toLowerCase();
  engine.kaspa = signer.kaspa;
  engine.address = address;
  engine.privateKey = signer.privateKeyHex;
  engine.privateKeyHex = signer.privateKeyHex;
  if (boundAddress !== address) {
    boundAddress = address;
    walletState.keys.clear();
    if (kachatLaunched) await loadWalletAddresses();
    // A claim keeps signing with the address it started from (iOS eb9b027 ownerSigner): the
    // spending keys of claims in progress are ready before the driver resumes them.
    if (kachatLaunched) await preloadClaimOwners();
    // Another account: its own registrations in flight (the driver keys them by wallet address).
    actions.resume();
  }
  return runtime;
}

/** Drops the bound key (wallet locked, account removed). The registry and its cache stay. */
export function forgetKachatSigner() {
  walletState.keys.clear();
  walletState.spending = [];
  walletState.kasSigner = [];
  if (!engine) return;
  engine.address = null;
  engine.privateKey = null;
  engine.privateKeyHex = null;
  boundAddress = null;
}

/** An address's .kachat label (primary name while active, else its oldest active name), or null. */
export async function kachatLabelOf(address) {
  const reg = kachatRegistry();
  if (!reg || !address) return null;
  try {
    await reg.refreshIfStale({ maxAge: 300 });
    return (await reg.identity(address))?.label || null;
  } catch {
    return null;
  }
}

// --- Social profiles (iOS KachatSocialImageResolver) ---------------------------------------
//
// A KaChat profile's avatar, banner and bio come from social profile links, looked up on this
// device (shared/engine/kachat-names/social-image-resolver.js). Those reads use their own optional
// host permissions, asked once when you allow profile pictures (audit EXT-004) - never the
// website-connect content scripts' access. Until you allow them nothing is fetched from those
// sites. An extension can't pick a User-Agent, so the resolver's "crawler" hint is not honored:
// pages answer as they do to a browser (Facebook's profile pictures may not show).

/** Every site a profile lookup reads (pictures themselves load as plain images). */
export const SOCIAL_ORIGINS = [
  "https://x.com/*", "https://api.fxtwitter.com/*", "https://www.youtube.com/*", "https://discord.com/*",
  "https://api.github.com/*", "https://t.me/*", "https://www.twitch.tv/*",
  "https://www.instagram.com/*", "https://www.tiktok.com/*", "https://www.facebook.com/*", "https://www.linkedin.com/*",
];

/** Whether you allowed profile lookups on the social sites. */
export async function socialLookupsAllowed() {
  try { return await ext.permissions.contains({ origins: SOCIAL_ORIGINS }); } catch { return false; }
}

/** Asks the browser for the social sites (call from a click). Resolves whether they were granted. */
export async function allowSocialLookups() {
  try { return await ext.permissions.request({ origins: SOCIAL_ORIGINS }); } catch { return false; }
}

async function fetchText(url, { accept, timeoutMs = 8000, maxBytes = 3_000_000, signal } = {}) {
  // Only with the permission you granted for profile lookups (audit EXT-004).
  if (!(await socialLookupsAllowed())) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort);
  try {
    const response = await fetch(url, {
      headers: accept ? { Accept: accept } : {},
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: controller.signal,
    });
    let text = await response.text();
    if (text.length > maxBytes) text = text.slice(0, maxBytes);
    return { status: response.status, contentType: response.headers.get("content-type") || "", text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

let socialResolver = null;

/** The one resolver of the wallet (its 24 h answers are kept in localStorage). */
export function kachatSocial() {
  if (!socialResolver) {
    socialResolver = new KachatSocialImageResolver({ fetchText, storage: localStorageAdapter });
  }
  return socialResolver;
}

/** This wallet's own profile record (the one it last wrote, else the registry's), or null. */
export async function ownKachatProfile(address) {
  const reg = base().registry;
  if (!address) return null;
  // This wallet's own profile follows the chain (iOS 5d4ce87): a profile saved on another device
  // (KaChat for iOS, Android, Desktop) is adopted when it's newer, so an imported wallet shows it
  // and the editor starts from it instead of overwriting it.
  try { await reg.syncOwnProfile?.(address, { maxAgeMs: 5 * 60_000 }); } catch { /* the device copy stays */ }
  try {
    const own = (await reg.ownProfile(address))?.profile;
    if (own) return own;
    return (await reg.identity(address))?.profile ?? null;
  } catch {
    return null;
  }
}
