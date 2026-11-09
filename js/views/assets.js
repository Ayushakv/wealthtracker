import { byName, countsTowardsNetWorth } from '../core/assets.js';
import { CATEGORIES, Category, categoryInfo } from '../core/categories.js';
import { INSTRUMENT_ORDER } from '../core/demat.js';
import { formatDate, inr, inrCompact, number, plainNumber } from '../core/format.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { importCAS } from './casImport.js';
import { emptyState, pageHead } from './common.js';

/** Category filter survives navigating into an asset and back, and so do expanded groups. */
let filter = '';
const expanded = new Set();
/** Long groups show this many assets until expanded (a group of one more than this shows in full). */
const PREVIEW = 5;

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
    case Category.fd:
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
    trailing = html`<span class="num">${inr(a.currentValuation)}</span>`;
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

const valueOf = (items) => items.filter(countsTowardsNetWorth).reduce((s, a) => s + a.currentValuation, 0);

/**
 * Bonds imported from a demat statement keep the section it listed them under (Corporate Bonds, Securitised
 * Instruments…); a category holding them is split the same way, with everything else last.
 */
function subgroups(c, items) {
  if (!items.some((a) => a.instrument)) return [{ key: c.slug, name: null, items }];
  const byName = new Map();
  for (const a of items) {
    const name = a.instrument ?? null;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(a);
  }
  const rank = (name) => (name == null ? Infinity : INSTRUMENT_ORDER.includes(name) ? INSTRUMENT_ORDER.indexOf(name) : INSTRUMENT_ORDER.length);
  return [...byName]
    .sort(([a], [b]) => rank(a) - rank(b) || (a ?? '').localeCompare(b ?? ''))
    .map(([name, list]) => ({ key: `${c.slug}:${name ?? ''}`, name: name ?? `Other ${c.short}`, items: list }));
}

/** A run of assets; a long one shows the first few and a button for the rest (unless a category filter is picked). */
function assetRun({ key, name, items }, titled) {
  const long = !filter && items.length > PREVIEW + 1;
  const open = !long || expanded.has(key);
  return html`${titled
    ? html`<li class="sub-heading split"><span>${name} <span class="count">${items.length}</span></span><span class="num">${inrCompact(valueOf(items))}</span></li>`
    : ''}${(open ? items : items.slice(0, PREVIEW)).map(assetRow)}${long
    ? html`<li><button class="row row-button" data-action="toggle-group" data-group="${key}" data-total="${items.length}" aria-expanded="${String(open)}">
        ${icon('chevron', open ? 'chev-up' : 'chev-down')}${open ? 'Show fewer' : `Show all ${items.length}`}</button></li>`
    : ''}`;
}

function addMenu() {
  return html`<details class="menu">
    <summary class="btn btn-primary" aria-label="Add Asset">${icon('plus')}<span class="hide-narrow">Add Asset</span></summary>
    <div class="menu-items" role="menu">
      <a role="menuitem" href="#/assets" data-action="import-cas">${icon('import')}<span>Import Mutual Funds or Bonds from CAS</span></a>
      <a role="menuitem" href="#/assets" class="menu-sep-after" data-action="import-nps">${icon('import')}<span>Import NPS Statement</span></a>
      ${CATEGORIES.map((c) => html`<a role="menuitem" href="#/new/${c.slug}">${icon(c.icon)}<span>${c.raw}</span></a>`)}
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
    return html`${head}${sections.map(({ c, items }) => {
      const runs = subgroups(c, items);
      return html`<section class="group">
        <h2 class="group-title split">
          <span>${icon(c.icon)} ${c.raw}${items.length > PREVIEW + 1 ? html` <span class="count">${items.length}</span>` : ''}</span>
          <span class="num">${inrCompact(valueOf(items))}</span>
        </h2>
        <ul class="group-body plain-list">${runs.map((run) => assetRun(run, runs.length > 1))}</ul>
      </section>`;
    })}`;
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
    'toggle-group'(el, ctx) {
      const slug = el.dataset.group;
      if (!expanded.delete(slug)) expanded.add(slug);
      ctx.rerender();
    },
    'import-cas'(el, ctx) {
      el.closest('details').open = false;
      return importCAS(ctx);
    },
    // The same reader: it tells the statements apart by their contents.
    'import-nps'(el, ctx) {
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
