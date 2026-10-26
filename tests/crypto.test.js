import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decryptJSON, deriveKey, encryptJSON, randomBytes, WrongPasscodeError } from '../js/store/crypto.js';

const ITER = 1_000; // the real 600k is slow by design

describe('Passcode encryption', () => {
  test('round-trips with the right passcode', async () => {
    const salt = randomBytes(16);
    const key = await deriveKey('correct horse', salt, ITER);
    const box = await encryptJSON(key, { assets: [{ name: 'PPF', currentValuation: 1e6 }] });
    assert.ok(!new TextDecoder().decode(box.data).includes('PPF'));
    assert.deepEqual(await decryptJSON(await deriveKey('correct horse', salt, ITER), box), { assets: [{ name: 'PPF', currentValuation: 1e6 }] });
  });

  test('rejects a wrong passcode or a different salt', async () => {
    const salt = randomBytes(16);
    const box = await encryptJSON(await deriveKey('123456', salt, ITER), [1]);
    await assert.rejects(decryptJSON(await deriveKey('123457', salt, ITER), box), WrongPasscodeError);
    await assert.rejects(decryptJSON(await deriveKey('123456', randomBytes(16), ITER), box), WrongPasscodeError);
  });

  test('every save uses a fresh IV', async () => {
    const key = await deriveKey('123456', randomBytes(16), ITER);
    const [a, b] = await Promise.all([encryptJSON(key, 1), encryptJSON(key, 1)]);
    assert.notDeepEqual(a.iv, b.iv);
  });

  test('the key cannot be exported', async () => {
    const key = await deriveKey('123456', randomBytes(16), ITER);
    assert.equal(key.extractable, false);
    await assert.rejects(globalThis.crypto.subtle.exportKey('raw', key));
  });
});
