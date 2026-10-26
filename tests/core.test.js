import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, date as d, daysBetween, financialYearStart, fromInputValue, fyLabel, parts, quarterStart, toInputValue } from '../js/core/calendar.js';
import { inr, inrCompact, percent, formatDate } from '../js/core/format.js';
import { parseNAV, latestNAV, latestNAVs } from '../js/core/mfapi.js';
import { Category } from '../js/core/categories.js';
import { allocation, countsTowardsNetWorth, createAsset, recompute, totals, upcomingRenewals } from '../js/core/assets.js';
import { applyDraft, draftFromAsset, newDraft, validateDraft } from '../js/core/draft.js';
import { RateSchedule } from '../js/core/ppf.js';
import { samplePortfolio } from '../js/core/seed.js';
import { renewalCalendar } from '../js/core/ics.js';

describe('IST calendar', () => {
  test('dates are midnight IST regardless of the machine time zone', () => {
    assert.equal(new Date(d(2026, 4, 1)).toISOString(), '2026-03-31T18:30:00.000Z');
    assert.deepEqual(parts(d(2026, 4, 1)), { year: 2026, month: 4, day: 1, msOfDay: 0 });
  });

  test('adding months clamps to the end of shorter months', () => {
    assert.equal(addMonths(d(2026, 1, 31), 1), d(2026, 2, 28));
    assert.equal(addMonths(d(2024, 1, 31), 1), d(2024, 2, 29));
    assert.equal(addMonths(d(2026, 3, 15), -3), d(2025, 12, 15));
  });

  test('financial year and quarter', () => {
    assert.equal(financialYearStart(d(2027, 1, 15)), 2026);
    assert.equal(financialYearStart(d(2026, 4, 1)), 2026);
    assert.equal(fyLabel(2026), 'FY 2026-27');
    assert.equal(fyLabel(2099), 'FY 2099-00');
    assert.equal(quarterStart(d(2026, 11, 20)), d(2026, 10, 1));
    assert.equal(quarterStart(d(2027, 2, 2)), d(2027, 1, 1));
  });

  test('date inputs round-trip', () => {
    assert.equal(toInputValue(d(2026, 10, 26)), '2026-10-26');
    assert.equal(fromInputValue('2026-10-26'), d(2026, 10, 26));
    assert.equal(fromInputValue(''), undefined);
    assert.equal(daysBetween(d(2026, 1, 1), d(2026, 7, 2)), 182);
  });
});

describe('Formatting', () => {
  test('Indian grouping', () => {
    assert.equal(inr(1_234_567), '₹12,34,567');
    assert.equal(inr(-0.2), '₹0');
  });

  test('compact lakh / crore', () => {
    assert.equal(inrCompact(350_000), '₹3.50 L');
    assert.equal(inrCompact(12_345_678), '₹1.23 Cr');
    assert.equal(inrCompact(-250_000), '-₹2.50 L');
    assert.equal(inrCompact(4_500), '₹4,500');
  });

  test('percent and dates', () => {
    assert.equal(percent(0.1234), '12.3%');
    assert.equal(formatDate(d(2026, 10, 26)), '26 Oct 2026');
  });
});

describe('mfapi.in client', () => {
  const sample = { meta: { fund_house: 'HDFC Mutual Fund', scheme_code: 118955, scheme_name: 'HDFC Flexi Cap Fund - Direct Plan - Growth Option' }, data: [{ date: '16-10-2026', nav: '2184.72800' }], status: 'SUCCESS' };

  test('parses latest NAV', () => {
    const q = parseNAV(JSON.stringify(sample), '118955');
    assert.equal(q.nav, 2184.728);
    assert.equal(q.fundHouse, 'HDFC Mutual Fund');
    assert.equal(q.date, d(2026, 10, 16));
  });

  test('unknown scheme codes return 200 with empty data', () => {
    assert.throws(() => parseNAV({ meta: { fund_house: '', scheme_code: 0, scheme_name: '' }, data: [], status: 'SUCCESS' }, '99999999'), { kind: 'schemeNotFound' });
  });

  test('malformed payloads are rejected', () => {
    assert.throws(() => parseNAV('<html>', '1'), { kind: 'malformedPayload' });
    assert.throws(() => parseNAV({ meta: {}, data: [{ date: '16-10-2026', nav: 'N.A.' }] }, '1'), { kind: 'malformedPayload' });
  });

  test('rejects non-numeric codes without a network call', async () => {
    let called = false;
    await assert.rejects(latestNAV('HDFC', () => { called = true; }), { kind: 'invalidSchemeCode' });
    assert.equal(called, false);
  });

  test('batch reports failures per code', async () => {
    const fake = async (url) => ({ ok: true, json: async () => (url.includes('118955') ? sample : { meta: {}, data: [] }) });
    const r = await latestNAVs(['118955', '99999999', '118955'], fake);
    assert.equal(r.size, 2);
    assert.equal(r.get('118955').ok, true);
    assert.equal(r.get('99999999').error.kind, 'schemeNotFound');
  });

  test('requests bypass mfapi.in caching so browsers get CORS headers', async () => {
    const urls = [];
    await latestNAV('118955', async (url) => (urls.push(url), { ok: true, json: async () => sample }));
    assert.match(urls[0], /^https:\/\/api\.mfapi\.in\/mf\/118955\/latest\?t=\d+$/);
  });

  test('live fetch (set LIVE_NETWORK_TESTS=1)', { skip: !process.env.LIVE_NETWORK_TESTS }, async () => {
    const r = await latestNAVs(['118955', '99999999']);
    assert.ok(r.get('118955').quote.nav > 0);
    assert.equal(r.get('99999999').ok, false);
    // Browsers need this header; mfapi.in only sends it on uncached responses.
    const res = await fetch(`https://api.mfapi.in/mf/118955/latest?t=${Date.now()}`, { headers: { Origin: 'https://example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });
});

describe('Assets and dashboard', () => {
  const now = d(2026, 10, 26);
  const rates = RateSchedule.official;

  test('health and term cover are excluded from net worth; LIC counts', () => {
    assert.equal(countsTowardsNetWorth({ category: Category.insurance, policyType: 'Health' }), false);
    assert.equal(countsTowardsNetWorth({ category: Category.insurance, policyType: 'LIC Endowment' }), true);
    assert.equal(countsTowardsNetWorth({ category: Category.bank }), true);
  });

  test('mutual fund value is units × NAV', () => {
    const a = recompute(createAsset({ name: 'MF', category: Category.mutualFund, unitsHeld: 10, averageNAV: 100, latestNAV: 150 }, now), rates, now);
    assert.equal(a.investedAmount, 1000);
    assert.equal(a.currentValuation, 1500);
  });

  test('sample portfolio totals and allocation', () => {
    const assets = samplePortfolio(rates, now);
    assert.equal(assets.length, 9);
    const t = totals(assets);
    const slices = allocation(assets);
    assert.equal(slices.length, 6);
    assert.ok(Math.abs(slices.reduce((s, x) => s + x.fraction, 0) - 1) < 1e-9);
    assert.ok(Math.abs(slices.reduce((s, x) => s + x.value, 0) - t.value) < 1e-6);
    assert.deepEqual(upcomingRenewals(assets, now).map((a) => a.name), ['HDFC Ergo Optima Secure']);
    // Health cover is valued at zero; PPF includes this FY's deposits (Apr–Oct = 7 × 12,500).
    assert.equal(assets.find((a) => a.policyType === 'Health').currentValuation, 0);
    assert.equal(assets.find((a) => a.category === Category.ppf).investedAmount, 682_340 + 7 * 12_500);
  });
});

describe('Asset form rules', () => {
  const now = d(2026, 10, 26);

  test('validation messages match the iOS app', () => {
    assert.equal(validateDraft(newDraft(Category.bank, now)), 'Enter a name.');
    assert.equal(validateDraft({ ...newDraft(Category.bank, now), name: 'X', bankLast4: '12a4' }), 'Last 4 digits must be 4 numbers.');
    assert.equal(validateDraft({ ...newDraft(Category.mutualFund, now), name: 'X', amfiCode: '1', unitsHeld: 0 }), 'Enter units held.');
    assert.equal(validateDraft({ ...newDraft(Category.nps, now), name: 'X', npsEquityPct: 60, npsGovtBondPct: 30 }), 'E/C/G/A split must add up to 100%.');
    assert.equal(validateDraft({ ...newDraft(Category.bonds, now), name: 'X', investedAmount: 1000, interestRate: 7 }), null);
  });

  test('bank balance is also the invested amount', () => {
    const a = applyDraft({ ...newDraft(Category.bank, now), name: 'HDFC', currentValuation: 5000 }, null, RateSchedule.official, now);
    assert.equal(a.investedAmount, 5000);
    assert.match(a.id, /^[0-9A-F-]{36}$/);
  });

  test('editing round-trips through a draft', () => {
    const [ , , mf] = samplePortfolio(RateSchedule.official, now);
    const draft = draftFromAsset(mf, now);
    draft.unitsHeld = 500;
    applyDraft(draft, mf, RateSchedule.official, now);
    assert.equal(mf.currentValuation, 500 * 1980);
    assert.equal(mf.amfiCode, '118955');
  });

  test('non-LIC policies drop the maturity date', () => {
    const a = applyDraft({ ...newDraft(Category.insurance, now), name: 'Term', policyType: 'Term Life', hasMaturityDate: true }, null, RateSchedule.official, now);
    assert.equal(a.maturityDate, undefined);
    assert.equal(a.currentValuation, 0);
  });
});

describe('Renewal calendar file', () => {
  test('one all-day event per policy with 30/15/3-day alarms at 9 am', () => {
    const ics = renewalCalendar([{ id: 'ABC', name: 'Optima, Secure; Plan', policyType: 'Health', annualPremium: 24380, policyRenewalDate: d(2026, 11, 23) }], d(2026, 10, 26));
    assert.match(ics, /DTSTART;VALUE=DATE:20261123\r\n/);
    assert.match(ics, /DTEND;VALUE=DATE:20261124\r\n/);
    assert.match(ics, /SUMMARY:Renewal due: Optima\\, Secure\\; Plan\r\n/);
    assert.deepEqual([...ics.matchAll(/TRIGGER:(\S+)/g)].map((m) => m[1]), ['-P29DT15H', '-P14DT15H', '-P2DT15H']);
    assert.ok(ics.split('\r\n').every((line) => new TextEncoder().encode(line).length <= 75));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  });
});
