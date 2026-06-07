require('dotenv').config();
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { scrapeListings, markListingsAsSent } = require('./src/scraper');
const { findMatches } = require('./src/matcher');
const { sendAlert } = require('./src/telegram');

const REQUIRED_VARS = ['TELEGRAM_BOT_TOKEN', 'RAILWAY_URL', 'ADMIN_KEY'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length) {
  console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

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
    if (!listings.length) {
      console.log('[cron] No new listings');
      return;
    }
    const matches = await findMatches(listings);
    console.log(`[cron] Found ${matches.length} matches`);
    if (!matches.length) return;
    const sentUrls = [];
    for (const { listing, user, score, label, dealScore, dealLabel } of matches) {
      try {
        await sendAlert(user.chat_id, listing, score, label, dealScore, dealLabel, user, bot);
        sentUrls.push(listing.url);
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.error('[cron] Failed to send alert:', err.message);
      }
    }
    if (sentUrls.length) markListingsAsSent(sentUrls);
    console.log(`[cron] Sent ${sentUrls.length} alerts`);
  } catch (err) {
    console.error('[cron] Error:', err.message);
  } finally {
    isRunning = false;
  }
}

(async () => {
  await new Promise(r => setTimeout(r, 2000));
  cron.schedule('*/30 * * * *', runScrapeAndAlert);
  console.log('[cron] Scraper running every 30 minutes');
  await runScrapeAndAlert();
})();
