const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateLetter({ naam, inkomen, verhuisdatum, extra, listing }) {
  const listingInfo = [
    listing.address && listing.city ? `Adres: ${listing.address}, ${listing.city}` : '',
    listing.price ? `Huur: ${listing.price}` : '',
    listing.rooms ? `Kamers: ${listing.rooms}` : '',
    listing.area ? `Oppervlakte: ${listing.area} m²` : '',
    listing.url ? `Link: ${listing.url}` : '',
  ].filter(Boolean).join('\n');

  const extraLine = extra && extra.trim()
    ? `Extra informatie: ${extra}`
    : '';

  const prompt = `Schrijf een professionele en persoonlijke motivatiebrief in het Nederlands voor een huurder die reageert op een huurwoning.

Gegevens van de huurder:
- Naam: ${naam}
- Bruto maandinkomen: ${inkomen}
- Beschikbaar per: ${verhuisdatum}
${extraLine}

Woning:
${listingInfo || 'Details niet beschikbaar'}

Instructies:
- Schrijf een brief van 3–4 alinea's
- Begin met "Geachte verhuurder/makelaar,"
- Wees warm, professioneel en concreet
- Noem het inkomen in verhouding tot de huur (vertrouwen wekken)
- Vermeld de beschikbaarheid
- Eindig met "Met vriendelijke groet," gevolgd door de naam
- Voeg GEEN extra uitleg of headers toe buiten de brief zelf`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

module.exports = { generateLetter };
