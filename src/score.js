function calculateScore(listing, user) {
  let score = 20;

  const price = listing.priceNumber || 0;
  const inkomen = user.inkomen || 0;
  const isHuur = listing.transactionType === 'huur';

  // Income ratio — max 35 pts
  if (inkomen > 0 && price > 0) {
    if (isHuur) {
      const maxHuur = inkomen / 3;
      if (price <= maxHuur) {
        const headroom = (maxHuur - price) / maxHuur;
        if (headroom >= 0.25) score += 35;
        else if (headroom >= 0.15) score += 28;
        else if (headroom >= 0.08) score += 20;
        else if (headroom >= 0.03) score += 10;
        else score += 4;
      }
    } else {
      const maxHypo = inkomen * 12 * 4.5;
      if (price <= maxHypo) {
        const headroom = (maxHypo - price) / maxHypo;
        if (headroom >= 0.2) score += 35;
        else if (headroom >= 0.12) score += 28;
        else if (headroom >= 0.06) score += 18;
        else if (headroom >= 0.02) score += 8;
        else score += 4;
      }
    }
  }

  const docPoints = { klaar: 20, bijna: 12, bezig: 6, niet: 0 };
  score += docPoints[user.application_readiness] || 0;

  if (user.prijs_max && price > 0) {
    const headroom = (user.prijs_max - price) / user.prijs_max;
    if (headroom >= 0.2) score += 20;
    else if (headroom >= 0.1) score += 14;
    else if (headroom >= 0.05) score += 8;
    else if (headroom >= 0) score += 4;
  }

  // Timing — max 5 pts (fresher listings score higher)
  if (listing.listedAt) {
    const ageMins = (Date.now() - new Date(listing.listedAt).getTime()) / 60000;
    if (ageMins <= 10) score += 5;
    else if (ageMins <= 30) score += 4;
    else if (ageMins <= 60) score += 2;
    else score += 1;
  } else {
    score += 3;
  }

  return Math.min(100, Math.max(0, score));
}

function scoreLabel(score) {
  if (score >= 85) return '✅ Excellent';
  if (score >= 70) return '🟢 Good';
  if (score >= 55) return '🟡 Fair';
  if (score >= 40) return '🟠 Low';
  return '🔴 Very Low';
}

module.exports = { calculateScore, scoreLabel };
