// The portfolio CSV's text cells (src/csv-text.js): a note or portfolio name that a spreadsheet
// would run as a formula is written with a leading ', and an import of the export takes exactly
// that ' off again. Run: node tools/test-csv-text.mjs
import assert from "node:assert/strict";
import { csvText, csvTextBack } from "../src/csv-text.js";

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

// what the CSV reader hands back for a quoted field: "" is one quote again
const unquote = (field) => field.replace(/""/g, '"');

check("a formula-looking start is defused", () => {
  assert.equal(csvText("=HYPERLINK(\"http://x\")"), "'=HYPERLINK(\"\"http://x\"\")");
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) assert.equal(csvText(`${lead}1+1`), `'${lead}1+1`);
});
check("ordinary text is written as it was, quotes doubled", () => {
  assert.equal(csvText("Bought on the dip"), "Bought on the dip");
  assert.equal(csvText('a "big" one'), 'a ""big"" one');
  assert.equal(csvText(" =not a formula"), " =not a formula");
  assert.equal(csvText("'quoted"), "'quoted");
  assert.equal(csvText(""), "");
  assert.equal(csvText(null), "");
});
check("text already starting with ' before a formula gets one more", () => {
  assert.equal(csvText("'=x"), "''=x");
  assert.equal(csvText("''-1"), "'''-1");
});
check("every note comes back from the export exactly", () => {
  for (const note of ["=SUM(A1:A9)", "+1 KAS", "-5 fee", "@home", "\tindented", "'=x", "''+y", "'plain", "plain", 'say "hi"', "", "multi\nline", "-"]) {
    assert.equal(csvTextBack(unquote(csvText(note))), note);
  }
});
check("the import leaves text the export didn't mark alone", () => {
  assert.equal(csvTextBack("'plain"), "'plain");
  assert.equal(csvTextBack("Long Term"), "Long Term");
  assert.equal(csvTextBack(undefined), "");
});

console.log(`${passed} passed`);
