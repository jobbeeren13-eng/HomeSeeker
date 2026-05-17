// Market benchmarks (2025 Dutch rental/sale market)
const MARKET_HUUR = { // €/m²/month
  amsterdam: 26, rotterdam: 17, 'den-haag': 18, utrecht: 21,
  haarlem: 22, amstelveen: 23, delft: 18,
};
const MARKET_KOOP = { // €/m²
  amsterdam: 6500, rotterdam: 4500, 'den-haag': 5000, utrecht: 5500,
  haarlem: 5800, amstelveen: 5500, delft: 5000,
};
const DEFAULT_HUUR = 20;
const DEFAULT_KOOP = 5000;

// Cities where listings tend to be better value for money
const LOCATION_SCORE = {
  delft: 15, haarlem: 14, amstelveen: 13, rotterdam: 13,
  utrecht: 12, 'den-haag': 11, amsterdam: 8,
};

const PRICE_DROP_PATTERNS = [
  /prijs\s*verlaagd/i, /prijsverlaging/i, /prijswijziging/i,
  /reduced/i, /price\s*drop/i, /reduced\s*price/i, /lowered/i,
  /verlaagd/i, /korting/i,
];

function detectPriceDrop(text) {
  if (!text) return false;
  return PRICE_DROP_PATTERNS.some(re => re.test(text));
}

function calculateDealScore(listing) {
  const { priceNumber, area, city, transactionType, gemeubileerd, description } = listing;
  const isHuur = transactionType === 'huur';
  let score = 0;

  // 1. €/m² vs market average — max 50 pts
  if (priceNumber > 0 && area > 0) {
    const pricePerM2 = priceNumber / area;
    const market = isHuur
      ? (MARKET_HUUR[city] || DEFAULT_HUUR)
      : (MARKET_KOOP[city] || DEFAULT_KOOP);
    const discount = (market - pricePerM2) / market; // positive = cheaper than market

    if (discount >= 0.25)      score += 50;
    else if (discount >= 0.15) score += 40;
    else if (discount >= 0.08) score += 30;
    else if (discount >= 0.02) score += 20;
    else if (discount >= -0.05) score += 12;
    else if (discount >= -0.15) score += 5;
    else                        score += 0;
  } else {
    score += 12; // no area data — neutral
  }

  // 2. Price drop detected — max 15 pts
  const combinedText = `${listing.address || ''} ${description || ''}`;
  if (detectPriceDrop(combinedText)) score += 15;

  // 3. WOZ proxy (koop) or furnished value (huur) — max 20 pts
  if (!isHuur) {
    // For koop: lower price/m² relative to market strongly implies good WOZ ratio
    if (priceNumber > 0 && area > 0) {
      const pricePerM2 = priceNumber / area;
      const market = MARKET_KOOP[city] || DEFAULT_KOOP;
      const ratio = pricePerM2 / market;
      if (ratio <= 0.80)      score += 20;
      else if (ratio <= 0.90) score += 14;
      else if (ratio <= 1.00) score += 8;
      else if (ratio <= 1.10) score += 4;
    }
  } else {
    // For huur: furnished adds value, especially for expats
    const isFurnished = gemeubileerd ||
      /gemeubileerd|furnished|gemeubeld/i.test(description || '');
    if (isFurnished) score += 20;
    else score += 8; // unfurnished still fine
  }

  // 4. Location value score — max 15 pts
  score += LOCATION_SCORE[city] || 10;

  return Math.min(100, Math.max(0, score));
}

function dealLabel(score) {
  if (score >= 80) return '💎 Hidden gem';
  if (score >= 60) return '🟢 Strong value';
  if (score >= 40) return '🟡 Fair deal';
  return '🔴 Bad deal';
}

module.exports = { calculateDealScore, dealLabel };
