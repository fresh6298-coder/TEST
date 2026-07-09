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

function parseStooqCsv(text) {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => /^date\s*,/i.test(l.trim()));
  if (headerIdx === -1) return null;
  const closes = {};
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) break;
    const cols = line.split(",");
    const date = cols[0];
    const close = parseFloat(cols[4]);
    if (date && !Number.isNaN(close)) closes[date] = close;
  }
  return Object.keys(closes).length ? closes : null;
}

// stooq's bot protection sometimes serves an HTML page instead of CSV to a
// serverless function's IP; r.jina.ai's reader proxy (already used for
// farside.co.uk and companiesmarketcap.com) gets through more often since
// it fetches from its own infrastructure rather than ours.
async function fetchStooqCloses(symbol) {
  const directUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const errors = [];

  try {
    const res = await fetch(directUrl, { headers: HEADERS });
    if (res.ok) {
      const parsed = parseStooqCsv(await res.text());
      if (parsed) return parsed;
      errors.push("direct: response wasn't parseable CSV");
    } else {
      errors.push(`direct: upstream responded ${res.status}`);
    }
  } catch (err) {
    errors.push(`direct: ${err.message}`);
  }

  try {
    const res = await fetch(`https://r.jina.ai/${directUrl}`);
    if (res.ok) {
      const parsed = parseStooqCsv(await res.text());
      if (parsed) return parsed;
      errors.push("reader: response wasn't parseable CSV");
    } else {
      errors.push(`reader: upstream responded ${res.status}`);
    }
  } catch (err) {
    errors.push(`reader: ${err.message}`);
  }

  throw new Error(`${symbol}: ${errors.join(" / ")}`);
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
