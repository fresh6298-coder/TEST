// BTC price is fetched client-side directly from Binance (see cycles.html) —
// calling Binance from this serverless function gets HTTP 451 (geo-block on
// the function's own US-hosted IP), even though the same calls work fine
// from an end user's browser. This endpoint only proxies the non-crypto
// assets, which stooq.com doesn't serve with CORS headers for direct
// browser fetches.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const STOOQ_SYMBOLS = [
  { key: "gold", stooq: "xauusd", label: "Gold (XAU/USD)" },
  { key: "nasdaq", stooq: "^ndq", label: "Nasdaq Composite" },
  { key: "dxy", stooq: "dx.f", label: "US Dollar Index" },
];

async function fetchStooqCloses(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${symbol}: upstream responded ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2 || !/^date/i.test(lines[0])) {
    throw new Error(`${symbol}: unexpected CSV (first line: ${lines[0]?.slice(0, 60)})`);
  }
  const closes = {};
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const date = cols[0];
    const close = parseFloat(cols[4]);
    if (date && !Number.isNaN(close)) closes[date] = close;
  }
  if (!Object.keys(closes).length) throw new Error(`${symbol}: no rows parsed`);
  return closes;
}

export default async function handler(req, res) {
  const results = await Promise.allSettled(STOOQ_SYMBOLS.map((s) => fetchStooqCloses(s.stooq)));

  const assets = {};
  const errors = [];
  STOOQ_SYMBOLS.forEach((s, i) => {
    const r = results[i];
    if (r.status === "fulfilled") assets[s.label] = r.value;
    else errors.push(`${s.label}: ${r.reason.message}`);
  });

  if (!Object.keys(assets).length) {
    res.status(502).json({ error: "All macro asset sources failed", details: errors });
    return;
  }

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
  res.status(200).json({ fetchedAt: new Date().toISOString(), assets, errors });
}
