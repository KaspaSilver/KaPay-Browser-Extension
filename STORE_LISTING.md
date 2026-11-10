# KaPay Extension - Chrome Web Store listing and review answers

Everything the Chrome Web Store forms ask for, ready to paste. KaPay ships on Chrome and Brave
only (owner, 2026-10-31): Brave installs straight from the Chrome Web Store, so one listing covers
both.

| | |
|---|---|
| Upload | `packages/kapay-extension-<version>-chromium.zip`, built with `npm run package` (it also writes Firefox files; ignore them) |
| Developer dashboard | https://chrome.google.com/webstore/devconsole |
| Privacy policy URL | **https://home.kachat.app/privacy/** - Cyber Ventures LLC's one policy for every KaChat app; it names the KaPay Extension |
| Every update | raise `version` in `public/manifest.json` and `package.json` together; the store refuses a version it has already seen |
| Swap | works once the store's item ID (dashboard, after the first upload) is in `KAPAY_EXTENSION_IDS` on the desktop.kachat.app Pages project, followed by a redeploy (KaChat-Desktop Build 261, docs/CLOUDFLARE_PAGES.md). Until then Swap says "not available right now" |

## Store listing tab

**Name:** KaPay Extension

**Summary (max 132 characters):**
KaPay, the Kaspa wallet from KaChat. Send and receive KAS, manage addresses and domains, and connect to Kaspa websites.

**Category:** Productivity > Tools (there is no finance category).

**Language:** English

**Description:**

KaPay brings the wallet from the KaPay and KaChat apps to your browser. Your 12 or 24 words open
the same addresses as KaPay on iPhone and KaChat on iPhone, Android and desktop.

- Create a new account in one tap, or import one from KaChat, KasWare, Kaspium, Kastle, KDX, OKX,
  OneKey, Chainge, Ledger or the Kaspa CLI wallet: KaPay finds which kind from your words
- Back up your 12 or 24 words step by step, with a check that your paper copy is right, and a
  Backup Hygiene check every six months
- Send Kaspa step by step: a keypad for the amount, .kas and .kachat name lookup, Max, coin
  control, a review with Normal / Fast / Priority fees, and swipe up to send
- A fresh receiving address every time, and Manage Addresses for your spending addresses:
  generate, discover, rename, hide and set the primary
- History, coins (UTXOs) and Compound for every address
- Contacts: save the people you pay by address or name
- Your domains on every Kaspa name service (.kas, .k, .kaspa) and .kachat names: claim a .kachat
  name, set your primary .kas name and send a domain to someone else
- Send to a name on any service - and pick another service's answer under "Other domains"
- Cold Storage: watch a KasSigner account by its kpub and send from it by signing on the device -
  the transaction goes out and the signature comes back as animated QR codes
- Portfolio: up to five portfolios of buys and sells, price and value charts, profit and loss,
  network hashrate, CSV import/export, and import from any Kaspa address
- Several accounts in one wallet
- Connect to Kaspa websites: they ask, you approve every connection, payment and signature
- Your 12 or 24 words are encrypted with your password and never leave your computer
- No accounts, no tracking, no ads

KaPay is self-custody: only you hold your keys. Keep your 12 or 24 words written down and
safe - they are the only way to restore your wallet.

**Graphics:**

- Store icon: 128x128 - `public/icons/kapay-128.png`
- Screenshots: 1280x800, one to five - `store-assets/screenshots/` (see Screenshots below)
- Small promo tile (optional): 440x280

## Privacy practices tab

**Single purpose:** A Kaspa cryptocurrency wallet: hold keys locally, show balances, send and
receive Kaspa, manage Kaspa name service domains, and let Kaspa websites request payments and
signatures with the user's approval.

**Permission justifications:**

- `storage` - Stores the password-encrypted wallet (the 12 or 24 words), account names, derived
  public addresses, contacts, portfolios, settings and connected websites in the browser.
- `alarms` - Locks the wallet automatically after the auto-lock time the user chooses, and
  schedules the clipboard clear below.
- `offscreen`, `clipboardWrite` - 30 seconds after the user copies their 12 or 24 words or a
  private key, an offscreen page clears the clipboard (the popup has closed by then).
- Host permission `indexer.kachat.app` - KaChat's own indexer: .kachat names (look up, claim,
  offers, set the primary name) for the user's addresses. The request carries those public addresses.
- Host permission `api.kaspa.org` - Kaspa REST API: transaction history and address usage.
- Host permissions `*.kaspa.green`, `*.kaspa.red`, `*.kaspa.stream`, `*.kaspa.blue`, `*.kaspa.ws` -
  the public Kaspa node resolver and nodes, for balances and sending transactions.
- Host permissions `api-tn10.kaspa.org`, `api-tn10.dotk.name` - the testnet-10 REST API and .k
  name service, used only when the user turns on Testnet in Settings.
- Host permission `api.knsdomains.org` - Kaspa Name Service: the .kas domains an address owns,
  name lookups, setting the primary domain.
- Host permissions `api.dotk.name`, `kaspaname.com` - the .k (dotk) and .kaspa (Kaspa Names)
  name services, read-only: the names an address owns and name lookups.
- Host permission `api.coingecko.com` - the Kaspa price in the user's currency and the
  Portfolio's price history.
- Host permissions `api.gateio.ws`, `query1.finance.yahoo.com` - Portfolio: long-range KAS price
  history (fallback) and the comparison charts (VOO, gold, silver).
- Content scripts on `https://*/*` (and localhost) - provide `window.kachat`, the interface Kaspa
  websites use to ask the wallet for a connection, payment or signature. The scripts only relay
  those requests; they do not read or change page content, and the wallet uses this access for
  nothing else. Every request needs the user's approval in the wallet.
- Optional host permission `https://*/*` - never requested up front. The wallet asks for one
  origin at a time, only after the user taps to allow it:
  - `desktop.kachat.app`, KaChat's relay to ChangeNOW, when the user opens Swap (swap KAS for
    another coin; the user pays the ChangeNOW deposit address themselves);
  - a custom Kaspa REST API or .kachat names indexer the user types into Settings.

**Remote code:** No. All code, including the Kaspa WebAssembly module, is in the package.
(`wasm-unsafe-eval` in the CSP lets the bundled WebAssembly compile; nothing is fetched and run.)

**Data usage:** tick "Financial and payment information" (public blockchain addresses) only.
Public Kaspa addresses are sent to the Kaspa network and the APIs above to show balances and send
transactions, and the user's chatting address is sent to KaChat's indexer (`indexer.kachat.app`)
to read its .kachat names. Nothing else is sent, nothing is stored about
the user, and the address is not sold, not used for unrelated purposes and not used for
creditworthiness. Like any web request, these services see the user's IP address. Tick all three
certifications (not sold to third parties, not used for unrelated purposes, not used for credit).

## Distribution tab

- Visibility: Public (or Unlisted for a first test release: installable from the link only)
- Regions: all regions

## Screenshots

1280x800 PNGs in `store-assets/screenshots/`, taken from the wallet opened as a tab
(`popup.html?view=tab`) on an empty test account, dark mode: the Wallet home screen, Send Kaspa,
Manage Addresses, Cold Storage, and Portfolio. Upload them in that order. Keep brand names out of
them: the .kachat Marketplace lists names like "disney" and "instagram" for sale, which a reviewer
can read as trademark misuse, so it is not among them.
