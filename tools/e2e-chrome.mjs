// End-to-end check in real headless Chrome over the DevTools protocol. No dependencies.
//   npm run test:e2e                 (screenshots go to ./e2e-shots, or SHOTS_DIR)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = resolve(process.env.SHOTS_DIR ?? 'e2e-shots');
const PASSCODE = 'correct-horse-7';
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
  problems.push(`log: ${entry.text} ${entry.url ?? ''}`);
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

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

  step('Load sample portfolio');
  await click('[data-action="load-sample"]');
  await waitFor(`document.querySelector('.card.summary')`, 'summary card');
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
  const assetCount = await evaluate(`document.querySelectorAll('a.list-row').length`);
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

  step('New bond with live projection');
  await go('#/new/bonds');
  await waitFor(`document.querySelector('[name="interestRate"]')`, 'bond form');
  assert(await evaluate(`document.querySelector('[data-save]').disabled`), 'Save disabled while empty');
  await fill('[name="name"]', 'SBI FD');
  await fill('[name="investedAmount"]', '200000');
  await fill('[name="interestRate"]', '7.1');
  await waitFor(`document.querySelector('[data-derived="projection"]')?.textContent.includes('Value today')`, 'projection');
  await shot('bond-form', { full: true });
  await click('[data-save]');
  // Save steps back to wherever "New" was opened from (the PPF detail here).
  await waitFor(`location.hash === '${ppfHref}'`, 'back after saving the bond');
  await go('#/assets');
  await waitFor(`document.querySelectorAll('a.list-row').length === ${assetCount + 1}`, 'bond saved');
  assert(await evaluate(`[...document.querySelectorAll('a.list-row .name')].some((n) => n.textContent === 'SBI FD')`), 'bond listed');
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
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  await chooseFile('[data-action="import"]', join(downloads, backupFile));
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Imported ${assetCount + 1} assets')`, 'import toast');
  await go('#/assets');
  await waitFor(`document.querySelectorAll('a.list-row').length === ${assetCount + 1}`, 'no duplicates after import');

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
  // The sample portfolio's HDFC Flexi Cap (same AMFI code, no folio) is updated rather than duplicated.
  assert(review.some((r) => r.includes('HDFC Flexi Cap Fund – Direct Growth') && r.includes('412.537 → 112.345') && r.includes('Update')), 'HDFC updated');
  assert((await text('dialog h2')) === 'Import 3 Funds', 'review title');
  assert((await text('dialog form')).includes('1 fully redeemed fund'), 'redeemed fund noted');
  await shot('cas-review');
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Imported 3 funds')`, 'CAS import toast');
  await waitFor(`location.hash === '#/assets' && document.querySelectorAll('a.list-row').length === ${assetCount + 3}`, 'two new funds listed');
  const ppfas = await evaluate(`[...document.querySelectorAll('a.list-row')].find((a) => a.textContent.includes('Parag Parikh'))?.getAttribute('href')`);
  assert(ppfas, 'Parag Parikh fund listed');
  await waitFor(`!document.querySelector('[data-action="refresh"]')?.disabled`, 'NAV refresh finished', 20_000);
  await go(ppfas);
  await waitFor(`document.querySelector('h1')?.textContent.includes('Parag Parikh')`, 'imported fund detail');
  const detail = await text('main');
  assert(detail.includes('9876543') && detail.includes('INF879O01027') && detail.includes('122639') && detail.includes('1,226.388'), 'folio, ISIN, AMFI code and units shown');
  await shot('cas-fund-detail', { full: true });
  await go('#/assets');

  step('Import bonds from an NSDL statement, unticking one');
  await click('details.menu > summary');
  await chooseFile('[data-action="import-cas"]', fileURLToPath(new URL('../tests/fixtures/sample-nsdl.pdf', import.meta.url)));
  await waitFor(`document.querySelector('dialog[open] [name="password"]')`, 'password dialog', 15_000);
  await fill('dialog [name="password"]', 'ABCDE1234F');
  await click('dialog .btn-primary');
  await waitFor(`document.querySelector('dialog[open] .cas-list')`, 'bond review dialog', 15_000);
  assert((await text('dialog h2')) === 'Import 3 Bonds', 'bond review title');
  const bonds = await evaluate(`[...document.querySelectorAll('dialog .cas-item')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim())`);
  assert(bonds.some((r) => r.includes('SGB 2020-21 SERIES VIII') && r.includes('2.5%') && r.includes('₹1,50,240') && r.includes('New')), `SGB listed (${JSON.stringify(bonds)})`);
  await shot('bond-review');
  await evaluate(`[...document.querySelectorAll('dialog .cas-item')].find((l) => l.textContent.includes('GOI LOAN')).querySelector('input').click()`);
  await click('dialog [data-ok]');
  await waitFor(`document.querySelector('#toast.show')?.textContent.includes('Imported 2 bonds')`, 'bond import toast');
  await waitFor(`location.hash === '#/assets' && document.querySelectorAll('a.list-row').length === ${assetCount + 5}`, 'two bonds added');
  assert(!(await text('main')).includes('GOI LOAN'), 'unticked bond not imported');
  const sgb = await evaluate(`[...document.querySelectorAll('a.list-row')].find((a) => a.textContent.includes('SGB 2020-21'))?.getAttribute('href')`);
  await go(sgb);
  await waitFor(`document.querySelector('h1')?.textContent.includes('SGB 2020-21')`, 'imported bond detail');
  const bondDetail = await text('main');
  assert(bondDetail.includes('₹1,50,240') && bondDetail.includes('IN30009512345678') && bondDetail.includes('IN0020200195') && bondDetail.includes('10 Nov 2028'), `bond value, account, ISIN and maturity shown (${bondDetail})`);
  await shot('bond-detail', { full: true });
  await go(`${sgb}/edit`);
  await waitFor(`document.querySelector('[name="hasStartDate"]')`, 'bond edit form');
  const bondForm = await evaluate(`({ accrual: document.querySelector('[name="hasStartDate"]').checked, value: document.querySelector('[name="currentValuation"]').closest('[data-show-if]').hidden, start: document.querySelector('[name="startDate"]').closest('[data-show-if]').hidden, projection: document.querySelector('[data-derived="projection"]').hidden })`);
  assert(!bondForm.accrual && !bondForm.value && bondForm.start && bondForm.projection, `market-valued bond edits its current value (${JSON.stringify(bondForm)})`);
  await shot('bond-edit');
  await go('#/assets');

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
    const g = r.result.transaction('kv').objectStore('kv').get('vault'); g.onsuccess = () => { const v = g.result; done({ keys: Object.keys(v).sort().join(','), plain: JSON.stringify(v).includes('renamed') }); r.result.close(); }; }; })`);
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
}
