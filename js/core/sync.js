import { recompute } from './assets.js';
import { Category, upgradeCategory } from './categories.js';
import { RateSchedule } from './ppf.js';

/**
 * Keeping several devices' copies the same. Each device remembers the data as it was at its last sync (the base),
 * so a sync can tell what changed here, what changed elsewhere, and combine the two field by field:
 * an edit on the phone and a different edit on the laptop both survive, and an asset deleted on one device is
 * deleted on the others (unless it was edited there in the meantime, in which case the edit wins).
 */

/** Bumped when the synced data's shape changes in a way older versions can't read. */
export const SYNC_FORMAT = 1;

export class SyncDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncDataError';
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => [k, sortKeys(value[k])]));
  return value;
}

/** Equal as data: key order and undefined keys don't matter. */
export const same = (a, b) => a === b || JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));

/** One value changed here (`l`), elsewhere (`r`) or both since `b`. */
function pick(b, l, r, preferLocal) {
  if (same(l, r)) return { value: l };
  if (same(l, b)) return { value: r, from: 'remote' };
  if (same(r, b)) return { value: l, from: 'local' };
  return { value: preferLocal ? l : r, from: 'both' };
}

/** Merges lists of records with `id`s. Keeps this device's order, with records new from elsewhere at the end. */
function mergeByID(base, local, remote, mergeItem) {
  const B = new Map(base.map((x) => [x.id, x]));
  const L = new Map(local.map((x) => [x.id, x]));
  const R = new Map(remote.map((x) => [x.id, x]));
  const out = [];
  let mixed = false;
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const b = B.get(id);
    const l = L.get(id);
    const r = R.get(id);
    if (!l) {
      // Deleted here and untouched elsewhere: stays deleted. Added or edited elsewhere: kept.
      if (!(b && same(r, b))) out.push(structuredClone(r));
      if (b) mixed = true;
    } else if (!r) {
      if (!(b && same(l, b))) out.push(l);
      if (b) mixed = true;
    } else {
      const m = mergeItem(b, l, r);
      out.push(m.value);
      mixed ||= m.mixed;
    }
  }
  return { items: out, mixed };
}

const newer = (l, r) => (l.lastUpdated ?? 0) >= (r.lastUpdated ?? 0);

function mergeEntry(b, l, r) {
  const m = pick(b, l, r, true);
  return { value: m.from === 'remote' ? structuredClone(m.value) : m.value, mixed: m.from === 'both' };
}

/** Field by field; where both devices changed the same field, the more recently updated copy wins. */
function mergeAsset(b, l, r) {
  if (!b) return { value: newer(l, r) ? l : structuredClone(r), mixed: false };
  const preferLocal = newer(l, r);
  const out = {};
  const sources = new Set();
  for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
    if (key === 'entries') continue;
    const m = pick(b[key], l[key], r[key], preferLocal);
    if (m.from && key !== 'lastUpdated') sources.add(m.from);
    if (m.value !== undefined) out[key] = m.value;
  }
  const entries = mergeByID(b.entries ?? [], l.entries ?? [], r.entries ?? [], mergeEntry);
  if (!same(entries.items, l.entries ?? [])) sources.add(same(entries.items, r.entries ?? []) ? 'remote' : 'both');
  out.entries = entries.items.sort((x, y) => x.date - y.date);
  // A mix of both devices' edits: values worked out from them (current value, interest) are worked out again.
  return { value: out, mixed: sources.size > 1 || sources.has('both') || entries.mixed };
}

/**
 * @param {{ base: {assets, ppfRates} | null, local: {assets, ppfRates}, remote: {assets, ppfRates} }} copies
 *   `base` is null on a device's first sync: the two copies are then combined, the newer copy of each asset winning.
 * @returns {{ assets: object[], ppfRates: object[] }} what both devices should now hold
 */
export function mergeVaults({ base, local, remote }, now = Date.now()) {
  const remoteRates = remote.ppfRates?.length ? remote.ppfRates : local.ppfRates;
  const rates = base ? pick(base.ppfRates, local.ppfRates, remoteRates, true) : { value: remoteRates, from: 'remote' };
  const ppfRates = structuredClone(rates.value);
  const schedule = RateSchedule.from(ppfRates);
  const { items: assets } = mergeByID(base?.assets ?? [], local.assets, remote.assets, (b, l, r) => {
    const m = mergeAsset(b, l, r);
    if (m.mixed) recompute(m.value, schedule, now);
    return m;
  });
  // Rates changed on both devices: every PPF account is revalued with the combined list.
  if (rates.from === 'both') for (const a of assets) if (a.category === Category.ppf) recompute(a, schedule, now);
  return { assets, ppfRates };
}

/** What's encrypted and stored: the assets and the PPF rate list (settings like the last NAV refresh stay per device). */
export const syncPayload = ({ assets, ppfRates }) => ({ format: SYNC_FORMAT, assets, ppfRates });

/** Checks a decrypted payload. @returns {{ assets, ppfRates }} */
export function readSyncPayload(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.assets)) throw new SyncDataError('The synced copy isn’t readable.');
  if (Number(p.format) > SYNC_FORMAT) throw new SyncDataError('Your synced data was saved by a newer version of WealthTracker. Reload the app to update it, then sync again.');
  const assets = p.assets.filter((a) => a && typeof a === 'object' && typeof a.id === 'string' && typeof a.category === 'string' && typeof a.name === 'string');
  for (const a of assets) {
    upgradeCategory(a);
    a.entries = Array.isArray(a.entries) ? a.entries : [];
  }
  const ppfRates = Array.isArray(p.ppfRates) ? p.ppfRates.filter((r) => Number.isFinite(r?.effectiveFrom) && Number.isFinite(r?.ratePercent)) : [];
  return { assets, ppfRates };
}
