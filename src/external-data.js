const {
  getCbsNeighbourhoodCache, upsertCbsNeighbourhoodCache,
  getLeefbaarometerPc4, countLeefbaarometerPc4, upsertLeefbaarometerPc4,
} = require('./database');
const { sendAdminAlert } = require('./admin-alert');

// ── Feature flags — each source is independently killable without a code change ──
const CBS_ENABLED = process.env.ENABLE_CBS_DATA !== 'false';               // free, public — default on
const LEEFBAAROMETER_ENABLED = process.env.ENABLE_LEEFBAAROMETER !== 'false'; // free, public — default on

const CBS_CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // CBS updates this table ~yearly
const LEEFBAAROMETER_YEAR = 2020;
const LEEFBAAROMETER_CSV_URL =
  'https://data.overheid.nl/sites/default/files/dataset/f37c3649-cc52-4e48-a864-870ae42807a2/resources/Leefbaarometer%203.0%20-%20meting%202020%20-%20scores%20PC4.csv';

// Per-source alert cooldown so a broken source pages once per window, not once per listing
const lastAlertAt = {};
function maybeAlert(source, msg) {
  const now = Date.now();
  if (now - (lastAlertAt[source] || 0) > 30 * 60 * 1000) {
    lastAlertAt[source] = now;
    sendAdminAlert(`[${source}] ${msg}`);
  }
}

function normaliseForMatch(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, '-');
}

// ─────────────────────────────────────────────
// CBS StatLine — Kerncijfers wijken en buurten (86165NED)
// ─────────────────────────────────────────────

async function fetchCbsWijkStats(city, neighbourhood) {
  const escaped = neighbourhood.replace(/'/g, "''");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const dimUrl = `https://opendata.cbs.nl/ODataApi/odata/86165NED/WijkenEnBuurten?$filter=Title eq '${escaped}' and startswith(Key,'BU')&$format=json`;
    const dimResp = await fetch(dimUrl, { signal: controller.signal });
    if (!dimResp.ok) throw new Error(`WijkenEnBuurten HTTP ${dimResp.status}`);
    const dimData = await dimResp.json();
    const candidates = dimData.value || [];
    if (!candidates.length) return { matched: false };

    for (const cand of candidates) {
      const statsUrl = `https://opendata.cbs.nl/ODataApi/odata/86165NED/TypedDataSet?$filter=WijkenEnBuurten eq '${cand.Key}'&$format=json`;
      const statsResp = await fetch(statsUrl, { signal: controller.signal });
      if (!statsResp.ok) continue;
      const statsData = await statsResp.json();
      const row = (statsData.value || [])[0];
      if (!row) continue;
      const gemeente = normaliseForMatch(row.Gemeentenaam_1);
      if (gemeente !== normaliseForMatch(city)) continue;

      return {
        matched: true,
        buurtKey: cand.Key,
        inwoners: row.AantalInwoners_5 ?? null,
        gemInkomen: row.GemiddeldInkomenPerInwoner_78 ?? null,
        huishoudens: row.HuishoudensTotaal_29 ?? null,
      };
    }
    return { matched: false };
  } finally {
    clearTimeout(timer);
  }
}

async function getCbsContext(listing) {
  if (!CBS_ENABLED) return null;
  const city = listing.city || '';
  const neighbourhood = listing.neighbourhood || '';
  if (!city || !neighbourhood) return null;

  const lookupKey = `${normaliseForMatch(city)}|${normaliseForMatch(neighbourhood)}`;
  try {
    const cached = getCbsNeighbourhoodCache.get(lookupKey);
    if (cached && Date.now() - (cached.fetched_at || 0) < CBS_CACHE_TTL_MS) {
      if (!cached.matched) return null;
      return { inwoners: cached.inwoners, gemInkomen: cached.gem_inkomen, huishoudens: cached.huishoudens };
    }

    const result = await fetchCbsWijkStats(city, neighbourhood);
    upsertCbsNeighbourhoodCache.run({
      lookupKey,
      matched: result.matched ? 1 : 0,
      buurtKey: result.buurtKey || null,
      inwoners: result.inwoners ?? null,
      gemInkomen: result.gemInkomen ?? null,
      huishoudens: result.huishoudens ?? null,
      fetchedAt: Date.now(),
    });

    if (!result.matched) return null;
    return { inwoners: result.inwoners, gemInkomen: result.gemInkomen, huishoudens: result.huishoudens };
  } catch (e) {
    console.error('[external-data] CBS lookup failed (non-fatal):', e.message);
    maybeAlert('cbs', `CBS StatLine lookup failing: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// Leefbaarometer — PC4-level score, meting 2020 (bulk CSV, cached locally)
// ─────────────────────────────────────────────

let leefbaarometerLoadPromise = null;

function parseLeefbaarometerCsv(text) {
  const lines = text.split('\n');
  const header = lines[0].split(',');
  const pc4Idx = header.indexOf('PC4');
  const jaarIdx = header.indexOf('jaar');
  const lbmIdx = header.indexOf('lbm');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    const jaar = parseInt(cols[jaarIdx], 10);
    if (jaar !== LEEFBAAROMETER_YEAR) continue;
    const pc4 = cols[pc4Idx];
    const score = parseFloat(cols[lbmIdx]);
    if (!pc4 || Number.isNaN(score)) continue;
    rows.push({ pc4, score, year: jaar, fetchedAt: Date.now() });
  }
  return rows;
}

async function loadLeefbaarometerData() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(LEEFBAAROMETER_CSV_URL, { signal: controller.signal });
    if (!resp.ok) throw new Error(`Leefbaarometer CSV HTTP ${resp.status}`);
    const text = await resp.text();
    const rows = parseLeefbaarometerCsv(text);
    if (!rows.length) throw new Error('Leefbaarometer CSV parsed to 0 rows');
    for (const row of rows) upsertLeefbaarometerPc4.run(row);
    console.log(`[external-data] Leefbaarometer: loaded ${rows.length} PC4 scores (meting ${LEEFBAAROMETER_YEAR})`);
  } finally {
    clearTimeout(timer);
  }
}

async function ensureLeefbaarometerLoaded() {
  if (!LEEFBAAROMETER_ENABLED) return;
  try {
    const { c } = countLeefbaarometerPc4.get();
    if (c > 0) return;
    if (!leefbaarometerLoadPromise) leefbaarometerLoadPromise = loadLeefbaarometerData();
    await leefbaarometerLoadPromise;
  } catch (e) {
    leefbaarometerLoadPromise = null;
    console.error('[external-data] Leefbaarometer load failed (non-fatal):', e.message);
    maybeAlert('leefbaarometer', `Leefbaarometer CSV load failing: ${e.message}`);
  }
}

function getLeefbaarometerScore(postalCode) {
  if (!LEEFBAAROMETER_ENABLED) return null;
  const pc4 = (postalCode || '').trim().slice(0, 4);
  if (!/^\d{4}$/.test(pc4)) return null;
  try {
    const row = getLeefbaarometerPc4.get(pc4);
    return row ? { score: row.score, year: row.year } : null;
  } catch (e) {
    console.error('[external-data] Leefbaarometer read failed (non-fatal):', e.message);
    return null;
  }
}

module.exports = {
  CBS_ENABLED, LEEFBAAROMETER_ENABLED,
  getCbsContext, ensureLeefbaarometerLoaded, getLeefbaarometerScore,
};
