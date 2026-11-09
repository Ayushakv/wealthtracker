import { createAsset } from './assets.js';
import { date, parts } from './calendar.js';
import { CASError, parseAmount } from './cas.js';
import { Category } from './categories.js';

/**
 * Reads bonds from an NSDL or CDSL Consolidated Account Statement (the depository's statement of a demat account).
 * Holding rows start with the ISIN; the description sits in the next column, often wrapped over lines above and
 * below the ISIN's line, and the figures on the ISIN's line end with the value in rupees.
 * Only debt is taken: what the statement files under bonds, securitised instruments (PTCs) and government
 * securities. Shares and fund units in the same statement are left alone.
 */
const ISIN_AT_START = /^(IN[0-9A-Z]{9}[0-9])\b/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_RE = /^(\d{1,2})[-/ ]([A-Za-z]{3}|\d{1,2})[-/ ](\d{4})$/;
const NUMBER_RE = /^-?[\d,]*\.?\d+$/;
const FIGURE_RE = /^(?:-?[\d,]*\.?\d+%?|\d{1,2}[-/](?:[A-Za-z]{3}|\d{1,2})[-/]\d{4})$/;
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

const couponIn = (text) => {
  const m = /(\d{1,2}(?:\.\d{1,4})?)\s*%/.exec(text ?? '');
  return m ? Number(m[1]) : null;
};

/** A maturity written into a security's description: "… RD 07-11-2027", "… RD-19112027" or "… 14-Aug-2033". */
function maturityIn(text) {
  for (const m of text.matchAll(/\b\d{1,2}[-/](?:[A-Za-z]{3}|\d{1,2})[-/]\d{4}\b/g)) {
    const t = parseStatementDate(m[0]);
    if (t != null) return t;
  }
  const m = /\bRD\s*-?\s*(\d{2})(\d{2})(\d{4})\b/.exec(text);
  return m ? parseStatementDate(`${m[1]}-${m[2]}-${m[3]}`) : null;
}

const isFigure = (token) => FIGURE_RE.test(token);
/** A cell with words in it (a name, a frequency, "Not Available"), as opposed to numbers, rates and dates. */
const isTextCell = (cell) => !cell.text.split(/\s+/).every(isFigure);
/** The italic line under an NSDL bond's name that gives its kind, e.g. "Fixed Interest Bonds". */
const isKindLabel = (text) => /^(?:[A-Z][a-z]+\s+)+(?:Bonds?|Debentures?)$/.test(text);

const SECTION_RE = /([A-Z][a-z]+(?:\s+[A-Za-z]+)*)\s*\(([A-Z]{1,3})\)/;
const DEBT_SECTION = /Bond|Debenture|Securiti[sz]ed|Government\s+Securit|Treasury|Money\s+Market|Commercial\s+Paper/i;
const isHeaderRow = (row) => /^ISIN(?:\s|ISIN|:|$)/.test(row.cells[0]?.text ?? '');
const isTotalRow = (row) => row.cells.some((c) => /^(?:Sub\s*)?Total(?![a-z])|^Grand\s+Total/.test(c.text));
const END_RE = /End\s+of\s+Statement/i;

/** Debt in a section the statement names ("Corporate Bonds (C)", "Securitised Instruments (S)"), or by its ISIN when unnamed. */
function isDebt(isin, section) {
  if (section == null) return isDebtISIN(isin);
  return DEBT_SECTION.test(section) && !/^INF/.test(isin) && !/^IN[EF][0-9A-Z]{4}01/.test(isin);
}

/** Lines whose description cell starts at the description column; wrapped names and kind labels included. */
function descriptionLines(table) {
  const isinRows = table.filter((r) => r.isin);
  const isinEnd = Math.min(...isinRows.map((r) => r.row.cells[0].end));
  const lineHeight = Math.max(...isinRows.map((r) => r.row.cells[0].h));
  const near = (row) => isinRows.some((r) => Math.abs(r.row.y - row.y) <= 4 * lineHeight);
  // The column right of the ISIN: the leftmost text cell after it, among lines around the holdings.
  const xs = table.filter((r) => near(r.row)).flatMap((r) => r.row.cells.filter((c, i) => c.x >= isinEnd - 0.5 && isTextCell(c) && !(r.isin && i === 0)).map((c) => c.x));
  if (!xs.length) return [];
  const column = Math.min(...xs);
  const lines = [];
  // A wrapped description can end with a line holding just its redemption date ("07-11-2027", or "24052027" after "RD-").
  const isDescription = (c) => isTextCell(c) || parseStatementDate(c.text) != null || /^\d{8}$/.test(c.text);
  for (const r of table) {
    const i = r.row.cells.findIndex((c, i) => !(r.isin && i === 0) && Math.abs(c.x - column) <= 3 && isDescription(c));
    if (i >= 0 && near(r.row)) lines.push({ r, y: r.row.y, h: r.row.cells[i].h, text: r.row.cells[i].text, cell: i });
  }
  return lines;
}

/**
 * Hands each description line to its holding. A cell's lines are centred on (or start at) its ISIN line, so lines
 * close together form one cell, which belongs to the ISIN line it contains or else the one nearest its middle.
 */
function assignDescriptions(table) {
  const isinRows = table.filter((r) => r.isin);
  const nearest = (y) => isinRows.reduce((best, r) => (Math.abs(r.row.y - y) < Math.abs(best.row.y - y) ? r : best));
  const lines = descriptionLines(table);
  const clusters = [];
  for (const line of lines) {
    const last = clusters.at(-1)?.at(-1);
    if (last && last.y - line.y <= 1.5 * Math.max(last.h, line.h)) clusters.at(-1).push(line);
    else clusters.push([line]);
  }
  const owned = new Map(isinRows.map((r) => [r, []]));
  for (const cluster of clusters) {
    const anchors = new Set(cluster.filter((l) => l.r.isin).map((l) => l.r));
    if (anchors.size > 1) {
      for (const l of cluster) owned.get(l.r.isin ? l.r : nearest(l.y)).push(l);
      continue;
    }
    const owner = anchors.size ? [...anchors][0] : nearest((cluster[0].y + cluster.at(-1).y) / 2);
    owned.get(owner).push(...cluster);
  }
  return owned;
}

function holdingFromRow(r, lines, table) {
  const cells = r.row.cells;
  const own = lines.find((l) => l.r === r);
  // Text and figures can share a cell when the gap between them is narrow; peel rates and dates off the name.
  const words = own ? own.text.split(/\s+/) : [];
  const after = cells.slice(own ? own.cell + 1 : 1).flatMap((c) => c.text.split(/\s+/));
  const figures = after.filter(isFigure);
  const peel = figures.length ? (t) => /%$/.test(t) || parseStatementDate(t) != null : isFigure;
  while (words.length > 1 && peel(words.at(-1))) figures.unshift(words.pop());
  const parts = lines.filter((l) => !isKindLabel(l.text)).map((l) => (l === own ? words.join(' ') : l.text));
  const description = parts.reduce((text, part) => (!text ? part : /-$/.test(text) ? text + part : `${text} ${part}`), '');

  let numbers = figures.filter((t) => NUMBER_RE.test(t));
  // A long description can push the figures onto the next line or two.
  const next = table.slice(table.indexOf(r) + 1, table.indexOf(r) + 3);
  for (const n of next) {
    if (numbers.length || n.isin) break;
    numbers = n.row.cells.filter((c) => !isTextCell(c)).flatMap((c) => c.text.split(/\s+/)).filter((t) => NUMBER_RE.test(t));
  }
  if (!numbers.length || !description) return null;
  // CDSL writes "ISSUER#12% SEC GRT … NCD PP-RD 07-11-2027": the issuer, then the coupon and the terms.
  const [issuer, terms] = description.includes('#') ? [description.slice(0, description.indexOf('#')), description.slice(description.indexOf('#') + 1)] : [description, description];
  const name = issuer.split(/\s+/);
  while (name.length > 1 && (/%$/.test(name.at(-1)) || parseStatementDate(name.at(-1)) != null)) name.pop();
  return {
    account: r.account,
    isin: r.isin,
    name: name.join(' ').replace(/^[-–:\s]+/, '').trim(),
    value: parseAmount(numbers.at(-1)),
    coupon: couponIn(figures.find((t) => t.endsWith('%')) ?? terms),
    maturity: figures.map(parseStatementDate).find((t) => t != null) ?? maturityIn(terms),
  };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One issuer's different bonds would share a name, so those get their coupon and maturity added. */
function nameApart(holdings) {
  const isins = new Map();
  for (const h of holdings) isins.set(h.name, (isins.get(h.name) ?? new Set()).add(h.isin));
  for (const h of holdings) {
    if (isins.get(h.name).size < 2) continue;
    const { year, month } = h.maturity != null ? parts(h.maturity) : {};
    const suffix = [h.coupon != null ? `${h.coupon}%` : null, year ? `${MONTH_NAMES[month - 1]} ${year}` : null].filter(Boolean).join(' ');
    if (suffix) h.name = `${h.name} ${suffix}`;
  }
}

/**
 * @param {import('../ui/pdf.js').Row[]} rows lines of the whole PDF with their positions, in reading order
 * @returns {{ asOf: number|null, holdings: { account, isin, name, value, coupon, maturity }[] }}
 */
export function parseDematBonds(rows) {
  const all = rows.map((r) => r.text).join('\n');
  const period = /(\d{1,2}[-/](?:[A-Za-z]{3}|\d{2})[-/]\d{4})\s+to\s+(\d{1,2}[-/](?:[A-Za-z]{3}|\d{2})[-/]\d{4})/i.exec(all);
  const asOn = /as\s+on\s+(\d{1,2}[-/](?:[A-Za-z]{3}|\d{2})[-/]\d{4})/i.exec(all);
  const asOf = parseStatementDate(period?.[2] ?? asOn?.[1]);

  // Split the holdings into tables: runs of lines on one page between headings, column headers and totals.
  const tables = [];
  let table = null;
  let dp = null;
  let account = null;
  let section = null;
  let inTransactions = false;
  for (const row of rows) {
    const text = row.text;
    if (END_RE.test(text)) break;
    const isin = ISIN_AT_START.exec(row.cells[0]?.text ?? '')?.[1] ?? null;
    const bo = /\bBO\s*ID\s*:?\s*(\d{16})\b/i.exec(text);
    const dpMatch = /\bDP\s*ID\s*:?\s*((?:IN)?\d{6,8})\b/i.exec(text);
    const client = /\bClient\s*ID\s*:?\s*(\d{8})\b/i.exec(text);
    if (dpMatch) dp = dpMatch[1];
    if (bo || client) {
      account = bo ? bo[1] : `${dp ?? ''}${client[1]}`;
      section = null;
    }
    const heading = isin ? null : SECTION_RE.exec(text);
    if (heading) section = heading[1];
    // Transactions repeat ISINs (and the account lines); a holdings heading or section ends them.
    if (TRANSACTIONS_RE.test(text)) inTransactions = true;
    else if (heading || HOLDINGS_RE.test(text)) inTransactions = false;
    const barrier = !isin && (bo || dpMatch || client || heading || isHeaderRow(row) || isTotalRow(row));
    if (barrier || inTransactions || table?.page !== row.page) table = null;
    if (barrier || inTransactions) continue;
    if (!table) tables.push((table = Object.assign([], { page: row.page })));
    table.push({ row, isin, account, section });
  }

  const found = new Map();
  for (const t of tables) {
    if (!t.some((r) => r.isin)) continue;
    for (const [r, lines] of assignDescriptions(t)) {
      if (!isDebt(r.isin, r.section)) continue;
      const h = holdingFromRow(r, lines, t);
      // A bond is listed once per account; if a summary repeats it, keep the first (the holding row).
      if (h && !found.has(`${h.isin}|${h.account}`)) found.set(`${h.isin}|${h.account}`, h);
    }
  }
  const holdings = [...found.values()];
  if (!holdings.length) {
    throw new CASError('No bonds found in this statement. Shares and mutual funds in a demat statement aren’t imported — use the CAMS/KFintech statement for mutual funds.');
  }
  // NSDL's table gives no coupon; the same bond in a CDSL account does.
  for (const h of holdings) {
    const twin = holdings.find((o) => o.isin === h.isin && o !== h);
    h.coupon ??= twin?.coupon ?? null;
    h.maturity ??= twin?.maturity ?? null;
  }
  nameApart(holdings);
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
