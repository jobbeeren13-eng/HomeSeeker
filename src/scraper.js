const https = require('https');
const zlib = require('zlib');
const {
  listingExists,
  insertListing,
  getUnsentListings,
  markListingGloballySent,
  getSentListingByFingerprint,
} = require('./database');

const SEARCH_HOST = 'listing-search-wonen.funda.io';
const SEARCH_INDEX = 'listings-wonen-searcher-alias-prod';
const SEARCH_TEMPLATE_ID = 'search_result_20250805';
const PAGE_SIZE = 15;

const CITIES = [
  'amsterdam', 'rotterdam', 'utrecht', 'den-haag',
  'eindhoven', 'delft', 'haarlem', 'leiden',
  'groningen', 'amstelveen', 'tilburg', 'almere',
  'breda', 'nijmegen', 'apeldoorn', 'arnhem',
  'maastricht', 'zwolle', 'enschede',
];

let scraperStats = {
  lastRunAt: null, lastSuccessfulRunAt: null, lastRunListings: 0,
  consecutiveZeroRuns: 0, totalRuns: 0, totalListingsFound: 0,
  averageListingsPerRun: 0, lastError: null, lastFailureReason: null,
  averageRuntime: 0, runtimes: [],
};

let _adminBot = null;
function setAdminBot(bot) { _adminBot = bot; }

async function sendAdminAlert(msg) {
  const chatId = process.env.ADMIN_CHAT_ID;
  if (!chatId || !_adminBot) return;
  try {
    await _adminBot.sendMessage(chatId, `🚨 *HomeSeeker Alert*\n\n${msg}`, { parse_mode: 'Markdown' });
  } catch (e) { console.error('[watchdog] Failed to send admin alert:', e.message); }
}

function getScraperHealth() {
  const staleCutoff = 6 * 60 * 60 * 1000;
  const isStale = scraperStats.lastSuccessfulRunAt
    ? Date.now() - new Date(scraperStats.lastSuccessfulRunAt).getTime() > staleCutoff : false;
  let status = 'ok';
  if (scraperStats.consecutiveZeroRuns >= 3) status = 'degraded';
  if (isStale) status = 'stale';
  return { ...scraperStats, status, isStale };
}

function recordScraperRun(count, runtime, error = null) {
  scraperStats.lastRunAt = new Date().toISOString();
  scraperStats.lastRunListings = count;
  scraperStats.totalRuns++;
  scraperStats.lastError = error;
  scraperStats.runtimes.push(runtime);
  if (scraperStats.runtimes.length > 10) scraperStats.runtimes.shift();
  scraperStats.averageRuntime = Math.round(scraperStats.runtimes.reduce((a, b) => a + b, 0) / scraperStats.runtimes.length);
  if (count > 0) {
    scraperStats.lastSuccessfulRunAt = new Date().toISOString();
    scraperStats.totalListingsFound += count;
    scraperStats.consecutiveZeroRuns = 0;
    scraperStats.averageListingsPerRun = Math.round(scraperStats.totalListingsFound / scraperStats.totalRuns);
  } else {
    scraperStats.consecutiveZeroRuns++;
    if (error) scraperStats.lastFailureReason = error;
    if (scraperStats.consecutiveZeroRuns === 3) sendAdminAlert(`⚠️ 3 consecutive scraper runs with 0 listings.\nLast error: ${error || 'none'}`);
  }
}

function normaliseCity(raw) {
  if (!raw) return '';
  return raw.toLowerCase().replace(/\s+/g, '-').replace(/'/g, '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function makeFingerprint(listing) {
  const address = (listing.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const priceRange = Math.round((listing.priceNumber || 0) / 50) * 50;
  const city = (listing.city || '').toLowerCase().replace(/[^a-z]/g, '');
  return `${city}__${address}__${priceRange}`;
}

function rowToListing(row) {
  return {
    url: row.url, address: row.address, price: row.price, city: row.city,
    priceNumber: row.price_number, transactionType: row.transaction_type,
    rooms: row.rooms, area: row.area, energyLabel: row.energy_label,
    constructionYear: row.construction_year, propertyType: row.property_type,
    image: row.image, listedAt: row.listed_at, source: row.source, fingerprint: row.fingerprint,
    description: row.description || '',
  };
}

function isValidListing(listing) {
  if (!listing.url || !listing.url.startsWith('http')) return false;
  if (!listing.priceNumber || listing.priceNumber < 100 || listing.priceNumber > 50000) return false;
  if (!listing.city) return false;
  return true;
}

function saveNewListing(listing) {
  if (!isValidListing(listing)) return false;
  const fingerprint = makeFingerprint(listing);
  listing.fingerprint = fingerprint;
  if (listingExists.get(listing.url)) return false;
  const existing = getSentListingByFingerprint.get(fingerprint);
  const base = {
    url: listing.url, address: listing.address || '', city: normaliseCity(listing.city),
    price: listing.price || '', priceNumber: listing.priceNumber,
    transactionType: listing.transactionType || 'huur', rooms: listing.rooms || 0,
    area: listing.area || 0, energyLabel: listing.energyLabel || '',
    constructionYear: listing.constructionYear || null, propertyType: listing.propertyType || '',
    image: listing.image || '', listedAt: listing.listedAt || new Date().toISOString(),
    source: listing.source, fingerprint, description: listing.description || '',
  };
  if (existing) { insertListing.run({ ...base, sent: 1 }); return false; }
  insertListing.run({ ...base, sent: 0 });
  return true;
}

// Generates Datadog trace headers matching the Funda Android app (Dart/Flutter)
function makeHeaders() {
  const traceId = String(Math.floor(Math.random() * 9e18 + 1e18));
  const parentId = Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, '0');
  const tid = Math.floor(Date.now() / 1000).toString(16) + '00000000';
  return {
    'user-agent': 'Dart/3.9 (dart:io)',
    'x-datadog-sampling-priority': '0',
    'x-datadog-origin': 'rum',
    'tracestate': `dd=s:0;o:rum;p:${parentId}`,
    'accept-encoding': 'gzip',
    'x-datadog-parent-id': traceId,
    'content-type': 'application/json',
    'referer': 'https://www.funda.nl/',
    'accept': 'application/json',
    'traceparent': `00-${tid}${traceId.slice(0, 16)}-${parentId}-00`,
  };
}

// Builds the NDJSON body for the Elasticsearch msearch template API
function makePayload(city, offeringType, page) {
  const indexLine = JSON.stringify({ index: SEARCH_INDEX });
  const queryLine = JSON.stringify({
    id: SEARCH_TEMPLATE_ID,
    params: {
      availability: ['available', 'negotiations'],
      type: ['single'],
      zoning: ['residential'],
      object_type: ['house', 'apartment'],
      publication_date: { no_preference: true },
      offering_type: offeringType,
      page: { from: page * PAGE_SIZE },
      sort: { field: 'publish_date_utc', order: 'desc' },
      selected_area: [city],
    },
  });
  return `${indexLine}\n${queryLine}\n`;
}

function postSearch(payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(payload, 'utf8');
    const req = https.request({
      hostname: SEARCH_HOST,
      path: '/_msearch/template',
      method: 'POST',
      headers: { ...makeHeaders(), 'content-length': body.length },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function parseHits(hits, city, transactionType) {
  return hits.map(hit => {
    const s = hit._source || {};
    const addr = s.address || {};
    const priceObj = s.price || {};

    const street = addr.street_name || '';
    const num = addr.house_number != null ? String(addr.house_number) : '';
    const suffix = addr.house_number_suffix || '';
    const numStr = num + (suffix ? (suffix.match(/^\d/) ? '-' + suffix : suffix) : '');
    const address = `${street} ${numStr}`.trim();

    const rawArr = transactionType === 'huur' ? priceObj.rent_price : priceObj.selling_price;
    const priceNumber = Array.isArray(rawArr) ? (rawArr[0] || null) : (rawArr || null);
    const price = priceNumber
      ? `€ ${Math.round(priceNumber).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
      : '';

    const areaArr = s.floor_area;
    const area = Array.isArray(areaArr) ? (areaArr[0] || 0) : (areaArr || 0);

    const path = s.object_detail_page_relative_url || '';
    const url = path ? `https://www.funda.nl${path}` : null;

    const description = (s.blikvanger && typeof s.blikvanger.text === 'string')
      ? s.blikvanger.text : '';

    return {
      url,
      address,
      city: normaliseCity(addr.city || city),
      price,
      priceNumber: priceNumber ? Number(priceNumber) : null,
      transactionType,
      rooms: s.number_of_rooms || 0,
      area: Number(area) || 0,
      energyLabel: s.energy_label || '',
      constructionYear: null,
      propertyType: s.object_type || '',
      image: '',
      listedAt: s.publish_date || new Date().toISOString(),
      source: 'funda',
      description,
    };
  }).filter(l => l.url && l.url.startsWith('http') && l.priceNumber);
}

async function fetchFundaCity(city, transactionType) {
  const offeringType = transactionType === 'huur' ? 'rent' : 'buy';
  try {
    const payload = makePayload(city, offeringType, 0);
    const { status, data } = await postSearch(payload);
    if (status !== 200) {
      console.error(`[api] ${city} ${transactionType}: HTTP ${status}`);
      return [];
    }
    const hits = data?.responses?.[0]?.hits?.hits || [];
    return parseHits(hits, city, transactionType);
  } catch (err) {
    console.error(`[api] Failed ${city} ${transactionType}: ${err.message}`);
    return [];
  }
}

async function scrapeFunda() {
  const startTime = Date.now();
  let newCount = 0;
  console.log(`[scraper] Starting funda API (${CITIES.length * 2} searches)…`);

  for (const city of CITIES) {
    for (const type of ['huur', 'koop']) {
      const listings = await fetchFundaCity(city, type);
      for (const listing of listings) {
        if (saveNewListing(listing)) newCount++;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  const runtime = Date.now() - startTime;
  console.log(`[scraper] funda API done — ${newCount} new listings in ${Math.round(runtime / 1000)}s`);
  recordScraperRun(newCount, runtime);
  return newCount;
}

async function scrapeListings() {
  await scrapeFunda();
  const unsent = getUnsentListings.all().map(rowToListing);
  console.log(`[scraper] Total unsent listings: ${unsent.length}`);
  return unsent;
}

function markListingsAsSent(urls) {
  for (const url of urls) markListingGloballySent.run(url);
}

module.exports = {
  scrapeListings,
  scrapeFunda,
  normaliseCity,
  makeFingerprint,
  markListingsAsSent,
  rowToListing,
  getScraperHealth,
  setAdminBot,
};
