require('dotenv').config();

// After an uncaughtException/unhandledRejection the process is in an undefined state —
// continuing to run (as this previously did, log-only) can silently corrupt state and prevents
// pm2 from ever restarting us into a clean process, since that only triggers on actual exit.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  process.exit(1);
});

const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { scrapeListings, markListingsAsSent, rowToListing, setAdminBot } = require('./src/scraper');
const { findMatches, findMatchesForUser } = require('./src/matcher');
const { getRecentListings, markListingSent, insertScraperStat } = require('./src/database');
const { sendAlert } = require('./src/telegram');

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://homeseeker.dev';
const ADMIN_KEY   = process.env.ADMIN_KEY;
const { generateLetterDirect, getAITip, generateFirstContactMessage, generateBuyerLetterDirect, generateLeaseReviewDirect, generateNegotiateDirect, generateRentAssistantResponse, generateBuyAssistantResponse, modifyLetterDirect, generateLandlordReplyDirect, generateRejectionAnalysisDirect, generateReferenceLetterDirect, generateIncomeExplainDirect, generateViewingFeedbackDirect, generateTenantRightsAnswerDirect, generateDealExplainDirect, generateOverbidLetterDirect, generateInspectionAdviceDirect, generateErfpachtAnalysisDirect, generateAgentScriptDirect, generateSupportChatDirect } = require('./src/letter');
const PORT        = parseInt(process.env.MATCH_NOW_PORT || '3001', 10);

const REQUIRED_VARS = ['TELEGRAM_BOT_TOKEN', 'RAILWAY_URL', 'ADMIN_KEY'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
setAdminBot(bot);

// ── Scraper health monitoring ─────────────────────────────────────────────
const scraperHealth = {
  lastRunAt: null,
  lastSuccessfulRunAt: null,
  lastRunListings: 0,
  consecutiveZeroRuns: 0,
};

async function sendAdminAlert(msg) {
  const chatId = process.env.ADMIN_CHAT_ID;
  if (!chatId) return;
  try {
    await bot.sendMessage(chatId, `*HomeSeeker Alert*\n\n${msg}`, { parse_mode: 'Markdown' });
  } catch (e) { console.error('[watchdog] Admin alert failed:', e.message); }
}

// Watchdog: alert if scraper stalls or returns zero listings repeatedly
setInterval(async () => {
  if (!scraperHealth.lastRunAt) return;
  if (Date.now() - scraperHealth.lastRunAt > 90 * 60 * 1000) {
    await sendAdminAlert(`Scraper has not completed a cycle in >90 minutes.\nLast run: ${new Date(scraperHealth.lastRunAt).toISOString()}`);
  } else if (scraperHealth.consecutiveZeroRuns >= 6) {
    await sendAdminAlert(`${scraperHealth.consecutiveZeroRuns} consecutive cycles returned zero listings.\nLast run: ${new Date(scraperHealth.lastRunAt).toISOString()}`);
  }
}, 30 * 60 * 1000);

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

      const { cacheId, sent } = await sendAlert(user.chat_id, listing, score, label, dealScore, dealLabel, user, bot);
      if (sent) {
        sentUrls.push(listing.url);
        markListingSent.run(listing.url, user.chat_id);
      }
      if (cacheId && sent) {
        fetch(`${RAILWAY_URL}/api/cache-listing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
          body: JSON.stringify({ id: cacheId, listing, chat_id: user.chat_id }),
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
  scraperHealth.lastRunAt = Date.now();
  const cycleStart = Date.now();
  console.log(`[cron] Starting scrape cycle at ${new Date().toISOString()}`);
  try {
    const listings = await scrapeListings();
    if (!listings.length) {
      scraperHealth.consecutiveZeroRuns++;
      scraperHealth.lastRunListings = 0;
      console.log('[cron] No new listings');
      return;
    }
    scraperHealth.consecutiveZeroRuns = 0;
    scraperHealth.lastSuccessfulRunAt = Date.now();
    scraperHealth.lastRunListings = listings.length;

    const matches = await findMatches(listings);
    console.log(`[cron] Found ${matches.length} matches`);
    if (!matches.length) {
      const srcCount = {};
      for (const l of listings) srcCount[l.source] = (srcCount[l.source] || 0) + 1;
      for (const [src, count] of Object.entries(srcCount)) {
        try { insertScraperStat.run(src, count, 0, Date.now() - cycleStart, Date.now()); } catch (_) {}
      }
      return;
    }

    const sentUrls = await dispatchAlerts(matches);
    if (sentUrls.length) markListingsAsSent(sentUrls);
    const srcCount = {};
    for (const l of listings) srcCount[l.source] = (srcCount[l.source] || 0) + 1;
    const srcStr = Object.entries(srcCount).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
    console.log(`[cron] Sent ${sentUrls.length} alerts | new: ${srcStr} | matches: ${matches.length}`);
    const cycleMs = Date.now() - cycleStart;
    for (const [src, count] of Object.entries(srcCount)) {
      const srcAlerts = sentUrls.filter(u => matches.find(m => m.listing.url === u && m.listing.source === src)).length;
      try { insertScraperStat.run(src, count, srcAlerts, cycleMs, Date.now()); } catch (_) {}
    }
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

// Off-site copy of Railway's daily SQLite backup — this Hetzner VPS is a separate machine and
// provider from Railway's volume, so a copy here survives a Railway volume incident. Raw-body
// route (not the global express.json() above) since the payload is a binary .db file, not JSON.
// Keeps only the most recent BACKUP_RETENTION_COUNT copies to bound disk usage.
const BACKUP_DIR = path.join(__dirname, 'offsite-backups');
const BACKUP_RETENTION_COUNT = 7;
app.post('/api/backup-upload', express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty body' });
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const filename = `homeseeker_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    fs.writeFileSync(path.join(BACKUP_DIR, filename), req.body);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('homeseeker_backup_')).sort();
    while (files.length > BACKUP_RETENTION_COUNT) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch (_) {}
    }
    console.log(`[backup-upload] Received off-site backup: ${filename} (${req.body.length} bytes)`);
    res.json({ ok: true, filename, bytes: req.body.length });
  } catch (err) {
    console.error('[backup-upload] Failed to save backup:', err.message);
    res.status(500).json({ error: 'Failed to save backup' });
  }
});

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

// First contact message proxy
app.post('/api/generate-first-contact', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { listing, user, extraContext } = req.body;
  if (!listing) return res.status(400).json({ error: 'listing required' });
  try {
    const result = await generateFirstContactMessage({ listing, user: user || {}, extraContext: extraContext || '' });
    res.json(result);
  } catch (err) {
    console.error('[generate-first-contact] Error:', err);
    res.status(500).json({ error: 'Internal error. Check server logs.' });
  }
});

// Letter generation proxy — Railway calls this so ANTHROPIC_API_KEY only needs to be on Hetzner
app.post('/api/generate-letter', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { listing, user, selectedTips, tone, intelligenceContext } = req.body;
  if (!listing) return res.status(400).json({ error: 'listing required' });
  try {
    const result = await generateLetterDirect({ listing, user: user || {}, selectedTips: selectedTips || [], tone: tone || 'professional', intelligenceContext: intelligenceContext || '' });
    res.json({ letter: result.letter });
  } catch (err) {
    console.error('[generate-letter] Error:', err);
    res.status(500).json({ error: 'Internal error. Check server logs.' });
  }
});

// Package generation proxy — same reason: ANTHROPIC_API_KEY lives only on Hetzner
app.post('/api/generate-package', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { listing, user, extraContext } = req.body;
  if (!listing) return res.status(400).json({ error: 'listing required' });
  try {
    const { generatePackageDirect } = require('./src/letter');
    const pkg = await generatePackageDirect({ listing, user: user || {}, extraContext: extraContext || '' });
    res.json(pkg);
  } catch (err) {
    console.error('[generate-package] Error:', err);
    res.status(500).json({ error: 'Internal error. Check server logs.' });
  }
});

// Buyer letter generation proxy
app.post('/api/generate-buyer-letter', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext } = req.body;
  if (!houseAddress) return res.status(400).json({ error: 'houseAddress required' });
  try {
    const letter = await generateBuyerLetterDirect({ houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext });
    res.json({ letter });
  } catch (err) {
    console.error('[generate-buyer-letter] Error:', err);
    res.status(500).json({ error: 'Internal error. Check server logs.' });
  }
});

// Lease review generation proxy
app.post('/api/generate-lease-review', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { leaseText, context } = req.body;
  try {
    const result = await generateLeaseReviewDirect({ leaseText, context });
    res.json(result);
  } catch (err) {
    console.error('[generate-lease-review] Error:', err);
    res.status(500).json({ error: 'Internal error. Check server logs.' });
  }
});

// Negotiation coach generation proxy
app.post('/api/generate-negotiate', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { goal, property, situation, extraContext } = req.body;
  try {
    const result = await generateNegotiateDirect({ goal, property, situation, extraContext });
    res.json(result);
  } catch (err) {
    console.error('[generate-negotiate] Error:', err);
    res.status(500).json({ error: 'Internal error. Check server logs.' });
  }
});

// Rental assistant proxy
app.post('/api/generate-rent-assistant', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { tab, userMessage, user, listingContext } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'userMessage required' });
  try {
    const result = await generateRentAssistantResponse({ tab, userMessage, user, listingContext });
    res.json(result);
  } catch (err) {
    console.error('[generate-rent-assistant] Error:', err);
    res.status(500).json({ error: 'Internal error. Check server logs.' });
  }
});

// Buyer assistant proxy
app.post('/api/generate-buy-assistant', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { tab, userMessage, user, listingContext } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'userMessage required' });
  try {
    const result = await generateBuyAssistantResponse({ tab, userMessage, user, listingContext });
    res.json(result);
  } catch (err) {
    console.error('[generate-buy-assistant] Error:', err);
    res.status(500).json({ error: 'Internal error. Check server logs.' });
  }
});

// Letter modification proxy
app.post('/api/modify-letter', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { letter, instruction } = req.body;
  if (!letter || !instruction) return res.status(400).json({ error: 'letter and instruction required' });
  try {
    const modified = await modifyLetterDirect({ letter, instruction });
    res.json({ letter: modified });
  } catch (err) {
    console.error('[modify-letter] Error:', err);
    res.status(500).json({ error: 'Internal error. Check server logs.' });
  }
});

// New tool proxies
app.post('/api/generate-landlord-reply', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { message, userProfile } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try { res.json(await generateLandlordReplyDirect({ message, userProfile: userProfile || {} })); }
  catch (err) { console.error('[generate-landlord-reply]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-rejection-analysis', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { applications, userProfile, outcomeHistory } = req.body;
  if (!applications) return res.status(400).json({ error: 'applications required' });
  try { res.json(await generateRejectionAnalysisDirect({ applications, userProfile: userProfile || {}, outcomeHistory: outcomeHistory || [] })); }
  catch (err) { console.error('[generate-rejection-analysis]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-reference-letter', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { type, details } = req.body;
  if (!type || !details) return res.status(400).json({ error: 'type and details required' });
  try { res.json(await generateReferenceLetterDirect({ type, details })); }
  catch (err) { console.error('[generate-reference-letter]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-income-explain', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { income, rent, situation } = req.body;
  if (!income || !rent) return res.status(400).json({ error: 'income and rent required' });
  try { res.json(await generateIncomeExplainDirect({ income, rent, situation: situation || '' })); }
  catch (err) { console.error('[generate-income-explain]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-viewing-feedback', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { viewingNotes, userProfile } = req.body;
  if (!viewingNotes) return res.status(400).json({ error: 'viewingNotes required' });
  try { res.json(await generateViewingFeedbackDirect({ viewingNotes, userProfile: userProfile || {} })); }
  catch (err) { console.error('[generate-viewing-feedback]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-tenant-rights', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  try { res.json(await generateTenantRightsAnswerDirect({ question })); }
  catch (err) { console.error('[generate-tenant-rights]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-deal-explain', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { dealData } = req.body;
  if (!dealData) return res.status(400).json({ error: 'dealData required' });
  try { res.json(await generateDealExplainDirect({ dealData })); }
  catch (err) { console.error('[generate-deal-explain]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-overbid-letter', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { bidDetails, userProfile } = req.body;
  if (!bidDetails) return res.status(400).json({ error: 'bidDetails required' });
  try { res.json(await generateOverbidLetterDirect({ bidDetails, userProfile: userProfile || {} })); }
  catch (err) { console.error('[generate-overbid-letter]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-inspection-advice', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { inspectionText, purchasePrice } = req.body;
  if (!inspectionText) return res.status(400).json({ error: 'inspectionText required' });
  try { res.json(await generateInspectionAdviceDirect({ inspectionText, purchasePrice: purchasePrice || 0 })); }
  catch (err) { console.error('[generate-inspection-advice]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-erfpacht-analysis', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { erfpachtText, purchasePrice, city } = req.body;
  if (!erfpachtText) return res.status(400).json({ error: 'erfpachtText required' });
  try { res.json(await generateErfpachtAnalysisDirect({ erfpachtText, purchasePrice: purchasePrice || 0, city: city || '' })); }
  catch (err) { console.error('[generate-erfpacht-analysis]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

app.post('/api/generate-agent-script', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { situation, context } = req.body;
  if (!situation) return res.status(400).json({ error: 'situation required' });
  try { res.json(await generateAgentScriptDirect({ situation, context: context || '' })); }
  catch (err) { console.error('[generate-agent-script]', err); res.status(500).json({ error: 'Internal error. Check server logs.' }); }
});

// Support chat — ANTHROPIC_API_KEY lives only on Hetzner, so this endpoint lives here
app.post('/api/support-chat', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const data = await generateSupportChatDirect({ message, history: Array.isArray(history) ? history : [] });
    res.json(data);
  } catch (err) {
    console.error('[support-chat]', err.message);
    res.json({ reply: 'I am having trouble right now. Please email support@homeseeker.dev and we will help you directly.' });
  }
});

app.listen(PORT, () => console.log(`[match-now] Listening on port ${PORT}`));

// ── Boot: run once immediately then on schedule ───────────────────────────
// SHUTDOWN is FAIL-SAFE PAUSED: unless SHUTDOWN=false, the scraping cron and the initial scrape do
// NOT run — so even if pm2 restarts this process (reboot, `pm2 resurrect`), no scraping resumes.
// The Express server above stays up on purpose: it still receives the off-site DB backup
// (/api/backup-upload) and serves the AI generation proxies. To resume scraping: set SHUTDOWN=false.
const SHUTDOWN = String(process.env.SHUTDOWN ?? 'true').toLowerCase() !== 'false';
(async () => {
  if (SHUTDOWN) {
    console.warn('[shutdown] Scraper PAUSED — no cron, no scraping, no alerts. Express server stays up to receive backups. Set SHUTDOWN=false to resume.');
    return;
  }
  await new Promise(r => setTimeout(r, 2000));
  cron.schedule('*/30 * * * *', runScrapeAndAlert);
  console.log('[cron] Scraper running every 30 minutes');
  await runScrapeAndAlert();
})();
