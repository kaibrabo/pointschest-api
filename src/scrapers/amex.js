'use strict';

/**
 * American Express scraper — PDF approach
 *
 * Amex uses Akamai bot protection AND explicitly disables eval() in their JS
 * (page.evaluate crashes with "eval is disabled"). The PDF approach sidesteps
 * both issues entirely — we capture a rendered snapshot without injecting any
 * scripts into the page context.
 */

const { pageToText } = require('../utils/pdfUtils');
const { parseCards } = require('../parsers/parseCards');

const LISTING_URL = 'https://www.americanexpress.com/us/credit-cards/';
const ISSUER = 'American Express';

module.exports = async function scrapeAmex(page, { detectBlock }) {
  const { text } = await pageToText(page, LISTING_URL, {
    navTimeout: 35000,
    waitMs: 6000, // Amex loads slowly
    saveAs: 'amex.pdf',
  });

  const blockReason = await detectBlock(page);
  if (blockReason) throw new Error(`${ISSUER} blocked scraper: ${blockReason}`);

  if (!text || text.trim().length < 100) {
    throw new Error(`${ISSUER}: extracted PDF text is too short — possible block or empty page`);
  }

  const cards = parseCards(text, ISSUER, { listingUrl: LISTING_URL });

  if (!cards.length) {
    throw new Error(
      `${ISSUER}: parser found 0 cards in PDF text (${text.length} chars). ` +
      'The page layout or text structure may have changed.'
    );
  }

  return cards;
};
