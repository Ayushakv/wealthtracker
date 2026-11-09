import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { linesFromItems, pdfLines, pdfRows, PDFPasswordError } from '../js/ui/pdf.js';
import { parseCAS } from '../js/core/cas.js';
import { isDepositoryStatement, parseDemat } from '../js/core/demat.js';

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

test('bonds and demat funds are read from a password-protected NSDL statement', async () => {
  const rows = await pdfRows(await fixture('sample-nsdl.pdf'), 'ABCDE1234F');
  assert.ok(isDepositoryStatement(rows.map((r) => r.text)));
  const d = (y, m, day) => new Date(`${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+05:30`).getTime();
  const statement = parseDemat(rows);
  // Units stacked by balance; the lock-in list after the bonds is left out.
  assert.deepEqual(statement.funds.map((f) => [f.account, f.isin, f.name, f.units, f.nav, f.value]), [['1208180087654321', 'INF000Y01AB2', 'EXAMPLE MUTUAL FUND', 250.5, 80.25, 20102.63]]);
  assert.deepEqual(
    statement.holdings.map((h) => [h.account, h.isin, h.name, h.value, h.coupon, h.maturity]),
    [
      ['IN30009512345678', 'IN0020200195', 'SGB 2020-21 SERIES VIII', 150240, 2.5, d(2028, 11, 10)],
      ['IN30009512345678', 'IN0020230085', 'GOI LOAN 7.18% 2033', 101250, 7.18, d(2033, 8, 14)],
      // NSDL's corporate bond table: names centred on the ISIN's line, a frequency column, no coupon.
      ['IN30009512345678', 'INE001A07RU8', 'EXAMPLE HOUSING FINANCE LIMITED', 25312.5, null, d(2028, 3, 15)],
      ['IN30009512345678', 'INE002B07AB3', 'SAMPLE CREDIT CAPITAL PRIVATE LIMITED', 50000, 12, d(2027, 9, 29)],
      // A CDSL account in the same statement: three-line securities with "#coupon" and "RD <maturity>".
      ['1208180087654321', 'INE003C15012', 'EXAMPLE TRUST MAY 2025', 201840, 11.4, d(2027, 9, 28)],
      ['1208180087654321', 'INE002B07AB3', 'SAMPLE CREDIT CAPITAL PRIVATE LTD 12% Sep 2027', 49130, 12, d(2027, 9, 29)],
      ['1208180087654321', 'INE002B07AC1', 'SAMPLE CREDIT CAPITAL PRIVATE LTD 13% May 2027', 99450, 13, d(2027, 5, 24)],
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
