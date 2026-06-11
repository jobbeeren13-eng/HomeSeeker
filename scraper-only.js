require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { scrapeListings, markListingsAsSent, rowToListing } = require('./src/scraper');
const { findMatches, findMatchesForUser } = require('./src/matcher');
const { getRecentListings } = require('./src/database');
const { sendAlert } = require('./src/telegram');

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://homeseeker.dev';
const ADMIN_KEY   = process.env.ADMIN_KEY;
const { generateLetterDirect, getAITip } = require('./src/letter');
const PORT        = parseInt(process.env.MATCH_NOW_PORT || '3001', 10);

const REQUIRED_VARS = ['TELEGRAM_BOT_TOKEN', 'RAILWAY_URL', 'ADMIN_KEY'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

// ── Shared alert sender (cron + match-now) ────────────────────────────────
async function dispatchAlerts(matches) {
  const sentUrls = [];
  for (const { listing: rawListing, user, score, label, dealScore, dealLabel } of matches) {
    try {
      // Inject AI tip for listings with rich descriptions (cached 48h, fails silently)
      let listing = rawListing;
      if (rawListing.description && rawListing.description.length >= 200) {
        const aiTip = await getAITip(rawListing, user);
        if (aiTip) listing = { ...rawListing, aiTip };
      }

      const cacheId = await sendAlert(user.chat_id, listing, score, label, dealScore, dealLabel, user, bot);
      sentUrls.push(listing.url);
      if (cacheId) {
        fetch(`${RAILWAY_URL}/api/cache-listing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
          body: JSON.stringify({ id: cacheId, listing }),
        }).then(r => {
          if (!r.ok) console.warn(`[dispatch] cache-listing HTTP ${r.status} for cacheId=${cacheId} url=${RAILWAY_URL}`);
        }).catch(err => console.warn('[dispatch] cache-listing network error:', err.message));
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error('[dispatch] Alert failed:', err.message);
    }
  }
  return sentUrls;
}

// ── Cron: full scrape + match all users every 30 min ─────────────────────
let isRunning = false;

async function runScrapeAndAlert() {
  if (isRunning) {
    console.warn('[cron] Previous cycle still running — skipping this tick');
    return;
  }
  isRunning = true;
  console.log(`[cron] Starting scrape cycle at ${new Date().toISOString()}`);
  try {
    const listings = await scrapeListings();
    if (!listings.length) { console.log('[cron] No new listings'); return; }

    const matches = await findMatches(listings);
    console.log(`[cron] Found ${matches.length} matches`);
    if (!matches.length) return;

    const sentUrls = await dispatchAlerts(matches);
    if (sentUrls.length) markListingsAsSent(sentUrls);
    const srcCount = {};
    for (const l of listings) srcCount[l.source] = (srcCount[l.source] || 0) + 1;
    const srcStr = Object.entries(srcCount).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
    console.log(`[cron] Sent ${sentUrls.length} alerts | new: ${srcStr} | matches: ${matches.length}`);
  } catch (err) {
    console.error('[cron] Error:', err.message);
  } finally {
    isRunning = false;
  }
}

// ── Express server: POST /api/match-now for immediate post-filter alerts ──
const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.post('/api/match-now', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { chat_id } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });

  res.json({ ok: true, queued: true });

  // Run in background — don't block the HTTP response
  setImmediate(async () => {
    try {
      const rows = getRecentListings.all();
      const listings = rows.map(rowToListing);
      console.log(`[match-now] ${listings.length} recent listings for chat_id=${chat_id}`);
      if (!listings.length) return;

      const matches = await findMatchesForUser(listings, String(chat_id));
      console.log(`[match-now] ${matches.length} matches for chat_id=${chat_id}`);
      if (!matches.length) return;

      // Note: do NOT call markListingsAsSent here — these listings may already
      // be globally sent; we only track per-user via sent_listings (done inside findMatchesForUser)
      await dispatchAlerts(matches);
    } catch (err) {
      console.error(`[match-now] Error for chat_id=${chat_id}:`, err.message);
    }
  });
});

// Letter generation proxy — Railway calls this so ANTHROPIC_API_KEY only needs to be on Hetzner
app.post('/api/generate-letter', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { listing, user, selectedTips } = req.body;
  if (!listing) return res.status(400).json({ error: 'listing required' });
  try {
    const letter = await generateLetterDirect({ listing, user: user || {}, selectedTips: selectedTips || [] });
    res.json({ letter });
  } catch (err) {
    console.error('[generate-letter] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`[match-now] Listening on port ${PORT}`));

// ── Boot: run once immediately then on schedule ───────────────────────────
(async () => {
  await new Promise(r => setTimeout(r, 2000));
  cron.schedule('*/30 * * * *', runScrapeAndAlert);
  console.log('[cron] Scraper running every 30 minutes');
  await runScrapeAndAlert();
})();
