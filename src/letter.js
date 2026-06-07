const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STYLE_LABELS = {
  professional: 'Professional — formele zakelijke brief, nadruk op inkomen en stabiliteit',
  friendly: 'Friendly — warme persoonlijke toon met een kort verhaal over de huurder',
  expat: 'Expat — Engelstalige brief met uitleg van de expat-situatie en 30% ruling indien van toepassing',
};

function formatCity(city) {
  if (!city) return '';
  return city.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function generateLetter({ style, listing, user, answers }) {
  const [situation, work, extra] = answers;
  const tone = STYLE_LABELS[style] || STYLE_LABELS.professional;

  const address = listing.address || 'onbekend adres';
  const city = formatCity(listing.city);
  const price = listing.price || (listing.priceNumber ? `€${listing.priceNumber}` : 'onbekend');
  const source = listing.source || 'onbekend platform';

  const naam = user?.naam || 'Huurder';
  const profiel = user?.profiel_type || 'particulier';
  const inkomen = user?.inkomen ? `€${user.inkomen}` : 'niet opgegeven';
  const contract = user?.contract_type || 'niet opgegeven';
  const expatNote = style === 'expat' && user?.expat_status
    ? `Expat status: ${user.expat_status}`
    : '';

  const systemPrompt = `Je bent een expert in het schrijven van Nederlandse huurmotivatiebrieven.
Schrijf een professionele, persoonlijke motivatiebrief voor een huurwoning.

Toon: ${tone}
Woning: ${address}, ${city}, ${price}
Platform: ${source}

Gebruikersinfo:
- Naam: ${naam}
- Profiel: ${profiel}
- Inkomen: ${inkomen}/maand
- Contract: ${contract}
${expatNote ? `- ${expatNote}` : ''}
- Situatie: ${situation || '—'}
- Werk: ${work || '—'}
- Extra: ${extra || '—'}

Regels:
- Max 200 woorden
- Geen clichés
- Eindig met een concrete vraag om bezichtiging
- Voor Expat stijl: schrijf in het Engels
- Vermeld NOOIT dat de brief door AI is gegenereerd`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: 'Schrijf de motivatiebrief. Geef alleen de brieftekst terug, zonder uitleg of metadata.',
    }],
  });

  return message.content[0].text;
}

async function generateLetterDirect({ listing, user }) {
  const naam = user?.naam || 'Huurder';
  const inkomen = user?.inkomen || 'onbekend';
  const contract_type = user?.contract_type || 'onbekend';
  const profiel_type = user?.profiel_type || 'particulier';
  const address = listing.address || 'onbekend adres';
  const city = formatCity(listing.city);
  const price = listing.priceNumber || listing.price || 'onbekend';
  const description = (listing.description || '').slice(0, 300);

  const systemPrompt = `Je bent een expert in Nederlandse huurmarkt sollicitatiebrieven. Schrijf een professionele, persoonlijke motivatiebrief van max 200 woorden voor een huurder die reageert op een woning. Gebruik een warme maar professionele toon. Begin direct met de brief, geen aanhef als 'Geachte'.`;

  const userPrompt = `Schrijf een motivatiebrief voor ${naam} die solliciteert op ${address} in ${city} voor €${price}/maand. Profiel: ${contract_type} contract, inkomen €${inkomen}/maand, ${profiel_type}.${description ? ` ${description}` : ''}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return message.content[0].text;
}

module.exports = { generateLetter, generateLetterDirect, STYLE_LABELS };
