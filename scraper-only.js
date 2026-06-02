require('dotenv').config();
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { scrapeListings, markListingsAsSent } = require('./src/scraper');
const { findMatches } = require('./src/matcher');
const { sendAlert } = require('./src/telegram');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

async function runScrapeAndAlert() {
  console.log(`[cron] Starting scrape cycle at ${new Date().toISOString()}`);
  try {
    const listings = await scrapeListings();
    if (!listings.length) return console.log('[cron] No new listings');
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
  }
}

(async () => {
  await new Promise(r => setTimeout(r, 2000));
  cron.schedule('*/10 * * * *', runScrapeAndAlert);
  console.log('[cron] Scraper running every 10 minutes');
  await runScrapeAndAlert();
})();
