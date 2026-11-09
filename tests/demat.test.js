import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAsset } from '../js/core/assets.js';
import { date as d } from '../js/core/calendar.js';
import { CASError } from '../js/core/cas.js';
import { Category } from '../js/core/categories.js';
import { bondFromHolding, goneFromStatement, isDebtISIN, isDepositoryStatement, parseDemat, parseStatementDate, planBondImport } from '../js/core/demat.js';
import { applyDraft, draftFromAsset, newDraft, validateDraft } from '../js/core/draft.js';

/**
 * Lays out statement lines the way pdfRows hands them over: one line every 8pt down the page (an empty string adds a
 * gap, like the padding between table rows), cells split at two or more spaces, 4pt per character across.
 * Synthetic data, laid out like the NSDL and CDSL statements.
 */
function page(lines, n = 1) {
  return lines.flatMap((line, i) => {
    const cells = [...line.matchAll(/\S+(?: \S+)*/g)].map((m) => ({ x: m.index * 4, end: (m.index + m[0].length) * 4, h: 7, text: m[0] }));
    return cells.length ? [{ page: n, y: 800 - i * 8, text: cells.map((c) => c.text).join('\t'), cells }] : [];
  });
}
/** A table line: the ISIN, the description column, then the other columns. */
const L = (isin = '', description = '', ...rest) => `${isin.padEnd(14)}${description.padEnd(64)}${rest.join('  ')}`.trimEnd();

const NSDL = page([
  'NSDL Consolidated Account Statement',
  'Statement for the period from 01-Sep-2026 to 30-Sep-2026',
  'Consolidated Portfolio Valuation',
  // The summary: each section's value across every account, and its share of the total.
  'Asset Class  Value (₹)  %',
  'Equities (E)  1,47,505.00  15.00%',
  'Mutual Funds (M)  20,102.63  2.00%',
  'Corporate Bonds (C)  2,38,580.00  30.00%',
  'Securitised Instruments (S)  2,01,840.00  20.00%',
  'Government Securities (G)  2,51,490.00  25.00%',
  'Mutual Fund Folios (F)  2,40,770.54  8.00%',
  'NSDL Demat Account  DP Name: SOME BROKING LIMITED',
  'DP ID: IN300095  Client ID: 12345678',
  'Equities (E)',
  L('ISIN', 'Company Name', 'Face Value (₹)  No. of Shares  Market Price (₹)  Value (₹)'),
  L('INE002A01018', 'RELIANCE INDUSTRIES LIMITED', '10.00', '50', '2,950.10', '1,47,505.00'),
  'Government Securities (G)',
  L('ISIN', 'Security', 'Coupon Rate  Maturity Date  Face Value  No. of Units  Market Price  Value (₹)'),
  L('IN0020200195', 'SGB 2020-21 SERIES VIII', '2.50%', '10-Nov-2028', '1.00', '20', '7,512.00', '1,50,240.00'),
  L('IN0020230085', 'GOI LOAN 7.18% 2033', '7.18%', '14-Aug-2033', '100.00', '1,000', '101.25', '1,01,250.00'),
  'Corporate Bonds (C)',
  L('ISIN', 'Company Name', 'Coupon Rate/  Maturity Date  No. of Bonds  Face Value  Market Price  Value (₹)'),
  L('', '', 'Frequency'),
  // The name is centred on the ISIN's line, wrapped above and below it, with the bond's kind in italics underneath.
  L('', 'EXAMPLE FINANCE LIMITED'),
  L('INE000A07AA1', '', 'QUARTERLY', '04-Aug-2028', '2', '10,000.00', '10,000.00', '20,000.00'),
  L('', 'Fixed Interest Bonds'),
  '',
  L('', 'SAMPLE CREDIT CAPITAL PRIVATE', 'Twelve times a'),
  L('INE000B07AB2', 'LIMITED', '29-Sep-2027', '5', '10,000.00', 'Not Available', '50,000.00'),
  L('', 'Fixed Interest Bonds', 'year'),
  '',
  L('', 'SAMPLE CREDIT CAPITAL PRIVATE', 'Twelve times a'),
  L('INE000B07AC0', 'LIMITED', '26-Apr-2028', '2', '10,000.00', '10,000.00', '20,000.00'),
  L('', 'Fixed Interest Bonds', 'year'),
  'Sub Total  90,000.00',
  'Mutual Fund Folios (F)',
  L('INF179K01UT0', 'HDFC FLEXI CAP FUND - DIRECT GROWTH', '112.345', '2,143.156', '2,40,770.54'),
  'CDSL Demat Account',
  'DP ID : 12081800 Client ID: 87654321',
  'Securitised Instruments (S)',
  L('ISIN', 'SECURITY', 'Current Bal.  Free Bal.  Lent Bal.  Market Price / Face Value  Value (₹)'),
  // Three balances stacked in each column; the security reads "ISSUER#COUPON TERMS … RD <maturity>".
  L('', '', '2.000  0.000  0.000'),
  L('', 'EXAMPLE TRUST MAY 2025#11.40% SEC TAX NCUM RTD'),
  L('INE000C15011', '', '2.000  0.000  0.000', '1,00,920.00', '2,01,840.00'),
  L('', 'RED PRN PRT PTC SR A1 LOA-RD 28-09-2027'),
  L('', '', '0.000  0.000  0.000'),
  'Sub Total  2,01,840.00',
  // A fund held in the demat account: units stacked by balance (current, safekeep, pledged), the NAV and the value.
  'Mutual Funds (M)',
  L('ISIN', 'ISIN Description', 'Current Bal.  Safekeep Bal.  Pledged Bal.  NAV  Value (₹)'),
  L('', '', '250.500  0.000  0.000'),
  L('INF000Y01AB2', 'EXAMPLE MUTUAL FUND', '0.000  250.500  0.000', '80.25', '20,102.63'),
  L('', '', '0.000  0.000  0.000'),
  'Sub Total  20,102.63',
  'Corporate Bonds (C)',
  L('ISIN', 'SECURITY', 'Current Bal.  Free Bal.  Lent Bal.  Market Price / Face Value  Value (₹)'),
  L('', 'SAMPLE CREDIT CAPITAL PRIVATE LTD#12% SEC GRT', '5.000  0.000  0.000'),
  L('INE000B07AB2', 'SNR TAX NCUM RTD RED PRN PRT NCD SR A PP-RD', '5.000  0.000  0.000', '9,826.00', '49,130.00'),
  L('', '29-09-2027', '0.000  0.000  0.000'),
  '',
  L('', 'SAMPLE CREDIT CAPITAL PRIVATE LTD#13%SEC GRT SNR', '10.000  0.000  0.000'),
  L('INE000B07AD8', 'TAX NCUM RAT RED PN PT NCD PP-', '10.000  0.000  0.000', '9,945.00', '99,450.00'),
  L('', 'RD-24052027', '0.000  0.000  0.000'),
  'Sub Total  1,48,580.00',
  // A lock-in list after the bonds: fund units, not bonds.
  L('INF000Y01AB2', 'EXAMPLE MUTUAL FUND', 'LOCK-IN', '23-Sep-2027', 'ELSS2005', '31.33'),
  'Transactions for the period from 01-Sep-2026 to 30-Sep-2026',
  'DP ID : IN300095 Client ID: 12345678',
  'ISIN : INE000A07AA1 - EXAMPLE FINANCE LIMITED',
  '05-Sep-2026  By Purchase  0  2  0  2',
  L('INE000A07AA1', 'EXAMPLE FINANCE LIMITED', '2', '0', '2'),
  '***End of Statement***',
]);

const CDSL = page([
  'CDSL  Central Depository Services (India) Limited',
  'Consolidated Account Statement',
  'For the period 01-09-2026 to 30-09-2026',
  'BO ID: 1208160012345678  DP Name: SOME INVEST TECH',
  'HOLDING STATEMENT AS ON 30-09-2026',
  L('ISIN', 'Security', 'Current Bal  Free Bal  Pledge Bal  Market Price / Face Value  Value'),
  L('IN0020210152', 'SGBDEC2512 - 2.50% SOVEREIGN GOLD BONDS 2029 SR-VIII', '10.000', '10.000', '0.000', '7,512.00', '75,120.00'),
  L('INE848E07AB4', '9.10% NCD NHPC SERIES 2030', '50.000', '50.000', '0.000', '1,000.00', '50,000.00'),
  L('INE009A01021', 'INFOSYS LIMITED - EQUITY SHARES', '10.000', '10.000', '0.000', '1,850.00', '18,500.00'),
]);
const text = (rows) => rows.map((r) => r.text);

describe('NSDL/CDSL bond import', () => {
  test('recognises depository statements and leaves CAMS ones alone', () => {
    assert.equal(isDepositoryStatement(text(NSDL)), true);
    assert.equal(isDepositoryStatement(text(CDSL)), true);
    assert.equal(isDepositoryStatement(['Consolidated Account Statement', 'Folio No: 123', 'Closing Unit Balance: 1.000', 'NSDL DP ID: IN300095']), false);
  });

  test('debt ISINs: government securities, SGBs and corporate bonds, not shares or funds', () => {
    assert.ok(isDebtISIN('IN0020200195'));
    assert.ok(isDebtISIN('IN1520230123'));
    assert.ok(isDebtISIN('INE001A07RU8'));
    assert.ok(isDebtISIN('INE848E08XY1'));
    // Without a section heading to go by, PTCs and the like aren't recognised from the ISIN alone.
    assert.ok(!isDebtISIN('INE000C15011'));
    assert.ok(!isDebtISIN('INE002A01018'));
    assert.ok(!isDebtISIN('INF179K01UT0'));
  });

  test('statement dates', () => {
    assert.equal(parseStatementDate('30-Sep-2026'), d(2026, 9, 30));
    assert.equal(parseStatementDate('30-09-2026'), d(2026, 9, 30));
    assert.equal(parseStatementDate('30/09/2026'), d(2026, 9, 30));
    assert.equal(parseStatementDate('31-13-2026'), null);
    assert.equal(parseStatementDate('7.18%'), null);
  });

  test('NSDL and CDSL tables: wrapped names, coupons and maturities; shares, funds and transactions ignored', () => {
    const s = parseDemat(NSDL);
    assert.equal(s.asOf, d(2026, 9, 30));
    assert.deepEqual(
      s.holdings.map((h) => [h.account, h.isin, h.name, h.value, h.coupon, h.maturity]),
      [
        ['IN30009512345678', 'IN0020200195', 'SGB 2020-21 SERIES VIII', 150240, 2.5, d(2028, 11, 10)],
        ['IN30009512345678', 'IN0020230085', 'GOI LOAN 7.18% 2033', 101250, 7.18, d(2033, 8, 14)],
        ['IN30009512345678', 'INE000A07AA1', 'EXAMPLE FINANCE LIMITED', 20000, null, d(2028, 8, 4)],
        // One issuer's bonds get their coupon and maturity in the name; NSDL's table has no coupon, but the same bond in the CDSL account does.
        ['IN30009512345678', 'INE000B07AB2', 'SAMPLE CREDIT CAPITAL PRIVATE LIMITED 12% Sep 2027', 50000, 12, d(2027, 9, 29)],
        ['IN30009512345678', 'INE000B07AC0', 'SAMPLE CREDIT CAPITAL PRIVATE LIMITED Apr 2028', 20000, null, d(2028, 4, 26)],
        // Securitised instruments (PTCs) are debt too.
        ['1208180087654321', 'INE000C15011', 'EXAMPLE TRUST MAY 2025', 201840, 11.4, d(2027, 9, 28)],
        ['1208180087654321', 'INE000B07AB2', 'SAMPLE CREDIT CAPITAL PRIVATE LTD 12% Sep 2027', 49130, 12, d(2027, 9, 29)],
        ['1208180087654321', 'INE000B07AD8', 'SAMPLE CREDIT CAPITAL PRIVATE LTD 13% May 2027', 99450, 13, d(2027, 5, 24)],
      ],
    );
  });

  test('funds in a demat account: units, NAV and value; folio funds and lock-in lists are left out', () => {
    assert.deepEqual(
      parseDemat(NSDL).funds.map((f) => [f.account, f.isin, f.name, f.units, f.nav, f.value]),
      [['1208180087654321', 'INF000Y01AB2', 'EXAMPLE MUTUAL FUND', 250.5, 80.25, 20102.63]],
    );
    assert.deepEqual(parseDemat(CDSL).funds, []);
  });

  test('a statement with only demat funds is imported', () => {
    const rows = page([
      'DP ID : 12081800 Client ID: 87654321',
      'Mutual Funds (M)',
      L('ISIN', 'ISIN Description', 'Current Bal.  Safekeep Bal.  Pledged Bal.  NAV  Value (₹)'),
      L('INF000Y01AB2', 'EXAMPLE MUTUAL FUND', '100.000  0.000  0.000', '50.00', '5,000.00'),
    ]);
    const s = parseDemat(rows);
    assert.deepEqual(s.holdings, []);
    assert.deepEqual(s.funds.map((f) => [f.units, f.nav, f.value]), [[100, 50, 5000]]);
  });

  test('each holding keeps its section; the summary gives each section’s total', () => {
    const s = parseDemat(NSDL);
    assert.deepEqual(
      s.holdings.map((h) => [h.isin, h.section]),
      [
        ['IN0020200195', 'Government Securities'],
        ['IN0020230085', 'Government Securities'],
        ['INE000A07AA1', 'Corporate Bonds'],
        ['INE000B07AB2', 'Corporate Bonds'],
        ['INE000B07AC0', 'Corporate Bonds'],
        ['INE000C15011', 'Securitised Instruments'],
        ['INE000B07AB2', 'Corporate Bonds'],
        ['INE000B07AD8', 'Corporate Bonds'],
      ],
    );
    assert.equal(s.funds[0].section, 'Mutual Funds');
    assert.deepEqual(s.summary, {
      Equities: 147505,
      'Mutual Funds': 20102.63,
      'Corporate Bonds': 238580,
      'Securitised Instruments': 201840,
      'Government Securities': 251490,
      'Mutual Fund Folios': 240770.54,
    });
    // What was read adds up to the summary, section by section.
    const total = (section) => s.holdings.filter((h) => h.section === section).reduce((sum, h) => sum + h.value, 0);
    for (const section of ['Corporate Bonds', 'Securitised Instruments', 'Government Securities']) assert.equal(total(section), s.summary[section], section);
    // Without section headings, the ISIN decides.
    assert.deepEqual(parseDemat(CDSL).holdings.map((h) => h.section), ['Government Securities', 'Corporate Bonds']);
    assert.equal(bondFromHolding({ holding: s.holdings[5], existing: null }).instrument, 'Securitised Instruments');
  });

  test('a table split across pages keeps each name with its own bond', () => {
    const rows = [
      ...page(['DP ID : IN300095 Client ID: 12345678', 'Corporate Bonds (C)', L('ISIN', 'Company Name', 'Value'), L('', 'FIRST FINANCE'), L('INE000D07AA7', 'LIMITED', '12-Jan-2028', '10,000.00'), L('', 'Fixed Interest Bonds')], 1),
      ...page(['Page 2', 'Consolidated Account Statement', L('ISIN', 'Company Name', 'Value'), L('', 'SECOND FINANCE LIMITED'), L('INE000E07AA5', '', '12-Feb-2028', '20,000.00'), L('', 'Fixed Interest Bonds'), 'Sub Total  30,000.00'], 2),
    ];
    assert.deepEqual(parseDemat(rows).holdings.map((h) => [h.isin, h.name, h.value]), [
      ['INE000D07AA7', 'FIRST FINANCE LIMITED', 10000],
      ['INE000E07AA5', 'SECOND FINANCE LIMITED', 20000],
    ]);
  });

  test('CDSL: BO ID account, coupon from the description', () => {
    const s = parseDemat(CDSL);
    assert.equal(s.asOf, d(2026, 9, 30));
    assert.deepEqual(
      s.holdings.map((h) => [h.isin, h.name, h.value, h.coupon, h.account]),
      [
        ['IN0020210152', 'SGBDEC2512 - 2.50% SOVEREIGN GOLD BONDS 2029 SR-VIII', 75120, 2.5, '1208160012345678'],
        ['INE848E07AB4', '9.10% NCD NHPC SERIES 2030', 50000, 9.1, '1208160012345678'],
      ],
    );
  });

  test('a description that wraps below its row joins the name; figures can share its cell or wrap to the next line', () => {
    const rows = page([
      'DP ID: IN300095  Client ID: 12345678',
      L('INE001A07RU8', 'EXAMPLE HOUSING FINANCE LIMITED', '1,000.00', '25', '1,012.50 25,312.50'),
      L('', 'SR-X 8.25% NCD'),
      '',
      L('IN0020200195', 'SGB 2020-21 SERIES VIII 2.50% 10-Nov-2028', '1.00', '20', '7,512.00 1,50,240.00'),
      '',
      L('INE001A07RV6', 'EXAMPLE HOUSING FINANCE LIMITED SR-Y NCD'),
      L('', '', '1,000.00', '10', '1,000.00', '10,000.00'),
      '',
      // No gaps wide enough to split cells: the figures are peeled off the end, taking the name's own figures with them.
      L('IN0020230085', 'GOI LOAN 7.18% 2033 7.18% 14-Aug-2033 100.00 1,000 101.25 1,01,250.00'),
      'Page 1 of 4',
    ]);
    assert.deepEqual(
      parseDemat(rows).holdings.map((h) => [h.name, h.coupon, h.maturity, h.value]),
      [
        ['EXAMPLE HOUSING FINANCE LIMITED SR-X 8.25% NCD', 8.25, null, 25312.5],
        ['SGB 2020-21 SERIES VIII', 2.5, d(2028, 11, 10), 150240],
        ['EXAMPLE HOUSING FINANCE LIMITED SR-Y NCD', null, null, 10000],
        ['GOI LOAN', 7.18, d(2033, 8, 14), 101250],
      ],
    );
  });

  test('a statement with only shares explains what is imported', () => {
    const sharesOnly = CDSL.filter((r) => !/^IN(0|E848)/.test(r.text));
    assert.throws(() => parseDemat(sharesOnly), (e) => e instanceof CASError && /No bonds/.test(e.message));
  });

  test('plan: re-imports match by ISIN + demat account; hand-entered bonds are left alone', () => {
    const now = d(2026, 10, 1);
    const s = parseDemat(CDSL);
    const imported = createAsset({ category: Category.bonds, name: 'SGB', isin: 'IN0020210152', folio: '1208160012345678', investedAmount: 60000, currentValuation: 70000 }, now);
    const sold = createAsset({ category: Category.bonds, name: 'Old NCD', isin: 'INE000X07AA1', folio: '1208160012345678', currentValuation: 1000 }, now);
    const otherAccount = createAsset({ category: Category.bonds, name: 'Elsewhere', isin: 'INE000X07BB1', folio: 'IN30009512345678' }, now);
    const manual = createAsset({ category: Category.bonds, name: 'HDFC Bank FD', investedAmount: 100000 }, now);
    const camsFund = createAsset({ category: Category.mutualFund, name: 'Folio fund', isin: 'INF000Z01AA1', folio: '9876543/21' }, now);
    const dematFund = createAsset({ category: Category.mutualFund, name: 'Redeemed demat fund', isin: 'INF000Z01AB9', folio: '1208160012345678' }, now);
    const assets = [imported, sold, otherAccount, manual, camsFund, dematFund];
    const { items } = planBondImport(s, assets);
    assert.deepEqual(items.map((i) => [i.holding.isin, i.action, i.existing?.name ?? null]), [
      ['IN0020210152', 'update', 'SGB'],
      ['INE848E07AB4', 'new', null],
    ]);
    // Monthly re-imports drop what earlier imports brought in and the statement no longer lists, in any demat account.
    // Hand-entered bonds and funds from a CAMS folio are left alone.
    const matched = new Set(items.map((i) => i.existing?.id).filter(Boolean));
    assert.deepEqual(goneFromStatement(assets, matched).map((a) => a.name), ['Old NCD', 'Elsewhere', 'Redeemed demat fund']);
  });

  test('new bonds take the market value; updates keep the cost and the interest settings', () => {
    const now = d(2026, 10, 1);
    const s = parseDemat(NSDL);
    const fresh = bondFromHolding({ holding: s.holdings[0], existing: null }, now);
    assert.equal(fresh.category, Category.bonds);
    assert.equal(fresh.name, 'SGB 2020-21 SERIES VIII');
    assert.equal(fresh.investedAmount, 150240);
    assert.equal(fresh.currentValuation, 150240);
    assert.equal(fresh.interestRate, 2.5);
    assert.equal(fresh.maturityDate, d(2028, 11, 10));
    assert.equal(fresh.folio, 'IN30009512345678');
    assert.equal(fresh.startDate, undefined);

    const existing = { ...fresh, investedAmount: 96000, currentValuation: 140000, interestRate: 2.5 };
    const updated = bondFromHolding({ holding: { ...s.holdings[0], value: 152000 }, existing }, now);
    assert.equal(updated.id, fresh.id);
    assert.equal(updated.investedAmount, 96000);
    assert.equal(updated.currentValuation, 152000);
    assert.equal(existing.currentValuation, 140000, 'the stored asset is not mutated');

    // A bond the user switched to interest calculation keeps its computed value.
    const accruing = { ...fresh, startDate: d(2025, 10, 1), currentValuation: 155000 };
    assert.equal(bondFromHolding({ holding: s.holdings[0], existing: accruing }, now).currentValuation, 155000);
  });

  test('market-valued bonds edit and save without a start date', () => {
    const now = d(2026, 10, 1);
    const bond = bondFromHolding({ holding: parseDemat(CDSL).holdings[1], existing: null }, now);
    const draft = draftFromAsset(bond, now);
    assert.equal(draft.hasStartDate, false);
    assert.equal(validateDraft(draft), null);
    const saved = applyDraft({ ...draft, currentValuation: 51000 }, structuredClone(bond), undefined, now);
    assert.equal(saved.currentValuation, 51000);
    assert.equal(saved.startDate, undefined);

    assert.equal(validateDraft({ ...draft, currentValuation: null }), 'Enter the current value.');
    // With interest calculation on, the rate is required and the value comes from it.
    assert.equal(validateDraft({ ...draft, hasStartDate: true, interestRate: null }), 'Enter the interest rate.');
    const accruing = applyDraft({ ...draft, hasStartDate: true, startDate: d(2025, 10, 1) }, structuredClone(bond), undefined, now);
    assert.ok(accruing.currentValuation > 50000);
    // New bonds still default to interest calculation.
    assert.equal(newDraft(Category.bonds, now).hasStartDate, true);
  });
});
