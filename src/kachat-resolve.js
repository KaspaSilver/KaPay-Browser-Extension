// A typed .kachat name -> the address money may follow, from one registry answer.
//
// The engine's `resolveHeldOnChain` reads the indexer twice - the address from `resolveHeld`, the
// chain check on a second `lookup` - and nothing ties the two together, so an indexer that answers
// the first with its own owner and the second with the genuine record gets its address through as
// "checked on the chain". Here the address and the check come from the same record: one lookup,
// the same rules as `resolveHeld` (registered, the name typed, not lapsed - refreshing first as
// `_resolve` does), then `confirmOnChain` on that record, whose on-chain fields commit to the
// owner returned. No DOM: tools/test-kachat-resolve.mjs runs it against a fake registry.

import { Failure, normalize, isValid } from "../shared/engine/kachat-names/codec.js";
import { Status, addressOf } from "../shared/engine/kachat-names/registry-state.js";

/** The owner of a name that is active or in its grace period, as a `kaspa(test):` address, or null
 *  (not a valid name, not registered, lapsed). From an indexer the record has to be on the chain
 *  first. Throws when the registry can't be read, the indexer answered for another name, or the
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
  await registry.confirmOnChain(info, service);
  return addressOf(info.owner);
}
