import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { accessOf, accessTotals, createAsset } from '../js/core/assets.js';
import { exportBackup, parseBackup } from '../js/core/backup.js';
import { date } from '../js/core/calendar.js';
import { Category, LIC_ENDOWMENT } from '../js/core/categories.js';
import { applyDraft, draftFromAsset, newDraft } from '../js/core/draft.js';

const now = date(2026, 11, 28);
const asset = (category, value, fields = {}) => createAsset({ category, name: `${category} ${value}`, investedAmount: value, currentValuation: value, ...fields }, now);

describe('Liquid and locked-in', () => {
  test('each category has a default: retirement and long-term money is locked in', () => {
    const locked = [Category.ppf, Category.nps, Category.realEstate, Category.insurance, Category.p2p];
    const liquid = [Category.bank, Category.fd, Category.bonds, Category.mutualFund, Category.gold];
    for (const c of locked) assert.equal(accessOf(asset(c, 1)), 'locked', c);
    for (const c of liquid) assert.equal(accessOf(asset(c, 1)), 'liquid', c);
    assert.equal(accessOf(asset(Category.nps, 1, { npsTier: 'Tier 2' })), 'liquid');
    assert.equal(accessOf(asset(Category.mutualFund, 1, { access: 'locked' })), 'locked');
    assert.equal(accessOf(asset(Category.ppf, 1, { access: 'bogus' })), 'locked');
  });

  test('net worth splits into the two, with each share; covers without a surrender value add nothing', () => {
    const s = accessTotals([
      asset(Category.bank, 20000),
      asset(Category.bonds, 280000),
      asset(Category.ppf, 40000),
      asset(Category.insurance, 60000, { policyType: LIC_ENDOWMENT }),
      asset(Category.insurance, 999999, { policyType: 'Term Life' }),
    ]);
    assert.equal(s.liquid, 300000);
    assert.equal(s.locked, 100000);
    assert.equal(s.liquidShare, 0.75);
    assert.equal(s.lockedShare, 0.25);
    assert.deepEqual(accessTotals([]), { liquid: 0, locked: 0, liquidShare: 0, lockedShare: 0 });
  });

  test('the form overrides the default only when changed, and an untouched choice keeps following the NPS tier', () => {
    const elss = asset(Category.mutualFund, 50000);
    const d = draftFromAsset(elss, now);
    assert.equal(d.access, 'liquid');
    const locked = applyDraft({ ...d, access: 'locked' }, structuredClone(elss), undefined, now);
    assert.equal(locked.access, 'locked');
    // Back to the default: nothing stored, so it follows the category again.
    const back = applyDraft({ ...draftFromAsset(locked, now), access: 'liquid' }, structuredClone(locked), undefined, now);
    assert.equal(back.access, undefined);

    const nps = applyDraft({ ...newDraft(Category.nps, now), name: 'NPS', currentValuation: 1000 }, undefined, undefined, now);
    assert.equal(nps.access, undefined);
    assert.equal(accessOf(nps), 'locked');
    const tier2 = applyDraft({ ...draftFromAsset(nps, now), npsTier: 'Tier 2' }, structuredClone(nps), undefined, now);
    assert.equal(tier2.access, undefined);
    assert.equal(accessOf(tier2), 'liquid');
  });

  test('a choice made by hand survives a backup round trip', () => {
    const a = asset(Category.mutualFund, 50000, { access: 'locked' });
    const [back] = parseBackup(exportBackup({ assets: [a], ppfRates: [] }, now)).assets;
    assert.equal(back.access, 'locked');
  });
});
