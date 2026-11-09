import { assetFromHolding, CASError, parseCAS, planCASImport } from '../core/cas.js';
import { byName } from '../core/assets.js';
import { Category } from '../core/categories.js';
import { bondFromHolding, goneFromStatement, INSTRUMENT_ORDER, isDepositoryStatement, parseDemat, planBondImport } from '../core/demat.js';
import { formatDate, inr, number, plainNumber } from '../core/format.js';
import { hideToast, pickFile, showDialog, toast } from '../ui/dom.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { pdfRows, PDFPasswordError } from '../ui/pdf.js';
import { latestNAVs } from '../core/mfapi.js';
import { isNPSStatement } from '../core/nps.js';
import { importNPS } from './npsImport.js';
import { isPPFStatement } from '../core/ppfStatement.js';
import { importPPF } from './ppfImport.js';

export const CAS_HELP =
  'Mutual funds: request a Detailed Consolidated Account Statement on camsonline.com or kfintech.com; it arrives by email as a PDF locked with the password you choose. Bonds, SGBs, NCDs and funds in a demat account: use the monthly NSDL or CDSL CAS emailed to you (usually locked with your PAN). NPS: download the Transaction Statement for your tier from the CRA site (Protean). PPF: download the account statement from 1 April of this financial year from your bank (Axis Bank’s layout is supported). The PDF is read on this device and never uploaded.';

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
      return await pdfRows(data, password);
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

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const checkbox = (i) => html`<input type="checkbox" name="pick" value="${i}" checked>`;
function status(item, changed) {
  if (item.action === 'new') return html`<span class="small pos">New</span>`;
  return html`<span class="small muted">${changed ? 'Update' : 'No change'}</span>`;
}

function bondRow({ item, asset }, i) {
  const h = item.holding;
  const before = item.existing?.currentValuation;
  const changed = before !== asset.currentValuation;
  const detail = [h.isin, asset.interestRate != null && `${plainNumber(asset.interestRate)}%`, asset.maturityDate != null && `Matures ${formatDate(asset.maturityDate)}`]
    .filter(Boolean)
    .join(' · ');
  return html`<li><label class="cas-item">
    ${checkbox(i)}
    <span class="stack">
      <span class="name">${asset.name}</span>
      <span class="muted small">${detail}</span>
    </span>
    <span class="stack end">
      <span class="num">${item.action === 'update' && changed ? html`<span class="muted small">${inr(before ?? 0)} →</span> ` : ''}${inr(asset.currentValuation)}</span>
      ${status(item, changed)}
    </span>
  </label></li>`;
}

function fundRow({ item, asset }, i) {
  const h = item.holding;
  const before = item.existing?.unitsHeld;
  const changed = before !== h.units;
  const units = item.action === 'update' && changed ? `${number(before ?? 0, 3)} → ${number(h.units, 3)} units` : `${number(h.units, 3)} units`;
  return html`<li><label class="cas-item">
    ${checkbox(i)}
    <span class="stack">
      <span class="name">${asset.name}</span>
      <span class="muted small">${h.isin} · ${units}</span>
    </span>
    <span class="stack end">
      <span class="num">${inr(asset.currentValuation)}</span>
      ${status(item, changed)}
    </span>
  </label></li>`;
}

function goneRow(asset, i) {
  const detail = [asset.isin, asset.category === Category.mutualFund ? 'Mutual fund' : asset.instrument, asset.maturityDate != null && `Matures ${formatDate(asset.maturityDate)}`]
    .filter(Boolean)
    .join(' · ');
  return html`<li><label class="cas-item">
    <input type="checkbox" name="drop" value="${i}" checked>
    <span class="stack">
      <span class="name">${asset.name}</span>
      <span class="muted small">${detail}</span>
    </span>
    <span class="stack end">
      <span class="num muted">${inr(asset.currentValuation)}</span>
      <span class="small neg">Remove</span>
    </span>
  </label></li>`;
}

const sectionRank = (name) => {
  const i = INSTRUMENT_ORDER.indexOf(name);
  return i < 0 ? INSTRUMENT_ORDER.length : i;
};

/**
 * The statement's holdings in its own sections (Mutual Funds, Corporate Bonds, Securitised Instruments…), each with the
 * total read from it, set against the total the statement's summary gives for that section.
 */
function sectionsOf(rows, summary) {
  const bySection = new Map();
  rows.forEach((r, i) => {
    const name = r.item.holding.section ?? 'Bonds';
    if (!bySection.has(name)) bySection.set(name, []);
    bySection.get(name).push({ r, i });
  });
  return [...bySection]
    .sort(([a], [b]) => sectionRank(a) - sectionRank(b) || a.localeCompare(b))
    .map(([name, entries]) => {
      const total = entries.reduce((sum, { r }) => sum + r.item.holding.value, 0);
      const stated = summary?.[name];
      return { name, entries, total, stated, matches: stated == null ? null : Math.abs(stated - total) < 1 };
    });
}

/** Review of a demat statement, section by section, plus what earlier imports hold that the statement no longer lists. */
function dematReviewDialog(statement, fundRows, bondRows, gone) {
  const rows = [...fundRows, ...bondRows];
  const sections = sectionsOf(rows, statement.summary);
  const what = [fundRows.length && plural(fundRows.length, 'Fund'), bondRows.length && plural(bondRows.length, 'Bond')].filter(Boolean).join(' and ');
  const heading = (title, count, total) =>
    html`<li class="cas-heading split"><span>${title} · ${count}</span>${total != null ? html`<span class="num">${inr(total)}</span>` : ''}</li>`;
  const checked = sections.filter((s) => s.matches != null);
  const notes = [
    checked.length && checked.every((s) => s.matches) && `${checked.length === 1 ? 'The total matches' : 'Each section’s total matches'} the statement’s summary.`,
    ...checked
      .filter((s) => !s.matches)
      .map((s) => ({ warn: `The statement’s summary shows ${inr(s.stated)} in ${s.name}, but ${inr(s.total)} was read. Check this list against the statement before importing.` })),
    rows.some((r) => r.item.action === 'new') && 'Untick anything you’ve already added by hand, so it isn’t counted twice.',
    gone.length && `${gone.length === 1 ? 'One holding' : `${gone.length} holdings`} from an earlier import ${gone.length === 1 ? 'isn’t' : 'aren’t'} in this statement (sold, matured or redeemed) and will be removed. Untick to keep.`,
    'Shares aren’t imported. Mutual funds held in folios rather than a demat account come from the CAMS/KFintech statement.',
  ].filter(Boolean);
  const intro = [
    statement.asOf != null && `Statement as on ${formatDate(statement.asOf)}.`,
    fundRows.length && 'Funds take their units from the statement and their NAV from mfapi.in.',
    bondRows.length && 'Each bond is valued at the statement’s market value.',
    rows.some((r) => r.item.action === 'new') && 'The statement doesn’t show what you paid, so edit an asset to add its cost and see its gain.',
  ].filter(Boolean).join(' ');
  return showDialog(
    html`<form method="dialog" class="sheet">
      <h2>Import ${what}</h2>
      <p class="muted">${intro}</p>
      <ul class="cas-list plain-list">
        ${sections.map((s) => html`${heading(s.name, s.entries.length, s.total)}${s.entries.map(({ r, i }) => (r.item.holding.units != null ? fundRow(r, i) : bondRow(r, i)))}`)}
        ${gone.length ? html`${heading('No Longer in the Statement', gone.length)}${gone.map(goneRow)}` : ''}
      </ul>
      ${notes.map((n) => html`<p class="small ${n.warn ? 'neg' : 'muted'}">${icon('info')} ${n.warn ?? n}</p>`)}
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn btn-primary" data-ok>Import</button>
      </div>
    </form>`,
    {
      className: 'wide',
      onMount(dialog, form) {
        form.addEventListener('change', () => {
          dialog.querySelector('[data-ok]').disabled = !form.querySelector('[name="pick"]:checked, [name="drop"]:checked');
        });
      },
      collect: (form) => ({
        picked: [...form.querySelectorAll('[name="pick"]:checked')].map((el) => rows[Number(el.value)]),
        dropped: [...form.querySelectorAll('[name="drop"]:checked')].map((el) => gone[Number(el.value)]),
      }),
    },
  );
}

/**
 * Demat statements name a fund only by its fund house ("DSP MUTUAL FUND"), so new funds take their scheme's name from
 * mfapi.in (only the AMFI codes leave the device). Offline, they keep the statement's name until renamed.
 */
async function nameFunds(plan) {
  const codes = plan.filter((item) => item.action === 'new' && item.amfiCode).map((item) => item.amfiCode);
  if (!codes.length) return;
  toast('Looking up fund names…', { duration: Infinity });
  const quotes = await latestNAVs(codes)
    .catch(() => new Map())
    .finally(hideToast);
  for (const item of plan) {
    const quote = quotes.get(item.amfiCode)?.quote;
    if (item.action !== 'new' || !quote) continue;
    if (quote.schemeName) item.holding.scheme = quote.schemeName;
    if (quote.fundHouse) item.holding.amc = quote.fundHouse;
  }
}

/**
 * The monthly NSDL/CDSL statement brings the demat holdings up to date: new bonds and funds are added, the ones already
 * imported take the statement's value, and those it no longer lists are removed.
 */
async function importDemat(pdf, { store, navigate }) {
  const statement = parseDemat(pdf);
  const now = Date.now();
  const { items } = planBondImport(statement, store.assets);
  const bondRows = items.filter((item) => item.action !== 'skip').map((item) => ({ item, asset: bondFromHolding(item, now) }));
  const fundHoldings = statement.funds.map((f) => ({ folio: f.account, isin: f.isin, scheme: f.name, units: f.units, nav: f.nav, value: f.value, section: f.section, navDate: statement.asOf, cost: null }));
  const fundPlan = planCASImport({ holdings: fundHoldings }, store.assets, fundHoldings.length ? await loadSchemeMap() : {});
  await nameFunds(fundPlan);
  const fundRows = fundPlan.filter((item) => item.action !== 'skip').map((item) => ({ item, asset: assetFromHolding(item, store.rates, now) }));
  const matched = new Set([...items, ...fundPlan].map((item) => item.existing?.id).filter(Boolean));
  const gone = goneFromStatement(store.assets, matched).sort(byName);
  if (!bondRows.length && !fundRows.length && !gone.length) {
    toast('No bonds or funds with a balance in this statement — nothing to import.', { duration: 6000 });
    return;
  }
  const choice = await dematReviewDialog(statement, fundRows, bondRows, gone);
  if (!choice || (!choice.picked.length && !choice.dropped.length)) return;
  const { picked, dropped } = choice;
  await store.updateAssets(picked.map((r) => r.asset), dropped.map((a) => a.id));
  navigate('#/assets');
  const added = picked.filter((r) => r.item.action === 'new');
  const newFunds = added.filter((r) => fundRows.includes(r)).length;
  const newBonds = added.length - newFunds;
  const updated = picked.length - added.length;
  const summary = [
    added.length && `added ${[newBonds && plural(newBonds, 'bond'), newFunds && plural(newFunds, 'fund')].filter(Boolean).join(' and ')}`,
    updated && `updated ${updated}`,
    dropped.length && `removed ${dropped.length} no longer held`,
  ].filter(Boolean).join(', ');
  toast(`${summary[0].toUpperCase()}${summary.slice(1)}.`);
  if (picked.some((r) => fundRows.includes(r))) await store.refresh();
}

/**
 * Picks a statement PDF (CAMS/KFintech CAS for funds, NSDL/CDSL CAS for bonds and demat funds, or an NPS transaction
 * statement, or a bank's PPF statement), previews what changes, and saves.
 */
export async function importCAS({ store, navigate }) {
  const file = await pickFile('.pdf,application/pdf');
  if (!file) return;
  try {
    const pdf = await readStatement(file);
    if (!pdf) return;
    const lines = pdf.map((r) => r.text);
    if (isNPSStatement(lines)) {
      await importNPS(pdf, { store, navigate });
      return;
    }
    if (isPPFStatement(lines)) {
      await importPPF(pdf, { store, navigate });
      return;
    }
    if (isDepositoryStatement(lines)) {
      await importDemat(pdf, { store, navigate });
      return;
    }
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
