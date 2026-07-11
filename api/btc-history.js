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

export default async function handler(req, res) {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=12y&interval=1d";
    const upstream = await fetch(url, { headers: HEADERS });
    const text = await upstream.text();
    if (!upstream.ok) {
      res.status(502).json({ error: `upstream responded ${upstream.status}, got ${snippet(text)}` });
      return;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      res.status(502).json({ error: `non-JSON response, got ${snippet(text)}` });
      return;
    }

    const result = json?.chart?.result?.[0];
    if (!result) {
      res.status(502).json({ error: `no chart result (${json?.chart?.error?.description || snippet(text)})` });
      return;
    }

    const timestamps = result.timestamp || [];
    const closesArr = result.indicators?.quote?.[0]?.close || [];
    const prices = {};
    timestamps.forEach((ts, i) => {
      const c = closesArr[i];
      if (c != null) prices[new Date(ts * 1000).toISOString().slice(0, 10)] = c;
    });

    if (!Object.keys(prices).length) {
      res.status(502).json({ error: "no close data in response" });
      return;
    }

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
    res.status(200).json({ fetchedAt: new Date().toISOString(), prices });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
