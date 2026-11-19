import { createAsset, recompute } from './assets.js';
import { addMonths, addYears, date } from './calendar.js';
import { CASError, parseAmount } from './cas.js';
import { Category, LIC_ENDOWMENT } from './categories.js';
import { RateSchedule } from './ppf.js';
import { PREMIUM_MODES } from './premiums.js';

/**
 * Reads the Schedule page of an LIC policy bond (the policy document PDF). The schedule is bilingual and laid out in
 * two columns, so a value often sits on a line of its own just above or below its English label, or on the Hindi
 * line next to it. Each field is looked for on the label's line first, then on the lines around it.
 */

const DATE_RE = /\b(\d{2})-(\d{2})-(\d{4})\b/;
const DATE_ONLY_RE = /^\s*(\d{2})-(\d{2})-(\d{4})\s*$/;
const AMOUNT_ONLY_RE = /^\s*([\d,]+(?:\.\d{1,2})?)\s*$/;
const MODES = { Mly: 'Monthly', SSS: 'Monthly', NACH: 'Monthly', ECS: 'Monthly', Qly: 'Quarterly', Hly: 'Half-yearly', Yly: 'Yearly', Single: 'Yearly', Sgl: 'Yearly' };
const MODE_RE = new RegExp(String.raw`(?:^|\t)(${Object.keys(MODES).join('|')})(?:\t|$)`);
/** "1  ADDB Rdr 999B999V01  15-01-2020  500000  125  15-12-2031  15-01-2040" */
const RIDER_RE = /^\d+\t(.*?\bRdr\b.*?)[\t ]+\d{2}-\d{2}-\d{4}\t([\d,]+)\t([\d,]+(?:\.\d+)?)(?:\t|$)/;
/** The footer on every page: "LIC’s Jeevan Sample Plan · Page 3 of 20 · Plan No -999" */
const FOOTER_RE = /LIC['’]s\s+(.+?)\s*\tPage\s+\d+\s+of\s+\d+\tPlan\s+No\s*-\s*(\d+)/;

export function isLICBond(lines) {
  return lines.some((l) => /Plan\s+No\s*-\s*\d{3}\b/.test(l)) && lines.some((l) => /Policy\s+Number/.test(l)) && lines.some((l) => /\bLIC['’]s\b|Life Insurance Corporation/i.test(l));
}

const toDate = (m) => date(Number(m[3]), Number(m[2]), Number(m[1]));
const fields = (line) => line.split('\t').map((s) => s.trim());

export function parseLICBond(rows) {
  const lines = rows.map((r) => (typeof r === 'string' ? r : r.text));
  if (!isLICBond(lines)) throw new CASError('This doesn’t look like an LIC policy bond. Use the policy document PDF that has the Schedule page.');

  const indexOf = (re) => lines.findIndex((l) => re.test(l));
  /** What follows the label on its own line, then the nearby lines in `order` (offsets from the label's line). */
  const near = (label, pick, order) => {
    const i = indexOf(label);
    if (i < 0) return null;
    const rest = lines[i].slice(lines[i].search(label)).replace(label, '');
    const own = pick(rest, true);
    if (own != null) return own;
    for (const o of order) {
      const line = lines[i + o];
      if (line == null) continue;
      const v = pick(line, false);
      if (v != null) return v;
    }
    return null;
  };
  /** A date right after the label, or a line that's only a date. */
  const pickDate = (s, own) => {
    const m = own ? DATE_RE.exec(fields(s).filter(Boolean)[0] ?? '') : DATE_ONLY_RE.exec(s);
    return m ? toDate(m) : null;
  };
  /** An amount in the field right after the label, or a line that's only an amount. */
  const pickAmount = (s, own) => {
    const m = AMOUNT_ONLY_RE.exec(own ? (fields(s).filter(Boolean).at(-1) ?? '') : s);
    return m ? parseAmount(m[1]) : null;
  };

  const policyNumber = near(/Policy\s+Number\s*:?/, (s) => /^\s*(\d{6,12})\b/.exec(fields(s).filter(Boolean)[0] ?? '')?.[1] ?? null, [1, -1]);
  if (!policyNumber) throw new CASError('Couldn’t find the policy number. Make sure the PDF includes the Schedule page.');

  const footer = lines.map((l) => FOOTER_RE.exec(l)).find(Boolean);
  const term = lines.map((l) => /Plan\s*&\s*Policy\s+Term\t(\d{1,4})\s+(\d{1,3})\b/.exec(l)).find(Boolean);
  const planNo = term?.[1] ?? footer?.[2] ?? null;
  const planName = footer?.[1].replace(/\s+Plan$/i, '').trim() || null;
  const policyTerm = term ? Number(term[2]) : null;
  const ppt = lines.map((l) => /Premium\s+Paying\s+Term\t(\d{1,3})\b/.exec(l)).find(Boolean);
  const premiumTerm = ppt ? Number(ppt[1]) : null;

  const commencement = near(/Date\s+of\s+Commencement\s+of\s+Policy\s*:?/, pickDate, [1, -1]);
  if (commencement == null) throw new CASError('Couldn’t find the date of commencement. Make sure the PDF includes the Schedule page.');

  const modeMatch = lines.map((l) => MODE_RE.exec(l)).find(Boolean);
  if (!modeMatch) throw new CASError('Couldn’t find how often premiums are paid (mode of payment) in this policy bond.');
  const code = modeMatch[1];
  const mode = MODES[code];
  const single = code === 'Single' || code === 'Sgl';

  const riders = lines.map((l) => RIDER_RE.exec(l)).filter(Boolean).map((m) => ({ name: m[1], sumAssured: parseAmount(m[2]), premium: parseAmount(m[3]) }));
  const riderPremium = riders.reduce((s, r) => s + r.premium, 0);

  const basePremium = near(/Instalment\s+Premium\s+for\s+Base\s+Policy\s*\(Rs\)?\.?/, pickAmount, [1, 2, -1]);
  let premium = near(/Total\s+Instalment\s+Premium\s*\(Rs\)/, pickAmount, [-1, 1, -2, 2]);
  if (basePremium != null && (premium == null || premium < basePremium)) premium = basePremium + riderPremium;
  if (!(premium > 0)) throw new CASError('Couldn’t find the instalment premium in this policy bond.');

  // The sum assured is the largest whole number around its label (the premiums printed beside it are smaller).
  const saAt = indexOf(/Basic\s+Sum\s+Assured/);
  const saCandidates = saAt < 0 ? [] : lines.slice(Math.max(0, saAt - 2), saAt + 2).flatMap((l) => fields(l)).filter((f) => /^\d{4,}$/.test(f)).map(Number);
  const sumAssured = saCandidates.length ? Math.max(...saCandidates) : (riders[0]?.sumAssured ?? null);

  const step = PREMIUM_MODES[mode];
  const lastPremium =
    near(/Due\s+date\s+of\s+Payment\s+of\s+Last/, pickDate, [1, 2, -1]) ??
    (single ? commencement : premiumTerm != null ? addMonths(addYears(commencement, premiumTerm), -step) : null);
  const maturity = near(/Date\s+of\s+Maturity\s*:?/, pickDate, [1, -1]) ?? (policyTerm != null ? addYears(commencement, policyTerm) : null);
  const survivalBenefit = near(/Date\s+of\s+First\s+Survival\s+Benefit\s+Payment/, pickDate, [1, -1]);

  return {
    policyNumber,
    planName,
    planNo,
    policyTerm,
    premiumTerm,
    commencement,
    mode,
    premium,
    basePremium,
    riders,
    sumAssured,
    lastPremium,
    maturity,
    survivalBenefit,
  };
}

/** The same policy number means the same policy; anything else is added as a new one. */
export function planLICImport(bond, assets) {
  const same = assets.find((a) => a.category === Category.insurance && String(a.policyNumber ?? '').trim() === bond.policyNumber);
  return same ? { action: 'update', existing: same } : { action: 'new', existing: null };
}

/**
 * The policy as its bond describes it, with its premiums counted from the first due date. A surrender value and the
 * name and notes already entered are kept.
 */
export function licAssetFrom(plan, bond, rates = RateSchedule.official, now = Date.now()) {
  const name = bond.planName ? `LIC ${bond.planName.replace(/^LIC\s+/i, '')}` : 'LIC Policy';
  const a = plan.existing ? structuredClone(plan.existing) : createAsset({ category: Category.insurance, name, institution: 'LIC' }, now);
  a.policyType = LIC_ENDOWMENT;
  a.policyNumber = bond.policyNumber;
  if (bond.sumAssured != null) a.policySumAssured = bond.sumAssured;
  a.premiumMode = bond.mode;
  a.premiumInstalment = bond.premium;
  a.premiumStartDate = bond.commencement;
  a.premiumEndDate = bond.lastPremium ?? undefined;
  a.maturityDate = bond.maturity ?? undefined;
  a.survivalBenefitDate = bond.survivalBenefit ?? undefined;
  if (!a.notes) {
    const terms = [bond.planNo && `Plan ${bond.planNo}`, bond.policyTerm && `${bond.policyTerm}-year term`, bond.premiumTerm && `premiums for ${bond.premiumTerm} years`].filter(Boolean);
    if (terms.length) a.notes = terms.join(' · ');
  }
  return recompute(a, rates, now);
}
