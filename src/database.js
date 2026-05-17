const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DATABASE_URL || '/tmp/homeseeker.db';
const db = const db = new Database(DB_PATH);

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
`);

// Migrate existing DBs that still have the old column name
try {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map(r => r.name);
  if (cols.includes('document_readiness') && !cols.includes('application_readiness')) {
    db.exec(`ALTER TABLE users RENAME COLUMN document_readiness TO application_readiness`);
    console.log('[db] Migrated document_readiness → application_readiness');
  }
} catch (e) {
  // ALTER COLUMN not supported on very old SQLite — ignore
}

// ── Prepared statements ──────────────────────────────────

const getUser = db.prepare('SELECT * FROM users WHERE chat_id = ?');
const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const getAllActiveUsers = db.prepare('SELECT * FROM users WHERE actief = 1 AND betaald = 1');

const upsertUser = db.prepare(`
  INSERT INTO users (chat_id, naam, email, profiel_type, expat_status, contract_type, inkomen,
    application_readiness, beschikbaarheid_timing, type, woningtype, locatie, prijs_min, prijs_max,
    opp_min, kamers_min, energielabel, bouwjaar_min, tuin, parkeren, delen_toegestaan, huisdieren,
    gemeubileerd, beschikbaar_per, kans_min)
  VALUES (:chat_id, :naam, :email, :profiel_type, :expat_status, :contract_type, :inkomen,
    :application_readiness, :beschikbaarheid_timing, :type, :woningtype, :locatie, :prijs_min, :prijs_max,
    :opp_min, :kamers_min, :energielabel, :bouwjaar_min, :tuin, :parkeren, :delen_toegestaan, :huisdieren,
    :gemeubileerd, :beschikbaar_per, :kans_min)
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
    beschikbaar_per = excluded.beschikbaar_per, kans_min = excluded.kans_min
`);

const setUserActive = db.prepare('UPDATE users SET actief = ? WHERE chat_id = ?');
const setUserPaid = db.prepare(`
  UPDATE users SET betaald = 1, stripe_customer_id = ?, stripe_subscription_id = ?, trial_start_date = datetime('now')
  WHERE email = ?
`);
const cancelUserByStripe = db.prepare(
  'UPDATE users SET betaald = 0, actief = 0 WHERE stripe_customer_id = ?'
);
const cancelUserByChatId = db.prepare(
  'UPDATE users SET betaald = 0, actief = 0 WHERE chat_id = ?'
);
const setUserChatId = db.prepare('UPDATE users SET chat_id = ? WHERE email = ?');

const isListingSent = db.prepare('SELECT 1 FROM sent_listings WHERE url = ? AND chat_id = ?');
const markListingSent = db.prepare(
  'INSERT OR IGNORE INTO sent_listings (url, chat_id) VALUES (?, ?)'
);

const getChat = db.prepare('SELECT * FROM telegram_chats WHERE chat_id = ?');
const upsertChat = db.prepare(`
  INSERT INTO telegram_chats (chat_id, username, first_name)
  VALUES (?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name
`);

module.exports = {
  db,
  getUser,
  getUserByEmail,
  getAllActiveUsers,
  upsertUser,
  setUserActive,
  setUserPaid,
  cancelUserByStripe,
  cancelUserByChatId,
  setUserChatId,
  isListingSent,
  markListingSent,
  getChat,
  upsertChat,
};
