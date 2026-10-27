// Rebuilds data/isin-amfi.json from AMFI's daily NAV file, so CAS imports can turn the ISINs printed
// on a statement into the AMFI scheme codes mfapi.in uses. Run now and then to pick up new schemes:
//   node tools/update-isin-map.mjs [path-to-NAVAll.txt]
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const OUT = fileURLToPath(new URL('../data/isin-amfi.json', import.meta.url));
const ISIN = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;

/** NAVAll.txt is ';'-separated with a header row; section titles and blank lines sit between the rows. */
export function parseNAVAll(text) {
  const lines = text.split(/\r?\n/);
  const header = lines.find((l) => l.startsWith('Scheme Code;'))?.split(';') ?? [];
  const isinColumns = header.flatMap((h, i) => (/ISIN/i.test(h) ? [i] : []));
  if (!isinColumns.length) throw new Error('NAVAll.txt header has no ISIN columns; the format may have changed.');
  const map = {};
  for (const line of lines) {
    const f = line.split(';');
    if (!/^\d+$/.test(f[0])) continue;
    for (const i of isinColumns) {
      const isin = f[i]?.trim();
      if (ISIN.test(isin)) map[isin] = f[0];
    }
  }
  return map;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = process.argv[2] ? await readFile(process.argv[2], 'utf8') : await (await fetch(SOURCE)).text();
  const schemes = parseNAVAll(text);
  const count = Object.keys(schemes).length;
  if (count < 5000) throw new Error(`Only ${count} ISINs found; refusing to overwrite the map.`);
  const sorted = Object.fromEntries(Object.entries(schemes).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(OUT, JSON.stringify({ source: SOURCE, generated: new Date().toISOString().slice(0, 10), schemes: sorted }) + '\n');
  console.log(`Wrote ${count} ISINs to data/isin-amfi.json`);
}
