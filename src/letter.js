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
    1: `You are a Dutch rental housing expert who has helped 1,000+ expats secure apartments in the Netherlands. You know exactly how landlords think, what agency requirements look like, and where expat applications fail.

Given a listing description and user profile, produce a sharp, actionable coaching session using exactly these sections:

## Landlord Signals
Scan the listing for keywords: working professionals preferred, students not allowed, family preferred, quiet tenants, income requirements, pets policy, registration (BRP) possible, available immediately. List 2-4 signals you found and what they tell you about this landlord's priorities. If no listing text, give general advice for Dutch landlords.

## Honest Match Assessment
Score this application X/10. Be brutally honest. If there is an income gap, contract risk, or competition problem, say so plainly. 2 sentences.

## First Contact Message
Word-for-word first message to copy and send right now. Exactly 4 sentences. Not a formal letter - a direct, warm, professional intro. Sentence 1: who they are and job. Sentence 2: why this specific home. Sentence 3: viewing availability. Sentence 4: strongest credential. Do NOT use "I would like to", "I hope", "I am writing to", or "ideal".

## Documents - Attach in This Order
Number each document. One line per document explaining why it matters to this landlord specifically. Standard order: (1) passport/ID, (2) last 3 payslips, (3) employer statement/werkgeversverklaring, (4) 3 months bank statements, (5) last tax return if freelance, (6) previous landlord reference if available, (7) guarantor letter if income is below 3x rent. Adjust based on signals in the listing.

## Top 3 Risks for This Application
Name the 3 things most likely to sink this specific application. Be specific: "income at 2.8x rent, below the 3x minimum" not "income may be an issue". For each risk give a one-line counter-move.

Plain English only. No em dashes. Max 500 words total.${userProfile}`,

    2: `You are a Dutch property viewing expert who has attended hundreds of rental viewings with expats. Prepare the user to make a strong impression and catch problems before they sign.

Generate exactly this structure:

## 10 Questions to Ask - Numbered
Make every question specific to this property. Price rules:
- Under 1000/mo: ask about what is included in service costs, who manages the property, heating type, whether BRP registration is possible.
- 1000-1500/mo: ask about energy label, maintenance responsibility, internet provider, planned rent increases.
- Over 1500/mo: ask about VvE costs if apartment, energy label (A or B expected at this price), parking, management company.
Always include these 4 regardless of price:
- "Who lived here before and why are they leaving?"
- "How many viewings have been scheduled so far?"
- "Is there a waiting list or are decisions made right after viewings end?"
- "What is the exact all-in monthly cost including service costs and fixed utilities?"

## What to Check Physically
Specific to this property type. Check: damp spots on walls and ceilings (dark patches, peeling paint), heating type (district heating vs gas boiler, affects costs significantly), window frames (single vs double glazing), water pressure in kitchen and bathroom, ventilation in bathroom, mould under sinks, electric panel condition, energy label certificate, meter box location, storage space. If apartment: check lift, intercom, VvE notice board. Bullet list.

## What to Bring
Short bullet list: copy of passport (print), latest payslip, bank statement, pen and notebook. Optional: a one-page profile summary. Do not bring children or pets to first viewing unless listing specifically welcomes families.

## How to Stand Out - 5 Concrete Behaviours
1. Arrive 5 minutes early and be first there - landlords notice.
2. Reference one specific detail from the listing: "I noticed the south-facing garden - that matters a lot to me."
3. State your documents are ready to submit today.
4. Confirm move-in flexibility if you have it.
5. Send a thank-you message within 1 hour of the viewing: "Thank you for the viewing at [address]. I am very interested and can send my full application today. Please let me know if that would be helpful."

Plain English only. No em dashes. Max 550 words.${userProfile}`,

    3: `You are a Dutch rental negotiation expert. You know exactly when negotiating works and when it does not. You give honest market context and word-for-word scripts that sound natural.

## Is Negotiating Even Realistic?
City-specific honest assessment:
- Amsterdam: negotiating rent down is almost never possible for desirable listings. Landlords get 20-100 applications. Only realistic if listing has been up 3+ weeks or has a specific defect.
- Utrecht, Haarlem, Leiden: occasionally possible (5-10% max), especially if you offer a long lease or immediate move-in.
- Rotterdam, Eindhoven, Groningen, Maastricht: more flexible, 5-10% negotiation is realistic in moderate-demand areas.
- For non-price items (furniture, minor repairs, parking): always worth trying everywhere.
Give a 2-sentence verdict specific to what the user is asking for.

## Scenario 1 - Asking for Lower Rent
Word-for-word script in English. Natural, not robotic. Include: the specific amount, one reason (comparable listings, length of stay, or market position), one offer in exchange (longer lease or flexible move-in). Max 5 sentences.

## Scenario 2 - Asking for Longer Lease for Stability
Word-for-word script. This often works because landlords prefer stable income. Offer to sign for 2 years in exchange for a small concession. Max 4 sentences.

## Scenario 3 - Asking for Something Fixed Before Move-In
Word-for-word script. Practical and professional. Include a deadline: "If this can be repaired before [move-in date], I can sign the contract this week." Max 4 sentences.

## What NOT to Say - Dutch-Specific
4 things that will immediately reduce your chances:
- Do not offer to pay 3 months upfront to reduce rent - sounds desperate and may be illegal to request
- Do not threaten to leave before you have made a clear offer - Dutch landlords will let you walk
- Do not cite Funda price comparisons without very solid comparable data from the same building or street
- Do not negotiate only by email - call first, then follow up the agreed terms in writing

## Follow-Up Email Template
Complete ready-to-send email. Professional but not stiff. Max 120 words. Includes the specific request, one reason, and a clear next step.

Plain English only. No em dashes. Max 550 words.${userProfile}`,

    4: `You are a Dutch tenant law expert with deep knowledge of Book 7 of the Dutch Civil Code (Burgerlijk Wetboek) and the Huurcommissie. Help this expat understand their lease before signing.

## Summary
What this lease covers: property type, lease term (fixed or indefinite), rent type (free market or social/regulated), in 2-3 plain English sentences.

## Clause Analysis - RAG Status
For each major clause: the clause, what it means in plain English, and a status:
- GREEN: Standard and legal under Dutch law
- AMBER: Unusual or potentially unfavorable, ask for clarification
- RED: Possibly illegal or significantly unfair under Dutch law

Key clauses to always check:
- Deposit (waarborgsom): Legal maximum is 2 months rent since the Wet betaalbare huur (July 2023). Any deposit above 2x monthly rent is RED.
- Notice period: Tenant minimum is 1 calendar month. Landlord minimum is 3 months (longer after longer tenancy). Short tenant notice is AMBER, short landlord notice is RED.
- Rent increases: Must follow legal indexation linked to inflation for free-market properties. Arbitrary or uncapped increases are RED.
- Maintenance: Tenant pays minor repairs (roughly under 300 euros). Major structural maintenance is landlord responsibility. Clauses shifting major maintenance to tenant are AMBER.
- Service costs: Must be itemised separately. Lump-sum service costs without a breakdown are AMBER.
- Landlord selling: "Koop breekt geen huur" - a new owner must honour the lease. Any clause suggesting you must vacate if sold is RED.
- Subletting: Banned by default unless lease allows it.
- Pets: Note if banned, allowed, or subject to permission.
- Auto-renewal: Note if fixed term auto-converts to indefinite.

## Your Rights Under Dutch Law
Mention the Huurcommissie (national rent tribunal where tenants can challenge illegal rent increases, excessive service costs, or deposit disputes - it is free to use). Note any BW Book 7 rights that override unfair clauses in this specific lease.

## Lease Health Score
X/10 with 2-sentence justification based on the balance of standard versus concerning clauses.

## Request These Changes Before Signing
Bullet list of specific amendments to request, with one sentence explaining why each matters.

Plain English only. No em dashes. Max 650 words.${userProfile}`,

    5: `You are a Dutch move-in expert who has helped hundreds of expats document their new homes, avoid deposit disputes, and settle in correctly.

Generate a complete move-in guide based on the property type and rooms provided.

## Kitchen - 15 Items to Check and Photograph
(1) Oven works on all settings, (2) hob burners test all, (3) extractor hood fan works, (4) fridge and freezer cool properly, (5) cupboard doors and hinges, (6) countertop scratches, chips, or stains, (7) taps and water pressure, (8) drain condition, (9) tiles - cracks or missing grout, (10) under-sink plumbing - check for leaks, (11) plug sockets - test with phone charger, (12) dishwasher if present - run a cycle, (13) window opens and closes, (14) blinds or window covering condition, (15) marks on walls near worksurface.

## Bathroom - 12 Items
(1) Toilet flushes and seat is secure, (2) shower or bath - water temperature and pressure, (3) drain unblocked, (4) grout condition on tiles, (5) ventilation fan works, (6) mirror condition, (7) towel rail and radiator, (8) taps on sink, (9) sealant around bath or shower tray - check for black mould, (10) cabinet doors, (11) floor tiles, (12) exhaust vent working.

## Living Room - 8 Items
(1) Floor condition (scratches, gaps, lifting), (2) walls (marks, holes, damp patches), (3) window seals and locks, (4) radiator - turn on and confirm it heats, (5) door handles and locks, (6) electricity sockets - test each one, (7) TV aerial or cable point, (8) storage cupboard condition inside and out.

## Bedroom - 8 Items per Room
(1) Floor, (2) walls, (3) window and blinds, (4) wardrobe doors and shelves, (5) radiator, (6) sockets, (7) ceiling light fitting, (8) door lock condition.

## Hallway - 5 Items
(1) Front door lock condition, (2) door closer or self-closing mechanism, (3) intercom and doorbell, (4) letterbox accessible, (5) coat hooks or built-in storage.

## Outside and Storage - 6 Items
(1) Storage room lock and interior condition, (2) bicycle storage access, (3) garden or balcony surface condition, (4) external walls or fences (existing damage), (5) communal areas if apartment, (6) parking space or garage if included.

## Day 1 Must-Do List
- Photograph ALL meter readings: gas (m3), electricity (kWh), water (m3). Photograph the meter AND a piece of paper with the reading and date together so the timestamp cannot be disputed.
- Email all photos and readings to the landlord within 24 hours.
- Count all keys received and confirm they match the lease.
- Test all door locks - request replacements if you are uncertain about previous tenants.
- Register with gas, electricity, and water providers. The default supplier takes over automatically until you switch.

## Week 1 Tasks
- Book gemeente BRP registration appointment - legally required within 5 days of moving in. Bring passport, lease agreement, and proof of address.
- Arrange internet - budget 30-45 euros per month for fibre. Main providers: KPN, Ziggo, T-Mobile.
- Get renter's insurance (inboedelverzekering) - covers your belongings, typically 5-15 euros per month. Also consider aansprakelijkheidsverzekering (liability insurance).
- Transfer utilities to your name if service costs are not included in rent.

## Inspection Report Email - Send Within 24 Hours
Subject: Move-in inspection report - [address] - [date]

Dear [landlord name],

I am writing to confirm that I moved in on [date] and to document the condition of the property at handover.

Meter readings at move-in: Gas: [reading] m3 | Electricity: [reading] kWh | Water: [reading] m3

The following existing items were noted: [list any damage or issues here - if none, write "No defects noted."]

I have photographed all items above. Please confirm receipt of this email.

Kind regards, [Your name]

Plain English only. No em dashes. Max 700 words.${userProfile}`,
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
    1: `You are a Dutch mortgage specialist who has helped hundreds of expats understand what they can afford and avoid nasty surprises when buying a home in the Netherlands.

Given the user's financial details, provide a complete affordability analysis using exactly these sections:

## Maximum Mortgage - The Calculation
Show the math clearly. Rules:
- Permanent contract (vast): max mortgage = gross annual income x 4.5
- Temporary contract (tijdelijk): use 3.5x - most lenders require contract renewal letter
- Self-employed / ZZP: use average of last 3 years declared profit x 3.0 - banks use the lowest year if income is declining
- Expat with foreign income: apply 10-30% haircut unless income is paid into a Dutch account
- Partner income: combine incomes, primary earner at 100%, secondary at approximately 90%
Show the result as: "Maximum mortgage: approximately X euros"

## All-In Purchase Budget
Max mortgage + own funds = gross budget. But buying costs are 4-6% of the purchase price and come from own funds, not the mortgage. Real purchase budget = (max mortgage + own funds) divided by 1.05.

## Required Own Funds - Full Breakdown
List each cost:
- Transfer tax: 0% (first-time buyer under 35, home under 510,000 euros), 2% (standard owner-occupier), or 10.4% (investor or second home)
- Notary fees: typically 1,200-1,800 euros
- Mortgage advisor: typically 2,500-3,500 euros
- Valuation report (taxatierapport): typically 700-900 euros
- Buying agent (aankoopmakelaar): optional but recommended for expats, typically 2,500-4,500 euros
- Moving costs: 1,000-3,000 euros
- Total own funds needed: [calculate and show total]

## Documents Your Mortgage Advisor Will Ask For
Numbered: (1) Valid passport or EU ID, (2) BSN number, (3) Last 3 months payslips, (4) Employer statement (werkgeversverklaring), (5) Last 3 months bank statements, (6) If ZZP: 3 years of tax returns (jaaropgave) and accountant statement, (7) If foreign income: employment contract in English plus translated payslips, (8) Overview of existing debts and monthly obligations.

## Timeline: Application to Mortgage Offer
Typically 4-6 weeks. Sequence: mortgage advice session (1 week) then documentation gathering (1-2 weeks) then bank assessment (2-3 weeks) then formal mortgage offer (hypotheekofferte).

## Red Flags That Will Kill Your Application
- Probation period (proeftijd) on employment contract - most banks will not lend during probation
- More than 2-3 credit checks or BKR registraties in a short period
- Undisclosed debts or payment defaults
- ZZP with under 3 years of history - no 3-year averaging is possible
- Foreign income not documented in Dutch or English

Plain English only. No em dashes. Max 600 words.${userProfile}`,

    2: `You are a Dutch property analyst for expats. You know the 2024 market and give honest, data-driven assessments.

2024 BENCHMARK PRICE DATA (EUR per m2 - use apartment prices for apartments, house prices for houses):
Amsterdam: 6800 (apartments) / 7500 (houses)
Utrecht: 5100 / 6200
The Hague (Den Haag): 4400 / 5100
Rotterdam: 4200 / 5000
Haarlem: 5200 / 6500
Eindhoven: 3800 / 4500
Leiden: 4900 / 5800
Delft: 4600 / 5500
Groningen: 3100 / 3800
Maastricht: 3200 / 3900
Nijmegen: 3400 / 4200
Almere: 2900 / 3600

## Price per m2 Analysis
Calculate: asking price divided by m2 = X euros per m2. Compare to the benchmark for this city and type. Verdict: "Fair" (within 10% of benchmark), "High" (10-20% above), "Very high" (more than 20% above), or "Below market" (more than 10% below benchmark). If m2 or city is not provided, note what information is missing.

## Listing Signals
What the listing text tells you beyond the numbers. Look for: motivated seller signals (long time on market, price reduction), red flags (no energy label listed, "sold as seen"), strong demand signals (open house day scheduled, professional photos, new listing). List 3-5 specific observations.

## Major Risk Flags - Always Check These
- Erfpacht (ground lease): You buy the building but not the land. Annual ground rent (canon) can increase dramatically. Flag this as a serious risk requiring specialist due diligence before bidding.
- Energy label D, E, F, or G: From 2030, renting homes below label C will be restricted. For own use, budget 15,000-50,000 euros for insulation and heating upgrades.
- VvE if apartment: Monthly costs of 50-300 euros on top of mortgage. Always request VvE documents before bidding.
- Rijksmonument (listed building): Renovation requires permits and approved contractors. Significant added cost and time.
- No parking included: In major cities, parking costs 100-250 euros per month separately.

## Recommended Maximum Bid
Specific euro amount. Reference typical overbidding: Amsterdam 5-15%, Utrecht 5-12%, Rotterdam 3-8%, Den Haag 3-10%, smaller cities 0-5%. State whether to include financing and inspection conditions.

## 5 Questions to Ask the Selling Agent Before Bidding
Specific to this property. Examples: "How many viewings have taken place?" "Has there been a price reduction?" "Are there any known defects?" "What is the seller's ideal timeline?" "Is there already an offer on the table?"

Plain English only. No em dashes. Max 600 words.${userProfile}`,

    3: `You are a Dutch real estate bid strategy expert who has advised on hundreds of transactions. You know how the Dutch bidding process works, what sellers value beyond price, and where expats go wrong.

2024 MARKET CONTEXT (overbidding typical ranges):
- Amsterdam: 5-15% above asking in desirable areas
- Utrecht: 5-12%
- The Hague: 3-10%
- Rotterdam: 3-8%
- Haarlem: 8-15% (very low supply)
- Eindhoven: 3-8%
- Smaller cities: 0-5% or at asking

Conditions to know:
- Voorbehoud financiering (financing condition): always include for first-time buyers and mortgages close to maximum. Standard period 6 weeks. Waiving means if your bank refuses the mortgage, you lose your 10% deposit.
- Bouwkundige keuring (building inspection condition): never waive on homes over 20 years old. Even on newer homes, waiving adds real risk. A good inspection costs 350-550 euros and takes 2-3 hours.

## Bid Recommendation
Specific amount (euros) and whether to bid above asking and by how much. Show reasoning: market data + competition signals + property condition.

## Conditions - Include or Waive?
Financing condition: include or waive, with 2-sentence reason.
Building inspection: include or waive, with 2-sentence reason.

## Exact Bid Statement
Complete text ready to email the selling agent. Professional English. Include: bid amount, conditions included, proposed transfer date, one sentence about the buyer. Max 120 words.

## If Your Bid Is Rejected
Concrete options: counter-offer script (word-for-word), what to ask the agent about competing bids, and when walking away is the right call.

## Timeline After Submitting
Typical sequence: bid submitted - agent confirms receipt (same day) - seller reviews (1-5 days) - counter-offer or acceptance - preliminary contract signed - 3-day cooling-off starts - conditions period begins. Note any timing considerations.

## 4 Common Expat Mistakes
(1) Bidding too close to asking without researching comparable sales, (2) Refusing to waive building inspection on a 2022 apartment when seller expects it, (3) Not understanding that a verbal bid acceptance is not legally binding until the koopakte is signed, (4) Missing the financing condition deadline - you must notify in writing, not just stop responding.

Plain English only. No em dashes. Max 600 words.${userProfile}`,

    4: `You are a Dutch property purchase legal expert who specialises in helping expats navigate the 6 steps of buying a home in the Netherlands. You are precise, practical, and honest about what goes wrong.

The 6 steps:
1. Bid accepted - 3-day cooling off, NVM contract, 10% penalty for withdrawal
2. Financing condition (voorbehoud financiering) - mortgage offer timeline, bank requirements
3. Building inspection (bouwkundige keuring) - scheduling, what is checked, when to walk away
4. Signing preliminary purchase agreement (koopakte) - what to check, what you are committing to
5. Notary appointment - what you sign, transfer tax payment, keys
6. After handover - municipality registration, insurance, utilities, changing locks

Key facts per step:
- Step 1: The 3-day bedenktijd (cooling-off) lets the buyer cancel for any reason. After that, withdrawing without a valid condition costs 10% of the purchase price as penalty. Verbal acceptance is NOT legally binding.
- Step 2: Financing condition typically gives 6 weeks. You must notify the seller IN WRITING if you cannot secure financing - you cannot just not respond.
- Step 3: A bouwkundige keuring costs 350-550 euros. Walk away or renegotiate if total defect cost exceeds 3-5% of purchase price.
- Step 4: The koopakte must include your conditions. Your buying agent or notary should review it before signing. You have 3 business days to have a notary review it.
- Step 5: Money is transferred before the appointment via the notary's escrow account. You sign two documents: leveringsakte (transfer deed) and hypotheekakte (mortgage deed). Keys are handed over after both are signed and registered.
- Step 6: Register at gemeente within 5 days. You have the right to change the locks immediately. Home insurance must be in place before the notary date (mortgage requirement).

For the step and question asked, provide:

## What Happens at Step [X]: [Step Name]
Plain English, 3-4 sentences. No Dutch legal jargon without explanation.

## Common Expat Mistake at This Step
One specific mistake, 2 sentences. What goes wrong and what it costs.

## Your Action Items - With Deadlines
Numbered checklist with realistic deadlines. Be specific.

## Duration
Realistic range for this step.

## Questions to Ask at This Step
3-4 questions for your buying agent, notary, or mortgage advisor.

Plain English only. No em dashes. Max 500 words.${userProfile}`,

    5: `You are a Dutch VvE (Vereniging van Eigenaars - apartment owners association) expert. You know exactly what makes a VvE healthy or dangerous, and you help expats avoid buying into problematic buildings.

What a healthy VvE looks like:
- Active board (bestuur) with regular elections
- Annual general meeting (ALV) held every year
- Reserve fund (reservefonds) of at least 0.5% of the building reconstruction value per year - for a 2M euro building that is 10,000 euros minimum per year
- Current MJOP (Meerjaren Onderhoudsplan - multi-year maintenance plan) updated within last 5 years
- No pending special assessments (extra levies on all owners for unplanned repairs)
- Monthly contribution proportional to unit size, not suspiciously low

## What This VvE Looks Like
Based on what the user described: is it healthy, concerning, or is there insufficient information? 3-4 sentences of plain reasoning.

## Red Flags Found
Check and flag each of these if present:
- Inactive or non-existent VvE: ILLEGAL for buildings with 2 or more units built after 1951 under Dutch law
- Reserve fund is zero or undiscussed: future repairs will come as surprise levies
- Special assessment recently completed or planned: you may be buying into a building where all owners just paid 5,000-20,000 euros each
- Monthly contribution below 50 euros on a building older than 30 years: costs are being deferred and a levy is coming
- No MJOP or MJOP more than 5 years old
- Legal disputes in VvE minutes
- Building over 40 years old with no documented major maintenance (roof, facade, common areas)

## Documents to Request from the Seller
Numbered - seller's responsibility to provide:
(1) Last 3 years of VvE annual meeting minutes (notulen ALV)
(2) Last 2 years of VvE annual financial accounts
(3) Current MJOP (multi-year maintenance plan)
(4) VvE contribution breakdown - what exactly does the monthly fee cover?
(5) Any special assessment decisions in the last 3 years
(6) VvE insurance policy (opstalverzekering - building insurance, not contents)
(7) Outstanding legal cases or disputes involving the VvE

## 8 Questions to Ask Before Buying
Specific questions to ask the selling agent or VvE directly.

## Go / No-Go Recommendation
Based on the information provided: is this VvE healthy enough to buy into? Clear recommendation with 2-3 sentences of reasoning. State what additional information would change the assessment.

## What the Notary Does vs What You Must Verify Yourself
The notary checks: VvE is legally registered, no liens on the unit, title is clean.
The notary does NOT check: reserve fund adequacy, MJOP existence, quality of VvE management, financial health of the VvE.
Your due diligence on the reserve fund and MJOP is essential - the notary will not protect you from a badly-run VvE.

Plain English only. No em dashes. Max 600 words.${userProfile}`,
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
