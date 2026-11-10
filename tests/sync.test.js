import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAsset, createEntry } from '../js/core/assets.js';
import { date } from '../js/core/calendar.js';
import { Category, LEGACY_BONDS_AND_FDS } from '../js/core/categories.js';
import { OFFICIAL_HISTORY } from '../js/core/ppf.js';
import { mergeVaults, readSyncPayload, SYNC_FORMAT } from '../js/core/sync.js';
import { deriveKey, randomBytes } from '../js/store/crypto.js';
import { fromBase64, GitHubGists, readEnvelope, seal, SyncError, toBase64, unseal } from '../js/store/sync.js';
import { fakeGitHub } from './fakeGitHub.js';

const now = date(2026, 11, 10);
const rates = OFFICIAL_HISTORY.map((r) => ({ ...r }));
const bank = (fields) => createAsset({ category: Category.bank, name: 'Savings', currentValuation: 1000, investedAmount: 1000, ...fields }, date(2026, 11, 1));
const copy = (x) => structuredClone(x);
const vault = (assets, ppfRates = rates) => ({ assets, ppfRates });

describe('Merging two devices’ copies', () => {
  test('different edits to the same asset on two devices both survive', () => {
    const a = bank({ id: 'A' });
    const base = vault([a]);
    const local = vault([{ ...copy(a), notes: 'joint account', lastUpdated: date(2026, 11, 5) }]);
    const remote = vault([{ ...copy(a), currentValuation: 5000, investedAmount: 5000, lastUpdated: date(2026, 11, 6) }]);
    const [m] = mergeVaults({ base, local, remote }, now).assets;
    assert.equal(m.notes, 'joint account');
    assert.equal(m.currentValuation, 5000);
  });

  test('the same field edited on both: the more recently updated copy wins', () => {
    const a = bank({ id: 'A' });
    const local = vault([{ ...copy(a), name: 'Older', lastUpdated: date(2026, 11, 5) }]);
    const remote = vault([{ ...copy(a), name: 'Newer', lastUpdated: date(2026, 11, 6) }]);
    assert.equal(mergeVaults({ base: vault([a]), local, remote }, now).assets[0].name, 'Newer');
    assert.equal(mergeVaults({ base: vault([a]), local: remote, remote: local }, now).assets[0].name, 'Newer');
  });

  test('assets added on either device are kept; deletions carry across unless the other device edited it', () => {
    const [a, b, c] = [bank({ id: 'A' }), bank({ id: 'B' }), bank({ id: 'C' })];
    const base = vault([a, b, c]);
    const local = vault([copy(a), { ...copy(c), notes: 'edited here' }, bank({ id: 'L' })]); // deleted B here
    const remote = vault([copy(b), bank({ id: 'R' })]); // deleted A and C elsewhere
    const ids = mergeVaults({ base, local, remote }, now).assets.map((x) => x.id);
    assert.deepEqual(ids, ['C', 'L', 'R']);
  });

  test('PPF deposits added on each device are combined, and the account revalued', () => {
    const ppf = createAsset({ id: 'P', category: Category.ppf, name: 'PPF', ppfOpeningBalance: 100000, ppfOpeningFYStartYear: 2026, entries: [createEntry(date(2026, 4, 3), 10000)] }, date(2026, 11, 1));
    const local = copy(ppf);
    local.entries.push(createEntry(date(2026, 5, 3), 20000));
    const remote = copy(ppf);
    remote.entries.push(createEntry(date(2026, 6, 3), 30000));
    remote.entries.shift(); // and the first deposit removed elsewhere
    const [m] = mergeVaults({ base: vault([ppf]), local: vault([local]), remote: vault([remote]) }, now).assets;
    assert.deepEqual(m.entries.map((e) => e.amount), [20000, 30000]);
    assert.equal(m.investedAmount, 150000);
    assert.equal(m.lastUpdated, now, 'revalued');
  });

  test('a device’s first sync combines both copies, keeping the newer of any asset both have', () => {
    const a = bank({ id: 'A' });
    const local = vault([{ ...copy(a), name: 'Stale', lastUpdated: date(2026, 1, 1) }, bank({ id: 'L' })], rates.slice(0, 3));
    const remote = vault([{ ...copy(a), name: 'Fresh', lastUpdated: date(2026, 11, 1) }, bank({ id: 'R' })]);
    const m = mergeVaults({ base: null, local, remote }, now);
    assert.deepEqual(m.assets.map((x) => [x.id, x.name]), [['A', 'Fresh'], ['L', 'Savings'], ['R', 'Savings']]);
    assert.equal(m.ppfRates.length, rates.length, 'the synced rate list');
  });

  test('nothing changed anywhere: the merge is the same data', () => {
    const v = vault([bank({ id: 'A' }), bank({ id: 'B' })]);
    assert.deepEqual(mergeVaults({ base: copy(v), local: copy(v), remote: copy(v) }, now), v);
  });

  test('synced data is checked: newer formats refused, broken records dropped, old categories upgraded', () => {
    assert.throws(() => readSyncPayload({ format: SYNC_FORMAT + 1, assets: [] }), /newer version/);
    assert.throws(() => readSyncPayload({ format: 1 }), /isn’t readable/);
    const { assets, ppfRates } = readSyncPayload({ format: 1, assets: [{ id: 'X', name: 'FD', category: LEGACY_BONDS_AND_FDS }, { name: 'no id' }, null], ppfRates: [{ effectiveFrom: 'x' }] });
    assert.deepEqual(assets.map((a) => [a.id, a.category, a.entries]), [['X', Category.fd, []]]);
    assert.deepEqual(ppfRates, []);
  });
});

describe('Encrypted gist', () => {
  const ITER = 1_000;

  test('only ciphertext leaves the device, and the wrong passphrase is told apart', async () => {
    const salt = toBase64(randomBytes(16));
    const key = await deriveKey('a sync passphrase', fromBase64(salt), ITER);
    const text = await seal(key, { salt, iterations: ITER }, { format: 1, assets: [{ name: 'Example Holdings' }] });
    assert.ok(!text.includes('Example'));
    const envelope = readEnvelope(text);
    assert.deepEqual(await unseal(await deriveKey('a sync passphrase', fromBase64(envelope.salt), envelope.iterations), envelope), { format: 1, assets: [{ name: 'Example Holdings' }] });
    await assert.rejects(unseal(await deriveKey('another passphrase', fromBase64(salt), ITER), envelope), (e) => e instanceof SyncError && e.kind === 'passphrase');
    assert.throws(() => readEnvelope('{"files":1}'), (e) => e.kind === 'format');
  });

  test('base64 survives large payloads', () => {
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 256);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  });

  test('the gist is created once, then found and updated from any device', async () => {
    const gh = fakeGitHub();
    const gists = new GitHubGists(' ghp_test\n', gh.fetch);
    assert.equal(await gists.login(), 'example-user');
    assert.equal(await gists.find(), null);
    const id = await gists.create('one');
    assert.equal(await new GitHubGists('ghp_test', gh.fetch).find(), id);
    await gists.write(id, 'two');
    assert.equal(await gists.read(id), 'two');
    assert.equal(gh.gists.size, 1);
    await assert.rejects(gists.read('missing'), (e) => e.kind === 'notFound');
    await assert.rejects(new GitHubGists('ghp_wrong', gh.fetch).login(), (e) => e.kind === 'auth' && /access token/.test(e.message));
    await assert.rejects(new GitHubGists('t', () => Promise.reject(new TypeError('offline'))).login(), (e) => e.kind === 'offline');
  });
});
