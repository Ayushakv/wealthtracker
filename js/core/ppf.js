import { addMonths, addDays, date, fyLabel, parts } from './calendar.js';

export const DEFAULT_RATE = 7.1;
export const ANNUAL_DEPOSIT_LIMIT = 150_000;

/** Swift's `.rounded()`: half away from zero. */
export const roundHalfAway = (x) => Math.sign(x) * Math.round(Math.abs(x));

/**
 * Rates notified by the Ministry of Finance since quarterly resets began (April 2016).
 * Later changes are added by the user from Settings when a new quarter's rate is announced.
 */
export const OFFICIAL_HISTORY = Object.freeze([
  { effectiveFrom: date(2016, 4, 1), ratePercent: 8.1 },
  { effectiveFrom: date(2016, 10, 1), ratePercent: 8.0 },
  { effectiveFrom: date(2017, 4, 1), ratePercent: 7.9 },
  { effectiveFrom: date(2017, 7, 1), ratePercent: 7.8 },
  { effectiveFrom: date(2018, 1, 1), ratePercent: 7.6 },
  { effectiveFrom: date(2018, 10, 1), ratePercent: 8.0 },
  { effectiveFrom: date(2019, 7, 1), ratePercent: 7.9 },
  { effectiveFrom: date(2020, 4, 1), ratePercent: 7.1 },
].map(Object.freeze));

/** Step function of PPF rates over time. The rate in force on a date is the latest change on or before it. */
export class RateSchedule {
  constructor(changes) {
    this.changes = [...changes].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
  }

  static flat(ratePercent) {
    return new RateSchedule([{ effectiveFrom: -Infinity, ratePercent }]);
  }

  /** The stored list, or the official history when it is empty. */
  static from(changes) {
    return changes?.length ? new RateSchedule(changes) : RateSchedule.official;
  }

  rateOn(t) {
    for (let i = this.changes.length - 1; i >= 0; i--) {
      if (this.changes[i].effectiveFrom <= t) return this.changes[i].ratePercent;
    }
    return this.changes[0]?.ratePercent ?? DEFAULT_RATE;
  }

  currentRate(now = Date.now()) {
    return this.rateOn(now);
  }
}

RateSchedule.official = new RateSchedule(OFFICIAL_HISTORY);

function newYear(fyStartYear, balance) {
  return {
    fyStartYear,
    label: fyLabel(fyStartYear),
    openingBalance: balance,
    netDeposits: 0,
    interestAccrued: 0,
    isCredited: false,
    closingBalance: balance,
    months: [],
    get exceedsAnnualLimit() {
      return this.netDeposits > ANNUAL_DEPOSIT_LIMIT;
    },
  };
}

/**
 * Implements the PPF interest rule (PPF Scheme, 2019):
 * - Interest for a month is computed on the lowest balance between the close of the 5th day and the end of the month.
 * - Monthly interest = qualifying balance × annual rate in force that month / 12.
 * - Interest for the year is credited (compounded) on 31 March, rounded to the rupee.
 *
 * @param {object} p
 * @param {number} p.openingBalance balance on 1 April of `openingFYStartYear` (includes all earlier interest)
 * @param {number} p.openingFYStartYear FY the opening balance applies to (2026 → FY 2026-27)
 * @param {{date:number, amount:number}[]} p.transactions deposits (+) / withdrawals (−); ones before the opening FY are ignored
 * @param {RateSchedule} [p.rates]
 * @param {number} [p.asOf] valuation date; only fully completed months accrue interest
 */
export function ppfStatement({ openingBalance, openingFYStartYear, transactions, rates = RateSchedule.official, asOf = Date.now() }) {
  const fyStart = date(openingFYStartYear, 4, 1);
  const sorted = transactions
    .filter((tx) => tx.date >= fyStart && tx.date <= asOf)
    .sort((a, b) => a.date - b.date);

  let balance = openingBalance;
  const years = [];
  let totalDeposits = 0;
  let txIndex = 0;
  let monthStart = fyStart;
  let current = newYear(openingFYStartYear, balance);

  while (monthStart <= asOf) {
    const nextMonth = addMonths(monthStart, 1);
    const cutoff = addDays(monthStart, 5); // 00:00 on the 6th

    const monthTx = [];
    while (txIndex < sorted.length && sorted[txIndex].date < nextMonth) {
      monthTx.push(sorted[txIndex]);
      txIndex++;
    }

    // Balance at the close of the 5th, then track the minimum through month end.
    for (const tx of monthTx) if (tx.date < cutoff) balance += tx.amount;
    let lowest = balance;
    for (const tx of monthTx) {
      if (tx.date >= cutoff) {
        balance += tx.amount;
        lowest = Math.min(lowest, balance);
      }
    }

    const net = monthTx.reduce((sum, tx) => sum + tx.amount, 0);
    current.netDeposits += net;
    totalDeposits += net;

    const monthComplete = nextMonth <= asOf;
    if (monthComplete) {
      const ratePercent = rates.rateOn(monthStart);
      const interest = (Math.max(lowest, 0) * ratePercent) / 100 / 12;
      current.interestAccrued += interest;
      current.months.push({ month: monthStart, qualifyingBalance: lowest, ratePercent, interest });
    }

    if (parts(monthStart).month === 3 && monthComplete) {
      // 31 March: credit the year's interest, rounded to the nearest rupee.
      current.interestAccrued = roundHalfAway(current.interestAccrued);
      balance += current.interestAccrued;
      current.isCredited = true;
      current.closingBalance = balance;
      years.push(current);
      current = newYear(current.fyStartYear + 1, balance);
    }
    monthStart = nextMonth;
  }

  current.closingBalance = balance;
  if (current.months.length || current.netDeposits !== 0 || years.length === 0) years.push(current);

  const accruedInterest = current.isCredited ? 0 : current.interestAccrued;
  return {
    years,
    /** Opening balance + deposits + interest credited on past 31 March closings. */
    creditedBalance: balance,
    /** Interest earned so far in the running FY, credited on 31 March. */
    accruedInterest,
    totalDeposits,
    /** Value shown in net worth: credited balance plus interest earned but not yet credited. */
    valuation: balance + accruedInterest,
  };
}
