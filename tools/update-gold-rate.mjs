// Writes rates/gold.json with today's gold rate in Hyderabad from 5paisa, for the app to value gold holdings.
// 5paisa has no API and its page can't be read from another site in a browser, so a scheduled GitHub Action
// (.github/workflows/gold-rate.yml) runs this and commits the result next to the app:
//   node tools/update-gold-rate.mjs [saved-page.html]
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'https://www.5paisa.com/commodity-trading/gold/hyderabad';
const OUT = fileURLToPath(new URL('../rates/gold.json', import.meta.url));

const ENTITIES = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', '#8377': '₹', '#x20b9': '₹' };
const toText = (html) =>
  html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ');

const amount = (s) => Number(s.replaceAll(',', ''));

/**
 * Reads the rates from the page's summary sentence ("… today is ₹14,268 per gram for 24 karat, ₹13,079 per gram for
 * 22 karat, and ₹10,305 per gram for 18 karat") and the date from the first row of its last-10-days table, which must
 * agree on the 24K rate.
 * @returns {{ date: string, perGram: { 24: number, 22: number, 18: number } }} date as YYYY-MM-DD
 */
export function parseGoldPage(html) {
  const text = toText(html);
  const perGram = {};
  for (const k of [24, 22, 18]) {
    const m = new RegExp(`₹\\s*([\\d,]+(?:\\.\\d+)?)\\s*per gram for ${k} karat`, 'i').exec(text);
    if (!m) throw new Error(`No ${k}K rate on the page; its wording may have changed.`);
    perGram[k] = amount(m[1]);
  }
  const row = /Last 10 Days.*?(\d{2})-(\d{2})-(\d{4})\s+([\d,]+)/i.exec(text);
  if (!row) throw new Error('No dated rate table on the page; its layout may have changed.');
  const [, d, mo, y, per10] = row;
  if (Math.abs(amount(per10) / 10 - perGram[24]) > 1) throw new Error(`The table (₹${per10}/10g) and summary (₹${perGram[24]}/g) disagree.`);
  if (!(perGram[24] > 2000 && perGram[24] < 100000 && perGram[18] < perGram[22] && perGram[22] < perGram[24])) {
    throw new Error(`Rates look wrong: ${JSON.stringify(perGram)}`);
  }
  return { date: `${y}-${mo}-${d}`, perGram };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = process.argv[2]
    ? await readFile(process.argv[2], 'utf8')
    : await (async () => {
        const res = await fetch(SOURCE, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WealthTracker gold rate)', Accept: 'text/html' } });
        if (!res.ok) throw new Error(`5paisa returned HTTP ${res.status}`);
        return res.text();
      })();
  const { date, perGram } = parseGoldPage(html);
  const previous = await readFile(OUT, 'utf8').then(JSON.parse, () => null);
  if (previous?.date === date && JSON.stringify(previous.perGram) === JSON.stringify(perGram)) {
    console.log(`Unchanged: ${date}`);
  } else {
    const file = { source: '5paisa', city: 'Hyderabad', url: SOURCE, date, perGram, checkedAt: new Date().toISOString() };
    await writeFile(OUT, JSON.stringify(file, null, 2) + '\n');
    console.log(`Wrote ${date}: 24K ₹${perGram[24]}/g, 22K ₹${perGram[22]}/g, 18K ₹${perGram[18]}/g`);
  }
}
