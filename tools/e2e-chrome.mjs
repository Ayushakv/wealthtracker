// End-to-end check in real headless Chrome over the DevTools protocol. No dependencies.
//   npm run test:e2e                 (screenshots go to ./e2e-shots, or SHOTS_DIR)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { createAsset } from '../js/core/assets.js';
import { exportBackup } from '../js/core/backup.js';
import { OFFICIAL_HISTORY, RateSchedule } from '../js/core/ppf.js';
import { deriveKey } from '../js/store/crypto.js';
import { fromBase64, readEnvelope, seal, SYNC_FILE, unseal } from '../js/store/sync.js';
import { fakeGitHub } from '../tests/fakeGitHub.js';
import { samplePortfolio } from '../tests/seed.js';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = resolve(process.env.SHOTS_DIR ?? 'e2e-shots');
const PASSCODE = 'correct-horse-7';
const SYNC_PASSPHRASE = 'battery-staple-9';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MARK: - Minimal CDP client

async function launch() {
  const profile = await mkdtemp(join(tmpdir(), 'wt-e2e-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 100 && !targets; i++) {
    await sleep(100);
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let nextID = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id != null) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${msg.error.message} (${p.method})`)) : p.resolve(msg.result);
    } else {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextID;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const close = async () => {
    ws.close();
    proc.kill();
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return { send, on, close };
}

// MARK: - Test run

const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const cdp = await launch();
const { send } = cdp;
await mkdir(SHOTS, { recursive: true });
const downloads = await mkdtemp(join(tmpdir(), 'wt-dl-'));
// A portfolio with every category, imported as a backup to give the app something to show.
const portfolioFile = join(await mkdtemp(join(tmpdir(), 'wt-portfolio-')), 'portfolio.json');
await writeFile(portfolioFile, exportBackup({ assets: samplePortfolio(RateSchedule.official), ppfRates: OFFICIAL_HISTORY }));

const problems = [];
let expectNetworkErrors = false;
cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => problems.push(`exception: ${d.exception?.description ?? d.text}`));
cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
  if (type === 'error') problems.push(`console.error: ${args.map((a) => a.value ?? a.description).join(' ')}`);
});
cdp.on('Log.entryAdded', ({ entry }) => {
  if (entry.level !== 'error') return;
  // mfapi.in may be unreachable from the test machine; that's handled in-app and shown in the footer.
  if (/mfapi\.in/.test(entry.url ?? '') || (expectNetworkErrors && entry.source === 'network')) return;
  // The sync test tries a wrong token on purpose.
  if (/api\.github\.com\/user/.test(entry.url ?? '') && /401/.test(entry.text)) return;
  problems.push(`log: ${entry.text} ${entry.url ?? ''}`);
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

// GitHub's gist API, answered in memory so sync can be tested without an account or a network.
const github = fakeGitHub();
const cors = [
  { name: 'Access-Control-Allow-Origin', value: '*' },
  { name: 'Access-Control-Allow-Headers', value: 'authorization, content-type, accept, x-github-api-version' },
  { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PATCH' },
];
// The gold rate file, fixed so values are predictable whatever the Action last committed.
const GOLD_RATE = { source: '5paisa', city: 'Hyderabad', date: '2026-11-10', perGram: { 24: 10000, 22: 9160, 18: 7500 } };
cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
  if (request.url.includes('/rates/gold.json')) {
    const body = Buffer.from(JSON.stringify(GOLD_RATE)).toString('base64');
    return send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body });
  }
  if (request.method === 'OPTIONS') return send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors });
  const body = request.postData ?? (request.postDataEntries ? Buffer.concat(request.postDataEntries.map((e) => Buffer.from(e.bytes ?? '', 'base64'))).toString() : undefined);
  const res = github.handle({ method: request.method, url: request.url, headers: request.headers, body });
  send('Fetch.fulfillRequest', {
    requestId,
    responseCode: res.status,
    responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
    body: Buffer.from(JSON.stringify(res.body)).toString('base64'),
  });
});
await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.github.com/*' }, { urlPattern: '*/rates/gold.json*' }] });
/** Another device's view of the synced data: decrypts the gist. */
async function readSyncedCopy() {
  const [gist] = github.gists.values();
  const envelope = readEnvelope(gist.files[SYNC_FILE].content);
  const key = await deriveKey(SYNC_PASSPHRASE, fromBase64(envelope.salt), envelope.iterations);
  return { gist, envelope, key, data: await unseal(key, envelope) };
}
/** …applies `change` to it, and saves it back. */
async function editSyncedCopy(change) {
  const { gist, envelope, key, data } = await readSyncedCopy();
  change(data);
  gist.files[SYNC_FILE].content = await seal(key, envelope, data);
}

const evaluate = async (expression, { userGesture = false } = {}) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
  if (exceptionDetails) throw new Error(`evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}\n  ${expression}`);
  return result.value;
};
async function waitFor(expression, what = expression, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(`!!(${expression})`).catch(() => false)) return;
    await sleep(60);
  }
  throw new Error(`Timed out waiting for: ${what}`);
}
// Clicks carry a user gesture so file pickers, downloads and the like behave as they would for a real tap.
const click = (sel) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.click(); })()`, { userGesture: true });
const fill = (sel, value) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)});
    el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
/** Clicks something that opens a file picker and answers it with `path` (needs Page.setInterceptFileChooserDialog). */
async function chooseFile(sel, path) {
  const chooser = new Promise((r) => cdp.on('Page.fileChooserOpened', r));
  await click(sel);
  const { backendNodeId } = await Promise.race([chooser, sleep(10_000).then(() => { throw new Error('Timed out waiting for: file chooser'); })]);
  await send('DOM.setFileInputFiles', { files: [path], backendNodeId });
}
const text = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
const go = async (hash) => {
  await evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await sleep(120);
};

let viewport = { width: 390, height: 844 };
async function setViewport(width, height, mobile = width < 768) {
  viewport = { width, height };
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
}
let shotIndex = 0;
async function shot(name, { full = false } = {}) {
  await sleep(250);
  let clip;
  if (full) {
    const { cssContentSize } = await send('Page.getLayoutMetrics');
    clip = { x: 0, y: 0, width: viewport.width, height: Math.max(viewport.height, Math.ceil(cssContentSize.height)), scale: 1 };
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
  const file = join(SHOTS, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
  await import('node:fs/promises').then((fs) => fs.writeFile(file, Buffer.from(data, 'base64')));
}
const step = (name) => console.log(`• ${name}`);
const assert = (cond, message) => {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
};

try {
  await setViewport(390, 844);
  await send('Page.navigate', { url: base });

  step('Welcome screen');
  await waitFor(`document.querySelector('.gate h1')?.textContent === 'WealthTracker'`, 'welcome');
  assert(await evaluate(`document.body.classList.contains('gated')`), 'tab bar hidden on welcome');
  await shot('welcome', { full: true });

  step('Continue without a passcode → empty dashboard');
  await click('[data-action="setup-plain"]');
  await waitFor(`document.querySelector('h1')?.textContent === 'Net Worth' && document.querySelector('.empty')`, 'empty dashboard');
  await shot('dashboard-empty');

  assert(!(await evaluate(`document.querySelector('[data-action="load-sample"]')`)), 'no sample portfolio button');

  step('Import a portfolio backup, then refresh NAVs');
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  await go('#/settings');
  await waitFor(`document.querySelector('[data-action="import"]')`, 'settings');
  assert(!(await text('main')).includes('Sample'), 'no sample portfolio in settings');
  await chooseFile('[data-action="import"]', portfolioFile);
  await waitFor(`document.querySelector('#toast.show')?.textContent.startsWith('Imported')`, 'backup import toast');
  await go('#/dashboard');
  await waitFor(`document.querySelector('.card.summary')`, 'summary card');
  await click('[data-action="refresh"]');
  await waitFor(`!document.querySelector('[data-action="refresh"]')?.disabled`, 'refresh finished', 20_000);
  assert((await text('.hero')).startsWith('₹'), 'hero shows rupees');
  const slices = await evaluate(`document.querySelectorAll('.slice').length`);
  assert(slices >= 3, `donut has slices (${slices})`);
  await shot('dashboard', { full: true });
  await evaluate(`document.querySelector('.slice').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  assert(await evaluate(`document.querySelector('.allocation').classList.contains('has-focus')`), 'tapping a slice focuses it');
  assert((await text('.donut-share')).endsWith('%'), 'centre shows the share');
  await shot('dashboard-slice-focused');

  step('Assets list and filter');
  await go('#/assets');
  await waitFor(`document.querySelector('h1')?.textContent === 'Assets' && document.querySelector('a.list-row')`, 'asset list');
  // Every asset listed, counting those folded away in long groups (which show five and a "Show all" button).
  const ROWS = `document.querySelectorAll('a.list-row').length + [...document.querySelectorAll('[data-action="toggle-group"][aria-expanded="false"]')].reduce((n, b) => n + Number(b.dataset.total) - 5, 0)`;
  const assetCount = await evaluate(ROWS);
  await shot('assets', { full: true });
  await evaluate(`(() => { const s = document.querySelector('[data-change="filter"]'); s.value = 'ppf'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`document.querySelectorAll('section.group').length === 1`, 'filtered to PPF');
  await click('details.menu > summary');
  await shot('assets-filtered-menu');
  await evaluate(`(() => { const s = document.querySelector('[data-change="filter"]'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  step('PPF detail → add a deposit');
  const ppfHref = await evaluate(`[...document.querySelectorAll('section.group')].find((s) => s.textContent.includes('PPF'))?.querySelector('a.list-row')?.getAttribute('href')`);
  assert(ppfHref, 'sample has a PPF account');
  await click(`a[href="${ppfHref}"]`);
  await waitFor(`document.querySelector('[data-action="add-entry"]')`, 'PPF detail');
  const entriesBefore = await evaluate(`document.querySelectorAll('[data-action="delete-entry"]').length`);
  await shot('ppf-detail', { full: true });
  await click('[data-action="add-entry"]');
  await waitFor(`document.querySelector('dialog[open] [name="amount"]')`, 'entry dialog');
  const d = await evaluate(`(() => { const t = new Date(Date.now() + 5.5 * 3600e3); return t.toISOString().slice(0, 8) + '12'; })()`);
  await fill('dialog [name="date"]', d);
  await fill('dialog [name="amount"]', '12,500');
  assert(!(await evaluate(`document.querySelector('dialog [data-late]').hidden`)), '"after the 5th" hint shows for the 12th');
  assert(!(await evaluate(`document.querySelector('dialog [data-add]').disabled`)), 'Add enabled');
  await shot('ppf-entry-dialog');
  await click('dialog [data-add]');
  await waitFor(`!document.querySelector('dialog') && document.querySelectorAll('[data-action="delete-entry"]').length === ${entriesBefore + 1}`, 'deposit added');

  step('Edit asset → rename → back to detail');
  await click('a[href$="/edit"]');
  await waitFor(`document.querySelector('form[data-form="asset"] [name="name"]')`, 'edit form');
  await shot('ppf-edit', { full: true });
  await fill('[name="name"]', 'PPF — renamed');
  await click('[data-save]');
  await waitFor(`location.hash === '${ppfHref}' && document.querySelector('h1')?.textContent === 'PPF — renamed'`, 'renamed and back on detail');

  step('New fixed deposit with live projection');
  await go('#/new/fd');
  await waitFor(`document.querySelector('[name="interestRate"]')`, 'FD form');
  assert(await evaluate(`document.querySelector('[name="category"]').value === 'Fixed Deposits' && document.querySelector('h1').textContent.includes('New FDs')`), 'FD form with its kind');
  assert(await evaluate(`document.querySelector('[data-save]').disabled`), 'Save disabled while empty');
  await fill('[name="name"]', 'SBI FD');
  await fill('[name="investedAmount"]', '200000');
  await fill('[name="interestRate"]', '7.1');
  await waitFor(`document.querySelector('[data-derived="projection"]')?.textContent.includes('Value today')`, 'projection');
  await shot('bond-form', { full: true });
  await click('[data-save]');
  // Save steps back to wherever "New" was opened from (the PPF detail here).
  await waitFor(`location.hash === '${ppfHref}'`, 'back after saving the FD');
  await go('#/assets');
  await waitFor(`${ROWS} === ${assetCount + 1}`, 'FD saved');
  const fdGroup = `[...document.querySelectorAll('section.group')].find((s) => s.querySelector('.group-title').textContent.includes('Fixed Deposits'))`;
  assert(await evaluate(`[...${fdGroup}.querySelectorAll('a.list-row .name')].map((n) => n.textContent).join() === 'HDFC Bank FD,SBI FD'`), 'FD listed under Fixed Deposits');
  assert(await evaluate(`[...document.querySelectorAll('a.list-row .name')].some((n) => n.textContent === 'PPF — renamed')`), 'rename kept');

  step('Settings and PPF rates');
  await go('#/settings');
  await waitFor(`document.querySelector('[data-action="export"]')`, 'settings');
  await waitFor(`!document.querySelector('[data-persisted]')?.textContent.includes('Checking')`, 'storage status');
  await shot('settings', { full: true });
  await click('a[href="#/settings/rates"]');
  await waitFor(`document.querySelector('[data-action="add-rate"]')`, 'rates');
  assert((await evaluate(`document.querySelector('.row-label')?.textContent`)).match(/^Q\d FY \d{4}-\d{2} · /), 'quarter label format');
  await shot('rates', { full: true });
  await click('[data-action="add-rate"]');
  await waitFor(`document.querySelector('dialog[open] [name="rate"]')`, 'rate dialog');
  await fill('dialog [name="rate"]', '25');
  assert(await evaluate(`document.querySelector('dialog [data-ok]').disabled`), 'rate above 20% rejected');
  await fill('dialog [name="rate"]', '7.1');
  await shot('rate-dialog');
  await evaluate(`document.querySelector('dialog').close('cancel')`);

  step('Export backup');
  await go('#/settings');
  await waitFor(`document.querySelector('[data-action="export"]')`, 'settings');
  await click('[data-action="export"]');
  let backupFile;
  for (let i = 0; i < 50 && !backupFile; i++) {
    await sleep(100);
    backupFile = (await readdir(downloads)).find((f) => f.endsWith('.json'));
  }
  assert(backupFile?.match(/^WealthTracker-Backup-\d{4}-\d{2}-\d{2}\.json$/), `backup downloaded (${backupFile})`);
  const backup = JSON.parse(await readFile(join(downloads, backupFile), 'utf8'));
  assert(backup.assets.length === assetCount + 1, 'backup holds every asset');

  step('Import the same backup (merges by ID, no duplicates)');
  await chooseFile('[data-action="import"]', join(downloads, backupFile));
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Imported ${assetCount + 1} assets')`, 'import toast');
  await go('#/assets');
  await waitFor(`${ROWS} === ${assetCount + 1}`, 'no duplicates after import');

  step('Import mutual funds from a password-protected CAS PDF');
  await click('details.menu > summary');
  await chooseFile('[data-action="import-cas"]', fileURLToPath(new URL('../tests/fixtures/sample-cas.pdf', import.meta.url)));
  await waitFor(`document.querySelector('dialog[open] [name="password"]')`, 'password dialog', 15_000);
  await fill('dialog [name="password"]', 'wrong');
  await click('dialog .btn-primary');
  await waitFor(`document.querySelector('dialog[open] [role="alert"]')?.textContent.includes('Incorrect password')`, 'wrong password message', 15_000);
  await fill('dialog [name="password"]', 'ABCDE1234F');
  await click('dialog .btn-primary');
  await waitFor(`document.querySelector('dialog[open] .cas-list')`, 'review dialog', 15_000);
  const review = await evaluate(`[...document.querySelectorAll('dialog .cas-item')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`);
  assert(review.length === 3, `3 funds to import (got ${JSON.stringify(review)})`);
  // The test portfolio's HDFC Flexi Cap (same AMFI code, no folio) is updated rather than duplicated.
  assert(review.some((r) => r.includes('HDFC Flexi Cap Fund – Direct Growth') && r.includes('412.537 → 112.345') && r.includes('Update')), 'HDFC updated');
  assert((await text('dialog h2')) === 'Import 3 Funds', 'review title');
  assert((await text('dialog form')).includes('1 fully redeemed fund'), 'redeemed fund noted');
  await shot('cas-review');
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Imported 3 funds')`, 'CAS import toast');
  await waitFor(`location.hash === '#/assets' && ${ROWS} === ${assetCount + 3}`, 'two new funds listed');
  const ppfas = await evaluate(`[...document.querySelectorAll('a.list-row')].find((a) => a.textContent.includes('Parag Parikh'))?.getAttribute('href')`);
  assert(ppfas, 'Parag Parikh fund listed');
  await waitFor(`!document.querySelector('[data-action="refresh"]')?.disabled`, 'NAV refresh finished', 20_000);
  await go(ppfas);
  await waitFor(`document.querySelector('h1')?.textContent.includes('Parag Parikh')`, 'imported fund detail');
  const detail = await text('main');
  assert(detail.includes('9876543') && detail.includes('INF879O01027') && detail.includes('122639') && detail.includes('1,226.388'), 'folio, ISIN, AMFI code and units shown');
  await shot('cas-fund-detail', { full: true });
  await go('#/assets');

  step('Import bonds and a demat fund from an NSDL statement, unticking one bond');
  const nsdl = fileURLToPath(new URL('../tests/fixtures/sample-nsdl.pdf', import.meta.url));
  const openNSDL = async () => {
    await go('#/assets');
    await click('details.menu > summary');
    await chooseFile('[data-action="import-cas"]', nsdl);
    await waitFor(`document.querySelector('dialog[open] [name="password"]')`, 'password dialog', 15_000);
    await fill('dialog [name="password"]', 'ABCDE1234F');
    await click('dialog .btn-primary');
    await waitFor(`document.querySelector('dialog[open] .cas-list')`, 'demat review dialog', 15_000);
  };
  const reviewRows = `[...document.querySelectorAll('dialog .cas-item')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`;
  const reviewHeadings = `[...document.querySelectorAll('dialog .cas-heading > span:first-child')].map((h) => h.textContent.trim())`;
  const untick = (name) => evaluate(`[...document.querySelectorAll('dialog .cas-item')].find((l) => l.textContent.includes(${JSON.stringify(name)})).querySelector('input').click()`);
  await openNSDL();
  assert((await text('dialog h2')) === 'Import 1 Fund and 7 Bonds', `bond review title (${await text('dialog h2')})`);
  const bonds = await evaluate(reviewRows);
  assert(bonds.some((r) => r.includes('SGB 2020-21 SERIES VIII') && r.includes('2.5%') && r.includes('₹1,50,240') && r.includes('New')), `SGB listed (${JSON.stringify(bonds)})`);
  assert(bonds[0].includes('INF000Y01AB2') && bonds[0].includes('250.500 units') && bonds[0].includes('₹20,103'), `demat fund listed first (${bonds[0]})`);
  const sections = await evaluate(reviewHeadings);
  assert(sections.join() === 'Mutual Funds · 1,Government Securities · 2,Corporate Bonds · 4,Securitised Instruments · 1', `the statement's sections (${sections})`);
  await shot('bond-review', { full: true });
  await untick('GOI LOAN');
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Added 6 bonds and 1 fund')`, 'bond import toast');
  await waitFor(`location.hash === '#/assets' && ${ROWS} === ${assetCount + 10}`, 'six bonds and a fund added');
  const groupNamed = (name) => `[...document.querySelectorAll('section.group')].find((s) => s.querySelector('.group-title').textContent.includes(${JSON.stringify(name)}))`;
  assert(await evaluate(`${groupNamed('Mutual Funds')}.textContent.includes('EXAMPLE MUTUAL FUND')`), 'demat fund listed under Mutual Funds');
  const subSections = await evaluate(`[...${groupNamed('Bonds')}.querySelectorAll('.sub-heading > span:first-child')].map((h) => h.textContent.replace(/\\s+/g, ' ').trim())`);
  assert(subSections.join() === 'Government Securities 1,Corporate Bonds 4,Securitised Instruments 1', `bonds split by section (${subSections})`);
  assert(!(await text('main')).includes('GOI LOAN'), 'unticked bond not imported');
  await shot('assets-sections', { full: true });
  const sgb = await evaluate(`[...document.querySelectorAll('a.list-row')].find((a) => a.textContent.includes('SGB 2020-21'))?.getAttribute('href')`);
  await go(sgb);
  await waitFor(`document.querySelector('h1')?.textContent.includes('SGB 2020-21')`, 'imported bond detail');
  const bondDetail = await text('main');
  assert(bondDetail.includes('₹1,50,240') && bondDetail.includes('Government Securities') && bondDetail.includes('IN30009512345678') && bondDetail.includes('IN0020200195') && bondDetail.includes('10 Nov 2028'), `bond value, type, account, ISIN and maturity shown (${bondDetail})`);
  await shot('bond-detail', { full: true });
  await go(`${sgb}/edit`);
  await waitFor(`document.querySelector('[name="hasStartDate"]')`, 'bond edit form');
  const bondForm = await evaluate(`({ accrual: document.querySelector('[name="hasStartDate"]').checked, value: document.querySelector('[name="currentValuation"]').closest('[data-show-if]').hidden, start: document.querySelector('[name="startDate"]').closest('[data-show-if]').hidden, projection: document.querySelector('[data-derived="projection"]').hidden })`);
  assert(!bondForm.accrual && !bondForm.value && bondForm.start && bondForm.projection, `market-valued bond edits its current value (${JSON.stringify(bondForm)})`);
  await shot('bond-edit');

  step('Next month’s statement: updates, and removes a bond no longer held');
  // Seven more FDs, and a bond an earlier import brought in that this statement no longer lists, from a backup made
  // when bonds and FDs shared one category: the FDs move to Fixed Deposits and the NCD to Bonds.
  const now = Date.now();
  const extra = [
    ...Array.from({ length: 7 }, (_, i) => createAsset({ category: 'Bonds & FDs', name: `Bank FD ${i + 1}`, investedAmount: 100000, currentValuation: 100000 }, now)),
    createAsset({ category: 'Bonds & FDs', name: 'Matured NCD', isin: 'INE000X07ZZ1', folio: 'IN30009512345678', instrument: 'Corporate Bonds', investedAmount: 50000, currentValuation: 50000 }, now),
  ];
  const extraFile = join(downloads, 'more-assets.json');
  await writeFile(extraFile, exportBackup({ assets: extra, ppfRates: OFFICIAL_HISTORY }));
  await go('#/settings');
  await waitFor(`document.querySelector('[data-action="import"]')`, 'settings');
  await chooseFile('[data-action="import"]', extraFile);
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Imported 8 assets')`, 'extra assets imported');
  await openNSDL();
  const monthly = await evaluate(reviewRows);
  assert((await evaluate(reviewHeadings)).at(-1) === 'No Longer in the Statement · 1', 'removals listed last');
  assert(monthly.at(-1).includes('Matured NCD') && monthly.at(-1).includes('Remove'), `stale bond to be removed (${monthly.at(-1)})`);
  assert(monthly.filter((r) => r.includes('No change')).length === 7, `unchanged holdings marked (${JSON.stringify(monthly)})`);
  await shot('monthly-review', { full: true });
  await untick('GOI LOAN');
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Updated 7, removed 1 no longer held')`, 'monthly import toast');
  await waitFor(`location.hash === '#/assets' && ${ROWS} === ${assetCount + 17}`, 'stale bond removed, nothing duplicated');
  assert(!(await text('main')).includes('Matured NCD'), 'stale bond gone');
  assert(await evaluate(`${fdGroup}.textContent.includes('Bank FD 1') && !${groupNamed('Bonds')}.textContent.includes('Bank FD')`), 'old combined-category FDs moved to Fixed Deposits');

  step('Long sections show five, then all');
  const other = `[...document.querySelectorAll('[data-action="toggle-group"]')].find((b) => b.dataset.group === 'fd')`;
  assert(await evaluate(`${other}?.textContent.trim() === 'Show all 9' && ${other}.getAttribute('aria-expanded') === 'false'`), 'Fixed Deposits folds to five');
  await shot('assets-collapsed', { full: true });
  await evaluate(`${other}.click()`);
  await waitFor(`${other}?.textContent.includes('Show fewer') && document.querySelectorAll('a.list-row').length === ${assetCount + 17}`, 'section expanded');
  await shot('assets-expanded', { full: true });
  await go('#/assets');

  step('Import an NPS statement: updates the NPS account with its PRAN');
  await click('details.menu > summary');
  await chooseFile('[data-action="import-nps"]', fileURLToPath(new URL('../tests/fixtures/sample-nps.pdf', import.meta.url)));
  await waitFor(`document.querySelector('dialog[open] .cas-list')`, 'NPS review dialog', 15_000);
  assert((await text('dialog h2')) === 'Update NPS Account', `NPS review title (${await text('dialog h2')})`);
  const npsReview = await evaluate(reviewRows);
  assert(npsReview.length === 5 && npsReview[1].includes('Scheme E · Equity') && npsReview[1].includes('4,250.1234 units'), `schemes listed (${JSON.stringify(npsReview)})`);
  assert(npsReview[0].includes('NPS Tier 1') && npsReview[0].includes('₹5,36,800 →') && npsReview[0].includes('₹4,87,006') && npsReview[0].includes('Update'), `seed NPS updated first (${npsReview[0]})`);
  assert((await text('dialog form')).includes('The schemes add up to'), 'scheme total checked');
  await shot('nps-review', { full: true });
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Updated NPS Tier 1 to ₹4,87,006')`, 'NPS import toast');
  await waitFor(`location.hash.startsWith('#/asset/') && document.querySelector('h1')?.textContent.includes('NPS Tier 1')`, 'NPS detail');
  const npsDetail = await text('main');
  assert(npsDetail.includes('₹4,20,000') && npsDetail.includes('65.7%') && npsDetail.includes('1.3%') && npsDetail.includes('8,150.6234') && npsDetail.includes('31 Oct 2026'), `NPS value, split, units and date (${npsDetail})`);
  await shot('nps-detail', { full: true });
  await go('#/assets');
  await waitFor(`${ROWS} === ${assetCount + 17}`, 'no NPS duplicate');

  step('Import a PPF statement: replaces the deposits entered by hand');
  await click('details.menu > summary');
  await chooseFile('[data-action="import-ppf"]', fileURLToPath(new URL('../tests/fixtures/sample-ppf.pdf', import.meta.url)));
  await waitFor(`document.querySelector('dialog[open] .cas-list')`, 'PPF review dialog', 15_000);
  assert((await text('dialog h2')) === 'Update PPF Account', `PPF review title (${await text('dialog h2')})`);
  const ppfReview = await evaluate(reviewRows);
  assert(ppfReview.length === 4 && ppfReview[0].includes('PPF — renamed') && ppfReview[0].includes('Balance ₹2,50,000') && ppfReview[0].includes('Opening ₹1,50,000'), `seed PPF updated (${JSON.stringify(ppfReview)})`);
  assert(ppfReview[1].includes('4 Oct 2026') && ppfReview[3].includes('5 Apr 2026') && ppfReview[3].includes('Balance ₹2,00,000'), `transactions newest first (${JSON.stringify(ppfReview)})`);
  assert((await text('dialog form')).includes('Replaces the opening balance and deposits you entered by hand'), 'adopting the hand-added PPF explained');
  await shot('ppf-review', { full: true });
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Updated PPF — renamed')`, 'PPF import toast');
  await waitFor(`location.hash === '${ppfHref}'`, 'PPF detail');
  const ppfDetail = await text('main');
  assert(ppfDetail.includes('9999PPF0000000001234') && ppfDetail.includes('₹1,50,000') && ppfDetail.includes('3 Jul 2026') && !ppfDetail.includes('Monthly SI'), `statement's account, opening and deposits (${ppfDetail})`);
  await shot('ppf-imported', { full: true });
  await go('#/assets');
  await waitFor(`${ROWS} === ${assetCount + 17}`, 'no PPF duplicate');

  step('Gold: grams valued at the day’s rate for their purity');
  await go('#/new/gold');
  await waitFor(`document.querySelector('[name="goldGrams"]')`, 'gold form');
  assert(await evaluate(`document.querySelector('[name="goldKarat"]').value === '24'`), '24K by default');
  assert((await text('[data-derived="gold-value"]')).includes('Valued once today’s gold rate is fetched'), 'no rate yet');
  await fill('[name="name"]', 'Digital gold');
  await fill('[name="institution"]', 'Example app');
  await fill('[name="goldGrams"]', '2.5');
  await fill('[name="investedAmount"]', '20000');
  await shot('gold-form', { full: true });
  await click('[data-save]');
  await waitFor(`location.hash === '#/assets'`, 'back after saving gold');
  // Saving the first gold holding fetches the rate (₹10,000/g for 24K here) and values it.
  await waitFor(`${ROWS} === ${assetCount + 18} && [...document.querySelectorAll('a.list-row')].some((r) => r.textContent.includes('Example app · 2.5 g · 24K') && r.textContent.includes('₹25,000'))`, 'gold listed at today’s rate', 15_000);
  const goldHref = await evaluate(`[...document.querySelectorAll('a.list-row')].find((r) => r.textContent.includes('Digital gold'))?.getAttribute('href')`);
  await go(goldHref);
  await waitFor(`document.querySelector('main').textContent.includes('Rate date')`, 'gold detail');
  const goldDetail = await text('main');
  assert(goldDetail.includes('2.5 g') && goldDetail.includes('24K (99.9%)') && goldDetail.includes('₹10,000/g') && goldDetail.includes('10 Nov 2026') && goldDetail.includes('₹25,000'), `gold weight, purity, rate and value (${goldDetail})`);
  await shot('gold-detail', { full: true });
  await go('#/new/gold');
  await waitFor(`document.querySelector('[data-derived="gold-value"]')?.textContent.includes('₹10,000/g')`, 'rate known in the form');
  await fill('[name="name"]', 'Chain');
  await fill('[name="goldGrams"]', '10');
  await fill('[name="goldKarat"]', '22');
  await waitFor(`document.querySelector('[data-derived="gold-value"]').textContent.includes('₹9,160/g') && document.querySelector('[data-derived="gold-value"]').textContent.includes('₹91,600')`, '22K rate and value');
  await click('[data-save]');
  await waitFor(`location.hash === '${goldHref}'`, 'back after saving the chain');
  await go('#/dashboard');
  await waitFor(`document.querySelector('.status')?.textContent.includes('Gold at ₹10,000/g for 24K (5paisa · Hyderabad, 10 Nov 2026)')`, 'gold rate on Net Worth');
  assert(await evaluate(`document.querySelector('.legend li[data-slice="gold"]')?.textContent.includes('₹1.17 L')`), 'gold slice on the donut');
  await shot('dashboard-gold', { full: true });
  await go('#/assets');
  await waitFor(`${ROWS} === ${assetCount + 19}`, 'two gold holdings');

  step('Sync: set up with a GitHub token → an encrypted gist is created');
  await go('#/settings');
  await waitFor(`document.querySelector('[data-action="sync-setup"]')`, 'sync section');
  await click('[data-action="sync-setup"]');
  await waitFor(`document.querySelector('dialog[open] [name="token"]')`, 'token dialog');
  await shot('sync-token');
  await fill('dialog [name="token"]', 'ghp_wrong');
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('dialog [data-error]')?.textContent.includes('access token')`, 'bad token explained');
  await fill('dialog [name="token"]', 'ghp_test');
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('dialog[open] [name="confirm"]')`, 'create passphrase dialog');
  assert((await text('dialog h2')) === 'Create Sync Passphrase', 'no synced data yet');
  await fill('dialog [name="passphrase"]', SYNC_PASSPHRASE);
  await fill('dialog [name="confirm"]', SYNC_PASSPHRASE);
  await shot('sync-passphrase-new');
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.startsWith('Sync is on')`, 'sync on', 15_000);
  await waitFor(`document.querySelector('[data-sync-status]')?.textContent.startsWith('Synced')`, 'synced status');
  assert(github.gists.size === 1, 'one gist');
  const gistText = [...github.gists.values()][0].files[SYNC_FILE].content;
  assert(!/renamed|PPF|HDFC|Savings|Digital gold/.test(gistText), 'gist holds only ciphertext');
  await shot('settings-sync-on', { full: true });

  step('Sync: a change made on another device arrives');
  await editSyncedCopy((data) => {
    data.assets.find((a) => a.name === 'PPF — renamed').name = 'PPF — from the laptop';
    data.assets.push({ ...structuredClone(data.assets[0]), id: 'E2E-SYNCED-ASSET', name: 'Added on the laptop' });
  });
  await click('[data-action="sync-now"]');
  await waitFor(`document.querySelector('#toast.show')?.textContent === 'Synced.'`, 'synced toast');
  await go('#/assets');
  await waitFor(`document.querySelector('main').textContent.includes('PPF — from the laptop') && ${ROWS} === ${assetCount + 20}`, 'remote rename and new asset');

  step('Sync: an edit here goes up on its own');
  await go(ppfHref);
  await waitFor(`document.querySelector('[data-action="add-entry"]')`, 'PPF detail');
  await evaluate(`document.querySelector('a[href$="/edit"]').click()`);
  await waitFor(`document.querySelector('input[name="name"]')`, 'edit form');
  await fill('input[name="name"]', 'PPF — edited on the phone');
  await evaluate(`document.querySelector('form[data-form]').requestSubmit()`);
  const syncedName = async () => (await readSyncedCopy()).data.assets.map((a) => a.name);
  const end = Date.now() + 10_000;
  while (!(await syncedName()).includes('PPF — edited on the phone') && Date.now() < end) await sleep(300);
  const syncState = await evaluate(`new Promise((done) => { const r = indexedDB.open('wealthtracker'); r.onsuccess = () => {
    const g = r.result.transaction('kv').objectStore('kv').get('vault'); g.onsuccess = () => { const s = g.result.settings?.sync; done(JSON.stringify({ lastSync: s?.lastSync, lastError: s?.lastError, names: g.result.assets.map((a) => a.name).filter((n) => n.startsWith('PPF')) })); r.result.close(); }; }; })`);
  assert((await syncedName()).includes('PPF — edited on the phone'), `edit pushed without tapping Sync Now (${syncState}; gist: ${(await syncedName()).filter((n) => n.startsWith('PPF'))}; calls: ${github.calls.slice(-6)})`);

  step('Sync: a new device (erased) gets everything back');
  await go('#/settings');
  await waitFor(`document.querySelector('[data-action="erase-everything"]')`, 'settings');
  await click('[data-action="erase-everything"]');
  await waitFor(`document.querySelector('dialog[open]')?.textContent.includes('synced copy on GitHub is kept')`, 'erase explains sync');
  await click('dialog button[value="ok"]');
  await waitFor(`document.querySelector('[data-action="setup-plain"]')`, 'welcome');
  assert((await text('.gate')).includes('turn on Sync in Settings'), 'welcome mentions sync');
  await click('[data-action="setup-plain"]');
  await go('#/settings');
  await waitFor(`document.querySelector('[data-action="sync-setup"]')`, 'sync section');
  await click('[data-action="sync-setup"]');
  await waitFor(`document.querySelector('dialog[open] [name="token"]')`, 'token dialog');
  await fill('dialog [name="token"]', 'ghp_test');
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('dialog h2')?.textContent === 'Enter Sync Passphrase'`, 'existing sync found');
  assert(!(await evaluate(`document.querySelector('dialog [name="confirm"], dialog [name="mode"]')`)), 'no confirm or combine choice on an empty device');
  await fill('dialog [name="passphrase"]', 'not-the-passphrase');
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('dialog [data-error]')?.textContent.includes('not the sync passphrase')`, 'wrong passphrase', 15_000);
  await shot('sync-passphrase-wrong');
  await fill('dialog [name="passphrase"]', SYNC_PASSPHRASE);
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.startsWith('Sync is on. ${assetCount + 20} assets')`, 'data restored', 15_000);
  await go('#/assets');
  await waitFor(`${ROWS} === ${assetCount + 20} && document.querySelector('main').textContent.includes('PPF — edited on the phone')`, 'every asset back');
  assert(github.gists.size === 1, 'still one gist');

  step('Turn on passcode → data encrypted at rest');
  await go('#/settings');
  await waitFor(`document.querySelector('[data-action="set-passcode"]')`, 'settings');
  await click('[data-action="set-passcode"]');
  await waitFor(`document.querySelector('dialog[open] [name="next"]')`, 'passcode dialog');
  await fill('dialog [name="next"]', PASSCODE);
  await fill('dialog [name="confirm"]', PASSCODE);
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Passcode on')`, 'passcode on', 15_000);
  const atRest = await evaluate(`new Promise((done) => { const r = indexedDB.open('wealthtracker'); r.onsuccess = () => {
    const g = r.result.transaction('kv').objectStore('kv').get('vault'); g.onsuccess = () => { const v = g.result; done({ keys: Object.keys(v).sort().join(','), plain: JSON.stringify(v).includes('edited on the phone') }); r.result.close(); }; }; })`);
  assert(atRest.keys === 'data,iv' && !atRest.plain, `vault is ciphertext (${JSON.stringify(atRest)})`);

  step('Lock → wrong passcode → unlock');
  await click('[data-action="lock-now"]');
  await waitFor(`document.querySelector('form[data-form="unlock"]')`, 'lock screen');
  await shot('locked');
  await fill('[name="passcode"]', 'wrong-passcode');
  await evaluate(`document.querySelector('form[data-form="unlock"]').requestSubmit()`);
  await waitFor(`document.querySelector('[data-error]')?.textContent === 'Wrong passcode.'`, 'wrong passcode message', 15_000);
  await fill('[name="passcode"]', PASSCODE);
  await evaluate(`document.querySelector('form[data-form="unlock"]').requestSubmit()`);
  await waitFor(`document.querySelector('a.list-row') || document.querySelector('.card.summary') || document.querySelector('[data-action="export"]')`, 'unlocked', 15_000);

  step('Reload stays locked, then unlocks');
  await send('Page.reload');
  await waitFor(`document.querySelector('form[data-form="unlock"]')`, 'locked after reload');
  await fill('[name="passcode"]', PASSCODE);
  await evaluate(`document.querySelector('form[data-form="unlock"]').requestSubmit()`);
  await waitFor(`document.querySelector('[data-action="export"]')`, 'back in settings', 15_000);

  step('Dark mode');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await go('#/dashboard');
  await waitFor(`document.querySelector('.card.summary')`, 'dashboard');
  await shot('dashboard-dark', { full: true });
  await go(ppfHref);
  await waitFor(`document.querySelector('[data-action="add-entry"]')`, 'detail');
  await shot('ppf-detail-dark');
  await go('#/settings');
  await waitFor(`document.querySelector('[data-action="export"]')`, 'settings');
  await click('[data-action="delete-all"]');
  await waitFor(`document.querySelector('dialog[open]')`, 'confirm dialog');
  await shot('confirm-dark');
  await evaluate(`document.querySelector('dialog').close('cancel')`);

  step('Desktop layout');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await setViewport(1280, 900);
  await go('#/dashboard');
  await waitFor(`document.querySelector('.card.summary')`, 'dashboard');
  await shot('desktop-dashboard');
  await go('#/assets');
  await waitFor(`document.querySelector('a.list-row')`, 'assets');
  await shot('desktop-assets');

  step('Offline: service worker serves the app');
  await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const version = sw.match(/const VERSION = '([^']+)'/)[1];
  const cachedURLs = await evaluate(`caches.open('${version}').then((c) => c.keys()).then((k) => k.map((r) => new URL(r.url).pathname))`);
  const precache = sw.match(/PRECACHE = \[([\s\S]*?)\]/)[1].match(/'[^']+'/g).length;
  const lazy = cachedURLs.filter((p) => /\/(vendor|data)\//.test(p));
  assert(cachedURLs.length - lazy.length === precache, `all ${precache} files precached (got ${cachedURLs.length - lazy.length})`);
  // Used by the CAS import above, so cached on first use.
  assert(['pdf.min.mjs', 'pdf.worker.min.mjs', 'isin-amfi.json'].every((f) => lazy.some((p) => p.endsWith(f))), `PDF reader and ISIN map cached (${lazy})`);
  expectNetworkErrors = true;
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.reload');
  await waitFor(`document.querySelector('form[data-form="unlock"]')`, 'app loads offline');
  await fill('[name="passcode"]', PASSCODE);
  await evaluate(`document.querySelector('form[data-form="unlock"]').requestSubmit()`);
  await waitFor(`document.querySelector('a.list-row')`, 'data available offline', 15_000);

  if (problems.length) throw new Error(`Console problems:\n  ${problems.join('\n  ')}`);
  console.log(`\n✓ All end-to-end checks passed. Screenshots: ${SHOTS}`);
} catch (e) {
  await shot('FAILURE').catch(() => {});
  console.error(`\n✗ ${e.message}`);
  const where = await evaluate(`({ hash: location.hash, h1: document.querySelector('h1')?.textContent, depth: history.state?.depth, length: history.length })`).catch(() => null);
  console.error(`  at ${JSON.stringify(where)}`);
  if (problems.length) console.error(`Console problems:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} finally {
  await cdp.close();
  server.close();
  if (existsSync(downloads)) await rm(downloads, { recursive: true, force: true });
  await rm(resolve(portfolioFile, '..'), { recursive: true, force: true });
}
