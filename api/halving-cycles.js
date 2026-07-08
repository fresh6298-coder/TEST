const HALVINGS = [
  { label: "2016 반감기", date: "2016-07-09" },
  { label: "2020 반감기", date: "2020-05-11" },
  { label: "2024 반감기", date: "2024-04-20" },
];

const COINGECKO_URL = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range";

const MAX_DAYS = 1460; // ~4 years, one full halving-epoch window, for apples-to-apples comparison

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

async function fetchDailyPrices(fromUnix, toUnix) {
  const url = `${COINGECKO_URL}?vs_currency=usd&from=${fromUnix}&to=${toUnix}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json?.prices) || !json.prices.length) {
    throw new Error("No price data in CoinGecko response");
  }
  return json.prices;
}

// Collapse to one price per UTC calendar day (last sample of that day wins).
function toDailyMap(prices) {
  const map = new Map();
  for (const [ts, price] of prices) {
    const day = new Date(ts).toISOString().slice(0, 10);
    map.set(day, price);
  }
  return map;
}

export default async function handler(req, res) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = Math.floor(new Date("2015-01-01T00:00:00Z").getTime() / 1000);
    const prices = await fetchDailyPrices(from, now);
    const dailyMap = toDailyMap(prices);
    const sortedDays = [...dailyMap.keys()].sort();

    const cycles = HALVINGS.map((h) => {
      const startIdx = sortedDays.findIndex((d) => d >= h.date);
      if (startIdx === -1) return { label: h.label, date: h.date, series: [] };
      const startDay = sortedDays[startIdx];
      const basePrice = dailyMap.get(startDay);
      const startMs = new Date(startDay).getTime();

      const series = [];
      for (let i = startIdx; i < sortedDays.length; i++) {
        const day = sortedDays[i];
        const price = dailyMap.get(day);
        const daysSince = Math.round((new Date(day).getTime() - startMs) / 86400000);
        if (daysSince > MAX_DAYS) break;
        series.push({ day: daysSince, ratio: price / basePrice });
      }
      return { label: h.label, date: h.date, series };
    });

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
    res.status(200).json({ fetchedAt: new Date().toISOString(), cycles });
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err) });
  }
}
