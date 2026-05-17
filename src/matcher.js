const { getAllActiveUsers, isListingSent, markListingSent } = require('./database');
const { calculateScore, scoreLabel } = require('./score');
const { calculateDealScore, dealLabel } = require('./deal_score');
const { normaliseCity } = require('./scraper');

const ENERGY_ORDER = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

function matchesUser(listing, user) {
  const userCity = normaliseCity(user.locatie || '');
  if (userCity && listing.city !== userCity) return false;

  if (user.type !== 'beide' && listing.transactionType !== user.type) return false;

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

function findMatches(listings) {
  const users = getAllActiveUsers.all();
  const matches = [];

  for (const listing of listings) {
    // Calculate deal score once per listing (not per user)
    const dScore = calculateDealScore(listing);
    const dLabel = dealLabel(dScore);

    for (const user of users) {
      if (!user.chat_id) continue;
      if (isListingSent.get(listing.url, user.chat_id)) continue;
      if (!matchesUser(listing, user)) continue;

      const score = calculateScore(listing, user);
      const kansMin = user.kans_min || 0;
      if (score < kansMin) continue;

      markListingSent.run(listing.url, user.chat_id);
      matches.push({
        listing, user,
        score, label: scoreLabel(score),
        dealScore: dScore, dealLabel: dLabel,
      });
    }
  }

  return matches;
}

module.exports = { findMatches };
