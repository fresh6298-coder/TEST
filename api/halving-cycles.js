const HALVINGS = [
  { label: "2016 반감기", date: "2016-07-09" },
  { label: "2020 반감기", date: "2020-05-11" },
  { label: "2024 반감기", date: "2024-04-20" },
];

const MAX_DAYS = 1460; // ~4 years, one full halving-epoch window, for apples-to-apples comparison

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// stooq.com's free CSV export (no key) has BTC/USD history going back to
// ~2014, unlike CoinGecko/CryptoCompare's historical endpoints which now
// require a paid key.
async function fetchBtcDailyMap() {
  const url = "https://stooq.com/q/d/l/?s=btcusd&i=d";
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`stooq responded ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2 || !/^date/i.test(lines[0])) {
    throw new Error(`unexpected CSV (first line: ${lines[0]?.slice(0, 60)})`);
  }
  const map = new Map();
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const date = cols[0];
    const close = parseFloat(cols[4]);
    if (date && !Number.isNaN(close)) map.set(date, close);
  }
  if (!map.size) throw new Error("no rows parsed from stooq CSV");
  return map;
}

export default async function handler(req, res) {
  try {
    const dailyMap = await fetchBtcDailyMap();
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
