import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { date as d } from '../js/core/calendar.js';
import { ppfStatement, RateSchedule, OFFICIAL_HISTORY } from '../js/core/ppf.js';

const flat = RateSchedule.flat(7.1);
const close = (actual, expected, tol = 0.01) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} ≉ ${expected}`);

describe('PPF interest engine', () => {
  test('lump sum on the 5th earns all 12 months', () => {
    const s = ppfStatement({ openingBalance: 0, openingFYStartYear: 2024, transactions: [{ date: d(2024, 4, 5), amount: 150_000 }], rates: flat, asOf: d(2025, 4, 1) });
    assert.equal(s.years[0].interestAccrued, 10_650);
    assert.equal(s.creditedBalance, 160_650);
    assert.equal(s.accruedInterest, 0);
  });

  test('deposit on the 6th misses that month', () => {
    const s = ppfStatement({ openingBalance: 0, openingFYStartYear: 2024, transactions: [{ date: d(2024, 4, 6), amount: 150_000 }], rates: flat, asOf: d(2025, 4, 1) });
    assert.equal(s.years[0].months[0].interest, 0);
    close(s.years[0].interestAccrued, 9_762.5, 0.5); // 11 months, rounded to the rupee
  });

  test('mid-year: only completed months accrue, nothing credited yet', () => {
    const s = ppfStatement({ openingBalance: 100_000, openingFYStartYear: 2026, transactions: [], rates: flat, asOf: d(2026, 7, 15) });
    close(s.accruedInterest, (100_000 * 0.071) / 12 * 3);
    assert.equal(s.creditedBalance, 100_000);
    assert.equal(s.valuation, s.creditedBalance + s.accruedInterest);
  });

  test('withdrawal after the 5th lowers that month’s qualifying balance', () => {
    const s = ppfStatement({ openingBalance: 100_000, openingFYStartYear: 2026, transactions: [{ date: d(2026, 4, 20), amount: -40_000 }], rates: flat, asOf: d(2026, 5, 1) });
    assert.equal(s.years[0].months[0].qualifyingBalance, 60_000);
  });

  test('interest compounds on 31 March into the next year', () => {
    const s = ppfStatement({
      openingBalance: 0, openingFYStartYear: 2023,
      transactions: [{ date: d(2023, 4, 1), amount: 150_000 }, { date: d(2024, 4, 1), amount: 150_000 }],
      rates: flat, asOf: d(2025, 4, 2),
    });
    assert.equal(s.years.length, 2);
    assert.equal(s.creditedBalance, 310_650 + Math.round(310_650 * 0.071));
    assert.ok(s.years.every((y) => !y.exceedsAnnualLimit));
  });

  test('over ₹1.5 lakh in a year is flagged', () => {
    const s = ppfStatement({
      openingBalance: 0, openingFYStartYear: 2026,
      transactions: [{ date: d(2026, 4, 1), amount: 100_000 }, { date: d(2026, 9, 1), amount: 60_000 }],
      rates: flat, asOf: d(2026, 10, 1),
    });
    assert.equal(s.years.at(-1).exceedsAnnualLimit, true);
  });

  test('each month uses the rate in force for its quarter', () => {
    // FY 2019-20: 8.0% for Apr–Jun, 7.9% from July.
    const s = ppfStatement({ openingBalance: 120_000, openingFYStartYear: 2019, transactions: [], rates: RateSchedule.official, asOf: d(2020, 4, 1) });
    const year = s.years[0];
    assert.ok(year.months.slice(0, 3).every((m) => m.ratePercent === 8.0));
    assert.ok(year.months.slice(3).every((m) => m.ratePercent === 7.9));
    assert.equal(year.interestAccrued, Math.round(120_000 * 0.08 / 12 * 3 + 120_000 * 0.079 / 12 * 9));
  });

  test('transactions before the opening FY are ignored', () => {
    const s = ppfStatement({ openingBalance: 50_000, openingFYStartYear: 2026, transactions: [{ date: d(2026, 3, 1), amount: 10_000 }], rates: flat, asOf: d(2026, 5, 1) });
    assert.equal(s.totalDeposits, 0);
  });

  test('the transactions array passed in is not reordered', () => {
    const txs = [{ date: d(2026, 6, 1), amount: 1 }, { date: d(2026, 4, 1), amount: 2 }];
    ppfStatement({ openingBalance: 0, openingFYStartYear: 2026, transactions: txs, rates: flat, asOf: d(2026, 7, 1) });
    assert.equal(txs[0].amount, 1);
  });
});

describe('PPF rate schedule', () => {
  test('official lookup', () => {
    const s = RateSchedule.official;
    assert.equal(s.rateOn(d(2016, 5, 10)), 8.1);
    assert.equal(s.rateOn(d(2018, 12, 31)), 8.0);
    assert.equal(s.rateOn(d(2019, 7, 1)), 7.9);
    assert.equal(s.rateOn(d(2026, 10, 18)), 7.1);
  });

  test('dates before the first entry fall back to the earliest rate', () => {
    assert.equal(RateSchedule.official.rateOn(d(2010, 1, 1)), 8.1);
  });

  test('a user-added change overrides from its quarter onward', () => {
    const s = new RateSchedule([...OFFICIAL_HISTORY, { effectiveFrom: d(2027, 1, 1), ratePercent: 7.0 }]);
    assert.equal(s.rateOn(d(2026, 12, 31)), 7.1);
    assert.equal(s.rateOn(d(2027, 1, 1)), 7.0);
  });

  test('an empty stored list falls back to the official history', () => {
    assert.equal(RateSchedule.from([]), RateSchedule.official);
  });
});
