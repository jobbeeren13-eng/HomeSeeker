const MARKET_HUUR = {
  amsterdam: 26, rotterdam: 17, 'den-haag': 18, utrecht: 21,
  haarlem: 22, amstelveen: 23, delft: 18, leiden: 19, eindhoven: 15,
  groningen: 12, nijmegen: 14, tilburg: 13, almere: 13, breda: 13,
  maastricht: 13, zwolle: 13, enschede: 11, arnhem: 12, apeldoorn: 11,
};
const MARKET_KOOP = {
  amsterdam: 6500, rotterdam: 4500, 'den-haag': 5000, utrecht: 5500,
  haarlem: 5800, amstelveen: 5500, delft: 5000, leiden: 5500, eindhoven: 4200,
  groningen: 3200, nijmegen: 3800, tilburg: 3500, almere: 3800, breda: 3600,
  maastricht: 3500, zwolle: 3800, enschede: 2800, arnhem: 3200, apeldoorn: 3000,
};
const DEFAULT_HUUR = 16;
const DEFAULT_KOOP = 4000;

const LOCATION_SCORE = {
  delft: 15, haarlem: 14, amstelveen: 13, rotterdam: 13,
  utrecht: 12, 'den-haag': 11, amsterdam: 8, leiden: 12,
  eindhoven: 11, groningen: 11, nijmegen: 11, tilburg: 10,
  almere: 10, breda: 10, maastricht: 10, zwolle: 10,
  enschede: 9, arnhem: 9, apeldoorn: 9,
};

const PRICE_DROP_PATTERNS = [
  /prijs\s*verlaagd/i, /prijsverlaging/i, /prijswijziging/i,
  /reduced/i, /price\s*drop/i, /lowered/i, /verlaagd/i, /korting/i,
];

function detectPriceDrop(text) {
  if (!text) return false;
  return PRICE_DROP_PATTERNS.some(re => re.test(text));
}

function estimateAreaFromRooms(rooms) {
  const r = rooms || 0;
  if (r <= 0) return 50;
  if (r === 1) return 25;
  if (r === 2) return 45;
  if (r === 3) return 65;
  if (r === 4) return 85;
  return 100;
}

function hasComparisonData(listing) {
  return !!(listing.priceNumber > 0 && (listing.area > 0 || listing.rooms > 0) && listing.city);
}

function calculateDealScore(listing) {
  if (!hasComparisonData(listing)) return null;

  const { priceNumber, city, transactionType, description } = listing;
  const area = (listing.area > 0) ? listing.area : estimateAreaFromRooms(listing.rooms);
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

module.exports = { calculateDealScore, dealLabel, hasComparisonData, detectPriceDrop, MARKET_HUUR };
