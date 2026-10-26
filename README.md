# WealthTracker

A private, local-first net-worth tracker for Indian portfolios. It's a website you can install on your phone's Home Screen like an app. Plain HTML, CSS and JavaScript, with no dependencies and no build step.

Tracks bank accounts, real estate, mutual funds (live NAVs from mfapi.in), PPF (month-wise interest using the official rate history), NPS, bonds and FDs, P2P (LenDenClub) and insurance (LIC surrender value; health and term cover are tracked but don't count towards net worth).

## Where your data lives

- Everything stays in this browser's storage (IndexedDB) on this device. Nothing is sent to a server.
- The only network request is to `api.mfapi.in`, and it sends just the AMFI scheme code to fetch the latest NAV.
- With a passcode turned on, data is encrypted at rest (AES-GCM-256, key derived with PBKDF2-SHA256 at 600,000 iterations). If you forget the passcode, the data can't be recovered, so keep a backup.
- **Backups:** Settings → Export Backup saves a plain JSON file. It's the same format as the earlier iPhone app, so old backups import directly. Importing merges by asset ID, so importing the same file twice doesn't create duplicates.

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

When you change any app file, bump `VERSION` in `sw.js` so installed copies pick up the update. `tests/offline.test.js` fails if a new file isn't added to the precache list.

## Put it on your iPhone

1. Open the site in Safari.
2. Tap Share → **Add to Home Screen**.
3. Open it from the Home Screen icon from then on.

It opens full-screen, works offline, and refreshes NAVs when you're online.

Safari can delete a website's storage after 7 days without a visit. Home Screen web apps are exempt, which is another reason to install it. Export a backup now and then anyway (Settings → Export Backup → Save to Files).

## Renewal reminders

Websites can't reliably send notifications on iPhone. Instead, **Add to Calendar** creates a calendar file (.ics) with each policy's renewal date and alerts 30, 15 and 3 days before, at 9 am. Your calendar app shows those alerts even when this app is closed. Add it again after a due date changes.

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
tools/       local server and the Chrome end-to-end test
```
