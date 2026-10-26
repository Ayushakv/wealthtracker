import { addDays, addMonths, addYears, date, financialYearStart } from './calendar.js';
import { Category } from './categories.js';
import { createAsset, createEntry, recompute } from './assets.js';

/** Realistic sample portfolio for exploring the dashboard. Every category is represented. */
export function samplePortfolio(rates, now = Date.now()) {
  const daysFromNow = (d) => addDays(now, d);
  const monthsAgo = (m) => addMonths(now, -m);
  const make = (fields) => createAsset(fields, now);

  const sbi = make({
    name: 'SBI Savings', category: Category.bank, investedAmount: 345_000, currentValuation: 345_000,
    institution: 'State Bank of India', bankLast4: '4821', lastReconciled: daysFromNow(-6),
  });

  const land = make({
    name: 'Agricultural Plot – Nashik', category: Category.realEstate, investedAmount: 1_850_000, currentValuation: 2_700_000,
    notes: '7/12 extract updated 2024. Mutation entry no. 3317.',
    locationDetails: 'Survey No. 112/2, Village Ozar, Tal. Niphad, Dist. Nashik',
    startDate: addYears(now, -6),
  });

  // AMFI 118955 = HDFC Flexi Cap Fund – Direct Plan – Growth
  const hdfcFlexi = make({
    name: 'HDFC Flexi Cap Fund – Direct Growth', category: Category.mutualFund,
    institution: 'HDFC Mutual Fund', amfiCode: '118955', unitsHeld: 412.537, averageNAV: 1605.4,
    latestNAV: 1980, navDate: monthsAgo(1), // placeholder until the first live refresh
  });

  // PPF: opening balance at the start of the current FY + ₹12,500 on the 3rd of each month since.
  const fy = financialYearStart(now);
  const ppf = make({
    name: 'PPF – SBI', category: Category.ppf, institution: 'State Bank of India',
    ppfOpeningFYStartYear: fy, ppfOpeningBalance: 682_340,
  });
  for (let month = date(fy, 4, 3); month <= now; month = addMonths(month, 1)) {
    ppf.entries.push(createEntry(month, 12_500, 'Monthly SI'));
  }

  const nps = make({
    name: 'NPS Tier 1', category: Category.nps, investedAmount: 420_000, currentValuation: 536_800,
    institution: 'Protean CRA', pran: '110012345678', npsTier: 'Tier 1', unitsHeld: 11_842.66,
    npsEquityPct: 50, npsCorporateDebtPct: 25, npsGovtBondPct: 23, npsAlternativePct: 2,
  });

  const fd = make({
    name: 'HDFC Bank FD', category: Category.bonds, investedAmount: 200_000, currentValuation: 200_000,
    institution: 'HDFC Bank', interestRate: 7.25, compounding: 'Quarterly', isPayout: false,
    startDate: monthsAgo(10), maturityDate: addMonths(now, 14),
  });

  const lendenclub = make({
    name: 'LenDenClub FMPP', category: Category.p2p, investedAmount: 150_000, currentValuation: 108_420,
    institution: 'LenDenClub', p2pRepaymentsReceived: 58_960, p2pWriteOffs: 3_150,
  });

  const health = make({
    name: 'HDFC Ergo Optima Secure', category: Category.insurance, institution: 'HDFC ERGO',
    policyType: 'Health', policyNumber: '2856 2034 5521 9001', policySumAssured: 1_000_000,
    annualPremium: 24_380, policyRenewalDate: daysFromNow(28),
  });

  const lic = make({
    name: 'LIC Jeevan Anand', category: Category.insurance, investedAmount: 216_000, currentValuation: 142_500,
    institution: 'LIC of India', policyType: 'LIC Endowment', policyNumber: '912345678',
    policySumAssured: 500_000, annualPremium: 27_000, policyRenewalDate: daysFromNow(74),
    maturityDate: addYears(now, 13),
  });

  return [sbi, land, hdfcFlexi, ppf, nps, fd, lendenclub, health, lic].map((a) => recompute(a, rates, now));
}
