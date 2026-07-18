// Same provider/auth setup as api/onchain-metrics.js (BGeometrics /
// bitcoin-data.com). Global M2 money supply is used as a macro liquidity
// overlay on the main price chart — a single daily value, same shape as
// the on-chain metrics, so this mirrors that file's fetch/archive logic
// rather than sharing a module (each Vercel function is self-contained).
const BGEO_AUTH_BASE = "https://api.bgeometrics.com/v1";
const BGEO_ANON_BASE = "https://bitcoin-data.com/v1";
const BGEO_TOKEN = process.env.BGEOMETRICS_API_TOKEN;
const PATH = "m2global";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};
// See api/onchain-metrics.js for why this is just one variant now (extra
// query params never returned more rows in production, only burned
// through the anonymous base's rate limit).
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

function normalizeRecord(row) {
  if (!row || typeof row !== "object") return null;
  const keys = Object.keys(row);
  const dateKey = keys.find((k) => /^(d|date)$/i.test(k)) || keys.find((k) => /time|timestamp/i.test(k)) || keys[0];
  const candidates = keys.filter((k) => k !== dateKey && !NON_VALUE_KEY.test(k) && isNumeric(row[k]));
  const valueKey = candidates.find((k) => /m2/i.test(k)) || candidates[0];
  if (!dateKey || !valueKey) return null;
  const value = parseFloat(row[valueKey]);
  if (Number.isNaN(value)) return null;
  const dateMs = Date.parse(row[dateKey]);
  return { date: row[dateKey], dateMs: Number.isNaN(dateMs) ? null : dateMs, value };
}

function normalizeSeries(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  return rows.map(normalizeRecord).filter(Boolean);
}

async function fetchFullHistory() {
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
    const label = `${auth ? "auth" : "anon"} ${base}/${PATH}${q || "(no query)"}`;
    if (auth) authAttemptsMade++;
    try {
      const json = await fetchJson(`${base}/${PATH}${q}`, auth);
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

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ARCHIVE_KEY = "m2-global-archive";

function redisConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function redisGetArchive() {
  const res = await fetch(`${REDIS_URL}/get/${ARCHIVE_KEY}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`redis GET failed: ${res.status}`);
  const data = await res.json();
  if (!data.result) return { authAttempted: false, rows: [] };
  try {
    const parsed = JSON.parse(data.result);
    if (Array.isArray(parsed)) return { authAttempted: false, rows: parsed };
    return { authAttempted: !!parsed.authAttempted, rows: Array.isArray(parsed.rows) ? parsed.rows : [] };
  } catch {
    return { authAttempted: false, rows: [] };
  }
}

async function redisSetArchive(rows, authAttempted) {
  await fetch(`${REDIS_URL}/set/${ARCHIVE_KEY}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "text/plain" },
    body: JSON.stringify({ authAttempted, rows }),
  });
}

function mergeHistory(existing, fresh) {
  const byDate = new Map(existing.map((r) => [r.dateMs ?? r.date, r]));
  fresh.forEach((r) => byDate.set(r.dateMs ?? r.date, r));
  return [...byDate.values()].sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
}

// M2 is a monthly/low-frequency series — refresh at most once a week to
// stay well within the anonymous rate limit.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  let existing = { authAttempted: false, rows: [] };
  if (redisConfigured()) {
    try {
      existing = await redisGetArchive();
    } catch {
      existing = { authAttempted: false, rows: [] };
    }
  }

  const needsAuthAttempt = Boolean(BGEO_TOKEN) && !existing.authAttempted;
  const rows = existing.rows;
  const latestMs = rows.length ? rows[rows.length - 1].dateMs : null;
  const archiveIsFreshEnough = !needsAuthAttempt && latestMs != null && Date.now() - latestMs < WEEK_MS;

  let fresh = null;
  let fetchDebug = archiveIsFreshEnough ? ["skipped (archive already fresh)"] : null;
  let freshSource = null;
  let authResolved = false;
  if (!archiveIsFreshEnough) {
    try {
      const best = await fetchFullHistory();
      fresh = normalizeSeries(best.json);
      fetchDebug = best.debug;
      freshSource = best.source;
      authResolved = Boolean(best.authResolved);
    } catch (err) {
      fetchDebug = err.debug || [String(err.message)];
      authResolved = Boolean(err.authResolved);
    }
  }

  let history = rows;
  let authAttempted = existing.authAttempted || (Boolean(BGEO_TOKEN) && authResolved);
  if (fresh) {
    history = mergeHistory(rows, fresh);
    if (redisConfigured()) await redisSetArchive(history, authAttempted).catch(() => {});
  }

  if (!history.length) {
    res.status(502).json({ error: "m2global: no parseable records", debug: fetchDebug });
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
    source: freshSource || "cache",
    debug: fetchDebug,
  });
}
