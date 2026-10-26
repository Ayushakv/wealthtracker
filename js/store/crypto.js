// Passcode encryption with WebCrypto: PBKDF2-SHA256 → AES-GCM-256.
// The derived key is non-extractable and only ever held in memory while the app is unlocked.

export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSCODE_LENGTH = 6;

const subtle = () => globalThis.crypto.subtle;

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export async function deriveKey(passcode, salt, iterations = PBKDF2_ITERATIONS) {
  const material = await subtle().importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** @returns {{ iv: Uint8Array, data: ArrayBuffer }} */
export async function encryptJSON(key, value) {
  const iv = randomBytes(12);
  const data = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { iv, data };
}

export class WrongPasscodeError extends Error {
  constructor() {
    super('Wrong passcode.');
    this.name = 'WrongPasscodeError';
  }
}

/** Throws WrongPasscodeError when the key doesn't match (GCM authentication fails). */
export async function decryptJSON(key, { iv, data }) {
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv }, key, data);
  } catch {
    throw new WrongPasscodeError();
  }
  return JSON.parse(new TextDecoder().decode(plain));
}
