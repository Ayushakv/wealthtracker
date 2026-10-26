const TZ = 'Asia/Kolkata';
const currencyFormatters = new Map();

function currency(fractionDigits) {
  let f = currencyFormatters.get(fractionDigits);
  if (!f) {
    f = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    currencyFormatters.set(fractionDigits, f);
  }
  return f;
}

/** Full amount with Indian digit grouping, e.g. ₹12,34,567. */
export function inr(value, fractionDigits = 0) {
  // Avoid "-₹0" for tiny negatives that round to zero.
  const v = Math.abs(value) < 0.5 / 10 ** fractionDigits ? 0 : value;
  return currency(fractionDigits).format(v);
}

/** Compact lakh/crore notation, e.g. ₹12.35 L, ₹1.20 Cr. */
export function inrCompact(value) {
  const sign = value < 0 ? '-' : '';
  const v = Math.abs(value);
  if (v >= 10_000_000) return `${sign}₹${(v / 10_000_000).toFixed(2)} Cr`;
  if (v >= 100_000) return `${sign}₹${(v / 100_000).toFixed(2)} L`;
  return sign + inr(v);
}

const percentFormatter = new Intl.NumberFormat('en-IN', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
export function percent(fraction) {
  return percentFormatter.format(fraction);
}

/** Signed amount for gains: "+₹1.20 L" / "-₹3,400". */
export function signedCompact(value) {
  return (value >= 0 ? '+' : '') + inrCompact(value);
}

export function number(value, fractionDigits) {
  return new Intl.NumberFormat('en-IN', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value);
}

/** Up to `maxDigits` decimals, trailing zeros dropped: 7.25 → "7.25", 8 → "8". */
export function plainNumber(value, maxDigits = 2) {
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxDigits }).format(value);
}

const dateFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const monthFormatter = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: TZ });
const longDateFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ });

/** "26 Oct 2026" */
export const formatDate = (t) => dateFormatter.format(t);
/** "Oct 2026" */
export const formatMonth = (t) => monthFormatter.format(t);
/** "1 October 2026" */
export const formatLongDate = (t) => longDateFormatter.format(t);
export const formatDateTime = (t) => dateTimeFormatter.format(t);

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function formatRelative(t, now = Date.now()) {
  const seconds = Math.round((t - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86400), 'day');
}
