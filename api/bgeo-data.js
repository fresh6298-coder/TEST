// Consolidates what used to be three separate serverless functions
// (onchain-metrics, hodl-waves, m2-global) into one. All three share the
// exact same BGeometrics/bitcoin-data.com fetch+auth+Redis-archive
// machinery — the only difference was which path(s) got requested and
// how each row got normalized. Vercel's Hobby plan caps a deployment at
// 12 Serverless Functions; adding api/ask.js pushed this project to 13
// root-level function files and every deployment since started failing
// within ~3-5s (the fast, pre-build "too many functions" rejection, not
// a real build error). Merging these three back into one function frees
// up two slots.
//
// vercel.json rewrites /api/onchain-metrics, /api/hodl-waves, and
// /api/m2-global to this file with a `type` query param, so none of the
// existing frontend fetch("/api/...") calls needed to change.
const BGEO_AUTH_BASE = "https://api.bgeometrics.com/v1";
const BGEO_ANON_BASE = "https://bitcoin-data.com/v1";
const BGEO_TOKEN = process.env.BGEOMETRICS_API_TOKEN;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};
// Originally tried 3 query variants per base to probe for a "full
// history" param, but production evidence across many metrics/requests
// showed the extra variants never returned more rows than a bare request
// — they only burned through the anonymous base's rate limit and
// triggered 429s on the very next variant in the same request. Down to
// one variant each now.
const HISTORY_QUERY_VARIANTS = [""];
const AUTH_QUERY_VARIANTS = [""];

const NON_VALUE_KEY = /^(d|date|id|unix.*|timestamp|ts|epoch|createdat|updatedat|blockheight|height)$/i;

async function fetchJson(url, useAuth) {
  const headers = useAuth && BGEO_TOKEN ? { ...HEADERS, Authorization: `Bearer ${BGEO_TOKEN}` } : HEADERS;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const err = new Error(`${url} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function isNumeric(v) {
  return typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(parseFloat(v)));
}

// Picks the date-like field, then prefers a value field whose name
// matches `hint`, falling back to the first remaining numeric field
// that isn't a timestamp/id lookalike. Used for single-value datasets
// (on-chain metrics, Global M2).
function normalizeRecord(row, hint) {
  if (!row || typeof row !== "object") return null;
  const keys = Object.keys(row);
  const dateKey = keys.find((k) => /^(d|date)$/i.test(k)) || keys.find((k) => /time|timestamp/i.test(k)) || keys[0];
  const candidates = keys.filter((k) => k !== dateKey && !NON_VALUE_KEY.test(k) && isNumeric(row[k]));
  const valueKey = (hint && candidates.find((k) => hint.test(k))) || candidates[0];
  if (!dateKey || !valueKey) return null;
  const value = parseFloat(row[valueKey]);
  if (Number.isNaN(value)) return null;
  const dateMs = Date.parse(row[dateKey]);
  return { date: row[dateKey], dateMs: Number.isNaN(dateMs) ? null : dateMs, value };
}

function normalizeSeries(json, hint) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  return rows.map((row) => normalizeRecord(row, hint)).filter(Boolean);
}

// HODL Waves keeps every numeric band field found on a row instead of
// picking just one — the frontend discovers band keys from the data
// itself rather than a hardcoded list.
function normalizeBandRow(row) {
  if (!row || typeof row !== "object") return null;
  const keys = Object.keys(row);
  const dateKey = keys.find((k) => /^(d|date)$/i.test(k)) || keys.find((k) => /time|timestamp/i.test(k)) || keys[0];
  if (!dateKey) return null;
  const dateMs = Date.parse(row[dateKey]);
  if (Number.isNaN(dateMs)) return null;

  const bands = {};
  keys.forEach((k) => {
    if (k === dateKey || NON_VALUE_KEY.test(k) || !isNumeric(row[k])) return;
    bands[k] = parseFloat(row[k]);
  });
  if (!Object.keys(bands).length) return null;

  return { date: row[dateKey], dateMs, bands };
}

function normalizeBandSeries(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  return rows.map(normalizeBandRow).filter(Boolean);
}

async function fetchFullHistory(path) {
  const attempts = [];
  if (BGEO_TOKEN) {
    AUTH_QUERY_VARIANTS.forEach((q) => attempts.push({ base: BGEO_AUTH_BASE, q, auth: true }));
  }
  HISTORY_QUERY_VARIANTS.forEach((q) => attempts.push({ base: BGEO_ANON_BASE, q, auth: false }));

  let best = null;
  let authSucceeded = false;
  let authRateLimited = false;
  let authAttemptsMade = 0;
  const debug = [];
  for (const { base, q, auth } of attempts) {
    const label = `${auth ? "auth" : "anon"} ${base}/${path}${q || "(no query)"}`;
    if (auth) authAttemptsMade++;
    try {
      const json = await fetchJson(`${base}/${path}${q}`, auth);
      const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      debug.push(`${label} -> ${rows.length} rows`);
      if (auth && rows.length) authSucceeded = true;
      if (rows.length && (!best || rows.length > best.rows.length)) {
        best = { json, rows, source: base };
      }
    } catch (err) {
      debug.push(`${label} -> ERROR ${err.status || err.message}`);
      if (auth && err.status === 429) authRateLimited = true;
    }
  }
  // Auth counts as "resolved" (no need to retry later) once it succeeds or
  // fails for a reason other than rate-limiting (e.g. a bad/expired
  // token). A 429 just means the quota needs to reset, so a future
  // request should try again rather than giving up on auth forever.
  const authResolved = authAttemptsMade === 0 || authSucceeded || !authRateLimited;
  if (!best) {
    const e = new Error("no data from any query variant");
    e.debug = debug;
    e.authResolved = authResolved;
    throw e;
  }
  best.debug = debug;
  best.authResolved = authResolved;
  return best;
}

// ---- Persistent archive (Upstash Redis) ----
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisGetArchive(key) {
  const res = await fetch(`${REDIS_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`redis GET failed: ${res.status}`);
  const data = await res.json();
  if (!data.result) return { authAttempted: false, authLastAttemptMs: null, rows: [] };
  try {
    const parsed = JSON.parse(data.result);
    if (Array.isArray(parsed)) return { authAttempted: false, authLastAttemptMs: null, rows: parsed }; // pre-token archive format
    return {
      authAttempted: !!parsed.authAttempted,
      authLastAttemptMs: typeof parsed.authLastAttemptMs === "number" ? parsed.authLastAttemptMs : null,
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    };
  } catch {
    return { authAttempted: false, authLastAttemptMs: null, rows: [] };
  }
}

async function redisSetArchive(key, rows, authAttempted, authLastAttemptMs) {
  await fetch(`${REDIS_URL}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "text/plain" },
    body: JSON.stringify({ authAttempted, authLastAttemptMs, rows }),
  });
}

function mergeHistory(existing, fresh) {
  const byDate = new Map(existing.map((r) => [r.dateMs ?? r.date, r]));
  fresh.forEach((r) => byDate.set(r.dateMs ?? r.date, r)); // fresh wins on overlapping dates
  return [...byDate.values()].sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Shared "load one dataset, merging into its Redis archive" routine.
// `normalize` turns the raw upstream JSON into rows; `freshnessMs`
// controls how long an archive is trusted before re-fetching (on-chain
// metrics/HODL waves update daily, Global M2 is monthly-ish so a week is
// plenty).
// BGeometrics' free tier is 10 req/hour, 15/day (confirmed from their
// pricing page) — a 429 must not be retried on literally every request,
// or with ~9 metrics all doing that on every page load, we permanently
// self-exhaust the hourly quota and auth never gets a chance to recover.
const AUTH_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

// All ~10 metrics were originally backfilled within minutes of each
// other, so their plain 24h freshness windows expire at nearly the same
// moment every day — that synchronized burst (up to 10 auth + 10 anon
// requests all at once) is what's been exhausting the paid tier's
// 200/hour cap, not routine daily traffic. A deterministic per-path
// jitter spreads that burst across a few extra hours instead.
const STAGGER_WINDOW_MS = 4 * 60 * 60 * 1000;
function staggerJitter(path) {
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
  return hash % STAGGER_WINDOW_MS;
}

async function loadDataset({ archiveKey, path, hint, normalize, freshnessMs, forceAuth }) {
  let existing = { authAttempted: false, authLastAttemptMs: null, rows: [] };
  if (redisConfigured()) {
    try {
      existing = await redisGetArchive(archiveKey);
    } catch {
      existing = { authAttempted: false, authLastAttemptMs: null, rows: [] };
    }
  }

  // A token that's now configured but was never tried against this
  // archive must force a fresh attempt regardless of date-freshness —
  // otherwise an archive that already happens to include today's date
  // (built before the token existed) would silently keep serving the
  // old, shorter window forever. But once a 429 has been hit, wait out
  // the cooldown before trying again instead of retrying every request.
  // `forceAuth` (?refresh=1) bypasses the cooldown for manual verification
  // right after a token change, since Redis remembers the last-attempt
  // timestamp across deploys and would otherwise make a just-fixed token
  // look like it's still not working for up to an hour.
  const authCooldownActive = !forceAuth && Boolean(existing.authLastAttemptMs) && Date.now() - existing.authLastAttemptMs < AUTH_RETRY_COOLDOWN_MS;
  const needsAuthAttempt = Boolean(BGEO_TOKEN) && !existing.authAttempted && !authCooldownActive;
  const rows = existing.rows;
  const latestMs = rows.length ? rows[rows.length - 1].dateMs : null;
  const archiveIsFreshEnough = !needsAuthAttempt && latestMs != null && Date.now() - latestMs < freshnessMs + staggerJitter(path);

  let fresh = null;
  let fetchDebug = archiveIsFreshEnough ? ["skipped (archive already fresh)"] : null;
  let freshSource = null;
  let authResolved = false;
  const willAttemptAuth = !archiveIsFreshEnough && Boolean(BGEO_TOKEN);
  if (!archiveIsFreshEnough) {
    try {
      const best = await fetchFullHistory(path);
      fresh = normalize(best.json, hint);
      fetchDebug = best.debug;
      freshSource = best.source;
      authResolved = Boolean(best.authResolved);
    } catch (err) {
      fetchDebug = err.debug || [String(err.message)];
      authResolved = Boolean(err.authResolved);
    }
  }

  let history = rows;
  // Only latch authAttempted once auth has actually been resolved one way
  // or the other — a 429 (rate limit) must NOT get recorded as "tried",
  // or a future request (once the provider's quota resets) would never
  // attempt auth again. authLastAttemptMs tracks *when* we last tried,
  // regardless of outcome, so the cooldown above has something to check.
  const authAttempted = existing.authAttempted || (Boolean(BGEO_TOKEN) && authResolved);
  const authLastAttemptMs = willAttemptAuth ? Date.now() : existing.authLastAttemptMs;
  if (fresh) history = mergeHistory(rows, fresh);
  if (redisConfigured() && (fresh || willAttemptAuth)) {
    await redisSetArchive(archiveKey, history, authAttempted, authLastAttemptMs).catch(() => {});
  }

  return { history, source: freshSource, debug: fetchDebug };
}

const ONCHAIN_METRICS = {
  mvrvZscore: { path: "mvrv-zscore", hint: /mvrv/i },
  // Same "graphics endpoint implies a JSON sibling" reasoning as
  // lth-sopr/sth-sopr below — bgeometrics' own MVRV chart tool shows
  // LTH-MVRV/STH-MVRV lines, and "lth_mvrv.html"/"sth_mvrv.html" exist.
  lthMvrv: { path: "lth-mvrv", hint: /mvrv/i },
  sthMvrv: { path: "sth-mvrv", hint: /mvrv/i },
  nupl: { path: "nupl", hint: /nupl|unrealized/i },
  puellMultiple: { path: "puell-multiple", hint: /puell/i },
  sopr: { path: "sopr", hint: /sopr/i },
  // Best-effort paths (not in bgeometrics' published endpoint list, but
  // "lth_sopr.html"/"sth_sopr.html" graphics endpoints exist, suggesting
  // these JSON siblings do too, following the kebab-case convention every
  // other /v1 path here uses).
  lthSopr: { path: "lth-sopr", hint: /sopr/i },
  sthSopr: { path: "sth-sopr", hint: /sopr/i },
  reserveRisk: { path: "reserve-risk", hint: /reserve/i },
  aviv: { path: "aviv", hint: /aviv/i },
  stockToFlow: { path: "stock", hint: /stock/i },
  // Confirmed working (anon tier returned 1461 rows). Not in bgeometrics'
  // own published endpoint list, but reachable anyway.
  realizedPrice: { path: "realized-price", hint: /realized/i },
  // Unverified best-effort guess: "btc-crypto" was in bgeometrics' own
  // endpoint list. If this is BTC/USD price, it likely shares the same
  // 2009+ coverage as their other metrics, which would let the frontend
  // fill in BTC price for dates before Yahoo Finance's ~2014-09-17 start
  // (see onchain.html's getBtcSeriesCached). If the path is wrong or the
  // value field isn't actually price, this just fails and gets dropped
  // like any other failed metric — nothing downstream assumes it exists.
  btcCrypto: { path: "btc-crypto", hint: /price|close|usd|btc/i },
  // Confirmed working (auth tier returned 5321 rows, current value
  // matched the user's reference chart almost exactly). The LTH "cost
  // basis" line for CryptoQuant's "LTH Realized Profit and Loss" chart.
  lthRealizedPrice: { path: "lth-realized-price", hint: /realized|price/i },
  // Also confirmed working (5850 rows, current ~1.03) — the aggregate,
  // network-wide version of that chart's profit/loss line. Kept as the
  // fallback the LTH-scoped guess below falls back to if it fails.
  realizedProfitLossRatio: { path: "realized-profit-loss-ratio", hint: /profit|loss|ratio|margin/i },
  // Re-trying the "lth-" prefixed version of the path above — the first
  // attempt hit the auth tier's rate limit before it could be confirmed
  // either way. If this 404s again for real (not just rate-limited),
  // drop it back out rather than paying for an unconfirmed extra auth
  // attempt every fetch cycle.
  lthRealizedProfitLossRatio: { path: "lth-realized-profit-loss-ratio", hint: /profit|loss|ratio|margin/i },
};

async function handleOnchainMetrics(req, res) {
  // ?refresh=1 bypasses the auth-retry cooldown for every metric — for
  // manually verifying a just-changed BGEOMETRICS_API_TOKEN without
  // waiting out the cooldown window Redis remembers from the previous
  // token's failed attempts. ?refresh=lthSopr,sthSopr scopes the bypass
  // to just those metric keys instead, so a targeted re-check doesn't
  // spend the (fairly tight, 200/hour) paid-tier quota re-attempting
  // auth on metrics that already succeeded and don't need it.
  const refreshParam = (req.query || {}).refresh;
  const forceAuthAll = refreshParam === "1" || refreshParam === "true";
  const forceAuthKeys = typeof refreshParam === "string" && !forceAuthAll
    ? new Set(refreshParam.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const entries = Object.entries(ONCHAIN_METRICS);
  const results = await Promise.allSettled(
    entries.map(async ([key, cfg]) => {
      const forceAuth = forceAuthAll || Boolean(forceAuthKeys && forceAuthKeys.has(key));
      const { history, source, debug } = await loadDataset({
        archiveKey: `onchain-archive:${cfg.path}`,
        path: cfg.path,
        hint: cfg.hint,
        normalize: normalizeSeries,
        freshnessMs: DAY_MS,
        forceAuth,
      });
      if (!history.length) throw new Error(`${cfg.path}: no parseable records`);
      return {
        current: history[history.length - 1],
        history,
        count: history.length,
        earliest: history[0].date,
        latest: history[history.length - 1].date,
        source: source || "cache",
        debug,
      };
    })
  );

  const metrics = {};
  const errors = [];
  entries.forEach(([key], i) => {
    const r = results[i];
    if (r.status === "fulfilled") metrics[key] = r.value;
    else errors.push(`${key}: ${r.reason.message}`);
  });

  if (!Object.keys(metrics).length) {
    res.status(502).json({ error: "All on-chain metrics failed", details: errors });
    return;
  }

  // ?summary=1 drops each metric's (often huge) `history` array — handy
  // for eyeballing count/earliest/latest/debug on mobile, where copying
  // or scrolling through the full JSON is painful.
  const summaryOnly = "summary" in (req.query || {}) || /[?&]summary=1/.test(req.url || "");
  const outMetrics = summaryOnly
    ? Object.fromEntries(Object.entries(metrics).map(([k, m]) => {
        const { history, ...rest } = m;
        return [k, rest];
      }))
    : metrics;

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
  res.status(200).json({
    tokenConfigured: Boolean(BGEO_TOKEN),
    fetchedAt: new Date().toISOString(),
    metrics: outMetrics,
    errors,
  });
}

async function handleHodlWaves(req, res) {
  const { history, source, debug } = await loadDataset({
    archiveKey: "hodl-waves-archive",
    path: "hodl-waves-supply",
    normalize: normalizeBandSeries,
    freshnessMs: DAY_MS,
  });

  if (!history.length) {
    res.status(502).json({ error: "hodl-waves-supply: no parseable records", debug });
    return;
  }

  // Union of band keys across the data (a provider could add/rename a
  // band over time) so the frontend can build its stacked series and
  // legend without hardcoding names.
  const bandKeys = [...new Set(history.flatMap((r) => Object.keys(r.bands)))];

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
  res.status(200).json({
    tokenConfigured: Boolean(BGEO_TOKEN),
    fetchedAt: new Date().toISOString(),
    bandKeys,
    history,
    count: history.length,
    earliest: history[0].date,
    latest: history[history.length - 1].date,
    source: source || "cache",
    debug,
  });
}

async function handleM2Global(req, res) {
  const { history, source, debug } = await loadDataset({
    archiveKey: "m2-global-archive",
    path: "m2global",
    hint: /m2/i,
    normalize: normalizeSeries,
    freshnessMs: WEEK_MS,
  });

  if (!history.length) {
    res.status(502).json({ error: "m2global: no parseable records", debug });
    return;
  }

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
  res.status(200).json({
    tokenConfigured: Boolean(BGEO_TOKEN),
    fetchedAt: new Date().toISOString(),
    history,
    count: history.length,
    earliest: history[0].date,
    latest: history[history.length - 1].date,
    source: source || "cache",
    debug,
  });
}

// ---- US national debt (usdebtclock.org-style stats, from official
// sources instead of scraping that site's live-ticker page) ----
// Treasury's own open-data API, not BGeometrics — daily since 1993-04-01,
// no key required.
const TREASURY_DEBT_URL =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v2/accounting/od/debt_to_penny";
// FRED's keyless CSV export (the same URL its own embeddable chart
// widgets use) — avoids needing a registered FRED API key just for one
// quarterly series. "Federal Debt: Total Public Debt as Percent of GDP".
const FRED_DEBT_TO_GDP_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=GFDEGDQ188S";

// Neither the Census Bureau nor the IRS publishes a live daily headcount
// — usdebtclock.org's own "per citizen"/"per taxpayer" figures are the
// same kind of periodically-updated estimate, not a real-time feed.
// Update these occasionally as new Census/IRS figures are published; a
// few months of staleness only shifts the per-person figures by a
// fraction of a percent.
const US_POPULATION_ESTIMATE = 347_000_000; // Census Bureau, ~2026
const US_TAXPAYER_ESTIMATE = 161_000_000; // IRS SOI, individual returns filed

async function fetchTreasuryDebtHistory() {
  const url = `${TREASURY_DEBT_URL}?fields=record_date,tot_pub_debt_out_amt&sort=-record_date&page[size]=10000`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`treasury debt_to_penny -> ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows
    .map((r) => ({ date: r.record_date, dateMs: Date.parse(r.record_date), value: parseFloat(r.tot_pub_debt_out_amt) }))
    .filter((r) => !Number.isNaN(r.dateMs) && !Number.isNaN(r.value))
    .sort((a, b) => a.dateMs - b.dateMs);
}

async function fetchDebtToGdpHistory() {
  const res = await fetch(FRED_DEBT_TO_GDP_CSV, { headers: { Accept: "text/csv" } });
  if (!res.ok) throw new Error(`fred GFDEGDQ188S -> ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n").slice(1); // drop the "DATE,GFDEGDQ188S" header
  return lines
    .map((line) => {
      const [date, value] = line.split(",");
      return { date, dateMs: Date.parse(date), value: parseFloat(value) };
    })
    .filter((r) => !Number.isNaN(r.dateMs) && !Number.isNaN(r.value))
    .sort((a, b) => a.dateMs - b.dateMs);
}

// Treasury's buyback operations — where they repurchase previously-issued
// securities to improve market liquidity (unrelated to the debt ceiling or
// to the government buying BTC). Path/field names here are an unverified
// best-effort guess at fiscaldata.treasury.gov's naming convention (same
// as debt_to_penny's own /v2/accounting/od/ shape) — this sandbox can't
// reach the real API to confirm the schema, so the parser stays generic
// (regex-matched date/amount fields, like normalizeRecord above) and the
// debug output includes the first raw row's actual keys so the real shape
// can be read back from a live deployment and the field guesses corrected.
const TREASURY_BUYBACK_URL =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/buyback_operations";

async function fetchTreasuryBuybacks() {
  const url = `${TREASURY_BUYBACK_URL}?sort=-operation_date&page[size]=10000`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`treasury buyback_operations -> ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  if (!rows.length) throw new Error("treasury buyback_operations -> empty data array");

  const sampleKeys = Object.keys(rows[0]);
  const dateKey = sampleKeys.find((k) => /^(operation_date|record_date|date)$/i.test(k)) || sampleKeys.find((k) => /date/i.test(k));
  const amountKey = sampleKeys.find((k) => /accepted.*amt|purchase.*amt|total.*amt|par.*amt/i.test(k)) || sampleKeys.find((k) => /amt|amount/i.test(k));
  if (!dateKey) throw new Error(`treasury buyback_operations -> no date-like field among [${sampleKeys.join(", ")}]`);

  const history = rows
    .map((r) => ({
      date: r[dateKey],
      dateMs: Date.parse(r[dateKey]),
      value: amountKey ? parseFloat(r[amountKey]) : null,
    }))
    .filter((r) => !Number.isNaN(r.dateMs))
    .sort((a, b) => a.dateMs - b.dateMs);

  return { history, sampleKeys, dateKey, amountKey };
}

async function handleUsDebt(req, res) {
  const archiveKey = "us-debt-archive";
  let debtHistory = [], gdpHistory = [], buybackHistory = [], cachedAtMs = 0;

  if (redisConfigured()) {
    try {
      const { rows } = await redisGetArchive(archiveKey);
      if (rows && Array.isArray(rows.debt)) {
        debtHistory = rows.debt;
        gdpHistory = Array.isArray(rows.gdp) ? rows.gdp : [];
        buybackHistory = Array.isArray(rows.buybacks) ? rows.buybacks : [];
        cachedAtMs = rows.fetchedAtMs || 0;
      }
    } catch {
      /* fall through to a fresh fetch */
    }
  }

  const debug = [];
  const stale = Date.now() - cachedAtMs > DAY_MS;
  if (stale || !debtHistory.length) {
    const [debtResult, gdpResult, buybackResult] = await Promise.allSettled([
      fetchTreasuryDebtHistory(),
      fetchDebtToGdpHistory(),
      fetchTreasuryBuybacks(),
    ]);
    if (debtResult.status === "fulfilled" && debtResult.value.length) {
      debtHistory = debtResult.value;
      debug.push(`treasury debt_to_penny -> ${debtHistory.length} rows`);
    } else {
      debug.push(`treasury debt_to_penny -> ERROR ${debtResult.reason?.message || debtResult.reason}`);
    }
    if (gdpResult.status === "fulfilled" && gdpResult.value.length) {
      gdpHistory = gdpResult.value;
      debug.push(`fred GFDEGDQ188S -> ${gdpHistory.length} rows`);
    } else {
      debug.push(`fred GFDEGDQ188S -> ERROR ${gdpResult.reason?.message || gdpResult.reason}`);
    }
    if (buybackResult.status === "fulfilled" && buybackResult.value.history.length) {
      buybackHistory = buybackResult.value.history;
      const { sampleKeys, dateKey, amountKey } = buybackResult.value;
      debug.push(
        `treasury buyback_operations -> ${buybackHistory.length} rows (dateKey=${dateKey}, amountKey=${amountKey || "none"}, allKeys=[${sampleKeys.join(",")}])`
      );
    } else {
      debug.push(`treasury buyback_operations -> ERROR ${buybackResult.reason?.message || buybackResult.reason}`);
    }
    if (redisConfigured() && (debtHistory.length || gdpHistory.length || buybackHistory.length)) {
      await redisSetArchive(archiveKey, { debt: debtHistory, gdp: gdpHistory, buybacks: buybackHistory, fetchedAtMs: Date.now() }, false, null).catch(() => {});
    }
  } else {
    debug.push(`cache -> debt ${debtHistory.length} rows, gdp ${gdpHistory.length} rows, buybacks ${buybackHistory.length} rows`);
  }

  if (!debtHistory.length) {
    res.status(502).json({ error: "US debt data unavailable", debug });
    return;
  }

  const latestDebt = debtHistory[debtHistory.length - 1];

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    debt: {
      current: latestDebt,
      history: debtHistory,
      count: debtHistory.length,
      earliest: debtHistory[0].date,
      latest: latestDebt.date,
    },
    debtToGdp: gdpHistory.length
      ? {
          current: gdpHistory[gdpHistory.length - 1],
          history: gdpHistory,
          count: gdpHistory.length,
          earliest: gdpHistory[0].date,
          latest: gdpHistory[gdpHistory.length - 1].date,
        }
      : null,
    buybacks: buybackHistory.length
      ? {
          current: buybackHistory[buybackHistory.length - 1],
          history: buybackHistory,
          count: buybackHistory.length,
          earliest: buybackHistory[0].date,
          latest: buybackHistory[buybackHistory.length - 1].date,
        }
      : null,
    perCitizen: latestDebt.value / US_POPULATION_ESTIMATE,
    perTaxpayer: latestDebt.value / US_TAXPAYER_ESTIMATE,
    populationEstimate: US_POPULATION_ESTIMATE,
    taxpayerEstimate: US_TAXPAYER_ESTIMATE,
    debug,
  });
}

export default async function handler(req, res) {
  const type = req.query && req.query.type;
  if (type === "hodl-waves") return handleHodlWaves(req, res);
  if (type === "m2-global") return handleM2Global(req, res);
  if (type === "us-debt") return handleUsDebt(req, res);
  return handleOnchainMetrics(req, res);
}
