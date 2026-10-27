import { assetFromHolding, CASError, parseCAS, planCASImport } from '../core/cas.js';
import { formatDate, inr, number } from '../core/format.js';
import { hideToast, pickFile, showDialog, toast } from '../ui/dom.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { pdfLines, PDFPasswordError } from '../ui/pdf.js';

export const CAS_HELP =
  'Request a Detailed Consolidated Account Statement (CAMS + KFintech) on camsonline.com or kfintech.com. It arrives by email as a PDF locked with the password you choose. The PDF is read on this device and never uploaded.';

/** ISIN → AMFI scheme code, bundled so no scheme list is fetched. Without it, funds keep the statement's NAV. */
async function loadSchemeMap() {
  try {
    const res = await fetch(new URL('../../data/isin-amfi.json', import.meta.url));
    return res.ok ? (await res.json()).schemes ?? {} : {};
  } catch {
    return {};
  }
}

function passwordDialog(incorrect) {
  return showDialog(
    html`<form method="dialog" class="sheet">
      <h2>Statement Password</h2>
      <p class="muted">Enter the password you set when requesting this statement.</p>
      <label class="field stacked">
        <span class="visually-hidden">Password</span>
        <input type="password" name="password" autocomplete="off" autocapitalize="off" spellcheck="false" required autofocus>
      </label>
      ${incorrect ? html`<p class="small neg" role="alert">${icon('warning')} Incorrect password. Try again.</p>` : ''}
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn btn-primary">Open</button>
      </div>
    </form>`,
    { collect: (form) => form.password.value },
  );
}

/** Reads the PDF, asking for the password until it opens or the user cancels (→ null). */
async function readStatement(file) {
  const data = await file.arrayBuffer();
  let password;
  for (;;) {
    toast('Reading statement…', { duration: Infinity });
    try {
      return await pdfLines(data, password);
    } catch (e) {
      if (!(e instanceof PDFPasswordError)) throw e;
      hideToast();
      password = await passwordDialog(e.incorrect);
      if (password == null) return null;
    } finally {
      hideToast();
    }
  }
}

function reviewRow({ item, asset }) {
  const h = item.holding;
  const before = item.existing?.unitsHeld;
  const units = item.action === 'update' && before !== h.units ? html`${number(before ?? 0, 3)} → ${number(h.units, 3)} units` : html`${number(h.units, 3)} units`;
  return html`<li class="cas-item">
    <span class="stack">
      <span class="name">${asset.name}</span>
      <span class="muted small">Folio ${h.folio} · ${units}</span>
    </span>
    <span class="stack end">
      <span class="num">${inr(asset.currentValuation)}</span>
      <span class="small ${item.action === 'new' ? 'pos' : 'muted'}">${item.action === 'new' ? 'New' : 'Update'}</span>
    </span>
  </li>`;
}

function reviewDialog(statement, rows, skipped) {
  const noCode = rows.filter((r) => !r.asset.amfiCode).length;
  const total = rows.reduce((s, r) => s + r.asset.currentValuation, 0);
  const notes = [
    skipped && `${skipped} fully redeemed fund${skipped === 1 ? '' : 's'} with no units left won’t be added.`,
    noCode && `${noCode} fund${noCode === 1 ? '' : 's'} couldn’t be matched to an AMFI code, so ${noCode === 1 ? 'it keeps' : 'they keep'} the statement’s NAV until you add one.`,
  ].filter(Boolean);
  return showDialog(
    html`<form method="dialog" class="sheet">
      <h2>Import ${rows.length} Fund${rows.length === 1 ? '' : 's'}</h2>
      <p class="muted">${statement.asOf != null ? `Statement as on ${formatDate(statement.asOf)} · ` : ''}${inr(total)} in total. Units and cost come from the statement; NAVs refresh from mfapi.in afterwards.</p>
      <ul class="cas-list plain-list">${rows.map(reviewRow)}</ul>
      ${notes.map((n) => html`<p class="small muted">${icon('info')} ${n}</p>`)}
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn btn-primary" data-ok>Import</button>
      </div>
    </form>`,
    { className: 'wide' },
  );
}

/** Picks a CAS PDF, previews what changes, and saves the funds. */
export async function importCAS({ store, navigate }) {
  const file = await pickFile('.pdf,application/pdf');
  if (!file) return;
  try {
    const lines = await readStatement(file);
    if (!lines) return;
    const statement = parseCAS(lines);
    const schemes = await loadSchemeMap();
    const now = Date.now();
    const plan = planCASImport(statement, store.assets, schemes);
    const rows = plan.filter((item) => item.action !== 'skip').map((item) => ({ item, asset: assetFromHolding(item, store.rates, now) }));
    if (!rows.length) {
      toast('Every fund in this statement has been fully redeemed — nothing to import.', { duration: 6000 });
      return;
    }
    if ((await reviewDialog(statement, rows, plan.length - rows.length)) !== 'ok') return;
    await store.upsertMany(rows.map((r) => r.asset));
    navigate('#/assets');
    toast(`Imported ${rows.length} fund${rows.length === 1 ? '' : 's'}.`);
    await store.refresh();
  } catch (e) {
    const message = e instanceof CASError ? e.message : `Couldn’t read the statement: ${e.message}`;
    toast(message, { kind: 'error', duration: 8000 });
  }
}
