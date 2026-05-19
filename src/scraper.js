const { PlaywrightCrawler } = require('@crawlee/playwright');
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

const CRAWLER_OPTS = {
  headless: true,
  browserPoolOptions: { useFingerprints: true },
  navigationTimeoutSecs: 45,
  maxRequestRetries: 3,
  requestHandlerTimeoutSecs: 90,
  maxConcurrency: 3,
  launchContext: {
    launchOptions: {
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
    },
  },
};

// ── Watchdog state ──────────────────────────
let scraperStats = {
  lastRunAt: null,
  lastRunListings: 0,
  consecutiveZeroRuns: 0,
  totalRuns: 0,
  lastError: null,
};

function getScraperHealth() {
  return scraperStats;
}

function recordScraperRun(count, error = null) {
  scraperStats.lastRunAt = new Date().toISOString();
  scraperStats.lastRunListings = count;
  scraperStats.totalRuns++;
  scraperStats.lastError = error;
  if (count === 0) {
    scraperStats.consecutiveZeroRuns++;
    if (scraperStats.consecutiveZeroRuns >= 3) {
      console.warn(`[watchdog] ⚠️ ${scraperStats.consecutiveZeroRuns} consecutive runs with 0 listings — possible silent failure`);
    }
  } else {
    scraperStats.consecutiveZeroRuns = 0;
  }
}

// ── Helpers ─────────────────────────────────
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
  const address = (listing.address || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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

// ── Data validation ──────────────────────────
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
  if (existing) {
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
    } catch (_) {}
  }
}

async function randomDelay(page) {
  await page.waitForTimeout(Math.random() * 1000 + 500);
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

// ── Scraper with retry ───────────────────────
async function scrapeFundaOnce() {
  let newCount = 0;
  const startUrls = buildFundaUrls();

  const crawler = new PlaywrightCrawler({
    ...CRAWLER_OPTS,
    async requestHandler({ page, request, log }) {
      const { source, city, transactionType } = request.userData;

      await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' });
      await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await dismissCookieBanner(page);
      await randomDelay(page);

      let raw = [];
      try {
        raw = await extractFundaListings(page, city, transactionType);
      } catch (err) {
        log.warning(`Extract failed on ${request.url}: ${err.message}`);
      }

      for (const item of raw) {
        const listing = normaliseListing(item, city, source, transactionType);
        if (saveNewListing(listing)) newCount++;
      }

      log.info(`[funda] ${city} (${transactionType}): ${raw.length} found, ${newCount} new`);
    },
    failedRequestHandler({ request, log }, error) {
      log.error(`[funda] Failed ${request.url}: ${error.message}`);
    },
  });

  await crawler.run(startUrls);
  return newCount;
}

async function scrapeFunda(retries = 2) {
  console.log(`[scraper] Starting funda (${CITIES.length * 2} URLs)…`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const count = await scrapeFundaOnce();
      console.log(`[scraper] funda done — ${count} new listings (attempt ${attempt})`);
      recordScraperRun(count);
      return count;
    } catch (err) {
      console.error(`[scraper] funda attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        console.log(`[scraper] Retrying in 10s…`);
        await new Promise(r => setTimeout(r, 10000));
      } else {
        recordScraperRun(0, err.message);
        return 0;
      }
    }
  }
  return 0;
}

async function scrapeListings() {
  await scrapeFunda();
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
  normaliseCity,
  makeFingerprint,
  markListingsAsSent,
  rowToListing,
  getScraperHealth,
};
