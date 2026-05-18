require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');

const { upsertUser, getUserByEmail, setUserChatId, cancelUserByChatId, cancelUserByStripe } = require('./src/database');
const { scrapeListings, markListingsAsSent, normaliseCity } = require('./src/scraper');
const { findMatches } = require('./src/matcher');
const { createBot, sendAlert, processWebhookUpdate } = require('./src/telegram');
const { createCheckoutSession, handleWebhook, cancelSubscription } = require('./src/stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/filters', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'filters.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

// Stripe Checkout — NO bypass, always requires Stripe
app.get('/subscribe', async (req, res) => {
  if (!process.env.STRIPE_PRICE_ID || !process.env.STRIPE_SECRET_KEY) {
    return res.status(500).send('Stripe is not configured. Contact support.');
  }
  try {
    const session = await createCheckoutSession(
      `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      `${BASE_URL}/?cancelled=1`
    );
    res.redirect(303, session.url);
  } catch (err) {
    console.error('[stripe] Checkout error:', err.message);
    res.status(500).send('Error creating checkout session. Please try again.');
  }
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

app.post('/api/filters', async (req, res) => {
  try {
    const b = req.body;
    const chatId = String(b.chat_id || '').trim();
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });

    upsertUser.run({
      chat_id: chatId,
      naam: b.naam || '',
      email: b.email || '',
      profiel_type: b.profiel_type || '',
      expat_status: b.expat_status || '',
      contract_type: b.contract_type || '',
      inkomen: parseFloat(b.inkomen) || 0,
      application_readiness: b.application_readiness || b.document_readiness || 'niet',
      beschikbaarheid_timing: b.beschikbaarheid_timing || 'flexibel',
      type: b.type || 'beide',
      woningtype: b.woningtype || 'alle',
      locatie: normaliseCity(b.locatie || ''),
      prijs_min: parseFloat(b.prijs_min) || 0,
      prijs_max: parseFloat(b.prijs_max) || null,
      opp_min: parseFloat(b.opp_min) || 0,
      kamers_min: parseInt(b.kamers_min) || 1,
      energielabel: b.energielabel || 'geen',
      bouwjaar_min: parseInt(b.bouwjaar_min) || null,
      tuin: b.tuin === 'true' || b.tuin === true ? 1 : 0,
      parkeren: b.parkeren === 'true' || b.parkeren === true ? 1 : 0,
      delen_toegestaan: b.delen_toegestaan === 'true' || b.delen_toegestaan === true ? 1 : 0,
      huisdieren: b.huisdieren === 'true' || b.huisdieren === true ? 1 : 0,
      gemeubileerd: b.gemeubileerd === 'true' || b.gemeubileerd === true ? 1 : 0,
      beschikbaar_per: b.beschikbaar_per || null,
      kans_min: parseInt(b.kans_min) || 0,
      deal_min: parseInt(b.deal_min) || 0,
      met_partner: b.met_partner || 'nee',
      partner_inkomen: parseFloat(b.partner_inkomen) || 0,
      heeft_borg: b.heeft_borg || 'nee',
    });

    if (b.email) {
      setUserChatId.run(chatId, b.email);
    }

    res.json({ success: true, message: 'Filters saved! You will start receiving alerts.' });
  } catch (err) {
    console.error('[api/filters] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/webhook/telegram', (req, res) => {
  processWebhookUpdate(req.body);
  res.sendStatus(200);
});

app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const type = await handleWebhook(req.body, sig);
    console.log(`[stripe] Webhook handled: ${type}`);
    res.json({ received: true });
  } catch (err) {
    console.error('[stripe] Webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.get('/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cancel.html'));
});

app.post('/api/cancel', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = getUserByEmail.get(email.trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account found with that email address' });

  try {
    if (user.stripe_subscription_id) {
      await cancelSubscription(user.stripe_subscription_id);
    }
    if (user.chat_id) {
      cancelUserByChatId.run(user.chat_id);
    } else {
      cancelUserByStripe.run(user.stripe_customer_id || '');
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[cancel] Error:', err.message);
    res.status(500).json({ error: 'Failed to cancel subscription. Please contact homeseeker@gmail.com' });
  }
});

app.get('/how-scores-work', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'how-scores-work.html'));
});

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

async function runScrapeAndAlert() {
  console.log(`[cron] Starting scrape cycle at ${new Date().toISOString()}`);
  try {
    const listings = await scrapeListings();
    if (!listings.length) return;

    const matches = findMatches(listings);
    console.log(`[cron] Found ${matches.length} matches to alert`);

    for (const { listing, user, score, label, dealScore, dealLabel } of matches) {
      await sendAlert(user.chat_id, listing, score, label, dealScore, dealLabel, user);
      await new Promise(r => setTimeout(r, 200));
    }

    markListingsAsSent(listings.map(l => l.url));
  } catch (err) {
    console.error('[cron] Error:', err.message);
  }
}

const useWebhook = IS_PRODUCTION && !!process.env.TELEGRAM_BOT_TOKEN;
createBot(useWebhook);

if (useWebhook) {
  const TelegramBot = require('node-telegram-bot-api');
  const tmpBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  tmpBot.setWebHook(`${BASE_URL}/webhook/telegram`).then(() => {
    console.log(`[telegram] Webhook set to ${BASE_URL}/webhook/telegram`);
  }).catch(console.error);
}

app.listen(PORT, () => {
  console.log(`[server] HomeSeeker running on port ${PORT}`);
  console.log(`[server] Base URL: ${BASE_URL}`);
});

setTimeout(() => {
  cron.schedule('*/10 * * * *', runScrapeAndAlert);
  console.log('[cron] Scrape job scheduled every 10 minutes');
}, 5000);
