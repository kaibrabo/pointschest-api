/**
 * parseCards.js
 *
 * Generic heuristic parser that turns raw PDF text (from any issuer page)
 * into an array of card objects matching the cards.json schema.
 *
 * Each issuer scraper calls parseCards(text, issuer, overrides) and can
 * optionally supply a custom `splitCards` function if the text layout is unique.
 *
 * Schema output per card:
 * {
 *   id, name, issuer, type, rewardRate, rewardCategories,
 *   welcomeBonus, annualFee, apr, creditScore, benefits, applyUrl, scrapedAt
 * }
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Extract annual fee value (integer dollars) from a text snippet.
 * Returns 0 for "no annual fee / $0 / free", null if not found.
 * Only matches values explicitly labeled as annual fees (not deposits, limits, etc.)
 */
function parseAnnualFee(text) {
  if (!text) return null;
  // Clean tracking-URL noise first
  const cleanText = text
    .split('\n')
    .filter((l) => !/srcCde=|adobe_mc=|ICMPGN=|TS%3D|MCMID|https?:\/\//.test(l))
    .join('\n');

  if (/no annual fee|free|\$0\s*annual fee|\$0\/year/i.test(cleanText)) return 0;

  // Must be explicitly labeled as annual fee
  const labeled = cleanText.match(/annual fee[:\s]+\$?([\d,]+)/i);
  if (labeled) return parseInt(labeled[1].replace(/,/g, ''), 10);

  // "$X Annual Fee" pattern
  const inline = cleanText.match(/\$\s*([\d,]+)\s+annual fee/i);
  if (inline) return parseInt(inline[1].replace(/,/g, ''), 10);

  // Broad "all with no annual fee" (Discover's top banner)
  if (/all with no annual fee/i.test(cleanText)) return 0;

  // If text mentions annual fee at all but no amount, default 0
  if (/annual fee/i.test(cleanText)) return 0;

  return null;
}

/**
 * Extract a reward rate (highest multiplier) from text.
 * e.g. "Earn 3x on dining" → 3
 */
function parseRewardRate(text) {
  if (!text) return 1;
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:x|%)\s*(?:points|miles|cash back)?/gi)];
  if (!matches.length) return 1;
  return Math.max(...matches.map((m) => parseFloat(m[1])));
}

/**
 * Extract APR range from text.
 * e.g. "19.99% - 28.99% Variable APR" → "19.99% - 28.99% Variable"
 * Ignores values that are clearly not APRs (>100 or look like timestamps).
 */
function parseApr(text) {
  if (!text) return 'See terms';

  // Strip lines containing tracking/URL artifacts before scanning
  const cleanText = text
    .split('\n')
    .filter((l) => !/srcCde=|adobe_mc=|ICMPGN=|TS%3D|MCMID/.test(l))
    .join('\n');

  const match = cleanText.match(
    /(\d+(?:\.\d+)?)\s*%\s*(?:[-–to]+\s*(\d+(?:\.\d+)?)\s*%)?\s*(variable|fixed)?/i
  );
  if (!match) return 'See terms';

  const lo = parseFloat(match[1]);
  const hi = match[2] ? parseFloat(match[2]) : null;

  // Sanity check: real APRs are between 0 and 100
  if (lo > 100) return 'See terms';
  if (hi && hi > 100) return 'See terms';

  const type = match[3] ? ` ${match[3]}` : '';
  return hi ? `${lo}% - ${hi}%${type}` : `${lo}%${type}`;
}

/**
 * Infer reward category multipliers from a block of reward text.
 * Returns { dining: 3, travel: 2, ... }
 */
function parseRewardCategories(text) {
  if (!text) return {};
  const cats = {};
  const patterns = [
    ['dining', /(\d+(?:\.\d+)?)\s*(?:x|%)\s*(?:on\s*)?(?:dining|restaurants|food)/i],
    ['travel', /(\d+(?:\.\d+)?)\s*(?:x|%)\s*(?:on\s*)?(?:travel|hotels?|flights?|airfare)/i],
    ['groceries', /(\d+(?:\.\d+)?)\s*(?:x|%)\s*(?:on\s*)?(?:groceries|grocery|supermarket)/i],
    ['gas', /(\d+(?:\.\d+)?)\s*(?:x|%)\s*(?:on\s*)?(?:gas|fuel|ev charging)/i],
    ['streaming', /(\d+(?:\.\d+)?)\s*(?:x|%)\s*(?:on\s*)?(?:streaming|entertainment)/i],
    ['pharmacy', /(\d+(?:\.\d+)?)\s*(?:x|%)\s*(?:on\s*)?(?:pharmacy|drugstore)/i],
    ['cellPhone', /(\d+(?:\.\d+)?)\s*(?:x|%)\s*(?:on\s*)?(?:cell phone|wireless|phone bills?)/i],
    ['other', /(\d+(?:\.\d+)?)\s*(?:x|%)\s*(?:on\s*)?(?:all other|everything else|every purchase)/i],
  ];

  for (const [cat, re] of patterns) {
    const m = text.match(re);
    if (m) cats[cat] = parseFloat(m[1]);
  }
  return cats;
}

/**
 * Infer card type from card name.
 */
function inferType(name, issuer) {
  const n = name.toLowerCase();
  if (/business|ink|spark|plum/i.test(n)) return 'Business';
  if (/student/i.test(n)) return 'Student';
  if (/secured/i.test(n)) return 'Secured';
  // Travel signals
  if (
    /sapphire|united|southwest|hyatt|ihg|marriott|aeroplan|venture|miles|delta|hilton|platinum|gold|green|altitude|premier|strata|aadvantage|travel/i.test(n)
  )
    return 'Travel';
  // Cash back signals
  if (/freedom|cash|quicksilver|savor|double|flat|rewards|discover it/i.test(n)) return 'Cash Back';

  // Issuer-level defaults
  if (issuer === 'American Express') return 'Travel';
  if (issuer === 'Discover') return 'Cash Back';
  return 'Cash Back';
}

/**
 * Infer required credit score from card name.
 */
function inferCreditScore(name) {
  const n = name.toLowerCase();
  if (/secured/i.test(n)) return 'Building/Rebuilding';
  if (/student/i.test(n)) return 'Fair to Good';
  if (/reserve|prestige|altitude reserve|venture x/i.test(n)) return 'Excellent';
  if (/sapphire preferred|venture(?! x)|strata premier|preferred/i.test(n)) return 'Good to Excellent';
  return 'Good to Excellent';
}

/**
 * Extract the welcome / signup bonus from text.
 */
function parseWelcomeBonus(text) {
  if (!text) return null;
  const match = text.match(
    /(?:earn|get|receive|bonus)\s+([\d,]+\s*(?:points|miles|cash back|\$[\d,]+)[^.]*?)(?:\.|after|when|if)/i
  );
  return match ? match[1].trim() : null;
}

// ─── Default block splitter ───────────────────────────────────────────────────

/**
 * Default strategy: identify card name lines then build blocks.
 *
 * A "card name line" must:
 *   - Contain the word "Card" (or "it" as part of a Discover-style name)
 *   - Be 5–80 chars
 *   - NOT start with a URL, question word, article, preposition, or common body-copy openers
 *   - NOT contain slashes (URL fragments), parentheses-heavy content, or % signs alone
 *   - NOT be an all-caps heading or a sentence fragment
 *
 * Returns an array of text blocks, each starting with a card name line.
 */
function defaultSplitCards(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const cardStartIndices = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Must contain "Card" as a standalone word (catches "Credit Card", "Cash Back Card", etc.)
    if (!/\bcard\b/i.test(line)) continue;

    // Length guard
    if (line.length < 6 || line.length > 90) continue;

    // Skip lines that are clearly URLs, URL fragments, or contain URL artifacts
    if (/https?:\/\/|^\/|^http|srcCde=|adobe_mc=|\?[A-Z]+=/.test(line)) continue;

    // Skip lines with too many parentheses (usually inline link text with URL)
    if ((line.match(/\(/g) || []).length > 1) continue;

    // Skip question sentences
    if (/\?$/.test(line)) continue;

    // Skip lines starting with lowercase (body copy / sentence continuation)
    if (/^[a-z]/.test(line)) continue;

    // Skip lines starting with common non-name openers
    if (/^(earn|get|apply|see|learn|the |a |an |as |in |on |at |with |from |for |to |and |or |all |no |find |compare |choose|what |how |is |are |can |will |when |if |build|your|use|check)/i.test(line)) continue;

    // Skip lines that are just section headings without a product name flavor
    // (e.g. "Credit Card FAQs", "Credit Card Benefits", "Credit Card Categories")
    if (/^credit card (faqs?|benefits?|categories|features|reward|quick links|interest|calculator)/i.test(line)) continue;

    // Skip navigation / footer / header items
    if (/^(menu|log in|sign up|footer|header|nav|skip to|back to|return to)/i.test(line)) continue;

    cardStartIndices.push(i);
  }

  if (!cardStartIndices.length) return [];

  const blocks = cardStartIndices.map((startIdx, pos) => {
    const endIdx = cardStartIndices[pos + 1] ?? lines.length;
    return lines.slice(startIdx, Math.min(endIdx, startIdx + 30)).join('\n');
  });

  // Deduplicate by normalized first line
  const seen = new Set();
  return blocks.filter((b) => {
    const key = b.split('\n')[0].toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Known product name normalization ────────────────────────────────────────

/**
 * Map of partial/truncated name prefixes → full canonical name.
 * Used to fix PDF text wrapping artifacts.
 */
const KNOWN_CARD_NAMES = [
  // Discover
  'Discover it Cash Back',
  'Discover it Miles',
  'Discover it Chrome Gas',
  'Discover it Student Cash Back',
  'Discover it Student Chrome',
  'Discover it Secured',
  'NHL Discover it',
  // Chase
  'Chase Sapphire Reserve',
  'Chase Sapphire Preferred',
  'Chase Freedom Unlimited',
  'Chase Freedom Flex',
  'Chase Freedom Rise',
  'Ink Business Cash',
  'Ink Business Unlimited',
  'Ink Business Preferred',
  'Ink Business Premier',
  'Southwest Rapid Rewards Plus',
  'Southwest Rapid Rewards Premier',
  'Southwest Rapid Rewards Priority',
  'United Explorer',
  'United Quest',
  'United Club Infinite',
  'World of Hyatt',
  'IHG One Rewards Premier',
  'Marriott Bonvoy Boundless',
  'Marriott Bonvoy Bold',
  'Marriott Bonvoy Bevy',
  // Amex
  'American Express Gold Card',
  'American Express Platinum Card',
  'American Express Green Card',
  'Blue Cash Preferred',
  'Blue Cash Everyday',
  'Blue Business Cash',
  'Blue Business Plus',
  'Delta SkyMiles Gold',
  'Delta SkyMiles Platinum',
  'Delta SkyMiles Reserve',
  'Delta SkyMiles Blue',
  'Hilton Honors American Express Card',
  'Hilton Honors Surpass',
  'Hilton Honors Aspire',
  'Marriott Bonvoy American Express',
  // Capital One
  'Capital One Venture X',
  'Capital One Venture Rewards',
  'Capital One VentureOne',
  'Capital One Savor Cash Rewards',
  'Capital One SavorOne Cash Rewards',
  'Capital One Quicksilver Cash Rewards',
  'Capital One QuicksilverOne Cash Rewards',
  'Capital One Platinum',
  'Capital One Platinum Secured',
  // Citi
  'Citi Strata Premier Card',
  'Citi Double Cash Card',
  'Citi Custom Cash Card',
  'Citi Rewards+ Card',
  'Citi Diamond Preferred Card',
  'Citi Simplicity Card',
  'Citi Secured Mastercard',
  'Citi AAdvantage Platinum Select',
  'Citi AAdvantage MileUp',
  'Citi AAdvantage Executive',
  // US Bank
  'U.S. Bank Altitude Reserve Visa',
  'U.S. Bank Altitude Go Visa',
  'U.S. Bank Altitude Connect Visa',
  'U.S. Bank Cash+ Visa',
  'U.S. Bank Shopper Cash Rewards Visa',
  'U.S. Bank Secured Visa',
  'U.S. Bank Business Altitude Power',
];

/**
 * If `name` is a truncated prefix of a known card name, return the full name.
 * Otherwise return `name` unchanged.
 */
function normalizeCardName(name) {
  const normalized = name.replace(/®/g, '').trim();
  for (const known of KNOWN_CARD_NAMES) {
    if (
      known.toLowerCase().startsWith(normalized.toLowerCase()) ||
      normalized.toLowerCase().startsWith(known.toLowerCase().slice(0, normalized.length))
    ) {
      // Only use the known name if our truncated string is a reasonable prefix
      // (at least 60% of the known name length)
      if (normalized.length >= known.length * 0.6) {
        return known;
      }
    }
  }
  return normalized;
}

// ─── Apply Now splitter (works well for Discover, Chase, Capital One) ─────────

/**
 * Splits PDF text into card blocks by finding "Apply Now" anchors.
 * The card name is typically 1-4 lines before "Apply Now".
 * The block content runs until the next "Apply Now".
 *
 * @param {string} text
 * @returns {Array<{ name: string, block: string }>}
 */
function applyNowSplitCards(text) {
  const lines = text.split('\n').map((l) => l.trim());
  const applyNowIndices = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^apply now\b/i.test(lines[i])) {
      applyNowIndices.push(i);
    }
  }

  if (!applyNowIndices.length) return [];

  const results = [];
  const seen = new Set();

  for (let a = 0; a < applyNowIndices.length; a++) {
    const applyIdx = applyNowIndices[a];
    const nextApplyIdx = applyNowIndices[a + 1] ?? lines.length;

    // Scan back up to 6 lines to find the card name
    // Card name: Title-cased, contains "Card" OR known card product keywords, not a URL
    let name = null;
    for (let back = 1; back <= 6; back++) {
      const candidate = lines[applyIdx - back];
      if (!candidate) continue;
      if (/https?:\/\/|^\/|srcCde=|adobe_mc=|\(https/.test(candidate)) continue;
      if (candidate.length < 6) continue;
      const hasCardWord = /\b(card|miles|cash back|rewards?|points|platinum|sapphire|venture|freedom|quicksilver|savor|altitude|strata|double cash|ink|delta|hilton|marriott|united|southwest|aeroplan|hyatt|ihg)\b/i.test(candidate);
      if (hasCardWord && /^[A-Z]/.test(candidate) && !candidate.endsWith('%')) {
        if (!name) name = candidate;
      }
    }

    if (!name) continue;

    // Clean name: remove trailing URL artifacts e.g. "(https://..."
    name = name.replace(/\s*\(https?:\/\/.*$/, '').replace(/®/g, '').trim();
    // Expand truncated names using known product dictionary
    name = normalizeCardName(name);
    const nameKey = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (seen.has(nameKey)) continue;
    seen.add(nameKey);

    // Build the text block for this card (from a few lines before Apply Now to next Apply Now)
    const blockStart = Math.max(0, applyIdx - 8);
    const blockLines = lines.slice(blockStart, Math.min(nextApplyIdx, applyIdx + 25));
    const block = blockLines.join('\n');

    results.push({ name, block });
  }

  // Return as plain strings prefixed with the name (compatible with parseCards block format)
  return results.map(({ name, block }) => `${name}\n${block}`);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Parse raw PDF text into an array of card objects.
 *
 * @param {string} text          - raw text extracted from PDF
 * @param {string} issuer        - e.g. 'Chase', 'American Express'
 * @param {object} [opts]
 * @param {string}   [opts.listingUrl]    - fallback applyUrl
 * @param {Function} [opts.splitCards]    - custom block splitter (text) => string[]
 * @param {Function} [opts.extractName]   - custom name extractor (block) => string|null
 * @returns {Array<object>}
 */
function parseCards(text, issuer, opts = {}) {
  const {
    listingUrl = '',
    splitCards = defaultSplitCards,
    extractName = null,
  } = opts;

  const blocks = splitCards(text);
  if (!blocks.length) return [];

  const cards = [];
  const seen = new Set();

  for (const block of blocks) {
    const firstLine = block.split('\n')[0].trim();
    const name = extractName ? extractName(block) : firstLine;
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    const annualFee = parseAnnualFee(block) ?? 0;
    const rewardRate = parseRewardRate(block);
    const rewardCategories = parseRewardCategories(block);
    const welcomeBonus = parseWelcomeBonus(block);
    const apr = parseApr(block);

    // Try to find an apply URL in the block (pdf-parse sometimes preserves link text)
    const urlMatch = block.match(/https?:\/\/[^\s"'<>]+/);
    const applyUrl = urlMatch ? urlMatch[0] : listingUrl;

    cards.push({
      id: slugify(`${issuer}-${name}`),
      name,
      issuer,
      type: inferType(name, issuer),
      rewardRate,
      rewardCategories,
      welcomeBonus,
      annualFee,
      apr,
      creditScore: inferCreditScore(name),
      benefits: [],
      applyUrl,
      scrapedAt: new Date().toISOString(),
    });
  }

  return cards;
}

export {
  parseCards,
  parseAnnualFee,
  parseRewardRate,
  parseRewardCategories,
  parseApr,
  parseWelcomeBonus,
  inferType,
  inferCreditScore,
  slugify,
  defaultSplitCards,
  applyNowSplitCards,
  normalizeCardName,
  KNOWN_CARD_NAMES,
};
