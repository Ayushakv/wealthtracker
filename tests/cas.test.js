import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assetFromHolding, CASError, parseCAS, parseCASDate, planCASImport, schemeName } from '../js/core/cas.js';
import { createAsset } from '../js/core/assets.js';
import { date as d } from '../js/core/calendar.js';
import { Category } from '../js/core/categories.js';
import { validateDraft, draftFromAsset } from '../js/core/draft.js';
import { parseNAVAll } from '../tools/update-isin-map.mjs';

// Text lines as pdf.js hands them over for a CAMS + KFintech detailed statement (synthetic data, real ISINs).
const DETAILED = `
Consolidated Account Statement
01-Apr-2026 To 26-Oct-2026
This Consolidated Account Statement is brought to you as an investor friendly initiative by CAMS and KFintech
Email Id: someone@example.com
PORTFOLIO SUMMARY
Mutual Fund	Cost Value	Market Value
HDFC Mutual Fund	2,10,000.00	2,40,770.54
HDFC Mutual Fund
Folio No: 12345678 / 90	KYC: OK	PAN: OK
B205-HDFC Flexi Cap Fund - Direct Plan - Growth (Non-Demat) - ISIN: INF179K01UT0(Advisor: DIRECT) Registrar :
CAMS
Nominee 1: SOMEONE
Opening Unit Balance: 100.000
05-May-2026	Purchase - SIP	5,000.00	2.611	1,915.123	102.611
05-Jun-2026	Purchase - SIP	5,000.00	2.518	1,985.567	105.129
Closing Unit Balance: 112.345	NAV on 26-Oct-2026: INR 2,143.156	Total Cost Value: 2,10,000.00	Market Value on 26-Oct-2026: INR 2,40,770.54
Page 1 of 3
Date	Transaction	Amount (INR)	Units	Price (INR)	Unit Balance
PPFAS Mutual Fund
Folio No: 9876543	KYC: OK	PAN: OK
PP001ZG-Parag Parikh Flexi Cap Fund - Direct Plan - Growth (formerly Parag Parikh Long Term Equity Fund)
(Non-Demat) - ISIN: INF879O01027(Advisor: DIRECT) Registrar : KFINTECH
Opening Unit Balance: 1,000.000
12-Jul-2026	Purchase	10,000.00	114.155	87.6000	1,114.155
Page 2 of 3
Date	Transaction	Amount (INR)	Units	Price (INR)	Unit Balance
14-Aug-2026	Purchase	10,000.00	112.233	89.1000	1,226.388
Closing Unit Balance: 1,226.388	NAV on 26-Oct-2026: INR 89.3000
Total Cost Value: 85,000.00	Market Value on 26-Oct-2026: INR 1,09,516.45
Nippon India Mutual Fund
Folio No: 4040404040	KYC: OK	PAN: OK
RMFSCDG-Nippon India Small Cap Fund - Direct Plan Growth Plan - Growth Option - ISIN: INF204K01K15(Advisor: DIRECT) Registrar : KFINTECH
Opening Unit Balance: 250.000
02-Sep-2026	Redemption	-48,000.00	-250.000	192.0000	0.000
Closing Unit Balance: 0.000	NAV on 26-Oct-2026: INR 190.9855	Total Cost Value: 0.00	Market Value on 26-Oct-2026: INR 0.00
Example Mutual Fund
Folio No: 55555	KYC: OK	PAN: OK
EX12-Example Arbitrage Fund - Direct Growth - ISIN: INF000X01234(Advisor: DIRECT) Registrar : CAMS
Opening Unit Balance: 10.000
Closing Unit Balance: 10.000	NAV on 26-Oct-2026: INR 15.50	Total Cost Value: 140.00	Market Value on 26-Oct-2026: INR 155.00
`.trim().split('\n');

const SCHEMES = { INF179K01UT0: '118955', INF879O01027: '122639', INF204K01K15: '118778' };

describe('CAS parsing', () => {
  const s = parseCAS(DETAILED);

  test('statement date and every scheme, including redeemed ones', () => {
    assert.equal(s.asOf, d(2026, 10, 26));
    assert.deepEqual(s.holdings.map((h) => h.isin), ['INF179K01UT0', 'INF879O01027', 'INF204K01K15', 'INF000X01234']);
  });

  test('closing line values, folio and fund house', () => {
    const [hdfc] = s.holdings;
    assert.deepEqual(hdfc, {
      amc: 'HDFC Mutual Fund',
      folio: '12345678/90',
      scheme: 'HDFC Flexi Cap Fund - Direct Plan - Growth',
      isin: 'INF179K01UT0',
      registrar: 'CAMS',
      units: 112.345,
      nav: 2143.156,
      navDate: d(2026, 10, 26),
      cost: 210000,
      value: 240770.54,
    });
  });

  test('a scheme name wrapped over two lines and values split by a page break', () => {
    const ppfas = s.holdings[1];
    assert.equal(ppfas.scheme, 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth');
    assert.equal(ppfas.registrar, 'KFINTECH');
    assert.equal(ppfas.units, 1226.388);
    assert.equal(ppfas.cost, 85000);
    assert.equal(ppfas.value, 109516.45);
  });

  test('zero balance', () => {
    assert.equal(s.holdings[2].units, 0);
    assert.equal(s.holdings[2].amc, 'Nippon India Mutual Fund');
  });

  test('summary statement rows', () => {
    const summary = parseCAS([
      'Consolidated Account Summary',
      'As on 26-Oct-2026',
      'Folio No.	ISIN	Scheme Name	Cost Value	Unit Balance	NAV Date	NAV	Market Value	Registrar',
      'Mirae Asset Mutual Fund',
      '7700112233	INF769K01DM9	Mirae Asset ELSS Tax Saver Fund - Direct Plan - Growth	40,000.00	900.120	26-Oct-2026	53.336	48,008.80	KFINTECH',
      'UTI Mutual Fund',
      '1234/567	INF789F01XA0	UTI Nifty 50 Index Fund - Direct Plan - Growth	1,00,000.00	700.500	26-Oct-2026	160.253	1,12,257.23	CAMS',
    ]);
    assert.equal(summary.asOf, d(2026, 10, 26));
    assert.equal(summary.holdings.length, 2);
    assert.deepEqual(summary.holdings[1], {
      amc: 'UTI Mutual Fund',
      folio: '1234/567',
      scheme: 'UTI Nifty 50 Index Fund - Direct Plan - Growth',
      isin: 'INF789F01XA0',
      registrar: 'CAMS',
      units: 700.5,
      nav: 160.253,
      navDate: d(2026, 10, 26),
      cost: 100000,
      value: 112257.23,
    });
  });

  test('depository statements and unrelated PDFs get a helpful error', () => {
    assert.throws(() => parseCAS(['NSDL Consolidated Account Statement', 'Equities 12,000']), (e) => e instanceof CASError && /NSDL/.test(e.message));
    assert.throws(() => parseCAS(['Electricity bill', 'Amount due 1,200.00']), (e) => e instanceof CASError && /No mutual fund holdings/.test(e.message));
  });

  test('scheme name clean-up and dates', () => {
    assert.equal(schemeName('ABC1-Some Fund - Growth (Demat) - ISIN: INF000X01234 Registrar : CAMS'), 'Some Fund - Growth');
    assert.equal(parseCASDate('5-Jan-2027'), d(2027, 1, 5));
    assert.equal(parseCASDate('31-Foo-2027'), null);
  });
});

describe('CAS import plan', () => {
  const s = parseCAS(DETAILED);

  test('an empty portfolio gets new funds; fully redeemed ones are skipped', () => {
    const plan = planCASImport(s, [], SCHEMES);
    assert.deepEqual(plan.map((p) => p.action), ['new', 'new', 'skip', 'new']);
    assert.deepEqual(plan.map((p) => p.amfiCode), ['118955', '122639', '118778', undefined]);
  });

  test('a fund added by hand is updated when its AMFI code is unambiguous', () => {
    const manual = createAsset({ category: Category.mutualFund, name: 'My HDFC', amfiCode: '118955', unitsHeld: 90, averageNAV: 1800, latestNAV: 2200, navDate: d(2026, 10, 27) });
    const plan = planCASImport(s, [manual], SCHEMES);
    assert.equal(plan[0].action, 'update');
    assert.equal(plan[0].existing, manual);

    const a = assetFromHolding(plan[0], undefined, d(2026, 10, 27));
    assert.notEqual(a, manual, 'the stored asset is not mutated');
    assert.equal(manual.unitsHeld, 90);
    assert.equal(a.name, 'My HDFC');
    assert.equal(a.folio, '12345678/90');
    assert.equal(a.isin, 'INF179K01UT0');
    assert.equal(a.unitsHeld, 112.345);
    assert.equal(a.investedAmount, 210000);
    // The NAV fetched from mfapi.in on the 27th is newer than the statement's, so it stays.
    assert.equal(a.latestNAV, 2200);
    assert.equal(a.currentValuation, 112.345 * 2200);
  });

  test('two folios of one scheme never guess which manual fund is which', () => {
    const twoFolios = { asOf: s.asOf, holdings: [s.holdings[0], { ...s.holdings[0], folio: '111' }] };
    const manual = createAsset({ category: Category.mutualFund, name: 'HDFC', amfiCode: '118955', unitsHeld: 1 });
    assert.deepEqual(planCASImport(twoFolios, [manual], SCHEMES).map((p) => p.action), ['new', 'new']);
  });

  test('importing the same statement again updates instead of duplicating', () => {
    const first = planCASImport(s, [], SCHEMES).filter((p) => p.action !== 'skip').map((p) => assetFromHolding(p, undefined, d(2026, 10, 27)));
    const again = planCASImport(s, first, SCHEMES);
    assert.deepEqual(again.map((p) => p.action), ['update', 'update', 'skip', 'update']);
    assert.equal(again[1].existing, first[1]);
  });

  test('a redeemed fund already in the portfolio is updated to zero', () => {
    const nippon = createAsset({ category: Category.mutualFund, name: 'Nippon', folio: '4040404040', isin: 'INF204K01K15', amfiCode: '118778', unitsHeld: 250 });
    const plan = planCASImport(s, [nippon], SCHEMES);
    assert.equal(plan[2].action, 'update');
    const a = assetFromHolding(plan[2]);
    assert.equal(a.unitsHeld, 0);
    assert.equal(a.currentValuation, 0);
  });

  test('new funds take the statement name, fund house, cost and NAV', () => {
    const [item] = planCASImport(s, [], SCHEMES);
    const a = assetFromHolding(item, undefined, d(2026, 10, 27));
    assert.equal(a.category, Category.mutualFund);
    assert.equal(a.name, 'HDFC Flexi Cap Fund - Direct Plan - Growth');
    assert.equal(a.institution, 'HDFC Mutual Fund');
    assert.equal(a.amfiCode, '118955');
    assert.equal(a.latestNAV, 2143.156);
    assert.equal(a.navDate, d(2026, 10, 26));
    assert.ok(Math.abs(a.averageNAV * a.unitsHeld - 210000) < 1e-6);
    assert.ok(Math.abs(a.currentValuation - 112.345 * 2143.156) < 1e-6);
  });

  test('a fund without an AMFI code stays editable', () => {
    const item = planCASImport(s, [], SCHEMES)[3];
    const a = assetFromHolding(item);
    assert.equal(a.amfiCode, undefined);
    assert.equal(validateDraft(draftFromAsset(a)), null);
    assert.equal(validateDraft({ ...draftFromAsset(a), latestNAV: null }), 'Enter a numeric AMFI scheme code.');
    assert.equal(validateDraft({ ...draftFromAsset(a), amfiCode: 'abc' }), 'Enter a numeric AMFI scheme code.');
  });
});

describe('ISIN map', () => {
  test('reads both ISIN columns of AMFI NAVAll.txt', () => {
    const map = parseNAVAll(
      [
        'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date',
        '',
        'Open Ended Schemes(Equity Scheme - Flexi Cap Fund)',
        'HDFC Mutual Fund',
        '118955;INF179K01UT0;-;HDFC Flexi Cap Fund - Growth Option - Direct Plan;2143.156;26-Oct-2026',
        '118956;INF179K01UU8;INF179K01UV6;HDFC Flexi Cap Fund - IDCW - Direct Plan;80.1;26-Oct-2026',
      ].join('\r\n'),
    );
    assert.deepEqual(map, { INF179K01UT0: '118955', INF179K01UU8: '118956', INF179K01UV6: '118956' });
  });
});
