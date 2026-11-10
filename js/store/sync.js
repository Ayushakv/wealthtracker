// Encrypted sync through a secret gist in the user's own GitHub account. The gist holds one file: the data encrypted
// with a key derived from the sync passphrase (PBKDF2-SHA256 → AES-GCM-256), so GitHub only ever sees ciphertext.

import { decryptJSON, encryptJSON, WrongPasscodeError } from './crypto.js';

const API = 'https://api.github.com';
export const SYNC_FILE = 'wealthtracker-sync.json';
const DESCRIPTION = 'WealthTracker sync (encrypted; readable only with your sync passphrase)';
export const MIN_SYNC_PASSPHRASE = 8;
/** A classic token with only the "gist" scope ticked. */
export const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=WealthTracker%20sync';

export class SyncError extends Error {
  /** @param {'offline'|'auth'|'scope'|'rateLimit'|'notFound'|'passphrase'|'format'|'server'} kind */
  constructor(message, kind) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
  }
}

export function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** @returns the gist file's text */
export async function seal(key, { salt, iterations }, payload) {
  const { iv, data } = await encryptJSON(key, payload);
  return JSON.stringify({ app: 'WealthTracker', format: 1, kdf: { name: 'PBKDF2-SHA256', iterations, salt }, cipher: 'AES-GCM-256', iv: toBase64(iv), data: toBase64(data) });
}

/** @returns {{ salt: string, iterations: number, iv: Uint8Array, data: Uint8Array }} */
export function readEnvelope(text) {
  let e;
  try {
    e = JSON.parse(text);
  } catch {
    e = null;
  }
  if (e?.app !== 'WealthTracker' || typeof e.kdf?.salt !== 'string' || !Number.isInteger(e.kdf.iterations) || typeof e.iv !== 'string' || typeof e.data !== 'string') {
    throw new SyncError('The sync gist on GitHub isn’t in a format this app can read.', 'format');
  }
  return { salt: e.kdf.salt, iterations: e.kdf.iterations, iv: fromBase64(e.iv), data: fromBase64(e.data) };
}

export async function unseal(key, envelope) {
  try {
    return await decryptJSON(key, envelope);
  } catch (e) {
    if (e instanceof WrongPasscodeError) throw new SyncError('That’s not the sync passphrase your data was saved with.', 'passphrase');
    throw e;
  }
}

/** The few GitHub REST calls sync needs. `fetchImpl` is swappable for tests. */
export class GitHubGists {
  constructor(token, fetchImpl = (...args) => globalThis.fetch(...args)) {
    this.token = token.trim();
    this.fetch = fetchImpl;
  }

  async #call(method, path, body) {
    let res;
    try {
      res = await this.fetch(`${API}${path}`, {
        method,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new SyncError('Couldn’t reach GitHub. Check your connection and try again.', 'offline');
    }
    if (res.ok) return res.json();
    if (res.status === 401) throw new SyncError('GitHub didn’t accept the access token. It may have expired or been revoked. Set up sync again with a new token.', 'auth');
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new SyncError('GitHub is limiting requests for a while. Sync will try again later.', 'rateLimit');
    }
    if (res.status === 403) throw new SyncError('The access token isn’t allowed to manage gists. Create one with the “gist” box ticked.', 'scope');
    if (res.status === 404) throw new SyncError('Not found on GitHub.', 'notFound');
    throw new SyncError(`GitHub had a problem (${res.status}). Try again in a moment.`, 'server');
  }

  /** @returns the account's username; also checks the token works */
  async login() {
    return (await this.#call('GET', '/user')).login;
  }

  /** The gist sync made earlier, from any device. @returns its id or null */
  async find() {
    for (let page = 1; page <= 10; page++) {
      const gists = await this.#call('GET', `/gists?per_page=100&page=${page}`);
      const found = gists.find((g) => g.files?.[SYNC_FILE]);
      if (found) return found.id;
      if (gists.length < 100) break;
    }
    return null;
  }

  /** @returns the sync file's text */
  async read(id) {
    const gist = await this.#call('GET', `/gists/${encodeURIComponent(id)}`);
    const file = gist.files?.[SYNC_FILE];
    if (!file) throw new SyncError('Not found on GitHub.', 'notFound');
    if (!file.truncated) return file.content;
    try {
      return await (await this.fetch(file.raw_url, { cache: 'no-store' })).text();
    } catch {
      throw new SyncError('Couldn’t reach GitHub. Check your connection and try again.', 'offline');
    }
  }

  /** @returns the new gist's id */
  async create(text) {
    return (await this.#call('POST', '/gists', { description: DESCRIPTION, public: false, files: { [SYNC_FILE]: { content: text } } })).id;
  }

  async write(id, text) {
    await this.#call('PATCH', `/gists/${encodeURIComponent(id)}`, { files: { [SYNC_FILE]: { content: text } } });
  }
}
