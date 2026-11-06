// The swipe-up screen's rules (iOS SwipeUpToSendScrollView / SendProgressScreen, KaPay 953b255),
// with no screen code, so tools/test-send-steps.mjs runs them in node. send-steps.js draws the
// screen itself.

import { SEND_OUTCOME_UNKNOWN_MESSAGE } from "../shared/engine/transactions.js";

/** How far the bar is pushed up before letting go sends: about a third of the screen (KaPay
 *  953b255; it was half). */
export function swipeUpThreshold(height) {
  return Math.max(120, Number(height || 0) * 0.3);
}

/**
 * How a swipe-up ended, from what the screen knows: `done` (sent, or a claim started) and the
 * failure text shown (null while there is none). "unknown" is a send the network never confirmed
 * (SEND_OUTCOME_UNKNOWN): it may have gone through, so there's nothing to try again and it ends
 * on Done (KaPay 953b255 outcomeUnknown). Returns { kind: "done" | "unknown" | "failed" | null,
 * title, final: "done" | "retry" | null }; `title` is null while it is still going.
 */
export function swipeUpEnding({ done = false, failure = null, doneTitle = "Sent" } = {}) {
  if (done) return { kind: "done", title: doneTitle, final: "done" };
  if (failure == null) return { kind: null, title: null, final: null };
  if (failure === SEND_OUTCOME_UNKNOWN_MESSAGE) return { kind: "unknown", title: "Not confirmed", final: "done" };
  return { kind: "failed", title: "Failed", final: "retry" };
}
