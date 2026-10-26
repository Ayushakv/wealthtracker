import { FIELD_TYPES, REQUIRED_FIELDS, newID } from './assets.js';
import { toInputValue } from './calendar.js';
import { Category, isKnownCategory } from './categories.js';

/**
 * Versioned, plain-JSON snapshot in the same format as the iOS app's BackupFile.
 * v2 added `ppfRates`; v1 files still import. The file is unencrypted.
 */
export const BACKUP_VERSION = 2;

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

/** Swift's `.iso8601` strategy rejects fractional seconds, so drop them. */
const isoDate = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

function parseDate(v) {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

/** Keys sorted like Swift's `.sortedKeys`, so exports from either app diff cleanly. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

function encodeAsset(a) {
  const out = {};
  for (const [key, type] of Object.entries(FIELD_TYPES)) {
    const v = a[key];
    if (v == null) continue;
    out[key] = type === 'date' ? isoDate(v) : v;
  }
  out.entries = (a.entries ?? []).map((e) => ({ id: e.id, date: isoDate(e.date), amount: e.amount, ...(e.note ? { note: e.note } : {}) }));
  return out;
}

/** @returns pretty-printed JSON text */
export function exportBackup({ assets, ppfRates }, now = Date.now()) {
  const file = {
    version: BACKUP_VERSION,
    exportedAt: isoDate(now),
    assets: assets.map(encodeAsset),
    ppfRates: ppfRates.map((r) => ({ effectiveFrom: isoDate(r.effectiveFrom), ratePercent: r.ratePercent })),
  };
  return JSON.stringify(sortKeys(file), null, 2);
}

function decodeField(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? value : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'int':
      return Number.isInteger(value) ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'date':
      return parseDate(value);
  }
}

/** Whitelists and type-checks one record; unknown keys are dropped. */
function decodeAsset(record, index) {
  if (!record || typeof record !== 'object') throw new BackupError(`Asset ${index + 1} is not an object.`);
  const a = {};
  for (const [key, type] of Object.entries(FIELD_TYPES)) {
    const v = decodeField(record[key], type);
    if (v !== undefined) a[key] = v;
  }
  for (const key of REQUIRED_FIELDS) {
    if (a[key] === undefined) throw new BackupError(`Asset ${index + 1} is missing “${key}”.`);
  }
  a.id = a.id.toUpperCase();
  if (!isKnownCategory(a.category)) a.category = Category.bank;
  const entries = Array.isArray(record.entries) ? record.entries : [];
  a.entries = entries
    .map((e) => ({ date: parseDate(e?.date), amount: decodeField(e?.amount, 'number'), note: decodeField(e?.note, 'string') }))
    .filter((e) => e.date !== undefined && e.amount !== undefined)
    .map((e) => ({ id: newID(), date: e.date, amount: e.amount, ...(e.note ? { note: e.note } : {}) }));
  return a;
}

/**
 * Parses and validates a backup file.
 * @returns {{ assets: object[], ppfRates: {effectiveFrom:number, ratePercent:number}[] | null }}
 */
export function parseBackup(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new BackupError('This file isn’t a WealthTracker backup (not valid JSON).');
  }
  if (!file || typeof file !== 'object' || !Number.isInteger(file.version) || !Array.isArray(file.assets)) {
    throw new BackupError('This file isn’t a WealthTracker backup.');
  }
  if (file.version > BACKUP_VERSION) {
    throw new BackupError(`This backup (version ${file.version}) was made by a newer version of the app.`);
  }
  const assets = file.assets.map(decodeAsset);
  let ppfRates = null;
  if (Array.isArray(file.ppfRates)) {
    ppfRates = file.ppfRates
      .map((r) => ({ effectiveFrom: parseDate(r?.effectiveFrom), ratePercent: decodeField(r?.ratePercent, 'number') }))
      .filter((r) => r.effectiveFrom !== undefined && r.ratePercent !== undefined);
  }
  return { assets, ppfRates };
}

/**
 * Merges a parsed backup into existing data: assets with a matching ID are overwritten, new ones are added.
 * A non-empty rate history in the backup replaces the local one.
 */
export function mergeBackup(existing, parsed) {
  const byID = new Map(existing.assets.map((a) => [a.id.toUpperCase(), a]));
  for (const a of parsed.assets) byID.set(a.id, a);
  return {
    assets: [...byID.values()],
    ppfRates: parsed.ppfRates?.length ? parsed.ppfRates : existing.ppfRates,
  };
}

export function suggestedFilename(now = Date.now()) {
  return `WealthTracker-Backup-${toInputValue(now)}.json`;
}
