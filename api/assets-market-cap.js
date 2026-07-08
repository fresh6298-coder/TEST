import { fetchTableWithFallback } from "./_lib/scrape.js";

const SOURCE_URL = "https://companiesmarketcap.com/assets-by-market-cap/";
const READER_URL =
  "https://r.jina.ai/https://companiesmarketcap.com/assets-by-market-cap/";

function parseMoney(text) {
  if (text == null) return null;
  const t = String(text).replace(/[$,]/g, "").trim();
  if (t === "" || t === "-") return null;
  const m = t.match(/^(-?[\d.]+)\s*([TtBbMmKk])?$/);
  if (!m) {
    const n = parseFloat(t);
    return Number.isNaN(n) ? null : n;
  }
  const num = parseFloat(m[1]);
  if (Number.isNaN(num)) return null;
  const mult =
    { T: 1e12, B: 1e9, M: 1e6, K: 1e3 }[m[2] ? m[2].toUpperCase() : ""] || 1;
  return num * mult;
}

function parsePercent(text) {
  if (text == null) return null;
  const t = String(text).replace(/%/g, "").trim();
  if (t === "" || t === "-") return null;
  const negative = /^\(.*\)$/.test(t) || t.startsWith("-");
  const cleaned = t.replace(/[()]/g, "").replace(/^-/, "");
  const n = parseFloat(cleaned);
  if (Number.isNaN(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function findIdx(headers, pattern) {
  return headers.findIndex((h) => pattern.test(h));
}

function buildResult(rawRows, source) {
  const headers = rawRows[0];
  const rankIdx = findIdx(headers, /^(rank|#)$/i);
  const nameIdx = findIdx(headers, /name/i);
  const capIdx = findIdx(headers, /market\s*cap/i);
  const priceIdx = findIdx(headers, /^price$/i);
  const changeIdx = findIdx(headers, /today|24h|change/i);
  const countryIdx = findIdx(headers, /country/i);

  const rows = rawRows
    .slice(1)
    .filter((r) => r.length >= headers.length - 1 && r.some((c) => c))
    .map((r, i) => {
      const cells = {};
      headers.forEach((h, idx) => {
        cells[h] = r[idx] != null ? r[idx] : null;
      });
      return {
        rank: rankIdx >= 0 ? parseInt(r[rankIdx], 10) || i + 1 : i + 1,
        name: nameIdx >= 0 ? r[nameIdx] : cells[headers[1]] || "",
        marketCapDisplay: capIdx >= 0 ? r[capIdx] : null,
        marketCap: capIdx >= 0 ? parseMoney(r[capIdx]) : null,
        priceDisplay: priceIdx >= 0 ? r[priceIdx] : null,
        price: priceIdx >= 0 ? parseMoney(r[priceIdx]) : null,
        changeDisplay: changeIdx >= 0 ? r[changeIdx] : null,
        changePct: changeIdx >= 0 ? parsePercent(r[changeIdx]) : null,
        country: countryIdx >= 0 ? r[countryIdx] : null,
        cells,
      };
    })
    .filter((r) => r.name);

  return {
    source,
    fetchedAt: new Date().toISOString(),
    headers,
    rows,
  };
}

export default async function handler(req, res) {
  try {
    const { rawRows, source } = await fetchTableWithFallback(
      SOURCE_URL,
      READER_URL
    );
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=1800"
    );
    res.status(200).json(buildResult(rawRows, source));
  } catch (err) {
    res
      .status(502)
      .json({ error: err.message, details: err.details || [] });
  }
}
