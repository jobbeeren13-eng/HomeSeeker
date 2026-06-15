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
    .replace(/—/g, '')
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

[Paragraph 1: Who you are, your employment, income mentioned once naturally. 2-3 sentences.]

[Paragraph 2: Why this specific property or location. Show you read the listing. 2 sentences.]

[Paragraph 3: Practical: move-in availability, long-term intention, documents ready. 2 sentences.]

Kind regards,
[First name]

Absolute rules:
- English only
- Separate every paragraph with a blank line (two newlines)
- No dashes anywhere
- No markdown or bold text
- Never use: reliable, responsible, delighted, ideal, perfect, pleased, I hope, I would love, I am writing to
- Mention income once only
- NEVER invent or assume any details not explicitly provided in the user profile
- NEVER mention an employer name unless it appears in the user description
- NEVER mention a guarantor unless explicitly stated in the user profile
- If information is missing, leave it out — do not guess or fabricate
- Max 150 words
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
  lines.push(`Write naturally. No AI phrases. No dashes. Max 150 words. Use the exact structure from the system prompt.`);
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
    1: `You are an expert Dutch rental market coach for expats. Given a listing and the user's situation, respond with exactly these sections using ## headers:

## Application Strategy
2-3 sentences on overall approach for this specific listing.

## First Contact Message
Exact script for a short punchy first message to the landlord, max 4 sentences. Not a formal letter — a direct, warm intro.

## Documents to Attach (in order)
Bullet list of what to attach and in what order, with one-line reason for each.

## Red Flags to Watch
Any concerns or unusual things in this listing the user should know.

## Match Assessment
Honest X/10 match score with 2-sentence explanation based on their profile.

Plain English. No em dashes. Max 450 words total.${userProfile}`,

    2: `You are a Dutch property viewing expert for expats. Generate a complete viewing preparation guide with exactly these sections:

## 10 Questions to Ask
Numbered list. Make questions specific to the listing type and price range mentioned.

## What to Check Physically
Bullet list: damp signs, heating type, insulation label, service costs included or not, VvE if apartment, who manages property.

## What to Bring
Short bullet list.

## How to Stand Out
What to say, how to present yourself, specific signals that show you are a serious tenant.

## Viewing Score Sheet
Simple table: Item | OK | Notes. Include 8 items relevant to this property.

Plain English. No em dashes. Max 500 words.${userProfile}`,

    3: `You are a Dutch rental negotiation expert. Given the situation, provide word-for-word negotiation guidance:

## Is Negotiation Realistic?
Honest 2-sentence assessment — Dutch market context, when landlords negotiate and when they don't.

## What to Say
Word-for-word scripts for the specific goal (lower rent, furnishings, longer lease, etc.).

## What NOT to Say
3-4 specific phrases or approaches that will backfire in the Dutch rental market.

## Follow-Up Email
Complete ready-to-send email template. Professional, direct, max 120 words.

Plain English. No em dashes. Max 500 words.${userProfile}`,

    4: `You are a Dutch tenant law expert. Analyse the provided lease text and respond with:

## Summary
What this lease covers in plain English, 2-3 sentences.

## Clause Analysis
For each major clause: what it means + whether it is Standard / Unusual / Concerning. Use - prefix for each.

## Tenant Rights
Any Dutch law rights (BW Book 7) that override unfair clauses found. If none, say so.

## Lease Health Score
X/10 with 2-sentence justification.

## Negotiate or Change Before Signing
Specific bullet list of things to ask the landlord to amend.

Plain English. No em dashes. Max 600 words.${userProfile}`,

    5: `You are a Dutch move-in expert. Generate a complete move-in guide based on the property type and rooms provided:

## Room-by-Room Inspection
For each room: specific items to check and document. Include: kitchen, bathroom, bedroom(s), living room, hallway, storage.

## Photo Log Instructions
What to photograph, how to name files (format: room-item-date), where to store and send them.

## Day-1 Utilities Setup
Gas, water, electricity, internet — Dutch providers, typical costs 2024, how and where to register.

## Municipality Registration
Gemeente BRP registration: required documents, how to book appointment, timeline (must be done within 5 days).

## Inspection Report Email
Complete template email to send to the landlord within 24 hours documenting the property condition.

Plain English. No em dashes. Max 600 words.${userProfile}`,
  };

  const system = systems[tabNum] || systems[1];
  const content = listingContext
    ? `Listing context: ${listingContext}\n\nUser input: ${userMessage}`
    : userMessage;

  const message = await callClaude({
    max_tokens: 2000,
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
    1: `You are a Dutch mortgage and affordability expert for expats. Given the user's financial situation, provide:

## Maximum Mortgage Estimate
Calculation: gross annual income x 4.5 (adjust down for temporary contract / self-employed / foreign income). Show the math.

## Recommended Purchase Price Range
Conservative range (80-90% of max mortgage + own funds).

## Required Own Funds
Transfer tax (2% or 10.4% depending on situation), notary ~€1,500, mortgage advisor ~€3,000, valuation ~€800. Total.

## Mortgage Types
Annuity vs linear: which suits this buyer and why.

## Red Flags for Expats
Probation period, temporary contract issues, foreign income complications, 30% ruling effects.

## Do You Need a Mortgage Advisor?
Yes/no and why.

Plain English. No em dashes. Max 500 words.${userProfile}`,

    2: `You are a Dutch property analyst for expats. Analyse the property based on listing details.

${PRICE_BENCHMARKS}

## Price per m2 Analysis
Calculate price/m2. Compare to benchmarks above for the city and property type. Verdict: fair / high / low.

## What the Listing Signals
3-5 observations from the description: motivated seller, overpriced, needs work, strong demand signals, etc.

## Recommended Maximum Bid
Suggested max bid with reasoning (market, condition, competition signals).

## Questions to Ask the Agent
8 specific questions for this property type and price range.

## What to Check at Viewing
Structural concerns, VvE for apartments (monthly costs, reserve fund, active), energy label, ground lease (erfpacht) warning, parking.

Plain English. No em dashes. Max 500 words.${userProfile}`,

    3: `You are a Dutch real estate bid strategy expert for expats. Given the bid situation, provide:

## Bid Recommendation
Specific amount with reasoning. Whether to bid above asking and by how much.

## Conditions to Include
Financing clause (voorbehoud financiering) and building inspection (bouwkundige keuring) — when to include, when to waive.

## Exact Bid Letter Wording
Complete text for a short professional bid letter or verbal statement to the agent.

## What Happens After You Bid
Timeline: what the agent does, how counter-offers work, typical response time.

## Common Expat Mistakes at This Stage
3-4 specific mistakes expats make when bidding in the Netherlands.

Plain English. No em dashes. Max 500 words.${userProfile}`,

    4: `You are a Dutch property purchase legal expert for expats. Answer the user's question about the specific step in the buying process.

The 6 steps are:
1. Bid accepted - 3-day cooling off, verbal vs written agreement
2. Financing condition (voorbehoud financiering) - getting mortgage offer in time
3. Building inspection (bouwkundige keuring) - when, how, what to look for
4. Preliminary purchase agreement (voorlopig koopcontract) - what to check before signing
5. Notary appointment - documents, what happens, what you sign
6. Key handover - what to inspect, what to register

For the step and question asked, provide:

## What Happens at This Step
Plain English explanation of the process.

## What You Must Do
Specific action items with deadlines.

## Common Mistakes
2-3 things expats get wrong here.

## Questions to Ask
3-4 questions to ask your agent or notary at this point.

Plain English. No em dashes. Max 400 words.${userProfile}`,

    5: `You are a Dutch VvE (apartment owners association) expert for expats. Analyse the VvE situation described.

## What a VvE Is and Why It Matters
Brief explanation in plain English (2-3 sentences).

## VvE Assessment
Based on the info provided: is this VvE healthy, concerning, or unknown? Monthly costs reasonable? Reserve fund adequate?

## Red Flags
- Inactive or no VvE (illegal for buildings >2 units built after 1951)
- No reserve fund or fund below legal minimum (0.5% of reconstruction value per year)
- Major maintenance planned but not funded
- Building over 30 years with no recent major maintenance record
- Very low monthly contribution (suggests costs are being deferred)

## Questions to Ask Before Buying
8 specific questions about this VvE that the buyer must get answers to before signing.

## Notary vs Your Own Due Diligence
What the notary checks (title, mortgage, VvE registration) vs what you must verify yourself (reserve fund, minutes, pending decisions).

Plain English. No em dashes. Max 500 words.${userProfile}`,
  };

  const system = systems[tabNum] || systems[1];
  const content = listingContext
    ? `Listing context: ${listingContext}\n\nUser input: ${userMessage}`
    : userMessage;

  const message = await callClaude({
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content }],
  });

  return { response: sanitizeResponse(message.content[0].text) };
}

module.exports = { generateLetter, generateLetterDirect, generatePackageDirect, getAITip, generateBuyerLetterDirect, generateBidAdviceDirect, generateLeaseReviewDirect, generateNegotiateDirect, generateRentAssistantResponse, generateBuyAssistantResponse, STYLE_LABELS };
