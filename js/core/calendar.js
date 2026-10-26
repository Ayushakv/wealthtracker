// Gregorian dates pinned to IST, matching the iOS app's IndianCalendar.
// Dates are stored as epoch milliseconds. IST is a fixed UTC+5:30 with no DST,
// so IST calendar fields are the UTC fields of (t + offset).

export const IST_OFFSET_MS = 330 * 60 * 1000;
export const DAY_MS = 86_400_000;

const mod = (a, n) => ((a % n) + n) % n;

/** Calendar fields of an instant, in IST. */
export function parts(t) {
  const shifted = t + IST_OFFSET_MS;
  const d = new Date(shifted);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    msOfDay: mod(shifted, DAY_MS),
  };
}

/** Midnight IST on the given day. */
export function date(year, month, day) {
  return Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds calendar months, clamping the day to the target month's length (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(t, months) {
  const p = parts(t);
  const total = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = mod(total, 12) + 1;
  return date(year, month, Math.min(p.day, daysInMonth(year, month))) + p.msOfDay;
}

export function addYears(t, years) {
  return addMonths(t, years * 12);
}

export function addDays(t, days) {
  return t + days * DAY_MS;
}

export function startOfDay(t) {
  const p = parts(t);
  return date(p.year, p.month, p.day);
}

/** Whole days from `from` to `to`, truncated towards zero (like Calendar.dateComponents([.day])). */
export function daysBetween(from, to) {
  return Math.trunc((to - from) / DAY_MS);
}

/** Indian financial years run 1 April – 31 March. Returns the calendar year the FY starts in. */
export function financialYearStart(t) {
  const p = parts(t);
  return p.month >= 4 ? p.year : p.year - 1;
}

export function fyLabel(startYear) {
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** PPF rates are notified per quarter (Apr, Jul, Oct, Jan). */
export function quarterStart(t) {
  const p = parts(t);
  return date(p.year, Math.floor((p.month - 1) / 3) * 3 + 1, 1);
}

/** "YYYY-MM-DD" for <input type="date">. */
export function toInputValue(t) {
  const p = parts(t);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function fromInputValue(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  return m ? date(Number(m[1]), Number(m[2]), Number(m[3])) : undefined;
}
