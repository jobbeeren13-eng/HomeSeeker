const Anthropic = require('@anthropic-ai/sdk');

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[letter] ANTHROPIC_API_KEY not set — letter generation will fail');
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STYLE_LABELS = {
  professional: 'Professional — formal business letter, emphasis on income and stability',
  friendly: 'Friendly — warm personal tone with a short story about the tenant',
  expat: 'Expat — English letter explaining the expat situation and 30% ruling if applicable',
};

function formatCity(city) {
  if (!city) return '';
  return city.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Telegram renders **text** as literal asterisks — strip bold markers before sending
function stripMarkdown(text) {
  return text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').trim();
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

async function generateLetterDirect({ listing, user }) {
  const rawNaam = (user?.naam || '').trim();
  const noName = !rawNaam || rawNaam.toLowerCase() === 'huurder';
  const naam = noName ? '' : rawNaam;
  const firstName = noName ? '' : naam.split(' ')[0];

  const inkomen = user?.inkomen || 'unknown';
  const contract_type = user?.contract_type || 'unknown';
  const profiel_type = user?.profiel_type || 'professional';
  const address = listing.address || 'the property';
  const city = formatCity(listing.city);
  const price = listing.priceNumber || listing.price || 'unknown';
  const description = (listing.description || '').slice(0, 200).trim();

  const systemPrompt = `You write short Dutch rental motivation letters for the Dutch housing market. Rules:
- Max 120 words total
- Never use: 'reliable tenant', 'responsible', 'delighted', 'pride myself', 'perfect fit', 'pleased to apply'
- Mention income ONCE only
- No mention of pets, smoking, or children unless listing explicitly asks for it
- Two parts: (1) short profile intro, (2) one specific sentence about WHY this exact property/location
- End with first name only
- Sound like a real person, not a template`;

  const nameClause = noName
    ? 'The applicant has no name — write in first person using "I" throughout, no name at all, sign off with just "Met vriendelijke groet,"'
    : `Applicant name: ${naam}. Sign off with just the first name: ${firstName}.`;

  const cityLine = city
    ? ` Include one specific sentence about why ${city} or this neighbourhood suits long-term living.`
    : '';

  const descPart = description ? ` Property detail: ${description}.` : '';

  const userPrompt = `Write a rental motivation letter for ${noName ? 'an applicant' : naam}, ${contract_type} ${profiel_type}, monthly income €${inkomen}.
Property: ${address}${city ? `, ${city}` : ''}, €${price}/month.${descPart}${cityLine}
Long-term housing search. Keep it under 120 words. Natural tone.
${nameClause}`;

  const message = await callClaude({
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return stripMarkdown(message.content[0].text);
}

module.exports = { generateLetter, generateLetterDirect, STYLE_LABELS };
