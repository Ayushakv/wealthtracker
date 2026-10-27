import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { linesFromItems, pdfLines, PDFPasswordError } from '../js/ui/pdf.js';
import { parseCAS } from '../js/core/cas.js';

const fixture = async () => (await readFile(new URL('./fixtures/sample-cas.pdf', import.meta.url))).buffer;

test('a password-protected CAS PDF is read and parsed', async () => {
  const data = await fixture();
  await assert.rejects(pdfLines(data), (e) => e instanceof PDFPasswordError && !e.incorrect);
  await assert.rejects(pdfLines(data, 'abcde1234f'), (e) => e instanceof PDFPasswordError && e.incorrect);

  const { holdings } = parseCAS(await pdfLines(data, 'ABCDE1234F'));
  assert.deepEqual(
    holdings.map((h) => [h.folio, h.isin, h.units]),
    [
      ['12345678/90', 'INF179K01UT0', 112.345],
      ['9876543', 'INF879O01027', 1226.388],
      ['4040404040', 'INF204K01K15', 0],
      ['55555', 'INF000X01234', 10],
    ],
  );
});

test('text items on one baseline become a line; wide gaps become tabs', () => {
  const item = (str, x, y, width) => ({ str, transform: [9, 0, 0, 9, x, y], width, height: 9 });
  const lines = linesFromItems([
    item('NAV on 26-Oct-2026:', 200, 700.5, 80),
    item('Closing Unit Balance:', 20, 700, 90),
    item('112.345', 112, 700, 30),
    item('INR 89.30', 282, 700.2, 40),
    item('Market Value', 20, 688, 50),
  ]);
  assert.deepEqual(lines, ['Closing Unit Balance: 112.345\tNAV on 26-Oct-2026: INR 89.30', 'Market Value']);
});
