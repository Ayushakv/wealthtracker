import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { linesFromItems, pdfLines, PDFPasswordError } from '../js/ui/pdf.js';
import { parseCAS } from '../js/core/cas.js';
import { isDepositoryStatement, parseDematBonds } from '../js/core/demat.js';

const fixture = async (name = 'sample-cas.pdf') => (await readFile(new URL(`./fixtures/${name}`, import.meta.url))).buffer;

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

test('bonds are read from a password-protected NSDL statement', async () => {
  const lines = await pdfLines(await fixture('sample-nsdl.pdf'), 'ABCDE1234F');
  assert.ok(isDepositoryStatement(lines));
  assert.deepEqual(
    parseDematBonds(lines).holdings.map((h) => [h.isin, h.name, h.value, h.coupon, h.account]),
    [
      ['IN0020200195', 'SGB 2020-21 SERIES VIII', 150240, 2.5, 'IN30009512345678'],
      ['IN0020230085', 'GOI LOAN 7.18% 2033', 101250, 7.18, 'IN30009512345678'],
      ['INE001A07RU8', 'EXAMPLE HOUSING FINANCE LIMITED SR-X 8.25% NCD', 25312.5, 8.25, 'IN30009512345678'],
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
