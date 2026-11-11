// Raw values are what the vault and backups store; renaming one needs an upgrade path (see upgradeCategory).

export const Category = Object.freeze({
  bank: 'Bank Accounts',
  realEstate: 'Real Estate & Land',
  mutualFund: 'Mutual Funds',
  bonds: 'Bonds',
  fd: 'Fixed Deposits',
  p2p: 'P2P Lending (LenDenClub)',
  ppf: 'Public Provident Fund (PPF)',
  nps: 'National Pension System (NPS)',
  insurance: 'Insurance & LIC',
  gold: 'Gold',
});

export const Bucket = Object.freeze({
  realEstate: 'realEstate',
  market: 'market',
  sovereignDebt: 'sovereignDebt',
  p2p: 'p2p',
  liquidCash: 'liquidCash',
  insurance: 'insurance',
  gold: 'gold',
});

/** Display order for lists and the add menu. */
export const CATEGORIES = [
  { raw: Category.bank, slug: 'bank', short: 'Bank', icon: 'bank', bucket: Bucket.liquidCash },
  { raw: Category.realEstate, slug: 'real-estate', short: 'Land', icon: 'map', bucket: Bucket.realEstate },
  { raw: Category.mutualFund, slug: 'mutual-fund', short: 'Mutual Funds', icon: 'trend', bucket: Bucket.market },
  { raw: Category.fd, slug: 'fd', short: 'FDs', icon: 'safe', bucket: Bucket.sovereignDebt },
  { raw: Category.bonds, slug: 'bonds', short: 'Bonds', icon: 'doc', bucket: Bucket.sovereignDebt },
  { raw: Category.p2p, slug: 'p2p', short: 'P2P', icon: 'people', bucket: Bucket.p2p },
  { raw: Category.ppf, slug: 'ppf', short: 'PPF', icon: 'shield', bucket: Bucket.sovereignDebt },
  { raw: Category.nps, slug: 'nps', short: 'NPS', icon: 'pension', bucket: Bucket.market },
  { raw: Category.gold, slug: 'gold', short: 'Gold', icon: 'gold', bucket: Bucket.gold },
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

/** Bonds and fixed deposits share the interest-based valuation, form and details. */
export const isFixedIncome = (raw) => raw === Category.bonds || raw === Category.fd;

/** The single category bonds and FDs shared before they were split. */
export const LEGACY_BONDS_AND_FDS = 'Bonds & FDs';
const BOND_NAME_RE = /\b(bonds?|ncds?|debentures?|sgbs?|g-?secs?|gilts?|t-?bills?|sdls?|securiti[sz]ed)\b/i;

/**
 * Moves an asset saved under the old combined category to Bonds or Fixed Deposits, in place: anything held in a demat
 * account (an ISIN) or named like a bond is a bond, the rest were deposits added by hand.
 * @returns whether the asset changed
 */
export function upgradeCategory(a) {
  if (a.category !== LEGACY_BONDS_AND_FDS) return false;
  a.category = a.isin || a.instrument || BOND_NAME_RE.test(a.name ?? '') ? Category.bonds : Category.fd;
  return true;
}

/**
 * Dashboard slices. `series` is a fixed palette slot so a bucket keeps its color when others are empty. Gold (slot 7,
 * violet) sits between Market and Sovereign Debt so it never touches Real Estate's blue around the ring.
 */
export const BUCKETS = [
  { key: Bucket.realEstate, label: 'Real Estate', series: 1 },
  { key: Bucket.market, label: 'Market (MF + NPS)', series: 2 },
  { key: Bucket.gold, label: 'Gold', series: 7 },
  { key: Bucket.sovereignDebt, label: 'Sovereign Debt (PPF, Bonds, FDs)', series: 3 },
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
