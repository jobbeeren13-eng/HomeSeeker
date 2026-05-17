const TelegramBot = require('node-telegram-bot-api');
const { getUser, getListingByUrl, upsertChat, setUserActive, cancelUserByChatId } = require('./database');
const { generateLetter } = require('./letter');
const { rowToListing } = require('./scraper');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const PRIVATE_MSG = `Sorry, this is a private service. 

To get access, visit:
👉 https://homeseeker.app

After subscribing, come back here and send /start.`;

const SOURCE_BADGES = {
  funda: '🔵 Funda',
  pararius: '🟣 Pararius',
  kamernet: '🟠 Kamernet',
  huurwoningen: '🟢 Huurwoningen',
  jaap: '🟡 Jaap',
};

const LETTER_QUESTIONS = [
  "What's your current living situation and why are you moving?",
  'Tell us about your work situation (employer, contract type, duration).',
  'Anything else the landlord should know? (pets, partner, etc.) — or type *skip*',
];

let bot = null;
const letterState = new Map();
const listingCache = new Map();
let listingCacheId = 0;

function cacheListing(listing) {
  const id = String(++listingCacheId);
  listingCache.set(id, listing);
  if (listingCache.size > 500) {
    const oldest = listingCache.keys().next().value;
    listingCache.delete(oldest);
  }
  return id;
}

function getCachedListing(id, fallbackUrl) {
  return listingCache.get(id) || listingFromUrl(fallbackUrl);
}

function hasAccess(chatId) {
  const user = getUser.get(String(chatId));
  return !!(user && user.betaald === 1 && user.actief === 1);
}

async function denyAccess(chatId) {
  await bot.sendMessage(chatId, PRIVATE_MSG);
}

function clearLetterState(chatId) {
  letterState.delete(String(chatId));
}

function getPlatformBadge(source) {
  return SOURCE_BADGES[source] || `📋 ${source || 'Listing'}`;
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

async function sendStyleChoice(chatId, listing) {
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
  const subject = encodeURIComponent(`Interesse in ${listing.address || 'huurwoning'}`);
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

  bot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);
    clearLetterState(chatId);
    upsertChat.run(chatId, msg.from?.username || '', msg.from?.first_name || '');

    if (!hasAccess(chatId)) return denyAccess(chatId);

    const filterUrl = `${BASE_URL}/filters?chat_id=${chatId}`;
    await bot.sendMessage(chatId,
      `🏠 *Welcome to HomeSeeker!*\n\nI'll send you real-time alerts when new listings appear on Dutch housing platforms that match your criteria.\n\nSet your filters to get started:`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⚙️ Set my filters', url: filterUrl }]] },
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
      const id = data.replace('ai_letter:', '');
      const listing = getCachedListing(id);
      if (!listing?.url) {
        return bot.sendMessage(chatId, '❌ Listing expired. Tap AI Letter on a fresh alert.');
      }
      letterState.set(chatId, {
        step: 'style',
        listing,
        style: null,
        answers: [],
        generatedLetter: null,
      });
      await sendStyleChoice(chatId, listing);
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
    const state = letterState.get(chatId);
    if (!state) return;

    if (!hasAccess(chatId)) {
      clearLetterState(chatId);
      return denyAccess(chatId);
    }

    const text = msg.text.trim();
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
        console.error('[letter] Error:', err.message);
        clearLetterState(chatId);
        await bot.sendMessage(chatId, '❌ Something went wrong generating the letter. Please try again.');
      }
    }
  });

  console.log('[telegram] Bot started (polling=%s)', !useWebhook);
  return bot;
}

function getBot() { return bot; }

async function sendAlert(chatId, listing, score, label, dealScore, dLabel, user = null) {
  if (!bot) return;

  clearLetterState(chatId);

  const priceStr = listing.price || (listing.priceNumber
    ? `€${listing.priceNumber.toLocaleString('nl-NL')}`
    : '—');
  const cityDisplay = formatCityDisplay(listing.city);
  const badge = getPlatformBadge(listing.source);
  const priceLine = listing.transactionType === 'huur'
    ? `${priceStr}/month`
    : priceStr;

  const filterLines = [];
  if (user) {
    if (user.prijs_max && listing.priceNumber && listing.priceNumber <= user.prijs_max) {
      filterLines.push('- Max price: ✓ within budget');
    }
    if (user.kamers_min && listing.rooms && listing.rooms >= user.kamers_min) {
      filterLines.push('- Min rooms: ✓');
    }
    if (user.locatie && listing.city && listing.city === user.locatie) {
      filterLines.push('- Location: ✓');
    }
  }

  const filterSection = filterLines.length
    ? `\n✅ *Matches your filters:*\n${filterLines.join('\n')}`
    : '';

  const text = [
    `🏠 *${listing.address || 'New listing'}*`,
    `📍 ${cityDisplay || '—'}`,
    `💶 ${priceLine}`,
    badge,
    ``,
    `🎯 *Chance:* ${score}% — ${label}`,
    `💎 *Deal:* ${dealScore !== null ? `${dealScore}% — ${dLabel}` : dLabel}`,
    filterSection || null,
  ].filter(s => s !== null).join('\n');

  const cacheId = cacheListing(listing);
  const shareData = `share:${cacheId}`;
  const letterData = `ai_letter:${cacheId}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🔗 View listing', url: listing.url },
        { text: '✉️ AI Letter', callback_data: letterData },
      ],
      [
        { text: '📤 Share', callback_data: shareData },
        { text: '❌ Unsubscribe', callback_data: 'unsubscribe' },
      ],
    ],
  };

  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error(`[telegram] Failed to send alert to ${chatId}:`, err.message);
  }
}

function processWebhookUpdate(update) {
  if (bot) bot.processUpdate(update);
}

module.exports = { createBot, getBot, sendAlert, processWebhookUpdate, clearLetterState };
