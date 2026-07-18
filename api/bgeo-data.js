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
  if (!data.result) return { authAttempted: false, rows: [] };
  try {
    const parsed = JSON.parse(data.result);
    if (Array.isArray(parsed)) return { authAttempted: false, rows: parsed }; // pre-token archive format
    return { authAttempted: !!parsed.authAttempted, rows: Array.isArray(parsed.rows) ? parsed.rows : [] };
  } catch {
    return { authAttempted: false, rows: [] };
  }
}

async function redisSetArchive(key, rows, authAttempted) {
  await fetch(`${REDIS_URL}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "text/plain" },
    body: JSON.stringify({ authAttempted, rows }),
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
async function loadDataset({ archiveKey, path, hint, normalize, freshnessMs }) {
  let existing = { authAttempted: false, rows: [] };
  if (redisConfigured()) {
    try {
      existing = await redisGetArchive(archiveKey);
    } catch {
      existing = { authAttempted: false, rows: [] };
    }
  }

  // A token that's now configured but was never tried against this
  // archive must force a fresh attempt regardless of date-freshness —
  // otherwise an archive that already happens to include today's date
  // (built before the token existed) would silently keep serving the
  // old, shorter window forever.
  const needsAuthAttempt = Boolean(BGEO_TOKEN) && !existing.authAttempted;
  const rows = existing.rows;
  const latestMs = rows.length ? rows[rows.length - 1].dateMs : null;
  const archiveIsFreshEnough = !needsAuthAttempt && latestMs != null && Date.now() - latestMs < freshnessMs;

  let fresh = null;
  let fetchDebug = archiveIsFreshEnough ? ["skipped (archive already fresh)"] : null;
  let freshSource = null;
  let authResolved = false;
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
  // attempt auth again.
  const authAttempted = existing.authAttempted || (Boolean(BGEO_TOKEN) && authResolved);
  if (fresh) {
    history = mergeHistory(rows, fresh);
    if (redisConfigured()) await redisSetArchive(archiveKey, history, authAttempted).catch(() => {});
  }

  return { history, source: freshSource, debug: fetchDebug };
}

const ONCHAIN_METRICS = {
  mvrvZscore: { path: "mvrv-zscore", hint: /mvrv/i },
  nupl: { path: "nupl", hint: /nupl|unrealized/i },
  puellMultiple: { path: "puell-multiple", hint: /puell/i },
  sopr: { path: "sopr", hint: /sopr/i },
  reserveRisk: { path: "reserve-risk", hint: /reserve/i },
  aviv: { path: "aviv", hint: /aviv/i },
  stockToFlow: { path: "stock", hint: /stock/i },
};

async function handleOnchainMetrics(req, res) {
  const entries = Object.entries(ONCHAIN_METRICS);
  const results = await Promise.allSettled(
    entries.map(async ([key, cfg]) => {
      const { history, source, debug } = await loadDataset({
        archiveKey: `onchain-archive:${cfg.path}`,
        path: cfg.path,
        hint: cfg.hint,
        normalize: normalizeSeries,
        freshnessMs: DAY_MS,
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

export default async function handler(req, res) {
  const type = req.query && req.query.type;
  if (type === "hodl-waves") return handleHodlWaves(req, res);
  if (type === "m2-global") return handleM2Global(req, res);
  return handleOnchainMetrics(req, res);
}
