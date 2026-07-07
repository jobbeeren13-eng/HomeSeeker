require('dotenv').config();

const REQUIRED_ENV = ['ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID', 'ADMIN_KEY', 'TELEGRAM_BOT_TOKEN', 'LINK_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) console.warn(`[startup] WARNING: ${key} is not set`);
}
if (process.env.LINK_SECRET === 'changeme_set_in_env') {
  console.warn('[startup] WARNING: LINK_SECRET is still the placeholder default — signed chat-tokens will fail closed (every paywalled AI request will be rejected) until a real secret is set on BOTH Railway and Hetzner.');
}

// After an uncaughtException/unhandledRejection, Node's own docs say the process is in an
// undefined state — continuing to run (as this previously did, log-only) can silently corrupt
// state and, worse, prevents Railway's restartPolicyType=ON_FAILURE from ever kicking in, since
// that only triggers when the process actually exits. Exit deliberately so Railway restarts us
// into a clean process instead.
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

const { db, dbPath, upsertUser, getUserByEmail, getUserByCustomerId, getAllActiveUsers, getUser, setUserChatId, linkChatToCustomer, clearChatIdFromOthers, createUserByCustomerId, cancelUserByChatId, cancelUserByStripe, createBareUserByChatId, activateUserByChatId, insertReview, getApprovedReviews, approveReview, getFavorites, addFavorite, removeFavorite, getApplicationTracker, upsertApplicationStatus, removeApplicationStatus, getTrackerOutcomesWithScores, getTrackerOutcomesWithScoresForChat, countApplicationTrackerAll, updateLastNoAlertsNotificationAt, updateLastReviewRequestAt, getUsersForTrialReminder, getUsersForNoAlertsNotification, getUsersForReviewRequest, getListingByUrl, checkAndIncrementAiUsage, purgeOldAiUsage, purgeOldProcessedStripeEvents } = require('./src/database');
const { sendWelcomeEmail, sendTrialReminderEmail, maskEmail } = require('./src/email');
const { normaliseCity, getScraperHealth, setAdminBot, rowToListing } = require('./src/scraper');
const { createBot, getBot, sendAlert, processWebhookUpdate, injectCachedListing, getCachedEntry, signChatId, verifyChatToken } = require('./src/telegram');
const { createCheckoutSession, handleWebhook, cancelSubscription } = require('./src/stripe');
const { calculateScore, getImprovementTips, getListingIntelligence, getBuyerTips, getPriceIntelligence, detectLandlordPersona, getDocumentReadiness, getCompetitionContext, resolveCityKey, UNIFIED_PRICE_BENCHMARK_ENABLED } = require('./src/score');
const { calculateDealScore, dealLabel } = require('./src/deal_score');
const { generateLetterDirect, generatePackageDirect, generateFirstContactMessage, generateBuyerLetterDirect, generateLeaseReviewDirect, generateNegotiateDirect, generateRentAssistantResponse, generateBuyAssistantResponse, modifyLetterDirect, generateLandlordReplyDirect, generateRejectionAnalysisDirect, generateReferenceLetterDirect, generateIncomeExplainDirect, generateViewingFeedbackDirect, generateTenantRightsAnswerDirect, generateDealExplainDirect, generateOverbidLetterDirect, generateInspectionAdviceDirect, generateErfpachtAnalysisDirect, generateAgentScriptDirect, generateSupportChatDirect } = require('./src/letter');

const app = express();
// Railway sits exactly one hop in front of this app (its own edge/gateway) — trusting 1 hop
// makes Express's own req.ip resolve to that trusted hop's X-Forwarded-For entry (walking from
// the right), rather than the manual `.split(',')[0]` parsing used throughout this file, which
// took whatever a client put FIRST in the header — fully attacker-controlled and useless as a
// rate-limit key. If this app is ever placed behind an additional proxy/CDN, bump this number.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── SHUTDOWN / paused mode ────────────────────────────────────────────────
// HomeSeeker is being wound down. This flag is FAIL-SAFE PAUSED: unless SHUTDOWN is explicitly set
// to "false", the server boots in a paused state — no proactive Telegram/email outbound (daily
// job), no Telegram bot, no new Stripe checkouts, and all tool/AI /api endpoints return 503.
// What stays up on purpose: /health (Railway healthcheck), /webhook/stripe (existing-subscriber
// consistency — we are NOT cancelling anyone), /admin/* (backup + status), static pages, and the
// daily DB backup job. Nothing is deleted. To resume the service later: set SHUTDOWN=false.
const SHUTDOWN = String(process.env.SHUTDOWN ?? 'true').toLowerCase() !== 'false';
if (SHUTDOWN) console.warn('[shutdown] PAUSED mode active — outbound jobs, Telegram bot, checkout and tool endpoints are OFF. Set SHUTDOWN=false to resume.');

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

// AI endpoint rate limiter — 10 requests per IP per minute
const rateLimits = new Map();
function rateLimit(key, maxPerMinute) {
  const now = Date.now();
  const window = rateLimits.get(key) || [];
  const recent = window.filter(t => now - t < 60000);
  if (recent.length >= maxPerMinute) return false;
  recent.push(now);
  rateLimits.set(key, recent);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rateLimits) { if (v.every(t => now - t > 60000)) rateLimits.delete(k); } }, 300000);

// Paywall for every AI-generation endpoint — same definition of "active subscriber" as
// getAllActiveUsers (matcher/alerts): actief=1 AND betaald=1. betaald flips to 1 as soon as a
// user starts a Stripe trial (see createUserByCustomerId/linkChatToCustomer), so this does not
// block trial users, only people with no trial/subscription at all or a cancelled one.
// A cacheId alone (e.g. a still-valid but abandoned Telegram alert cache entry) is deliberately
// NOT sufficient — the chatId behind it must resolve to a currently active, paying user.
function isPaidUser(chatId) {
  if (!chatId) return false;
  try {
    const user = getUser.get(String(chatId));
    return !!(user && user.actief === 1 && user.betaald === 1);
  } catch (_) {
    return false;
  }
}

const PAYWALL_MESSAGE = 'Start your free trial to use this feature.';
const DAILY_CAP_MESSAGE = 'Daily limit reached for AI features. Try again tomorrow, or contact support@homeseeker.dev if you need a higher limit.';
const GLOBAL_CAP_MESSAGE = 'AI features are temporarily at capacity. Please try again in a little while.';
const MAX_AI_CALLS_PER_DAY = parseInt(process.env.MAX_AI_CALLS_PER_DAY, 10) || 50;
// Service-wide daily ceiling across ALL users — a circuit breaker on total Anthropic spend, on
// top of the per-user cap. Default 5000/day (= up to 100 fully-active users at the 50/day cap).
// Tune via env as the user base grows.
const MAX_AI_CALLS_GLOBAL_PER_DAY = parseInt(process.env.MAX_AI_CALLS_GLOBAL_PER_DAY, 10) || 5000;
let lastGlobalCapAlertDay = null; // so we log the breach once per day, not on every blocked call

// Applies the hard per-user daily cap plus the service-wide global cap (both DB-backed, see
// checkAndIncrementAiUsage) once a chatId has already been established as belonging to a paid
// user. Shared by both requirePaidUser and requirePaidUserTrusted below so the caps apply
// identically regardless of how chatId was proven. A per-user breach is the user's own limit
// (429); a global breach is a service-wide capacity stop (503) and is not the user's fault.
function enforceDailyCap(res, chatId) {
  const result = checkAndIncrementAiUsage(String(chatId), MAX_AI_CALLS_PER_DAY, MAX_AI_CALLS_GLOBAL_PER_DAY);
  if (result.ok) return true;
  if (result.reason === 'global') {
    const today = new Date().toISOString().slice(0, 10);
    if (lastGlobalCapAlertDay !== today) {
      lastGlobalCapAlertDay = today;
      console.error(`[ai-cap] GLOBAL daily AI cap of ${MAX_AI_CALLS_GLOBAL_PER_DAY} reached — AI endpoints returning 503 until tomorrow (UTC).`);
    }
    res.status(503).json({ error: GLOBAL_CAP_MESSAGE, code: 'GLOBAL_CAP' });
    return false;
  }
  res.status(429).json({ error: DAILY_CAP_MESSAGE, code: 'DAILY_CAP' });
  return false;
}

// Call at the top of an AI endpoint handler right after the rate-limit check, passing the
// signed chat-token the client presents (never a raw chat_id — those are guessable numeric
// Telegram ids and trusting them directly lets anyone impersonate a paying user). Verifies the
// HMAC signature and expiry, derives the real chat_id from the token itself, then checks the
// paywall and the daily cap. Returns the paid user row and lets the handler continue, or sends
// the error itself and returns null so the handler can `if (!user) return;`.
function requirePaidUser(req, res, ct) {
  const chatId = verifyChatToken(ct);
  if (!chatId || !isPaidUser(chatId)) {
    res.status(403).json({ error: PAYWALL_MESSAGE, code: 'PAYWALL' });
    return null;
  }
  if (!enforceDailyCap(res, chatId)) return null;
  return getUser.get(String(chatId));
}

// For the handful of endpoints where chatId is derived server-side from an unguessable cacheId
// (crypto.randomUUID(), looked up via getCachedEntry) rather than taken directly from client
// input — the cacheId itself is already the unforgeable credential here, so no separate signed
// token is required. Still enforces the same paywall + daily cap as requirePaidUser.
function requirePaidUserTrusted(req, res, chatId) {
  if (!isPaidUser(chatId)) {
    res.status(403).json({ error: PAYWALL_MESSAGE, code: 'PAYWALL' });
    return null;
  }
  if (!enforceDailyCap(res, chatId)) return null;
  return getUser.get(String(chatId));
}

// Listing-tips response cache (30 min TTL) — avoids recomputing intelligence per request
const tipsCache = new Map();
const TIPS_CACHE_TTL = 30 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [k, v] of tipsCache) { if (now - v.ts > TIPS_CACHE_TTL) tipsCache.delete(k); } }, 3600000);

// In-flight request dedup for AI assistant endpoints
const pendingRequests = new Map();

app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// SHUTDOWN: take the tool/AI API surface offline (503) while keeping /admin/* (backup + status)
// reachable. Infrastructure lives outside /api (/health, /webhook/*, static pages) so it is
// unaffected. Pages still render; their API calls return a clean 503 "temporarily unavailable".
if (SHUTDOWN) {
  app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/admin')) return next();
    res.set('Retry-After', '3600');
    return res.status(503).json({ error: 'HomeSeeker is temporarily unavailable.' });
  });
}

// FASE 2: these standalone AI tools were merged into tabs inside rent-assistant.html /
// buy-assistant.html (Scout). Old bookmarks and Telegram links still work — 301 redirect to the
// matching tab, forwarding chat_id/listing so the assistant can still prefill and pass the paywall.
function redirectToTab(assistantPath, tabNum) {
  return (req, res) => {
    const params = new URLSearchParams();
    if (req.query.chat_id) params.set('chat_id', String(req.query.chat_id));
    if (req.query.ct) params.set('ct', String(req.query.ct));
    if (req.query.listing) params.set('listing', String(req.query.listing));
    params.set('tab', String(tabNum));
    res.redirect(301, `${assistantPath}?${params.toString()}`);
  };
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/filters', (req, res) => res.sendFile(path.join(__dirname, 'public', 'filters.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/cancel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cancel.html')));
app.get('/how-scores-work', (req, res) => res.sendFile(path.join(__dirname, 'public', 'how-scores-work.html')));
app.get('/reviews', (req, res) => res.sendFile(path.join(__dirname, 'public', 'review.html')));
app.get('/letter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'letter.html')));
app.get('/apply', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apply.html')));
app.get('/guide/buy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guide', 'buy.html')));
app.get('/guide/rent', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guide', 'rent.html')));
app.get('/tools/buyer-letter', redirectToTab('/tools/buy-assistant', 6));
app.get('/tools/mortgage', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'mortgage.html')));
// bid-advisor.html was a standalone, context-free implementation (no listing/user data, no
// intelligence) duplicating the richer Bid Strategy tab inside buy-assistant.html. Redirect
// instead of maintaining two implementations of the same feature.
app.get('/tools/bid-advisor', (req, res) => res.redirect(301, '/tools/buy-assistant?tab=3'));
app.get('/tools/legal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'legal.html')));
app.get('/tools/handover', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'handover.html')));
app.get('/tools/lease-review', redirectToTab('/tools/buy-assistant', 7));
app.get('/tools/negotiate', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'negotiate.html')));
app.get('/tools/documents', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'documents.html')));
app.get('/tools/move-in', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'move-in.html')));
app.get('/tools/rent-assistant', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'rent-assistant.html')));
app.get('/tools/buy-assistant', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'buy-assistant.html')));
app.get('/tools/landlord-reply', redirectToTab('/tools/rent-assistant', 4));
app.get('/tools/rejection-analyser', redirectToTab('/tools/rent-assistant', 6));
app.get('/tools/reference-letter', redirectToTab('/tools/rent-assistant', 7));
app.get('/tools/income-check', redirectToTab('/tools/rent-assistant', 5));
app.get('/tools/viewing-feedback', redirectToTab('/tools/rent-assistant', 8));
app.get('/tools/tenant-rights', redirectToTab('/tools/rent-assistant', 9));
app.get('/tools/deal-finder', redirectToTab('/tools/buy-assistant', 8));
app.get('/tools/overbid-calculator', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tools', 'overbid-calculator.html')));
app.get('/tools/inspection-advisor', redirectToTab('/tools/buy-assistant', 9));
app.get('/tools/erfpacht-checker', redirectToTab('/tools/buy-assistant', 10));
app.get('/tools/agent-scripts', redirectToTab('/tools/buy-assistant', 11));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/subscribe', async (req, res) => {
  // SHUTDOWN: stop billing new customers — no new checkout sessions are created.
  if (SHUTDOWN) {
    res.set('Retry-After', '3600');
    return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Temporarily unavailable</title><body style="font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;text-align:center;color:#222"><h1>Temporarily unavailable</h1><p>New sign-ups are paused right now. Please check back later.</p></body>');
  }
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
    res.status(500).send('Error creating checkout session. Try again in a moment.');
  }
});

app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

app.post('/api/filters', async (req, res) => {
  const clientIp = req.ip;
  if (!checkFilterRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
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
  res.sendStatus(200);
  if (SHUTDOWN) return; // paused: no bot, no outbound — swallow any residual Telegram updates
  try { processWebhookUpdate(req.body); } catch (err) { console.error('[webhook/telegram]', err.message); }
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
    res.status(500).json({ error: 'Failed to cancel subscription. Contact support@homeseeker.dev' });
  }
});

// Reviews
app.get('/api/reviews', (req, res) => {
  try {
    res.json(getApprovedReviews.all());
  } catch (err) {
    console.error('[api/reviews]', err.message);
    res.status(500).json({ error: 'Could not load reviews' });
  }
});

app.post('/api/reviews', (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`api:${clientIp}`, 5)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { name, rating, review_text } = req.body;
  if (!name || !rating || !review_text) return res.status(400).json({ error: 'Missing fields' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
  try {
    insertReview.run(name, parseInt(rating), review_text);
    res.json({ success: true });
  } catch (err) {
    console.error('[api/reviews]', err.message);
    res.status(500).json({ error: 'Could not submit review' });
  }
});

app.post('/api/reviews/:id/approve', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    approveReview.run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[api/reviews/:id/approve]', err.message);
    res.status(500).json({ error: 'Could not approve review' });
  }
});

// Admin: manually link a Telegram chat_id to a user by email or Stripe customer ID
app.post('/api/admin/link-chat', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { email, customer_id, chat_id } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id is required' });
  if (!email && !customer_id) return res.status(400).json({ error: 'email or customer_id is required' });

  try {
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
    console.log(`[admin] Linked chat_id=${chatIdStr} to user email=${maskEmail(user.email)} customer=${user.stripe_customer_id}`);
    res.json({ success: true, user: { email: updated.email, chat_id: updated.chat_id, betaald: updated.betaald, actief: updated.actief } });
  } catch (err) {
    console.error('[api/admin/link-chat]', err.message);
    res.status(500).json({ error: 'Could not link chat_id' });
  }
});

// Admin: upsert a user by email and link their chat_id (creates row if missing)
app.post('/api/admin/fix-user', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { email, chat_id, stripe_customer_id, stripe_subscription_id } = req.body;
  if (!email || !chat_id) return res.status(400).json({ error: 'email and chat_id are required' });

  const emailNorm = email.trim().toLowerCase();
  const chatIdStr = String(chat_id).trim();

  try {
    let user = getUserByEmail.get(emailNorm)
            || (stripe_customer_id ? getUserByCustomerId.get(stripe_customer_id.trim()) : null);
    const wasCreated = !user;

    if (!user) {
      // Create the user row from scratch
      const custId = (stripe_customer_id || '').trim();
      const subId  = (stripe_subscription_id || '').trim();
      createUserByCustomerId.run(chatIdStr, emailNorm, custId, subId, Date.now());
      user = getUserByEmail.get(emailNorm) || getUserByCustomerId.get(custId);
      console.log(`[admin] fix-user: created user email=${maskEmail(emailNorm)} chat_id=${chatIdStr}`);
    } else {
      // User exists — link the chat_id
      clearChatIdFromOthers.run(chatIdStr, user.stripe_customer_id || '');
      if (user.stripe_customer_id) {
        linkChatToCustomer.run(chatIdStr, user.stripe_customer_id);
      } else {
        setUserChatId.run(chatIdStr, emailNorm);
      }
      console.log(`[admin] fix-user: linked chat_id=${chatIdStr} to email=${maskEmail(emailNorm)}`);
    }

    const updated = getUserByEmail.get(emailNorm) || getUserByCustomerId.get((stripe_customer_id || '').trim());
    res.json({ success: true, created: wasCreated, user: { email: updated?.email, chat_id: updated?.chat_id, betaald: updated?.betaald, actief: updated?.actief } });
  } catch (err) {
    console.error('[api/admin/fix-user]', err.message);
    res.status(500).json({ error: 'Could not fix user' });
  }
});

// Admin: force a chat_id to actief=1, betaald=1 (e.g. a test account) — creates a bare row if
// none exists yet for that chat_id, otherwise updates the existing one in place.
app.post('/api/admin/activate-chat', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { chat_id } = req.body;
  if (!chat_id) return res.status(400).json({ error: 'chat_id is required' });
  const chatIdStr = String(chat_id).trim();

  try {
    createBareUserByChatId.run(chatIdStr);
    activateUserByChatId.run(chatIdStr);
    const updated = getUser.get(chatIdStr);
    console.log(`[admin] activate-chat: chat_id=${chatIdStr} -> actief=${updated?.actief} betaald=${updated?.betaald}`);
    res.json({ success: true, user: { chat_id: updated?.chat_id, betaald: updated?.betaald, actief: updated?.actief } });
  } catch (err) {
    console.error('[api/admin/activate-chat]', err.message);
    res.status(500).json({ error: 'Could not activate chat_id' });
  }
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
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'User has no Stripe customer ID - cannot generate activation link' });

  try {
    await sendWelcomeEmail(user.email, user.naam || '', user.stripe_customer_id);
    console.log(`[admin] Resent activation email to ${maskEmail(user.email)}`);
    res.json({ success: true, email: user.email });
  } catch (err) {
    console.error('[admin] Resend activation error:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// ── Letter generator web page API ──────────────────────────────────────

// Returns raw listing for rent-assistant / buy-assistant context loading
app.get('/api/cached-listing/:id', (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`api:${clientIp}`, 30)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  try {
    const entry = getCachedEntry(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Listing not found or expired' });
    res.json({ listing: entry.listing });
  } catch (err) {
    console.error('[api/cached-listing]', err.message);
    res.status(500).json({ error: 'Could not load listing' });
  }
});

// Was used to pre-fill buy-assistant's affordability tab from a saved profile.
// This endpoint took an arbitrary chat_id with no verification that the caller owns it, and
// returned that account's income, partner income, contract type and profile type — a PII leak
// to anyone who knew or guessed a chat_id. There is no session/login system on the web side to
// verify ownership, so until one exists this must not return any per-user data. Always resolves
// to an empty object (never a 404) so it doesn't even leak whether a given chat_id is registered.
app.get('/api/user-profile', (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`api:${clientIp}`, 30)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { chat_id } = req.query;
  if (!chat_id) return res.status(400).json({ error: 'chat_id required' });
  try {
    res.json({});
  } catch (err) {
    console.error('[api/user-profile]', err.message);
    res.status(500).json({ error: 'Could not load profile' });
  }
});

const SKIP_LETTER_CATS = new Set(['timing', 'viewing', 'city_action', 'source_action']);

// Returns listing details + tips for the /letter page
app.get('/api/letter-data', (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`api:${clientIp}`, 30)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
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
    ct: chatId ? signChatId(chatId) : null,
  });
});

// CBS/Leefbaarometer are written to the listings table by the scraper's async external-data
// enrichment, which can finish after a listing was already cached for the alert — so the cached
// in-memory copy may not have them yet even though the DB row now does. Re-read the row by URL to
// catch that case; if anything fails, the neighbourhood context is simply omitted (non-fatal).
function getNeighbourhoodContext(listing) {
  try {
    let cbsRaw = listing.cbsContext || null;
    let lbmScore = listing.leefbaarometerScore ?? null;
    if ((!cbsRaw || lbmScore == null) && listing.url) {
      const row = getListingByUrl.get(listing.url);
      if (row) {
        cbsRaw = cbsRaw || row.cbs_context || null;
        lbmScore = lbmScore != null ? lbmScore : (row.leefbaarometer_score ?? null);
      }
    }
    const cbs = cbsRaw ? JSON.parse(cbsRaw) : null;
    if (!cbs && lbmScore == null) return null;
    return {
      leefbaarometerScore: lbmScore != null ? Math.round(lbmScore * 10) / 10 : null,
      cbsInwoners: cbs?.inwoners ?? null,
      cbsGemInkomen: cbs?.gemInkomen ?? null,
    };
  } catch (e) {
    console.error('[server] neighbourhood context failed (non-fatal):', e.message);
    return null;
  }
}

// Returns listing intelligence for a cached listing (used by assistant panels)
app.get('/api/listing-tips', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  const cacheKey = `tips:${id}`;
  const cached = tipsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TIPS_CACHE_TTL) return res.json(cached.data);

  const entry = getCachedEntry(id);
  if (!entry) return res.status(404).json({ error: 'Listing not found or expired' });

  try {
  const { listing, chatId, score, dealScore } = entry;
  const user = chatId ? getUser.get(String(chatId)) : null;
  const isKoop = listing.transactionType === 'koop';

  const priceIntel = getPriceIntelligence(listing);
  const persona = detectLandlordPersona(listing);
  const docReadiness = getDocumentReadiness(user, listing);
  const competitionCtx = getCompetitionContext(listing);
  const neighbourhoodCtx = getNeighbourhoodContext(listing);

  let data;
  if (isKoop) {
    const { listingTips, profileTips, generalTips, tips } = getBuyerTips(listing, user || {});
    data = {
      listingTips: listingTips.map(t => ({ tip: t.tip, level: t.level || 'listing' })),
      profileTips: profileTips.map(t => ({ tip: t.tip })),
      generalTips: generalTips.map(t => ({ tip: t.tip })),
      tips: tips.map(t => t.tip),
      listing: { address: listing.address, price: listing.price, area: listing.area, city: listing.city },
      score, dealScore, isKoop,
      priceIntelligence: priceIntel,
      persona,
      documentReadiness: docReadiness,
      competitionContext: competitionCtx,
      neighbourhoodContext: neighbourhoodCtx,
    };
  } else {
    const intel = getListingIntelligence(listing, user || {});
    data = {
      landlordProfile: intel.landlordProfile,
      smartPoints: intel.smartPoints,
      uniqueAngles: intel.uniqueAngles,
      watchOut: intel.watchOut,
      hiddenSignals: intel.hiddenSignals,
      platformContext: intel.platformContext || [],
      listingTips: intel.tips.filter(t => t.level === 'critical' || t.level === 'listing').map(t => ({ tip: t.tip, level: t.level })),
      profileTips: intel.tips.filter(t => t.level === 'profile').map(t => ({ tip: t.tip })),
      generalTips: [],
      tips: intel.tips.map(t => t.tip),
      listing: { address: listing.address, price: listing.price, area: listing.area, city: listing.city },
      score, dealScore, isKoop,
      priceIntelligence: priceIntel,
      persona,
      documentReadiness: docReadiness,
      competitionContext: competitionCtx,
      neighbourhoodContext: neighbourhoodCtx,
    };
  }
  tipsCache.set(cacheKey, { data, ts: Date.now() });
  return res.json(data);
  } catch (err) {
    console.error('[api/listing-tips]', err.message);
    res.status(500).json({ error: 'Could not load listing tips' });
  }
});

// Generates letter from web page selections
app.post('/api/generate-letter-web', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { cacheId, selectedTipTexts = [], extraContext = '', tone = 'professional' } = req.body;
  if (!cacheId || !/^[a-zA-Z0-9_-]+$/.test(String(cacheId))) return res.status(400).json({ error: 'Missing or invalid cacheId' });
  if (extraContext && String(extraContext).length > 500) return res.status(400).json({ error: 'extraContext must be under 500 characters' });

  const entry = getCachedEntry(cacheId);
  if (!entry) return res.status(404).json({ error: 'Listing not found or expired' });

  const { listing, chatId } = entry;
  const user = requirePaidUserTrusted(req, res, chatId);
  if (!user) return;

  const selectedTips = [...(selectedTipTexts || [])];
  if (extraContext && extraContext.trim()) selectedTips.push(extraContext.trim());

  let intelligenceContext = '';
  try { intelligenceContext = buildIntelligenceContext(listing, user); } catch (e) { console.error('[api/generate-letter-web] intelligence context failed (non-fatal):', e.message); }

  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let letter;
    if (hetznerUrl && adminKey) {
      try {
        const resp = await timedFetch(`${hetznerUrl}/api/generate-letter`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
          body: JSON.stringify({ listing, user: user || {}, selectedTips, tone, intelligenceContext }),
        }, 70000);
        if (!resp.ok) throw new Error(`Hetzner HTTP ${resp.status}`);
        letter = (await resp.json()).letter;
      } catch (hetznerErr) {
        console.error('[api/generate-letter-web] Hetzner unavailable, falling back to direct generation:', hetznerErr.message);
        ({ letter } = await generateLetterDirect({ listing, user: user || {}, selectedTips, tone, intelligenceContext }));
      }
    } else {
      ({ letter } = await generateLetterDirect({ listing, user: user || {}, selectedTips, tone, intelligenceContext }));
    }
    res.json({ letter });
  } catch (err) {
    console.error('[api/generate-letter-web]', err.message);
    res.status(500).json({ error: 'Letter generation failed. Try again in a moment.' });
  }
});

// First contact message — short 4-sentence message to send to landlord immediately
app.post('/api/first-contact-message', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { cacheId, extraContext = '', selectedTipTexts = [] } = req.body;
  if (!cacheId) return res.status(400).json({ error: 'Missing cacheId' });

  const entry = getCachedEntry(cacheId);
  if (!entry) return res.status(404).json({ error: 'Listing not found or expired' });

  const { listing, chatId } = entry;
  const user = requirePaidUserTrusted(req, res, chatId);
  if (!user) return;

  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let message;
    if (hetznerUrl && adminKey) {
      try {
        const resp = await timedFetch(`${hetznerUrl}/api/generate-first-contact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
          body: JSON.stringify({ listing, user: user || {}, extraContext, selectedTipTexts }),
        }, 70000);
        if (!resp.ok) throw new Error(`Hetzner HTTP ${resp.status}`);
        message = (await resp.json()).message;
      } catch (hetznerErr) {
        console.error('[api/first-contact-message] Hetzner unavailable, falling back to direct generation:', hetznerErr.message);
        ({ message } = await generateFirstContactMessage({ listing, user: user || {}, extraContext, selectedTipTexts }));
      }
    } else {
      ({ message } = await generateFirstContactMessage({ listing, user: user || {}, extraContext, selectedTipTexts }));
    }
    res.json({ message });
  } catch (err) {
    console.error('[api/first-contact-message]', err.message);
    res.status(500).json({ error: 'First contact message generation failed. Try again in a moment.' });
  }
});

// Generates full application package (letter + intro + quickFacts + financialSummary)
app.post('/api/generate-package', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { cacheId, extraContext = '' } = req.body;
  if (!cacheId) return res.status(400).json({ error: 'Missing cacheId' });

  const entry = getCachedEntry(cacheId);
  if (!entry) return res.status(404).json({ error: 'Listing not found or expired' });

  const { listing, chatId } = entry;
  const user = requirePaidUserTrusted(req, res, chatId);
  if (!user) return;

  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let pkg;
    if (hetznerUrl && adminKey) {
      try {
        const resp = await timedFetch(`${hetznerUrl}/api/generate-package`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
          body: JSON.stringify({ listing, user: user || {}, extraContext }),
        }, 70000);
        if (!resp.ok) throw new Error(`Hetzner HTTP ${resp.status}`);
        pkg = await resp.json();
      } catch (hetznerErr) {
        console.error('[api/generate-package] Hetzner unavailable, falling back to direct generation:', hetznerErr.message);
        pkg = await generatePackageDirect({ listing, user: user || {}, extraContext });
      }
    } else {
      pkg = await generatePackageDirect({ listing, user: user || {}, extraContext });
    }
    res.json(pkg);
  } catch (err) {
    console.error('[api/generate-package]', err.message);
    res.status(500).json({ error: 'Package generation failed. Try again in a moment.' });
  }
});

// Listing cache endpoint — scraper POSTs listings here so Railway's bot can serve AI Letter callbacks
app.post('/api/cache-listing', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { id, listing, chat_id } = req.body;
  if (!id || !listing) return res.status(400).json({ error: 'Missing id or listing' });
  // chat_id is required: the cached entry is what the paywalled AI buttons resolve the paying
  // user from. A missing chat_id here means a null-owner entry that would block the paid user —
  // reject it loudly rather than caching a broken entry (the historical paid-user-blocked bug).
  if (!chat_id) {
    console.warn(`[api/cache-listing] Rejected cache write with no chat_id (id=${id})`);
    return res.status(400).json({ error: 'chat_id required' });
  }
  try {
    injectCachedListing(id, listing, String(chat_id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[api/cache-listing]', err.message);
    res.status(500).json({ error: 'Could not cache listing' });
  }
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
  try {
    const total  = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const paid   = db.prepare('SELECT COUNT(*) as c FROM users WHERE betaald = 1').get().c;
    const linked = db.prepare("SELECT COUNT(*) as c FROM users WHERE chat_id IS NOT NULL AND chat_id != ''").get().c;
    const active = db.prepare('SELECT COUNT(*) as c FROM users WHERE betaald = 1 AND actief = 1').get().c;
    res.json({ dbPath, total, paid, linked, active, ts: new Date().toISOString() });
  } catch (err) {
    console.error('[api/admin/db-status]', err.message);
    res.status(500).json({ error: 'Could not load db status' });
  }
});

// Read-only outcome-learning report (Laag 1) — score-band vs. tracked application outcome.
// Purely informational: does not read into or modify calculateScore's weights in any way.
app.get('/api/admin/outcome-report', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const rows = getTrackerOutcomesWithScores.all();
    const totalTrackerEntries = countApplicationTrackerAll.get().c;

    const BANDS = [
      { label: '0-20', min: 0, max: 20 },
      { label: '20-40', min: 20, max: 40 },
      { label: '40-60', min: 40, max: 60 },
      { label: '60-80', min: 60, max: 80 },
      { label: '80-100', min: 80, max: 101 },
    ];
    const STATUSES = ['applied', 'viewing', 'rejected', 'accepted'];
    const bands = BANDS.map(b => ({ band: b.label, total: 0, byStatus: Object.fromEntries(STATUSES.map(s => [s, 0])) }));

    for (const row of rows) {
      if (row.score == null) continue;
      const bandIdx = BANDS.findIndex(b => row.score >= b.min && row.score < b.max);
      if (bandIdx === -1) continue;
      bands[bandIdx].total++;
      bands[bandIdx].byStatus[row.status] = (bands[bandIdx].byStatus[row.status] || 0) + 1;
    }

    res.json({
      bands,
      matchedRows: rows.length,
      totalTrackerEntries,
      note: 'Joined via outcome_snapshots (permanent, written at every sent alert), not the volatile listing_cache — matchedRows should track totalTrackerEntries closely for any tracker entry created after this fix shipped. Read-only: no scoring weights are read or changed by this endpoint.',
      ts: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[api/admin/outcome-report]', err.message);
    res.status(500).json({ error: 'Could not build outcome report' });
  }
});

// ── Dashboard API ──────────────────────────────────────────────────────────

app.get('/api/dashboard', (req, res) => {
  const chatId = verifyChatToken(req.query.ct);
  if (!chatId) return res.status(403).json({ error: 'Invalid or expired link. Use /dashboard in Telegram to get a fresh link.' });
  try {
    const user = getUser.get(String(chatId));
    if (!user) return res.status(404).json({ error: 'User not found' });
    const favorites = getFavorites.all(String(chatId));
    const tracker = getApplicationTracker.all(String(chatId));
    res.json({
      user: { naam: user.naam, email: user.email, locatie: user.locatie, type: user.type, betaald: user.betaald, actief: user.actief },
      favorites: favorites.map(f => { try { return { url: f.listing_url, listing: JSON.parse(f.listing_json), addedAt: f.added_at }; } catch { return { url: f.listing_url, listing: {}, addedAt: f.added_at }; } }),
      tracker: tracker.map(t => ({ url: t.listing_url, address: t.listing_address, price: t.listing_price, image: t.listing_image, status: t.status, notes: t.notes, updatedAt: t.updated_at })),
    });
  } catch (err) {
    console.error('[api/dashboard]', err.message);
    res.status(500).json({ error: 'Could not load dashboard' });
  }
});

app.post('/api/favorites', (req, res) => {
  const { ct, listing_url, listing, action } = req.body;
  const chatId = verifyChatToken(ct);
  if (!chatId) return res.status(403).json({ error: 'Invalid or expired link. Use /dashboard in Telegram to get a fresh link.' });
  if (!listing_url) return res.status(400).json({ error: 'listing_url required' });
  try {
    if (action === 'remove') {
      removeFavorite.run(String(chatId), listing_url);
    } else {
      addFavorite.run(String(chatId), listing_url, JSON.stringify(listing || {}));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[api/favorites]', err.message);
    res.status(500).json({ error: 'Could not update favorites' });
  }
});

app.post('/api/application-status', (req, res) => {
  const { ct, listing_url, listing_address, listing_price, listing_image, status, notes } = req.body;
  const chatId = verifyChatToken(ct);
  if (!chatId) return res.status(403).json({ error: 'Invalid or expired link. Use /dashboard in Telegram to get a fresh link.' });
  if (!listing_url) return res.status(400).json({ error: 'listing_url required' });
  try {
    if (!status) {
      removeApplicationStatus.run(String(chatId), listing_url);
    } else {
      upsertApplicationStatus.run(String(chatId), listing_url, listing_address || '', listing_price || '', listing_image || '', status, notes || '');
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[api/application-status]', err.message);
    res.status(500).json({ error: 'Could not update application status' });
  }
});

// AI buyer letter — proxies to Hetzner (ANTHROPIC_API_KEY lives there)
app.post('/api/buyer-letter', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext, chatId } = req.body;
  if (!houseAddress) return res.status(400).json({ error: 'houseAddress required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let letter;
    if (hetznerUrl && adminKey) {
      try {
        const resp = await timedFetch(`${hetznerUrl}/api/generate-buyer-letter`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
          body: JSON.stringify({ houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext }),
        }, 70000);
        if (!resp.ok) throw new Error(`Hetzner HTTP ${resp.status}`);
        letter = (await resp.json()).letter;
      } catch (hetznerErr) {
        console.error('[api/buyer-letter] Hetzner unavailable, falling back to direct generation:', hetznerErr.message);
        letter = await generateBuyerLetterDirect({ houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext });
      }
    } else {
      letter = await generateBuyerLetterDirect({ houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext });
    }
    res.json({ letter });
  } catch (err) {
    console.error('[api/buyer-letter]', err.message);
    res.status(500).json({ error: 'Letter generation failed. Try again in a moment.' });
  }
});

// AI lease review — proxies to Hetzner, falls back to direct
app.post('/api/lease-review', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { leaseText, context, chatId } = req.body;
  if (!leaseText || leaseText.length < 50) return res.status(400).json({ error: 'leaseText must be at least 50 characters' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    if (hetznerUrl && adminKey) {
      try {
        const r = await timedFetch(`${hetznerUrl}/api/generate-lease-review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
          body: JSON.stringify({ leaseText, context }),
        }, 70000);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Hetzner error');
        return res.json(data);
      } catch (hetznerErr) {
        console.error('[api/lease-review] Hetzner unavailable, falling back to direct generation:', hetznerErr.message);
      }
    }
    const result = await generateLeaseReviewDirect({ leaseText, context });
    return res.json(result);
  } catch (err) {
    console.error('[api/lease-review]', err.message);
    res.status(500).json({ error: 'Lease review failed. Try again in a moment.' });
  }
});

// AI negotiation coach — proxies to Hetzner, falls back to direct
app.post('/api/negotiate', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { goal, property, situation, extraContext, chatId } = req.body;
  if (!goal || !situation || situation.length < 20) return res.status(400).json({ error: 'goal and situation are required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    if (hetznerUrl && adminKey) {
      try {
        const r = await timedFetch(`${hetznerUrl}/api/generate-negotiate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
          body: JSON.stringify({ goal, property, situation, extraContext }),
        }, 70000);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Hetzner error');
        return res.json(data);
      } catch (hetznerErr) {
        console.error('[api/negotiate] Hetzner unavailable, falling back to direct generation:', hetznerErr.message);
      }
    }
    const result = await generateNegotiateDirect({ goal, property, situation, extraContext });
    return res.json(result);
  } catch (err) {
    console.error('[api/negotiate]', err.message);
    res.status(500).json({ error: 'Negotiation strategy generation failed. Try again in a moment.' });
  }
});

// AI letter modification — proxies to Hetzner, falls back to direct
app.post('/api/modify-letter-web', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { letter, instruction, chatId } = req.body;
  if (!letter || !instruction) return res.status(400).json({ error: 'letter and instruction required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    if (hetznerUrl && adminKey) {
      try {
        const r = await timedFetch(`${hetznerUrl}/api/modify-letter`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
          body: JSON.stringify({ letter, instruction }),
        }, 70000);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Hetzner error');
        return res.json(data);
      } catch (hetznerErr) {
        console.error('[api/modify-letter-web] Hetzner unavailable, falling back to direct generation:', hetznerErr.message);
      }
    }
    const modified = await modifyLetterDirect({ letter, instruction });
    return res.json({ letter: modified });
  } catch (err) {
    console.error('[api/modify-letter-web]', err.message);
    res.status(500).json({ error: 'Letter modification failed. Try again in a moment.' });
  }
});

// AI rental assistant — proxies to Hetzner, falls back to direct
app.post('/api/rent-assistant', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { tab, userMessage, listingContext, chatId, cacheId } = req.body;
  if (!userMessage || typeof userMessage !== 'string') return res.status(400).json({ error: 'userMessage required' });
  if (userMessage.length > 2000) return res.status(400).json({ error: 'userMessage must be under 2000 characters' });
  if (tab !== undefined && typeof tab !== 'string') return res.status(400).json({ error: 'tab must be a string' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  const reqKey = `rent:${tab}:${userMessage.slice(0, 50)}`;
  if (pendingRequests.has(reqKey)) {
    try { return res.json(await pendingRequests.get(reqKey)); } catch (err) { return res.status(500).json({ error: 'Assistant response failed. Try again in a moment.' }); }
  }
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let enrichedContext = listingContext;
    if (cacheId) {
      try {
        const entry = getCachedEntry(cacheId);
        if (entry && entry.listing) enrichedContext = (listingContext || '') + buildIntelligenceContext(entry.listing, user);
      } catch (e) { console.error('[api/rent-assistant] intelligence enrichment failed (non-fatal):', e.message); }
    }
    const promise = (async () => {
      if (hetznerUrl && adminKey) {
        try {
          // Hetzner's own generateRentAssistantResponse can take up to 75s for the heaviest tab
          // (Viewing Tips) — this outer wrapper must allow more than that or it aborts first.
          const r = await timedFetch(`${hetznerUrl}/api/generate-rent-assistant`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
            body: JSON.stringify({ tab, userMessage, user, listingContext: enrichedContext }),
          }, 90000);
          const data = await r.json();
          if (!r.ok) throw new Error('Hetzner error');
          return data;
        } catch (hetznerErr) {
          console.error('[api/rent-assistant] Hetzner unavailable, falling back to direct generation:', hetznerErr.message);
        }
      }
      return generateRentAssistantResponse({ tab, userMessage, user, listingContext: enrichedContext });
    })();
    pendingRequests.set(reqKey, promise);
    const result = await promise;
    pendingRequests.delete(reqKey);
    return res.json(result);
  } catch (err) {
    pendingRequests.delete(reqKey);
    console.error('[api/rent-assistant]', err.message);
    res.status(500).json({ error: 'Assistant response failed. Try again in a moment.' });
  }
});

// AI buyer assistant — proxies to Hetzner, falls back to direct
app.post('/api/buy-assistant', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { tab, userMessage, listingContext, chatId, cacheId, dealFields } = req.body;
  if (!userMessage || typeof userMessage !== 'string') return res.status(400).json({ error: 'userMessage required' });
  if (userMessage.length > 2000) return res.status(400).json({ error: 'userMessage must be under 2000 characters' });
  if (tab !== undefined && typeof tab !== 'string') return res.status(400).json({ error: 'tab must be a string' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  const reqKey = `buy:${tab}:${userMessage.slice(0, 50)}`;
  if (pendingRequests.has(reqKey)) {
    try { return res.json(await pendingRequests.get(reqKey)); } catch (err) { return res.status(500).json({ error: 'Assistant response failed. Try again in a moment.' }); }
  }
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    let enrichedContext = listingContext;
    if (cacheId) {
      try {
        const entry = getCachedEntry(cacheId);
        if (entry && entry.listing) enrichedContext = (listingContext || '') + buildIntelligenceContext(entry.listing, user);
      } catch (e) { console.error('[api/buy-assistant] intelligence enrichment failed (non-fatal):', e.message); }
    }
    // Property Analysis (tab 2) and Bid Strategy (tab 3) both collect price/area/city directly —
    // score.js is the single source of truth for price benchmark, deal score and competition,
    // resolved here instead of leaning solely on the static tables baked into the systems[2]/
    // systems[4] prompts. Any failure (unknown city, missing fields, flag off) leaves
    // enrichedContext untouched and the prompt's own static tables remain the fallback.
    if (UNIFIED_PRICE_BENCHMARK_ENABLED && dealFields && dealFields.price && dealFields.area && dealFields.location) {
      try {
        const resolved = resolveCityKey(dealFields.location);
        if (resolved) {
          const syntheticListing = {
            priceNumber: parseFloat(dealFields.price), area: parseFloat(dealFields.area),
            city: resolved.city, neighbourhood: resolved.neighbourhood, transactionType: 'koop',
          };
          const lines = [];
          const intel = getPriceIntelligence(syntheticListing);
          if (intel) {
            lines.push(`Price vs market: ${intel.label} (${intel.diffPct > 0 ? '+' : ''}${intel.diffPct}% vs ${intel.source === 'live' ? `a live benchmark, ${intel.sampleSize} recent listings` : 'an estimated city benchmark'} of EUR ${intel.benchmarkPpm2}/m2).`);
          }
          try {
            const dealScoreVal = calculateDealScore(syntheticListing);
            if (dealScoreVal != null) lines.push(`Deal score: ${dealScoreVal}/100 (${dealLabel(dealScoreVal, syntheticListing)}) — the same score used in HomeSeeker's alerts.`);
          } catch (_) {}
          try {
            const competitionCtx = getCompetitionContext(syntheticListing);
            if (competitionCtx) lines.push(`Estimated competition: roughly ${competitionCtx.estimated.low}-${competitionCtx.estimated.high} other bidders (${competitionCtx.level}). ${competitionCtx.timingMessage}`);
          } catch (_) {}
          if (lines.length) {
            enrichedContext = (enrichedContext || '') + `\n\nLive market intelligence for this listing (computed from real data — prefer it over the static tables above when they conflict):\n${lines.join('\n')}`;
          }
        }
      } catch (e) { console.error('[api/buy-assistant] price benchmark enrichment failed (non-fatal):', e.message); }
    }
    const promise = (async () => {
      if (hetznerUrl && adminKey) {
        try {
          // All buy-assistant tabs share the same heavy 1800-token/75s budget on the Hetzner
          // side — this outer wrapper must allow more than that or it aborts first.
          const r = await timedFetch(`${hetznerUrl}/api/generate-buy-assistant`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
            body: JSON.stringify({ tab, userMessage, user, listingContext: enrichedContext }),
          }, 90000);
          const data = await r.json();
          if (!r.ok) throw new Error('Hetzner error');
          return data;
        } catch (hetznerErr) {
          console.error('[api/buy-assistant] Hetzner unavailable, falling back to direct generation:', hetznerErr.message);
        }
      }
      return generateBuyAssistantResponse({ tab, userMessage, user, listingContext: enrichedContext });
    })();
    pendingRequests.set(reqKey, promise);
    const result = await promise;
    pendingRequests.delete(reqKey);
    return res.json(result);
  } catch (err) {
    pendingRequests.delete(reqKey);
    console.error('[api/buy-assistant]', err.message);
    res.status(500).json({ error: 'Assistant response failed. Try again in a moment.' });
  }
});

// New tool API endpoints — all proxy to Hetzner with local fallback

// Fix: rich listing intelligence (price vs benchmark, landlord persona, competition,
// document readiness) was already computed by score.js for the Analyse-tab display cards,
// but never reached the actual generation calls (Letter/Viewing/Negotiation/Buy tabs) — those
// only ever saw a thin "address - city - price - description" string. This turns the same
// score.js signals into a compact, explicit context block for the generation layer.
// Best-effort only: any failure just means the block is omitted, callers behave exactly as
// before.
const ASSISTANT_INTELLIGENCE_ENABLED = process.env.ENABLE_ASSISTANT_INTELLIGENCE !== 'false';
function buildIntelligenceContext(listing, user) {
  if (!ASSISTANT_INTELLIGENCE_ENABLED || !listing) return '';
  const isKoop = listing.transactionType === 'koop';
  const lines = [];
  try {
    const priceIntel = getPriceIntelligence(listing);
    if (priceIntel) {
      lines.push(`Price vs market: ${priceIntel.label} (${priceIntel.diffPct > 0 ? '+' : ''}${priceIntel.diffPct}% vs ${priceIntel.source === 'live' ? 'a live' : 'an estimated'} benchmark of EUR ${priceIntel.benchmarkPpm2}/m2).`);
    }
  } catch (_) {}
  // Landlord persona and document readiness are rental-application concepts (appealing to a
  // landlord's emotional attachment, payslips/contract readiness) that don't map to a home
  // seller/mortgage-buyer context — only include them for huur listings.
  if (!isKoop) {
    try {
      const persona = detectLandlordPersona(listing);
      if (persona) lines.push(`Landlord type: ${persona.label} (confidence ${persona.confidence}). What they want: ${persona.whatTheyWant} Strategy: ${persona.strategy}`);
    } catch (_) {}
  }
  try {
    const competitionCtx = getCompetitionContext(listing);
    if (competitionCtx) lines.push(`Competition: roughly ${competitionCtx.estimated.low}-${competitionCtx.estimated.high} other ${isKoop ? 'bidders' : 'applicants'} (${competitionCtx.level}). ${competitionCtx.timingMessage}`);
  } catch (_) {}
  if (!isKoop) {
    try {
      const docReadiness = getDocumentReadiness(user, listing);
      if (docReadiness && !docReadiness.ready) lines.push(`Document readiness: ${docReadiness.score}%. ${docReadiness.urgency || ''}`);
    } catch (_) {}
  }
  try {
    const dealScoreVal = calculateDealScore(listing);
    if (dealScoreVal != null) lines.push(`Deal score: ${dealScoreVal}/100 (${dealLabel(dealScoreVal, listing)}) vs the local market rate — the same score used in HomeSeeker's alerts.`);
  } catch (_) {}
  try {
    const nbCtx = getNeighbourhoodContext(listing);
    if (nbCtx) {
      const parts = [];
      if (nbCtx.leefbaarometerScore != null) parts.push(`Leefbaarometer liveability score ${nbCtx.leefbaarometerScore}/10`);
      if (nbCtx.cbsGemInkomen) parts.push(`average neighbourhood income EUR ${Math.round(nbCtx.cbsGemInkomen)}`);
      if (nbCtx.cbsInwoners) parts.push(`${nbCtx.cbsInwoners} residents in the buurt`);
      if (parts.length) lines.push(`Neighbourhood (CBS/Leefbaarometer): ${parts.join(', ')}.`);
    }
  } catch (_) {}
  if (!lines.length) return '';
  return `\n\nVerified listing intelligence (this is computed from real data — prefer it over general assumptions):\n${lines.join('\n')}`;
}

async function timedFetch(url, options, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function proxyToHetzner(path, body, directFn) {
  const hetznerUrl = process.env.HETZNER_URL;
  const adminKey = process.env.ADMIN_KEY;
  if (hetznerUrl && adminKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 70000);
    try {
      const r = await fetch(`${hetznerUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `Hetzner HTTP ${r.status}`);
      return data;
    } catch (err) {
      console.error(`[proxyToHetzner] ${path} failed, falling back to direct generation:`, err.message);
      return await directFn();
    } finally {
      clearTimeout(timer);
    }
  }
  return await directFn();
}

app.post('/api/landlord-reply', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { message, chatId } = req.body;
  if (!message || message.length < 5) return res.status(400).json({ error: 'message required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const userProfile = user || {};
    const data = await proxyToHetzner('/api/generate-landlord-reply', { message, userProfile }, () => generateLandlordReplyDirect({ message, userProfile }));
    res.json(data);
  } catch (err) { console.error('[api/landlord-reply]', err.message); res.status(500).json({ error: 'Analysis failed. Try again in a moment.' }); }
});

app.post('/api/rejection-analyser', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { applications, chatId, userProfile: selfReportedProfile } = req.body;
  if (!applications) return res.status(400).json({ error: 'applications required' });
  const paidUser = requirePaidUser(req, res, chatId);
  if (!paidUser) return;
  try {
    const userProfile = { ...paidUser, ...(selfReportedProfile || {}) };
    // Cross-reference the user's self-reported text with their own objective outcome history
    // (real Application Score at alert time vs what they later marked as applied/rejected/
    // accepted) so the diagnosis isn't based purely on what they remember to type in.
    // Best-effort: any failure just means this list stays empty and the analysis falls back
    // to self-reported text only, exactly as before.
    let outcomeHistory = [];
    if (paidUser.chat_id) {
      try {
        outcomeHistory = getTrackerOutcomesWithScoresForChat.all(String(paidUser.chat_id)).map(r => ({
          address: r.listing_address || null, status: r.status, score: r.score, dealScore: r.deal_score, updatedAt: r.updated_at,
        }));
      } catch (e) { console.error('[api/rejection-analyser] outcome history lookup failed (non-fatal):', e.message); }
    }
    const data = await proxyToHetzner('/api/generate-rejection-analysis', { applications, userProfile, outcomeHistory }, () => generateRejectionAnalysisDirect({ applications, userProfile, outcomeHistory }));
    res.json(data);
  } catch (err) { console.error('[api/rejection-analyser]', err.message); res.status(500).json({ error: 'Analysis failed. Try again in a moment.' }); }
});

app.post('/api/reference-letter', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { type, details, chatId } = req.body;
  if (!type || !details) return res.status(400).json({ error: 'type and details required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const data = await proxyToHetzner('/api/generate-reference-letter', { type, details }, () => generateReferenceLetterDirect({ type, details }));
    res.json(data);
  } catch (err) { console.error('[api/reference-letter]', err.message); res.status(500).json({ error: 'Letter generation failed. Try again in a moment.' }); }
});

app.post('/api/income-explain', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { income, rent, situation, chatId } = req.body;
  if (!income || !rent) return res.status(400).json({ error: 'income and rent required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const data = await proxyToHetzner('/api/generate-income-explain', { income, rent, situation: situation || '' }, () => generateIncomeExplainDirect({ income, rent, situation: situation || '' }));
    res.json(data);
  } catch (err) { console.error('[api/income-explain]', err.message); res.status(500).json({ error: 'Explanation generation failed. Try again in a moment.' }); }
});

app.post('/api/viewing-feedback', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { viewingNotes, chatId } = req.body;
  if (!viewingNotes || viewingNotes.length < 20) return res.status(400).json({ error: 'viewingNotes must be at least 20 characters' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const userProfile = user || {};
    const data = await proxyToHetzner('/api/generate-viewing-feedback', { viewingNotes, userProfile }, () => generateViewingFeedbackDirect({ viewingNotes, userProfile }));
    res.json(data);
  } catch (err) { console.error('[api/viewing-feedback]', err.message); res.status(500).json({ error: 'Analysis failed. Try again in a moment.' }); }
});

app.post('/api/tenant-rights-question', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { question, chatId } = req.body;
  if (!question || question.length < 10) return res.status(400).json({ error: 'question required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const data = await proxyToHetzner('/api/generate-tenant-rights', { question }, () => generateTenantRightsAnswerDirect({ question }));
    res.json(data);
  } catch (err) { console.error('[api/tenant-rights-question]', err.message); res.status(500).json({ error: 'Answer generation failed. Try again in a moment.' }); }
});

// Single source of truth for price-vs-benchmark verdicts computed from free-text listing
// details (Deal Finder, Buy Assistant Property Analysis) — wraps score.js getPriceIntelligence,
// the same function that powers real scraped listings and Telegram alerts. Always resolves to
// { ok:false } rather than an error status on any miss so callers can silently fall back.
app.post('/api/price-benchmark', (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`api:${clientIp}`, 30)) return res.status(429).json({ ok: false, error: 'Too many requests.' });
  if (!UNIFIED_PRICE_BENCHMARK_ENABLED) return res.json({ ok: false });
  try {
    const { price, area, location, type } = req.body;
    const priceNumber = parseFloat(price);
    const areaNumber = parseFloat(area);
    if (!priceNumber || !areaNumber || !location) return res.json({ ok: false });
    const resolved = resolveCityKey(location);
    if (!resolved) return res.json({ ok: false });
    const dealListing = {
      priceNumber, area: areaNumber, city: resolved.city,
      neighbourhood: resolved.neighbourhood, transactionType: type === 'koop' ? 'koop' : 'huur',
    };
    const intel = getPriceIntelligence(dealListing);
    if (!intel) return res.json({ ok: false });
    // deal_score.js is the same single source of truth used for Telegram alerts — callers like
    // Deal Finder should upgrade their local estimate with this instead of scoring independently.
    let dealScoreVal = null, dealLabelVal = null;
    try {
      dealScoreVal = calculateDealScore(dealListing);
      if (dealScoreVal != null) dealLabelVal = dealLabel(dealScoreVal, dealListing);
    } catch (_) {}
    return res.json({ ok: true, intel, resolvedCity: resolved.city, dealScore: dealScoreVal, dealLabel: dealLabelVal });
  } catch (err) {
    console.error('[api/price-benchmark]', err.message);
    return res.json({ ok: false });
  }
});

app.post('/api/explain-deal', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { dealData, chatId } = req.body;
  if (!dealData) return res.status(400).json({ error: 'dealData required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    // score.js is the single source of truth for the benchmark verdict — recompute it
    // server-side from whatever the client sent and prefer it over the client's own
    // calculation when it succeeds. Falls back to the client-supplied dealData untouched
    // if resolution fails for any reason (unknown city, missing fields, flag off).
    let enrichedDealData = dealData;
    if (UNIFIED_PRICE_BENCHMARK_ENABLED) {
      try {
        const resolved = resolveCityKey(dealData.city || dealData.location || '');
        if (resolved && dealData.price && dealData.area) {
          const intel = getPriceIntelligence({
            priceNumber: parseFloat(dealData.price), area: parseFloat(dealData.area),
            city: resolved.city, neighbourhood: resolved.neighbourhood, transactionType: 'koop',
          });
          if (intel) enrichedDealData = { ...dealData, benchmark: intel.benchmarkPpm2, ppm2verdict: intel.label, benchmarkSource: intel.source };
        }
      } catch (e) { console.error('[api/explain-deal] benchmark enrichment failed (non-fatal):', e.message); }
    }
    const data = await proxyToHetzner('/api/generate-deal-explain', { dealData: enrichedDealData }, () => generateDealExplainDirect({ dealData: enrichedDealData }));
    res.json(data);
  } catch (err) { console.error('[api/explain-deal]', err.message); res.status(500).json({ error: 'Analysis failed. Try again in a moment.' }); }
});

app.post('/api/overbid-bid-letter', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { bidDetails, chatId } = req.body;
  if (!bidDetails) return res.status(400).json({ error: 'bidDetails required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const userProfile = user || {};
    const data = await proxyToHetzner('/api/generate-overbid-letter', { bidDetails, userProfile }, () => generateOverbidLetterDirect({ bidDetails, userProfile }));
    res.json(data);
  } catch (err) { console.error('[api/overbid-bid-letter]', err.message); res.status(500).json({ error: 'Letter generation failed. Try again in a moment.' }); }
});

app.post('/api/inspection-advisor', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { inspectionText, purchasePrice, chatId } = req.body;
  if (!inspectionText || inspectionText.length < 20) return res.status(400).json({ error: 'inspectionText must be at least 20 characters' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const data = await proxyToHetzner('/api/generate-inspection-advice', { inspectionText, purchasePrice: purchasePrice || 0 }, () => generateInspectionAdviceDirect({ inspectionText, purchasePrice: purchasePrice || 0 }));
    res.json(data);
  } catch (err) { console.error('[api/inspection-advisor]', err.message); res.status(500).json({ error: 'Analysis failed. Try again in a moment.' }); }
});

app.post('/api/erfpacht-analysis', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { erfpachtText, purchasePrice, city, chatId } = req.body;
  if (!erfpachtText || erfpachtText.length < 20) return res.status(400).json({ error: 'erfpachtText must be at least 20 characters' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const data = await proxyToHetzner('/api/generate-erfpacht-analysis', { erfpachtText, purchasePrice: purchasePrice || 0, city: city || '' }, () => generateErfpachtAnalysisDirect({ erfpachtText, purchasePrice: purchasePrice || 0, city: city || '' }));
    res.json(data);
  } catch (err) { console.error('[api/erfpacht-analysis]', err.message); res.status(500).json({ error: 'Analysis failed. Try again in a moment.' }); }
});

app.post('/api/agent-script', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { situation, context, chatId } = req.body;
  if (!situation || situation.length < 10) return res.status(400).json({ error: 'situation required' });
  const user = requirePaidUser(req, res, chatId);
  if (!user) return;
  try {
    const data = await proxyToHetzner('/api/generate-agent-script', { situation, context: context || '' }, () => generateAgentScriptDirect({ situation, context: context || '' }));
    res.json(data);
  } catch (err) { console.error('[api/agent-script]', err.message); res.status(500).json({ error: 'Script generation failed. Try again in a moment.' }); }
});

// ── Daily database backup ────────────────────────────────────────────────
let lastBackupAt = null;
// ── Daily job: trial reminders, no-alerts notifications, review requests ─────
let lastDailyJobDate = null;

function getAmsterdamHour() {
  return parseInt(new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', hour12: false, timeZone: 'Europe/Amsterdam' }).format(new Date()), 10);
}

async function runDailyJob() {
  const today = new Date().toISOString().slice(0, 10);
  if (getAmsterdamHour() !== 10) return;
  if (lastDailyJobDate === today) return;
  lastDailyJobDate = today;
  console.log('[daily] Running daily job for', today);

  const now = Date.now();

  // Trial expiry safety net: deactivate users whose 7-day trial started >8 days ago
  // with no confirmed subscription_id (guards against missed Stripe webhooks)
  try {
    const expiryCutoff = now - 8 * 24 * 60 * 60 * 1000;
    const expiredUsers = db.prepare(
      `SELECT * FROM users WHERE betaald = 1 AND actief = 1
       AND trial_start IS NOT NULL AND trial_start < ?
       AND (stripe_subscription_id IS NULL OR stripe_subscription_id = '')`
    ).all(expiryCutoff);
    for (const u of expiredUsers) {
      db.prepare('UPDATE users SET betaald = 0, actief = 0 WHERE chat_id = ?').run(u.chat_id);
      console.log(`[daily] Trial expired (no subscription confirmed) — deactivated user ${u.email ? maskEmail(u.email) : u.chat_id}`);
    }
    if (expiredUsers.length) console.log(`[daily] Expired trial users deactivated: ${expiredUsers.length}`);
  } catch (e) { console.error('[daily] trial expiry check error:', e.message); }

  // FIX 2: Trial expiry reminder on day 5
  try {
    const min = now - 5.5 * 24 * 60 * 60 * 1000;
    const max = now - 4.5 * 24 * 60 * 60 * 1000;
    const trialUsers = getUsersForTrialReminder.all(min, max);
    for (const u of trialUsers) {
      if (!u.email) continue;
      await sendTrialReminderEmail(u.email, u.naam || '').catch(e => console.error('[daily] trial reminder failed:', e.message));
    }
    if (trialUsers.length) console.log(`[daily] Trial reminders sent: ${trialUsers.length}`);
  } catch (e) { console.error('[daily] trial reminder step error:', e.message); }

  // FIX 3: No-alerts Telegram notification
  try {
    const _bot = getBot();
    if (_bot) {
      const cutoff48h = now - 48 * 60 * 60 * 1000;
      const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      const cutoff72h = now - 72 * 60 * 60 * 1000;
      const noAlertUsers = getUsersForNoAlertsNotification.all(cutoff48h, cutoff24h, cutoff72h);
      for (const u of noAlertUsers) {
        try {
          await _bot.sendMessage(u.chat_id,
            'No new listings matching your filters in the past 48 hours.\n\nTry widening your city, price range, or room count to find more options.',
            { reply_markup: { inline_keyboard: [[{ text: 'Adjust my filters', url: `${BASE_URL}/filters?chat_id=${u.chat_id}` }]] } }
          );
          updateLastNoAlertsNotificationAt.run(now, u.chat_id);
        } catch (e) { console.error(`[daily] no-alerts msg failed for ${u.chat_id}:`, e.message); }
      }
      if (noAlertUsers.length) console.log(`[daily] No-alerts notifications sent: ${noAlertUsers.length}`);
    }
  } catch (e) { console.error('[daily] no-alerts step error:', e.message); }

  // FIX 11: Review request (14 days after activation)
  try {
    const _bot = getBot();
    if (_bot) {
      const reviewUsers = getUsersForReviewRequest.all();
      for (const u of reviewUsers) {
        try {
          await _bot.sendMessage(u.chat_id,
            `Hi ${u.naam || 'there'}, you've been with HomeSeeker for 2 weeks now.\n\nIf the alerts or AI tools helped your search, we'd love a quick review — it helps other expats find us too.`,
            { reply_markup: { inline_keyboard: [[{ text: 'Leave a review', url: 'https://homeseeker.dev/reviews' }]] } }
          );
          updateLastReviewRequestAt.run(now, u.chat_id);
        } catch (e) { console.error(`[daily] review request failed for ${u.chat_id}:`, e.message); }
      }
      if (reviewUsers.length) console.log(`[daily] Review requests sent: ${reviewUsers.length}`);
    }
  } catch (e) { console.error('[daily] review request step error:', e.message); }
}

if (!SHUTDOWN) setInterval(runDailyJob, 60 * 60 * 1000);
else console.log('[shutdown] Daily job (trial reminders / no-alerts notices / review requests) disabled');

let lastBackupStatus = 'never';
let lastOffsiteBackupAt = null;
let lastOffsiteBackupStatus = 'never';

async function runDbBackup() {
  const backupPath = path.join(path.dirname(dbPath), 'homeseeker_backup.db');
  try {
    await db.backup(backupPath);
    lastBackupAt = new Date().toISOString();
    lastBackupStatus = 'ok';
    console.log(`[backup] DB backup complete → ${backupPath}`);
  } catch (err) {
    lastBackupStatus = `failed: ${err.message}`;
    console.error('[backup] DB backup failed:', err.message);
    return; // no point pushing an off-site copy if the local backup itself failed
  }

  try { purgeOldAiUsage.run(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)); } catch (e) { console.error('[backup] ai_usage_daily purge failed (non-fatal):', e.message); }
  try { purgeOldProcessedStripeEvents.run(Date.now() - 30 * 24 * 60 * 60 * 1000); } catch (e) { console.error('[backup] processed_stripe_events purge failed (non-fatal):', e.message); }

  // Off-site copy: the local backup above lives on the same Railway volume as the live DB, so it
  // protects against nothing if that volume is ever lost (platform incident, misconfiguration,
  // accidental deletion). Push a copy to the Hetzner VPS — a genuinely separate machine and
  // provider — as an independent second location. Best-effort: any failure here is logged but
  // does not affect the (already-succeeded) local backup above.
  try {
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    if (!hetznerUrl || !adminKey) {
      lastOffsiteBackupStatus = 'skipped: HETZNER_URL/ADMIN_KEY not configured';
      return;
    }
    const buf = fs.readFileSync(backupPath);
    const resp = await timedFetch(`${hetznerUrl}/api/backup-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-admin-key': adminKey },
      body: buf,
    }, 60000);
    if (!resp.ok) throw new Error(`Hetzner HTTP ${resp.status}`);
    lastOffsiteBackupAt = new Date().toISOString();
    lastOffsiteBackupStatus = 'ok';
    console.log('[backup] Off-site copy pushed to Hetzner');
  } catch (err) {
    lastOffsiteBackupStatus = `failed: ${err.message}`;
    console.error('[backup] Off-site push to Hetzner failed (local backup still ok):', err.message);
  }
}

// Run immediately on boot, then every 24 hours. The boot run means a deploy (incl. the shutdown
// deploy) always produces a fresh local backup + off-site push to Hetzner.
runDbBackup();
setInterval(runDbBackup, 24 * 60 * 60 * 1000);

// On-demand backup trigger — used during shutdown to force a final off-site copy and confirm it.
app.post('/admin/run-backup', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  await runDbBackup();
  res.json({
    ok: lastBackupStatus === 'ok',
    backupPath: path.join(path.dirname(dbPath), 'homeseeker_backup.db'),
    lastBackupAt, lastBackupStatus,
    lastOffsiteBackupAt, lastOffsiteBackupStatus,
    ts: new Date().toISOString(),
  });
});

app.get('/admin/backup-status', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const backupPath = path.join(path.dirname(dbPath), 'homeseeker_backup.db');
  let backupSize = null;
  try { backupSize = fs.statSync(backupPath).size; } catch (_) {}
  res.json({ lastBackupAt, lastBackupStatus, lastOffsiteBackupAt, lastOffsiteBackupStatus, backupPath, backupSizeBytes: backupSize, ts: new Date().toISOString() });
});

// Public healthcheck — Railway probes this without auth
app.get('/health', (req, res) => {
  const dbOk = (() => { try { db.prepare('SELECT 1').get(); return true; } catch { return false; } })();
  if (!dbOk) return res.status(503).json({ status: 'error', db: false });
  res.json({ status: 'ok' });
});

// Detailed health — admin only
app.get('/admin/health', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const scraper = getScraperHealth();
  const dbOk = (() => { try { db.prepare('SELECT 1').get(); return true; } catch { return false; } })();
  const activeUsers = (() => { try { return db.prepare('SELECT COUNT(*) as c FROM users WHERE betaald=1 AND actief=1').get().c; } catch { return null; } })();
  res.json({
    status: dbOk ? scraper.status : 'db_error',
    uptime: Math.round(process.uptime()),
    memory: process.memoryUsage().heapUsed,
    dbOk,
    activeUsers,
    timestamp: new Date().toISOString(),
    scraper,
  });
});

// ── Boot ─────────────────────────────────────
const useWebhook = IS_PRODUCTION && !!process.env.TELEGRAM_BOT_TOKEN;
// SHUTDOWN: do not start the Telegram bot at all — no polling, no webhook registration, no
// outbound messages. Alerts from the scraper are stopped separately (pm2 stop on Hetzner).
const bot = SHUTDOWN ? null : createBot(useWebhook);
if (bot) setAdminBot(bot);
if (SHUTDOWN) console.log('[shutdown] Telegram bot disabled (no polling/webhook, no outbound messages)');

if (!SHUTDOWN && useWebhook) {
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
      createUserByCustomerId.run(bootChat, bootEmail, '', '', Date.now());
      console.log(`[boot] DB reset detected — created user: email=${maskEmail(bootEmail)} chat_id=${bootChat}`);
    } else if (!existing.chat_id || existing.chat_id !== bootChat) {
      setUserChatId.run(bootChat, bootEmail);
      console.log(`[boot] Re-linked chat_id=${bootChat} to email=${maskEmail(bootEmail)}`);
    } else {
      console.log(`[boot] User OK: email=${maskEmail(bootEmail)} chat_id=${bootChat}`);
    }
  }
}

app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Request failed. Try again or contact support@homeseeker.dev' });
});

app.post('/api/support-chat', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`ai:${clientIp}`, 10)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { message, history } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  if (message.length > 500) return res.status(400).json({ error: 'message must be under 500 characters' });
  if (history !== undefined && (!Array.isArray(history) || history.length > 10)) return res.status(400).json({ error: 'history must be an array with at most 10 items' });
  try {
    const hist = Array.isArray(history) ? history.slice(-6) : [];
    const data = await proxyToHetzner('/api/support-chat', { message, history: hist }, () => generateSupportChatDirect({ message, history: hist }));
    res.json({ reply: data.reply || 'I am not sure - please email support@homeseeker.dev' });
  } catch (err) {
    console.error('[support-chat]', err.message);
    res.json({ reply: 'I am having trouble right now. Please email support@homeseeker.dev and we will help you directly.' });
  }
});

// Funda photo proxy — called by Hetzner scraper to bypass IP-based CAPTCHA block
app.get('/api/fetch-funda-photo', async (req, res) => {
  const clientIp = req.ip;
  if (!rateLimit(`api:${clientIp}`, 30)) return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  const { url } = req.query;
  if (!url || !url.startsWith('https://www.funda.nl/')) return res.status(400).json({ error: 'invalid url' });
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'nl-NL,nl;q=0.9',
        'Referer': 'https://www.funda.nl/',
      },
      signal: AbortSignal.timeout(8000),
    });
    const html = await resp.text();
    if (html.includes('fundaCaptchaForm') || html.includes('akam_recaptcha')) {
      return res.json({ photo: null, captcha: true });
    }
    const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
           || html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);
    res.json({ photo: m ? m[1] : null });
  } catch (e) {
    res.json({ photo: null, error: e.message });
  }
});

// ── Funda API proxy (Hetzner IP is blocked by Funda; Railway is not) ─────
app.post('/api/funda-search', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { payload } = req.body;
  if (!payload || typeof payload !== 'string') return res.status(400).json({ error: 'payload required' });
  const traceId = String(Math.floor(Math.random() * 9e18 + 1e18));
  const parentId = Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, '0');
  const tid = Math.floor(Date.now() / 1000).toString(16) + '00000000';
  try {
    const resp = await fetch('https://listing-search-wonen.funda.io/_msearch/template', {
      method: 'POST',
      headers: {
        'user-agent': 'Dart/3.9 (dart:io)',
        'x-datadog-sampling-priority': '0',
        'x-datadog-origin': 'rum',
        'tracestate': `dd=s:0;o:rum;p:${parentId}`,
        'x-datadog-parent-id': traceId,
        'content-type': 'application/json',
        'referer': 'https://www.funda.nl/',
        'accept': 'application/json',
        'traceparent': `00-${tid}${traceId.slice(0, 16)}-${parentId}-00`,
      },
      body: payload,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return res.json({ status: resp.status, data: null });
    const data = await resp.json();
    res.json({ status: resp.status, data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── 404 + 500 handlers (must be registered after all routes) ──────────────
// API and webhook paths get JSON so clients can parse the error; everything else is a browser
// navigation and gets the styled HTML page.
function wantsJson(req) {
  return req.path.startsWith('/api/') || req.path.startsWith('/webhook/') || (req.headers.accept || '').includes('application/json');
}

app.use((req, res) => {
  if (wantsJson(req)) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Express error handler: 4 args so Express treats it as the error middleware. Logs the stack
// server-side but never leaks it to the client.
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  if (wantsJson(req)) return res.status(500).json({ error: 'Internal server error' });
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

const server = app.listen(PORT, () => {
  console.log(`[server] HomeSeeker running on port ${PORT}`);
  console.log(`[server] Base URL: ${BASE_URL}`);
});

process.on('SIGTERM', () => {
  console.log('[server] SIGTERM received — shutting down gracefully');
  server.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
});
