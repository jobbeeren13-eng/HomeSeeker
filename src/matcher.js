const { isListingSent, markListingSent } = require('./database');
const { calculateScore, scoreLabel } = require('./score');
const { calculateDealScore, dealLabel } = require('./deal_score');
const { normaliseCity } = require('./scraper');

const ENERGY_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const RAILWAY_URL = process.env.RAILWAY_URL || 'https://homeseeker.dev';
const ADMIN_KEY = process.env.ADMIN_KEY;

async function getActiveUsers() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${RAILWAY_URL}/api/users`, {
      headers: { 'x-admin-key': ADMIN_KEY },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const users = await res.json();
    console.log(`[matcher] Fetched ${users.length} active users from Railway`);
    return users;
  } catch (err) {
    console.error('[matcher] Failed to fetch users from Railway:', err.message);
    return [];
  }
}

function matchesUser(listing, user) {
  // Support multiple cities stored as comma-separated string
  const userCities = (user.locatie || '').split(',').map(c => normaliseCity(c.trim())).filter(Boolean);
  if (userCities.length > 0 && !userCities.includes(listing.city)) return false;

  const userType = (user.type || '').toLowerCase();
  const listingType = (listing.transactionType || '').toLowerCase();
  if (userType !== 'beide' && listingType !== userType) return false;

  if (user.prijs_max && listing.priceNumber > user.prijs_max) return false;
  if (user.prijs_min && listing.priceNumber < user.prijs_min) return false;

  if (user.opp_min && listing.area > 0 && listing.area < user.opp_min) return false;
  if (user.kamers_min && listing.rooms > 0 && listing.rooms < user.kamers_min) return false;

  if (user.woningtype && user.woningtype !== 'alle') {
    const lt = listing.propertyType || '';
    if (user.woningtype === 'huis' && !lt.includes('huis') && !lt.includes('house') && !lt.includes('woning')) return false;
    if (user.woningtype === 'appartement' && !lt.includes('appartement') && !lt.includes('apartment')) return false;
  }

  if (user.energielabel && user.energielabel !== 'geen' && listing.energyLabel) {
    const userIdx = ENERGY_ORDER.indexOf(user.energielabel);
    const listIdx = ENERGY_ORDER.indexOf(listing.energyLabel);
    if (listIdx > userIdx) return false;
  }

  if (user.bouwjaar_min && listing.constructionYear && listing.constructionYear < user.bouwjaar_min) return false;

  return true;
}

const MAX_ALERTS_PER_USER_PER_CYCLE = 20;

async function findMatches(listings) {
  const users = await getActiveUsers();
  if (!users.length) {
    console.log('[matcher] No active users found, skipping match cycle');
    return [];
  }
  const matches = [];
  const userAlertCount = new Map();
  const userStats = new Map(); // chat_id -> { checked, matched, rejected }

  for (const listing of listings) {
    const dScore = calculateDealScore(listing);
    const dLabel = dealLabel(dScore, listing);

    for (const user of users) {
      if (!user.chat_id) continue;
      const stats = userStats.get(user.chat_id) || { checked: 0, matched: 0, alreadySent: 0, noMatch: 0, lowScore: 0, lowDeal: 0, capped: 0 };
      stats.checked++;

      if (isListingSent.get(listing.url, user.chat_id)) { stats.alreadySent++; userStats.set(user.chat_id, stats); continue; }
      if (!matchesUser(listing, user)) { stats.noMatch++; userStats.set(user.chat_id, stats); continue; }

      const score = calculateScore(listing, user);
      if (score < (user.kans_min || 0)) { stats.lowScore++; userStats.set(user.chat_id, stats); continue; }

      const dealMin = user.deal_min || 0;
      if (dealMin > 0 && (dScore === null || dScore < dealMin)) { stats.lowDeal++; userStats.set(user.chat_id, stats); continue; }

      const alertCount = userAlertCount.get(user.chat_id) || 0;
      if (alertCount >= MAX_ALERTS_PER_USER_PER_CYCLE) { stats.capped++; userStats.set(user.chat_id, stats); continue; }

      markListingSent.run(listing.url, user.chat_id);
      userAlertCount.set(user.chat_id, alertCount + 1);
      stats.matched++;
      userStats.set(user.chat_id, stats);
      matches.push({
        listing, user,
        score, label: scoreLabel(score),
        dealScore: dScore, dealLabel: dLabel,
      });
    }
  }

  // Log per-user match summary
  for (const [chatId, s] of userStats) {
    if (s.matched > 0 || s.capped > 0) {
      console.log(`[matcher] user=${chatId} checked=${s.checked} matched=${s.matched} noMatch=${s.noMatch} lowScore=${s.lowScore} lowDeal=${s.lowDeal} capped=${s.capped}`);
    }
  }

  return matches;
}

// Match all recent listings against one specific user (for immediate post-filter alerts).
// Uses per-user sent_listings dedup — does NOT touch the global listings.sent flag.
async function findMatchesForUser(listings, chatId) {
  const users = await getActiveUsers();
  const user = users.find(u => String(u.chat_id) === String(chatId));
  if (!user) {
    console.log(`[matcher] chat_id=${chatId} not found in active users`);
    return [];
  }

  const matches = [];
  for (const listing of listings) {
    if (isListingSent.get(listing.url, user.chat_id)) continue;
    if (!matchesUser(listing, user)) continue;

    const score = calculateScore(listing, user);
    if (score < (user.kans_min || 0)) continue;

    const dScore = calculateDealScore(listing);
    const dLabel = dealLabel(dScore, listing);
    if ((user.deal_min || 0) > 0 && (dScore === null || dScore < user.deal_min)) continue;

    markListingSent.run(listing.url, user.chat_id);
    matches.push({ listing, user, score, label: scoreLabel(score), dealScore: dScore, dealLabel: dLabel });
  }

  return matches;
}

module.exports = { findMatches, findMatchesForUser };
