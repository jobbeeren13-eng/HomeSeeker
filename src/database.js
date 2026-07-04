const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
 
// DB_PATH env var is our dedicated SQLite path variable (avoids collision with Railway's
// auto-injected DATABASE_URL which gets overwritten when a Postgres service is linked).
// Priority: DB_PATH (explicit) → DATABASE_URL (legacy) → hardcoded default.
const DB_PATH = process.env.DB_PATH || process.env.DATABASE_URL || '/app/data/homeseeker.db';
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(DB_PATH);
 
db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);
 
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id TEXT PRIMARY KEY,
    naam TEXT,
    email TEXT,
    profiel_type TEXT,
    expat_status TEXT,
    contract_type TEXT,
    inkomen REAL,
    application_readiness TEXT DEFAULT 'niet',
    beschikbaarheid_timing TEXT DEFAULT 'flexibel',
    type TEXT DEFAULT 'beide',
    woningtype TEXT DEFAULT 'alle',
    locatie TEXT,
    prijs_min REAL DEFAULT 0,
    prijs_max REAL,
    opp_min REAL DEFAULT 0,
    kamers_min INTEGER DEFAULT 1,
    energielabel TEXT DEFAULT 'geen',
    bouwjaar_min INTEGER,
    tuin INTEGER DEFAULT 0,
    parkeren INTEGER DEFAULT 0,
    delen_toegestaan INTEGER DEFAULT 0,
    huisdieren INTEGER DEFAULT 0,
    gemeubileerd INTEGER DEFAULT 0,
    beschikbaar_per TEXT,
    kans_min INTEGER DEFAULT 0,
    deal_min INTEGER DEFAULT 0,
    met_partner TEXT DEFAULT 'nee',
    partner_inkomen REAL DEFAULT 0,
    heeft_borg TEXT DEFAULT 'nee',
    betaald INTEGER DEFAULT 0,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    trial_start_date TEXT,
    actief INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS sent_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    UNIQUE(url, chat_id)
  );
 
  CREATE TABLE IF NOT EXISTS telegram_chats (
    chat_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    registered_at TEXT DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS listings (
    url TEXT PRIMARY KEY,
    address TEXT,
    city TEXT,
    price TEXT,
    price_number REAL,
    transaction_type TEXT,
    rooms INTEGER,
    area REAL,
    energy_label TEXT,
    construction_year INTEGER,
    property_type TEXT,
    image TEXT,
    listed_at TEXT,
    source TEXT,
    fingerprint TEXT,
    description TEXT DEFAULT '',
    scraped_at TEXT DEFAULT (datetime('now')),
    sent INTEGER DEFAULT 0
  );
 
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    review_text TEXT NOT NULL,
    approved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS listing_cache (
    cache_id TEXT PRIMARY KEY,
    listing_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    listing_url TEXT NOT NULL,
    listing_json TEXT NOT NULL DEFAULT '{}',
    added_at TEXT DEFAULT (datetime('now')),
    UNIQUE(chat_id, listing_url)
  );

  CREATE TABLE IF NOT EXISTS application_tracker (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    listing_url TEXT NOT NULL,
    listing_address TEXT DEFAULT '',
    listing_price TEXT DEFAULT '',
    listing_image TEXT DEFAULT '',
    status TEXT DEFAULT 'applied' CHECK(status IN ('applied','viewing','rejected','accepted')),
    notes TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(chat_id, listing_url)
  );

  CREATE TABLE IF NOT EXISTS scraper_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    listings_found INTEGER,
    alerts_sent INTEGER,
    cycle_time_ms INTEGER,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS agency_intelligence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    agency_key TEXT,
    city TEXT,
    price_number REAL DEFAULT 0,
    requires_permanent_contract INTEGER DEFAULT 0,
    mentions_expats INTEGER DEFAULT 0,
    requires_income_proof INTEGER DEFAULT 0,
    excludes_students INTEGER DEFAULT 0,
    is_furnished INTEGER DEFAULT 0,
    has_garden INTEGER DEFAULT 0,
    url TEXT,
    inserted_at INTEGER,
    scraped_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cbs_neighbourhood_cache (
    lookup_key TEXT PRIMARY KEY,
    matched INTEGER DEFAULT 0,
    buurt_key TEXT,
    inwoners INTEGER,
    gem_inkomen REAL,
    huishoudens INTEGER,
    fetched_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS leefbaarometer_pc4 (
    pc4 TEXT PRIMARY KEY,
    score REAL,
    year INTEGER,
    fetched_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS ep_online_energylabel_cache (
    address_key TEXT PRIMARY KEY,
    postcode TEXT,
    huisnummer TEXT,
    energy_label TEXT,
    fetched_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS outcome_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    listing_url TEXT NOT NULL,
    score INTEGER,
    deal_score INTEGER,
    alerted_at INTEGER NOT NULL
  );
`);

try {
  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(r => r.name);
  if (userCols.includes('document_readiness') && !userCols.includes('application_readiness')) {
    db.exec(`ALTER TABLE users RENAME COLUMN document_readiness TO application_readiness`);
    console.log('[db] Migrated document_readiness → application_readiness');
  }
} catch (e) {}

try {
  const cacheCols = db.prepare(`PRAGMA table_info(listing_cache)`).all().map(r => r.name);
  if (!cacheCols.includes('score')) { db.exec(`ALTER TABLE listing_cache ADD COLUMN score INTEGER`); console.log('[db] Added score column to listing_cache'); }
  if (!cacheCols.includes('deal_score')) { db.exec(`ALTER TABLE listing_cache ADD COLUMN deal_score INTEGER`); console.log('[db] Added deal_score column to listing_cache'); }
  if (!cacheCols.includes('chat_id')) { db.exec(`ALTER TABLE listing_cache ADD COLUMN chat_id TEXT`); console.log('[db] Added chat_id column to listing_cache'); }
} catch (e) {}
 
try {
  const listingCols = db.prepare(`PRAGMA table_info(listings)`).all().map(r => r.name);
  if (listingCols.length > 0 && !listingCols.includes('fingerprint')) {
    db.exec(`ALTER TABLE listings ADD COLUMN fingerprint TEXT`);
    console.log('[db] Added fingerprint column to listings');
  }
  if (listingCols.length > 0 && !listingCols.includes('description')) {
    db.exec(`ALTER TABLE listings ADD COLUMN description TEXT DEFAULT ''`);
    console.log('[db] Added description column to listings');
  }
  if (listingCols.length > 0 && !listingCols.includes('postal_code')) {
    db.exec(`ALTER TABLE listings ADD COLUMN postal_code TEXT`);
    console.log('[db] Added postal_code column to listings');
  }
  if (listingCols.length > 0 && !listingCols.includes('neighbourhood')) {
    db.exec(`ALTER TABLE listings ADD COLUMN neighbourhood TEXT`);
    console.log('[db] Added neighbourhood column to listings');
  }
  if (listingCols.length > 0 && !listingCols.includes('llm_signals')) {
    db.exec(`ALTER TABLE listings ADD COLUMN llm_signals TEXT`);
    console.log('[db] Added llm_signals column to listings');
  }
  if (listingCols.length > 0 && !listingCols.includes('description_hash')) {
    db.exec(`ALTER TABLE listings ADD COLUMN description_hash TEXT`);
    console.log('[db] Added description_hash column to listings');
  }
  if (listingCols.length > 0 && !listingCols.includes('cbs_context')) {
    db.exec(`ALTER TABLE listings ADD COLUMN cbs_context TEXT`);
    console.log('[db] Added cbs_context column to listings');
  }
  if (listingCols.length > 0 && !listingCols.includes('leefbaarometer_score')) {
    db.exec(`ALTER TABLE listings ADD COLUMN leefbaarometer_score REAL`);
    console.log('[db] Added leefbaarometer_score column to listings');
  }
  if (listingCols.length > 0 && !listingCols.includes('energy_label_source')) {
    db.exec(`ALTER TABLE listings ADD COLUMN energy_label_source TEXT`);
    console.log('[db] Added energy_label_source column to listings');
  }
} catch (e) {}
 
try {
  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(r => r.name);
  if (userCols.length > 0 && !userCols.includes('deal_min')) {
    db.exec(`ALTER TABLE users ADD COLUMN deal_min INTEGER DEFAULT 0`);
    console.log('[db] Added deal_min column to users');
  }
  if (userCols.length > 0 && !userCols.includes('kans_min')) {
    db.exec(`ALTER TABLE users ADD COLUMN kans_min INTEGER DEFAULT 0`);
    console.log('[db] Added kans_min column to users');
  }
  if (!userCols.includes('met_partner')) db.exec(`ALTER TABLE users ADD COLUMN met_partner TEXT DEFAULT 'nee'`);
  if (!userCols.includes('partner_inkomen')) db.exec(`ALTER TABLE users ADD COLUMN partner_inkomen REAL DEFAULT 0`);
  if (!userCols.includes('heeft_borg')) db.exec(`ALTER TABLE users ADD COLUMN heeft_borg TEXT DEFAULT 'nee'`);
  if (!userCols.includes('user_description')) db.exec(`ALTER TABLE users ADD COLUMN user_description TEXT DEFAULT ''`);
  if (!userCols.includes('move_reason')) db.exec(`ALTER TABLE users ADD COLUMN move_reason TEXT DEFAULT ''`);
  if (!userCols.includes('tenant_quality')) db.exec(`ALTER TABLE users ADD COLUMN tenant_quality TEXT DEFAULT ''`);
} catch (e) {}

try {
  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(r => r.name);
  if (!userCols.includes('trial_start')) { db.exec(`ALTER TABLE users ADD COLUMN trial_start INTEGER`); console.log('[db] Added trial_start'); }
  if (!userCols.includes('last_alert_sent_at')) { db.exec(`ALTER TABLE users ADD COLUMN last_alert_sent_at INTEGER`); console.log('[db] Added last_alert_sent_at'); }
  if (!userCols.includes('last_no_alerts_notification_at')) { db.exec(`ALTER TABLE users ADD COLUMN last_no_alerts_notification_at INTEGER`); console.log('[db] Added last_no_alerts_notification_at'); }
  if (!userCols.includes('last_review_request_at')) { db.exec(`ALTER TABLE users ADD COLUMN last_review_request_at INTEGER`); console.log('[db] Added last_review_request_at'); }
} catch (e) {}
 
db.exec(`CREATE INDEX IF NOT EXISTS idx_fingerprint ON listings(fingerprint)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_cache_expires ON listing_cache(expires_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sent_listings_chat_id ON sent_listings(chat_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_favorites_chat_id ON favorites(chat_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_application_tracker_chat_id ON application_tracker(chat_id)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_listings_city_price ON listings(city, price_number)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_listings_sent ON listings(sent)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_users_chat ON users(chat_id)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_agency_intel_key ON agency_intelligence(agency_key)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_listings_description_hash ON listings(description_hash)'); } catch(e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_outcome_snapshots_chat_url ON outcome_snapshots(chat_id, listing_url)'); } catch(e) {}

// Startup health check — log path and user count so resets are immediately visible in logs
{
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const linkedCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE chat_id IS NOT NULL AND chat_id != ''").get().c;
  console.log(`[db] path=${DB_PATH} | users=${userCount} | linked=${linkedCount}`);
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  if (userCount === 0 && onRailway) {
    console.warn('[db] WARNING: no users found — if this is unexpected, the Railway volume at /app/data may not be mounted');
  }
}
 
const getUser = db.prepare('SELECT * FROM users WHERE chat_id = ?');
const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByCustomerId = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?');
const getAllActiveUsers = db.prepare('SELECT * FROM users WHERE actief = 1 AND betaald = 1');
 
const upsertUser = db.prepare(`
  INSERT INTO users (chat_id, naam, email, profiel_type, expat_status, contract_type, inkomen,
    application_readiness, beschikbaarheid_timing, type, woningtype, locatie, prijs_min, prijs_max,
    opp_min, kamers_min, energielabel, bouwjaar_min, tuin, parkeren, delen_toegestaan, huisdieren,
    gemeubileerd, beschikbaar_per, kans_min, deal_min, met_partner, partner_inkomen, heeft_borg,
    user_description, move_reason, tenant_quality)
  VALUES (:chat_id, :naam, :email, :profiel_type, :expat_status, :contract_type, :inkomen,
    :application_readiness, :beschikbaarheid_timing, :type, :woningtype, :locatie, :prijs_min, :prijs_max,
    :opp_min, :kamers_min, :energielabel, :bouwjaar_min, :tuin, :parkeren, :delen_toegestaan, :huisdieren,
    :gemeubileerd, :beschikbaar_per, :kans_min, :deal_min, :met_partner, :partner_inkomen, :heeft_borg,
    :user_description, :move_reason, :tenant_quality)
  ON CONFLICT(chat_id) DO UPDATE SET
    naam = excluded.naam, email = excluded.email, profiel_type = excluded.profiel_type,
    expat_status = excluded.expat_status, contract_type = excluded.contract_type,
    inkomen = excluded.inkomen, application_readiness = excluded.application_readiness,
    beschikbaarheid_timing = excluded.beschikbaarheid_timing, type = excluded.type,
    woningtype = excluded.woningtype, locatie = excluded.locatie, prijs_min = excluded.prijs_min,
    prijs_max = excluded.prijs_max, opp_min = excluded.opp_min, kamers_min = excluded.kamers_min,
    energielabel = excluded.energielabel, bouwjaar_min = excluded.bouwjaar_min,
    tuin = excluded.tuin, parkeren = excluded.parkeren, delen_toegestaan = excluded.delen_toegestaan,
    huisdieren = excluded.huisdieren, gemeubileerd = excluded.gemeubileerd,
    beschikbaar_per = excluded.beschikbaar_per, kans_min = excluded.kans_min,
    deal_min = excluded.deal_min, met_partner = excluded.met_partner,
    partner_inkomen = excluded.partner_inkomen, heeft_borg = excluded.heeft_borg,
    user_description = excluded.user_description, move_reason = excluded.move_reason,
    tenant_quality = excluded.tenant_quality
`);
 
const setUserActive = db.prepare('UPDATE users SET actief = ? WHERE chat_id = ?');
const setUserPaid = db.prepare(`
  UPDATE users SET betaald = 1, stripe_customer_id = ?, stripe_subscription_id = ?, trial_start_date = datetime('now')
  WHERE email = ?
`);
const setUserPaidByCustomerId = db.prepare(`
  UPDATE users SET betaald = 1, stripe_subscription_id = ?, trial_start_date = datetime('now')
  WHERE stripe_customer_id = ?
`);
const createUserByCustomerId = db.prepare(`
  INSERT OR IGNORE INTO users (chat_id, email, stripe_customer_id, stripe_subscription_id, betaald, actief, trial_start_date, trial_start)
  VALUES (?, ?, ?, ?, 1, 1, datetime('now'), ?)
`);
const clearOldChatId = db.prepare('UPDATE users SET chat_id = NULL WHERE chat_id = ? AND stripe_customer_id != ?');
const clearChatIdFromOthers = db.prepare(`
  UPDATE users SET chat_id = NULL WHERE chat_id = ? AND stripe_customer_id != ?
`);
const linkChatToCustomer = db.prepare(`
  UPDATE users SET chat_id = ? WHERE stripe_customer_id = ?
`);
const cancelUserByStripe = db.prepare('UPDATE users SET betaald = 0, actief = 0 WHERE stripe_customer_id = ?');
const cancelUserByChatId = db.prepare('UPDATE users SET betaald = 0, actief = 0 WHERE chat_id = ?');
const setUserChatId = db.prepare('UPDATE users SET chat_id = ? WHERE email = ?');
 
const isListingSent = db.prepare('SELECT 1 FROM sent_listings WHERE url = ? AND chat_id = ?');
const markListingSent = db.prepare('INSERT OR IGNORE INTO sent_listings (url, chat_id) VALUES (?, ?)');
 
const getChat = db.prepare('SELECT * FROM telegram_chats WHERE chat_id = ?');
const upsertChat = db.prepare(`
  INSERT INTO telegram_chats (chat_id, username, first_name)
  VALUES (?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name
`);
 
const listingExists = db.prepare('SELECT 1 FROM listings WHERE url = ?');
const getListingByUrl = db.prepare('SELECT * FROM listings WHERE url = ?');
const getSentListingByFingerprint = db.prepare(
  'SELECT url, source FROM listings WHERE fingerprint = ? AND sent = 1 LIMIT 1'
);
const insertListing = db.prepare(`
  INSERT OR IGNORE INTO listings (
    url, address, city, price, price_number, transaction_type, rooms, area,
    energy_label, construction_year, property_type, image, listed_at, source, fingerprint, description, sent,
    postal_code, neighbourhood
  ) VALUES (
    @url, @address, @city, @price, @priceNumber, @transactionType, @rooms, @area,
    @energyLabel, @constructionYear, @propertyType, @image, @listedAt, @source, @fingerprint, @description, @sent,
    @postalCode, @neighbourhood
  )
`);
const getUnsentListings = db.prepare('SELECT * FROM listings WHERE sent = 0');
const markListingGloballySent = db.prepare('UPDATE listings SET sent = 1 WHERE url = ?');
const updateListingDescription = db.prepare('UPDATE listings SET description = ? WHERE url = ?');
const updateListingImage = db.prepare("UPDATE listings SET image = ? WHERE url = ? AND (image IS NULL OR image = '')");
const updateListingLlmSignals = db.prepare('UPDATE listings SET llm_signals = ?, description_hash = ? WHERE url = ?');
const updateListingExternalData = db.prepare('UPDATE listings SET cbs_context = ?, leefbaarometer_score = ? WHERE url = ?');
const updateListingEnergyLabelFromEpOnline = db.prepare(
  "UPDATE listings SET energy_label = ?, energy_label_source = 'ep-online' WHERE url = ? AND (energy_label IS NULL OR energy_label = '')"
);
const getLlmSignalsByDescriptionHash = db.prepare(
  'SELECT llm_signals FROM listings WHERE description_hash = ? AND llm_signals IS NOT NULL LIMIT 1'
);

const getCbsNeighbourhoodCache = db.prepare('SELECT * FROM cbs_neighbourhood_cache WHERE lookup_key = ?');
const upsertCbsNeighbourhoodCache = db.prepare(`
  INSERT INTO cbs_neighbourhood_cache (lookup_key, matched, buurt_key, inwoners, gem_inkomen, huishoudens, fetched_at)
  VALUES (@lookupKey, @matched, @buurtKey, @inwoners, @gemInkomen, @huishoudens, @fetchedAt)
  ON CONFLICT(lookup_key) DO UPDATE SET
    matched = excluded.matched, buurt_key = excluded.buurt_key, inwoners = excluded.inwoners,
    gem_inkomen = excluded.gem_inkomen, huishoudens = excluded.huishoudens, fetched_at = excluded.fetched_at
`);

const getLeefbaarometerPc4 = db.prepare('SELECT * FROM leefbaarometer_pc4 WHERE pc4 = ?');
const countLeefbaarometerPc4 = db.prepare('SELECT COUNT(*) as c FROM leefbaarometer_pc4');
const upsertLeefbaarometerPc4 = db.prepare(`
  INSERT INTO leefbaarometer_pc4 (pc4, score, year, fetched_at)
  VALUES (@pc4, @score, @year, @fetchedAt)
  ON CONFLICT(pc4) DO UPDATE SET score = excluded.score, year = excluded.year, fetched_at = excluded.fetched_at
`);

const getEpOnlineEnergyLabel = db.prepare('SELECT * FROM ep_online_energylabel_cache WHERE address_key = ?');
const upsertEpOnlineEnergyLabel = db.prepare(`
  INSERT INTO ep_online_energylabel_cache (address_key, postcode, huisnummer, energy_label, fetched_at)
  VALUES (@addressKey, @postcode, @huisnummer, @energyLabel, @fetchedAt)
  ON CONFLICT(address_key) DO UPDATE SET energy_label = excluded.energy_label, fetched_at = excluded.fetched_at
`);
const getRecentListings = db.prepare(
  "SELECT * FROM listings WHERE scraped_at > datetime('now', '-7 days') ORDER BY scraped_at DESC"
);
 
const insertReview = db.prepare('INSERT INTO reviews (name, rating, review_text) VALUES (?, ?, ?)');
const getApprovedReviews = db.prepare('SELECT id, name, rating, review_text, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC');
const approveReview = db.prepare('UPDATE reviews SET approved = 1 WHERE id = ?');

const persistCacheListing = db.prepare(
  'INSERT OR REPLACE INTO listing_cache (cache_id, listing_json, expires_at, score, deal_score, chat_id) VALUES (?, ?, ?, ?, ?, ?)'
);
const getPersistedCacheListing = db.prepare(
  'SELECT listing_json FROM listing_cache WHERE cache_id = ? AND expires_at > ?'
);
const purgeExpiredCacheListings = db.prepare('DELETE FROM listing_cache WHERE expires_at <= ?');

const getFavorites = db.prepare('SELECT * FROM favorites WHERE chat_id = ? ORDER BY added_at DESC');
const addFavorite = db.prepare('INSERT OR REPLACE INTO favorites (chat_id, listing_url, listing_json) VALUES (?, ?, ?)');
const removeFavorite = db.prepare('DELETE FROM favorites WHERE chat_id = ? AND listing_url = ?');

const getApplicationTracker = db.prepare('SELECT * FROM application_tracker WHERE chat_id = ? ORDER BY updated_at DESC');

// Read-only outcome-learning infra (Laag 1) — permanent, no-TTL record of the score shown
// at alert time, written once per successfully-sent alert. Never pruned like listing_cache.
const insertOutcomeSnapshot = db.prepare(`
  INSERT INTO outcome_snapshots (chat_id, listing_url, score, deal_score, alerted_at)
  VALUES (@chatId, @listingUrl, @score, @dealScore, @alertedAt)
`);
// Joins tracked application status back to the score at alert time via outcome_snapshots
// (permanent), not the volatile 48h/500-row listing_cache. Picks the most recent snapshot
// per (chat_id, listing_url) in case a listing was alerted more than once.
const getTrackerOutcomesWithScores = db.prepare(`
  SELECT at.chat_id, at.listing_url, at.status, at.updated_at, os.score, os.deal_score
  FROM application_tracker at
  JOIN outcome_snapshots os
    ON os.id = (
      SELECT id FROM outcome_snapshots os2
      WHERE os2.chat_id = at.chat_id AND os2.listing_url = at.listing_url
      ORDER BY os2.alerted_at DESC LIMIT 1
    )
  WHERE os.score IS NOT NULL
`);
// Same join, scoped to one user — used by the Rejection Analyser to cross-reference the
// user's own objective outcome history (real Application Score at alert time vs what actually
// happened) alongside whatever they type in about past rejections.
const getTrackerOutcomesWithScoresForChat = db.prepare(`
  SELECT at.listing_url, at.listing_address, at.status, at.updated_at, os.score, os.deal_score
  FROM application_tracker at
  JOIN outcome_snapshots os
    ON os.id = (
      SELECT id FROM outcome_snapshots os2
      WHERE os2.chat_id = at.chat_id AND os2.listing_url = at.listing_url
      ORDER BY os2.alerted_at DESC LIMIT 1
    )
  WHERE os.score IS NOT NULL AND at.chat_id = ?
  ORDER BY at.updated_at DESC LIMIT 20
`);
const countApplicationTrackerAll = db.prepare('SELECT COUNT(*) as c FROM application_tracker');
const upsertApplicationStatus = db.prepare(`
  INSERT INTO application_tracker (chat_id, listing_url, listing_address, listing_price, listing_image, status, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(chat_id, listing_url) DO UPDATE SET
    status = excluded.status, notes = excluded.notes, updated_at = datetime('now'),
    listing_address = COALESCE(NULLIF(excluded.listing_address,''), listing_address),
    listing_price = COALESCE(NULLIF(excluded.listing_price,''), listing_price),
    listing_image = COALESCE(NULLIF(excluded.listing_image,''), listing_image)
`);
const removeApplicationStatus = db.prepare('DELETE FROM application_tracker WHERE chat_id = ? AND listing_url = ?');

const updateLastAlertSentAt = db.prepare('UPDATE users SET last_alert_sent_at = ? WHERE chat_id = ?');
const updateLastNoAlertsNotificationAt = db.prepare('UPDATE users SET last_no_alerts_notification_at = ? WHERE chat_id = ?');
const updateLastReviewRequestAt = db.prepare('UPDATE users SET last_review_request_at = ? WHERE chat_id = ?');

const getUsersForTrialReminder = db.prepare(`
  SELECT * FROM users WHERE actief = 1 AND email IS NOT NULL AND email != ''
  AND trial_start IS NOT NULL AND trial_start > ? AND trial_start < ?
`);
const getUsersForNoAlertsNotification = db.prepare(`
  SELECT * FROM users WHERE actief = 1 AND betaald = 1
  AND chat_id IS NOT NULL AND chat_id != ''
  AND (last_alert_sent_at IS NULL OR last_alert_sent_at < ?)
  AND created_at < ?
  AND (last_no_alerts_notification_at IS NULL OR last_no_alerts_notification_at < ?)
`);
const getUsersForReviewRequest = db.prepare(`
  SELECT * FROM users WHERE actief = 1 AND betaald = 1
  AND chat_id IS NOT NULL AND chat_id != ''
  AND last_review_request_at IS NULL
  AND created_at <= datetime('now', '-14 days')
`);

const insertScraperStat = db.prepare(
  'INSERT INTO scraper_stats (source, listings_found, alerts_sent, cycle_time_ms, created_at) VALUES (?, ?, ?, ?, ?)'
);

const getCityPriceBenchmark = db.prepare(`
  SELECT
    AVG(price_number * 1.0 / NULLIF(area, 0)) as avg_ppm2,
    COUNT(*) as sample_size,
    MIN(price_number) as min_price,
    MAX(price_number) as max_price
  FROM listings
  WHERE city = ?
    AND price_number > 0
    AND area > 0
    AND transaction_type = ?
    AND scraped_at > datetime('now', '-30 days')
`);

const getNeighbourhoodPriceBenchmark = db.prepare(`
  SELECT
    AVG(price_number * 1.0 / NULLIF(area, 0)) as avg_ppm2,
    COUNT(*) as sample_size,
    MIN(price_number) as min_price,
    MAX(price_number) as max_price
  FROM listings
  WHERE city = ?
    AND neighbourhood = ?
    AND price_number > 0
    AND area > 0
    AND transaction_type = ?
    AND scraped_at > datetime('now', '-30 days')
`);

const getListingVolumeByCity = db.prepare(`
  SELECT COUNT(*) as total, AVG(price_number) as avg_price
  FROM listings
  WHERE city = ?
    AND transaction_type = ?
    AND scraped_at > datetime('now', '-7 days')
`);

const insertAgencyListing = db.prepare(`
  INSERT INTO agency_intelligence
    (source, agency_key, city, price_number, requires_permanent_contract, mentions_expats,
     requires_income_proof, excludes_students, is_furnished, has_garden, url, inserted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getAgencyInsights = db.prepare(`
  SELECT
    COUNT(*) as total,
    ROUND(AVG(requires_permanent_contract) * 100) as pct_contract,
    ROUND(AVG(mentions_expats) * 100) as pct_expats,
    ROUND(AVG(requires_income_proof) * 100) as pct_income,
    ROUND(AVG(excludes_students) * 100) as pct_no_students,
    ROUND(AVG(is_furnished) * 100) as pct_furnished
  FROM agency_intelligence
  WHERE agency_key = ?
`);

module.exports = {
  db, dbPath: DB_PATH,
  getUser, getUserByEmail, getUserByCustomerId, getAllActiveUsers, upsertUser, setUserActive,
  setUserPaid, setUserPaidByCustomerId, createUserByCustomerId, linkChatToCustomer,
  cancelUserByStripe, cancelUserByChatId, setUserChatId, clearChatIdFromOthers,
  isListingSent, markListingSent, getChat, upsertChat,
  listingExists, getListingByUrl, getSentListingByFingerprint, insertListing,
  getUnsentListings, markListingGloballySent, updateListingDescription, updateListingImage,
  insertReview, getApprovedReviews, approveReview,
  persistCacheListing, getPersistedCacheListing, purgeExpiredCacheListings,
  getRecentListings,
  getFavorites, addFavorite, removeFavorite,
  getApplicationTracker, upsertApplicationStatus, removeApplicationStatus,
  getTrackerOutcomesWithScores, getTrackerOutcomesWithScoresForChat, countApplicationTrackerAll, insertOutcomeSnapshot,
  updateLastAlertSentAt, updateLastNoAlertsNotificationAt, updateLastReviewRequestAt,
  getUsersForTrialReminder, getUsersForNoAlertsNotification, getUsersForReviewRequest,
  insertScraperStat, getCityPriceBenchmark, getNeighbourhoodPriceBenchmark, getListingVolumeByCity,
  updateListingLlmSignals, getLlmSignalsByDescriptionHash,
  updateListingExternalData, updateListingEnergyLabelFromEpOnline,
  getCbsNeighbourhoodCache, upsertCbsNeighbourhoodCache,
  getLeefbaarometerPc4, countLeefbaarometerPc4, upsertLeefbaarometerPc4,
  getEpOnlineEnergyLabel, upsertEpOnlineEnergyLabel,
  insertAgencyListing, getAgencyInsights,
};
 