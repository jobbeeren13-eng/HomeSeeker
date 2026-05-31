const https = require('https');
const { parseStringPromise } = require('xml2js');
const {
  listingExists,
  insertListing,
  getUnsentListings,
  markListingGloballySent,
  getSentListingByFingerprint,
} = require('./database');

const CITIES = [
  'amsterdam', 'rotterdam', 'utrecht', 'den-haag',
  'eindhoven', 'delft', 'haarlem', 'leiden',
  'groningen', 'amstelveen',
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

function parsePrice(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[€\s.]/g, '').replace(',', '.');
  const match = cleaned.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

function normaliseCity(raw) {
  if (!raw) return '';
  return raw.toLowerCase().replace(/\s+/g, '-').replace(/'/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
    source: listing.source, fingerprint,
  };
  if (existing) { insertListing.run({ ...base, sent: 1 }); return false; }
  insertListing.run({ ...base, sent: 0 });
  return true;
}

function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'nl-NL,nl;q=0.9',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('RSS fetch timeout')); });
  });
}

function extractImageFromDescription(desc) {
  if (!desc) return '';
  const match = desc.match(/src="([^"]+)"/);
  return match ? match[1] : '';
}

function extractRoomsFromTitle(title) {
  const match = (title || '').match(/(\d+)\s*(?:kamer|slaapkamer|room)/i);
  return match ? parseInt(match[1]) : 0;
}

function extractAreaFromTitle(title) {
  const match = (title || '').match(/(\d+)\s*m[²2]/i);
  return match ? parseFloat(match[1]) : 0;
}

async function fetchFundaRSS(city, transactionType) {
  const type = transactionType === 'huur' ? 'huur' : 'koop';
  const url = `https://www.funda.nl/zoeken/${type}?selected_area=[%22${encodeURIComponent(city)}%22]&rss=1`;

  try {
    const xml = await fetchRSS(url);
    const cleanXml = xml.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');
    const parsed = await parseStringPromise(cleanXml, { explicitArray: false, strict: false });
    const items = parsed?.rss?.channel?.item;
    if (!items) return [];

    const list = Array.isArray(items) ? items : [items];
    return list.map(item => {
      const title = item.title || '';
      const link = (item.link || '').split('?')[0];
      const price = (title.match(/€\s*[\d.,]+/) || [])[0] || '';
      const image = extractImageFromDescription(item.description || '');

      return {
        url: link,
        address: title.split('€')[0].trim().replace(/^[^a-zA-Z0-9]+/, ''),
        city,
        price,
        priceNumber: parsePrice(price),
        transactionType,
        rooms: extractRoomsFromTitle(title),
        area: extractAreaFromTitle(title),
        energyLabel: '',
        constructionYear: null,
        propertyType: '',
        image,
        listedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
        source: 'funda',
      };
    }).filter(l => l.url && l.url.startsWith('http'));
  } catch (err) {
    console.error(`[rss] Failed ${city} ${transactionType}: ${err.message}`);
    return [];
  }
}

async function scrapeFunda() {
  const startTime = Date.now();
  let newCount = 0;
  console.log(`[scraper] Starting funda RSS (${CITIES.length * 2} feeds)…`);

  for (const city of CITIES) {
    for (const type of ['huur', 'koop']) {
      const listings = await fetchFundaRSS(city, type);
      for (const listing of listings) {
        if (saveNewListing(listing)) newCount++;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const runtime = Date.now() - startTime;
  console.log(`[scraper] funda RSS done — ${newCount} new listings in ${Math.round(runtime / 1000)}s`);
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
 