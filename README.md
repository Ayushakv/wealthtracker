# WealthTracker

A private, local-first net-worth tracker for Indian portfolios. It's a website you can install on your phone's Home Screen like an app. Plain HTML, CSS and JavaScript, with no dependencies and no build step.

Tracks bank accounts, real estate, mutual funds (live NAVs from mfapi.in), PPF (month-wise interest using the official rate history), NPS, bonds, fixed deposits, P2P (LenDenClub), gold (physical and digital, valued at the day's Hyderabad rate) and insurance (LIC surrender value; health and term cover are tracked but don't count towards net worth).

## Where your data lives

- Everything stays in this browser's storage (IndexedDB) on this device. Nothing is sent to a server, unless you turn on sync (below).
- The only other network request is to `api.mfapi.in`, and it sends just the AMFI scheme code to fetch the latest NAV. The gold rate comes from this site itself (`rates/gold.json`), so fetching it sends nothing.
- With a passcode turned on, data is encrypted at rest (AES-GCM-256, key derived with PBKDF2-SHA256 at 600,000 iterations). If you forget the passcode, the data can't be recovered, so keep a backup.
- **CAS import** reads the PDF in the browser; the file and its password never leave the device.
- **Backups:** Settings → Export Backup saves a plain JSON file. It's the same format as the earlier iPhone app, so old backups import directly. Importing merges by asset ID, so importing the same file twice doesn't create duplicates.

## Sync between devices (optional)

Each browser keeps its own copy, so a new phone or browser starts empty. Sync keeps them the same:

1. Settings → **Set Up Sync**. Follow the link to create a GitHub token with only the **gist** permission (choose "No expiration" if you don't want to redo this), and paste it in.
2. On the first device, choose a sync passphrase. On every other device, paste a token (the same one or a new one) and enter the same passphrase. Your data appears.

How it works:

- The data is encrypted on the device (AES-GCM-256, key from your sync passphrase via PBKDF2-SHA256, 600,000 iterations) and saved as a single file in a **secret gist** in your GitHub account. GitHub only ever sees ciphertext. Without the passphrase, nobody can read it, including you if you forget it; your devices still keep their own copies.
- The app syncs when it opens, a couple of seconds after each change, and when you tap Sync Now. Each device remembers the data as of its last sync, so changes from different devices are combined field by field rather than one overwriting the other. Assets deleted on one device are deleted on the others. If two devices change the same field, the more recently updated copy wins.
- The token and passphrase are stored on the device (encrypted too, when a passcode is on). "Turn Off Sync on This Device" forgets them and leaves the gist for your other devices. "Erase Everything" doesn't touch the gist, so setting up sync again brings everything back.
- Sync covers your assets and the PPF rate list. Per-device things (passcode, last NAV refresh) aren't synced.

## Import from your statements

Assets → **+** → **Import Mutual Funds or Bonds from CAS** or **Import NPS Statement** (both also in Settings). Either one tells the kinds of statement apart by itself.

### Mutual funds (CAMS + KFintech)

It reads a CAMS + KFintech Consolidated Account Statement and creates or updates one fund per folio and scheme, with units, cost and NAV.

1. Request a **Detailed** CAS on camsonline.com or kfintech.com, choosing a password. It arrives by email as a PDF.
2. Import the PDF and enter that password. Review the list, then tap **Import**.

How it matches: a fund imported before is matched by ISIN + folio, so re-importing a newer statement updates it. A fund you added by hand is matched by AMFI code if exactly one fund in the statement has that code. Fully redeemed funds are skipped unless they're already in the portfolio. The ISIN on the statement is turned into an AMFI code with `data/isin-amfi.json` so live NAVs keep working; a fund with no match keeps the statement's NAV.

### Bonds in a demat account (NSDL or CDSL)

The NSDL or CDSL CAS, emailed monthly to anyone with a demat account, lists sovereign gold bonds, government securities and corporate bonds/NCDs with their market value. Each bond becomes a Bonds asset valued at that market value, with the coupon and maturity when the statement shows them. Shares and fund units in the same statement are skipped; mutual funds come from the CAMS/KFintech statement.

- The statement has no purchase price, so the principal starts at the market value. Edit it to see your gain.
- These bonds have **Calculate value from interest** turned off. Re-importing a newer statement updates their value. Turn it on (with a start date) to calculate accrued interest the way FDs do.
- Re-imports match by ISIN + demat account. Bonds you entered by hand have no ISIN, so the review lets you untick them to avoid duplicates.
- Bank FDs aren't in any statement an app can read; add them by hand under **Fixed Deposits**. Entries saved under the old combined Bonds & FDs category move to Bonds when they have an ISIN or a bond-like name, and to Fixed Deposits otherwise; switch one with **Kind** in its edit form.

### NPS (Protean CRA)

Download the **Transaction Statement** for Tier I or Tier II from the Protean CRA site (any period ending today) and import the PDF. It sets the NPS asset's value, total contributed (less withdrawals), units, NAV date and E/C/G/A split from the statement's Investment Summary and Scheme Wise Summary.

- It updates the NPS asset with the same PRAN and tier. If none has that PRAN but exactly one NPS asset of that tier has no PRAN (added by hand), that one is updated and takes the PRAN. Otherwise a new asset is added.
- The asset split is what each scheme holds now, not your scheme preference.

### PPF (bank statement)

Download your PPF account statement from 1 April of the current financial year (Axis Bank's layout: "The current value of investment in your Public Provident Fund (PPF) account number … is INR …" followed by Transaction Date, Remarks, Amount and Balance) and import the PDF, as often as you like.

- The balance on 1 April becomes the opening balance, and the statement's deposits and withdrawals replace the account's transactions. The bank's interest credits are left out: the app works out interest month by month at the official rate, so the value includes interest earned since 1 April that the bank credits on 31 March.
- It updates the PPF asset with the same account number. If none has it but exactly one PPF asset has no account number (added by hand), that one is overwritten and takes the account number. Otherwise a new asset is added.
- A statement that starts partway through a financial year is refused, since its opening balance wouldn't be the 1 April balance.

The parsers (`js/core/cas.js`, `js/core/demat.js`, `js/core/nps.js`, `js/core/ppfStatement.js`) are tested on synthetic statements. If a real statement imports wrongly, adjust the parser and add a test in `tests/cas.test.js`, `tests/demat.test.js`, `tests/nps.test.js` or `tests/ppfStatement.test.js`.

## Run it locally

Requires Node 22 or later. Nothing to install.

```sh
npm start              # http://localhost:8080  (PORT=9000 npm start to change)
npm test               # unit tests
npm run test:e2e       # drives headless Google Chrome through the whole app
```

`LIVE_NETWORK_TESTS=1 npm test` also checks the real mfapi.in service. `SHOTS_DIR=path npm run test:e2e` saves screenshots (default `./e2e-shots`).

## Hosting

Any static host works: GitHub Pages, Netlify or Cloudflare Pages. Publish this folder as-is.

The site **must be served over HTTPS** (or from `localhost`). Encryption (`crypto.subtle`) and offline support (the service worker) only work in a secure context, so opening `http://192.168.x.x:8080` from your phone won't work.

When you change any app file, bump `VERSION` in `sw.js` so installed copies pick up the update. `tests/offline.test.js` fails if a new file isn't added to the precache list. `vendor/` and `data/` aren't precached (about 2 MB, used only for CAS import); they're cached the first time they're used.

Refresh the ISIN → AMFI code map now and then to pick up new schemes: `node tools/update-isin-map.mjs` (downloads AMFI's NAVAll.txt).

## Put it on your iPhone

1. Open the site in Safari.
2. Tap Share → **Add to Home Screen**.
3. Open it from the Home Screen icon from then on.

It opens full-screen, works offline, and refreshes NAVs when you're online.

Safari can delete a website's storage after 7 days without a visit. Home Screen web apps are exempt, which is another reason to install it. Export a backup now and then anyway (Settings → Export Backup → Save to Files), or turn on sync. Note that on iPhone the Home Screen app and Safari keep separate storage.

## Renewal reminders

Websites can't reliably send notifications on iPhone. Instead, **Add to Calendar** creates a calendar file (.ics) with each policy's renewal date and alerts 30, 15 and 3 days before, at 9 am. Your calendar app shows those alerts even when this app is closed. Add it again after a due date changes.

## Gold rate

Gold holdings are entered in grams with their purity (24K, 22K or 18K) and valued at grams × that day's rate per gram in Hyderabad from [5paisa](https://www.5paisa.com/commodity-trading/gold/hyderabad), before GST and making charges. For digital gold (Paytm, Gullak and so on), add one holding per app with the grams it shows.

5paisa has no API and its page can't be read by a browser from another site, so the **Gold rate** GitHub Action (`.github/workflows/gold-rate.yml`) runs `tools/update-gold-rate.mjs` at 10:00 and 15:00 IST. It reads the rates from the page, checks them against the page's own last-10-days table, and commits `rates/gold.json` when they change. The app reads that file on Refresh. If 5paisa changes its page, the script stops with an error rather than guessing, and the app keeps the last rate.

GitHub turns off scheduled workflows in a public repository after 60 days without activity. If the rate date on Net Worth stops moving, re-enable the workflow under Actions → Gold rate. You can also run it by hand from there.

## mfapi.in note

mfapi.in's cache strips the CORS header from cached responses, so browsers would block them. Each request adds a unique `?t=` query string to get a fresh response. If NAV refresh starts failing in the browser but works with `curl`, check this first.

## Layout

```
index.html, manifest.webmanifest, sw.js   app shell, install metadata, offline cache
css/app.css                               all styles (light and dark)
js/core/     calculations, formats, backup, mfapi client (no DOM; unit-tested in Node)
js/store/    IndexedDB, encryption, app state
js/ui/       HTML templating, icons, donut chart, dialogs/toasts
js/views/    one file per screen
js/app.js    router and shell
vendor/      pdf.js 4.10.38 (Apache 2.0), loaded only for CAS import
data/        ISIN → AMFI scheme code map, generated from AMFI's NAVAll.txt
tests/       unit tests; fixtures/ has synthetic password-protected CAMS and NSDL statements (password ABCDE1234F)
rates/       gold.json, the day's gold rate, written by the Gold rate Action
tools/       local server, Chrome end-to-end test, ISIN map generator, gold rate updater
```
