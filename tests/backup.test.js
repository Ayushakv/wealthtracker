import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { date as d } from '../js/core/calendar.js';
import { exportBackup, mergeBackup, parseBackup } from '../js/core/backup.js';
import { OFFICIAL_HISTORY, RateSchedule } from '../js/core/ppf.js';
import { samplePortfolio } from '../js/core/seed.js';

const now = d(2026, 10, 26);

/** Shaped exactly like an export from the iOS app (Swift JSONEncoder, .iso8601, .sortedKeys). */
const swiftBackup = JSON.stringify({
  assets: [
    {
      category: 'Public Provident Fund (PPF)',
      currentValuation: 790000.5,
      entries: [{ amount: 12500, date: '2026-04-02T18:30:00Z', id: '0E2C1C59-6D7B-4C59-9E8E-1F0F2B0C9D11', note: 'Monthly SI' }],
      id: '7C9E6679-7425-40DE-944B-E07FC1F90AE7',
      institution: 'State Bank of India',
      investedAmount: 769840,
      lastUpdated: '2026-10-18T06:12:45Z',
      name: 'PPF – SBI',
      ppfOpeningBalance: 682340,
      ppfOpeningFYStartYear: 2026,
    },
    { category: 'Something New', currentValuation: 1, id: 'aaaaaaaa-0000-0000-0000-000000000000', investedAmount: 1, lastUpdated: '2026-10-18T06:12:45Z', name: 'Unknown', isPayout: 'yes', entries: [] },
  ],
  exportedAt: '2026-10-18T06:12:45Z',
  ppfRates: [{ effectiveFrom: '2020-03-31T18:30:00Z', ratePercent: 7.1 }],
  version: 2,
});

describe('Backup compatibility with the iOS app', () => {
  test('reads an iOS backup', () => {
    const { assets, ppfRates } = parseBackup(swiftBackup);
    const ppf = assets[0];
    assert.equal(ppf.ppfOpeningFYStartYear, 2026);
    assert.equal(ppf.lastUpdated, Date.parse('2026-10-18T06:12:45Z'));
    assert.equal(ppf.entries[0].date, d(2026, 4, 3));
    assert.notEqual(ppf.entries[0].id, '0E2C1C59-6D7B-4C59-9E8E-1F0F2B0C9D11'); // fresh IDs, like the iOS importer
    assert.deepEqual(ppfRates, [{ effectiveFrom: d(2020, 4, 1), ratePercent: 7.1 }]);
  });

  test('sanitises records: unknown category → bank, wrong types dropped, IDs uppercased', () => {
    const [, odd] = parseBackup(swiftBackup).assets;
    assert.equal(odd.category, 'Bank Accounts');
    assert.equal(odd.isPayout, undefined);
    assert.equal(odd.id, 'AAAAAAAA-0000-0000-0000-000000000000');
  });

  test('exports dates without fractional seconds (Swift rejects them) and round-trips', () => {
    const assets = samplePortfolio(RateSchedule.official, now + 123);
    const text = exportBackup({ assets, ppfRates: OFFICIAL_HISTORY }, now + 456);
    assert.doesNotMatch(text, /\.\d{3}Z"/);
    const file = JSON.parse(text);
    assert.equal(file.version, 2);
    assert.deepEqual(Object.keys(file), ['assets', 'exportedAt', 'ppfRates', 'version']);
    assert.ok(!text.includes('null'));

    const back = parseBackup(text);
    assert.equal(back.assets.length, assets.length);
    const ppf = back.assets.find((a) => a.name === 'PPF – SBI');
    assert.equal(ppf.entries.length, assets.find((a) => a.name === 'PPF – SBI').entries.length);
    assert.equal(back.ppfRates.length, OFFICIAL_HISTORY.length);
  });

  test('rejects files from newer versions and non-backups', () => {
    assert.throws(() => parseBackup('{"version":3,"assets":[]}'), /newer version/);
    assert.throws(() => parseBackup('[]'), /isn’t a WealthTracker backup/);
    assert.throws(() => parseBackup('nope'), /not valid JSON/);
    assert.throws(() => parseBackup('{"version":2,"assets":[{"name":"x"}]}'), /missing “id”/);
  });

  test('v1 files without rates keep the local rate history', () => {
    const merged = mergeBackup({ assets: [], ppfRates: OFFICIAL_HISTORY }, parseBackup('{"version":1,"exportedAt":"2025-01-01T00:00:00Z","assets":[]}'));
    assert.equal(merged.ppfRates, OFFICIAL_HISTORY);
  });

  test('merging overwrites matching IDs and adds new ones', () => {
    const existing = { assets: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', name: 'Old' }, { id: 'B', name: 'Keep' }], ppfRates: [] };
    const merged = mergeBackup(existing, parseBackup(swiftBackup));
    assert.deepEqual(merged.assets.map((a) => a.name).sort(), ['Keep', 'PPF – SBI', 'Unknown']);
  });
});
