// A text cell of the portfolio's CSV export, safe to open in a spreadsheet: Excel, Numbers and
// Google Sheets run a cell starting with = + - @ (or a tab or carriage return) as a formula, so a
// note or portfolio name like that is written with a leading ' - the spreadsheets' own "this is
// text" mark, which they don't show. Text that already starts with ' before such a character gets
// one more, so the import can take exactly one off and every note comes back as it was. Numbers
// are never passed through here: "-1.0" stays a number. No DOM: tools/test-csv-text.mjs.

const FORMULA = /^'*[=+\-@\t\r]/;

/** `value` as the inside of a quoted CSV field: a formula-looking start defused, quotes doubled. */
export function csvText(value) {
  const text = String(value ?? "");
  return (FORMULA.test(text) ? `'${text}` : text).replace(/"/g, '""');
}

/** A text field read back from this app's own export: the ' `csvText` added taken off. */
export function csvTextBack(value) {
  const text = String(value ?? "");
  return text.startsWith("'") && FORMULA.test(text) ? text.slice(1) : text;
}
