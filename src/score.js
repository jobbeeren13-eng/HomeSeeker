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

  const seen = new Set();
  const landlordTips = [];
  const financialTips = [];
  const profileTips  = [];
  const timingTips   = [];
  const cityTips     = [];
  const fallbackTips = [];

  function add(bucket, tip) {
    if (tip && !seen.has(tip)) { seen.add(tip); bucket.push({ tip }); }
  }

  // ── AI-GENERATED TIP (pre-computed, highest priority) ────────────────
  if (listing.aiTip) add(landlordTips, listing.aiTip);

  // ── INCOME CROSS-REFERENCE (beats generic income_requirement tip) ────
  let skipGenericIncomeReq = false;
  if (inkomen > 0 && price > 0 && listing.description) {
    const mIncome = listing.description.match(/(\d+)[xX]\s*(?:de\s*)?(?:maand)?huur/i)
                 || listing.description.match(/(\d+)\s*times.*rent/i)
                 || listing.description.match(/(\d+)[xX]\s*(?:monthly\s*)?rent/i);
    if (mIncome) {
      const mult = parseInt(mIncome[1]);
      const required = price * mult;
      const gap = required - inkomen;
      skipGenericIncomeReq = true;
      if (gap > 0) {
        const shortfall = Math.ceil(gap / 100) * 100;
        add(financialTips, `Landlord requires ${mult}x rent (${fmtEuro(required)}/mo) — you are ${fmtEuro(shortfall)}/mo short`);
      } else {
        add(financialTips, `Your income meets the ${mult}x rent requirement (${fmtEuro(required)}/mo) — state this explicitly`);
      }
    }
  }

  // ── LANDLORD INTENT TIPS (all matching LANDLORD_SIGNALS from description) ──────────────────
  if (listing.description) {
    const { tips: descTips } = detectLandlordIntent(listing.description);
    for (const t of descTips) {
      if (skipGenericIncomeReq && t.tip && (t.tip.includes('income requirement') || t.tip.includes('Income requirement'))) continue;
      add(landlordTips, t.tip);
    }
  }

  // ── DEPOSIT TIP ──────────────────────────────────────────────────────
  if (user.heeft_borg === 'nee' && listing.description) {
    const hasBorg = /\bborg\b|waarborgsom|\bdeposit\b/i.test(listing.description);
    if (hasBorg) add(profileTips, 'Deposit required but you have no guarantor — budget for it and mention readiness to pay');
  }

  // ── FINANCIAL TIPS (actual ratio with real numbers) ──────────────────
  if (inkomen > 0 && price > 0 && listing.transactionType === 'huur') {
    const maxHuur = inkomen / 3;
    const ratio   = price / maxHuur;
    if (ratio > 1.2) {
      const multiplier = (inkomen / price).toFixed(1);
      const gap = Math.ceil((price * 3 - inkomen) / 100) * 100;
      add(financialTips, `Income at ${multiplier}x rent, need 3x: guarantor earning ${fmtEuro(gap)}/mo closes the gap`);
    } else if (ratio > 1.0) {
      const gap = Math.ceil((price * 3 - inkomen) / 100) * 100;
      add(financialTips, `Just below 3x threshold: add a co-applicant with ${fmtEuro(gap)}/mo extra income`);
    } else if (ratio > 0.85) {
      add(financialTips, 'Income just meets the limit: mention savings or extra income sources');
    }
  }

  // ── CONTRACT / PROFILE TIPS ──────────────────────────────────────────
  if (user.contract_type === 'zzp') {
    const maxHuur = inkomen > 0 ? inkomen / 3 : 0;
    if (price > 0 && inkomen > 0 && price > maxHuur) {
      add(profileTips, 'ZZP below threshold: attach 3 annual tax returns and a client contract');
    } else {
      add(profileTips, 'ZZP: attach 3 years of tax returns upfront to remove the main landlord objection');
    }
  }
  if (user.contract_type === 'tijdelijk') {
    add(profileTips, 'Temporary contract: get a werkgeversverklaring confirming renewal intent');
  }
  if (user.contract_type === 'student') {
    add(profileTips, 'Student: lead with institution, program, graduation year and guarantor if available');
  }

  // ── DOCUMENT TIPS ────────────────────────────────────────────────────
  if (user.application_readiness === 'niet') {
    add(profileTips, 'Prepare your docs first: ID, 3 payslips, employer letter, bank statements');
  } else if (user.application_readiness === 'bezig') {
    add(profileTips, 'Finish your document pack today: landlords decide within 24-48 hours');
  } else if (user.application_readiness === 'bijna') {
    add(profileTips, 'Almost ready: confirm you have ID, BSN, 3 payslips, employer letter, bank statements');
  }

  // ── TIMING TIPS ──────────────────────────────────────────────────────
  if (listing.listedAt) {
    const ageMins = (Date.now() - new Date(listing.listedAt).getTime()) / 60000;
    if (!isNaN(ageMins)) {
      if (ageMins < 30) {
        add(timingTips, 'Listed just now — apply immediately before the inbox fills up');
      } else if (ageMins < 120) {
        add(timingTips, 'Still fresh — apply within the hour to be in the first wave');
      } else if (ageMins > 360) {
        add(timingTips, 'Listing is several hours old — add a strong personal intro to stand out from late applicants');
      }
    }
  }

  // ── CITY COMPETITION TIPS ────────────────────────────────────────────
  if (cityRaw.includes('amsterdam')) {
    if (price > 0 && price < 1800) {
      add(cityTips, 'Amsterdam under €1,800: expect 100+ applicants — apply now, before the inbox fills');
    } else {
      add(cityTips, 'Amsterdam: highly competitive — include a personal message and viewing availability');
    }
  } else if (cityRaw.includes('utrecht')) {
    add(cityTips, 'Utrecht: extremely tight market — apply today and mention your earliest viewing availability');
  } else if (cityRaw.includes('haarlem')) {
    add(cityTips, 'Haarlem: very limited supply — treat this as a top-priority application');
  } else if (cityRaw.includes('rotterdam')) {
    add(cityTips, 'Rotterdam: fast market — respond today with your document pack ready');
  } else if (cityRaw.includes('leiden') || cityRaw.includes('delft')) {
    add(cityTips, 'Student city: high competition — a personal, concise intro message is essential');
  } else if (cityRaw.includes('eindhoven')) {
    add(cityTips, 'Eindhoven: international tech market — mention ASML/IMEC/Philips ties if relevant');
  }

  // ── FALLBACK TIPS ────────────────────────────────────────────────────
  add(fallbackTips, 'Write a short intro: who you are, why this home, and your move-in date');
  add(fallbackTips, 'Have all documents in one PDF ready — immediate senders get priority');
  add(fallbackTips, 'State your viewing availability: landlords prioritize flexible applicants');

  // ── MERGE: AI + landlord tips first, then financial, then profile/timing/city, then fallback ──
  const tips = [];
  for (const t of landlordTips) {
    if (tips.length >= 5) break;
    tips.push(t);
  }
  for (const t of financialTips) {
    if (tips.length >= 5) break;
    tips.push(t);
  }
  for (const t of [...profileTips, ...timingTips, ...cityTips]) {
    if (tips.length >= 5) break;
    tips.push(t);
  }
  for (const t of fallbackTips) {
    if (tips.length >= 5) break;
    tips.push(t);
  }

  return { tips: tips.slice(0, 5) };
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
    patterns: [/professional/i, /werkende/i, /werkend\b/i, /working professional/i, /professional couple/i, /professional tenant/i, /vast dienstverband/i],
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
    patterns: [/quiet/i, /rustig/i, /respectful/i, /well-maintained/i, /no noise/i, /geen overlast/i, /geen feestjes/i, /geen muziek/i, /geen geluidsoverlast/i],
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
  no_students: {
    patterns: [/geen studenten/i, /no students/i, /niet voor studenten/i, /studenten niet/i, /not for students/i],
    label: 'No students — listing explicitly excludes students',
    tip: null,
    boost: 0,
    warning: true,
  },
  no_couples: {
    patterns: [/geen koppel/i, /geen koppels/i, /no couples/i, /geen stel\b/i, /geen stellen/i],
    label: 'No couples — landlord prefers single occupant',
    tip: null,
    boost: 0,
    warning: true,
  },
  family_only: {
    patterns: [/uitsluitend.*gezin/i, /alleen.*gezin/i, /enkel.*gezin/i, /family only/i, /voor gezinnen\b/i, /alleen voor gezinnen/i],
    label: 'Families only — landlord targets families with children',
    tip: null,
    boost: 0,
    warning: true,
  },
  working_only: {
    patterns: [/geen uitkeringsgerechtigden/i, /werkende woningdelers/i, /only working professionals/i, /working professionals only/i],
    label: 'Working professionals only',
    tip: 'This landlord specifically targets working professionals — lead with your job title and employer',
    boost: 10,
  },
  expat_with_family: {
    patterns: [/expats met gezin/i, /expats \(met een gezin\)/i, /expats with family/i],
    label: 'Expats with families preferred',
    tip: 'Expats with families are the target group — if applicable, mention your family situation and relocation',
    boost: 8,
  },
  income_requirement: {
    patterns: [/\d+x\s*(de\s*)?(maand)?huur/i, /\d+\s*times.*rent/i, /\d+x\s*(?:monthly\s*)?rent/i, /inkomenseis\b/i, /inkomensnorm\b/i],
    label: 'Income requirement mentioned',
    computeTip: (description) => {
      const m = description.match(/(\d+)[xX]\s*(?:de\s*)?(?:maand)?huur/i)
             || description.match(/(\d+)\s*times.*rent/i)
             || description.match(/(\d+)[xX]\s*(?:monthly\s*)?rent/i);
      const mult = m ? parseInt(m[1]) : null;
      return mult
        ? `Landlord requires ${mult}x monthly rent — confirm your income meets this before applying`
        : 'Income requirement mentioned — confirm your income meets it before applying';
    },
    boost: 8,
  },
  tidy_tenant: {
    patterns: [/nette huurder/i, /nette bewoner/i, /\bverzorgd\b/i, /\bnetjes\b/i],
    label: 'Tidy, well-presented tenant preferred',
    tip: 'Landlord values a tidy tenant — mention you keep your home in excellent condition',
    boost: 5,
  },
  couple_ok: {
    patterns: [/voor (een )?(stel|koppel)/i, /(stel|koppel) welkom/i, /twee personen/i, /2[\s-]persoons/i, /geschikt voor.*koppel/i],
    label: 'Suitable for a couple',
    tip: 'Property is suited for a couple — if applying as two, mention this upfront',
    boost: 4,
  },
  single_ok: {
    patterns: [/alleenstaand/i, /voor één persoon/i, /voor 1 persoon/i, /1[\s-]persoonshuishouden/i],
    label: 'Single occupant preferred',
    tip: 'Single occupant preferred — if you live alone, state this clearly in your application',
    boost: 5,
  },
  registration_ok: {
    patterns: [/\binschrijving\b/i, /\binschrijven\b/i, /\bBRP\b/, /gemeentelijke\b/i, /inschrijf/i],
    label: 'Address registration available',
    tip: 'Address registration is available — mention that you need to register at this address',
    boost: 6,
  },
  furnished_tip: {
    patterns: [/gemeubileerd/i, /gestoffeerd/i, /\bfurnished\b/i, /inclusief meubels/i],
    label: 'Property is furnished or decorated',
    tip: 'Property is furnished/decorated — mention you appreciate a move-in ready home and will care for the furnishings',
    boost: 3,
  },
  outdoor_space: {
    patterns: [/\btuin\b/i, /\bbalkon\b/i, /\bdakterras\b/i, /\bterras\b/i],
    label: 'Property has outdoor space',
    tip: 'Property has outdoor space — mention how you would use and maintain it',
    boost: 3,
  },
  pets_welcome: {
    patterns: [/huisdierenvriendelijk/i, /huisdieren welkom/i, /pets welcome/i, /pets allowed/i, /huisdieren toegestaan/i, /huisdieren zijn welkom/i],
    label: 'Pets welcome',
    tip: 'Pets are welcome — if you have pets, mention them positively in your application',
    boost: 4,
  },
  min_rental_period: {
    patterns: [/minimaal\s+\d+\s*jaar/i, /minimale huurperiode/i, /minimum rental period/i, /minimum.*\d+\s*year/i],
    label: 'Minimum rental period required',
    computeTip: (description) => {
      const m = description.match(/minimaal\s+(\d+)\s*jaar/i)
             || description.match(/minimum.*?(\d+)\s*year/i);
      const years = m ? parseInt(m[1]) : null;
      return years
        ? `Minimum ${years}-year rental period — state clearly that you plan to stay at least ${years} years`
        : 'Minimum rental period required — state clearly how long you plan to stay';
    },
    boost: 7,
  },
  students_welcome: {
    patterns: [/studenten welkom/i, /students welcome/i, /studentenwoning/i, /studentenhuis/i, /geschikt voor studenten/i],
    label: 'Students welcome',
    tip: 'Students are welcome — mention your institution, program, and expected graduation date',
    boost: 5,
  },
  deposit_mentioned: {
    patterns: [/\bborg\b/i, /waarborgsom/i, /\bdeposit\b/i, /\bborgtocht\b/i, /\bkaution\b/i, /borg van/i, /borg bedraagt/i],
    label: 'Security deposit required',
    computeTip: (description) => {
      const m = description.match(/(?:borg(?:som|tocht)?|deposit|waarborgsom)[^€\d]*(?:€\s*)?([\d.,]+)/i);
      const amount = m ? parseFloat(m[1].replace(',', '.')) : null;
      return amount && amount > 100
        ? `Deposit of €${Math.round(amount)} required — have this ready before your viewing`
        : 'Security deposit required — confirm the amount and have it ready before applying';
    },
    boost: 5,
  },
  no_dss: {
    patterns: [/geen uitkering/i, /geen bijstand/i, /geen bijstandsuitkering/i, /no benefits/i, /no dss/i, /geen\s+ww\b/i, /geen werkloosheidsuitkering/i, /working income only/i],
    label: 'No benefits — landlord requires earned income',
    tip: null,
    boost: 0,
    warning: true,
  },
  per_direct: {
    patterns: [/per direct/i, /direct beschikbaar/i, /immediately available/i, /available immediately/i, /vanaf nu beschikbaar/i, /\bnu beschikbaar\b/i, /asap/i],
    label: 'Available immediately',
    tip: 'Property is available now — state your earliest possible move-in date in your first message',
    boost: 7,
  },
  viewing_appointment: {
    patterns: [/bezichtiging op afspraak/i, /viewing by appointment/i, /viewing on request/i, /viewing on appointment/i, /\bop afspraak\b/i, /bezichtiging aanvragen/i, /maak een afspraak/i],
    label: 'Viewing by appointment only',
    tip: 'Viewing is by appointment — explicitly request a viewing slot in your very first message',
    boost: 5,
  },
  service_costs_incl: {
    patterns: [/inclusief servicekosten/i, /servicekosten\s*(?:zijn\s*)?inbegrepen/i, /\ball.in\b/i, /utilities included/i, /stookkosten inbegrepen/i, /incl\.\s*servicekosten/i, /inclusief\s+gas\s*(?:en\s*)?elektra/i],
    label: 'Service costs or utilities included',
    tip: 'Service costs or utilities are included — verify exactly what is covered to understand your true monthly cost',
    boost: 4,
  },
  service_costs_excl: {
    patterns: [/exclusief servicekosten/i, /excl\.\s*servicekosten/i, /service costs excluded/i, /\+\s*servicekosten/i, /servicekosten niet inbegrepen/i],
    label: 'Service costs on top of listed rent',
    computeTip: (description) => {
      const m = description.match(/servicekosten[^€\d]*(?:€\s*)?([\d.,]+)/i);
      const amount = m ? parseFloat(m[1].replace(',', '.')) : null;
      return amount && amount > 10
        ? `Service costs of €${Math.round(amount)}/mo are NOT in the listed rent — factor this into your budget`
        : 'Service costs are on top of listed rent — ask for the exact amount to budget correctly';
    },
    boost: 3,
  },
  energy_label_ab: {
    patterns: [/\benergielabel\s*[ab]\b/i, /\benergy\s*label\s*[ab]\b/i, /\blabel\s*[ab]\b/i, /\benergieklasse\s*[ab]\b/i, /\benergiezuinig\b/i],
    label: 'Good energy rating (A or B)',
    tip: 'Property has an A or B energy label — mention your appreciation for the low energy costs in your application',
    boost: 3,
  },
  brp_required: {
    patterns: [/\binschrijving\s*(?:bij\s*)?(?:de\s*)?gemeente\s*(?:is\s*)?(?:niet\s*)?(?:mogelijk|toegestaan)/i, /\bBRP\s*(?:inschrijving)?\s*(?:is\s*)?(?:niet\s*)?(?:mogelijk|toegestaan)/i, /geen\s*inschrijving/i, /\bnot\s*possible\s*to\s*register\b/i, /gemeente\s*niet\s*mogelijk/i],
    label: 'Address registration not allowed',
    tip: null,
    boost: 0,
    warning: true,
  },
  young_professional: {
    patterns: [/young professional/i, /young professionals/i, /starter/i, /starters/i],
    label: 'Aimed at young professionals or starters',
    tip: 'Property targets young professionals — emphasise your career trajectory and commitment to the city',
    boost: 5,
  },
  no_subletting: {
    patterns: [/niet onderhuren/i, /no subletting/i, /no sublet/i, /onderhuur niet toegestaan/i, /no airbnb/i, /no short.term rental/i],
    label: 'No subletting allowed',
    tip: null,
    boost: 0,
    warning: true,
  },
  good_maintenance: {
    patterns: [/\bnetjes\s*achterlaten\b/i, /goed onderhoud/i, /goed onderhouden/i, /goed verzorgd/i, /\bverzorgd achterlaten\b/i, /maintain.*(?:clean|good)/i, /in\s*goede\s*staat\b/i],
    label: 'Landlord expects property to be kept in good condition',
    tip: 'Landlord values careful maintenance — mention your track record of keeping properties in excellent condition',
    boost: 4,
  },
  availability_date: {
    patterns: [/beschikbaar\s*(?:per|vanaf|op)\s*\d{1,2}[\s-]\w+/i, /available\s*(?:from|as of)\s*\d{1,2}/i, /\bper\s+\d{1,2}\s+(?:jan|feb|mrt|mar|apr|mei|may|jun|jul|aug|sep|okt|oct|nov|dec)/i, /\bfrom\s+\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i],
    label: 'Specific availability date mentioned',
    computeTip: (description) => {
      const m = description.match(/(?:beschikbaar\s*(?:per|vanaf|op)|available\s*(?:from|as of))\s*(\d{1,2}[\s-]\w+\s*\d{0,4})/i);
      const date = m ? m[1].trim() : null;
      return date
        ? `Property available from ${date} — mention your move-in flexibility around this date`
        : 'Specific availability date mentioned — confirm your move-in timing aligns with it';
    },
    boost: 5,
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
        if (tip) tips.push({ tip, boost: signal.boost, source: 'landlord' });
      } else if (signal.tip) {
        tips.push({ tip: signal.tip, boost: signal.boost, source: 'landlord' });
      }
    }
  }

  return { signals, tips, warnings };
}

module.exports = { calculateScore, scoreLabel, strengthLabel, getImprovementTips, getPillarBreakdown, detectLandlordIntent };
