import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAsset } from '../js/core/assets.js';
import { date as d } from '../js/core/calendar.js';
import { CASError } from '../js/core/cas.js';
import { Category } from '../js/core/categories.js';
import { bondFromHolding, isDebtISIN, isDepositoryStatement, parseDematBonds, parseStatementDate, planBondImport } from '../js/core/demat.js';
import { applyDraft, draftFromAsset, newDraft, validateDraft } from '../js/core/draft.js';

// Text lines as pdf.js hands them over (cells separated by tabs). Synthetic data, laid out like the NSDL and CDSL statements.
const NSDL = `
NSDL Consolidated Account Statement
Statement for the period from 01-Sep-2026 to 30-Sep-2026
Consolidated Portfolio Valuation
NSDL Demat Account	DP Name: SOME BROKING LIMITED
DP ID: IN300095	Client ID: 12345678
Equities (E)
ISIN	Stock Symbol	Company Name	Face Value (₹)	No. of Shares	Market Price (₹)	Value (₹)
INE002A01018	RELIANCE	RELIANCE INDUSTRIES LIMITED	10.00	50	2,950.10	1,47,505.00
Government Securities (G)
ISIN	Security	Coupon Rate	Maturity Date	Face Value	No. of Units	Market Price	Value (₹)
IN0020200195	SGB 2020-21 SERIES VIII	2.50%	10-Nov-2028	1.00	20	7,512.00	1,50,240.00
IN0020230085	GOI LOAN 7.18% 2033	7.18%	14-Aug-2033	100.00	1,000	101.25	1,01,250.00
Corporate Bonds (C)
ISIN	Description	Face Value	No. of Bonds	Market Price	Value (₹)
INE001A07RU8	HOUSING DEVELOPMENT FINANCE CORPORATION LIMITED SR-X NCD
1,000.00	25	1,012.50	25,312.50
Mutual Fund Folios (F)
INF179K01UT0	HDFC FLEXI CAP FUND - DIRECT GROWTH	112.345	2,143.156	2,40,770.54
Transactions for the period from 01-Sep-2026 to 30-Sep-2026
INE001A07RU8	HOUSING DEVELOPMENT FINANCE CORPORATION LIMITED SR-X NCD
05-Sep-2026	By Purchase	0	25	0	25
`.trim().split('\n');

const CDSL = `
CDSL	Central Depository Services (India) Limited
Consolidated Account Statement
For the period 01-09-2026 to 30-09-2026
BO ID: 1208160012345678	DP Name: SOME INVEST TECH
HOLDING STATEMENT AS ON 30-09-2026
ISIN	Security	Current Bal	Free Bal	Pledge Bal	Market Price / Face Value	Value
IN0020210152	SGBDEC2512 - 2.50% SOVEREIGN GOLD BONDS 2029 SR-VIII	10.000	10.000	0.000	7,512.00	75,120.00
INE848E07AB4	9.10% NCD NHPC SERIES 2030	50.000	50.000	0.000	1,000.00	50,000.00
INE009A01021	INFOSYS LIMITED - EQUITY SHARES	10.000	10.000	0.000	1,850.00	18,500.00
`.trim().split('\n');

describe('NSDL/CDSL bond import', () => {
  test('recognises depository statements and leaves CAMS ones alone', () => {
    assert.equal(isDepositoryStatement(NSDL), true);
    assert.equal(isDepositoryStatement(CDSL), true);
    assert.equal(isDepositoryStatement(['Consolidated Account Statement', 'Folio No: 123', 'Closing Unit Balance: 1.000', 'NSDL DP ID: IN300095']), false);
  });

  test('debt ISINs: government securities, SGBs and corporate bonds, not shares or funds', () => {
    assert.ok(isDebtISIN('IN0020200195'));
    assert.ok(isDebtISIN('IN1520230123'));
    assert.ok(isDebtISIN('INE001A07RU8'));
    assert.ok(isDebtISIN('INE848E08XY1'));
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

  test('NSDL: bonds with coupon and maturity; shares, funds and transactions ignored', () => {
    const s = parseDematBonds(NSDL);
    assert.equal(s.asOf, d(2026, 9, 30));
    assert.deepEqual(
      s.holdings.map((h) => [h.isin, h.name, h.value, h.coupon, h.maturity, h.account]),
      [
        ['IN0020200195', 'SGB 2020-21 SERIES VIII', 150240, 2.5, d(2028, 11, 10), 'IN30009512345678'],
        ['IN0020230085', 'GOI LOAN 7.18% 2033', 101250, 7.18, d(2033, 8, 14), 'IN30009512345678'],
        // The figures wrapped onto the next line.
        ['INE001A07RU8', 'HOUSING DEVELOPMENT FINANCE CORPORATION LIMITED SR-X NCD', 25312.5, null, null, 'IN30009512345678'],
      ],
    );
  });

  test('CDSL: BO ID account, coupon from the description', () => {
    const s = parseDematBonds(CDSL);
    assert.equal(s.asOf, d(2026, 9, 30));
    assert.deepEqual(
      s.holdings.map((h) => [h.isin, h.name, h.value, h.coupon, h.account]),
      [
        ['IN0020210152', 'SGBDEC2512 - 2.50% SOVEREIGN GOLD BONDS 2029 SR-VIII', 75120, 2.5, '1208160012345678'],
        ['INE848E07AB4', '9.10% NCD NHPC SERIES 2030', 50000, 9.1, '1208160012345678'],
      ],
    );
  });

  test('a description that wraps below its row joins the name; a heading after the table does not', () => {
    const lines = [
      'DP ID: IN300095\tClient ID: 12345678',
      'INE001A07RU8 EXAMPLE HOUSING FINANCE LIMITED\t1,000.00\t25\t1,012.50 25,312.50',
      'SR-X 8.25% NCD',
      'IN0020200195 SGB 2020-21 SERIES VIII 2.50%\t10-Nov-2028\t1.00\t20\t7,512.00 1,50,240.00',
      'Mutual Fund Folios',
      'IN0020230085 GOI LOAN 7.18% 2033 7.18% 14-Aug-2033 100.00 1,000 101.25 1,01,250.00',
      'Page 1 of 4',
    ];
    assert.deepEqual(
      parseDematBonds(lines).holdings.map((h) => [h.name, h.coupon, h.value]),
      [
        ['EXAMPLE HOUSING FINANCE LIMITED SR-X 8.25% NCD', 8.25, 25312.5],
        ['SGB 2020-21 SERIES VIII', 2.5, 150240],
        // No gaps wide enough for tabs: the figures are peeled off the end, taking the name's own figures with them.
        ['GOI LOAN', 7.18, 101250],
      ],
    );
  });

  test('a statement with only shares explains what is imported', () => {
    const sharesOnly = CDSL.filter((l) => !/^IN(0|E848)/.test(l));
    assert.throws(() => parseDematBonds(sharesOnly), (e) => e instanceof CASError && /No bonds/.test(e.message));
  });

  test('plan: re-imports match by ISIN + demat account; hand-entered bonds are left alone', () => {
    const now = d(2026, 10, 1);
    const s = parseDematBonds(CDSL);
    const imported = createAsset({ category: Category.bonds, name: 'SGB', isin: 'IN0020210152', folio: '1208160012345678', investedAmount: 60000, currentValuation: 70000 }, now);
    const sold = createAsset({ category: Category.bonds, name: 'Old NCD', isin: 'INE000X07AA1', folio: '1208160012345678', currentValuation: 1000 }, now);
    const otherAccount = createAsset({ category: Category.bonds, name: 'Elsewhere', isin: 'INE000X07BB1', folio: 'IN30009512345678' }, now);
    const manual = createAsset({ category: Category.bonds, name: 'HDFC Bank FD', investedAmount: 100000 }, now);
    const { items, missing } = planBondImport(s, [imported, sold, otherAccount, manual]);
    assert.deepEqual(items.map((i) => [i.holding.isin, i.action, i.existing?.name ?? null]), [
      ['IN0020210152', 'update', 'SGB'],
      ['INE848E07AB4', 'new', null],
    ]);
    assert.deepEqual(missing.map((a) => a.name), ['Old NCD']);
  });

  test('new bonds take the market value; updates keep the cost and the interest settings', () => {
    const now = d(2026, 10, 1);
    const s = parseDematBonds(NSDL);
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
    const bond = bondFromHolding({ holding: parseDematBonds(CDSL).holdings[1], existing: null }, now);
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
