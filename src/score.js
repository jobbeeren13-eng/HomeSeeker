const { getCityPriceBenchmark, getNeighbourhoodPriceBenchmark, getAgencyInsights } = require('./database');

// Kill-switch: set ENABLE_NEIGHBOURHOOD_BENCHMARK=false to disable without a code change
const NEIGHBOURHOOD_BENCHMARK_ENABLED = process.env.ENABLE_NEIGHBOURHOOD_BENCHMARK !== 'false';
const NEIGHBOURHOOD_SAMPLE_MIN = 8;

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
  else if (user.contract_type === 'zzp') { score += 5; detail = 'Self-employed: may require extra docs'; }
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
    bijna: 'Almost ready: minor documents missing',
    bezig: 'Documents in progress: significant gap',
    niet: 'No documents prepared: high risk',
  };
  return { score, label: tierLabel(score), detail: details[user.application_readiness] || 'Unknown' };
}

function calcTimingAdvantage(listing) {
  if (!listing.listedAt) return { score: 60, label: 'Unknown', detail: 'Listing age unknown' };
  const ageMs = Date.now() - new Date(listing.listedAt).getTime();
  if (isNaN(ageMs)) return { score: 60, label: 'Unknown', detail: 'Listing age unknown' };
  const ageMins = ageMs / 60000;
  let score, detail;
  if (ageMins <= 30) { score = 100; detail = 'Just listed: apply immediately before competition builds'; }
  else if (ageMins <= 120) { score = 100; detail = 'New listing: apply immediately'; }
  else if (ageMins <= 1440) { score = 55; detail = 'Listed today: competition is building'; }
  else { score = 10; detail = 'Listing is older: very competitive'; }
  return { score, label: tierLabel(score), detail };
}

function listingAgeBonusPoints(listing) {
  if (!listing.listedAt) return 0;
  const ageMs = Date.now() - new Date(listing.listedAt).getTime();
  if (isNaN(ageMs) || ageMs < 0) return 0;
  const ageMins = ageMs / 60000;
  if (ageMins <= 30) return 15;
  if (ageMins <= 120) return 8;
  return 0;
}

function calcCompetitionPressure(listing) {
  const price = listing.priceNumber || 0;
  const city = (listing.city || '').toLowerCase();
  let score = 60;
  let detail = 'Average competition';

  // High demand cities
  const hotCities = ['amsterdam', 'utrecht', 'haarlem', 'leiden'];
  const mediumCities = ['rotterdam', 'den-haag', 'eindhoven', 'delft'];
  if (hotCities.includes(city)) { score -= 20; detail = 'High-demand city: expect many applications'; }
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

const COMPETITION_PENALTY = {
  funda: {
    amsterdam: 18,
    utrecht: 14,
    haarlem: 14,
    leiden: 12,
    delft: 11,
    'den-haag': 9,
    rotterdam: 9,
    eindhoven: 8,
    default: 10,
  },
  kamernet: {
    amsterdam: 10,
    rotterdam: 6,
    utrecht: 8,
    default: 6,
  },
  housinganywhere: {
    amsterdam: 8,
    rotterdam: 5,
    utrecht: 6,
    default: 5,
  },
};

function getCompetitionPenalty(source, city) {
  const src = (source || 'funda').toLowerCase();
  const cty = (city || '').toLowerCase().replace(/\s+/g, '-');
  const penalties = COMPETITION_PENALTY[src] || COMPETITION_PENALTY.funda;
  return penalties[cty] || penalties.default;
}

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

  const bonus = listingAgeBonusPoints(listing);
  const raw = Math.round(weighted) + bonus;
  if (isNaN(raw)) return 0;
  let score = Math.min(100, Math.max(0, raw));
  const competitionPenalty = getCompetitionPenalty(listing.source, listing.city);
  score = Math.max(0, score - competitionPenalty);
  return Math.round(score);
}

function scoreLabel(score) {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Strong';
  if (score >= 55) return 'Good';
  if (score >= 40) return 'Fair';
  if (score >= 25) return 'Weak';
  return 'Very Weak';
}

const strengthLabel = scoreLabel;

// ─────────────────────────────────────────────
// SMART SUGGESTIONS — context-aware advisor tips
// ─────────────────────────────────────────────

function fmtEuro(n) {
  return '€' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function getImprovementTips(listing, user, _currentScore, _dealScore) {
  const price = listing.priceNumber || 0;
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);
  const desc = (listing.description || '').toLowerCase();
  const source = (listing.source || '').toLowerCase();
  const city = (listing.city || '').toLowerCase();
  const signals = analyseDescription(listing.description, listing);
  const listingTips = [];  // critical blockers + listing-specific opportunities
  const profileTips = [];  // profile-specific always-fire tips
  const generalTips = [];

  // ── LEVEL 1: CRITICAL BLOCKERS — shown first, always, highest priority ──

  if (inkomen > 0 && price > 0) {
    const ratio = inkomen / price;
    if (ratio < 2.5) {
      const requiredIncome = fmtEuro(price * 3);
      listingTips.push({
        tip: `Your income is ${ratio.toFixed(1)}x the rent — significantly below the standard 3x requirement. Do not apply without a guarantor earning above ${requiredIncome}/mo or an offer of 3 months deposit upfront. Most landlords will reject without one of these.`,
        category: 'financial_blocker',
        level: 'critical',
      });
    }
  }

  if (user.application_readiness === 'niet') {
    listingTips.push({
      tip: 'Your documents are not prepared. Without payslips, employment contract, and bank statements ready to send, you cannot compete with applicants who can deliver documents within the hour. Prepare these before applying.',
      category: 'documents_blocker',
      level: 'critical',
    });
  }

  const ct = (user.contract_type || '').toLowerCase();
  const profiel = (user.profiel_type || '').toLowerCase();
  const isStudent = ct === 'student' || profiel === 'student';
  const hasNoEmployment = ct === '' || ct === 'none';
  const hasPartner = user.met_partner === 'ja';

  if (isStudent && /geen studenten|no students|niet voor studenten|studenten niet|not for students/i.test(desc)) {
    listingTips.push({
      tip: 'This landlord explicitly states no students. Applying is very unlikely to succeed and may waste your first-hour advantage on a better listing.',
      category: 'student_blocker',
      level: 'critical',
    });
  }

  if (hasPartner && /geen koppel|geen koppels|no couples|geen stel\b|geen stellen/i.test(desc)) {
    listingTips.push({
      tip: 'This landlord states no couples. This conflicts directly with your profile — applying is very unlikely to succeed.',
      category: 'couples_blocker',
      level: 'critical',
    });
  }

  if (hasNoEmployment && /geen uitkeringsgerechtigden|werkende woningdelers|only working professionals|working professionals only/i.test(desc)) {
    listingTips.push({
      tip: 'This landlord requires proof of employment. Without this, your application will not pass the first filter.',
      category: 'employment_blocker',
      level: 'critical',
    });
  }

  // ── LEVEL 2: LISTING-SPECIFIC OPPORTUNITIES — only when description contains signals ──

  if (/woningcorporatie|sociale huur|objectcode|inschrijvingsduur|wachtlijst|alliantie|ymere|stadgenoot|eigen haard|de key|rochdale/i.test(desc)) {
    listingTips.push({ tip: "This is a social housing listing — you need a valid objectcode or registration number, not a motivation letter. Follow the housing corporation's specific process exactly — applying without the correct objectcode is an immediate rejection.", category: 'social_housing', level: 'listing' });
  }

  if (/makelaar|makelaardij|real estate|NVM|VBO|\bvia\b.*kantoor/i.test(desc)) {
    listingTips.push({ tip: 'This listing is managed by an agency. Agencies process high volumes and are more transactional than private landlords. Call the agency directly after submitting — give your name, confirm your application, and ask about the timeline. Most applicants never call.', category: 'agency', level: 'listing' });
  }

  if (/werkende|working professional|working professionals|werkend\b|vast dienstverband/i.test(desc) && !isStudent) {
    listingTips.push({ tip: 'This landlord is explicitly filtering for working professionals. Your opening line must name your job title, employer, and contract type — nothing else. Landlords make this shortlist decision in under 10 seconds.', category: 'working_professional', level: 'listing' });
  }

  if (/expat|international|relocation|expats welcome|internationals/i.test(desc)) {
    listingTips.push({ tip: 'This landlord explicitly welcomes expats. Your international background and Dutch relocation story is an advantage here — mention your employer name and your reason for being in the Netherlands.', category: 'expat_welcome', level: 'listing' });
  }

  if (/\btuin\b|private garden|achtertuin|gemeenschappelijke tuin/i.test(desc)) {
    listingTips.push({ tip: 'This property has outdoor space. State directly that you will maintain it — landlords with gardens consistently cite neglect as their biggest fear. One sentence removes that concern.', category: 'garden', level: 'listing' });
  }

  if (/gemeubileerd|furnished|gestoffeerd/i.test(desc)) {
    listingTips.push({ tip: "This listing is furnished. Before applying, confirm exactly what is included — 'furnished' in Dutch listings ranges from a single bed to a complete home. Ask for an inventory list in your first message.", category: 'furnished', level: 'listing' });
  }

  if (/inschrijving niet mogelijk|geen inschrijving|not possible to register|cannot register/i.test(desc)) {
    listingTips.push({ tip: 'This listing does not allow municipality registration. For expats this is critical — without registration you cannot obtain a BSN, open a Dutch bank account, or access most government services. Verify whether this works for your situation before applying.', category: 'no_registration', level: 'listing' });
  }

  // Check listing age for "old listing" signal
  if (listing.listedAt) {
    const ageDays = (Date.now() - new Date(listing.listedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays >= 21) {
      listingTips.push({ tip: 'This listing has been available longer than average. The landlord may have had a previous deal fall through or is waiting for a very specific tenant. Apply with a message that emphasises your reliability and ability to sign quickly — this is your leverage.', category: 'old_listing', level: 'listing' });
    }
  }

  // ── LEVEL 3: PROFILE-SPECIFIC — always fire, always personalised ─────────────────

  if (inkomen > 0 && price > 0) {
    const ratio = inkomen / price;
    if (ratio >= 4) {
      profileTips.push({ tip: `Your income covers this rent ${ratio.toFixed(1)}x. Lead with your gross annual salary (${fmtEuro(inkomen * 12)}/year) in your first sentence — annual figures land harder than monthly, and your ratio is one of the strongest a landlord will see today.`, category: 'financial' });
    } else if (ratio >= 3) {
      const financialTip = signals.requires4x
        ? `This listing requires 4x income — you qualify at ${ratio.toFixed(1)}x. Mention this precisely in your application to show you have done the math: ${fmtEuro(inkomen * 12)}/year gross.`
        : `You meet the 3x income requirement at ${ratio.toFixed(1)}x. You qualify, but some private landlords want 3.5x or higher. State your gross annual income explicitly: ${fmtEuro(inkomen * 12)}/year.`;
      profileTips.push({ tip: financialTip, category: 'financial' });
    } else if (ratio >= 2.5) {
      profileTips.push({ tip: `Your income is ${ratio.toFixed(1)}x the rent — borderline for the standard 3x rule. State your annual income clearly (${fmtEuro(inkomen * 12)}/year) and offer to provide 3 months bank statements to demonstrate financial stability.`, category: 'financial' });
    }
    // below 2.5x is already a critical blocker in Level 1
  }

  if (ct === 'vast' || ct === 'permanent') {
    const contractTip = signals.prefersWorkingProfessionals
      ? 'This landlord explicitly filters for working professionals. Your permanent contract is exactly what they are screening for — lead with it in your very first sentence.'
      : 'Your permanent contract is your strongest asset in the Dutch rental market. It must appear in your first sentence, not buried in paragraph two. Landlords filter by contract type before they finish reading the opening line.';
    profileTips.push({ tip: contractTip, category: 'contract' });
  } else if (ct === 'tijdelijk' || ct === 'temporary') {
    profileTips.push({ tip: 'Your temporary contract is a risk signal for Dutch landlords. Address it proactively: state the likelihood of renewal, how long you have been with the employer, and consider offering 3 months deposit as security.', category: 'contract' });
  } else if (ct === 'zzp' || ct === 'freelance') {
    profileTips.push({ tip: 'Freelance income requires more documentation than employment. Prepare 3 years of annual accounts (jaaropgaven), a current assignment confirmation, and your last 6 months bank statements. State in your application that you have these ready.', category: 'contract' });
  }

  if (user.application_readiness === 'bezig' || user.application_readiness === 'bijna') {
    profileTips.push({ tip: 'Finish your documents before sending your application. The moment a landlord asks and you cannot deliver within the hour, you drop in the queue behind candidates who can.', category: 'documents' });
  } else if (user.application_readiness === 'klaar') {
    profileTips.push({ tip: "All documents prepared. State this explicitly in every message: 'I can send payslips, employment contract, and bank statements within the hour of your request.' This single sentence closes more deals than any other single action.", category: 'documents' });
  }

  if (source === 'funda') {
    profileTips.push({ tip: 'Funda listings attract 50-200 applications. Call the agency within one hour of sending your application — state your name, confirm your application, and ask about the timeline. Agents who speak to a candidate are 3x more likely to schedule a viewing.', category: 'source' });
  } else if (source === 'kamernet') {
    profileTips.push({ tip: 'Kamernet landlords are usually private individuals. A warm, personal message works better than a formal letter. If the landlord name appears anywhere in the listing, address them directly.', category: 'source' });
  } else if (source === 'housinganywhere') {
    profileTips.push({ tip: 'HousingAnywhere attracts many international applicants. Write your message in English and end with one sentence in Dutch — it signals integration and long-term intent.', category: 'source' });
  }

  // ── NEIGHBOURHOOD CONTEXT — CBS / Leefbaarometer, only when available for this listing ──
  {
    const parts = [];
    if (listing.cbsContext) {
      try {
        const cbs = typeof listing.cbsContext === 'string' ? JSON.parse(listing.cbsContext) : listing.cbsContext;
        if (cbs && cbs.gemInkomen) parts.push(`gemiddeld inkomen in deze buurt is ${fmtEuro(cbs.gemInkomen)}k/jaar`);
        else if (cbs && cbs.inwoners) parts.push(`deze buurt telt ongeveer ${cbs.inwoners} inwoners`);
      } catch (_) { /* ignore malformed cache entry */ }
    }
    if (listing.leefbaarometerScore != null) {
      parts.push(`leefbaarheidsscore van deze postcode is ${listing.leefbaarometerScore.toFixed(2)} (Leefbaarometer, meting 2020)`);
    }
    if (parts.length) {
      listingTips.push({ tip: `Buurtcontext: ${parts.join(', ')}.`, category: 'neighbourhood_context', level: 'info' });
    }
  }

  // ── GENERAL TIPS — universal best practices ─────────────────
  generalTips.push({ tip: 'Send all documents as one PDF named Firstname_Lastname_Application.pdf. Landlords with 50+ applications shortlist candidates who make their job easy — loose files signal disorganisation.', category: 'general_docs' });
  generalTips.push({ tip: "Name two specific days you are available in your first message: 'I am free Tuesday and Thursday this week.' Vague availability loses viewings to candidates who are decisive.", category: 'general_timing' });
  generalTips.push({ tip: 'Add one sentence about why this specific street suits your life — near your work, your neighbourhood. Landlords can tell when someone actually wants this home versus any available rental.', category: 'general_personal' });

  // ── Flat deduplicated tips array for backwards compatibility ───
  const usedCategories = new Set();
  const tips = [];
  for (const t of [...listingTips, ...profileTips, ...generalTips]) {
    if (!usedCategories.has(t.category)) {
      usedCategories.add(t.category);
      tips.push(t);
    }
  }

  return { listingTips, profileTips, generalTips, tips };
}

// ─────────────────────────────────────────────
// LISTING INTELLIGENCE — structured intelligence
// ─────────────────────────────────────────────

const CITY_RENT_PM2 = {
  amsterdam: 28, utrecht: 22, rotterdam: 18, 'den-haag': 17,
  haarlem: 24, leiden: 21, eindhoven: 15, groningen: 12,
};

// Merges the LLM-derived signals (src/llm-signals.js) into the regex-based result.
// Shared boolean keys are OR'd — the LLM only adds nuance regex misses, never removes a regex hit.
// Never throws: any parse/shape problem silently falls back to the regex-only result.
function mergeLlmSignals(base, listing) {
  if (!listing || !listing.llmSignals) return base;
  let llm;
  try {
    llm = typeof listing.llmSignals === 'string' ? JSON.parse(listing.llmSignals) : listing.llmSignals;
  } catch (_) { return base; }
  if (!llm || typeof llm !== 'object') return base;

  const merged = { ...base };
  for (const key of Object.keys(base)) {
    if (typeof base[key] === 'boolean' && typeof llm[key] === 'boolean') {
      merged[key] = base[key] || llm[key];
    }
  }
  if (typeof llm.riskNotes === 'string' && llm.riskNotes) merged.llmRiskNotes = llm.riskNotes;
  if (typeof llm.summary === 'string' && llm.summary) merged.llmSummary = llm.summary;
  return merged;
}

function analyseDescription(description, listing) {
  const d = (description || '').toLowerCase();
  const price = listing.priceNumber || 0;
  const area = listing.area || 0;

  const base = {
    // Income/contract requirements
    requires3x: /\b3x\b|driedubbel huur|drie maal huur|3 maal|inkomen.*3x|3x.*inkomen/i.test(d),
    requires4x: /\b4x\b|vierdubbel huur|vier maal|4 maal|inkomen.*4x|4x.*inkomen/i.test(d),
    requiresEmployerStatement: /werkgeversverklaring|employer.*statement|employment.*declaration|employer declaration/i.test(d),
    requiresReference: /\breference\b|\breferenties\b|\breferentie\b|vorige verhuurder|previous landlord/i.test(d),
    requiresGuarantor: /\bgarant\b|\bsurety\b|\bguarantor\b|\bborg.*persoon\b/i.test(d),

    // Tenant type preferences
    prefersWorkingProfessionals: /werkend(e)?\b|working professional|professionals only|vaste baan|werknemer|professional huurder/i.test(d),
    prefersExpats: /\bexpat\b|international.*tenant|english.*speaking|english welcome|internationals welcome|no dutch required/i.test(d),
    excludesStudents: /geen student|no students|not.*student|studenten niet/i.test(d),
    excludesCouples: /geen koppel|geen koppels|no couples|geen stel\b/i.test(d),

    // Property characteristics
    isFurnished: /gemeubileerd|furnished|gestoffeerd|inclusief meubels|met meubels/i.test(d),
    hasGarden: /\btuin\b|private garden|achtertuin|moestuin/i.test(d),
    hasSouthFacing: /zuidbalkon|south.facing|zuidgericht|op het zuiden/i.test(d),
    hasParking: /\bparkeerplaats\b|\bparking\b|\bgarage\b|\bparkeren inbegrepen\b/i.test(d),
    hasVvE: /\bvve\b|vve-bijdrage|vereniging van eigenaren|service.*kosten|servicekosten/i.test(d),
    hasStadsverwarming: /stadsverwarming|district heating/i.test(d),
    isNewlyRenovated: /gerenoveerd|renovated|nieuw keuken|nieuwe badkamer|recent verbouwd|vers gerenoveerd/i.test(d),
    isNewBuild: /nieuwbouw|new build|new construction|oplevering 202/i.test(d),

    // Landlord signals
    isPrivateLandlord: /particulier|private owner|eigenaar verhuurt|zelf verhuur|particuliere verhuurder/i.test(d),
    isCorporation: /woningcorporatie|sociale huur|corporatie\b|toegelaten instelling/i.test(d),
    isAgency: /makelaar|verhuurmakelaar|real estate agent|makelaardij|via kantoor/i.test(d),
    socialHousing: /woningcorporatie|sociale huur|objectcode|wachtlijst|corporatie\b/i.test(d),

    // Landlord emphasis
    emphasisesStability: /langdurig|long.term|meerdere jaren|vaste huurder|stable tenant/i.test(d),
    emphasisesCare: /goed onderhoud|verzorgd|nette huurder|nette bewoner|zorg.*woning/i.test(d),

    // Lease conditions
    temporaryLease: /tijdelijk\b|temporary lease|short.stay|short stay|tijdelijke verhuur|diplochat|diplomatenclausule/i.test(d),
    noRegistration: /geen inschrijving|not possible to register|inschrijving niet mogelijk|no municipality registration/i.test(d),
    availableImmediately: /per direct|immediately available|direct beschikbaar|vanaf nu\b|z\.s\.m/i.test(d),

    // Price tier (derived)
    isHighEndRental: price > 2500,
    isBudgetRental: price > 0 && price < 900,
    isLargeProperty: area > 100,
    pricePerM2: area > 0 ? Math.round(price / area) : 0,
  };

  return mergeLlmSignals(base, listing);
}

function getListingIntelligence(listing, user) {
  const signals = analyseDescription(listing.description, listing);
  const price = listing.priceNumber || 0;
  const inkomen = ((user && user.inkomen) || 0) + ((user && user.partner_inkomen) || 0);
  const ct = ((user && user.contract_type) || '').toLowerCase();
  const source = (listing.source || '').toLowerCase();

  const smartPoints = [];
  const uniqueAngles = [];
  const watchOut = [];
  const hiddenSignals = [];
  const landlordProfile = [];
  const platformContext = [];

  function dedupe(arr) {
    const seen = new Set();
    return arr.filter(tip => {
      const key = tip.slice(0, 40).toLowerCase().replace(/[^a-z]/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ── LANDLORD PROFILE ──
  if (signals.isCorporation || signals.socialHousing) {
    landlordProfile.push('Social housing — requires an objectcode or registration number to apply. Standard motivation letters will be rejected.');
  } else if (signals.isPrivateLandlord) {
    landlordProfile.push('Private landlord — personal connection matters more than income data alone. They choose tenants they trust, not just tenants who qualify.');
  } else if (signals.isAgency) {
    landlordProfile.push('Agency listing — professional presentation and complete documentation are the primary filters used here.');
  } else {
    landlordProfile.push('Landlord type unclear from this listing — apply with both financial strength and a personal, specific message.');
  }
  if (signals.emphasisesStability) {
    landlordProfile.push('Long-term stability is explicitly prioritised — mention your intended lease length in the first message.');
  }
  if (signals.emphasisesCare) {
    landlordProfile.push('Presentation and care of the property matters here — acknowledge that you will maintain it to the same standard.');
  }

  // ── SMART POINTS ──
  if (signals.prefersWorkingProfessionals) {
    smartPoints.push('Lead with your job title, employer, and contract type in the first sentence. This listing filters for working professionals and that decision is made in the first 10 seconds of reading.');
  }
  if (signals.prefersExpats) {
    smartPoints.push('Your expat background is an advantage here — this landlord explicitly welcomes internationals. Mention your employer and relocation context upfront.');
  }
  if (signals.requiresEmployerStatement) {
    smartPoints.push('Werkgeversverklaring is explicitly required. Have yours signed before applying — requesting it after the fact adds 3-5 days and hands the deal to a faster candidate.');
  }
  if (signals.requiresReference) {
    smartPoints.push('A previous landlord reference is mentioned. If you have one ready, include it proactively — most candidates cannot provide this immediately and it becomes the deciding factor.');
  }
  if (signals.availableImmediately) {
    smartPoints.unshift('This listing is available immediately. State your exact move-in date in your first sentence — landlords with an empty property want it filled fast.');
  }
  if (signals.hasSouthFacing) {
    smartPoints.push('The south-facing aspect is highlighted — it signals the landlord values natural light and takes pride in the property. Mentioning that you specifically sought a south-facing home shows genuine intent.');
  }
  if (signals.hasGarden && signals.isPrivateLandlord) {
    smartPoints.push('Private landlords with gardens consistently worry about neglect. One sentence: "I have maintained outdoor spaces carefully in every home I have lived in."');
  } else if (signals.hasGarden) {
    smartPoints.push('Garden is mentioned — address it directly: "I enjoy and maintain outdoor spaces carefully."');
  }
  if (signals.isFurnished) {
    smartPoints.push('Furnished listing — before applying, ask for the inventory list. In the Netherlands, vague inventories are used to justify deposit deductions at move-out. Ask for it upfront.');
  }
  if (signals.isNewlyRenovated) {
    smartPoints.push('Recently renovated — acknowledge the investment: "I specifically chose a renovated property to avoid disruption in the first year." Shows forward thinking.');
  }
  if (signals.requires4x) {
    smartPoints.push('This listing requires 4x income — higher than the standard 3x. Confirm your income exceeds this threshold before applying and state it explicitly in your first message.');
  } else if (signals.requires3x && inkomen > 0 && price > 0) {
    const ratio = inkomen / price;
    if (ratio >= 3) {
      smartPoints.push(`You meet the stated 3x income requirement at ${ratio.toFixed(1)}x. State your gross annual income clearly: ${fmtEuro(inkomen * 12)}/year.`);
    }
  }
  if (signals.hasStadsverwarming) {
    smartPoints.push('Stadsverwarming is mentioned. Ask what the monthly cost has been — it ranges from EUR 80 to EUR 280 and is not visible in the listed rent.');
  }
  if (signals.hasParking) {
    smartPoints.push('Parking is included. Clarify whether you need it in your first message — offering flexibility on parking can differentiate you from candidates who assume it is theirs.');
  }
  if (signals.emphasisesStability) {
    smartPoints.push('Long-term tenancy is a priority for this landlord. Commit explicitly: "I am looking for somewhere to stay for at least two years."');
  }
  if (signals.isHighEndRental) {
    smartPoints.push('At this price point, most applicants are financially qualified. Standing out requires showing you specifically want this property — not just any available rental.');
  }
  if (signals.isBudgetRental) {
    smartPoints.push('Budget listings attract very high volumes. Keep your first message under 4 sentences — lead immediately with income and contract type.');
  }
  if (signals.isLargeProperty) {
    smartPoints.push('Large property — the landlord likely expects a stable, settled household. Mention your intention to stay long-term and who will live there.');
  }
  if (ct === 'zzp') {
    smartPoints.push('Freelance income requires extra documentation — prepare 3 years of annual accounts, current assignment confirmation, and 6 months bank statements. Have these ready before applying.');
  }

  // Income ratio tip when no explicit requirement signal
  if (inkomen > 0 && price > 0 && !signals.requires3x && !signals.requires4x) {
    const ratio = inkomen / price;
    if (ratio >= 4) {
      smartPoints.push(`Income ${ratio.toFixed(1)}x the rent — well above the standard 3x threshold. Lead with your gross annual salary: ${fmtEuro(inkomen * 12)}/year. Annual figures land harder than monthly.`);
    }
  }

  // Agency intelligence tip
  const agencyTip = getAgencyTip(listing);
  if (agencyTip) smartPoints.push(agencyTip);

  // Fallback when no signals fired
  if (smartPoints.length === 0) {
    smartPoints.push('Lead with your job title, contract type, and income-to-rent ratio in the first sentence.');
    smartPoints.push('State your move-in date as a fact: "I can move in on [date]" — not "I would like to".');
    smartPoints.push('Attach all documents in one PDF: Firstname_Lastname_Application.pdf.');
  }

  // ── UNIQUE ANGLES ──
  if (signals.hasGarden && !signals.isPrivateLandlord) {
    uniqueAngles.push('Most applicants mention they like the garden. Stand out instead: "I have maintained outdoor spaces in every home — I see it as a responsibility, not a perk."');
  }
  if (signals.prefersWorkingProfessionals && ct === 'vast') {
    uniqueAngles.push('You have a permanent contract — the exact profile this landlord is filtering for. Most candidates bury this in paragraph two. Put it in sentence one.');
  }
  if (signals.isNewlyRenovated) {
    uniqueAngles.push('Reference the renovation: "I specifically chose a recently renovated property to avoid the disruption of works in the first year." Shows you are thinking ahead.');
  }
  if (signals.noRegistration) {
    uniqueAngles.push('This listing does not allow municipality registration — critical for anyone who needs a BSN, Dutch bank account, or healthcare access. Confirm this works for your situation before applying.');
  }

  const hoursOnline = listing.listedAt
    ? (Date.now() - new Date(listing.listedAt).getTime()) / 3600000
    : 48;

  if (hoursOnline > 504) {
    uniqueAngles.push('This listing has been available for over 3 weeks — ask directly: "I noticed this has been on the market for a while; is there anything I should know?" The answer reveals your leverage.');
  } else if (hoursOnline < 2) {
    uniqueAngles.push('Just listed — you are among the first to see this. Apply now and call the agency within the hour. The shortlist forms before the day is out.');
  }

  // Price vs market
  if (price > 0 && listing.area > 0 && listing.transactionType === 'huur') {
    const benchmark = CITY_RENT_PM2[(listing.city || '').toLowerCase()];
    if (benchmark) {
      const ppm2 = price / listing.area;
      const dev = (ppm2 - benchmark) / benchmark;
      if (dev < -0.10) {
        uniqueAngles.unshift(`Priced ${Math.round(-dev * 100)}% below the ${listing.city || 'city'} average — expect strong competition. Apply within the first 2 hours.`);
      } else if (dev > 0.20) {
        uniqueAngles.push('Premium-priced listing — competition is lower but standards are higher. Position yourself as a quality tenant: stable income, excellent references, documents ready.');
      }
    }
  }

  if (uniqueAngles.length === 0) {
    uniqueAngles.push('Name two specific viewing days in your first message — most candidates stay vague. Decisiveness signals commitment and shortcuts the landlord\'s decision process.');
  }

  // ── WATCH OUT ──
  if (signals.socialHousing || signals.isCorporation) {
    watchOut.push('Social housing listing — you need an objectcode or registration number to apply. Standard motivation letters will be rejected immediately.');
  }
  if (signals.temporaryLease) {
    watchOut.push('Temporary or short-stay contract — Dutch tenant law offers significantly less protection on temporary leases. Confirm the exact end date and whether extension is possible before signing.');
  }
  if (signals.requiresGuarantor) {
    watchOut.push('A guarantor is required or mentioned. Arrange this before applying — landlords who require one will reject without it regardless of your income level.');
  }
  if (signals.excludesCouples && user && (user.met_partner === 'ja' || (user.partner_inkomen || 0) > 0)) {
    watchOut.push('This listing states no couples — your profile includes a partner. Your application may be filtered out immediately.');
  }
  if (signals.excludesStudents && user && ((user.contract_type || '') === 'student' || (user.profiel_type || '') === 'student')) {
    watchOut.push('This listing explicitly excludes students and your profile is set to student. Applying will very likely be rejected.');
  }
  if (inkomen > 0 && price > 0 && (inkomen / price) < 2.5) {
    watchOut.push(`Income ${(inkomen / price).toFixed(1)}x the rent — below the 3x rule. Do not apply without a guarantor earning above ${fmtEuro(price * 3)}/mo or an offer of 3 months deposit upfront.`);
  }
  watchOut.splice(3);

  // ── HIDDEN SIGNALS ──
  if (signals.hasVvE) {
    hiddenSignals.push('VvE mentioned — service costs apply. Ask for the breakdown: service costs cover shared building maintenance and you have a legal right to this information before signing.');
  }
  if (signals.requiresReference && !signals.requiresGuarantor) {
    hiddenSignals.push('Reference requested — this landlord has likely had a problematic tenant before. They are filtering for reliability above all else. Emphasise stability and track record.');
  }
  if (signals.emphasisesCare) {
    hiddenSignals.push('Landlord emphasises condition — they are anxious about damage. Mention one specific example of how you maintain your current home.');
  }
  if (signals.emphasisesStability) {
    hiddenSignals.push('Long-term preference signals past short-stay tenants — explicitly committing to a duration ("I plan to stay at least 2 years") addresses this anxiety directly.');
  }
  if (/rustig|quiet|geen overlast|geen feestjes|geen muziek/i.test(listing.description || '')) {
    hiddenSignals.push('Quiet household emphasis is a filter, not a preference — landlord has likely had noise problems before. Mention you keep regular hours and respect neighbours.');
  }
  if (/borg|waarborgsom|deposit/i.test(listing.description || '')) {
    hiddenSignals.push('Deposit explicitly mentioned — confirming your deposit is ready immediately removes a common last-hurdle hesitation for landlords.');
  }
  if (hiddenSignals.length === 0) {
    if (source === 'funda') {
      hiddenSignals.push('Agency listings are transactional — agents select for candidates easiest to close. Document readiness and immediate availability matter more than personality here.');
    } else {
      hiddenSignals.push('Private landlords value tenants who communicate clearly and respond promptly — replying within 2 hours of contact signals this from the start.');
    }
  }
  hiddenSignals.splice(4);

  // ── PLATFORM CONTEXT ──
  if (source === 'funda') {
    platformContext.push('Call the agency within 1 hour of applying. Candidates who call are 3x more likely to get a viewing — most applicants never do.');
  } else if (source === 'kamernet') {
    platformContext.push('Kamernet landlords are usually private individuals. A warm, personal tone works better than a formal letter — use their first name if it appears anywhere in the listing.');
  } else if (source === 'housinganywhere') {
    platformContext.push('HousingAnywhere attracts many international applicants. End your message with one Dutch sentence — it signals integration and long-term intent.');
  }

  const tips = [
    ...dedupe(watchOut).map(t => ({ tip: t, category: 'watch_out', level: 'critical' })),
    ...dedupe(landlordProfile).map(t => ({ tip: t, category: 'landlord_profile', level: 'listing' })),
    ...dedupe(smartPoints).map(t => ({ tip: t, category: 'smart_point', level: 'listing' })),
    ...dedupe(hiddenSignals).map(t => ({ tip: t, category: 'hidden_signal', level: 'listing' })),
    ...dedupe(uniqueAngles).map(t => ({ tip: t, category: 'unique_angle', level: 'profile' })),
    ...platformContext.map(t => ({ tip: t, category: 'platform', level: 'profile' })),
  ];

  return {
    landlordProfile: dedupe(landlordProfile),
    smartPoints: dedupe(smartPoints),
    uniqueAngles: dedupe(uniqueAngles),
    watchOut: dedupe(watchOut),
    hiddenSignals: dedupe(hiddenSignals),
    platformContext,
    tips,
  };
}

// ─────────────────────────────────────────────
// BUYER TIPS — koop listings only
// ─────────────────────────────────────────────

const CITY_OVERBID = {
  amsterdam: 17, utrecht: 13, haarlem: 14, leiden: 12, delft: 11,
  'den-haag': 9, rotterdam: 9, eindhoven: 10, groningen: 5, maastricht: 4, almere: 7,
};

function getBuyerTips(listing, user) {
  const price = listing.priceNumber || 0;
  const desc = (listing.description || '').toLowerCase();
  const city = (listing.city || '').toLowerCase();
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);
  const listingTips = [];
  const profileTips = [];
  const generalTips = [];

  if (/erfpacht/i.test(desc)) {
    listingTips.push({ tip: 'This property has erfpacht (ground lease). Ask for the current canon amount, the revision date, and whether permanent buyout is possible. Erfpacht significantly affects your mortgage options and long-term cost — most banks are cautious about temporary erfpacht.', category: 'erfpacht' });
  }

  if (/\bvve\b|servicekosten|appartements?complex|vvE/i.test(desc)) {
    listingTips.push({ tip: 'This apartment is part of a VvE (owners association). Request the last 3 years of meeting minutes, the reserve fund balance, and the MJOP maintenance plan before bidding. A poorly funded VvE is the most common source of buyer regret in the Netherlands.', category: 'vve' });
  }

  if (/renovatie|verbouwing|te renoveren|opknapper|klus|fixer/i.test(desc)) {
    listingTips.push({ tip: 'This property needs renovation. Budget EUR 600-1200/m2 for a complete renovation at current Dutch contractor rates. Always get a building inspection (bouwkundige keuring) before bidding — it gives you grounds to renegotiate or exit the deal.', category: 'renovation' });
  }

  if (/nieuwbouw|new development|new build|nieuw gebouwd|sleutelklaar/i.test(desc)) {
    listingTips.push({ tip: 'New construction: transfer tax applies only to the land value, not the construction cost. The price is usually fixed — overbidding is rare. Confirm the completion date and check whether a delay penalty clause protects you if handover is late.', category: 'new_construction' });
  }

  if (inkomen > 0 && price > 0) {
    const maxMortgage = Math.round(inkomen * 12 * 4.5 / 1000) * 1000;
    const buyingCosts = Math.round(price * 0.06 / 100) * 100;
    const gap = price - maxMortgage;
    const note = gap > 0
      ? `Your maximum mortgage (EUR ${maxMortgage.toLocaleString('nl-NL')}) is EUR ${gap.toLocaleString('nl-NL')} below the asking price — you need additional own funds to cover the gap.`
      : `Your maximum mortgage is approximately EUR ${maxMortgage.toLocaleString('nl-NL')}, which covers this asking price.`;
    profileTips.push({ tip: `${note} Budget roughly EUR ${buyingCosts.toLocaleString('nl-NL')} in buying costs (transfer tax, notary, inspection, mortgage advisor).`, category: 'mortgage_capacity' });
  }

  const overbidPct = CITY_OVERBID[city] || 8;
  if (price > 0) {
    const recBid = Math.round(price * (1 + overbidPct / 100) / 1000) * 1000;
    profileTips.push({ tip: `In this city, median overbid is around ${overbidPct}%, suggesting a competitive bid near EUR ${recBid.toLocaleString('nl-NL')}. Same-day bidding and a personal buyer letter attached to your offer increase your win rate.`, category: 'overbid' });
  }

  generalTips.push({ tip: 'Always include a building inspection clause (bouwkundige keuring) for homes over 20 years old — it costs EUR 400-600 and gives you grounds to renegotiate or withdraw if serious defects are found.', category: 'general' });
  generalTips.push({ tip: 'Ask when the seller needs to hand over the keys — offering a transfer date that suits them is often more persuasive than a slightly higher bid, especially for owner-occupiers.', category: 'general_timing' });
  generalTips.push({ tip: 'Attach a brief personal letter to your bid explaining who you are and why you want this specific property. Owner-sellers respond strongly to this — it often tips the decision when bids are close.', category: 'general_letter' });

  const usedCategories = new Set();
  const tips = [];
  for (const t of [...listingTips, ...profileTips, ...generalTips]) {
    if (!usedCategories.has(t.category)) {
      usedCategories.add(t.category);
      tips.push(t);
    }
  }

  return { listingTips, profileTips, generalTips, tips };
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
    category: 'contract',
    patterns: [/professional/i, /werkende/i, /werkend\b/i, /working professional/i, /professional couple/i, /professional tenant/i, /vast dienstverband/i],
    label: 'Professional tenant preferred',
    tip: 'Emphasize your professional employment and stable income',
    boost: 8,
  },
  longterm: {
    category: 'long-term',
    patterns: [/long.term/i, /langdurig/i, /for several years/i, /meerdere jaren/i, /stable tenant/i, /vaste huurder/i],
    label: 'Long-term tenant preferred',
    tip: 'Long-term preference: show stability through job, contract type, and city commitment',
    boost: 10,
  },
  expat: {
    category: 'expat',
    patterns: [/expat/i, /international/i, /relocation/i, /expats welcome/i, /internationals/i],
    label: 'Expat-friendly landlord',
    tip: 'Mention your relocation or international employment',
    boost: 6,
  },
  quiet: {
    category: 'lifestyle',
    patterns: [/quiet/i, /rustig/i, /respectful/i, /well-maintained/i, /no noise/i, /geen overlast/i, /geen feestjes/i, /geen muziek/i, /geen geluidsoverlast/i],
    label: 'Values quiet, considerate tenants',
    tip: 'Landlord values quiet tenants: mention you keep regular hours and respect neighbors',
    boost: 5,
  },
  family: {
    category: 'contract',
    patterns: [/family/i, /gezin/i, /near schools/i, /near school/i, /family home/i, /gezinswoning/i],
    label: 'Family-friendly property',
    tip: 'Highlight family stability in your application',
    boost: 5,
  },
  corporate: {
    category: 'contract',
    patterns: [/corporate lease/i, /company lease/i, /zakelijke huur/i, /employer/i],
    label: 'Corporate lease possible',
    tip: 'Consider applying through your employer if available',
    boost: 7,
  },
  nopets: {
    category: 'lifestyle',
    patterns: [/no pets/i, /geen huisdieren/i, /no animals/i, /geen dieren/i],
    label: 'No pets allowed',
    tip: null,
    boost: 0,
    warning: true,
  },
  nosharing: {
    category: 'contract',
    patterns: [/no sharing/i, /no roommates/i, /niet delen/i, /single occupant/i, /one person/i],
    label: 'No house sharing',
    tip: null,
    boost: 0,
    warning: true,
  },
  no_students: {
    category: 'contract',
    patterns: [/geen studenten/i, /no students/i, /niet voor studenten/i, /studenten niet/i, /not for students/i],
    label: 'No students: listing explicitly excludes students',
    tip: null,
    boost: 0,
    warning: true,
  },
  no_couples: {
    category: 'contract',
    patterns: [/geen koppel/i, /geen koppels/i, /no couples/i, /geen stel\b/i, /geen stellen/i],
    label: 'No couples: landlord prefers single occupant',
    tip: null,
    boost: 0,
    warning: true,
  },
  family_only: {
    category: 'contract',
    patterns: [/uitsluitend.*gezin/i, /alleen.*gezin/i, /enkel.*gezin/i, /family only/i, /voor gezinnen\b/i, /alleen voor gezinnen/i],
    label: 'Families only: landlord targets families with children',
    tip: null,
    boost: 0,
    warning: true,
  },
  working_only: {
    category: 'contract',
    patterns: [/geen uitkeringsgerechtigden/i, /werkende woningdelers/i, /only working professionals/i, /working professionals only/i],
    label: 'Working professionals only',
    tip: 'Working professionals only: lead with your job title and employer',
    boost: 10,
  },
  expat_with_family: {
    category: 'expat',
    patterns: [/expats met gezin/i, /expats \(met een gezin\)/i, /expats with family/i],
    label: 'Expats with families preferred',
    tip: 'Expats with families preferred: mention your family and relocation situation',
    boost: 8,
  },
  income_requirement: {
    category: 'contract',
    patterns: [/\d+x\s*(de\s*)?(maand)?huur/i, /\d+\s*times.*rent/i, /\d+x\s*(?:monthly\s*)?rent/i, /inkomenseis\b/i, /inkomensnorm\b/i],
    label: 'Income requirement mentioned',
    computeTip: (description) => {
      const m = description.match(/(\d+)[xX]\s*(?:de\s*)?(?:maand)?huur/i)
             || description.match(/(\d+)\s*times.*rent/i)
             || description.match(/(\d+)[xX]\s*(?:monthly\s*)?rent/i);
      const mult = m ? parseInt(m[1]) : null;
      return mult
        ? `Landlord requires ${mult}x monthly rent: confirm your income meets this`
        : 'Income requirement mentioned: confirm your income meets it before applying';
    },
    boost: 8,
  },
  tidy_tenant: {
    category: 'lifestyle',
    patterns: [/nette huurder/i, /nette bewoner/i, /\bverzorgd\b/i, /\bnetjes\b/i],
    label: 'Tidy, well-presented tenant preferred',
    tip: 'Tidy tenant valued: mention you keep your home in excellent condition',
    boost: 5,
  },
  couple_ok: {
    category: 'contract',
    patterns: [/voor (een )?(stel|koppel)/i, /(stel|koppel) welkom/i, /twee personen/i, /2[\s-]persoons/i, /geschikt voor.*koppel/i],
    label: 'Suitable for a couple',
    tip: 'Suited for a couple: if applying as two, mention this upfront',
    boost: 4,
  },
  single_ok: {
    category: 'contract',
    patterns: [/alleenstaand/i, /voor één persoon/i, /voor 1 persoon/i, /1[\s-]persoonshuishouden/i],
    label: 'Single occupant preferred',
    tip: 'Single occupant preferred: state clearly that you live alone',
    boost: 5,
  },
  registration_ok: {
    category: 'location',
    patterns: [/\binschrijving\b/i, /\binschrijven\b/i, /\bBRP\b/, /gemeentelijke\b/i, /inschrijf/i],
    label: 'Address registration available',
    tip: 'Address registration available: mention that you need to register here',
    boost: 6,
  },
  furnished_tip: {
    category: 'furnished',
    patterns: [/gemeubileerd/i, /gestoffeerd/i, /\bfurnished\b/i, /inclusief meubels/i],
    label: 'Property is furnished or decorated',
    tip: 'Furnished property: mention you appreciate a move-in ready home',
    boost: 3,
  },
  outdoor_space: {
    category: 'garden',
    patterns: [/\btuin\b/i, /\bbalkon\b/i, /\bdakterras\b/i, /\bterras\b/i],
    label: 'Property has outdoor space',
    tip: 'Has outdoor space: mention how you would use and maintain it',
    boost: 3,
  },
  pets_welcome: {
    category: 'lifestyle',
    patterns: [/huisdierenvriendelijk/i, /huisdieren welkom/i, /pets welcome/i, /pets allowed/i, /huisdieren toegestaan/i, /huisdieren zijn welkom/i],
    label: 'Pets welcome',
    tip: 'Pets welcome: if you have pets, mention them positively in your message',
    boost: 4,
  },
  min_rental_period: {
    category: 'long-term',
    patterns: [/minimaal\s+\d+\s*jaar/i, /minimale huurperiode/i, /minimum rental period/i, /minimum.*\d+\s*year/i],
    label: 'Minimum rental period required',
    computeTip: (description) => {
      const m = description.match(/minimaal\s+(\d+)\s*jaar/i)
             || description.match(/minimum.*?(\d+)\s*year/i);
      const years = m ? parseInt(m[1]) : null;
      return years
        ? `Minimum ${years}-year stay: commit to this explicitly in your application`
        : 'Minimum rental period required: state how long you plan to stay';
    },
    boost: 7,
  },
  students_welcome: {
    category: 'contract',
    patterns: [/studenten welkom/i, /students welcome/i, /studentenwoning/i, /studentenhuis/i, /geschikt voor studenten/i],
    label: 'Students welcome',
    tip: 'Students welcome: mention your institution, program, and graduation date',
    boost: 5,
  },
  deposit_mentioned: {
    category: 'guarantor',
    patterns: [/\bborg\b/i, /waarborgsom/i, /\bdeposit\b/i, /\bborgtocht\b/i, /\bkaution\b/i, /borg van/i, /borg bedraagt/i],
    label: 'Security deposit required',
    computeTip: (description) => {
      const m = description.match(/(?:borg(?:som|tocht)?|deposit|waarborgsom)[^€\d]*(?:€\s*)?([\d.,]+)/i);
      const amount = m ? parseFloat(m[1].replace(',', '.')) : null;
      return amount && amount > 100
        ? `Deposit of €${Math.round(amount)} required: have this ready before your viewing`
        : 'Security deposit required: confirm the amount and have it ready';
    },
    boost: 5,
  },
  no_dss: {
    category: 'contract',
    patterns: [/geen uitkering/i, /geen bijstand/i, /geen bijstandsuitkering/i, /no benefits/i, /no dss/i, /geen\s+ww\b/i, /geen werkloosheidsuitkering/i, /working income only/i],
    label: 'No benefits: earned income required',
    tip: null,
    boost: 0,
    warning: true,
  },
  per_direct: {
    category: 'timing',
    patterns: [/per direct/i, /direct beschikbaar/i, /immediately available/i, /available immediately/i, /vanaf nu beschikbaar/i, /\bnu beschikbaar\b/i, /asap/i],
    label: 'Available immediately',
    tip: 'Available now: state your earliest move-in date in your message',
    boost: 7,
  },
  viewing_appointment: {
    category: 'viewing',
    patterns: [/bezichtiging op afspraak/i, /viewing by appointment/i, /viewing on request/i, /viewing on appointment/i, /\bop afspraak\b/i, /bezichtiging aanvragen/i, /maak een afspraak/i],
    label: 'Viewing by appointment only',
    tip: 'Viewing by appointment: request a slot explicitly in your first message',
    boost: 5,
  },
  service_costs_incl: {
    category: 'contract',
    patterns: [/inclusief servicekosten/i, /servicekosten\s*(?:zijn\s*)?inbegrepen/i, /\ball.in\b/i, /utilities included/i, /stookkosten inbegrepen/i, /incl\.\s*servicekosten/i, /inclusief\s+gas\s*(?:en\s*)?elektra/i],
    label: 'Service costs or utilities included',
    tip: 'Service costs included: verify what is covered to budget correctly',
    boost: 4,
  },
  service_costs_excl: {
    category: 'contract',
    patterns: [/exclusief servicekosten/i, /excl\.\s*servicekosten/i, /service costs excluded/i, /\+\s*servicekosten/i, /servicekosten niet inbegrepen/i],
    label: 'Service costs on top of listed rent',
    computeTip: (description) => {
      const m = description.match(/servicekosten[^€\d]*(?:€\s*)?([\d.,]+)/i);
      const amount = m ? parseFloat(m[1].replace(',', '.')) : null;
      return amount && amount > 10
        ? `Service costs of €${Math.round(amount)}/mo extra: factor this into your budget`
        : 'Service costs are on top of listed rent: ask for the exact amount';
    },
    boost: 3,
  },
  energy_label_ab: {
    category: 'energy',
    patterns: [/\benergielabel\s*[ab]/i, /\benergy\s*label\s*[ab]/i, /\benergieklasse\s*[ab]/i, /\benergiezuinig\b/i],
    label: 'Good energy rating (A or B)',
    computeTip: (description) => {
      const m = description.match(/energielabel\s*([A-G][+]*)/i) || description.match(/energy\s*label\s*([A-G][+]*)/i);
      const lbl = m ? m[1].toUpperCase() : 'A';
      if (/^A/.test(lbl)) return 'Energy label A: low utility costs, roughly €50-100/mo below average homes';
      return 'Energy label B: decent insulation, reasonable heating costs';
    },
    boost: 3,
  },
  brp_required: {
    category: 'location',
    patterns: [/\binschrijving\s*(?:bij\s*)?(?:de\s*)?gemeente\s*(?:is\s*)?(?:niet\s*)?(?:mogelijk|toegestaan)/i, /\bBRP\s*(?:inschrijving)?\s*(?:is\s*)?(?:niet\s*)?(?:mogelijk|toegestaan)/i, /geen\s*inschrijving/i, /\bnot\s*possible\s*to\s*register\b/i, /gemeente\s*niet\s*mogelijk/i],
    label: 'Address registration not allowed',
    tip: null,
    boost: 0,
    warning: true,
  },
  young_professional: {
    category: 'contract',
    patterns: [/young professional/i, /young professionals/i, /starter/i, /starters/i],
    label: 'Aimed at young professionals or starters',
    tip: 'Targets young professionals: emphasise your career and commitment to the city',
    boost: 5,
  },
  no_subletting: {
    category: 'contract',
    patterns: [/niet onderhuren/i, /no subletting/i, /no sublet/i, /onderhuur niet toegestaan/i, /no airbnb/i, /no short.term rental/i],
    label: 'No subletting allowed',
    tip: null,
    boost: 0,
    warning: true,
  },
  good_maintenance: {
    category: 'lifestyle',
    patterns: [/\bnetjes\s*achterlaten\b/i, /goed onderhoud/i, /goed onderhouden/i, /goed verzorgd/i, /\bverzorgd achterlaten\b/i, /maintain.*(?:clean|good)/i, /in\s*goede\s*staat\b/i],
    label: 'Landlord expects property in good condition',
    tip: 'Careful maintenance expected: mention your track record with past properties',
    boost: 4,
  },
  availability_date: {
    category: 'timing',
    patterns: [/beschikbaar\s*(?:per|vanaf|op)\s*\d{1,2}[\s-]\w+/i, /available\s*(?:from|as of)\s*\d{1,2}/i, /\bper\s+\d{1,2}\s+(?:jan|feb|mrt|mar|apr|mei|may|jun|jul|aug|sep|okt|oct|nov|dec)/i, /\bfrom\s+\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i],
    label: 'Specific availability date mentioned',
    computeTip: (description) => {
      const m = description.match(/(?:beschikbaar\s*(?:per|vanaf|op)|available\s*(?:from|as of))\s*(\d{1,2}[\s-]\w+\s*\d{0,4})/i);
      const date = m ? m[1].trim() : null;
      return date
        ? `Available from ${date}: mention your move-in flexibility around this date`
        : 'Specific availability date: confirm your move-in timing aligns with it';
    },
    boost: 5,
  },
  werkgeversverklaring: {
    category: 'documents',
    patterns: [/werkgeversverklaring/i, /employer\s*(?:statement|declaration)/i],
    label: 'Employer statement required',
    tip: 'Employer statement required: get yours signed before applying',
    boost: 6,
  },
  payslips_req: {
    category: 'documents',
    patterns: [/loonstrook/i, /loonstroken/i, /\bpayslip/i, /salarisstrook/i, /salary\s*slip/i],
    label: 'Payslips required',
    tip: 'Last 3 payslips required: have them ready to send immediately',
    boost: 5,
  },
  digid_req: {
    category: 'documents',
    patterns: [/\bdigiD\b/i, /\bdigid\b/i],
    label: 'DigiD required',
    tip: 'DigiD required: ensure yours is active and accessible',
    boost: 4,
  },
  bsn_req: {
    category: 'documents',
    patterns: [/\bBSN\b/, /\bbsn-nummer\b/i, /burgerservicenummer/i],
    label: 'BSN number required',
    tip: 'BSN required: have it ready for the application form',
    boost: 4,
  },
  reference_req: {
    category: 'documents',
    patterns: [/\breferentie\b/i, /reference\s*(?:letter|required|needed|requested)/i, /landlord\s*reference/i, /huurdersreferentie/i],
    label: 'References required',
    tip: 'References required: prepare a previous landlord contact',
    boost: 5,
  },
  guarantor_req: {
    category: 'guarantor',
    patterns: [/\bborgsteller\b/i, /\bgarantsteller\b/i, /guarantor\s*required/i, /guarantor\s*needed/i],
    label: 'Guarantor required',
    tip: null,
    boost: 0,
    warning: true,
  },
  documents_general: {
    category: 'documents',
    patterns: [/bewijs van inkomen/i, /\bpaspoort\b/i, /\blegitimatie\b/i, /\bidentiteitsbewijs\b/i, /\bID\s*bewijs\b/i],
    label: 'Documents explicitly requested',
    tip: 'Documents requested: prepare ID, payslips, employer letter, bank statements',
    boost: 3,
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
        warnings.push({ key, label: signal.label });
      } else if (signal.computeTip) {
        const tip = signal.computeTip(description);
        if (tip) tips.push({ tip, boost: signal.boost, source: 'landlord', category: signal.category || 'general' });
      } else if (signal.tip) {
        tips.push({ tip: signal.tip, boost: signal.boost, source: 'landlord', category: signal.category || 'general' });
      }
    }
  }

  return { signals, tips, warnings };
}

// ─────────────────────────────────────────────
// PRICE INTELLIGENCE — uses real scraped data
// ─────────────────────────────────────────────

function buildPriceResult(ppm2, benchmarkPpm2, diffPct, source, city, sampleSize) {
  let label, color, action;
  if (diffPct > 20) {
    label = 'Significantly overpriced';
    color = 'red';
    action = `At €${Math.round(ppm2)}/m² vs the ${city} average of €${Math.round(benchmarkPpm2)}/m², this is ${diffPct}% above market. Fewer applicants will compete — but confirm you are comfortable with the premium before applying.`;
  } else if (diffPct > 8) {
    label = 'Above market';
    color = 'amber';
    action = `Priced ${diffPct}% above the ${city} average of €${Math.round(benchmarkPpm2)}/m². Competition will be moderate — focus on quality of application over speed.`;
  } else if (diffPct > -8) {
    label = 'Fair price';
    color = 'green';
    action = `Fairly priced at €${Math.round(ppm2)}/m² vs the ${city} average of €${Math.round(benchmarkPpm2)}/m². Expect normal competition — speed and document readiness matter most.`;
  } else if (diffPct > -20) {
    label = 'Below market';
    color = 'green';
    action = `Priced ${Math.abs(diffPct)}% below the ${city} average — expect high competition. Apply within the first 2 hours. The price advantage will attract many applications.`;
  } else {
    label = 'Significantly underpriced';
    color = 'green';
    action = `This listing is ${Math.abs(diffPct)}% below market price — expect very high competition, possibly 150+ applications. Apply immediately and call the agency within the hour.`;
  }
  return { ppm2: Math.round(ppm2), benchmarkPpm2: Math.round(benchmarkPpm2), diffPct, label, color, action, source, sampleSize: sampleSize || null };
}

function getPriceIntelligence(listing) {
  const price = listing.priceNumber || 0;
  const area = listing.area || 0;
  const city = (listing.city || '').toLowerCase();
  const type = listing.transactionType || 'huur';
  if (!price || !area || !city) return null;

  if (NEIGHBOURHOOD_BENCHMARK_ENABLED && listing.neighbourhood) {
    try {
      const nb = getNeighbourhoodPriceBenchmark.get(city, listing.neighbourhood, type);
      if (nb && nb.sample_size >= NEIGHBOURHOOD_SAMPLE_MIN && nb.avg_ppm2) {
        const ppm2 = price / area;
        const diffPct = Math.round((ppm2 - nb.avg_ppm2) / nb.avg_ppm2 * 100);
        return buildPriceResult(ppm2, nb.avg_ppm2, diffPct, 'live', city, nb.sample_size);
      }
    } catch (_) { /* fall through to city-level benchmark */ }
  }

  try {
    const benchmark = getCityPriceBenchmark.get(city, type);
    if (benchmark && benchmark.sample_size >= 5 && benchmark.avg_ppm2) {
      const ppm2 = price / area;
      const diffPct = Math.round((ppm2 - benchmark.avg_ppm2) / benchmark.avg_ppm2 * 100);
      return buildPriceResult(ppm2, benchmark.avg_ppm2, diffPct, 'live', city, benchmark.sample_size);
    }
  } catch (_) {}

  const STATIC = {
    amsterdam: 28, haarlem: 24, leiden: 21, utrecht: 22,
    delft: 19, 'den-haag': 17, rotterdam: 18, eindhoven: 15,
    groningen: 12, maastricht: 13, almere: 14,
  };
  const staticBenchmark = STATIC[city];
  if (!staticBenchmark) return null;
  const ppm2 = price / area;
  const diffPct = Math.round((ppm2 - staticBenchmark) / staticBenchmark * 100);
  return buildPriceResult(ppm2, staticBenchmark, diffPct, 'static', city);
}

// ─────────────────────────────────────────────
// LANDLORD PERSONA — tells user what to do differently
// ─────────────────────────────────────────────

function detectLandlordPersona(listing) {
  const desc = (listing.description || '');
  const source = (listing.source || '').toLowerCase();

  let corporate = 0, private_ = 0, riskAverse = 0;

  if (/makelaar|makelaardij|vastgoed|nvm|vbo|agency|management/i.test(desc)) corporate += 3;
  if (/inkomensbewijs|werkgeversverklaring|employer statement/i.test(desc)) corporate += 2;
  if (/3x.*huur|4x.*huur|maandinkomen/i.test(desc)) corporate += 2;

  if (/particulier|private owner|eigenaar verhuurt|zelf verhuur/i.test(desc)) private_ += 4;
  if (/gezellig|fijne buurt|goede buren|charming|cosy/i.test(desc)) private_ += 2;
  if (source === 'kamernet') private_ += 2;

  if (/geen huisdieren|geen studenten|no students|no pets/i.test(desc)) riskAverse += 3;
  if (/referentie|verhuurdersverklaring|landlord reference/i.test(desc)) riskAverse += 2;
  if (/langdurig|long.?term|minimaal.*jaar/i.test(desc)) riskAverse += 2;
  if (/netjes|verzorgd|representatief/i.test(desc)) riskAverse += 2;

  const dominant = corporate >= private_ && corporate >= riskAverse ? 'corporate'
    : private_ >= riskAverse ? 'private'
    : 'riskAverse';

  const strategies = {
    corporate: {
      label: 'Agency / corporate landlord',
      whatTheyWant: 'Income proof, correct documentation, no complications',
      strategy: 'Keep your message formal and factual. Lead with income, contract type, and a one-line statement that all documents are ready. Personal stories will not help here.',
      doThis: [
        'Open with: job title, employer, gross annual income, contract type',
        'State explicitly: "I can send payslips, contract, and bank statements within the hour"',
        'Call the agency after applying — most candidates never do',
      ],
      avoid: 'Long personal stories, emotional language, or anything that makes the application harder to process',
    },
    private: {
      label: 'Private landlord',
      whatTheyWant: 'A reliable person they feel comfortable with in their property',
      strategy: 'Private landlords choose tenants they trust. One genuine sentence about why you want this specific property outweighs a perfect financial profile.',
      doThis: [
        'Use their first name if it appears anywhere in the listing',
        'Write one specific sentence about why this property appeals to you — not "great location" but something concrete',
        'Keep your tone warm but professional — not formal, not casual',
      ],
      avoid: 'Generic copy-paste letters, overly formal tone, or mass-application feel',
    },
    riskAverse: {
      label: 'Risk-conscious landlord',
      whatTheyWant: 'Stability, long-term commitment, references',
      strategy: 'This landlord has been burned before. Every sentence in your application should reduce their perceived risk. Stability signals matter more than income here.',
      doThis: [
        'Mention how long you have been at your current employer',
        'State explicitly that you intend to stay for 2+ years',
        'Offer a reference from a previous landlord if you have one',
      ],
      avoid: 'Mentioning flexibility on lease length, recent job changes, or anything that signals you might leave soon',
    },
  };

  return {
    persona: dominant,
    confidence: Math.max(corporate, private_, riskAverse) > 4 ? 'High' : 'Medium',
    ...strategies[dominant],
  };
}

// ─────────────────────────────────────────────
// DOCUMENT READINESS — honest, specific
// ─────────────────────────────────────────────

function getDocumentReadiness(user, listing) {
  if (!user) return null;
  const desc = (listing?.description || '').toLowerCase();
  const readiness = user.application_readiness || 'niet';

  const alwaysRequired = [
    { id: 'id', label: 'Passport or ID copy' },
    { id: 'payslips', label: 'Last 3 payslips' },
    { id: 'contract', label: 'Employment contract' },
    { id: 'bank', label: 'Last 3 months bank statements' },
    { id: 'employer', label: 'Employer statement (werkgeversverklaring)' },
  ];

  const conditionalRequired = [];
  if (/verhuurdersverklaring|landlord reference|huurdersreferentie/i.test(desc)) {
    conditionalRequired.push({ id: 'reference', label: 'Landlord reference letter', reason: 'explicitly required in this listing' });
  }
  if (/guarantor|borgsteller|garantsteller/i.test(desc)) {
    conditionalRequired.push({ id: 'guarantor', label: 'Guarantor documentation', reason: 'required by this landlord' });
  }

  const doneIds = readiness === 'klaar' ? ['id', 'payslips', 'contract', 'bank', 'employer']
    : readiness === 'bijna' ? ['id', 'payslips', 'contract']
    : ['id'];

  const allRequired = [...alwaysRequired, ...conditionalRequired];
  const done = allRequired.filter(i => doneIds.includes(i.id));
  const missing = allRequired.filter(i => !doneIds.includes(i.id));
  const score = Math.round(done.length / allRequired.length * 100);

  const urgency = missing.length === 0 ? null
    : missing.length === 1 ? `One document missing: ${missing[0].label}`
    : `${missing.length} documents missing — you cannot compete with applicants who can send everything immediately`;

  return { score, done: done.map(i => i.label), missing: missing.map(i => ({ label: i.label, reason: i.reason || null })), urgency, ready: missing.length === 0 };
}

// ─────────────────────────────────────────────
// COMPETITION CONTEXT — honest, no fake %
// ─────────────────────────────────────────────

function getCompetitionContext(listing) {
  const city = (listing.city || '').toLowerCase();
  const price = listing.priceNumber || 0;
  const area = listing.area || 0;
  const hoursOnline = listing.listedAt
    ? (Date.now() - new Date(listing.listedAt).getTime()) / 3600000
    : 48;

  const cityBase = {
    amsterdam: { low: 50, high: 200 }, haarlem: { low: 30, high: 100 },
    leiden: { low: 25, high: 80 }, utrecht: { low: 30, high: 120 },
    'den-haag': { low: 20, high: 80 }, rotterdam: { low: 15, high: 60 },
    eindhoven: { low: 10, high: 40 }, groningen: { low: 8, high: 30 },
    maastricht: { low: 5, high: 20 },
  };
  const base = cityBase[city] || { low: 15, high: 50 };

  const STATIC_BENCHMARKS = { amsterdam: 28, utrecht: 22, rotterdam: 18, 'den-haag': 17, haarlem: 24, eindhoven: 15, groningen: 12 };
  const benchmark = STATIC_BENCHMARKS[city] || 18;
  const ppm2 = area > 0 ? price / area : 0;
  let multiplier = 1;
  if (ppm2 > 0 && ppm2 < benchmark * 0.85) multiplier = 1.5;
  if (ppm2 > benchmark * 1.2) multiplier = 0.6;

  const estimated = { low: Math.round(base.low * multiplier), high: Math.round(base.high * multiplier) };

  let timingMessage, urgency;
  if (hoursOnline < 2) { timingMessage = 'Just listed — you are among the first to see this. Apply now before the shortlist forms.'; urgency = 'critical'; }
  else if (hoursOnline < 6) { timingMessage = 'Listed a few hours ago — competition is building. Apply today.'; urgency = 'high'; }
  else if (hoursOnline < 24) { timingMessage = 'Listed today — many applications likely already submitted. Speed still matters.'; urgency = 'medium'; }
  else if (hoursOnline < 72) { timingMessage = 'Listed a few days ago — a strong, specific letter matters more than speed now.'; urgency = 'low'; }
  else { timingMessage = 'Listed over 3 days ago — if not yet rented, the landlord may be selective. Ask why directly.'; urgency = 'investigate'; }

  const successFactors = hoursOnline < 6
    ? [
        { factor: 'Speed — apply immediately', importance: 'Most important' },
        { factor: 'Document readiness — send everything within the hour', importance: 'Critical' },
        { factor: 'First contact message quality', importance: 'Secondary' },
      ]
    : hoursOnline < 24
    ? [
        { factor: 'Document readiness', importance: 'Most important' },
        { factor: 'Letter quality and personalisation', importance: 'Critical' },
        { factor: 'Follow-up call to agency', importance: 'High impact' },
      ]
    : [
        { factor: 'Letter quality — show you specifically want this property', importance: 'Most important' },
        { factor: 'Document readiness', importance: 'Critical' },
        { factor: 'Stand out from many identical applications', importance: 'Key differentiator' },
      ];

  const level = estimated.high > 150 ? 'Very High'
    : estimated.high > 80 ? 'High'
    : estimated.high > 40 ? 'Medium'
    : 'Low';

  return { estimated, level, urgency, timingMessage, successFactors };
}

function getAgencyTip(listing) {
  try {
    const url = listing.url || '';
    const fundaMatch = url.match(/funda\.nl\/[^/]+\/([a-z0-9-]+?)-\d+/i);
    const agencyKey = fundaMatch ? 'funda:' + fundaMatch[1] : (listing.source || 'unknown');
    const insights = getAgencyInsights.get(agencyKey);
    if (!insights || insights.total < 3) return null;
    if (insights.pct_contract > 70) {
      return `Based on ${insights.total} previous listings from this agency, ${insights.pct_contract}% required a permanent contract or employer statement — have yours ready before applying.`;
    }
    if (insights.pct_no_students > 70) {
      return `This agency has excluded students in ${insights.pct_no_students}% of its recent listings — confirm this listing accepts your profile before spending time on an application.`;
    }
    if (insights.pct_expats > 60) {
      return `This agency actively welcomes expats in ${insights.pct_expats}% of its listings. Your international background is an asset here — mention your employer and relocation context prominently.`;
    }
    if (insights.pct_furnished > 70) {
      return `This agency lists furnished properties ${insights.pct_furnished}% of the time. Ask for the inventory list upfront — furnished listings in the Netherlands vary enormously in what is included.`;
    }
  } catch (e) {}
  return null;
}

module.exports = { calculateScore, scoreLabel, strengthLabel, getImprovementTips, getListingIntelligence, getBuyerTips, getPillarBreakdown, detectLandlordIntent, getPriceIntelligence, detectLandlordPersona, getDocumentReadiness, getCompetitionContext, analyseDescription, getAgencyTip };
