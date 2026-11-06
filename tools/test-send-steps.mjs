// The step-by-step send's keypad (src/keypad.js, KaPay iOS 05db583 KaspaKeypad.applying; the same
// checks as KaChat-Desktop tools/test-send-steps.mjs) and the swipe-up screen's rules
// (src/swipe-up.js, KaPay 953b255). Run: node tools/test-send-steps.mjs
import assert from "node:assert/strict";
import { applyKeypadKey, keypadKeyForKeyboard, keypadFontSize, keypadDisplayText } from "../src/keypad.js";
import { swipeUpThreshold, swipeUpEnding } from "../src/swipe-up.js";
import { SEND_OUTCOME_UNKNOWN_MESSAGE, sendOutcomeUnknownError } from "../shared/engine/transactions.js";

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

check("digits append; a leading zero gives way", () => {
  assert.equal(applyKeypadKey("5", ""), "5");
  assert.equal(applyKeypadKey("5", "0"), "5");
  assert.equal(applyKeypadKey("0", "12"), "120");
});
check("the point writes 0. on an empty amount, once only", () => {
  assert.equal(applyKeypadKey("decimal", ""), "0.");
  assert.equal(applyKeypadKey("decimal", "3"), "3.");
  assert.equal(applyKeypadKey("decimal", "3.1"), "3.1");
  assert.equal(applyKeypadKey("decimal", "3", 0), "3");
});
check("at most maxDecimals decimals and 11 whole digits", () => {
  assert.equal(applyKeypadKey("9", "1.12345678", 8), "1.12345678");
  assert.equal(applyKeypadKey("9", "1.12", 2), "1.12");
  assert.equal(applyKeypadKey("9", "1.1", 2), "1.19");
  assert.equal(applyKeypadKey("7", "12345678901"), "12345678901");
});
check("delete drops one character, clear empties", () => {
  assert.equal(applyKeypadKey("delete", "12.5"), "12.");
  assert.equal(applyKeypadKey("delete", ""), "");
  assert.equal(applyKeypadKey("clear", "12.5"), "");
});
check("an unknown key changes nothing", () => {
  assert.equal(applyKeypadKey("x", "12"), "12");
});
check("a keyboard's digits, point and Backspace map to keys", () => {
  assert.equal(keypadKeyForKeyboard({ key: "7" }), "7");
  assert.equal(keypadKeyForKeyboard({ key: "." }), "decimal");
  assert.equal(keypadKeyForKeyboard({ key: "," }), "decimal");
  assert.equal(keypadKeyForKeyboard({ key: "Backspace" }), "delete");
  assert.equal(keypadKeyForKeyboard({ key: "Delete" }), "clear");
  assert.equal(keypadKeyForKeyboard({ key: "v", metaKey: true }), null);
  assert.equal(keypadKeyForKeyboard({ key: "1", ctrlKey: true }), null);
  assert.equal(keypadKeyForKeyboard({ key: "a" }), null);
});
check("the typed amount shrinks as it grows (popup 52 / 40 / 30)", () => {
  assert.equal(keypadFontSize("1,234"), 52);
  assert.equal(keypadFontSize("1,234,567"), 40);
  assert.equal(keypadFontSize("12,345,678.9"), 30);
});
check("the amount shows 0 while empty, grouped once typed", () => {
  assert.equal(keypadDisplayText(""), "0");
  assert.match(keypadDisplayText("1234567.5"), /^1.234.567.5$/);
});

// The swipe-up screen (src/swipe-up.js, KaPay 953b255).
check("letting go sends at about 30% of the screen, never under 120", () => {
  assert.equal(swipeUpThreshold(600), 180);
  assert.equal(swipeUpThreshold(300), 120);
  assert.equal(swipeUpThreshold(0), 120);
});
check("a send the network never confirmed is Not confirmed, with only Done", () => {
  assert.deepEqual(swipeUpEnding({ failure: SEND_OUTCOME_UNKNOWN_MESSAGE }), { kind: "unknown", title: "Not confirmed", final: "done" });
  assert.equal(sendOutcomeUnknownError("ab").message, SEND_OUTCOME_UNKNOWN_MESSAGE);
});
check("any other failure is Failed with Try Again; a finished one is Done", () => {
  assert.deepEqual(swipeUpEnding({ failure: "The send didn't go out." }), { kind: "failed", title: "Failed", final: "retry" });
  assert.deepEqual(swipeUpEnding({ done: true, doneTitle: "Name Bought" }), { kind: "done", title: "Name Bought", final: "done" });
  assert.deepEqual(swipeUpEnding({}), { kind: null, title: null, final: null });
});

console.log(`\n${passed} passed`);
