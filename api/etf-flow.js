import { fetchTableWithFallback, parseNumber } from "./_lib/scrape.js";

// farside.co.uk's dedicated full-history page (/bitcoin-etf-flow-all-data/)
// 403s server-side fetches outright (its bot protection is stricter there
// than on the main page), so scrape the regular /btc/ page instead — it
// may only carry a recent window server-rendered, but it's the one that
// actually responds.
const SOURCE_URL = "https://farside.co.uk/btc/";
const READER_URL = "https://r.jina.ai/https://farside.co.uk/btc/";

// bitcoin-data.com (BGeometrics — the same provider api/onchain-metrics.js
// already uses successfully for MVRV/NUPL/Puell) also tracks ETF flows,
// and unlike farside its history isn't capped to a recent window. The
// exact endpoint path isn't confirmed (docs weren't reachable to verify),
// so a few plausible candidates are tried and whichever returns a
// substantial, parseable series wins; if none do, this falls through to
// the farside scrape below rather than breaking anything.
const BGEO_BASE = "https://bitcoin-data.com/v1";
const BGEO_ETF_PATHS = ["etf-flow", "etf-flows", "btc-etf-flow", "bitcoin-etf-flow", "etf"];
const BGEO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json",
};
const MIN_BGEO_ROWS = 100; // farside's recent-window fallback tops out well under this

const NON_VALUE_KEY = /^(d|date|id|unix.*|timestamp|ts|epoch|createdat|updatedat)$/i;

function isNumeric(v) {
  return typeof v === "number" || (typeof v === "string" && v !== "" && !Number.isNaN(parseFloat(v)));
}

// Row shape isn't known in advance, so this stays generic: whichever key
// looks like a date becomes the date, everything else numeric becomes a
// per-issuer value, and a "total"-looking key (or else the sum of the
// other numeric fields) becomes the total.
function normalizeBgeoEtfRow(row) {
  if (!row || typeof row !== "object") return null;
  const keys = Object.keys(row);
  const dateKey = keys.find((k) => /^(d|date)$/i.test(k)) || keys.find((k) => /time|timestamp/i.test(k));
  if (!dateKey) return null;
  const dateMs = Date.parse(row[dateKey]);
  if (Number.isNaN(dateMs)) return null;

  const valueKeys = keys.filter((k) => k !== dateKey && !NON_VALUE_KEY.test(k) && isNumeric(row[k]));
  if (!valueKeys.length) return null;

  const totalKey = valueKeys.find((k) => /total/i.test(k));
  const values = {};
  valueKeys.forEach((k) => {
    if (k !== totalKey) values[k] = parseFloat(row[k]);
  });
  const rawTotal = totalKey
    ? parseFloat(row[totalKey])
    : valueKeys.reduce((sum, k) => sum + parseFloat(row[k]), 0);
  const total = Math.round(rawTotal * 10) / 10;

  const d = new Date(dateMs);
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return {
    date: `${String(d.getUTCDate()).padStart(2, "0")} ${monthNames[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
    dateMs,
    values,
    total,
  };
}

async function fetchBgeoEtfFlow() {
  for (const path of BGEO_ETF_PATHS) {
    try {
      const res = await fetch(`${BGEO_BASE}/${path}`, { headers: BGEO_HEADERS });
      if (!res.ok) continue;
      const json = await res.json();
      const rawRows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : null;
      if (!rawRows || !rawRows.length) continue;

      const rows = rawRows.map(normalizeBgeoEtfRow).filter(Boolean).sort((a, b) => a.dateMs - b.dateMs);
      if (rows.length >= MIN_BGEO_ROWS) {
        const headerSet = new Set();
        rows.forEach((r) => Object.keys(r.values).forEach((k) => headerSet.add(k)));
        return {
          source: `${BGEO_BASE}/${path}`,
          headers: ["Date", ...headerSet, "Total"],
          rows,
        };
      }
    } catch {
      // try the next candidate path
    }
  }
  return null;
}

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

// Farside's date column reads like "11th Jan 2024" — the ordinal suffix
// makes it unparseable by plain `new Date(...)`. Strip it and parse
// explicitly instead of relying on the runtime's (locale-dependent) date
// string parser.
function parseFarsideDate(text) {
  const raw = String(text || "").trim();
  const m = raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\s+(\d{4})$/i);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const year = parseInt(m[3], 10);
    if (month != null && !Number.isNaN(day) && !Number.isNaN(year)) {
      return Date.UTC(year, month, day);
    }
  }
  // Fall back to native parsing in case the format differs from the
  // "11th Jan 2024" pattern above.
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function buildResult(rawRows, source) {
  const headers = rawRows[0];
  const totalIdx = headers.findIndex((h) => /total/i.test(h));

  const dataRows = rawRows
    .slice(1)
    .filter((r) => r.length === headers.length && r[0])
    .filter((r) => !/^(total|average|maximum|minimum|max|min)\b/i.test(r[0]))
    .map((r) => {
      const values = {};
      headers.slice(1).forEach((h, i) => {
        values[h] = parseNumber(r[i + 1]);
      });
      return {
        date: r[0],
        dateMs: parseFarsideDate(r[0]),
        values,
        total: totalIdx >= 0 ? parseNumber(r[totalIdx]) : null,
      };
    })
    .filter((r) => r.dateMs != null);

  return {
    source,
    fetchedAt: new Date().toISOString(),
    headers,
    rows: dataRows,
  };
}

export default async function handler(req, res) {
  const bgeoResult = await fetchBgeoEtfFlow();
  if (bgeoResult) {
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=1800");
    res.status(200).json({ ...bgeoResult, fetchedAt: new Date().toISOString() });
    return;
  }

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
