/**
 * Citi scraper — PDF approach
 */

import { pageToText } from '../utils/pdfUtils.js';
import { parseCards } from '../parsers/parseCards.js';

const LISTING_URL = 'https://www.citi.com/credit-cards/compare/view-all-credit-cards';
const ISSUER = 'Citi';

export default async function scrapeCiti(page, { detectBlock }) {
  const { text } = await pageToText(page, LISTING_URL, {
    navTimeout: 30000,
    waitMs: 5000,
    saveAs: 'citi.pdf',
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
}
