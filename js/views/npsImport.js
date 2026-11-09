import { gain } from '../core/assets.js';
import { formatDate, inr, number } from '../core/format.js';
import { NPS_CLASSES, npsAssetFrom, parseNPS, planNPSImport } from '../core/nps.js';
import { showDialog, toast } from '../ui/dom.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { signClass } from './common.js';

function schemeRow(s) {
  const kind = NPS_CLASSES[s.assetClass];
  return html`<li class="cas-item">
    <span class="stack">
      <span class="name">${kind ? `Scheme ${s.assetClass} · ${kind.label}` : s.name}</span>
      <span class="muted small">${[s.pfm, `${number(s.units, 4)} units`, `NAV ${inr(s.nav, 4)}`].filter(Boolean).join(' · ')}</span>
    </span>
    <span class="stack end"><span class="num">${inr(s.value)}</span></span>
  </li>`;
}

function accountRow(plan, asset) {
  const before = plan.existing?.currentValuation;
  const changed = plan.action === 'update' && before !== asset.currentValuation;
  const g = gain(asset);
  return html`<li class="cas-item">
    <span class="stack">
      <span class="name">${asset.name}</span>
      <span class="muted small">Contributed ${inr(asset.investedAmount)} · Gain <span class="${signClass(g)}">${inr(g)}</span></span>
    </span>
    <span class="stack end">
      <span class="num">${changed ? html`<span class="muted small">${inr(before ?? 0)} →</span> ` : ''}${inr(asset.currentValuation)}</span>
      <span class="small ${plan.action === 'new' ? 'pos' : 'muted'}">${plan.action === 'new' ? 'New' : changed ? 'Update' : 'No change'}</span>
    </span>
  </li>`;
}

function npsReviewDialog(statement, plan, asset) {
  const schemesTotal = statement.schemes.reduce((s, x) => s + x.value, 0);
  const matches = statement.schemes.length ? Math.abs(schemesTotal - statement.value) < 1 : null;
  const heading = (title, total) => html`<li class="cas-heading split"><span>${title}</span>${total != null ? html`<span class="num">${inr(total)}</span>` : ''}</li>`;
  const notes = [
    matches === true && 'The schemes add up to the statement’s Value of your Holdings.',
    matches === false && { warn: `The statement’s summary shows ${inr(statement.value)}, but its schemes add up to ${inr(schemesTotal)}. The summary’s value is used; check it against the statement.` },
    plan.adopted && `Updates “${plan.existing.name}”, which you added without a PRAN; it takes this statement’s PRAN from now on.`,
    plan.action === 'new' && 'If you’ve already added this account by hand under a different PRAN, delete that one after importing.',
    'Invested is the total you’ve contributed less withdrawals; the asset split is what each scheme holds now.',
  ].filter(Boolean);
  const title = plan.action === 'new' ? 'Import NPS Account' : 'Update NPS Account';
  return showDialog(
    html`<form method="dialog" class="sheet">
      <h2>${title}</h2>
      <p class="muted">${[statement.asOf != null && `Statement as on ${formatDate(statement.asOf)}`, statement.tier, `PRAN ${statement.pran}`].filter(Boolean).join(' · ')}.</p>
      <ul class="cas-list plain-list">
        ${heading('Account')}
        ${accountRow(plan, asset)}
        ${heading(`Schemes · ${statement.schemes.length}`, statement.schemes.length ? schemesTotal : null)}
        ${statement.schemes.map(schemeRow)}
      </ul>
      ${notes.map((n) => html`<p class="small ${n.warn ? 'neg' : 'muted'}">${icon('info')} ${n.warn ?? n}</p>`)}
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn btn-primary" data-ok>${plan.action === 'new' ? 'Import' : 'Update'}</button>
      </div>
    </form>`,
    { className: 'wide' },
  );
}

/** The yearly NPS statement sets the account's value, contributions, units and asset split. */
export async function importNPS(pdf, { store, navigate }) {
  const statement = parseNPS(pdf);
  const now = Date.now();
  const plan = planNPSImport(statement, store.assets);
  const asset = npsAssetFrom(plan, statement, now);
  if ((await npsReviewDialog(statement, plan, asset)) !== 'ok') return;
  await store.updateAssets([asset]);
  navigate(`#/asset/${asset.id}`);
  toast(plan.action === 'new' ? `Added ${asset.name}.` : `Updated ${asset.name} to ${inr(asset.currentValuation)}.`);
}
