// ─────────────────────────────────────────────
// APPLICATION STRENGTH — 5 weighted pillars
// ─────────────────────────────────────────────

function calcFinancialFit(listing, user) {
  const price = listing.priceNumber || 0;
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);
  const isHuur = listing.transactionType === 'huur';
  if (!inkomen || !price) return { score: 0, label: 'Unknown', detail: 'No income data' };

  let score = 0;
  let detail = '';

  if (isHuur) {
    const maxHuur = inkomen / 3;
    const ratio = price / maxHuur;
    if (ratio <= 0.75) { score = 100; detail = 'Strong income-to-rent ratio'; }
    else if (ratio <= 0.85) { score = 80; detail = 'Good income-to-rent ratio'; }
    else if (ratio <= 0.95) { score = 55; detail = 'Tight income-to-rent ratio'; }
    else if (ratio <= 1.0) { score = 30; detail = 'At the limit of typical acceptance'; }
    else { score = 10; detail = 'Income below typical requirement for this rent'; }
  } else {
    const maxHypo = inkomen * 12 * 4.5;
    const ratio = price / maxHypo;
    if (ratio <= 0.7) { score = 100; detail = 'Strong affordability for purchase'; }
    else if (ratio <= 0.85) { score = 75; detail = 'Good affordability'; }
    else if (ratio <= 0.95) { score = 50; detail = 'Moderate affordability'; }
    else if (ratio <= 1.0) { score = 25; detail = 'At the limit of mortgage eligibility'; }
    else { score = 5; detail = 'Price likely exceeds mortgage eligibility'; }
  }

  // Contract type modifier
  if (user.contract_type === 'vast') score = Math.min(100, score + 5);
  else if (user.contract_type === 'tijdelijk') score = Math.max(0, score - 10);
  else if (user.contract_type === 'zzp') score = Math.max(0, score - 15);
  else if (user.contract_type === 'student') score = Math.max(0, score - 20);

  // Guarantor boost
  if (user.heeft_borg === 'ja') score = Math.min(100, score + 10);
  // Partner boost
  if (user.met_partner === 'ja') score = Math.min(100, score + 8);

  return { score, label: tierLabel(score), detail };
}

function calcProfileStrength(user) {
  let score = 50;
  let detail = '';

  if (user.contract_type === 'vast') { score += 25; detail = 'Permanent contract'; }
  else if (user.contract_type === 'tijdelijk') { score += 10; detail = 'Temporary contract'; }
  else if (user.contract_type === 'zzp') { score += 5; detail = 'Self-employed — may require extra docs'; }
  else if (user.contract_type === 'student') { score -= 10; detail = 'Student profile'; }

  if (user.expat_status === 'EU') { score += 10; detail += ' · EU citizen'; }
  else if (user.expat_status === 'non-EU') { score += 0; detail += ' · Non-EU (extra docs may apply)'; }

  if (user.profiel_type === 'expat') score += 5;
  if (user.met_partner === 'ja') score += 5;

  return { score: Math.min(100, Math.max(0, score)), label: tierLabel(score), detail: detail.trim() || 'Standard profile' };
}

function calcDocumentReadiness(user) {
  const points = { klaar: 100, bijna: 65, bezig: 35, niet: 5 };
  const score = points[user.application_readiness] || 5;
  const details = {
    klaar: 'All documents ready to submit',
    bijna: 'Almost ready — minor documents missing',
    bezig: 'Documents in progress — significant gap',
    niet: 'No documents prepared — high risk',
  };
  return { score, label: tierLabel(score), detail: details[user.application_readiness] || 'Unknown' };
}

function calcTimingAdvantage(listing) {
  if (!listing.listedAt) return { score: 60, label: 'Unknown', detail: 'Listing age unknown' };
  const ageMins = (Date.now() - new Date(listing.listedAt).getTime()) / 60000;
  let score, detail;
  if (ageMins <= 15) { score = 100; detail = 'Listed just now — apply immediately'; }
  else if (ageMins <= 60) { score = 80; detail = `Listed ${Math.round(ageMins)} min ago — still early`; }
  else if (ageMins <= 240) { score = 55; detail = `Listed ${Math.round(ageMins / 60)}h ago — moderate competition`; }
  else if (ageMins <= 1440) { score = 30; detail = 'Listed today — high competition likely'; }
  else { score = 10; detail = 'Listing is older — very competitive'; }
  return { score, label: tierLabel(score), detail };
}

function calcCompetitionPressure(listing) {
  const price = listing.priceNumber || 0;
  const city = (listing.city || '').toLowerCase();
  let score = 60;
  let detail = 'Average competition';

  // High demand cities
  const hotCities = ['amsterdam', 'utrecht', 'haarlem', 'leiden'];
  const mediumCities = ['rotterdam', 'den-haag', 'eindhoven', 'delft'];
  if (hotCities.includes(city)) { score -= 20; detail = 'High-demand city — expect many applications'; }
  else if (mediumCities.includes(city)) { score -= 5; detail = 'Moderate competition in this city'; }

  // Price attractiveness (lower price = more competition)
  if (listing.transactionType === 'huur') {
    if (price < 1000) { score -= 20; detail += ' · Very attractive price point'; }
    else if (price < 1400) { score -= 10; detail += ' · Competitive price range'; }
    else if (price > 2000) { score += 15; detail += ' · Higher price = less competition'; }
  }

  return { score: Math.min(100, Math.max(0, score)), label: tierLabel(score), detail };
}

function tierLabel(score) {
  if (score >= 85) return 'Strong';
  if (score >= 65) return 'Good';
  if (score >= 45) return 'Moderate';
  if (score >= 25) return 'Weak';
  return 'Very Weak';
}

// Weights per pillar
const WEIGHTS = {
  financial: 0.35,
  profile: 0.20,
  documents: 0.20,
  timing: 0.15,
  competition: 0.10,
};

function calculateScore(listing, user) {
  const financial = calcFinancialFit(listing, user);
  const profile = calcProfileStrength(user);
  const documents = calcDocumentReadiness(user);
  const timing = calcTimingAdvantage(listing);
  const competition = calcCompetitionPressure(listing);

  const weighted =
    financial.score * WEIGHTS.financial +
    profile.score * WEIGHTS.profile +
    documents.score * WEIGHTS.documents +
    timing.score * WEIGHTS.timing +
    competition.score * WEIGHTS.competition;

  return Math.min(100, Math.max(0, Math.round(weighted)));
}

function scoreLabel(score) {
  if (score >= 85) return '✅ Excellent';
  if (score >= 70) return '🟢 Good';
  if (score >= 55) return '🟡 Fair';
  if (score >= 40) return '🟠 Low';
  return '🔴 Very Low';
}

const strengthLabel = scoreLabel;

// ─────────────────────────────────────────────
// SMART SUGGESTIONS — factor-driven
// ─────────────────────────────────────────────

function getImprovementTips(listing, user, currentScore) {
  const tips = [];
  const price = listing.priceNumber || 0;
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);

  const financial = calcFinancialFit(listing, user);
  const documents = calcDocumentReadiness(user);
  const timing = calcTimingAdvantage(listing);
  const competition = calcCompetitionPressure(listing);

  // Financial tips
  if (financial.score < 50) {
    if (!user.heeft_borg || user.heeft_borg === 'nee') {
      tips.push({ tip: 'Add a guarantor — it significantly improves acceptance for borderline income ratios', boost: 12 });
    }
    if (!user.met_partner || user.met_partner === 'nee') {
      tips.push({ tip: 'Apply with a partner to combine income and strengthen your financial profile', boost: 10 });
    }
    if (price > 0 && inkomen > 0) {
      const maxHuur = inkomen / 3;
      if (price > maxHuur) {
        const suggested = Math.round(maxHuur * 0.9);
        tips.push({ tip: `Target listings under €${suggested}/mo to stay within the standard income-to-rent ratio`, boost: 8 });
      }
    }
  }

  // Document tips
  if (documents.score < 65) {
    if (user.application_readiness === 'niet') {
      tips.push({ tip: 'Prepare income proof and employer letter before applying — missing documents are the #1 reason applications fail', boost: 20 });
    } else if (user.application_readiness === 'bezig') {
      tips.push({ tip: 'Finish preparing your documents — landlords in the Netherlands decide fast', boost: 14 });
    } else if (user.application_readiness === 'bijna') {
      tips.push({ tip: 'Complete your document pack to maximise your chances', boost: 8 });
    }
  }

  // Timing tips
  if (timing.score < 60) {
    tips.push({ tip: 'Applications in the first hour have significantly higher success rates — enable instant alerts', boost: 9 });
  } else if (timing.score >= 80) {
    tips.push({ tip: 'You\'re early — apply now to stay ahead of the competition', boost: 5 });
  }

  // Competition tips
  if (competition.score < 40) {
    tips.push({ tip: 'This listing is highly competitive — send a personalised introduction to stand out', boost: 7 });
    tips.push({ tip: 'Apply within the first hour — early applications are reviewed first', boost: 9 });
  }

  // Contract type tips
  if (user.contract_type === 'zzp') {
    tips.push({ tip: 'As a freelancer, include your last 3 years of tax returns and a recent client contract', boost: 6 });
  } else if (user.contract_type === 'tijdelijk') {
    tips.push({ tip: 'Include an employer statement confirming contract renewal expectations', boost: 6 });
  }

  // Always relevant
  tips.push({ tip: 'Send a short, personal introduction message with your application', boost: 5 });

  // Sort by boost, take top 3
  tips.sort((a, b) => b.boost - a.boost);
  const top = tips.slice(0, 3);
  const potentialScore = Math.min(100, currentScore + top.reduce((sum, t) => sum + t.boost, 0));

  return { tips: top, potentialScore };
}

// ─────────────────────────────────────────────
// PILLAR BREAKDOWN (for detailed Telegram alert)
// ─────────────────────────────────────────────

function getPillarBreakdown(listing, user) {
  return {
    financial: calcFinancialFit(listing, user),
    profile: calcProfileStrength(user),
    documents: calcDocumentReadiness(user),
    timing: calcTimingAdvantage(listing),
    competition: calcCompetitionPressure(listing),
  };
}


// ─────────────────────────────────────────────
// LANDLORD INTENT DETECTION — NLP on description
// ─────────────────────────────────────────────

const LANDLORD_SIGNALS = {
  professional: {
    patterns: [/professional/i, /werkende/i, /working professional/i, /professional couple/i, /professional tenant/i],
    label: 'Professional tenant preferred',
    tip: 'Emphasize your professional employment and stable income',
    boost: 8,
  },
  longterm: {
    patterns: [/long.term/i, /langdurig/i, /for several years/i, /meerdere jaren/i, /stable tenant/i, /vaste huurder/i],
    label: 'Long-term tenant preferred',
    tip: 'Mention your intention to stay for 2+ years',
    boost: 10,
  },
  expat: {
    patterns: [/expat/i, /international/i, /relocation/i, /expats welcome/i, /internationals/i],
    label: 'Expat-friendly landlord',
    tip: 'Mention your relocation or international employment',
    boost: 6,
  },
  quiet: {
    patterns: [/quiet/i, /rustig/i, /respectful/i, /well-maintained/i, /no noise/i, /geen overlast/i],
    label: 'Values quiet, responsible tenants',
    tip: 'Highlight your quiet lifestyle and responsible character',
    boost: 5,
  },
  family: {
    patterns: [/family/i, /gezin/i, /near schools/i, /near school/i, /family home/i, /gezinswoning/i],
    label: 'Family-friendly property',
    tip: 'Highlight family stability in your application',
    boost: 5,
  },
  corporate: {
    patterns: [/corporate lease/i, /company lease/i, /zakelijke huur/i, /employer/i],
    label: 'Corporate lease possible',
    tip: 'Consider applying through your employer if available',
    boost: 7,
  },
  nopets: {
    patterns: [/no pets/i, /geen huisdieren/i, /no animals/i, /geen dieren/i],
    label: 'No pets allowed',
    tip: null,
    boost: 0,
    warning: true,
  },
  nosharing: {
    patterns: [/no sharing/i, /no roommates/i, /niet delen/i, /single occupant/i, /one person/i],
    label: 'No house sharing',
    tip: null,
    boost: 0,
    warning: true,
  },
};

function detectLandlordIntent(description) {
  if (!description) return { signals: [], tips: [], warnings: [] };
  const signals = [];
  const tips = [];
  const warnings = [];

  for (const [key, signal] of Object.entries(LANDLORD_SIGNALS)) {
    const matched = signal.patterns.some(p => p.test(description));
    if (matched) {
      signals.push({ key, label: signal.label, boost: signal.boost });
      if (signal.warning) {
        warnings.push(signal.label);
      } else if (signal.tip) {
        tips.push({ tip: signal.tip, boost: signal.boost, source: 'landlord' });
      }
    }
  }

  return { signals, tips, warnings };
}

module.exports = { calculateScore, scoreLabel, strengthLabel, getImprovementTips, getPillarBreakdown, detectLandlordIntent };
