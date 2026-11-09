// A typed .kachat name -> the address money may follow, from one registry answer.
//
// The engine's `resolveHeldOnChain` reads the indexer twice - the address from `resolveHeld`, the
// chain check on a second `lookup` - and nothing ties the two together, so an indexer that answers
// the first with its own owner and the second with the genuine record gets its address through as
// "checked on the chain". Here the address and the check come from the same record: one lookup,
// the same rules as `resolveHeld` (registered, the name typed, not lapsed - refreshing first as
// `_resolve` does), then `confirmOnChain` on that record, whose on-chain fields commit to the
// owner returned. A record read from the chain copy is checked the same way (KaPay iOS 2da5f4b): a
// copy can be hours old, and every send checks the name's record live on chain. No DOM:
// tools/test-kachat-resolve.mjs runs it against a fake registry.

import { Failure, normalize, isValid, nameState } from "../shared/engine/kachat-names/codec.js";
import { Status, addressOf, RegistryState } from "../shared/engine/kachat-names/registry-state.js";
import { templateScript } from "../shared/engine/kachat-names/manifest.js";

const nameRecordScript = (manifest, tracked) => templateScript(manifest.name, nameState(RegistryState.nameFields(tracked)));

/** The record `info` describes, unspent on the chain right now, whichever source answered. The
 *  engine's `confirmOnChain` only checks an indexer's (its chain-copy NameInfo carries no fields, so
 *  they're rebuilt here from the tracked name). Throws when it isn't there. */
export async function confirmLiveOnChain(registry, info, service, { scriptOf = nameRecordScript } = {}) {
  if (registry.source?.kind === "indexer") return registry.confirmOnChain(info, service);
  const tracked = registry.chainState?.name?.(info.name);
  if (!tracked) throw new Failure("the registry is not loaded");
  const manifest = await service.loadManifest();
  return service.liveRegistryUtxo({ script: scriptOf(manifest, tracked), outpoint: info.outpoint });
}

// How long a walk that reached the live UTXOs counts as the chain as it stands (iOS answersAreCurrent).
const CHAIN_COPY_CURRENT_MS = 120_000;
// The engine's walk gives up after this many rounds (registry-state.js walk), with more to do.
const WALK_MAX_ROUNDS = 64;

/** Whether a registry answer right now reflects the chain as it stands (iOS answersAreCurrent, KaPay
 *  iOS 2da5f4b): an indexer's does (it was checked to be keeping up), the chain copy's only just
 *  after a walk that reached the live UTXOs. Anything that spends or withdraws on a registry answer
 *  asks this first: a copy minutes old can say a name is free that has since been taken. */
export function answersAreCurrent(registry, nowMs = Date.now()) {
  if (registry?.source?.kind === "indexer") return true;
  if (registry?.source?.kind !== "chain" || registry.lastError != null || registry.refreshedAt == null) return false;
  if (nowMs - Number(registry.refreshedAt) >= CHAIN_COPY_CURRENT_MS) return false;
  const walk = registry.lastWalk;
  return Boolean(walk) && !walk.unresolved?.length && walk.rounds < WALK_MAX_ROUNDS;
}

/** The owner of a name that is active or in its grace period, as a `kaspa(test):` address, or null
 *  (not a valid name, not registered, lapsed). The record has to be live on the chain first. Throws when the registry can't be read, the indexer answered for another name, or the
 *  chain doesn't hold its record (the caller shows the lookup as failed). */
export async function resolveHeldChecked(registry, raw, service) {
  const canonical = normalize(raw);
  if (!isValid(canonical)) return null;
  await registry.refreshIfStale();
  const found = await registry.lookup(canonical);
  if (found?.kind !== "registered") return null;
  const info = found.info;
  if (info?.name !== canonical) throw new Failure("the indexer answered for another name");
  if (info.status(registry.graceMs, registry._nowMs()) === Status.lapsed) return null;
  await confirmLiveOnChain(registry, info, service);
  return addressOf(info.owner);
}
