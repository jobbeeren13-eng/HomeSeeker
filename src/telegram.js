const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { getUser, getUserByEmail, getListingByUrl, getUserByCustomerId, linkChatToCustomer, clearChatIdFromOthers, setUserChatId, upsertChat, setUserActive, cancelUserByChatId, persistCacheListing, getPersistedCacheListing, purgeExpiredCacheListings } = require('./database');
const { rowToListing } = require('./scraper');
const { getImprovementTips, detectLandlordIntent } = require('./score');
 
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
  funda: 'https://via.placeholder.com/800x400/0a0a0a/00c896?text=Funda',
  kamernet: 'https://via.placeholder.com/800x400/0a0a0a/00c896?text=Kamernet',
  housinganywhere: 'https://via.placeholder.com/800x400/0a0a0a/00c896?text=HousingAnywhere',
  pararius: 'https://via.placeholder.com/800x400/0a0a0a/00c896?text=Pararius',
  huurwoningen: 'https://via.placeholder.com/800x400/0a0a0a/00c896?text=Huurwoningen',
  jaap: 'https://via.placeholder.com/800x400/0a0a0a/00c896?text=Jaap',
};
const GENERIC_PLACEHOLDER = 'https://via.placeholder.com/800x400/0a0a0a/00c896?text=HomeSeeker';

let bot = null;
const letterState = new Map();
const pendingLinkState = new Map(); // chatId -> true, waiting for email input
const listingCache = new Map();
let listingCacheId = 0;

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
  const id = String(++listingCacheId);
  const expiresAt = Date.now() + CACHE_TTL_MS;
  listingCache.set(id, { listing, chatId, score, dealScore, expiresAt });
  try { persistCacheListing.run(id, JSON.stringify({ listing, chatId, score, dealScore }), expiresAt); } catch (_) {}
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

  bot.onText(/\/tools/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!hasAccess(chatId)) return denyAccess(chatId);
    await bot.sendMessage(chatId, '🛠 *HomeSeeker Tools*\n\nAll the tools to help you find and secure a home in the Netherlands:', {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🤖 Rental Assistant', url: `${BASE_URL}/tools/rent-assistant?chat_id=${chatId}` }, { text: '💬 Landlord Reply Coach', url: `${BASE_URL}/tools/landlord-reply` }],
          [{ text: '🔍 Rejection Analyser', url: `${BASE_URL}/tools/rejection-analyser` }, { text: '💰 Income Check', url: `${BASE_URL}/tools/income-check` }],
          [{ text: '📄 Reference Letters', url: `${BASE_URL}/tools/reference-letter` }, { text: '👁 Viewing Feedback', url: `${BASE_URL}/tools/viewing-feedback` }],
          [{ text: '⚖️ Tenant Rights', url: `${BASE_URL}/tools/tenant-rights` }, { text: '📖 Rental Guide', url: `${BASE_URL}/guide/rent` }],
          [{ text: '🏡 Buyer Assistant', url: `${BASE_URL}/tools/buy-assistant?chat_id=${chatId}` }, { text: '🎯 Deal Finder', url: `${BASE_URL}/tools/deal-finder` }],
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

  // Line 1: source badge (platform only)
  lines.push(getPlatformBadge(listing.source));

  // Line 2: address + city, bold
  const cityStr = cityDisplay || listing.city || '';
  lines.push(`📍 *${address}${cityStr ? ', ' + cityStr : ''}*`);

  // Bullet details
  if (listing.area) lines.push(`• ${listing.area}m²`);
  if (isHuur && listing.priceNumber) {
    lines.push(`• Rent: ${priceStr}/mo`);
    if (listing.area && listing.priceNumber) {
      const ppm2 = Math.round(listing.priceNumber / listing.area);
      lines.push(`• ${ppm2}/m²`);
    }
    if (monthlyCost) lines.push(`• Est. total: €${monthlyCost.toLocaleString('nl-NL')}/mo`);
  } else if (!isHuur && listing.priceNumber) {
    lines.push(`• ${priceStr}`);
    if (listing.area && listing.priceNumber) {
      const ppm2 = Math.round(listing.priceNumber / listing.area);
      lines.push(`• ${ppm2}/m²`);
    }
  } else {
    lines.push(`• ${priceStr}${isHuur ? '/mo' : ''}`);
  }

  // Audience signals
  if (sigKeys.includes('expat_with_family')) lines.push('🌍 Expat-friendly listing');
  else if (sigKeys.includes('students_welcome')) lines.push('🎓 Students welcome');
  else if (sigKeys.includes('young_professional')) lines.push('💼 Young professionals preferred');

  // Profile mismatch BEFORE scores so it is seen immediately
  if (conflicts.length > 0) {
    lines.push('');
    lines.push('⛔ *Possible profile mismatch. Read landlord requirements carefully.*');
  }

  // Scores
  const dealDisplay = dealScore != null ? valueLabel(dealScore) : 'Insufficient data';
  lines.push('');
  lines.push(`*Application: ${appLabel(score)}*`);
  lines.push(bar(score, appFill(score)));
  lines.push('');
  lines.push(`*Market Value: ${dealDisplay}*`);
  if (dealScore != null) lines.push(bar(dealScore, dealFill(dealScore)));

  // Deal score bar for koop listings
  if (!isHuur && listing.priceNumber && listing.area) {
    const BUYER_BENCHMARKS = { amsterdam: 6800, utrecht: 5100, rotterdam: 4200, denhaag: 4400, haarlem: 5200, eindhoven: 3800, leiden: 4900, delft: 4600, groningen: 3100, maastricht: 3200 };
    const cityKey = (listing.city || '').toLowerCase().replace(/[-\s]/g, '');
    const bench = BUYER_BENCHMARKS[cityKey] || null;
    if (bench) {
      const ppm2 = Math.round(listing.priceNumber / listing.area);
      const diff = (ppm2 - bench) / bench;
      let buyDealScore = 50;
      if (diff < -0.15) buyDealScore = 85;
      else if (diff < -0.05) buyDealScore = 70;
      else if (diff < 0.10) buyDealScore = 50;
      else if (diff < 0.20) buyDealScore = 30;
      else buyDealScore = 15;
      const dealFillFn = (pct) => pct >= 60 ? '🟩' : pct >= 35 ? '🟨' : '🟥';
      const dealLabelFn = (pct) => pct >= 65 ? 'Good deal' : pct >= 40 ? 'Fair price' : 'Overpriced';
      lines.push('');
      lines.push(`*Deal Score: ${dealLabelFn(buyDealScore)}*`);
      lines.push(bar(buyDealScore, dealFillFn(buyDealScore)));
    }
  }

  // Warnings
  if (intent.warnings.length > 0) {
    lines.push('');
    intent.warnings.forEach(w => lines.push(`⚠️ ${w.label}`));
  }

  // Tips
  if (user) {
    if (isHuur) {
      const { tips } = getImprovementTips(listing, user, score, dealScore);
      lines.push('');
      tips.slice(0, 5).forEach((t, i) => { lines.push(''); lines.push(`*${i + 1}.* ${t.tip}`); });
    } else {
      // Buyer-specific tips for koop listings
      const buyerTips = [];
      if (listing.area && listing.priceNumber) {
        const ppm2 = Math.round(listing.priceNumber / listing.area);
        const cityLower = (listing.city || '').toLowerCase().replace(/-/g, '');
        const BENCHMARKS = { amsterdam: 6800, utrecht: 5100, rotterdam: 4200, denhaag: 4400, haarlem: 5200, eindhoven: 3800, leiden: 4900, delft: 4600, groningen: 3100, maastricht: 3200 };
        const benchmark = BENCHMARKS[cityLower] || null;
        if (benchmark && ppm2 > benchmark * 1.10) {
          buyerTips.push(`At ${ppm2}/m² you are paying above the ${cityStr || 'local'} average - get a valuation before bidding`);
        } else if (benchmark && ppm2 < benchmark * 0.90) {
          buyerTips.push(`At ${ppm2}/m² this is below market - move quickly, expect competing bids`);
        }
      }
      const cityLower2 = (listing.city || '').toLowerCase().replace(/-/g, '');
      const hotBuyerCities = ['amsterdam', 'utrecht', 'haarlem'];
      if (hotBuyerCities.includes(cityLower2)) {
        buyerTips.push(`Overbidding is common in ${cityStr || 'this area'} - budget 8-15% above asking`);
      } else {
        buyerTips.push('Overbidding of 3-8% is typical in this area - research recent sold prices on Kadaster');
      }
      buyerTips.push('Always include financing condition (voorbehoud financiering) and check VvE costs if apartment - can add 200+ euros per month');
      lines.push('');
      lines.push('*Buyer Tips:*');
      buyerTips.slice(0, 3).forEach((t, i) => { lines.push(''); lines.push(`${i + 1}. ${t}`); });
    }
  }

  // Verdict
  if (user) {
    let verdict = '';
    const isJustListed = ageMs !== null && !isNaN(ageMs) && ageMs < 60 * 60 * 1000;
    if (score >= 80 && isJustListed) {
      verdict = 'Strong match on a fresh listing. Apply now.';
    } else if (score >= 80) {
      verdict = 'Strong match. Worth a serious application.';
    } else if (score >= 65) {
      verdict = 'Good match. A strong application gives you a real chance.';
    } else if (score >= 50) {
      verdict = 'Decent match. Address the gaps above before applying.';
    } else if (score >= 35) {
      verdict = 'Weak match. Significant barriers - read the tips carefully.';
    } else {
      verdict = 'Very weak match. The gaps above make this a long shot.';
    }
    lines.push('');
    lines.push(verdict);
  }

  const fullText = lines.join('\n');
  const cacheId = cacheListing(listing, chatId, score, dealScore);
 
  const keyboard = isHuur ? {
    inline_keyboard: [
      [
        { text: 'View listing', url: listing.url },
        { text: 'AI Letter', callback_data: `ai_letter:${cacheId}` },
      ],
      [
        { text: 'AI Rental Assistant', url: `${BASE_URL}/tools/rent-assistant?chat_id=${chatId}&listing=${cacheId}` },
        { text: 'Share', callback_data: `share:${cacheId}` },
      ],
      [{ text: 'Unsubscribe', callback_data: 'unsubscribe' }],
    ],
  } : {
    inline_keyboard: [
      [
        { text: 'View listing', url: listing.url },
        { text: 'AI Buyer Assistant', url: `${BASE_URL}/tools/buy-assistant?chat_id=${chatId}&listing=${cacheId}` },
      ],
      [
        { text: 'Deal Score', url: `${BASE_URL}/tools/deal-finder?chat_id=${chatId}` },
        { text: 'Share', callback_data: `share:${cacheId}` },
      ],
      [{ text: 'Unsubscribe', callback_data: 'unsubscribe' }],
    ],
  };
 
  const hasRealImage = listing.image && /^https?:\/\//.test(listing.image);
  console.log('[telegram] alert text length:', fullText.length);

  // sendPhoto caps captions at 1024 chars — long captions hide keyboard rows.
  // Only use sendPhoto when text fits; otherwise send image first, then text+keyboard.
  let sent = false;
  if (hasRealImage && fullText.length <= 900) {
    try {
      await sendWithRetry(_bot, 'sendPhoto', chatId, listing.image, {
        caption: fullText,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      sent = true;
    } catch (_) {}
  }

  if (!sent) {
    if (hasRealImage) {
      try { await sendWithRetry(_bot, 'sendPhoto', chatId, listing.image, {}); } catch (_) {}
    }
    try {
      await sendWithRetry(_bot, 'sendMessage', chatId, fullText, {
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
 
module.exports = { createBot, getBot, sendAlert, processWebhookUpdate, clearLetterState, generateStartPayload, injectCachedListing, getCachedEntry };
 