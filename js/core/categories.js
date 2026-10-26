// Raw values match the iOS app's enums so backups are interchangeable.

export const Category = Object.freeze({
  bank: 'Bank Accounts',
  realEstate: 'Real Estate & Land',
  mutualFund: 'Mutual Funds',
  bonds: 'Bonds & FDs',
  p2p: 'P2P Lending (LenDenClub)',
  ppf: 'Public Provident Fund (PPF)',
  nps: 'National Pension System (NPS)',
  insurance: 'Insurance & LIC',
});

export const Bucket = Object.freeze({
  realEstate: 'realEstate',
  market: 'market',
  sovereignDebt: 'sovereignDebt',
  p2p: 'p2p',
  liquidCash: 'liquidCash',
  insurance: 'insurance',
});

/** Display order for lists and the add menu. */
export const CATEGORIES = [
  { raw: Category.bank, slug: 'bank', short: 'Bank', icon: 'bank', bucket: Bucket.liquidCash },
  { raw: Category.realEstate, slug: 'real-estate', short: 'Land', icon: 'map', bucket: Bucket.realEstate },
  { raw: Category.mutualFund, slug: 'mutual-fund', short: 'Mutual Funds', icon: 'trend', bucket: Bucket.market },
  { raw: Category.bonds, slug: 'bonds', short: 'Bonds & FDs', icon: 'doc', bucket: Bucket.sovereignDebt },
  { raw: Category.p2p, slug: 'p2p', short: 'P2P', icon: 'people', bucket: Bucket.p2p },
  { raw: Category.ppf, slug: 'ppf', short: 'PPF', icon: 'shield', bucket: Bucket.sovereignDebt },
  { raw: Category.nps, slug: 'nps', short: 'NPS', icon: 'pension', bucket: Bucket.market },
  { raw: Category.insurance, slug: 'insurance', short: 'Insurance', icon: 'umbrella', bucket: Bucket.insurance },
];

const byRaw = new Map(CATEGORIES.map((c) => [c.raw, c]));

export function categoryInfo(raw) {
  return byRaw.get(raw) ?? byRaw.get(Category.bank);
}

export const categoryBySlug = (slug) => CATEGORIES.find((c) => c.slug === slug) ?? null;

export function isKnownCategory(raw) {
  return byRaw.has(raw);
}

/** Dashboard slices. `series` is a fixed palette slot so a bucket keeps its color when others are empty. */
export const BUCKETS = [
  { key: Bucket.realEstate, label: 'Real Estate', series: 1 },
  { key: Bucket.market, label: 'Market (MF + NPS)', series: 2 },
  { key: Bucket.sovereignDebt, label: 'Sovereign Debt (PPF + Bonds)', series: 3 },
  { key: Bucket.p2p, label: 'P2P (LenDenClub)', series: 4 },
  { key: Bucket.liquidCash, label: 'Liquid Cash', series: 5 },
  { key: Bucket.insurance, label: 'LIC Surrender Value', series: 6 },
];

export const COMPOUNDING = [
  { raw: 'Monthly', perYear: 12 },
  { raw: 'Quarterly', perYear: 4 },
  { raw: 'Half-Yearly', perYear: 2 },
  { raw: 'Yearly', perYear: 1 },
  { raw: 'Simple (No Compounding)', perYear: null },
];
export const DEFAULT_COMPOUNDING = 'Quarterly';

export function periodsPerYear(raw) {
  const c = COMPOUNDING.find((x) => x.raw === raw) ?? COMPOUNDING.find((x) => x.raw === DEFAULT_COMPOUNDING);
  return c.perYear;
}

export const POLICY_TYPES = ['Term Life', 'Health', 'Vehicle', 'LIC Endowment'];
export const LIC_ENDOWMENT = 'LIC Endowment';

/** Only savings-linked policies carry a surrender value that counts towards net worth. */
export function hasSurrenderValue(policyType) {
  return policyType === LIC_ENDOWMENT;
}

export const NPS_TIERS = ['Tier 1', 'Tier 2'];
