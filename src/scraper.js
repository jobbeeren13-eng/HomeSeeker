const https = require('https');
const zlib = require('zlib');
const {
  db,
  listingExists,
  insertListing,
  getUnsentListings,
  markListingGloballySent,
  updateListingDescription,
  updateListingImage,
  getSentListingByFingerprint,
  insertAgencyListing,
} = require('./database');
const { analyseDescription } = require('./score');

// Prepared once at module load — used for near-duplicate detection
const getNearDuplicateAddresses = db.prepare(
  `SELECT address FROM listings WHERE city = ? AND price_number BETWEEN ? AND ? LIMIT 50`
);

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://homeseeker.dev';
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
  sourceCounts: { funda: 0, kamernet: 0, housinganywhere: 0 },
  lastCycleSources: { funda: 0, kamernet: 0, housinganywhere: 0 },
  descriptionFillRate: 0,
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
  return {
    ...scraperStats,
    status, isStale,
    sources: scraperStats.lastCycleSources,
    descriptionFillRate: scraperStats.descriptionFillRate,
  };
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

// Strip all non-alphanumeric characters and lowercase — used in both fingerprint and similarity
function normalizeAddr(raw) {
  return (raw || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

function makeFingerprint(listing) {
  const address = normalizeAddr(listing.address);
  const priceRange = Math.round((listing.priceNumber || 0) / 100) * 100;
  const city = normalizeAddr(listing.city).replace(/\d/g, ''); // city: letters only
  return `${city}__${address}__${priceRange}`;
}

// Bigram Dice coefficient on normalized address strings.
// Treats house numbers as a hard discriminator: two different non-empty numbers → 0.
function addressSimilarity(a, b) {
  const na = normalizeAddr(a);
  const nb = normalizeAddr(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  const numA = (na.match(/\d+/) || [''])[0];
  const numB = (nb.match(/\d+/) || [''])[0];
  if (numA && numB && numA !== numB) return 0;
  const streetA = na.replace(/\d+/g, '');
  const streetB = nb.replace(/\d+/g, '');
  if (!streetA || !streetB) return 0;
  const bigrams = s => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s[i] + s[i + 1]);
    return set;
  };
  const ba = bigrams(streetA);
  const bb = bigrams(streetB);
  if (!ba.size || !bb.size) return streetA === streetB ? 1 : 0;
  let shared = 0;
  for (const bg of ba) if (bb.has(bg)) shared++;
  return (2 * shared) / (ba.size + bb.size);
}

function isNearDuplicate(listing) {
  if (!listing.priceNumber || !listing.city || !listing.address) return false;
  const city = normaliseCity(listing.city);
  const price = listing.priceNumber;
  const rows = getNearDuplicateAddresses.all(city, price - 100, price + 100);
  for (const row of rows) {
    if (addressSimilarity(listing.address, row.address) >= 0.8) return true;
  }
  return false;
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

function extractAgencyKey(listing) {
  const url = listing.url || '';
  const fundaMatch = url.match(/funda\.nl\/[^/]+\/([a-z0-9-]+?)-\d+/i);
  return fundaMatch ? 'funda:' + fundaMatch[1] : (listing.source || 'unknown');
}

function saveNewListing(listing) {
  if (!isValidListing(listing)) return false;
  const fingerprint = makeFingerprint(listing);
  listing.fingerprint = fingerprint;
  if (listingExists.get(listing.url)) return false;
  const existing = getSentListingByFingerprint.get(fingerprint);
  if (!existing && isNearDuplicate(listing)) {
    console.log(`[scraper] skipped near-duplicate: ${listing.address} (${listing.source})`);
    return false;
  }
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
  try {
    const sigs = analyseDescription(listing.description, listing);
    const agencyKey = extractAgencyKey(listing);
    insertAgencyListing.run(
      listing.source || '',
      agencyKey,
      normaliseCity(listing.city),
      listing.priceNumber || 0,
      (sigs.requiresEmployerStatement || sigs.requires3x || sigs.requires4x) ? 1 : 0,
      sigs.prefersExpats ? 1 : 0,
      sigs.requiresEmployerStatement ? 1 : 0,
      sigs.excludesStudents ? 1 : 0,
      sigs.isFurnished ? 1 : 0,
      sigs.hasGarden ? 1 : 0,
      listing.url || '',
      Date.now()
    );
  } catch (e) { /* non-critical */ }
  return true;
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

async function postSearch(payload) {
  const res = await fetch(`${RAILWAY_URL}/api/funda-search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-key': process.env.ADMIN_KEY || '',
    },
    body: JSON.stringify({ payload }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return { status: res.status, data: null };
  return res.json();
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

    // thumbnail_id: 9-digit integer (array or scalar) → cloud.funda.nl CDN path
    // e.g. 230146512 → https://cloud.funda.nl/valentina_media/230/146/512.jpg
    const thumbRaw = s.thumbnail_id;
    const thumbInt = Array.isArray(thumbRaw) ? thumbRaw[0] : (thumbRaw != null ? thumbRaw : null);
    const thumbUrl = thumbInt
      ? `https://cloud.funda.nl/valentina_media/${String(thumbInt).padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1/$2/$3')}.jpg`
      : '';
    // Fallback to other image fields present in some API responses
    const image = thumbUrl
      || (Array.isArray(s.media) && s.media[0] && (s.media[0].url || s.media[0].uri || ''))
      || (Array.isArray(s.images) && s.images[0] && (s.images[0].url || s.images[0].uri || ''))
      || s.photo_url || s.main_photo_url || s.cover_photo_url || '';

    const descFull  = (typeof s.description === 'string') ? s.description.trim() : '';
    const descBlurb = (s.blikvanger && typeof s.blikvanger.text === 'string') ? s.blikvanger.text.trim() : '';
    const description = descFull || descBlurb;

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

async function fetchFundaDescriptionAndImage(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'nl-NL,nl;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { description: '', image: '' };
    const html = await resp.text();
    if (html.includes('fundaCaptchaForm') || html.includes('akam_recaptcha')) {
      console.log('[scraper] funda CAPTCHA block:', url.slice(-50));
      return { description: '', image: '' };
    }
    const descM = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
               || html.match(/<meta\s+content="([^"]+)"\s+name="description"/i);
    const imgM  = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)
               || html.match(/<meta\s+content="([^"]+)"\s+property="og:image"/i);
    return {
      description: descM ? descM[1].trim() : '',
      image: imgM ? imgM[1].trim() : '',
    };
  } catch {
    return { description: '', image: '' };
  }
}

async function fetchDescriptionFromMeta(url, userAgent) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return '';
    const html = await resp.text();
    const m = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
           || html.match(/<meta\s+content="([^"]+)"\s+name="description"/i);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

async function fetchKamernetDescription(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return '';
    const html = await resp.text();
    // Try __NEXT_DATA__ first for structured description
    const nextDataM = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataM) {
      try {
        const data = JSON.parse(nextDataM[1]);
        const desc = data?.props?.pageProps?.targetPageProps?.listingDetails?.description
                  || data?.props?.pageProps?.listing?.description
                  || '';
        if (desc) return String(desc).slice(0, 1500).trim();
      } catch {}
    }
    // Fall back to meta description
    const metaM = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
               || html.match(/<meta\s+content="([^"]+)"\s+name="description"/i);
    return metaM ? metaM[1].trim() : '';
  } catch {
    return '';
  }
}

async function scrapeFunda() {
  const startTime = Date.now();
  let newCount = 0;
  const needsDesc = [];
  console.log(`[scraper] Starting funda API (${CITIES.length * 2} searches)…`);

  for (const city of CITIES) {
    for (const type of ['huur', 'koop']) {
      const listings = await fetchFundaCity(city, type);
      for (const listing of listings) {
        if (saveNewListing(listing)) {
          newCount++;
          if (!listing.description) needsDesc.push(listing.url);
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Batch-fetch description + image for new listings (concurrency = 3, non-blocking on error)
  if (needsDesc.length > 0) {
    console.log(`[scraper] Enriching ${needsDesc.length} new Funda listing(s) with description + image…`);
    const railwayBase = process.env.RAILWAY_URL;
    const CONCURRENCY = 3;
    for (let i = 0; i < needsDesc.length; i += CONCURRENCY) {
      await Promise.allSettled(needsDesc.slice(i, i + CONCURRENCY).map(async url => {
        const { description, image: directImage } = await fetchFundaDescriptionAndImage(url);
        let image = directImage;
        // If Hetzner IP is CAPTCHA-blocked, fetch photo via Railway (different IP)
        if (!image && railwayBase) {
          try {
            const r = await fetch(`${railwayBase}/api/fetch-funda-photo?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10000) });
            const d = await r.json();
            if (d.photo) image = d.photo;
            else if (d.captcha) console.log('[scraper] funda photo: Railway also CAPTCHA-blocked:', url.slice(-50));
          } catch (e) {
            console.log('[scraper] funda photo via Railway failed:', e.message);
          }
        }
        if (description) updateListingDescription.run(description, url);
        if (image) { try { updateListingImage.run(image, url); } catch {} }
        console.log('[scraper] funda detail fetch:', url.slice(-50), '| desc:', description ? 'ok' : 'empty', '| img:', image ? image.slice(0, 60) : 'EMPTY');
      }));
    }
  }

  const runtime = Date.now() - startTime;
  scraperStats.sourceCounts.funda += newCount;
  scraperStats.lastCycleSources.funda = newCount;
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
  const needsDesc = [];
  console.log('[scraper] Starting Kamernet scrape…');
  for (const city of CITIES) {
    const listings = await fetchKamernetPage(city);
    for (const listing of listings) {
      if (saveNewListing(listing)) {
        newCount++;
        if (!listing.description) needsDesc.push(listing.url);
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }

  if (needsDesc.length > 0) {
    console.log(`[scraper] Enriching ${needsDesc.length} new Kamernet listing(s) with descriptions…`);
    const CONCURRENCY = 2;
    for (let i = 0; i < needsDesc.length; i += CONCURRENCY) {
      await Promise.allSettled(needsDesc.slice(i, i + CONCURRENCY).map(async url => {
        const desc = await fetchKamernetDescription(url);
        if (desc) {
          updateListingDescription.run(desc, url);
          console.log(`[scraper] Kamernet desc: ${desc.length} chars — ${url.slice(-40)}`);
        } else {
          console.log(`[scraper] Kamernet desc: empty — ${url.slice(-40)}`);
        }
      }));
      await new Promise(r => setTimeout(r, 500));
    }
  }

  scraperStats.sourceCounts.kamernet += newCount;
  scraperStats.lastCycleSources.kamernet = newCount;
  console.log(`[scraper] Kamernet done — ${newCount} new listings`);
  return newCount;
}

async function fetchHousingAnywhereDescription(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { description: '', image: '' };
    const html = await resp.text();
    // Try __NEXT_DATA__ for structured description + image (HA uses Next.js)
    const nextDataM = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextDataM) {
      try {
        const data = JSON.parse(nextDataM[1]);
        const unit = data?.props?.pageProps?.listing
                  || data?.props?.pageProps?.room
                  || data?.props?.pageProps?.unit
                  || data?.props?.pageProps?.unitType
                  || data?.props?.pageProps?.initialData?.listing
                  || {};
        const desc = unit.description || unit.longDescription || '';
        const imgUrl = (unit.photos && unit.photos[0] && (unit.photos[0].url || unit.photos[0].original || unit.photos[0].src || ''))
                    || (unit.images && unit.images[0] && (unit.images[0].url || unit.images[0].original || unit.images[0].src || ''))
                    || (unit.media && unit.media[0] && (unit.media[0].url || unit.media[0].original || ''))
                    || (unit.gallery && unit.gallery[0] && (unit.gallery[0].url || unit.gallery[0].original || unit.gallery[0].src || ''))
                    || (unit.mainPhoto && (unit.mainPhoto.url || unit.mainPhoto.original || unit.mainPhoto.src || ''))
                    || (unit.coverPhoto && (unit.coverPhoto.url || unit.coverPhoto.original || unit.coverPhoto.src || ''))
                    || (unit.photo && (typeof unit.photo === 'string' ? unit.photo : (unit.photo.url || unit.photo.original || '')))
                    || unit.photoUrl || unit.thumbnailUrl || unit.imageUrl || '';
        if (desc && String(desc).trim().length > 20) {
          if (!imgUrl) console.log('[ha-detail] no image in __NEXT_DATA__ for', url.slice(-50), '| keys:', Object.keys(unit).filter(k => /photo|image|media|gallery|cover|thumb/i.test(k)).join(','));
          return { description: String(desc).slice(0, 1200).trim(), image: String(imgUrl || '') };
        }
      } catch {}
    }
    // Fall back to meta description
    const metaM = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)
               || html.match(/<meta\s+content="([^"]+)"\s+name="description"/i);
    return { description: metaM ? metaM[1].trim() : '', image: '' };
  } catch {
    return { description: '', image: '' };
  }
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
    // Try src=, data-src= (lazy-load), and srcset= in order; accept imgix.net or housinganywhere CDN
    const imgM = chunk.match(/(?:src|data-src)="(https:\/\/housinganywhere\.imgix\.net\/[^"?]+)/i)
              || chunk.match(/(?:src|data-src)="(https:\/\/[^"]+\.imgix\.net\/[^"?]*(?:unit|room|listing|photo|cover|main)[^"?]*)/i)
              || chunk.match(/srcset="(https:\/\/housinganywhere\.imgix\.net\/[^\s"?]+)/i)
              || chunk.match(/(?:src|data-src)="(https:\/\/[^"]*housinganywhere[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)/i)
              || chunk.match(/(?:src|data-src)="(https:\/\/images\.housinganywhere\.com\/[^"?]+)/i)
              || chunk.match(/(?:src|data-src)="(https:\/\/cdn\.housinganywhere\.com\/[^"?]+)/i);
    const rawImg = imgM ? imgM[1] : '';
    const image = rawImg ? (rawImg.includes('?') ? rawImg : `${rawImg}?fit=crop&auto=format&w=400`) : '';
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
  const needsDesc = [];
  console.log('[scraper] Starting HousingAnywhere scrape…');
  for (const city of CITIES) {
    const listings = await fetchHousingAnywhereCity(city);
    for (const listing of listings) {
      if (saveNewListing(listing)) {
        newCount++;
        if (!listing.description) needsDesc.push(listing.url);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (needsDesc.length > 0) {
    console.log(`[scraper] Enriching ${needsDesc.length} new HousingAnywhere listing(s) with descriptions…`);
    const CONCURRENCY = 2;
    for (let i = 0; i < needsDesc.length; i += CONCURRENCY) {
      await Promise.allSettled(needsDesc.slice(i, i + CONCURRENCY).map(async url => {
        const result = await fetchHousingAnywhereDescription(url);
        if (result.description) updateListingDescription.run(result.description, url);
        if (result.image) try { updateListingImage.run(result.image, url); } catch {}
      }));
      await new Promise(r => setTimeout(r, 800));
    }
  }

  scraperStats.sourceCounts.housinganywhere += newCount;
  scraperStats.lastCycleSources.housinganywhere = newCount;
  console.log(`[scraper] HousingAnywhere done — ${newCount} new listings`);
  return newCount;
}

async function scrapeListings() {
  scraperStats.lastCycleSources = { funda: 0, kamernet: 0, housinganywhere: 0 };
  await scrapeFunda();
  await scrapeKamernet();
  await scrapeHousingAnywhere();
  const unsent = getUnsentListings.all().map(rowToListing);

  // Description fill rate for this cycle
  const withDesc = unsent.filter(l => l.description && l.description.length > 20).length;
  scraperStats.descriptionFillRate = unsent.length > 0 ? Math.round((withDesc / unsent.length) * 100) : 0;

  const { funda, kamernet, housinganywhere } = scraperStats.lastCycleSources;
  console.log(`[scraper] Cycle totals — funda: ${funda}, kamernet: ${kamernet}, housinganywhere: ${housinganywhere}`);
  console.log(`[scraper] Total unsent listings: ${unsent.length} (desc fill: ${scraperStats.descriptionFillRate}%)`);
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
