import { date } from './calendar.js';

const BASE_URL = 'https://api.mfapi.in/mf/';
const TIMEOUT_MS = 15_000;

export class MFAPIError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'MFAPIError';
    this.kind = kind;
  }
}

const errors = {
  invalidSchemeCode: () => new MFAPIError('invalidSchemeCode', 'AMFI scheme codes are numeric (e.g. 118955).'),
  schemeNotFound: (code) => new MFAPIError('schemeNotFound', `No scheme found for AMFI code ${code}.`),
  badResponse: (status) => new MFAPIError('badResponse', `mfapi.in returned HTTP ${status}.`),
  malformedPayload: () => new MFAPIError('malformedPayload', 'Unexpected response from mfapi.in.'),
  network: () => new MFAPIError('network', 'Could not reach mfapi.in. Check your connection.'),
};

export const isValidSchemeCode = (code) => /^\d+$/.test(code);

/** Parses an mfapi.in `/latest` payload. Unknown codes come back as HTTP 200 with an empty `data` array. */
export function parseNAV(payload, code) {
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw errors.malformedPayload();
    }
  }
  if (!payload || !Array.isArray(payload.data) || typeof payload.meta !== 'object' || payload.meta === null) {
    throw errors.malformedPayload();
  }
  const latest = payload.data[0];
  if (!latest) throw errors.schemeNotFound(code);

  const nav = typeof latest.nav === 'string' && latest.nav.trim() !== '' ? Number(latest.nav) : NaN;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(latest.date ?? '');
  if (!Number.isFinite(nav) || !m) throw errors.malformedPayload();

  return {
    schemeCode: code,
    schemeName: String(payload.meta.scheme_name ?? ''),
    fundHouse: String(payload.meta.fund_house ?? ''),
    nav,
    date: date(Number(m[3]), Number(m[2]), Number(m[1])),
  };
}

/** Fetches the latest NAV for an AMFI scheme code. Only the code leaves the device. */
export async function latestNAV(rawCode, fetchImpl = globalThis.fetch) {
  const code = String(rawCode ?? '').trim();
  if (!isValidSchemeCode(code)) throw errors.invalidSchemeCode();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    // `/latest` returns only the most recent NAV instead of the full history. mfapi.in's cache drops
    // the CORS header from cached responses, so a unique query string makes browsers get a fresh one.
    response = await fetchImpl(`${BASE_URL}${code}/latest?t=${Date.now()}`, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  } catch {
    throw errors.network();
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw errors.badResponse(response.status);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw errors.malformedPayload();
  }
  return parseNAV(payload, code);
}

/** Fetches several schemes concurrently. Failures are reported per code rather than aborting the batch. */
export async function latestNAVs(codes, fetchImpl = globalThis.fetch) {
  const unique = [...new Set(codes)];
  const settled = await Promise.allSettled(unique.map((code) => latestNAV(code, fetchImpl)));
  const results = new Map();
  unique.forEach((code, i) => {
    const s = settled[i];
    results.set(code, s.status === 'fulfilled' ? { ok: true, quote: s.value } : { ok: false, error: s.reason instanceof MFAPIError ? s.reason : errors.malformedPayload() });
  });
  return results;
}
