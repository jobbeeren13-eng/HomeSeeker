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

function getImprovementTips(listing, user, _currentScore, _dealScore) {
  const price = listing.priceNumber || 0;
  const inkomen = (user.inkomen || 0) + (user.partner_inkomen || 0);
  const desc = (listing.description || '').toLowerCase();
  const source = (listing.source || '').toLowerCase();
  const listingTips = [];
  const profileTips = [];
  const generalTips = [];

  // ── LAYER 1: LISTING TIPS — description-based signals ────────────

  if (/woningcorporatie|sociale huur|objectcode|inschrijvingsduur|wachtlijst|alliantie|ymere|stadgenoot|eigen haard|de key|rochdale/i.test(desc)) {
    listingTips.push({ tip: "This is a social housing listing — you need a valid objectcode or registration number, not a motivation letter. Find the exact code in the listing and follow the housing corporation's application process directly.", category: 'social_housing' });
  }

  if (/gemeubileerd|furnished|gestoffeerd/i.test(desc)) {
    listingTips.push({ tip: "Confirm exactly what 'furnished' includes before applying — Dutch listings range from a bed to a complete home. Request a written inventory list before you sign anything.", category: 'furnished' });
  }

  if (/short stay|tijdelijk|temporary|expat only|max[^\d]{0,5}\d+\s*maand|maximaal\s*\d+\s*maanden/i.test(desc)) {
    listingTips.push({ tip: 'This listing may be a short-stay or temporary rental. Confirm the minimum and maximum lease length before applying — temporary contracts offer less tenant protection under Dutch law.', category: 'short_stay' });
  }

  if (/makelaar|makelaardij|real estate|NVM|VBO|\bvia\b.*kantoor/i.test(desc)) {
    listingTips.push({ tip: 'This listing is managed by an agency processing dozens of applications. Call them directly after submitting — agents who speak to a candidate are far more likely to book a viewing than with those who only email.', category: 'agency' });
  }

  if (/inschrijving niet mogelijk|geen inschrijving|not possible to register|cannot register/i.test(desc)) {
    listingTips.push({ tip: 'This listing does not allow municipality registration — without it you cannot get a BSN, open a Dutch bank account, or access most services. Confirm whether this is acceptable for your situation before applying.', category: 'no_registration' });
  }

  if (/huisdieren welkom|pets allowed|pets welcome|huisdier toegestaan/i.test(desc)) {
    listingTips.push({ tip: "Mention your pet proactively: include breed, size, and one sentence about behaviour. Landlords who allow pets appreciate transparency — it removes the doubt that costs you the deal.", category: 'pets_welcome' });
  }

  // ── LAYER 2: PROFILE TIPS — user data vs listing ─────────────────

  if (inkomen > 0 && price > 0) {
    const ratio = inkomen / price;
    if (ratio >= 4) {
      profileTips.push({ tip: `Your income is ${ratio.toFixed(1)}x the rent — this is your strongest asset. State your gross annual salary (${fmtEuro(inkomen * 12)}/year) in your first sentence: annual figures sound more substantial than monthly and landlords calculate annually.`, category: 'financial' });
    } else if (ratio >= 3) {
      profileTips.push({ tip: `Your income meets the 3x requirement at ${ratio.toFixed(1)}x — state your gross annual income (${fmtEuro(inkomen * 12)}/year) in your first sentence. Send payslips within the hour of being asked: most landlords decide before they finish reading applications.`, category: 'financial' });
    } else if (ratio >= 2) {
      profileTips.push({ tip: `Your income is ${ratio.toFixed(1)}x the rent, below the standard 3x requirement. Address this directly: offer a guarantor earning above the gap, or propose 3 months deposit upfront.`, category: 'financial' });
    } else {
      profileTips.push({ tip: `Your income covers only ${ratio.toFixed(1)}x the rent, well below the 3x threshold. A guarantor earning ${fmtEuro(price * 3)}/mo is required — do not apply without one or a 3-month deposit offer.`, category: 'financial' });
    }
  }

  const ct = (user.contract_type || '').toLowerCase();
  if (ct === 'vast' || ct === 'permanent') {
    profileTips.push({ tip: "Open your first sentence with your permanent contract: 'I hold a permanent contract at [company] earning €X/year.' Landlords filter by contract type before they finish reading the first paragraph.", category: 'contract' });
  } else if (ct === 'tijdelijk' || ct === 'temporary') {
    profileTips.push({ tip: 'Your temporary contract is a yellow flag for Dutch landlords. Counter it proactively: state when your contract is likely to be extended or renewed, and offer additional deposit security.', category: 'contract' });
  } else if (ct === 'zzp' || ct === 'freelance') {
    profileTips.push({ tip: 'Freelance income requires extra documentation — 3 years of annual accounts and a current assignment confirmation. Prepare these before applying to any listing.', category: 'contract' });
  }

  if (user.application_readiness === 'niet') {
    profileTips.push({ tip: 'Your documents are not prepared — fix this before applying. You need a passport copy, last 3 payslips, employment contract, and 3 months of bank statements: landlords ask for these immediately and unpreparedness kills the deal.', category: 'documents' });
  } else if (user.application_readiness === 'bezig' || user.application_readiness === 'bijna') {
    profileTips.push({ tip: 'Your documents are almost ready — finish them before applying. The moment a landlord asks and you cannot deliver within the hour, you drop behind candidates who can.', category: 'documents' });
  } else if (user.application_readiness === 'klaar') {
    profileTips.push({ tip: `State this in every application: 'All documents are ready — I can send everything within the hour.' This single sentence moves you ahead of every candidate who cannot say the same.`, category: 'documents' });
  }

  if (source === 'funda') {
    profileTips.push({ tip: 'Call the agency within one hour of sending your application. Agents who speak to a candidate book viewings 3x more often — most applicants never call, so you immediately stand out.', category: 'source' });
  } else if (source === 'kamernet') {
    profileTips.push({ tip: 'Kamernet landlords are usually private individuals. A warm, personal message works better than a formal letter — address them by name if it appears in the listing.', category: 'source' });
  } else if (source === 'housinganywhere') {
    profileTips.push({ tip: 'HousingAnywhere listings attract many international applicants. Write your message in English with one Dutch sentence at the end: it signals integration and seriousness.', category: 'source' });
  }

  // ── LAYER 3: GENERAL TIPS — universal best practices ─────────────

  generalTips.push({ tip: 'Send all documents as one PDF named Firstname_Lastname_Application.pdf. Landlords with 50+ applications shortlist candidates who make their job easy — loose files signal disorganisation.', category: 'general_docs' });
  generalTips.push({ tip: "Name two specific days you are available in your first message: 'I am free Tuesday and Thursday this week.' Vague availability loses viewings to candidates who are decisive.", category: 'general_timing' });
  generalTips.push({ tip: 'Add one sentence about why this specific street suits your life — near your work, your gym, your neighbourhood. Landlords can tell when someone actually wants this home versus any available rental.', category: 'general_personal' });

  // ── BACKWARDS COMPAT: flat deduplicated tips array (one per category) ───
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

module.exports = { calculateScore, scoreLabel, strengthLabel, getImprovementTips, getBuyerTips, getPillarBreakdown, detectLandlordIntent };
