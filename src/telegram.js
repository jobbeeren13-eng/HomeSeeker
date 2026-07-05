const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { getUser, getUserByEmail, getListingByUrl, getUserByCustomerId, linkChatToCustomer, clearChatIdFromOthers, setUserChatId, upsertChat, setUserActive, cancelUserByChatId, persistCacheListing, getPersistedCacheListing, purgeExpiredCacheListings, updateLastAlertSentAt, insertOutcomeSnapshot } = require('./database');
const { rowToListing } = require('./scraper');
const { detectLandlordIntent } = require('./score');
 
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const LINK_SECRET = process.env.LINK_SECRET || 'changeme_set_in_env';
 
const SOURCE_BADGES = {
  funda: 'Funda',
  kamernet: 'Kamernet',
  housinganywhere: 'HousingAnywhere',
  pararius: 'Pararius',
  huurwoningen: 'Huurwoningen',
  jaap: 'Jaap',
};

let bot = null;
const letterState = new Map();
const pendingLinkState = new Map(); // chatId -> true, waiting for email input
const listingCache = new Map();

// --- Signed chat-id token (prevents impersonating a paying user by guessing their
// numeric Telegram chat_id) --- Web pages must present this token instead of a raw
// chat_id for anything paywall-gated; the server derives the authoritative chat_id
// from the token itself rather than trusting a client-supplied value directly.
const CHAT_TOKEN_TTL_MS = 45 * 24 * 60 * 60 * 1000; // 45 days — alerts can sit unread for a while
function linkSecretConfigured() {
  return !!LINK_SECRET && LINK_SECRET !== 'changeme_set_in_env';
}
function signChatId(chatId) {
  if (!chatId || !linkSecretConfigured()) return null;
  const id = String(chatId);
  const expiresAt = Date.now() + CHAT_TOKEN_TTL_MS;
  const sig = crypto.createHmac('sha256', LINK_SECRET).update(`${id}.${expiresAt}`).digest('hex').slice(0, 32);
  return `${id}.${expiresAt}.${sig}`;
}
function verifyChatToken(token) {
  if (!token || !linkSecretConfigured()) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [id, expiresAtStr, sig] = parts;
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!id || !expiresAt || Number.isNaN(expiresAt) || Date.now() > expiresAt) return null;
  const expected = crypto.createHmac('sha256', LINK_SECRET).update(`${id}.${expiresAtStr}`).digest('hex').slice(0, 32);
  const sigBuf = Buffer.from(sig, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  return id;
}

// --- Signed start payload (prevents brute-forcing customer IDs) ---
function generateStartPayload(customerId) {
  const sig = crypto
    .createHmac('sha256', LINK_SECRET)
    .update(customerId)
    .digest('hex')
    .slice(0, 8);
  return `${customerId}_${sig}`;
}
 
function verifyStartPayload(payload) {
  if (!payload) return null;
  const parts = payload.split('_');
  // cus_xxx_signature format: last part is sig, rest is customerId
  if (parts.length < 3) return null;
  const sig = parts[parts.length - 1];
  const customerId = parts.slice(0, parts.length - 1).join('_');
  if (!customerId.startsWith('cus_')) return null;
  const expected = crypto
    .createHmac('sha256', LINK_SECRET)
    .update(customerId)
    .digest('hex')
    .slice(0, 8);
  if (sig !== expected) return null;
  return customerId;
}
 
const CACHE_TTL_MS = 48 * 60 * 60 * 1000;

function cacheListing(listing, chatId = null, score = null, dealScore = null) {
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + CACHE_TTL_MS;
  listingCache.set(id, { listing, chatId, score, dealScore, expiresAt });
  try { persistCacheListing.run(id, JSON.stringify({ listing, chatId, score, dealScore }), expiresAt, score ?? null, dealScore ?? null, chatId ?? null); } catch (_) {}
  if (listingCache.size >= 500) {
    const now = Date.now();
    for (const [k, v] of listingCache) {
      if (v.expiresAt < now) listingCache.delete(k);
    }
    if (listingCache.size >= 500) {
      const oldest = listingCache.keys().next().value;
      listingCache.delete(oldest);
    }
  }
  return id;
}

function _parseStoredEntry(raw) {
  // Handle both old format (direct listing object) and new format ({ listing, chatId })
  if (raw && raw.listing && raw.listing.url) return { listing: raw.listing, chatId: raw.chatId || null };
  return { listing: raw, chatId: null };
}

function getCachedListing(id) {
  const entry = listingCache.get(id);
  if (entry) {
    if (entry.expiresAt < Date.now()) { listingCache.delete(id); return null; }
    return entry.listing;
  }
  try {
    const row = getPersistedCacheListing.get(String(id), Date.now());
    if (row) {
      const { listing, chatId } = _parseStoredEntry(JSON.parse(row.listing_json));
      listingCache.set(id, { listing, chatId, expiresAt: Date.now() + CACHE_TTL_MS });
      return listing;
    }
  } catch (_) {}
  return null;
}

// Returns { listing, chatId, score, dealScore } — used by server.js for the web letter page
function getCachedEntry(id) {
  const entry = listingCache.get(id);
  if (entry) {
    if (entry.expiresAt < Date.now()) { listingCache.delete(id); return null; }
    return { listing: entry.listing, chatId: entry.chatId, score: entry.score || null, dealScore: entry.dealScore || null };
  }
  try {
    const row = getPersistedCacheListing.get(String(id), Date.now());
    if (row) {
      const parsed = JSON.parse(row.listing_json);
      const { listing, chatId } = _parseStoredEntry(parsed);
      const score = parsed.score || null;
      const dealScore = parsed.dealScore || null;
      listingCache.set(id, { listing, chatId, score, dealScore, expiresAt: Date.now() + CACHE_TTL_MS });
      return { listing, chatId, score, dealScore };
    }
  } catch (_) {}
  return null;
}

function injectCachedListing(id, listing) {
  const expiresAt = Date.now() + CACHE_TTL_MS;
  listingCache.set(String(id), { listing, chatId: null, expiresAt });
  try { persistCacheListing.run(String(id), JSON.stringify({ listing, chatId: null }), expiresAt, null, null, null); } catch (_) {}
}
 
// Server-side access check — always hits DB, never trusts cached state
function hasAccess(chatId) {
  const user = getUser.get(String(chatId));
  return !!(user && user.betaald === 1 && user.actief === 1);
}
 
async function denyAccess(chatId) {
  await bot.sendMessage(chatId,
    `🔒 No active subscription found.\n\nStart your free trial at:\n👉 https://homeseeker.dev`
  );
}
 
function clearLetterState(chatId) {
  letterState.delete(String(chatId));
}
 
function getPlatformBadge(source) {
  return SOURCE_BADGES[source] || (source || 'Listing');
}
 
function formatCityDisplay(city) {
  if (!city) return '';
  return city.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
 
function listingFromUrl(url) {
  const row = getListingByUrl.get(url);
  if (row) return rowToListing(row);
  return { url, address: '', city: '', price: '', priceNumber: 0, source: '' };
}
 
function estimateMonthlyCost(rentPrice) {
  const serviceCosts = 150;
  const utilities = 120;
  const internet = 40;
  const total = rentPrice + serviceCosts + utilities + internet;
  return Math.round(total / 10) * 10;
}
 
function createBot(useWebhook = false) {
  if (!TOKEN) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled');
    return null;
  }
  console.log('[telegram] Token loaded, creating bot (useWebhook=%s)', useWebhook);
 
  bot = new TelegramBot(TOKEN, useWebhook ? { webHook: true } : { polling: true });
 
  bot.on('polling_error', (err) => {
    console.error('[telegram] Polling error:', err.message);
  });
 
  // /start — handles both new activations (with signed payload) and returning users
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const rawPayload = match && match[1] ? match[1].trim() : null;
    clearLetterState(chatId);
    upsertChat.run(chatId, msg.from?.username || '', msg.from?.first_name || '');
 
    if (rawPayload) {
      // Verify signed payload
      const customerId = verifyStartPayload(rawPayload);
      if (!customerId) {
        await bot.sendMessage(chatId,
          `❌ This activation link is invalid or expired.\n\nStart a trial at https://homeseeker.dev`
        );
        return;
      }
 
      const stripeUser = getUserByCustomerId.get(customerId);
      if (!stripeUser || stripeUser.betaald !== 1) {
        await bot.sendMessage(chatId,
          `❌ No active subscription found for this link.\n\nStart a trial at https://homeseeker.dev`
        );
        return;
      }
 
      // Single-use binding: if already linked to a different chat_id, block
      if (stripeUser.chat_id && stripeUser.chat_id !== '' && stripeUser.chat_id !== chatId) {
        await bot.sendMessage(chatId,
          `⚠️ This activation link has already been used on another account.\n\nContact support at support@homeseeker.dev`
        );
        return;
      }
 
      // Link chat_id to customer
      clearChatIdFromOthers.run(chatId, customerId);
      linkChatToCustomer.run(chatId, customerId);
      const filterUrl = `${BASE_URL}/filters?chat_id=${chatId}`;
      await bot.sendMessage(chatId,
        `🏠 *Welcome to HomeSeeker!*\n\nYour 7-day trial is active. Set your filters to start receiving alerts:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⚙️ Set my filters', url: filterUrl }]] },
        }
      );
      return;
    }
 
    // No payload — check if already linked and paid (returning user)
    if (hasAccess(chatId)) {
      const filterUrl = `${BASE_URL}/filters?chat_id=${chatId}`;
      await bot.sendMessage(chatId,
        `🏠 *Welcome back to HomeSeeker!*\n\nUpdate your filters anytime:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⚙️ Set my filters', url: filterUrl }]] },
        }
      );
      return;
    }
 
    // Not linked — 3-step onboarding for new users
    pendingLinkState.set(chatId, true);
    await bot.sendMessage(chatId,
      `👋 *Welcome to HomeSeeker*\n\n` +
      `We send real-time Telegram alerts the moment a matching Dutch rental appears — before it fills up.\n\n` +
      `*Step 1 — Start your free trial*\n` +
      `Visit homeseeker.dev and sign up. No credit card required to start.\n\n` +
      `*Step 2 — Set your filters*\n` +
      `Tell us your city, budget, room count, and income. We score every listing against your profile and only alert you on strong matches.\n\n` +
      `*Step 3 — Get alerts and apply*\n` +
      `Each alert includes a match score, market value rating, and a direct link to your AI application letter — ready to send in minutes.\n\n` +
      `Already subscribed? Reply with your email address and we'll connect your account instantly.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🚀 Start 7-day free trial', url: `${BASE_URL}` }]],
        },
      }
    );
  });
 
  bot.onText(/\/(stop|unsubscribe)/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!hasAccess(chatId)) return denyAccess(chatId);
    clearLetterState(chatId);
    setUserActive.run(0, chatId);
    await bot.sendMessage(chatId,
      '⏸ Your alerts have been paused. Send /start anytime to resume.\n\nTo fully cancel your subscription and stop billing, use /cancel.'
    );
  });
 
  bot.onText(/\/cancel/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!hasAccess(chatId)) return denyAccess(chatId);
    clearLetterState(chatId);
 
    const user = getUser.get(chatId);
    if (!user) {
      return bot.sendMessage(chatId, '❌ No account found. Send /start to set up your profile.');
    }
 
    if (!user.stripe_subscription_id) {
      setUserActive.run(0, chatId);
      return bot.sendMessage(chatId,
        '✅ Your alerts have been stopped. You will not be charged.\n\nSend /start anytime to start again.'
      );
    }
 
    await bot.sendMessage(chatId,
      '⚠️ *Cancel subscription?*\n\nThis will immediately stop your alerts and cancel your billing. Are you sure?',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Yes, cancel', callback_data: 'confirm_cancel' },
            { text: '❌ Keep subscription', callback_data: 'keep_subscription' },
          ]],
        },
      }
    );
  });
 
  bot.onText(/\/filters/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!hasAccess(chatId)) return denyAccess(chatId);
    const filterUrl = `${BASE_URL}/filters?chat_id=${chatId}`;
    await bot.sendMessage(chatId, '⚙️ Update your filters here:', {
      reply_markup: { inline_keyboard: [[{ text: '⚙️ Open filter form', url: filterUrl }]] },
    });
  });

  bot.onText(/\/tools/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!hasAccess(chatId)) return denyAccess(chatId);
    await bot.sendMessage(chatId, '🛠 *HomeSeeker Tools*\n\nAll the tools to help you find and secure a home in the Netherlands:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🤖 Rental Assistant', url: `${BASE_URL}/tools/rent-assistant?chat_id=${chatId}&ct=${signChatId(chatId)}` }, { text: '💬 Landlord Reply Coach', url: `${BASE_URL}/tools/landlord-reply` }],
          [{ text: '🔍 Rejection Analyser', url: `${BASE_URL}/tools/rejection-analyser?chat_id=${chatId}&ct=${signChatId(chatId)}` }, { text: '💰 Income Check', url: `${BASE_URL}/tools/income-check` }],
          [{ text: '📄 Reference Letters', url: `${BASE_URL}/tools/reference-letter` }, { text: '👁 Viewing Feedback', url: `${BASE_URL}/tools/viewing-feedback` }],
          [{ text: '⚖️ Tenant Rights', url: `${BASE_URL}/tools/tenant-rights` }, { text: '📖 Rental Guide', url: `${BASE_URL}/guide/rent` }],
          [{ text: '🏡 Buyer Assistant', url: `${BASE_URL}/tools/buy-assistant?chat_id=${chatId}&ct=${signChatId(chatId)}` }, { text: '🎯 Deal Finder', url: `${BASE_URL}/tools/deal-finder` }],
          [{ text: '📈 Overbid Calculator', url: `${BASE_URL}/tools/overbid-calculator` }, { text: '🔎 Inspection Advisor', url: `${BASE_URL}/tools/inspection-advisor` }],
          [{ text: '🏗 Erfpacht Checker', url: `${BASE_URL}/tools/erfpacht-checker` }, { text: '🗣 Agent Scripts', url: `${BASE_URL}/tools/agent-scripts` }],
        ],
      },
    });
  });

  bot.onText(/\/dashboard/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!hasAccess(chatId)) return denyAccess(chatId);
    const dashUrl = `${BASE_URL}/dashboard?chat_id=${chatId}`;
    await bot.sendMessage(chatId, '📊 *Your HomeSeeker Dashboard*\n\nView your saved listings, application status, and quick links to all tools:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📊 Open Dashboard', url: dashUrl }]] },
    });
  });
 
  bot.onText(/\/status/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!hasAccess(chatId)) return denyAccess(chatId);
 
    const user = getUser.get(chatId);
    if (!user) {
      return bot.sendMessage(chatId, '❌ No profile found. Send /start to set up your filters.');
    }
    const status = user.betaald ? (user.actief ? '✅ Active' : '⏸ Paused') : '⚠️ Trial / unpaid';
    const readiness = { klaar: 'Ready', bijna: 'Almost ready', bezig: 'In progress', niet: 'Not started' };
    await bot.sendMessage(chatId,
      `📊 *Your status*\n\n` +
      `Name: ${user.naam || '—'}\n` +
      `City: ${user.locatie || '—'}\n` +
      `Type: ${user.type || '—'}\n` +
      `Max price: €${user.prijs_max || '—'}\n` +
      `Application readiness: ${readiness[user.application_readiness] || '—'}\n` +
      `Subscription: ${status}`,
      { parse_mode: 'Markdown' }
    );
  });
 
  bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    const data = query.data || '';
    await bot.answerCallbackQuery(query.id);
 
    if (!hasAccess(chatId)) return denyAccess(chatId);
 
    if (data === 'unsubscribe') {
      clearLetterState(chatId);
      setUserActive.run(0, chatId);
      await bot.sendMessage(chatId,
        '⏸ Alerts paused. Send /start to resume.\n\nTo fully cancel billing, use /cancel.'
      );
      return;
    }
 
    if (data === 'confirm_cancel') {
      const user = getUser.get(chatId);
      if (user?.stripe_subscription_id) {
        try {
          const { cancelSubscription } = require('./stripe');
          await cancelSubscription(user.stripe_subscription_id);
        } catch (err) {
          console.error('[telegram] Stripe cancel error:', err.message);
        }
      }
      cancelUserByChatId.run(chatId);
      clearLetterState(chatId);
      await bot.sendMessage(chatId,
        '✅ Your subscription has been cancelled. You will not be charged again.\n\nWe\'re sorry to see you go! Send /start anytime to resubscribe.'
      );
      return;
    }
 
    if (data === 'keep_subscription') {
      await bot.sendMessage(chatId, '👍 Great! Your subscription is still active. Alerts will keep coming.');
      return;
    }
 
    if (data.startsWith('share:')) {
      const id = data.slice(6);
      const listing = getCachedListing(id);
      await bot.sendMessage(chatId, listing?.url || 'Listing not found.');
      return;
    }
 
    if (data.startsWith('ai_letter:')) {
      const cacheId = data.split(':')[1];
      await bot.sendMessage(chatId, '✍️ Generate your application letter on HomeSeeker:', {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Open letter generator →', url: `${BASE_URL}/letter?id=${cacheId}` },
          ]],
        },
      });
      return;
    }

  });
 
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    // Email-based account recovery after bare /start
    if (pendingLinkState.has(chatId)) {
      pendingLinkState.delete(chatId);
      const email = text.toLowerCase();
      const user = getUserByEmail.get(email);
      if (!user || user.betaald !== 1) {
        await bot.sendMessage(chatId,
          `❌ No active subscription found for ${email}.\n\nStart a trial at:\n👉 https://homeseeker.dev`
        );
        return;
      }
      if (user.chat_id && user.chat_id !== '' && user.chat_id !== chatId) {
        await bot.sendMessage(chatId,
          `⚠️ This account is already linked to another Telegram account.\n\nContact support at support@homeseeker.dev if you need help.`
        );
        return;
      }
      clearChatIdFromOthers.run(chatId, user.stripe_customer_id || '');
      if (user.stripe_customer_id) {
        linkChatToCustomer.run(chatId, user.stripe_customer_id);
      } else {
        setUserChatId.run(chatId, email);
      }
      const filterUrl = `${BASE_URL}/filters?chat_id=${chatId}`;
      console.log(`[telegram] Self-serve linked chat_id=${chatId} to email=${email}`);
      await bot.sendMessage(chatId,
        `✅ *Account connected!* Your subscription is active.\n\nSet your filters to start receiving alerts:`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⚙️ Set my filters', url: filterUrl }]] },
        }
      );
      return;
    }

  });
 
  console.log('[telegram] Bot started (polling=%s)', !useWebhook);
  return bot;
}
 
function getBot() { return bot; }
 
function listingAgeStr(listing) {
  if (!listing.listedAt) return null;
  const ageMs = Date.now() - new Date(listing.listedAt).getTime();
  if (isNaN(ageMs) || ageMs < 0) return null;
  if (ageMs < 30 * 60 * 1000) return 'Just listed';
  if (ageMs < 2 * 60 * 60 * 1000) return 'New today';
  if (ageMs < 24 * 60 * 60 * 1000) return 'Listed today';
  return null;
}

async function sendAlert(chatId, listing, score, label, dealScore, dLabel, user = null, botOverride = null) {
  const _bot = botOverride || bot;
  if (!_bot) return;

  clearLetterState(chatId);

  function bar(pct, fill) {
    const filled = Math.round((pct / 100) * 10);
    return fill.repeat(filled) + '⬜'.repeat(10 - filled) + ' ' + pct + '%';
  }
  function appFill(pct) { return pct >= 70 ? '🟩' : pct >= 40 ? '🟨' : '🟥'; }
  function dealFill(pct) { return pct >= 60 ? '🟩' : pct >= 35 ? '🟨' : '🟥'; }
  function appLabel(pct) {
    if (pct >= 85) return 'Excellent';
    if (pct >= 70) return 'Strong';
    if (pct >= 50) return 'Good';
    if (pct >= 30) return 'Fair';
    return 'Weak';
  }
  function valueLabel(pct) {
    if (pct >= 60) return 'Good deal';
    if (pct >= 40) return 'Fair price';
    return 'Expensive';
  }
  function verdictCTA(sc, huur) {
    if (huur) {
      if (sc >= 85) return 'Excellent match. Tap AI Rental Assistant for your full strategy.';
      if (sc >= 70) return 'Strong match. Tap AI Rental Assistant to see your best move.';
      if (sc >= 55) return 'Good match. Tap AI Rental Assistant to strengthen your application.';
      if (sc >= 40) return 'Possible match. Tap AI Rental Assistant to close the gaps.';
      return 'Weak match. Tap AI Rental Assistant to see what is blocking you.';
    }
    if (sc >= 80) return 'Strong buyer profile. Tap AI Buyer Assistant for your full strategy.';
    if (sc >= 60) return 'Good buyer profile. Tap AI Buyer Assistant to prepare your bid.';
    return 'Review your position. Tap AI Buyer Assistant to understand your options.';
  }

  const JUNK = ['blikvanger', 'nieuw', 'verhuurd', 'verkocht', 'onder bod'];
  let address = listing.address || '';
  if (JUNK.some(j => address.toLowerCase().trim() === j || address.toLowerCase().trim().startsWith(j + ' '))) {
    const m = listing.url?.match(/\/([^/]+)\/\d+\/?$/);
    if (m) address = m[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  const priceStr = listing.priceNumber
    ? `€${listing.priceNumber.toLocaleString('nl-NL')}`
    : (listing.price || 'N/A');
  const cityDisplay = formatCityDisplay(listing.city);
  const isHuur = listing.transactionType === 'huur';
  const monthlyCost = (isHuur && listing.priceNumber) ? estimateMonthlyCost(listing.priceNumber) : null;

  const intent = detectLandlordIntent(listing.description || '');
  const warningKeys = intent.warnings.map(w => w.key);
  const conflicts = [];
  if (user) {
    if (warningKeys.includes('no_students') && user.profiel_type === 'student') conflicts.push('no_students');
    if (warningKeys.includes('no_couples') && user.met_partner === 'ja') conflicts.push('no_couples');
    if (warningKeys.includes('family_only') && user.met_partner !== 'ja') conflicts.push('family_only');
    if (warningKeys.includes('working_only') && user.contract_type === 'student') conflicts.push('working_only');
  }

  const cityStr = cityDisplay || listing.city || '';
  const safeAddr = address.replace(/_/g, '\\_');

  // Build single complete caption
  const lines = [];
  lines.push(getPlatformBadge(listing.source));
  lines.push(`📍 *${safeAddr}${cityStr ? ', ' + cityStr : ''}*`);
  if (listing.area) lines.push(`• ${listing.area}m²`);
  if (isHuur && listing.priceNumber) {
    lines.push(`• Rent: ${priceStr}/mo`);
    if (listing.area && listing.priceNumber) {
      const ppm2 = Math.round(listing.priceNumber / listing.area);
      if (ppm2 >= 5 && ppm2 <= 100) lines.push(`• €${ppm2}/m²`);
    }
    if (monthlyCost) lines.push(`• Est. total: €${monthlyCost.toLocaleString('nl-NL')}/mo`);
  } else if (!isHuur && listing.priceNumber) {
    lines.push(`• ${priceStr}`);
    if (listing.area && listing.priceNumber) {
      const ppm2 = Math.round(listing.priceNumber / listing.area);
      if (ppm2 >= 5 && ppm2 <= 100) lines.push(`• €${ppm2}/m²`);
    }
  } else {
    lines.push(`• ${priceStr}${isHuur ? '/mo' : ''}`);
  }

  const dealDisplay = dealScore != null ? valueLabel(dealScore) : 'Insufficient data';
  lines.push('');
  lines.push(`*Application: ${appLabel(score)}*`);
  lines.push(bar(score, appFill(score)));
  lines.push('');
  lines.push(`*Market Value: ${dealDisplay}*`);
  if (dealScore != null) lines.push(bar(dealScore, dealFill(dealScore)));
  lines.push('');
  const disclaimer = '_Score reflects your profile fit, not your odds of getting the home._';
  lines.push(disclaimer);
  lines.push('');
  lines.push(verdictCTA(score, isHuur));

  if (conflicts.length > 0) {
    lines.push('');
    lines.push('*Possible profile mismatch. Read landlord requirements carefully.*');
  }

  let captionText = lines.join('\n');
  // Telegram sendPhoto caption limit is 1024 chars — drop disclaimer if needed
  if (captionText.length > 1024) {
    captionText = lines.filter(l => l !== disclaimer).join('\n').slice(0, 1024);
  }
  console.log('[alert] captionLength:', captionText.length);

  const cacheId = cacheListing(listing, chatId, score, dealScore);
  const ct = signChatId(chatId);
  const keyboard = isHuur ? {
    inline_keyboard: [
      [
        { text: 'View listing', url: listing.url },
        { text: 'AI Rental Assistant', url: `${BASE_URL}/tools/rent-assistant?chat_id=${chatId}&ct=${ct}&listing=${cacheId}` },
      ],
      [
        { text: 'Share', callback_data: `share:${cacheId}` },
        { text: 'Unsubscribe', callback_data: 'unsubscribe' },
      ],
    ],
  } : {
    inline_keyboard: [
      [
        { text: 'View listing', url: listing.url },
        { text: 'AI Buyer Assistant', url: `${BASE_URL}/tools/buy-assistant?chat_id=${chatId}&ct=${ct}&listing=${cacheId}` },
      ],
      [
        { text: 'Deal Score', url: `${BASE_URL}/tools/deal-finder?chat_id=${chatId}&ct=${ct}` },
        { text: 'Share', callback_data: `share:${cacheId}` },
      ],
      [{ text: 'Unsubscribe', callback_data: 'unsubscribe' }],
    ],
  };

  const hasRealImage = listing.image && /^https?:\/\//.test(listing.image);
  let atLeastOneSent = false;

  if (hasRealImage) {
    // Download to buffer — Telegram can refuse to fetch CDN URLs with restrictive origins
    let photo = listing.image;
    let fileOpts;
    try {
      const imgResp = await fetch(listing.image, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Referer': 'https://www.funda.nl/',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (imgResp.ok) {
        photo = Buffer.from(await imgResp.arrayBuffer());
        fileOpts = { filename: 'photo.jpg', contentType: 'image/jpeg' };
      }
    } catch (imgErr) {
      console.log('[telegram] photo buffer fetch failed, using URL:', imgErr.message);
    }
    try {
      const sendPhotoArgs = [chatId, photo, { caption: captionText, parse_mode: 'Markdown', reply_markup: keyboard }];
      if (fileOpts) sendPhotoArgs.push(fileOpts);
      await sendWithRetry(_bot, 'sendPhoto', ...sendPhotoArgs);
      atLeastOneSent = true;
    } catch (e) {
      console.error('[telegram] sendPhoto failed:', e.message);
      try {
        await sendWithRetry(_bot, 'sendMessage', chatId, captionText, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
          disable_web_page_preview: true,
        });
        atLeastOneSent = true;
      } catch (e2) {
        console.error('[telegram] sendMessage fallback failed:', e2.message);
      }
    }
  } else {
    try {
      await sendWithRetry(_bot, 'sendMessage', chatId, captionText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
      atLeastOneSent = true;
    } catch (e) {
      console.error('[telegram] sendMessage failed:', e.message);
    }
  }

  if (atLeastOneSent && user && user.chat_id) {
    try { updateLastAlertSentAt.run(Date.now(), user.chat_id); } catch (_) {}
    try {
      insertOutcomeSnapshot.run({
        chatId: user.chat_id, listingUrl: listing.url,
        score: score ?? null, dealScore: dealScore ?? null, alertedAt: Date.now(),
      });
    } catch (e) { console.error('[telegram] insertOutcomeSnapshot failed (non-fatal):', e.message); }
  }
  return { cacheId, sent: atLeastOneSent };
}

async function sendWithRetry(_bot, method, ...args) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await _bot[method](...args);
    } catch (err) {
      if (err.code === 429 && attempt < 2) {
        const retryAfter = ((err.response?.body?.parameters?.retry_after) || 5) * 1000;
        await new Promise(r => setTimeout(r, retryAfter));
      } else {
        throw err;
      }
    }
  }
}

function processWebhookUpdate(update) {
  if (!bot) return;
  try { bot.processUpdate(update); } catch (err) { console.error('[telegram] processWebhookUpdate error:', err.message); }
}
 
module.exports = { createBot, getBot, sendAlert, processWebhookUpdate, clearLetterState, generateStartPayload, injectCachedListing, getCachedEntry, signChatId, verifyChatToken };
 