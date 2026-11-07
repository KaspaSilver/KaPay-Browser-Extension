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

// --- Which rows an import replaces (iOS PortfolioViewModel.importCsv, KaPay iOS 1652437) -----------
//
// A row in the file replaces a row the portfolio already had at that time - on the second, since the
// export writes whole seconds and rows from an address import or Add to Portfolio carry
// milliseconds. Only rows from before this import, each at most once: two rows of the same second
// in the file are two transactions.

/** -> take(portfolioId, timestamp): the index in `transactions` (the rows before the import) of the
 *  row a file row at `timestamp` (ms) replaces, or -1; each row is handed out once. */
export function csvRowMatcher(transactions) {
  const bySecond = new Map(); // "portfolioId|second" -> indexes still to hand out
  (Array.isArray(transactions) ? transactions : []).forEach((tx, index) => {
    const key = `${tx?.portfolioId}|${Math.floor(Number(tx?.timestamp) / 1000)}`;
    if (!bySecond.has(key)) bySecond.set(key, []);
    bySecond.get(key).push(index);
  });
  return (portfolioId, timestamp) => {
    const waiting = bySecond.get(`${portfolioId}|${Math.floor(Number(timestamp) / 1000)}`);
    return waiting?.length ? waiting.shift() : -1;
  };
}
