import { addDays, parts } from './calendar.js';
import { inr } from './format.js';

/** Same lead times as the iOS app's notifications: 30, 15 and 3 days before, at 9 am. */
export const LEAD_DAYS = [30, 15, 3];
const REMINDER_HOUR = 9;

const pad = (n) => String(n).padStart(2, '0');
const icsDate = (t) => {
  const p = parts(t);
  return `${p.year}${pad(p.month)}${pad(p.day)}`;
};
const icsStamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** RFC 5545 text escaping. */
const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Folds lines longer than 75 octets, as RFC 5545 requires. */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** "-P29DT15H" = 30 days before an all-day event, at 9 am. */
const trigger = (days) => `-P${days - 1}DT${24 - REMINDER_HOUR}H`;

/**
 * Calendar file with one all-day event per policy due date, each with alarms 30/15/3 days before at 9 am.
 * Calendar apps fire these alerts even when the web app is closed.
 */
export function renewalCalendar(policies, now = Date.now()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WealthTracker//Renewals//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const p of policies) {
    if (p.policyRenewalDate == null) continue;
    const details = [
      p.policyType,
      p.institution,
      p.policyNumber && `Policy no. ${p.policyNumber}`,
      p.annualPremium != null && `Premium ${inr(p.annualPremium)}`,
    ].filter(Boolean);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${p.id}-${icsDate(p.policyRenewalDate)}@wealthtracker`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART;VALUE=DATE:${icsDate(p.policyRenewalDate)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(p.policyRenewalDate, 1))}`,
      `SUMMARY:${escapeText(`Renewal due: ${p.name}`)}`,
      `DESCRIPTION:${escapeText(details.join('\n'))}`,
      'TRANSP:TRANSPARENT',
    );
    for (const days of LEAD_DAYS) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(`${p.name} renews in ${days} days`)}`, `TRIGGER:${trigger(days)}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
