const MARKET_HUUR = {
  amsterdam: 26, rotterdam: 17, 'den-haag': 18, utrecht: 21,
  haarlem: 22, amstelveen: 23, delft: 18,
};
const MARKET_KOOP = {
  amsterdam: 6500, rotterdam: 4500, 'den-haag': 5000, utrecht: 5500,
  haarlem: 5800, amstelveen: 5500, delft: 5000,
};
const DEFAULT_HUUR = 20;
const DEFAULT_KOOP = 5000;

const LOCATION_SCORE = {
  delft: 15, haarlem: 14, amstelveen: 13, rotterdam: 13,
  utrecht: 12, 'den-haag': 11, amsterdam: 8,
};

const PRICE_DROP_PATTERNS = [
  /prijs\s*verlaagd/i, /prijsverlaging/i, /prijswijziging/i,
  /reduced/i, /price\s*drop/i, /lowered/i, /verlaagd/i, /korting/i,
];

function detectPriceDrop(text) {
  if (!text) return false;
  return PRICE_DROP_PATTERNS.some(re => re.test(text));
}

function hasComparisonData(listing) {
  return !!(listing.priceNumber > 0 && listing.area > 0 && listing.city);
}

function calculateDealScore(listing) {
  if (!hasComparisonData(listing)) return null;

  const { priceNumber, area, city, transactionType, description } = listing;
  const isHuur = transactionType === 'huur';
  let score = 0;

  const pricePerM2 = priceNumber / area;
  const market = isHuur
    ? (MARKET_HUUR[city] || DEFAULT_HUUR)
    : (MARKET_KOOP[city] || DEFAULT_KOOP);
  const discount = (market - pricePerM2) / market;

  if (discount >= 0.25) score += 50;
  else if (discount >= 0.15) score += 40;
  else if (discount >= 0.08) score += 30;
  else if (discount >= 0.02) score += 20;
  else if (discount >= -0.05) score += 12;
  else if (discount >= -0.15) score += 5;

  const combinedText = `${listing.address || ''} ${description || ''}`;
  if (detectPriceDrop(combinedText)) score += 15;

  if (!isHuur) {
    const ratio = pricePerM2 / market;
    if (ratio <= 0.80) score += 20;
    else if (ratio <= 0.90) score += 14;
    else if (ratio <= 1.00) score += 8;
    else if (ratio <= 1.10) score += 4;
  } else {
    const isFurnished = /gemeubileerd|furnished|gemeubeld/i.test(description || '');
    score += isFurnished ? 20 : 8;
  }

  score += LOCATION_SCORE[city] || 10;

  return Math.min(100, Math.max(0, score));
}

function dealLabel(score, listing = {}) {
  if (score === null || !hasComparisonData(listing)) return 'No data';
  if (score >= 80) return '🔥 Great deal';
  if (score >= 60) return '👍 Good deal';
  if (score >= 40) return '😐 Fair';
  return '💸 Overpriced';
}

module.exports = { calculateDealScore, dealLabel, hasComparisonData };
