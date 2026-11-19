import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { countsTowardsNetWorth, createAsset, recompute, totals, upcomingRenewals } from '../js/core/assets.js';
import { exportBackup, parseBackup } from '../js/core/backup.js';
import { date } from '../js/core/calendar.js';
import { CASError } from '../js/core/cas.js';
import { Category, LIC_ENDOWMENT } from '../js/core/categories.js';
import { applyDraft, draftFromAsset, validateDraft } from '../js/core/draft.js';
import { isLICBond, licAssetFrom, parseLICBond, planLICImport } from '../js/core/licBond.js';
import { isPPFStatement } from '../js/core/ppfStatement.js';
import { premiumSchedule } from '../js/core/premiums.js';
import { pdfRows } from '../js/ui/pdf.js';

const now = date(2026, 11, 19);
const policy = (fields = {}) =>
  createAsset(
    {
      category: Category.insurance,
      name: 'LIC Example',
      policyType: LIC_ENDOWMENT,
      premiumMode: 'Monthly',
      premiumInstalment: 5000,
      premiumStartDate: date(2022, 3, 25),
      premiumEndDate: date(2042, 2, 25),
      ...fields,
    },
    now,
  );

/** The other layout LIC prints: the total on its label's line, the sum assured two lines above its label. */
const otherLayout = [
  'LIC’s Example Gain\tPage 3 of 20\tPlan No -998',
  'UIN\tPolicy Number\t900000002',
  'Plan & Policy Term\t998 16\tPremium Paying Term\t10',
  'Date of Commencement of Policy\t10-03-2021\tDate of Commencement of Risk\t10-03-2021',
  'Date of Issuance of Policy\t12-03-2021\tDate of Maturity\t10-03-2037',
  'मूल बीमा राशि(रु.)\t400000\tमूल पॉलिसी के लिए अंतिम प्रीमियम Due date of Payment of Last',
  '10-12-2030',
  'Basic Sum Assured ( Rs)\tpremium for Base Policy',
  'प्रीमियम भुगतान की विधि\tQly\tमूल पॉलिसी के लिए किस्त प्रीमियम (रु.)',
  'Mode of payment of premium\tInstalment Premium for Base Policy (Rs\t12400.50',
  'Due date of Premium\tजाऐगे)',
  'Total Instalment Premium (Rs): (Taxes, if any, as applicable from time\t12500.00',
  '1\tADDB Rdr 999B999V01\t10-03-2021\t400000\t99.50\t10-12-2030\t10-03-2037',
];

describe('LIC policy bond', () => {
  test('the schedule page of a policy bond PDF is read, values apart from their labels included', async () => {
    const rows = await pdfRows((await readFile(new URL('./fixtures/sample-lic.pdf', import.meta.url))).buffer);
    const lines = rows.map((r) => r.text);
    assert.ok(isLICBond(lines));
    assert.ok(!isPPFStatement(lines));
    const bond = parseLICBond(rows);
    assert.deepEqual(
      { ...bond, riders: bond.riders.map((r) => r.premium) },
      {
        policyNumber: '900000001',
        planName: 'Jeevan Sample',
        planNo: '999',
        policyTerm: 20,
        premiumTerm: 12,
        commencement: date(2020, 1, 15),
        mode: 'Monthly',
        premium: 5225,
        basePremium: 5100,
        riders: [125],
        sumAssured: 500000,
        lastPremium: date(2031, 12, 15),
        maturity: date(2040, 1, 15),
        survivalBenefit: null,
      },
    );
  });

  test('the other column layout: total on the label line, quarterly mode, sum assured above its label', () => {
    const bond = parseLICBond(otherLayout);
    assert.equal(bond.policyNumber, '900000002');
    assert.equal(bond.planName, 'Example Gain');
    assert.equal(bond.mode, 'Quarterly');
    assert.equal(bond.premium, 12500);
    assert.equal(bond.basePremium, 12400.5);
    // Larger than the premium printed beside it, yet not mistaken for it.
    assert.equal(bond.sumAssured, 400000);
    assert.equal(bond.lastPremium, date(2030, 12, 10));
    assert.equal(bond.maturity, date(2037, 3, 10));
  });

  test('a missing total falls back to the base premium plus riders; a missing last premium date is worked out', () => {
    const lines = otherLayout.filter((l) => !l.startsWith('Total') && l !== '10-12-2030');
    const bond = parseLICBond(lines);
    assert.equal(bond.premium, 12500);
    // Ten years of quarterly premiums from 10 Mar 2021: the last is a quarter before the tenth anniversary.
    assert.equal(bond.lastPremium, date(2030, 12, 10));
  });

  test('other PDFs are refused with a plain message', () => {
    assert.ok(!isLICBond(['Public Provident Fund statement', 'Policy Number 1']));
    assert.throws(() => parseLICBond(['Statement of account']), (e) => e instanceof CASError && /LIC policy bond/.test(e.message));
    assert.throws(() => parseLICBond(otherLayout.filter((l) => !l.includes('Commencement of Policy'))), /date of commencement/);
  });
});

describe('Premium schedule', () => {
  test('monthly premiums are counted up to today; the one due today is still due', () => {
    const s = premiumSchedule(policy({ premiumInstalment: 4321 }), now);
    // 25 Mar 2022 to 25 Oct 2026: 56 premiums.
    assert.equal(s.count, 56);
    assert.equal(s.paid, 56 * 4321);
    assert.equal(s.next, date(2026, 11, 25));
    assert.equal(s.totalCount, 240);
    assert.equal(s.annual, 12 * 4321);
    const dueToday = premiumSchedule(policy(), date(2026, 11, 25) + 10 * 3600e3);
    assert.equal(dueToday.count, 56);
    assert.equal(dueToday.next, date(2026, 11, 25));
    assert.equal(premiumSchedule(policy(), date(2026, 11, 26)).count, 57);
  });

  test('a due date late in the month is clamped to shorter months, without drifting', () => {
    const a = policy({ premiumStartDate: date(2026, 1, 31), premiumEndDate: date(2026, 5, 31) });
    assert.equal(premiumSchedule(a, date(2026, 3, 1)).count, 2); // 31 Jan, 28 Feb
    assert.equal(premiumSchedule(a, date(2026, 3, 1)).next, date(2026, 3, 31));
    assert.equal(premiumSchedule(a, date(2026, 4, 1)).next, date(2026, 4, 30));
  });

  test('after the last premium nothing is due, and quarterly and yearly modes step by their months', () => {
    const done = premiumSchedule(policy({ premiumEndDate: date(2024, 2, 25) }), now);
    assert.equal(done.count, 24);
    assert.equal(done.next, null);
    const q = premiumSchedule(policy({ premiumMode: 'Quarterly' }), now);
    assert.equal(q.count, 19); // Mar 2022 … Sep 2026
    assert.equal(q.next, date(2026, 12, 25));
    assert.equal(premiumSchedule(policy({ premiumMode: 'Yearly' }), now).annual, 5000);
    assert.equal(premiumSchedule(policy({ premiumMode: undefined }), now), null);
  });

  test('without a surrender value the policy counts at the premiums paid; once entered, that value is kept', () => {
    const a = recompute(policy(), undefined, now);
    assert.equal(a.investedAmount, 280000);
    assert.equal(a.currentValuation, 280000);
    assert.equal(a.annualPremium, 60000);
    assert.equal(a.policyRenewalDate, date(2026, 11, 25));
    assert.deepEqual(upcomingRenewals([a], now).map((p) => p.id), [a.id]);
    assert.deepEqual(totals([a]), { value: 280000, invested: 280000, gain: 0 });

    const valued = recompute(policy({ currentValuation: 180000, surrenderValueDate: date(2026, 6, 1) }), undefined, now);
    assert.equal(valued.currentValuation, 180000);
    assert.equal(valued.investedAmount, 280000);
    // A month later the next premium is counted and the due date moves on by itself.
    const later = recompute(structuredClone(valued), undefined, date(2026, 12, 19));
    assert.equal(later.investedAmount, 285000);
    assert.equal(later.policyRenewalDate, date(2026, 12, 25));
    assert.equal(later.currentValuation, 180000);

    const term = recompute(policy({ policyType: 'Term Life', currentValuation: 1, investedAmount: 1 }), undefined, now);
    assert.ok(!countsTowardsNetWorth(term));
    assert.equal(term.currentValuation, 0);
  });
});

describe('LIC import and editing', () => {
  const bond = parseLICBond(otherLayout);

  test('a new policy is set up from the bond; the same policy number updates it and keeps what was entered', () => {
    const plan = planLICImport(bond, []);
    assert.equal(plan.action, 'new');
    const a = licAssetFrom(plan, bond, undefined, now);
    assert.equal(a.name, 'LIC Example Gain');
    assert.equal(a.institution, 'LIC');
    assert.equal(a.policyType, LIC_ENDOWMENT);
    assert.equal(a.policySumAssured, 400000);
    assert.equal(a.premiumMode, 'Quarterly');
    assert.equal(a.notes, 'Plan 998 · 16-year term · premiums for 10 years');
    assert.equal(a.investedAmount, 23 * 12500); // Mar 2021 … Sep 2026
    assert.equal(a.policyRenewalDate, date(2026, 12, 10));

    const mine = { ...a, name: 'Gain (mine)', notes: 'Mine', currentValuation: 150000, surrenderValueDate: date(2026, 4, 1) };
    const again = planLICImport(bond, [createAsset({ category: Category.insurance, name: 'Health', policyNumber: '1' }), mine]);
    assert.equal(again.action, 'update');
    const updated = licAssetFrom(again, bond, undefined, now);
    assert.equal(updated.id, a.id);
    assert.equal(updated.name, 'Gain (mine)');
    assert.equal(updated.notes, 'Mine');
    assert.equal(updated.currentValuation, 150000);
  });

  test('the form leaves the surrender value blank until entered, then dates it', () => {
    const a = licAssetFrom(planLICImport(bond, []), bond, undefined, now);
    const d = draftFromAsset(a, now);
    assert.equal(d.hasPremiumSchedule, true);
    assert.equal(d.currentValuation, null);
    assert.equal(validateDraft(d), null);
    assert.equal(validateDraft({ ...d, premiumInstalment: null }), 'Enter the instalment premium.');

    const unchanged = applyDraft(d, structuredClone(a), undefined, now);
    assert.equal(unchanged.surrenderValueDate, undefined);
    assert.equal(unchanged.currentValuation, unchanged.investedAmount);

    const entered = applyDraft({ ...d, currentValuation: 190000, surrenderValueDate: date(2026, 10, 1) }, structuredClone(a), undefined, now);
    assert.equal(entered.currentValuation, 190000);
    assert.equal(entered.surrenderValueDate, date(2026, 10, 1));

    // A new value a year on, with the date left as it was, is from today.
    const nextYear = date(2027, 10, 5);
    const d2 = draftFromAsset(entered, nextYear);
    assert.equal(d2.currentValuation, 190000);
    const renewed = applyDraft({ ...d2, currentValuation: 230000 }, structuredClone(entered), undefined, nextYear);
    assert.equal(renewed.surrenderValueDate, nextYear);

    // Turning counting off keeps the policy as entered by hand.
    const manual = applyDraft({ ...d, hasPremiumSchedule: false, investedAmount: 100000, currentValuation: 90000 }, structuredClone(a), undefined, now);
    assert.equal(manual.premiumMode, undefined);
    assert.equal(manual.investedAmount, 100000);
    assert.equal(manual.currentValuation, 90000);
  });

  test('the schedule survives a backup round trip', () => {
    const a = licAssetFrom(planLICImport(bond, []), bond, undefined, now);
    const [back] = parseBackup(exportBackup({ assets: [a], ppfRates: [] }, now)).assets;
    for (const key of ['premiumMode', 'premiumInstalment', 'premiumStartDate', 'premiumEndDate', 'policyNumber']) assert.equal(back[key], a[key], key);
  });
});
