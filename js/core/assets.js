import { addDays, financialYearStart, startOfDay } from './calendar.js';
import { BUCKETS, Category, categoryInfo, DEFAULT_COMPOUNDING, hasSurrenderValue } from './categories.js';
import { fixedIncomeValuation } from './fixedIncome.js';
import { ppfStatement, RateSchedule } from './ppf.js';

/**
 * Assets are plain objects whose keys match the iOS app's backup records (AssetRecord),
 * so the same JSON moves between the two apps. Dates are epoch milliseconds.
 * `entries` holds PPF deposits (+) and withdrawals (−): { id, date, amount, note? }.
 */
export const FIELD_TYPES = Object.freeze({
  id: 'string',
  name: 'string',
  category: 'string',
  investedAmount: 'number',
  currentValuation: 'number',
  lastUpdated: 'date',
  notes: 'string',
  institution: 'string',
  bankLast4: 'string',
  lastReconciled: 'date',
  locationDetails: 'string',
  startDate: 'date',
  amfiCode: 'string',
  unitsHeld: 'number',
  averageNAV: 'number',
  latestNAV: 'number',
  navDate: 'date',
  folio: 'string',
  isin: 'string',
  pran: 'string',
  npsTier: 'string',
  npsEquityPct: 'number',
  npsCorporateDebtPct: 'number',
  npsGovtBondPct: 'number',
  npsAlternativePct: 'number',
  interestRate: 'number',
  maturityDate: 'date',
  compounding: 'string',
  isPayout: 'boolean',
  ppfOpeningBalance: 'number',
  ppfOpeningFYStartYear: 'int',
  p2pRepaymentsReceived: 'number',
  p2pWriteOffs: 'number',
  policyType: 'string',
  policyNumber: 'string',
  policySumAssured: 'number',
  annualPremium: 'number',
  policyRenewalDate: 'date',
});

export const REQUIRED_FIELDS = ['id', 'name', 'category', 'investedAmount', 'currentValuation', 'lastUpdated'];

/** Uppercase, like Swift's UUID().uuidString, so IDs match across the two apps. */
export const newID = () => globalThis.crypto.randomUUID().toUpperCase();

export function createAsset(fields, now = Date.now()) {
  return { id: newID(), investedAmount: 0, currentValuation: 0, lastUpdated: now, entries: [], ...fields };
}

export const createEntry = (date, amount, note) => ({ id: newID(), date, amount, ...(note ? { note } : {}) });

export const gain = (a) => a.currentValuation - a.investedAmount;
export const gainFraction = (a) => (a.investedAmount > 0 ? gain(a) / a.investedAmount : null);

/** Pure-risk covers (term, health, vehicle) don't count towards net worth. */
export function countsTowardsNetWorth(a) {
  return a.category !== Category.insurance || hasSurrenderValue(a.policyType);
}

export function ppfStatementFor(a, rates = RateSchedule.official, asOf = Date.now()) {
  if (a.category !== Category.ppf) return null;
  return ppfStatement({
    openingBalance: a.ppfOpeningBalance ?? 0,
    openingFYStartYear: a.ppfOpeningFYStartYear ?? financialYearStart(asOf),
    transactions: (a.entries ?? []).map((e) => ({ date: e.date, amount: e.amount })),
    rates,
    asOf,
  });
}

export function fixedIncomeFor(a, asOf = Date.now()) {
  if (a.category !== Category.bonds || a.startDate == null) return null;
  return fixedIncomeValuation({
    principal: a.investedAmount,
    annualRatePercent: a.interestRate ?? 0,
    compounding: a.compounding ?? DEFAULT_COMPOUNDING,
    isPayout: a.isPayout ?? false,
    start: a.startDate,
    maturity: a.maturityDate,
    asOf,
  });
}

/** Recomputes derived valuations for rule-based categories in place. Manually valued categories are left untouched. */
export function recompute(a, rates = RateSchedule.official, now = Date.now()) {
  switch (a.category) {
    case Category.ppf: {
      const s = ppfStatementFor(a, rates, now);
      a.investedAmount = (a.ppfOpeningBalance ?? 0) + s.totalDeposits;
      a.currentValuation = s.valuation;
      break;
    }
    case Category.bonds: {
      const v = fixedIncomeFor(a, now);
      if (!v) return a;
      a.currentValuation = v.currentValue;
      break;
    }
    case Category.mutualFund:
      if (a.unitsHeld != null && a.averageNAV != null) a.investedAmount = a.unitsHeld * a.averageNAV;
      if (a.unitsHeld != null && a.latestNAV != null) a.currentValuation = a.unitsHeld * a.latestNAV;
      break;
    case Category.insurance:
      if (hasSurrenderValue(a.policyType)) return a;
      a.currentValuation = 0;
      a.investedAmount = 0;
      break;
    default:
      return a;
  }
  a.lastUpdated = now;
  return a;
}

export function totals(assets) {
  let value = 0;
  let invested = 0;
  for (const a of assets) {
    if (!countsTowardsNetWorth(a)) continue;
    value += a.currentValuation;
    invested += a.investedAmount;
  }
  return { value, invested, gain: value - invested };
}

/** Dashboard donut slices, in fixed bucket order; empty buckets are dropped. */
export function allocation(assets) {
  const sums = new Map();
  for (const a of assets) {
    if (!countsTowardsNetWorth(a)) continue;
    const bucket = categoryInfo(a.category).bucket;
    sums.set(bucket, (sums.get(bucket) ?? 0) + a.currentValuation);
  }
  const total = [...sums.values()].reduce((s, v) => s + v, 0);
  if (!(total > 0)) return [];
  return BUCKETS.filter((b) => (sums.get(b.key) ?? 0) > 0).map((b) => ({ ...b, value: sums.get(b.key), fraction: sums.get(b.key) / total }));
}

/** Insurance policies due between today and `days` from now, soonest first. */
export function upcomingRenewals(assets, now = Date.now(), days = 60) {
  const from = startOfDay(now);
  const to = addDays(now, days);
  return assets
    .filter((a) => a.category === Category.insurance && a.policyRenewalDate != null && a.policyRenewalDate >= from && a.policyRenewalDate <= to)
    .sort((a, b) => a.policyRenewalDate - b.policyRenewalDate);
}

/** Every asset with a NAV source, for the refresher. */
export const amfiCodes = (assets) => [...new Set(assets.filter((a) => a.category === Category.mutualFund && a.amfiCode).map((a) => a.amfiCode))];

export const byName = (a, b) => a.name.localeCompare(b.name, 'en-IN', { sensitivity: 'base' });
