'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { runAllScrapers } = require('./scraper');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, '..', 'data', 'cards.json');

app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readDataFile() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    return null;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /
 * Health check.
 */
app.get('/', (req, res) => {
  res.json({ service: 'pointschest-api', status: 'ok' });
});

/**
 * GET /status
 * Returns last scrape timestamp, card count, and per-issuer scrape results.
 */
app.get('/status', (req, res) => {
  const data = readDataFile();
  if (!data) {
    return res.status(404).json({
      error: 'No scrape data found. Run POST /scrape to seed data.',
    });
  }
  res.json({
    lastScrapedAt: data.lastScrapedAt,
    cardCount: data.cards.length,
    issuers: data.issuers,
  });
});

/**
 * GET /cards
 * Returns all cards from the latest scrape.
 * Query params:
 *   ?issuer=chase
 *   ?type=Travel
 *   ?category=dining  (filters cards that have a rewardCategories entry for that key)
 */
app.get('/cards', (req, res) => {
  const data = readDataFile();
  if (!data) {
    return res.status(404).json({
      error: 'No scrape data found. Run POST /scrape to seed data.',
    });
  }

  let cards = data.cards;
  const { issuer, type, category } = req.query;

  if (issuer) {
    cards = cards.filter(
      (c) => c.issuer.toLowerCase().replace(/\s+/g, '') === issuer.toLowerCase().replace(/\s+/g, '')
    );
  }
  if (type) {
    cards = cards.filter(
      (c) => c.type && c.type.toLowerCase() === type.toLowerCase()
    );
  }
  if (category) {
    cards = cards.filter(
      (c) => c.rewardCategories && c.rewardCategories[category.toLowerCase()] != null
    );
    // Sort by that category's reward rate descending
    cards = cards.sort(
      (a, b) =>
        (b.rewardCategories[category.toLowerCase()] || 0) -
        (a.rewardCategories[category.toLowerCase()] || 0)
    );
  }

  res.json({
    lastScrapedAt: data.lastScrapedAt,
    count: cards.length,
    cards,
  });
});

/**
 * GET /cards/:issuer
 * Convenience alias for GET /cards?issuer=:issuer
 */
app.get('/cards/:issuer', (req, res) => {
  const data = readDataFile();
  if (!data) {
    return res.status(404).json({
      error: 'No scrape data found. Run POST /scrape to seed data.',
    });
  }

  const slug = req.params.issuer.toLowerCase().replace(/\s+/g, '');
  const cards = data.cards.filter(
    (c) => c.issuer.toLowerCase().replace(/\s+/g, '') === slug
  );

  if (!cards.length) {
    return res.status(404).json({
      error: `No cards found for issuer "${req.params.issuer}". Valid issuers: americanexpress, capitalone, chase, citi, usbank, discover`,
    });
  }

  res.json({
    lastScrapedAt: data.lastScrapedAt,
    count: cards.length,
    cards,
  });
});

/**
 * POST /scrape
 * Triggers a manual scrape of all issuers immediately.
 * Returns full results including per-issuer errors.
 */
app.post('/scrape', async (req, res) => {
  console.log('[API] Manual scrape triggered via POST /scrape');
  try {
    const result = await runAllScrapers();
    res.json(result);
  } catch (err) {
    console.error('[API] Scrape failed with unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.path}`,
    availableRoutes: [
      'GET  /',
      'GET  /status',
      'GET  /cards',
      'GET  /cards/:issuer',
      'POST /scrape',
    ],
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[API] pointschest-api running on http://localhost:${PORT}`);
  startScheduler();
});

module.exports = app;
