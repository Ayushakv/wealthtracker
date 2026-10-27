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
    const lines = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      lines.push(...linesFromItems(items));
      page.cleanup();
    }
    return lines;
  } finally {
    await task.destroy();
  }
}

/** Groups pdf.js text items ({ str, transform: [a, b, c, d, x, y], width, height }) into lines, top to bottom. */
export function linesFromItems(items) {
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
    let text = '';
    let end = null;
    for (const it of row.items) {
      if (end != null) {
        const gap = it.x - end;
        if (gap > 1.5 * it.h) text += '\t';
        else if (gap > 0.15 * it.h && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      end = Math.max(end ?? -Infinity, it.end);
    }
    return text.replace(/[  ]+/g, ' ').trim();
  });
}
