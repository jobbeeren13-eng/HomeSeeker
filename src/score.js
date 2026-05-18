function calculateScore(listing, user) {
  let score = 20;

  const price = listing.priceNumber || 0;
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);
  const isHuur = listing.transactionType === 'huur';

  // Income ratio — max 35 pts (now uses combined income)
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

  // Guarantor bonus
  if (user.heeft_borg === 'ja') score += 10;

  // Partner bonus
  if (user.met_partner === 'ja') score += 8;

  const docPoints = { klaar: 20, bijna: 12, bezig: 6, niet: 0 };
  score += docPoints[user.application_readiness] || 0;

  if (user.prijs_max && price > 0) {
    const headroom = (user.prijs_max - price) / user.prijs_max;
    if (headroom >= 0.2) score += 20;
    else if (headroom >= 0.1) score += 14;
    else if (headroom >= 0.05) score += 8;
    else if (headroom >= 0) score += 4;
  }

  // Timing — max 5 pts
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

function getImprovementTips(listing, user, currentScore) {
  const tips = [];
  const price = listing.priceNumber || 0;
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);
  const hasGuarantor = user.heeft_borg === 'ja';
  const hasPartner = user.met_partner === 'ja';

  // Documents not ready
  if (user.application_readiness === 'niet') {
    tips.push({ tip: 'Prepare your documents upfront', boost: 20 });
  } else if (user.application_readiness === 'bezig') {
    tips.push({ tip: 'Finish preparing your documents', boost: 14 });
  } else if (user.application_readiness === 'bijna') {
    tips.push({ tip: 'Complete your document preparation', boost: 8 });
  }

  // No guarantor
  if (!hasGuarantor) {
    const maxHuur = inkomen / 3;
    const ratio = price / (maxHuur || 1);
    if (ratio > 0.8) {
      tips.push({ tip: 'Add a guarantor to strengthen your application', boost: 12 });
    } else {
      tips.push({ tip: 'Having a guarantor available can help in competitive situations', boost: 6 });
    }
  }

  // No partner
  if (!hasPartner) {
    tips.push({ tip: 'Apply with a partner for dual income verification', boost: 10 });
  }

  // Contract type
  if (user.contract_type === 'zzp' || user.contract_type === 'tijdelijk') {
    tips.push({ tip: 'Include your employment contract or recent tax returns', boost: 6 });
  }

  // Timing tip — always relevant
  tips.push({ tip: 'Apply within 15 minutes of receiving this alert', boost: 9 });

  // Personalized intro
  tips.push({ tip: 'Send a personalized introduction letter', boost: 5 });

  // Sort by boost descending, take top 3
  tips.sort((a, b) => b.boost - a.boost);
  const top = tips.slice(0, 3);

  const potentialScore = Math.min(100, currentScore + top.reduce((sum, t) => sum + t.boost, 0));

  return { tips: top, potentialScore };
}

// Alias for consistent naming
const strengthLabel = scoreLabel;

module.exports = { calculateScore, scoreLabel, strengthLabel, getImprovementTips };
