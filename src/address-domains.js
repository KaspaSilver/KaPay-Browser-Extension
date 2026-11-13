// An address's Domains tab (iOS fe52376 / 0b68567): on the chatting address, a spending address
// and a KasSigner address, cards for .kachat, .k, .kaspa and .kas, each with how many names this
// address holds there (a warning when that service couldn't be reached), looked up at once for this
// address only. A card opens the names: .kachat its cards and detail screens as before, the others
// a list. Your Domains' own lists are left alone.

import { esc, ICONS } from "./ui.js";
import * as wallet from "./wallet.js";
import { ownedNamesByService } from "./names.js";
import { addressNamesTab, showLiveNameDetail } from "./kachat-live.js";
import { kachatRegistry } from "./kachat-names.js";
import { KachatNamesRegistry } from "../shared/engine/kachat-names/registry.js";

const SERVICES = [["kachat", ".kachat"], ["k", ".k"], ["kaspa", ".kaspa"], ["kas", ".kas"]];
const cache = new Map(); // address -> { lists: { tld: names[] | null }, loading, open, loadedAt }
// Counts older than this are looked up again the next time the tab is shown (audit 2026-11-13).
const FRESH_MS = 2 * 60_000;
// Set once a domain has left this wallet: lookups skip the KNS answer cached before it moved.
let knsChanged = false;

/** A domain was sent or transferred: every address's counts are looked up again. */
export function forgetAddressDomains() {
  cache.clear();
  knsChanged = true;
}

const GLOBE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.8 3.9 6 3.9 9.5S14.6 18.7 12 21.5M12 2.5C9.4 5.3 8.1 8.5 8.1 12s1.3 6.7 3.9 9.5"/></svg>';

function load(address, entry, repaint) {
  if (entry.loading) return;
  entry.loading = true;
  const key = String(address).toLowerCase();
  const kachat = (async () => {
    const reg = kachatRegistry();
    const owner = reg ? KachatNamesRegistry.keyOf(key) : null;
    if (!owner) return [];
    try {
      if (reg.refreshedAt == null) await reg.refresh();
      return (await reg.heldNames(owner)).map((n) => n.display);
    } catch { return null; }
  })();
  const kas = wallet.domains(address, { force: knsChanged }).then((d) => (d.domains || []).map((x) => x.fullName || x.name).filter(Boolean)).catch(() => null);
  const others = ownedNamesByService(address).catch(() => ({ k: null, kaspa: null }));
  Promise.all([kachat, kas, others]).then(([kachatNames, kasNames, o]) => {
    entry.lists = {
      kachat: kachatNames,
      kas: kasNames,
      k: o.k == null ? null : o.k.map((n) => n.display || n.name),
      kaspa: o.kaspa == null ? null : o.kaspa.map((n) => n.display || n.name),
    };
    entry.loading = false;
    entry.loadedAt = Date.now();
    // a forget meanwhile: this answer is from before it, and isn't kept
    if (cache.get(address) === entry) repaint();
  });
}

/** The tab's body for `address`: `{ html, bind(container, back) }`, loading on its own. */
export function addressDomainsTab({ address, repaint }) {
  const entry = cache.get(address) || { lists: null, loading: false, open: null };
  cache.set(address, entry);
  if (!entry.lists || (!entry.loading && Date.now() - (entry.loadedAt || 0) > FRESH_MS)) load(address, entry, repaint);
  let kachatTab = null;

  let html;
  if (entry.open === "kachat") {
    kachatTab = addressNamesTab({ address, repaint });
    html = `<button class="bar-text accent domains-back" data-domains-back>${ICONS.back}<span>Domains</span></button>${kachatTab.html}`;
  } else if (entry.open) {
    const label = SERVICES.find(([tld]) => tld === entry.open)[1];
    const names = entry.lists?.[entry.open] || [];
    html = `
      <button class="bar-text accent domains-back" data-domains-back>${ICONS.back}<span>Domains</span></button>
      ${names.length
        ? names.map((n) => `<div class="domain-card small-card"><span class="domain-name">${esc(n)}</span></div>`).join("")
        : `<p class="muted small center-text">No ${esc(label)} names on this address.</p>`}`;
  } else {
    html = `<div class="domains-grid">${SERVICES.map(([tld, label]) => {
      const list = entry.lists ? entry.lists[tld] : undefined;
      const count = list === undefined ? '<span class="spinner small-spin"></span>'
        : list === null ? `<span class="kl-orange tiny">${ICONS.warning || "!"} Couldn't check</span>`
          : `<span class="domains-count">${list.length}</span>`;
      return `<button class="glass domains-service" data-domains-open="${tld}">
        <span class="accent">${GLOBE}</span>
        <span class="strong">${esc(label)}</span>
        ${count}
      </button>`;
    }).join("")}</div>`;
  }

  return {
    html,
    bind(container, back) {
      for (const b of container.querySelectorAll("[data-domains-open]")) b.onclick = () => { entry.open = b.dataset.domainsOpen; repaint(); };
      const backBtn = container.querySelector("[data-domains-back]");
      if (backBtn) backBtn.onclick = () => { entry.open = null; repaint(); };
      kachatTab?.bind(container, { openName: (info) => showLiveNameDetail({ info, onBack: back }) });
    },
  };
}
