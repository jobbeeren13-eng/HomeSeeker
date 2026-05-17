const { PlaywrightCrawler } = require('@crawlee/playwright');
const {
  listingExists,
  insertListing,
  getUnsentListings,
  markListingGloballySent,
  getSentListingByFingerprint,
} = require('./database');
 
const CITIES = [
  'amsterdam', 'rotterdam', 'den-haag', 'utrecht',
  'haarlem', 'amstelveen', 'delft',
];
 
const CRAWLER_OPTS = {
  headless: true,
  browserPoolOptions: { useFingerprints: true },
  navigationTimeoutSecs: 45,
  maxRequestRetries: 3,
  requestHandlerTimeoutSecs: 90,
  maxConcurrency: 2,
  launchContext: {
    launchOptions: {
      args: ['--disable-blink-features=AutomationControlled'],
    },
  },
};
 
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
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
 
function makeFingerprint(listing) {
  const address = (listing.address || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  const priceRange = Math.round((listing.priceNumber || 0) / 50) * 50;
  const city = (listing.city || '').toLowerCase().replace(/[^a-z]/g, '');
  return `${city}__${address}__${priceRange}`;
}
 
function rowToListing(row) {
  return {
    url: row.url,
    address: row.address,
    price: row.price,
    city: row.city,
    priceNumber: row.price_number,
    transactionType: row.transaction_type,
    rooms: row.rooms,
    area: row.area,
    energyLabel: row.energy_label,
    constructionYear: row.construction_year,
    propertyType: row.property_type,
    image: row.image,
    listedAt: row.listed_at,
    source: row.source,
    fingerprint: row.fingerprint,
  };
}
 
function saveNewListing(listing) {
  if (!listing.url || !listing.priceNumber) return false;
 
  const fingerprint = makeFingerprint(listing);
  listing.fingerprint = fingerprint;
 
  if (listingExists.get(listing.url)) return false;
 
  const existing = getSentListingByFingerprint.get(fingerprint);
  if (existing) {
    console.log(`[dedup] Skipping duplicate: ${listing.url} (already sent as ${existing.source})`);
    insertListing.run({
      url: listing.url,
      address: listing.address || '',
      city: normaliseCity(listing.city),
      price: listing.price || '',
      priceNumber: listing.priceNumber,
      transactionType: listing.transactionType || 'huur',
      rooms: listing.rooms || 0,
      area: listing.area || 0,
      energyLabel: listing.energyLabel || '',
      constructionYear: listing.constructionYear || null,
      propertyType: listing.propertyType || '',
      image: listing.image || '',
      listedAt: listing.listedAt || new Date().toISOString(),
      source: listing.source,
      fingerprint,
      sent: 1,
    });
    return false;
  }
 
  insertListing.run({
    url: listing.url,
    address: listing.address || '',
    city: normaliseCity(listing.city),
    price: listing.price || '',
    priceNumber: listing.priceNumber,
    transactionType: listing.transactionType || 'huur',
    rooms: listing.rooms || 0,
    area: listing.area || 0,
    energyLabel: listing.energyLabel || '',
    constructionYear: listing.constructionYear || null,
    propertyType: listing.propertyType || '',
    image: listing.image || '',
    listedAt: listing.listedAt || new Date().toISOString(),
    source: listing.source,
    fingerprint,
    sent: 0,
  });
  return true;
}
 
function normaliseListing(item, city, source, transactionType = 'huur') {
  return {
    ...item,
    city: normaliseCity(item.city || city),
    priceNumber: parsePrice(item.price),
    transactionType: transactionType || item.transactionType || 'huur',
    energyLabel: (item.energyLabel || '').toUpperCase(),
    source,
  };
}
 
async function dismissCookieBanner(page) {
  const selectors = [
    'button:has-text("Alles accepteren")',
    'button:has-text("Accepteer alle")',
    'button:has-text("Accept all")',
    'button:has-text("Akkoord")',
    '[data-testid="accept-all"]',
    '#onetrust-accept-btn-handler',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(500);
        return;
      }
    } catch (_) { /* next */ }
  }
}
 
async function randomDelay(page) {
  await page.waitForTimeout(Math.random() * 2000 + 1000);
}
 
function buildFundaUrls() {
  const urls = [];
  for (const city of CITIES) {
    urls.push({
      url: `https://www.funda.nl/zoeken/huur/?selected_area=["${city}"]`,
      userData: { source: 'funda', city, transactionType: 'huur' },
    });
    urls.push({
      url: `https://www.funda.nl/zoeken/koop/?selected_area=["${city}"]`,
      userData: { source: 'funda', city, transactionType: 'koop' },
    });
  }
  return urls;
}
 
function buildHuurwoningenUrls() {
  return CITIES.map(city => ({
    url: `https://www.huurwoningen.nl/huurwoningen/${city}/`,
    userData: { source: 'huurwoningen', city, transactionType: 'huur' },
  }));
}
 
function buildJaapUrls() {
  return CITIES.map(city => ({
    url: `https://www.jaap.nl/huurhuizen/${city}/`,
    userData: { source: 'jaap', city, transactionType: 'huur' },
  }));
}
 
async function extractFundaListings(page, city, transactionType) {
  return page.evaluate(({ city, transactionType }) => {
    const results = [];
    const seen = new Set();
 
    const parseFromCard = (card, href) => {
      const text = card.innerText || '';
      const priceMatch = text.match(/€\s*([\d.]+(?:,\d+)?)/);
      const areaMatch = text.match(/(\d+)\s*m[²2]/i);
      const roomsMatch = text.match(/(\d+)\s*(?:kamer|room)/i);
      const img = card.querySelector('img');
      const addressEl = card.querySelector('h2, h3, [data-testid="street-name"], .font-semibold');
      const fullUrl = href.startsWith('http') ? href.split('?')[0] : `https://www.funda.nl${href.split('?')[0]}`;
      if (seen.has(fullUrl)) return;
      seen.add(fullUrl);
      results.push({
        url: fullUrl,
        address: addressEl?.textContent?.trim() || '',
        city,
        price: priceMatch ? `€ ${priceMatch[1]}` : '',
        transactionType,
        rooms: roomsMatch ? parseInt(roomsMatch[1], 10) : 0,
        area: areaMatch ? parseFloat(areaMatch[1]) : 0,
        image: img?.src || img?.getAttribute('data-src') || '',
        listedAt: new Date().toISOString(),
        source: 'funda',
      });
    };
 
    document.querySelectorAll('a[href*="/detail/"]').forEach(anchor => {
      const href = anchor.getAttribute('href') || '';
      if (!href.includes('/detail/')) return;
      parseFromCard(anchor.closest('article, li, div') || anchor, href);
    });
 
    return results;
  }, { city, transactionType });
}
 
async function extractHuurwoningenListings(page, city) {
  return extractGenericListings(page, {
    city,
    source: 'huurwoningen',
    baseHost: 'www.huurwoningen.nl',
    linkMatch: (href) => /\/huurwoningen\/[^/]+\/[^/]+/.test(href) || href.includes('/woning/'),
  });
}
 
async function extractJaapListings(page, city) {
  return extractGenericListings(page, {
    city,
    source: 'jaap',
    baseHost: 'www.jaap.nl',
    linkMatch: (href) => href.includes('/huurhuizen/') && href.split('/').length > 4,
  });
}
 
async function extractGenericListings(page, opts) {
  return page.evaluate((opts) => {
    const { city, source, baseHost, linkMatch, propertyType } = opts;
    const results = [];
    const seen = new Set();
 
    const parseItem = (item, href) => {
      const text = item.innerText || '';
      const priceMatch = text.match(/€\s*([\d.]+(?:,\d+)?)/);
      const areaMatch = text.match(/(\d+)\s*m[²2]/i);
      const roomsMatch = text.match(/(\d+)\s*(?:kamer|room|slaapkamer)/i);
      const img = item.querySelector('img');
      const title = item.querySelector('h2, h3, h4, .title, a');
      let fullUrl = href;
      if (!href.startsWith('http')) {
        fullUrl = `https://${baseHost}${href.startsWith('/') ? '' : '/'}${href}`;
      }
      fullUrl = fullUrl.split('?')[0];
      if (seen.has(fullUrl)) return;
      seen.add(fullUrl);
      results.push({
        url: fullUrl,
        address: title?.textContent?.trim() || '',
        city,
        price: priceMatch ? `€ ${priceMatch[1]}` : '',
        transactionType: 'huur',
        rooms: roomsMatch ? parseInt(roomsMatch[1], 10) : 0,
        area: areaMatch ? parseFloat(areaMatch[1]) : 0,
        propertyType: propertyType || '',
        image: img?.src || img?.getAttribute('data-src') || '',
        listedAt: new Date().toISOString(),
        source,
      });
    };
 
    document.querySelectorAll('a[href]').forEach(anchor => {
      const href = anchor.getAttribute('href') || '';
      if (!linkMatch(href)) return;
      parseItem(anchor.closest('article, li, div, section') || anchor, href);
    });
 
    return results;
  }, opts);
}
 
async function scrapePlatform(name, startUrls, extractFn) {
  if (!startUrls.length) return 0;
 
  let newCount = 0;
 
  try {
    const crawler = new PlaywrightCrawler({
      ...CRAWLER_OPTS,
      async requestHandler({ page, request, log }) {
        const { source, city, transactionType, propertyType } = request.userData;
        log.info(`[${name}] ${source} — ${city}`);
 
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
        });
 
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await dismissCookieBanner(page);
        await randomDelay(page);
 
        let raw = [];
        try {
          raw = await extractFn(page, request.userData);
        } catch (err) {
          log.warning(`Extract failed on ${request.url}: ${err.message}`);
        }
 
        for (const item of raw) {
          const listing = normaliseListing(item, city, source, transactionType);
          if (propertyType) listing.propertyType = propertyType;
          if (saveNewListing(listing)) newCount++;
        }
 
        log.info(`[${name}] ${city}: ${raw.length} found`);
      },
      failedRequestHandler({ request, log }, error) {
        log.error(`[${name}] Failed ${request.url}: ${error.message}`);
      },
    });
 
    console.log(`[scraper] Starting ${name} (${startUrls.length} URLs)…`);
    await crawler.run(startUrls);
    console.log(`[scraper] ${name} done — ${newCount} new listings`);
    return newCount;
  } catch (err) {
    console.error(`[scraper] ${name} failed: ${err.message}`);
    return 0;
  }
}
 
async function scrapeFunda() {
  return scrapePlatform('funda', buildFundaUrls(), async (page, { city, transactionType }) =>
    extractFundaListings(page, city, transactionType)
  );
}
 
async function scrapeHuurwoningen() {
  return scrapePlatform('huurwoningen', buildHuurwoningenUrls(), async (page, { city }) =>
    extractHuurwoningenListings(page, city)
  );
}
 
async function scrapeJaap() {
  return scrapePlatform('jaap', buildJaapUrls(), async (page, { city }) =>
    extractJaapListings(page, city)
  );
}
 
async function scrapeListings() {
  await scrapeFunda();
  await scrapeHuurwoningen();
  await scrapeJaap();
 
  const unsent = getUnsentListings.all().map(rowToListing);
  console.log(`[scraper] Total unsent listings: ${unsent.length}`);
  return unsent;
}
 
function markListingsAsSent(urls) {
  for (const url of urls) {
    markListingGloballySent.run(url);
  }
}
 
module.exports = {
  scrapeListings,
  scrapeFunda,
  scrapeHuurwoningen,
  scrapeJaap,
  normaliseCity,
  makeFingerprint,
  markListingsAsSent,
  rowToListing,
};