// The amount field's KAS / currency switch (iOS KaspaFiatAmountState, KaPay iOS 0799cec), with no
// screen code, so tools/test-send-steps.mjs runs it in node. send-pieces.js hands it to the
// screens; send-steps.js draws the switch.

import { KAS_UNIT } from "../shared/engine/network.js";

/**
 * The amount as typed - in KAS, or in your currency (`fiat`) - and what it is in KAS. iOS
 * KaspaFiatAmountState: the screen keeps the KAS text; this owns the field's own text and unit.
 * `kasText` is the exact KAS last handed to the screen: a unit switch only changes what's shown,
 * never the amount, so back in KAS the field shows that KAS, not one worked back from the
 * 2-decimal currency figure (KaPay iOS 0799cec).
 */
export function amountState() {
  return {
    fiat: false,
    display: "",
    kasText: "",
    /** The KAS amount as text after `display` changed; "" when it isn't a number yet. */
    kasFromDisplay(price) {
      const entered = Number(this.display);
      if (!this.display || !Number.isFinite(entered)) return null;
      if (!this.fiat) return entered;
      return price > 0 ? entered / price : null;
    },
    onInput(text, price) {
      this.display = text;
      if (!this.fiat) {
        this.kasText = text;
        return text;
      }
      const kas = this.kasFromDisplay(price);
      this.kasText = kas == null ? "" : plainKas(kas);
      return this.kasText;
    },
    /** Max (or a compound) sets the KAS amount; the field shows it in the unit on screen. */
    setKas(kasText, price) {
      const kas = Number(kasText);
      this.kasText = String(kasText ?? "");
      this.display = this.fiat && price > 0 && Number.isFinite(kas) ? (kas * price).toFixed(2) : this.kasText;
    },
    toggle(price) {
      if (!(price > 0)) return;
      const held = this.kasText !== "" && Number.isFinite(Number(this.kasText)) ? Number(this.kasText) : null;
      const kas = held ?? this.kasFromDisplay(price);
      this.fiat = !this.fiat;
      if (kas == null) {
        this.display = "";
        return;
      }
      // back in KAS: the exact amount the screen holds and will send
      this.display = this.fiat ? (kas * price).toFixed(2) : (this.kasText || plainKas(kas));
    },
    /** The other unit's value for the switch: "$12.34" / "123.4 TKAS"; null while empty.
     *  `formatFiat(kas)` formats a KAS amount in your currency. */
    conversion(price, formatFiat) {
      const kas = this.kasFromDisplay(price);
      if (kas == null) return null;
      // the KAS that will be sent, exactly
      if (this.fiat) return `${this.kasText || plainKas(kas)} ${KAS_UNIT}`;
      return price > 0 ? formatFiat(kas) : null;
    },
    reset() { this.fiat = false; this.display = ""; this.kasText = ""; },
  };
}

function plainKas(kas) {
  return kas.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}
