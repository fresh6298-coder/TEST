// bitcoin-data.com (anonymous, rate-limited to 8 req/hour) was the only
// access this app had for a while and caps out around a ~4-year rolling
// window. api.bgeometrics.com is the same provider's authenticated API —
// confirmed working via a user-provided token (`Authorization: Bearer
// <token>`) — and is tried first when a token is configured, since it
// may not carry the same rolling-window cap. Falls back to the
// anonymous endpoint either way, so this works with or without a token.
const BGEO_AUTH_BASE = "https://api.bgeometrics.com/v1";
const BGEO_ANON_BASE = "https://bitcoin-data.com/v1";
const BGEO_TOKEN = process.env.BGEOMETRICS_API_TOKEN;

const METRICS = {
  mvrvZscore: { path: "mvrv-zscore", hint: /mvrv/i },
  nupl: { path: "nupl", hint: /nupl|unrealized/i },
  puellMultiple: { path: "puell-multiple", hint: /puell/i },
  sopr: { path: "sopr", hint: /sopr/i },
  reserveRisk: { path: "reserve-risk", hint: /reserve/i },
  aviv: { path: "aviv", hint: /aviv/i },
  stockToFlow: { path: "stock", hint: /stock/i },
};

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};
// Neither provider's docs were reachable to confirm the exact param for
// full history, so a short, bounded list of plausible variants is tried
// per base URL rather than a wide guess-spray (the anonymous base is
// rate-limited to 8 req/hour). Whichever variant/base returns the most
// rows wins.
const HISTORY_QUERY_VARIANTS = ["", "?limit=100000", "?days=100000"];
// The authenticated base is rate-limited (observed 429s) — only try one
// query variant against it per metric to conserve quota; the anonymous
// base below still gets the full variant list as a fallback.
const AUTH_QUERY_VARIANTS = [""];

// Fields that look numeric but are never "the metric" — timestamps,
// ids, block heights, etc. Excluded from value-field guessing.
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

// bitcoin-data.com's exact field names aren't hardcoded here: pick the
// date-like field, then prefer a value field whose name matches the
// metric (e.g. "mvrv"), falling back to the first remaining numeric
// field that isn't a timestamp/id lookalike.
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

// The anonymous endpoint seems to cap out around ~4 years of daily
// records (a rolling window, not a hard data-availability limit — this
// provider markets full history back to genesis). Try the authenticated
// base first (if a token is configured), then the anonymous one, each
// with a couple of plausible query variants; whichever combination
// returns the most rows wins.
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

// ---- Persistent archive (Upstash Redis), same pattern as api/etf-flow.js ----
// Whatever window bitcoin-data.com gives us on a given request is merged
// into a Redis-backed archive (fresh values win on overlapping dates,
// nothing already captured is ever dropped) and the merged archive is
// what gets served. This also means every request no longer needs to
// refetch bitcoin-data.com at all if Redis already has fresh-enough
// data — helpful given the 8-requests/hour anonymous rate limit.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function redisConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

// Stores {authAttempted, rows} rather than a bare array — see the
// authAttempted check in loadMetric for why: a cached archive built
// before a token existed must not silently keep hiding a longer history
// just because it happens to already have "today"'s date in it.
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

async function loadMetric(key, path, hint) {
  const archiveKey = `onchain-archive:${path}`;
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

  // These metrics only update once a day at most, and anonymous access to
  // bitcoin-data.com is rate-limited (8 req/hour, 15/day) — once the
  // archive already has today-or-yesterday's data (and doesn't need the
  // auth check above), skip hitting the origin again this request and
  // just serve what's cached.
  const rows = existing.rows;
  const latestMs = rows.length ? rows[rows.length - 1].dateMs : null;
  const archiveIsFreshEnough = !needsAuthAttempt && latestMs != null && Date.now() - latestMs < DAY_MS;

  let fresh = null;
  let fetchDebug = archiveIsFreshEnough ? ["skipped (archive already fresh)"] : null;
  let freshSource = null;
  let authResolved = false;
  if (!archiveIsFreshEnough) {
    try {
      const best = await fetchFullHistory(path);
      fresh = normalizeSeries(best.json, hint);
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
  let authAttempted = existing.authAttempted || (Boolean(BGEO_TOKEN) && authResolved);
  if (fresh) {
    history = mergeHistory(rows, fresh);
    if (redisConfigured()) await redisSetArchive(archiveKey, history, authAttempted).catch(() => {});
  }

  if (!history.length) throw new Error(`${path}: no parseable records`);
  return {
    current: history[history.length - 1],
    history,
    count: history.length,
    earliest: history[0].date,
    latest: history[history.length - 1].date,
    source: freshSource || "cache",
    debug: fetchDebug,
  };
}

export default async function handler(req, res) {
  const entries = Object.entries(METRICS);
  const results = await Promise.allSettled(entries.map(([key, cfg]) => loadMetric(key, cfg.path, cfg.hint)));

  const metrics = {};
  const errors = [];
  entries.forEach(([key], i) => {
    const r = results[i];
    if (r.status === "fulfilled") {
      metrics[key] = r.value;
    } else {
      errors.push(`${key}: ${r.reason.message}`);
    }
  });

  if (!Object.keys(metrics).length) {
    res.status(502).json({ error: "All on-chain metrics failed", details: errors });
    return;
  }

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
  res.status(200).json({
    tokenConfigured: Boolean(BGEO_TOKEN),
    fetchedAt: new Date().toISOString(),
    metrics,
    errors,
  });
}
