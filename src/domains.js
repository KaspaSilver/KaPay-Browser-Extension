// Your Domains - iOS KNSDomainsListView, KNSDomainDetailView and KNSDomainSendView.
//
//   cards    four Kaspa Hub style squares (iOS debd6fd, 2ee667c): .kachat, .kas (KNS), .k (dotk),
//            .kaspa (Kaspa Names), each with who runs it and how many names you hold there (a
//            dash until the answer is in). A card opens that service's own list.
//   list     the names as teal cards; an outside service's list pins "Get a <ending> domain at
//            <site>", which opens that service's site - KaChat creates only its own .kachat names.
//            .kas cards carry "Primary"; a .kaspa name still settling carries "Settling".
//   detail   (.kas) the card, Asset ID, Set as Primary / Primary Domain, Status: Listed, Send
//   send     recipient (address or a name on any service, with "Other domains"), Normal /
//            Fast / Priority fee on 0.02 KAS, the two-transaction progress sheet, the Sent sheet
//
// Left out on purpose: inscribing and profile editing. Profiles are moving to .kachat names.

import { remember, selectTab } from "./dock.js";
import * as wallet from "./wallet.js";
import { app, esc, render, $, toast, showAlert, ICONS, navHeader } from "./ui.js";
import * as names from "./names.js";
import { kachatRegistry } from "./kachat-names.js";
import { showKachatMarket } from "./market.js";
import { showLiveNameDetail } from "./kachat-live.js";
// the .kachat list, started from the names saved last time (iOS f4f5c0f)
import { ownedDomainsTab, ownedDomainsEntry } from "./kachat-owned-cache.js";
import { recipientLookup } from "./send-pieces.js";
import { logWarn } from "./log.js";

const BASE_FEE_SOMPI = 2_000_000n; // 0.02 KAS - iOS WithdrawFeeTier base for domain transfers
const FEE_TIERS = [
  { id: "normal", label: "Normal", multiplier: 1n },
  { id: "fast", label: "Fast", multiplier: 2n },
  { id: "priority", label: "Priority", multiplier: 5n },
];

const sameDomain = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

// iOS DomainNameCardView: the name, and an optional corner badge.
function nameCardHtml(title, badge = null) {
  return `
    <div class="domain-card">
      <span class="domain-name">${esc(title)}</span>
      ${badge ? `<span class="domain-badge">${esc(badge)}</span>` : ""}
    </div>`;
}

function cardHtml(domain, primary) {
  return nameCardHtml(domain.fullName, primary ? "Primary" : null);
}

// The service whose list is open (null: the cards), kept while you go into a domain and back.
let selectedTab = null;

export function showDomains({ address, onBack, atCards = false, service = null }) {
  // opened from the Wallet tab: the cards; back from a domain: the list it came from; `service`: that list
  if (atCards) selectedTab = null;
  if (service && names.service(service)) selectedTab = service;
  const state = {
    data: wallet.cachedDomains(address), loading: true, error: "",
    owned: names.cachedOwnedNames(address), ownedLoading: true,
  };
  const back = () => showDomains({ address, onBack });
  const here = () => app.dataset.screen === "domains";
  const loadPending = () => wallet.pendingDomainTransfers()
    .then((pending) => { state.pending = pending; if (here()) paint(); })
    .catch(() => {});
  loadPending();

  const getNameButton = (tld) => {
    const info = names.service(tld);
    if (!info?.site) return "";
    return `<a class="get-domain" href="${esc(info.site)}" target="_blank" rel="noopener noreferrer">Get a ${esc(info.suffix)} domain at ${esc(info.siteName)}</a>`;
  };

  const kasTab = () => {
    const list = state.data?.domains || [];
    const pending = (state.pending || []).map(pendingCardHtml).join("");
    if (state.error) return `${pending}<p class="error">${esc(state.error)}</p>`;
    if (!state.data && state.loading) return '<div class="center-text"><span class="spinner"></span></div>';
    if (!list.length) return `${pending}<p class="muted center-text">No domains yet.</p>`;
    return pending + list.map((domain, i) => `
      <button class="domain-button" data-i="${i}" aria-label="${esc(domain.fullName)}">
        ${cardHtml(domain, sameDomain(domain.fullName, state.data.primaryDomain))}
      </button>`).join("");
  };

  const serviceTab = (tld) => {
    const info = names.service(tld);
    const list = state.owned?.[tld] || [];
    if (!list.length) {
      if (state.ownedLoading && !state.owned?.[tld]) return '<div class="center-text"><span class="spinner"></span></div>';
      if (state.owned?.failed?.[tld]) return `<p class="muted center-text">Couldn't reach ${esc(info.serviceName)}. <button class="link-button" id="retry">Try again</button></p>`;
      return `<p class="muted center-text">No ${esc(info.suffix)} names yet.</p>`;
    }
    return list.map((owned) => nameCardHtml(owned.display, owned.provisional ? "Settling" : null)).join("");
  };

  // The live tab on every network (iOS 7227d69) - empty on mainnet, where no registry runs.
  let liveTab = null;
  const kachatTab = () => {
    liveTab = ownedDomainsTab(address, () => { if (here() && selectedTab === "kachat") paint(); });
    return liveTab.html;
  };
  const comingTab = () => `
    <div class="kachat-coming">
      <span class="accent">${ICONS.atCircle}</span>
      <h3>.kachat names are coming</h3>
      <p class="muted small">KaChat's own names will live here: claim one, set it as your name in chats, and share it as your profile link.</p>
    </div>`;

  // How many names you hold on a service, or null until the answer is in (a dash).
  const countOf = (tld) => {
    if (tld === "kas") return state.data ? (state.data.domains || []).length : null;
    if (tld === "kachat") {
      // the same held-names read the .kachat list shows, reloaded when the registry moves; the
      // saved list's count at once (iOS f4f5c0f)
      ownedDomainsTab(address, () => { if (here() && selectedTab == null) paint(); });
      const entry = ownedDomainsEntry(address);
      return entry?.loaded ? entry.names.length : null;
    }
    if (state.owned?.failed?.[tld]) return null;
    return state.owned?.[tld] ? state.owned[tld].length : null;
  };
  const cardsHtml = () => `
    <div class="domains-grid your-domains-grid">${names.NAME_SERVICES.map((svc) => {
      const count = countOf(svc.tld);
      return `<button class="glass domains-service" data-tab="${svc.tld}">
        <span class="accent">${ICONS.atCircle}</span>
        <span class="strong">${esc(svc.suffix)}</span>
        <span class="muted tiny">${esc(svc.serviceName)}</span>
        <span class="domains-count-pill">${count == null ? "-" : esc(String(count))}</span>
      </button>`;
    }).join("")}</div>`;

  const paint = () => {
    if (selectedTab == null) {
      render(`
        ${navHeader({ title: "Your Domains" })}
        <section class="screen domains">${cardsHtml()}</section>`, "domains");
      remember(() => paint());
      $("#back").onclick = onBack;
      for (const card of app.querySelectorAll("[data-tab]")) card.onclick = () => switchTo(card.dataset.tab);
      return;
    }
    const body = selectedTab === "kas" ? kasTab() : selectedTab === "kachat" ? kachatTab() : serviceTab(selectedTab);
    render(`
      ${navHeader({ title: names.service(selectedTab)?.suffix || "Your Domains" })}
      <section class="screen domains" id="domains-body">${body}</section>
      ${selectedTab === "kachat"
        ? (liveTab?.showsInscribe ? '<div class="get-domain-bar"><button class="get-domain" id="inscribe">Inscribe</button></div>' : "")
        : `<div class="get-domain-bar">${getNameButton(selectedTab)}</div>`}`, "domains");
    remember(() => paint());
    // back to the cards
    $("#back").onclick = () => { selectedTab = null; paint(); };
    const list = state.data?.domains || [];
    for (const button of app.querySelectorAll("[data-i]")) {
      button.onclick = () => showDomainDetail({ address, domain: list[Number(button.dataset.i)], primaryDomain: state.data.primaryDomain, onBack: back });
    }
    const retry = $("#retry");
    if (retry) retry.onclick = loadOwned;
    for (const b of app.querySelectorAll("[data-finish]")) {
      b.onclick = () => {
        const record = (state.pending || []).find((r) => r.assetId === b.dataset.finish);
        if (record) finishTransfer(record, () => { loadPending(); back(); });
      };
    }
    if (selectedTab === "kachat" && liveTab) liveTab.bind(app, { openName: (info) => showLiveNameDetail({ info, onBack: back }) });
    // Inscribe (iOS e4da63d): the .kachat marketplace; a new name shows here on the way back.
    const inscribe = $("#inscribe");
    // the marketplace is its own tab (claiming lands back in Your Domains on its own: the registry refreshes)
    if (inscribe) inscribe.onclick = () => selectTab("kachat");
  };

  const switchTo = (tld) => {
    if (!names.service(tld)) return;
    selectedTab = tld;
    paint();
  };

  const loadOwned = () => {
    state.ownedLoading = true;
    if (here()) paint();
    names.ownedNames(address)
      .then((owned) => { state.owned = owned; })
      .catch(() => {})
      .finally(() => { state.ownedLoading = false; if (here()) paint(); });
  };

  paint();
  wallet.domains(address, { force: true })
    .then((data) => { state.data = data; state.error = ""; })
    .catch((error) => { state.error = state.data ? "" : error.message || "Could not load KNS domains."; })
    .finally(() => { state.loading = false; if (here()) paint(); });
  loadOwned();
}

function showDomainDetail({ address, domain, primaryDomain, onBack }) {
  const state = { primaryDomain, setting: false, error: "" };
  const paint = () => {
    const isPrimary = sameDomain(domain.fullName, state.primaryDomain);
    const listed = domain.status === "listed";
    const canSend = Boolean(domain.inscriptionId) && !listed;
    render(`
      ${navHeader({ title: domain.fullName })}
      <section class="screen domains">
        ${cardHtml(domain, isPrimary)}
        <div class="glass list">
          <div class="list-row"><span>Asset ID</span><span class="mono tiny muted ellipsis asset-id" title="${esc(domain.inscriptionId || "")}">${esc(domain.inscriptionId || "—")}</span></div>
          ${isPrimary
            ? `<div class="list-row"><span>Primary Domain</span><span class="accent">${ICONS.starFill}</span></div>`
            : domain.inscriptionId
              ? `<button class="list-row" id="set-primary" ${state.setting ? "disabled" : ""}><span>Set as Primary</span>${state.setting ? '<span class="spinner small-spin"></span>' : `<span class="accent">${ICONS.star}</span>`}</button>`
              : ""}
          ${listed ? '<div class="list-row"><span>Status</span><span class="muted">Listed</span></div>' : ""}
        </div>
        ${state.error ? `<p class="error small">${esc(state.error)}</p>` : ""}
        ${listed ? '<p class="muted small center-text">This domain is listed and can\'t be sent right now.</p>' : ""}
        <div class="spacer"></div>
        <button id="send" class="with-icon domain-send" ${canSend ? "" : "disabled"}>${ICONS.sendCircle}<span>Send</span></button>
      </section>`, "domain-detail");
    $("#back").onclick = onBack;
    const setPrimary = $("#set-primary");
    if (setPrimary) setPrimary.onclick = async () => {
      state.setting = true;
      state.error = "";
      paint();
      try {
        await wallet.setPrimaryDomain(domain.inscriptionId, domain.fullName);
        state.primaryDomain = domain.fullName;
        toast(`Primary domain set to ${domain.fullName}.`);
        // The KNS API takes a moment to report the new primary (iOS refreshKNSUntilPrimarySettles).
        settlePrimary(address, domain.fullName);
      } catch (error) {
        // the password prompt was cancelled: nothing changed, and nothing to say
        if (error?.code !== wallet.SEND_CANCELLED) state.error = String(error?.message || error).slice(0, 160);
      }
      state.setting = false;
      if (app.dataset.screen === "domain-detail") paint();
    };
    $("#send").onclick = () => {
      if (canSend) showSendDomain({ domain, ownerAddress: address, onBack: paint, onSent: onBack });
    };
  };
  paint();
}

async function settlePrimary(address, fullName) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const data = await wallet.domains(address, { force: true });
      if (sameDomain(data.primaryDomain, fullName)) return;
    } catch { /* try again */ }
  }
}

// --- Send Domain ---------------------------------------------------------------------------

const STAGES = {
  "resolving-recipient": ["Preparing transfer", 0.1],
  "verifying-ownership": ["Preparing transfer", 0.1],
  committing: ["Submitting commit transaction", 0.3],
  committed: ["Waiting for the commit to settle", 0.55],
  revealing: ["Submitting reveal transaction", 0.8],
  revealed: ["Confirming the new owner", 0.95],
  verifying: ["Confirming the new owner", 0.95],
};

// --- Unfinished transfers (audit EXT-005) ----------------------------------------------------
// A transfer whose commit went out but whose reveal didn't (a closed popup, a refused reveal) is
// kept in storage; Finish Transfer reveals it with the key that sent it. Its 2 KAS are safe.

function pendingCardHtml(record) {
  return `
    <div class="glass pending-transfer">
      <div class="strong small">Unfinished transfer: ${esc(record.domain || "domain")}</div>
      <div class="muted tiny">To ${esc(wallet.shortAddress(record.recipient || ""))}. The commit was sent but the reveal didn't go through; your 2 KAS are safe.</div>
      <div class="pending-buttons"><button class="small-button" data-finish="${esc(record.assetId)}">Finish Transfer</button></div>
    </div>`;
}

/** Runs Finish Transfer for `record` on a progress screen, then calls `after`. */
async function finishTransfer(record, after) {
  const progress = (status) => {
    const [title, fraction] = STAGES[status] || ["Finishing transfer", 0.5];
    render(`
      <section class="screen progress-sheet">
        <h2 class="center-text">Finishing ${esc(record.domain || "transfer")}</h2>
        <div class="progress"><div class="progress-bar" style="width:${Math.round(fraction * 100)}%"></div></div>
        <p class="center-text">${esc(title)}</p>
        <p class="muted small center-text">Revealing the commit that was already sent. Keep this window open until it finishes.</p>
      </section>`, "send-domain-progress");
  };
  progress("revealing");
  try {
    const result = await wallet.finishDomainTransfer(record, ({ status }) => progress(status));
    if (result.status === "no-commit") {
      showAlert({
        title: "No Commit Found",
        message: "The commit for this transfer isn't on chain, so nothing was spent. If you just sent it, wait a minute and try again; otherwise you can forget this transfer.",
        confirmLabel: "Forget It", cancelLabel: "Keep",
        onConfirm: async () => { await wallet.discardDomainTransfer(record.assetId); after(); },
      });
      after();
      return;
    }
    toast(result.status === "already-transferred" ? `${record.domain} already belongs to the recipient.` : `${record.domain} transferred.`);
    if (result.revealTxid) showDomainSent({ txid: result.revealTxid, onDone: after });
    else after();
  } catch (error) {
    if (error?.code !== wallet.SEND_CANCELLED) toast(String(error?.message || error));
    after();
  }
}

/** Send Domain. `source` is the owner: the chatting address, or { kind: "spending", index };
 *  `ownerAddress` its address as shown - another account's key is refused at Send. */
export function showSendDomain({ domain, onBack, onSent, source = { kind: "main" }, ownerAddress = null }) {
  const state = {
    recipientInput: "", recipient: null, recipientError: "", resolving: false, resolutions: [], othersOpen: false,
    tier: "normal", customFeeSompi: null, editingFee: false,
    sending: false, stage: null, error: "",
  };
  const feeSompi = () => state.customFeeSompi ?? BASE_FEE_SOMPI * (FEE_TIERS.find((t) => t.id === state.tier)?.multiplier || 1n);
  const canSend = () => Boolean(state.recipient) && !state.resolving && !state.sending;

  // The send screens' lookup (send-pieces.js): a keystroke clears the recipient and marks it as being
  // looked up at once, so Send is off until the new text resolves - never the last answer's address.
  const lookup = recipientLookup({
    read: () => state.recipientInput.split("?")[0],
    resolve: (text) => wallet.resolveRecipient(text),
    onChange: (found) => {
      state.recipient = found.recipient;
      state.recipientError = found.error;
      state.resolutions = found.resolutions;
      state.resolving = found.resolving;
      // nothing for the ending typed, but another service has the name: show it straight away
      state.othersOpen = Boolean(found.error) && found.resolutions.some((r) => r.address);
      paintRecipient();
    },
  });

  const recipientStatusHtml = () => {
    const status = (() => {
      if (!state.recipientInput.trim()) return "";
      if (state.resolving) return `<div class="status muted"><span class="spinner small-spin"></span> Looking up domain...</div>`;
      if (state.recipientError) return `<div class="status bad">${ICONS.xCircle}<span>${esc(state.recipientError)}</span></div>`;
      if (state.recipient?.domain) return `<div class="status good">${ICONS.checkFill}<span>Resolved: ${esc(state.recipient.domain)}</span></div><div class="mono tiny muted break">${esc(state.recipient.address)}</div>`;
      if (state.recipient) return `<div class="status good">${ICONS.checkFill}<span>Valid address</span></div>`;
      return "";
    })();
    return status || state.resolutions.length ? `<div class="form-row stack-tight">${status}${names.otherDomainsHtml({ resolutions: state.resolutions, selectedTld: state.recipient?.tld || names.splitTypedName(state.recipientInput).tld, open: state.othersOpen })}</div>` : "";
  };
  const bindRecipientExtras = () => {
    names.bindOtherDomains(app, {
      onToggle: () => { state.othersOpen = !state.othersOpen; paintRecipient(); },
      onPick: (tld) => {
        const pick = state.resolutions.find((r) => r.tld === tld && r.address);
        if (!pick) return;
        state.recipient = { address: pick.address, domain: pick.display, tld: pick.tld, resolutions: state.resolutions };
        state.recipientError = "";
        state.othersOpen = false;
        paintRecipient();
      },
    });
  };
  /** Only the recipient's status and the Send button, so the field keeps its caret while typing. */
  const paintRecipient = () => {
    if (state.sending || app.dataset.screen !== "send-domain") return;
    const host = $("#recipient-status");
    if (host) host.innerHTML = recipientStatusHtml();
    bindRecipientExtras();
    const send = $("#send");
    if (send) send.disabled = !canSend();
  };

  const paint = () => {
    if (state.sending) return paintProgress();
    const focusedId = document.activeElement?.id;
    const fee = feeSompi();
    render(`
      <header class="navbar form-bar">
        <button class="bar-text" id="cancel">Cancel</button>
        <div class="nav-title">Send Domain</div>
        <button class="bar-text strong" id="send" ${canSend() ? "" : "disabled"}>Send</button>
      </header>
      <section class="form">
        <div class="form-section">
          <div class="form-header">Domain</div>
          <div class="form-card"><div class="form-row stack-tight"><span class="strong">${esc(domain.fullName)}</span><span class="mono tiny muted break">${esc(domain.inscriptionId)}</span></div></div>
        </div>
        <div class="form-section">
          <div class="form-header">Recipient Address</div>
          <div class="form-card">
            <textarea id="recipient" class="mono recipient" rows="2" placeholder="kaspa:qr... or domain" spellcheck="false" autocapitalize="off">${esc(state.recipientInput)}</textarea>
            <div id="recipient-status">${recipientStatusHtml()}</div>
            <div class="form-row"><button class="link-button" id="paste">${ICONS.clipboard}<span>Paste</span></button></div>
          </div>
          <div class="form-footer">Enter a Kaspa address (kaspa:...) or a domain.</div>
        </div>
        <div class="form-section">
          <div class="form-header">Fee</div>
          <div class="form-card">
            <div class="form-row">
              <div class="segmented wide" role="radiogroup" aria-label="Fee">
                ${FEE_TIERS.map((t) => `<button type="button" role="radio" data-tier="${t.id}" aria-checked="${state.customFeeSompi == null && state.tier === t.id}">${t.label}</button>`).join("")}
              </div>
            </div>
            <div class="form-row between">
              <span>Network Fee</span>
              ${state.editingFee
                ? `<span class="fee-edit"><input id="custom-fee" inputmode="decimal" value="${esc(wallet.sompiToKasText(fee))}" /><button class="icon plain" id="fee-ok" aria-label="Use this fee">${ICONS.checkCircle}</button></span>`
                : `<button class="link-button underline" id="fee">${esc(wallet.sompiToKasText(fee))} KAS ${ICONS.pencilSmall}</button>`}
            </div>
          </div>
          <div class="form-footer">If the network is busy, Fast or Priority pays a higher fee to help your transfer confirm sooner. Tap the fee amount to set a custom fee.</div>
        </div>
        ${state.error ? `<div class="form-section"><div class="form-card"><div class="form-row error-text">${esc(state.error)}</div></div></div>` : ""}
      </section>`, "send-domain");
    $("#cancel").onclick = onBack;
    $("#send").onclick = doSend;
    const recipient = $("#recipient");
    recipient.oninput = () => {
      state.recipientInput = recipient.value;
      lookup.schedule();
    };
    bindRecipientExtras();
    $("#paste").onclick = async () => {
      let text;
      try { text = (await navigator.clipboard.readText()).trim(); }
      catch { toast("Clipboard unavailable - paste with ⌘V instead."); return; }
      state.recipientInput = text;
      const field = $("#recipient");
      if (field) field.value = text;
      lookup.now();
    };
    for (const button of app.querySelectorAll("[data-tier]")) {
      button.onclick = () => { state.tier = button.dataset.tier; state.customFeeSompi = null; state.editingFee = false; paint(); };
    }
    const feeButton = $("#fee");
    if (feeButton) feeButton.onclick = () => { state.editingFee = true; paint(); $("#custom-fee")?.select(); };
    const feeOk = $("#fee-ok");
    if (feeOk) {
      const commit = () => {
        const value = wallet.kasToSompi($("#custom-fee").value.trim());
        state.editingFee = false;
        if (value != null && value > 0n) state.customFeeSompi = value;
        paint();
      };
      feeOk.onclick = commit;
      $("#custom-fee").onkeydown = (event) => { if (event.key === "Enter") commit(); };
    }
    if (focusedId === "recipient") {
      const again = $("#recipient");
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }
  };

  // The progress sheet can't be left while the two transactions are in flight (iOS disables
  // dismissal the same way): leaving between commit and reveal would strand the commit.
  const paintProgress = () => {
    const [title, fraction] = STAGES[state.stage] || ["Preparing transfer", 0.1];
    render(`
      <section class="screen progress-sheet">
        <h2 class="center-text">Sending ${esc(domain.fullName)}</h2>
        <div class="progress"><div class="progress-bar" style="width:${Math.round(fraction * 100)}%"></div></div>
        <p class="center-text">${esc(title)}</p>
        <p class="muted small center-text">A domain transfer is two transactions, so this takes a moment. Keep this window open until it finishes.</p>
      </section>`, "send-domain-progress");
  };

  const doSend = async () => {
    if (!canSend()) return;
    state.sending = true;
    state.stage = "verifying-ownership";
    state.error = "";
    paintProgress();
    try {
      const result = await wallet.transferDomain({
        domain: domain.fullName,
        assetId: domain.inscriptionId,
        toAddress: state.recipient.address,
        priorityFeeSompi: feeSompi(),
        source,
        fromAddress: ownerAddress,
        onStatus: ({ status }) => { if (STAGES[status]) { state.stage = status; paintProgress(); } },
      });
      const who = state.recipient.domain || wallet.shortAddress(result.recipientAddress);
      toast(result.verified ? `${domain.fullName} transferred to ${who}.` : `Transfer submitted for ${domain.fullName}.`);
      showDomainSent({ txid: result.revealTxid, onDone: onSent });
    } catch (error) {
      logWarn("[KaPay] domain transfer failed:", error);
      // The commit went out (or a transfer of this domain is already unfinished): never commit
      // again - finish that one instead (audit EXT-005).
      if ((error?.code === "knsTransferRevealPending" || error?.code === "knsTransferPending") && error.pendingTransfer) {
        state.sending = false;
        showAlert({
          title: "Finish the Transfer",
          message: String(error.message || ""),
          confirmLabel: error.code === "knsTransferRevealPending" ? "Retry Reveal" : "Finish Transfer",
          cancelLabel: "Later",
          onConfirm: () => finishTransfer(error.pendingTransfer, onSent),
        });
        onBack();
        return;
      }
      state.sending = false;
      // a cancelled password prompt: nothing was sent, back to the form as it was
      state.error = error?.code === wallet.SEND_CANCELLED ? "" : String(error?.message || error);
      paint();
    }
  };

  paint();
}

// iOS SentConfirmationSheet for a domain transfer: the reveal transaction.
function showDomainSent({ txid, onDone }) {
  render(`
    <section class="screen sent">
      <div class="sent-check accent">${ICONS.checkBig}</div>
      <h2>Sent</h2>
      <a class="mono small break link-button" href="${esc(wallet.explorerTxUrl(txid))}" target="_blank" rel="noopener noreferrer">${esc(txid)}</a>
      <p class="muted small center-text">Tap the transaction to open it in the explorer.</p>
      <div class="spacer"></div>
      <button id="done" class="big">Done</button>
    </section>`, "sent");
  $("#done").onclick = onDone;
}
