import { countsTowardsNetWorth, createEntry, fixedIncomeFor, gain, gainFraction, ppfStatementFor } from '../core/assets.js';
import { fromInputValue, parts, toInputValue } from '../core/calendar.js';
import { Category, DEFAULT_COMPOUNDING } from '../core/categories.js';
import { formatDate, formatDateTime, formatMonth, inr, inrCompact, number, percent, plainNumber } from '../core/format.js';
import { confirmDialog, parseNumber, showDialog } from '../ui/dom.js';
import { html } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { emptyState, group, pageHead, row, signClass } from './common.js';

const opt = (label, v, fmt = (x) => x) => (v != null && v !== '' ? row(label, fmt(v)) : '');

function splitRow(label, pct) {
  const v = pct ?? 0;
  return row(label, html`<progress max="100" value="${v}"></progress><span class="num pct">${plainNumber(v)}%</span>`);
}

function categoryDetails(a, store, now) {
  switch (a.category) {
    case Category.bank:
      return group({ title: 'Account' }, [opt('Account', a.bankLast4, (v) => `•••• ${v}`), opt('Last reconciled', a.lastReconciled, formatDate)]);

    case Category.realEstate:
      return group({ title: 'Parcel' }, [opt('Location', a.locationDetails), opt('Purchased', a.startDate, formatDate)]);

    case Category.mutualFund:
      return group({ title: 'Holding' }, [
        opt('AMFI code', a.amfiCode),
        opt('Units', a.unitsHeld, (v) => number(v, 3)),
        opt('Average NAV', a.averageNAV, (v) => inr(v, 4)),
        opt('Latest NAV', a.latestNAV, (v) => inr(v, 4)),
        opt('NAV date', a.navDate, formatDate),
      ]);

    case Category.nps:
      return html`
        ${group({ title: 'Account' }, [opt('PRAN', a.pran), row('Tier', a.npsTier ?? 'Tier 1'), opt('Units', a.unitsHeld, (v) => number(v, 4))])}
        ${group({ title: 'Asset split' }, [
          splitRow('Equity (E)', a.npsEquityPct),
          splitRow('Corporate debt (C)', a.npsCorporateDebtPct),
          splitRow('Government bonds (G)', a.npsGovtBondPct),
          splitRow('Alternative (A)', a.npsAlternativePct),
        ])}`;

    case Category.bonds: {
      const v = fixedIncomeFor(a, now);
      if (!v) return '';
      return group({ title: 'Interest' }, [
        row('Rate', `${plainNumber(a.interestRate ?? 0)}% · ${a.compounding ?? DEFAULT_COMPOUNDING}`),
        row('Mode', a.isPayout ? 'Payout' : 'Cumulative'),
        row('Accrued interest', inr(v.accruedInterest)),
        opt('Start', a.startDate, formatDate),
        opt('Maturity', a.maturityDate, formatDate),
        opt('Value at maturity', v.maturityValue, inr),
      ]);
    }

    case Category.p2p: {
      const net = a.currentValuation + (a.p2pRepaymentsReceived ?? 0) - a.investedAmount;
      return group({ title: 'Ledger' }, [
        row('Principal deployed', inr(a.investedAmount)),
        row('Repayments received', inr(a.p2pRepaymentsReceived ?? 0)),
        row('Outstanding', inr(a.currentValuation)),
        row('Defaults / write-offs', html`<span class="neg">${inr(a.p2pWriteOffs ?? 0)}</span>`),
        row('Net return (incl. repayments)', html`<span class="${signClass(net)}">${inr(net)}</span>`),
      ]);
    }

    case Category.ppf:
      return ppfSections(a, store, now);

    case Category.insurance:
      return group({ title: 'Policy' }, [
        opt('Type', a.policyType),
        opt('Policy no.', a.policyNumber),
        opt('Sum assured', a.policySumAssured, inr),
        opt('Annual premium', a.annualPremium, inr),
        opt('Next due', a.policyRenewalDate, formatDate),
        opt('Maturity', a.maturityDate, formatDate),
      ]);
  }
  return '';
}

function ppfSections(a, store, now) {
  const rates = store.rates;
  const s = ppfStatementFor(a, rates, now);
  const entries = [...(a.entries ?? [])].sort((x, y) => y.date - x.date);
  return html`
    ${group({ title: 'Balance' }, [
      row('Credited balance', inr(s.creditedBalance)),
      row('Interest accrued this FY', inr(s.accruedInterest)),
      row('Current rate', `${plainNumber(rates.currentRate(now))}% p.a.`),
    ])}
    ${[...s.years].reverse().map((y) =>
      group({ title: y.label + (y.isCredited ? '' : ' (in progress)') }, [
        row('Opening', inr(y.openingBalance)),
        row(
          'Deposits',
          html`${y.exceedsAnnualLimit ? html`<span class="warn" title="Exceeds the ₹1.5 lakh annual limit">${icon('warning')}<span class="visually-hidden">Exceeds the ₹1.5 lakh annual limit</span></span>` : ''}${inr(y.netDeposits)}`,
        ),
        row(y.isCredited ? 'Interest credited' : 'Interest accrued', inr(y.interestAccrued)),
        html`<details class="breakdown">
          <summary>Monthly breakdown</summary>
          ${y.months.map((m) => row(formatMonth(m.month), html`<span class="num">${inrCompact(m.qualifyingBalance)} @ ${plainNumber(m.ratePercent)}% → ${inr(m.interest, 2)}</span>`, 'small'))}
        </details>`,
      ]),
    )}
    ${group({ title: 'Transactions', foot: 'Deposit on or before the 5th to earn interest for that month.' }, [
      entries.map(
        (e) => html`<div class="row">
          <span class="row-label">${formatDate(e.date)}${e.note ? html` <span class="muted">${e.note}</span>` : ''}</span>
          <span class="row-value"><span class="num ${e.amount < 0 ? 'neg' : ''}">${inr(e.amount)}</span>
            <button class="btn btn-icon btn-quiet" data-action="delete-entry" data-entry="${e.id}" aria-label="Delete ${formatDate(e.date)} ${inr(e.amount)}">${icon('trash')}</button></span>
        </div>`,
      ),
      html`<button class="row row-button" data-action="add-entry">${icon('plus')} Add Deposit / Withdrawal</button>`,
    ])}`;
}

function entryDialog(now) {
  return showDialog(
    html`<form method="dialog" class="sheet" novalidate>
      <h2 data-title>Deposit</h2>
      <div class="segmented" role="radiogroup" aria-label="Type">
        <label><input type="radio" name="kind" value="deposit" checked><span>Deposit</span></label>
        <label><input type="radio" name="kind" value="withdrawal"><span>Withdrawal</span></label>
      </div>
      <label class="field"><span>Date</span><input type="date" name="date" value="${toInputValue(now)}" required></label>
      <label class="field"><span>Amount</span><input name="amount" inputmode="decimal" placeholder="₹0" autocomplete="off" required></label>
      <label class="field"><span>Note</span><input name="note" autocomplete="off"></label>
      <p class="hint muted small" data-late hidden>${icon('info')} After the 5th: this deposit earns interest from next month.</p>
      <div class="sheet-actions">
        <button value="cancel" class="btn" formnovalidate>Cancel</button>
        <button value="add" class="btn btn-primary" data-add disabled>Add</button>
      </div>
    </form>`,
    {
      onMount(dialog, form) {
        const update = () => {
          const withdrawal = form.kind.value === 'withdrawal';
          const day = form.date.value ? parts(fromInputValue(form.date.value)).day : 1;
          dialog.querySelector('[data-title]').textContent = withdrawal ? 'Withdrawal' : 'Deposit';
          dialog.querySelector('[data-late]').hidden = withdrawal || day <= 5;
          dialog.querySelector('[data-add]').disabled = !((parseNumber(form.amount.value) ?? 0) > 0) || !form.date.value;
        };
        form.addEventListener('input', update);
        form.addEventListener('change', update);
      },
      collect: (form) => ({
        date: fromInputValue(form.date.value),
        amount: Math.abs(parseNumber(form.amount.value)) * (form.kind.value === 'withdrawal' ? -1 : 1),
        note: form.note.value.trim(),
      }),
    },
  );
}

export const detailView = {
  render({ store, params, now }) {
    const a = store.asset(params.id);
    const back = { href: '#/assets', label: 'Assets' };
    if (!a) return html`${pageHead({ title: 'Not found', back })}${emptyState({ iconName: 'tray', title: 'This asset no longer exists' })}`;
    const g = gainFraction(a);
    return html`
      ${pageHead({ title: a.name, back, actions: html`<a class="btn" href="#/asset/${a.id}/edit">Edit</a>` })}
      ${group({}, [
        countsTowardsNetWorth(a)
          ? [
              row('Current value', html`<strong class="num big">${inr(a.currentValuation)}</strong>`),
              row('Invested', inr(a.investedAmount)),
              a.investedAmount > 0 ? row('Gain', html`<span class="num ${signClass(gain(a))}">${inr(gain(a))} (${percent(g ?? 0)})</span>`) : '',
            ]
          : '',
        opt('Institution', a.institution),
        row('Last updated', formatDateTime(a.lastUpdated)),
      ])}
      ${categoryDetails(a, store, now)}
      ${a.notes ? group({ title: 'Notes' }, html`<p class="notes">${a.notes}</p>`) : ''}
      <div class="danger-zone"><button class="btn btn-danger-text" data-action="delete-asset">Delete Asset</button></div>`;
  },

  titleFor({ store, params }) {
    return store.asset(params.id)?.name ?? 'Asset';
  },

  actions: {
    async 'delete-asset'(_, { store, params, navigate }) {
      const a = store.asset(params.id);
      const ok = await confirmDialog({
        title: `Delete ${a.name}?`,
        message: 'This removes it from this device. Export a backup first if you might need it.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      await store.deleteAsset(a.id);
      navigate('#/assets', { replace: true });
    },
    async 'add-entry'(_, { store, params, now }) {
      const result = await entryDialog(now);
      if (result) await store.addEntry(params.id, createEntry(result.date, result.amount, result.note));
    },
    async 'delete-entry'(el, { store, params }) {
      const ok = await confirmDialog({ title: 'Delete this transaction?', message: 'Interest is recalculated without it.', confirmLabel: 'Delete', destructive: true });
      if (ok) await store.deleteEntry(params.id, el.dataset.entry);
    },
  },
};
