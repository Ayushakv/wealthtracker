import { addMonths, daysBetween } from './calendar.js';
import { periodsPerYear } from './categories.js';

/**
 * Valuation for FDs and bonds, following the convention Indian banks use:
 * compound for whole periods, then simple interest on the broken period (days / 365).
 *
 * @returns {{currentValue:number, accruedInterest:number, maturityValue:number|undefined}}
 */
export function fixedIncomeValuation({ principal, annualRatePercent, compounding, isPayout, start, maturity, asOf = Date.now() }) {
  const end = maturity != null ? Math.min(maturity, asOf) : asOf;
  const current = value(principal, annualRatePercent, compounding, isPayout, start, end);
  return {
    currentValue: current.currentValue,
    accruedInterest: current.accrued,
    maturityValue: maturity != null ? value(principal, annualRatePercent, compounding, isPayout, start, maturity).currentValue : undefined,
  };
}

function value(principal, ratePercent, compounding, isPayout, start, end) {
  if (!(end > start) || !(principal > 0)) return { currentValue: principal, accrued: 0 };
  const r = ratePercent / 100;
  const n = periodsPerYear(compounding);

  if (n == null) {
    const interest = principal * r * yearFraction(start, end);
    return { currentValue: principal + interest, accrued: interest };
  }

  // Walk whole periods (12/n months each) from the start date.
  const monthsPerPeriod = 12 / n;
  let periods = 0;
  let periodStart = start;
  for (;;) {
    const next = addMonths(start, monthsPerPeriod * (periods + 1));
    if (next > end) break;
    periods++;
    periodStart = next;
  }
  const broken = yearFraction(periodStart, end);

  if (isPayout) {
    // Interest is paid out every period; only the running period's interest is still held.
    const accrued = principal * r * broken;
    return { currentValue: principal + accrued, accrued };
  }

  const compounded = principal * Math.pow(1 + r / n, periods);
  const accrued = compounded * r * broken;
  return { currentValue: compounded + accrued, accrued: compounded - principal + accrued };
}

function yearFraction(from, to) {
  return Math.max(daysBetween(from, to), 0) / 365;
}
