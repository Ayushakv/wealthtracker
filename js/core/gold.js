// Gold is valued at the day's rate per gram in Hyderabad from 5paisa (before GST). 5paisa's page can't be read from
// a browser on another site, so a daily GitHub Action copies the rate into rates/gold.json next to the app
// (tools/update-gold-rate.mjs); fetching it sends nothing about the user.

import { date } from './calendar.js';

export const GOLD_RATE_URL = 'rates/gold.json';
export const GOLD_SOURCE = '5paisa · Hyderabad';
const TIMEOUT_MS = 15_000;

export const KARATS = [
  { karat: 24, label: '24K (99.9%)', hint: 'coins, bars, digital gold' },
  { karat: 22, label: '22K (91.6%)', hint: 'jewellery' },
  { karat: 18, label: '18K (75%)', hint: 'jewellery' },
];
export const DEFAULT_KARAT = 24;
export const karatLabel = (k) => KARATS.find((x) => x.karat === k)?.label ?? `${k}K`;

export class GoldRateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoldRateError';
  }
}

/** Checks rates/gold.json. @returns {{ date: number, perGram: Record<number, number> }} */
export function parseGoldRate(payload) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(payload?.date ?? '');
  const perGram = {};
  for (const { karat } of KARATS) {
    const v = payload?.perGram?.[karat];
    if (Number.isFinite(v) && v > 0) perGram[karat] = v;
  }
  if (!m || !perGram[DEFAULT_KARAT]) throw new GoldRateError('The gold rate file isn’t readable.');
  return { date: date(Number(m[1]), Number(m[2]), Number(m[3])), perGram };
}

/** Rate per gram for a purity, scaled from 24K when the source didn't list it. */
export function rateForKarat(goldRate, karat = DEFAULT_KARAT) {
  if (!goldRate?.perGram) return null;
  return goldRate.perGram[karat] ?? (goldRate.perGram[DEFAULT_KARAT] * karat) / 24;
}

/** Puts the current rate for the holding's purity on an asset or draft, in place. */
export function applyGoldRate(target, goldRate) {
  const rate = rateForKarat(goldRate, target.goldKarat ?? DEFAULT_KARAT);
  if (rate == null) return target;
  target.goldRate = rate;
  target.goldRateDate = goldRate.date;
  return target;
}

export async function fetchGoldRate(fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${GOLD_RATE_URL}?t=${Date.now()}`, { signal: controller.signal, cache: 'no-store' });
  } catch {
    throw new GoldRateError('Couldn’t fetch today’s gold rate. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new GoldRateError(`Couldn’t fetch today’s gold rate (HTTP ${response.status}).`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new GoldRateError('The gold rate file isn’t readable.');
  }
  return parseGoldRate(payload);
}
