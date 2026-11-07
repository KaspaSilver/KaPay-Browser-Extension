// KaPay's console lines (src/log.js, KaPay iOS 1652437 AppLog): every Kaspa address in a line is cut to
// "…" and its last 8 characters, whichever prefix or spelling it has. No DOM, no network.
// Run: node tools/test-log.mjs
import assert from "node:assert/strict";
import { shortenAddresses, logInfo, logWarn } from "../src/log.js";

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

const MAIN = "kaspa:qpamkvhgh0kzx50gwvvp5xs8ktmqutcy3dfs9dc3w7lm9rq0zs76vf959mmrp";
const TEST = "kaspatest:qq0nvlmn07f6edcdfynt4nu4l4r58rkquuvgt635ac";

check("an address is cut to … and its last 8 characters", () => {
  assert.equal(shortenAddresses(`Creating transaction from ${MAIN} to ${TEST}`), `Creating transaction from …${MAIN.slice(-8)} to …${TEST.slice(-8)}`);
  assert.equal(shortenAddresses(MAIN), `…${MAIN.slice(-8)}`);
});
check("in a URL, a storage key (after its own _ too) and any case", () => {
  assert.equal(shortenAddresses(`https://api.kaspa.org/addresses/${MAIN}/balance`), `https://api.kaspa.org/addresses/…${MAIN.slice(-8)}/balance`);
  assert.equal(shortenAddresses(`kachat_spending_${MAIN.replace(":", "_")}`), `kachat_spending_…${MAIN.slice(-8)}`);
  assert.equal(shortenAddresses(`kachat.utxoLabels.${MAIN}`), `kachat.utxoLabels.…${MAIN.slice(-8)}`);
  assert.equal(shortenAddresses(MAIN.toUpperCase()), `…${MAIN.toUpperCase().slice(-8)}`);
});
check("text without an address, a txid or a short prefix stays as it was", () => {
  for (const text of ["Broadcast txid: " + "ab".repeat(32), "kaspa:", "kaspa:abc", "Max send (3 inputs)", "mykaspa:qpamkvhgh0kzx50gwvvp5xs8"]) assert.equal(shortenAddresses(text), text);
});
check("the console helpers pass shortened text and errors, other objects as they are", () => {
  const seen = [];
  const original = { info: console.info, warn: console.warn };
  console.info = (...parts) => seen.push(parts);
  console.warn = (...parts) => seen.push(parts);
  try {
    const plain = new Error("timed out");
    const detail = { address: MAIN };
    logInfo(`from ${MAIN}`, 3, detail, plain);
    logWarn(`[KaPay] send failed for ${TEST}:`, new Error(`No UTXOs at ${MAIN}`));
    assert.deepEqual(seen[0], ["[KaPay]", `from …${MAIN.slice(-8)}`, 3, detail, plain]);
    assert.deepEqual(seen[1], [`[KaPay] send failed for …${TEST.slice(-8)}:`, `Error: No UTXOs at …${MAIN.slice(-8)}`]);
  } finally {
    Object.assign(console, original);
  }
});

console.log(`${passed} passed`);
