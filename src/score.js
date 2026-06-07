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
  const ageMs = Date.now() - new Date(listing.listedAt).getTime();
  if (isNaN(ageMs)) return { score: 60, label: 'Unknown', detail: 'Listing age unknown' };
  const ageMins = ageMs / 60000;
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

  const result = Math.round(weighted);
  return isNaN(result) ? 0 : Math.min(100, Math.max(0, result));
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
  const price = listing.priceNumber || 0;
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);
  const city = (listing.city || '').toLowerCase().replace(/-/g, ' ');
  const description = listing.description || '';

  const financial = calcFinancialFit(listing, user);
  const documents = calcDocumentReadiness(user);

  const seen = new Set();
  const landlordTips = [];
  const otherTips = [];

  function addLandlord(tip, boost) {
    if (!seen.has(tip)) { seen.add(tip); landlordTips.push({ tip, boost }); }
  }
  function addOther(tip, boost) {
    if (!seen.has(tip)) { seen.add(tip); otherTips.push({ tip, boost }); }
  }

  // Landlord intent tips — come first when description is available
  if (description.length > 50) {
    if (/professional|werkende|working professional/i.test(description)) {
      addLandlord('This landlord specifically mentions professional tenants — lead with your job title and employer name', 8);
    }
    if (/expat|international|relocation/i.test(description)) {
      addLandlord('Expats are welcome here — mention your international background and employer relocation support if applicable', 6);
    }
    if (/langdurig|long-term|meerdere jaren/i.test(description)) {
      addLandlord('Long-term tenancy is a priority — state clearly that you plan to stay for 2+ years', 10);
    }
    if (/rustig|quiet|geen overlast/i.test(description)) {
      addLandlord('The landlord values a quiet environment — mention your lifestyle and that you work regular hours', 5);
    }
    if (/gezin|family/i.test(description)) {
      addLandlord('This is a family-friendly property — if you have a stable family situation, highlight it', 5);
    }
  }

  // Financial tips (only if financial score < 60)
  if (financial.score < 60) {
    const maxHuur = inkomen > 0 ? inkomen / 3 : 0;
    const incomeRatio = (maxHuur > 0 && price > 0) ? price / maxHuur : 0;
    if (incomeRatio > 1.0) {
      addOther('Your income is below the standard 3x rent requirement — a guarantor or co-applicant will significantly strengthen your application', 14);
    } else if (incomeRatio >= 0.85) {
      addOther('Your income is close to the limit — mention your savings or stable employment history to reassure the landlord', 8);
    }
    if (user.contract_type === 'zzp') {
      addOther('As a freelancer, prepare 3 years of tax returns and your latest client contract — this is what Dutch landlords ask for', 6);
    }
    if (user.contract_type === 'tijdelijk') {
      addOther('Include an employer statement confirming your contract is likely to be renewed — this reduces perceived risk for the landlord', 6);
    }
  }

  // Document tips (only if document score < 70)
  if (documents.score < 70) {
    if (user.application_readiness === 'niet') {
      addOther('Prepare your ID, income proof, employer letter, and last 3 payslips before applying — missing documents are the #1 reason applications fail in the Netherlands', 20);
    } else if (user.application_readiness === 'bezig') {
      addOther('Finish your document pack this week — in Amsterdam and Rotterdam, landlords decide within 24-48 hours', 14);
    } else if (user.application_readiness === 'bijna') {
      addOther('Double-check you have: ID, DigiD, last 3 payslips, employer statement, and bank statements', 8);
    }
  }

  // Timing tip (only if listing is < 2 hours old)
  if (listing.listedAt) {
    const ageMins = (Date.now() - new Date(listing.listedAt).getTime()) / 60000;
    if (ageMins < 120) {
      addOther('This listing is fresh — apply within the next hour to be in the first wave of applicants', 9);
    }
  }

  // Competition tips (only if city is Amsterdam, Utrecht, or Haarlem)
  const hotCities = ['amsterdam', 'utrecht', 'haarlem'];
  const matchedCity = hotCities.find(c => city.includes(c));
  if (matchedCity) {
    const displayCity = matchedCity.charAt(0).toUpperCase() + matchedCity.slice(1);
    addOther(`In ${displayCity}, landlords receive 50+ applications — a personal introduction message doubles your chances of being invited`, 7);
  }

  // Fallback if nothing else applies
  if (landlordTips.length === 0 && otherTips.length === 0) {
    addOther('Send a short personal introduction with your application — landlords in the Netherlands prefer tenants they feel they know', 5);
  }

  // Landlord tips first, then others sorted by boost, max 3
  landlordTips.sort((a, b) => b.boost - a.boost);
  otherTips.sort((a, b) => b.boost - a.boost);
  const top = [...landlordTips, ...otherTips].slice(0, 3);
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
