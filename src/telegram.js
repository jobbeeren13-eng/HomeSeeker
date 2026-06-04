const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const { getUser, getListingByUrl, getUserByCustomerId, linkChatToCustomer, clearChatIdFromOthers, upsertChat, setUserActive, cancelUserByChatId } = require('./database');
const { generateLetter } = require('./letter');
const { rowToListing } = require('./scraper');
const { getImprovementTips, getPillarBreakdown } = require('./score');
 
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const LINK_SECRET = process.env.LINK_SECRET || 'changeme_set_in_env';
 
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
 
function cacheListing(listing) {
  const id = String(++listingCacheId);
  listingCache.set(id, listing);
  if (listingCache.size > 500) {
    const oldest = listingCache.keys().next().value;
    listingCache.delete(oldest);
  }
  return id;
}
 
function getCachedListing(id) {
  return listingCache.get(id) || null;
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
          `⚠️ This activation link has already been used on another account.\n\nContact support at homeseeker@gmail.com`
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
 
    // Not paid, no payload
    await bot.sendMessage(chatId,
      `👋 Hi! HomeSeeker sends real-time Telegram alerts for Dutch housing listings.\n\n` +
      `Start your 7-day free trial:\n👉 https://homeseeker.dev\n\n` +
      `After subscribing, click the activation link in your confirmation email to connect your account here.`
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
      await sendStyleChoice(chatId);
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
    : (listing.price || '—');
  const cityDisplay = formatCityDisplay(listing.city);
  const isHuur = listing.transactionType === 'huur';
  const monthlyCost = (isHuur && listing.priceNumber) ? estimateMonthlyCost(listing.priceNumber) : null;
  const inkomen = user ? ((user.inkomen || 0) + (user.partner_inkomen || 0)) : 0;
  const maxHuur = inkomen / 3;
  const price = listing.priceNumber || 0;
  const incomeRatio = (inkomen > 0 && price > 0) ? Math.round((price / maxHuur) * 10) / 10 : null;
 
  const lines = [];
 
  // Header
  lines.push(`📍 *${address}*`);
  lines.push(`• ${cityDisplay || listing.city}${listing.area ? `  ·  ${listing.area}m²` : ''}`);
  lines.push(`• Rental = ${priceStr}${isHuur ? '/mo' : ''}`);
  if (monthlyCost) lines.push(`• Est. total = €${monthlyCost.toLocaleString('nl-NL')}/mo`);
 
  // Scores
  lines.push('');
  lines.push(`Application Score = ${appLabel(score)}`);
  lines.push(bar(score));
  lines.push('');
  if (dealScore !== null) {
    lines.push(`Market Value = ${valueLabel(dealScore)}`);
    lines.push(bar(dealScore));
  }
 
  // Boost tips
  if (user && score < 85) {
    const tips = [];
 
    if (price > maxHuur && inkomen > 0) {
      tips.push({ line: `Income = ${incomeRatio}× rent (3.0× required)  →  Add a guarantor  +14%`, p: 3 });
    } else if (!user.heeft_borg || user.heeft_borg === 'nee') {
      tips.push({ line: `Add a guarantor  +10%`, p: 2 });
    }
    if (!user.met_partner || user.met_partner === 'nee') {
      tips.push({ line: `Apply with a partner  +9%`, p: 2 });
    }
    if (user.application_readiness === 'niet') {
      tips.push({ line: `Documents = not ready  →  Prepare income proof & ID  +20%`, p: 3 });
    } else if (user.application_readiness === 'bezig') {
      tips.push({ line: `Documents = in progress  →  Complete your documents  +14%`, p: 2 });
    }
    if (user.contract_type === 'zzp') {
      tips.push({ line: `Add 3 years of tax returns  +6%`, p: 2 });
    }
    tips.push({ line: `Send a personal introduction  +3%`, p: 1 });
 
    tips.sort((a, b) => b.p - a.p);
    const top = tips.slice(0, 3);
    const potentialScore = Math.min(100, score + top.reduce((s, t) => s + parseInt(t.line.match(/\+(\d+)%/)?.[1] || 0), 0));
 
    lines.push('');
    lines.push(`*Boost to ${potentialScore}% 🚀*`);
    top.forEach(t => lines.push(`• ${t.line}`));
  }
 
  // Verdict
  if (user) {
    let verdict = '';
    if (score >= 70) {
      verdict = 'Strong match — apply now.';
    } else if (price > maxHuur && incomeRatio !== null) {
      verdict = 'Worth applying with a guarantor or co-applicant.';
    } else if (score >= 50) {
      verdict = 'Decent match — respond quickly.';
    } else {
      verdict = 'Challenging — strengthen your profile before applying.';
    }
    lines.push('');
    lines.push(verdict);
  }
 
  const text = lines.join('\n');
  const cacheId = cacheListing(listing);
 
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'View listing', url: listing.url },
        { text: 'AI Cover Letter', callback_data: `ai_letter:${cacheId}` },
      ],
      [
        { text: 'Share', callback_data: `share:${cacheId}` },
        { text: 'Unsubscribe', callback_data: 'unsubscribe' },
      ],
    ],
  };
 
  try {
    if (listing.image) {
      try {
        await _bot.sendPhoto(chatId, listing.image, {
          caption: text,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
      } catch (photoErr) {
        await _bot.sendMessage(chatId, listing.image + '\n\n' + text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
          disable_web_page_preview: false,
        });
      }
    } else {
      await _bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        disable_web_page_preview: false,
      });
    }
  } catch (err) {
    try {
      await _bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
        disable_web_page_preview: false,
      });
    } catch (e) {
      console.error(`[telegram] Failed to send alert to ${chatId}:`, e.message);
    }
  }
}
 
function processWebhookUpdate(update) {
  if (bot) bot.processUpdate(update);
}
 
module.exports = { createBot, getBot, sendAlert, processWebhookUpdate, clearLetterState, generateStartPayload };
 