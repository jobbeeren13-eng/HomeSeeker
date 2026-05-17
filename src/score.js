function calculateScore(listing, user) {
  let score = 20; // base

  const price = listing.priceNumber || 0;
  const inkomen = user.inkomen || 0;
  const isHuur = listing.transactionType === 'huur';

  // Income ratio — max 35 pts
  if (inkomen > 0 && price > 0) {
    if (isHuur) {
      const ratio = inkomen / price;
      if (ratio >= 4) score += 35;
      else if (ratio >= 3.5) score += 28;
      else if (ratio >= 3) score += 20;
      else if (ratio >= 2.5) score += 10;
      else score += 0;
    } else {
      // koop: inkomen * 4.5 = max hypotheek
      const maxHypo = inkomen * 12 * 4.5;
      const ratio = maxHypo / price;
      if (ratio >= 1.2) score += 35;
      else if (ratio >= 1.0) score += 28;
      else if (ratio >= 0.85) score += 18;
      else if (ratio >= 0.7) score += 8;
      else score += 0;
    }
  }

  // Application readiness — max 20 pts
  const docPoints = { klaar: 20, bijna: 12, bezig: 6, niet: 0 };
  score += docPoints[user.application_readiness] || 0;

  // Price fit — max 20 pts (how far listing is below user's max)
  if (user.prijs_max && price > 0) {
    const headroom = (user.prijs_max - price) / user.prijs_max;
    if (headroom >= 0.2) score += 20;
    else if (headroom >= 0.1) score += 14;
    else if (headroom >= 0.05) score += 8;
    else if (headroom >= 0) score += 4;
  }

  // Timing — max 5 pts (assumed "just listed" by definition since we check every 15 min)
  score += 5;

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
