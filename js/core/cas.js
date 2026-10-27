import { createAsset, recompute } from './assets.js';
import { date } from './calendar.js';
import { Category } from './categories.js';
import { RateSchedule } from './ppf.js';

/**
 * Reads a CAMS / KFintech Consolidated Account Statement (CAS) from the text lines of the PDF.
 * The detailed statement lists, per folio and scheme, a header line with the ISIN, the transactions,
 * then a closing line with units, NAV, cost and market value. The summary statement is one table row
 * per holding. Field patterns follow the layouts parsed by the open-source casparser project.
 */
export class CASError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CASError';
  }
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE = String.raw`(\d{1,2}-[A-Za-z]{3}-\d{4})`;
const NUM = String.raw`(-?[\d,]*\.?\d+)`;
const INR = String.raw`(?:INR|Rs\.?|₹)?\s*`;

const ISIN_RE = /\bISIN\s*:\s*([A-Z]{2}[0-9A-Z]{9}[0-9])/;
const FOLIO_RE = /Folio\s*No\s*[:.]?\s*(\d[\d/ ]*\d|\d)/i;
const AMC_RE = /^\s*([A-Za-z0-9&.'()\- ]{2,60}?\s(?:Mutual\s+Fund|MF))\s*$/i;
const PERIOD_RE = new RegExp(String.raw`${DATE}\s+to\s+${DATE}`, 'i');
const AS_ON_RE = new RegExp(String.raw`as\s+on\s+${DATE}`, 'i');
const OPENING_RE = /Opening\s+Unit\s+Balance/i;
const CLOSING_RE = new RegExp(String.raw`Closing\s+Unit\s+Balance\s*:?\s*${NUM}`, 'i');
const NAV_RE = new RegExp(String.raw`NAV\s+on\s+${DATE}\s*:?\s*${INR}${NUM}`, 'i');
const COST_RE = new RegExp(String.raw`Total\s+Cost\s+Value\s*:?\s*${INR}${NUM}`, 'i');
const VALUE_RE = new RegExp(String.raw`(?:Market\s+Value|Valuation)\s+on\s+${DATE}\s*:?\s*${INR}${NUM}`, 'i');
const SCHEME_CODE_RE = /^[A-Z0-9]{2,12}\s*-\s*(?=\S)/;
const SUMMARY_ROW_RE = new RegExp(
  String.raw`^\s*(\d[\d/ ]*?)\s+([A-Z]{2}[0-9A-Z]{9}[0-9])\s+(.+?)\s+(?:${NUM}\s+)?${NUM}\s+${DATE}\s+${NUM}\s+${NUM}\s+(CAMS|KFINTECH|KARVY|FTAMIL|[A-Z]+)\s*$`,
  'i',
);

export const parseAmount = (s) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** "26-Oct-2026" → midnight IST. */
export function parseCASDate(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s?.trim() ?? '');
  const month = m && MONTHS[m[2].toLowerCase()];
  return month ? date(Number(m[3]), month, Number(m[1])) : null;
}

const normaliseFolio = (s) => s.replace(/\s+/g, '');

/** Cleans "B205-HDFC Flexi Cap Fund - Direct Plan - Growth (Non-Demat) - ISIN: …(Advisor: …) Registrar : CAMS". */
export function schemeName(raw) {
  return raw
    .replace(SCHEME_CODE_RE, '')
    .split(/\s*-?\s*ISIN\s*:/i)[0]
    .split(/\(\s*Advisor\s*:/i)[0]
    .split(/\bRegistrar\s*:/i)[0]
    .replace(/\((?:Non[- ]?Demat|Demat)\)/gi, '')
    .replace(/\(\s*(?:formerly|erstwhile)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s-]+$/, '')
    .trim();
}

/** The scheme starts on the last "CODE-Name" line at or before the ISIN; fall back to the ISIN line itself. */
function schemeFromHeader(lines) {
  const isinAt = lines.findIndex((l) => ISIN_RE.test(l));
  const upTo = isinAt >= 0 ? isinAt : lines.length - 1;
  let start = -1;
  for (let i = upTo; i >= 0; i--) {
    if (SCHEME_CODE_RE.test(lines[i]) && !/^(Nominee|PAN|KYC|Folio)/i.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) start = Math.max(0, upTo);
  const text = lines.slice(start).join(' ');
  return {
    scheme: schemeName(text),
    isin: ISIN_RE.exec(lines.join(' '))?.[1] ?? null,
    registrar: /\bRegistrar\s*:\s*([A-Za-z]+)/i.exec(text)?.[1]?.toUpperCase() ?? null,
  };
}

function parseDetailed(lines) {
  const holdings = [];
  let amc = null;
  let folio = null;
  let header = [];
  let inTransactions = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const amcMatch = AMC_RE.exec(line);
    if (amcMatch && !FOLIO_RE.test(line)) {
      amc = amcMatch[1].replace(/\s+/g, ' ').trim();
      continue;
    }
    const folioMatch = FOLIO_RE.exec(line);
    if (folioMatch) {
      folio = normaliseFolio(folioMatch[1]);
      header = [];
      inTransactions = false;
      continue;
    }
    if (!folio) continue;

    const closing = CLOSING_RE.exec(line);
    if (closing) {
      // The NAV, cost and value usually share the closing line but can wrap onto the next ones.
      const tail = lines.slice(i, i + 3).join('  ');
      const nav = NAV_RE.exec(tail);
      const cost = COST_RE.exec(tail);
      const value = VALUE_RE.exec(tail);
      const { scheme, isin, registrar } = schemeFromHeader(header);
      const units = parseAmount(closing[1]);
      if (scheme && units != null && nav) {
        holdings.push({
          amc,
          folio,
          scheme,
          isin,
          registrar,
          units,
          nav: parseAmount(nav[2]),
          navDate: parseCASDate(nav[1]),
          cost: cost ? parseAmount(cost[1]) : null,
          value: value ? parseAmount(value[2]) : null,
        });
      }
      header = [];
      inTransactions = false;
      continue;
    }
    if (OPENING_RE.test(line)) {
      inTransactions = true;
      continue;
    }
    if (!inTransactions) header.push(line);
  }
  return holdings;
}

function parseSummary(lines) {
  let amc = null;
  const holdings = [];
  for (const line of lines) {
    const amcMatch = AMC_RE.exec(line);
    if (amcMatch) {
      amc = amcMatch[1].replace(/\s+/g, ' ').trim();
      continue;
    }
    const m = SUMMARY_ROW_RE.exec(line);
    if (!m) continue;
    const [, folio, isin, name, cost, units, navDate, nav, value, registrar] = m;
    holdings.push({
      amc,
      folio: normaliseFolio(folio),
      scheme: schemeName(name),
      isin,
      registrar: registrar.toUpperCase(),
      units: parseAmount(units),
      nav: parseAmount(nav),
      navDate: parseCASDate(navDate),
      cost: cost != null ? parseAmount(cost) : null,
      value: parseAmount(value),
    });
  }
  return holdings;
}

/**
 * @param {string[]} lines text lines of the whole PDF, in reading order
 * @returns {{ asOf: number|null, holdings: object[] }}
 */
export function parseCAS(lines) {
  const all = lines.join('\n');
  const period = PERIOD_RE.exec(all);
  const asOn = AS_ON_RE.exec(all);
  const asOf = parseCASDate(period?.[2] ?? asOn?.[1]);

  let holdings = parseDetailed(lines);
  if (!holdings.length) holdings = parseSummary(lines);
  if (!holdings.length) {
    if (/\b(NSDL|CDSL)\b|Central\s+Depository/i.test(all) && !FOLIO_RE.test(all)) {
      throw new CASError('This is a depository (NSDL/CDSL) statement. Use the CAS from CAMS or KFintech instead — it lists every mutual fund folio.');
    }
    throw new CASError('No mutual fund holdings found. Use the CAS from CAMS or KFintech (a “Detailed” statement works best).');
  }
  return { asOf, holdings };
}

// MARK: - Merging into the portfolio

const holdingKey = (isin, folio) => `${isin}|${folio}`;

/**
 * Works out which holdings create new funds and which update existing ones.
 * A fund imported before is matched by ISIN + folio. A fund entered by hand (no folio) is matched by
 * AMFI code when exactly one holding and one existing fund share that code.
 * Fully redeemed holdings (0 units) are skipped unless they update an existing fund.
 * @param {Record<string,string>} schemes ISIN → AMFI scheme code
 */
export function planCASImport(statement, assets, schemes = {}) {
  const funds = assets.filter((a) => a.category === Category.mutualFund);
  const byKey = new Map(funds.filter((a) => a.isin && a.folio).map((a) => [holdingKey(a.isin, a.folio), a]));
  const codeOf = (h) => (h.isin ? schemes[h.isin] : undefined);
  const holdingsPerCode = new Map();
  for (const h of statement.holdings) {
    const code = codeOf(h);
    if (code) holdingsPerCode.set(code, (holdingsPerCode.get(code) ?? 0) + 1);
  }
  const claimed = new Set();
  return statement.holdings.map((holding) => {
    const amfiCode = codeOf(holding);
    let existing = holding.isin ? byKey.get(holdingKey(holding.isin, holding.folio)) : undefined;
    if (!existing && amfiCode && holdingsPerCode.get(amfiCode) === 1) {
      const manual = funds.filter((a) => !a.folio && a.amfiCode === amfiCode && !claimed.has(a.id));
      if (manual.length === 1) existing = manual[0];
    }
    if (existing) claimed.add(existing.id);
    const action = existing ? 'update' : holding.units > 0 ? 'new' : 'skip';
    return { holding, amfiCode, existing: existing ?? null, action };
  });
}

/**
 * Builds the saved asset for one planned item without touching the original.
 * Names and fund houses the user already set are kept; a fresher NAV from mfapi.in is kept too.
 */
export function assetFromHolding(item, rates = RateSchedule.official, now = Date.now()) {
  const h = item.holding;
  const a = item.existing ? structuredClone(item.existing) : createAsset({ category: Category.mutualFund, name: h.scheme }, now);
  a.folio = h.folio;
  if (h.isin) a.isin = h.isin;
  if (!a.amfiCode && item.amfiCode) a.amfiCode = item.amfiCode;
  if (!a.institution && h.amc) a.institution = h.amc;
  a.unitsHeld = h.units;
  if (h.cost > 0 && h.units > 0) a.averageNAV = h.cost / h.units;
  else a.averageNAV ??= h.nav;
  if (a.navDate == null || a.latestNAV == null || (h.navDate != null && h.navDate >= a.navDate)) {
    a.latestNAV = h.nav;
    a.navDate = h.navDate ?? now;
  }
  return recompute(a, rates, now);
}
