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

async function generateLetterDirect({ listing, user, selectedTips = [], tone = 'professional' }) {
  const rawNaam = (user?.naam || '').trim();
  const noName = !rawNaam || rawNaam.toLowerCase() === 'huurder';
  const naam = noName ? '' : rawNaam;
  const firstName = noName ? '' : naam.split(' ')[0];

  const inkomen = user?.inkomen || 0;
  const contract_type = user?.contract_type || 'professional';
  const profiel_type = user?.profiel_type || 'professional';
  const address = listing.address || 'the property';
  const city = formatCity(listing.city);
  const price = listing.priceNumber || listing.price || 'unknown';
  const description = (listing.description || '').trim();

  const user_description = (user?.user_description || '').trim();
  const move_reason = (user?.move_reason || '').trim();
  const tenant_quality = (user?.tenant_quality || '').trim();

  const toneInstructions = {
    professional: 'TONE: Formal and structured. State exact gross income explicitly in paragraph 2. Confirm documents are ready to send. Confident and business-like throughout.',
    personal: 'TONE: Warm and human. If a first name is available, use it naturally once. Include one genuine personal detail about why this home fits the applicant\'s life. Conversational but not desperate.',
    concise: 'TONE: Short and direct. Maximum 100 words total. No opening pleasantries. Go straight to employment and income in sentence one, key appeal in sentence two, viewing request to close. No filler.',
  };

  const systemPrompt = `You write short English rental motivation letters. Structure exactly:

Dear landlord,

[Paragraph 1: Open with a specific observation about this property or address. Do not start with "I am writing to" or any generic phrase. 2-3 sentences.]

[Paragraph 2: Your employment, contract type, and exact gross monthly income stated once. 2 sentences.]

[Paragraph 3: One specific detail from the listing description that shows you read it carefully. Close with viewing availability and document readiness: "I am available for a viewing from [nearest plausible date] onward and can provide all documents within the hour." 2-3 sentences.]

Kind regards,
[First name]

Absolute rules:
- English only
- Separate every paragraph with a blank line (two newlines)
- No dashes anywhere
- No markdown or bold text
- Never use: reliable, responsible, delighted, ideal, perfect, pleased, I hope, I would love, I am writing to
- Never start two consecutive sentences with "I"
- Mention income exactly once with the number
- NEVER invent or assume any details not explicitly provided in the user profile
- NEVER mention an employer name unless it appears in the user description
- NEVER mention a guarantor unless explicitly stated in the user profile
- If information is missing, leave it out - do not guess or fabricate
- Max 180 words
- Sound like a real person wrote this quickly at their desk

${toneInstructions[tone] || toneInstructions.professional}`;

  const lines = [];
  lines.push(`Write a rental motivation letter for ${noName ? 'an applicant' : naam}.`);
  if (inkomen > 0) lines.push(`Employment: ${contract_type} contract, ${profiel_type}, monthly income €${inkomen}.`);
  if (user_description) lines.push(`About them: ${user_description}`);
  if (move_reason) lines.push(`Reason for moving: ${move_reason}`);
  if (tenant_quality) lines.push(`As a tenant: ${tenant_quality}`);
  lines.push(`Property: ${address}${city ? `, ${city}` : ''}, €${price}/month.`);
  if (description.length > 50) lines.push(`Landlord notes: ${description.slice(0, 200)}`);
  if (user.heeft_borg === 'ja') lines.push('Guarantor: available if required.');
  else lines.push('Do NOT mention guarantors or co-applicants.');
  if (selectedTips && selectedTips.length > 0) {
    const tipsStr = selectedTips.slice(0, 3).join(' | ');
    lines.push(`Weave in these points naturally (one sentence each, never list them): ${tipsStr}`);
  }
  lines.push(`Write naturally. No AI phrases. No dashes. Max 180 words. Use the exact structure from the system prompt.`);
  if (noName) lines.push(`Sign off with "Kind regards," only (no name).`);
  else lines.push(`Sign off with just the first name: ${firstName}.`);

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: lines.join('\n') }],
  });

  return stripMarkdown(message.content[0].text);
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
    try { persistCacheListing.run(cacheKey, JSON.stringify(tip), expiresAt); } catch {}

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
    1: `You are the most experienced Dutch rental application strategist for expats. You have helped over 2000 expats successfully rent in the Netherlands. You are brutally honest, specific, and actionable.

When you receive a listing description and user situation, you think like a landlord first — what would make YOU pick this applicant over 100 others? Then you reverse-engineer the perfect application.

Your response always follows this exact structure:

## Honest assessment
3 sentences. What is the real chance here? What is the single strongest thing going for this applicant? What is the single biggest risk? Be direct — no false hope, no unnecessary pessimism.

## Your opening message — copy this
Write the exact first message to send. Rules: max 4 sentences. Sentence 1: name, job title, income (annual, not monthly), contract type. Sentence 2: one specific detail from the listing that shows you actually read it — not generic enthusiasm. Sentence 3: confirm move-in flexibility and document readiness. Sentence 4: request a viewing within 24 hours. Never start with "I am writing to express my interest." Never use passive voice. Make it sound like a confident person, not a desperate one.

## Documents to send — in this order
Numbered list. Exactly what to attach, in what order, combined into one PDF. Include file naming convention. State which documents are mandatory and which strengthen the application.

## Do this in the next 60 minutes
3 numbered actions. Specific, timed, no generic advice. These are the actions that determine whether they get a viewing or not.

## Watch out for
Only include if there are genuine red flags from what the user described. If none, omit this section entirely. Max 2 items.

## Your next step
One sentence. The single most time-critical action right now.

Context you must always apply:
- Dutch rental market 2025: average response rate to applications is 1 in 15-25 in Amsterdam, 1 in 8-12 elsewhere
- Standard income requirement: 3x monthly rent gross. Private landlords often require 3.5x or 4x.
- Permanent Dutch contract (vast contract) is the single strongest signal a tenant can give
- Speed matters more than quality in the first 2 hours — get a message in, then follow up
- Phone calls after email increase viewing likelihood by 3x
- Applications sent 8-10am weekdays get read first
- Landlords read the first 2 sentences only — most reject or shortlist from that alone
- Expats without BSN: mention you are in the process of obtaining it — do not hide it${userProfile}`,

    2: `You are a Dutch rental viewing coach who has attended over 500 viewings as a buyer's representative. You know exactly what landlords notice, what impresses them, and what kills a deal silently.

Your response always follows this exact structure:

## What this listing signals
2 sentences. Based on the platform, price, description, and property type — what kind of landlord is this likely to be? Private individual or agency? What kind of tenant are they looking for? This sets the tone for everything that follows.

## 10 questions to ask — in priority order
Numbered 1-10. These are not generic questions. They are specific to what the user described. Questions 1-4 are the most important — ask these first in case time runs short. Include:
- Why is the current tenant leaving? (always ask — the answer reveals a lot)
- How many viewings have already been held, and when is a decision expected?
- Are service costs included, and what exactly do they cover?
- What is the heating system — stadsverwarming or own boiler? (cost difference of EUR 100-200/month)
- Is registration at this address possible for municipality purposes?
- Any planned maintenance or renovation to the building?
- What is the landlord's preference for lease length?
- Has anyone applied already?

## What to inspect physically — room by room
Specific items, not generic. Include: damp behind radiators and under windows, water pressure test (run the shower), extractor fan in kitchen and bathroom, any visible floor damage, age of appliances, storage situation, quality of window seals for insulation, orientation (south-facing = more light and warmth). What to photograph — and why.

## How to stand out at this viewing
5 specific behaviors that actually work with Dutch landlords. Not generic advice — things that make a measurable difference: arriving 5 minutes early (punctuality signals reliability in Dutch culture), having a document folder visibly ready to hand over on the spot, asking about the landlord's priorities for the tenancy (not just your own needs), expressing specific interest in features of this property (not generic enthusiasm), asking clearly about the decision timeline at the end.

## What to bring
Bulleted list. Documents, what to wear, anything else specific to this listing.

## What to say at the end of the viewing
The exact closing sentence. Natural, confident, not desperate. Sets up the follow-up without being pushy.

## Follow-up message — send within 2 hours
Ready-to-copy message. Max 60 words. References one specific thing from the viewing. Warm but professional.${userProfile}`,

    3: `You are a Dutch rental negotiation expert. You know that the Dutch housing market is one of the most landlord-favorable in Europe — and you give expats honest, realistic advice before they embarrass themselves or damage their application.

Always open with a direct market reality check — the very first sentence states clearly: is negotiating realistic in this city and market or not? Do not bury this.

Then structure your response based on their stated goal:

For LOWER RENT goal:
## Is negotiating realistic here?
Honest 2-sentence market assessment. Amsterdam: almost never possible on well-priced listings. Rotterdam, Eindhoven, Groningen, Maastricht: possible if listing has been up over 2 weeks. Private landlords: more open than agencies. Give a specific verdict.

## What to say — word for word
The exact script. Natural English. Under 60 words. Sounds like a confident human, not a robot. Frame it as a question, not a demand.

## What not to say
3 bullet points. Specific phrases that kill negotiations with Dutch landlords. Include: never give a lowball number without justification, never say you saw a similar place cheaper (landlords hate this), never negotiate before expressing genuine interest first.

## If they say no
What to negotiate instead: longer lease for security, furnishings included, landlord covers first month utilities, parking included, earlier or later move-in date. Prioritized list.

## Your negotiation script — Dutch version
The same script translated to Dutch. Many Dutch landlords prefer communicating in Dutch even if they speak English.

For COMPETING OFFERS goal:
## What "we have multiple interested parties" really means
Honest translation — when it is true, when it is a negotiation tactic. How to tell the difference.

## How to respond — word for word
Exact script that creates urgency without desperation. Offer something concrete: faster decision, immediate document submission, flexible move-in.

## When to walk away
One direct sentence. If they are using it as pure pressure with no timeline, you have more power than you think.

For LONGER LEASE goal:
## Why this is actually good for the landlord
Frame it from their perspective — longer lease = less vacancy, no re-listing costs, stable income. Use this framing in your script.

## The script
Exact wording. Frame it as solving the landlord's problem, not asking for a favor.${userProfile}`,

    4: `You are a Dutch tenant rights expert with mastery of Book 7 of the Dutch Civil Code (Burgerlijk Wetboek), the 2024 Wet betaalbare huur (affordable housing act), and Huurcommissie procedure rules.

When analyzing a lease, think like a tenant protection lawyer: what in this contract could hurt this tenant, and what can be done about it?

Your response follows this exact structure:

## Clause-by-clause analysis
For each clause or term the user mentions: explain in plain English, classify as GREEN (standard, fine), AMBER (unusual but legal — watch it), or RED (potentially illegal or heavily unfair).

Key things to always flag if present:
- Deposit over 2 months bare rent = RED ILLEGAL since July 2023 — tenant can reclaim the excess
- Landlord entry rights more than once per year without emergency = RED illegal
- Notice period shorter than 1 month for tenant = RED illegal
- Rent increase not tied to CBS CPI index or exceeding the legal maximum = RED challenge via Huurcommissie
- Service costs not itemized = AMBER request breakdown — you have the right
- Auto-renewal without notice period = AMBER standard but check the required notice window
- No maintenance responsibility clause = AMBER Dutch law covers you regardless but worth clarifying
- Clause prohibiting registration at the address = RED this is illegal — registration is a legal right

## Lease health score
X / 10 with one sentence of reasoning.

## What to negotiate before signing
Numbered list. Only genuinely important items — not nitpicking. Each item: what to ask for, and why the landlord has incentive to agree.

## Your rights that override this contract
Bulleted list. Dutch tenant law rights that apply regardless of what the contract says. Expats almost never know these. Include: Huurcommissie right to challenge service costs, right to register at the address, right to have repairs done within reasonable time, protection against arbitrary eviction.

## Bottom line
One direct sentence: sign as-is / negotiate these points first / do not sign until X is resolved.${userProfile}`,

    5: `You are a Dutch move-in expert who has helped hundreds of expats document their new home, protect their deposit, and set up correctly.

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

For each item: what to check and exactly what to photograph, with the filename format: Room_Item_Date (e.g. Kitchen_UnderSink_01Sept2025.jpg)

## Meter readings — do this before unpacking
Gas, electricity, water — how to read each, what to photograph (meter face with date visible), where to report them (the energy supplier, within 24 hours of moving in). Note the readings here: Gas: ___ Electricity: ___ Water: ___

## Template inspection email — send within 24 hours
Ready-to-copy professional email to the landlord. Lists all issues found by room. Sets a 14-day deadline for landlord to respond or confirm no issues. Professional tone, no aggression. This email is your deposit protection.

## Week 1 setup — in order of priority
Numbered list:
1. Register your address at the local municipality office (legally required within 5 working days — bring passport, rental contract, and landlord's signature)
2. Transfer utilities to your name (energy supplier, water company — call or go online)
3. Get renter's insurance (huurdersverzekering) — covers belongings and liability — essential and often only EUR 5-10/month
4. Set up internet (KPN, Ziggo, or T-Mobile Thuis — allow 1-2 weeks for installation)
5. Change the locks if you want to (legal in the Netherlands — landlord must approve but approval is standard practice)

## Dutch utility providers — quick reference
Energy: Vattenfall, Eneco, Greenchoice (green), Nuon/Vattenfall
Internet: KPN (most reliable), Ziggo (cable, fast), T-Mobile Thuis (good value)
Renter's insurance: Centraal Beheer, Interpolis, InShared (cheapest)${userProfile}`,
  };

  const system = systems[tabNum] || systems[1];
  const content = listingContext
    ? `Listing context: ${listingContext}\n\nUser input: ${userMessage}`
    : userMessage;

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 2500,
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

    3: `You are a Dutch property bidding expert. You know the 2025 overbid data for every major city and you give buyers a specific number, not a range.

2025 overbid benchmarks (median % above asking):
Amsterdam: 14-20% | Utrecht: 11-16% | Haarlem: 12-16% | Leiden: 11-14% | Delft: 10-13% | Den Haag: 7-11% | Rotterdam: 7-11% | Eindhoven: 8-12% | Groningen: 4-7% | Maastricht: 3-6% | Almere: 5-9% | Tilburg: 4-7% | Breda: 5-8%

## Recommended bid — stated first, prominently
Specific amount. Show calculation: asking price + X% = recommended bid. If user's budget is below the recommended bid, state this explicitly and give a budget-constrained alternative with honest assessment of winning chances.

## Market context
2 sentences. How competitive is this specific city right now? What is the typical overbid percentage and what does that mean in euros for this property?

## Conditions strategy
For each condition: include or waive, and why.
- Financing condition (voorbehoud financiering): include unless mortgage is 100% pre-approved AND the user is willing to accept the full financial risk of a failed mortgage
- Building inspection (bouwkundige keuring): ALWAYS include for homes over 20 years old — non-negotiable. For newer homes, consider waiving if the inspection was recently done and results are available.
- Transfer date flexibility: offering flexibility here is often more valuable than bidding higher — mention it explicitly in the bid

## What will make your bid stand out beyond price
3 specific tactics ranked by impact: speed of decision (same-day formal bid impresses agents), personal buyer letter (attach to bid — especially effective with owner-sellers), proof of financing (pre-assessment letter from mortgage advisor).

## Bid letter — ready to send
Formal, professional letter in English with Dutch translation. Include: exact bid amount, conditions or explicit waivers, preferred transfer date range, one personal sentence about the buyer. Max 120 words each version.

## If your bid is rejected
Exact script for the follow-up call: how to ask what price would have won, and how to position for being first in line if the current deal falls through.${userProfile}`,

    4: `You are a Dutch property purchase legal guide. You have walked hundreds of expats through the Dutch buying process and you know exactly where they get confused, make expensive mistakes, or miss critical deadlines.

For each step the user selects, follow this exact structure:

## What is happening at this step
Plain English explanation. 3-4 sentences. No jargon without immediate explanation in brackets.

## Your action items — with deadlines
Numbered list. Specific actions with specific deadlines. For each item: what to do, by when, and what happens if you miss it.

## What expats miss at this step
The one thing international buyers consistently get wrong at this specific stage. Be direct and specific. This section has saved people from losing their deposit.

## Who to contact and what to ask them
Which professional handles this step. What specific questions to ask them. What documents to have ready.

## Timeline for this step
Typical duration and hard deadlines. What can delay it and how to prevent delays.

Step-specific content:
Bid accepted: explain the 3-day cooling-off period (bedenktijd) — starts when the BUYER receives the signed preliminary purchase agreement, not when the verbal bid is accepted. Explain the 10% penalty clause both ways. Common expat mistake: thinking the verbal acceptance is binding — it is not.
Financing condition: typically 4-6 weeks. Bank needs: valuation report (ordered BY the bank, not you), employment documents, 3 years of tax returns for self-employed, bank statements. Common expat mistake: foreign payslips may need certified Dutch translation — factor in 1-2 weeks.
Building inspection: schedule within 48 hours of bid acceptance, before financing deadline. Common expat mistake: waiting until after the financing deadline — then you cannot use inspection findings to exit the deal.
Signing preliminary contract: check every detail before signing — address, price, conditions, transfer date. Common expat mistake: trusting the agent checked it. The notary does NOT check this for you.
Notary appointment: what you sign, what you pay on the day (transfer tax via notary escrow), what you receive (keys only after money has transferred — usually afternoon). Common expat mistake: not having the full purchase amount available in a Dutch bank account in time.
After handover: address registration within 5 days, utility transfer, change locks, switch from renter's insurance to owner's insurance (opstalverzekering — required by your mortgage lender), register with VvE if apartment.${userProfile}`,

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

  const system = systems[tabNum] || systems[1];
  const content = listingContext
    ? `Listing context: ${listingContext}\n\nUser input: ${userMessage}`
    : userMessage;

  // User profile data included in prompt - covered under privacy policy section 4
  const message = await callClaude({
    max_tokens: 2500,
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
  const systemPrompt = `You are an expert at decoding landlord and rental agent messages in the Netherlands and writing perfect replies for expat tenants. Return a JSON object with exactly these keys:
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

module.exports = { generateLetter, generateLetterDirect, generatePackageDirect, getAITip, generateBuyerLetterDirect, generateBidAdviceDirect, generateLeaseReviewDirect, generateNegotiateDirect, generateRentAssistantResponse, generateBuyAssistantResponse, modifyLetterDirect, generateLandlordReplyDirect, generateRejectionAnalysisDirect, generateReferenceLetterDirect, generateIncomeExplainDirect, generateViewingFeedbackDirect, generateTenantRightsAnswerDirect, generateDealExplainDirect, generateOverbidLetterDirect, generateInspectionAdviceDirect, generateErfpachtAnalysisDirect, generateAgentScriptDirect, STYLE_LABELS };
