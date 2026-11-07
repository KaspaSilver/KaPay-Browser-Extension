// KaPay's console lines (iOS AppLog.log, KaPay iOS 1652437): every Kaspa address in a line is cut to
// "…" and its last 8 characters, wherever it came from (a part passed in, an engine message, a URL,
// a storage key), so call sites need no care of their own. Objects other than errors are passed on
// as they are. No DOM: tools/test-log.mjs.

/** A full Kaspa address: `kaspa:`, `kaspatest:` (and the sim/dev prefixes), or the `_` form used in
 *  keys and file names - also right after a key's own "_" or ".", which iOS's \b misses. */
const ADDRESS = /(?<![a-z0-9])(?:kaspa|kaspatest|kaspasim|kaspadev)[:_]([a-z0-9]{12,})/gi;

/** `text` with every address in it cut to "…" and its last 8 characters. */
export function shortenAddresses(text) {
  return String(text).replace(ADDRESS, (_, payload) => `…${payload.slice(-8)}`);
}

/** One part of a log line: text shortened; an error whose words name an address as its shortened
 *  text (its stack would repeat the address); anything else as it is. */
function logPart(part) {
  if (typeof part === "string") return shortenAddresses(part);
  if (part instanceof Error) {
    const text = String(part.message || part);
    ADDRESS.lastIndex = 0;
    return ADDRESS.test(text) ? `${part.name || "Error"}: ${shortenAddresses(text)}` : part;
  }
  return part;
}

/** console.info("[KaPay]", ...parts), addresses shortened. */
export function logInfo(...parts) {
  console.info("[KaPay]", ...parts.map(logPart));
}

/** console.warn with `label` ("[KaPay] send failed:"), addresses shortened. */
export function logWarn(label, ...parts) {
  console.warn(shortenAddresses(label), ...parts.map(logPart));
}
