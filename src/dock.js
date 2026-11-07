// The dock - KaPay iOS MainTabView's tab bar (AppTab.dock, iOS 64b5f53 / 723a1ee / 109721c /
// 040f91a): Portfolio | Cold Storage | Wallet | .kachat | Settings, Wallet in the middle and the
// tab the wallet opens on after unlocking (iOS 59593af). There is no "+" any more: the Wallet tab's
// floating up/down arrow opens Send and Receive (iOS 6d4bf75 / 5bab351).
// Selected items take the accent, the rest the system grey; labels are 10 pt under 26 pt
// glyphs. Each tab keeps its own place: switching back returns to the screen you left there
// (iOS keeps every tab's NavigationStack alive). Tapping the tab you are on does nothing.
//
// Screens say whether they sit in a tab (the dock shows) or are a sheet / full-screen flow
// (it hides) by name: showsDock() lists the Wallet tab's screens; any screen named "cold:...",
// "portfolio:..." or "kachat:..." belongs to those tabs, "settings" to Settings; the Contacts
// screens ("book:...") are the Wallet tab's (a card there). The tab ids stay as they were
// ("profile" is the Wallet tab).

import { esc, toast, onRender } from "./ui.js";
import { backupBannerHtml, bindBackupBanner } from "./account-backup.js";

const ICON = {
  // lock.shield
  cold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l7.5 2.8v5.9c0 4.8-3.2 8.9-7.5 10.4-4.3-1.5-7.5-5.6-7.5-10.4V5.3L12 2.5z"/><rect x="9" y="11" width="6" height="4.8" rx="1"/><path d="M10.3 11V9.6a1.7 1.7 0 0 1 3.4 0V11"/></svg>',
  // chart.pie
  portfolio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M11 3.1A9 9 0 1 0 20.9 13H11z"/><path d="M14 2.6V10h7.4A8.6 8.6 0 0 0 14 2.6z"/></svg>',
  // iOS KachatTabIcon.domainsImage (574f3c5): a name tag - its point on the left, the hole it
  // hangs by - with an "@" on it
  kachat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M1.3 12L7.3 4.2H19.6a3 3 0 0 1 3 3v9.6a3 3 0 0 1-3 3H7.3z"/><circle cx="6.2" cy="12" r="1.3"/><text x="15.1" y="12.4" fill="currentColor" stroke="none" font-size="11.5" font-weight="800" font-family="ui-rounded, \'SF Pro Rounded\', system-ui, sans-serif" text-anchor="middle" dominant-baseline="central">@</text></svg>',
  // wallet.bifold, as KaPosts draws its Wallet tab (iOS adc1110)
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h11.5A1.5 1.5 0 0 1 19 6.5V8"/><path d="M3.5 7.5v10A2.5 2.5 0 0 0 6 20h12.5a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 18.5 8H6a2.5 2.5 0 0 1-2.5-2.5"/><circle cx="16.3" cy="14" r=".6" fill="currentColor"/></svg>',
  // gearshape, as KaChat's Settings (iOS 59593af)
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

// iOS AppTab.dock: Wallet in the middle (owner's call, 2026-10-24), Settings last (2026-10-27).
const TABS = [["portfolio", "Portfolio"], ["cold", "Cold Storage"], ["profile", "Wallet"], ["kachat", ".kachat"], ["settings", "Settings"]];

const roots = {};
// Tabs showing a red dot (iOS 28d9d68: Wallet, whenever the bell has something unread).
const badges = new Set();
const last = {};
let current = "profile";
let enabled = false;
const profileScreens = new Set();

/** The Wallet tab's screens that keep the dock (the rest of its screens are sheets / flows). */
export function showsDock(...screens) { for (const s of screens) profileScreens.add(s); }

/** Each tab's first screen. */
export function registerTab(id, showRoot) { roots[id] = showRoot; }

/** Back to the screen the current tab is on (its remembered place, else its first screen) -
 *  for a flow opened over a tab, e.g. from the Wallet tab's Send and Receive. */
export function returnToTab() { (last[current] || roots[current])?.(); }

/** The dock appears once a wallet is open, and goes with it (lock, log out); it opens on Wallet
 *  (iOS AppTab.home, 59593af). */
export function enableDock(on) { enabled = on; if (!on) { for (const k of Object.keys(last)) delete last[k]; current = "profile"; } }

export function currentTab() { return current; }

/** Remember the screen now showing as this tab's place, so switching back returns to it. */
export function remember(thunk) { last[current] = thunk; }

/** Back to a tab's first screen (and forget where it was). */
export function resetTab(id) { delete last[id]; }

export function selectTab(id) {
  if (id === current || !roots[id]) return;
  current = id;
  (last[id] || roots[id])();
}

function belongsToTab(screen) {
  if (/^cold:/.test(screen)) return "cold";
  if (/^portfolio:/.test(screen)) return "portfolio";
  if (/^book:/.test(screen)) return "profile";
  if (/^kachat:/.test(screen)) return "kachat";
  if (screen === "settings") return "settings";
  if (profileScreens.has(screen)) return "profile";
  return null;
}

const dockEl = document.getElementById("dock");

/** Shows or hides a tab's red dot, at once if the dock is up. */
export function setBadge(id, on) {
  if (on === badges.has(id)) return;
  if (on) badges.add(id); else badges.delete(id);
  const item = dockEl?.querySelector(`[data-dock="${id}"]`);
  if (!item) return;
  item.querySelector(".dock-dot")?.remove();
  if (on) item.insertAdjacentHTML("beforeend", '<span class="dock-dot"></span>');
}

onRender((screen) => {
  const tab = enabled ? belongsToTab(screen) : null;
  const visible = Boolean(tab);
  if (visible) current = tab;
  document.body.classList.toggle("dock-on", visible);
  if (!dockEl) return;
  dockEl.hidden = !visible;
  if (!visible) return;
  dockEl.innerHTML = TABS.map(([id, label]) => `
    <button class="dock-item" data-dock="${id}" role="tab" aria-selected="${id === current}" aria-label="${esc(label)}">
      ${ICON[id]}<span>${esc(label)}</span>${badges.has(id) ? '<span class="dock-dot"></span>' : ""}
    </button>`).join("");
  for (const button of dockEl.querySelectorAll("[data-dock]")) button.onclick = () => selectTab(button.dataset.dock);
});

// --- the toolbar every tab's first screen shares (iOS: connection dot, the chatting wallet's
// balance in the middle) and its large title ------------------------------------------------

const status = { connection: "busy", balanceText: null, nodeUrl: "" };

export function setStatus(patch) { Object.assign(status, patch); }

/** Lock, log out, delete or an account switch: no account's balance stays in the toolbar. */
export function resetStatus() { Object.assign(status, { connection: "busy", balanceText: null, nodeUrl: "" }); }

/** Between the toolbar and the title, the backup banner while the backup is owed (KaPay iOS 953b255
 *  pinnedTabHeader): every tab shows it. */
export function tabTopHtml(title, { rightHtml = "" } = {}) {
  const cls = status.connection === "ok" ? "ok" : status.connection === "bad" ? "bad" : "busy";
  return `
    <header class="tab-toolbar">
      <button class="dot-button" id="tab-dot" aria-label="Connection"><span class="dot ${cls}"></span></button>
      <div class="toolbar-balance"><img src="icons/kaspa-logo.png" alt="" /><span>${status.balanceText != null ? esc(status.balanceText) : "--"} KAS</span></div>
      <div class="toolbar-right">${rightHtml}</div>
    </header>
    ${backupBannerHtml()}
    <h1 class="large-tab-title">${esc(title)}</h1>`;
}

export function bindTabTop() {
  const dot = document.getElementById("tab-dot");
  if (dot) dot.onclick = () => toast(status.connection === "ok" ? `Connected to ${status.nodeUrl.replace(/^wss:\/\//, "")}` : status.connection === "bad" ? "Can't reach a Kaspa node - retrying" : "Connecting to the Kaspa network…");
  // the steps come back to this tab's first screen, the banner gone once they're finished
  bindBackupBanner(() => roots[current]?.());
}
