import { formatDate, inr } from '../core/format.js';
import { licAssetFrom, parseLICBond, planLICImport } from '../core/licBond.js';
import { modeLabel, premiumSchedule } from '../core/premiums.js';
import { showDialog, toast } from '../ui/dom.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';

const fact = (label, value, sub) => html`<li class="cas-item">
  <span class="stack"><span class="name">${label}</span>${sub ? html`<span class="muted small">${sub}</span>` : ''}</span>
  <span class="stack end"><span class="num">${value}</span></span>
</li>`;

function licReviewDialog(bond, plan, asset, now) {
  const s = premiumSchedule(asset, now);
  const riders = bond.riders.length && bond.basePremium != null ? `${inr(bond.basePremium, 2)} base + ${inr(bond.premium - bond.basePremium, 2)} rider` : '';
  const notes = [
    'Premiums are counted from the first one, each as paid on its due date, and the count and next due date update by themselves.',
    'Amounts are before GST, as the bond prints them; edit the instalment if you’d rather count what you actually pay.',
    plan.action === 'update' && asset.surrenderValueDate != null && `Keeps the surrender value you entered (${inr(asset.currentValuation)} as of ${formatDate(asset.surrenderValueDate)}).`,
    asset.surrenderValueDate == null && 'Until you enter LIC’s surrender value, the policy counts at the premiums paid.',
  ].filter(Boolean);
  const title = plan.action === 'new' ? 'Import LIC Policy' : 'Update LIC Policy';
  const heading = (text) => html`<li class="cas-heading split"><span>${text}</span></li>`;
  return showDialog(
    html`<form method="dialog" class="sheet">
      <h2>${title}</h2>
      <p class="muted">${[asset.name, `Policy ${bond.policyNumber}`, bond.planNo && `Plan ${bond.planNo}`].filter(Boolean).join(' · ')}.</p>
      <ul class="cas-list plain-list">
        ${heading('Policy')}
        ${bond.sumAssured != null ? fact('Sum assured', inr(bond.sumAssured)) : ''}
        ${fact('Commenced', formatDate(bond.commencement), [bond.policyTerm && `${bond.policyTerm}-year term`, bond.premiumTerm && `premiums for ${bond.premiumTerm} years`].filter(Boolean).join(' · '))}
        ${bond.maturity != null ? fact('Maturity', formatDate(bond.maturity)) : ''}
        ${bond.survivalBenefit != null ? fact('First survival benefit', formatDate(bond.survivalBenefit)) : ''}
        ${heading('Premiums')}
        ${fact('Instalment', inr(bond.premium, 2), [`Paid ${modeLabel(bond.mode)}`, riders].filter(Boolean).join(' · '))}
        ${fact('Paid so far', inr(s.paid), `${s.count}${s.totalCount != null ? ` of ${s.totalCount}` : ''} premiums`)}
        ${fact('Next due', s.next != null ? formatDate(s.next) : 'All paid', bond.lastPremium != null ? `Last premium ${formatDate(bond.lastPremium)}` : '')}
      </ul>
      ${notes.map((n) => html`<p class="small muted">${icon('info')} ${n}</p>`)}
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn btn-primary" data-ok>${plan.action === 'new' ? 'Import' : 'Update'}</button>
      </div>
    </form>`,
    { className: 'wide' },
  );
}

/** An LIC policy bond sets up the policy and its premium schedule; the surrender value is entered by hand. */
export async function importLIC(pdf, { store, navigate }) {
  const bond = parseLICBond(pdf);
  const now = Date.now();
  const plan = planLICImport(bond, store.assets);
  const asset = licAssetFrom(plan, bond, store.rates, now);
  if ((await licReviewDialog(bond, plan, asset, now)) !== 'ok') return;
  await store.updateAssets([asset]);
  navigate(`#/asset/${asset.id}`);
  toast(plan.action === 'new' ? `Added ${asset.name}.` : `Updated ${asset.name}.`);
}
