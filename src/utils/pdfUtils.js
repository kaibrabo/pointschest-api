'use strict';

/**
 * pdfUtils.js
 *
 * Shared helpers used by every issuer scraper:
 *   1. pageToText(page, opts)  — navigate to URL, save PDF, extract text
 *   2. extractText(pdfBuffer)  — extract raw text from a PDF buffer
 *
 * Why PDF instead of DOM scraping?
 *   - page.pdf() captures a fully-rendered snapshot of the page without needing
 *     to reverse-engineer CSS selectors that break whenever an issuer redeploys.
 *   - pdf-parse gives us clean plain text that we can parse with regex/heuristics.
 *   - No page.evaluate() — avoids the Amex "eval is disabled" crash.
 */

const path = require('path');
const fs = require('fs');
const { PDFParse } = require('pdf-parse');

const PDF_DIR = path.join(__dirname, '..', '..', 'data', 'pdfs');

/**
 * Navigate to `url`, optionally wait for a selector or idle, then:
 *   1. Save the page as a PDF buffer
 *   2. Optionally write it to disk (for debugging)
 *   3. Extract and return the plain text
 *
 * @param {import('playwright').Page} page  - already-created Playwright page
 * @param {string} url                      - target URL
 * @param {object} [opts]
 * @param {number}  [opts.navTimeout=30000] - navigation timeout ms
 * @param {number}  [opts.waitMs=4000]      - extra ms to wait after load
 * @param {string}  [opts.waitForSelector]  - optional selector to wait for
 * @param {string}  [opts.saveAs]           - filename (no path) to save PDF for debugging
 * @returns {Promise<{ text: string, pdfBuffer: Buffer }>}
 */
async function pageToText(page, url, opts = {}) {
  const {
    navTimeout = 30000,
    waitMs = 4000,
    waitForSelector = null,
    saveAs = null,
  } = opts;

  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: navTimeout,
  });

  // Let JS frameworks finish rendering
  await page.waitForTimeout(waitMs);

  // Optionally wait for a specific element before snapping the PDF
  if (waitForSelector) {
    await page.waitForSelector(waitForSelector, { timeout: 15000 }).catch(() => {});
  }

  // Capture the rendered page as a PDF (Chromium only; works headless)
  const pdfBuffer = await page.pdf({
    format: 'A4',
    printBackground: true,
  });

  // Optionally persist to disk for manual inspection / debugging
  if (saveAs) {
    fs.mkdirSync(PDF_DIR, { recursive: true });
    fs.writeFileSync(path.join(PDF_DIR, saveAs), pdfBuffer);
  }

  const text = await extractText(pdfBuffer);
  return { text, pdfBuffer };
}

/**
 * Run pdf-parse on a buffer and return the plain text string.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<string>}
 */
async function extractText(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer, verbosity: 0 });
  await parser.load();
  const result = await parser.getText();
  // getText() returns { pages: [{ text: string, ... }] }
  if (result && Array.isArray(result.pages)) {
    return result.pages.map((p) => p.text || '').join('\n');
  }
  // Fallback for unexpected shapes
  return typeof result === 'string' ? result : JSON.stringify(result);
}

module.exports = { pageToText, extractText };
