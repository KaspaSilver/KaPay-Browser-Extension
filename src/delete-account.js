// The Delete Account warning (KaPay iOS 99ab88a DeleteAccountSheet), the same for Settings and the
// sign-in screen's Delete: what can't be undone, a way to the 12 or 24 words (or, for an account
// that still owes its backup, to the backup steps), then Delete Account and Cancel. Deleting is never
// blocked: an empty account someone doesn't want shouldn't have to be backed up first.

import { esc, ICONS, showSheet } from "./ui.js";

// exclamationmark.triangle.fill
const TRIANGLE = '<svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.6a2 2 0 0 1 3.4 0l8.4 14.6a2 2 0 0 1-1.7 3H3.6a2 2 0 0 1-1.7-3z" fill="#ff453a"/><path d="M12 9v5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.3" fill="#fff"/></svg>';
// exclamationmark.shield
const SHIELD = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5l8 3v6c0 5-3.4 9.1-8 10.5-4.6-1.4-8-5.5-8-10.5v-6z"/><path d="M12 8v5M12 16.5v.01"/></svg>';

/**
 * @param {object} opts
 * @param {string} opts.confirmSubtitle  what goes: the Delete row's second line
 * @param {boolean} [opts.notBackedUp]   the account hasn't finished the backup steps
 * @param {Function} [opts.onBackUp]     Settings only: into the backup steps
 * @param {Function} [opts.onViewSeed]   Settings only: View 12 or 24 Words and Passphrase
 * @param {Function} opts.onConfirm
 */
export function showDeleteAccountSheet({ confirmSubtitle, notBackedUp = false, onBackUp = null, onViewSeed = null, onConfirm }) {
  const rows = [];
  if (notBackedUp && onBackUp) {
    rows.push({ label: "Back Up Account", subtitle: "Write down your 12 or 24 words before you delete.", icon: SHIELD, onClick: onBackUp });
  } else if (onViewSeed) {
    rows.push({ label: "View 12 or 24 Words and Passphrase", subtitle: "The passphrase shows too, if this account has one.", icon: ICONS.key, onClick: onViewSeed });
  }
  rows.push({ label: "Delete Account", subtitle: confirmSubtitle, icon: ICONS.trash, danger: true, onClick: onConfirm });
  showSheet({
    title: "",
    headerHtml: `
      <div class="delete-warning">
        ${TRIANGLE}
        <div class="sheet-title">Delete Account</div>
        ${notBackedUp ? `<p class="delete-warning-alert">This account isn't backed up. If you delete it now, it and its funds can never be recovered.</p>` : ""}
        ${notBackedUp && !onBackUp ? '<p class="muted small">To back it up first, sign in to it and use the card on the Wallet tab.</p>' : ""}
        <p class="muted small">${esc("Make sure your 12 or 24 words are backed up, and your passphrase too if you have one. They are the only way to recover this account and its funds.")}</p>
      </div>`,
    rows,
  });
}
