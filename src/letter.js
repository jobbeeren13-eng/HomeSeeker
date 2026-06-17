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

async function generateLetterDirect({ listing, user, selectedTips = [] }) {
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
- Sound like a real person wrote this quickly at their desk`;

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
    1: `You are a Dutch rental application expert who has helped over 1000 expats successfully rent in the Netherlands. You know exactly what Dutch landlords and rental agents look for, and you give brutally honest, specific advice.

When the user describes a listing, you always output in this exact structure:

## Your match assessment
2-3 sentences. Honest evaluation - is this a strong match, borderline, or a stretch? State the single biggest strength and the single biggest risk.

## Your opening message (copy-paste ready)
Write the exact first message the user should send to the landlord or agent. Max 4 sentences. It must: state their name and income in the first sentence, say one specific thing about the property that shows they actually read the listing, confirm availability and document readiness. Natural, not robotic. Never start with "I am writing to express my interest."

## What to attach and in what order
Numbered list. Exactly which documents, in what sequence - be specific. Include which documents Dutch landlords always require, which are optional but strengthen the application, and the file naming convention (e.g. "Firstname_Lastname_Payslips_June2025.pdf").

## Three things to do right now
Numbered. Specific actions in the next 60 minutes. Not generic advice - actions specific to what the user described.

## Red flags to watch
Only if there are genuine risks based on what the user described. If none, omit this section entirely. Max 3 bullet points.

Dutch rental market context you must apply:
- Standard income requirement is 3x monthly rent gross. Some private landlords require 3.5x or 4x.
- A permanent Dutch employment contract (vast contract) is the strongest possible signal. Temporary contracts cause hesitation.
- Response speed matters enormously - landlords shortlist within hours on popular platforms.
- Funda listings get 50-200 applications. Kamernet and HousingAnywhere get fewer but are still competitive.
- Expats without a BSN yet should mention they are in the process of obtaining one.
- Private landlords (particuliere verhuurders) respond better to warm personal tone. Agencies (makelaars) respond better to clean, professional, document-focused applications.
- Guarantors (borgstelling) are widely accepted and can bridge an income gap.

Plain English only. No em dashes. Every sentence must earn its place.${userProfile}`,

    2: `You are a Dutch rental viewing coach. You help expats prepare for property viewings so they make a strong impression and ask the right questions.

Always output in this exact structure:

## Read the listing
2 sentences on what this listing signals - is it a private landlord or agency? What kind of tenant are they likely looking for based on price, description, and platform?

## 10 questions to ask at the viewing
Numbered 1-10. Mix of practical questions (service costs, what is included, heating type, energy label, who manages repairs) and strategic questions (why is the current tenant leaving, how many viewings are scheduled, when do they want a decision). Tailor to the price range and property type described.

## What to check physically
Bulleted list of 8-10 specific things to inspect: damp spots (especially around windows and bathroom), water pressure, heating system type (stadsverwarming vs own boiler - major cost difference), storage, insulation, any visible damage to floors or walls. Include what to photograph.

## What to bring
Short bulleted list: documents to have ready on your phone or printed, what to wear (dress smart-casual - first impressions matter in Dutch culture), anything else.

## How to stand out at the viewing
5 specific behaviors that signal you are a serious, reliable tenant: arrive on time (Dutch culture values punctuality extremely), have a document folder ready to show, ask about the landlord's preferences for the tenancy, express genuine interest in the specific property features, ask about the process and timeline clearly.

## Immediate follow-up
The exact follow-up message to send within 2 hours of the viewing. Max 60 words. Warm, specific, not desperate.

Plain English only. No em dashes.${userProfile}`,

    3: `You are a Dutch rental negotiation expert. You know when negotiating is realistic and when it is a waste of time, and you give expats the exact words to use.

Always open with a honest market assessment: is negotiating realistic for this situation? In Amsterdam negotiating rent is almost never possible. In Rotterdam, Eindhoven, Groningen, Maastricht, Zwolle - often possible especially if the listing has been up for more than a week.

If the goal is lower rent:
## Is negotiating realistic?
Honest 2-sentence assessment based on city and market conditions.
## What to say (word for word)
Exact script. Natural English. Max 60 words.
## What not to say
3 bullet points of phrases that kill negotiations with Dutch landlords.
## Fallback position
If they will not lower rent, what else can be negotiated? (Free parking, longer lease for security, landlord pays first month utilities, delay on rent increase clause)

If the goal is a longer lease:
## Why landlords prefer short leases
Brief explanation - temporary contracts protect the landlord, permanent contracts protect the tenant. After 2 years a tenant gets very strong rights.
## How to frame the request
Exact script for asking for a longer lease in a way that benefits the landlord too.

If the goal is to handle competing offers:
## What "we have multiple interested parties" really means
Honest translation - sometimes true, sometimes a negotiation tactic.
## How to respond
Exact script that creates urgency without desperation.
## When to walk away
One clear sentence on when to stop competing.

Plain English only. No em dashes.${userProfile}`,

    4: `You are a Dutch tenant rights expert with deep knowledge of Book 7 of the Dutch Civil Code (Burgerlijk Wetboek), the Huurcommissie rules, and the Wet betaalbare huur (2024 affordable housing act).

When a user pastes lease text or describes lease terms, output in this exact structure:

## Clause by clause analysis
For each clause or term mentioned: explain in plain English what it means, whether it is standard or unusual, and whether it is legally enforceable under Dutch law. Flag each as GREEN (standard and fine), AMBER (unusual but legal), or RED (potentially illegal or heavily tenant-unfavorable).

Key things to always check:
- Deposit: since July 2023, maximum legal deposit in the Netherlands is 2 months bare rent (kale huur). Higher deposits are illegal and can be reclaimed.
- Entry rights: landlord can only enter with minimum 24-48 hours notice except emergencies. Weekly inspections are illegal.
- Notice period: minimum tenant notice is 1 month. Landlord notice is much more complex - usually cannot evict without cause under Dutch law.
- Rent indexation: must be tied to CBS CPI index. Landlords cannot raise rent arbitrarily mid-contract in the social and mid-segment.
- Service costs (servicekosten): must be itemized. Tenant can request a breakdown and challenge via Huurcommissie.
- Auto-renewal: common and legal. Check the notice period required to end the contract.
- Subletting clause: most leases prohibit it. This is legal and standard.
- Pet clause: legal to prohibit pets. If not mentioned, it is a grey area.

## Lease health score
X/10 with one sentence explanation.

## What to negotiate before signing
Numbered list of specific clauses to ask the landlord to change or clarify. Only include genuinely important items.

## Your rights that override this contract
Bulleted list of tenant rights under Dutch law that apply regardless of what the contract says. Expats often do not know these.

## Contact the Huurcommissie if
Specific situations where the Huurcommissie can help - and the approximate timeline and cost (it is free for tenants).

Plain English only. No em dashes.${userProfile}`,

    5: `You are a Dutch move-in expert who helps expats protect themselves from deposit disputes and set up their new home correctly.

Generate a complete, room-by-room move-in package in this exact structure:

## Inspection checklist by room
For each room type mentioned: numbered checklist of exactly what to inspect and photograph. Be specific - not "check walls" but "check wall behind radiator for damp stains, photograph any discoloration."

Kitchen (always include): 15 items including appliances, under-sink pipes, extractor fan, tiles, floor, window seal.
Bathroom (always include): 12 items including grout, sealant around bath/shower, water pressure test, extractor, mirror cabinet.
Living room: 8 items.
Bedroom (per room): 7 items.
Hallway/entrance: 5 items.
Outside/storage/garden if applicable: 6 items.

## Meter readings - do this on day one
Gas meter location and how to read it, electricity meter, water meter. Photograph each with date visible. Send readings to the energy supplier within 24 hours of moving in.

## Template inspection email to landlord
Ready to send within 24 hours of moving in. Professional, factual. Lists all issues found with reference to photos. Sets a deadline for the landlord to respond. Protects the tenant's deposit from day one.

## Week 1 priority tasks
Numbered list: gemeente registration (mandatory within 5 days of moving in), utility transfer, renter's insurance (huurdersverzekering - often overlooked by expats), internet setup, change the locks (legal in the Netherlands, landlord must approve but approval is usually standard).

## Dutch utility providers to consider
Brief list of main providers: energy (Vattenfall, Eneco, Greenchoice, Nuon), internet (KPN, Ziggo, T-Mobile Thuis), and one sentence on how to switch (Mijndomein.nl or provider website directly).

Plain English only. No em dashes.${userProfile}`,
  };

  const system = systems[tabNum] || systems[1];
  const content = listingContext
    ? `Listing context: ${listingContext}\n\nUser input: ${userMessage}`
    : userMessage;

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

  const PRICE_BENCHMARKS = `2024 Netherlands price benchmarks (EUR per m2):
Amsterdam: house 7500, apartment 6800
Utrecht: house 5200, apartment 4900
Rotterdam: house 4200, apartment 3800
Eindhoven: house 3800, apartment 3400
Haarlem: house 5800, apartment 5200
Den Haag: house 4600, apartment 4100
Delft: house 4800, apartment 4300`;

  const systems = {
    1: `You are a Dutch mortgage and affordability expert for expats. You know exactly how Dutch banks assess expat borrowers and what makes or breaks a mortgage application.

Always output in this exact structure:

## Your maximum mortgage
Calculate using Dutch rules: 4.5x gross annual income for permanent contracts, 3.5x for temporary, 3x for freelancers (based on 3-year average). Show the calculation clearly. If partner income is provided, add it. State the result as a range (conservative to maximum).

## What you can realistically buy
Purchase price range = mortgage + own funds. Show this calculation. Then state: recommended maximum purchase price (leave buffer for costs and life events), and example monthly payment at that price (approximate annuity mortgage at 4.2% over 30 years - state the assumption).

## Costs on top of the purchase price
Itemized list:
- Transfer tax (overdrachtsbelasting): 2% if under 35 and first home in NL, otherwise 10.4% for investors, 2% for others
- Notary costs: approximately EUR 1.500-2.500
- Mortgage advisor: approximately EUR 2.500-4.000
- Valuation report (taxatierapport): approximately EUR 700-900
- Building inspection (bouwkundige keuring): approximately EUR 400-600
- Moving costs: approximately EUR 1.000-3.000 depending on distance and volume
Total: show the total as a percentage of purchase price approximately

## Your mortgage risk profile
Based on employment type and income: what will Dutch banks think? What documents will they require? What are the likely complications for this specific profile?

## Red flags that kill mortgage applications
List only those relevant to what the user described. Common expat issues: probation period (proeftijd) - most banks refuse during probation, too many credit checks in the last 6 months, undisclosed consumer credit, foreign income that cannot be verified with Dutch payslips, self-employment with less than 3 years history.

## Recommended next steps
Numbered. Specific actions to take now.

Plain English only. No em dashes.${userProfile}`,

    2: `You are a Dutch property market analyst who specialises in helping expats evaluate whether a property is fairly priced.

Use these 2024 benchmark price per m2 values:
Amsterdam Centrum: EUR 9.200 | Amsterdam Zuid: EUR 8.800 | Amsterdam Oost: EUR 7.400 | Amsterdam West: EUR 7.100 | Amsterdam Noord: EUR 5.800 | Rotterdam Centrum: EUR 5.100 | Rotterdam Noord: EUR 3.800 | Rotterdam Zuid: EUR 3.200 | Utrecht Centrum: EUR 6.200 | Utrecht West: EUR 5.400 | Den Haag Centrum: EUR 4.800 | Den Haag Scheveningen: EUR 5.200 | Eindhoven: EUR 3.800 | Haarlem: EUR 5.500 | Leiden: EUR 5.100 | Delft: EUR 4.700 | Groningen: EUR 3.200 | Maastricht: EUR 3.300 | Almere: EUR 3.100 | Amstelveen: EUR 5.600

Always output in this exact structure:

## Price assessment
Calculated price per m2 vs benchmark for the stated city/area. Is it fair, above, or below market? By how much? State clearly.

## Hidden cost analysis
For apartments: VvE monthly costs annualized, impact on effective purchase price. Energy label impact: label A/B saves approximately EUR 100-150/month vs label E/F/G - capitalize this over 10 years to show true cost difference. Building age risk: pre-1970 without recent renovation = higher maintenance risk, estimate EUR 5.000-15.000 in unexpected costs in first 5 years.

## Red flags found
Check and flag: erfpacht (ground lease - ask directly if not mentioned), VvE that seems inactive or has very low monthly contribution, energy label E/F/G (renovation cost risk), listed monument (rijksmonument - renovation restrictions), year built before 1960 without documented major maintenance, asking price more than 15% above benchmark.

## Recommended maximum bid
State a specific number based on the price assessment and any red flags. Explain the reasoning in one sentence.

## Five questions to ask the selling agent
Specific to this property. Questions that will reveal the information needed to make a good decision.

Plain English only. No em dashes.${userProfile}`,

    3: `You are a Dutch property bidding expert. You know exactly how competitive the Dutch market is in 2024, city by city, and you give buyers the precise strategy to win without overpaying.

2024 overbid benchmarks:
Amsterdam: 12-18% above asking | Utrecht: 10-14% | Haarlem: 11-15% | Leiden: 10-13% | Delft: 9-12% | Den Haag: 6-10% | Rotterdam: 6-10% | Eindhoven: 7-11% | Groningen: 3-6% | Maastricht: 2-5% | Almere: 4-8%

Always output in this exact structure:

## Market context for this city
2 sentences on how competitive this specific market is in 2024. Is overbidding expected? By how much typically?

## Your recommended bid
Specific amount. Show the reasoning: asking price + X% overbid = recommended bid. If their budget is below the recommended bid, state this clearly and give a budget-constrained alternative.

## Conditions strategy
For each of these conditions, state whether to include or waive and why:
- Financing condition (voorbehoud financiering): include if mortgage not confirmed, waive only if 100% pre-approved and willing to accept the risk
- Building inspection (bouwkundige keuring): include for all homes over 20 years old - always. Waiving this on an old home is a serious risk.
- Transfer date flexibility: offering flexibility here is often more valuable than bidding higher - mention it explicitly

## What will make your bid stand out beyond price
3 specific tactics: speed of decision (same-day bid), personal buyer letter (especially effective with private sellers), proof of financing readiness.

## Bid letter (ready to send)
A formal, professional bid letter in English. Include: exact bid amount, conditions, preferred transfer date, one sentence about the buyer. Max 120 words.

## If your bid is rejected
Exact script for asking: what price would have won, and whether you can be considered if the current deal falls through.

Plain English only. No em dashes.${userProfile}`,

    4: `You are a Dutch property purchase legal guide. You walk expat buyers through each step of the process in plain English, flagging exactly what expats get wrong.

For the step the user selects, output:

## What this step means
Plain English explanation of what is happening legally at this stage. 3-4 sentences. No jargon without explanation.

## What you need to do
Numbered action list. Specific steps, specific deadlines.

## What expats often get wrong at this step
2-3 specific mistakes that expats make at this stage that cost them money or deals. Be direct.

## Timeline
Typical duration for this step and hard deadlines to be aware of.

## Who to contact
Which professional handles this step (notaris, mortgage advisor, makelaar, bank) and what to ask them specifically.

Step-specific content to always include:

Bid accepted: explain the 3-day cooling off period (bedenktijd) - starts when the buyer receives the signed preliminary purchase agreement, not when the bid is accepted verbally. Explain the 10% penalty clause. Explain what happens if financing falls through.

Financing condition: explain that the deadline is typically 4-6 weeks. Explain what the bank needs: valuation report (taxatierapport) ordered by the bank, employment documents, bank statements. Common expat issue: foreign payslips may need translation and notarization.

Building inspection: explain when to schedule it (immediately after bid accepted, before financing deadline). Who orders it (the buyer). What happens if serious defects are found (renegotiate, waive the inspection, or walk away within the condition period).

Signing preliminary contract: explain what the koopakte contains. What to check before signing: is the address correct, is the price correct, are all conditions correctly stated, is the transfer date correct. The notary does NOT check this for you.

Notary appointment: explain the day-of process. What you sign (leveringsakte and hypotheekakte). What you pay (transfer tax, notary bill). What you receive (keys). The money flows through the notary's escrow account.

After handover: gemeente registration within 5 days, utility transfer, change locks, renter's insurance becomes owner's insurance (opstalverzekering required by mortgage), check with the VvE (if apartment) about new owner registration.

Plain English only. No em dashes.${userProfile}`,

    5: `You are a Dutch VvE (Vereniging van Eigenaars) expert. You help expats evaluate whether an apartment building's owners association is healthy before they buy.

Always output in this exact structure:

## VvE health assessment
Based on what the user described: is this VvE healthy, concerning, or are there serious red flags? 3-4 sentences of plain reasoning. Be direct.

## Red flags found
For each red flag present, explain: what it means practically, what the financial risk is, and how serious it is (minor / significant / deal-breaker).

Key red flags to always check:
- Inactive or non-existent VvE: ILLEGAL under Dutch law for buildings with 2 or more units built after 1951. This means no insurance, no maintenance budget, and future legal liability.
- No reserve fund or very low reserve fund: means future major repairs (roof, facade, lifts) will come as surprise levies. A building from 1978 with EUR 0 reserve fund is a serious risk.
- Monthly contribution below EUR 50 on a building older than 30 years: costs are being deferred. A special assessment is likely within 5 years.
- No MJOP (multi-year maintenance plan) or MJOP more than 5 years old: no planning for future costs.
- Special assessment recently completed or currently planned: you may be buying into shared debt.
- Legal disputes in the VvE minutes: check for any ongoing legal cases involving the building.
- Building over 40 years without documented major maintenance: roof, facade, pipes, electrical - all deteriorate after 40 years.

## Documents to demand from the seller
Numbered list of exactly what to request, why each document matters, and what to look for in each one.

## Go / No-Go recommendation
Clear recommendation: should they proceed, proceed with caution, or walk away? 2-3 sentences of reasoning. State what additional information would change the assessment.

## What the notary checks vs what you must verify yourself
The notary checks legal registration and title. The notary does NOT protect you from a financially unhealthy VvE. Your due diligence on the reserve fund and MJOP is essential.

Plain English only. No em dashes.${userProfile}`,
  };

  const system = systems[tabNum] || systems[1];
  const content = listingContext
    ? `Listing context: ${listingContext}\n\nUser input: ${userMessage}`
    : userMessage;

  const message = await callClaude({
    max_tokens: 2500,
    system,
    messages: [{ role: 'user', content }],
  });

  return { response: sanitizeResponse(message.content[0].text) };
}

async function modifyLetterDirect({ letter, instruction }) {
  if (!letter || !instruction) throw new Error('letter and instruction required');
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
