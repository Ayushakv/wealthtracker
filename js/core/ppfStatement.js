import { createAsset, createEntry, recompute } from './assets.js';
import { date, financialYearStart } from './calendar.js';
import { CASError, parseAmount } from './cas.js';
import { Category } from './categories.js';
import { RateSchedule } from './ppf.js';

/**
 * Reads the PPF account statement a bank emails or lets you download for a financial year (Axis Bank's layout:
 * "The current value of investment in your Public Provident Fund (PPF) account number … is INR …", then a table of
 * Transaction Date · Remarks · Amount · Balance). The app works out interest itself, so what it needs is the balance
 * on 1 April and the deposits and withdrawals since.
 */

const NUM_DATE = String.raw`(\d{1,2}[-/.]\d{1,2}[-/.]\d{4})`;
const ACCOUNT_RE = /Public\s+Provident\s+Fund\s*(?:\(PPF\))?\s+account\s+(?:number|no\.?)\s*:?\s*([A-Z0-9]{6,})/i;
const VALUE_RE = /account\s+(?:number|no\.?)\s*:?\s*[A-Z0-9]{6,}\s+is\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)/i;
const PERIOD_RE = new RegExp(String.raw`from\s+${NUM_DATE}\s+to\s+${NUM_DATE}`, 'i');
/** "02-11-2026  Deposit  20000.00  40000.00" */
const TX_RE = new RegExp(String.raw`^${NUM_DATE}\t([^\t]*)\t(-?[\d,]+\.\d{2})\t(-?[\d,]+\.\d{2})\s*$`);
const BANK_RE = /\b((?:[A-Z][A-Za-z&]*\s+){0,3}Bank)\s+(?:Ltd|Limited)\b/;

const WITHDRAWAL_RE = /withdraw|debit|\bdr\b|closure|transfer(?:red)?\s+out/i;
const INTEREST_RE = /interest|\bint\.?\s*(?:cr|credit)/i;

export function isPPFStatement(lines) {
  return ACCOUNT_RE.test(lines.join(' '));
}

/** "14-10-2026" (day first) → epoch ms at IST midnight */
function numericDate(s) {
  const [d, m, y] = s.split(/[-/.]/).map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? date(y, m, d) : null;
}

const round2 = (x) => Math.round(x * 100) / 100;
export const normaliseAccount = (s) => (s ?? '').replace(/[^0-9A-Z]/gi, '').toUpperCase();

/**
 * @returns {{account, bank, asOf, fyStart, value, opening, balanced, transactions: {date, remarks, kind, amount, balance}[]}}
 *   `amount` is signed (withdrawals negative); `kind` is 'deposit', 'withdrawal' or 'interest'.
 */
export function parsePPF(rows) {
  const lines = rows.map((r) => (typeof r === 'string' ? r : r.text));
  const all = lines.join(' ').replace(/\s+/g, ' ');
  const account = ACCOUNT_RE.exec(all)?.[1];
  if (!account) throw new CASError('This PPF statement has no account number on it.');
  const value = VALUE_RE.exec(all)?.[1];
  const period = PERIOD_RE.exec(all);
  const periodStart = period && numericDate(period[1]);
  if (periodStart != null && periodStart !== date(financialYearStart(periodStart), 4, 1)) {
    throw new CASError('This statement starts partway through a financial year. Download the one from 1 April, so the opening balance is right.');
  }

  const listed = [];
  for (const line of lines) {
    const m = TX_RE.exec(line);
    if (!m) continue;
    const remarks = m[2].trim();
    const kind = INTEREST_RE.test(remarks) ? 'interest' : WITHDRAWAL_RE.test(remarks) || m[3].startsWith('-') ? 'withdrawal' : 'deposit';
    const size = Math.abs(parseAmount(m[3].replace('-', '')));
    listed.push({ date: numericDate(m[1]), remarks, kind, amount: kind === 'withdrawal' ? -size : size, balance: parseAmount(m[4].replace('-', '')) });
  }
  if (listed.some((t) => t.date == null)) throw new CASError('Couldn’t read the dates in this PPF statement.');
  // Banks list newest first or oldest first; same-day rows keep their order either way.
  const newestFirst = listed.length > 1 && listed[0].date > listed.at(-1).date;
  const transactions = newestFirst ? [...listed].reverse() : listed;

  const closing = value != null ? parseAmount(value) : transactions.at(-1)?.balance;
  if (closing == null) throw new CASError('Couldn’t find the balance in this PPF statement.');
  const opening = round2(closing - transactions.reduce((s, t) => s + t.amount, 0));
  let running = opening;
  const balanced = transactions.every((t) => Math.abs((running = round2(running + t.amount)) - t.balance) < 0.01);

  const lone = lines.map((l) => l.trim()).find((l) => new RegExp(`^${NUM_DATE}$`).test(l));
  const asOf = (lone && numericDate(lone)) ?? transactions.at(-1)?.date ?? null;
  const fyStart = periodStart != null ? financialYearStart(periodStart) : financialYearStart(transactions[0]?.date ?? asOf ?? Date.now());
  const bank = BANK_RE.exec(all)?.[1] ?? null;
  return { account, bank, asOf, fyStart, value: closing, opening, balanced, transactions };
}

/**
 * Which PPF asset the statement brings up to date: the one with its account number, else the only one with no
 * account number yet (added by hand), else a new one.
 */
export function planPPFImport(statement, assets) {
  const ppf = assets.filter((a) => a.category === Category.ppf);
  const same = ppf.find((a) => normaliseAccount(a.accountNumber) === normaliseAccount(statement.account));
  if (same) return { action: 'update', existing: same };
  const unlinked = ppf.filter((a) => !a.accountNumber);
  if (unlinked.length === 1) return { action: 'update', existing: unlinked[0], adopted: true };
  return { action: 'new', existing: null };
}

/**
 * The asset as the statement leaves it: its opening balance and transactions are the statement's, replacing any
 * entered before. Interest rows are left out, since the app credits interest itself. Name and notes are kept.
 */
export function ppfAssetFrom(plan, statement, rates = RateSchedule.official, now = Date.now()) {
  const a = plan.existing
    ? structuredClone(plan.existing)
    : createAsset({ category: Category.ppf, name: statement.bank ? `PPF – ${statement.bank}` : 'PPF', ...(statement.bank ? { institution: statement.bank } : {}) }, now);
  if (!a.institution && statement.bank) a.institution = statement.bank;
  a.accountNumber = statement.account;
  a.ppfOpeningFYStartYear = statement.fyStart;
  a.ppfOpeningBalance = statement.opening;
  a.entries = statement.transactions
    .filter((t) => t.kind !== 'interest')
    .map((t) => createEntry(t.date, t.amount, /^(deposit|withdrawal)$/i.test(t.remarks) ? undefined : t.remarks));
  return recompute(a, rates, now);
}
