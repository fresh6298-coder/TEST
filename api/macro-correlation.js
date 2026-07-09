const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const STOOQ_SYMBOLS = [
  { key: "gold", stooq: "xauusd", label: "Gold (XAU/USD)" },
  { key: "nasdaq", stooq: "^ndq", label: "Nasdaq Composite" },
  { key: "dxy", stooq: "dx.f", label: "US Dollar Index" },
];

const DAYS_BACK = 730; // ~2 years

async function fetchStooqCloses(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${symbol}: upstream responded ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2 || !/^date/i.test(lines[0])) {
    throw new Error(`${symbol}: unexpected CSV (first line: ${lines[0]?.slice(0, 60)})`);
  }
  const closes = new Map();
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const date = cols[0];
    const close = parseFloat(cols[4]);
    if (date && !Number.isNaN(close)) closes.set(date, close);
  }
  if (!closes.size) throw new Error(`${symbol}: no rows parsed`);
  return closes;
}

function pearsonCorrelation(a, b) {
  const n = a.length;
  if (n < 2) return null;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

function dailyReturns(values) {
  const out = [];
  for (let i = 1; i < values.length; i++) out.push(values[i] / values[i - 1] - 1);
  return out;
}

export default async function handler(req, res) {
  const errors = [];

  let btcCloses;
  try {
    btcCloses = await fetchStooqCloses("btcusd");
  } catch (err) {
    res.status(502).json({ error: `BTC price fetch failed: ${err.message}` });
    return;
  }

  const assetResults = await Promise.allSettled(
    STOOQ_SYMBOLS.map((s) => fetchStooqCloses(s.stooq))
  );

  const assetCloses = {};
  STOOQ_SYMBOLS.forEach((s, i) => {
    const r = assetResults[i];
    if (r.status === "fulfilled") assetCloses[s.key] = r.value;
    else errors.push(`${s.label}: ${r.reason.message}`);
  });

  const availableKeys = Object.keys(assetCloses);
  if (!availableKeys.length) {
    res.status(502).json({ error: "All macro asset sources failed", details: errors });
    return;
  }

  // Only compare on dates every series actually has (BTC trades weekends, TradFi doesn't),
  // then keep just the most recent window since stooq returns full history.
  const commonDates = [...btcCloses.keys()]
    .filter((d) => availableKeys.every((k) => assetCloses[k].has(d)))
    .sort()
    .slice(-DAYS_BACK);

  if (commonDates.length < 10) {
    res.status(502).json({ error: "Not enough overlapping trading days", details: errors });
    return;
  }

  const btcSeries = commonDates.map((d) => btcCloses.get(d));
  const rebase = (arr) => arr.map((v) => (v / arr[0]) * 100);

  const series = { BTC: rebase(btcSeries) };
  const correlations = {};
  const btcReturns = dailyReturns(btcSeries);

  availableKeys.forEach((k) => {
    const label = STOOQ_SYMBOLS.find((s) => s.key === k).label;
    const closes = commonDates.map((d) => assetCloses[k].get(d));
    series[label] = rebase(closes);
    correlations[label] = pearsonCorrelation(btcReturns, dailyReturns(closes));
  });

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
  res.status(200).json({
    fetchedAt: new Date().toISOString(),
    dates: commonDates,
    series,
    correlations,
    errors,
  });
}
