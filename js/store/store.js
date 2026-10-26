import { amfiCodes, recompute } from '../core/assets.js';
import { exportBackup, mergeBackup, parseBackup } from '../core/backup.js';
import { quarterStart } from '../core/calendar.js';
import { Category } from '../core/categories.js';
import { latestNAVs } from '../core/mfapi.js';
import { OFFICIAL_HISTORY, RateSchedule } from '../core/ppf.js';
import { samplePortfolio } from '../core/seed.js';
import { decryptJSON, deriveKey, encryptJSON, MIN_PASSCODE_LENGTH, PBKDF2_ITERATIONS, randomBytes } from './crypto.js';
import { clearAll, getMany, openDB, putMany } from './db.js';

/** Lock again when the app comes back after being hidden this long. */
export const AUTO_LOCK_MS = 5 * 60 * 1000;

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

  #db = null;
  #key = null;
  #meta = null;
  #saving = Promise.resolve();
  #hiddenAt = null;
  #channel = null;
  #iterations;

  constructor({ dbName, iterations = PBKDF2_ITERATIONS } = {}) {
    super();
    this.dbName = dbName;
    this.#iterations = iterations;
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
  }

  lock() {
    if (!this.encrypted || this.status !== 'ready') return;
    this.#key = null;
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

  upsert(asset) {
    return this.mutate(() => {
      const i = this.assets.findIndex((a) => a.id === asset.id);
      if (i >= 0) this.assets[i] = asset;
      else this.assets.push(asset);
      return asset;
    });
  }

  deleteAsset(id) {
    return this.mutate(() => {
      this.assets = this.assets.filter((a) => a.id !== id);
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

  async loadSample() {
    await this.mutate(() => {
      this.assets.push(...samplePortfolio(this.rates));
    });
    await this.refresh();
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

  /** Pulls fresh NAVs and recomputes rule-based valuations (PPF, FDs/bonds). */
  async refresh(fetchImpl) {
    if (this.isRefreshing || this.status !== 'ready') return;
    this.isRefreshing = true;
    this.#emit();
    try {
      const codes = amfiCodes(this.assets);
      const results = codes.length ? await latestNAVs(codes, fetchImpl) : new Map();
      if (this.status !== 'ready') return; // locked while waiting on the network
      const failures = {};
      const rates = this.rates;
      for (const a of this.assets) {
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
}
