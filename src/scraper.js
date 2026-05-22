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

// Use system Chromium if available (Railway/Docker)
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

process.env.CRAWLEE_MEMORY_MBYTES = process.env.CRAWLEE_MEMORY_MBYTES || '2000';

const CRAWLER_OPTS = {
  headless: true,
  browserPoolOptions: { useFingerprints: true },
  navigationTimeoutSecs: 30,
  maxRequestRetries: 2,
  requestHandlerTimeoutSecs: 60,
  maxConcurrency: 1,
  launchContext: {
    launchOptions: {
      executablePath: CHROMIUM_PATH,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote', '--renderer-process-limit=1'],
    },
  },
};

// ── Watchdog state ───────────────────────────
let scraperStats = {
  lastRunAt: null,
  lastSuccessfulRunAt: null,
  lastRunListings: 0,
  consecutiveZeroRuns: 0,
  totalRuns: 0,
  totalListingsFound: 0,
  averageListingsPerRun: 0,
  lastError: null,
  lastFailureReason: null,
  averageRuntime: 0,
  runtimes: [],
};

// Admin Telegram alert (sends to ADMIN_CHAT_ID if set)
let _adminBot = null;
function setAdminBot(bot) { _adminBot = bot; }

async function sendAdminAlert(msg) {
  const chatId = process.env.ADMIN_CHAT_ID;
  if (!chatId || !_adminBot) return;
  try {
    await _adminBot.sendMessage(chatId, `🚨 *HomeSeeker Alert*\n\n${msg}`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('[watchdog] Failed to send admin alert:', e.message);
  }
}

function getScraperHealth() {
  const staleCutoff = 6 * 60 * 60 * 1000; // 6 hours
  const isStale = scraperStats.lastSuccessfulRunAt
    ? Date.now() - new Date(scraperStats.lastSuccessfulRunAt).getTime() > staleCutoff
    : false;

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

  // Track runtime average
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

    if (scraperStats.consecutiveZeroRuns === 3) {
      sendAdminAlert(`⚠️ 3 consecutive scraper runs with 0 listings.\nLast error: ${error || 'none'}\nCheck Railway logs.`);
    }
  }

  // Suspiciously low detection
  if (scraperStats.averageListingsPerRun > 0 && count > 0) {
    const threshold = scraperStats.averageListingsPerRun * 0.2;
    if (count < threshold) {
      console.warn(`[watchdog] Suspiciously low listings: ${count} (avg: ${scraperStats.averageListingsPerRun})`);
      sendAdminAlert(`⚠️ Suspiciously low listings: ${count} (historical avg: ${scraperStats.averageListingsPerRun}). Possible selector change.`);
    }
  }
}

// ── Helpers ──────────────────────────────────
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

// ── Data validation ───────────────────────────
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

// ── Selector health check ─────────────────────
async function checkSelectorHealth(page) {
  try {
    const count = await page.locator('a[href*="/detail/"]').count();
    if (count === 0) {
      const title = await page.title();
      console.warn(`[watchdog] No results found. Page title: "${title}" — possible captcha or selector change`);
      // Screenshot for debugging
      try {
        await page.screenshot({ path: '/tmp/scraper_failure.png', fullPage: false });
        console.log('[watchdog] Screenshot saved to /tmp/scraper_failure.png');
      } catch (_) {}
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
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

// ── Global timeout wrapper ────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

// ── Core scraper with timeout ─────────────────
async function scrapeFundaOnce() {
  let newCount = 0;
  const startUrls = buildFundaUrls();

  const crawler = new PlaywrightCrawler({
    ...CRAWLER_OPTS,
    async requestHandler({ page, request, log }) {
      const { source, city, transactionType } = request.userData;

      await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' });

      await withTimeout(
        page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
        35000,
        `goto ${city}`
      );

      await dismissCookieBanner(page);
      await randomDelay(page);

      // Selector health check
      const healthy = await checkSelectorHealth(page);
      if (!healthy) {
        log.warning(`[funda] Selector issue on ${city} — skipping`);
        return;
      }

      let raw = [];
      try {
        raw = await withTimeout(
          extractFundaListings(page, city, transactionType),
          15000,
          `extract ${city}`
        );
      } catch (err) {
        log.warning(`Extract failed on ${request.url}: ${err.message}`);
      }

      for (const item of raw) {
        const listing = normaliseListing(item, city, source, transactionType);
        if (saveNewListing(listing)) newCount++;
      }

      log.info(`[funda] ${city} (${transactionType}): ${raw.length} found`);
    },
    failedRequestHandler({ request, log }, error) {
      log.error(`[funda] Failed ${request.url}: ${error.message}`);
    },
  });

  await withTimeout(crawler.run(startUrls), 5 * 60 * 1000, 'full crawler run');
  return newCount;
}

// ── Scraper with retry ────────────────────────
async function scrapeFunda(retries = 2) {
  const startTime = Date.now();
  console.log(`[scraper] Starting funda (${CITIES.length * 2} URLs)…`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const count = await scrapeFundaOnce();
      const runtime = Date.now() - startTime;
      console.log(`[scraper] funda done — ${count} new listings in ${Math.round(runtime / 1000)}s (attempt ${attempt})`);
      recordScraperRun(count, runtime);
      return count;
    } catch (err) {
      console.error(`[scraper] funda attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        console.log(`[scraper] Retrying in 15s…`);
        await new Promise(r => setTimeout(r, 15000));
      } else {
        const runtime = Date.now() - startTime;
        recordScraperRun(0, runtime, err.message);
        sendAdminAlert(`🔴 Scraper failed after ${retries} attempts.\nError: ${err.message}`);
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
