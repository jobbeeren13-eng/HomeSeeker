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
  const result = Math.round(weighted) + bonus;
  return isNaN(result) ? 0 : Math.min(100, Math.max(0, result));
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

function getImprovementTips(listing, user, _currentScore, dealScore) {
  const price = listing.priceNumber || 0;
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);
  const desc = (listing.description || '').toLowerCase();
  const source = (listing.source || '').toLowerCase();

  const DEDUP_PHRASES = [
    'permanent contract', 'annual income', 'income too low', 'income is',
    'guarantor', 'energy label', 'funda', 'new listing', 'call the ag', 'documents',
  ];

  function sharesKeyPhrase(a, b) {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    return DEDUP_PHRASES.some(p => al.includes(p) && bl.includes(p));
  }

  function sharesFiveWords(a, b) {
    const wa = a.toLowerCase().split(/\s+/);
    const bl = b.toLowerCase();
    for (let i = 0; i <= wa.length - 5; i++) {
      if (bl.includes(wa.slice(i, i + 5).join(' '))) return true;
    }
    return false;
  }

  function semanticDedup(arr) {
    const out = [];
    for (const candidate of arr) {
      let dominated = false;
      const toRemove = [];
      for (let i = 0; i < out.length; i++) {
        if (sharesKeyPhrase(candidate.tip, out[i].tip) || sharesFiveWords(candidate.tip, out[i].tip)) {
          if (candidate.tip.length > out[i].tip.length) {
            toRemove.push(i);
          } else {
            dominated = true;
            break;
          }
        }
      }
      if (!dominated) {
        for (let i = toRemove.length - 1; i >= 0; i--) out.splice(toRemove[i], 1);
        out.push(candidate);
      }
    }
    return out;
  }

  const organicTips = [];

  // ── FINANCIAL ───────────────────────────────────────────────────────────
  if (inkomen > 0 && price > 0) {
    const ratio = inkomen / price;
    if (ratio >= 4) {
      organicTips.push({ tip: `Your income is ${ratio.toFixed(1)}x the rent. Say it in your first sentence.`, category: 'financial' });
    } else if (ratio >= 3.3) {
      organicTips.push({ tip: `You meet the 3x rule. Start with your annual income of ${fmtEuro(inkomen * 12)}.`, category: 'financial' });
    } else if (ratio >= 3.0) {
      organicTips.push({ tip: `Income is ${ratio.toFixed(1)}x rent — borderline. Offer an extra bank statement.`, category: 'financial' });
    } else {
      organicTips.push({ tip: `Income too low for 3x rule. Offer a guarantor or 3 months deposit.`, category: 'guarantor' });
    }
    if (dealScore != null && dealScore < 30) {
      const contractLabel = (user.contract_type === 'vast' || user.contract_type === 'permanent') ? 'permanent contract' : 'stable income';
      organicTips.push({ tip: `Above-market rent. Your ${contractLabel} is a strong point. Say it first.`, category: 'financial' });
    }
  }

  // ── CONTRACT ─────────────────────────────────────────────────────────────
  const ct = (user.contract_type || '').toLowerCase();
  if (ct === 'vast' || ct === 'permanent') {
    organicTips.push({ tip: `You have a permanent contract. Say it in your first sentence.`, category: 'contract' });
  } else if (ct === 'tijdelijk' || ct === 'temporary') {
    organicTips.push({ tip: `Temporary contract looks risky. Offer 3 months deposit or extra bank statements.`, category: 'contract' });
  } else if (ct === 'zzp' || ct === 'freelance') {
    organicTips.push({ tip: `Freelancer: offer 3 months deposit and 2 years of tax returns.`, category: 'contract' });
  }

  // ── PROFILE / COMPETITION ─────────────────────────────────────────────────
  if (/expat|international|english only|relocation/.test(desc)) {
    organicTips.push({ tip: `Expat-friendly listing. Write in English and name your employer.`, category: 'profile' });
  } else if (/working professional|young professional|werkend professional/.test(desc)) {
    organicTips.push({ tip: `Targets working professionals. Start with your job title and employer.`, category: 'profile' });
  }

  if (source === 'funda') {
    organicTips.push({ tip: `Apply fast and call the agent after sending. Funda fills quickly.`, category: 'source_action' });
  } else if (source === 'housinganywhere') {
    organicTips.push({ tip: `Write in English and Dutch. Bilingual applicants stand out on HousingAnywhere.`, category: 'source_action' });
  } else if (source === 'kamernet') {
    organicTips.push({ tip: `Kamernet landlords like personal messages. Skip templates and write directly.`, category: 'source_action' });
  }

  // ── TIMING ──────────────────────────────────────────────────────────────
  if (listing.listedAt) {
    const ageMs = Date.now() - new Date(listing.listedAt).getTime();
    if (!isNaN(ageMs) && ageMs >= 0) {
      const ageMins = ageMs / 60000;
      if (ageMins < 30) {
        organicTips.push({ tip: `New listing. Apply now before the shortlist fills.`, category: 'timing' });
      } else if (ageMins < 120) {
        organicTips.push({ tip: `You are among the first to see this. Apply and call today.`, category: 'timing' });
      } else if (ageMins < 1440) {
        organicTips.push({ tip: `Competition is building. Call the agency after you send your application.`, category: 'timing' });
      } else if (ageMins < 14 * 24 * 60) {
        organicTips.push({ tip: `Listing has been up a while. Offer to sign quickly.`, category: 'timing' });
      } else {
        organicTips.push({ tip: `On market longer than average. Negotiate and say you can sign now.`, category: 'timing' });
      }
    }
  }

  // ── PROPERTY ─────────────────────────────────────────────────────────────
  if (/\btuin\b|garden/.test(desc)) {
    organicTips.push({ tip: `Property has a garden. Say you will take care of it.`, category: 'property' });
  }
  if (/parkeerplaats|parking|garage/.test(desc)) {
    organicTips.push({ tip: `Parking available. Say clearly if you need the spot.`, category: 'property' });
  }
  if (/geen huisdieren|no pets|no animals/.test(desc)) {
    organicTips.push({ tip: `No pets allowed. Confirm you have no pets in your first message.`, category: 'property' });
  }

  const energyLbl = (listing.energyLabel || listing.energy_label || '').toUpperCase().trim();
  if (/^[AB]/.test(energyLbl)) {
    organicTips.push({ tip: `Energy label ${energyLbl} saves €80-120/mo. Mention this in your letter.`, category: 'energy' });
  } else if (/^[DEFG]/.test(energyLbl)) {
    organicTips.push({ tip: `Energy label ${energyLbl} means higher bills. Budget €150-200/mo extra and negotiate on price.`, category: 'energy' });
  }

  if (/gemeubileerd|fully furnished|furnished/.test(desc)) {
    organicTips.push({ tip: `Furnished listing. Ask for an inventory list before signing.`, category: 'property' });
  }
  if (/inschrijving|gemeentelijke registratie|brp registratie/.test(desc)) {
    organicTips.push({ tip: `Address registration possible here. Confirm this in your letter.`, category: 'property' });
  }

  // ── DOCUMENTS ────────────────────────────────────────────────────────────
  if (user.application_readiness === 'niet') {
    organicTips.push({ tip: `No documents yet. Collect ID, payslips, and bank statements today.`, category: 'documents' });
  } else if (user.application_readiness === 'bezig' || user.application_readiness === 'bijna') {
    organicTips.push({ tip: `Finish your documents today. Say you can send them within the hour.`, category: 'documents' });
  } else if (user.application_readiness === 'klaar') {
    organicTips.push({ tip: `Documents ready. Say you can send everything within the hour.`, category: 'documents' });
  }

  // ── SEMANTIC + WORD-OVERLAP DEDUP ────────────────────────────────────────
  const dedupedTips = semanticDedup(organicTips);

  // ── FALLBACK PADDING ─────────────────────────────────────────────────────
  const FALLBACK = [
    { tip: 'Call the agent after applying. A brief call triples callback rate.', category: 'general' },
    { tip: 'Apply between 8am and 10am. Landlords check email early and respond faster.', category: 'timing' },
    { tip: "Use the landlord's name if you know it. It gets more responses.", category: 'general' },
    { tip: 'Say how long you want to stay. It removes doubt about your plans.', category: 'general' },
    { tip: 'Offer a video call if you cannot view in person right away.', category: 'general' },
    { tip: 'Moving to this city? Say why. Landlords like to know your reason.', category: 'profile' },
  ];

  for (const f of FALLBACK) {
    if (dedupedTips.length >= 5) break;
    const conflicts = dedupedTips.some(t =>
      sharesKeyPhrase(f.tip, t.tip) || sharesFiveWords(f.tip, t.tip)
    );
    if (!conflicts) dedupedTips.push(f);
  }

  return { tips: dedupedTips.slice(0, 5) };
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

module.exports = { calculateScore, scoreLabel, strengthLabel, getImprovementTips, getPillarBreakdown, detectLandlordIntent };
