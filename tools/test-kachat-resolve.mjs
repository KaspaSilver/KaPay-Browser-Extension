// A typed .kachat name's address comes from the same indexer answer the chain checked
// (src/kachat-resolve.js): a fake registry whose two answers differ can't slip its owner past
// `confirmOnChain`. Run: node tools/test-kachat-resolve.mjs
import assert from "node:assert/strict";
import { resolveHeldChecked, confirmLiveOnChain, answersAreCurrent } from "../src/kachat-resolve.js";
import { NameInfo, addressOf } from "../shared/engine/kachat-names/registry-state.js";
import { KachatNamesRegistry } from "../shared/engine/kachat-names/registry.js";
import { key as nameKey } from "../shared/engine/kachat-names/codec.js";

let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log(`ok - ${name}`); }

const genuine = new Uint8Array(32).fill(0x11);
const attacker = new Uint8Array(32).fill(0x66);
const now = 1_800_000_000_000n;
const graceMs = 30n * 86_400_000n;
const day = 86_400_000n;

function record(name, owner, expiresAt = now + 365n * day) {
  return new NameInfo({ name, key: nameKey(name), owner, expiresAt, periodStart: now - day, outpoint: { txid: new Uint8Array(32), index: 0 } });
}

// An indexer that answers each lookup from `answers` in turn; the chain holds only `onChain`'s owner.
function fakeRegistry(answers, { onChain = genuine } = {}) {
  const calls = [];
  return {
    calls,
    source: { kind: "indexer" },
    graceMs,
    _nowMs: () => now,
    async refreshIfStale() { calls.push("refresh"); },
    async lookup(name) {
      calls.push("lookup");
      const info = answers[Math.min(calls.filter((c) => c === "lookup").length - 1, answers.length - 1)];
      return info ? { kind: "registered", name, info } : { kind: "free", name, gap: null };
    },
    async confirmOnChain(n) {
      calls.push("confirm");
      if (!n.owner.every((b, i) => b === onChain[i])) throw new Error("no such record on the chain");
    },
  };
}

await check("the engine's two reads are what this replaces", async () => {
  const reg = fakeRegistry([record("alice", attacker), record("alice", genuine)]);
  reg.resolveHeld = KachatNamesRegistry.prototype.resolveHeld;
  reg._resolve = KachatNamesRegistry.prototype._resolve;
  let got = null;
  try { got = await KachatNamesRegistry.prototype.resolveHeldOnChain.call(reg, "alice", {}); } catch { /* fixed */ }
  if (got === addressOf(attacker)) console.log("  note: shared resolveHeldOnChain still returns the first answer's owner");
  else console.log("  note: shared resolveHeldOnChain no longer trusts the first answer - src may go back to it");
});
await check("an indexer that lies first and tells the truth second fails the lookup", async () => {
  const reg = fakeRegistry([record("alice", attacker), record("alice", genuine)]);
  await assert.rejects(resolveHeldChecked(reg, "alice", {}), /chain/);
  assert.deepEqual(reg.calls, ["refresh", "lookup", "confirm"]);
});
await check("the address is the owner of the record the chain backed", async () => {
  const reg = fakeRegistry([record("alice", genuine), record("alice", attacker)]);
  assert.equal(await resolveHeldChecked(reg, "Alice.kachat", {}), addressOf(genuine));
  assert.deepEqual(reg.calls, ["refresh", "lookup", "confirm"]);
});
await check("an answer for another name fails the lookup", async () => {
  const reg = fakeRegistry([record("bob", genuine)]);
  await assert.rejects(resolveHeldChecked(reg, "alice", {}), /another name/);
  assert.ok(!reg.calls.includes("confirm"));
});
await check("a name in grace still resolves; a lapsed one doesn't", async () => {
  const inGrace = fakeRegistry([record("alice", genuine, now - day)]);
  assert.equal(await resolveHeldChecked(inGrace, "alice", {}), addressOf(genuine));
  const lapsed = fakeRegistry([record("alice", genuine, now - graceMs - day)]);
  assert.equal(await resolveHeldChecked(lapsed, "alice", {}), null);
  assert.ok(!lapsed.calls.includes("confirm"));
});
await check("a free or invalid name is null, without asking the chain", async () => {
  const free = fakeRegistry([null]);
  assert.equal(await resolveHeldChecked(free, "alice", {}), null);
  assert.deepEqual(free.calls, ["refresh", "lookup"]);
  const invalid = fakeRegistry([record("alice", genuine)]);
  assert.equal(await resolveHeldChecked(invalid, "not a name!", {}), null);
  assert.deepEqual(invalid.calls, []);
});
await check("a registry that can't be read throws", async () => {
  const reg = fakeRegistry([]);
  reg.lookup = async () => { throw new Error("indexer down"); };
  await assert.rejects(resolveHeldChecked(reg, "alice", {}), /indexer down/);
});

// KaPay iOS 2da5f4b: a chain copy can be hours old, so its answer is checked live too.
const chainCopy = (tracked) => ({ source: { kind: "chain" }, chainState: { name: () => tracked }, confirmOnChain() { throw new Error("the engine's check skips a chain copy"); } });
const liveService = (seen, { live = true } = {}) => ({
  loadManifest: async () => ({ name: "template" }),
  liveRegistryUtxo: async (args) => { seen.push(args); if (!live) throw new Error("not on chain"); return { entry: {} }; },
});
await check("a record read from the chain copy is checked live on the chain, at its own script and outpoint", async () => {
  const seen = [];
  const info = record("alice", genuine);
  await confirmLiveOnChain(chainCopy({ name: "alice" }), info, liveService(seen), { scriptOf: (m, n) => `${m.name}:${n.name}` });
  assert.deepEqual(seen, [{ script: "template:alice", outpoint: info.outpoint }]);
});
await check("a name the chain copy says is held but the chain has moved on fails the lookup", async () => {
  await assert.rejects(confirmLiveOnChain(chainCopy({ name: "alice" }), record("alice", genuine), liveService([], { live: false }), { scriptOf: () => "s" }), /not on chain/);
  await assert.rejects(confirmLiveOnChain(chainCopy(null), record("alice", genuine), liveService([]), { scriptOf: () => "s" }), /not loaded/);
});
await check("an indexer's record still goes through the engine's check", async () => {
  const reg = fakeRegistry([]);
  await confirmLiveOnChain(reg, record("alice", genuine), {});
  assert.deepEqual(reg.calls, ["confirm"]);
});
const walked = (over = {}) => ({ source: { kind: "chain" }, lastError: null, refreshedAt: 1_000_000, lastWalk: { rounds: 3, unresolved: [] }, ...over });
await check("an indexer's answer is current; a chain copy's only just after a walk that reached the live UTXOs", () => {
  assert.equal(answersAreCurrent({ source: { kind: "indexer" } }), true);
  assert.equal(answersAreCurrent(walked(), 1_000_000 + 119_999), true);
  assert.equal(answersAreCurrent(walked(), 1_000_000 + 120_000), false);
  assert.equal(answersAreCurrent(walked({ lastError: "the node went away" }), 1_000_000), false);
  assert.equal(answersAreCurrent(walked({ lastWalk: { rounds: 3, unresolved: ["a:0"] } }), 1_000_000), false);
  assert.equal(answersAreCurrent(walked({ lastWalk: { rounds: 64, unresolved: [] } }), 1_000_000), false);
  assert.equal(answersAreCurrent(walked({ lastWalk: null }), 1_000_000), false);
  assert.equal(answersAreCurrent({ source: null }), false);
});

console.log(`${passed} passed`);
