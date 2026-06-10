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

// Strip markdown and punctuation that doesn't render well in Telegram
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/\s*—\s*/g, ' ')
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

async function generateLetterDirect({ listing, user }) {
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

  const user_description = (user?.user_description || '').trim();
  const move_reason = (user?.move_reason || '').trim();
  const tenant_quality = (user?.tenant_quality || '').trim();

  let signalLines = '';
  if (listing.description) {
    const { detectLandlordIntent } = require('./score');
    const { signals } = detectLandlordIntent(listing.description);
    const topSignals = signals.slice(0, 2).map(s => s.label);
    if (topSignals.length > 0) {
      signalLines = `Landlord cares about: ${topSignals.join(', ')}`;
    }
  }

  const systemPrompt = `You write short, human rental motivation letters for the Dutch housing market. You never sound like AI. Rules:
- Max 130 words
- Never use: reliable, responsible, delighted, pride myself, perfect fit, pleased to apply, ideal candidate
- No em dashes, no bullet points, no markdown
- Mention income ONCE, naturally
- Address 1-2 specific things about the property or location
- If landlord prefers quiet/long-term/professionals: address this naturally without stating it explicitly
- Sign off with first name only
- Sound like a thoughtful person wrote this at their desk, not an AI`;

  const incomeClause = inkomen > 0 ? `, monthly income €${inkomen}` : '';
  const profileLines = [
    user_description && `About me: ${user_description}`,
    move_reason && `Why moving: ${move_reason}`,
    tenant_quality && `As a tenant: ${tenant_quality}`,
  ].filter(Boolean).join('\n');

  const nameClause = noName
    ? 'Sign off with "Met vriendelijke groet," only (no name).'
    : `Sign off with just the first name: ${firstName}.`;

  const userPrompt = `Write a rental motivation letter.

Applicant: ${noName ? 'unnamed' : naam}, ${contract_type} ${profiel_type}${incomeClause}
Property: ${address}${city ? `, ${city}` : ''}, €${price}/month
${profileLines ? profileLines + '\n' : ''}${signalLines ? signalLines + '\n' : ''}
${nameClause}`;

  const message = await callClaude({
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return stripMarkdown(message.content[0].text);
}

// Generate a single AI-powered application tip for listings with rich descriptions.
// Result is cached in listing_cache for 48h to avoid repeated API calls.
async function getAITip(listing, user) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!listing.description || listing.description.length < 200) return null;

  const cacheKey = `aitip_${listing.fingerprint || listing.url}`;

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
      system: 'You are a Dutch rental application advisor. Give one actionable tip. Max 15 words. No preamble, no trailing punctuation changes, no quotes.',
      messages: [{
        role: 'user',
        content: `Listing description: "${listing.description.slice(0, 400)}"\nTenant: ${userProfile || 'professional'}\nWhat is the single most important thing this tenant should mention in their application?`,
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

module.exports = { generateLetter, generateLetterDirect, getAITip, STYLE_LABELS };
