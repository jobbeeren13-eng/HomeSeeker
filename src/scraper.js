const axios = require('axios');

const APIFY_TOKEN = process.env.APIFY_TOKEN;

const FUNDA_ACTOR_ID = 'memo23~funda-scraper';
const PARARIUS_ACTOR_ID = 'misceres~pararius-scraper'; // TODO: verify actor ID at https://apify.com/store?search=pararius

const POLL_INTERVAL_MS = 10_000;
const MAX_WAIT_MS = 5 * 60_000;

// ── Funda URLs (koop + huur, 7 cities) ─────────────────────────────────────
const FUNDA_URLS = [
  { url: 'https://www.funda.nl/zoeken/koop/?selected_area=["amsterdam"]' },
  { url: 'https://www.funda.nl/zoeken/huur/?selected_area=["amsterdam"]' },
  { url: 'https://www.funda.nl/zoeken/koop/?selected_area=["rotterdam"]' },
  { url: 'https://www.funda.nl/zoeken/huur/?selected_area=["rotterdam"]' },
  { url: 'https://www.funda.nl/zoeken/koop/?selected_area=["den-haag"]' },
  { url: 'https://www.funda.nl/zoeken/huur/?selected_area=["den-haag"]' },
  { url: 'https://www.funda.nl/zoeken/koop/?selected_area=["utrecht"]' },
  { url: 'https://www.funda.nl/zoeken/huur/?selected_area=["utrecht"]' },
  { url: 'https://www.funda.nl/zoeken/koop/?selected_area=["haarlem"]' },
  { url: 'https://www.funda.nl/zoeken/huur/?selected_area=["haarlem"]' },
  { url: 'https://www.funda.nl/zoeken/koop/?selected_area=["amstelveen"]' },
  { url: 'https://www.funda.nl/zoeken/huur/?selected_area=["amstelveen"]' },
  { url: 'https://www.funda.nl/zoeken/koop/?selected_area=["delft"]' },
  { url: 'https://www.funda.nl/zoeken/huur/?selected_area=["delft"]' },
];

// ── Pararius URLs (huur only) ────────────────────────────────────────────────
const PARARIUS_URLS = [
  { url: 'https://www.pararius.nl/huurwoningen/amsterdam' },
  { url: 'https://www.pararius.nl/huurwoningen/rotterdam' },
  { url: 'https://www.pararius.nl/huurwoningen/den-haag' },
  { url: 'https://www.pararius.nl/huurwoningen/utrecht' },
  { url: 'https://www.pararius.nl/huurwoningen/haarlem' },
  { url: 'https://www.pararius.nl/huurwoningen/amstelveen' },
  { url: 'https://www.pararius.nl/huurwoningen/delft' },
];

// TODO: Kamernet — no suitable Apify actor found.
//   Manual option: use Playwright/Puppeteer scraper against https://kamernet.nl/en/for-rent/rooms-{city}
//   API option: check if kamernet.nl has a public API or partner programme.

// TODO: HousingAnywhere — no public Apify actor found.
//   Endpoint to investigate: https://housinganywhere.com/s/Amsterdam--Netherlands/1/apartment
//   They have a documented API for partners; contact partners@housinganywhere.com.

// TODO: Directwonen — no Apify actor found.
//   Renders server-side; scrape with Axios + Cheerio against:
//   https://www.directwonen.nl/huurwoningen/{city}/
//   Be mindful of their terms of service.

function parsePrice(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[€\s.]/g, '').replace(',', '.');
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

function normaliseCity(raw) {
  if (!raw) return '';
  return raw.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/'/g, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normaliseListing(item, source = 'funda') {
  const rawPrice = item.price || item.rentPrice || item.askingPrice || '';
  const isHuur = (item.transactionType || item.type || '').toLowerCase().includes('huur')
    || String(rawPrice).includes('/mnd')
    || String(rawPrice).includes('p/m')
    || source === 'pararius'; // Pararius is huur-only

  return {
    url: item.url || item.listingUrl || '',
    address: item.address || item.streetName || '',
    city: normaliseCity(item.city || item.place || ''),
    price: rawPrice,
    priceNumber: parsePrice(rawPrice),
    transactionType: isHuur ? 'huur' : 'koop',
    rooms: parseInt(item.rooms || item.numberOfRooms || 0, 10) || 0,
    area: parseFloat(item.area || item.livingArea || 0) || 0,
    energyLabel: (item.energyLabel || item.energielabel || '').toUpperCase(),
    constructionYear: parseInt(item.constructionYear || item.yearOfConstruction || 0, 10) || null,
    propertyType: (item.propertyType || item.woningType || '').toLowerCase(),
    description: item.description || '',
    image: (item.images && item.images[0]) || item.image || '',
    listedAt: item.listedSince || item.publicationDate || new Date().toISOString(),
    source,
  };
}

async function startRun(actorId, startUrls) {
  const res = await axios.post(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`,
    {
      startUrls,
      maxItems: 50,
      proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
    },
    { timeout: 30_000 }
  );
  return res.data.data.id;
}

async function waitForRun(actorId, runId) {
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const res = await axios.get(
      `https://api.apify.com/v2/acts/${actorId}/runs/${runId}?token=${APIFY_TOKEN}`,
      { timeout: 15_000 }
    );
    const status = res.data.data.status;
    if (status === 'SUCCEEDED') return true;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      console.error(`[scraper] Apify run ${runId} ended with status: ${status}`);
      return false;
    }
  }
  console.error(`[scraper] Apify run ${runId} timed out after ${MAX_WAIT_MS / 1000}s`);
  return false;
}

async function fetchDataset(actorId, runId) {
  const res = await axios.get(
    `https://api.apify.com/v2/acts/${actorId}/runs/${runId}/dataset/items?token=${APIFY_TOKEN}&limit=1000`,
    { timeout: 30_000 }
  );
  return res.data;
}

async function scrapeSource(actorId, startUrls, source) {
  try {
    console.log(`[scraper] Starting ${source} run (actor: ${actorId})…`);
    const runId = await startRun(actorId, startUrls);
    const ok = await waitForRun(actorId, runId);
    if (!ok) return [];
    const raw = await fetchDataset(actorId, runId);
    const listings = raw.map(item => normaliseListing(item, source)).filter(l => l.url && l.priceNumber);
    console.log(`[scraper] ${source}: got ${listings.length} valid listings`);
    return listings;
  } catch (err) {
    console.error(`[scraper] ${source} error:`, err.message);
    return [];
  }
}

async function scrapeListings() {
  if (!APIFY_TOKEN) {
    console.warn('[scraper] APIFY_TOKEN not set — skipping scrape');
    return [];
  }

  // Run Funda and Pararius in parallel
  const [fundaListings, parariusListings] = await Promise.all([
    scrapeSource(FUNDA_ACTOR_ID, FUNDA_URLS, 'funda'),
    scrapeSource(PARARIUS_ACTOR_ID, PARARIUS_URLS, 'pararius'),
  ]);

  const all = [...fundaListings, ...parariusListings];

  // Deduplicate by URL
  const seen = new Set();
  const deduped = all.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });

  console.log(`[scraper] Total unique listings: ${deduped.length} (funda: ${fundaListings.length}, pararius: ${parariusListings.length})`);
  return deduped;
}

module.exports = { scrapeListings, normaliseCity };
