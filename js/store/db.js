// Minimal IndexedDB key-value wrapper. Everything lives in one object store so a save is one transaction.

const DB_NAME = 'wealthtracker';
const STORE = 'kv';

const promisify = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });

export async function openDB(name = DB_NAME) {
  const request = indexedDB.open(name, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  const db = await promisify(request);
  // Another tab upgrading the schema: step aside rather than block it.
  db.onversionchange = () => db.close();
  return db;
}

/** @returns {Promise<Record<string, any>>} values for `keys`; missing keys are undefined */
export async function getMany(db, keys) {
  const tx = db.transaction(STORE, 'readonly');
  const store = tx.objectStore(STORE);
  const values = await Promise.all(keys.map((k) => promisify(store.get(k))));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

/** Writes every entry in one transaction: either all land or none do. */
export async function putMany(db, entries) {
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const [key, value] of Object.entries(entries)) store.put(value, key);
  await done(tx);
}

export async function clearAll(db) {
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
}
