// Historical "kimchi premium" = how much more (or less) BTC costs on a
// Korean exchange (Upbit, KRW) than its USD price implies once converted
// at the market exchange rate. There's no ready-made API for this, so it's
// computed here from three separate free sources for each overlapping
// date: Upbit's own daily KRW-BTC candles, Yahoo Finance's BTC-USD daily
// close (same source as api/btc-history.js), and frankfurter.app's ECB
// USD/KRW reference rate (business days only, unlike the other two).
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};

function snippet(text) {
  return JSON.stringify((text || "").replace(/\s+/g, " ").trim().slice(0, 160));
}

async function fetchBtcUsdHistory() {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?range=12y&interval=1d";
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`BTC-USD: upstream responded ${res.status}, got ${snippet(text)}`);
  const json = JSON.parse(text);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`BTC-USD: no chart result (${json?.chart?.error?.description || snippet(text)})`);
  const timestamps = result.timestamp || [];
  const closesArr = result.indicators?.quote?.[0]?.close || [];
  const prices = {};
  timestamps.forEach((ts, i) => {
    const c = closesArr[i];
    if (c != null) prices[new Date(ts * 1000).toISOString().slice(0, 10)] = c;
  });
  if (!Object.keys(prices).length) throw new Error("BTC-USD: no close data in response");
  return prices;
}

async function fetchUsdKrwHistory() {
  const url = "https://api.frankfurter.app/2014-01-01..?from=USD&to=KRW";
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) throw new Error(`FX: upstream responded ${res.status}, got ${snippet(text)}`);
  const json = JSON.parse(text);
  const rates = {};
  Object.entries(json.rates || {}).forEach(([date, v]) => {
    if (v?.KRW != null) rates[date] = v.KRW;
  });
  if (!Object.keys(rates).length) throw new Error("FX: no rates in response");
  return rates;
}

// Upbit returns at most 200 candles per call, newest-first; paginate
// backwards using `to` (the timestamp of the oldest candle already seen)
// until either the market runs out of history or the page cap is hit.
async function fetchUpbitKrwHistory() {
  const prices = {};
  let to;
  for (let page = 0; page < 15; page++) {
    const url = `https://api.upbit.com/v1/candles/days?market=KRW-BTC&count=200${to ? `&to=${encodeURIComponent(to)}` : ""}`;
    const res = await fetch(url, { headers: HEADERS });
    const text = await res.text();
    if (!res.ok) throw new Error(`Upbit: upstream responded ${res.status}, got ${snippet(text)}`);
    const data = JSON.parse(text);
    if (!Array.isArray(data) || !data.length) break;
    data.forEach((c) => {
      prices[c.candle_date_time_utc.slice(0, 10)] = c.trade_price;
    });
    if (data.length < 200) break;
    to = data[data.length - 1].candle_date_time_utc.replace("T", " ");
  }
  if (!Object.keys(prices).length) throw new Error("Upbit: no candles returned");
  return prices;
}

export default async function handler(req, res) {
  try {
    const [btcUsd, usdKrw, upbitKrw] = await Promise.all([
      fetchBtcUsdHistory(),
      fetchUsdKrwHistory(),
      fetchUpbitKrwHistory(),
    ]);

    // frankfurter only has business-day rates, so weekend dates drop out
    // here even though Upbit/BTC trade every day — still leaves ~5
    // points/week, plenty for a multi-year trend chart.
    const dates = Object.keys(upbitKrw)
      .filter((d) => btcUsd[d] != null && usdKrw[d] != null)
      .sort();
    if (dates.length < 30) throw new Error("겹치는 날짜가 너무 적음 (data too sparse)");

    const premiums = {};
    dates.forEach((d) => {
      const impliedUsd = upbitKrw[d] / usdKrw[d];
      premiums[d] = (impliedUsd / btcUsd[d] - 1) * 100;
    });

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
    res.status(200).json({ fetchedAt: new Date().toISOString(), premiums });
  } catch (e) {
    res.status(502).json({ error: "김치프리미엄 히스토리 로드 실패: " + e.message });
  }
}
