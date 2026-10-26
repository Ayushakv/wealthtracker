import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { date as d } from '../js/core/calendar.js';
import { fixedIncomeValuation } from '../js/core/fixedIncome.js';

const close = (actual, expected, tol = 0.01) => assert.ok(Math.abs(actual - expected) <= tol, `${actual} ≉ ${expected}`);

describe('FD & bond valuation', () => {
  test('cumulative FD compounds quarterly', () => {
    const v = fixedIncomeValuation({ principal: 100_000, annualRatePercent: 7, compounding: 'Quarterly', isPayout: false, start: d(2025, 1, 1), maturity: d(2027, 1, 1), asOf: d(2026, 1, 1) });
    close(v.currentValue, 100_000 * 1.0175 ** 4);
    close(v.maturityValue, 100_000 * 1.0175 ** 8);
  });

  test('payout FD only holds the running period’s interest', () => {
    const v = fixedIncomeValuation({ principal: 100_000, annualRatePercent: 7.3, compounding: 'Quarterly', isPayout: true, start: d(2025, 1, 1), asOf: d(2025, 5, 1) });
    close(v.accruedInterest, (100_000 * 0.073 * 30) / 365); // 1 Apr → 1 May
  });

  test('simple interest', () => {
    const v = fixedIncomeValuation({ principal: 50_000, annualRatePercent: 8, compounding: 'Simple (No Compounding)', isPayout: false, start: d(2025, 1, 1), asOf: d(2026, 1, 1) });
    close(v.currentValue, 54_000);
  });

  test('value stops growing after maturity', () => {
    const v = fixedIncomeValuation({ principal: 100_000, annualRatePercent: 7, compounding: 'Yearly', isPayout: false, start: d(2020, 1, 1), maturity: d(2021, 1, 1), asOf: d(2026, 1, 1) });
    close(v.currentValue, 107_000);
  });

  test('broken period earns simple interest on the compounded amount', () => {
    const v = fixedIncomeValuation({ principal: 100_000, annualRatePercent: 8, compounding: 'Yearly', isPayout: false, start: d(2025, 1, 1), asOf: d(2026, 7, 2) });
    close(v.currentValue, 108_000 * (1 + (0.08 * 182) / 365)); // 1 Jan 2026 → 2 Jul 2026
  });

  test('no maturity date means no maturity value', () => {
    const v = fixedIncomeValuation({ principal: 1000, annualRatePercent: 7, compounding: 'Monthly', isPayout: false, start: d(2025, 1, 1), asOf: d(2025, 2, 1) });
    assert.equal(v.maturityValue, undefined);
  });
});
