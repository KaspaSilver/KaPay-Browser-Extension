// .kachat - the marketplace for KaChat's own names, a 1:1 port of iOS KachatMarketView,
// KachatListingDetailView, KachatBuySheet and KachatOfferSheet (Kaspa Hub > .kachat on iOS; here
// the .kachat row under Your Domains).
//
// The tab is the logo and four numbered cards - Marketplace, Available, Expired, Activity - each
// opening its page; only the Marketplace has the name search (KaPay 99ab88a). A card's number is
// how many live on its page, "-" until the registry has answered.
//
// On mainnet it is UI only, as on iOS: search answers "Registration isn't open yet", listings,
// offers and activity are placeholder skeletons, and every final action is disabled. No invented
// names or prices anywhere - the skeletons are redacted shapes (iOS .redacted(reason:
// .placeholder)), so nothing here can be mistaken for a real listing.
//
// On TESTNET (testnet-10, with the bundled registry manifest verified) it is live
// (kachat-live.js, iOS KachatNamesLiveViews.swift): search shows real availability (Available or
// Taken; no price per year, KaPay 05db583), Claim registers in steps - how long, then the costs and
// swipe up, which follows the claim (KaPay 5bab351) - and the pages -
// Marketplace, Available, Expired, Activity (iOS 0765ce0, eea52b2, cb3c27d) - read the registry. Your
// own names and the offers you made live in Your Domains.

import { app, esc, render, $, ICONS, navHeader } from "./ui.js";
import { SYMBOLS, kachatWordmark, openPanel } from "./kachat-ui.js";
import { kachatLive, kachatLaunched, kachatNames } from "./kachat-names.js";

// Names are always bought on the chatting address (iOS 6e938ff, the owner's call): there is no
// Buy From any more - claims, purchases, offers, extend and renew pay from the chatting address.

import { IS_TESTNET } from "./net.js";
import * as dock from "./dock.js";
import * as live from "./kachat-live.js";

export { kachatWordmark };

const redact = (text) => `<span class="redacted">${esc(text)}</span>`;
const pill = () => '<span class="coming-pill">Coming soon</span>';
const header = (title, detail) => `
  <div class="km-header"><div class="km-title">${esc(title)}</div>${detail ? `<div class="muted tiny">${esc(detail)}</div>` : ""}</div>`;

// The pages behind the cards (KaPay 99ab88a KachatMarketView.Page): names for sale, names back on
// the market (Available), names in their grace period (Expired), and everything that happens in
// the registry.
const PAGES = [
  { id: "market", title: "Marketplace", icon: "tag" },
  { id: "available", title: "Available", icon: "sealCheck" },
  { id: "expired", title: "Expired", icon: "hourglass" },
  { id: "activity", title: "Activity", icon: "history" },
];
// The cards' icons not in SYMBOLS: checkmark.seal and clock.arrow.circlepath (KaPay 99ab88a).
const CARD_ICONS = {
  sealCheck: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1.8l2.4 1.8 3-.2.9 2.9 2.5 1.7-1 2.8 1 2.8-2.5 1.7-.9 2.9-3-.2L12 22.2l-2.4-1.8-3 .2-.9-2.9-2.5-1.7 1-2.8-1-2.8 2.5-1.7.9-2.9 3 .2Z"/><path d="m8.4 12.3 2.4 2.4 4.8-5"/></svg>',
  history: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.8V9h4.2"/><path d="M12 8v4.3l2.8 1.7"/></svg>',
};

const isLive = () => kachatLive && live.hub.isLive;
// Live, or not launched here (mainnet): the same pages - empty on mainnet (iOS 7227d69). The
// placeholder pages remain only for a testnet registry that is setting up.
const livePages = () => isLive() || !kachatLaunched;

// The names being claimed, with a count (iOS b219bb0 KachatClaimsButton): beside How it works on
// the cards, alone on a page.
const claimsButton = () => (isLive() ? live.claimsButtonHtml() : "");
const bindClaims = () => { const b = $("#claims"); if (b) b.onclick = () => live.openClaimsList(); };

/** Starts the hub (or, where the registry isn't launched, shows its pages empty) and repaints with
 *  `paintParts` on every change. */
function follow(paintParts, { start = true } = {}) {
  if (kachatLive) {
    live.hub.onChange = paintParts;
    if (start || !live.hub.isLive) live.hub.start();
    else paintParts();
  } else {
    // Not launched here: the live pages show empty, under "Coming soon".
    live.hub.loaded = true;
    paintParts();
  }
}

/** The .kachat tab's first screen (its own place in the dock): the logo and a numbered card per
 *  page - Marketplace, Available, Expired, Activity - each opening its page (KaPay 99ab88a). No
 *  Back, unless it was opened from somewhere else (`onBack`). */
export function showKachatMarket({ onBack = null } = {}) {
  const back = () => showKachatMarket({ onBack });

  /** How many live on a page; "-" until the registry has answered (KaPay 99ab88a count(of:)). */
  const countText = (id) => {
    const h = live.hub;
    if (!isLive() || !h.loaded || h.loadError) return "-";
    const list = id === "available" ? h.lapsed : id === "expired" ? h.grace : id === "activity" ? h.activity : h.listings;
    return String(list.length);
  };
  const cardsHtml = () => PAGES.map((p) => `
    <button class="km-card km-hub-card" data-open-page="${p.id}">
      <span class="km-hub-card-top">
        <span class="accent km-hub-card-icon">${SYMBOLS[p.icon] || CARD_ICONS[p.icon]}</span>
        <span class="km-chevron">${ICONS.chevron}</span>
      </span>
      <span class="km-hub-card-count" data-count="${p.id}">${esc(countText(p.id))}</span>
      <span class="km-hub-card-title">${esc(p.title)}</span>
    </button>`).join("");

  const heroStatus = () => {
    // the Testnet badge on testnet only; mainnet is live as it is (iOS ef6b21e)
    if (isLive()) return IS_TESTNET ? live.testnetBadge() : "";
    // The bundled manifest is for the previous registry: a calm "Setting up", no error (iOS d2e0673).
    if (kachatLive && live.hub.upgrading) {
      // the Testnet badge on testnet only, and no network named in the text (EXT-021)
      return `<div class="kl-badges">${IS_TESTNET ? live.testnetBadge() : ""}<span class="coming-pill kl-setting-up">${SYMBOLS.hammer}<span>Setting up</span></span></div>
        <p class="muted tiny center-text">The .kachat registry is being upgraded. Names open here again once the new registry is live.</p>`;
    }
    const error = kachatLive && live.hub.ready === false && live.hub.setupError
      ? `<p class="muted tiny center-text">${esc(live.hub.setupError)}</p>` : "";
    return pill() + error;
  };

  render(`
    <header class="navbar">
      ${onBack ? `<button class="nav-back" id="back" aria-label="Back">${ICONS.back}<span>Back</span></button>` : "<span></span>"}
      <div class="nav-title">.kachat</div>
      <div class="nav-right km-nav-actions">
        <span id="km-claims">${claimsButton()}</span>
        <button class="icon plain accent" id="how" aria-label="How it works">${SYMBOLS.question}</button>
      </div>
    </header>
    <section class="km">
      <div class="km-hero compact">
        ${kachatWordmark(64)}
        <div id="km-status">${heroStatus()}</div>
      </div>
      <div class="km-hub-cards">${cardsHtml()}</div>
    </section>`, "kachat:market");
  dock.remember(back);
  if (onBack) $("#back").onclick = onBack;
  $("#how").onclick = () => showHowItWorks(isLive());
  bindClaims();
  for (const card of app.querySelectorAll("[data-open-page]")) {
    card.onclick = () => showKachatPage(card.dataset.openPage, { onBack: back });
  }

  // Live updates redraw the parts in place.
  const paintParts = () => {
    if (app.dataset.screen !== "kachat:market") return;
    $("#km-status").innerHTML = heroStatus();
    $("#km-claims").innerHTML = claimsButton();
    bindClaims();
    for (const count of app.querySelectorAll("[data-count]")) count.textContent = countText(count.dataset.count);
  };
  follow(paintParts);
}

/** A card's page (KaPay 99ab88a pageScreen): its title and the claims button on top; only the
 *  Marketplace has the name search ("Find a name"). Back goes to the cards. `search` and `scroll`
 *  are where it was, coming back from a name opened on it. */
function showKachatPage(id, { onBack, search = "", scroll = 0 }) {
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  const state = { search: page.id === "market" ? search : "" };
  const again = (at = 0) => showKachatPage(page.id, { onBack, search: state.search, scroll: at });
  // a name opened here stays in the .kachat tab, and Back comes back to this page as it was
  const nav = {
    openName: (info) => {
      const at = app.querySelector(".km")?.scrollTop || 0;
      live.hub.onChange = null;
      live.showLiveNameDetail({ info, onBack: () => again(at), screen: "kachat:name" });
    },
  };

  const searchResult = () => {
    const typed = state.search.trim().toLowerCase();
    if (!typed) return "";
    if (isLive()) return live.searchResultHtml(typed);
    return `
      <div class="km-card km-search-result">
        <div class="tx-meta"><span class="strong ellipsis">${esc(typed)}.kachat</span><span class="muted tiny">Registration isn't open yet.</span></div>
        <button class="km-prominent small-button" disabled>Claim</button>
      </div>`;
  };
  // The Marketplace's search (KaPay 99ab88a KachatNameSearchCard): Available or Taken.
  const searchHtml = () => `
    <div class="km-search">
      <label class="km-card km-search-field">
        <span class="muted">${ICONS.search}</span>
        <input id="search" value="${esc(state.search)}" placeholder="Find a name" autocomplete="off" autocapitalize="off" spellcheck="false" />
        <span class="muted strong">.kachat</span>
      </label>
      <div id="search-result">${searchResult()}</div>
    </div>`;

  // A name tile's shape, redacted: no invented name or price (iOS tilePlaceholder, 27a4f39 / c488d1d).
  const tile = (attr = "") => `<button class="km-card kl-tile" ${attr}>${live.nameTileHtml(redact("somename"), redact("000 KAS"))}</button>`;

  const marketPage = () => `
    ${header("For sale")}
    ${live.nameGridHtml(Array.from({ length: 4 }, () => tile("data-listing")).join(""))}
    <button class="km-bordered with-icon" disabled>${SYMBOLS.tag}<span>List a Name for Sale</span></button>
    <p class="muted small center-text">Listings appear here once .kachat names launch.</p>`;

  const availablePage = () => `
    ${header("Available")}
    ${live.nameGridHtml(Array.from({ length: 2 }, () => tile('disabled aria-hidden="true"')).join(""))}
    <p class="muted small center-text">Expired names appear here once .kachat names launch.</p>`;

  // Names in their grace period, redacted (iOS expiredPage, cb3c27d).
  const expiredPage = () => `
    ${header("Expired")}
    ${live.nameGridHtml(Array.from({ length: 2 }, () => `<button class="km-card kl-tile" disabled aria-hidden="true">${live.nameTileHtml(redact("somename"), '<span class="muted tiny">00:00</span>')}</button>`).join(""))}
    <p class="muted small center-text">Names in their grace period appear here once .kachat names launch.</p>`;

  const activityPage = () => `
    ${header("Recent activity", "Every claim, renewal, listing, sale, offer, transfer and reclaim across the registry.")}
    <div class="km-card km-list">
      ${["tag", "cart", "at", "arrows"].map((icon) => `
        <div class="km-row">
          <span class="accent km-icon">${SYMBOLS[icon]}</span>
          <span class="tx-meta"><span class="strong small">${redact("somename.kachat sold")}</span><span class="tiny">${redact("2h ago")}</span></span>
          <span class="small">${redact("000 KAS")}</span>
        </div>`).join("")}
    </div>
    <p class="muted small center-text">Activity appears here once .kachat names launch.</p>`;

  // Mainnet (or before the testnet registry is ready): the mockups.
  const mockPage = () => (page.id === "available" ? availablePage() : page.id === "expired" ? expiredPage() : page.id === "activity" ? activityPage() : marketPage());
  const pageHtml = () => (livePages() ? live.livePageHtml(page.id) : mockPage());

  render(`
    <header class="navbar">
      <button class="nav-back" id="back" aria-label="Back">${ICONS.back}<span>Back</span></button>
      <div class="nav-title">${esc(page.title)}</div>
      <div class="nav-right km-nav-actions"><span id="km-claims">${claimsButton()}</span></div>
    </header>
    <section class="km km-page-screen">
      ${page.id === "market" ? searchHtml() : ""}
      <div class="km-page" id="km-page">${pageHtml()}</div>
    </section>`, "kachat:page");
  dock.remember(() => again());
  const scroller = app.querySelector(".km");
  if (scroller) scroller.scrollTop = scroll;
  $("#back").onclick = onBack;
  bindClaims();
  const field = $("#search");
  if (field) {
    field.oninput = () => {
      state.search = field.value;
      if (isLive()) live.hub.lookup(state.search.trim().toLowerCase());
      paintSearch();
    };
    // coming back from a name: the result for what is still typed
    if (state.search.trim() && isLive()) live.hub.lookup(state.search.trim().toLowerCase());
  }

  const bindParts = () => {
    for (const listing of app.querySelectorAll("[data-listing]")) listing.onclick = () => showListing({ onBack: () => again() });
    if (livePages()) live.bindLivePage($("#km-page"), nav);
  };
  const paintSearch = () => {
    const result = $("#search-result");
    if (!result) return;
    result.innerHTML = searchResult();
    if (isLive()) live.bindSearchResult(result, nav);
  };
  // Live updates redraw the parts in place, so typing in the search field keeps its focus.
  const paintParts = () => {
    if (app.dataset.screen !== "kachat:page") return;
    const el = app.querySelector(".km");
    const top = el?.scrollTop || 0;
    $("#km-claims").innerHTML = claimsButton();
    bindClaims();
    $("#km-page").innerHTML = pageHtml();
    paintSearch();
    bindParts();
    if (el) el.scrollTop = top;
  };
  bindParts();
  paintSearch();
  // the cards already started the hub: a page only follows it (and starts it if it never got going)
  follow(paintParts, { start: false });
}

// --- How it works (sheet) ------------------------------------------------------------------

function showHowItWorks(isLive = false) {
  const rows = [
    ["atPlus", "Claim", "Pick a free name and register it on Kaspa. It's yours: your name in chats, your profile, your link."],
    ["tag", "List", "Set a price. The name waits in an on-chain covenant, not with KaChat or anyone else, until someone buys it or you take it back."],
    ["cart", "Buy", "Pay the listed price. The payment reaches the seller and the name reaches you in the same transaction - both happen, or neither does."],
    ["hand", "Offer", "Name your own price. Your KAS waits on chain until the seller accepts, you withdraw the offer, or it expires - and you can message the seller first."],
    ["shield", "Trustless", "No middleman and no escrow account: Kaspa's own rules enforce every sale."],
  ];
  openPanel({
    title: "How .kachat works",
    trailing: "Done",
    body: `
      <div class="km-card km-how">
        ${rows.map(([icon, title, detail]) => `
          <div class="km-how-row">
            <span class="accent km-how-icon">${SYMBOLS[icon]}</span>
            <span class="tx-meta"><span class="strong small">${esc(title)}</span><span class="muted small">${esc(detail)}</span></span>
          </div>`).join("")}
      </div>
      <p class="form-footer">${!isLive ? "Nothing here is live yet." : IS_TESTNET ? "Live on Testnet: names, prices and payments here use TKAS on testnet-10. Mainnet names are live on Mainnet." : "Live on Mainnet: names, prices and payments here are real KAS."}</p>`,
  });
}

// --- Listing (iOS KachatListingDetailView) --------------------------------------------------

function showListing({ onBack }) {
  const rows = (icon, line, trailing) => `
    <div class="km-row">
      <span class="accent km-icon">${SYMBOLS[icon]}</span>
      ${line}
      ${trailing}
    </div>`;
  render(`
    ${navHeader({ title: "Listing" })}
    <section class="km">
      <div class="km-card km-name-card">
        <div class="km-name-banner">${redact("name.kachat")}</div>
        <div class="km-price-row">
          <div class="tx-meta"><span class="muted tiny">Price</span><span class="km-price">${redact("000 KAS")}</span></div>
          <span class="tiny">${redact("listed 1h ago")}</span>
        </div>
        ${pill()}
      </div>
      <div class="km-actions">
        <button class="km-prominent with-icon" id="buy">${SYMBOLS.cart}<span>Buy Now</span></button>
        <button class="km-bordered with-icon" id="offer">${SYMBOLS.hand}<span>Make an Offer</span></button>
      </div>
      ${header("Seller")}
      <div class="km-card km-seller">
        <span class="km-dot big"></span>
        <span class="tx-meta"><span class="strong small">${redact("kaspa:xxxx....xxxx")}</span><span class="muted tiny">Ask about the name, or agree on a price before you offer.</span></span>
        <button class="km-bordered small-button with-icon" disabled>${SYMBOLS.bubbles}<span>Message</span></button>
      </div>
      ${header("Offers", "Open offers on this name, highest first. The seller can accept any of them.")}
      <div class="km-card km-list">
        ${Array.from({ length: 3 }, () => rows("hand",
          `<span class="tx-meta"><span class="strong small">${redact("kaspa:xxxx....xxxx")}</span><span class="tiny">${redact("expires in 2d")}</span></span>`,
          `<span class="strong small">${redact("000 KAS")}</span>`)).join("")}
      </div>
      ${header("History")}
      <div class="km-card km-list">
        ${["tag", "arrows", "atPlus"].map((icon) => rows(icon,
          `<span class="tx-meta"><span class="small">${redact("listed by kaspa:xxxx")}</span></span>`,
          `<span class="tiny">${redact("3d ago")}</span>`)).join("")}
      </div>
      <div class="km-notes muted small">
        <div>${SYMBOLS.cart}<span>Buying pays the seller and moves the name to you in one transaction.</span></div>
        <div>${SYMBOLS.lock}<span>An offer locks your KAS on chain until the seller accepts it, you withdraw it, or it expires.</span></div>
        <div>${SYMBOLS.bubbles}<span>Messages go to the seller like any KaChat chat.</span></div>
      </div>
    </section>`, "kachat:listing");
  $("#back").onclick = onBack;
  // Buy Now and Make an Offer open their sheets so the flow can be looked at; their final
  // buttons are disabled until names launch.
  $("#buy").onclick = showBuy;
  $("#offer").onclick = showOffer;
}

function summaryRow(title, value, bold = false) {
  return `<div class="form-row between"><span class="${bold ? "strong" : ""}">${esc(title)}</span><span class="${bold ? "strong" : ""}">${redact(value)}</span></div>`;
}

function showBuy() {
  openPanel({
    title: "Buy Name",
    leading: "Cancel",
    full: true, // full height with Cancel top left, like Make an Offer (iOS 6dd5578)
    body: `
      <div class="form-section">
        <div class="form-card">
          ${summaryRow("Name", "name.kachat")}
          ${summaryRow("Price", "000 KAS")}
          ${summaryRow("Network fee", "0.0000 KAS")}
          ${summaryRow("Total", "000 KAS", true)}
        </div>
        <div class="form-footer">The payment reaches the seller and the name reaches you in the same transaction - both happen, or neither does.</div>
      </div>
      <div class="form-section">
        <div class="form-card"><button class="form-row km-form-button" disabled>Confirm Purchase</button></div>
        <div class="form-footer">Buying opens when .kachat names launch.</div>
      </div>`,
  });
}

function showOffer() {
  const expiries = [["1d", "1 Day"], ["3d", "3 Days"], ["7d", "7 Days"], ["30d", "30 Days"]];
  openPanel({
    title: "Make an Offer",
    leading: "Cancel",
    full: true,
    body: `
      <div class="form-section">
        <div class="form-card">
          ${summaryRow("Name", "name.kachat")}
          ${summaryRow("Listed at", "000 KAS")}
        </div>
      </div>
      <div class="form-section">
        <div class="form-header">Your offer</div>
        <div class="form-card"><div class="form-row"><input class="plain-input km-offer-amount" inputmode="decimal" placeholder="0" /><span class="muted">KAS</span></div></div>
        <div class="form-footer">Your KAS stays locked on chain until the seller accepts, you withdraw the offer, or it expires. Nobody else can touch it.</div>
      </div>
      <div class="form-section">
        <div class="form-header">Expires after</div>
        <div class="form-card"><div class="form-row">
          <div class="segmented wide km-expiry" role="radiogroup" aria-label="Expires after">
            ${expiries.map(([id, label]) => `<button type="button" role="radio" data-expiry="${id}" aria-checked="${id === "3d"}">${label}</button>`).join("")}
          </div>
        </div></div>
      </div>
      <div class="form-section">
        <div class="form-card"><button class="form-row km-form-button" disabled>Send Offer</button></div>
        <div class="form-footer">Offers open when .kachat names launch.</div>
      </div>`,
    onMount(panel) {
      // The amount and expiry can be set so the form can be tried, as on iOS.
      for (const option of panel.querySelectorAll("[data-expiry]")) {
        option.onclick = () => {
          for (const other of panel.querySelectorAll("[data-expiry]")) other.setAttribute("aria-checked", String(other === option));
        };
      }
      const amount = panel.querySelector(".km-offer-amount");
      amount.oninput = () => { amount.value = amount.value.replace(/[^\d.]/g, ""); };
    },
  });
}

