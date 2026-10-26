import { financialYearStart, fromInputValue, fyLabel, parts, quarterStart, toInputValue } from '../core/calendar.js';
import { formatLongDate, formatMonth, plainNumber } from '../core/format.js';
import { confirmDialog, parseNumber, showDialog } from '../ui/dom.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { group, pageHead } from './common.js';

const QUARTERS = { 4: 'Q1', 7: 'Q2', 10: 'Q3', 1: 'Q4' };

/** "Q1 FY 2026-27 · Apr 2026" */
export function quarterLabel(t) {
  const q = QUARTERS[parts(t).month] ?? formatMonth(t);
  return `${q} ${fyLabel(financialYearStart(t))} · ${formatMonth(t)}`;
}

function addRateDialog(now) {
  const start = quarterStart(now);
  return showDialog(
    html`<form method="dialog" class="sheet">
      <h2>New PPF Rate</h2>
      <label class="field"><span>Quarter starting</span><input type="date" name="date" value="${toInputValue(start)}" required></label>
      <label class="field"><span>Rate</span><span class="input-wrap"><input name="rate" inputmode="decimal" placeholder="0" autocomplete="off" required><span class="suffix">%</span></span></label>
      <div class="row muted-row"><span class="row-label">Applies from</span><span class="row-value" data-applies>${formatLongDate(start)}</span></div>
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="ok" class="btn btn-primary" data-ok disabled>Save</button>
      </div>
    </form>`,
    {
      onMount(dialog, form) {
        form.addEventListener('input', () => {
          const date = fromInputValue(form.date.value);
          const rate = parseNumber(form.rate.value);
          dialog.querySelector('[data-applies]').textContent = date != null ? formatLongDate(quarterStart(date)) : '—';
          dialog.querySelector('[data-ok]').disabled = date == null || !(rate >= 0.1 && rate <= 20);
        });
      },
      collect: (form) => ({ date: fromInputValue(form.date.value), rate: parseNumber(form.rate.value) }),
    },
  );
}

export const ratesView = {
  title: 'PPF Rates',

  render({ store }) {
    const records = [...store.ppfRates].sort((a, b) => b.effectiveFrom - a.effectiveFrom);
    return html`
      ${pageHead({
        title: 'PPF Rates',
        back: { href: '#/settings', label: 'Settings' },
        actions: html`<button class="btn btn-primary" data-action="add-rate">${icon('plus')}<span class="hide-narrow">Add Rate</span></button>`,
      })}
      ${group(
        { title: 'Effective from', foot: 'Each rate applies from its quarter until the next change. Interest for every PPF account is recalculated when you edit this list.' },
        records.map(
          (r) => html`<div class="row">
            <span class="row-label">${quarterLabel(r.effectiveFrom)}</span>
            <span class="row-value"><span class="num">${plainNumber(r.ratePercent)}%</span>
              <button class="btn btn-icon btn-quiet" data-action="delete-rate" data-from="${r.effectiveFrom}" aria-label="Delete ${quarterLabel(r.effectiveFrom)}">${icon('trash')}</button></span>
          </div>`,
        ),
      )}
      <div class="danger-zone"><button class="btn btn-danger-text" data-action="restore-rates">Restore Official History</button></div>`;
  },

  actions: {
    async 'add-rate'(_, { store, now }) {
      const r = await addRateDialog(now);
      if (r) await store.setRate(r.rate, r.date);
    },
    async 'delete-rate'(el, { store }) {
      const from = Number(el.dataset.from);
      const ok = await confirmDialog({ title: `Delete the ${quarterLabel(from)} rate?`, message: 'PPF interest is recalculated using the previous rate for that period.', confirmLabel: 'Delete', destructive: true });
      if (ok) await store.deleteRate(from);
    },
    async 'restore-rates'(_, { store }) {
      const ok = await confirmDialog({
        title: 'Replace your rate list with the built-in history?',
        message: 'Rates you added after April 2020 will be removed.',
        confirmLabel: 'Restore',
        destructive: true,
      });
      if (ok) await store.restoreOfficialRates();
    },
  },
};
