const Anthropic = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[letter] ANTHROPIC_API_KEY not set — letter generation will fail');
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STYLE_LABELS = {
  professional: 'Professional: formal business letter, emphasis on income and stability',
  friendly: 'Friendly: warm personal tone with a short story about the tenant',
  expat: 'Expat: English letter explaining the expat situation and 30% ruling if applicable',
};

function formatCity(city) {
  if (!city) return '';
  return city.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Strip markdown and punctuation that doesn't render well in Telegram.
// Preserves paragraph breaks (\n\n) while collapsing inline whitespace.
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/—/g, '-')
    .replace(/ - /g, ' ')
    .replace(/\n{3,}/g, '\n\n')   // normalize 3+ newlines → double newline
    .replace(/[^\S\n]{2,}/g, ' ') // collapse inline spaces (not newlines)
    .trim();
}

// Try primary model, fall back to previous generation if model unavailable
async function callClaude(params) {
  try {
    return await client.messages.create({ ...params, model: 'claude-sonnet-4-6' });
  } catch (err) {
    const status = err.status || err.statusCode;
    if (status === 404 || status === 400) {
      console.warn('[letter] claude-sonnet-4-6 unavailable (status=%s), retrying with claude-sonnet-4-5', status);
      return await client.messages.create({ ...params, model: 'claude-sonnet-4-5' });
    }
    throw err;
  }
}

async function generateLetter({ style, listing, user, answers }) {
  const [situation, work, extra] = answers;
  const tone = STYLE_LABELS[style] || STYLE_LABELS.professional;

  const address = listing.address || 'the property';
  const city = formatCity(listing.city);
  const price = listing.price || (listing.priceNumber ? `€${listing.priceNumber}` : 'unknown');
  const source = listing.source || 'unknown platform';

  const naam = user?.naam || 'Applicant';
  const profiel = user?.profiel_type || 'individual';
  const inkomen = user?.inkomen ? `€${user.inkomen}` : 'not provided';
  const contract = user?.contract_type || 'not provided';
  const expatNote = style === 'expat' && user?.expat_status
    ? `Expat status: ${user.expat_status}`
    : '';

  const systemPrompt = `You are an expert at writing English rental motivation letters.
Write a professional, personal motivation letter for a rental property.

Style: ${tone}
Property: ${address}, ${city}, ${price}
Platform: ${source}

Applicant info:
- Name: ${naam}
- Profile: ${profiel}
- Income: ${inkomen}/month
- Contract: ${contract}
${expatNote ? `- ${expatNote}` : ''}
- Situation: ${situation || '—'}
- Work: ${work || '—'}
- Extra: ${extra || '—'}

Rules:
- Max 200 words
- No clichés
- End with a concrete request for a viewing
- Never mention the letter was AI-generated`;

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 700,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: 'Write the motivation letter. Return only the letter text, no explanation or metadata.',
    }],
  });

  return stripMarkdown(message.content[0].text);
}

async function generateLetterDirect({ listing, user, selectedTips = [], selectedTipTexts = [], extraContext = '', cacheId = null, tone = 'professional' }) {
  const allTips = [...selectedTips, ...selectedTipTexts].filter(Boolean);

  const rawNaam = (user?.naam || '').trim();
  const noName = !rawNaam || rawNaam.toLowerCase() === 'huurder';
  const naam = noName ? '' : rawNaam;
  const firstName = noName ? '' : naam.split(' ')[0];

  const inkomen = user?.inkomen || 0;
  const partnerInkomen = user?.partner_inkomen || 0;
  const totalInkomen = inkomen + partnerInkomen;
  const contract_type = user?.contract_type || 'professional';
  const profiel_type = user?.profiel_type || 'professional';
  const address = listing.address || 'the property';
  const city = formatCity(listing.city);
  const price = listing.priceNumber || listing.price || 'unknown';
  const description = (listing.description || '').trim();
  const annualIncome = totalInkomen * 12;
  const incomeRatio = (totalInkomen > 0 && listing.priceNumber) ? (totalInkomen / listing.priceNumber).toFixed(1) : null;

  const user_description = (user?.user_description || '').trim();
  const move_reason = (user?.move_reason || '').trim();

  const wordLimit = tone === 'concise' ? 80 : 160;

  const conciseNote = tone === 'concise' ? '\nCONCISE mode: maximum 80 words. Merge sentences 2 and 3 into one.' : '';
  const personalNote = tone === 'personal' ? '\nPERSONAL mode: warmer opener, one brief genuine personal detail in sentence 3.' : '';

  const systemPrompt = `You write short English rental motivation letters for the Dutch market. Landlords read 100 letters per day and identify generic AI text from the first sentence. Your job is to write a letter that reads like a specific, confident professional wrote it quickly from their desk.

STRUCTURE — four sentences in this exact order, no extra paragraphs:

SENTENCE 1 — The specific hook (most important sentence):
Extract ONE concrete specific detail from the listing description. Open with it from the applicant's perspective. This proves the applicant actually read this listing, not a mass-copy template.

By listing signal:
- South-facing / sunny / zonnig / south balcony: "The south-facing living room caught my attention immediately — working from home three days a week, natural light is not a luxury, it is a condition."
- Tuin / garden / private garden: "The private garden at this address is exactly what I have been looking for — I maintain outdoor spaces with genuine care in every home I have lived in."
- Werkende / working professionals preferred / working professional: "As a [job title], I read your preference for working professionals and want to address that directly in the first line."
- Specific neighbourhood feature mentioned: "Living within walking distance of [the feature mentioned] fits my daily routine in a way I rarely find in listings."
- No description or generic: Open with a confident profile statement that establishes credibility immediately: "[Job title], permanent contract, [X]x the rent in income — the relevant facts upfront so you can assess this in 30 seconds."

SENTENCE 2 — Financial credibility with exact numbers:
State income ANNUALLY not monthly (annual sounds more substantial), contract type, income-to-rent ratio, document readiness.
Format: "On a permanent contract earning [annual income] gross annually — [ratio]x the monthly rent — payslips, employer statement, and bank statements are ready to send within the hour."

SENTENCE 3 — Why this specific home:
One sentence referencing something specific from the listing or address. Must sound personal, not generic.

SENTENCE 4 — Availability and decisiveness:
State viewing availability and document readiness as facts, not requests.

FORMAT:
Dear landlord,

[Four sentences as described — no extra paragraphs, no lists]

Kind regards,
${noName ? '[Your name]' : firstName}

ABSOLUTE RULES — failure on any of these is not acceptable:
- NEVER start the letter body with "I" as the first word — this is the single most critical rule
- NEVER use any variation of: "I am writing to express", "I came across your listing", "I would like to apply", "I am very interested", "I recently saw", "My name is X and I", "I am looking for"
- Maximum ${wordLimit} words (count carefully — stay under this limit)
- Never fabricate details not explicitly in the user profile or context — use placeholders [your name] [Tuesday or Wednesday] if unknown
- Never mention employer name unless it appears in user description or extra context
- Never mention guarantor unless explicitly stated in the user profile
- Never use em dashes or exclamation marks
- Never use: perfect fit, ideal candidate, dream home, passionate about, reliable, responsible, delighted, pleased
- No markdown, no bold, no formatting
- English only${conciseNote}${personalNote}`;

  const lines = [];
  lines.push(`Write a rental motivation letter for ${noName ? 'an applicant' : naam}.`);
  lines.push(`Property: ${address}${city ? `, ${city}` : ''}, ${typeof price === 'number' ? `€${price}` : price}/month.`);
  if (description.length > 20) lines.push(`Listing description (scan for specific hook for sentence 1): ${description.slice(0, 350)}`);
  if (totalInkomen > 0) lines.push(`Employment: ${contract_type} contract, ${profiel_type}.`);
  if (inkomen > 0) lines.push(`Monthly income: €${inkomen}${partnerInkomen > 0 ? ` + €${partnerInkomen} partner` : ''}. Annual: €${annualIncome}.${incomeRatio ? ` Income ratio: ${incomeRatio}x the rent.` : ''}`);
  if (user_description) lines.push(`About applicant: ${user_description}`);
  if (move_reason) lines.push(`Move reason: ${move_reason}`);
  if (extraContext) lines.push(`Additional context: ${extraContext}`);
  if (user.heeft_borg === 'ja') lines.push('Guarantor: available if required.');
  else lines.push('Do NOT mention guarantors or co-applicants.');
  if (allTips.length > 0) lines.push(`CONFIRMED POINTS TO INCLUDE — The user has selected these specific points to include. Treat each as a confirmed fact about their situation and weave it naturally into the letter. Do not list them — integrate them as natural sentences. Listing-specific points appear in the first half of the letter; general strengths appear in the second half: ${allTips.slice(0, 6).join(' | ')}`);
  lines.push(`Use the exact 4-sentence structure. Maximum ${wordLimit} words. NEVER start with "I".`);
  if (noName) lines.push('Sign off with "Kind regards," only (no name below).');
  else lines.push(`Sign off with first name only: ${firstName}.`);

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const letter = stripMarkdown(message.content[0].text);
  return { letter };
}

// Generate a single AI-powered application tip for listings with rich descriptions.
// Result is cached in listing_cache for 48h to avoid repeated API calls.
async function getAITip(listing, user) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!listing.description || listing.description.length < 200) return null;

  // v3 prefix invalidates tips containing banned words (reliable, highlight, stability)
  const cacheKey = `aitip3_${listing.fingerprint || listing.url}`;

  // Check persistent DB cache
  try {
    const { getPersistedCacheListing, persistCacheListing } = require('./database');
    const cached = getPersistedCacheListing.get(cacheKey, Date.now());
    if (cached) {
      try { return JSON.parse(cached.listing_json); } catch { return null; }
    }

    const userProfile = [
      user?.contract_type && `contract: ${user.contract_type}`,
      user?.profiel_type && `profile: ${user.profiel_type}`,
      user?.inkomen && `income: €${user.inkomen}/month`,
      user?.met_partner === 'ja' && 'applying with partner',
      user?.contract_type === 'zzp' && 'self-employed',
    ].filter(Boolean).join(', ');

    // User profile data included in prompt - covered under privacy policy section 4
    const msg = await callClaude({
      max_tokens: 80,
      system: 'You advise tenants on rental applications in the Netherlands. Always respond in English only, never Dutch. Give one single actionable tip. Max 12 words. No preamble, no quotes, no dashes. Never use: reliable, highlight, stability, ensure, leverage, demonstrate.',
      messages: [{
        role: 'user',
        content: `Listing description (may be Dutch): "${listing.description.slice(0, 400)}"\nTenant profile: ${userProfile || 'professional'}\nWhat is the ONE most important thing to mention in the application? English only.`,
      }],
    });

    const raw = msg.content[0]?.text || '';
    const tip = stripMarkdown(raw).replace(/^["'`]|["'`]$/g, '').trim();
    if (!tip || tip.length < 10) return null;

    const expiresAt = Date.now() + 48 * 60 * 60 * 1000;
    try { persistCacheListing.run(cacheKey, JSON.stringify(tip), expiresAt, null, null, null); } catch {}

    return tip;
  } catch (err) {
    console.warn('[aitip] Failed:', err.message);
    return null;
  }
}

// Generates a full application package: letter + intro + quickFacts + financialSummary
async function generatePackageDirect({ listing, user = {}, extraContext = '' }) {
  const naam = (user?.naam || '').trim();
  const firstName = naam ? naam.split(' ')[0] : '';
  const inkomen = user?.inkomen || 0;
  const contract_type = user?.contract_type || 'professional';
  const profiel_type = user?.profiel_type || 'professional';
  const address = listing.address || 'the property';
  const city = formatCity(listing.city);
  const price = listing.priceNumber || 0;
  const priceStr = price ? `€${price}` : (listing.price || 'unknown');
  const incomeRatio = (inkomen > 0 && price > 0) ? (inkomen / price).toFixed(1) : null;

  const systemPrompt = `You generate rental application packages for the Dutch housing market. Return a JSON object with exactly these keys:
- "letter": English motivation letter, max 150 words, no markdown, no dashes, 3 paragraphs separated by blank lines
- "intro": 3-sentence personal introduction, first person, max 50 words, copy-paste ready
- "quickFacts": WhatsApp one-liner, max 25 words, format: "Hi, I'm [name/applicant], [job]. I'd love to view [address]. Available [timeframe]."

Return only valid JSON. No explanation, no code blocks.`;

  const lines = [];
  if (naam) lines.push(`Applicant: ${naam}.`);
  if (inkomen > 0) lines.push(`Monthly income: €${inkomen}, ${contract_type} contract, ${profiel_type}.`);
  if (incomeRatio) lines.push(`Income/rent ratio: ${incomeRatio}x.`);
  if (user?.heeft_borg === 'ja') lines.push('Guarantor available if required.');
  lines.push(`Property: ${address}${city ? `, ${city}` : ''}, ${priceStr}/month.`);
  if ((listing.description || '').length > 50) lines.push(`Listing notes: ${listing.description.slice(0, 200)}`);
  if (extraContext) lines.push(`Extra context: ${extraContext}`);
  lines.push('Generate the JSON package.');

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 900,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const raw = message.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in package response');
  const pkg = JSON.parse(jsonMatch[0]);

  const financialSummary = {
    income: inkomen ? `€${inkomen}/month` : null,
    ratio: incomeRatio ? `${incomeRatio}x rent` : null,
    contract: contract_type || null,
    profile: profiel_type || null,
    guarantor: user?.heeft_borg === 'ja' ? 'Available' : null,
    documents: { klaar: 'All ready', bijna: 'Almost ready', bezig: 'In progress', niet: 'Not started' }[user?.application_readiness] || null,
  };

  return {
    letter: pkg.letter ? stripMarkdown(pkg.letter) : '',
    intro: pkg.intro || '',
    quickFacts: pkg.quickFacts || '',
    financialSummary,
  };
}

async function generateBuyerLetterDirect({ houseAddress, houseCity, housePrice, whyLove, situation, offerIntent, extraContext = '' }) {
  const city = houseCity ? formatCity(houseCity) : '';
  const systemPrompt = `You write short English buyer introduction letters for Dutch property purchases. Structure exactly:

Dear selling agent,

[Paragraph 1: Who the buyer is and their situation. 2-3 sentences.]

[Paragraph 2: Why they love this specific property and what resonates with them. 2 sentences.]

[Paragraph 3: Their offer intent and what they want as next step. 2 sentences.]

Kind regards,
[Buyer]

Rules:
- English only
- Separate every paragraph with a blank line
- No dashes, no markdown, no bold text
- Never use: reliable, responsible, delighted, ideal, perfect, pleased, I hope, I would love, I am writing to
- Max 160 words
- Personal and specific to the property mentioned
- Sound like a real person writing, not a template`;

  const lines = [];
  lines.push(`Write a buyer introduction letter for a property at ${houseAddress}${city ? `, ${city}` : ''}.`);
  if (housePrice) lines.push(`Asking price: ${housePrice}.`);
  if (situation) lines.push(`Buyer situation: ${situation}`);
  if (whyLove) lines.push(`Why they want this property: ${whyLove}`);
  if (offerIntent) lines.push(`Offer intent: ${offerIntent}`);
  if (extraContext) lines.push(`Extra context: ${extraContext}`);
  lines.push('Write the letter. Max 160 words. No dashes. English only. Use the exact structure from the system prompt.');

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  return stripMarkdown(message.content[0].text);
}

async function generateBidAdviceDirect({ listingPrice, neighborhood, situation, extraContext = '' }) {
  const systemPrompt = `You are a Dutch real estate expert advising expat buyers on bid strategy. Return a JSON object with exactly these keys:
- "recommendation": one sentence bid strategy (e.g. "Bid 5% above asking price")
- "bidAmount": suggested bid as an integer (euros, no formatting)
- "reasoning": 2-3 sentences explaining the reasoning based on Dutch market conditions
- "conditions": array of strings listing conditions to include (e.g. "financing condition", "building inspection")
- "conditionsToWaive": array of strings listing conditions to consider waiving with brief reason each
- "marketSignal": one of "hot", "warm", "neutral", "cool"
- "marketNote": one sentence about current market dynamics for this type of property

Return only valid JSON. No explanation, no code blocks, no markdown.`;

  const lines = [];
  lines.push(`Property asking price: ${listingPrice}`);
  if (neighborhood) lines.push(`Location/neighborhood: ${neighborhood}`);
  if (situation) lines.push(`Buyer situation: ${situation}`);
  if (extraContext) lines.push(`Additional context: ${extraContext}`);
  lines.push('Generate bid strategy as JSON.');

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 700,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const raw = message.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in bid advice response');
  return JSON.parse(jsonMatch[0]);
}

async function generateLeaseReviewDirect({ leaseText, context = '' }) {
  const systemPrompt = `You are a Dutch tenant law expert helping an expat review a rental lease. Return a JSON object with exactly these keys:
- "summary": 2-3 sentence plain English summary of what the lease covers
- "flags": array of objects with keys "type" ("warning", "ok", or "info") and "text" (explanation in English)
  - "warning": unusual, unfair, or potentially illegal clauses
  - "ok": standard clauses that are fine
  - "info": clauses worth understanding even if normal
  Include 4-8 flags total. Prioritize warnings and important clauses.
- "questions": string with 3-5 specific questions the tenant should ask their landlord, one per line

Return only valid JSON. No explanation, no code blocks, no markdown.`;

  const lines = [];
  lines.push(`Lease text to review:\n${leaseText.slice(0, 3000)}`);
  if (context) lines.push(`Tenant situation: ${context}`);
  lines.push('Review this lease and return the JSON analysis.');

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 1200,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n\n') }],
  });

  const raw = message.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in lease review response');
  return JSON.parse(jsonMatch[0]);
}

async function generateNegotiateDirect({ goal, property = '', situation, extraContext = '' }) {
  const systemPrompt = `You are an expert at negotiating Dutch rental terms on behalf of tenants. Return a JSON object with exactly these keys:
- "strategy": 2-3 sentence overall negotiation strategy for this goal
- "arguments": 3-4 bullet points (as a single string, one point per line starting with "- ") with strong arguments the tenant can use
- "emailScript": a complete, ready-to-send professional email to the landlord or agent. Plain text, no markdown, max 150 words.
- "avoid": 2-3 things to avoid saying or doing in this negotiation, as a single string (one per line starting with "- ")

Return only valid JSON. No explanation, no code blocks, no markdown.`;

  const lines = [];
  lines.push(`Negotiation goal: ${goal}`);
  if (property) lines.push(`Property: ${property}`);
  if (situation) lines.push(`Tenant situation: ${situation}`);
  if (extraContext) lines.push(`Additional context: ${extraContext}`);
  lines.push('Generate the negotiation strategy as JSON.');

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const raw = message.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in negotiate response');
  return JSON.parse(jsonMatch[0]);
}

function buildUserProfile(user) {
  if (!user) return '';
  const parts = [];
  if (user.naam) parts.push(`Name: ${user.naam}`);
  if (user.inkomen) parts.push(`Monthly income: €${user.inkomen}`);
  if (user.partner_inkomen) parts.push(`Partner income: €${user.partner_inkomen}`);
  if (user.contract_type) parts.push(`Contract type: ${user.contract_type}`);
  if (user.profiel_type) parts.push(`Profile: ${user.profiel_type}`);
  if (user.expat_status) parts.push(`Expat status: ${user.expat_status}`);
  if (user.locatie) parts.push(`Target city: ${user.locatie}`);
  if (user.prijs_max) parts.push(`Max budget: €${user.prijs_max}`);
  if (user.application_readiness) parts.push(`Document readiness: ${user.application_readiness}`);
  if (user.met_partner === 'ja') parts.push('Applying with partner: yes');
  if (user.heeft_borg === 'ja') parts.push('Guarantor: available');
  if (user.user_description) parts.push(`About: ${user.user_description}`);
  if (user.move_reason) parts.push(`Move reason: ${user.move_reason}`);
  return parts.length > 0 ? `\n\nUser profile:\n${parts.join('\n')}` : '';
}

function sanitizeResponse(text) {
  return text.replace(/—/g, '-').replace(/\n{3,}/g, '\n\n').trim();
}

async function generateRentAssistantResponse({ tab, userMessage, user = null, listingContext = '' }) {
  const userProfile = buildUserProfile(user);
  const tabNum = parseInt(tab) || 1;

  const systems = {
    2: `You are a Dutch rental application strategist who has helped over 2000 expats win rental applications in the Netherlands. You are brutally honest, specific, and structured. An expat who just received an alert needs to act in the next hour — your job is to make that possible in under 5 minutes of reading.

Your response MUST follow this exact structure with these exact section headings. No deviations. No additional sections.

## Send this now
Write the complete, copy-paste first message to send to the landlord or agent. Maximum 4 sentences. This appears FIRST before any analysis — it is what the user does in the next 5 minutes. Rules: sentence 1 = job title, employer (if known), annual income (not monthly), contract type; sentence 2 = one specific detail from the listing showing you read it; sentence 3 = document readiness and move-in flexibility; sentence 4 = request a viewing. Include placeholders in [brackets] for unknown fields. Never start with "I am writing". Never use passive voice.

## Your honest chances
2-3 sentences maximum. State the single strongest asset and the single biggest risk. Be direct — no hedging. If income is below 3x say so. If the listing has been up 3+ weeks say that is actually leverage. Use real numbers.

## Documents to send — in this exact order
Numbered list, maximum 6 items. Each item: what it is and one sentence on how to present it. End with: "Combine into one PDF named Firstname_Lastname_Application.pdf."

## Do this in the next 60 minutes
Maximum 3 numbered actions. These are the time-critical steps that determine whether they get a viewing. Not generic advice — specific actions for this listing and this profile.

## Watch for
Only include if there are genuine red flags. Maximum 2 items. If no red flags, OMIT THIS SECTION ENTIRELY.

CONTEXT you must always apply:
- Dutch rental market 2025: 1 in 15-25 applications leads to a viewing in Amsterdam. 1 in 8-12 elsewhere.
- The first hour after a listing goes live is critical — shortlists form within 2-4 hours on Funda
- Calling the agency after submitting increases viewing chances by 3x — most applicants never call
- Applications sent 8-10am on weekdays get read first
- Landlords read the first two sentences and decide — everything else is secondary
- A permanent Dutch contract (vast contract) is the single strongest signal — lead with it always
- Income stated annually sounds more substantial than monthly — always convert to annual
- Standard requirement: 3x monthly rent gross. Private landlords often want 3.5x or 4x.${userProfile}`,

    3: `You are an expert Dutch rental viewing coach who has personally helped 1000+ expats win rental offers. You know exactly what landlords notice, what questions reveal hidden problems, and what behaviours close deals. Your advice is always specific — never generic. Every section is mandatory.

## What this listing signals
2 sentences. Based on platform, price, description, and any listing age signals — what type of landlord is this, and what are they actually filtering for in a tenant?

## Your 10 questions — ask these in order
Exactly 10 questions. Numbered 1-10. Every question MUST include a reason in [brackets] explaining exactly what the answer reveals.

Always include these (adapted to the listing specifics):
1. "Why is the current tenant leaving?" [The answer reveals hidden problems the listing never mentions — landlords giving vague answers are concealing something]
2. "How many viewings have you scheduled, and when do you expect to make a decision?" [Tells you the competition level and whether you need to act immediately]
3. "Is registration at this address possible for municipality purposes (inschrijven bij de gemeente)?" [Non-negotiable for expats — some landlords refuse this to avoid tax obligations, which is illegal]
4. "What is the exact monthly cost for heating — is this stadsverwarming or a private boiler, and what did the previous tenant pay per month?" [Cost difference of €100-250/month invisible in the listed rent price]
5. "Can you provide an itemised breakdown of what the service costs cover?" [You have a legal right to this — inflated service costs are a common overcharge the Huurcommissie can reverse]
6. "What maintenance has been done in the last 2 years, and is there anything planned in the next year?" [Reveals whether you are inheriting a maintenance backlog]
7. "What is your preference for lease length?" [Shows you are thinking about stability — what landlords actually want]
8. "Has anyone else applied or been offered the property?" [Reveals your actual competitive position — do not accept a vague answer]
9. "What matters most to you in a long-term tenant?" [Their answer tells you exactly how to position yourself for the rest of the conversation]
10. "If I want to proceed, what are the exact next steps?" [Signals decisiveness and tells you whether they are serious]

Add listing-specific questions (choose only those triggered by the description):
- If VvE mentioned: "What is the current VvE reserve fund balance, and is there a signed multi-year maintenance plan?" [A VvE without a reserve fund means surprise levies — this is your risk]
- If stadsverwarming mentioned: "What has the stadsverwarming invoice averaged per month over the last 12 months?" [Stadsverwarming ranges from €80 to €280/month and is not visible in the listing price]
- If listing over 3 weeks old: "I noticed this listing has been available for a few weeks — could you help me understand if previous applications did not proceed?" [The answer reveals leverage and structural problems]
- If ground floor: "Has there been any history of damp or moisture issues, and when was dampproofing last inspected?" [Ground floor is highest risk — damp problems cost deposits and health]
- If top floor: "Has the roof been inspected recently, and when was roof insulation last replaced?" [Top floor apartments show roof problems first — inside your ceiling]
- If furnished: "Can I see the full inventory list of exactly what is included, and what condition is each item documented in?" [Vague inventories are used to charge deposit deductions for missing items]
- If energy label D or below: "What has the average monthly combined energy bill been over the last 12 months?" [Energy label E/F/G can add €200-400/month to real cost of living]
- If older building or private landlord: "Is there a professional property manager for maintenance, or do repairs go directly through you?" [The difference between 24-hour repair response and a 3-week wait]

## What to inspect physically — room by room
Specific items with what to photograph and why. Mention filename format: [Room]_[Item]_[Date].jpg

Always include:
- Damp behind radiators and under windows: look for paint discoloration and staining at skirting boards — photograph every mark. Primary deposit protection evidence.
- Water pressure: run the shower and all taps simultaneously — if pressure drops, there is a pipe or boiler problem not disclosed.
- Window frames and seals: press around the edge of every frame — flex means cold air ingress and high heating costs.
- Extractor fans: run kitchen and bathroom fans, hold paper near them — the paper should be pulled in. If it falls, the motor is failing.
- Floor condition: check near all walls for unevenness, water stains, or soft spots — photograph any.
- All electrical sockets: test every socket — non-functioning sockets documented now cannot be deducted from your deposit later.

Add based on building type and age:
- Pre-1970 building: check walls for settlement cracks (photograph anything wider than 2mm) and floors for unevenness.
- Apartment with upper neighbours: stand still in each room and listen — poor floor insulation is common and impossible to fix after moving in.
- Ground floor: check corners, under the kitchen sink, and inside built-in wardrobes for damp smell.
- Top floor: check ceiling at the perimeter and around any skylights — roof leaks appear at the edges first and are often painted over.

## How to stand out — 5 specific behaviours
Not generic advice. Specific behaviours that change a landlord's actual decision:

1. Arrive 3-5 minutes early — not on time, not 10 minutes early. Dutch culture treats punctuality as the primary reliability signal. Late is disqualifying. Very early is presumptuous. 3-5 minutes is the professional window.
2. Bring a physical document folder — have it visible but do not offer it unless asked. The signal is "I am prepared" not "I am desperate." Landlords notice this immediately.
3. Before talking about yourself, ask: "What matters most to you in a long-term tenant?" Their answer is the exact brief for how to position the rest of your conversation.
4. Mention one genuinely specific thing about this property — not generic enthusiasm. "The ceiling height in the living room is unusual at this price point" beats "it is beautiful." Specificity signals genuine interest, not desperation.
5. Close clearly at the end: "What is your process from here, and is there anything you need from me before making your decision?" Decisive and professional — most applicants leave without asking this.

## Red flags to watch for
Specific to this property type and listing — include only genuine red flags:
- Landlord gives vague or evasive answers to direct financial questions (service costs, heating costs, why previous tenant left)
- "We will be in touch" with no specific timeline means you are not currently the favourite
- Fresh paint only in certain areas at skirting board height — classic sign of damp painted over for the viewing
- Landlord discourages photographing anything — this is not normal and is a red flag
- If the neighbourhood is audible during the viewing, it will be worse when the building is otherwise quiet
- VvE documents "not available yet" means the VvE is either inactive or the documents show problems

## Send this within 2 hours of your viewing
Complete ready-to-copy follow-up message. Maximum 60 words. References one specific thing from the viewing. Warm but not desperate. Ends with document readiness confirmation and a clear next step request.${userProfile}`,

    4: `You are an expert at Dutch rental negotiation who gives expats honest market assessments before any scripts. The Dutch housing market in 2025 is highly competitive in cities — bad negotiation advice costs people apartments. Honesty always comes before scripts.

Your response MUST start with the market assessment before any tactics or scripts:

## Is negotiating realistic here?
This is always the first section. Be direct and honest. Apply this logic based on what the user describes:

Amsterdam Centrum, Oud-West, De Pijp, Amsterdam Zuid, any Amsterdam listing under 3 weeks online at or below market price: "Negotiating rent here will almost certainly cost you this apartment. The landlord has 30-60 other applications and will simply move to the next candidate. Win the application first — only negotiate after you have been formally offered the tenancy. Focus everything on being the strongest candidate, not the cheapest ask."

Amsterdam listing over 3 weeks online, or priced visibly above market: "There is real room here. A listing this old in Amsterdam means the landlord has not found the right tenant or had a previous deal fall through. You have leverage. Use it carefully — one ask, framed correctly, with something offered in return."

Rotterdam, Utrecht, Den Haag, Haarlem listings under 2 weeks online: "Negotiating is realistic in this market but timing matters. Do not raise it before or during the viewing — only after the landlord has indicated they want to proceed with you. Then one careful, well-framed ask."

Rotterdam, Utrecht, Den Haag 2+ weeks online, or Eindhoven, Groningen, Maastricht, smaller cities: "Real negotiation room exists here. A listing this old in this market means the landlord needs the right tenant more than they need the full asking price. One well-framed ask has a realistic chance."

Any listing over 30 days online: "This listing has been on the market for over a month. Something has prevented it renting. You have significant leverage — but find out the reason first before making your move. Ask directly: 'I noticed this listing has been available for a while — is there anything I should know?'"

ONLY AFTER the market assessment, provide what is relevant to the stated goal:

For LOWER RENT goal:

## What to say — word for word
Natural English, under 60 words. Framed as a question, not a demand. Offers something concrete in return:
"I am very interested and ready to proceed. Given [specific reason: listing age / pricing vs market / situation], I would like to discuss whether [specific lower figure] per month is possible. In return, I am happy to commit to a [longer] lease term and can sign this week. Would that work for you?"

## What NOT to say — and why
3 specific phrases that kill Dutch rent negotiations:
1. "I found a similar apartment for less" — landlords take price comparisons personally and it ends the conversation immediately.
2. Any number before expressing clear interest — sequence matters. Express genuine interest first, then and only then open on price.
3. Multiple asks at once — one ask, your highest priority. Stacking requests signals problem tenant before you even sign.

## If they say no to lower rent — negotiate these instead (in this order)
1. Longer lease period (2 years): frame as stability and guaranteed income for the landlord, not a concession from you
2. Furnishings or white goods included rather than rent reduction
3. Landlord covers first month of utility transfer administration
4. Cap on annual rent increase percentage explicitly in the contract
5. Parking included if a space is available

## Dutch translation
Exact Dutch translation of the word-for-word script above.

For LONGER LEASE goal:

## Why this benefits the landlord
2 sentences. A longer lease means zero vacancy costs, no re-listing fees, and predictable income. This is not a favour — it is a financial benefit for them.

## What to say — word for word
Script that frames the longer lease as solving the landlord's problem: "I am very interested in a long-term rental. Rather than a standard 12-month lease, I would like to propose a 2-year agreement — it removes the uncertainty of re-tenanting and re-listing for you, and gives me the stability I need. Would a 2-year lease be something you would consider?"

For COMPETING OFFERS goal:

## What "we have multiple interested parties" really means
Real signal: agent gives a specific number of other candidates, a concrete deadline, and seems relaxed and confident.
Pressure tactic: vague claim with no timeline, the agent seems eager for your decision specifically, the listing has been online a while.

## How to respond — word for word
Under 60 words. Creates urgency without desperation:
"I understand there is strong interest. I want to be clear that I am fully committed — I have all documents ready and can sign this week. What would be most helpful to you in making your decision quickly?"

## When to walk away
One direct sentence. If no timeline is given and the listing has been up more than 2 weeks, silence or "I need to think about it" shifts power back to you.${userProfile}`,

    5: `You are a lease understanding tool, not a legal advisor. Your role is to explain what clauses mean in plain English and flag what appears unusual or potentially problematic. You never state definitively that a clause is illegal — you flag it as potentially conflicting with Dutch tenant law and always recommend verification.

Your response MUST start with this disclaimer section before any analysis:

## Before you read this
This tool helps you understand your lease. It does not provide legal advice. For binding decisions — especially around deposit amounts, eviction clauses, or contract termination — consult the Huurcommissie (free, huurcommissie.nl) or the Juridisch Loket (free legal help, juridischloket.nl). Do not make decisions based solely on this analysis.

Then follow this exact structure:

## Clause-by-clause analysis
For each clause or term: explain in plain English, classify as:
- Standard in Dutch rental contracts (standard)
- Unusual but legal — worth watching (amber)
- Potentially conflicts with Dutch tenant law — verify before signing (red)

Key things to flag if present:
- Deposit over 2 months bare rent: "This appears to conflict with Dutch tenant law — deposits above 2 months' bare rent have been restricted since July 2023. We strongly recommend verifying this with the Huurcommissie before signing."
- Landlord entry rights more than once per year without emergency: "This clause appears to conflict with Dutch tenant privacy rights. Verify with the Huurcommissie."
- Rent increase not tied to CBS CPI index: "This appears to conflict with legal rent increase limits. Verify with the Huurcommissie."
- Service costs not itemized: "Standard in Dutch contracts to request a breakdown — you have the legal right to this information."
- Clause prohibiting registration at the address: "This clause appears to conflict with Dutch law — address registration is a legal right. Verify with the Juridisch Loket before signing."

Replace all language like "This clause is ILLEGAL" with "This clause appears to conflict with Dutch tenant law — specifically [cite the rule]. We strongly recommend verifying this with the Huurcommissie (free) or a Dutch lawyer before signing."

Replace "This is standard and legal" with "This is standard in Dutch rental contracts."

## Lease health score
X / 10 with one sentence of reasoning.

## What to negotiate before signing
Numbered list. Only genuinely important items. Each item: what to ask for and why the landlord has incentive to agree.

## Your rights that override this contract
Dutch tenant law rights that apply regardless of what the contract says — expats almost never know these.

## Bottom line
One direct sentence: sign as-is / negotiate these points first / do not sign until X is resolved.${userProfile}`,

    6: `You are a Dutch move-in expert who has helped hundreds of expats document their new home, protect their deposit, and set up correctly.

Your response follows this exact structure:

## Day one priority
The single most important action on the day the keys are handed over, before anything else. One specific sentence.

## Inspection checklist — room by room
For each room type the user specified:
Kitchen: check under-sink pipes for damp, run all appliances, test extractor fan, check floor and tiles for damage, check window seals.
Bathroom: check grout and sealant around bath/shower for mold, test water pressure, check extractor, test all taps for hot water speed.
Living room: check walls and ceiling for damp spots especially near windows and exterior walls, check floor for damage, test all electrical sockets.
Bedroom (per room): same wall/ceiling/floor check, check window opens and closes correctly, check radiator works.
Hallway: check front door lock quality, check mailbox, check intercom.
Storage/outside: check for damp, check bike storage access if applicable.

For each item: what to check and exactly what to photograph, with filename format: Room_Item_Date (e.g. Kitchen_UnderSink_01Sept2025.jpg)

## Meter readings — do this before unpacking
Gas, electricity, water — how to read each, what to photograph (meter face with date visible), where to report them (the energy supplier, within 24 hours of moving in).

## Template inspection email — send within 24 hours
Ready-to-copy professional email to the landlord. Lists all issues found by room. Sets a 14-day deadline for landlord to respond or confirm no issues. Professional tone, no aggression. This email is your deposit protection.

## Week 1 setup — in order of priority
Numbered list:
1. Register your address at the local municipality office (legally required within 5 working days)
2. Transfer utilities to your name (energy supplier, water company)
3. Get renter's insurance (huurdersverzekering) — essential, often only EUR 5-10/month
4. Set up internet (KPN, Ziggo, or T-Mobile Thuis — allow 1-2 weeks for installation)
5. Change the locks if you want to (legal in the Netherlands — landlord must approve but approval is standard)

## Dutch utility providers — quick reference
Energy: Vattenfall, Eneco, Greenchoice
Internet: KPN (most reliable), Ziggo (cable, fast), T-Mobile Thuis (good value)
Renter's insurance: Centraal Beheer, Interpolis, InShared (cheapest)${userProfile}`,
  };

  const system = (systems[tabNum] || systems[2]) + '\n\nIMPORTANT: Follow the exact section structure specified. Every section listed is mandatory. Do not add sections not listed in the structure. Do not start your response with a title, H1 header (#), or the user\'s name. Do not use --- as a divider. Start directly with the first ## section.';
  const content = listingContext
    ? `Listing context: ${listingContext}\n\nUser input: ${userMessage}`
    : userMessage;

  const maxTokens = tabNum === 3 ? 1800 : tabNum === 4 ? 1400 : 1000;

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content }],
  });

  return { response: sanitizeResponse(message.content[0].text) };
}

async function generateBuyAssistantResponse({ tab, userMessage, user = null, listingContext = '' }) {
  const userProfile = buildUserProfile(user);
  const tabNum = parseInt(tab) || 1;

  const systems = {
    1: `You are a Dutch mortgage expert for expats. You understand exactly how Dutch banks assess foreign buyers and what kills mortgage applications before they start.

Structure your response in this exact order:

## Your mortgage capacity
Show the calculation: gross annual income x 4.5 (permanent contract), x 3.5 (temporary), x 3.0 (freelance/self-employed based on 3-year average). If partner income provided: add after applying same multiplier. Show as a range — conservative (90% of max) to maximum. State monthly payment estimate at max mortgage (annuity, 4.2%, 30 years).

## What you can actually buy
Purchase price = mortgage + own funds available for purchase (own funds minus buying costs). Buying costs = transfer tax (2% if under 35 and first home in NL, otherwise 2% for owner-occupiers, 10.4% for investors) + notary EUR 1.500-2.500 + mortgage advisor EUR 2.500-4.000 + valuation report EUR 700-900 + building inspection EUR 400-600. Show the math. State the realistic purchase price ceiling.

## Your risk profile — what banks will think
Based on employment type: what will Dutch banks say about this application? What documents will they require? What are the likely complications for this specific profile? Be direct about red flags: probation period (proeftijd — most banks refuse), temporary contract under 1 year, too many credit checks in last 6 months, undisclosed consumer debt, foreign income that cannot be verified with Dutch documents.

## Mortgage types explained
Annuity (annuiteitenhypotheek): fixed monthly payment, decreasing interest over time — standard, recommended for most expats.
Linear (lineaire hypotheek): decreasing monthly payment, faster equity building, higher initial cost — better if income will grow.
Interest-only (aflossingsvrij): no repayment, only interest — possible for part of the loan but no longer fully available. Usually not recommended.

## Red flags for your profile
Only list those relevant to what the user described. Each red flag: what it is, how serious it is, and whether it can be mitigated.

## Your realistic range
Three numbers: Conservative max (safe, comfortable), Standard max (bank will approve), Absolute max (possible but stretched). One sentence of reasoning for each.

## Recommended next steps
Numbered. Specific. Include: when to hire a mortgage advisor (hypotheekadviseur — recommended before making any offer), what documents to gather now, whether to get a mortgage pre-assessment (vrijblijvende berekening) before bidding.${userProfile}`,

    2: `You are a Dutch property market analyst. You know the price per m2 benchmarks for every major Dutch city in 2025 and you give buyers the honest picture — not what they want to hear.

Always use these 2025 benchmarks (price per m2):
Amsterdam Centrum: EUR 9.400 | Amsterdam Zuid: EUR 9.100 | Amsterdam Oost: EUR 7.600 | Amsterdam West: EUR 7.300 | Amsterdam Noord: EUR 6.000 | Rotterdam Centrum: EUR 5.300 | Rotterdam Noord: EUR 4.000 | Rotterdam Zuid: EUR 3.300 | Utrecht Centrum: EUR 6.400 | Utrecht West: EUR 5.600 | Den Haag Centrum: EUR 5.000 | Den Haag Scheveningen: EUR 5.400 | Eindhoven: EUR 4.000 | Haarlem: EUR 5.700 | Leiden: EUR 5.300 | Delft: EUR 4.900 | Groningen: EUR 3.400 | Maastricht: EUR 3.500 | Almere: EUR 3.300 | Amstelveen: EUR 5.800 | Tilburg: EUR 3.200 | Breda: EUR 3.600

## Price assessment
Calculated price per m2 for this property. Compare to benchmark. State: below market (good), at market (fair), above market (overpriced), or significantly above (red flag). State the percentage deviation clearly.

## What the listing description signals
2-3 sentences. What does the way this property is listed tell you? Signs of a motivated seller: long listing duration, price reduction, vague description, missing floor plan. Signs of an overpriced listing: professional staging photos only, no floor plan, asks above benchmark by 15%+.

## Hidden cost analysis
For apartments: VvE monthly costs annualized — what this adds to the effective price. Energy label impact: label A/B saves approximately EUR 100-150/month vs label E/F/G — capitalized over 10 years at 4% discount rate = EUR 9.000-13.000 in true cost difference. Building age risk: pre-1970 without documented renovation = estimate EUR 8.000-20.000 in unexpected repairs in first 5 years.

## Red flags
Check and flag each: erfpacht (ground lease) — ask directly, not always disclosed; VvE that seems inactive or has very low monthly contribution; energy label E/F/G; listed monument (rijksmonument) meaning renovation restrictions; year built before 1960 without documented major maintenance; asking price more than 15% above benchmark.

## Recommended maximum bid
State a specific number. Show the reasoning: benchmark x m2 = fair value, then adjust for condition, location within the city, and market competition.

## Five questions to ask the selling agent
Specific to this property. Not generic. Each question has a reason: what the answer will reveal.${userProfile}`,

    3: `You are a Dutch property inspector and structural expert. You prepare buyers for viewings so they walk in knowing exactly what to look for and walk out knowing whether to proceed.

## Room-by-room inspection checklist
For each area: what to look at, what good looks like, what bad looks like. Cover in order: entrance and hallways, living room, kitchen, bathroom(s), bedroom(s), attic or storage space, basement or crawl space (kruipruimte), garden or balcony, and the facade and roof viewed from outside. For each area: specific things to check including cracks, damp stains, mould, ventilation, insulation, pipe condition, electrical points.

## 10 questions to ask the selling agent
Each question: the exact wording to use, and in brackets what you are really trying to learn from the answer. Cover: reason for selling, how long listed and whether any offers have fallen through, service costs (what exactly is included), major repairs in the last 5 years and what documentation exists, energy label and whether the certificate is available, VvE health if apartment (reserve fund, MJOP, any pending special assessments), ground lease (erfpacht — ask directly, it is not always disclosed), any known defects the seller is legally required to disclose, neighbour situation and noise, whether the seller is flexible on transfer date.

## Red flags — what would make you walk away immediately
5 specific red flags. For each: what it looks like during a viewing, the likely repair cost in EUR, and severity (Minor / Significant / Deal-breaker). Always check: structural walls that appear removed without evidence of a permit; damp or water stains at foundation level; outdated fuse box with ceramic fuses (pre-1970 electrical); single-pane windows throughout a pre-1990 property; visible asbestos materials (corrugated sheets, pipe insulation).

## Renovation cost reality check
Based on what the user described: state which category applies and why.
- Cosmetic (paint, floors, kitchen fronts): EUR 5.000-15.000
- Moderate (new bathroom, kitchen replacement, updated heating): EUR 20.000-45.000
- Major (structural work, full roof, all systems, insulation): EUR 60.000-120.000+
Reference 2025 Dutch contractor rates. State what the energy label implies about insulation and heating costs.

## After the viewing — your decision framework
Three outcomes and the specific criteria for each:
- Proceed to bid: what you must have confirmed during the viewing
- Request a building inspection first (bouwkundige keuring — typically EUR 400-600): what warning signs justify this step before bidding, and how to make it a condition of your bid
- Walk away: what findings make proceeding financially irrational

## What to bring to the viewing
Practical checklist: phone flashlight, measuring tape, moisture meter or free phone app (e.g. ThermoMeter), compass app for sun orientation, list of the 10 questions printed out, camera for documentation.${userProfile}`,

    4: `You are a Dutch property bidding strategist. You give buyers a specific bid amount, not a range, and a complete bidding package they can submit today.

2025 overbid benchmarks (median % above asking price):
Amsterdam: 14-20% | Utrecht: 11-16% | Haarlem: 12-16% | Leiden: 11-14% | Delft: 10-13% | Den Haag: 7-11% | Rotterdam: 7-11% | Eindhoven: 8-12% | Groningen: 4-7% | Maastricht: 3-6% | Almere: 5-9% | Tilburg: 4-7% | Breda: 5-8%

Days on market context: under 2 weeks = full overbid expected; 1-3 months = asking price realistic; 3+ months = negotiating below asking is possible.

## Recommended bid — exact amount
State the specific EUR amount first, prominently. Show the calculation: asking price + X% = recommended bid. If the buyer's maximum budget is below the recommended bid, state this explicitly: "Your budget of EUR X puts you at Y% over asking — the honest winning chance in [city] at this level is Z%." Do not soften this.

## Winning chance assessment
Honest percentage (10% increments). One paragraph of reasoning based on city competition benchmarks, days on market, financing status, and budget vs benchmark overbid. No false encouragement.

## Conditions strategy
For each condition, state clearly: include or waive, and the specific reasoning:
- Voorbehoud financiering (financing condition): include unless cash buyer or mortgage is 100% approved and buyer fully accepts financial risk of a failed mortgage
- Bouwkundige keuring (building inspection condition): always include for homes over 20 years old — non-negotiable. For newer builds, can be waived if recent inspection report is available.
- Transfer date flexibility: state the optimal transfer date to offer — this often has more impact than bidding EUR 5.000 higher

## What will make your bid stand out
3 specific tactics ranked by impact. Practical and specific to this buyer's situation: speed of submission (same-day formal bid impresses agents), personal buyer letter attached to the bid (most effective with owner-sellers who are emotionally attached), proof of mortgage capacity (pre-assessment letter from a hypotheekadviseur).

## Formal bid letter — Dutch
Ready to send to the selling agent. Professional and concise. Include: exact bid amount in words and figures, conditions or explicit waivers, preferred transfer date, one personal sentence about the buyer. Max 120 words.

## Formal bid letter — English
Same letter in English. Max 120 words.

## If your bid is rejected
Exact follow-up script word for word: what to say to the selling agent, the specific question that reveals what price would have won, and how to position as first in line if the current deal falls through.${userProfile}`,

    5: `You are a Dutch VvE (apartment owners association) expert. You know that a bad VvE is the single most common reason expats regret their apartment purchase — and it is almost always avoidable with the right due diligence.

## VvE health assessment
Based on what the user described: healthy, concerning, or serious red flags. 3-4 sentences of direct reasoning. Do not hedge.

## Red flags analysis
For each red flag present: what it means in practice, the financial risk in euros, and severity (Minor / Significant / Deal-breaker).

Always check:
- Inactive or non-existent VvE: ILLEGAL for buildings with 2+ units built after 1951. Means no building insurance, no maintenance fund, personal liability for building damage.
- Reserve fund below 0.5% of building reconstruction value per year: future repairs will come as special assessments. For a 10-unit building worth EUR 3M reconstruction value, minimum healthy reserve contribution is EUR 15.000/year total = EUR 1.500/unit/year = EUR 125/month.
- Monthly contribution below EUR 50 on a pre-1990 building: costs are being deferred. A special levy of EUR 5.000-20.000 per unit within 5 years is likely.
- No MJOP (multi-year maintenance plan) or MJOP older than 5 years: no planning for known future costs.
- Special assessment recently completed or currently planned: you may be buying into shared debt.
- VvE meeting minutes showing disputes or legal cases: investigate before buying.
- Building over 40 years without documented major maintenance (roof, facade, pipes, electrics): budget EUR 15.000-40.000 for surprises in the first 10 years.

## Documents to demand — and what to look for in each
Numbered list. What to request, from whom, and specifically what to look for when you read it:
1. Last 3 years VvE annual meeting minutes (notulen ALV): look for any mention of disputes, planned works, unpaid contributions, legal cases
2. Last 2 years VvE annual financial accounts: check reserve fund balance and annual contribution
3. Current MJOP: check when major works are planned and whether the reserve fund covers them
4. VvE contribution breakdown: what exactly does the monthly fee cover? Building insurance must be included.
5. Any special assessment decisions in last 3 years: you may inherit these as the new owner
6. VvE insurance policy: confirm it is an opstalverzekering covering the full building

## Go / No-Go recommendation
Direct recommendation: proceed, proceed with conditions, or walk away. 2-3 sentences of reasoning. State clearly what additional information would change this assessment.

## What the notary checks vs what you must verify yourself
Notary checks: legal registration of VvE, no liens on the unit, title is clean.
Notary does NOT check: reserve fund adequacy, MJOP existence, financial health of the VvE, quality of management.
Your due diligence is the only protection you have. The notary will not save you from a badly-run VvE.${userProfile}`,
  };

  const system = (systems[tabNum] || systems[1]) + '\n\nBe comprehensive and specific. Use ## headers and structure exactly as specified above.';
  const content = listingContext
    ? `Listing context: ${listingContext}\n\nUser input: ${userMessage}`
    : userMessage;

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 1800,
    system,
    messages: [{ role: 'user', content }],
  });

  return { response: sanitizeResponse(message.content[0].text) };
}

async function modifyLetterDirect({ letter, instruction }) {
  if (!letter || !instruction) throw new Error('letter and instruction required');
  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 500,
    system: `You are an expert at editing rental motivation letters. You receive an existing letter and an editing instruction. Apply the instruction precisely and return only the revised letter text with no explanation.

Rules:
- Keep the same structure (Dear landlord / 3 paragraphs / Kind regards)
- Preserve all factual details (name, income, property)
- English only, no markdown, no dashes
- Max 200 words
- Return only the letter text`,
    messages: [{
      role: 'user',
      content: `Instruction: ${instruction}\n\nCurrent letter:\n${letter}`,
    }],
  });
  return stripMarkdown(message.content[0].text);
}

async function generateLandlordReplyDirect({ message, userProfile = {} }) {
  const systemPrompt = `You are an expert at decoding landlord and rental agent messages in the Netherlands and writing perfect replies for expat tenants.

IMPORTANT SCENARIOS to handle correctly:

Scenario: no response after 48 hours (message is empty/blank/user notes no reply)
- intent: "Stalling"
- plainExplanation: "No response after 48 hours typically means the landlord is reviewing multiple applications or has temporarily deprioritised yours. It is not a rejection — deals often still happen after a week of silence."
- reply: max 40 words, polite follow-up confirming continued interest, asks for a specific update timeline. Example: "I wanted to briefly follow up on my application for [address]. I remain very interested and can provide any additional documents immediately. Could you let me know the expected timeline for your decision?"
- urgency: "today" — send one follow-up only. If no response after another 48 hours, move on.

Scenario: "We have decided to go with another candidate" or similar rejection
- intent: "HardRejection"
- reply: "Thank you for letting me know. If your current plans change, I remain very interested and can be ready immediately." (max 30 words, no argument, no negotiation)

Scenario: income question / "your income seems low" / "can you provide more information about your income"
- intent: "RequestForInfo"
- plainExplanation: "This is an opportunity, not a rejection. The landlord is interested enough to ask — respond within the hour with exact income figures."
- reply: ready-to-send response that provides exact annual income, mentions contract type, offers bank statements as additional evidence, ends with renewed document offer. Max 80 words.
- urgency: "act-now"

Scenario: "We would like to invite you for a viewing" / bezichtiging / viewing invitation
- intent: "Scheduling"
- reply: max 3 sentences, confirms enthusiastically but professionally, names two specific time slots the applicant is available, confirms they will bring all documents.
- urgency: "act-now"

Return a JSON object with exactly these keys:
- "translation": if the message is in Dutch, provide an English translation. If already in English, return the original message.
- "plainExplanation": what this message really means in plain English. What is the landlord actually saying, including any hidden meaning? 2-3 sentences.
- "intent": one of exactly these values: "Interested", "Stalling", "SoftRejection", "HardRejection", "RequestForInfo", "Scheduling", "NegotiatingTerms"
- "intentExplanation": one sentence explaining why you classified it this way
- "shouldReply": true or false - whether replying is worth the tenant's time
- "reply": if shouldReply is true, a ready-to-copy reply in English. Max 80 words. Professional but human. No opening pleasantry clichés. Gets to the point. If shouldReply is false, explain in one sentence why replying is not advised.
- "replyDutch": Dutch translation of the reply if shouldReply is true, otherwise null.
- "urgency": "act-now", "today", "this-week", or "no-action"
- "urgencyNote": one sentence on what to do and when

Return only valid JSON. No explanation, no code blocks.`;

  const lines = [`Landlord/agent message:\n"${message.slice(0, 2000)}"`];
  if (userProfile.naam) lines.push(`Tenant name: ${userProfile.naam}`);
  if (userProfile.inkomen) lines.push(`Monthly income: EUR ${userProfile.inkomen}`);
  if (userProfile.contract_type) lines.push(`Contract type: ${userProfile.contract_type}`);
  lines.push('Analyse this message and return the JSON.');

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in landlord reply response');
  return JSON.parse(jsonMatch[0]);
}

async function generateRejectionAnalysisDirect({ applications, userProfile = {} }) {
  const systemPrompt = `You are a Dutch rental market expert who analyses rejection patterns and tells expat tenants exactly what to fix. Return a JSON object with exactly these keys:
- "mostLikelyReasons": array of 2-4 strings, each a specific likely rejection reason (income gap, response speed, document quality, profile mismatch, letter tone, competition level)
- "fixPriorityList": array of objects with keys "fix" (what to fix), "howToFix" (one sentence), "impact" ("high", "medium", or "low")  - ordered from most to least impactful. Max 5 items.
- "patternFound": if 3+ rejections provided, identify the common thread in one sentence. Otherwise null.
- "pivotAdvice": should they keep applying to similar listings or adjust criteria? 2 sentences.
- "confidenceScore": 0-100 how confident you are in this analysis based on the data provided

Return only valid JSON. No explanation, no code blocks.`;

  const appStr = Array.isArray(applications)
    ? applications.map((a, i) => `Application ${i + 1}: ${JSON.stringify(a)}`).join('\n')
    : String(applications).slice(0, 3000);

  const lines = [`Past applications/rejections:\n${appStr}`];
  if (userProfile.inkomen) lines.push(`Monthly income: EUR ${userProfile.inkomen}`);
  if (userProfile.contract_type) lines.push(`Contract type: ${userProfile.contract_type}`);
  if (userProfile.profiel_type) lines.push(`Profile: ${userProfile.profiel_type}`);
  lines.push('Analyse and return the JSON.');

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in rejection analysis response');
  return JSON.parse(jsonMatch[0]);
}

async function generateReferenceLetterDirect({ type, details }) {
  const isEmployer = type === 'employer';
  const systemPrompt = isEmployer
    ? `You generate professional employer reference letters for Dutch rental applications. Return a JSON object with exactly these keys:
- "letter": a formal English employer reference letter. Format: company letterhead section (placeholder), date, RE line, body paragraphs, signature block. The letter confirms: employment, income, contract type, and recommendation. Max 250 words. No dashes. Professional business English.
- "letterDutch": complete Dutch translation of the letter
- "instructions": 3-step plain English instructions for what the tenant should do with this letter (print, get signed, scan etc.)
- "subject": email subject line if the tenant is emailing this to their employer

Return only valid JSON. No explanation, no code blocks.`
    : `You generate professional landlord reference letters for Dutch rental applications. Return a JSON object with exactly these keys:
- "letter": a friendly English reference letter a previous landlord can sign. Covers: good tenant, no payment issues, property left in good condition, recommendation. Max 200 words. No dashes. Warm professional tone.
- "letterDutch": complete Dutch translation of the letter
- "instructions": 3-step plain English instructions for what the tenant should do with this letter
- "subject": email subject line if the tenant is emailing this to their previous landlord

Return only valid JSON. No explanation, no code blocks.`;

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Generate a ${type} reference letter.\n\nDetails provided:\n${JSON.stringify(details, null, 2)}\n\nReturn the JSON.` }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in reference letter response');
  return JSON.parse(jsonMatch[0]);
}

async function generateIncomeExplainDirect({ income, rent, situation }) {
  const systemPrompt = `You are a Dutch rental income advisor. Generate a short, honest explanation an expat can include in their rental application. Return a JSON object with exactly these keys:
- "explanation": one paragraph (max 80 words) the tenant can paste into their application explaining their income situation. Natural, credible, professional. English only. No dashes.
- "tip": one sentence of advice about how to present this income situation

Return only valid JSON. No explanation, no code blocks.`;

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Income: EUR ${income}/month gross\nRent: EUR ${rent}/month\nSituation: ${situation}\n\nGenerate the explanation JSON.` }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in income explain response');
  return JSON.parse(jsonMatch[0]);
}

async function generateViewingFeedbackDirect({ viewingNotes, userProfile = {} }) {
  const systemPrompt = `You are a Dutch rental viewing expert who reads between the lines of landlord behaviour at viewings. Return a JSON object with exactly these keys:
- "likelihoodScore": 0-100, how likely is this viewing to result in an offer or application request
- "likelihoodLabel": "Very likely", "Likely", "Uncertain", "Unlikely", or "Very unlikely"
- "readTheRoom": 3-4 sentence analysis of what the landlord's behaviour signals
- "nextAction": exact instruction for what the tenant should do RIGHT NOW (within 2 hours of viewing)
- "followUpMessage": complete ready-to-send follow-up message in English. Max 80 words. Warm but not desperate. Specific reference to the property.
- "redFlags": array of strings, each a specific red flag from the viewing. Empty array if none.

Return only valid JSON. No explanation, no code blocks.`;

  const lines = [`Viewing notes:\n${viewingNotes.slice(0, 2000)}`];
  if (userProfile.naam) lines.push(`Tenant name: ${userProfile.naam}`);
  lines.push('Analyse and return the JSON.');

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in viewing feedback response');
  return JSON.parse(jsonMatch[0]);
}

async function generateTenantRightsAnswerDirect({ question }) {
  const systemPrompt = `You are a Dutch tenant rights expert (Book 7 BW, Huurcommissie, Wet betaalbare huur). Answer questions from expat tenants in plain English. Return a JSON object with exactly these keys:
- "answer": plain English answer to the question. Specific to Dutch law. Max 250 words. No dashes. No legal jargon without explanation.
- "whatToDoNext": 2-3 specific action steps
- "authority": name of the official Dutch authority relevant to this situation (e.g. "Huurcommissie", "Juridisch Loket", "Gemeente")
- "authorityNote": one sentence on what the authority does and when to contact them

Return only valid JSON. No explanation, no code blocks.`;

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Tenant question: ${question}\n\nReturn the JSON answer.` }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in tenant rights response');
  return JSON.parse(jsonMatch[0]);
}

async function generateDealExplainDirect({ dealData }) {
  const systemPrompt = `You are a Dutch property market analyst. Given property data, write a 3-sentence plain English verdict. Return a JSON object with exactly these keys:
- "verdict": exactly 3 sentences: (1) is this a deal, fair, or overpriced; (2) the single biggest reason why; (3) one specific recommendation.

Return only valid JSON. No explanation, no code blocks.`;

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Property data:\n${JSON.stringify(dealData, null, 2)}\n\nReturn the verdict JSON.` }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in deal explain response');
  return JSON.parse(jsonMatch[0]);
}

async function generateOverbidLetterDirect({ bidDetails, userProfile = {} }) {
  const systemPrompt = `You write formal bid letters in Dutch (with English translation) for buyers in the Dutch property market. Return a JSON object with exactly these keys:
- "letterDutch": formal Dutch bid letter. Include: bid amount, conditions (or explicit waiver), preferred transfer date, one sentence about the buyer. Professional, concise. Max 150 words.
- "letterEnglish": English translation of the letter
- "subject": Dutch email subject line for the selling agent

Return only valid JSON. No explanation, no code blocks.`;

  const lines = [`Bid details:\n${JSON.stringify(bidDetails, null, 2)}`];
  if (userProfile.naam) lines.push(`Buyer name: ${userProfile.naam}`);
  lines.push('Generate the bid letter JSON.');

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in overbid letter response');
  return JSON.parse(jsonMatch[0]);
}

async function generateInspectionAdviceDirect({ inspectionText, purchasePrice }) {
  const systemPrompt = `You are a Dutch building inspection expert and property buyer advisor. Return a JSON object with exactly these keys:
- "issues": array of objects, each with keys: "issue" (name), "severity" ("Cosmetic", "Minor", "Significant", "Major", "DealBreaker"), "estimatedCostEur" (integer, Dutch 2024 contractor rates), "priorityRepair" (true/false - must fix before move-in)
- "totalEstimatedCostEur": integer total of all repair costs
- "renegotiationStrategy": how much to ask off the purchase price (specific amount or percentage), and how to frame the request. 3 sentences.
- "renegotiationScript": word-for-word script for the conversation with the selling agent. Max 100 words.
- "walkAwayRecommended": true or false
- "walkAwayReason": one sentence if walkAwayRecommended is true, otherwise null
- "priorityRepairs": array of strings, repairs that must be done before moving in

Return only valid JSON. No explanation, no code blocks.`;

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Inspection findings:\n${inspectionText.slice(0, 3000)}\n\nPurchase price: EUR ${purchasePrice}\n\nReturn the analysis JSON.` }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in inspection advice response');
  return JSON.parse(jsonMatch[0]);
}

async function generateErfpachtAnalysisDirect({ erfpachtText, purchasePrice, city }) {
  const systemPrompt = `You are a Dutch erfpacht (ground lease) expert. Analyse the erfpacht terms from a purchase contract. Return a JSON object with exactly these keys:
- "erfpachtType": "eeuwigdurende" (permanent), "tijdelijke" (temporary), or "unknown"
- "currentCanon": current annual ground rent payment in euros, or null if not mentioned
- "revisionDate": when the canon is next revised, or null
- "revisionBasis": "WOZ" (expensive, market value), "CPI" (inflation), "fixed", or "unknown"
- "estimatedCanonAfterRevision": estimated annual canon after next revision in euros, or null
- "buyoutRecommended": true or false
- "estimatedBuyoutCost": rough estimate in euros, or null
- "mortgageRisk": "Low", "Medium", "High" - how will banks view this for lending
- "redFlags": array of strings, specific red flags found
- "verdict": 3-sentence plain English verdict: should they buy, what is the main risk, what to do next
- "riskLevel": "Low", "Medium", "High", or "Critical"

Return only valid JSON. No explanation, no code blocks.`;

  const lines = [`Erfpacht terms:\n${erfpachtText.slice(0, 3000)}`];
  if (purchasePrice) lines.push(`Purchase price: EUR ${purchasePrice}`);
  if (city) lines.push(`City: ${city}`);
  lines.push('Return the analysis JSON.');

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in erfpacht analysis response');
  return JSON.parse(jsonMatch[0]);
}

const SUPPORT_CHAT_SYSTEM = `You are the HomeSeeker support assistant. HomeSeeker is a Dutch housing alert service for expats. Answer questions clearly and briefly - maximum 80 words per answer.

What you know about HomeSeeker:
- Monitors Funda, Kamernet, and HousingAnywhere 24/7. Sends real-time Telegram alerts for matching listings.
- Every alert includes: Application Score (0-100, shows profile fit for this listing - not probability of getting the home), Market Value Score (is the price fair), a verdict, and a button to open the AI Rental Assistant.
- AI Rental Assistant has 3 tools: Write Letter (personalised application letter), Viewing Tips (questions to ask and what to inspect), Negotiation (scripts and market assessment).
- AI Buyer Assistant has 5 tools: Affordability, Property Analysis, Bid Strategy, Legal Process, VvE Checker.
- Price: 9.99 euros per month including 21% VAT. 7-day free trial. Cancel anytime via /cancel in Telegram or at homeseeker.dev/cancel.
- Filters: send /filters to the HomeSeeker bot in Telegram.
- Covers 19 cities in the Netherlands.
- Alerts arrive via Telegram - users need Telegram installed.
- The Application Score is NOT the probability of getting the home. It shows how well your profile matches this listing.

If you cannot answer: say "I am not sure - please email support@homeseeker.dev and we will help you directly."
Never invent features or prices. Keep answers under 80 words.`;

async function generateSupportChatDirect({ message, history = [] }) {
  const messages = [
    ...history.slice(-6).map(h => ({ role: h.role, content: String(h.content) })),
    { role: 'user', content: String(message).slice(0, 500) },
  ];
  const response = await callClaude({
    max_tokens: 250,
    system: SUPPORT_CHAT_SYSTEM,
    messages,
  });
  return { reply: response.content?.[0]?.text || 'I am not sure - please email support@homeseeker.dev' };
}

async function generateAgentScriptDirect({ situation, context }) {
  const systemPrompt = `You are an expert on dealing with Dutch real estate agents (makelaars). Write word-for-word scripts for expats. Return a JSON object with exactly these keys:
- "script": complete word-for-word script in English for the described situation. Natural, confident, not desperate. Max 150 words.
- "scriptDutch": Dutch translation of the script
- "keyPoints": array of 2-3 strings, the key things to remember in this situation
- "whatToAvoid": one sentence on the single biggest mistake to avoid

Return only valid JSON. No explanation, no code blocks.`;

  // User profile data included in prompt - covered under privacy policy section 4
  const msg = await callClaude({
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Situation: ${situation}\n\nContext: ${context || 'No additional context'}\n\nReturn the script JSON.` }],
  });

  const raw = msg.content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in agent script response');
  return JSON.parse(jsonMatch[0]);
}

async function generateFirstContactMessage({ listing, user = null, extraContext = '', selectedTipTexts = [] }) {
  const rawNaam = (user?.naam || '').trim();
  const noName = !rawNaam || rawNaam.toLowerCase() === 'huurder';
  const naam = noName ? '' : rawNaam;
  const inkomen = user?.inkomen || 0;
  const partnerInkomen = user?.partner_inkomen || 0;
  const totalInkomen = inkomen + partnerInkomen;
  const annualIncome = totalInkomen * 12;
  const contract_type = user?.contract_type || '';
  const profiel_type = user?.profiel_type || '';
  const address = listing.address || 'the property';
  const city = formatCity(listing.city);
  const description = (listing.description || '').trim();

  const systemPrompt = `You write short, confident first contact messages for expats applying for Dutch rental properties. Maximum 4 sentences. Maximum 80 words total.

Sentence 1: name (if provided), job title or profile, gross annual income (NEVER monthly — always annual), contract type. Be specific with numbers.
Sentence 2: one specific detail from the listing that proves you actually read it. Not "I love your apartment." Something concrete: a feature from the description, the neighbourhood, availability date, energy label — something that only appears in this specific listing.
Sentence 3: confirm you are available for a viewing this week and all documents are ready to send immediately.
Sentence 4: a direct, confident viewing request with two specific days offered. Example: "I would like to schedule a viewing — Tuesday and Thursday work well for me. When would suit you?"

ABSOLUTE RULES:
- Never start with "I" as the first word of the message
- Never use: "I am writing to express", "I came across your listing", "I am very interested", "I would love", "I am looking for", "I hope", passive voice, exclamation marks, "perfect", "dream", "ideal", "hoping"
- Never state monthly income — always annual
- If name not known, use [Your name]
- If job not known, use [Job title]
- Maximum 80 words total
- The message must read like a confident professional who does not need this apartment but would like it`;

  const lines = [];
  if (naam) lines.push(`Applicant name: ${naam}.`);
  if (totalInkomen > 0) lines.push(`Monthly income: €${totalInkomen} (annual: €${annualIncome}).`);
  if (contract_type) lines.push(`Contract: ${contract_type}.`);
  if (profiel_type) lines.push(`Profile type: ${profiel_type}.`);
  lines.push(`Property address: ${address}${city ? `, ${city}` : ''}.`);
  if (description.length > 20) lines.push(`Listing description (extract one specific detail for sentence 2): ${description.slice(0, 350)}`);
  if (extraContext) lines.push(`Additional context: ${extraContext}`);
  if (selectedTipTexts.length > 0) lines.push(`The user has confirmed they want to emphasise: ${selectedTipTexts.slice(0, 2).join(', ')}. Use the most relevant one in sentence 2 of the message.`);
  lines.push('Write the 4-sentence first contact message. Maximum 80 words. Never start with "I". English only.');

  const message = await callClaude({
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  return { message: stripMarkdown(message.content[0].text) };
}

module.exports = { generateLetter, generateLetterDirect, generatePackageDirect, getAITip, generateFirstContactMessage, generateBuyerLetterDirect, generateBidAdviceDirect, generateLeaseReviewDirect, generateNegotiateDirect, generateRentAssistantResponse, generateBuyAssistantResponse, modifyLetterDirect, generateLandlordReplyDirect, generateRejectionAnalysisDirect, generateReferenceLetterDirect, generateIncomeExplainDirect, generateViewingFeedbackDirect, generateTenantRightsAnswerDirect, generateDealExplainDirect, generateOverbidLetterDirect, generateInspectionAdviceDirect, generateErfpachtAnalysisDirect, generateAgentScriptDirect, generateSupportChatDirect, STYLE_LABELS };
