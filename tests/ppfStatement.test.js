import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAsset, createEntry } from '../js/core/assets.js';
import { date } from '../js/core/calendar.js';
import { Category } from '../js/core/categories.js';
import { isDepositoryStatement } from '../js/core/demat.js';
import { isNPSStatement } from '../js/core/nps.js';
import { RateSchedule } from '../js/core/ppf.js';
import { isPPFStatement, parsePPF, planPPFImport, ppfAssetFrom } from '../js/core/ppfStatement.js';
import { pdfRows } from '../js/ui/pdf.js';

const head = (value, from = '01-04-2024') => [
  '15-05-2026',
  'The current value of investment in your Public Provident Fund (PPF) account number 8888PPF0000000004321',
  `is INR ${value}.`,
  `Please find the statement of transaction for your PPF account from ${from} to 31-03-2027 below:`,
  'Transaction Date\tRemarks\tAmount (INR)\tBalance (INR)',
];

// Oldest first, across two financial years, with the bank's interest credit and a withdrawal.
const twoYears = [
  ...head('112710.00'),
  '10-04-2024\tDeposit\t50000.00\t150000.00',
  '31-03-2025\tInterest Credit\t10650.00\t160650.00',
  '20-04-2025\tPartial Withdrawal\t50000.00\t110650.00',
  '31-03-2026\tInterest Credit\t2060.00\t112710.00',
  'Regards,',
  'Example Bank Ltd.',
];

test('a bank PPF statement PDF is recognised and read', async () => {
  const rows = await pdfRows((await readFile(new URL('./fixtures/sample-ppf.pdf', import.meta.url))).buffer);
  const lines = rows.map((r) => r.text);
  assert.ok(isPPFStatement(lines));
  assert.ok(!isNPSStatement(lines) && !isDepositoryStatement(lines));
  const s = parsePPF(rows);
  assert.deepEqual([s.account, s.bank, s.asOf, s.fyStart, s.value, s.opening, s.balanced], ['9999PPF0000000001234', 'Example Bank', date(2026, 10, 31), 2026, 250000, 150000, true]);
  // Listed newest first; read oldest first.
  assert.deepEqual(s.transactions.map((t) => [t.date, t.kind, t.amount]), [
    [date(2026, 4, 5), 'deposit', 50000],
    [date(2026, 7, 3), 'deposit', 25000],
    [date(2026, 10, 4), 'deposit', 25000],
  ]);
});

test('withdrawals count against the balance; the bank’s interest is folded in, not kept as a deposit', () => {
  const s = parsePPF(twoYears);
  assert.equal(s.fyStart, 2024);
  assert.equal(s.opening, 100000);
  assert.ok(s.balanced);
  assert.deepEqual(s.transactions.map((t) => [t.kind, t.amount]), [['deposit', 50000], ['interest', 10650], ['withdrawal', -50000], ['interest', 2060]]);
  const a = ppfAssetFrom(planPPFImport(s, []), s, RateSchedule.official, date(2026, 4, 1));
  assert.deepEqual(a.entries.map((e) => [e.amount, e.note]), [[50000, undefined], [-50000, 'Partial Withdrawal']]);
  assert.equal(a.ppfOpeningFYStartYear, 2024);
  assert.equal(a.name, 'PPF – Example Bank');
});

test('statements that don’t start on 1 April, don’t add up, or aren’t PPF are told apart', () => {
  assert.throws(() => parsePPF(head('1000.00', '01-10-2026')), /partway through a financial year/);
  assert.ok(!parsePPF([...head('1000.00', '01-04-2026'), '05-04-2026\tDeposit\t500.00\t900.00']).balanced);
  assert.ok(!isPPFStatement(['NPS TRANSACTION STATEMENT', 'PRAN 110012345678']));
  assert.throws(() => parsePPF(['Public Provident Fund statement']), /no account number/);
});

test('the account is matched by number, or takes over the one PPF added by hand, whose deposits it replaces', () => {
  const s = parsePPF(twoYears);
  const ppf = (fields) => createAsset({ category: Category.ppf, name: 'PPF', ...fields }, 0);
  const linked = ppf({ accountNumber: '8888 PPF 0000000004321', name: 'Mine', notes: 'keep' });
  const other = ppf({ accountNumber: '1111PPF0000000000001' });
  const manual = ppf({ name: 'By hand', ppfOpeningBalance: 5, ppfOpeningFYStartYear: 2026, entries: [createEntry(date(2026, 4, 2), 1000)] });

  assert.equal(planPPFImport(s, [other, manual, linked]).existing, linked);
  const adopted = planPPFImport(s, [other, manual]);
  assert.ok(adopted.adopted && adopted.existing === manual);
  assert.equal(planPPFImport(s, [other, manual, ppf({})]).action, 'new');

  const updated = ppfAssetFrom(adopted, s, RateSchedule.official, date(2026, 4, 1));
  assert.deepEqual([updated.id, updated.name, updated.accountNumber, updated.ppfOpeningBalance, updated.ppfOpeningFYStartYear], [manual.id, 'By hand', '8888PPF0000000004321', 100000, 2024]);
  assert.equal(updated.entries.length, 2);
  assert.equal(manual.entries.length, 1, 'the stored asset is left alone until saved');
  assert.deepEqual([ppfAssetFrom({ existing: linked }, s).notes], ['keep']);
});
