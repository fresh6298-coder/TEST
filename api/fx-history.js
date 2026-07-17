// Proxies frankfurter.app (free, keyless ECB reference rates) server-side.
// A direct client-side fetch to it fails in the browser ("Failed to
// fetch"), which almost always means the response isn't sending CORS
// headers for cross-origin requests — calling it from a serverless
// function instead sidesteps that entirely, same reasoning as why Yahoo
// Finance is proxied through api/btc-history.js / api/macro-correlation.js
// instead of being fetched client-side.
const HEADERS = { Accept: "application/json" };

function snippet(text) {
  return JSON.stringify((text || "").replace(/\s+/g, " ").trim().slice(0, 160));
}

export default async function handler(req, res) {
  try {
    const url = "https://api.frankfurter.app/2014-01-01..?from=USD&to=KRW";
    const upstream = await fetch(url, { headers: HEADERS });
    const text = await upstream.text();
    if (!upstream.ok) {
      res.status(502).json({ error: `upstream responded ${upstream.status}, got ${snippet(text)}` });
      return;
    }

    const json = JSON.parse(text);
    const rates = {};
    Object.entries(json.rates || {}).forEach(([date, v]) => {
      if (v?.KRW != null) rates[date] = v.KRW;
    });
    if (!Object.keys(rates).length) {
      res.status(502).json({ error: `no rates in response, got ${snippet(text)}` });
      return;
    }

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
    res.status(200).json({ fetchedAt: new Date().toISOString(), rates });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
