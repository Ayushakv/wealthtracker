import { byName, countsTowardsNetWorth, gain, gainFraction } from '../core/assets.js';
import { CATEGORIES, Category, categoryInfo } from '../core/categories.js';
import { formatDate, inr, inrCompact, number, percent, plainNumber } from '../core/format.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { importCAS } from './casImport.js';
import { emptyState, pageHead, signClass } from './common.js';

/** Category filter survives navigating into an asset and back. */
let filter = '';

export function assetSubtitle(a) {
  const join = (...parts) => parts.filter(Boolean).join(' · ');
  switch (a.category) {
    case Category.bank:
      return join(a.institution, a.bankLast4 && `••${a.bankLast4}`);
    case Category.mutualFund:
      return a.unitsHeld != null ? `${number(a.unitsHeld, 3)} units` : `AMFI ${a.amfiCode ?? '–'}`;
    case Category.insurance:
      return join(a.policyType, a.policyRenewalDate != null && `Renews ${formatDate(a.policyRenewalDate)}`);
    case Category.bonds:
      return join(a.interestRate != null && `${plainNumber(a.interestRate)}%`, a.maturityDate != null && `Matures ${formatDate(a.maturityDate)}`);
    case Category.nps:
      return join(a.npsTier ?? 'Tier 1', a.pran && `PRAN ${a.pran}`);
    default:
      return a.institution ?? categoryInfo(a.category).short;
  }
}

function assetRow(a) {
  let trailing = '';
  if (countsTowardsNetWorth(a)) {
    const g = gainFraction(a);
    trailing = html`<span class="num">${inr(a.currentValuation)}</span>
      ${g != null ? html`<span class="num small ${signClass(gain(a))}">${gain(a) >= 0 ? '+' : ''}${percent(g)}</span>` : ''}`;
  } else if (a.policySumAssured != null) {
    trailing = html`<span class="muted">Cover ${inrCompact(a.policySumAssured)}</span>`;
  }
  return html`<li>
    <a class="list-row" href="#/asset/${a.id}">
      <span class="stack"><span class="name">${a.name}</span><span class="muted small">${assetSubtitle(a)}</span></span>
      <span class="stack end">${trailing}</span>
      ${icon('chevron', 'chev')}
    </a>
  </li>`;
}

function addMenu() {
  return html`<details class="menu">
    <summary class="btn btn-primary" aria-label="Add Asset">${icon('plus')}<span class="hide-narrow">Add Asset</span></summary>
    <div class="menu-items" role="menu">
      ${CATEGORIES.map((c) => html`<a role="menuitem" href="#/new/${c.slug}">${icon(c.icon)}<span>${c.raw}</span></a>`)}
      <a role="menuitem" href="#/assets" class="menu-sep" data-action="import-cas">${icon('import')}<span>Import Mutual Funds from CAS</span></a>
    </div>
  </details>`;
}

function filterPicker() {
  return html`<label class="select-wrap">
    <span class="visually-hidden">Category</span>
    <select data-change="filter">
      <option value="" ${filter ? '' : 'selected'}>All Categories</option>
      ${CATEGORIES.map((c) => html`<option value="${c.slug}" ${filter === c.slug ? 'selected' : ''}>${c.short}</option>`)}
    </select>
  </label>`;
}

export const assetsView = {
  title: 'Assets',

  render({ store }) {
    const head = pageHead({ title: 'Assets', actions: html`${filterPicker()}${addMenu()}` });
    const assets = [...store.assets].sort(byName);
    if (!assets.length) {
      return html`${head}${emptyState({ iconName: 'tray', title: 'No Assets', text: 'Tap + to add a bank account, fund, policy or property.' })}`;
    }
    const visible = filter ? CATEGORIES.filter((c) => c.slug === filter) : CATEGORIES;
    const sections = visible
      .map((c) => ({ c, items: assets.filter((a) => a.category === c.raw) }))
      .filter((s) => s.items.length);
    if (!sections.length) {
      const c = visible[0];
      return html`${head}${emptyState({ iconName: c.icon, title: `No ${c.short} Assets` })}`;
    }
    return html`${head}${sections.map(
      ({ c, items }) => html`<section class="group">
        <h2 class="group-title split">
          <span>${icon(c.icon)} ${c.raw}</span>
          <span class="num">${inrCompact(items.filter(countsTowardsNetWorth).reduce((s, a) => s + a.currentValuation, 0))}</span>
        </h2>
        <ul class="group-body plain-list">${items.map(assetRow)}</ul>
      </section>`,
    )}`;
  },

  mount(root) {
    // Close the add menu when tapping outside it.
    const menu = root.querySelector('details.menu');
    if (!menu) return;
    const close = (e) => {
      if (!menu.contains(e.target)) menu.open = false;
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  },

  actions: {
    'import-cas'(el, ctx) {
      el.closest('details').open = false;
      return importCAS(ctx);
    },
  },

  changes: {
    filter(el, ctx) {
      filter = el.value;
      ctx.rerender();
    },
  },
};
