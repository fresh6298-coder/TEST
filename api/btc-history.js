// Binance geo-blocks this function's US-hosted IP (HTTP 451), so long BTC
// history is fetched server-side from Yahoo Finance instead, which has
// BTC-USD data back to ~September 2014 (unlike Binance's Aug 2017 start).
// An explicit range (not "max") keeps the response at daily granularity —
// see api/macro-correlation.js for why "max" silently downgrades to monthly.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

function snippet(text) {
  return JSON.stringify((text || "").replace(/\s+/g, " ").trim().slice(0, 160));
}

async function fetchYahoo() {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=12y&interval=1d";
  const upstream = await fetch(url, { headers: HEADERS });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error(`upstream responded ${upstream.status}, got ${snippet(text)}`);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response, got ${snippet(text)}`);
  }

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`no chart result (${json?.chart?.error?.description || snippet(text)})`);

  const timestamps = result.timestamp || [];
  const closesArr = result.indicators?.quote?.[0]?.close || [];
  const prices = {};
  timestamps.forEach((ts, i) => {
    const c = closesArr[i];
    if (c != null) prices[new Date(ts * 1000).toISOString().slice(0, 10)] = c;
  });

  if (!Object.keys(prices).length) throw new Error("no close data in response");
  return prices;
}

// Yahoo's BTC-USD history only starts ~2014-09-17. blockchain.info's public,
// keyless Charts API has tracked BTC market price since ~2010, so it's used
// here purely to fill in the pre-2014 gap — Yahoo still wins on any
// overlapping date since it's the long-established source every page here
// already trusts. Best-effort: if this fails, the response just falls back
// to Yahoo-only, exactly like before this was added.
async function fetchBlockchainInfo() {
  const url = "https://api.blockchain.info/charts/market-price?timespan=all&format=json";
  const upstream = await fetch(url, { headers: HEADERS });
  if (!upstream.ok) throw new Error(`blockchain.info responded ${upstream.status}`);
  const json = await upstream.json();
  const values = json?.values || [];
  const prices = {};
  values.forEach((v) => {
    if (v && v.y != null) prices[new Date(v.x * 1000).toISOString().slice(0, 10)] = v.y;
  });
  if (!Object.keys(prices).length) throw new Error("no values in response");
  return prices;
}

export default async function handler(req, res) {
  try {
    const [yahooResult, bciResult] = await Promise.allSettled([fetchYahoo(), fetchBlockchainInfo()]);

    if (yahooResult.status === "rejected") {
      res.status(502).json({ error: yahooResult.reason?.message || String(yahooResult.reason) });
      return;
    }

    const prices =
      bciResult.status === "fulfilled" ? { ...bciResult.value, ...yahooResult.value } : yahooResult.value;

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
    res.status(200).json({
      fetchedAt: new Date().toISOString(),
      prices,
      preYahooSource: bciResult.status === "fulfilled" ? "blockchain.info" : null,
      preYahooError: bciResult.status === "rejected" ? String(bciResult.reason?.message || bciResult.reason) : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
