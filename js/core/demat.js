import { createAsset } from './assets.js';
import { date } from './calendar.js';
import { CASError, parseAmount } from './cas.js';
import { Category } from './categories.js';

/**
 * Reads bonds from an NSDL or CDSL Consolidated Account Statement (the depository's statement of a demat account).
 * Holding rows start with the ISIN, then the description, then figures ending with the value in rupees.
 * Only debt is taken: government securities and SGBs (ISINs "IN" + digit) and corporate bonds/NCDs (security
 * type 07 or 08 in an INE ISIN). Shares and fund units in the same statement are left alone.
 */
const ISIN_RE = /\b(IN[0-9A-Z]{9}[0-9])\b/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_RE = /^(\d{1,2})[-/ ]([A-Za-z]{3}|\d{1,2})[-/ ](\d{4})$/;
const NUMBER_RE = /^-?[\d,]*\.?\d+$/;
const FIGURE_RE = /^(?:-?[\d,]*\.?\d+%?|\d{1,2}[-/](?:[A-Za-z]{3}|\d{1,2})[-/]\d{4})$/;
const STARTS_WITH_DATE = /^\s*\d{1,2}[-/](?:[A-Za-z]{3}|\d{1,2})[-/]\d{2,4}\b/;
const TRANSACTIONS_RE = /^\s*(?:Statement\s+of\s+)?Transactions?\b/i;
const HOLDINGS_RE = /Holding\s+Statement|Statement\s+of\s+Holdings?|Portfolio\s+(?:Valuation|Holdings?)|Holdings?\s+as\s+on/i;

export const isDebtISIN = (isin) => /^IN\d/.test(isin) || /^INE[0-9A-Z]{4}0[78]/.test(isin);

/** True for an NSDL/CDSL statement (it identifies demat accounts by DP ID / BO ID; CAMS statements list folios). */
export function isDepositoryStatement(lines) {
  const all = lines.join('\n');
  return /\b(NSDL|CDSL)\b/.test(all) && /\b(DP\s*ID|BO\s*ID)\b/i.test(all) && !/Closing\s+Unit\s+Balance/i.test(all);
}

/** "30-Sep-2026", "30-09-2026" or "30/09/2026" → midnight IST. */
export function parseStatementDate(s) {
  const m = DATE_RE.exec(s?.trim() ?? '');
  if (!m) return null;
  const month = /\d/.test(m[2]) ? Number(m[2]) : MONTHS[m[2].toLowerCase()];
  return month >= 1 && month <= 12 ? date(Number(m[3]), month, Number(m[1])) : null;
}

/**
 * Splits what follows the ISIN into the description (leading text cells) and the figures after it.
 * Cells only split on wide gaps, so a coupon or date next to the name can share its cell; those move to the figures.
 * With no gaps at all, the trailing figures are peeled off the end.
 */
function splitRow(rest) {
  const cells = rest.split('\t').map((c) => c.trim()).filter(Boolean);
  const isFigures = (cell) => cell.split(/\s+/).every((t) => FIGURE_RE.test(t));
  let i = 0;
  while (i < cells.length && !isFigures(cells[i])) i++;
  const words = cells.slice(0, i).join(' ').split(/\s+/).filter(Boolean);
  const figures = cells.slice(i).join(' ').split(/\s+/).filter(Boolean);
  const peel = figures.length ? (t) => /%$/.test(t) || parseStatementDate(t) != null : (t) => FIGURE_RE.test(t);
  while (words.length > 1 && peel(words.at(-1))) figures.unshift(words.pop());
  return { description: words.join(' '), figures };
}

const couponIn = (text) => {
  const m = /(\d{1,2}(?:\.\d{1,4})?)\s*%/.exec(text);
  return m ? Number(m[1]) : null;
};

function holdingFromRow(isin, rest, account) {
  const { description, figures } = splitRow(rest);
  const numbers = figures.filter((t) => NUMBER_RE.test(t));
  const value = numbers.length ? parseAmount(numbers.at(-1)) : null;
  if (value == null || !description) return null;
  return {
    account,
    isin,
    name: description.replace(/^[-–:\s]+/, ''),
    value,
    coupon: couponIn(figures.find((t) => t.endsWith('%')) ?? description),
    maturity: figures.map(parseStatementDate).find((t) => t != null) ?? null,
  };
}

/** The tail of a description that wrapped below its row: short upper-case text, not a heading, label, total or footer. */
const isNameContinuation = (line) =>
  line.length <= 60 && !/[a-z]/.test(line) && !HOLDINGS_RE.test(line) && !TRANSACTIONS_RE.test(line) && !line.includes('\t') && !line.includes(':') && !ISIN_RE.test(line) && !/\(\w\)\s*$/.test(line) && !/^\s*(ISIN|Total|Sub\s*Total|Page|Grand)\b/i.test(line) && !STARTS_WITH_DATE.test(line);

/**
 * @param {string[]} lines text lines of the whole PDF, in reading order
 * @returns {{ asOf: number|null, holdings: { account, isin, name, value, coupon, maturity }[] }}
 */
export function parseDematBonds(lines) {
  const all = lines.join('\n');
  const period = /(\d{1,2}[-/](?:[A-Za-z]{3}|\d{2})[-/]\d{4})\s+to\s+(\d{1,2}[-/](?:[A-Za-z]{3}|\d{2})[-/]\d{4})/i.exec(all);
  const asOn = /as\s+on\s+(\d{1,2}[-/](?:[A-Za-z]{3}|\d{2})[-/]\d{4})/i.exec(all);
  const asOf = parseStatementDate(period?.[2] ?? asOn?.[1]);

  const found = new Map();
  let dp = null;
  let account = null;
  let inTransactions = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bo = /\bBO\s*ID\s*:?\s*(\d{16})\b/i.exec(line);
    if (bo) account = bo[1];
    const dpMatch = /\bDP\s*ID\s*:?\s*((?:IN)?\d{6,8})\b/i.exec(line);
    if (dpMatch) dp = dpMatch[1];
    const client = /\bClient\s*ID\s*:?\s*(\d{8})\b/i.exec(line);
    if (client) account = `${dp ?? ''}${client[1]}`;
    if (TRANSACTIONS_RE.test(line)) inTransactions = true;
    else if (bo || client || HOLDINGS_RE.test(line)) inTransactions = false;

    const isinMatch = ISIN_RE.exec(line);
    // Transaction rows start with a date; holdings start with the ISIN.
    if (inTransactions || !isinMatch || !isDebtISIN(isinMatch[1]) || STARTS_WITH_DATE.test(line)) continue;
    let rest = line.slice(isinMatch.index + isinMatch[1].length);
    let h = holdingFromRow(isinMatch[1], rest, account);
    // A long description can push the figures onto the next line or two.
    for (let j = i + 1; !h && j <= i + 2 && j < lines.length && !ISIN_RE.test(lines[j]) && !STARTS_WITH_DATE.test(lines[j]); j++) {
      rest += `\t${lines[j]}`;
      h = holdingFromRow(isinMatch[1], rest, account);
    }
    if (!h) continue;
    const next = lines[i + 1];
    if (next != null && rest === line.slice(isinMatch.index + isinMatch[1].length) && isNameContinuation(next)) {
      h.name += ` ${next.trim()}`;
      h.coupon ??= couponIn(next);
      i++;
    }
    // A bond is listed once per account; if a summary repeats it, keep the first (the holding row).
    const key = `${h.isin}|${h.account}`;
    if (!found.has(key)) found.set(key, h);
  }
  const holdings = [...found.values()];
  if (!holdings.length) {
    throw new CASError('No bonds found in this statement. Shares and mutual funds in a demat statement aren’t imported — use the CAMS/KFintech statement for mutual funds.');
  }
  return { asOf, holdings };
}

/**
 * Bonds imported before are matched by ISIN + demat account; everything else is new.
 * Bonds entered by hand have no ISIN, so the review lets the user untick ones they already track.
 */
export function planBondImport(statement, assets) {
  const bonds = assets.filter((a) => a.category === Category.bonds && a.isin);
  const byKey = new Map(bonds.map((a) => [`${a.isin}|${a.folio ?? ''}`, a]));
  const items = statement.holdings.map((holding) => {
    const existing = byKey.get(`${holding.isin}|${holding.account ?? ''}`) ?? null;
    return { holding, existing, action: existing ? 'update' : holding.value > 0 ? 'new' : 'skip' };
  });
  const seen = new Set(items.map((i) => i.existing?.id).filter(Boolean));
  const accounts = new Set(statement.holdings.map((h) => h.account ?? ''));
  // Bonds from an earlier import of these accounts that the statement no longer lists (sold or matured).
  const missing = bonds.filter((a) => accounts.has(a.folio ?? '') && !seen.has(a.id));
  return { items, missing };
}

/** The saved bond for one item. New bonds are valued at the statement's market value; bonds set to calculate from interest keep doing so. */
export function bondFromHolding(item, now = Date.now()) {
  const h = item.holding;
  const a = item.existing ? structuredClone(item.existing) : createAsset({ category: Category.bonds, name: h.name, investedAmount: h.value }, now);
  a.isin = h.isin;
  if (h.account) a.folio = h.account;
  if (a.interestRate == null && h.coupon != null) a.interestRate = h.coupon;
  if (a.maturityDate == null && h.maturity != null) a.maturityDate = h.maturity;
  if (a.startDate == null) {
    a.currentValuation = h.value;
    a.lastUpdated = now;
  }
  return a;
}
