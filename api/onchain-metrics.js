const BASE = "https://bitcoin-data.com/v1";

const METRICS = {
  mvrvZscore: { path: "mvrv-zscore" },
  nupl: { path: "nupl" },
  puellMultiple: { path: "puell-multiple" },
};

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const err = new Error(`${url} -> ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// bitcoin-data.com's exact field names aren't hardcoded here: treat the
// first date-like field as the date and the first other numeric-looking
// field as the value, so small naming differences don't break parsing.
function normalizeRecord(row) {
  if (!row || typeof row !== "object") return null;
  const keys = Object.keys(row);
  const dateKey = keys.find((k) => /^(d|date|time|timestamp)$/i.test(k)) || keys[0];
  const valueKey = keys.find((k) => {
    if (k === dateKey) return false;
    const v = row[k];
    return typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(parseFloat(v)));
  });
  if (!dateKey || !valueKey) return null;
  const value = parseFloat(row[valueKey]);
  if (Number.isNaN(value)) return null;
  return { date: row[dateKey], value };
}

function normalizeSeries(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  return rows.map(normalizeRecord).filter(Boolean);
}

async function loadMetric(path) {
  const history = normalizeSeries(await fetchJson(`${BASE}/${path}`));
  if (!history.length) throw new Error(`${path}: no parseable records`);
  return { current: history[history.length - 1], history };
}

export default async function handler(req, res) {
  const entries = Object.entries(METRICS);
  const results = await Promise.allSettled(entries.map(([, cfg]) => loadMetric(cfg.path)));

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
