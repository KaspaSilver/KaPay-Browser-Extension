// The password before every KAS you send (KaChat-Desktop Build 228, the owner's rule of 2026-10-23,
// without Face ID here: the wallet password). wallet.js asks this before anything is built or a
// node is touched - Send Kaspa, Max, Compound, a spending address's send, .kas transfers, and
// payments approved for websites - so no screen can skip it. Cancelling sends nothing.

import { app, esc } from "./ui.js";
import * as vault from "./vault.js";

// The prompt up now, if any: one at a time (iOS authPending, KaPay iOS 0799cec).
let waiting = null;
// Answers the prompt up now "no", or null when none is up.
let cancelWaiting = null;

/** The wallet locked, logged out or switched accounts under the prompt: it answers "cancelled"
 *  (nothing sent), comes off the screen and gives the screen behind its clicks and keys back. */
export function cancelSpendPrompt() {
  cancelWaiting?.();
}

/**
 * "Confirm Send" with what is being sent and to whom. Resolves true once the password checks out,
 * false when cancelled. `details`: { amountText, recipient, max, title, message, confirmLabel }.
 *
 * While it is up nothing else starts or changes the send it waits for (iOS SwipeUpToSendScrollView
 * authPending, KaPay iOS 0799cec): a second request is turned down (false, nothing sent) and the
 * waiting prompt stays as it is; the screen behind takes no clicks, keys or focus; a click beside
 * the prompt does nothing - only Cancel or Escape cancel it.
 */
export function confirmSpend(details = {}) {
  if (waiting) return Promise.resolve(false);
  waiting = askPassword(details).finally(() => { waiting = null; });
  return waiting;
}

function askPassword({ amountText = "", recipient = "", max = false, title = "Confirm Send", totalText = null, extraFeeText = null, message = "Enter your wallet password to send.", confirmLabel = "Send" } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "alert-backdrop spend-auth";
    const what = max ? `Everything${amountText ? ` (${amountText})` : ""}` : amountText;
    const to = recipient ? `${recipient.slice(0, 16)}…${recipient.slice(-6)}` : "";
    backdrop.innerHTML = `
      <form class="alert" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="alert-body">
          <div class="alert-title">${esc(title)}</div>
          <div class="alert-message">${what ? `<strong>${esc(what)}</strong>` : ""}${to ? `<br><span class="mono tiny">to ${esc(to)}</span>` : ""}</div>
          ${totalText ? `<div class="alert-message">Total <strong>${esc(totalText)}</strong>${extraFeeText ? `<br><span class="small">includes ${esc(extraFeeText)} extra fee set by the site</span>` : ""}</div>` : ""}
          <div class="alert-message">${esc(message)}</div>
          <input class="alert-field" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" />
          <div class="error spend-auth-error"></div>
        </div>
        <div class="alert-buttons two">
          <button type="button" class="alert-button" data-cancel>Cancel</button>
          <button type="submit" class="alert-button strong">${esc(confirmLabel)}</button>
        </div>
      </form>`;
    // the screen behind sits still until this answers
    const wasInert = Boolean(app?.inert);
    if (app) app.inert = true;
    let answered = false;
    const done = (ok) => {
      if (answered) return;
      answered = true;
      cancelWaiting = null;
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      if (app) app.inert = wasInert;
      resolve(ok);
    };
    cancelWaiting = () => done(false);
    const onKey = (event) => { if (event.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (event) => { if (event.target.closest("[data-cancel]")) done(false); });
    const input = backdrop.querySelector(".alert-field");
    backdrop.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      if (await vault.verifyPassword(input.value)) return done(true);
      if (answered) return;
      backdrop.querySelector(".spend-auth-error").textContent = "Wrong password.";
      input.select();
    };
    document.body.appendChild(backdrop);
    input.focus();
  });
}
