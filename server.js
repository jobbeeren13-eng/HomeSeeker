require('dotenv').config();
const express = require('express');
const path = require('path');

const { db, dbPath, upsertUser, getUserByEmail, getUserByCustomerId, getAllActiveUsers, getUser, setUserChatId, linkChatToCustomer, clearChatIdFromOthers, createUserByCustomerId, cancelUserByChatId, cancelUserByStripe, insertReview, getApprovedReviews, approveReview, getFavorites, addFavorite, removeFavorite, getApplicationTracker, upsertApplicationStatus, removeApplicationStatus } = require('./src/database');
const { sendWelcomeEmail } = require('./src/email');
const { normaliseCity, getScraperHealth, setAdminBot } = require('./src/scraper');
const { createBot, sendAlert, processWebhookUpdate, injectCachedListing, getCachedEntry } = require('./src/telegram');
const { createCheckoutSession, handleWebhook, cancelSubscription } = require('./src/stripe');
const { calculateScore, getImprovementTips } = require('./src/score');
const { calculateDealScore } = require('./src/deal_score');
const { generateLetterDirect, generatePackageDirect, generateBuyerLetterDirect, generateBidAdviceDirect, generateLeaseReviewDirect, generateNegotiateDirect, generateRentAssistantResponse, generateBuyAssistantResponse, modifyLetterDirect, generateLandlordReplyDirect, generateRejectionAnalysisDirect, generateReferenceLetterDirect, generateIncomeExplainDirect, generateViewingFeedbackDirect, generateTenantRightsAnswerDirect, generateDealExplainDirect, generateOverbidLetterDirect, generateInspectionAdviceDirect, generateErfpachtAnalysisDirect, generateAgentScriptDirect } = require('./src/letter');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Simple in-memory rate limiter for /api/filters (10 requests per IP per hour)
const filterRateLimits = new Map();
function checkFilterRateLimit(ip) {
  const now = Date.now();
  const entry = filterRateLimits.get(ip);
  if (!entry || entry.resetAt < now) {
    filterRateLimits.set(ip, { count: 1, resetAt: now + 3600000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}
// Purge stale entries every hour to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of filterRateLimits) { if (e.resetAt < now) filterRateLimits.delete(ip); }
}, 3600000);

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/filters', (req, res) => res.sendFile(path.join(__dirname, 'public', 'filters.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/cancel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cancel.html')));
app.get('/how-scores-work', (req, res) => res.sendFile(path.join(__dirname, 'public', 'how-scores-work.html')));
app.get('/reviews', (req, res) => res.sendFile(path.join(__dirname, 'public', 'review.html')));
app.get('/letter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'letter.html')));
app.get('/apply', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apply.html')));
app.get('/guide/buy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guide', 'buy.html')));
app.get('/guide/rent', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guide', 'rent.html')));
app.get('/tools/buyer-letter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'buyer-letter.html')));
app.get('/tools/mortgage', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'mortgage.html')));
app.get('/tools/bid-advisor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'bid-advisor.html')));
app.get('/tools/legal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'legal.html')));
app.get('/tools/handover', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'handover.html')));
app.get('/tools/lease-review', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'lease-review.html')));
app.get('/tools/negotiate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'negotiate.html')));
app.get('/tools/documents', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'documents.html')));
app.get('/tools/move-in', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'move-in.html')));
app.get('/tools/rent-assistant', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'rent-assistant.html')));
app.get('/tools/buy-assistant', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'buy-assistant.html')));
app.get('/tools/landlord-reply', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'landlord-reply.html')));
app.get('/tools/rejection-analyser', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'rejection-analyser.html')));
app.get('/tools/reference-letter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'reference-letter.html')));
app.get('/tools/income-check', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'income-check.html')));
app.get('/tools/viewing-feedback', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'viewing-feedback.html')));
app.get('/tools/tenant-rights', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'tenant-rights.html')));
app.get('/tools/deal-finder', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'deal-finder.html')));
app.get('/tools/overbid-calculator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'overbid-calculator.html')));
app.get('/tools/inspection-advisor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'inspection-advisor.html')));
app.get('/tools/erfpacht-checker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'erfpacht-checker.html')));
app.get('/tools/agent-scripts', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'agent-scripts.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

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

app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

app.post('/api/filters', async (req, res) => {
  const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!checkFilterRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests - please wait before submitting again' });
  }
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
      user_description: (b.user_description || '').trim().slice(0, 200),
      move_reason: (b.move_reason || '').trim().slice(0, 200),
      tenant_quality: (b.tenant_quality || '').trim().slice(0, 200),
    });

    if (b.email) setUserChatId.run(chatId, b.email);

    // Notify Hetzner scraper to immediately match this user against recent listings
    const hetznerUrl = process.env.HETZNER_URL;
    if (hetznerUrl && chatId) {
      fetch(`${hetznerUrl}/api/match-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY },
        body: JSON.stringify({ chat_id: chatId }),
      }).catch(err => console.warn('[filters] match-now notify failed:', err.message));
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

app.post('/api/cancel', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const user = getUserByEmail.get(email.trim().toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account found with that email address' });
  try {
    if (user.stripe_subscription_id) await cancelSubscription(user.stripe_subscription_id);
    if (user.chat_id) cancelUserByChatId.run(user.chat_id);
    else cancelUserByStripe.run(user.stripe_customer_id || '');
    res.json({ success: true });
  } catch (err) {
    console.error('[cancel] Error:', err.message);
    res.status(500).json({ error: 'Failed to cancel subscription. Please contact support@homeseeker.dev' });
  }
});

// Reviews
app.get('/api/reviews', (req, res) => {
  res.json(getApprovedReviews.all());
});

app.post('/api/reviews', (req, res) => {
  const { name, rating, review_text } = req.body;
  if (!name || !rating || !review_text) return res.status(400).json({ error: 'Missing fields' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
  insertReview.run(name, parseInt(rating), review_text);
  res.json({ success: true });
});

app.post('/api/reviews/:id/approve', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  approveReview.run(req.params.id);
  res.json({ success: true });
});

// Admin: manually link a Telegram chat_id to a user by email or Stripe customer ID
app.post('/api/admin/link-chat', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { email, customer_id, chat_id } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id is required' });
  if (!email && !customer_id) return res.status(400).json({ error: 'email or customer_id is required' });

  let user = null;
  if (customer_id) {
    user = getUserByCustomerId.get(customer_id.trim());
  } else {
    user = getUserByEmail.get(email.trim().toLowerCase());
  }

  if (!user) return res.status(404).json({ error: 'User not found' });

  const chatIdStr = String(chat_id).trim();
  clearChatIdFromOthers.run(chatIdStr, user.stripe_customer_id || '');
  if (user.stripe_customer_id) {
    linkChatToCustomer.run(chatIdStr, user.stripe_customer_id);
  } else {
    setUserChatId.run(chatIdStr, user.email);
  }

  const updated = getUserByEmail.get(user.email);
  console.log(`[admin] Linked chat_id=${chatIdStr} to user email=${user.email} customer=${user.stripe_customer_id}`);
  res.json({ success: true, user: { email: updated.email, chat_id: updated.chat_id, betaald: updated.betaald, actief: updated.actief } });
});

// Admin: upsert a user by email and link their chat_id (creates row if missing)
app.post('/api/admin/fix-user', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { email, chat_id, stripe_customer_id, stripe_subscription_id } = req.body;
  if (!email || !chat_id) return res.status(400).json({ error: 'email and chat_id are required' });

  const emailNorm = email.trim().toLowerCase();
  const chatIdStr = String(chat_id).trim();

  let user = getUserByEmail.get(emailNorm)
          || (stripe_customer_id ? getUserByCustomerId.get(stripe_customer_id.trim()) : null);

  if (!user) {
    // Create the user row from scratch
    const custId = (stripe_customer_id || '').trim();
    const subId  = (stripe_subscription_id || '').trim();
    createUserByCustomerId.run(chatIdStr, emailNorm, custId, subId);
    user = getUserByEmail.get(emailNorm) || getUserByCustomerId.get(custId);
    console.log(`[admin] fix-user: created user email=${emailNorm} chat_id=${chatIdStr}`);
  } else {
    // User exists — link the chat_id
    clearChatIdFromOthers.run(chatIdStr, user.stripe_customer_id || '');
    if (user.stripe_customer_id) {
      linkChatToCustomer.run(chatIdStr, user.stripe_customer_id);
    } else {
      setUserChatId.run(chatIdStr, emailNorm);
    }
    console.log(`[admin] fix-user: linked chat_id=${chatIdStr} to email=${emailNorm}`);
  }

  const updated = getUserByEmail.get(emailNorm) || getUserByCustomerId.get((stripe_customer_id || '').trim());
  res.json({ success: true, created: !user, user: { email: updated?.email, chat_id: updated?.chat_id, betaald: updated?.betaald, actief: updated?.actief } });
});

// Admin: resend activation email with Telegram link
app.post('/api/admin/resend-activation', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { email, customer_id } = req.body;
  if (!email && !customer_id) return res.status(400).json({ error: 'email or customer_id is required' });

  let user = null;
  if (customer_id) {
    user = getUserByCustomerId.get(customer_id.trim());
  } else {
    user = getUserByEmail.get(email.trim().toLowerCase());
  }

  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'User has no Stripe customer ID — cannot generate activation link' });

  try {
    await sendWelcomeEmail(user.email, user.naam || '', user.stripe_customer_id);
    console.log(`[admin] Resent activation email to ${user.email}`);
    res.json({ success: true, email: user.email });
  } catch (err) {
    console.error('[admin] Resend activation error:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// ── Letter generator web page API ──────────────────────────────────────

// Returns raw listing for rent-assistant / buy-assistant context loading
app.get('/api/cached-listing/:id', (req, res) => {
  const entry = getCachedEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Listing not found or expired' });
  res.json({ listing: entry.listing });
});

const SKIP_LETTER_CATS = new Set(['timing', 'viewing', 'city_action', 'source_action']);

// Returns listing details + tips for the /letter page
app.get('/api/letter-data', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const entry = getCachedEntry(id);
  if (!entry) return res.status(404).json({ error: 'Listing not found or expired' });

  const { listing, chatId, score: cachedScore, dealScore: cachedDealScore } = entry;
  const user = chatId ? getUser.get(String(chatId)) : null;

  const score = cachedScore !== null ? cachedScore : calculateScore(listing, user || {});
  const dealScore = cachedDealScore !== null ? cachedDealScore : calculateDealScore(listing);
  const { tips } = getImprovementTips(listing, user || {}, score, dealScore);
  const letterTips = tips.filter(t => !SKIP_LETTER_CATS.has(t.category));

  res.json({
    listing: {
      address: listing.address, city: listing.city, price: listing.price,
      priceNumber: listing.priceNumber, area: listing.area, rooms: listing.rooms,
      image: listing.image, source: listing.source, url: listing.url,
      energyLabel: listing.energyLabel,
    },
    tips: letterTips.map(t => ({ tip: t.tip, category: t.category })),
    score,
    dealScore,
    chatId: chatId || null,
    user: user ? {
      naam: user.naam, contract_type: user.contract_type,
      inkomen: user.inkomen, profiel_type: user.profiel_type,
      heeft_borg: user.heeft_borg, application_readiness: user.application_readiness,
    } : null,
  });
});

// Generates letter from web page selections
app.post('/api/generate-letter-web', async (req, res) => {
  const { cacheId, selectedTipIndices = [], extraContext = '' } = req.body;
  if (!cacheId) return res.status(400).json({ error: 'Missing cacheId' });

  const entry = getCachedEntry(cacheId);
  if (!entry) return res.status(404).json({ error: 'Listing not found or expired' });

  const { listing, chatId } = entry;
  const user = chatId ? getUser.get(String(chatId)) : null;

  const score = calculateScore(listing, user || {});
  const dealScore = calculateDealScore(listing);
  const { tips } = getImprovementTips(listing, user || {}, score, dealScore);
  const letterTips = tips.filter(t => !SKIP_LETTER_CATS.has(t.category));

  const selectedTips = (selectedTipIndices || [])
    .filter(i => i >= 0 && i < letterTips.length)
    .map(i => letterTips[i].tip);
  if (extraContext && extraContext.trim()) selectedTips.push(extraContext.trim());

  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let letter;
    if (hetznerUrl && adminKey) {
      const resp = await fetch(`${hetznerUrl}/api/generate-letter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ listing, user: user || {}, selectedTips }),
      });
      if (!resp.ok) throw new Error(`Hetzner HTTP ${resp.status}`);
      letter = (await resp.json()).letter;
    } else {
      letter = await generateLetterDirect({ listing, user: user || {}, selectedTips });
    }
    res.json({ letter });
  } catch (err) {
    console.error('[api/generate-letter-web]', err.message);
    res.status(500).json({ error: 'Letter generation failed. Please try again.' });
  }
});

// Generates full application package (letter + intro + quickFacts + financialSummary)
app.post('/api/generate-package', async (req, res) => {
  const { cacheId, extraContext = '' } = req.body;
  if (!cacheId) return res.status(400).json({ error: 'Missing cacheId' });

  const entry = getCachedEntry(cacheId);
  if (!entry) return res.status(404).json({ error: 'Listing not found or expired' });

  const { listing, chatId } = entry;
  const user = chatId ? getUser.get(String(chatId)) : null;

  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let pkg;
    if (hetznerUrl && adminKey) {
      const resp = await fetch(`${hetznerUrl}/api/generate-package`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ listing, user: user || {}, extraContext }),
      });
      if (!resp.ok) throw new Error(`Hetzner HTTP ${resp.status}`);
      pkg = await resp.json();
    } else {
      pkg = await generatePackageDirect({ listing, user: user || {}, extraContext });
    }
    res.json(pkg);
  } catch (err) {
    console.error('[api/generate-package]', err.message);
    res.status(500).json({ error: 'Package generation failed. Please try again.' });
  }
});

// Listing cache endpoint — scraper POSTs listings here so Railway's bot can serve AI Letter callbacks
app.post('/api/cache-listing', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { id, listing } = req.body;
  if (!id || !listing) return res.status(400).json({ error: 'Missing id or listing' });
  injectCachedListing(id, listing);
  res.json({ ok: true });
});

// API endpoint for Hetzner matcher to fetch active users
app.get('/api/users', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const users = getAllActiveUsers.all();
    res.json(users);
  } catch (err) {
    console.error('[api/users] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: database state — call after any deploy to verify volume is mounted and data persists
app.get('/api/admin/db-status', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const total  = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const paid   = db.prepare('SELECT COUNT(*) as c FROM users WHERE betaald = 1').get().c;
  const linked = db.prepare("SELECT COUNT(*) as c FROM users WHERE chat_id IS NOT NULL AND chat_id != ''").get().c;
  const active = db.prepare('SELECT COUNT(*) as c FROM users WHERE betaald = 1 AND actief = 1').get().c;
  res.json({ dbPath, total, paid, linked, active, ts: new Date().toISOString() });
});

// ── Dashboard API ──────────────────────────────────────────────────────────

app.get('/api/dashboard', (req, res) => {
  const { chat_id } = req.query;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
  const user = getUser.get(String(chat_id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  const favorites = getFavorites.all(String(chat_id));
  const tracker = getApplicationTracker.all(String(chat_id));
  res.json({
    user: { naam: user.naam, email: user.email, locatie: user.locatie, type: user.type, betaald: user.betaald, actief: user.actief },
    favorites: favorites.map(f => { try { return { url: f.listing_url, listing: JSON.parse(f.listing_json), addedAt: f.added_at }; } catch { return { url: f.listing_url, listing: {}, addedAt: f.added_at }; } }),
    tracker: tracker.map(t => ({ url: t.listing_url, address: t.listing_address, price: t.listing_price, image: t.listing_image, status: t.status, notes: t.notes, updatedAt: t.updated_at })),
  });
});

app.post('/api/favorites', (req, res) => {
  const { chat_id, listing_url, listing, action } = req.body;
  if (!chat_id || !listing_url) return res.status(400).json({ error: 'chat_id and listing_url required' });
  if (action === 'remove') {
    removeFavorite.run(String(chat_id), listing_url);
  } else {
    addFavorite.run(String(chat_id), listing_url, JSON.stringify(listing || {}));
  }
  res.json({ ok: true });
});

app.post('/api/application-status', (req, res) => {
  const { chat_id, listing_url, listing_address, listing_price, listing_image, status, notes } = req.body;
  if (!chat_id || !listing_url) return res.status(400).json({ error: 'chat_id and listing_url required' });
  if (!status) {
    removeApplicationStatus.run(String(chat_id), listing_url);
  } else {
    upsertApplicationStatus.run(String(chat_id), listing_url, listing_address || '', listing_price || '', listing_image || '', status, notes || '');
  }
  res.json({ ok: true });
});

// AI buyer letter — proxies to Hetzner (ANTHROPIC_API_KEY lives there)
app.post('/api/buyer-letter', async (req, res) => {
  const { houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext } = req.body;
  if (!houseAddress) return res.status(400).json({ error: 'houseAddress required' });
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let letter;
    if (hetznerUrl && adminKey) {
      const resp = await fetch(`${hetznerUrl}/api/generate-buyer-letter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext }),
      });
      if (!resp.ok) throw new Error(`Hetzner HTTP ${resp.status}`);
      letter = (await resp.json()).letter;
    } else {
      letter = await generateBuyerLetterDirect({ houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext });
    }
    res.json({ letter });
  } catch (err) {
    console.error('[api/buyer-letter]', err.message);
    res.status(500).json({ error: 'Letter generation failed. Please try again.' });
  }
});

// AI lease review — proxies to Hetzner, falls back to direct
app.post('/api/lease-review', async (req, res) => {
  const { leaseText, context } = req.body;
  if (!leaseText || leaseText.length < 50) return res.status(400).json({ error: 'leaseText must be at least 50 characters' });
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    if (hetznerUrl && adminKey) {
      const r = await fetch(`${hetznerUrl}/api/generate-lease-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ leaseText, context }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Hetzner error');
      return res.json(data);
    }
    const result = await generateLeaseReviewDirect({ leaseText, context });
    return res.json(result);
  } catch (err) {
    console.error('[api/lease-review]', err.message);
    res.status(500).json({ error: 'Lease review failed. Please try again.' });
  }
});

// AI negotiation coach — proxies to Hetzner, falls back to direct
app.post('/api/negotiate', async (req, res) => {
  const { goal, property, situation, extraContext } = req.body;
  if (!goal || !situation || situation.length < 20) return res.status(400).json({ error: 'goal and situation are required' });
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    if (hetznerUrl && adminKey) {
      const r = await fetch(`${hetznerUrl}/api/generate-negotiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ goal, property, situation, extraContext }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Hetzner error');
      return res.json(data);
    }
    const result = await generateNegotiateDirect({ goal, property, situation, extraContext });
    return res.json(result);
  } catch (err) {
    console.error('[api/negotiate]', err.message);
    res.status(500).json({ error: 'Negotiation strategy generation failed. Please try again.' });
  }
});

// AI bid advisor — proxies to Hetzner
app.post('/api/bid-advisor', async (req, res) => {
  const { listingPrice, neighborhood, situation, extraContext } = req.body;
  if (!listingPrice) return res.status(400).json({ error: 'listingPrice required' });
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let advice;
    if (hetznerUrl && adminKey) {
      const resp = await fetch(`${hetznerUrl}/api/generate-bid-advice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ listingPrice, neighborhood, situation, extraContext }),
      });
      if (!resp.ok) throw new Error(`Hetzner HTTP ${resp.status}`);
      advice = await resp.json();
    } else {
      advice = await generateBidAdviceDirect({ listingPrice, neighborhood, situation, extraContext });
    }
    res.json(advice);
  } catch (err) {
    console.error('[api/bid-advisor]', err.message);
    res.status(500).json({ error: 'Bid advice generation failed. Please try again.' });
  }
});

// AI letter modification — proxies to Hetzner, falls back to direct
app.post('/api/modify-letter-web', async (req, res) => {
  const { letter, instruction } = req.body;
  if (!letter || !instruction) return res.status(400).json({ error: 'letter and instruction required' });
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    if (hetznerUrl && adminKey) {
      const r = await fetch(`${hetznerUrl}/api/modify-letter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ letter, instruction }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Hetzner error');
      return res.json(data);
    }
    const modified = await modifyLetterDirect({ letter, instruction });
    return res.json({ letter: modified });
  } catch (err) {
    console.error('[api/modify-letter-web]', err.message);
    res.status(500).json({ error: 'Letter modification failed. Please try again.' });
  }
});

// AI rental assistant — proxies to Hetzner, falls back to direct
app.post('/api/rent-assistant', async (req, res) => {
  const { tab, userMessage, listingContext, chatId } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'userMessage required' });
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let user = null;
    if (chatId) {
      try { user = getUser.get(String(chatId)); } catch (_) {}
    }
    if (hetznerUrl && adminKey) {
      const r = await fetch(`${hetznerUrl}/api/generate-rent-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ tab, userMessage, user, listingContext }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Hetzner error');
      return res.json(data);
    }
    const result = await generateRentAssistantResponse({ tab, userMessage, user, listingContext });
    return res.json(result);
  } catch (err) {
    console.error('[api/rent-assistant]', err.message);
    res.status(500).json({ error: 'Assistant response failed. Please try again.' });
  }
});

// AI buyer assistant — proxies to Hetzner, falls back to direct
app.post('/api/buy-assistant', async (req, res) => {
  const { tab, userMessage, listingContext, chatId } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'userMessage required' });
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let user = null;
    if (chatId) {
      try { user = getUser.get(String(chatId)); } catch (_) {}
    }
    if (hetznerUrl && adminKey) {
      const r = await fetch(`${hetznerUrl}/api/generate-buy-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ tab, userMessage, user, listingContext }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Hetzner error');
      return res.json(data);
    }
    const result = await generateBuyAssistantResponse({ tab, userMessage, user, listingContext });
    return res.json(result);
  } catch (err) {
    console.error('[api/buy-assistant]', err.message);
    res.status(500).json({ error: 'Assistant response failed. Please try again.' });
  }
});

// New tool API endpoints — all proxy to Hetzner with local fallback

async function proxyToHetzner(path, body, directFn) {
  const hetznerUrl = process.env.HETZNER_URL;
  const adminKey = process.env.ADMIN_KEY;
  if (hetznerUrl && adminKey) {
    const r = await fetch(`${hetznerUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Hetzner HTTP ${r.status}`);
    return data;
  }
  return await directFn();
}

app.post('/api/landlord-reply', async (req, res) => {
  const { message, chatId } = req.body;
  if (!message || message.length < 5) return res.status(400).json({ error: 'message required' });
  try {
    let userProfile = {};
    if (chatId) { try { userProfile = getUser.get(String(chatId)) || {}; } catch (_) {} }
    const data = await proxyToHetzner('/api/generate-landlord-reply', { message, userProfile }, () => generateLandlordReplyDirect({ message, userProfile }));
    res.json(data);
  } catch (err) { console.error('[api/landlord-reply]', err.message); res.status(500).json({ error: 'Analysis failed. Please try again.' }); }
});

app.post('/api/rejection-analyser', async (req, res) => {
  const { applications, chatId } = req.body;
  if (!applications) return res.status(400).json({ error: 'applications required' });
  try {
    let userProfile = {};
    if (chatId) { try { userProfile = getUser.get(String(chatId)) || {}; } catch (_) {} }
    const data = await proxyToHetzner('/api/generate-rejection-analysis', { applications, userProfile }, () => generateRejectionAnalysisDirect({ applications, userProfile }));
    res.json(data);
  } catch (err) { console.error('[api/rejection-analyser]', err.message); res.status(500).json({ error: 'Analysis failed. Please try again.' }); }
});

app.post('/api/reference-letter', async (req, res) => {
  const { type, details } = req.body;
  if (!type || !details) return res.status(400).json({ error: 'type and details required' });
  try {
    const data = await proxyToHetzner('/api/generate-reference-letter', { type, details }, () => generateReferenceLetterDirect({ type, details }));
    res.json(data);
  } catch (err) { console.error('[api/reference-letter]', err.message); res.status(500).json({ error: 'Letter generation failed. Please try again.' }); }
});

app.post('/api/income-explain', async (req, res) => {
  const { income, rent, situation } = req.body;
  if (!income || !rent) return res.status(400).json({ error: 'income and rent required' });
  try {
    const data = await proxyToHetzner('/api/generate-income-explain', { income, rent, situation: situation || '' }, () => generateIncomeExplainDirect({ income, rent, situation: situation || '' }));
    res.json(data);
  } catch (err) { console.error('[api/income-explain]', err.message); res.status(500).json({ error: 'Explanation generation failed. Please try again.' }); }
});

app.post('/api/viewing-feedback', async (req, res) => {
  const { viewingNotes, chatId } = req.body;
  if (!viewingNotes || viewingNotes.length < 20) return res.status(400).json({ error: 'viewingNotes must be at least 20 characters' });
  try {
    let userProfile = {};
    if (chatId) { try { userProfile = getUser.get(String(chatId)) || {}; } catch (_) {} }
    const data = await proxyToHetzner('/api/generate-viewing-feedback', { viewingNotes, userProfile }, () => generateViewingFeedbackDirect({ viewingNotes, userProfile }));
    res.json(data);
  } catch (err) { console.error('[api/viewing-feedback]', err.message); res.status(500).json({ error: 'Analysis failed. Please try again.' }); }
});

app.post('/api/tenant-rights-question', async (req, res) => {
  const { question } = req.body;
  if (!question || question.length < 10) return res.status(400).json({ error: 'question required' });
  try {
    const data = await proxyToHetzner('/api/generate-tenant-rights', { question }, () => generateTenantRightsAnswerDirect({ question }));
    res.json(data);
  } catch (err) { console.error('[api/tenant-rights-question]', err.message); res.status(500).json({ error: 'Answer generation failed. Please try again.' }); }
});

app.post('/api/explain-deal', async (req, res) => {
  const { dealData } = req.body;
  if (!dealData) return res.status(400).json({ error: 'dealData required' });
  try {
    const data = await proxyToHetzner('/api/generate-deal-explain', { dealData }, () => generateDealExplainDirect({ dealData }));
    res.json(data);
  } catch (err) { console.error('[api/explain-deal]', err.message); res.status(500).json({ error: 'Analysis failed. Please try again.' }); }
});

app.post('/api/overbid-bid-letter', async (req, res) => {
  const { bidDetails, chatId } = req.body;
  if (!bidDetails) return res.status(400).json({ error: 'bidDetails required' });
  try {
    let userProfile = {};
    if (chatId) { try { userProfile = getUser.get(String(chatId)) || {}; } catch (_) {} }
    const data = await proxyToHetzner('/api/generate-overbid-letter', { bidDetails, userProfile }, () => generateOverbidLetterDirect({ bidDetails, userProfile }));
    res.json(data);
  } catch (err) { console.error('[api/overbid-bid-letter]', err.message); res.status(500).json({ error: 'Letter generation failed. Please try again.' }); }
});

app.post('/api/inspection-advisor', async (req, res) => {
  const { inspectionText, purchasePrice } = req.body;
  if (!inspectionText || inspectionText.length < 20) return res.status(400).json({ error: 'inspectionText must be at least 20 characters' });
  try {
    const data = await proxyToHetzner('/api/generate-inspection-advice', { inspectionText, purchasePrice: purchasePrice || 0 }, () => generateInspectionAdviceDirect({ inspectionText, purchasePrice: purchasePrice || 0 }));
    res.json(data);
  } catch (err) { console.error('[api/inspection-advisor]', err.message); res.status(500).json({ error: 'Analysis failed. Please try again.' }); }
});

app.post('/api/erfpacht-analysis', async (req, res) => {
  const { erfpachtText, purchasePrice, city } = req.body;
  if (!erfpachtText || erfpachtText.length < 20) return res.status(400).json({ error: 'erfpachtText must be at least 20 characters' });
  try {
    const data = await proxyToHetzner('/api/generate-erfpacht-analysis', { erfpachtText, purchasePrice: purchasePrice || 0, city: city || '' }, () => generateErfpachtAnalysisDirect({ erfpachtText, purchasePrice: purchasePrice || 0, city: city || '' }));
    res.json(data);
  } catch (err) { console.error('[api/erfpacht-analysis]', err.message); res.status(500).json({ error: 'Analysis failed. Please try again.' }); }
});

app.post('/api/agent-script', async (req, res) => {
  const { situation, context } = req.body;
  if (!situation || situation.length < 10) return res.status(400).json({ error: 'situation required' });
  try {
    const data = await proxyToHetzner('/api/generate-agent-script', { situation, context: context || '' }, () => generateAgentScriptDirect({ situation, context: context || '' }));
    res.json(data);
  } catch (err) { console.error('[api/agent-script]', err.message); res.status(500).json({ error: 'Script generation failed. Please try again.' }); }
});

// Health + watchdog endpoint
app.get('/health', (req, res) => {
  const scraper = getScraperHealth();
  res.json({
    status: scraper.status,
    ts: new Date().toISOString(),
    scraper,
  });
});

// ── Boot ─────────────────────────────────────
const useWebhook = IS_PRODUCTION && !!process.env.TELEGRAM_BOT_TOKEN;
const bot = createBot(useWebhook);
if (bot) setAdminBot(bot);

if (useWebhook) {
  const TelegramBot = require('node-telegram-bot-api');
  const tmpBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  tmpBot.setWebHook(`${BASE_URL}/webhook/telegram`).then(() => {
    console.log(`[telegram] Webhook set to ${BASE_URL}/webhook/telegram`);
  }).catch(console.error);
}

// Startup relink: if BOOT_RELINK_EMAIL + BOOT_RELINK_CHAT_ID are set in Railway Variables,
// this ensures the user is re-linked automatically after any DB reset on redeploy.
{
  const bootEmail = (process.env.BOOT_RELINK_EMAIL || '').toLowerCase().trim();
  const bootChat  = (process.env.BOOT_RELINK_CHAT_ID || '').trim();
  if (bootEmail && bootChat) {
    const existing = getUserByEmail.get(bootEmail);
    if (!existing) {
      createUserByCustomerId.run(bootChat, bootEmail, '', '');
      console.log(`[boot] DB reset detected — created user: email=${bootEmail} chat_id=${bootChat}`);
    } else if (!existing.chat_id || existing.chat_id !== bootChat) {
      setUserChatId.run(bootChat, bootEmail);
      console.log(`[boot] Re-linked chat_id=${bootChat} to email=${bootEmail}`);
    } else {
      console.log(`[boot] User OK: email=${bootEmail} chat_id=${bootChat}`);
    }
  }
}

app.listen(PORT, () => {
  console.log(`[server] HomeSeeker running on port ${PORT}`);
  console.log(`[server] Base URL: ${BASE_URL}`);
});
