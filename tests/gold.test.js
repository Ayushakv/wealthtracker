import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { allocation, createAsset, recompute } from '../js/core/assets.js';
import { exportBackup, parseBackup } from '../js/core/backup.js';
import { date } from '../js/core/calendar.js';
import { Category } from '../js/core/categories.js';
import { applyDraft, newDraft, validateDraft } from '../js/core/draft.js';
import { applyGoldRate, fetchGoldRate, parseGoldRate, rateForKarat } from '../js/core/gold.js';
import { parseGoldPage } from '../tools/update-gold-rate.mjs';

const now = date(2026, 11, 11);
const goldRate = parseGoldRate({ date: '2026-11-11', perGram: { 24: 10000, 22: 9160, 18: 7500 } });

/** Shaped like the 5paisa city page: a summary sentence plus a last-10-days table priced per 10 grams. */
const page = ({ k24 = '10,000', k22 = '9,160', k18 = '7,500', row = '11-11-2026 1,00,000' } = {}) => `<html><head><title>Gold Rate</title>
  <script>var x = "₹1 per gram for 24 karat";</script></head><body>
  <p>Gold price in Example City today is &#8377;${k24} per gram for 24 karat, ₹${k22} per gram for 22 karat, and ₹${k18} per gram for 18 karat.</p>
  <h2>Gold Rate in Example City for Last 10 Days</h2>
  <table><tr><th>Date</th><th>24 Carat Gold (10gm)</th></tr><tr><td>${row.split(' ')[0]}</td><td>${row.split(' ')[1]}</td><td>-100 (-0.10%)</td></tr>
  <tr><td>10-11-2026</td><td>1,00,100</td></tr></table></body></html>`;

describe('Gold rate', () => {
  test('the 5paisa page is read for each purity and dated from its table', () => {
    assert.deepEqual(parseGoldPage(page()), { date: '2026-11-11', perGram: { 24: 10000, 22: 9160, 18: 7500 } });
  });

  test('a page that changed shape or disagrees with itself is refused rather than guessed at', () => {
    assert.throws(() => parseGoldPage(page({ k18: 'n/a' })), /18K/);
    assert.throws(() => parseGoldPage(page({ row: '11-11-2026 1,20,000' })), /disagree/);
    assert.throws(() => parseGoldPage(page({ k22: '12,000', row: '11-11-2026 1,00,000' })), /look wrong/);
    assert.throws(() => parseGoldPage('<p>Maintenance</p>'), /rate/);
  });

  test('the rate file is checked, and missing purities scale from 24K', () => {
    assert.equal(goldRate.date, now);
    assert.throws(() => parseGoldRate({ date: '11/11/2026', perGram: { 24: 1 } }), /isn’t readable/);
    assert.throws(() => parseGoldRate({ date: '2026-11-11', perGram: { 22: 1 } }), /isn’t readable/);
    assert.equal(rateForKarat(parseGoldRate({ date: '2026-11-11', perGram: { 24: 12000 } }), 18), 9000);
    assert.equal(rateForKarat(null, 24), null);
  });

  test('fetching sends no details and reports failures plainly', async () => {
    let asked;
    const rate = await fetchGoldRate(async (url) => {
      asked = url;
      return new Response(JSON.stringify({ date: '2026-11-11', perGram: { 24: 10000 } }));
    });
    assert.match(asked, /^rates\/gold\.json\?t=\d+$/);
    assert.equal(rate.perGram[24], 10000);
    await assert.rejects(fetchGoldRate(() => Promise.reject(new TypeError('offline'))), /connection/);
    await assert.rejects(fetchGoldRate(async () => new Response('', { status: 404 })), /HTTP 404/);
  });
});

describe('Gold holdings', () => {
  test('valued at grams × the rate for their purity', () => {
    const coin = applyGoldRate(createAsset({ category: Category.gold, name: 'Coin', goldGrams: 10, goldKarat: 24, investedAmount: 80000 }, now), goldRate);
    const chain = applyGoldRate(createAsset({ category: Category.gold, name: 'Chain', goldGrams: 5, goldKarat: 22 }, now), goldRate);
    assert.equal(recompute(coin, undefined, now).currentValuation, 100000);
    assert.equal(recompute(chain, undefined, now).currentValuation, 45800);
    assert.equal(coin.goldRateDate, now);
  });

  test('a new holding needs grams, and keeps the amount paid as its value until a rate arrives', () => {
    const d = { ...newDraft(Category.gold, now), name: 'Digital gold', institution: 'Example app', investedAmount: 5000 };
    assert.match(validateDraft(d), /grams/);
    d.goldGrams = 0.4567;
    assert.equal(validateDraft(d), null);
    const a = applyDraft(d, null, undefined, now);
    assert.equal(a.currentValuation, 5000);
    const valued = applyDraft(applyGoldRate(d, goldRate), structuredClone(a), undefined, now);
    assert.equal(valued.currentValuation, 4567);
    assert.equal(valued.goldKarat, 24);
  });

  test('gold has its own dashboard slice, and backups keep the holding', () => {
    const coin = recompute(applyGoldRate(createAsset({ category: Category.gold, name: 'Coin', goldGrams: 1 }, now), goldRate), undefined, now);
    const cash = createAsset({ category: Category.bank, name: 'Savings', currentValuation: 30000 }, now);
    assert.deepEqual(allocation([coin, cash]).map((s) => [s.label, s.value]), [['Gold', 10000], ['Liquid Cash', 30000]]);
    const [back] = parseBackup(exportBackup({ assets: [coin], ppfRates: [] })).assets;
    assert.deepEqual([back.category, back.goldGrams, back.goldKarat, back.goldRate, back.goldRateDate], [Category.gold, 1, undefined, 10000, now]);
  });
});
