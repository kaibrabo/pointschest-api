import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

import scrapeAmex from './scrapers/amex.js';
import scrapeCapitalOne from './scrapers/capitalOne.js';
import scrapeChase from './scrapers/chase.js';
import scrapeCiti from './scrapers/citi.js';
import scrapeUsBank from './scrapers/usBank.js';
import scrapeDiscover from './scrapers/discover.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FILE = path.join(__dirname, '..', 'data', 'cards.json');

// ─── Error classification ─────────────────────────────────────────────────────

const BLOCK_SIGNALS = [
  /403/i,
  /429/i,
  /access denied/i,
  /blocked/i,
  /captcha/i,
  /robot/i,
  /bot detection/i,
  /cloudflare/i,
  /just a moment/i,     // Cloudflare challenge page
  /ddos.protection/i,
  /rate limit/i,
  /too many requests/i,
  /forbidden/i,
  /unavailable for legal reasons/i,
  /incapsula/i,
  /perimeter/i,
  /distil/i,            // Distil Networks bot protection
  /akamai/i,
];

function classifyError(err) {
  const msg = (err.message || '').toLowerCase();
  const isBlock = BLOCK_SIGNALS.some((re) => re.test(msg));
  if (isBlock) return 'blocked';

  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('net::err') || msg.includes('navigation')) return 'network';
  if (msg.includes('selector') || msg.includes('locator') || msg.includes('waiting for')) return 'parse';
  return 'unknown';
}

// ─── Block/challenge detection on a live page ─────────────────────────────────

async function detectBlock(page) {
  const title = (await page.title().catch(() => '')).toLowerCase();

  // Use locator API instead of page.evaluate — avoids Amex "eval is disabled" crash
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
  const snippet = bodyText.slice(0, 500).toLowerCase();

  const signals = [
    { pattern: /just a moment/i, reason: 'Cloudflare challenge page detected' },
    { pattern: /access denied/i, reason: 'Access denied by server' },
    { pattern: /captcha/i, reason: 'CAPTCHA challenge detected' },
    { pattern: /robot/i, reason: 'Bot detection triggered' },
    { pattern: /403/i, reason: 'HTTP 403 Forbidden' },
    { pattern: /429/i, reason: 'HTTP 429 Too Many Requests' },
    { pattern: /blocked/i, reason: 'Request blocked by issuer' },
    { pattern: /verify you are human/i, reason: 'Human verification required' },
    { pattern: /enable javascript/i, reason: 'JS-gating: bot fingerprint likely detected' },
  ];

  for (const { pattern, reason } of signals) {
    if (pattern.test(title) || pattern.test(snippet)) {
      return reason;
    }
  }

  return null;
}

// ─── Browser factory ──────────────────────────────────────────────────────────

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

async function newStealthContext(browser) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Remove webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return context;
}

// ─── Per-issuer runner ────────────────────────────────────────────────────────

async function runScraper(name, scraperFn, browser) {
  const startedAt = new Date().toISOString();
  console.log(`[scraper] Starting: ${name}`);

  let context;
  try {
    context = await newStealthContext(browser);
    const page = await context.newPage();

    // Intercept known analytics/tracking requests to speed up page loads
    await page.route(/google-analytics|doubleclick|facebook|hotjar|tealium|optimizely/, (route) =>
      route.abort()
    );

    const cards = await scraperFn(page, { detectBlock });

    const finishedAt = new Date().toISOString();
    console.log(`[scraper] Done: ${name} — ${cards.length} card(s) found`);

    return {
      issuer: name,
      status: 'success',
      cardCount: cards.length,
      startedAt,
      finishedAt,
      error: null,
      cards,
    };
  } catch (err) {
    const errorType = classifyError(err);
    const finishedAt = new Date().toISOString();

    const advice = {
      blocked:
        'Issuer is blocking headless browsers. Consider: rotating user-agents, adding delays, using residential proxies, or checking if a public API/JSON feed is available.',
      timeout:
        'Page load timed out. The issuer site may be slow or require JS interaction before content appears.',
      network:
        'Network error. Check connectivity or whether the target URL has changed.',
      parse:
        'DOM selectors failed — the issuer likely updated their page layout. Selectors need updating.',
      unknown:
        'Unexpected error. See errorMessage for details.',
    };

    console.error(`[scraper] FAILED: ${name} [${errorType}] — ${err.message}`);

    return {
      issuer: name,
      status: 'failed',
      errorType,
      errorMessage: err.message,
      advice: advice[errorType],
      startedAt,
      finishedAt,
      cards: [],
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

async function runAllScrapers() {
  const startedAt = new Date().toISOString();
  console.log(`\n[scraper] === Run started at ${startedAt} ===`);

  const scrapers = [
    { name: 'American Express', fn: scrapeAmex },
    { name: 'Capital One', fn: scrapeCapitalOne },
    { name: 'Chase', fn: scrapeChase },
    { name: 'Citi', fn: scrapeCiti },
    { name: 'US Bank', fn: scrapeUsBank },
    { name: 'Discover', fn: scrapeDiscover },
  ];

  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    const msg = `Failed to launch browser: ${err.message}`;
    console.error(`[scraper] ${msg}`);
    return { error: msg, startedAt, finishedAt: new Date().toISOString() };
  }

  // Run all scrapers in parallel — one failure never blocks others
  const results = await Promise.all(
    scrapers.map(({ name, fn }) => runScraper(name, fn, browser))
  );

  await browser.close().catch(() => {});

  // Collate cards from successful scrapers only
  const allCards = results.flatMap((r) => r.cards);
  const issuerSummary = results.map(({ cards, ...rest }) => rest); // strip cards from summary

  const finishedAt = new Date().toISOString();

  const payload = {
    lastScrapedAt: finishedAt,
    startedAt,
    finishedAt,
    totalCards: allCards.length,
    issuers: issuerSummary,
    cards: allCards,
  };

  // Persist to disk
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
    console.log(`[scraper] Wrote ${allCards.length} cards to ${DATA_FILE}`);
  } catch (err) {
    console.error(`[scraper] Failed to write data file: ${err.message}`);
  }

  // Log summary
  const succeeded = results.filter((r) => r.status === 'success').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  console.log(
    `[scraper] === Run complete: ${succeeded} succeeded, ${failed} failed. Total cards: ${allCards.length} ===\n`
  );

  if (failed > 0) {
    console.warn('[scraper] Failed issuers:');
    results
      .filter((r) => r.status === 'failed')
      .forEach((r) =>
        console.warn(`  • ${r.issuer}: [${r.errorType}] ${r.errorMessage}`)
      );
  }

  return payload;
}

export { runAllScrapers };
