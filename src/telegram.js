const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { getUser, getUserByEmail, getListingByUrl, getUserByCustomerId, linkChatToCustomer, clearChatIdFromOthers, setUserChatId, upsertChat, setUserActive, cancelUserByChatId, persistCacheListing, getPersistedCacheListing, purgeExpiredCacheListings } = require('./database');
const { generateLetter, generateLetterDirect } = require('./letter');
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

const LETTER_QUESTIONS = [
  "What's your current living situation and why are you moving?",
  'Tell us about your work situation (employer, contract type, duration).',
  'Anything else the landlord should know? (pets, partner, etc.) Type *skip* to skip.',
];
 
let bot = null;
const letterState = new Map();
const pendingLinkState = new Map(); // chatId -> true, waiting for email input
const listingCache = new Map();
let listingCacheId = 0;

// Tip-selection state for interactive AI letter flow
// key: `${chatId}:${messageId}`, value: { cacheId, tips: [{text, selected}], expiresAt }
const tipSelectionState = new Map();
const TIP_SEL_TTL = 4 * 60 * 60 * 1000; // 4 hours

// Summarise a tip for use in a button label — strips filler, truncates at word boundary.
// Max 45 chars so all buttons render at roughly the same width.
function summariseTipLabel(text, maxLen = 45) {
  let s = text.replace(/^(make sure to|verify what is|ensure that|check that|remember to|try to)\s+/i, '');
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen + 1).replace(/\s+\S*$/, '');
  return (cut || s.slice(0, maxLen)) + '…';
}

function buildSelectionKeyboard(cacheId, tips) {
  const rows = tips.map((t, i) => [{
    text: `${t.selected ? '[x]' : '[ ]'} ${i + 1}. ${summariseTipLabel(t.text)}`,
    callback_data: `tgl:${i}`,
  }]);
  rows.push([
    { text: '✉️ Write my letter', callback_data: 'alg' },
    { text: 'Skip →', callback_data: `ald:${cacheId}` },
  ]);
  return { inline_keyboard: rows };
}

// Shared letter-generation helper used by both ai_letter and alg handlers
async function generateAndSendLetter(chatId, listing, user, selectedTips, usedIndices) {
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
    if (usedIndices && usedIndices.length > 0) {
      await bot.sendMessage(chatId, `_Addressed in letter: ${usedIndices.join(', ')}_`, { parse_mode: 'Markdown' });
    }
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

function cacheListing(listing) {
  const id = String(++listingCacheId);
  const expiresAt = Date.now() + CACHE_TTL_MS;
  listingCache.set(id, { listing, expiresAt });
  try { persistCacheListing.run(id, JSON.stringify(listing), expiresAt); } catch (_) {}
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

function getCachedListing(id) {
  const entry = listingCache.get(id);
  if (entry) {
    if (entry.expiresAt < Date.now()) { listingCache.delete(id); }
    else return entry.listing;
  }
  // Fall back to persistent DB cache (survives restarts)
  try {
    const row = getPersistedCacheListing.get(String(id), Date.now());
    if (row) {
      const listing = JSON.parse(row.listing_json);
      listingCache.set(id, { listing, expiresAt: Date.now() + CACHE_TTL_MS });
      return listing;
    }
  } catch (_) {}
  return null;
}

function injectCachedListing(id, listing) {
  const expiresAt = Date.now() + CACHE_TTL_MS;
  listingCache.set(String(id), { listing, expiresAt });
  try { persistCacheListing.run(String(id), JSON.stringify(listing), expiresAt); } catch (_) {}
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
 
async function sendStyleChoice(chatId) {
  await bot.sendMessage(chatId, 'Choose your letter style:', {
    reply_markup: {
      inline_keyboard: [[
        { text: '🎯 Professional', callback_data: 'letter_style:professional' },
        { text: '😊 Friendly', callback_data: 'letter_style:friendly' },
        { text: '🌍 Expat', callback_data: 'letter_style:expat' },
      ]],
    },
  });
}
 
async function sendLetterOptions(chatId, listing, letter) {
  const subject = encodeURIComponent(`Application for ${listing.address || 'property'}`);
  const body = encodeURIComponent(letter);
  const mailtoLink = `mailto:?subject=${subject}&body=${body}`;
  const waLink = `https://wa.me/?text=${encodeURIComponent(letter)}`;
 
  await bot.sendMessage(chatId, '✅ Your letter is ready! Choose how to send it:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Copy letter', callback_data: 'letter_copy' }],
        [{ text: '📧 Open in email', url: mailtoLink }],
        [{ text: '💬 WhatsApp', url: waLink }],
      ],
    },
  });
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

      // Compute tips for the selection UI (recomputed fresh so they match listing context)
      const score = calculateScore(listing, user || {});
      const dealScore = calculateDealScore(listing);
      const { tips } = getImprovementTips(listing, user || {}, score, dealScore);

      if (!tips.length) {
        // No tips available — generate immediately without selection step
        await generateAndSendLetter(chatId, listing, user, []);
        return;
      }

      // Show tip-selection keyboard — only first tip pre-selected
      const selTips = tips.map((t, i) => ({ text: t.tip, selected: i === 0 }));
      const selMsg = await bot.sendMessage(
        chatId,
        '✉️ *Personalise your letter*\n\nSelect the points you want addressed:\n_(tap to select or deselect)_',
        { parse_mode: 'Markdown', reply_markup: buildSelectionKeyboard(cacheId, selTips) }
      );

      // Store state keyed by chatId:messageId
      const stateKey = `${chatId}:${selMsg.message_id}`;
      tipSelectionState.set(stateKey, { cacheId, tips: selTips, expiresAt: Date.now() + TIP_SEL_TTL });
      // Lazy cleanup of expired states
      if (tipSelectionState.size > 200) {
        const now = Date.now();
        for (const [k, v] of tipSelectionState) { if (v.expiresAt < now) tipSelectionState.delete(k); }
      }
      return;
    }

    // Toggle a tip checkbox — updates keyboard in-place, no new message
    if (data.startsWith('tgl:')) {
      const tipIndex = parseInt(data.split(':')[1]);
      const stateKey = `${chatId}:${query.message.message_id}`;
      const state = tipSelectionState.get(stateKey);
      if (!state || state.expiresAt < Date.now()) return;
      if (tipIndex >= 0 && tipIndex < state.tips.length) {
        state.tips[tipIndex].selected = !state.tips[tipIndex].selected;
        try {
          await bot.editMessageReplyMarkup(
            buildSelectionKeyboard(state.cacheId, state.tips),
            { chat_id: chatId, message_id: query.message.message_id }
          );
        } catch (_) {}
      }
      return;
    }

    // Generate letter with selected tips
    if (data === 'alg') {
      const stateKey = `${chatId}:${query.message.message_id}`;
      const state = tipSelectionState.get(stateKey);
      if (!state || state.expiresAt < Date.now()) {
        return bot.sendMessage(chatId, '❌ Selection expired. Please tap AI Letter on a fresh alert.');
      }
      tipSelectionState.delete(stateKey);
      const listing = getCachedListing(state.cacheId);
      if (!listing?.url) {
        return bot.sendMessage(chatId, '❌ Listing expired. Tap AI Letter on a fresh alert.');
      }
      const user = getUser.get(chatId);
      const selectedTips = state.tips.filter(t => t.selected).map(t => t.text);
      const usedIndices = state.tips.map((t, i) => t.selected ? i + 1 : null).filter(Boolean);
      await generateAndSendLetter(chatId, listing, user, selectedTips, usedIndices);
      return;
    }

    // Quick letter — bypass tip selection entirely
    if (data.startsWith('ald:')) {
      const cacheId = data.slice(4);
      const listing = getCachedListing(cacheId);
      if (!listing?.url) {
        return bot.sendMessage(chatId, '❌ Listing expired. Tap AI Letter on a fresh alert.');
      }
      const user = getUser.get(chatId);
      await generateAndSendLetter(chatId, listing, user, []);
      return;
    }
 
    if (data.startsWith('letter_style:')) {
      const style = data.replace('letter_style:', '');
      const state = letterState.get(chatId);
      if (!state) return;
      state.style = style;
      state.step = 'q1';
      state.answers = [];
      await bot.sendMessage(chatId, LETTER_QUESTIONS[0], { parse_mode: 'Markdown' });
      return;
    }
 
    if (data === 'letter_copy') {
      const state = letterState.get(chatId);
      if (!state?.generatedLetter) {
        return bot.sendMessage(chatId, '❌ No letter found. Start again from a listing alert.');
      }
      await bot.sendMessage(chatId, state.generatedLetter);
      clearLetterState(chatId);
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

    const state = letterState.get(chatId);
    if (!state) return;

    if (!hasAccess(chatId)) {
      clearLetterState(chatId);
      return denyAccess(chatId);
    }

    const qIndex = { q1: 0, q2: 1, q3: 2 }[state.step];
    if (qIndex === undefined) return;
 
    state.answers[qIndex] = text === 'skip' ? '' : text;
 
    if (state.step === 'q1') {
      state.step = 'q2';
      return bot.sendMessage(chatId, LETTER_QUESTIONS[1]);
    }
    if (state.step === 'q2') {
      state.step = 'q3';
      return bot.sendMessage(chatId, LETTER_QUESTIONS[2], { parse_mode: 'Markdown' });
    }
    if (state.step === 'q3') {
      state.step = 'done';
      await bot.sendMessage(chatId, '✍️ Generating your application letter…');
      try {
        const user = getUser.get(chatId);
        const letter = await generateLetter({
          style: state.style,
          listing: state.listing,
          user,
          answers: state.answers,
        });
        state.generatedLetter = letter;
        await sendLetterOptions(chatId, state.listing, letter);
      } catch (err) {
        console.error('[letter] Error:', err);
        clearLetterState(chatId);
        await bot.sendMessage(chatId, '❌ Something went wrong generating the letter. Please try again.');
      }
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

  function bar(pct) {
    const total = 10;
    const filled = Math.round((pct / 100) * total);
    const dot = pct >= 70 ? '🟩' : pct >= 40 ? '🟨' : '🟥';
    return dot.repeat(filled) + '⬜'.repeat(total - filled) + `  ${pct}%`;
  }

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
  const maxHuur = inkomen / 3;
  const price = listing.priceNumber || 0;
  const incomeRatio = (inkomen > 0 && price > 0) ? Math.round((price / maxHuur) * 10) / 10 : null;

  // Freshness & price drop signals
  const ageMs = listing.listedAt ? Date.now() - new Date(listing.listedAt).getTime() : null;
  const isJustListed = ageMs !== null && !isNaN(ageMs) && ageMs < 60 * 60 * 1000;
  const hasPriceDrop = detectPriceDrop(`${listing.address || ''} ${listing.description || ''}`);

  const lines = [];

  // Source badge + freshness badge — first line
  let sourceLine = getPlatformBadge(listing.source);
  if (hasPriceDrop) sourceLine += '  📉 Price reduced';
  lines.push(sourceLine);

  // Header: address + city on one line
  const cityStr = cityDisplay || listing.city || '';
  lines.push(`📍 *${address}${cityStr ? `, ${cityStr}` : ''}*`);

  // Audience badge (expat / student priority)
  const intentEarly = detectLandlordIntent(listing.description || '');
  const sigKeys = intentEarly.signals.map(s => s.key);
  if (sigKeys.includes('expat_with_family')) lines.push('🌍 Expat-friendly listing');
  else if (sigKeys.includes('students_welcome')) lines.push('🎓 Students welcome');
  else if (sigKeys.includes('young_professional')) lines.push('💼 Young professionals preferred');

  lines.push('');
  if (listing.area) lines.push(`• ${listing.area}m²`);
  lines.push(`• Rent: ${priceStr}${isHuur ? '/mo' : ''}`);
  if (monthlyCost) lines.push(`• Est. total: €${monthlyCost.toLocaleString('nl-NL')}/mo`);

  // Landlord warnings & profile mismatch — always, regardless of score
  const intent = intentEarly;
  const warningKeys = intent.warnings.map(w => w.key);
  const conflicts = [];
  if (user) {
    if (warningKeys.includes('no_students') && user.profiel_type === 'student') conflicts.push('no_students');
    if (warningKeys.includes('no_couples') && user.met_partner === 'ja') conflicts.push('no_couples');
    if (warningKeys.includes('family_only') && user.met_partner !== 'ja') conflicts.push('family_only');
    if (warningKeys.includes('working_only') && user.contract_type === 'student') conflicts.push('working_only');
  }
  if (conflicts.length > 0) {
    lines.push('');
    lines.push('⛔ *Possible mismatch: read landlord requirements carefully*');
  }

  // Scores — Application and Market Value run flush together (no blank between)
  lines.push('');
  lines.push(`*Application: ${appLabel(score)}*`);
  lines.push(bar(score));
  const dealDisplay = dealScore != null ? valueLabel(dealScore) : 'Insufficient data';
  lines.push(`*Market Value: ${dealDisplay}*`);
  if (dealScore != null) lines.push(bar(dealScore));

  // Sections: warnings first (deal-breakers), then boost tips, then verdict
  let warningSection = '';
  let boostSection = '';
  if (intent.warnings.length > 0) {
    warningSection = '\n\n' + intent.warnings.map(w => `⚠️ ${w.label}`).join('\n');
  }
  if (user && score < 85) {
    const { tips } = getImprovementTips(listing, user, score, dealScore);
    if (tips.length > 0) {
      const SEP = '*- - - - - - - - - - -*';
      boostSection = '\n\n*Boost your application:*\n' +
        tips.map((t, i) => (i > 0 ? SEP + '\n' : '') + `${i + 1}. ${t.tip}`).join('\n');
    }
  }

  let verdictSection = '';
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
    verdictSection = '\n\n' + verdict;
  }

  const coreText = lines.join('\n');

  // Full text for sendMessage (max 4000 chars)
  let text = coreText + warningSection + boostSection + verdictSection;
  if (text.length > 4000) text = coreText + warningSection + verdictSection;
  if (text.length > 4000) text = coreText + verdictSection;
  if (text.length > 4000) text = text.slice(0, 3997) + '…';

  // Photo caption (max 1024 chars — progressively strip boost tips to fit)
  let photoCaption = coreText + warningSection + boostSection + verdictSection;
  if (photoCaption.length > 1024) photoCaption = coreText + warningSection + verdictSection;
  if (photoCaption.length > 1024) photoCaption = coreText + verdictSection;
  if (photoCaption.length > 1024) photoCaption = photoCaption.slice(0, 1021) + '…';
  const cacheId = cacheListing(listing);
 
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

  let sent = false;
  try {
    await _bot.sendPhoto(chatId, imageUrl, {
      caption: photoCaption,
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    sent = true;
  } catch (photoErr) {
    console.warn('[telegram] sendPhoto failed (%s), retrying with placeholder', (photoErr.message || '').slice(0, 80));
  }

  if (!sent && imageUrl !== GENERIC_PLACEHOLDER) {
    try {
      await _bot.sendPhoto(chatId, GENERIC_PLACEHOLDER, {
        caption: photoCaption,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
      sent = true;
    } catch (_) {}
  }

  if (!sent) {
    try {
      await _bot.sendMessage(chatId, text, {
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
 
module.exports = { createBot, getBot, sendAlert, processWebhookUpdate, clearLetterState, generateStartPayload, injectCachedListing };
 