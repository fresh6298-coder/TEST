// BTC price is fetched client-side directly from Binance (see cycles.html) —
// calling Binance from this serverless function gets HTTP 451 (geo-block on
// the function's own US-hosted IP), even though the same calls work fine
// from an end user's browser. This endpoint only proxies the non-crypto
// assets.
//
// stooq.com was tried first but serves an active JavaScript verification
// challenge to this function's IP (both directly and via the r.jina.ai
// reader proxy), which a plain fetch can't solve. Yahoo Finance's chart
// endpoint is a long-standing, widely used free/keyless source for exactly
// this kind of index/commodity data.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const YAHOO_SYMBOLS = [
  { symbol: "GC=F", label: "Gold (Futures)" },
  { symbol: "^IXIC", label: "Nasdaq Composite" },
  { symbol: "DX-Y.NYB", label: "US Dollar Index" },
  { symbol: "^KS11", label: "KOSPI" },
  { symbol: "005930.KS", label: "삼성전자" },
];

// A separate, larger symbol set for the "annual returns by asset class"
// comparison table — kept apart from YAHOO_SYMBOLS so it doesn't also
// flood the unrelated macro-correlation chart/legend above with 19 extra
// lines. ETF proxies are used (rather than raw indices/futures) so
// dividend-adjusted total-return closes are available going back to
// 2011 for most of these.
const RETURNS_SYMBOLS = [
  { symbol: "SPY", label: "US Large Caps" },
  { symbol: "QQQ", label: "US Nasdaq 100" },
  { symbol: "IWM", label: "US Small Caps" },
  { symbol: "MDY", label: "US Mid Caps" },
  { symbol: "IWD", label: "US Value" },
  { symbol: "IWF", label: "US Growth" },
  { symbol: "VNQ", label: "US REITs" },
  { symbol: "EFA", label: "Developed International" },
  { symbol: "VWO", label: "Emerging Markets" },
  { symbol: "BND", label: "US Total Bond Market" },
  { symbol: "LQD", label: "Investment Grade Bonds" },
  { symbol: "HYG", label: "High Yield Bonds" },
  { symbol: "EMB", label: "EM Bonds (USD)" },
  { symbol: "TIP", label: "TIPS" },
  { symbol: "TLT", label: "Long Duration Treasuries" },
  { symbol: "CWB", label: "Convertible Bonds" },
  { symbol: "PFF", label: "Preferred Stocks" },
  { symbol: "GLD", label: "Gold" },
  { symbol: "DBC", label: "Commodities" },
  { symbol: "BIL", label: "US Cash" },
];

function snippet(text) {
  return JSON.stringify((text || "").replace(/\s+/g, " ").trim().slice(0, 160));
}

async function fetchYahooCloses(symbol) {
  // range=max makes Yahoo silently downgrade to monthly candles for these
  // long-history symbols even with interval=1d requested; an explicit range
  // long enough to cover BTC's full Yahoo history (BTC-USD starts ~Sept
  // 2014, same 12y range as api/btc-history.js) keeps it daily and lets
  // the gold/BTC 4-year moving-average chart compute a full trailing
  // window as far back as the data allows.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=12y&interval=1d`;
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`${symbol}: upstream responded ${res.status}, got ${snippet(text)}`);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${symbol}: non-JSON response, got ${snippet(text)}`);
  }

  const result = json?.chart?.result?.[0];
  if (!result) {
    throw new Error(`${symbol}: no chart result (${json?.chart?.error?.description || snippet(text)})`);
  }
  const timestamps = result.timestamp || [];
  const closesArr = result.indicators?.quote?.[0]?.close || [];
  const closes = {};
  timestamps.forEach((ts, i) => {
    const c = closesArr[i];
    if (c != null) closes[new Date(ts * 1000).toISOString().slice(0, 10)] = c;
  });
  if (!Object.keys(closes).length) throw new Error(`${symbol}: no close data in response`);
  return closes;
}

export default async function handler(req, res) {
  const symbolSet = (req.query || {}).set === "returns" ? RETURNS_SYMBOLS : YAHOO_SYMBOLS;
  const results = await Promise.allSettled(symbolSet.map((s) => fetchYahooCloses(s.symbol)));

  const assets = {};
  const errors = [];
  symbolSet.forEach((s, i) => {
    const r = results[i];
    if (r.status === "fulfilled") assets[s.label] = r.value;
    else errors.push(r.reason.message);
  });

  if (!Object.keys(assets).length) {
    res.status(502).json({ error: "All macro asset sources failed", details: errors });
    return;
  }

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
  res.status(200).json({ fetchedAt: new Date().toISOString(), assets, errors });
}
