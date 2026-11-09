import { formatDate, inr } from '../core/format.js';
import { planPPFImport, parsePPF, ppfAssetFrom } from '../core/ppfStatement.js';
import { showDialog, toast } from '../ui/dom.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';

const KIND_LABEL = { deposit: 'Deposit', withdrawal: 'Withdrawal', interest: 'Interest' };

function transactionRow(t) {
  return html`<li class="cas-item">
    <span class="stack">
      <span class="name">${formatDate(t.date)}</span>
      <span class="muted small">${t.remarks || KIND_LABEL[t.kind]}${t.kind === 'interest' ? ' · worked out by the app instead' : ''}</span>
    </span>
    <span class="stack end">
      <span class="num ${t.amount < 0 ? 'neg' : ''}">${inr(t.amount)}</span>
      <span class="muted small">Balance ${inr(t.balance)}</span>
    </span>
  </li>`;
}

function accountRow(plan, statement, asset) {
  const before = plan.existing?.currentValuation;
  const changed = plan.action === 'update' && Math.round(before) !== Math.round(asset.currentValuation);
  return html`<li class="cas-item">
    <span class="stack">
      <span class="name">${asset.name}</span>
      <span class="muted small">Balance ${inr(statement.value)} · Opening ${inr(statement.opening)}</span>
    </span>
    <span class="stack end">
      <span class="num">${changed ? html`<span class="muted small">${inr(before ?? 0)} →</span> ` : ''}${inr(asset.currentValuation)}</span>
      <span class="small ${plan.action === 'new' ? 'pos' : 'muted'}">${plan.action === 'new' ? 'New' : changed ? 'Update' : 'No change'}</span>
    </span>
  </li>`;
}

function ppfReviewDialog(statement, plan, asset) {
  const accrued = Math.round(asset.currentValuation - statement.value);
  const notes = [
    !statement.balanced && { warn: 'The running balances in this statement don’t add up. The closing balance is used; check the transactions against the statement.' },
    plan.adopted && `Replaces the opening balance and deposits you entered by hand in “${plan.existing.name}”, which takes this statement’s account number from now on.`,
    plan.action === 'update' && !plan.adopted && 'Replaces the account’s opening balance and transactions with the statement’s.',
    plan.action === 'new' && 'If you’ve already added this account by hand alongside another PPF account, delete that one after importing.',
    accrued > 0 && `The value includes ${inr(accrued)} of interest earned since 1 April at the official rate; the bank credits it on 31 March.`,
  ].filter(Boolean);
  const title = plan.action === 'new' ? 'Import PPF Account' : 'Update PPF Account';
  const heading = (text) => html`<li class="cas-heading split"><span>${text}</span></li>`;
  return showDialog(
    html`<form method="dialog" class="sheet">
      <h2>${title}</h2>
      <p class="muted">${[statement.asOf != null && `Statement as on ${formatDate(statement.asOf)}`, statement.bank, `A/c ${statement.account}`].filter(Boolean).join(' · ')}.</p>
      <ul class="cas-list plain-list">
        ${heading('Account')}
        ${accountRow(plan, statement, asset)}
        ${heading(`Transactions · ${statement.transactions.length}`)}
        ${[...statement.transactions].reverse().map(transactionRow)}
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

/** The bank's PPF statement for the year sets the account's opening balance and its deposits. */
export async function importPPF(pdf, { store, navigate }) {
  const statement = parsePPF(pdf);
  const now = Date.now();
  const plan = planPPFImport(statement, store.assets);
  const asset = ppfAssetFrom(plan, statement, store.rates, now);
  if ((await ppfReviewDialog(statement, plan, asset)) !== 'ok') return;
  await store.updateAssets([asset]);
  navigate(`#/asset/${asset.id}`);
  toast(plan.action === 'new' ? `Added ${asset.name}.` : `Updated ${asset.name} to ${inr(asset.currentValuation)}.`);
}
