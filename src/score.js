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
// SMART SUGGESTIONS — context-aware advisor tips
// ─────────────────────────────────────────────

function fmtEuro(n) {
  return '€' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function getImprovementTips(listing, user, _currentScore) {
  const price = listing.priceNumber || 0;
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);
  const cityRaw = (listing.city || '').toLowerCase().replace(/-/g, '');
  const desc = (listing.description || '').toLowerCase();

  const seen = new Set();
  const landlordTips = [];
  const financialTips = [];
  const profileTips  = [];
  const timingTips   = [];
  const cityTips     = [];
  const fallbackTips = [];

  function add(bucket, tip) {
    if (!seen.has(tip)) { seen.add(tip); bucket.push({ tip }); }
  }

  // ── LANDLORD INTENT TIPS (from description) ──────────────────────────
  if (desc.length > 50) {
    if (/professional|werkende|working professional|vast dienstverband/.test(desc)) {
      add(landlordTips, 'This landlord specifically asks for working professionals — open your message with your job title, employer name, and that you have a permanent contract');
    }
    if (/\bexpat\b|international|relocation|internationally/.test(desc)) {
      add(landlordTips, 'Expats are explicitly welcome — mention your country of origin, your Dutch employer or relocation package, and your expected length of stay');
    }
    if (/langdurig|long-term|lange termijn|meerdere jaren|minimaal 2 jaar/.test(desc)) {
      add(landlordTips, 'Long-term tenancy is a stated priority — in your introduction, commit to a minimum of 2 years and explain why you plan to stay');
    }
    if (/rustig|quiet|geen overlast|no noise|respectvol/.test(desc)) {
      add(landlordTips, "The landlord values a quiet, respectful tenant — mention that you work regular hours, don't host parties, and take good care of your living space");
    }
    if (/geen huisdieren|no pets|geen dieren/.test(desc)) {
      add(landlordTips, '⚠️ No pets allowed — if you have pets, do not apply to this listing');
    }
    if (/\bkoppel\b|couple|stel|twee personen|2 personen/.test(desc)) {
      add(landlordTips, "This listing seems suited for a couple — if applying with a partner, mention this upfront as it may align well with the landlord's preference");
    }
    if (/\bstudent\b|students welcome|studenten/.test(desc)) {
      add(landlordTips, "Students are welcome here — if you're a student, mention your institution and expected graduation date");
    }
    if (/income requirement|inkomenseis|3x huur|4x huur/.test(desc)) {
      if (inkomen > 0 && price > 0) {
        const maxHuur = inkomen / 3;
        if (price > maxHuur) {
          const gap = Math.ceil((price * 3 - inkomen) / 100) * 100;
          add(landlordTips, `This landlord requires 3x monthly rent in income — your income is below this threshold, consider adding a guarantor or co-applicant who earns at least ${fmtEuro(gap)}/month more`);
        } else {
          add(landlordTips, 'Your income meets the stated 3x requirement — mention this explicitly in your application');
        }
      }
    }
  }

  // ── FINANCIAL TIPS (actual ratio with real numbers) ──────────────────
  if (inkomen > 0 && price > 0 && listing.transactionType === 'huur') {
    const maxHuur = inkomen / 3;
    const ratio   = price / maxHuur;           // >1 means income too low
    if (ratio > 1.2) {
      const multiplier = (inkomen / price).toFixed(1);
      const gap = Math.ceil((price * 3 - inkomen) / 100) * 100;
      add(financialTips, `Your income covers ${multiplier}x the rent — well below the standard 3x requirement. A guarantor who earns ${fmtEuro(gap)}/month more would close this gap`);
    } else if (ratio > 1.0) {
      const gap = Math.ceil((price * 3 - inkomen) / 100) * 100;
      add(financialTips, `Your income is just below the 3x rent threshold. Adding a co-applicant with even ${fmtEuro(gap)} extra monthly income would meet the requirement`);
    } else if (ratio > 0.85) {
      add(financialTips, 'Your income meets the requirement, but only just — mention your savings buffer or any additional income sources to reassure the landlord');
    }
    // ratio ≤ 0.85: strong fit — no financial tip needed, other tips are more valuable
  }

  // ── CONTRACT / PROFILE TIPS ──────────────────────────────────────────
  if (user.contract_type === 'zzp') {
    const maxHuur = inkomen > 0 ? inkomen / 3 : 0;
    if (price > 0 && inkomen > 0 && price > maxHuur) {
      add(profileTips, 'As a freelancer below the income threshold, attach your last 3 annual tax returns AND a current client contract showing ongoing income — this is what Dutch landlords ask for');
    } else {
      add(profileTips, 'As a freelancer with strong income, attach your last 3 annual tax returns upfront — proactive documentation removes the biggest objection');
    }
  }
  if (user.contract_type === 'tijdelijk') {
    add(profileTips, 'With a temporary contract, get a werkgeversverklaring stating your employer intends to renew — this is standard and significantly reduces perceived risk');
  }
  if (user.contract_type === 'student') {
    add(profileTips, "As a student, lead with your institution, program, and expected graduation date. If you have a guarantor (ouderlijke borgstelling), mention this immediately");
  }

  // ── DOCUMENT TIPS ────────────────────────────────────────────────────
  if (user.application_readiness === 'niet') {
    add(profileTips, "You haven't started your documents yet — before applying anywhere, prepare: valid ID, last 3 payslips, employer statement (werkgeversverklaring), and last 3 months of bank statements");
  } else if (user.application_readiness === 'bezig') {
    add(profileTips, 'Your documents are in progress — landlords in Amsterdam and Rotterdam decide within 24-48 hours, so prioritize finishing your document pack today');
  } else if (user.application_readiness === 'bijna') {
    add(profileTips, 'Almost ready — double-check you have all 5 standard Dutch documents: ID, BSN, last 3 payslips, employer letter, and 3 months of bank statements');
  }

  // ── TIMING TIPS ──────────────────────────────────────────────────────
  if (listing.listedAt) {
    const ageMins = (Date.now() - new Date(listing.listedAt).getTime()) / 60000;
    if (!isNaN(ageMins)) {
      if (ageMins < 30) {
        add(timingTips, "This listing went live minutes ago — you're among the first to see it. Apply immediately, before the inbox fills up");
      } else if (ageMins < 120) {
        add(timingTips, 'This listing is still fresh — apply in the next hour to stay in the first wave of applicants');
      } else if (ageMins > 360) {
        add(timingTips, 'This listing has been up for several hours — many have already applied. Make your application stand out with a strong personal introduction');
      }
    }
  }

  // ── CITY COMPETITION TIPS ────────────────────────────────────────────
  if (cityRaw.includes('amsterdam')) {
    add(cityTips, "Amsterdam averages 80+ applications per listing — a personalized first message that shows you've read the listing is no longer optional, it's required");
  } else if (cityRaw.includes('utrecht')) {
    add(cityTips, 'Utrecht is one of the most competitive rental markets — apply the same day and mention your availability for a viewing immediately');
  } else if (cityRaw.includes('haarlem')) {
    add(cityTips, 'Haarlem has very limited supply — if this listing fits, treat it as a priority application today');
  } else if (cityRaw.includes('rotterdam')) {
    add(cityTips, 'Rotterdam moves fast — respond the same day with your complete document pack ready to send');
  }

  // ── FALLBACK TIPS ────────────────────────────────────────────────────
  add(fallbackTips, "Write a 3-sentence personal introduction: who you are, why this specific home, and when you can move in — landlords read hundreds of messages and remember the personal ones");
  add(fallbackTips, 'Have your documents in a single PDF ready to attach — applicants who can send everything immediately get priority');
  add(fallbackTips, 'If you can do a viewing within 48 hours, state this clearly — availability is one of the top factors landlords consider');

  // ── MERGE: up to 2 from landlord+financial, fill rest from profile/timing/city, then fallback ──
  const tips = [];
  for (const t of [...landlordTips, ...financialTips]) {
    if (tips.length >= 2) break;
    tips.push(t);
  }
  for (const t of [...profileTips, ...timingTips, ...cityTips]) {
    if (tips.length >= 3) break;
    tips.push(t);
  }
  for (const t of fallbackTips) {
    if (tips.length >= 3) break;
    tips.push(t);
  }

  return { tips: tips.slice(0, 3) };
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
