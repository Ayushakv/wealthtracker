import { allocation, totals, upcomingRenewals } from '../core/assets.js';
import { daysBetween, startOfDay } from '../core/calendar.js';
import { formatDate, formatRelative, inr, percent, signedCompact } from '../core/format.js';
import { renewalCalendar } from '../core/ics.js';
import { donut, mountDonut } from '../ui/donut.js';
import { deliverFile, toast } from '../ui/dom.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { emptyState, pageHead, signClass } from './common.js';

function refreshButton(store) {
  return html`<button class="btn btn-icon" data-action="refresh" ${store.isRefreshing ? 'disabled' : ''} aria-label="Refresh NAVs" title="Refresh NAVs">
    ${icon('refresh', store.isRefreshing ? 'spin' : '')}
  </button>`;
}

function summaryCard(t) {
  return html`
    <section class="card summary">
      <p class="muted small">Total Portfolio Value</p>
      <p class="hero num">${inr(t.value)}</p>
      <hr>
      <div class="metrics">
        <div>
          <p class="muted small">Invested Capital</p>
          <p class="metric num">${inr(t.invested)}</p>
        </div>
        <div>
          <p class="muted small">Unrealised Gain</p>
          <p class="metric num"><span class="${signClass(t.gain)}">${icon(t.gain >= 0 ? 'up' : 'down')}</span>
            ${signedCompact(t.gain)}${t.invested > 0 ? ` (${percent(t.gain / t.invested)})` : ''}</p>
        </div>
      </div>
    </section>`;
}

function daysLeft(date, now) {
  const days = daysBetween(startOfDay(now), startOfDay(date));
  return days === 0 ? 'Today' : `in ${days} days`;
}

function renewalsCard(policies, now) {
  return html`
    <section class="card">
      <div class="card-head">
        <h2>${icon('bell')} Upcoming Renewals</h2>
        <button class="btn btn-small" data-action="renewals-to-calendar">${icon('calendar')} Add to Calendar</button>
      </div>
      <ul class="plain-list">
        ${policies.map(
          (p) => html`<li>
            <a class="list-row" href="#/asset/${p.id}">
              <span class="stack"><span>${p.name}</span><span class="muted small">${p.policyType ?? 'Policy'}</span></span>
              <span class="stack end"><span>${formatDate(p.policyRenewalDate)}</span><span class="muted small">${daysLeft(p.policyRenewalDate, now)}</span></span>
            </a>
          </li>`,
        )}
      </ul>
    </section>`;
}

function statusFooter(store, now) {
  const { lastRefresh, failures } = store.settings;
  const failed = Object.keys(failures ?? {}).length;
  return html`
    <footer class="status muted small">
      ${lastRefresh ? html`<p>NAVs refreshed ${formatRelative(lastRefresh, now)}</p>` : ''}
      ${failed ? html`<p class="warn">${icon('warning')} ${failed} scheme(s) failed to update</p>` : ''}
      ${navigator.onLine === false ? html`<p>${icon('info')} Offline — showing saved values</p>` : ''}
    </footer>`;
}

export const dashboardView = {
  title: 'Net Worth',

  render({ store, now }) {
    const head = pageHead({ title: 'Net Worth', actions: store.assets.length ? refreshButton(store) : null });
    if (!store.assets.length) {
      return html`${head}${emptyState({
        iconName: 'rupee',
        title: 'No Assets Yet',
        text: 'Add your first asset from the Assets tab, or load a sample portfolio to explore the dashboard.',
        action: html`<button class="btn btn-primary" data-action="load-sample">Load Sample Portfolio</button>`,
      })}`;
    }
    const slices = allocation(store.assets);
    const renewals = upcomingRenewals(store.assets, now);
    return html`
      ${head}
      <div class="dash">
        ${summaryCard(totals(store.assets))}
        <section class="card allocation">
          <h2>Allocation</h2>
          ${slices.length ? donut(slices) : html`<p class="muted">Nothing to chart yet — values are all zero.</p>`}
        </section>
        ${renewals.length ? renewalsCard(renewals, now) : ''}
        ${statusFooter(store, now)}
      </div>`;
  },

  mount(root, { store }) {
    mountDonut(root.querySelector('.allocation'), allocation(store.assets));
  },

  actions: {
    async 'renewals-to-calendar'(_, { store, now }) {
      const policies = upcomingRenewals(store.assets, now);
      await deliverFile(renewalCalendar(policies, now), 'WealthTracker-Renewals.ics', 'text/calendar');
    },
    async 'load-sample'(_, { store }) {
      await store.loadSample();
      toast('Sample portfolio added.');
    },
  },
};
