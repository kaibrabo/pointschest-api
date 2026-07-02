/**
 * Chase scraper — PDF approach
 *
 * Navigates to the Chase credit cards listing page, captures a PDF of the
 * fully-rendered page, extracts plain text, and parses it into card objects.
 *
 * No DOM selectors, no page.evaluate() — immune to layout changes and the
 * Akamai bot detection that blocks headless JS injection.
 */

import { pageToText } from '../utils/pdfUtils.js';
import { parseCards, applyNowSplitCards } from '../parsers/parseCards.js';

const LISTING_URL = 'https://creditcards.chase.com/';
const ISSUER = 'Chase';

export default async function scrapeChase(page, { detectBlock }) {
  const { text } = await pageToText(page, LISTING_URL, {
    navTimeout: 30000,
    waitMs: 5000,
    saveAs: 'chase.pdf',
  });

  const blockReason = await detectBlock(page);
  if (blockReason) throw new Error(`${ISSUER} blocked scraper: ${blockReason}`);

  if (!text || text.trim().length < 100) {
    throw new Error(`${ISSUER}: extracted PDF text is too short — possible block or empty page`);
  }

  const cards = parseCards(text, ISSUER, { listingUrl: LISTING_URL, splitCards: applyNowSplitCards });

  if (!cards.length) {
    throw new Error(
      `${ISSUER}: parser found 0 cards in PDF text (${text.length} chars). ` +
      'The page layout or text structure may have changed.'
    );
  }

  return cards;
}
