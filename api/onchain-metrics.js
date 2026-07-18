const BASE = "https://bitcoin-data.com/v1";

const METRICS = {
  mvrvZscore: { path: "mvrv-zscore", hint: /mvrv/i },
  nupl: { path: "nupl", hint: /nupl|unrealized/i },
  puellMultiple: { path: "puell-multiple", hint: /puell/i },
};

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};
// bitcoin-data.com's docs weren't reachable to confirm the exact param
// for full history (anonymous access is also rate-limited — 8 req/hour —
// so this stays a short, bounded list rather than a wide guess-spray
// that would burn the whole hourly budget on one page load). Stops at
// the first variant past the plain endpoint that actually returns more
// rows; if none do, the plain endpoint's result is used as before.
const HISTORY_QUERY_VARIANTS = ["", "?limit=100000", "?days=100000"];

// Fields that look numeric but are never "the metric" — timestamps,
// ids, block heights, etc. Excluded from value-field guessing.
const NON_VALUE_KEY = /^(d|date|id|unix.*|timestamp|ts|epoch|createdat|updatedat|blockheight|height)$/i;

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
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

// The plain endpoint seems to cap out around ~4 years of daily records
// (a rolling window, not a hard data-availability limit — bitcoin-data.com
// markets full history back to genesis). Try a couple of plausible
// params for a bigger window; whichever variant returns the most rows
// wins, falling back to the plain endpoint if none help.
async function fetchFullHistory(path) {
  let best = null;
  for (const q of HISTORY_QUERY_VARIANTS) {
    try {
      const json = await fetchJson(`${BASE}/${path}${q}`);
      const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      if (rows.length && (!best || rows.length > best.rows.length)) {
        best = { json, rows };
      }
    } catch {
      // try the next variant
    }
  }
  if (!best) throw new Error("no data from any query variant");
  return best.json;
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

async function redisGetArchive(key) {
  const res = await fetch(`${REDIS_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`redis GET failed: ${res.status}`);
  const data = await res.json();
  if (!data.result) return [];
  try {
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function redisSetArchive(key, rows) {
  await fetch(`${REDIS_URL}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "text/plain" },
    body: JSON.stringify(rows),
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
  let existing = [];
  if (redisConfigured()) {
    try {
      existing = await redisGetArchive(archiveKey);
    } catch {
      existing = [];
    }
  }

  // These metrics only update once a day at most, and anonymous access to
  // bitcoin-data.com is rate-limited (8 req/hour, 15/day) — once the
  // archive already has today-or-yesterday's data, skip hitting the
  // origin again this request and just serve what's cached.
  const latestMs = existing.length ? existing[existing.length - 1].dateMs : null;
  const archiveIsFreshEnough = latestMs != null && Date.now() - latestMs < DAY_MS;

  let fresh = null;
  if (!archiveIsFreshEnough) {
    try {
      const json = await fetchFullHistory(path);
      fresh = normalizeSeries(json, hint);
    } catch {
      fresh = null;
    }
  }

  let history = existing;
  if (fresh) {
    history = mergeHistory(existing, fresh);
    if (redisConfigured()) await redisSetArchive(archiveKey, history).catch(() => {});
  }

  if (!history.length) throw new Error(`${path}: no parseable records`);
  return {
    current: history[history.length - 1],
    history,
    count: history.length,
    earliest: history[0].date,
    latest: history[history.length - 1].date,
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
    source: BASE,
    fetchedAt: new Date().toISOString(),
    metrics,
    errors,
  });
}
