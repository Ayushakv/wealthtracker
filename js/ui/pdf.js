/**
 * Extracts the text of a PDF on the device with the vendored pdf.js (loaded only when needed).
 * Text items are regrouped into visual lines: items sharing a baseline are joined left to right,
 * with a tab where a wide gap separates table columns.
 */
let pdfjs = null;

async function loadPDFJS() {
  if (!pdfjs) {
    pdfjs = await import('../../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export class PDFPasswordError extends Error {
  constructor(incorrect) {
    super(incorrect ? 'Incorrect password.' : 'This PDF needs a password.');
    this.name = 'PDFPasswordError';
    this.incorrect = incorrect;
  }
}

/**
 * @param {ArrayBuffer} data the PDF file
 * @param {string} [password]
 * @returns {Promise<string[]>} lines of every page in reading order
 * @throws {PDFPasswordError} when a password is missing or wrong
 */
export async function pdfLines(data, password) {
  return (await pdfRows(data, password)).map((row) => row.text);
}

/**
 * Like pdfLines, but each line keeps where it sits on the page, for tables whose cells wrap over several lines.
 * @returns {Promise<Row[]>}
 */
export async function pdfRows(data, password) {
  const { getDocument, PasswordResponses } = await loadPDFJS();
  // pdf.js hands the buffer to its worker, so give it a copy and keep ours for a password retry.
  const task = getDocument({ data: new Uint8Array(data.slice(0)), password, isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    if (e?.name === 'PasswordException') throw new PDFPasswordError(e.code === PasswordResponses.INCORRECT_PASSWORD);
    throw new Error('This file couldn’t be read as a PDF.');
  }
  try {
    const rows = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      rows.push(...rowsFromItems(items, n));
      page.cleanup();
    }
    return rows;
  } finally {
    await task.destroy();
  }
}

/** Groups pdf.js text items ({ str, transform: [a, b, c, d, x, y], width, height }) into lines, top to bottom. */
export function linesFromItems(items) {
  return rowsFromItems(items).map((row) => row.text);
}

const ISIN_ONLY = /^IN[0-9A-Z]{9}[0-9]$/;

/**
 * @typedef {{ x: number, end: number, h: number, text: string }} Cell text that runs together, in page points (y grows upwards)
 * @typedef {{ page: number, y: number, text: string, cells: Cell[] }} Row a visual line; text is its cells joined by tabs
 * @returns {Row[]}
 */
export function rowsFromItems(items, page = 1) {
  const rows = [];
  for (const it of items) {
    if (!it.str?.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.height || it.transform[3]) || 8;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, 0.4 * Math.min(h, r.h)));
    if (!row) rows.push((row = { y, h, items: [] }));
    row.items.push({ x, end: x + (it.width || 0), str: it.str, h });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x);
    const cells = [];
    let cell = null;
    for (const it of row.items) {
      const gap = cell ? it.x - cell.end : 0;
      // A wide gap starts a new cell, and so does anything after an ISIN that starts the line (a table's first column).
      if (!cell || gap > 1.5 * it.h || (cells.length === 1 && ISIN_ONLY.test(cell.text.trim()))) {
        cells.push((cell = { x: it.x, end: it.end, h: it.h, text: it.str }));
        continue;
      }
      if (gap > 0.15 * it.h && !/\s$/.test(cell.text) && !/^\s/.test(it.str)) cell.text += ' ';
      cell.text += it.str;
      cell.end = Math.max(cell.end, it.end);
      cell.h = Math.max(cell.h, it.h);
    }
    for (const c of cells) c.text = c.text.replace(/[ \u00a0]+/g, ' ').trim();
    const kept = cells.filter((c) => c.text);
    return { page, y: row.y, text: kept.map((c) => c.text).join('\t'), cells: kept };
  });
}
