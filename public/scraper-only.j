require('dotenv').config();
const cron = require('node-cron');
const { scrapeListings, markListingsAsSent } = require('./src/scraper');
const { findMatches } = require('./src/matcher');
const { sendAlert } = require('./src/telegram');

async function runScrapeAndAlert() {
  console.log(`[cron] Starting scrape cycle at ${new Date().toISOString()}`);
  try {
    const listings = await scrapeListings();
    if (!listings.length) return console.log('[cron] No new listings');
    const matches = await findMatches(listings);
    console.log(`[cron] Found ${matches.length} matches`);
    for (const { listing, user, score, label, dealScore, dealLabel } of matches) {
      await sendAlert(user.chat_id, listing, score, label, dealScore, dealLabel, user);
      await new Promise(r => setTimeout(r, 200));
    }
    markListingsAsSent(listings.map(l => l.url));
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
