import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAsset } from '../js/core/assets.js';
import { date } from '../js/core/calendar.js';
import { Category } from '../js/core/categories.js';
import { isDepositoryStatement } from '../js/core/demat.js';
import { assetSplit, describeScheme, isNPSStatement, npsAssetFrom, parseNPS, planNPSImport } from '../js/core/nps.js';
import { pdfRows } from '../js/ui/pdf.js';

// Synthetic lines in the Protean layout, as pdfRows joins them (cells separated by tabs).
const tier2Lines = [
  'NPS TRANSACTION STATEMENT',
  'April 01, 2026 to September 30, 2026',
  'NPS Transaction Statement for',
  'Tier II Account',
  'PRAN\t110099988877\tRegistration Date\t01-Jan-21',
  'Investment Summary',
  '(A)\t(B)\t(C)\tD=(A-B)+C\tE',
  '₹ 48,200.00\t6\t₹ 60,000.00\t₹ 10,000.00\t₹ (1,800.00)\t₹ 40.00',
  'Investment Details - Scheme Wise Summary',
  'Scheme wise Value of',
  'Particulars\tTotal Units ( U)',
  '₹) (E= U* N)',
  'NPS TRUST A/C SAMPLE PENSION FUNDS PRIVATE LIMITED SCHEME E - TIER II\t30,000.00\t1,000.0000\t30.0000',
  'NPS TRUST A/C SAMPLE PENSION FUNDS PRIVATE LIMITED SCHEME G - TIER II\t18,200.00\t700.0000\t26.0000',
  'Transaction Details',
  'NPS TRUST A/C SAMPLE PENSION FUNDS PRIVATE LIMITED SCHEME E - TIER II\t5,000.00\t200.0000\t25.0000',
];

test('a Protean NPS statement PDF is recognised and read, wrapped scheme names included', async () => {
  const rows = await pdfRows((await readFile(new URL('./fixtures/sample-nps.pdf', import.meta.url))).buffer);
  const lines = rows.map((r) => r.text);
  assert.ok(isNPSStatement(lines));
  assert.ok(!isDepositoryStatement(lines));
  const s = parseNPS(rows);
  assert.equal(s.pran, '110012345678');
  assert.equal(s.tier, 'Tier 1');
  assert.equal(s.asOf, date(2026, 10, 31));
  assert.deepEqual([s.value, s.contributed, s.withdrawn, s.cra], [487005.84, 420000, 0, 'Protean CRA']);
  assert.deepEqual(
    s.schemes.map((x) => [x.pfm, x.assetClass, x.value, x.units, x.nav]),
    [
      ['Example Pension Fund', 'E', 319821.79, 4250.1234, 75.25],
      ['Example Pension Fund', 'C', 101034.05, 2100.5, 48.1],
      ['Example Pension Fund', 'G', 60000, 1500, 40],
      ['Example Pension Fund', 'A', 6150, 300, 20.5],
    ],
  );
});

test('Tier II, withdrawals and a loss; transactions after the summary are not schemes', () => {
  const s = parseNPS(tier2Lines);
  assert.equal(s.tier, 'Tier 2');
  assert.equal(s.asOf, date(2026, 9, 30));
  assert.deepEqual([s.value, s.contributed, s.withdrawn], [48200, 60000, 10000]);
  assert.deepEqual(s.schemes.map((x) => [x.pfm, x.assetClass, x.value]), [['Sample Pension Funds', 'E', 30000], ['Sample Pension Funds', 'G', 18200]]);
  const a = npsAssetFrom(planNPSImport(s, []), s, 1);
  // Invested is contributions less withdrawals, so the gain is the statement's notional gain/loss (D).
  assert.equal(a.currentValuation - a.investedAmount, -1800);
  assert.equal(a.npsTier, 'Tier 2');
  assert.equal(a.name, 'NPS – Sample Pension Funds');
});

test('statements other than NPS, or without the summary, are told apart', () => {
  assert.ok(!isNPSStatement(['Consolidated Account Statement', 'PRAN 110012345678']));
  assert.throws(() => parseNPS(['NPS TRANSACTION STATEMENT', 'Tier I Account']), /no PRAN/);
  assert.throws(() => parseNPS(['NPS TRANSACTION STATEMENT', 'PRAN\t110012345678']), /Investment Summary/);
});

test('scheme names give the pension fund and asset class', () => {
  assert.deepEqual(describeScheme('NPS TRUST A/C HDFC PENSION FUND SCHEME C - TIER II'), {
    name: 'NPS TRUST A/C HDFC PENSION FUND SCHEME C - TIER II',
    pfm: 'HDFC Pension Fund',
    assetClass: 'C',
  });
  assert.equal(describeScheme('NPS TRUST A/C SBI PENSION FUNDS PRIVATE LIMITED SCHEME - CENTRAL GOVT').assetClass, null);
});

test('the asset split adds up to 100, and is left out when a scheme has no class', () => {
  const split = assetSplit([
    { assetClass: 'E', value: 1 },
    { assetClass: 'C', value: 1 },
    { assetClass: 'G', value: 1 },
  ]);
  assert.deepEqual([split.npsEquityPct, split.npsCorporateDebtPct, split.npsGovtBondPct], [33.4, 33.3, 33.3]);
  assert.equal(Math.round((split.npsEquityPct + split.npsCorporateDebtPct + split.npsGovtBondPct + split.npsAlternativePct) * 10), 1000);
  assert.equal(split.npsAlternativePct, 0);
  assert.equal(assetSplit([{ assetClass: null, value: 5 }]), null);
});

test('the account is matched by PRAN and tier, or takes over the one NPS asset without a PRAN', () => {
  const s = parseNPS(tier2Lines);
  const nps = (fields) => createAsset({ category: Category.nps, name: 'NPS', ...fields }, 0);
  const linked = nps({ pran: '1100 9998 8877', npsTier: 'Tier 2', name: 'My Tier 2', notes: 'keep', institution: 'Mine' });
  const otherTier = nps({ pran: '110099988877', npsTier: 'Tier 1' });
  const manual = nps({ npsTier: 'Tier 2' });

  assert.equal(planNPSImport(s, [otherTier, manual, linked]).existing, linked);
  const adopted = planNPSImport(s, [otherTier, manual]);
  assert.ok(adopted.adopted && adopted.existing === manual);
  assert.equal(planNPSImport(s, [otherTier, manual, nps({ npsTier: 'Tier 2' })]).action, 'new');

  const updated = npsAssetFrom({ action: 'update', existing: linked }, s, 5);
  assert.deepEqual([updated.id, updated.name, updated.notes, updated.institution], [linked.id, 'My Tier 2', 'keep', 'Mine']);
  assert.deepEqual([updated.pran, updated.currentValuation, updated.investedAmount, updated.lastUpdated], ['110099988877', 48200, 50000, 5]);
  assert.equal(linked.currentValuation, 0, 'the stored asset is left alone until saved');
});
