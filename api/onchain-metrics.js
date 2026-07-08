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
  return { date: row[dateKey], value };
}

function normalizeSeries(json, hint) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  return rows.map((row) => normalizeRecord(row, hint)).filter(Boolean);
}

// The plain endpoint seems to cap out around ~4 years of daily records;
// try a large explicit limit in case the API defaults to a smaller page
// and honors this param for a bigger one. Falls back to the plain
// endpoint's result if the "big limit" request errors or doesn't help.
async function fetchFullHistory(path) {
  const base = await fetchJson(`${BASE}/${path}`);
  const baseRows = Array.isArray(base) ? base : Array.isArray(base?.data) ? base.data : [];
  try {
    const big = await fetchJson(`${BASE}/${path}?limit=100000`);
    const bigRows = Array.isArray(big) ? big : Array.isArray(big?.data) ? big.data : [];
    return bigRows.length > baseRows.length ? big : base;
  } catch {
    return base;
  }
}

async function loadMetric(path, hint) {
  const json = await fetchFullHistory(path);
  const history = normalizeSeries(json, hint);
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
  const results = await Promise.allSettled(entries.map(([, cfg]) => loadMetric(cfg.path, cfg.hint)));

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
