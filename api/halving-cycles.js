// Binance's BTCUSDT history only goes back to Aug 2017, so the 2016
// halving isn't coverable here. CryptoCompare's news endpoint and
// CoinGecko's historical range endpoint both now require a paid API key,
// and stooq.com didn't have a working btcusd ticker for CSV export, so
// Binance (already used successfully elsewhere in this app) is the most
// reliable free source available for the cycles it can cover.
const HALVINGS = [
  { label: "2020 반감기", date: "2020-05-11" },
  { label: "2024 반감기", date: "2024-04-20" },
];

const MAX_DAYS = 1460; // ~4 years, one full halving-epoch window, for apples-to-apples comparison

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchAllDailyKlines(startTimeMs) {
  let all = [];
  let start = startTimeMs;
  const now = Date.now();
  while (start < now) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${start}&limit=1000`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Binance responded ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || !batch.length) break;
    all = all.concat(batch);
    if (batch.length < 1000) break;
    start = batch[batch.length - 1][0] + 86400000;
  }
  if (!all.length) throw new Error("no klines returned");
  return all;
}

function toDailyMap(klines) {
  const map = new Map();
  for (const k of klines) {
    const day = new Date(k[0]).toISOString().slice(0, 10);
    map.set(day, parseFloat(k[4]));
  }
  return map;
}

export default async function handler(req, res) {
  try {
    const earliestNeeded = new Date("2020-01-01T00:00:00Z").getTime();
    const klines = await fetchAllDailyKlines(earliestNeeded);
    const dailyMap = toDailyMap(klines);
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
