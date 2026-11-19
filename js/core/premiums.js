import { addMonths, startOfDay } from './calendar.js';

/** Months between premiums for each payment mode. */
export const PREMIUM_MODES = Object.freeze({ Monthly: 1, Quarterly: 3, 'Half-yearly': 6, Yearly: 12 });

export const modeLabel = (mode) => (mode === 'Half-yearly' ? 'half-yearly' : (mode ?? '').toLowerCase());

/** A policy whose premiums the app counts itself: an instalment, a payment mode and the first due date. */
export const hasPremiumSchedule = (a) => PREMIUM_MODES[a.premiumMode] != null && a.premiumInstalment > 0 && a.premiumStartDate != null;

/**
 * The policy's premiums as of `now`, assuming each one was paid on its due date. Due dates step from the first
 * premium (the policy's commencement) by whole months, clamped to the month's length, as LIC bills them; the one due
 * today still counts as due, so it shows in Upcoming Renewals. Null when the policy has no schedule.
 * @returns {{ count, paid, next, total, totalCount, annual, perYear }} `next` is null once every premium is paid.
 */
export function premiumSchedule(a, now = Date.now()) {
  if (!hasPremiumSchedule(a)) return null;
  const step = PREMIUM_MODES[a.premiumMode];
  const today = startOfDay(now);
  const last = a.premiumEndDate ?? null;
  const dueAt = (k) => addMonths(a.premiumStartDate, k * step);
  // 100 years of monthly premiums bounds the loop for a bad end date.
  const LIMIT = 1200;
  let count = 0;
  while (count < LIMIT && dueAt(count) < today && (last == null || dueAt(count) <= last)) count++;
  const next = count < LIMIT && (last == null || dueAt(count) <= last) ? dueAt(count) : null;
  let totalCount = null;
  if (last != null) {
    totalCount = count;
    while (totalCount < LIMIT && dueAt(totalCount) <= last) totalCount++;
  }
  const perYear = 12 / step;
  return {
    count,
    paid: count * a.premiumInstalment,
    next,
    totalCount,
    total: totalCount == null ? null : totalCount * a.premiumInstalment,
    perYear,
    annual: a.premiumInstalment * perYear,
  };
}
