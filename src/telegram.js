const TelegramBot = require('node-telegram-bot-api');
const { getUser, upsertChat, setUserActive, cancelUserByChatId } = require('./database');
const { generateLetter } = require('./letter');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

let bot = null;

// AI letter sessions: chat_id -> { step, data, listingUrl }
const aiSessions = new Map();

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
    console.log('[telegram] /start from chat_id=%s username=%s', msg.chat.id, msg.from?.username);
    const chatId = String(msg.chat.id);
    upsertChat.run(chatId, msg.from?.username || '', msg.from?.first_name || '');
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
    console.log('[telegram] /stop from chat_id=%s', msg.chat.id);
    const chatId = String(msg.chat.id);
    setUserActive.run(0, chatId);
    await bot.sendMessage(chatId,
      '⏸ Your alerts have been paused. Send /start anytime to resume.\n\nTo fully cancel your subscription and stop billing, use /cancel.'
    );
  });

  bot.onText(/\/cancel/, async (msg) => {
    console.log('[telegram] /cancel from chat_id=%s', msg.chat.id);
    const chatId = String(msg.chat.id);
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
    console.log('[telegram] /filters from chat_id=%s', msg.chat.id);
    const chatId = String(msg.chat.id);
    const filterUrl = `${BASE_URL}/filters?chat_id=${chatId}`;
    await bot.sendMessage(chatId, '⚙️ Update your filters here:', {
      reply_markup: { inline_keyboard: [[{ text: '⚙️ Open filter form', url: filterUrl }]] },
    });
  });

  bot.onText(/\/status/, async (msg) => {
    console.log('[telegram] /status from chat_id=%s', msg.chat.id);
    const chatId = String(msg.chat.id);
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

  // Callback query handler
  bot.on('callback_query', async (query) => {
    console.log('[telegram] callback_query data=%s chat_id=%s', query.data, query.message?.chat?.id);
    const chatId = String(query.message.chat.id);
    const data = query.data || '';
    await bot.answerCallbackQuery(query.id);

    if (data === 'unsubscribe') {
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
      await bot.sendMessage(chatId,
        '✅ Your subscription has been cancelled. You will not be charged again.\n\nWe\'re sorry to see you go! Send /start anytime to resubscribe.'
      );
      return;
    }

    if (data === 'keep_subscription') {
      await bot.sendMessage(chatId, '👍 Great! Your subscription is still active. Alerts will keep coming.');
      return;
    }

    if (data.startsWith('ai_letter:')) {
      const listingUrl = data.replace('ai_letter:', '');
      aiSessions.set(chatId, { step: 'naam', data: {}, listingUrl });
      await bot.sendMessage(chatId,
        '✉️ *Let\'s write your application letter!*\n\nI\'ll ask you 4 quick questions.\n\n*What is your full name?*',
        { parse_mode: 'Markdown' }
      );
      return;
    }
  });

  // AI letter flow: 4-step conversation
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = String(msg.chat.id);
    const session = aiSessions.get(chatId);
    if (!session) return;

    console.log('[telegram] AI letter step=%s chat_id=%s', session.step, chatId);
    const text = msg.text.trim();

    const steps = {
      naam: {
        next: 'inkomen',
        save: 'naam',
        question: '💶 *What is your gross monthly income?* (e.g. €3.500)',
      },
      inkomen: {
        next: 'verhuisdatum',
        save: 'inkomen',
        question: '📅 *When can you move in?* (e.g. "immediately", "1 June", "within 2 months")',
      },
      verhuisdatum: {
        next: 'extra',
        save: 'verhuisdatum',
        question: '💬 *Any extra info for the landlord?*\n(e.g. no pets, stable job, etc. — or type *skip*)',
      },
      extra: {
        next: 'done',
        save: 'extra',
        question: null,
      },
    };

    const currentStep = steps[session.step];
    if (!currentStep) return;

    session.data[currentStep.save] = text === 'skip' ? '' : text;

    if (currentStep.next === 'done') {
      aiSessions.delete(chatId);
      await bot.sendMessage(chatId, '✍️ Generating your application letter…');
      try {
        const listing = { url: session.listingUrl };
        const letter = await generateLetter({ ...session.data, listing });
        await bot.sendMessage(chatId,
          `📄 *Your application letter:*\n\n${letter}\n\n_Copy and send this directly to the landlord/agent._`,
          { parse_mode: 'Markdown' }
        );
        await bot.sendMessage(chatId,
          '💡 *Tip:* Personalise the first line before sending!'
        , { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('[letter] Error:', err.message);
        await bot.sendMessage(chatId, '❌ Something went wrong generating the letter. Please try again.');
      }
      return;
    }

    session.step = currentStep.next;
    await bot.sendMessage(chatId, currentStep.question, { parse_mode: 'Markdown' });
  });

  console.log('[telegram] Bot started (polling=%s)', !useWebhook);
  return bot;
}

function getBot() { return bot; }

async function sendAlert(chatId, listing, score, label, dealScore, dLabel, user = null) {
  if (!bot) return;

  const priceStr = listing.price || (listing.priceNumber ? `€${listing.priceNumber.toLocaleString('nl-NL')}` : '—');
  const cityDisplay = listing.city
    ? listing.city.charAt(0).toUpperCase() + listing.city.slice(1)
    : '';

  const detailParts = [
    listing.price || listing.priceNumber ? `💰 ${priceStr}${listing.transactionType === 'huur' ? '/month' : ''}` : null,
    listing.area  ? `📐 ${listing.area}m²` : null,
    listing.rooms ? `🛏 ${listing.rooms} room${listing.rooms !== 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(' | ');

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
    `🏠 *New listing in ${cityDisplay}*`,
    ``,
    `📍 ${listing.address || 'Address unknown'}${cityDisplay ? `, ${cityDisplay}` : ''}`,
    detailParts || null,
    ``,
    `━━━━━━━━━━━━━━━`,
    `🎯 *Chance Score: ${label} (${score}%)*`,
    `💎 *Deal Score: ${dLabel} (${dealScore}%)*`,
    `━━━━━━━━━━━━━━━`,
    filterSection || null,
  ].filter(s => s !== null).join('\n');

  const keyboard = {
    inline_keyboard: [
      [{ text: '🔗 View Listing', url: listing.url }],
      [{ text: '✉️ Generate Application Letter', callback_data: `ai_letter:${listing.url}` }],
      [{ text: '❌ Unsubscribe', callback_data: 'unsubscribe' }],
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

module.exports = { createBot, getBot, sendAlert, processWebhookUpdate };
