import { addYears, financialYearStart } from './calendar.js';
import { Category, DEFAULT_COMPOUNDING, LIC_ENDOWMENT } from './categories.js';
import { createAsset, recompute } from './assets.js';

/**
 * Editable copy of an asset, so a form can be cancelled without touching the store.
 * Mirrors the iOS app's AssetDraft. Optional numbers are `null` when blank.
 */
export function newDraft(category, now = Date.now()) {
  return {
    category,
    name: '',
    institution: '',
    notes: '',
    investedAmount: null,
    currentValuation: null,
    bankLast4: '',
    lastReconciled: now,
    locationDetails: '',
    hasStartDate: category === Category.bonds,
    startDate: now,
    amfiCode: '',
    unitsHeld: null,
    averageNAV: null,
    latestNAV: null,
    navDate: null,
    pran: '',
    npsTier: 'Tier 1',
    npsEquityPct: null,
    npsCorporateDebtPct: null,
    npsGovtBondPct: null,
    npsAlternativePct: null,
    interestRate: null,
    hasMaturityDate: false,
    maturityDate: now,
    compounding: DEFAULT_COMPOUNDING,
    isPayout: false,
    ppfOpeningBalance: null,
    ppfOpeningFYStartYear: financialYearStart(now),
    p2pRepaymentsReceived: null,
    p2pWriteOffs: null,
    policyType: 'Health',
    policyNumber: '',
    policySumAssured: null,
    annualPremium: null,
    hasRenewalDate: true,
    policyRenewalDate: addYears(now, 1),
  };
}

export function draftFromAsset(a, now = Date.now()) {
  const d = newDraft(a.category, now);
  const str = (v) => v ?? '';
  const num = (v) => v ?? null;
  Object.assign(d, {
    name: a.name,
    institution: str(a.institution),
    notes: str(a.notes),
    investedAmount: a.investedAmount,
    currentValuation: a.currentValuation,
    bankLast4: str(a.bankLast4),
    lastReconciled: a.lastReconciled ?? now,
    locationDetails: str(a.locationDetails),
    hasStartDate: a.startDate != null,
    startDate: a.startDate ?? now,
    amfiCode: str(a.amfiCode),
    unitsHeld: num(a.unitsHeld),
    averageNAV: num(a.averageNAV),
    latestNAV: num(a.latestNAV),
    navDate: num(a.navDate),
    pran: str(a.pran),
    npsTier: a.npsTier ?? 'Tier 1',
    npsEquityPct: num(a.npsEquityPct),
    npsCorporateDebtPct: num(a.npsCorporateDebtPct),
    npsGovtBondPct: num(a.npsGovtBondPct),
    npsAlternativePct: num(a.npsAlternativePct),
    interestRate: num(a.interestRate),
    hasMaturityDate: a.maturityDate != null,
    maturityDate: a.maturityDate ?? now,
    compounding: a.compounding ?? DEFAULT_COMPOUNDING,
    isPayout: a.isPayout ?? false,
    ppfOpeningBalance: num(a.ppfOpeningBalance),
    ppfOpeningFYStartYear: a.ppfOpeningFYStartYear ?? financialYearStart(now),
    p2pRepaymentsReceived: num(a.p2pRepaymentsReceived),
    p2pWriteOffs: num(a.p2pWriteOffs),
    policyType: a.policyType ?? 'Health',
    policyNumber: str(a.policyNumber),
    policySumAssured: num(a.policySumAssured),
    annualPremium: num(a.annualPremium),
    hasRenewalDate: a.policyRenewalDate != null,
    policyRenewalDate: a.policyRenewalDate ?? d.policyRenewalDate,
  });
  return d;
}

export function npsAllocationTotal(d) {
  return [d.npsEquityPct, d.npsCorporateDebtPct, d.npsGovtBondPct, d.npsAlternativePct].reduce((s, v) => s + (v ?? 0), 0);
}

/** Returns a user-facing problem, or null when the draft can be saved. */
export function validateDraft(d) {
  if (!d.name.trim()) return 'Enter a name.';
  switch (d.category) {
    case Category.bank:
      if (d.bankLast4 && !/^\d{4}$/.test(d.bankLast4)) return 'Last 4 digits must be 4 numbers.';
      break;
    case Category.mutualFund:
      // Funds imported from a CAS whose ISIN had no AMFI code keep the statement's NAV instead.
      if (d.amfiCode ? !/^\d+$/.test(d.amfiCode) : d.latestNAV == null) return 'Enter a numeric AMFI scheme code.';
      if (!((d.unitsHeld ?? 0) > 0)) return 'Enter units held.';
      break;
    case Category.bonds:
      if (!((d.investedAmount ?? 0) > 0)) return 'Enter the principal.';
      if (d.interestRate == null) return 'Enter the interest rate.';
      if (d.hasMaturityDate && d.maturityDate < d.startDate) return 'Maturity must be after the start date.';
      break;
    case Category.nps: {
      const total = npsAllocationTotal(d);
      if (total > 0 && Math.abs(total - 100) > 0.5) return 'E/C/G/A split must add up to 100%.';
      break;
    }
  }
  return null;
}

const nonEmpty = (s) => {
  const t = (s ?? '').trim();
  return t || undefined;
};
const opt = (v) => (v == null ? undefined : v);

/**
 * Writes the draft into `asset` (or a new asset when null) and recomputes its valuation.
 * Fields that don't belong to the category are left as they were, like the iOS app.
 * @returns the saved asset
 */
export function applyDraft(d, asset, rates, now = Date.now()) {
  const a = asset ?? createAsset({ category: d.category, name: d.name }, now);
  a.name = d.name.trim();
  a.category = d.category;
  a.institution = nonEmpty(d.institution);
  a.notes = nonEmpty(d.notes);
  a.investedAmount = d.investedAmount ?? 0;
  a.currentValuation = d.currentValuation ?? d.investedAmount ?? 0;
  a.startDate = d.hasStartDate ? d.startDate : undefined;

  switch (d.category) {
    case Category.bank:
      a.bankLast4 = nonEmpty(d.bankLast4);
      a.lastReconciled = d.lastReconciled;
      a.investedAmount = a.currentValuation;
      break;
    case Category.realEstate:
      a.locationDetails = nonEmpty(d.locationDetails);
      break;
    case Category.mutualFund:
      a.amfiCode = nonEmpty(d.amfiCode);
      a.unitsHeld = opt(d.unitsHeld);
      a.averageNAV = opt(d.averageNAV);
      a.latestNAV = opt(d.latestNAV);
      a.navDate = opt(d.navDate);
      break;
    case Category.nps:
      a.pran = nonEmpty(d.pran);
      a.npsTier = d.npsTier;
      a.unitsHeld = opt(d.unitsHeld);
      a.npsEquityPct = opt(d.npsEquityPct);
      a.npsCorporateDebtPct = opt(d.npsCorporateDebtPct);
      a.npsGovtBondPct = opt(d.npsGovtBondPct);
      a.npsAlternativePct = opt(d.npsAlternativePct);
      break;
    case Category.ppf:
      a.ppfOpeningBalance = d.ppfOpeningBalance ?? 0;
      a.ppfOpeningFYStartYear = d.ppfOpeningFYStartYear;
      a.maturityDate = d.hasMaturityDate ? d.maturityDate : undefined;
      break;
    case Category.bonds:
      a.interestRate = opt(d.interestRate);
      a.compounding = d.compounding;
      a.isPayout = d.isPayout;
      a.maturityDate = d.hasMaturityDate ? d.maturityDate : undefined;
      a.startDate ??= now;
      break;
    case Category.p2p:
      a.p2pRepaymentsReceived = opt(d.p2pRepaymentsReceived);
      a.p2pWriteOffs = opt(d.p2pWriteOffs);
      break;
    case Category.insurance:
      a.policyType = d.policyType;
      a.policyNumber = nonEmpty(d.policyNumber);
      a.policySumAssured = opt(d.policySumAssured);
      a.annualPremium = opt(d.annualPremium);
      a.policyRenewalDate = d.hasRenewalDate ? d.policyRenewalDate : undefined;
      a.maturityDate = d.policyType === LIC_ENDOWMENT && d.hasMaturityDate ? d.maturityDate : undefined;
      break;
  }
  a.entries ??= [];
  a.lastUpdated = now;
  return recompute(a, rates, now);
}
