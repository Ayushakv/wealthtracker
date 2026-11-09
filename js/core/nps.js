import { createAsset } from './assets.js';
import { date } from './calendar.js';
import { CASError, parseAmount, parseCASDate } from './cas.js';
import { Category } from './categories.js';

/**
 * Reads the NPS Transaction Statement a CRA (Protean, formerly NSDL e-Gov) produces for one tier of a PRAN: the
 * Investment Summary row (value, contributions, withdrawals) and the Scheme Wise Summary (units × NAV per scheme).
 */

const PRAN_RE = /\bPRAN\b\s*:?\s*(\d{12})\b/;
const TIER_RE = /\bTier\s+(II|I)\s+Account\b/i;
const NAV_DATE_RE = /NAV\s+as\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i;
const LONG_DATE = String.raw`([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})`;
const PERIOD_RE = new RegExp(String.raw`${LONG_DATE}\s+to\s+${LONG_DATE}`, 'i');
/** "NPS TRUST A/C HDFC PENSION FUND SCHEME E - TIER I  1,20,000.00  2,400.0000  50.0000" (value, units, NAV) */
const SCHEME_ROW_RE = /^([^\t]*[A-Za-z][^\t]*)\t([\d,]+\.\d+)\t([\d,]+\.\d+)\t([\d,]+\.\d+)\s*$/;
/** A long scheme name wraps onto a line of its own: "SCHEME E - TIER I" (names are in capitals; headings aren't). */
const NAME_PART_RE = /\b(SCHEME|TIER|PENSION|NPS\s+TRUST)\b/i;
/** "₹ 4,87,005.84", "₹ (1,204.10)" or "₹ -1,204.10" */
const RUPEES_RE = /₹\s*(\(?-?[\d,]+\.\d+\)?)/g;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export const NPS_CLASSES = {
  E: { label: 'Equity', field: 'npsEquityPct' },
  C: { label: 'Corporate debt', field: 'npsCorporateDebtPct' },
  G: { label: 'Government bonds', field: 'npsGovtBondPct' },
  A: { label: 'Alternative', field: 'npsAlternativePct' },
};

export function isNPSStatement(lines) {
  return lines.some((l) => /\bNPS\s*TRANSACTION\s*STATEMENT\b/i.test(l)) && lines.some((l) => PRAN_RE.test(l));
}

const signed = (s) => {
  const negative = /^\(.*\)$/.test(s);
  const n = parseAmount(s.replace(/[()]/g, ''));
  return n == null ? null : negative ? -n : n;
};

function longDate(month, day, year) {
  const m = MONTHS.indexOf(month.toLowerCase()) + 1;
  return m ? date(Number(year), m, Number(day)) : null;
}

const ACRONYMS = new Set(['SBI', 'LIC', 'UTI', 'HDFC', 'ICICI', 'DSP', 'NPS', 'II']);
const titleCase = (s) =>
  s
    .split(/\s+/)
    .map((w) => (ACRONYMS.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');

/** "NPS TRUST A/C HDFC PENSION FUND SCHEME E - TIER I" → { pfm: "HDFC Pension Fund", assetClass: "E" } */
export function describeScheme(raw) {
  const name = raw.replace(/\s+/g, ' ').trim();
  const before = name.split(/\s+SCHEME\b/i)[0].replace(/^NPS\s+TRUST\s+A\/?C\s+/i, '').replace(/\s+(PRIVATE\s+)?(LIMITED|LTD\.?)$/i, '');
  const assetClass = /\bSCHEME\s+([ECGA])\b/i.exec(name)?.[1].toUpperCase() ?? null;
  return { name, pfm: before ? titleCase(before) : null, assetClass };
}

/** @returns {{pran, tier, asOf, navDate, value, contributed, withdrawn, schemes: {name, pfm, assetClass, value, units, nav}[], cra}} */
export function parseNPS(rows) {
  const lines = rows.map((r) => (typeof r === 'string' ? r : r.text));
  const all = lines.join('\n');
  const pran = lines.map((l) => PRAN_RE.exec(l)?.[1]).find(Boolean);
  if (!pran) throw new CASError('This NPS statement has no PRAN on it.');
  const tier = TIER_RE.exec(all)?.[1].toUpperCase() === 'II' ? 'Tier 2' : 'Tier 1';
  const period = PERIOD_RE.exec(all);
  const navDate = parseCASDate(NAV_DATE_RE.exec(all)?.[1]);
  const asOf = (period && longDate(period[4], period[5], period[6])) ?? navDate;

  // The amounts row sits under the column letters "(A) (B) (C) D=(A-B)+C E".
  const letters = lines.findIndex((l) => /\(A\)/.test(l) && /\(B\)/.test(l));
  const amounts = lines
    .slice(letters + 1)
    .map((l) => [...l.matchAll(RUPEES_RE)].map((m) => signed(m[1])))
    .find((xs) => xs.length >= 3);
  if (letters < 0 || !amounts) throw new CASError('Couldn’t find the Investment Summary in this NPS statement.');
  const [value, contributed, withdrawn] = amounts;

  const schemes = schemeRows(lines).map((s) => ({ ...describeScheme(s.name), value: s.value, units: s.units, nav: s.nav }));
  const cra = /\bProtean\b/i.test(all) ? 'Protean CRA' : /\bKFin/i.test(all) ? 'KFintech CRA' : /\bCAMS\b/i.test(all) ? 'CAMS CRA' : null;
  return { pran, tier, asOf, navDate, value, contributed, withdrawn, schemes, cra };
}

/** The Scheme Wise Summary's rows, with any wrapped part of a name put back on its row. */
function schemeRows(lines) {
  const start = lines.findIndex((l) => /Scheme\s*Wise\s*Summary/i.test(l));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /Transaction\s+Details|In\s+case\s+of\s+debit|Changes\s+made|Contribution\s*\/\s*Redemption/i.test(l));
  const rows = [];
  let pending = [];
  for (const line of start < 0 ? [] : end < 0 ? rest : rest.slice(0, end)) {
    const m = SCHEME_ROW_RE.exec(line);
    if (m) {
      rows.push({ name: [...pending, m[1]].join(' '), value: parseAmount(m[2]), units: parseAmount(m[3]), nav: parseAmount(m[4]) });
      pending = [];
    } else if (!line.includes('\t') && NAME_PART_RE.test(line) && line === line.toUpperCase()) {
      // Below a row whose name stops short of its scheme, it ends that name; otherwise it starts the next one.
      const last = rows.at(-1);
      if (last && !/\bSCHEME\b/i.test(last.name)) last.name += ` ${line}`;
      else pending.push(line);
    }
  }
  return rows;
}

/**
 * The value each asset class holds now, as percentages that add up to exactly 100 (to one decimal).
 * Null when a scheme has no E/C/G/A class (e.g. a government-sector scheme), so the split isn't misleading.
 */
export function assetSplit(schemes) {
  const total = schemes.reduce((s, x) => s + x.value, 0);
  if (!schemes.length || !(total > 0) || schemes.some((s) => !s.assetClass)) return null;
  const tenths = {};
  for (const s of schemes) tenths[s.assetClass] = (tenths[s.assetClass] ?? 0) + (s.value / total) * 1000;
  const rounded = Object.fromEntries(Object.entries(tenths).map(([k, v]) => [k, Math.round(v)]));
  const largest = Object.keys(rounded).sort((a, b) => rounded[b] - rounded[a])[0];
  rounded[largest] += 1000 - Object.values(rounded).reduce((s, v) => s + v, 0);
  return Object.fromEntries(Object.keys(NPS_CLASSES).map((k) => [NPS_CLASSES[k].field, (rounded[k] ?? 0) / 10]));
}

const tierOf = (a) => a.npsTier ?? 'Tier 1';
const samePRAN = (a, pran) => (a.pran ?? '').replace(/\D/g, '') === pran;

/**
 * Which NPS asset the statement brings up to date: the one with its PRAN and tier, else the only one of that tier
 * with no PRAN yet (added by hand), else a new one.
 */
export function planNPSImport(statement, assets) {
  const nps = assets.filter((a) => a.category === Category.nps && tierOf(a) === statement.tier);
  const same = nps.find((a) => samePRAN(a, statement.pran));
  if (same) return { action: 'update', existing: same };
  const unlinked = nps.filter((a) => !a.pran);
  if (unlinked.length === 1) return { action: 'update', existing: unlinked[0], adopted: true };
  return { action: 'new', existing: null };
}

export function npsName(statement) {
  const pfms = [...new Set(statement.schemes.map((s) => s.pfm).filter(Boolean))];
  return pfms.length === 1 ? `NPS – ${pfms[0]}` : `NPS ${statement.tier}`;
}

/** The asset as the statement leaves it. An existing asset keeps its name, institution and notes. */
export function npsAssetFrom(plan, statement, now = Date.now()) {
  const a = plan.existing
    ? structuredClone(plan.existing)
    : createAsset({ category: Category.nps, name: npsName(statement), ...(statement.cra ? { institution: statement.cra } : {}) }, now);
  a.pran = statement.pran;
  a.npsTier = statement.tier;
  a.currentValuation = statement.value;
  a.investedAmount = statement.contributed - (statement.withdrawn ?? 0);
  if (statement.schemes.length) a.unitsHeld = Math.round(statement.schemes.reduce((s, x) => s + x.units, 0) * 1e4) / 1e4;
  const valuedOn = statement.navDate ?? statement.asOf;
  if (valuedOn != null) a.navDate = valuedOn;
  Object.assign(a, assetSplit(statement.schemes) ?? {});
  a.lastUpdated = now;
  return a;
}
