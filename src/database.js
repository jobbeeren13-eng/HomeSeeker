const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_URL || '/tmp/homeseeker.db';
if (!fs.existsSync('/tmp')) fs.mkdirSync('/tmp', { recursive: true });
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
    scraped_at TEXT DEFAULT (datetime('now')),
    sent INTEGER DEFAULT 0
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
  const listingCols = db.prepare(`PRAGMA table_info(listings)`).all().map(r => r.name);
  if (listingCols.length > 0 && !listingCols.includes('fingerprint')) {
    db.exec(`ALTER TABLE listings ADD COLUMN fingerprint TEXT`);
    console.log('[db] Added fingerprint column to listings');
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
} catch (e) {}


  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    review_text TEXT NOT NULL,
    approved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

db.exec(`CREATE INDEX IF NOT EXISTS idx_fingerprint ON listings(fingerprint)`);

const getUser = db.prepare('SELECT * FROM users WHERE chat_id = ?');
const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByCustomerId = db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?');
const getAllActiveUsers = db.prepare('SELECT * FROM users WHERE actief = 1 AND betaald = 1');

const upsertUser = db.prepare(`
  INSERT INTO users (chat_id, naam, email, profiel_type, expat_status, contract_type, inkomen,
    application_readiness, beschikbaarheid_timing, type, woningtype, locatie, prijs_min, prijs_max,
    opp_min, kamers_min, energielabel, bouwjaar_min, tuin, parkeren, delen_toegestaan, huisdieren,
    gemeubileerd, beschikbaar_per, kans_min, deal_min, met_partner, partner_inkomen, heeft_borg)
  VALUES (:chat_id, :naam, :email, :profiel_type, :expat_status, :contract_type, :inkomen,
    :application_readiness, :beschikbaarheid_timing, :type, :woningtype, :locatie, :prijs_min, :prijs_max,
    :opp_min, :kamers_min, :energielabel, :bouwjaar_min, :tuin, :parkeren, :delen_toegestaan, :huisdieren,
    :gemeubileerd, :beschikbaar_per, :kans_min, :deal_min, :met_partner, :partner_inkomen, :heeft_borg)
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
    deal_min = excluded.deal_min, met_partner = excluded.met_partner, partner_inkomen = excluded.partner_inkomen, heeft_borg = excluded.heeft_borg
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
  INSERT OR IGNORE INTO users (chat_id, email, stripe_customer_id, stripe_subscription_id, betaald, actief, trial_start_date)
  VALUES (?, ?, ?, ?, 1, 1, datetime('now'))
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
    energy_label, construction_year, property_type, image, listed_at, source, fingerprint, sent
  ) VALUES (
    @url, @address, @city, @price, @priceNumber, @transactionType, @rooms, @area,
    @energyLabel, @constructionYear, @propertyType, @image, @listedAt, @source, @fingerprint, @sent
  )
`);
const getUnsentListings = db.prepare('SELECT * FROM listings WHERE sent = 0');
const markListingGloballySent = db.prepare('UPDATE listings SET sent = 1 WHERE url = ?');


const insertReview = db.prepare('INSERT INTO reviews (name, rating, review_text) VALUES (?, ?, ?)');
const getApprovedReviews = db.prepare('SELECT id, name, rating, review_text, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC');
const approveReview = db.prepare('UPDATE reviews SET approved = 1 WHERE id = ?');

module.exports = {
  db, getUser, getUserByEmail, getUserByCustomerId, getAllActiveUsers, upsertUser, setUserActive,
  setUserPaid, setUserPaidByCustomerId, createUserByCustomerId, linkChatToCustomer,
  cancelUserByStripe, cancelUserByChatId, setUserChatId,
  isListingSent, markListingSent, getChat, upsertChat,
  listingExists, getListingByUrl, getSentListingByFingerprint, insertListing,
  getUnsentListings, markListingGloballySent,
  insertReview, getApprovedReviews, approveReview,
};
