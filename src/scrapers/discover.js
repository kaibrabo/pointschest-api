'use strict';

/**
 * Discover scraper — PDF approach
 *
 * Discover has the lightest bot detection of the six issuers.
 */

const { pageToText } = require('../utils/pdfUtils');
const { parseCards, applyNowSplitCards } = require('../parsers/parseCards');

const LISTING_URL = 'https://www.discover.com/credit-cards/';
const ISSUER = 'Discover';

module.exports = async function scrapeDiscover(page, { detectBlock }) {
  const { text } = await pageToText(page, LISTING_URL, {
    navTimeout: 30000,
    waitMs: 4000,
    saveAs: 'discover.pdf',
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
};
