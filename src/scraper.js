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
    transactionType: listing.transactionType || null, rooms: listing.rooms || 0,
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
    const rawNum = addr.house_number;
    const num = Array.isArray(rawNum) ? (rawNum[0] != null ? String(rawNum[0]) : '') : (rawNum != null ? String(rawNum) : '');
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

    // thumbnail_id is a 9-digit integer; CDN path is three 3-digit segments
    // e.g. 230146512 → https://cloud.funda.nl/valentina_media/230/146/512.jpg
    const thumbInt = Array.isArray(s.thumbnail_id) ? s.thumbnail_id[0] : null;
    const image = thumbInt
      ? `https://cloud.funda.nl/valentina_media/${String(thumbInt).padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1/$2/$3')}.jpg`
      : '';

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
      image,
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

// Kamernet listing type slug map (1=room, 2=apartment, 3=studio)
const KAMERNET_TYPE = { 1: 'room', 2: 'apartment', 3: 'studio' };

function parseKamernetListings(listings) {
  return listings.map(l => {
    const typeSlug = KAMERNET_TYPE[l.listingType] || 'room';
    const url = `https://kamernet.nl/en/for-rent/${typeSlug}-${l.citySlug}/${l.streetSlug}/${typeSlug}-${l.listingId}`;
    return {
      url,
      address: l.street || '',
      city: normaliseCity(l.city || l.citySlug || ''),
      price: l.totalRentalPrice ? `€ ${l.totalRentalPrice}` : '',
      priceNumber: l.totalRentalPrice || null,
      transactionType: 'huur',
      rooms: 1,
      area: l.surfaceArea || 0,
      energyLabel: '',
      constructionYear: null,
      propertyType: typeSlug,
      image: (() => { const img = l.resizedFullPreviewImageUrl || l.thumbnailUrl || ''; return img.startsWith('https://') ? img : ''; })(),
      listedAt: l.availabilityStartDate || new Date().toISOString(),
      source: 'kamernet',
      description: '',
    };
  }).filter(l => l.url && l.priceNumber && l.priceNumber > 0);
}

function fetchKamernetPage(citySlug) {
  return new Promise((resolve) => {
    const path = citySlug ? `/en/for-rent/rooms-${citySlug}` : '/en/for-rent/rooms-netherlands';
    const req = https.request({
      hostname: 'kamernet.nl',
      path,
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        resolve([]);
        return;
      }
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try {
          const html = Buffer.concat(chunks).toString('utf8');
          const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
          if (!m) { resolve([]); return; }
          const data = JSON.parse(m[1]);
          const raw = data.props?.pageProps?.targetPageProps?.findListingsResponse?.listings || [];
          resolve(parseKamernetListings(raw));
        } catch (e) {
          console.error(`[kamernet] Parse error ${citySlug}: ${e.message}`);
          resolve([]);
        }
      });
      stream.on('error', () => resolve([]));
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

async function scrapeKamernet() {
  let newCount = 0;
  console.log('[scraper] Starting Kamernet scrape…');
  for (const city of CITIES) {
    const listings = await fetchKamernetPage(city);
    for (const listing of listings) {
      if (saveNewListing(listing)) newCount++;
    }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`[scraper] Kamernet done — ${newCount} new listings`);
  return newCount;
}

// HousingAnywhere — plain HTML scraping, listings visible without auth
function toHACitySlug(city) {
  return city.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
}

function parseHousingAnywhereCards(html) {
  const seen = new Set();
  const urlRe = /href="(https:\/\/housinganywhere\.com\/room\/[^"]+)"/g;
  const roomLinks = [];
  let m;
  while ((m = urlRe.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); roomLinks.push({ url: m[1], idx: m.index }); }
  }
  const listings = [];
  for (let i = 0; i < roomLinks.length; i++) {
    const { url, idx } = roomLinks[i];
    const nextIdx = roomLinks[i + 1]?.idx ?? idx + 5000;
    const chunk = html.slice(idx, nextIdx);
    const tMatch = chunk.match(/title="([^"]*for rent[^"]*)"/i);
    if (!tMatch) continue;
    const tp = tMatch[1].match(/([\w ]+) for rent for €([\d,]+) per month in ([^,]+), (.+)/i);
    if (!tp) continue;
    const [, propType, priceStr, city, , ] = tp;
    const priceNumber = parseInt(priceStr.replace(/,/g, ''));
    if (!priceNumber) continue;
    const imgM = chunk.match(/src="(https:\/\/housinganywhere\.imgix\.net\/unit_type\/[^"?]+)/);
    const image = imgM ? `${imgM[1]}?fit=crop&auto=format&w=400` : '';
    const streetSlug = url.split('/').pop();
    const address = streetSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const cityName = tp[3];
    listings.push({
      url,
      address,
      city: normaliseCity(cityName),
      price: `€ ${priceStr}`,
      priceNumber,
      transactionType: 'huur',
      rooms: 0,
      area: 0,
      energyLabel: '',
      constructionYear: null,
      propertyType: propType.trim().toLowerCase(),
      image,
      listedAt: new Date().toISOString(),
      source: 'housinganywhere',
      description: '',
    });
  }
  return listings;
}

function fetchHousingAnywhereCity(city) {
  const slug = toHACitySlug(city);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'housinganywhere.com',
      path: `/${slug}--Netherlands`,
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode !== 200) { resolve([]); return; }
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip()) : res;
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try { resolve(parseHousingAnywhereCards(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { console.error(`[housinganywhere] Parse error ${city}: ${e.message}`); resolve([]); }
      });
      stream.on('error', () => resolve([]));
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end();
  });
}

async function scrapeHousingAnywhere() {
  let newCount = 0;
  console.log('[scraper] Starting HousingAnywhere scrape…');
  for (const city of CITIES) {
    const listings = await fetchHousingAnywhereCity(city);
    for (const listing of listings) {
      if (saveNewListing(listing)) newCount++;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`[scraper] HousingAnywhere done — ${newCount} new listings`);
  return newCount;
}

async function scrapeListings() {
  await scrapeFunda();
  await scrapeKamernet();
  await scrapeHousingAnywhere();
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
  scrapeKamernet,
  scrapeHousingAnywhere,
  normaliseCity,
  makeFingerprint,
  markListingsAsSent,
  rowToListing,
  getScraperHealth,
  setAdminBot,
};
