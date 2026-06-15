const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { getUser, getUserByEmail, getListingByUrl, getUserByCustomerId, linkChatToCustomer, clearChatIdFromOthers, setUserChatId, upsertChat, setUserActive, cancelUserByChatId, persistCacheListing, getPersistedCacheListing, purgeExpiredCacheListings } = require('./database');
const { generateLetterDirect } = require('./letter');
const { rowToListing } = require('./scraper');
const { calculateScore, getImprovementTips, getPillarBreakdown, detectLandlordIntent } = require('./score');
const { calculateDealScore, detectPriceDrop } = require('./deal_score');
 
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const LINK_SECRET = process.env.LINK_SECRET || 'changeme_set_in_env';
 
const SOURCE_BADGES = {
  funda: '🏠 Funda',
  kamernet: '🚪 Kamernet',
  housinganywhere: '🌍 HousingAnywhere',
  pararius: '🔑 Pararius',
  huurwoningen: '🏠 Huurwoningen',
  jaap: '🏠 Jaap',
};

const SOURCE_PLACEHOLDERS = {
  funda: 'https://via.placeholder.com/800x400/0a0a0a/00e5a0?text=Funda',
  kamernet: 'https://via.placeholder.com/800x400/0a0a0a/00e5a0?text=Kamernet',
  housinganywhere: 'https://via.placeholder.com/800x400/0a0a0a/00e5a0?text=HousingAnywhere',
  pararius: 'https://via.placeholder.com/800x400/0a0a0a/00e5a0?text=Pararius',
  huurwoningen: 'https://via.placeholder.com/800x400/0a0a0a/00e5a0?text=Huurwoningen',
  jaap: 'https://via.placeholder.com/800x400/0a0a0a/00e5a0?text=Jaap',
};
const GENERIC_PLACEHOLDER = 'https://via.placeholder.com/800x400/0a0a0a/00e5a0?text=HomeSeeker';

let bot = null;
const letterState = new Map();
const pendingLinkState = new Map(); // chatId -> true, waiting for email input
const listingCache = new Map();
let listingCacheId = 0;

// Categories that are action items, not letter content — filtered from auto-selected tips
const SKIP_LETTER_CATS = new Set(['timing', 'viewing', 'city_action', 'source_action']);

// Shared letter-generation helper
async function generateAndSendLetter(chatId, listing, user, selectedTips) {
  await bot.sendMessage(chatId, '✍️ Generating your letter…');
  try {
    let letter;
    const hetznerUrl = process.env.HETZNER_URL;
    const adminKey = process.env.ADMIN_KEY;
    if (hetznerUrl && adminKey) {
      const resp = await fetch(`${hetznerUrl}/api/generate-letter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ listing, user, selectedTips: selectedTips || [] }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Letter proxy HTTP ${resp.status}: ${body}`);
      }
      letter = (await resp.json()).letter;
    } else {
      letter = await generateLetterDirect({ listing, user, selectedTips: selectedTips || [] });
    }
    await bot.sendMessage(chatId, letter);
  } catch (err) {
    console.error('[letter] Generation error:', err.message);
    await bot.sendMessage(chatId, 'Sorry, could not generate your letter. Please try again later.');
  }
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

function cacheListing(listing, chatId = null) {
  const id = String(++listingCacheId);
  const expiresAt = Date.now() + CACHE_TTL_MS;
  listingCache.set(id, { listing, chatId, expiresAt });
  try { persistCacheListing.run(id, JSON.stringify({ listing, chatId }), expiresAt); } catch (_) {}
  if (listingCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of listingCache) {
      if (v.expiresAt < now) listingCache.delete(k);
    }
    if (listingCache.size > 500) {
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

// Returns { listing, chatId } — used by server.js for the web letter page
function getCachedEntry(id) {
  const entry = listingCache.get(id);
  if (entry) {
    if (entry.expiresAt < Date.now()) { listingCache.delete(id); return null; }
    return { listing: entry.listing, chatId: entry.chatId };
  }
  try {
    const row = getPersistedCacheListing.get(String(id), Date.now());
    if (row) {
      const { listing, chatId } = _parseStoredEntry(JSON.parse(row.listing_json));
      listingCache.set(id, { listing, chatId, expiresAt: Date.now() + CACHE_TTL_MS });
      return { listing, chatId };
    }
  } catch (_) {}
  return null;
}

function injectCachedListing(id, listing) {
  const expiresAt = Date.now() + CACHE_TTL_MS;
  listingCache.set(String(id), { listing, chatId: null, expiresAt });
  try { persistCacheListing.run(String(id), JSON.stringify({ listing, chatId: null }), expiresAt); } catch (_) {}
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
  return SOURCE_BADGES[source] || `🏠 ${source || 'Listing'}`;
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
 
    // Not linked — prompt for email to self-serve reconnect, or subscribe
    pendingLinkState.set(chatId, true);
    await bot.sendMessage(chatId,
      `👋 Hi! HomeSeeker sends real-time Telegram alerts for Dutch housing listings.\n\n` +
      `🔗 Start your 7-day free trial:\n👉 https://homeseeker.dev\n\n` +
      `Already subscribed? Reply with the email address you used when signing up and we'll connect your account instantly.`
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
      const cacheId = data.replace('ai_letter:', '');
      const listing = getCachedListing(cacheId);
      if (!listing?.url) {
        return bot.sendMessage(chatId, '❌ Listing expired. Tap AI Letter on a fresh alert.');
      }
      const user = getUser.get(chatId);

      // Auto-select all letter-safe tips, max 3
      const score = calculateScore(listing, user || {});
      const dealScore = calculateDealScore(listing);
      const { tips } = getImprovementTips(listing, user || {}, score, dealScore);
      const selectedTips = tips
        .filter(t => !SKIP_LETTER_CATS.has(t.category))
        .slice(0, 3)
        .map(t => t.tip);

      await generateAndSendLetter(chatId, listing, user, selectedTips);

      // Offer web customization
      const letterUrl = `${BASE_URL}/letter?id=${cacheId}`;
      await bot.sendMessage(chatId, '✏️ Want a more personalised letter? Customise it here:', {
        reply_markup: {
          inline_keyboard: [[{ text: 'Open letter generator →', url: letterUrl }]],
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
  if (ageMs < 2 * 60 * 60 * 1000) return 'New listing';
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
  const inkomen = user ? ((user.inkomen || 0) + (user.partner_inkomen || 0)) : 0;
  const price = listing.priceNumber || 0;

  const ageMs = listing.listedAt ? Date.now() - new Date(listing.listedAt).getTime() : null;

  const intent = detectLandlordIntent(listing.description || '');
  const sigKeys = intent.signals.map(s => s.key);
  const warningKeys = intent.warnings.map(w => w.key);
  const conflicts = [];
  if (user) {
    if (warningKeys.includes('no_students') && user.profiel_type === 'student') conflicts.push('no_students');
    if (warningKeys.includes('no_couples') && user.met_partner === 'ja') conflicts.push('no_couples');
    if (warningKeys.includes('family_only') && user.met_partner !== 'ja') conflicts.push('family_only');
    if (warningKeys.includes('working_only') && user.contract_type === 'student') conflicts.push('working_only');
  }

  const lines = [];

  // Line 1: source badge
  lines.push(getPlatformBadge(listing.source));

  // Line 2: address + city, bold
  const cityStr = cityDisplay || listing.city || '';
  lines.push(`📍 *${address}${cityStr ? ', ' + cityStr : ''}*`);

  // Bullet details
  if (listing.area) lines.push(`• ${listing.area}m²`);
  if (isHuur && listing.priceNumber) {
    lines.push(`• Rent: ${priceStr}/mo`);
    if (monthlyCost) lines.push(`• Est. total: €${monthlyCost.toLocaleString('nl-NL')}/mo`);
  } else {
    lines.push(`• ${priceStr}${isHuur ? '/mo' : ''}`);
  }

  // Audience signals
  if (sigKeys.includes('expat_with_family')) lines.push('🌍 Expat-friendly listing');
  else if (sigKeys.includes('students_welcome')) lines.push('🎓 Students welcome');
  else if (sigKeys.includes('young_professional')) lines.push('💼 Young professionals preferred');

  // Profile mismatch
  if (conflicts.length > 0) lines.push('⛔ Possible mismatch: read landlord requirements carefully');

  // Scores
  const dealDisplay = dealScore != null ? valueLabel(dealScore) : 'Insufficient data';
  lines.push('');
  lines.push(`*Application: ${appLabel(score)}*`);
  lines.push(bar(score, appFill(score)));
  lines.push('');
  lines.push(`*Market Value: ${dealDisplay}*`);
  if (dealScore != null) lines.push(bar(dealScore, dealFill(dealScore)));

  // Warnings
  if (intent.warnings.length > 0) {
    lines.push('');
    intent.warnings.forEach(w => lines.push(`⚠️ ${w.label}`));
  }

  // Boost tips — always fully included, never truncated
  if (user && score < 85) {
    const { tips } = getImprovementTips(listing, user, score, dealScore);
    if (tips.length > 0) {
      lines.push('');
      lines.push('*Boost your application:*');
      tips.forEach((t, i) => { lines.push(''); lines.push(`${i + 1}. ${t.tip}`); });
    }
  }

  // Verdict
  if (user) {
    let verdict = '';
    const isVeryFresh = ageMs !== null && !isNaN(ageMs) && ageMs < 30 * 60 * 1000;
    if (isVeryFresh && score > 70) {
      verdict = 'Strong match — new listing: apply now.';
    } else if (score >= 80) {
      verdict = 'Strong match: apply today, you have a real chance.';
    } else if (score >= 65) {
      verdict = 'Good match: worth a strong application.';
    } else if (score >= 50) {
      verdict = 'Decent match: apply with a guarantor or strong intro.';
    } else if (score >= 35) {
      verdict = 'Weak match: address the gaps above before applying.';
    } else {
      verdict = 'Very weak match: significant barriers to this listing.';
    }
    lines.push('');
    lines.push(verdict);
  }

  const fullText = lines.join('\n');
  const cacheId = cacheListing(listing, chatId);
 
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'View listing', url: listing.url },
        { text: 'AI Letter', callback_data: `ai_letter:${cacheId}` },
      ],
      [
        { text: 'Share', callback_data: `share:${cacheId}` },
        { text: 'Unsubscribe', callback_data: 'unsubscribe' },
      ],
    ],
  };
 
  const imageUrl = (listing.image && /^https?:\/\//.test(listing.image))
    ? listing.image
    : (SOURCE_PLACEHOLDERS[listing.source] || GENERIC_PLACEHOLDER);

  // Try sendPhoto with full text; if caption too long or photo fails, fall back to sendMessage
  let sent = false;
  try {
    await _bot.sendPhoto(chatId, imageUrl, {
      caption: fullText,
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    sent = true;
  } catch (_) {}

  if (!sent) {
    try {
      await _bot.sendMessage(chatId, fullText, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        disable_web_page_preview: true,
      });
    } catch (e) {
      console.error(`[telegram] Failed to send alert to ${chatId}:`, e.message);
    }
  }
  return cacheId;
}

function processWebhookUpdate(update) {
  if (bot) bot.processUpdate(update);
}
 
module.exports = { createBot, getBot, sendAlert, processWebhookUpdate, clearLetterState, generateStartPayload, injectCachedListing, getCachedEntry };
 