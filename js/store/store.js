import { amfiCodes, recompute } from '../core/assets.js';
import { exportBackup, mergeBackup, parseBackup } from '../core/backup.js';
import { quarterStart } from '../core/calendar.js';
import { Category, upgradeCategory } from '../core/categories.js';
import { applyGoldRate, fetchGoldRate } from '../core/gold.js';
import { latestNAVs } from '../core/mfapi.js';
import { OFFICIAL_HISTORY, RateSchedule } from '../core/ppf.js';
import { mergeVaults, readSyncPayload, same, syncPayload } from '../core/sync.js';
import { decryptJSON, deriveKey, encryptJSON, MIN_PASSCODE_LENGTH, PBKDF2_ITERATIONS, randomBytes } from './crypto.js';
import { clearAll, getMany, openDB, putMany } from './db.js';
import { GitHubGists, MIN_SYNC_PASSPHRASE, readEnvelope, seal, SyncError, toBase64, fromBase64, unseal } from './sync.js';

/** Lock again when the app comes back after being hidden this long. */
export const AUTO_LOCK_MS = 5 * 60 * 1000;
/** Sync this long after the last edit, so a burst of edits goes up together. */
const SYNC_DELAY_MS = 2000;

const officialRates = () => OFFICIAL_HISTORY.map((r) => ({ ...r }));
const emptyVault = () => ({ assets: [], ppfRates: officialRates(), settings: { lastRefresh: null, failures: {} } });

/**
 * Single source of truth for the UI. Holds the decrypted vault in memory while unlocked
 * and writes the whole vault back on every change (it's small).
 *
 * IndexedDB layout (store "kv"):
 *   meta  → { version: 1, encrypted: false } | { version: 1, encrypted: true, salt, iterations }
 *   vault → plain object when not encrypted, { iv, data } when encrypted
 *
 * `settings.sync` (when sync is on) = { token, login, gistId, passphrase, base, lastSync, lastError }; `base` is the
 * data as of the last sync, which the next one merges against (see core/sync.js).
 *
 * Fires a "change" event whenever anything the UI shows changes.
 */
export class Store extends EventTarget {
  /** 'loading' | 'welcome' | 'locked' | 'ready' | 'error' */
  status = 'loading';
  error = null;
  encrypted = false;
  assets = [];
  ppfRates = officialRates();
  settings = { lastRefresh: null, failures: {} };
  isRefreshing = false;
  isSyncing = false;

  #db = null;
  #key = null;
  #meta = null;
  #saving = Promise.resolve();
  #hiddenAt = null;
  #channel = null;
  #iterations;
  #fetch;
  /** { salt, iterations, key } for the sync passphrase, derived once per unlock. */
  #syncKey = null;
  #syncing = null;
  #syncAgain = false;
  #syncTimer = null;

  constructor({ dbName, iterations = PBKDF2_ITERATIONS, fetchImpl } = {}) {
    super();
    this.dbName = dbName;
    this.#iterations = iterations;
    this.#fetch = fetchImpl;
  }

  get rates() {
    return RateSchedule.from(this.ppfRates);
  }

  #emit() {
    this.dispatchEvent(new Event('change'));
  }

  async open() {
    try {
      this.#db = await openDB(this.dbName);
      const { meta } = await getMany(this.#db, ['meta']);
      this.#meta = meta ?? null;
      if (!meta) {
        this.status = 'welcome';
      } else if (meta.encrypted) {
        this.encrypted = true;
        this.status = 'locked';
      } else {
        this.encrypted = false;
        await this.#loadVault();
        this.refresh();
        this.syncNow();
      }
    } catch (e) {
      this.status = 'error';
      this.error = e?.message ?? String(e);
    }
    this.#listenForOtherTabs();
    this.#emit();
  }

  async #loadVault() {
    const { vault } = await getMany(this.#db, ['vault']);
    const v = vault ? (this.encrypted ? await decryptJSON(this.#key, vault) : vault) : emptyVault();
    this.assets = v.assets ?? [];
    // Saved before Bonds and FDs were separate categories; the next save stores the split.
    for (const a of this.assets) upgradeCategory(a);
    this.ppfRates = v.ppfRates?.length ? v.ppfRates : officialRates();
    this.settings = { lastRefresh: null, failures: {}, ...v.settings };
    this.status = 'ready';
  }

  #snapshot() {
    return { assets: this.assets, ppfRates: this.ppfRates, settings: this.settings };
  }

  /** Queues a write of the current state. Writes are serialised so a slow one can't land after a newer one. */
  save() {
    // Capture the key now: the app may lock before the queued write runs.
    const snapshot = structuredClone(this.#snapshot());
    const key = this.encrypted ? this.#key : null;
    this.#saving = this.#saving
      .catch(() => {})
      .then(async () => {
        await putMany(this.#db, { vault: key ? await encryptJSON(key, snapshot) : snapshot });
        this.#channel?.postMessage('saved');
      });
    return this.#saving;
  }

  /** Applies a change, persists it and re-renders. */
  async mutate(fn) {
    const result = fn();
    this.#emit();
    await this.save();
    this.#scheduleSync();
    return result;
  }

  // MARK: - First run, passcode, lock

  async setup(passcode) {
    this.assets = [];
    this.ppfRates = officialRates();
    this.settings = { lastRefresh: null, failures: {} };
    await this.#writeAll(passcode || null);
    this.status = 'ready';
    globalThis.navigator?.storage?.persist?.().catch(() => {});
    this.#emit();
  }

  /** Rewrites meta + vault together under a new passcode (or none). */
  async #writeAll(passcode) {
    await this.#saving.catch(() => {});
    if (passcode) {
      if (passcode.length < MIN_PASSCODE_LENGTH) throw new Error(`Use at least ${MIN_PASSCODE_LENGTH} characters.`);
      const salt = randomBytes(16);
      const key = await deriveKey(passcode, salt, this.#iterations);
      const meta = { version: 1, encrypted: true, salt, iterations: this.#iterations };
      const vault = await encryptJSON(key, this.#snapshot());
      await putMany(this.#db, { meta, vault });
      this.#key = key;
      this.#meta = meta;
      this.encrypted = true;
    } else {
      const meta = { version: 1, encrypted: false };
      await putMany(this.#db, { meta, vault: structuredClone(this.#snapshot()) });
      this.#key = null;
      this.#meta = meta;
      this.encrypted = false;
    }
    this.#channel?.postMessage('rekeyed');
  }

  async #keyFor(passcode) {
    return deriveKey(passcode, this.#meta.salt, this.#meta.iterations ?? PBKDF2_ITERATIONS);
  }

  /** Throws WrongPasscodeError on a bad passcode. */
  async unlock(passcode) {
    const key = await this.#keyFor(passcode);
    const { vault } = await getMany(this.#db, ['vault']);
    if (vault) await decryptJSON(key, vault); // verifies before we commit to the key
    this.#key = key;
    await this.#loadVault();
    this.#emit();
    this.refresh();
    this.syncNow();
  }

  lock() {
    if (!this.encrypted || this.status !== 'ready') return;
    this.#key = null;
    this.#syncKey = null;
    clearTimeout(this.#syncTimer);
    this.assets = [];
    this.settings = { lastRefresh: null, failures: {} };
    this.status = 'locked';
    this.#emit();
  }

  async #verify(currentPasscode) {
    if (!this.encrypted) return;
    const { vault } = await getMany(this.#db, ['vault']);
    await decryptJSON(await this.#keyFor(currentPasscode), vault);
  }

  /** Sets, changes or (with an empty `next`) removes the passcode. */
  async changePasscode(currentPasscode, next) {
    await this.#verify(currentPasscode);
    await this.#writeAll(next || null);
    this.#emit();
  }

  /** Forgotten passcode or "start over": wipes everything on this device. */
  async eraseEverything() {
    await this.#saving.catch(() => {});
    await clearAll(this.#db);
    this.#key = null;
    this.#syncKey = null;
    clearTimeout(this.#syncTimer);
    this.#meta = null;
    this.encrypted = false;
    this.assets = [];
    this.ppfRates = officialRates();
    this.settings = { lastRefresh: null, failures: {} };
    this.status = 'welcome';
    this.#channel?.postMessage('erased');
    this.#emit();
  }

  /** Call from visibilitychange: locks after the app has been in the background too long. */
  noteVisibility(hidden, now = Date.now()) {
    if (hidden) {
      this.#hiddenAt = now;
    } else if (this.#hiddenAt != null) {
      if (now - this.#hiddenAt >= AUTO_LOCK_MS) this.lock();
      this.#hiddenAt = null;
    }
  }

  /** Keeps several open tabs consistent: reload when another tab saves or changes the passcode. */
  #listenForOtherTabs() {
    if (!globalThis.BroadcastChannel || this.#channel) return;
    this.#channel = new BroadcastChannel(`wt-${this.dbName ?? 'default'}`);
    this.#channel.onmessage = async ({ data }) => {
      try {
        if (data === 'erased' || data === 'rekeyed') {
          this.#key = null;
          await this.open();
        } else if (data === 'saved' && this.status === 'ready') {
          await this.#loadVault();
          this.#emit();
        }
      } catch {
        this.lock();
      }
    };
  }

  // MARK: - Assets

  asset(id) {
    return this.assets.find((a) => a.id === id) ?? null;
  }

  async upsert(asset) {
    await this.upsertMany([asset]);
    return asset;
  }

  /** Adds or replaces assets in one save. */
  upsertMany(assets) {
    return this.mutate(() => {
      for (const asset of assets) {
        const i = this.assets.findIndex((a) => a.id === asset.id);
        if (i >= 0) this.assets[i] = asset;
        else this.assets.push(asset);
      }
    });
  }

  deleteAsset(id) {
    return this.mutate(() => {
      this.assets = this.assets.filter((a) => a.id !== id);
    });
  }

  /** Adds or replaces some assets and removes others in one save (a statement import). */
  updateAssets(upserts, removeIDs = []) {
    const gone = new Set(removeIDs);
    return this.mutate(() => {
      this.assets = this.assets.filter((a) => !gone.has(a.id));
      for (const asset of upserts) {
        const i = this.assets.findIndex((a) => a.id === asset.id);
        if (i >= 0) this.assets[i] = asset;
        else this.assets.push(asset);
      }
    });
  }

  addEntry(id, entry) {
    return this.mutate(() => {
      const a = this.asset(id);
      a.entries = [...(a.entries ?? []), entry];
      recompute(a, this.rates);
    });
  }

  deleteEntry(id, entryID) {
    return this.mutate(() => {
      const a = this.asset(id);
      a.entries = a.entries.filter((e) => e.id !== entryID);
      recompute(a, this.rates);
    });
  }

  deleteAllAssets() {
    return this.mutate(() => {
      this.assets = [];
      this.settings.failures = {};
    });
  }

  // MARK: - PPF rates

  #revalueAllPPF() {
    const rates = this.rates;
    for (const a of this.assets) if (a.category === Category.ppf) recompute(a, rates);
  }

  /** Adds or replaces the rate for the quarter containing `date`, then revalues every PPF account. */
  setRate(ratePercent, date) {
    return this.mutate(() => {
      const start = quarterStart(date);
      this.ppfRates = [...this.ppfRates.filter((r) => r.effectiveFrom !== start), { effectiveFrom: start, ratePercent }].sort((a, b) => a.effectiveFrom - b.effectiveFrom);
      this.#revalueAllPPF();
    });
  }

  deleteRate(effectiveFrom) {
    return this.mutate(() => {
      this.ppfRates = this.ppfRates.filter((r) => r.effectiveFrom !== effectiveFrom);
      this.#revalueAllPPF();
    });
  }

  restoreOfficialRates() {
    return this.mutate(() => {
      this.ppfRates = officialRates();
      this.#revalueAllPPF();
    });
  }

  // MARK: - Refresh (port of PortfolioRefresher)

  /** Pulls fresh NAVs and the gold rate, and recomputes rule-based valuations (PPF, FDs/bonds, gold). */
  async refresh(fetchImpl = this.#fetch) {
    if (this.isRefreshing || this.status !== 'ready') return;
    this.isRefreshing = true;
    this.#emit();
    try {
      const codes = amfiCodes(this.assets);
      const hasGold = this.assets.some((a) => a.category === Category.gold);
      const [results, gold] = await Promise.all([
        codes.length ? latestNAVs(codes, fetchImpl) : new Map(),
        hasGold ? fetchGoldRate(fetchImpl).then((rate) => ({ rate }), (error) => ({ error })) : null,
      ]);
      if (this.status !== 'ready') return; // locked while waiting on the network
      const failures = {};
      if (gold?.rate) this.settings.goldRate = gold.rate;
      else if (gold) failures.gold = gold.error.message;
      const rates = this.rates;
      for (const a of this.assets) {
        if (a.category === Category.gold) applyGoldRate(a, this.settings.goldRate);
        const r = a.category === Category.mutualFund && a.amfiCode ? results.get(a.amfiCode) : null;
        if (r?.ok) {
          a.latestNAV = r.quote.nav;
          a.navDate = r.quote.date;
        } else if (r) {
          failures[a.amfiCode] = r.error.message;
        }
        recompute(a, rates);
      }
      this.settings.failures = failures;
      this.settings.lastRefresh = Date.now();
      await this.save();
    } finally {
      this.isRefreshing = false;
      this.#emit();
    }
  }

  // MARK: - Backup

  exportBackup() {
    return exportBackup({ assets: this.assets, ppfRates: this.ppfRates });
  }

  /** Merges by asset ID. Throws BackupError with a user-facing message. @returns number of assets imported */
  async importBackup(text) {
    const parsed = parseBackup(text);
    await this.mutate(() => {
      const merged = mergeBackup({ assets: this.assets, ppfRates: this.ppfRates }, parsed);
      this.assets = merged.assets;
      this.ppfRates = merged.ppfRates;
    });
    this.refresh();
    return parsed.assets.length;
  }

  // MARK: - Sync (encrypted copy in a secret GitHub gist)

  get syncOn() {
    return !!this.settings.sync?.token;
  }

  #gists(token) {
    return new GitHubGists(token, this.#fetch);
  }

  /**
   * First step of turning sync on: checks the token and looks for data synced from another device.
   * @returns {{ token, login, gistId, envelope }} for connectSync
   */
  async probeSync(token) {
    if (!token?.trim()) throw new SyncError('Paste the access token from GitHub.', 'auth');
    const gists = this.#gists(token);
    const login = await gists.login();
    const gistId = await gists.find();
    const envelope = gistId ? readEnvelope(await gists.read(gistId)) : null;
    return { token: gists.token, login, gistId, envelope };
  }

  /**
   * Turns sync on with the passphrase: decrypts what's already synced (throwing SyncError 'passphrase' if it's the
   * wrong one) and combines it with this device's data, or, with `replace`, swaps this device's data for it.
   * @returns the number of assets now on this device
   */
  async connectSync(probe, passphrase, { replace = false } = {}) {
    if ((passphrase ?? '').length < MIN_SYNC_PASSPHRASE) throw new SyncError(`Use at least ${MIN_SYNC_PASSPHRASE} characters.`, 'passphrase');
    await this.#syncing?.catch(() => {});
    let remote = null;
    if (probe.envelope) {
      const { salt, iterations } = probe.envelope;
      const key = await deriveKey(passphrase, fromBase64(salt), iterations);
      remote = readSyncPayload(await unseal(key, probe.envelope));
      this.#syncKey = { salt, iterations, key };
    } else {
      const salt = toBase64(randomBytes(16));
      this.#syncKey = { salt, iterations: this.#iterations, key: await deriveKey(passphrase, fromBase64(salt), this.#iterations) };
    }
    const before = { assets: this.assets, ppfRates: this.ppfRates, sync: this.settings.sync };
    this.settings.sync = { token: probe.token, login: probe.login, gistId: probe.gistId, passphrase, base: null, lastSync: null, lastError: null };
    if (remote && (replace || !this.assets.length)) {
      this.assets = remote.assets;
      this.ppfRates = remote.ppfRates.length ? remote.ppfRates : this.ppfRates;
      this.settings.sync.base = structuredClone(syncPayload(remote));
    }
    try {
      await this.#syncOnce(remote && probe.envelope);
    } catch (e) {
      Object.assign(this, { assets: before.assets, ppfRates: before.ppfRates });
      this.settings.sync = before.sync;
      this.#syncKey = null;
      this.#emit();
      await this.save();
      throw e;
    }
    this.refresh();
    return this.assets.length;
  }

  /** Stops syncing on this device. The encrypted copy stays on GitHub for the others. */
  async disconnectSync() {
    clearTimeout(this.#syncTimer);
    await this.#syncing?.catch(() => {});
    delete this.settings.sync;
    this.#syncKey = null;
    this.#emit();
    await this.save();
  }

  #scheduleSync() {
    if (!this.syncOn) return;
    clearTimeout(this.#syncTimer);
    this.#syncTimer = setTimeout(() => this.syncNow(), SYNC_DELAY_MS);
    this.#syncTimer.unref?.();
  }

  /** Pulls, merges and pushes. Problems are kept in `settings.sync.lastError` (and thrown when `throws`). */
  syncNow({ throws = false } = {}) {
    if (!this.syncOn || this.status !== 'ready') return Promise.resolve();
    clearTimeout(this.#syncTimer);
    if (this.#syncing) {
      this.#syncAgain = true;
      return throws ? this.#syncing : this.#syncing.catch(() => {});
    }
    this.isSyncing = true;
    this.#emit();
    this.#syncing = (async () => {
      try {
        do {
          this.#syncAgain = false;
          await this.#syncOnce();
        } while (this.#syncAgain && this.syncOn && this.status === 'ready');
      } catch (e) {
        if (this.settings.sync) {
          this.settings.sync.lastError = e?.message ?? String(e);
          await this.save().catch(() => {});
        }
        throw e;
      } finally {
        this.isSyncing = false;
        this.#syncing = null;
        this.#emit();
      }
    })();
    return throws ? this.#syncing : this.#syncing.catch(() => {});
  }

  async #sealingKey(envelope) {
    const { passphrase } = this.settings.sync;
    const salt = envelope?.salt ?? this.#syncKey?.salt ?? toBase64(randomBytes(16));
    const iterations = envelope?.iterations ?? this.#syncKey?.iterations ?? this.#iterations;
    if (this.#syncKey?.salt !== salt || this.#syncKey.iterations !== iterations) {
      this.#syncKey = { salt, iterations, key: await deriveKey(passphrase, fromBase64(salt), iterations) };
    }
    return this.#syncKey;
  }

  /** @param {object} [envelope] the gist's contents, when already fetched */
  async #syncOnce(envelope) {
    const s = this.settings.sync;
    const gists = this.#gists(s.token);
    let gistId = s.gistId;
    if (!envelope && gistId) {
      try {
        envelope = readEnvelope(await gists.read(gistId));
      } catch (e) {
        if (e.kind !== 'notFound') throw e;
        gistId = null; // deleted on GitHub: start a new one from this device's data
      }
    }
    const sealing = await this.#sealingKey(envelope);
    const remote = envelope ? readSyncPayload(await unseal(sealing.key, envelope)) : null;
    // Locked, erased or sync turned off while waiting on the network.
    if (this.status !== 'ready' || this.settings.sync?.token !== s.token) return;
    const cur = this.settings.sync;

    const local = { assets: this.assets, ppfRates: this.ppfRates };
    const merged = remote ? mergeVaults({ base: cur.base, local, remote }) : structuredClone(local);
    if (!same(merged, local)) {
      this.assets = merged.assets;
      this.ppfRates = merged.ppfRates;
      this.#emit();
      await this.save();
    }
    if (!remote || !same(syncPayload(merged), syncPayload(remote))) {
      const text = await seal(sealing.key, sealing, syncPayload(merged));
      if (gistId) await gists.write(gistId, text);
      else gistId = await gists.create(text);
    }
    if (this.settings.sync?.token !== s.token) return;
    Object.assign(this.settings.sync, { gistId, base: structuredClone(syncPayload(merged)), lastSync: Date.now(), lastError: null });
    await this.save();
  }
}
