import { financialYearStart, fromInputValue, fyLabel, toInputValue } from '../core/calendar.js';
import { categoryBySlug, categoryInfo, Category, COMPOUNDING, LIC_ENDOWMENT, NPS_TIERS, POLICY_TYPES } from '../core/categories.js';
import { applyDraft, draftFromAsset, newDraft, npsAllocationTotal, validateDraft } from '../core/draft.js';
import { fixedIncomeValuation } from '../core/fixedIncome.js';
import { formatDate, inr, plainNumber } from '../core/format.js';
import { renewalCalendar } from '../core/ics.js';
import { latestNAV } from '../core/mfapi.js';
import { deliverFile, parseNumber, toast } from '../ui/dom.js';
import { html, setHTML } from '../ui/html.js';
import { icon } from '../ui/icons.js';
import { emptyState, group, pageHead, row } from './common.js';

// MARK: - Field helpers (each input's name is the draft key; data-type says how to read it back)

const numText = (v, digits) => (v == null ? '' : String(Number(v.toFixed(digits))));

function textField(name, label, value, { placeholder = label, multiline = false, inputmode, maxlength } = {}) {
  const input = multiline
    ? html`<textarea name="${name}" data-type="text" rows="3" placeholder="${placeholder}">${value}</textarea>`
    : html`<input name="${name}" data-type="text" value="${value}" placeholder="${placeholder}" autocomplete="off" ${inputmode ? html`inputmode="${inputmode}"` : ''} ${maxlength ? html`maxlength="${maxlength}"` : ''}>`;
  return html`<label class="field ${multiline ? 'stacked' : ''}"><span>${label}</span>${input}</label>`;
}

function numberField(name, label, value, { digits = 2, placeholder = '0', suffix } = {}) {
  return html`<label class="field"><span>${label}</span>
    <span class="input-wrap"><input name="${name}" data-type="number" inputmode="decimal" value="${numText(value, digits)}" placeholder="${placeholder}" autocomplete="off">${suffix ? html`<span class="suffix">${suffix}</span>` : ''}</span>
  </label>`;
}
const amountField = (name, label, value, digits = 2) => numberField(name, label, value, { digits, placeholder: '₹0' });
const percentField = (name, label, value) => numberField(name, label, value, { digits: 2, suffix: '%' });

const dateField = (name, label, value, { min } = {}) =>
  html`<label class="field"><span>${label}</span><input type="date" name="${name}" data-type="date" value="${toInputValue(value)}" ${min != null ? html`min="${toInputValue(min)}"` : ''} required></label>`;

const toggle = (name, label, checked) =>
  html`<label class="field toggle"><span>${label}</span><input type="checkbox" role="switch" name="${name}" data-type="bool" ${checked ? 'checked' : ''}></label>`;

const select = (name, label, options, value, type = 'text') =>
  html`<label class="field"><span>${label}</span><select name="${name}" data-type="${type}">${options.map(
    (o) => html`<option value="${o.value}" ${String(o.value) === String(value) ? 'selected' : ''}>${o.label}</option>`,
  )}</select></label>`;

const segmented = (name, label, options, value) =>
  html`<div class="field"><span>${label}</span><div class="segmented" role="radiogroup" aria-label="${label}">${options.map(
    (o) => html`<label><input type="radio" name="${name}" data-type="text" value="${o}" ${o === value ? 'checked' : ''}><span>${o}</span></label>`,
  )}</div></div>`;

/** Wrapper shown only while `cond` ("flag", "!flag" or "key=value") holds for the draft. */
const showIf = (cond, d, body) => html`<div data-show-if="${cond}" ${matches(cond, d) ? '' : 'hidden'}>${body}</div>`;

function matches(cond, d) {
  if (cond.startsWith('!')) return !matches(cond.slice(1), d);
  const [key, value] = cond.split('=');
  return value === undefined ? !!d[key] : String(d[key]) === value;
}

function readInto(form, d) {
  for (const el of form.elements) {
    const type = el.dataset?.type;
    if (!type || !el.name) continue;
    if (el.type === 'radio' && !el.checked) continue;
    switch (type) {
      case 'text':
        d[el.name] = el.value;
        break;
      case 'number':
        d[el.name] = parseNumber(el.value);
        break;
      case 'int':
        d[el.name] = Number.parseInt(el.value, 10);
        break;
      case 'bool':
        d[el.name] = el.checked;
        break;
      case 'date':
        d[el.name] = fromInputValue(el.value) ?? d[el.name];
        break;
    }
  }
}

// MARK: - Category sections

function institutionLabel(category) {
  switch (category) {
    case Category.bank: return 'Bank name';
    case Category.mutualFund: return 'Fund house';
    case Category.insurance: return 'Insurer';
    case Category.p2p: return 'Platform';
    case Category.nps: return 'CRA / POP';
    case Category.realEstate: return 'Owner(s)';
    default: return 'Institution';
  }
}

function mfNav(d) {
  if (d.latestNAV == null) return '';
  return html`${row('Latest NAV', inr(d.latestNAV, 4))}${d.unitsHeld != null ? row('Current value', inr(d.unitsHeld * d.latestNAV)) : ''}`;
}

function projection(d) {
  if (d.investedAmount == null || d.interestRate == null) return '';
  const v = fixedIncomeValuation({
    principal: d.investedAmount,
    annualRatePercent: d.interestRate,
    compounding: d.compounding,
    isPayout: d.isPayout,
    start: d.startDate,
    maturity: d.hasMaturityDate ? d.maturityDate : undefined,
  });
  return group({ title: 'Projection' }, [
    row('Value today', inr(v.currentValue)),
    row('Accrued interest', inr(v.accruedInterest)),
    v.maturityValue != null ? row('At maturity', inr(v.maturityValue)) : '',
  ]);
}

function categorySections(d, { rates, now }) {
  switch (d.category) {
    case Category.bank:
      return group({ title: 'Account' }, [
        textField('bankLast4', 'Last 4 digits', d.bankLast4, { inputmode: 'numeric', maxlength: 4, placeholder: '1234' }),
        amountField('currentValuation', 'Current balance', d.currentValuation),
        dateField('lastReconciled', 'Last reconciled', d.lastReconciled),
      ]);

    case Category.realEstate:
      return group({ title: 'Parcel' }, [
        textField('locationDetails', 'Location / survey details', d.locationDetails, { multiline: true }),
        toggle('hasStartDate', 'Purchase date known', d.hasStartDate),
        showIf('hasStartDate', d, dateField('startDate', 'Purchase date', d.startDate)),
        amountField('investedAmount', 'Purchase price', d.investedAmount),
        amountField('currentValuation', 'Estimated fair market value', d.currentValuation),
      ]);

    case Category.mutualFund:
      return html`
        ${group({ title: 'Scheme', foot: 'Find the code on amfiindia.com or your CAS statement. Only this code is sent to mfapi.in.' }, [
          html`<div class="field with-button">
            <label for="amfiCode">AMFI scheme code</label>
            <input id="amfiCode" name="amfiCode" data-type="text" inputmode="numeric" value="${d.amfiCode}" placeholder="e.g. 118955" autocomplete="off">
            <button type="button" class="btn btn-small" data-action="verify-amfi">Verify</button>
          </div>`,
          html`<div class="lookup" data-derived="lookup" aria-live="polite"></div>`,
        ])}
        ${group({ title: 'Holding' }, [
          numberField('unitsHeld', 'Units held', d.unitsHeld, { digits: 3 }),
          amountField('averageNAV', 'Average purchase NAV', d.averageNAV, 4),
          html`<div data-derived="mf-nav">${mfNav(d)}</div>`,
        ])}`;

    case Category.ppf: {
      const current = financialYearStart(now);
      const years = [];
      for (let y = current; y >= Math.min(current - 15, d.ppfOpeningFYStartYear); y--) years.push({ value: y, label: fyLabel(y) });
      return group(
        {
          title: 'Account',
          foot: 'Add monthly deposits from the account screen. Interest accrues on the lowest balance between the 5th and month-end at the rate in force that quarter, and is credited every 31 March. Update rates in Settings.',
        },
        [
          select('ppfOpeningFYStartYear', 'Opening FY', years, d.ppfOpeningFYStartYear, 'int'),
          amountField('ppfOpeningBalance', 'Balance on 1 April', d.ppfOpeningBalance),
          row('Interest rate', `${plainNumber(rates.currentRate(now))}% (from rate history)`, 'muted-row'),
          toggle('hasMaturityDate', 'Track maturity date', d.hasMaturityDate),
          showIf('hasMaturityDate', d, dateField('maturityDate', 'Maturity', d.maturityDate)),
        ],
      );
    }

    case Category.nps:
      return html`
        ${group({ title: 'Account' }, [
          textField('pran', 'PRAN', d.pran, { inputmode: 'numeric' }),
          segmented('npsTier', 'Tier', NPS_TIERS, d.npsTier),
          numberField('unitsHeld', 'Total units', d.unitsHeld, { digits: 4 }),
          amountField('investedAmount', 'Total contributed', d.investedAmount),
          amountField('currentValuation', 'Current value', d.currentValuation),
        ])}
        <section class="group">
          <h2 class="group-title">Asset split</h2>
          <div class="group-body">
            ${percentField('npsEquityPct', 'Equity (E)', d.npsEquityPct)}
            ${percentField('npsCorporateDebtPct', 'Corporate debt (C)', d.npsCorporateDebtPct)}
            ${percentField('npsGovtBondPct', 'Government bonds (G)', d.npsGovtBondPct)}
            ${percentField('npsAlternativePct', 'Alternative (A)', d.npsAlternativePct)}
          </div>
          <p class="group-foot" data-derived="nps-total">Total ${plainNumber(npsAllocationTotal(d))}%</p>
        </section>`;

    case Category.bonds:
      return html`
        ${group(
          { title: 'Instrument', foot: 'Turn off interest calculation for market-traded bonds (SGBs, NCDs, G-secs) to enter the current value from your demat statement instead.' },
          [
            amountField('investedAmount', 'Principal', d.investedAmount),
            percentField('interestRate', 'Coupon / interest rate', d.interestRate),
            toggle('hasStartDate', 'Calculate value from interest', d.hasStartDate),
            showIf('hasStartDate', d, [
              select('compounding', 'Compounding', COMPOUNDING.map((c) => ({ value: c.raw, label: c.raw })), d.compounding),
              toggle('isPayout', 'Interest paid out (non-cumulative)', d.isPayout),
              dateField('startDate', 'Start date', d.startDate),
            ]),
            showIf('!hasStartDate', d, amountField('currentValuation', 'Current value', d.currentValuation)),
            toggle('hasMaturityDate', 'Has maturity date', d.hasMaturityDate),
            showIf('hasMaturityDate', d, dateField('maturityDate', 'Maturity', d.maturityDate, { min: d.hasStartDate ? d.startDate : undefined })),
          ],
        )}
        <div data-derived="projection" ${d.hasStartDate ? '' : 'hidden'}>${projection(d)}</div>`;

    case Category.p2p:
      return group({ title: 'Ledger', foot: 'Copy these totals from your LenDenClub dashboard. Outstanding balance is what counts towards net worth.' }, [
        amountField('investedAmount', 'Total principal deployed', d.investedAmount),
        amountField('p2pRepaymentsReceived', 'Cumulative repayments received', d.p2pRepaymentsReceived),
        amountField('currentValuation', 'Current outstanding balance', d.currentValuation),
        amountField('p2pWriteOffs', 'Net defaults / write-offs', d.p2pWriteOffs),
      ]);

    case Category.insurance:
      return html`
        ${group({ title: 'Policy' }, [
          select('policyType', 'Type', POLICY_TYPES.map((t) => ({ value: t, label: t })), d.policyType),
          textField('policyNumber', 'Policy number', d.policyNumber),
          amountField('policySumAssured', 'Sum assured', d.policySumAssured),
          amountField('annualPremium', 'Annual premium', d.annualPremium),
        ])}
        ${group({ foot: 'After saving, add the due date to your calendar for reminders 30, 15 and 3 days before.' }, [
          toggle('hasRenewalDate', 'Renewal / premium due date', d.hasRenewalDate),
          showIf('hasRenewalDate', d, dateField('policyRenewalDate', 'Due on', d.policyRenewalDate)),
        ])}
        ${showIf(
          `policyType=${LIC_ENDOWMENT}`,
          d,
          group({ title: 'Savings value' }, [
            amountField('investedAmount', 'Total premiums paid', d.investedAmount),
            amountField('currentValuation', 'Surrender / paid-up value', d.currentValuation),
            toggle('hasMaturityDate', 'Has maturity date', d.hasMaturityDate),
            showIf('hasMaturityDate', d, dateField('maturityDate', 'Maturity', d.maturityDate)),
          ]),
        )}`;
  }
  return '';
}

// MARK: - View

function draftFor({ store, params, state, now }) {
  if (state.draft) return state.draft;
  if (params.id) {
    const a = store.asset(params.id);
    if (!a) return null;
    state.draft = draftFromAsset(a, now);
  } else {
    const c = categoryBySlug(params.slug);
    if (!c) return null;
    state.draft = newDraft(c.raw, now);
  }
  return state.draft;
}

/** Re-reads the form and refreshes everything derived from it, without touching the inputs being typed in. */
function update(form, ctx) {
  const d = ctx.state.draft;
  readInto(form, d);
  for (const el of form.querySelectorAll('[data-show-if]')) el.hidden = !matches(el.dataset.showIf, d);

  const error = validateDraft(d);
  form.querySelector('[data-save]').disabled = !!error;
  form.querySelector('[data-derived="validation"]').textContent = error && d.name.trim() ? error : '';

  const derived = (key, fragment) => {
    const el = form.querySelector(`[data-derived="${key}"]`);
    if (el) setHTML(el, fragment);
  };
  if (d.category === Category.mutualFund) derived('mf-nav', mfNav(d));
  if (d.category === Category.bonds) {
    derived('projection', projection(d));
    form.querySelector('[data-derived="projection"]').hidden = !d.hasStartDate;
    const maturity = form.querySelector('[name="maturityDate"]');
    if (maturity) maturity.min = d.hasStartDate ? toInputValue(d.startDate) : '';
  }
  if (d.category === Category.nps) form.querySelector('[data-derived="nps-total"]').textContent = `Total ${plainNumber(npsAllocationTotal(d))}%`;
}

export const formView = {
  keepOnChange: true,

  titleFor(ctx) {
    const d = draftFor(ctx);
    if (!d) return 'Asset';
    return `${ctx.params.id ? 'Edit' : 'New'} ${categoryInfo(d.category).short}`;
  },

  render(ctx) {
    const d = draftFor(ctx);
    const back = ctx.params.id ? { href: `#/asset/${ctx.params.id}`, label: 'Back' } : { href: '#/assets', label: 'Assets' };
    if (!d) return html`${pageHead({ title: 'Not found', back })}${emptyState({ iconName: 'tray', title: 'Nothing to edit here' })}`;
    const error = validateDraft(d);
    return html`
      <form class="asset-form" data-form="asset" novalidate autocomplete="off">
        ${pageHead({
          title: formView.titleFor(ctx),
          actions: html`<button type="button" class="btn" data-action="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary" data-save ${error ? 'disabled' : ''}>Save</button>`,
        })}
        ${group({}, [
          textField('name', 'Name', d.name),
          textField('institution', institutionLabel(d.category), d.institution),
        ])}
        ${categorySections(d, { rates: ctx.store.rates, now: ctx.now })}
        ${group({ title: 'Notes' }, textField('notes', 'Notes', d.notes, {
          multiline: true,
          placeholder: d.category === Category.realEstate ? 'Legal notes, documents, mutation entries' : 'Notes',
        }))}
        <p class="validation muted small" data-derived="validation" aria-live="polite"></p>
      </form>`;
  },

  mount(root, ctx) {
    const form = root.querySelector('form[data-form="asset"]');
    if (!form) return;
    const onInput = (e) => {
      if (e.target.name === 'amfiCode') setHTML(form.querySelector('[data-derived="lookup"]'), '');
      update(form, ctx);
    };
    form.addEventListener('input', onInput);
    form.addEventListener('change', onInput);
    if (!ctx.params.id) form.querySelector('[name="name"]').focus({ preventScroll: true });
  },

  actions: {
    cancel(_, ctx) {
      ctx.goBack(ctx.params.id ? `#/asset/${ctx.params.id}` : '#/assets');
    },

    async 'verify-amfi'(button, ctx) {
      const form = button.form;
      const d = ctx.state.draft;
      readInto(form, d);
      const status = form.querySelector('[data-derived="lookup"]');
      button.disabled = true;
      setHTML(status, html`<span class="muted">${icon('refresh', 'spin')} Checking…</span>`);
      try {
        const q = await latestNAV(d.amfiCode);
        d.latestNAV = q.nav;
        d.navDate = q.date;
        if (!d.name.trim()) form.elements.name.value = d.name = q.schemeName;
        if (!d.institution.trim()) form.elements.institution.value = d.institution = q.fundHouse;
        setHTML(status, html`<span class="pos">${icon('check')} ${q.schemeName} · NAV ${inr(q.nav, 2)} on ${formatDate(q.date)}</span>`);
      } catch (e) {
        setHTML(status, html`<span class="neg">${icon('error')} ${e.message}</span>`);
      } finally {
        button.disabled = false;
        update(form, ctx);
      }
    },
  },

  submits: {
    async asset(form, ctx) {
      const { store, params, state } = ctx;
      update(form, ctx);
      const d = state.draft;
      if (validateDraft(d)) return;
      const existing = params.id ? store.asset(params.id) : null;
      const before = existing?.policyRenewalDate;
      const saved = applyDraft(d, existing ? structuredClone(existing) : null, store.rates);
      await store.upsert(saved);
      ctx.goBack(existing ? `#/asset/${saved.id}` : '#/assets');

      if (saved.category === Category.insurance && saved.policyRenewalDate != null && saved.policyRenewalDate !== before) {
        toast(`Due ${formatDate(saved.policyRenewalDate)}. Add a reminder?`, {
          action: { label: 'Add to Calendar', run: () => deliverFile(renewalCalendar([saved]), `${saved.name.replace(/[^\w-]+/g, '-')}-renewal.ics`, 'text/calendar') },
          duration: 8000,
        });
      }
    },
  },
};
